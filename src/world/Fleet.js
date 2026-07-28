import * as THREE from 'three';
import {
  M, place, panel, slab, weld, palette, emitter, dress, truss, solarWing, greebles, CHOIR_HUE,
} from '../gfx/greeble.js';
import { LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';
import { container, tint, CARGO_HUES } from './Station.js';
import { mulberry32 } from './generate.js';

/* ============================================================================
   Traffic.

   A system with nothing moving in it is a diorama. This module is what makes
   one read as inhabited: freighters grinding between worlds, couriers cutting
   across the ecliptic, tugs working a belt, and — occasionally — something that
   was not built by anyone still alive.

   Four things make traffic work at these distances:

   **A ship you cannot resolve still has to be visible.** Sixty metres of hull
   at four million kilometres is far below a pixel. Every craft therefore
   carries *beacons* — camera-facing quads whose world size is set each frame so
   they land at a constant few pixels — plus a drive plume that does the same.
   From across a system a freighter is a moving amber spark; that spark is what
   sells the place as busy, not the hull it is attached to.

   **Silhouette, and a front and a back.** These hulls are seen at forty pixels
   far more often than at four hundred, and at forty pixels nothing survives but
   the outline. So every class is built around one shape you can name — a loaded
   spine, a dart, a cab-and-engine, a cutter, a satellite — with the masses
   separated by empty space and the heavy end aft. A box with greebles on it is
   not a spacecraft at any distance.

   **Models are templates, instances are clones.** Each class is built once and
   welded per material; instances share the geometry and the materials outright,
   so twelve ships cost twelve transforms and no extra memory. All of a craft's
   running lights are one mesh and all of its plumes are another, which keeps
   even the freighter under ten draws.

   **Everything is on a schedule, not a simulation.** Craft follow analytic
   paths keyed to `time`, which means they are exactly where they should be
   after a fold jump, a system reload or a two-minute pause, with no integration
   drift and no wake-up cost.
   ========================================================================== */

const _v = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _ahead = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

/* Cold white-blue: every lamp a human being installed, anywhere in this game. */
const CABIN = 0x9ec8ff;
const NAV_STBD = 0x30ff60;
const NAV_PORT = 0xff3020;

/* -------------------------------------------------------------- the beacon

   One shared shader for every distance-locked light in the game. The vertex
   stage sizes each quad from its own view depth so it holds a fixed pixel size
   once the real geometry has shrunk below it — which is the only reason a hull
   four million kilometres away is still a moving spark rather than nothing.

   All of a craft's lights live in *one* mesh: the quad centre, colour, gain,
   physical size, pixel size and flash mode are per-vertex, so a freighter's
   eleven lamps cost one draw call and one material instead of eleven of each.
   Only the strobe phase is a uniform, because it is the one thing that has to
   differ between two ships built from the same template.

   BEACON_HDR is the difference between a running light and a grey dot, and it
   is the trap this project has written down and fallen into anyway. These quads
   land in the scene-linear HDR target and go through AgX like everything else,
   and a pixel needs something like 120 units of radiance before AgX returns
   white. The per-lamp gains are 1.2 to 2.6. So every navigation light, strobe
   and docking lamp in the fleet was authored at about two per cent of the
   value it needed, and the measured result is exactly what you would predict:
   a courier framed against a lit planet at the range a player actually sees one
   is a pale lump with a single faint green speck on it. The gains stay as they
   are — they are the *relative* weights, and they are right — and one shared
   multiplier puts the whole set into real HDR, where a nav light sits just
   under the clip point and blooms, and a xenon strobe clips hard, which is what
   a xenon strobe does. Sizing was never the problem: uMinPx already holds every
   lamp at five pixels however far away the hull is. */
const BEACON_HDR = 44.0;

const BEACON_VERT = /* glsl */`
attribute vec3 aCenter;    // lamp position, metres, ship space
attribute vec3 aTint;
attribute vec4 aParam;     // gain, physical size (world units), mode, pixel scale
uniform float uPixel;      // world units per pixel at unit depth
uniform float uMinPx;      // never smaller than this many pixels
uniform float uTime;
uniform float uPhase;
uniform float uHDR;        // scene radiance per unit of authored gain
varying vec2 vUv;
varying vec3 vCol;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  float depth = max(-mv.z, 1e-6);
  float wantPx = uMinPx * aParam.w * uPixel * depth;
  float s = max(aParam.y, wantPx);

  // 0 steady, 1 xenon anti-collision strobe, 2 slow rotating hazard beacon
  float g = aParam.x;
  if(aParam.z > 0.5){
    float fast = step(aParam.z, 1.5);
    float rate = mix(0.42, 0.92, fast);
    float duty = mix(0.22, 0.06, fast);
    float cyc  = fract(uTime*rate + uPhase + aCenter.z*0.011);
    g *= step(cyc, duty) * mix(1.7, 3.4, fast);
  }
  vCol = aTint * g * uHDR;

  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
}
`;
const BEACON_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vCol;
void main(){
  vec2 d = vUv*2.0 - 1.0;
  float r = length(d);
  // No discard: it mis-compiles against gl_FragDepth under ANGLE, and a
  // premultiplied zero is free anyway.
  float m = step(r, 1.0);
  // a tight core with a soft halo — reads as a point source under bloom
  float core = pow(max(1.0 - r, 0.0), 3.0);
  float halo = pow(max(1.0 - r, 0.0), 1.4)*0.45;
  float a = (core + halo) * m;
  gl_FragColor = vec4(vCol*a, a);
}
`;

const _quad = [[-0.5, -0.5, 0, 0], [0.5, -0.5, 1, 0], [0.5, 0.5, 1, 1], [-0.5, 0.5, 0, 1]];

/** Every lamp on a craft, merged into one distance-locked mesh. */
function makeBeacons(lights) {
  if (!lights.length) return null;
  const n = lights.length;
  const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8);
  const ctr = new Float32Array(n * 12), tint = new Float32Array(n * 12);
  const par = new Float32Array(n * 16);
  const idx = new Uint16Array(n * 6);
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const l = lights[i];
    col.set(l.hex);
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      pos[v * 3] = _quad[k][0]; pos[v * 3 + 1] = _quad[k][1];
      uv[v * 2] = _quad[k][2]; uv[v * 2 + 1] = _quad[k][3];
      ctr[v * 3] = l.pos[0]; ctr[v * 3 + 1] = l.pos[1]; ctr[v * 3 + 2] = l.pos[2];
      tint[v * 3] = col.r; tint[v * 3 + 1] = col.g; tint[v * 3 + 2] = col.b;
      par[v * 4] = l.gain;
      par[v * 4 + 1] = (l.size ?? 0.30) * M;
      par[v * 4 + 2] = l.mode ?? 0;
      par[v * 4 + 3] = l.px ?? 1.0;
    }
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aCenter', new THREE.BufferAttribute(ctr, 3));
  geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  geo.setAttribute('aParam', new THREE.BufferAttribute(par, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: BEACON_VERT, fragmentShader: BEACON_FRAG,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPixel: { value: 0.002 }, uMinPx: { value: 5.0 },
      uHDR: { value: BEACON_HDR },
      uTime: { value: 0 }, uPhase: { value: 0 },
    },
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 20;
  return m;
}

/* ------------------------------------------------------------ drive plume

   A fusion torch rather than a jet flame: a collimated near-white core,
   a cooler sheath, and standing shock cells near the throat. Cheaper than the
   player's — half the octaves and no per-craft material — but the same read, so
   a freighter's drive and the player's are visibly the same technology.

   It is drawn in world space against the log-depth buffer, so it carries the
   depth chunks; without them the plume z-fights every hull in the system. */

const TRAIL_VERT = /* glsl */`
${LOGD_V_PARS}
varying vec2 vUv;
varying vec3 vPos;
void main(){
  vUv = uv; vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
${LOGD_V}
}
`;
const TRAIL_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec2 vUv;
varying vec3 vPos;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uTime;
uniform float uPower;
void main(){
  float t = clamp(vUv.y, 0.0, 1.0);        // 0 at the throat -> 1 at the tip
  float r = abs(vUv.x - 0.5)*2.0;          // 0 on axis -> 1 at the edge
  float core   = pow(1.0-t, 2.8) * (1.0 - smoothstep(0.0, 0.42 + t*0.7, r));
  float sheath = pow(1.0-t, 1.5) * (1.0 - smoothstep(0.14, 1.0, r));
  // Standing shock cells, closely spaced at the throat and only in the first
  // third. Kept low-contrast and low-frequency on purpose: a plume a fifth the
  // length of the player's, banded at the player's rate, reads as corduroy.
  float cell = 0.5 + 0.5*sin(pow(t, 0.72)*17.0 - uTime*6.0);
  cell *= smoothstep(0.40, 0.04, t);
  float flick = 0.92 + 0.08*sin(uTime*31.0 + vPos.z*15.0);
  vec3 col = mix(uColB, uColA, clamp(core*1.7, 0.0, 1.0));
  col += uColA*cell*core*0.28;
  float a = (core*1.15 + sheath*0.26) * uPower * flick;
  a *= smoothstep(1.0, 0.28, t);
  gl_FragColor = vec4(col*a*2.4, a);
${LOGD_F}
}
`;

/** Every engine on a craft, merged into one plume mesh. */
function makePlumes(engines, mat) {
  const list = [];
  for (const e of engines) {
    const len = e.plume;
    const g = new THREE.CylinderGeometry(e.r * 0.28, e.r, len, 12, 1, true);
    g.translate(0, len / 2, 0);
    g.rotateX(Math.PI / 2);
    list.push(place(g, { pos: e.pos }));
  }
  const m = weld(list, mat, null);
  if (!m) return null;
  m.renderOrder = 12;
  return m;
}

/* ============================================================== part helpers

   Three shapes do most of the work. `slab` and the primitives make blocks and
   tubes; these turn them into vehicles.  */

/** A side profile, given in (−z, y), extruded across the beam. */
function hullSide(pts, width, o = {}) {
  return place(panel(pts, width, o.bevel ?? 0.28), {
    rot: [0, Math.PI / 2, 0], pos: [o.x || 0, o.y || 0, o.z || 0],
  });
}

/** A flat planform, given in (x, z), extruded in thickness. Wings and fins. */
function planform(pts, thick, o = {}) {
  return place(panel(pts, thick, o.bevel ?? 0.10), {
    rot: [Math.PI / 2, 0, 0], pos: [o.x || 0, o.y || 0, o.z || 0],
  });
}

/**
 * A tube from one point to another. Booms, arms and bracing get built from
 * *joints* rather than from a position and a guessed Euler triple, because a
 * guessed triple is how the old tug ended up with two grapple pads hanging in
 * space beside the hull — which an art director correctly read as broken
 * geometry rather than as cargo.
 */
function strut(p, q, r0, r1 = r0, seg = 11) {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  // a cylinder is authored along +Y; rotateX then rotateY aims it along d
  const rx = Math.acos(Math.max(-1, Math.min(1, d[1] / len)));
  const h = Math.hypot(d[0], d[2]);
  const ry = h > 1e-6 ? Math.atan2(d[0], d[2]) : 0;
  return place(new THREE.CylinderGeometry(r1, r0, len, seg), {
    pos: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], rot: [rx, ry, 0],
  });
}

/**
 * A drive bell: brushed alloy outside, sooted composite liner, one polished
 * lip ring. Three parts is the minimum that reads as a nozzle rather than as a
 * pipe, and the lip is where the hard specular hit lives.
 */
function bell(L, x, y, z, rOut, rIn, len, seg = 20) {
  L.metal.push(place(new THREE.CylinderGeometry(rOut, rIn, len, seg, 1, true), {
    pos: [x, y, z], rot: [Math.PI / 2, 0, 0],
  }));
  L.structure.push(place(new THREE.CylinderGeometry(rOut * 0.86, rIn * 0.78, len * 0.94, seg, 1, true), {
    pos: [x, y, z], rot: [Math.PI / 2, 0, 0],
  }));
  L.trim.push(place(new THREE.TorusGeometry(rOut, rOut * 0.10, 5, seg + 4), { pos: [x, y, z + len / 2] }));
}

/**
 * A lit window: a dark recess, an emissive pane and a polished sill above and
 * below it. A bare glowing rectangle laid on a hull reads as a decal; the thing
 * that makes it a *window* is that it is set into something and framed.
 * Built facing −Z at the origin and then placed, so the frame can never
 * z-fight the pane whatever angle it ends up at.
 */
function pane(L, w, h, pos, rot = [0, 0, 0], mullions = 0) {
  L.structure.push(place(place(slab(w + 0.9, h + 0.9, 0.55, 0.16), { pos: [0, 0, 0.34] }), { pos, rot }));
  L.lit.push(place(place(new THREE.PlaneGeometry(w, h), { rot: [0, Math.PI, 0] }), { pos, rot }));
  for (const s of [1, -1]) {
    L.trim.push(place(place(slab(w + 1.0, 0.26, 0.34, 0.07), { pos: [0, s * (h / 2 + 0.16), -0.10] }), { pos, rot }));
  }
  for (let i = 0; i < mullions; i++) {
    const x = (-(mullions - 1) / 2 + i) * (w / mullions);
    L.trim.push(place(place(slab(0.20, h, 0.30, 0.05), { pos: [x, 0, -0.08] }), { pos, rot }));
  }
}

/* ============================================================ ship classes

   Each class fills `L` — one array per material — and returns the parts of the
   spec that are not geometry. Everything is in metres; `buildTemplate` welds,
   lights and scales. Nose is −Z, aft is +Z, starboard is +X.  */

const CLASSES = {

  /* ------------------------------------------------------------- freighter
     A bulk hauler: a loaded spine with a bridge tower up front and a stern that
     is nothing but engine and radiator. Nothing about it is aerodynamic, which
     is the point — it never enters an atmosphere. What makes it read at forty
     pixels is that the two ends are completely different masses: a tall block
     forward, a wide one aft, and two hundred feet of stacked boxes between. */
  freighter(rnd, L) {
    const bays = 3 + Math.floor(rnd() * 2);
    const half = bays * 13;
    const aTip = half + 46;                       // bow tip, as (−z)
    const zStern = half + 16;
    const len = 2 * half + 82;

    // ---- keel: one continuous beam, so the ship is a spine and not a pile
    L.structure.push(place(slab(6.2, 3.2, 2 * half + 30, 0.5), { pos: [0, -7.0, 0] }));
    L.metal.push(...truss(2 * half + 6, 4.4, bays * 3, 0.20)
      .map((g) => place(g, { pos: [0, 16.0, 0] })));

    /* ---- cargo.  Two rows of two on the keel, with the odd slot empty: a
       fully loaded ship reads as a solid block, and the gaps are what tell the
       eye these are separate containers rather than a moulded hull.

       They used to be literal rectangular boxes — flat faces, straight
       silhouette, corrugation and panel lines painted rather than modelled, no
       corner castings, no twist locks, no door end. A container is allowed to
       be a box; it is not allowed to be a *smooth* box, and it is not allowed
       to be the same box four times over. `container()` gives the corrugation
       as geometry and the hardware tier that goes with it; the rest of this is
       variety — three lengths, an open top under a tarp, a reefer with its
       plant unit, and one sitting askew in its guides.

       Colour is the other half of it. A cargo run in one grey is the single
       biggest reason a freighter reads as a prop, so every box is tinted off a
       vertex channel out of the game's own palette. One material, one draw. */
    for (let i = 0; i < bays; i++) {
      const z = -half + 13 + i * 26;
      for (const sx of [1, -1]) {
        for (const sy of [0, 1]) {
          if (rnd() < 0.13) continue;
          /* A stack, not a two-tone box.
             The pitch was 9.9 on a 9.6 metre box, so the upper container sat
             three hundred millimetres off the lower one — close enough that at
             any distance you can read the paint the two flanks are one
             continuous surface with a colour change across it. An art director
             read that, correctly, as a texture-atlas seam. A metre and a bit of
             daylight between them, the corner posts and castings `container()`
             now carries, and a cast shadow from the upper box onto the lower
             one are what turn the same two boxes back into two boxes. */
          const x = 6.9 * sx, y = -1.6 + sy * 11.0;
          const r0 = rnd();
          const type = r0 < 0.12 ? 'open' : r0 < 0.22 ? 'reefer' : 'box';
          // a short box leaves a gap in its guides, which is what a half-loaded
          // slot actually looks like
          const short = r0 > 0.86;
          const skew = rnd() < 0.14 ? (rnd() - 0.5) * 0.10 : 0;
          const hue = _lin(CARGO_HUES[Math.floor(rnd() * CARGO_HUES.length)]);
          const c = container(rnd, { len: short ? 15.5 : 23.4, w: 12.4, h: 9.6, type });
          const pl = {
            pos: [x, y, z + (short ? (rnd() < 0.5 ? -3.6 : 3.6) : 0)],
            rot: [skew, Math.PI / 2 * (rnd() < 0.5 ? 1 : -1), skew * 0.6],
          };
          for (const gg of c.body) L.cargo.push(tint(place(gg, pl), hue));
          for (const gg of c.hard) L.metal.push(place(gg, pl));
          // the guides it sits in, fore and aft
          L.structure.push(place(slab(12.8, 10.0, 0.8, 0.35), { pos: [x, y, z - 11.9] }));
          L.structure.push(place(slab(12.8, 10.0, 0.8, 0.35), { pos: [x, y, z + 11.9] }));
          // one lashing strap, not two: the pair cost five thousand triangles a
          // ship and was invisible at every distance a freighter is ever seen from
          L.metal.push(place(slab(0.45, 10.1, 1.1, 0.10), { pos: [x - 3.4, y, z] }));
        }
      }
      // transverse frame between the stacks, at every bay station
      L.structure.push(place(slab(28, 1.5, 1.3, 0.3), { pos: [0, 4.4, z - 13.0] }));
    }
    // central spine box filling the gap between the two container stacks
    L.structure.push(place(slab(2.6, 21, 2 * half + 8, 0.4), { pos: [0, 4.3, 0] }));

    /* ---- bow: a blunt raked wedge, and the bridge tower standing on it.
       The profile always raked; the *plan* did not, so the bow carried a
       constant sixteen metre beam right to the stem and read as one large flat
       facet — the biggest unbroken painted area on the ship. The forecastle
       deck now tapers in plan as well, which is what puts a second highlight
       down each shoulder instead of one flat panel between them. */
    L.paint.push(hullSide([
      [aTip, -1.0], [aTip - 7.5, -7.8], [half + 1, -8.6],
      [half + 1, 8.4], [aTip - 14, 8.4], [aTip - 2, 3.2],
    ], 16.0, { bevel: 0.7 }));
    /* The plan taper. The profile always raked, but the beam was a constant
       sixteen metres right to the stem, so the forecastle was one large flat
       facet — the biggest unbroken painted area on the ship. A deck that
       narrows toward the stem lays a second highlight down each shoulder, and
       it goes *over* the existing hull rather than replacing part of it: a
       first attempt narrowed the profile instead and opened a hole where the
       old beam used to be. */
    L.paint.push(planform([
      [8.2, -half - 2], [8.2, -(aTip - 16)], [2.0, -(aTip - 0.5)],
      [-2.0, -(aTip - 0.5)], [-8.2, -(aTip - 16)], [-8.2, -half - 2],
    ], 3.4, { y: 7.6, bevel: 0.5 }));
    L.structure.push(planform([
      [8.4, -half - 2], [8.4, -(aTip - 13)], [2.4, -(aTip - 2.5)],
      [-2.4, -(aTip - 2.5)], [-8.4, -(aTip - 13)], [-8.4, -half - 2],
    ], 2.6, { y: -7.2, bevel: 0.4 }));
    for (const s of [1, -1]) {
      // a chamfered strake down each shoulder, where the two decks meet
      L.trim.push(place(slab(1.3, 1.3, 34, 0.3), { pos: [8.3 * s, 6.0, -half - 20], rot: [0, 0.12 * s, 0] }));
    }
    // the stem itself, a chamfered bar the two decks close on
    L.trim.push(place(slab(2.0, 12.0, 2.2, 0.5), { pos: [0, 0.4, -aTip + 2.4], rot: [0.42, 0, 0] }));
    // frames down the forecastle, at the bay pitch
    for (let i = 0; i < 3; i++) {
      L.trim.push(place(slab(16.6, 18.6, 0.8, 0.4), { pos: [0, 0.4, -half - 9 - i * 12] }));
    }
    L.structure.push(hullSide([
      [aTip - 1, -1.4], [aTip - 8, -8.0], [half + 1, -8.8], [half + 1, -5.0], [aTip - 5, -4.2],
    ], 16.6, { bevel: 0.4 }));
    // bow cap and towing eyes
    L.trim.push(place(new THREE.TorusGeometry(2.3, 0.30, 6, 18), { pos: [0, 1.0, -aTip + 2.5] }));
    for (const s of [1, -1]) {
      L.metal.push(place(new THREE.TorusGeometry(1.1, 0.22, 5, 12), {
        pos: [6.6 * s, -2.2, -aTip + 5.0], rot: [0, Math.PI / 2, 0],
      }));
    }

    const zT = -(aTip - 21);
    L.paint.push(place(slab(13.0, 10.5, 14.0, 0.9), { pos: [0, 13.6, zT] }));
    L.structure.push(place(slab(14.4, 1.3, 15.4, 0.3), { pos: [0, 19.2, zT] }));
    // wraparound bridge glazing: a front band and a quarter light each side
    pane(L, 10.4, 2.7, [0, 15.0, zT - 7.3], [0.22, 0, 0], 3);
    for (const s of [1, -1]) {
      pane(L, 3.2, 2.2, [6.6 * s, 15.0, zT - 3.6], [0, -Math.PI / 2 * s, 0]);
      L.paint.push(place(slab(1.2, 8.0, 9.0, 0.3), { pos: [7.2 * s, 11.0, zT + 2.0] }));
    }
    // lit cabin block below the bridge and a stair tower down the back of it
    pane(L, 2.0, 1.4, [0, 9.4, zT - 7.4], [0, 0, 0]);
    L.structure.push(place(slab(4.0, 9.0, 3.4, 0.3), { pos: [0, 12.0, zT + 8.4] }));

    // mast, dish and antenna farm on the tower roof
    L.metal.push(place(new THREE.CylinderGeometry(0.18, 0.34, 9.0, 10), { pos: [0, 24.0, zT + 3.0] }));
    L.panel.push(place(new THREE.SphereGeometry(3.2, 18, 6, 0, Math.PI * 2, Math.PI * 0.78, Math.PI * 0.22), {
      pos: [-3.4, 21.4, zT - 2.0], rot: [Math.PI + 0.5, 0, 0],
    }));
    L.metal.push(place(new THREE.CylinderGeometry(0.35, 0.5, 2.6, 12), { pos: [-3.4, 20.0, zT - 2.0] }));
    for (let i = 0; i < 3; i++) {
      L.metal.push(place(new THREE.CylinderGeometry(0.06, 0.10, 5.0 - i * 0.8, 8), {
        pos: [2.2 + i * 1.3, 21.6, zT + 1.0 + i * 1.6], rot: [0.10 * i, 0, -0.11 * (i - 1)],
      }));
    }

    /* ---- stern: the heavy end, and the widest thing on the ship.
       It was `slab(26, 17, 24)` — a plain rectangular block, and because it is
       the largest single painted face on the hull it read as one flat panel of
       colour whatever the shader put on it. An engine room is a *section*: it
       flares out of the spine, carries its widest point where the thrust
       structure is, and closes again at the transom. Two lofted profiles —
       one in plan, one in elevation — cost the same triangles and give the key
       four edges to break on instead of none. */
    L.paint.push(hullSide([
      [-(zStern - 13.0), -6.4], [-(zStern - 11.0), -9.6], [-(zStern + 6.0), -9.6],
      [-(zStern + 13.5), -6.0], [-(zStern + 13.5), 8.4], [-(zStern + 5.0), 11.2],
      [-(zStern - 10.0), 11.2], [-(zStern - 13.0), 7.0],
    ], 25.0, { bevel: 1.0 }));
    for (const s of [1, -1]) {
      // the flank blisters, so the block has a beam that changes down its length
      L.paint.push(place(slab(2.2, 15.0, 20.0, 0.7), { pos: [13.0 * s, 2.0, zStern - 1.0] }));
      L.structure.push(place(slab(1.4, 6.0, 21.0, 0.4), { pos: [13.9 * s, 8.6, zStern - 1.0] }));
    }
    // transverse frames down the engine room, the second scale on the biggest
    // painted mass in the fleet
    for (let i = 0; i < 4; i++) {
      L.trim.push(place(slab(27.2, 19.4, 0.9, 0.5), { pos: [0, 2.0, zStern - 9.0 + i * 7.0] }));
    }
    L.structure.push(place(slab(22.5, 15, 8.0, 0.6), { pos: [0, 2.0, zStern - 15.0] }));
    L.structure.push(place(slab(27, 18, 2.0, 0.5), { pos: [0, 2.0, zStern + 12.5] }));
    L.accent.push(place(slab(27.4, 1.5, 1.6, 0.3), { pos: [0, 10.4, zStern + 12.0] }));
    const engines = [];
    for (const s of [1, -1]) {
      bell(L, 8.2 * s, -1.4, zStern + 17.0, 3.6, 2.3, 8.0, 22);
      L.structure.push(place(new THREE.CylinderGeometry(2.5, 3.0, 6.0, 16, 1, true), {
        pos: [8.2 * s, -1.4, zStern + 10.5], rot: [Math.PI / 2, 0, 0],
      }));
      L.trim.push(place(new THREE.TorusGeometry(3.0, 0.22, 6, 20), { pos: [8.2 * s, -1.4, zStern + 12.8] }));
      engines.push({ pos: [8.2 * s, -1.4, zStern + 21.0], r: 3.0, plume: 34 });
    }
    // manoeuvring pods on the stern shoulders
    for (const s of [1, -1]) {
      L.metal.push(place(new THREE.CylinderGeometry(0.9, 1.2, 2.4, 12), {
        pos: [12.4 * s, 9.0, zStern - 8.0], rot: [Math.PI / 2, 0, 0],
      }));
    }

    // ---- radiators: three leaves a side, gaps between them, swept aft. This
    // is the widest span on the ship and where the running lights live.
    for (const s of [1, -1]) {
      L.structure.push(place(slab(7.0, 2.2, 9.0, 0.4), { pos: [15.0 * s, 7.5, zStern - 2.0], rot: [0, 0, 0.16 * s] }));
      for (let i = 0; i < 3; i++) {
        const ln = 17 + i * 3.0;
        L.panel.push(place(slab(ln, 0.35, 7.0, 0.2), { pos: [(17 + ln / 2) * s, 9.4, zStern - 8.0 + i * 8.0] }));
        L.structure.push(place(slab(ln, 0.55, 0.5, 0.10), { pos: [(17 + ln / 2) * s, 8.9, zStern - 8.0 + i * 8.0] }));
      }
      L.metal.push(place(new THREE.CylinderGeometry(0.30, 0.18, 24.0, 11), {
        pos: [29.0 * s, 8.6, zStern], rot: [0, 0, Math.PI / 2],
      }));
    }

    // Hardware sits on surfaces, not inside them: these hug the top deck of the
    // stern block, where a real vessel's tankage and pumps live.
    L.structure.push(...greebles(rnd, 16, [-11, 9.2, zStern - 11, 11, 11.8, zStern + 8], [0.7, 2.2]));
    L.structure.push(...greebles(rnd, 8, [-6, 8.0, -aTip + 10, 6, 9.6, -half - 6], [0.5, 1.6]));

    return {
      lights: [
        // wingtip navigation, at the outermost points of the radiator span
        { pos: [40.5, 8.6, zStern], hex: NAV_STBD, gain: 2.6, size: 0.5 },
        { pos: [-40.5, 8.6, zStern], hex: NAV_PORT, gain: 2.6, size: 0.5 },
        // anti-collision strobes, above and below
        { pos: [0, 25.0, zT + 1.0], hex: 0xffffff, gain: 2.6, mode: 1, size: 0.45, px: 1.15 },
        { pos: [0, -9.2, 4.0], hex: 0xffffff, gain: 2.0, mode: 1, size: 0.4 },
        // forward-facing docking lamp under the bow
        { pos: [0, -6.0, -aTip + 6.0], hex: CABIN, gain: 2.0, size: 0.6 },
        // the bridge, spilling out of its own glass
        { pos: [0, 15.0, zT - 8.2], hex: CABIN, gain: 1.5, size: 1.6, px: 0.55 },
        // deck working lights down the cargo run
        { pos: [0, 18.2, -half + 6], hex: CABIN, gain: 0.9, size: 0.35, px: 0.5 },
        { pos: [0, 18.2, half - 6], hex: CABIN, gain: 0.9, size: 0.35, px: 0.5 },
        // a slow hazard beacon on the stern, the way a working vehicle carries one
        { pos: [0, 11.6, zStern], hex: 0xff8a30, gain: 2.2, mode: 2, size: 0.5 },
      ],
      /* Bone, not tan. `hue: 1` is the palette's warm brown, and on the two
         largest flat masses in the fleet — the forecastle and the engine room
         — it came out the colour and grain of marine ply: the most saturated
         thing in a frame whose brief reserves saturation for the Choir. The
         cargo now carries all the colour this ship needs, and a chalked bone
         hull is both what the brief asks for and what makes a stack of oxide
         and slate containers read at all. */
      engines, length: len, hue: 0, wear: 0.85, plate: 4.0,
      plumeA: 0xdcecff, plumeB: 0x2f4fe0,
    };
  },

  /* --------------------------------------------------------------- courier
     One crew, one cabin, and no cargo worth stealing. A dart: everything about
     it slopes back from a single point, which is the only silhouette in the set
     that reads as *fast*. */
  courier(rnd, L) {
    const len = 30;

    // fuselage — a lifting-body profile with a sharp nose
    L.paint.push(hullSide([
      [15.5, -0.2], [14.0, 1.6], [4.0, 2.9], [-8.4, 2.6],
      [-10.2, 0.6], [-10.2, -1.7], [-2.0, -2.6], [11.5, -1.9],
    ], 4.2, { bevel: 0.35 }));
    // ventral keel strake, dark, the length of the belly
    L.structure.push(hullSide([
      [13.0, -1.3], [-9.0, -2.8], [-9.0, -4.0], [8.0, -2.4],
    ], 3.0, { bevel: 0.2 }));
    // cheek fairings, so the body has a beam and not just a profile
    for (const s of [1, -1]) {
      L.paint.push(place(new THREE.CapsuleGeometry(1.5, 9.5, 5, 14), {
        pos: [2.5 * s, -0.3, 1.0], rot: [Math.PI / 2, 0, 0],
      }));
      L.trim.push(place(slab(0.22, 0.20, 12.0, 0.05), { pos: [2.9 * s, 1.4, -1.0] }));
    }

    // ---- cabin. One person sits here and you can see the light they read by.
    L.structure.push(place(slab(3.6, 1.5, 5.0, 0.3), { pos: [0, 2.6, -5.6] }));
    pane(L, 2.7, 1.15, [0, 3.15, -8.0], [0.34, 0, 0], 2);
    for (const s of [1, -1]) pane(L, 1.9, 0.85, [1.55 * s, 3.05, -5.4], [0, -Math.PI / 2 * s, 0]);
    L.glass.push(place(slab(3.2, 0.20, 3.0, 0.10), { pos: [0, 3.85, -5.6], rot: [0.06, 0, 0] }));

    // ---- wings: swept, with the tips carrying the nav lights
    for (const s of [1, -1]) {
      L.paint.push(planform([
        [1.7 * s, -3.6], [9.6 * s, 2.2], [9.6 * s, 4.6], [1.9 * s, 4.2],
      ], 0.55, { y: -0.9 }));
      L.accent.push(planform([
        [2.0 * s, -3.3], [9.4 * s, 2.3], [9.4 * s, 3.0], [2.2 * s, -2.4],
      ], 0.62, { y: -0.9 }));
      // tip pod
      L.paint.push(place(new THREE.CapsuleGeometry(0.55, 3.4, 4, 10), {
        pos: [9.7 * s, -0.9, 3.0], rot: [Math.PI / 2, 0, 0],
      }));
      // and the pylon that carries the wing root back into the body
      L.structure.push(place(slab(2.6, 1.5, 6.0, 0.25), { pos: [2.2 * s, -0.9, 1.6], rot: [0, 0, 0.2 * s] }));
    }

    // dorsal fin — the part that gives it a back
    L.paint.push(hullSide([[-2.0, 2.4], [-9.6, 2.4], [-9.0, 7.2], [-5.2, 7.2]], 0.5, { bevel: 0.15 }));
    L.trim.push(place(slab(0.22, 0.20, 4.6, 0.05), { pos: [0, 7.3, 7.0] }));

    // ---- stern: two small bells under a shared shroud
    L.structure.push(place(slab(6.0, 3.4, 4.4, 0.5), { pos: [0, -0.1, 9.4] }));
    const engines = [];
    for (const s of [1, -1]) {
      bell(L, 1.7 * s, -0.1, 12.0, 1.35, 0.85, 3.4, 16);
      engines.push({ pos: [1.7 * s, -0.1, 13.6], r: 1.05, plume: 13 });
    }
    // antenna off the nose
    L.metal.push(place(new THREE.CylinderGeometry(0.05, 0.14, 5.0, 9), {
      pos: [0, 0.6, -17.4], rot: [Math.PI / 2, 0, 0],
    }));
    L.structure.push(...greebles(rnd, 8, [-1.5, 2.3, -2.0, 1.5, 3.2, 7.0], [0.25, 0.75]));

    return {
      lights: [
        { pos: [10.2, -0.9, 3.4], hex: NAV_STBD, gain: 2.2, size: 0.28 },
        { pos: [-10.2, -0.9, 3.4], hex: NAV_PORT, gain: 2.2, size: 0.28 },
        { pos: [0, 7.6, 6.4], hex: 0xffffff, gain: 2.2, mode: 1, size: 0.24 },
        { pos: [0, -2.9, 2.0], hex: 0xffffff, gain: 1.6, mode: 1, size: 0.22 },
        { pos: [0, 3.1, -8.6], hex: CABIN, gain: 1.2, size: 0.7, px: 0.5 },
        { pos: [0, 0.1, -15.4], hex: CABIN, gain: 1.4, size: 0.25 },
      ],
      engines, length: len, hue: 0, wear: 0.4, plate: 2.8,
      plumeA: 0xe8f4ff, plumeB: 0x3a68ff,
    };
  },

  /* ------------------------------------------------------------------- tug
     A yard tug: a low cab, a stern that is nothing but engine, a lift frame
     over the top and two grapple arms reaching out in front of it. It is the
     one class that is *wider* than it is long, and the arms are what make it
     unmistakable in outline — nothing else out here reaches forward. */
  tug(rnd, L) {
    const len = 30;

    // ---- cab: low, blunt, and glazed right round the front.
    // The profile rakes and the *plan* flares, so the cab is a wedge from above
    // as well as from the side. Flat rectangular sides are what put the plate
    // seams into running bond and made the old hull read as brickwork.
    L.paint.push(hullSide([
      [13.6, -2.2], [12.8, 3.0], [9.6, 5.2], [1.5, 5.6], [1.5, -4.2], [12.4, -4.2],
    ], 8.4, { bevel: 0.6 }));
    for (const s of [1, -1]) {
      L.paint.push(planform([
        [4.1 * s, -13.2], [4.1 * s, 1.5], [5.9 * s, 1.5], [5.9 * s, -6.6],
      ], 6.6, { y: 0.3, bevel: 0.25 }));
      L.structure.push(planform([
        [4.1 * s, -13.2], [4.1 * s, -6.6], [6.0 * s, -6.6],
      ], 2.0, { y: 4.0, bevel: 0.2 }));
    }
    L.structure.push(place(slab(8.8, 1.2, 11.0, 0.3), { pos: [0, 5.5, -7.0] }));
    pane(L, 6.0, 2.3, [0, 2.1, -13.2], [0.30, 0, 0], 2);
    for (const s of [1, -1]) pane(L, 3.6, 1.9, [4.3 * s, 2.2, -9.4], [0, -Math.PI / 2 * s, 0]);
    // sun visor over the screen — the detail that says a person looks out of it
    L.structure.push(place(slab(6.8, 0.35, 1.6, 0.12), { pos: [0, 3.8, -13.0], rot: [0.5, 0, 0] }));
    // bumper across the chin, oxide, scuffed
    L.accent.push(place(slab(8.6, 1.1, 1.2, 0.3), { pos: [0, -3.6, -12.6] }));

    // ---- mid body and the stern block, which is wider than the cab
    L.structure.push(place(slab(8.4, 7.8, 10.4, 0.6), { pos: [0, 0.4, 3.0] }));
    for (const s of [1, -1]) {
      L.paint.push(place(slab(1.6, 6.0, 10.6, 0.4), { pos: [4.6 * s, 0.4, 3.0] }));
    }
    L.paint.push(place(slab(14.5, 8.6, 9.0, 0.9), { pos: [0, -0.2, 10.0] }));
    L.structure.push(place(slab(15.0, 9.0, 1.6, 0.4), { pos: [0, -0.2, 14.2] }));
    L.accent.push(place(slab(15.2, 1.2, 1.4, 0.3), { pos: [0, 4.0, 14.0] }));

    const engines = [];
    for (const s of [1, -1]) {
      bell(L, 4.6 * s, -0.6, 17.0, 2.7, 1.7, 5.6, 20);
      L.structure.push(place(new THREE.CylinderGeometry(1.8, 2.2, 4.0, 14, 1, true), {
        pos: [4.6 * s, -0.6, 12.6], rot: [Math.PI / 2, 0, 0],
      }));
      engines.push({ pos: [4.6 * s, -0.6, 19.4], r: 2.1, plume: 15 });
      // outboard manoeuvring pods, angled out
      L.metal.push(place(new THREE.CylinderGeometry(0.75, 0.95, 2.2, 13), {
        pos: [7.6 * s, 3.4, 7.0], rot: [Math.PI / 2, 0, 0],
      }));
    }

    // ---- lift frame over the cab. Two rails, four legs, two cross members —
    // the strongest single line in the silhouette and where the work lights go.
    for (const s of [1, -1]) {
      L.metal.push(place(new THREE.CylinderGeometry(0.30, 0.30, 19.0, 13), {
        pos: [4.0 * s, 7.4, -2.6], rot: [Math.PI / 2, 0, 0],
      }));
      L.metal.push(place(new THREE.CylinderGeometry(0.26, 0.26, 3.4, 11), { pos: [4.0 * s, 5.8, -11.4] }));
      L.metal.push(place(new THREE.CylinderGeometry(0.26, 0.26, 4.6, 11), { pos: [4.0 * s, 5.4, 5.8] }));
      L.metal.push(place(new THREE.CylinderGeometry(0.20, 0.20, 4.2, 10), {
        pos: [4.0 * s, 6.2, 2.0], rot: [0.9, 0, 0],
      }));
    }
    for (const z of [-11.6, 6.0]) {
      L.metal.push(place(new THREE.CylinderGeometry(0.24, 0.24, 8.0, 11), {
        pos: [0, 7.4, z], rot: [0, 0, Math.PI / 2],
      }));
    }
    // work floods on the front cross member, aimed at the claws
    for (const s of [1, -1]) {
      L.lit.push(place(new THREE.CircleGeometry(0.42, 10), { pos: [2.2 * s, 6.9, -11.95], rot: [Math.PI - 0.5, 0, 0] }));
      L.metal.push(place(new THREE.CylinderGeometry(0.5, 0.42, 0.7, 12), {
        pos: [2.2 * s, 7.05, -11.6], rot: [Math.PI / 2 - 0.5, 0, 0],
      }));
    }

    /* ---- propellant bottles on the mid-body flanks.
       Turned, domed and clamped, with a fill point and a relief line: a yard
       tug carries its reaction mass where a fitter can reach it, and a tank
       with bands and plumbing on it is the clearest hardware tier this hull
       has. Twenty sides, because a tug is the class the player gets closest to
       and a ten-sided tank is a nut. */
    for (const s of [1, -1]) {
      const tx = 6.0 * s, ty = -2.4, tz = 3.4;
      const TR = 1.55, TL = 9.0;
      const tk = new THREE.LatheGeometry([
        [0, -TL / 2], [TR * 0.45, -TL / 2], [TR, -TL / 2 + TR * 0.85],
        [TR, TL / 2 - TR * 0.85], [TR * 0.45, TL / 2], [0, TL / 2],
      ].map((p) => new THREE.Vector2(p[0], p[1])), 20);
      tk.rotateX(Math.PI / 2);
      L.paint.push(place(tk, { pos: [tx, ty, tz] }));
      for (const t of [-0.28, 0.28]) {
        L.trim.push(place(new THREE.TorusGeometry(TR + 0.07, 0.12, 6, 18), { pos: [tx, ty, tz + TL * t] }));
        L.structure.push(place(slab(0.5, 1.4, 1.1, 0.14), { pos: [tx - 0.5 * s, ty + 1.5, tz + TL * t] }));
      }
      L.metal.push(place(new THREE.CylinderGeometry(0.16, 0.16, TL * 0.8, 9).rotateX(Math.PI / 2),
        { pos: [tx + 0.9 * s, ty + 1.1, tz] }));
      L.metal.push(place(new THREE.CylinderGeometry(0.30, 0.36, 0.7, 11), { pos: [tx, ty + 1.7, tz - 1.4] }));
    }

    // ---- winch drum on the stern block roof, with the cable running forward
    L.metal.push(place(new THREE.CylinderGeometry(1.6, 1.6, 5.6, 18), {
      pos: [0, 5.6, 10.0], rot: [0, 0, Math.PI / 2],
    }));
    for (const s of [1, -1]) {
      L.trim.push(place(new THREE.TorusGeometry(1.7, 0.16, 5, 16), { pos: [2.9 * s, 5.6, 10.0], rot: [0, Math.PI / 2, 0] }));
      L.structure.push(place(slab(0.8, 3.4, 3.4, 0.2), { pos: [3.6 * s, 4.2, 10.0] }));
    }
    L.metal.push(place(new THREE.CylinderGeometry(0.10, 0.10, 12.0, 6, 1, true), { pos: [0, 6.6, 3.6], rot: [Math.PI / 2 - 0.09, 0, 0] }));

    // ---- grapple arms. Nothing else out here reaches *forward*, so this is
    // the read that identifies the class in outline. Laid out from three
    // joints — shoulder on the cab flank, elbow, jaw — and every segment
    // placed between two of them, so no piece can drift away from the ship.
    for (const s of [1, -1]) {
      const A = [4.6 * s, -2.1, -5.0];
      const B = [6.2 * s, -3.3, -10.6];
      const C = [7.4 * s, -2.9, -15.6];
      L.structure.push(place(slab(2.8, 3.0, 4.0, 0.35), { pos: [4.4 * s, -2.1, -5.2] }));
      L.trim.push(place(new THREE.CylinderGeometry(0.75, 0.75, 3.4, 14), {
        pos: [4.4 * s, -2.1, -5.2], rot: [0, 0, Math.PI / 2],
      }));
      L.metal.push(strut(A, B, 0.88, 0.70, 9));
      L.structure.push(strut([A[0], A[1] + 1.1, A[2]], [B[0], B[1] + 0.95, B[2]], 0.34, 0.28, 9));
      L.trim.push(place(new THREE.CylinderGeometry(0.78, 0.78, 2.6, 14), {
        pos: B, rot: [0, 0, Math.PI / 2],
      }));
      L.metal.push(strut(B, C, 0.72, 0.58, 9));
      // the jaw: a head block, two fingers curving in, and a wear pad on each
      L.structure.push(place(slab(3.0, 2.8, 3.0, 0.35), { pos: C }));
      for (const t of [1, -1]) {
        const F0 = [C[0], C[1] + 1.15 * t, C[2] - 1.1];
        const F1 = [C[0], C[1] + 0.55 * t, C[2] - 3.7];
        L.metal.push(strut(F0, F1, 0.36, 0.24, 10));
        L.accent.push(place(slab(2.0, 0.55, 1.3, 0.15), { pos: [C[0], C[1] + 0.44 * t, C[2] - 3.9] }));
      }
    }

    L.structure.push(...greebles(rnd, 14, [-3.2, 3.6, -1.0, 3.2, 4.8, 7.6], [0.35, 1.2]));

    return {
      lights: [
        { pos: [5.4, 7.6, -3.0], hex: NAV_STBD, gain: 2.0, size: 0.26 },
        { pos: [-5.4, 7.6, -3.0], hex: NAV_PORT, gain: 2.0, size: 0.26 },
        // the rotating hazard beacon on the frame — a working vehicle in a yard
        { pos: [0, 8.4, -3.0], hex: 0xff8a30, gain: 3.0, mode: 2, size: 0.4, px: 1.2 },
        { pos: [0, -4.6, 6.0], hex: 0xffffff, gain: 1.8, mode: 1, size: 0.24 },
        // the cab, and the two floods on the claws
        { pos: [0, 2.2, -14.0], hex: CABIN, gain: 1.4, size: 1.3, px: 0.5 },
        { pos: [2.2, 6.9, -12.2], hex: CABIN, gain: 2.4, size: 0.42 },
        { pos: [-2.2, 6.9, -12.2], hex: CABIN, gain: 2.4, size: 0.42 },
      ],
      engines, length: len, hue: 3, wear: 1.0, plate: 4.2,
      plumeA: 0xdae8ff, plumeB: 0x2b46cc,
    };
  },

  /* ---------------------------------------------------------------- patrol
     Institute cutter. Clean, cold, and the only civilian thing out here with
     hardpoints on it: a long slender fuselage, an offset sensor blister and
     wings that rake back hard. Everything about it is thinner than everything
     else in the fleet, which is how you know it is not carrying anything. */
  patrol(rnd, L) {
    const len = 40;

    L.paint.push(hullSide([
      [20.0, 0.2], [18.4, 1.5], [6.0, 3.0], [-9.4, 2.8],
      [-11.8, 1.0], [-11.8, -1.8], [-5.0, -2.9], [15.0, -2.0], [19.0, -0.9],
    ], 4.6, { bevel: 0.35 }));
    // dorsal spine and ventral strake — the value break along the body
    L.structure.push(hullSide([[3.0, 2.6], [-11.0, 2.4], [-11.0, 4.0], [1.0, 4.2]], 3.0, { bevel: 0.2 }));
    L.structure.push(hullSide([[16.0, -1.6], [-10.0, -2.9], [-10.0, -4.6], [12.0, -2.4]], 2.6, { bevel: 0.2 }));

    // nose: a four-sided spike with a chin sensor turret under it
    L.structure.push(place(new THREE.ConeGeometry(1.9, 8.0, 4), {
      pos: [0, 0.1, -23.0], rot: [-Math.PI / 2, 0, Math.PI / 4],
    }));
    L.metal.push(place(new THREE.SphereGeometry(1.25, 14, 8), { pos: [0, -1.9, -16.0] }));
    L.lit.push(place(new THREE.CircleGeometry(0.62, 12), { pos: [0, -2.34, -16.94], rot: [Math.PI - 1.0, 0, 0] }));
    L.trim.push(place(new THREE.TorusGeometry(0.80, 0.10, 5, 14), { pos: [0, -2.28, -16.85], rot: [-1.0, 0, 0] }));

    // ---- cockpit, raised and forward
    L.paint.push(hullSide([[13.0, 2.5], [4.0, 3.2], [3.0, 5.4], [10.4, 5.2]], 3.2, { bevel: 0.25 }));
    pane(L, 2.6, 1.5, [0, 4.3, -12.2], [0.42, 0, 0], 2);
    for (const s of [1, -1]) pane(L, 3.0, 1.1, [1.5 * s, 4.3, -9.0], [0, -Math.PI / 2 * s, 0]);
    L.glass.push(place(slab(2.8, 0.22, 3.6, 0.10), { pos: [0, 5.5, -8.6], rot: [0.10, 0, 0] }));

    // ---- wings, raked hard, with a rail pod under each
    for (const s of [1, -1]) {
      L.paint.push(planform([
        [2.1 * s, -4.0], [11.0 * s, 4.6], [11.0 * s, 7.0], [2.4 * s, 5.0],
      ], 0.6, { y: -1.1 }));
      L.structure.push(planform([
        [2.4 * s, -3.6], [10.6 * s, 4.6], [10.6 * s, 5.6], [2.6 * s, 0.5],
      ], 0.68, { y: -1.1 }));
      L.paint.push(place(new THREE.CapsuleGeometry(0.85, 5.0, 5, 12), {
        pos: [10.9 * s, -1.1, 4.6], rot: [Math.PI / 2, 0, 0],
      }));
      L.metal.push(place(new THREE.CylinderGeometry(0.42, 0.42, 6.4, 12), {
        pos: [7.4 * s, -2.2, 2.4], rot: [Math.PI / 2, 0, 0],
      }));
      L.accent.push(place(new THREE.ConeGeometry(0.44, 1.6, 12), {
        pos: [7.4 * s, -2.2, -1.4], rot: [-Math.PI / 2, 0, 0],
      }));
      L.structure.push(place(slab(1.6, 1.3, 3.0, 0.2), { pos: [7.4 * s, -1.5, 2.4] }));
    }

    // ---- fin and phased array
    L.paint.push(hullSide([[-3.0, 2.8], [-12.6, 2.6], [-12.0, 9.2], [-7.0, 9.2]], 0.6, { bevel: 0.15 }));
    for (const s of [1, -1]) {
      L.structure.push(place(slab(0.20, 3.2, 4.0, 0.10), { pos: [0.42 * s, 6.0, 8.6] }));
      L.lit.push(place(new THREE.PlaneGeometry(3.6, 0.10), { pos: [0.56 * s, 4.5, 8.6], rot: [0, Math.PI / 2 * s, 0] }));
    }
    L.trim.push(place(slab(0.24, 0.22, 5.2, 0.06), { pos: [0, 9.3, 9.4] }));

    // ---- three drives across the stern, in a shroud that tapers into the
    // fuselage. A plain box across the tail was the one part of this hull that
    // still read as a kit part rather than as a designed stern.
    L.structure.push(planform([
      [-3.4, 8.0], [3.4, 8.0], [6.9, 13.0], [6.9, 16.4], [-6.9, 16.4], [-6.9, 13.0],
    ], 4.6, { y: -0.4, bevel: 0.35 }));
    for (const s of [1, -1]) {
      L.paint.push(place(slab(1.1, 3.6, 7.0, 0.3), { pos: [7.0 * s, -0.4, 13.6] }));
      L.accent.push(place(slab(1.3, 0.6, 0.9, 0.15), { pos: [7.0 * s, 1.3, 10.6] }));
    }
    const engines = [];
    for (const x of [0, 5.0, -5.0]) {
      bell(L, x, -0.4, 17.6, 1.55, 1.0, 4.4, 16);
      engines.push({ pos: [x, -0.4, 19.6], r: 1.2, plume: 16 });
    }
    L.structure.push(...greebles(rnd, 10, [-1.3, 4.0, -6.0, 1.3, 4.9, 10.0], [0.25, 0.8]));

    return {
      lights: [
        { pos: [11.6, -1.1, 5.2], hex: NAV_STBD, gain: 2.4, size: 0.3 },
        { pos: [-11.6, -1.1, 5.2], hex: NAV_PORT, gain: 2.4, size: 0.3 },
        { pos: [0, 9.6, 9.0], hex: 0xbfe8ff, gain: 2.6, mode: 1, size: 0.26, px: 1.1 },
        { pos: [0, -4.6, 2.0], hex: 0xbfe8ff, gain: 2.0, mode: 1, size: 0.24 },
        { pos: [0, 4.3, -13.0], hex: CABIN, gain: 1.4, size: 0.9, px: 0.5 },
        { pos: [0, -2.4, -17.2], hex: CABIN, gain: 1.8, size: 0.35 },
      ],
      engines, length: len, hue: 2, wear: 0.25, plate: 3.0,
      plumeA: 0xeaf6ff, plumeB: 0x4a8cff,
    };
  },

  /* ----------------------------------------------------------------- drone
     A survey drone: no crew, no windows, a hexagonal bus with a sensor boom out
     front and two solar wings. It is the smallest thing out here and the only
     one whose silhouette is mostly *gaps* — starlight through the array is what
     tells you it is a structure and not a pebble. */
  drone(rnd, L) {
    L.paint.push(place(new THREE.CylinderGeometry(2.3, 2.3, 3.6, 6), { pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0] }));
    L.structure.push(place(new THREE.CylinderGeometry(1.9, 2.2, 2.0, 6), { pos: [0, 0, 2.6], rot: [Math.PI / 2, 0, 0] }));
    L.trim.push(place(new THREE.TorusGeometry(2.25, 0.12, 5, 6), { pos: [0, 0, -1.8], rot: [0, 0, Math.PI / 6] }));

    // Sensor boom and head, forward: the drone's one unambiguous front. The
    // head is a housing, a sunshade and a lit aperture — a plain cube on a stick
    // reads as an unfinished asset from any distance at which you can see it.
    L.metal.push(place(new THREE.CylinderGeometry(0.20, 0.26, 3.4, 10), { pos: [0, 0, -3.6], rot: [Math.PI / 2, 0, 0] }));
    L.paint.push(place(slab(1.9, 1.7, 2.2, 0.3), { pos: [0, 0, -6.0] }));
    L.structure.push(place(new THREE.CylinderGeometry(0.62, 0.80, 1.7, 14, 1, true), {
      pos: [0, 0, -7.6], rot: [Math.PI / 2, 0, 0],
    }));
    L.lit.push(place(new THREE.CircleGeometry(0.52, 14), { pos: [0, 0, -8.34], rot: [0, Math.PI, 0] }));
    L.trim.push(place(new THREE.TorusGeometry(0.66, 0.09, 5, 16), { pos: [0, 0, -8.4] }));
    // a small star tracker, offset — nothing on a working probe is symmetric
    L.structure.push(place(slab(0.9, 0.9, 1.1, 0.15), { pos: [1.1, 0.8, -5.6] }));
    L.trim.push(place(new THREE.TorusGeometry(0.3, 0.06, 5, 12), { pos: [1.1, 0.8, -6.2] }));

    // a high-gain dish, offset to port — the asymmetry is what stops it reading
    // as a die with antennae glued on
    L.panel.push(place(new THREE.SphereGeometry(1.7, 16, 6, 0, Math.PI * 2, Math.PI * 0.76, Math.PI * 0.24), {
      pos: [-2.2, 1.9, -1.0], rot: [Math.PI - 0.7, 0, -0.5],
    }));
    L.metal.push(place(new THREE.CylinderGeometry(0.18, 0.24, 1.8, 10), { pos: [-1.7, 1.2, -1.0], rot: [0, 0, -0.5] }));

    // solar wings, mounted on two opposite flats of the hex
    for (const s of [1, -1]) {
      const w = solarWing(8.5, 2.4, 3);
      for (const g of w) {
        L.panel.push(s > 0 ? place(g, { pos: [1.6, 0, 0] })
          : place(g, { pos: [-1.6, 0, 0], rot: [0, Math.PI, 0] }));
        g.dispose();
      }
      L.metal.push(place(new THREE.CylinderGeometry(0.30, 0.30, 1.6, 11), {
        pos: [2.0 * s, 0, 0], rot: [0, 0, Math.PI / 2],
      }));
    }

    // three instrument stalks off the aft face, each ending in a real head —
    // built between two points so the head cannot part company with the stalk
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      const cx = Math.cos(a), cy = Math.sin(a);
      const p = [cx * 1.5, cy * 1.5, 2.6];
      const q = [cx * 3.4, cy * 3.4, 6.2];
      L.metal.push(strut(p, q, 0.13, 0.10, 8));
      L.accent.push(place(slab(1.0, 1.0, 0.6, 0.12), { pos: q }));
      L.structure.push(place(slab(1.15, 1.15, 0.25, 0.08), { pos: [q[0], q[1], q[2] + 0.42] }));
    }

    // one small ion drive
    bell(L, 0, 0, 3.9, 0.85, 0.5, 1.6, 12);

    return {
      lights: [
        { pos: [0, 2.7, 0], hex: 0x9fd8ff, gain: 2.0, mode: 1, size: 0.18 },
        { pos: [0, 0, -8.2], hex: CABIN, gain: 1.6, size: 0.3 },
        { pos: [9.6, 0, 0], hex: CABIN, gain: 0.8, size: 0.16, px: 0.5 },
        { pos: [-9.6, 0, 0], hex: CABIN, gain: 0.8, size: 0.16, px: 0.5 },
      ],
      engines: [{ pos: [0, 0, 4.8], r: 0.6, plume: 5 }],
      length: 16, hue: 0, wear: 0.6, plate: 1.4,
      plumeA: 0xdcefff, plumeB: 0x4f7cff,
    };
  },
};

/* ================================================================ the mote

   Choir motes are not built from the kit. Nothing the Choir left behind has a
   panel line, a weld bead or a running light on it, and holding that line is
   what makes them read as *other* rather than as another faction's hardware.

   The old mote was a flat green ball: a back-faced icosahedron at 22% opacity
   is a disc from every angle, and it swallowed the geometry inside it. What
   replaces it is a field that only exists at its own limb — a Fresnel shell,
   so the thing is a bright rim around a dark interior, and you can see the
   shards turning inside. */

const MOTE_VERT = /* glsl */`
${LOGD_V_PARS}
varying vec3 vN;
varying vec3 vV;
varying vec3 vObj;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // The shells are polyhedra and three authors them with flat face normals, so
  // the shader derives the sphere normal from the position instead. Using the
  // attribute drew a hard twelve-sided outline: the shell read as a die.
  vObj = normalize(position);
  vN = normalize(normalMatrix * vObj);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
${LOGD_V}
}
`;
const MOTE_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
uniform vec3 uColor;
uniform float uTime;
uniform float uGain;
uniform float uSharp;
varying vec3 vN;
varying vec3 vV;
varying vec3 vObj;
void main(){
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, uSharp);
  // a slow standing wave around the shell, so the field is never quite still
  float band = 0.55 + 0.45*sin(vObj.y*6.0 - uTime*0.7 + sin(vObj.x*4.0 + uTime*0.31));
  float a = rim * band * uGain;
  gl_FragColor = vec4(uColor*a, a);
${LOGD_F}
}
`;

function buildMote(rnd) {
  const root = new THREE.Group();
  const spin = new THREE.Group();
  root.add(spin);

  // Matter, not hardware: dark, smooth, and barely lit from within. Almost all
  // of the light comes from the nucleus and the field, which is what makes the
  // thing read as something *containing* an energy rather than as a green rock.
  const mat = new THREE.MeshStandardMaterial({
    color: 0x05070a, metalness: 0.05, roughness: 0.55,
    emissive: new THREE.Color(CHOIR_HUE).multiplyScalar(0.05), emissiveIntensity: 1.0,
  });
  const shellMat = new THREE.ShaderMaterial({
    vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(CHOIR_HUE) },
      uTime: { value: 0 }, uGain: { value: 1.5 }, uSharp: { value: 5.0 },
    },
  });

  // Two spindles standing off an open centre, and two rings around it. The
  // centre is deliberately *empty*: the nucleus below has to be visible through
  // the structure or the mote is just a green pebble again.
  const core = [];
  for (const s of [1, -1]) {
    core.push(place(new THREE.OctahedronGeometry(1.5, 1), { pos: [0, 2.9 * s, 0], scale: [0.62, 1.9, 0.62] }));
  }
  core.push(place(new THREE.TorusGeometry(2.5, 0.22, 6, 30), { rot: [Math.PI / 2, 0, 0] }));
  core.push(place(new THREE.TorusGeometry(3.5, 0.16, 6, 30), { rot: [Math.PI / 2 - 0.55, 0.4, 0] }));
  weld(core, mat, root);

  const shards = [];
  const n = 5 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 4.0 + rnd() * 1.1;
    const y = (rnd() - 0.5) * 2.6;
    shards.push(place(new THREE.OctahedronGeometry(0.85 + rnd() * 0.75, 0), {
      pos: [Math.cos(a) * r, y, Math.sin(a) * r],
      rot: [0, -a, 0.55 + rnd() * 0.5], scale: [1.0, 0.55, 2.1],
    }));
  }
  weld(shards, mat, spin);

  // The nucleus: a real point source, so bloom has something to bleed from and
  // the shards are lit from *inside* the object. It is the only saturated
  // emissive in the game and it is the whole reason the mote is unsettling.
  const coreMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(CHOIR_HUE).multiplyScalar(9.0), toneMapped: false,
  });
  const nucleus = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 1), coreMat);
  nucleus.frustumCulled = false;
  spin.add(nucleus);

  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(6.6, 3), shellMat);
  shell.frustumCulled = false;
  shell.renderOrder = 14;
  root.add(shell);
  const inner = new THREE.Mesh(new THREE.IcosahedronGeometry(2.9, 2), shellMat);
  inner.frustumCulled = false;
  inner.renderOrder = 13;
  spin.add(inner);

  root.scale.setScalar(M);
  root.traverse((o) => { o.frustumCulled = false; });
  // no plumes and no running lights: the Choir left nothing that signals
  return { root, spin, shellMat, length: 14 * M, beacons: [], plumeMat: null };
}

/* ------------------------------------------------------------- templates */

const WELD_ORDER = ['paint', 'structure', 'metal', 'accent', 'trim', 'panel', 'lit', 'glass', 'cargo'];

/** sRGB hex to a linear THREE.Color, for the container tints. */
const _lin = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

function buildTemplate(kind, rnd) {
  const L = {};
  for (const k of WELD_ORDER) L[k] = [];
  const spec = CLASSES[kind](rnd, L);
  const root = new THREE.Group();

  const pal = palette({ hue: spec.hue, wear: spec.wear, plate: spec.plate });
  /* Freight, in whatever colour it was painted. `<color_fragment>` runs after
     `<map_fragment>`, so the plating law and the weathering happen first and
     the per-box tint modulates the result — a pale blue container comes out
     chalked and sooted rather than as flat colour. */
  pal.cargo = dress(new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, metalness: 0.05,
    roughness: 0.72 + spec.wear * 0.16, envMapIntensity: 0.85,
  }), { plate: 1.5, bleach: 0.5 + spec.wear * 0.3, soot: spec.wear * 0.7, brushed: 0.3, edge: 0.30 });
  // Cold white-blue, and brighter than the kit's default: a cabin light has to
  // survive AgX and still read as a light rather than as pale paint.
  pal.lit = emitter(CABIN, 2.6);

  /* Bounce, so the dark side is a shadow and not a hole.
     These hulls are the game's scale witness — the brief's own argument for
     them is that a planet needs something small and lit beside it — and a
     witness that goes to zero the moment it turns away from the key is not
     doing that job. The environment probe is a PMREM of the nebula and it is
     the only fill out here; at the kit's default the shadow side of a freighter
     measured under two counts, which is the "silhouette with running lights on
     it" reading rather than a lit object. */
  for (const k of ['paint', 'structure', 'metal', 'panel', 'accent', 'cargo']) {
    if (pal[k]) pal[k].envMapIntensity *= 1.30;
  }

  /* ---- shadows ----------------------------------------------------------
     A freighter's roof truss sat directly on its containers and marked none of
     them; the radiator leaves crossed the engine room and marked nothing; a
     stack of boxes lit from one side had no idea the box beside it existed. A
     hull that does not occlude itself is a set of separately-lit parts that
     happen to overlap, which is exactly how the traffic read.

     `lit` and `glass` are excluded — an emissive pane and a canopy are not
     blockers, and a depth pass over either puts the light inside its own
     shadow. The beacons and the plume are added after this loop and never get
     the flag at all.

     And these are *culled*. The template's blanket `frustumCulled = false`
     below is there for the beacon mesh, whose position attribute is a unit quad
     the vertex stage blows up from `aCenter` — a two-metre bounding sphere at
     the model's origin, which would cull the running lights the moment the hull
     left frame. Every other mesh here has honest bounds, and leaving them
     unculled means eighteen craft scattered across four million kilometres each
     draw a full depth pass into a shadow box a hundred metres wide, every
     frame, for nothing. */
  for (const k of WELD_ORDER) {
    const m = weld(L[k], pal[k], root);
    if (!m) continue;
    m.receiveShadow = true;
    m.castShadow = k !== 'lit' && k !== 'glass';
    m.userData.solid = true;
  }

  // every lamp, and a throat glow per engine, in one mesh
  const lights = spec.lights.slice();
  for (const e of spec.engines) {
    lights.push({
      pos: [e.pos[0], e.pos[1], e.pos[2] - 0.4], hex: spec.plumeA,
      gain: 1.75, size: e.r * 0.72, px: 1.25,
    });
  }
  const beacon = makeBeacons(lights);
  if (beacon) root.add(beacon);

  const plumeMat = new THREE.ShaderMaterial({
    vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: {
      uColA: { value: new THREE.Color(spec.plumeA) },
      uColB: { value: new THREE.Color(spec.plumeB) },
      uTime: { value: 0 }, uPower: { value: 0.62 },
    },
  });
  const plume = makePlumes(spec.engines, plumeMat);
  if (plume) root.add(plume);

  root.scale.setScalar(M);
  root.traverse((o) => { o.frustumCulled = !!o.userData.solid; });
  return { root, length: spec.length * M, plumeMat };
}

/* ============================================================== behaviours */

/**
 * Analytic paths. Each returns a position for a given time; the craft's
 * orientation is derived by sampling slightly ahead, so a ship always points
 * where it is going without any state to keep.
 */
const PATHS = {
  // a long haul between two bodies, with a turnaround at each end
  transit(p, t, out) {
    const period = p.period;
    const u = ((t / period) + p.phase) % 1;
    // ease at both ends: a real burn accelerates, coasts and decelerates
    const s = u < 0.5 ? u * 2 : (1 - u) * 2;
    const e = s * s * (3 - 2 * s);
    out.copy(p.a).lerp(p.b, u < 0.5 ? e * 0.5 : 1 - e * 0.5);
    out.y += Math.sin(u * Math.PI * 2 + p.phase * 9) * p.wobble;
    return out;
  },
  // circling a body
  orbit(p, t, out) {
    const a = t * p.rate + p.phase * Math.PI * 2;
    out.set(Math.cos(a) * p.radius, Math.sin(a * 1.7 + p.phase) * p.radius * p.inc, Math.sin(a) * p.radius);
    out.add(p.center);
    return out;
  },
  // loose station-keeping: drift around a point without ever settling
  hover(p, t, out) {
    out.set(
      Math.sin(t * 0.11 + p.phase * 7) * p.radius,
      Math.sin(t * 0.07 + p.phase * 3) * p.radius * 0.5,
      Math.cos(t * 0.09 + p.phase * 5) * p.radius
    );
    out.add(p.center);
    return out;
  },
};

/* ================================================================== fleet */

export class Fleet {
  /**
   * @param {object} sys     the generated system
   * @param {object[]} bodies  Game's body list, already positioned
   * @param {string} quality
   */
  constructor(sys, bodies, quality) {
    this.rnd = mulberry32((sys.stub.seed ^ 0x7a11) >>> 0);
    this.object = new THREE.Group();
    this.object.matrixAutoUpdate = false;
    this.craft = [];
    this.templates = {};
    this.plumeMats = [];
    this.quality = quality;

    const budget = quality === 'low' ? 7 : quality === 'medium' ? 12 : 18;
    this._populate(sys, bodies, budget);
  }

  _template(kind) {
    if (!this.templates[kind]) {
      const t = buildTemplate(kind, this.rnd);
      this.templates[kind] = t;
      if (t.plumeMat) this.plumeMats.push(t.plumeMat);
    }
    return this.templates[kind];
  }

  /**
   * Clone a template: geometry and materials are shared, only nodes are new.
   * The one exception is the beacon material, which carries this craft's own
   * strobe phase — two ships from the same yard must not blink in lockstep.
   */
  _spawn(kind) {
    const t = this._template(kind);
    const root = t.root.clone(true);
    const beacons = [];
    root.traverse((o) => {
      if (o.isMesh && o.material && o.material.uniforms && o.material.uniforms.uMinPx) {
        o.material = o.material.clone();
        beacons.push(o);
      }
    });
    return { root, beacons, length: t.length };
  }

  _populate(sys, bodies, budget) {
    const rnd = this.rnd;
    const planets = bodies.filter((b) => b.kind === 'planet');
    if (!planets.length) return;

    const inhabited = planets.filter((p) => p.spec.inhabited);
    const anchor = inhabited[0] || planets[Math.floor(planets.length / 2)];

    const add = (kind, path, params, opts = {}) => {
      if (this.craft.length >= budget) return null;
      const s = kind === 'mote' ? buildMote(rnd) : this._spawn(kind);
      this.object.add(s.root);
      const c = {
        kind, ...s, path, params,
        absPos: new THREE.Vector3(), quat: new THREE.Quaternion(),
        faction: opts.faction || (kind === 'mote' ? 'choir' : kind === 'patrol' ? 'institute' : 'free'),
        name: opts.name || CRAFT_NAMES[kind](rnd),
        hostile: !!opts.hostile,
        hailed: false,
      };
      this.craft.push(c);
      return c;
    };

    // ---- lanes between worlds. The single most legible sign of commerce is a
    // ship crossing the gap between two things you can also see.
    //
    // The period has to come from the *distance*, not from a taste-picked
    // number: a fixed 300-second leg across four million kilometres is thirteen
    // thousand km/s, sixty times what the player can manage, and every
    // freighter tears out of frame the instant you look at one. Fix the cruise
    // speed instead and let the clock fall out of it.
    const lanes = Math.min(4, Math.max(2, Math.floor(planets.length / 2)));
    for (let i = 0; i < lanes; i++) {
      const a = planets[Math.floor(rnd() * planets.length)];
      let b = planets[Math.floor(rnd() * planets.length)];
      if (b === a) b = planets[(planets.indexOf(a) + 1) % planets.length];
      const kind = rnd() < 0.55 ? 'freighter' : 'courier';
      const from = a.absPos.clone().addScaledVector(
        _v.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), a.radius * 3);
      const to = b.absPos.clone().addScaledVector(
        _v.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), b.radius * 3);
      // km/s: a loaded hauler is slower than the player, a courier faster
      const cruise = kind === 'freighter' ? 18 + rnd() * 22 : 55 + rnd() * 60;
      add(kind, 'transit', {
        a: from, b: to,
        period: Math.max(60, (from.distanceTo(to) / cruise) * 2.4),
        phase: rnd(), wobble: 4000 * rnd(),
      });
    }

    // ---- orbital traffic around the busiest world
    const nOrbit = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < nOrbit; i++) {
      const radius = anchor.radius * (1.35 + rnd() * 1.5);
      // Angular rate from a plausible tangential speed, for the same reason as
      // the lanes above — a fixed rate makes big worlds fling their traffic.
      const tangential = 6 + rnd() * 12;                  // km/s
      add(rnd() < 0.4 ? 'patrol' : rnd() < 0.7 ? 'courier' : 'tug', 'orbit', {
        center: anchor.absPos, radius,
        rate: (rnd() < 0.5 ? 1 : -1) * (tangential / radius),
        inc: (rnd() - 0.5) * 0.5, phase: rnd(),
      });
    }

    // ---- a drone swarm, working a second world
    const survey = planets[Math.floor(rnd() * planets.length)];
    const swarm = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < swarm; i++) {
      add('drone', 'hover', {
        center: survey.absPos.clone().addScaledVector(
          _v.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), survey.radius * (1.6 + rnd())),
        radius: survey.radius * 0.30, phase: rnd(),
      });
    }

    // ---- tugs working a belt
    if (sys.belts.length) {
      const belt = sys.belts[0];
      const n = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = (belt.inner + belt.outer) * 0.5;
        add('tug', 'hover', {
          center: new THREE.Vector3(Math.cos(a) * r, (rnd() - 0.5) * belt.thickness, Math.sin(a) * r),
          radius: 60, phase: rnd(),
        });
      }
    }

    // ---- and, rarely, something that has been running its errand for forty
    // thousand years
    if (rnd() < 0.55) {
      const host = planets[Math.floor(rnd() * planets.length)];
      const radius = host.radius * (2.2 + rnd());
      add('mote', 'orbit', {
        center: host.absPos, radius, rate: 3.0 / radius, inc: 0.6, phase: rnd(),
      }, { faction: 'choir', name: 'UNRESOLVED CONTACT' });
    }
  }

  /** Bodies that the targeting, scanner and archive should know about. */
  contacts() {
    return this.craft.map((c) => ({
      kind: 'craft', craftKind: c.kind, name: c.name, faction: c.faction,
      radius: c.length * 1.5, absPos: c.absPos, craft: c,
      id: `craft:${c.name}`,
    }));
  }

  update(dt, ctx) {
    const t = ctx.time;
    // one uniform per class, not per craft: the torch flicker is the same
    // physics on every hull of a given type
    for (const m of this.plumeMats) m.uniforms.uTime.value = t;

    for (const c of this.craft) {
      _prev.copy(c.absPos);
      PATHS[c.path](c.params, t, c.absPos);

      // Orientation from the path itself: sample a moment ahead and point the
      // nose there. `lookAt` puts -Z on the target, which is where every hull
      // in this game has its nose, so no correction is needed.
      PATHS[c.path](c.params, t + 0.35, _ahead);
      _fwd.copy(_ahead).sub(c.absPos);
      if (_fwd.lengthSq() > 1e-14) {
        _m4.lookAt(_zero, _fwd.normalize(), ctx.up);
        c.quat.setFromRotationMatrix(_m4);
      }
      c.speed = _prev.distanceTo(c.absPos) / Math.max(dt, 1e-4);
      c.root.position.copy(c.absPos).sub(ctx.origin);
      c.root.quaternion.copy(c.quat);

      // A mote does not fly, it *hangs*, and its shards turn against the core.
      if (c.kind === 'mote') {
        c.root.rotation.y += dt * 0.10;
        c.root.rotation.x += dt * 0.04;
        c.spin.rotation.y -= dt * 0.26;
        c.spin.rotation.z += dt * 0.07;
        c.shellMat.uniforms.uTime.value = t;
        c.shellMat.uniforms.uGain.value = 1.35 + 0.45 * Math.sin(t * 0.6 + c.params.phase * 6);
      }

      for (const b of c.beacons) {
        b.material.uniforms.uPixel.value = ctx.pixelScale;
        b.material.uniforms.uTime.value = t;
        b.material.uniforms.uPhase.value = c.params.phase;
      }
    }
  }

  dispose() {
    this.object.traverse((o) => {
      if (o.isMesh) { o.geometry?.dispose?.(); }
    });
    for (const c of this.craft) {
      for (const b of c.beacons) b.material?.dispose?.();
      c.shellMat?.dispose?.();
    }
    for (const k of Object.keys(this.templates)) {
      this.templates[k].root.traverse((o) => { if (o.isMesh) o.material?.dispose?.(); });
    }
  }
}

/* --------------------------------------------------------------- flavour */

const HULL_NAMES = ['Ashgrain', 'Tallow', 'Nine Reeds', 'Cold Harvest', 'Miserere',
  'Long Patience', 'Verity', 'Kettle', 'Sallow', 'Bright Fault', 'Undersong',
  'Thousandth Name', 'Ochre', 'Fen', 'Provident', 'Salt Angel', 'Bellwether'];

const CRAFT_NAMES = {
  freighter: (r) => `${pick(r, HULL_NAMES)} · bulk`,
  courier: (r) => `${pick(r, HULL_NAMES)} · courier`,
  tug: (r) => `Yard tender ${1 + Math.floor(r() * 40)}`,
  patrol: (r) => `INSTITUTE ${['ARGUS', 'VIGIL', 'KEEPER', 'WARDEN'][Math.floor(r() * 4)]}-${1 + Math.floor(r() * 9)}`,
  drone: (r) => `Survey drone ${String.fromCharCode(65 + Math.floor(r() * 26))}${1 + Math.floor(r() * 9)}`,
  mote: () => 'UNRESOLVED CONTACT',
};
function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
