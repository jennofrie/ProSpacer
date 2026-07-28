import * as THREE from 'three';
import { PostFX } from '../gfx/PostFX.js';

/* Renderer, sizing, quality tiering and the frame loop. */

/**
 * Pick a quality tier from what the browser will admit about the machine.
 *
 * `navigator.deviceMemory` is Chromium-only — Safari and Firefox return
 * undefined. Defaulting that to 4 and then testing `mem <= 4` pinned every
 * Safari user to the medium tier regardless of hardware, which capped the
 * canvas at 1.5x on a 2x display: rendered at 75% linear scale and upscaled by
 * the browser. Blurry and aliased at the same time is exactly what that looks
 * like, and it also halved MSAA. So memory is now only ever read as a
 * *positive* signal;
 * unknown means unknown, not slow.
 *
 * Window size is likewise not evidence about the GPU — a small window on a
 * fast machine is still a fast machine. Only a genuinely small *screen* counts.
 */
export function detectQuality() {
  const mem = navigator.deviceMemory;                     // undefined off Chromium
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = window.matchMedia('(hover: none)').matches;
  const smallScreen = Math.min(screen.width, screen.height) < 700;

  const knownLowMem = mem !== undefined && mem <= 4;
  if (coarse && (knownLowMem || cores <= 4)) return 'low';
  if (coarse || smallScreen) return 'medium';
  if (cores <= 4 || knownLowMem) return 'medium';
  return 'high';
}

export class Engine {
  constructor(canvas, quality) {
    this.canvas = canvas;
    this.quality = quality;

    /* Diagnostic switches. Some of these make the image wrong on purpose —
       they exist so a browser that cannot be profiled from here can still be
       bisected by whoever is sitting in front of it.
         ?logdepth=0  drop the logarithmic depth buffer. It writes gl_FragDepth
                      in every fragment, which defeats early-Z rejection; on a
                      tile-based GPU that can cost far more than it looks.
                      Planets will z-fight against their atmospheres without it.
         ?msaa=0      no multisampling on the HDR target. 4x on an RGBA16F
                      buffer is a lot of bandwidth if the driver handles it
                      poorly.
         ?post=0      skip the entire post chain. Splits "the scene is slow"
                      from "the twenty full-screen passes are slow". Output is
                      untonemapped and will look flat.
         ?ao=0        drop the ambient-occlusion chain: the depth linearisation,
                      the half-res AO and its two blurs. Four passes and a
                      full-res float target, so it is worth being able to weigh
                      them on their own — and an A/B in one session is the only
                      honest way to measure anything on a loaded machine. */
    const flags = new URLSearchParams(location.search);
    this.flags = {
      logDepth: flags.get('logdepth') !== '0',
      msaa: flags.get('msaa') !== '0',
      post: flags.get('post') !== '0',
      ao: flags.get('ao') !== '0',
    };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // we resolve with MSAA on the HDR target + FXAA
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      logarithmicDepthBuffer: this.flags.logDepth,
      preserveDrawingBuffer: false,
    });
    this.renderer.autoClear = true;
    // Contact shadows inside the hull; the exterior has nothing to cast onto.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;   // AgX happens in PostFX
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    THREE.ColorManagement.enabled = true;

    /* Supersampling headroom.

       MSAA antialiases *coverage* — it shades once per pixel and only smooths
       triangle silhouettes. Every surface in this game is procedural detail
       evaluated per fragment, with no texture and therefore no mip chain to
       prefilter it, so none of that detail is antialiased by MSAA at all. The
       only thing that touches shading aliasing is shading at a higher rate.

       So the ceiling is allowed above the display's own ratio and the dynamic
       controller below decides how much of it is affordable: a scene with
       headroom renders supersampled and resolves sharp, a scene without falls
       back to native rather than dropping frames. It is self-balancing, which
       is why the ceiling can be generous. */
    const SS = quality === 'high' ? 1.4 : quality === 'medium' ? 1.15 : 1.0;
    const base = quality === 'low' ? 1.0 : quality === 'medium' ? 1.5 : 2.0;
    // Start at native and *climb*. Starting at the ceiling means every boot
    // spends its first few seconds rendering eleven megapixels and ratcheting
    // back down, which is both slow and visible — each step rebuilds a dozen
    // render targets and restarts the eye adaptation.
    this.maxPixelRatio = base;
    // Dynamic resolution may move between these. The floor matters: below one
    // device pixel per CSS pixel the image is soft enough that it is no longer
    // worth buying frames with, so on a pointer device we stop there and would
    // rather drop frames than ship a blurry frame.
    this.prCeil = base * SS;
    this.prFloor = quality === 'low' ? 0.7 : 1.0;
    this.superSample = SS;
    this.pixelRatio = Math.min((window.devicePixelRatio || 1) * SS, this.maxPixelRatio);
    this._warm = 0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.008, 6.0e7);

    this.post = new PostFX(this.renderer, quality);
    this.post.msaa = this.flags.msaa;      // read by setSize, called below
    this.post.enabled.streak = quality !== 'low';
    this.post.enabled.ao = this.flags.ao;

    this.clock = new THREE.Clock();
    this.time = 0;
    this.frame = 0;
    this._fpsAcc = 0; this._fpsN = 0; this.fps = 60;
    this._adaptAcc = 0;

    this.sunUV = new THREE.Vector2(0.5, 0.5);
    this.sunVis = 0;

    this.resize();
    window.addEventListener('resize', () => this.requestResize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.requestResize(), 120));
  }

  /* Ask for a resize at the top of the next frame rather than taking it now.
   *
   * Writing `canvas.width` clears the drawing buffer, and the browser composites
   * whatever is in it at the end of the task — so a resize taken *after* the
   * frame's render(), which is where the dynamic-resolution controller runs,
   * presents a cleared buffer. That is one wholly black frame per resolution
   * change, and the controller steps five or six times in the first seconds of
   * a pan on a machine that cannot hold the ceiling: measured at 1512x900 dpr2,
   * five resizes in twelve seconds and five frames at exactly 100% black, each
   * one the frame the resize landed on. It reads as a flicker, not as a
   * resolution change, because everything either side of it is correct.
   *
   * Deferring also coalesces a burst of window `resize` events into one rebuild
   * of a dozen render targets, which is worth having on its own.
   */
  requestResize() { this._needResize = true; }

  resize() {
    this._needResize = false;
    const w = window.innerWidth, h = window.innerHeight;
    this.pixelRatio = Math.min((window.devicePixelRatio || 1) * this.superSample, this.maxPixelRatio);
    /* three writes canvas.width unconditionally, so even a resize to the size
       it already is costs a cleared buffer. The window fires `resize` for
       plenty of things that do not change the canvas — devtools docking, a
       pixel-ratio change on a monitor swap — so check before touching it. */
    const W = Math.floor(w * this.pixelRatio), H = Math.floor(h * this.pixelRatio);
    if (this.width === w && this.height === h && this._bufW === W && this._bufH === H) return;
    this._bufW = W; this._bufH = H;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, this.pixelRatio);
    this.width = w; this.height = h;
  }

  /** Dynamic resolution: keep 60fps by trading pixels, never features. */
  adapt(dt) {
    this._fpsAcc += dt; this._fpsN++;
    this._warm += dt;
    if (this._fpsAcc < 0.5) return;

    this.fps = this._fpsN / this._fpsAcc;
    this._fpsAcc = 0; this._fpsN = 0;

    // Shaders compile and the sky bakes during the first seconds, so early
    // frame times say nothing about steady-state cost. Reacting to them
    // ratcheted the resolution down before the scene had ever run at speed,
    // and the old recovery rate was slow enough that it never came back.
    if (this._warm < 5) return;

    // Every resize disposes and rebuilds a dozen render targets, including the
    // eye-adaptation history — so the exposure restarts and the frame visibly
    // flashes. Sitting near a threshold made that happen over and over. One
    // change every couple of seconds at most.
    this._cool = Math.max(0, (this._cool || 0) - 0.5);
    if (this._cool > 0) return;

    /* The thresholds target sixty, not forty-five.

       The old band let the controller sit happily at 56 fps, which was fine
       when the ceiling was the display's own pixel ratio and the only thing
       below it was a blurrier image. Now the ceiling is *above* native — the
       resolution above 1:1 is being spent on antialiasing rather than on
       sharpness — so the controller's job is to find the highest rate that
       still holds the frame, and it has to give that up as soon as it costs
       frames. The upper threshold is above sixty on purpose: on a 60 Hz panel
       the measured rate caps at 60, so anything at or under it would ratchet
       the resolution up forever against a wall it cannot see past. */
    if (this.fps < 57 && this.maxPixelRatio > this.prFloor) {
      this.maxPixelRatio = Math.max(this.prFloor, this.maxPixelRatio - 0.12);
      this._adaptAcc = 0;
      this._cool = 2.0;
      this.requestResize();
    } else if (this.fps > 62 && this.maxPixelRatio < this.prCeil) {
      // Recover at a comparable rate to the way down. The old controller fell
      // 0.18 every half second and climbed 0.1 every three, so any transient
      // dip cost a permanent chunk of resolution.
      this._adaptAcc++;
      if (this._adaptAcc >= 3) {
        this._adaptAcc = 0;
        this._cool = 2.0;
        this.maxPixelRatio = Math.min(this.prCeil, this.maxPixelRatio + 0.12);
        this.requestResize();
      }
    } else {
      this._adaptAcc = 0;
    }
  }

  /**
   * Two passes into one HDR target.
   *
   * three filters lights by *camera* layers rather than object layers, so
   * object-layer isolation cannot keep starlight out of a cabin — a second
   * scene can. The depth buffer is cleared between passes because you are
   * inside the hull, so it always wins; the canopy still blends over the space
   * already sitting in the colour buffer.
   */
  render(overlayScene, overlayCamera) {
    // Take any deferred resize here, at the head of the frame that is about to
    // refill the canvas — never after it. See requestResize.
    if (this._needResize) this.resize();

    /* Nothing to draw. While a landing's cloud deck is fully opaque the
       composite overwrites every pixel of the scene, so drawing it is work
       whose entire output is discarded — and those are exactly the frames the
       transition is doing its expensive structural work on. Measured on the
       ground bench, the frame the hull's materials change depth convention on
       ran 159 ms, all of it inside render(), against a scene that was not
       visible. The HDR target keeps the last frame it was given, which is all
       the bloom and adaptation chains need to stay continuous. */
    if (this.skipScene && this.flags.post && this.post.sceneTarget) {
      this.drawCalls = 0; this.triangles = 0;
      this.post.render({ sunUV: this.sunUV, sunVis: this.sunVis, time: this.time, dt: this.dt || 0.016 });
      return;
    }
    // `sceneOverride` swaps the whole world out for another one — used by the
    // ground scene, which is a completely separate set of geometry and would
    // otherwise have to be merged into a space scene it shares nothing with.
    const scene = this.sceneOverride || this.scene;
    // ?post=0 — straight to the canvas, no HDR target and no chain. The image
    // is untonemapped and wrong; the number it produces is the point.
    if (!this.flags.post) {
      this.renderer.setRenderTarget(null);
      this.renderer.clear(true, true, true);
      this.renderer.render(scene, this.camera);
      let c = this.renderer.info.render.calls;
      let t = this.renderer.info.render.triangles;
      if (overlayScene) {
        const prev = this.renderer.autoClear;
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(overlayScene, overlayCamera || this.camera);
        this.renderer.autoClear = prev;
        c += this.renderer.info.render.calls;
        t += this.renderer.info.render.triangles;
      }
      this.drawCalls = c; this.triangles = t;
      return;
    }

    /* Resolving a multisampled depth buffer into a texture is a real blit of
       real bandwidth, and it happens at the end of every render() whose target
       asks for it. Only the pass that ends up owning the frame needs one: with
       a cabin drawn over the world, the cabin's depth is the frame's depth and
       the world's is about to be cleared anyway. Asking for both measured four
       milliseconds a frame in the two cameras that have a cabin. */
    const wantDepth = this.post.enabled.ao;
    this.post.sceneTarget.resolveDepthBuffer = wantDepth && !overlayScene;

    this.renderer.setRenderTarget(this.post.sceneTarget);
    this.renderer.clear(true, true, true);
    this.renderer.render(scene, this.camera);
    let calls = this.renderer.info.render.calls;
    let tris = this.renderer.info.render.triangles;

    /* Normalise the depth *now*, while it is still in the buffer — the cabin
       clears it before it draws, so there is no later moment at which the
       world's depth exists at all. Rebinding the HDR target afterwards is
       safe: three only invalidates the multisample attachments after a resolve
       on OculusBrowser, so the world's colour is still sitting in the MSAA
       renderbuffer for the cabin to draw over. */
    if (!overlayScene) this.post.captureDepth(this.camera, { log: this.flags.logDepth });

    if (overlayScene) {
      const prevAuto = this.renderer.autoClear;
      this.post.sceneTarget.resolveDepthBuffer = wantDepth;
      this.renderer.setRenderTarget(this.post.sceneTarget);
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(overlayScene, overlayCamera || this.camera);
      this.renderer.autoClear = prevAuto;
      calls += this.renderer.info.render.calls;
      tris += this.renderer.info.render.triangles;
      // The cabin strips the logarithmic depth buffer from every material it
      // owns — it does not need it, and gl_FragDepth costs early-Z — so it is
      // on the ordinary projection curve and inverts differently.
      this.post.captureDepth(overlayCamera || this.camera, { log: false });
    }

    this.drawCalls = calls;
    this.triangles = tris;
    this.post.render({ sunUV: this.sunUV, sunVis: this.sunVis, time: this.time, dt: this.dt || 0.016 });
  }
}
