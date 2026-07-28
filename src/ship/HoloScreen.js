import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';
import { INTERIOR_LAYER, CABIN_ENV_GLSL, stripLogDepth } from './interiorMaterials.js';

/* ============================================================================
   Cockpit and console displays.

   Each screen is a 2D canvas drawn with a small vector-graphics vocabulary and
   uploaded as a texture. The shader on top adds the things that make a panel
   read as a *display* rather than a picture stuck to a box: scanlines, a phosphor
   bloom around bright strokes, a faint interlace roll, per-channel offset at the
   edges, and a curved-glass vignette.

   Around that sits the module: a machined bezel with latch hardware and
   fasteners, physical keycaps and indicator blocks on the rails, and a cover
   pane in front of the glass. See `buildScreenModules`.

   Canvas redraw is throttled — instruments do not need 120 Hz.
   ========================================================================== */

const VERT = /* glsl */`${LOGD_V_PARS}
varying vec2 vUv;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec3 vWTan;
varying vec3 vWBit;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vWNrm = normalize(mat3(modelMatrix) * normal);
  /* The panel's own axes in world space. A PlaneGeometry's u runs along local
     +x and its v along local +y, so these are the two directions the image is
     printed in — which is what the cover pane's parallax has to be measured
     against. */
  vWTan = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0));
  vWBit = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGD_V}
}
`;

const FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec2 vUv;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec3 vWTan;
varying vec3 vWBit;

uniform sampler2D uMap;
uniform float uTime;
uniform float uPower;      // 0 = dark panel, 1 = fully lit
uniform vec3  uTint;
uniform vec3  uCamPos;
uniform float uCurve;
uniform float uGlitch;
uniform float uBoot;      // 1 = just powered on, 0 = settled
uniform vec2  uTexel;     // 1/canvas size, so blur offsets are texel-relative
uniform vec2  uSize;      // physical panel size in metres
uniform float uEnvGain;   // cabinEnv -> scene radiance
uniform vec2  uHdr;       // (floor gain, headroom gain) in scene radiance
uniform float uScanPerM;  // raster lines per metre of panel height
uniform float uGrillePerM;// aperture-grille triads per metre of panel width
uniform vec2  uParallax;  // emitter depth behind the cover pane, in uv per unit tan

/* The cabin, along the reflection vector. Shared with the canopy glazing and
   with the cover pane in front of this display — several reflective surfaces
   in the same frame have to return the same room, so the model lives in
   interiorMaterials.js and everything imports it. */
${CABIN_ENV_GLSL}

vec3 sample3(vec2 uv, float off){
  return vec3(
    texture2D(uMap, uv + vec2(off, 0.0)).r,
    texture2D(uMap, uv).g,
    texture2D(uMap, uv - vec2(off, 0.0)).b);
}

void main(){
  /* no LOGD_F: interior-only, and writing gl_FragDepth would cost early-Z */
  vec2 uv = vUv;

  /* ---- parallax under the cover pane.

     The emitter is not the front surface. There is a cover glass, an air gap
     and a polariser between the pixels and the pilot's eye — six or seven
     millimetres of it — so the image slides against the bezel as the head
     moves, and it slides more at the edges than in the middle. Without it the
     content is *painted on* the front of the panel, which is exactly the
     "browser overlay glued to a quad" reading: it is the one cue that survives
     however good the type is, because it is the only one that moves.

     Measured against the panel's own axes rather than the screen's, so it is
     right for the side displays' 24-degree yaw as well as for the centre one.
     Divided by N·V so it grows off-axis the way a real offset image does. */
  {
    vec3 Vp = normalize(uCamPos - vWPos);
    vec3 Np = normalize(vWNrm);
    if(dot(Np, Vp) < 0.0) Np = -Np;
    float nv = max(dot(Np, Vp), 0.22);
    uv -= vec2(dot(Vp, vWTan), dot(Vp, vWBit)) * uParallax / nv;
  }

  // barrel curvature: the glass is not flat
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  uv = 0.5 + c * (1.0 + r2 * uCurve);
  if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0){
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // occasional interference
  float g = uGlitch * step(0.9975, fract(sin(floor(uTime*11.0)*91.7)*4371.3));
  uv.x += g * (fract(sin(uv.y*431.0 + uTime)*719.0) - 0.5) * 0.04;

  /* Chromatic separation. It grows hard off-axis rather than staying under a
     texel everywhere: a display seen through a cover pane and a curved front
     surface fringes at the corners, and a panel whose type is equally, exactly
     resolved from centre to edge is the single loudest tell that the type was
     never emitted by anything. */
  vec3 col = sample3(uv, 0.0004 + r2*0.0032);

  /* Phosphor bloom, and edge defocus in the same four taps. The offsets are a
     fraction of a *texel*, not of the panel — at the old 0.0035 they were six
     pixels wide at working resolution, which blurred the glyphs themselves
     rather than haloing them. The tap radius then grows with r2 so the corners
     of the image genuinely lose resolution, which is what a pane of glass over
     a display does and what perfect vector antialiasing never does. */
  vec2 tx = uTexel * (1.5 + 9.0 * r2);
  vec3 blur = vec3(0.0);
  blur += texture2D(uMap, uv + vec2( tx.x, 0.0)).rgb;
  blur += texture2D(uMap, uv + vec2(-tx.x, 0.0)).rgb;
  blur += texture2D(uMap, uv + vec2(0.0,  tx.y)).rgb;
  blur += texture2D(uMap, uv + vec2(0.0, -tx.y)).rgb;
  blur *= 0.25;
  col = mix(col, blur, clamp(r2 * 1.2, 0.0, 0.38));
  col += blur * 0.55;

  col *= uTint;

  /* ---- HDR authoring.

     The old panel multiplied everything by one flat 4.6, which put its
     brightest stroke four units into a frame where a hundred and twenty is
     white — the cabin measured 0.000% of pixels at display white in every
     frame, which is the definition of flat. A display is not a flat gain
     though: it is a drive signal through a panel gamma, so the response is
     strongly convex. The headroom is therefore given away through a hard knee
     near white, and *only* there.

     The knee is not a stylistic choice, it is what keeps auto-exposure out of
     the argument. Metering runs off the frame's average luminance, so lifting
     the whole panel by a factor of four buys clipped highlights and pays for
     them by stopping the entire cabin down — measured at mean 45.8 -> 38.0 and
     17.7% -> 23.0% of the frame crushed to black, which is a worse picture
     than the flat one. Lifting a few per cent of the panel's area by a factor
     of thirty costs the meter almost nothing and clips exactly the strokes
     that should clip. It also hardens the antialiasing ramp on those glyphs,
     which is the point: perfect vector antialiasing is the tell that nothing
     emitted them.

     By luminance rather than per channel, or a cyan whose blue is already at
     1.0 turns into pure blue as the gain climbs. */
  float lum = clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float drive = smoothstep(0.92, 1.00, lum);
  col *= uHdr.x + uHdr.y * drive;

  /* Scanlines, pitched per metre of panel rather than per unit of uv, and
     faded out once a cycle is narrower than a pixel. Left unfaded they beat
     against the display grid and produce the moire that reads as "jaggy" — the
     aliasing is in the stripe pattern, not the geometry. At the old 300 lines
     the fade had killed them at every distance anyone ever sees the panel
     from, which is a scanline that costs instructions and shows nothing. */
  float slPhase = uv.y * max(uSize.y * uScanPerM, 18.0);
  float slFade = 1.0 - smoothstep(0.30, 0.85, fwidth(slPhase));
  float sl = 1.0 - 0.17*slFade*(0.5 + 0.5*sin(slPhase*6.2832));
  float roll = 0.98 + 0.02*sin(uv.y*13.0 - uTime*2.1);
  col *= sl * roll;

  /* Aperture grille. The pitch is a property of the display and not of the
     render resolution — lean in and the image disintegrates into RGB stripes
     the way a real emissive panel does; sit back and it filters away.
     Vertical stripes only, because that is what an aperture grille is: a
     shadow-mask triad would put a second frequency across the scan and the two
     would beat. Faded by fwidth, and the fade is not optional — a stripe
     pattern at half a pixel is moire, not detail, and it crawls with every
     head movement. */
  float ph = uv.x * uSize.x * uGrillePerM;
  float phFade = 1.0 - smoothstep(0.32, 0.90, fwidth(ph));
  col *= mix(vec3(1.0),
             1.0 + 0.30*cos(6.2831853*(ph - vec3(0.0, 0.33333, 0.66667))),
             phFade);

  /* Fixed-pattern noise and a slow supply flicker. A panel whose every lit
     pixel is exactly its neighbour's value is a texture; a real one has a
     percent or two of gain scatter that does not move with the image. */
  float fpn = fract(sin(dot(floor(uv * uSize * 260.0), vec2(12.9898, 78.233))) * 43758.545);
  col *= (0.965 + 0.07*fpn) * (0.994 + 0.006*sin(uTime*37.0));

  // glass vignette, and a real reflection of the room
  float vig = 1.0 - r2*0.40;
  vec3 N = normalize(vWNrm);
  vec3 V = normalize(uCamPos - vWPos);
  // Schlick, F0 = 0.04. The constant term is what carries a *dark* panel: with
  // a pure grazing power the display went black when looked at square on, and
  // a black rectangle in a bezel is not glass, it is a hole.
  float fres = 0.04 + 0.96*pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 5.0);
  /* uEnvGain is the whole reason a dark panel reads as glass rather than as a
     hole, and it is a units bug that hid for a long time. cabinEnv returns
     *reflectances* -- 0.05 to 0.12, the sort of number an albedo is -- while
     everything else in this shader is scene radiance. A 4% Fresnel of a 0.1
     reflectance is 0.004 units, and an unpowered MFD measured 0 to 2 out of
     255 across its whole face: a black rectangle in a bezel. Lifted to cabin
     radiance the same four smoothsteps put the ceiling coves, the canopy and
     the footwell into the glass, they slide when the head turns, and the panel
     has a black level a real display has.
     Most of that job belongs to the cover pane in front now — this is the
     second surface, the emitter's own front polariser, so it is weaker. */
  vec3 refl = cabinEnv(reflect(-V, N)) * fres * uEnvGain;
  col = col*vig*uPower + refl;

  // ---- power-up: a bright line sweeps down, the image resolves behind it
  if(uBoot > 0.001){
    float t = 1.0 - uBoot;                       // 0 at switch-on -> 1 settled
    float edge = t*1.35 - 0.18;
    float reveal = smoothstep(edge, edge + 0.10, 1.0 - uv.y);
    float sweep = exp(-pow((1.0 - uv.y - edge)/0.035, 2.0));
    // interference in the not-yet-resolved region
    float hiss = fract(sin(dot(uv*vec2(431.0, 197.0) + uTime*7.0, vec2(12.9898, 78.233)))*43758.5);
    col = mix(vec3(0.02, 0.05, 0.07)*uHdr.x + hiss*0.09*uBoot*uHdr.x, col, reveal);
    col += vec3(0.55, 0.85, 1.0) * sweep * uBoot * 24.0;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ------------------------------------------------------------------- spill

   Light does not stop at the edge of a screen. A display sunk 24 mm into a
   machined recess throws a soft wash onto the gasket walls and the bezel
   around it, and without that wash the panel is a bright rectangle with a
   perfectly hard edge — which is exactly what a sticker looks like, and was
   the last thing keeping these from reading as instruments.

   It is a second quad, larger all round, floating just proud of the bezel and
   blended additively. The colour is taken from the panel itself at the nearest
   edge point, so the spill is whatever is actually lit *there*: an amber
   warning bar bleeds amber onto the metal beside it and a dark corner bleeds
   nothing.  */
const SPILL_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SPILL_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uMap;
uniform vec2  uInner;    // half-extent of the display, in this quad's uv
uniform vec2  uSoft;     // falloff width in uv, per axis
uniform float uPower;
uniform vec3  uTint;
uniform float uGain;
void main(){
  vec2 d = max(abs(vUv - 0.5) - uInner, 0.0) / uSoft;
  float o = length(d);
  /* No discard: emit a transparent fragment and return. discard alongside a
     depth write mis-compiles under ANGLE/Metal, and this pass is cheap enough
     that the branch costs less than finding that out again. */
  if (o >= 1.0 || o <= 0.0) { gl_FragColor = vec4(0.0); return; }
  float fall = pow(1.0 - o, 2.4);
  vec2 su = clamp((vUv - 0.5) / (2.0 * uInner) + 0.5, 0.0, 1.0);
  /* Nine taps over a 9% box, and the blur is not cosmetic.
     su is *clamped*, so across the whole margin it is constant along the
     edge normal — which means its screen-space derivatives are zero there and
     the hardware picks mip 0 for every tap. A single sharp tap therefore
     smears the panel's edge pixels outward as legible glyphs: the starboard
     display's distance column appeared to run off its own bezel and across
     the surrounding metal, still readable. The mip chain cannot help because
     the derivative it would key off does not exist; the taps have to be
     explicit. */
  vec3 c = vec3(0.0);
  const float O = 0.045;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      c += texture2D(uMap, clamp(su + vec2(float(i), float(j)) * O, 0.0, 1.0)).rgb;
    }
  }
  gl_FragColor = vec4(c * (1.0 / 9.0) * uTint * fall * uPower * uGain, 1.0);
}
`;

/* -------------------------------------------------------------- cover glass

   A pane in front of the display, at a real standoff from it.

   Everything that says "there is glass here" needs the pane to be a separate
   surface at its own depth. A reflection painted onto the display itself is
   welded to the image and slides with it; a reflection on a pane 30 mm proud
   has its own parallax, its dirt sits at its own focus, and its bevel casts a
   bright line across the readout when the head moves. Those three cues are the
   whole difference between an instrument behind glass and a picture of one.

   One merged mesh for every pane in the cockpit, so all of this costs one
   draw call. Panel-local metres arrive in `aHalf` because the merge throws
   away any notion of which panel a vertex came from.  */
const GLASS_VERT = /* glsl */`
attribute vec2 aHalf;      // half-extent of this pane, metres
varying vec2 vUv;
varying vec2 vHalf;
varying vec3 vWPos;
varying vec3 vWNrm;
void main(){
  vUv = uv;
  vHalf = aHalf;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vWNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GLASS_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec2 vHalf;
varying vec3 vWPos;
varying vec3 vWNrm;
uniform vec3  uCamPos;
uniform float uEnvGain;
uniform float uSheen;
uniform vec3  uLampA;     // the coaming wash bar, in cabin space
uniform vec3  uLampB;
uniform vec3  uLampCol;
uniform float uGrime;
uniform float uPower;

${CABIN_ENV_GLSL}

float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0 - 2.0*f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main(){
  vec3 N = normalize(vWNrm);
  vec3 V = normalize(uCamPos - vWPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.035 + 0.965 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);

  // the room, which is mostly a dark canopy and two warm coves
  vec3 col = cabinEnv(R) * fres * uEnvGain;

  /* The sheen: the coaming wash bar, reflected. It is the brightest thing
     above the panel and the only source close enough for a 30 mm standoff to
     move — which is what makes the pane read as a separate surface rather than
     as a gloss setting on the display. Closest approach between the reflected
     ray and the lamp segment, then a Gaussian across it. */
  vec3 ab = uLampB - uLampA;
  vec3 w0 = vWPos - uLampA;
  float qa = max(dot(R, R), 1e-5);
  float qb = dot(R, ab);
  float qc = max(dot(ab, ab), 1e-5);
  float qd = dot(R, w0);
  float qe = dot(ab, w0);
  float den = max(qa*qc - qb*qb, 1e-5);
  float s = clamp((qa*qe - qb*qd) / den, 0.0, 1.0);
  float t = max(dot(uLampA + ab*s - vWPos, R) / qa, 0.0);
  vec3 gap = (vWPos + R*t) - (uLampA + ab*s);
  float d2 = dot(gap, gap);
  float spec = exp(-d2 * 220.0) * step(0.0001, t);
  col += uLampCol * spec * uSheen * (0.10 + 0.90*fres);

  /* Dirt. A wiped pane is not clean, it is *streaked*, and the streaks are the
     one thing on the glass at the glass's own depth. Only visible where there
     is something to scatter, so it is driven by the reflection strength. */
  vec2 m = (vUv - 0.5) * 2.0 * vHalf;
  /* One octave, not two. A second octave of value noise for the dust is four
     more sin() per pixel over every panel in the frame and measured a third of
     the pane's whole cost; what actually reads at this size is the wipe. */
  float wipe = 0.5 + 0.5*sin(m.x*54.0 + vnoise(m*11.0)*7.0);
  float grime = uGrime * wipe * (0.20 + 0.80*fres);
  col += vec3(0.62, 0.70, 0.82) * grime * 0.55;

  /* The pane edge. A bevel round a 4 mm plate returns a hard bright line, and
     because the plate stands proud of the display that line moves against the
     readout underneath — the cue the eye actually uses to place the glass. */
  vec2 e = (vHalf - abs(m)) ;
  float edge = 1.0 - smoothstep(0.0012, 0.0042, min(e.x, e.y));
  col += vec3(0.55, 0.68, 0.85) * edge * (0.6 + 2.4*fres) * (0.4 + 0.6*uPower) * 1.1;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

export class HoloScreen {
  /**
   * @param {{name:string,w:number,h:number,res?:number,tint?:number,curve?:number}} spec
   */
  constructor(spec) {
    this.name = spec.name;
    this.spec = spec;
    const aspect = spec.w / spec.h;
    // Layout resolution and sampling resolution are separate. Panels are laid
    // out in `res` design units — every draw call in Cockpit.js is written
    // against those — and rendered into a canvas `ss` times larger. Raising
    // `res` to sharpen the image would otherwise shrink all the content on it,
    // because the drawing code works in absolute pixels.
    const DW = spec.res || 512;
    const DH = Math.round(DW / aspect);
    const ss = spec.ss || 2;
    this.canvas = document.createElement('canvas');
    this.canvas.width = DW * ss;
    this.canvas.height = DH * ss;
    this.ctx = this.canvas.getContext('2d');
    this.W = DW; this.H = DH;         // design units, what ScreenGfx sees
    this.ss = ss;

    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // The panels are drawn well above their on-screen size so glyphs stay
    // crisp, which means they are always minified — without mipmaps that
    // shimmers every time the ship moves. The redraws are throttled and
    // staggered, so regenerating the chain is affordable.
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = true;
    this.tex.anisotropy = 8;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      // A display sits a few millimetres proud of the panel it is set into, and
      // at a grazing angle that gap is well inside depth-buffer noise — which
      // is what made the screens z-fight and crawl. Biasing them toward the
      // viewer settles it without having to hand-tune every mounting offset.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      uniforms: {
        uMap: { value: this.tex },
        uTime: { value: 0 },
        uPower: { value: 0 },
        uTint: { value: new THREE.Color(spec.tint ?? 0xffffff) },
        uCamPos: { value: new THREE.Vector3() },
        uCurve: { value: spec.curve ?? 0.10 },
        uGlitch: { value: 0 },
        uBoot: { value: 1 },
        uTexel: { value: new THREE.Vector2(1 / this.canvas.width, 1 / this.canvas.height) },
        uSize: { value: new THREE.Vector2(spec.w, spec.h) },
        uEnvGain: { value: spec.envGain ?? 5.0 },
        /* Scene radiance, not a display value. See the block in FRAG: the
           floor keeps the dim two-thirds of the panel exactly where it has
           always been and the headroom is what lets a white readout clip. */
        uHdr: { value: new THREE.Vector2(spec.hdrLo ?? 4.6, spec.hdrHi ?? 420.0) },
        uScanPerM: { value: spec.scanPerM ?? 340.0 },
        uGrillePerM: { value: spec.grillePerM ?? 430.0 },
        /* Emitter depth over panel size, per axis: a 6 mm stack behind a
           0.86 m panel shifts the image by 0.7% of its width at 45 degrees.
           Small on purpose — this is a cue, not an effect, and anything you
           can consciously see is wrong. */
        uParallax: {
          value: new THREE.Vector2(
            (spec.gapZ ?? 0.006) / spec.w, (spec.gapZ ?? 0.006) / spec.h),
        },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.w, spec.h, 1, 1), this.material);
    this.mesh.layers.set(INTERIOR_LAYER);
    this.mesh.frustumCulled = false;
    if (spec.pos) this.mesh.position.fromArray(spec.pos);
    if (spec.rot) this.mesh.rotation.fromArray(spec.rot);

    /* The machined home this display sits in. `bezelFront` is the standoff
       from the canvas to the front face of the bay's own bezel, which is
       `face + lip` in tools/interior_bake/42_cockpit.py's screen_bay() — the
       same number Interior.js states as `spillZ` less the 4 mm the spill quad
       floats by. Everything the module hangs on the panel is measured from
       there, so a bay that gets deeper only has to say so once. */
    const front = (spec.spillZ ?? 0.041) - 0.004;
    const small = Math.min(spec.w, spec.h) < 0.14;
    this.bay = {
      front,
      gap: spec.bayGap ?? (small ? 0.010 : 0.012),
      rail: spec.railW ?? (small ? 0.017 : 0.028),
      rise: spec.railRise ?? (small ? 0.006 : 0.010),
      keys: spec.keys ?? (Math.min(spec.w, spec.h) >= 0.25 ? 5 : 0),
      latches: spec.latches ?? (small ? 0 : 2),
      small,
    };

    /* Spill onto the bezel. Parented to the display, so it inherits the rake
       and the yaw of whatever bay it sits in and only the standoff along the
       panel normal has to be stated. It has to clear the module's own bezel or
       the wash is a quad the bezel occludes, so both come off `this.bay`. */
    const M = spec.spill ?? (this.bay.gap + this.bay.rail);
    if (M > 0) {
      const W = spec.w + M * 2, H = spec.h + M * 2;
      this.spillMat = new THREE.ShaderMaterial({
        vertexShader: SPILL_VERT, fragmentShader: SPILL_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: {
          uMap: { value: this.tex },
          uInner: { value: new THREE.Vector2(spec.w / (2 * W), spec.h / (2 * H)) },
          uSoft: { value: new THREE.Vector2(M / W, M / H) },
          uPower: { value: 0 },
          uTint: { value: new THREE.Color(spec.tint ?? 0xffffff) },
          uGain: { value: spec.spillGain ?? 2.2 },
        },
      });
      this.spill = new THREE.Mesh(new THREE.PlaneGeometry(W, H, 1, 1), this.spillMat);
      this.spill.position.z = front + this.bay.rise + 0.002;
      this.spill.renderOrder = 18;
      this.spill.frustumCulled = false;
      this.spill.layers.set(INTERIOR_LAYER);
      this.mesh.add(this.spill);
    }

    this._acc = 0;
    this.interval = 1 / 20;
    this.dirty = true;
  }

  /** @param {(g:ScreenGfx)=>void} fn */
  draw(fn) {
    this.gfx = this.gfx || new ScreenGfx(this.ctx, this.W, this.H, this.ss);
    this.gfx.reset();
    fn(this.gfx);
    this.tex.needsUpdate = true;
  }

  /** Kick off the power-on sweep. */
  boot(delay = 0) { this._bootT = -delay; }

  update(dt, camPos, power) {
    const u = this.material.uniforms;
    u.uTime.value += dt;
    u.uCamPos.value.copy(camPos);
    u.uPower.value += (power - u.uPower.value) * Math.min(1, dt * 4);
    if (this.spillMat) this.spillMat.uniforms.uPower.value = u.uPower.value;
    if (this._bootT !== undefined) {
      this._bootT += dt;
      const k = THREE.MathUtils.clamp(this._bootT / 0.85, 0, 1);
      u.uBoot.value = 1 - k;
      if (k >= 1) this._bootT = undefined;
    }
    this._acc += dt;
    if (this._acc >= this.interval) { this._acc = 0; return true; }
    return false;
  }
}

/* ==========================================================================
   The module around the glass.

   A canvas in a hole reads as a web page pasted to a panel however good the
   canvas is. What a real MFD has, and what this builds, is: a bezel with
   genuine section — an inner chamfer, a flat land, an outer chamfer and a
   skirt onto the fascia — countersunk fasteners along the top and bottom
   rails, over-centre latches on the port rail, a column of physical keycaps
   with lit legends on the starboard rail, and indicator blocks beside them.
   None of it is on the glass. That is the point: the reference photograph's
   keys are *hardware next to a display*, and drawing them into the canvas
   would reproduce exactly the flatness being complained about.

   Everything is welded per material and per cockpit rather than per screen, so
   six instrument modules cost four draw calls between them.
   ========================================================================== */

/** A rounded-rectangle path with outward normals, counter-clockwise. */
function roundRectPath(hw, hh, r, cseg) {
  const R = Math.min(r, hw * 0.9, hh * 0.9);
  const out = [];
  const corners = [[1, 1, 0], [-1, 1, Math.PI / 2], [-1, -1, Math.PI], [1, -1, Math.PI * 1.5]];
  for (const [sx, sy, a0] of corners) {
    const cx = sx * (hw - R), cy = sy * (hh - R);
    for (let k = 0; k <= cseg; k++) {
      const a = a0 + (k / cseg) * (Math.PI / 2);
      const nu = Math.cos(a), nv = Math.sin(a);
      out.push([cx + nu * R, cy + nv * R, nu, nv]);
    }
  }
  return out;
}

/**
 * Sweep a 2D section around a rounded rectangle.
 *
 * `profile` is a list of [outward offset, z]. Repeat a point to get a hard
 * crease: the quad between the duplicates is degenerate, so the vertices
 * either side of it keep their own faces' normals instead of averaging across
 * the edge — which is the difference between a machined bezel and a bar of
 * soap.
 */
function sweepFrame(hw, hh, r, profile, cseg = 3) {
  const path = roundRectPath(hw, hh, r, cseg);
  const N = path.length, M = profile.length;
  const pos = new Float32Array(N * M * 3);
  const uvs = new Float32Array(N * M * 2);
  let p = 0, q = 0;
  for (let i = 0; i < N; i++) {
    const [u, v, nu, nv] = path[i];
    for (let j = 0; j < M; j++) {
      pos[p++] = u + nu * profile[j][0];
      pos[p++] = v + nv * profile[j][0];
      pos[p++] = profile[j][1];
      uvs[q++] = i / (N - 1);
      uvs[q++] = j / (M - 1);
    }
  }
  const idx = [];
  for (let i = 0; i < N; i++) {
    const i2 = (i + 1) % N;
    for (let j = 0; j < M - 1; j++) {
      const a = i * M + j, b = a + 1, c = i2 * M + j, d = c + 1;
      idx.push(a, b, c, c, b, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** A keycap: square, dished, and tapered the way a moulded cap actually is. */
function keycap(w, h, d, taper = 0.72) {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 4, 1, false);
  g.rotateY(Math.PI / 4);
  g.rotateX(Math.PI / 2);
  // the cylinder's own scaling is uniform, so square it up and taper the face
  const p = g.attributes.position;
  const K = 0.5 * Math.SQRT1_2;       // circumradius -> half-width, at 45 deg
  for (let i = 0; i < p.count; i++) {
    const front = p.getZ(i) > 0;
    const t = front ? taper : 1;
    p.setXYZ(i, p.getX(i) / K * w * 0.5 * t, p.getY(i) / K * h * 0.5 * t,
      front ? d : 0);
  }
  g.computeVertexNormals();
  return g;
}

function bolt(r, h) {
  const g = new THREE.CylinderGeometry(r * 0.82, r, h, 6, 1, false);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, h * 0.5);
  return g;
}

function slab(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, 0, d * 0.5);
  return g;
}

/**
 * Lit hardware: keycap legends and indicator blocks, welded into one mesh.
 *
 * Vertex colours carry scene radiance directly — a `MeshBasicMaterial` is
 * `color * vColor` and the attribute is float, so values well over one survive
 * to the HDR target. That is what lets a caution block clip while the keycap
 * legends beside it stay as backlights.
 */
class LampBank {
  constructor() { this.parts = []; this.meta = new Map(); this._c = new THREE.Color(); }

  add(key, geo, hex, gain) {
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(geo);
    this.meta.set(key, { geo, n, hex, gain });
    this.set(key, hex, gain);
    return this;
  }

  set(key, hex, gain) {
    const m = this.meta.get(key);
    if (!m) return;
    const c = this._c.setHex(hex, THREE.SRGBColorSpace).multiplyScalar(gain);
    if (m.mesh) {
      const a = m.mesh.geometry.attributes.color;
      for (let i = 0; i < m.n; i++) a.setXYZ(m.start + i, c.r, c.g, c.b);
      a.needsUpdate = true;
    } else {
      const a = m.geo.attributes.color;
      for (let i = 0; i < m.n; i++) a.setXYZ(i, c.r, c.g, c.b);
    }
  }

  build() {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    let off = 0;
    for (const m of this.meta.values()) { m.start = off; off += m.n; }
    const mesh = new THREE.Mesh(merged, stripLogDepth(new THREE.MeshBasicMaterial({
      vertexColors: true, toneMapped: true,
    })));
    mesh.layers.set(INTERIOR_LAYER);
    mesh.frustumCulled = false;
    for (const m of this.meta.values()) {
      m.mesh = mesh;
      if (m.geo !== merged) m.geo.dispose();
    }
    this.parts.length = 0;
    return mesh;
  }
}

/**
 * Build every instrument module in the cockpit.
 *
 * @param {HoloScreen[]} screens
 * @param {object} materials  the cabin's material set, so the bezels are made
 *                            of the same painted alloy as everything else
 * @returns {{meshes:THREE.Mesh[], lamps:LampBank, glassMat:THREE.ShaderMaterial}}
 */
export function buildScreenModules(screens, materials) {
  const byMat = new Map();        // material -> geometry[]
  const glass = [];
  const lamps = new LampBank();
  const put = (mat, geo, mtx) => {
    if (mtx) geo.applyMatrix4(mtx);
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(geo);
  };

  for (const s of screens) {
    const { w, h } = s.spec;
    const bay = s.bay;
    s.mesh.updateMatrix();
    const mtx = s.mesh.matrix.clone();

    const hw = w / 2 + bay.gap - 0.004;
    const hh = h / 2 + bay.gap - 0.004;
    const F = bay.front, RW = bay.rail, RS = bay.rise;
    const cham = Math.min(0.005, RW * 0.22);

    /* The section, read from the glass outward: a lip that starts *below* the
       bay's own bezel face so no seam shows, a chamfer up onto the land, the
       land itself, an outer chamfer, and a skirt down onto the fascia.
       Duplicated points are creases. */
    const prof = [
      [0, F - 0.008], [0, F + 0.002], [0, F + 0.002],
      [cham, F + RS], [cham, F + RS],
      [RW - cham * 1.8, F + RS], [RW - cham * 1.8, F + RS],
      [RW, F + 0.002], [RW, F + 0.002],
      [RW + 0.002, F - 0.012],
    ];
    put(materials.dark, sweepFrame(hw, hh, bay.small ? 0.008 : 0.014, prof, 3), mtx);

    /* A case, for the modules that are not sunk into a fascia. The glareshield
       strip is bolted onto a curved casting and stands 20 mm off it; without a
       box behind it and a pair of brackets it is a rectangle hanging in the
       air in front of the shield. */
    if (s.spec.caseDepth) {
      const D = s.spec.caseDepth;
      // front face just *behind* the canvas, so the case is a box the display
      // is set into rather than a lid over it
      const box = slab(hw * 2 + RW * 1.6, hh * 2 + RW * 1.6, D);
      box.translate(0, 0, -D - 0.001);
      put(materials.dark, box, mtx);
      for (const su of [-1, 1]) {
        const br = slab(0.020, hh * 1.1, D * 0.9);
        br.translate(su * hw * 0.78, 0, -D * 1.9 - 0.001);
        put(materials.rail, br, mtx);
      }
    }

    // ---- countersunk fasteners along the top and bottom rails, and at the
    //      four corners, which is where a panel this size is actually held on
    const fr = bay.small ? 0.0030 : 0.0042;
    const land = hw + (RW + cham - cham * 1.8) * 0.5;
    const landV = hh + (RW + cham - cham * 1.8) * 0.5;
    const nf = bay.small ? 2 : 4;
    for (let i = 0; i < nf; i++) {
      const u = (-1 + 2 * (i + 0.5) / nf) * (hw - 0.02);
      for (const sv of [-1, 1]) {
        const g = bolt(fr, 0.0022);
        g.translate(u, sv * landV, F + RS);
        put(materials.rail, g, mtx.clone());
      }
    }
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const g = bolt(fr * 1.15, 0.0026);
        g.translate(su * (hw - 0.002), sv * (hh - 0.002), F + RS);
        put(materials.rail, g, mtx.clone());
      }
    }

    /* ---- over-centre latches on the port rail. A rack instrument is not
       glued in: it is held by two quarter-turn latches you could reach with a
       gloved hand, and the shadow they throw across the rail is most of what
       says the module is a separate part from the fascia it is in. */
    for (let i = 0; i < bay.latches; i++) {
      const v = (bay.latches === 1 ? 0 : (i ? 1 : -1)) * hh * 0.42;
      const base = slab(RW * 0.62, 0.030, 0.0055);
      base.translate(-land, v, F + RS);
      put(materials.dark, base, mtx.clone());
      const lever = slab(RW * 0.34, 0.021, 0.0060);
      lever.translate(-land, v, F + RS + 0.0055);
      put(materials.rail, lever, mtx.clone());
      const pin = bolt(0.0022, 0.004);
      pin.translate(-land, v + 0.0085, F + RS + 0.0115);
      put(materials.rail, pin, mtx.clone());
    }

    /* ---- the keycap column, on the starboard rail beside the glass.
       Sized to the rail rather than added outboard of it: there is no room
       between the centre bay and its neighbours — 42_cockpit.py says the same
       thing about the switch banks — and the reference's keys sit in the
       bezel's own width anyway. */
    if (bay.keys > 0) {
      const cw = RW * 0.52, ch = Math.min(0.013, h / (bay.keys + 3));
      const pitch = ch * 1.42;
      const top = (bay.keys - 1) * pitch * 0.5;
      for (let i = 0; i < bay.keys; i++) {
        const v = top - i * pitch;
        const cap = keycap(cw, ch, 0.0052);
        cap.translate(land, v, F + RS);
        put(materials.accent, cap, mtx.clone());
        // the lit legend, on the cap face. Amber, the way a backlit legend on
        // an oxide cap is, and frankly oversized: a 2 mm legend is a sub-pixel
        // emissive, which is not dim, it is absent.
        const lg = new THREE.PlaneGeometry(cw * 0.58, ch * 0.40);
        lg.translate(land, v, F + RS + 0.0054);
        lg.applyMatrix4(mtx);
        /* Authored to clip, and it costs the exposure meter nothing to do it:
           the luminance the auto-exposure integrates is clamped at six units,
           so what a bright emissive charges is its *area*, not its value. A
           legend nine pixels across can sit at twenty units and be the hottest
           thing in the cabin for the price of forty pixels. */
        lamps.add(`${s.name}:k${i}`, lg, 0xffc040, i === 0 ? 22.0 : 13.0);
      }
      // and the indicator blocks under them, which are the panel's loudest
      // emissives and the ones that are meant to clip
      for (let i = 0; i < 3; i++) {
        const v = -top - pitch * (i + 1.15);
        const blk = new THREE.PlaneGeometry(cw * 0.88, ch * 0.40);
        blk.translate(land, v, F + RS + 0.0012);
        blk.applyMatrix4(mtx.clone());
        lamps.add(`${s.name}:i${i}`, blk, 0x7fd8ff, 40.0);
      }
    }

    /* ---- the cover pane. Set back inside the bezel land so the bezel wraps
       it, and standing well clear of the canvas: the standoff is the whole
       reason the sheen, the dirt and the bevel have parallax against the
       readout underneath.

       Floored, never behind the canvas: the archive terminal is flush-mounted
       on a wall panel and its bay standoff is 2 mm, so a fixed setback put its
       pane inside the display, where the depth test simply ate it. */
    const gz = Math.max(F - 0.006, 0.004);
    const gw = w / 2 + bay.gap * 0.55, gh = h / 2 + bay.gap * 0.55;
    const pane = new THREE.PlaneGeometry(gw * 2, gh * 2, 1, 1);
    const n = pane.attributes.position.count;
    const half = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { half[i * 2] = gw; half[i * 2 + 1] = gh; }
    pane.setAttribute('aHalf', new THREE.BufferAttribute(half, 2));
    pane.translate(0, 0, gz);
    pane.applyMatrix4(mtx.clone());
    glass.push(pane);
  }

  const meshes = [];
  for (const [mat, parts] of byMat) {
    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => { if (p !== merged) p.dispose(); });
    const m = new THREE.Mesh(merged, mat);
    m.layers.set(INTERIOR_LAYER);
    m.frustumCulled = false;
    meshes.push(m);
  }

  let glassMat = null;
  if (glass.length) {
    glassMat = new THREE.ShaderMaterial({
      vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uCamPos: { value: new THREE.Vector3() },
        uEnvGain: { value: 13.0 },
        uSheen: { value: 14.0 },
        // the coaming wash bar, transcribed from Interior.js's cLamp()
        uLampA: { value: new THREE.Vector3(-1.21, 0.966, -6.578) },
        uLampB: { value: new THREE.Vector3(1.21, 0.966, -6.578) },
        uLampCol: { value: new THREE.Color(0xffe6c8) },
        uGrime: { value: 0.16 },
        uPower: { value: 0 },
      },
    });
    const merged = mergeGeometries(glass, false);
    glass.forEach((p) => { if (p !== merged) p.dispose(); });
    const gm = new THREE.Mesh(merged, glassMat);
    gm.layers.set(INTERIOR_LAYER);
    gm.frustumCulled = false;
    gm.renderOrder = 19;
    meshes.push(gm);
  }

  const lampMesh = lamps.build();
  if (lampMesh) meshes.push(lampMesh);

  return { meshes, lamps, glassMat };
}

/* ------------------------------------------------------------------ canvas */

const CY = '#8fe4ff';
const AM = '#ffc48a';
const DIM = 'rgba(150,196,214,0.42)';

/** A tiny vector vocabulary so every panel is drawn in the same language. */
export class ScreenGfx {
  constructor(ctx, w, h, ss = 1) { this.c = ctx; this.w = w; this.h = h; this.ss = ss; }

  reset() {
    const { c, w, h, ss } = this;
    // Every coordinate below this line is in design units; the supersample
    // factor lives entirely in this transform.
    c.setTransform(ss, 0, 0, ss, 0, 0);
    c.clearRect(0, 0, w, h);
    // a faint charged backlight, so an idle panel still looks powered
    const bg = c.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#07131c');
    bg.addColorStop(1, '#040a10');
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(143,228,255,0.20)';
    c.lineWidth = 3;
    c.strokeRect(3, 3, w - 6, h - 6);
    c.textBaseline = 'alphabetic';
  }

  font(px, weight = '') { this.c.font = `${weight} ${px}px ui-monospace, "SF Mono", Menlo, monospace`; return this; }

  text(s, x, y, { size = 16, color = CY, align = 'left', track = 0, alpha = 1 } = {}) {
    const c = this.c;
    c.save();
    c.globalAlpha = alpha;
    this.font(size);
    c.fillStyle = color;
    if (track > 0) {
      let str = String(s);
      let total = 0;
      for (const ch of str) total += c.measureText(ch).width + track;
      let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
      for (const ch of str) { c.fillText(ch, cx, y); cx += c.measureText(ch).width + track; }
    } else {
      c.textAlign = align;
      c.fillText(String(s), x, y);
      c.textAlign = 'left';
    }
    c.restore();
    return this;
  }

  line(x0, y0, x1, y1, color = DIM, width = 1, alpha = 1) {
    const c = this.c;
    c.save(); c.globalAlpha = alpha;
    c.strokeStyle = color; c.lineWidth = width;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.restore();
    return this;
  }

  rect(x, y, w, h, color = DIM, width = 1, alpha = 1) {
    const c = this.c;
    c.save(); c.globalAlpha = alpha;
    c.strokeStyle = color; c.lineWidth = width;
    c.strokeRect(x, y, w, h);
    c.restore();
    return this;
  }

  fill(x, y, w, h, color, alpha = 1) {
    const c = this.c;
    c.save(); c.globalAlpha = alpha; c.fillStyle = color;
    c.fillRect(x, y, w, h); c.restore();
    return this;
  }

  arc(cx, cy, r, a0, a1, color = CY, width = 2, alpha = 1) {
    const c = this.c;
    c.save(); c.globalAlpha = alpha;
    c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round';
    c.beginPath(); c.arc(cx, cy, r, a0, a1); c.stroke();
    c.restore();
    return this;
  }

  dot(x, y, r, color = CY, alpha = 1) {
    const c = this.c;
    c.save(); c.globalAlpha = alpha; c.fillStyle = color;
    c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill(); c.restore();
    return this;
  }

  /** Section header with a rule, used on every panel for consistency. */
  header(label, x, y, w, color = DIM) {
    this.text(label, x, y, { size: 15, color, track: 3.4 });
    this.line(x, y + 8, x + w, y + 8, color, 1, 0.5);
    return this;
  }

  /**
   * Horizontal bar meter.
   *
   * The body of the bar is deliberately held back and the value edge is the
   * bright thing. A full-width solid fill in a saturated colour is the largest
   * area of light on any of these panels, and once the emissives were authored
   * in real HDR every one of them blew out and streaked — a hundred-millimetre
   * bar has no business being the brightest object in the cockpit. What the
   * eye reads on a meter is *where the edge is*, so that is what gets the
   * radiance.
   */
  meter(x, y, w, h, v, { color = CY, bg = 'rgba(143,228,255,0.10)', ticks = 0 } = {}) {
    const k = Math.max(0, Math.min(1, v));
    this.fill(x, y, w, h, bg);
    this.fill(x, y, w * k, h, color, 0.5);
    if (k > 0.004) this.fill(x + Math.max(0, w * k - 2.5), y, 2.5, h, color);
    for (let i = 1; i < ticks; i++) this.fill(x + (w * i) / ticks, y - 2, 1, h + 4, 'rgba(3,8,13,0.9)');
    return this;
  }

  /**
   * A sub-panel: a hairline box with a filled caption bar along its top.
   *
   * This is the single largest difference between the reference photographs of
   * a real MFD and a canvas full of type. A real display is *partitioned* — six
   * or eight framed regions, each with its own caption, each holding one kind
   * of thing — because the pilot navigates it by position, not by reading. A
   * page of left-aligned columns floating in whitespace navigates by reading,
   * which is what a web page is.
   *
   * Returns the inner rectangle so the caller never repeats the inset.
   */
  group(x, y, w, h, label, { color = DIM, cap = 11, accent = null } = {}) {
    const c = this.c;
    c.save();
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(10,26,38,0.5)';
    c.fillRect(x, y, w, h);
    c.fillStyle = 'rgba(143,228,255,0.10)';
    c.fillRect(x, y, w, cap);
    if (accent) { c.fillStyle = accent; c.fillRect(x, y, 2, cap); }
    c.strokeStyle = 'rgba(143,228,255,0.26)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    c.restore();
    if (label) this.text(label, x + (accent ? 6 : 4), y + cap - 3, { size: 7.5, color, track: 1.5 });
    return { x: x + 4, y: y + cap + 3, w: w - 8, h: h - cap - 7 };
  }

  /**
   * Vertical bar in a well, with a tick scale down one side.
   *
   * A rank of these is the cheapest way to put *shape* on a panel — the eye
   * reads six columns of different heights in one glance and never has to
   * resolve a digit, which is exactly what an engine page is for.
   */
  vbar(x, y, w, h, v, { color = CY, label = null, ticks = 4 } = {}) {
    const k = Math.max(0, Math.min(1, v));
    this.fill(x, y, w, h, 'rgba(143,228,255,0.09)');
    const bh = Math.round(h * k);
    if (bh > 0) {
      this.fill(x, y + h - bh, w, bh, color, 0.42);
      this.fill(x, y + h - bh, w, Math.min(2, bh), color);
    }
    for (let i = 1; i < ticks; i++) {
      this.fill(x, y + Math.round((h * i) / ticks), w, 1, 'rgba(3,10,16,0.8)');
    }
    if (label) this.text(label, x + w / 2, y + h + 8, { size: 6.5, color: DIM, align: 'center' });
    return this;
  }

  /**
   * A rank of small mono glyphs at fixed pitch — the reference's "G G G" row.
   *
   * Deliberately not readable at a glance and deliberately not decorative
   * either: a channel identifier and a one-character state, which is what a
   * bus page actually shows.
   */
  glyphs(x, y, pitch, items, { size = 7 } = {}) {
    items.forEach(([ch, col, on], i) => {
      this.text(ch, x + i * pitch, y, { size, color: col, alpha: on ? 1 : 0.22 });
    });
    return this;
  }

  /** A block of lit indicator cells — the reference's coloured tiles. */
  blocks(x, y, w, h, cells, { gap = 4 } = {}) {
    const cw = (w - gap * (cells.length - 1)) / cells.length;
    cells.forEach(([col, on], i) => {
      const cx = x + i * (cw + gap);
      // A lit cell is held at 0.88 so it stays under the display's HDR knee.
      // At full strength these are the widest solid strokes on the panel, and
      // a rank of them at two hundred units is a row of blown white squares
      // with the bloom of a landing light — which is what the first pass was.
      this.fill(cx, y, cw, h, col, on ? 0.88 : 0.14);
      this.fill(cx, y + h - 1, cw, 1, 'rgba(3,10,16,0.75)');
    });
    return this;
  }
}

export { CY, AM, DIM };
