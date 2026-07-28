import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HoloScreen, buildScreenModules, CY, AM, DIM } from './HoloScreen.js';
import { INTERIOR_LAYER } from './interiorMaterials.js';
import { LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';

/* Scratch vectors for the panel's flight maths. Allocated once: drawMain runs
   on a redraw timer and a new Vector3 per readout per frame is garbage the
   collector then has to find in the middle of a 16 ms budget. */
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/* ============================================================================
   Everything diegetic: the console panels, the tactical hologram in the console
   well, and the volumetric system model over the navigation table.

   The rule followed here is that instruments are *in the world*. Nothing that
   belongs on a dashboard is drawn as a screen-space overlay, so the only DOM
   left is subtitles and the interaction prompt.
   ========================================================================== */

/* --------------------------------------------------------- holo materials */

const HOLO_VERT = /* glsl */`${LOGD_V_PARS}
varying vec3 vLocal;
varying vec3 vWPos;
void main(){
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGD_V}
}
`;

const HOLO_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec3 vLocal;
varying vec3 vWPos;
uniform vec3  uColor;
uniform float uTime;
uniform float uPower;
uniform float uScanH;     // height of the scan band in local units
void main(){
  /* no LOGD_F: interior-only, and writing gl_FragDepth would cost early-Z */
  // horizontal build-up scan, plus fine slice lines: the two cues that read
  // instantly as "projected volume" rather than "solid object"
  float band = exp(-pow((vLocal.y - fract(uTime*0.11)*uScanH*2.0 + uScanH*0.5)/(uScanH*0.10), 2.0));
  float slice = 0.55 + 0.45*sin(vLocal.y*260.0);
  // Additive blending, so anything over 1 clips to white and the volume
  // loses its shape. Kept under unity except on the build-up band.
  float a = uPower * (0.26 + band*0.85) * slice;
  gl_FragColor = vec4(uColor*a, a);
}
`;

/**
 * @param {number} color
 * @param {number} scanH  height of the build-up band, in local units
 * @param {number} gain   radiance multiplier
 *
 * `gain` exists because the tactical plot lives in a machined well that is now
 * genuinely dark, and an additive line at unit radiance under a 0.045 exposure
 * lands at nine thousandths of a display unit — present in the buffer and
 * invisible on the screen. The nav table sits in open cabin light and wants
 * none of it, so the multiplier is per-instrument rather than in the shader.
 */
export function holoMat(color, scanH = 0.2, gain = 1) {
  return new THREE.ShaderMaterial({
    vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(color).multiplyScalar(gain) },
      uTime: { value: 0 }, uPower: { value: 1 }, uScanH: { value: scanH },
    },
  });
}

/* ================================================================ COCKPIT */

/* --------------------------------------------------------- directive strip

   The pilot's standing order, on the glareshield, where an advisory annunciator
   goes on anything that flies.

   It used to be a DOM card floating at the top of the screen — which drew *over*
   the canopy structure, so the one piece of information the game most wants you
   to read was also the one thing in the frame that proved none of this is real.
   Nothing on a dashboard is a screen-space overlay.

   The transform is measured off tools/interior_bake/42_cockpit.py's coaming.
   `coam_crown(0)` puts the crown datum at (1.096, -6.530); `_coam_sect`'s roll
   and aft-face run, corrected for the section's forward lean, put the casting's
   aft surface at (y 1.070, z -6.4785) falling to (y 1.040, z -6.466), with
   world z = crown_z - a. The registers cut into that face are at x -1.16,
   -0.90, -0.64, +0.40 and +0.96, so the centre 0.85 m of it is clear.

   Held 20 mm proud on its own case, because the shield is a curved casting and
   this is a bolt-on box: the seated sight line to it runs 12.1 to 14.9 degrees
   below the horizon, which is between the crown roll at 11.6 and the main
   display's bezel at 15.1. It therefore reads against the shield rather than
   against the sky, and takes nothing off the window — `tools/framing.mjs` is
   the check that matters and it stays where it was. */
const DIRECTIVE_SPEC = {
  name: 'directive', w: 0.50, h: 0.030,
  pos: [0, 1.0605, -6.4588], rot: [-0.28, 0, 0],
  res: 1000, ss: 2,
  spillZ: 0.014, bayGap: 0.005, railW: 0.011, railRise: 0.005,
  keys: 0, latches: 0, spill: 0.016, spillGain: 2.6, caseDepth: 0.024,
  curve: 0.05, scanPerM: 900, grillePerM: 900,
  hdrLo: 5.2, hdrHi: 320.0, envGain: 4.0,
};

export class Cockpit {
  constructor(interior, game) {
    this.game = game;
    this.interior = interior;
    this.screens = {};
    this.holoMats = [];

    for (const spec of [...interior.screens, DIRECTIVE_SPEC]) {
      const s = new HoloScreen(spec);
      this.screens[spec.name] = s;
      interior.root.add(s.mesh);
    }
    // stagger redraws so four canvases never land on the same frame
    Object.values(this.screens).forEach((s, i) => { s._acc = (i * 0.25) * s.interval; });

    /* Bezels, latches, fasteners, keycaps, indicator blocks and cover glass —
       welded per material across the whole cockpit, so six instrument modules
       cost four draw calls between them. This has to run after the screens
       exist and after `mergeStatic`, which is why it is here and not in
       Interior.js. */
    const mod = buildScreenModules(Object.values(this.screens), interior.materials);
    this.lamps = mod.lamps;
    this.glassMat = mod.glassMat;
    this.moduleMeshes = mod.meshes;
    for (const m of mod.meshes) { m.receiveShadow = true; interior.root.add(m); }

    this._buildRadar();
    this._buildNavHologram();
    this._buildStationMarker();

    this._blipPool = [];
    this._navPool = [];
    this._v = new THREE.Vector3();
    for (const s of Object.values(this.screens)) {
      s.draw((gfx) => { gfx.text('INITIALISING', 20, 40, { size: 16 }); });
    }
  }

  /* ------------------------------------------------------------- radar */

  /**
   * The tactical plot in the pedestal well.
   *
   * Every static element is welded into one geometry. That is not a
   * micro-optimisation: the radar is added to the cabin *after* `mergeStatic`
   * has run, so each mesh here is its own draw call, and the old eleven-piece
   * plot cost eleven of them for three rings, four spokes and a cage. Merged,
   * the same budget buys a bearing scale, a lattice on the plate and elevation
   * struts — which is the difference between a graphic and an instrument. Only
   * the sweep stays separate, because it turns.
   */
  _buildRadar() {
    const g = new THREE.Group();
    g.position.set(0, 0.795, -5.80);
    this.radar = g;
    this.interior.root.add(g);

    const mat = holoMat(0x8fe4ff, 0.16, 3.0);
    this.holoMats.push(mat);
    this.radarMat = mat;

    this.radarR = 0.15;
    const R = this.radarR;
    const parts = [];
    const push = (geo, x = 0, y = 0, z = 0, ry = 0) => {
      if (ry) geo.rotateY(ry);
      geo.translate(x, y, z);
      parts.push(geo);
    };
    /* A line on the plate, as a flat quad rather than a box: the plot is only
       ever seen from above, so the four vertical faces of a 0.9 mm box are
       four triangles nobody can see, and there are a hundred and forty of
       them. */
    const seg = (x0, z0, x1, z1, w, y = 0) => {
      const dx = x1 - x0, dz = z1 - z0;
      const l = Math.hypot(dx, dz) || 1;
      const q = new THREE.PlaneGeometry(l, w);
      q.rotateX(-Math.PI / 2);
      q.rotateY(Math.atan2(-dz, dx));
      q.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
      return q;
    };
    const ring = (r, w, y = 0, n = 72) => {
      const t = new THREE.TorusGeometry(r, w, 4, n);
      t.rotateX(Math.PI / 2);
      t.translate(0, y, 0);
      return t;
    };

    // ---- range rings, the outer one heavier, plus a half-range dashed ring
    for (const [f, w] of [[0.34, 0.0007], [0.67, 0.0007], [1.0, 0.0016]]) {
      parts.push(ring(R * f, w));
    }
    for (let i = 0; i < 48; i += 2) {
      const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2;
      parts.push(seg(Math.cos(a0) * R * 0.845, Math.sin(a0) * R * 0.845,
        Math.cos(a1) * R * 0.845, Math.sin(a1) * R * 0.845, 0.0006));
    }
    /* Bearing scale, ticking *inward* from the rim. Outward ticks put the
       scale at r = R + 0.020, which is 0.170 — outside the 0.156 wall of the
       well the plot sits in, so a third of the scale was buried in the
       machined bezel. */
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const l = i % 3 === 0 ? 0.018 : 0.009;
      parts.push(seg(Math.cos(a) * R, Math.sin(a) * R,
        Math.cos(a) * (R - l), Math.sin(a) * (R - l), i % 9 === 0 ? 0.0016 : 0.0008));
    }
    // ---- spokes, and a fine lattice on the plate clipped to the disc. The
    //      lattice is what gives a plot a floor: without it a contact hangs in
    //      a void with nothing to measure its position against.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push(seg(0, 0, Math.cos(a) * R, Math.sin(a) * R, i % 2 ? 0.0005 : 0.0008));
    }
    const NL = 7;
    for (let i = 1; i < NL; i++) {
      const t = (i / NL) * 2 - 1;
      const h = Math.sqrt(Math.max(0, 1 - t * t)) * R;
      parts.push(seg(t * R, -h, t * R, h, 0.0004));
      parts.push(seg(-h, t * R, h, t * R, 0.0004));
    }
    // ---- elevation cage: two rings and four struts, so a contact's stalk has
    //      something to be a height *against*
    for (const sy of [-1, 1]) {
      parts.push(ring(R * 0.62, 0.0005, sy * R * 0.42, 48));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const s = new THREE.BoxGeometry(0.0006, R * 0.42, 0.0006);
        s.translate(Math.cos(a) * R * 0.62, sy * R * 0.21, Math.sin(a) * R * 0.62);
        parts.push(s);
      }
    }
    // ---- own ship, and a heading wedge ahead of it
    const own = new THREE.ConeGeometry(0.006, 0.018, 4);
    own.rotateX(-Math.PI / 2);
    parts.push(own);
    parts.push(seg(0, -0.012, 0.010, -0.030, 0.0006));
    parts.push(seg(0, -0.012, -0.010, -0.030, 0.0006));
    // ---- a scale bar, inboard of the port rim
    parts.push(seg(-R * 0.80, R * 0.44, -R * 0.80, R * 0.08, 0.0008));
    for (const zz of [R * 0.44, R * 0.26, R * 0.08]) {
      parts.push(seg(-R * 0.84, zz, -R * 0.74, zz, 0.0008));
    }

    const merged = mergeGeometries(parts, false);
    parts.forEach((p) => { if (p !== merged) p.dispose(); });
    const plate = new THREE.Mesh(merged, mat);
    plate.layers.set(INTERIOR_LAYER);
    g.add(plate);

    // sweep wedge — the one moving part, so the one that cannot be welded in.
    // Its own material at a lower gain: at the plate's gain a solid 24-degree
    // wedge is far brighter than the lines it is sweeping over.
    const sweepMat = holoMat(0x8fe4ff, 0.16, 0.85);
    this.holoMats.push(sweepMat);
    const sweepGeo = new THREE.CircleGeometry(R, 20, 0, 0.42);
    sweepGeo.rotateX(-Math.PI / 2);
    this.sweep = new THREE.Mesh(sweepGeo, sweepMat);
    this.sweep.layers.set(INTERIOR_LAYER);
    g.add(this.sweep);
  }

  _blip(i) {
    if (!this._blipPool[i]) {
      const grp = new THREE.Group();
      const m = holoMat(0x8fe4ff, 0.1, 3.4);
      this.holoMats.push(m);
      const dot = new THREE.Mesh(new THREE.OctahedronGeometry(0.005, 0), m);
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.0007, 1, 0.0007), m);
      stalk.name = 'stalk';
      grp.add(dot, stalk);
      grp.layers.set(INTERIOR_LAYER);
      grp.traverse((o) => o.layers.set(INTERIOR_LAYER));
      this.radar.add(grp);
      this._blipPool[i] = { grp, dot, stalk, mat: m };
    }
    return this._blipPool[i];
  }

  /* --------------------------------------------------- station highlight */

  _buildStationMarker() {
    // Four corner brackets that snap around whatever you can reach. Reads as a
    // targeting overlay rather than a glow, which is the difference between
    // "this is interactive" and "this is shiny".
    const g = new THREE.Group();
    const mat = holoMat(0x8fe4ff, 0.4);
    this.holoMats.push(mat);
    this.markerMat = mat;
    const L = 0.09, T = 0.006;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const c = new THREE.Group();
        c.add(new THREE.Mesh(new THREE.BoxGeometry(L, T, T), mat).translateX(-sx * L / 2));
        c.add(new THREE.Mesh(new THREE.BoxGeometry(T, L, T), mat).translateY(-sy * L / 2));
        c.position.set(sx * 0.20, sy * 0.14, 0);
        g.add(c);
      }
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.0022, 6, 40), mat);
    g.add(ring);
    this.markerRing = ring;
    g.traverse((o) => o.layers.set(INTERIOR_LAYER));
    g.visible = false;
    this.stationMarker = g;
    this.interior.root.add(g);
  }

  /* ------------------------------------------------------- nav hologram */

  _buildNavHologram() {
    const g = new THREE.Group();
    g.position.set(0, 1.30, 2.6);
    this.nav = g;
    this.interior.root.add(g);

    const mat = holoMat(0x8fe4ff, 0.5);
    this.holoMats.push(mat);
    this.navMat = mat;

    this.navStar = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 2), mat);
    g.add(this.navStar);

    this.navOrbits = new THREE.Group();
    g.add(this.navOrbits);
    this.navBodies = new THREE.Group();
    g.add(this.navBodies);

    // ship marker
    this.navShip = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.034, 4), holoMat(0xffc48a, 0.5));
    this.holoMats.push(this.navShip.material);
    g.add(this.navShip);

    g.traverse((o) => o.layers.set(INTERIOR_LAYER));
    g.visible = false;
  }

  /** Rebuild the volumetric orbit rings when the system changes. */
  rebuildNav(system) {
    const g = this.navOrbits;
    while (g.children.length) { g.children[0].geometry.dispose(); g.remove(g.children[0]); }
    while (this.navBodies.children.length) this.navBodies.remove(this.navBodies.children[0]);
    this._navPool.length = 0;

    const maxR = Math.max(...system.planets.map((p) => p.orbitR), 1);
    this.navScale = 0.62 / maxR;

    for (const p of system.planets) {
      const r = p.orbitR * this.navScale;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0009, 4, 96), this.navMat);
      ring.rotation.x = Math.PI / 2;
      g.add(ring);

      const m = holoMat(0x9fe8ff, 0.2);
      this.holoMats.push(m);
      const body = new THREE.Mesh(
        new THREE.IcosahedronGeometry(p.type === 'gas' ? 0.019 : 0.012, 1), m);
      this.navBodies.add(body);
      this._navPool.push({ mesh: body, spec: p, mat: m });
    }
    this.navOrbits.traverse((o) => o.layers.set(INTERIOR_LAYER));
    this.navBodies.traverse((o) => o.layers.set(INTERIOR_LAYER));
  }

  /* ------------------------------------------------------------- update */

  update(dt, ctx) {
    const g = this.game;
    const power = ctx.power;

    for (const m of this.holoMats) {
      m.uniforms.uTime.value += dt;
      m.uniforms.uPower.value += (power - m.uniforms.uPower.value) * Math.min(1, dt * 3);
    }
    this.sweep.rotation.y -= dt * 1.15;

    // ---- radar contacts
    const ship = g.ship;
    const range = ctx.radarRange;
    const inv = new THREE.Quaternion().copy(ship.quat).invert();
    let n = 0;
    const sorted = g.bodies.slice()
      .sort((a, b) => a.absPos.distanceToSquared(ship.absPos) - b.absPos.distanceToSquared(ship.absPos))
      .slice(0, 12);
    for (const b of sorted) {
      const rel = this._v.copy(b.absPos).sub(ship.absPos);
      const d = rel.length();
      if (d > range) continue;
      rel.applyQuaternion(inv).multiplyScalar(this.radarR / range);
      const bl = this._blip(n++);
      bl.grp.visible = true;
      // -Z forward maps to +Z on the plate so the display matches the canopy
      bl.grp.position.set(rel.x, THREE.MathUtils.clamp(rel.y, -0.075, 0.075), -rel.z);
      bl.dot.scale.setScalar(b.kind === 'star' ? 1.8 : b.kind === 'anomaly' ? 1.3 : 1);
      const h = Math.abs(bl.grp.position.y);
      bl.stalk.scale.y = Math.max(h, 0.0005);
      bl.stalk.position.y = -bl.grp.position.y / 2;
      // re-applied every frame, so the gain has to be re-applied with it
      bl.mat.uniforms.uColor.value.set(
        b === g.target ? 0xffc48a : b.kind === 'anomaly' ? 0xffa96a : b.scanned ? 0x8affc1 : 0x8fe4ff)
        .multiplyScalar(3.4);
    }
    for (let i = n; i < this._blipPool.length; i++) this._blipPool[i].grp.visible = false;

    // ---- nav hologram
    this.nav.visible = ctx.navActive;
    if (ctx.navActive && this._navPool.length) {
      this.navStar.material.uniforms.uColor.value.copy(g.star.color).multiplyScalar(2.2);
      for (const it of this._navPool) {
        const body = g.bodies.find((b) => b.spec === it.spec);
        if (!body) continue;
        it.mesh.position.set(body.absPos.x * this.navScale, body.absPos.y * this.navScale * 0.3,
          body.absPos.z * this.navScale);
        it.mat.uniforms.uColor.value.set(body === g.target ? 0xffc48a : body.scanned ? 0x8affc1 : 0x9fe8ff);
      }
      this.navShip.position.set(ship.absPos.x * this.navScale,
        ship.absPos.y * this.navScale * 0.3 + 0.02, ship.absPos.z * this.navScale);
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quat);
      this.navShip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), f);
    }

    // ---- station highlight
    const st = ctx.station;
    const sm = this.stationMarker;
    this._smK = THREE.MathUtils.lerp(this._smK || 0, st ? 1 : 0, Math.min(1, dt * 9));
    sm.visible = this._smK > 0.02;
    if (sm.visible) {
      const look = st ? st.look : sm.position;
      sm.position.lerp(look, Math.min(1, dt * 14));
      sm.lookAt(ctx.camPos);
      const pop = 1.0 + (1 - this._smK) * 0.5;
      sm.scale.setScalar(pop * (0.85 + 0.15 * this._smK));
      this.markerMat.uniforms.uPower.value = this._smK * (0.7 + 0.3 * Math.sin(ctx.time * 4.0));
      this.markerRing.rotation.z += dt * 0.8;
    }

    // ---- panels
    for (const s of Object.values(this.screens)) {
      if (s.update(dt, ctx.camPos, power)) this._drawScreen(s, ctx);
    }

    // ---- the cover glass over all of them
    if (this.glassMat) {
      this.glassMat.uniforms.uCamPos.value.copy(ctx.camPos);
      const u = this.glassMat.uniforms.uPower;
      u.value += (power - u.value) * Math.min(1, dt * 4);
    }

    /* ---- the hardware beside the glass.
       Indicator blocks are physical lamps on the bezel rail, so they say what
       the machine is doing whatever page a display happens to be on. They are
       the loudest emissives in the cabin on purpose: the cabin measured 0.000%
       of pixels at display white in every frame, and a frame in which nothing
       clips reads as flat. */
    const blink = Math.sin(ctx.time * 7.2) > 0;
    const hot = ctx.warn ? (blink ? 78 : 6) : 0;
    const st8 = [
      ship.hull < 0.4 ? [0xff5a3a, blink ? 70 : 10] : [0x62ff8a, 42],
      ship.foldCharge > 0.99 ? [0x7fd8ff, 52] : [0x7fd8ff, 11],
      ctx.warn ? [0xff8a3a, hot]
        : g.scanProgress > 0.001 ? [0xffc040, 46] : [0x4a6a80, 3],
    ];
    if (this._lampT === undefined || Math.abs(this._lampT - ctx.time) > 0.06) {
      this._lampT = ctx.time;
      for (const nm of ['main', 'left', 'right']) {
        for (let i = 0; i < 3; i++) this.lamps.set(`${nm}:i${i}`, st8[i][0], st8[i][1] * power);
      }
    }

    // ---- the directive strip flashes when the standing order changes
    const d = g.directive;
    if (d !== this._lastDir) {
      this._lastDir = d;
      if (this.screens.directive) this.screens.directive.boot(0);
    }
  }

  _drawScreen(s, ctx) {
    const fn = {
      main: drawMain, left: drawSystems, right: drawContacts,
      radarLabel: drawRadarLabel, archive: drawArchiveIdle, lower: drawLower,
      directive: drawDirective,
    }[s.name];
    if (fn) s.draw((gfx) => fn(gfx, this.game, ctx));
  }
}

/* ============================================================ panel content */

/* Two colours carry the whole tone hierarchy on these panels.

   `HI` is the only thing on a display authored to clip. The headroom in
   HoloScreen's response curve opens above luminance 0.86, so anything painted
   at or above that goes to two hundred units of scene radiance and blows the
   top off the tone curve — which is exactly what should happen to the one line
   telling the pilot what to do, and exactly what should not happen to a column
   of secondary readouts. Everything that used to be '#dff4ff' or '#eafaff' was
   sitting just over that line, so *every* value on the panel blazed at once and
   auto-exposure stopped the whole cabin down to pay for it. `VAL` sits
   deliberately under the knee. */
const HI = '#ffffff';
const VAL = '#cfe6f4';

function fmtDist(d) {
  if (d < 1) return `${Math.round(d * 1000)} m`;
  if (d < 1000) return `${d.toFixed(1)} km`;
  if (d < 1e6) return `${(d / 1000).toFixed(1)} Mm`;
  return `${(d / 149597870).toFixed(3)} AU`;
}

/**
 * What the pilot should do right now, in one line.
 *
 * This is the thing the cockpit was missing. Every readout on the old panel
 * described state — speed, attitude, a target's classification — and none of it
 * said what to press or why, so sitting down at the helm told you nothing.
 */
function nextAction(game) {
  const t = game.target;
  if (game.scanProgress > 0.001) {
    return { line: `SCANNING   ${Math.round(game.scanProgress * 100)}%`, hot: true };
  }
  if (!t) return { line: 'AIM AT A WORLD', hot: false };
  if (t.scanned) return { line: 'CATALOGUED  —  PICK A NEW TARGET', hot: false };
  if (game.scanTarget === t) return { line: 'HOLD   F   TO SCAN', hot: true };
  if (game.autopilot) return { line: 'AUTOPILOT  —  CLOSING', hot: false };
  return { line: 'OUT OF RANGE  —  G  TO APPROACH', hot: false };
}

/**
 * The glareshield strip: one line, the standing order, at eye level.
 *
 * 720 x 40 design units on a 360 x 20 mm panel, which is about 690 x 38 device
 * pixels from the seat on a 2x display — one line of type and no more, which is
 * the whole brief for an annunciator. Anything that needs a second line belongs
 * on the main display underneath.
 */
function drawDirective(g, game, ctx) {
  const { w, h } = g;
  const d = game.directive;
  const warn = ctx.warn;
  const label = warn ? 'CAUTION' : 'DIRECTIVE';
  const col = warn ? '#ff8a5e' : AM;
  // the lit edge, which is what a real annunciator has instead of a border
  g.fill(8, 8, 6, h - 16, col);
  g.text(label, 28, h * 0.66, { size: 17, color: col, track: 3.6 });
  const body = warn ? warn : d ? String(d.short).toUpperCase() : 'STAND BY';
  g.text(body, 208, h * 0.68, { size: 30, color: warn ? '#ffe4d4' : HI, track: 1.6 });
  if (!warn && d && d.total > 1) {
    g.text(`${d.done}/${d.total}`, w - 26, h * 0.68, { size: 26, color: AM, align: 'right' });
    // a progress rule under the type, so the count is also a shape
    const p = Math.max(0, Math.min(1, d.done / d.total));
    const bw = w - 340;
    g.fill(208, h - 11, bw * p, 3, AM);
    g.fill(208 + bw * p, h - 11, bw * (1 - p), 3, 'rgba(255,196,138,0.18)');
  } else if (!warn) {
    g.text('INSTITUTE RELAY', w - 26, h * 0.68, { size: 17, color: DIM, align: 'right', track: 2.6 });
  }
}

/**
 * The pilot's primary panel.
 *
 * Third pass, and this one is about what a display *is* rather than about what
 * it says. The review's finding was blunt: "the centre MFD is a web page — 40 px
 * crisp text, left-aligned columns, generous leading, whitespace-first layout,
 * no pixel structure, no scanline, no phosphor bleed into the bezel, no parallax
 * under the cover pane. It reads as a browser overlay glued to a quad."
 *
 * The reference it was measured against does the opposite, on purpose: the
 * content is small enough to be *nearly unreadable*, because the subject of the
 * photograph is the hardware. Three things follow from that, and all three are
 * here.
 *
 *   Partition. A real panel is six or eight framed regions, each captioned, each
 *   holding one kind of thing, navigated by position rather than by reading. The
 *   old layout was three columns of type floating in a black field with 30% of
 *   the panel empty. Everything now lives in a `group` — a hairline box with a
 *   filled caption bar — and the boxes tile the panel with a 6-unit gutter.
 *
 *   Density. Type is 6.5 to 9.5 design units where it was 8.5 to 19, and there
 *   are fifty-odd readouts where there were twenty. Most of them are never read.
 *   That is the point: what says "this machine knows things" is the count of
 *   things it is telling you, not the legibility of any one of them.
 *
 *   Shape. Half of what is on the panel now is not type at all — six vertical
 *   bar columns in tick wells, a bearing tape, a hull plan with lit zones, two
 *   ranks of bus glyphs, a contact list with signal bars. A page of pure type is
 *   a document; the colour that is *not* type is what photographs as an
 *   instrument.
 *
 * The single exception is the action line, which stays at 14 units and keeps its
 * lit edge. A flight display has exactly one thing on it you are meant to read
 * from across the cockpit, and hiding the game's only instruction inside the
 * texture in the name of authenticity would be a worse panel, not a better one.
 */
function drawMain(g, game, ctx) {
  const { w, h } = g;
  const ship = game.ship;
  const t = game.target;
  /* Plant load, not `ship.power` — that uniform drives the exhaust plume and
     reads 0 whenever the pilot is coasting, which put a dead PWR column in the
     middle of the engine page on a ship that was plainly running. */
  const P = Math.min(1, 0.30 + ship.throttle * 0.55
    + (ship.foldMode ? 0.25 : 0) + (ship.heat || 0) * 0.12);

  /* Label over value, at instrument scale. `vw` right-aligns the value in a
     column of that width, which is how a rank of numbers gets a decimal point
     that lines up. */
  const kv = (label, val, x, y, col = VAL, vw = 0) => {
    g.text(label, x, y, { size: 6.5, color: DIM, track: 1.1 });
    g.text(val, vw ? x + vw : x, y + 12, {
      size: 9.5, color: col, align: vw ? 'right' : 'left', track: 0.2,
    });
  };
  const pct = (v) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}`;
  const on = (k) => ((game.state?.resonance ?? 0) + k) % 3 !== 0;

  /* ---- top rail: the standing order, and eight lamps that are not type.
     Height 15 of 303, and it runs the full width — a caption bar for the whole
     panel rather than a heading with air under it. */
  g.fill(4, 4, w - 8, 15, 'rgba(143,228,255,0.13)');
  g.fill(4, 4, 2, 15, AM);
  const dir = game.directive;
  g.text('DIR', 16, 15, { size: 7, color: AM, track: 1.6 });
  g.text(dir ? String(dir.short).toUpperCase() : 'STAND BY', 41, 15,
    { size: 8.5, color: VAL, track: 0.9 });
  if (dir && dir.total > 1) {
    g.text(`${dir.done}/${dir.total}`, 236, 15, { size: 8, color: AM, align: 'right' });
  }
  // eight annunciators along the rail. Two are live, six are the machine's
  // opinion of itself, and none of them has to be read.
  const rail = [
    ['#8affc1', ship.hull > 0.4], ['#8affc1', 1], [CY, ship.assist],
    [CY, ship.foldCharge > 0.99], [AM, game.scanProgress > 0.001],
    ['#ffc48a', on(1)], ['#4a6a80', 0], ['#ff6b5e', !!ctx.warn],
  ];
  g.blocks(w - 156, 7, 150, 9, rail, { gap: 3 });

  /* ================================================================ row A */
  const AY = 23, AH = 126;

  // ---- TARGET: what the instruction refers to
  const tg = g.group(4, AY, 218, AH, 'TARGET  ·  DESIGNATION', { accent: CY });
  if (t) {
    const d = Math.max(0, t.absPos.distanceTo(ship.absPos) - (t.radius || 0));
    const kind = t.kind === 'anomaly' ? (t.anomalyType || 'ANOMALY').toUpperCase()
      : t.kind === 'star' ? `${t.spec.cls}-CLASS STAR`
        : (t.spec?.type || 'WORLD').toUpperCase();
    g.text(t.name.toUpperCase(), tg.x + 2, tg.y + 11, { size: 11, color: '#eef9ff', track: 0.6 });
    g.text(`${kind}${t.scanned ? '  ·  CAT' : ''}`, tg.x + 2, tg.y + 21,
      { size: 6.5, color: t.scanned ? '#8affc1' : DIM, track: 1.4 });

    const rel = _v0.copy(t.absPos).sub(ship.absPos);
    const fwd = _v1.set(0, 0, -1).applyQuaternion(ship.quat);
    const up = _v2.set(0, 1, 0).applyQuaternion(ship.quat);
    const rt = _v3.crossVectors(fwd, up).normalize();
    const rn = rel.length() || 1;
    const brg = Math.atan2(rel.dot(rt) / rn, rel.dot(fwd) / rn) * 57.2958;
    const elv = Math.asin(Math.max(-1, Math.min(1, rel.dot(up) / rn))) * 57.2958;
    const clo = -rel.normalize().dot(ship.vel);

    const CW = 69;
    kv('RANGE', fmtDist(d), tg.x + 2, tg.y + 34, AM);
    kv('BEARING', `${brg >= 0 ? '+' : ''}${brg.toFixed(0)}°`, tg.x + 2 + CW, tg.y + 34);
    kv('ELEV', `${elv >= 0 ? '+' : ''}${elv.toFixed(0)}°`, tg.x + 2 + CW * 2, tg.y + 34);
    kv('CLOSURE', `${clo.toFixed(1)} km/s`, tg.x + 2, tg.y + 58,
      clo > 0.05 ? '#8affc1' : DIM);
    kv('DIA', `${((t.radius || 0) * 2).toFixed(0)} km`, tg.x + 2 + CW, tg.y + 58);
    kv('SIG', t.scanned ? 'RESOLVED' : 'PARTIAL', tg.x + 2 + CW * 2, tg.y + 58,
      t.scanned ? '#8affc1' : AM);

    /* Bearing tape, across the bottom of the box. Ninety degrees either side of
       the nose with the target's marker sliding along it — a scale is the one
       way a number ever tells you *how far off* you are, and it costs six
       fills. */
    const TX = tg.x + 2, TW = tg.w - 4, TY = tg.y + 76;
    g.fill(TX, TY, TW, 12, 'rgba(143,228,255,0.08)');
    for (let i = 0; i <= 12; i++) {
      const bx = TX + (TW * i) / 12;
      const big = i % 3 === 0;
      g.fill(bx, TY + (big ? 0 : 4), 1, big ? 12 : 5, 'rgba(143,228,255,0.34)');
    }
    const bk = Math.max(0, Math.min(1, brg / 180 + 0.5));
    g.fill(TX + TW * bk - 1.5, TY - 2, 3, 16, AM);
    g.text('−90', TX, TY + 21, { size: 6, color: DIM });
    g.text('NOSE', TX + TW / 2, TY + 21, { size: 6, color: DIM, align: 'center' });
    g.text('+90', TX + TW, TY + 21, { size: 6, color: DIM, align: 'right' });
  } else {
    g.text('NO TARGET', tg.x + 2, tg.y + 11, { size: 11, color: DIM, track: 1.6 });
    g.text('AIM AT A WORLD TO DESIGNATE', tg.x + 2, tg.y + 21,
      { size: 6.5, color: DIM, track: 1.4 });
    for (let i = 0; i < 6; i++) {
      kv(['RANGE', 'BEARING', 'ELEV', 'CLOSURE', 'DIA', 'SIG'][i], '- - -',
        tg.x + 2 + (i % 3) * 69, tg.y + 34 + Math.floor(i / 3) * 24, DIM);
    }
  }

  // ---- FLIGHT: six columns in tick wells. Shape, not type.
  const fl = g.group(226, AY, 148, AH, 'FLIGHT  ·  PLANT');
  {
    const bars = [
      ['THR', ship.throttle, ship.boost > 0.1 ? AM : CY],
      ['PWR', P, CY],
      ['CORE', ship.heat, ship.heat > 0.82 ? '#ff6b5e' : AM],
      ['FLD', ship.foldCharge, ship.foldCharge > 0.99 ? '#8affc1' : CY],
      ['HUL', ship.hull, ship.hull < 0.4 ? '#ff6b5e' : '#8affc1'],
      ['SNK', 0.18 + ship.heat * 0.5, CY],
    ];
    const BW = 15, GAP = 8, BH = 74;
    for (let i = 0; i < bars.length; i++) {
      const [lbl, v, col] = bars[i];
      g.vbar(fl.x + 3 + i * (BW + GAP), fl.y + 3, BW, BH, v, { color: col, label: lbl });
    }
    // and the two numbers the columns are of, small, under the labels
    g.line(fl.x, fl.y + BH + 15, fl.x + fl.w, fl.y + BH + 15, DIM, 1, 0.3);
    g.text('MODE', fl.x + 3, fl.y + BH + 27, { size: 6.5, color: DIM, track: 1.1 });
    g.text(ship.foldMode ? 'FOLD' : ship.boost > 0.1 ? 'BOOST' : 'CRUISE',
      fl.x + fl.w - 3, fl.y + BH + 27, { size: 8.5, color: ship.foldMode ? AM : CY, align: 'right' });
    g.text('ASSIST', fl.x + 3, fl.y + BH + 38, { size: 6.5, color: DIM, track: 1.1 });
    g.text(ship.assist ? 'ON' : 'OFF', fl.x + fl.w - 3, fl.y + BH + 38,
      { size: 8.5, color: ship.assist ? '#8affc1' : AM, align: 'right' });
  }

  // ---- HULL AND BUS: a plan of the ship with lit zones, and two glyph ranks
  const hu = g.group(378, AY, 238, AH, 'HULL  ·  BUS  ·  STORES');
  {
    /* The plan-form. Eight zones, each a cell that is lit when that part of the
       ship is intact — which is nearly always, so it reads as a diagram rather
       than as a warning. A schematic is worth four readouts because it is the
       only thing on the panel that says what shape the machine is. */
    const px = hu.x + 4, py = hu.y + 6, pw = 92, ph = 62;
    g.rect(px, py, pw, ph, 'rgba(143,228,255,0.18)', 1);
    const zone = (zx, zy, zw, zh, k) => {
      const hurt = ship.hull < 0.4 && k === 2;
      g.fill(px + zx, py + zy, zw, zh, hurt ? '#ff6b5e' : '#8affc1', hurt ? 0.8 : 0.30);
      g.rect(px + zx, py + zy, zw, zh, 'rgba(3,10,16,0.6)', 1);
    };
    zone(34, 2, 24, 14, 0);            // nose
    zone(30, 17, 32, 20, 1);           // cockpit
    zone(26, 38, 40, 22, 2);           // habitat
    zone(4, 22, 20, 12, 3);            // port pod
    zone(68, 22, 20, 12, 4);           // starboard pod
    zone(4, 36, 20, 10, 5);
    zone(68, 36, 20, 10, 6);
    zone(38, 50, 16, 9, 7);
    g.text('AIRFRAME', px, py + ph + 9, { size: 6, color: DIM, track: 1.2 });

    // right of the plan: eight readouts in two columns
    const RX = hu.x + 104, CW = 66;
    const rows = [
      ['HULL', `${pct(ship.hull)}%`, ship.hull < 0.4 ? '#ff6b5e' : '#8affc1'],
      ['FOLD', `${pct(ship.foldCharge)}%`, ship.foldCharge > 0.99 ? '#8affc1' : CY],
      ['CORE', `${(280 + ship.heat * 620).toFixed(0)}K`, ship.heat > 0.82 ? '#ff6b5e' : AM],
      ['PWR', `${pct(P)}%`, CY],
      ['SYSTEM', (game.system?.star?.name || '—').toUpperCase().slice(0, 8), VAL],
      ['BODIES', String(game.system?.bodies?.length ?? 0), CY],
      ['CATALOG', String(game.discoveries?.size ?? 0), AM],
      ['RESON', `${game.state?.resonance ?? 0}/7`, AM],
    ];
    for (let i = 0; i < rows.length; i++) {
      kv(rows[i][0], rows[i][1], RX + (i % 2) * CW, hu.y + 2 + Math.floor(i / 2) * 22,
        rows[i][2]);
    }

    /* Two ranks of bus glyphs along the bottom. Twelve characters that mean
       nothing anybody will decode and everything anybody can glance at: this is
       the colour that is not type. */
    const GY = hu.y + hu.h - 6;
    g.text('BUS', hu.x + 4, GY - 13, { size: 6, color: DIM, track: 1.2 });
    g.glyphs(hu.x + 28, GY - 13, 15, [
      ['A', CY, 1], ['B', CY, 1], ['C', CY, on(1)], ['D', '#8affc1', 1],
      ['E', AM, on(2)], ['F', CY, 1], ['G', '#4a6a80', 0], ['H', CY, on(0)],
      ['J', '#8affc1', 1], ['K', AM, on(4)], ['L', CY, 1], ['M', '#4a6a80', 0],
      ['N', CY, on(3)], ['P', '#8affc1', 1],
    ]);
    g.text('STO', hu.x + 4, GY, { size: 6, color: DIM, track: 1.2 });
    g.blocks(hu.x + 28, GY - 7, 208, 7, [
      ['#8affc1', 1], ['#8affc1', on(0)], [CY, on(4)], ['#4a6a80', 0],
      [AM, ship.heat > 0.5], [CY, 1], ['#8affc1', on(2)], ['#4a6a80', 0],
      [CY, on(1)], [AM, 0],
    ], { gap: 3 });
  }

  /* ================================================================ row B

     Two boxes, not four. The seated view is pitched about six degrees down and
     the centre pedestal's front lip stands in front of the panel's bottom
     edge: measured off the frame, everything below about 94% of the panel
     height is behind the console and cannot be seen from the seat at rest
     pitch. Content there is content nobody will ever look at, so the layout
     ends at 91% and the soft-key strip sits on the line rather than under it.
  */
  const BY = AY + AH + 5, BH = 104;

  // ---- ACTION and VELOCITY. The one line on this panel meant to be read from
  //      across the cockpit, and the two numbers you steer by underneath it.
  const act = nextAction(game);
  const ag = g.group(4, BY, 370, BH, 'ACTION  ·  VELOCITY', { accent: act.hot ? AM : CY });
  g.fill(ag.x, ag.y + 1, ag.w, 28, act.hot ? 'rgba(255,170,110,0.13)' : 'rgba(143,228,255,0.07)');
  g.fill(ag.x, ag.y + 1, 3, 28, act.hot ? AM : CY);
  g.text(act.line, ag.x + 12, ag.y + 21,
    { size: act.line.length > 30 ? 11.5 : 14, color: act.hot ? '#ffd8b0' : HI, track: 0.9 });
  g.meter(ag.x, ag.y + 32, ag.w, 5, game.scanProgress, { color: AM, ticks: 10 });
  {
    let num, unit;
    if (ship.foldMode) { num = (ship.speed / 299792.458).toFixed(2); unit = 'c'; }
    else if (ship.speed < 1) { num = String(Math.round(ship.speed * 1000)); unit = 'm/s'; }
    else { num = ship.speed.toFixed(0); unit = 'km/s'; }
    const vy = ag.y + 44;
    g.text(num, ag.x + 2, vy + 17, { size: 19, color: ship.foldMode ? AM : HI });
    g.font(19);
    g.text(unit, ag.x + 7 + g.c.measureText(num).width, vy + 17,
      { size: 7, color: DIM, track: 1.2 });
    const sf = Math.min(1, ship.speed / (ship.maxSpeed * ship.boostMul));
    g.meter(ag.x + 2, vy + 23, 168, 6, sf, { color: ship.boost > 0.1 ? AM : CY, ticks: 8 });
    g.text('THR', ag.x + 186, vy + 6, { size: 6.5, color: DIM, track: 1.2 });
    g.meter(ag.x + 212, vy, 152, 6, ship.throttle,
      { color: ship.boost > 0.1 ? AM : CY, ticks: 4 });
    /* Drift: the angle between where the nose points and where the ship is
       actually going. With flight assist off that is the whole story of the
       handling model, and with it on it is a needle that sits at zero and
       twitches — which is exactly what an instrument should do. */
    const fw = _v1.set(0, 0, -1).applyQuaternion(ship.quat);
    const sp = ship.vel.length();
    const drift = sp > 0.02
      ? Math.acos(Math.max(-1, Math.min(1,
        _v0.copy(ship.vel).divideScalar(sp).dot(fw)))) * 57.2958
      : 0;
    g.text('DRIFT', ag.x + 186, vy + 20, { size: 6.5, color: DIM, track: 1.2 });
    g.meter(ag.x + 212, vy + 14, 152, 6, drift / 90,
      { color: drift > 25 ? AM : CY, ticks: 4 });
    g.text(`SCAN ${game.scanProgress > 0.001 ? `${pct(game.scanProgress)}%` : 'IDLE'}`
      + `   AP ${game.autopilot ? 'ENGAGED' : 'STBY'}`
      + `   ASSIST ${ship.assist ? 'ON' : 'OFF'}`
      + `   LOAD ${Math.round(P * 100)}%   BUS ${(P * 118).toFixed(0)}V`,
      ag.x + 2, vy + 40, { size: 6.5, color: DIM, track: 0.7 });
  }

  // ---- CONTACTS, and under them the machine talking to itself
  const cg = g.group(378, BY, 238, BH, 'CONTACTS  ·  PASSIVE');
  {
    const near = (game.bodies || [])
      .filter((b) => b !== ship)
      .map((b) => ({ b, d: b.absPos.distanceTo(ship.absPos) }))
      .sort((a2, b2) => a2.d - b2.d)
      .slice(0, 6);
    for (let i = 0; i < 6; i++) {
      const y = cg.y + 8 + i * 9;
      const it = near[i];
      if (!it) { g.text('—', cg.x + 2, y, { size: 6.5, color: DIM }); continue; }
      const sel = it.b === t;
      g.text(String(it.b.name).toUpperCase().slice(0, 17), cg.x + 2, y,
        { size: 6.5, color: sel ? AM : VAL, track: 0.5 });
      g.text(fmtDist(it.d), cg.x + 152, y, { size: 6.5, color: DIM, align: 'right' });
      const sg = Math.max(0.06, Math.min(1, 2.4 / (1 + it.d / 2000)));
      g.fill(cg.x + 158, y - 5, 70, 5, 'rgba(143,228,255,0.07)');
      g.fill(cg.x + 158, y - 5, 70 * sg, 5, sel ? AM : CY, sel ? 0.85 : 0.34);
    }
    g.line(cg.x, cg.y + 59, cg.x + cg.w, cg.y + 59, DIM, 1, 0.3);
    /* Four lines nobody reads, cycling. The most instrument-like thing that can
       be on a panel is a machine narrating itself to nobody in particular. */
    const tick = Math.floor((ctx.time || 0) * 0.7);
    const log = [
      ['NAV', 'EPHEMERIS SYNC OK'],
      ['PWR', `BUS ${(P * 118).toFixed(0)}V NOMINAL`],
      ['SCN', game.scanProgress > 0.001 ? 'ACQUIRING' : 'ARRAY IDLE'],
      ['FLD', ship.foldCharge > 0.99 ? 'COIL CHARGED' : `COIL ${pct(ship.foldCharge)}%`],
      ['THM', `RAD ${(280 + ship.heat * 620).toFixed(0)}K`],
    ];
    for (let i = 0; i < 3; i++) {
      const row = log[(tick + i) % log.length];
      const y = cg.y + 68 + i * 9;
      g.text(row[0], cg.x + 2, y, { size: 6.5, color: AM, track: 0.8 });
      g.text(row[1], cg.x + 26, y, { size: 6.5, color: DIM, track: 0.4 });
    }
  }

  /* ---- soft-key legends along the bottom edge.

     The reference photograph's subject is not its display, it is the rank of
     amber keycaps beside it — and what makes a bank of unlabelled keys read as
     a control rather than as decoration is a legend strip on the glass telling
     you what each one currently does. The bay's own keycaps are modelled on the
     starboard rail in HoloScreen's buildScreenModules; this is the other half
     of that pair, and it also stops the panel dying away into an empty band
     along its bottom sixth. */
  {
    const KY = 262, KN = 8, KW = (w - 8 - (KN - 1) * 3) / KN;
    const page = ['NAV', 'SYS', 'CON', 'SCN', 'FLD', 'MAP', 'CFG', 'DIM'];
    const live = [0, 3, 4];
    for (let i = 0; i < KN; i++) {
      const kx = 4 + i * (KW + 3);
      const hotKey = live.includes(i);
      g.fill(kx, KY, KW, 14, hotKey ? 'rgba(255,196,138,0.16)' : 'rgba(143,228,255,0.07)');
      g.fill(kx, KY + 13, KW, 1, hotKey ? AM : 'rgba(143,228,255,0.24)');
      g.text(page[i], kx + KW / 2, KY + 10,
        { size: 7, color: hotKey ? AM : DIM, align: 'center', track: 1.2 });
    }
  }

  // ---- warnings win over everything
  if (ctx.warn) {
    const blink = (Math.sin(performance.now() * 0.012) > 0) ? 1 : 0.3;
    g.fill(4, 4, w - 8, 15, 'rgba(255,80,60,0.45)', blink);
    g.text(ctx.warn, w / 2, 15, { size: 9, color: '#ffd9d2', align: 'center', track: 2.2, alpha: blink });
  }
}

function drawSystems(g, game, ctx) {
  const { w } = g;
  const ship = game.ship;
  g.header('SYSTEMS', 16, 28, w - 32);

  const rows = [
    ['HULL', ship.hull, '#8affc1'],
    ['FOLD CHARGE', ship.foldCharge, CY],
    ['CORE TEMP', ship.heat, ship.heat > 0.82 ? '#ff6b5e' : AM],
    ['SCANNER', 1, CY],
  ];
  let y = 62;
  for (const [label, v, col] of rows) {
    g.text(label, 16, y, { size: 13, color: DIM, track: 2 });
    g.text(`${Math.round(v * 100)}%`, w - 16, y, { size: 13, color: col, align: 'right' });
    g.meter(16, y + 8, w - 32, 5, v, { color: col });
    y += 44;
  }

  g.line(16, y - 6, w - 16, y - 6, DIM, 1, 0.3);
  g.text('SYSTEM', 16, y + 20, { size: 12, color: DIM, track: 2 });
  g.text(game.system.star.name.toUpperCase(), w - 16, y + 20, { size: 14, color: VAL, align: 'right' });
  g.text('CATALOGUED', 16, y + 44, { size: 12, color: DIM, track: 2 });
  g.text(String(game.discoveries.size), w - 16, y + 44, { size: 14, color: AM, align: 'right' });
  g.text('RESONANCE', 16, y + 68, { size: 12, color: DIM, track: 2 });
  g.text(`${game.state.resonance} / 7`, w - 16, y + 68, { size: 14, color: AM, align: 'right' });
}

function drawContacts(g, game, ctx) {
  const { w, h } = g;
  g.header('CONTACTS', 16, 28, w - 32);
  const ship = game.ship;
  const list = game.bodies.slice()
    .sort((a, b) => a.absPos.distanceToSquared(ship.absPos) - b.absPos.distanceToSquared(ship.absPos))
    .slice(0, 8);
  let y = 60;
  for (const b of list) {
    const d = b.absPos.distanceTo(ship.absPos) - (b.radius || 0);
    const sel = b === game.target;
    if (sel) g.fill(10, y - 15, w - 20, 22, 'rgba(255,196,138,0.13)');
    const col = sel ? AM : b.kind === 'anomaly' ? '#ffa96a' : b.scanned ? '#8affc1' : '#bfe0ee';
    g.text(b.scanned ? '✓' : b.kind === 'anomaly' ? '◆' : '·', 16, y, { size: 13, color: col });
    g.text(b.name.slice(0, 17).toUpperCase(), 34, y, { size: 13, color: col, track: 0.5 });
    g.text(fmtDist(Math.max(d, 0)), w - 16, y, { size: 12, color: DIM, align: 'right' });
    y += 24;
  }
  g.line(16, h - 40, w - 16, h - 40, DIM, 1, 0.3);
  g.text(`${game.anomalies.filter((a) => !a.scanned).length} UNRESOLVED SIGNALS`, 16, h - 18,
    { size: 12, color: AM, track: 1.6 });
}

/**
 * The lower console strip, between the pilot's knees.
 *
 * Seven to one aspect and 0.45 m from the eye. Nothing here is read — it is
 * *glanced at*, which means bars rather than numbers and four fields rather
 * than a page. It exists so that the closest surface in the seated down-view
 * is alive instead of being a metre of blank plate, and so the console has
 * something on it that changes while you fly.
 */
function drawLower(g, game, ctx) {
  const { w, h } = g;
  const ship = game.ship;
  const cells = [
    ['PWR', ship.throttle, ship.boost > 0.1 ? AM : CY],
    ['FOLD', ship.foldCharge, CY],
    ['HULL', ship.hull, ship.hull < 0.4 ? '#ff6b5e' : '#8affc1'],
    ['TEMP', ship.heat, ship.heat > 0.82 ? '#ff6b5e' : AM],
  ];
  const pad = 14, gap = 10;
  const cw = (w - pad * 2 - gap * 3) / 4;
  cells.forEach(([label, v, col], i) => {
    const x = pad + i * (cw + gap);
    g.fill(x, 12, cw, h - 24, 'rgba(143,228,255,0.045)');
    g.text(label, x + 8, 32, { size: 13, color: DIM, track: 2.2 });
    g.text(`${Math.round(THREE.MathUtils.clamp(v, 0, 1) * 100)}`, x + cw - 8, 32,
      { size: 17, color: col, align: 'right' });
    g.meter(x + 8, 42, cw - 16, 8, v, { color: col, ticks: 4 });
  });
  // a hairline under the whole strip, so it reads as one instrument
  g.line(pad, h - 13, w - pad, h - 13, DIM, 1, 0.35);
}

function drawRadarLabel(g, game, ctx) {
  const { w } = g;
  g.text('TACTICAL', w / 2, 34, { size: 16, color: DIM, align: 'center', track: 5 });
  g.text(`RANGE ${fmtDist(ctx.radarRange)}`, w / 2, 62, { size: 15, color: CY, align: 'center', track: 2 });
}

function drawArchiveIdle(g, game, ctx) {
  const { w, h } = g;
  g.header('INSTITUTE ARCHIVE', 22, 40, w - 44);
  g.text('PROSPACER', 22, 108, { size: 34, color: VAL, track: 4 });
  g.text('COMMISSION 1101 · PALE SEEKER', 22, 138, { size: 15, color: AM, track: 2.4 });

  const rows = [
    ['SYSTEMS CHARTED', `${game.galaxy.filter((s) => s.visited).length} / ${game.galaxy.length}`],
    ['BODIES CATALOGUED', String(game.discoveries.size)],
    ['RECORDS RECOVERED', String(game.logsFound.size)],
    ['CANTOS ATTUNED', `${game.state.resonance} / 7`],
  ];
  let y = 196;
  for (const [k, v] of rows) {
    g.text(k, 22, y, { size: 15, color: DIM, track: 2 });
    g.text(v, w - 22, y, { size: 17, color: CY, align: 'right' });
    g.line(22, y + 10, w - 22, y + 10, DIM, 1, 0.25);
    y += 42;
  }
  g.text('PRESS  E  TO OPEN', w / 2, h - 26, { size: 15, color: AM, align: 'center', track: 4 });
}
