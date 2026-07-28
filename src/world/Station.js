import * as THREE from 'three';
import {
  M, place, slab, panel, weld, palette, truss, solarWing, greebles, emitter, dress, loftBox,
} from '../gfx/greeble.js';
import { LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';
import { mulberry32 } from './generate.js';

/* ============================================================================
   Orbital infrastructure.

   The single cheapest way to make a system feel inhabited is to hang something
   enormous and *lit* in front of a planet. A station does three jobs a planet
   cannot do on its own:

     it gives the world a sense of scale — you finally have a metre stick;
     it is the only large object in the game with interior light, so it reads
       as occupied rather than as geology;
     and it puts a horizon line and a hard diagonal into a frame that would
       otherwise be one sphere and a lot of black.

   ---------------------------------------------------------------------------
   The architecture, and why it is this one.

   The first version was a wheel lying in the XZ plane with a spine running
   along Z *through* it. Two things followed from that and both were fatal.
   The spine and the ring occupied the same volume, so the middle of the wheel
   was a thicket of planks with no readable relationship to each other; and a
   ring whose axis is the world's vertical is seen edge-on from every camera
   near the ecliptic, which is where the camera nearly always is. What the
   reviewer got was "a long thin white bar with rectangular panels stuck to it".
   They were right: from a low elevation there was nothing else to see.

   So the wheel now turns about the *spine*, which is the only arrangement in
   which the two largest objects in the model explain each other — a fixed core
   with a rotating habitat ring around its waist, riding on a visible bearing.
   The core is a real mass rather than a mast, and it is loaded asymmetrically:

     bow            command tower, high and to one side, so the shape has a
                    front and the silhouette is never mirror-symmetric;
     forward drum   docking arms and berths, one of them occupied;
     hub + wheel    the bearing, the six spokes, the ring;
     tank farm      six pressure vessels in a hexagon, the single biggest
                    source of self-occlusion on the model;
     starboard      the docking bay: a hangar with a mouth a ship fits through,
                    an approach lane of lights leading to it, and light
                    spilling out of it across the hull;
     port           the cargo raft, a rack of containers under a gantry;
     stern          truss, radiators, arrays.

   Every one of those is a thing a viewer can point at and name, which is the
   whole of what "readable function" means.

   It has to survive being read at three distances, and each one wants a
   different thing:

     silhouette   — ring, core, tanks, bay, radiators, arrays: five masses of
                    different shape, none of them centred, so the outline is
                    interesting from any angle the camera can orbit to;
     module       — albedo variation between modules, so a five hundred metre
                    object is not one moulded piece of off-white;
     surface      — plate seams, ring frames, stringers, hazard striping,
                    painted registry numbers, floodlights, running lights,
                    handrails, and ten thousand windows.

   Windows are the whole trick. They are not lights — they are two merged
   emissive meshes of a few hundred quads, each *subdivided in the shader* into
   a block of individually seeded rooms, drawn in one call each. Under the bloom
   pass that reads as a city.
   ========================================================================== */

const _lin = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/* ------------------------------------------------------------------ windows */

/* Panes are deliberately oversized — five to ten metres, not two. A realistic
   viewport on a 600 m wheel is a third of a pixel from any distance you would
   actually frame the station at, and a third of a pixel of emissive is nothing
   at all. The cheat is invisible and the alternative is a dark station.

   The cost of the cheat is that a ten metre quad of flat emissive reads as a
   ten metre quad, so each pane carries its cell count in its own UVs and the
   shader breaks it back down into rooms with mullions between them. Frankly
   oversized *outside*, correctly scaled *inside* — and the cell count is what
   keeps every window on the station the same apparent size as every other,
   which is the only reason they work as a metre stick. */
function paneGeo(w, h, cx, cy) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv.array;
  for (let i = 0; i < uv.length; i += 2) { uv[i] *= cx; uv[i + 1] *= cy; }
  return g;
}

const WINDOW_VERT = /* glsl */`${LOGD_V_PARS}
attribute float aLit;
attribute float aSeed;
varying float vLit;
varying float vSeed;
varying vec2  vCell;
varying vec3  vN;
varying vec3  vW;
void main(){
  vLit = aLit; vSeed = aSeed; vCell = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGD_V}
}
`;

const WINDOW_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying float vLit;
varying float vSeed;
varying vec2  vCell;
varying vec3  vN;
varying vec3  vW;
uniform vec3  uWarm;
uniform vec3  uCold;
uniform float uGain;
uniform float uTime;
uniform vec3  uCamPos;

float wHash(vec2 p){
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.71);
  return fract(p.x * p.y * 95.4307);
}

void main(){
  ${LOGD_F}
  vec2 cell = floor(vCell);
  vec2 f = fract(vCell);
  float rid = wHash(cell + vSeed * 17.3);
  float rid2 = wHash(cell * 1.73 + vSeed * 5.11 + 3.0);
  float rid3 = wHash(cell * 0.61 + vSeed * 21.7 + 11.0);

  // Rooms, not lamps. Three in ten dark is what makes the rest read as
  // occupied; a fully lit grid reads as a texture, and much past a third dark
  // the wheel stops reading as inhabited at all — the pane list already throws
  // a quarter to two fifths of the *panes* away before this runs.
  float on = step(0.30, rid) * vLit;

  // A couple of rooms per hundred are on a different shift and blink.
  float blink = step(0.965, rid);
  on *= mix(1.0, step(0.45, fract(uTime * 0.31 + rid * 11.0)), blink);

  // mullions
  vec2 e = smoothstep(0.0, 0.16, f) * smoothstep(0.0, 0.16, 1.0 - f);
  float pane = e.x * e.y;

  /* ---- what is behind the glass.
     Every pane on the station used to run the same two lines — a ceiling strip
     and one uniform random — and every one of them then went through a gain
     high enough that the strip clipped. So they came out as the same hard white
     rectangle at the same brightness whatever the seed said, which is precisely
     the "identical stickers on a dark lump" reading.

     Three things fix it and none of them is geometry. The brightness
     distribution is a *power* law rather than a uniform one, so most rooms sit
     well down the curve and a handful punch through it — which is the only way
     a run of windows has a value range after AgX rather than a threshold. The
     head of the reveal shades the top of the glass, so the pane has a dark
     lintel and reads as set into something. And a little over half of them have
     somebody's furniture in the way. */
  float ceilStrip = 0.34 + 1.12 * smoothstep(0.44, 0.90, f.y);
  ceilStrip *= 1.0 - 0.70 * smoothstep(0.84, 1.0, f.y);      // lintel
  // a partition, a locker, a person: a dark vertical against the back wall
  float ox = fract(rid2 * 31.7) * 0.7 + 0.15;
  float sil = step(0.52, rid3)
            * (1.0 - smoothstep(0.0, 0.13, abs(f.x - ox)))
            * (1.0 - smoothstep(0.32, 0.70, f.y));
  // and one in seven has the blind half down
  float blind = step(0.86, rid2) * (1.0 - smoothstep(0.40, 0.46, f.y));

  /* Most of the range, and then a few that punch out of it. A frame in which
     nothing clips reads flat — measurably: the station sat at 0.001% of pixels
     above 250 with the power law alone. One room in thirty-odd is a hangar
     door, a galley or a shop floor with everything switched on, and those are
     what put a highlight on the wheel that the bloom pass has something to do
     with. It is the same hash that decides warmth, so a hot room is usually
     also a working one. */
  float bright = 0.14 + 3.0 * pow(rid2, 2.2) + 5.5 * step(0.972, rid3);
  float lum = on * pane * ceilStrip * bright
            * (1.0 - 0.82 * sil) * (1.0 - 0.72 * blind);

  // A window seen edge-on shows you the wall, not the room. With the wheel
  // turning, this is what makes the promenade breathe.
  vec3 V = normalize(uCamPos - vW);
  float face = clamp(abs(dot(normalize(vN), V)), 0.0, 1.0);
  lum *= 0.18 + 0.82 * pow(face, 0.85);

  // discard + gl_FragDepth mis-compiles under ANGLE/Metal, so a black
  // premultiplied fragment and a return instead.
  if (lum < 0.0025) { gl_FragColor = vec4(0.0); return; }

  /* Biased cold, and the temperature is per *room*. Human-made light in this
     game is white-blue; the warm end is there so a run of panes is never
     uniform, not so the wheel goes amber. One room in nine is a working space
     under a sodium lamp and sits right at the warm end — those are the ones
     that make the cold ones read as cold. */
  float warmth = fract(rid * 7.31 + rid3 * 0.55);
  warmth = mix(warmth * warmth, 0.90, step(0.89, rid3));
  vec3 c = mix(uCold, uWarm, warmth);
  gl_FragColor = vec4(c * lum * uGain, 1.0);
}
`;

/* ------------------------------------------------------------------ beacons

   Running lights were spheres of emissive: 3.4 m across and gain 13, which at
   the distance you actually frame a station from resolved as a row of blown
   white discs the size of the hab modules they were bolted to — the reviewer
   counted them before they counted anything else on the model.

   The fix is the one `Fleet.js` already uses for craft lights. A camera-facing
   quad whose world size is derived from its own view depth holds a *fixed
   number of pixels* however far away it is, so a lamp is a hard three-pixel
   point at eight radii and a real 1.4 m fitting when you are parked next to it.
   Physical size loses every time, and so does physical brightness.

   All of a station's lights are one mesh — centre, tint, gain, floor size,
   pixel size and flash mode are per-vertex — so seventy lamps cost one draw.
   Unlike the fleet's, these *do* depth-test: a running light on the far side
   of the ring has to go behind the ring, because self-occlusion is most of
   what says the object has a volume at all. Which means they need the log
   depth chunks, exactly like every other custom shader drawn in world space. */
const BEACON_VERT = /* glsl */`${LOGD_V_PARS}
attribute vec3 aCenter;    // lamp position, metres, station space
attribute vec3 aTint;
attribute vec4 aParam;     // gain, floor size (world units), mode, pixels
uniform float uPixel;      // world units per pixel at unit depth
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  float depth = max(-mv.z, 1e-6);
  float s = max(aParam.y, aParam.w * uPixel * depth);

  // 0 steady, 1 xenon anti-collision strobe, 2 slow rotating hazard beacon
  float g = aParam.x;
  if (aParam.z > 0.5) {
    float fast = step(aParam.z, 1.5);
    float rate = mix(0.38, 0.90, fast);
    float duty = mix(0.26, 0.07, fast);
    float cyc  = fract(uTime * rate + aCenter.z * 0.0037 + aCenter.x * 0.0021);
    g *= step(cyc, duty) * mix(1.5, 3.0, fast);
  }
  vCol = aTint * g;

  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
  ${LOGD_V}
}
`;
const BEACON_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec2 vUv;
varying vec3 vCol;
void main(){
  ${LOGD_F}
  vec2 d = vUv * 2.0 - 1.0;
  float r = length(d);
  // No discard: it mis-compiles against gl_FragDepth under ANGLE, and a
  // premultiplied zero is free anyway.
  float m = step(r, 1.0);
  float core = pow(max(1.0 - r, 0.0), 3.0);
  float halo = pow(max(1.0 - r, 0.0), 1.4) * 0.42;
  float a = (core + halo) * m;
  gl_FragColor = vec4(vCol * a, a);
}
`;

const _quad = [[-0.5, -0.5, 0, 0], [0.5, -0.5, 1, 0], [0.5, 0.5, 1, 1], [-0.5, 0.5, 0, 1]];
const _sz = new THREE.Vector2();

/* Every gain below is multiplied by this on the way in, and it is not a fudge
   factor — it is the difference between a three-pixel dot that exists and one
   that does not. A lamp authored at 9 units of radiance and drawn across three
   pixels contributes almost nothing once auto-exposure has stopped down for a
   sunlit hull filling half the frame: the old emissive spheres got away with
   the same number only because they were six metres across and covered fifty
   pixels each, which is precisely why they read as blown white discs rather
   than as lights. Small and hot beats large and warm. Photospheres in this game
   sit at 100-400; a running light belongs an order of magnitude under that. */
const LAMP_GAIN = 4.0;

/** Every lamp in one list, merged into one distance-locked mesh. */
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
      par[v * 4 + 1] = (l.size ?? 1.3) * M;
      par[v * 4 + 2] = l.mode ?? 0;
      par[v * 4 + 3] = l.px ?? 2.6;
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
    transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uPixel: { value: 0.002 }, uTime: { value: 0 } },
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 5;
  m.onBeforeRender = (r, s, cam) => {
    r.getSize(_sz);
    // world units per pixel at unit depth, from the projection actually in use
    mat.uniforms.uPixel.value = 2 / (cam.projectionMatrix.elements[5] * Math.max(1, _sz.y));
    mat.uniforms.uTime.value = performance.now() * 0.001;
  };
  return m;
}

/* --------------------------------------------------------------- floodlight */

/* A cone of light with nothing in it is still a cone of light: the shaft is
   what tells you a lamp is pointed *at* something, and a docking bay without
   one is a hole. Additive, grazing-weighted so the cone's edge is brighter
   than its middle, and it never writes depth. */
const CONE_VERT = /* glsl */`${LOGD_V_PARS}
varying vec2 vC; varying vec3 vW; varying vec3 vN;
void main(){
  vC = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGD_V}
}
`;
const CONE_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec2 vC; varying vec3 vW; varying vec3 vN;
uniform vec3 uCol; uniform vec3 uCamPos; uniform float uGain;
void main(){
  ${LOGD_F}
  float t = clamp(vC.y, 0.0, 1.0);          // 1 at the lamp, 0 at the pool
  // A shaft is bright where it leaves the lamp and gone before it lands.
  float fall = pow(t, 3.0) * (1.0 - pow(t, 22.0));
  vec3 V = normalize(uCamPos - vW);
  float f = 1.0 - abs(dot(normalize(vN), V));
  /* What this surface stands in for is a *volume*, and the amount of it a ray
     passes through grows toward the silhouette — so weighting by grazing angle
     is right. Taking it all the way to the edge is not: the alpha peaked
     exactly where the geometry stopped, which put a hard bright line round a
     fourteen-sided cone and made the shaft read as a pane of blue glass rather
     than as light. The band now peaks just inside the outline and falls to
     nothing at it, so the cone has no edge at all. */
  float thru = pow(f, 2.4) * (1.0 - smoothstep(0.82, 1.0, f));
  // and it dies at the apex as well, where a real lamp has a housing in the way
  float a = fall * thru * smoothstep(1.0, 0.90, t) * uGain;
  gl_FragColor = vec4(uCol * a, 1.0);
}
`;

/* ------------------------------------------------------- surface treatments */

/* `dress` lays its plate frame out in a cylinder along Z. On a six hundred
   metre ring lying in XZ that produces almost nothing, which is why the wheel —
   the largest continuous surface in the game — came out as one smooth off-white
   band. A torus wants its own frame: distance *around* the ring for the bays,
   angle *around the tube* for the staves. */
function ringDetail(mat, R, dead) {
  const base = mat.onBeforeCompile;
  const key = 'sta_ring_' + R.toFixed(1) + (dead ? '_d' : '');
  mat.onBeforeCompile = (sh) => {
    base(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', /* glsl */`
      #include <alphamap_fragment>
      {
        vec3 rp = vShipPos;
        float maj = atan(rp.z, rp.x);
        float rr  = length(rp.xz);
        float minr = atan(rp.y, rr - ${R.toFixed(2)});
        float arc = maj * ${R.toFixed(2)};                 // metres around the ring

        // plate bays around the ring, staves around the tube
        float bay = arc / 13.0, stave = minr * 3.2;
        float sA = 1.0 - smoothstep(0.0, 0.055, abs(fract(bay) - 0.5));
        float sB = 1.0 - smoothstep(0.0, 0.060, abs(fract(stave) - 0.5));
        diffuseColor.rgb *= 1.0 - max(sA, sB * 0.75) * 0.55;

        // Frame stations. A pressure ring is built in bays between ring
        // frames, and the frames show through the skin as a shallow step every
        // twenty-odd metres. This is the largest-scale detail on the wheel and
        // the only one still legible at eight radii.
        float fr = 1.0 - smoothstep(0.0, 0.018, abs(fract(arc / 21.0) - 0.5));
        diffuseColor.rgb *= 1.0 - fr * 0.34;

        // Per-plate albedo. This is the whole difference between a hull and a
        // moulded shell: no two panels on a real pressure vessel were made in
        // the same year, replaced at the same time or faded by the same amount.
        vec2 pc = vec2(floor(bay), floor(stave));
        float pseed = fract(sin(dot(pc, vec2(12.9898, 78.233))) * 43758.5453);
        diffuseColor.rgb *= 0.80 + 0.42 * pseed;

        // Module-to-module albedo. Without it the ring is one moulded piece;
        // with it a stranger's eye counts the sections and gets the size.
        float mseed = fract(sin(floor(arc / 52.0) * 12.9898 + 4.1) * 43758.5453);
        diffuseColor.rgb *= 0.78 + 0.46 * mseed;

        /* ---- and a *colour* per section.  A six hundred metre wheel painted
           one value of off-white is the single loudest difference between this
           and the reference art: measured against a real yard the frame came
           back at 0.12 saturation to their 0.34, and none of the geometry in
           the world fixes that. The palette is the game's own — bone, slate,
           oxide, rust — so the wheel gains hue separation between sections
           without gaining a colour the brief does not allow. It is four
           constants and a hash, and it costs nothing per frame. */
        vec3 secHue = mseed < 0.34 ? vec3(0.196, 0.194, 0.176)      // bone
                    : mseed < 0.58 ? vec3(0.106, 0.130, 0.150)      // slate blue
                    : mseed < 0.80 ? vec3(0.210, 0.106, 0.052)      // oxide
                                   : vec3(0.140, 0.086, 0.062);     // rust
        float hueK = 0.30 + 0.34 * fract(mseed * 7.1);
        diffuseColor.rgb = mix(diffuseColor.rgb,
                               secHue * (0.55 + 1.5 * dot(diffuseColor.rgb, vec3(0.33))),
                               hueK * ${dead ? '0.30' : '1.0'});

        /* The wheel's overall value.
           Three multipliers already run over this surface — per plate, per
           module and per section hue — and each of them had a mean below one,
           so the compounded result sat at about 0.58 of the paint it was told
           to use. On the largest continuous surface in the game, lit by one
           raking key with nothing but bounce to fill it, that measured out at a
           mean of eight counts and eighty per cent pure black: a dark mud lump
           with white stickers on it, which is what the review said. The three
           laws above are now centred on one and this is the only deliberate
           step down, which is the sooting the ring actually earns. */
        diffuseColor.rgb *= 0.88;

        // Painted registry band on the outward face, dashed so it reads as
        // paint rather than as a moulding.
        float outFace = 1.0 - smoothstep(0.0, 0.34, abs(minr));
        float dash = step(0.32, fract(arc / 31.0));
        // The corpse keeps its livery, but as a stain rather than as paint —
        // a bright band undoes the whole point of a dark hull.
        diffuseColor.rgb = mix(diffuseColor.rgb,
                               ${dead ? 'vec3(0.075, 0.028, 0.008)' : 'vec3(0.400, 0.104, 0.011)'},
                               outFace * dash * ${dead ? '0.55' : '0.78'});

        // The inner face is in permanent shade from the ring itself, and a
        // darker promenade wall is what lets the glazing read as light. Not
        // black, though: it is filled by the rest of the wheel facing it, which
        // is the brightest thing anywhere near it.
        diffuseColor.rgb *= mix(1.0, 0.60, smoothstep(0.1, 0.8, -cos(minr)));
        ${dead ? /* glsl */`
        // Forty thousand years of nothing: the paint is gone, the metal is
        // scorched, and there are burn shadows downstream of every rupture.
        float burn = smoothstep(0.28, 0.80, hFbm(rp * 0.055));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.009, 0.008, 0.007), burn * 0.9);
        diffuseColor.rgb *= 0.55;
        ` : ''}
      }
    `);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/* The same argument, for the core. `dress` gives a five hundred metre hull the
   same 2 m plate grid it gives a twenty metre nacelle, and at the distance a
   station is actually framed from that grid is finer than a pixel — it averages
   out to exactly the "uniform flat mid-grey field" the review complained about.
   What a big object needs is detail at the *module* scale: ring frames every
   dozen metres, whole sections of hull that were painted in different decades,
   and a shadow line under every frame. All keyed off z, which on this model is
   the axis every drum, tank and truss is built along. */
function coreDetail(mat, dead) {
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => {
    base(sh);
    /* The hull's own axis, in view space. A groove drawn only in albedo stays
       flat under a raking key — which is the light this game is entirely made
       of — so the frames roll the shading normal into the seam and back out of
       it as well. That needs a direction to roll *toward*, and the only one
       that means anything here is the axis every drum on the model is turned
       about. */
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAxisV;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vAxisV = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAxisV;')
      .replace('#include <normal_fragment_begin>', /* glsl */`
      #include <normal_fragment_begin>
      {
        float sideN = 1.0 - abs(vShipNrm.z);
        float fzN = fract(vShipPos.z / 11.5) - 0.5;
        float kN = -sin(fzN * 6.2831853) * exp(-fzN * fzN * 220.0) * 0.62 * sideN;
        normal = normalize(normal + vAxisV * kN);
      }
    `);
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', /* glsl */`
      #include <alphamap_fragment>
      {
        float z = vShipPos.z;

        // Ring frames: a groove with a burnished lip on the sunward side of it,
        // every 11.5 m along the hull, only where the surface is not itself an
        // end cap. On the drums this is the detail that carries the read.
        float side = 1.0 - abs(vShipNrm.z);
        float fz = fract(z / 11.5) - 0.5;
        float fr = 1.0 - smoothstep(0.0, 0.055, abs(fz));
        float lipz = smoothstep(0.16, 0.06, abs(fz)) * step(0.0, fz);
        diffuseColor.rgb *= 1.0 - side * (fr * 0.42 - lipz * 0.10);

        // Module bands. A 500 m structure is assembled from sections that were
        // built in different yards and repainted at different times; two draws
        // per section, one broad and one narrow, so the hull reads as a stack
        // rather than as an extrusion.
        float mid = floor(z / 27.0);
        float ms = fract(sin(mid * 12.9898 + 7.13) * 43758.5453);
        float mb = fract(sin(floor(z / 96.0) * 39.71 + 1.9) * 43758.5453);
        diffuseColor.rgb *= 0.66 + 0.56 * ms;
        diffuseColor.rgb *= 0.86 + 0.30 * mb;

        // Section colour, the same law the wheel uses. Weaker here: the core is
        // the bone-coloured spine everything else is bolted to, and it earns
        // its hue in bands rather than section by section.
        vec3 cHue = mb < 0.42 ? vec3(0.196, 0.194, 0.176)
                  : mb < 0.70 ? vec3(0.106, 0.130, 0.150)
                              : vec3(0.205, 0.104, 0.050);
        diffuseColor.rgb = mix(diffuseColor.rgb,
                               cHue * (0.55 + 1.5 * dot(diffuseColor.rgb, vec3(0.33))),
                               (0.18 + 0.28 * ms) * ${dead ? '0.30' : '1.0'});

        // Stringers running the length of it, faint, so the drums do not read
        // as turned stock.
        float ang = atan(vShipPos.y, vShipPos.x);
        float st = 1.0 - smoothstep(0.0, 0.09, abs(fract(ang * 3.8) - 0.5));
        diffuseColor.rgb *= 1.0 - st * side * 0.16;
        ${dead ? /* glsl */`
        float burn = smoothstep(0.30, 0.82, hFbm(vShipPos * 0.05));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.010, 0.009, 0.008), burn * 0.85);
        diffuseColor.rgb *= 0.62;
        ` : ''}
      }
    `);
  };
  mat.customProgramCacheKey = () => 'sta_core' + (dead ? '_d' : '');
  return mat;
}

/* Diagonal hazard striping. Sharp edges are the point — a *noisy* stripe reads
   as corrosion, and corrosion reads as a shader bug. Keyed off object-space
   position so it stays continuous across a merged mesh with no UVs.

   What it must not be is *new*. The old version laid down a fully saturated
   orange straight out of the tin, at 92% over the paint, with a ruled edge —
   which made the chevrons the most saturated thing in any frame of the station
   and the one surface on a hundred-year-old structure that had never been
   touched. Three things fix that and none of them is noise for its own sake:
   the boundary wanders slowly, because paint was masked off by hand and has
   been rubbed back since; there are scuffs through to the substrate where the
   hull is handled; and the orange itself is a decade of ultraviolet down from
   the colour it was mixed. */
function hazardMat(dead) {
  const m = dress(new THREE.MeshStandardMaterial({
    color: 0x9d9a92, metalness: 0.12, roughness: 0.70, envMapIntensity: 0.8,
  }), { plate: 1.2, bleach: 0.5, soot: dead ? 1.0 : 0.55 });
  const base = m.onBeforeCompile;
  m.onBeforeCompile = (sh) => {
    base(sh);
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', /* glsl */`
      #include <alphamap_fragment>
      {
        float ph = (vShipPos.x + vShipPos.y + vShipPos.z) * 0.14;
        // A hand-masked edge, not a ruled one. Low frequency on purpose: this
        // has to read as a wandering boundary at ten metres and as a straight
        // stripe at three hundred, and anything faster reads as rot.
        ph += 0.055 * hFbm(vShipPos * 0.115);
        float tw = abs(fract(ph) - 0.5) * 2.0;
        // The filter width has to be clamped. Left open it swallows the whole
        // stripe at any distance and the hazard band renders as one flat slab
        // of orange, which is exactly what a hazard band is not.
        float w = clamp(fwidth(ph) * 1.6, 0.02, 0.40);
        float s = smoothstep(0.5 - w, 0.5 + w, tw);
        // Chalked. Fresh hazard orange is 0.48 of the red channel; this is what
        // it goes to once the binder has gone and the pigment has powdered.
        vec3 hz = mix(vec3(0.021, 0.020, 0.018), vec3(0.300, 0.088, 0.013), s);
        // Bleaching is uneven across a stripe, so the run has light and dark
        // chevrons rather than one value repeated.
        hz *= 0.74 + 0.46 * hFbm(vShipPos * 0.055 + 9.0);
        // and it is off altogether where the hull gets handled
        float rub = smoothstep(0.46, 0.88, hFbm(vShipPos * 0.62 + 3.0));
        hz = mix(hz, diffuseColor.rgb * 0.85, rub * 0.60);
        diffuseColor.rgb = mix(diffuseColor.rgb, hz, ${dead ? '0.42' : '0.90'});
        ${dead ? 'diffuseColor.rgb *= 0.45;' : ''}
      }
    `);
  };
  m.customProgramCacheKey = () => 'sta_haz' + (dead ? 'd' : '');
  return m;
}

/* ---------------------------------------------------------------- numerals */

/* Painted registry numbers. Seven-segment blocks are close enough to a stencil
   font at any distance you will ever read one from, they cost a dozen boxes,
   and they are the single clearest signal that a hull belongs to somebody.
   Bit order a b c d e f g. */
const DIGIT = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
const LETTER = { A: 0x77, C: 0x39, E: 0x79, F: 0x71, H: 0x76, L: 0x38, P: 0x73, U: 0x3e, S: 0x6d, G: 0x7d, T: 0x78, N: 0x37, O: 0x3f, R: 0x77, D: 0x5b };

/* Glyph segments are plain boxes, not bevelled slabs. `slab` costs about three
   hundred triangles because it rounds and bevels its corners, which is right
   for a pylon and absurd for a stroke of paint: one registry number was
   costing more geometry than the pressure hull it was painted on, and the
   whole set of them ran to thirty thousand triangles a station. A box is
   twelve, and paint has no bevel to see. */

/** Glyph boxes for one character, in a box (0..w, 0..h), extruded ±d/2 in z. */
function glyph(mask, h, d) {
  const w = h * 0.60, t = h * 0.155, out = [];
  const hz = (y) => out.push(place(new THREE.BoxGeometry(w - t, t, d), { pos: [w / 2, y, 0] }));
  const vt = (x, y) => out.push(place(new THREE.BoxGeometry(t, h * 0.5 - t, d), { pos: [x, y, 0] }));
  if (mask & 0x01) hz(h - t / 2);
  if (mask & 0x08) hz(t / 2);
  if (mask & 0x40) hz(h / 2);
  if (mask & 0x20) vt(t / 2, h * 0.75);
  if (mask & 0x02) vt(w - t / 2, h * 0.75);
  if (mask & 0x10) vt(t / 2, h * 0.25);
  if (mask & 0x04) vt(w - t / 2, h * 0.25);
  return out;
}

/** A short run of characters, laid out from x=0, baseline y=0. */
function stencil(text, h, d) {
  const out = [];
  let x = 0;
  for (const ch of text) {
    if (ch === ' ') { x += h * 0.36; continue; }
    if (ch === '-') { out.push(place(new THREE.BoxGeometry(h * 0.34, h * 0.155, d), { pos: [x + h * 0.24, h / 2, 0] })); x += h * 0.52; continue; }
    const mask = ch >= '0' && ch <= '9' ? DIGIT[+ch] : (LETTER[ch] || 0x00);
    for (const g of glyph(mask, h, d)) { g.translate(x, 0, 0); out.push(g); }
    x += h * 0.78;
  }
  return { geo: out, width: x };
}

/* ------------------------------------------------------- lofted primitives

   Everything below exists for one reason. A structure assembled out of boxes
   and eight-sided tubes has no edge for a raking key to find, and a raking key
   is the only light in this game: a chamfered section catches a highlight line
   down every corner, and a plain box catches nothing and reads as a painted
   rectangle however good the shader on it is. `slab` bevels its four *outline*
   corners but the extrusion still ends in two flat faces; these give a section
   that is chamfered all the way round, a revolve about the station's own axis,
   and — the one shape the kit cannot express at all — an opening. */

/**
 * A chamfered structural bar: an octagonal section extruded along Z.
 *
 * The *ends* are deliberately square. Every edge a raking key can find on a
 * bar runs along its length and is chamfered by the outline; the two ends are
 * almost always butted into whatever the bar is bolted to. Bevelling them as
 * well triples the triangle count — 92 against 28 — and there are some seven
 * hundred bars on a station, which is forty thousand triangles of end caps
 * nobody can see. `capped` puts them back where an end really does show.
 */
function bar(w, h, len, ch, capped = false) {
  const hw = w / 2, hh = h / 2;
  const c = Math.min(ch ?? Math.min(w, h) * 0.30, hw * 0.62, hh * 0.62);
  const pts = [
    [-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c],
    [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c],
  ];
  if (capped) return panel(pts, len, Math.min(c * 0.55, len * 0.30));
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -len / 2);
  return g;
}

/** An I-section beam along Z — the section a real gantry rail actually has. */
function ibeam(w, h, len) {
  const hw = w / 2, hh = h / 2, t = Math.min(w, h) * 0.22;
  return panel([
    [-hw, -hh], [hw, -hh], [hw, -hh + t], [t / 2, -hh + t * 1.5],
    [t / 2, hh - t * 1.5], [hw, hh - t], [hw, hh], [-hw, hh],
    [-hw, hh - t], [-t / 2, hh - t * 1.5], [-t / 2, -hh + t * 1.5], [-hw, -hh + t],
  ], len, t * 0.30);
}

/** A revolved profile about +Z. `LatheGeometry` turns about Y; this stands the
    result up so it shares the axis every drum, tank and truss here is built
    along. Points are (radius, z). */
function latheZ(pts, seg = 26, phi0 = 0, phi = Math.PI * 2) {
  const g = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg, phi0, phi);
  g.rotateX(Math.PI / 2);
  return g;
}

/** A pressure hull section: a lathe with a chamfered break at each end, so a
    drum meets its cap on an edge the key can find instead of a knife line. */
function hullTube(r, z0, z1, seg = 26, ch = 1.4) {
  const c = Math.min(ch, (z1 - z0) * 0.30, r * 0.5);
  return latheZ([
    [0, z0], [r - c, z0], [r, z0 + c], [r, z1 - c], [r - c, z1], [0, z1],
  ], seg);
}

/**
 * A hollow lofted section: an outer profile with an inner one cut out of it,
 * extruded along Z. This is what a pressurised hall actually is — one shell
 * with a wall thickness — and it is both cheaper and enormously better than
 * five slabs laid round a void: the corners are mitred, the section can carry
 * a roof spine and a stepped floor, and every edge of it is chamfered.
 */
function shell(outer, inner, len, bevel = 0.8) {
  const s = new THREE.Shape();
  s.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i++) s.lineTo(outer[i][0], outer[i][1]);
  s.closePath();
  const h = new THREE.Path();
  h.moveTo(inner[0][0], inner[0][1]);
  for (let i = 1; i < inner.length; i++) h.lineTo(inner[i][0], inner[i][1]);
  h.closePath();
  s.holes.push(h);
  const b = Math.min(bevel, len * 0.30);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: len, bevelEnabled: true, bevelSize: b, bevelThickness: b,
    bevelSegments: 1, curveSegments: 2,
  });
  g.translate(0, 0, -len / 2);
  return g;
}

/** A rectangular frame with a chamfered bore: a hatch surround, a mouth
    collar, a recessed window box. `ExtrudeGeometry` takes holes, and nothing
    else in the kit can express an opening — which is why every hangar mouth in
    this file used to be four planks laid round a gap. */
function frameGeo(ow, oh, iw, ih, d, bevel = 0.9) {
  const s = new THREE.Shape();
  const rr = (sh, w, h, b) => {
    const hw = w / 2, hh = h / 2, c = Math.min(b, hw * 0.4, hh * 0.4);
    sh.moveTo(-hw + c, -hh);
    sh.lineTo(hw - c, -hh); sh.quadraticCurveTo(hw, -hh, hw, -hh + c);
    sh.lineTo(hw, hh - c); sh.quadraticCurveTo(hw, hh, hw - c, hh);
    sh.lineTo(-hw + c, hh); sh.quadraticCurveTo(-hw, hh, -hw, hh - c);
    sh.lineTo(-hw, -hh + c); sh.quadraticCurveTo(-hw, -hh, -hw + c, -hh);
  };
  rr(s, ow, oh, bevel * 3.0);
  const hole = new THREE.Path();
  rr(hole, iw, ih, bevel * 2.2);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: d, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel,
    bevelSegments: 2, curveSegments: 3,
  });
  g.translate(0, 0, -d / 2);
  return g;
}

/* ------------------------------------------------------------------ spars

   Every long member on this station used to be `slab(length, w, h)` — a
   constant rectangular section extruded end to end. That is the single most
   visible modelling failure left on the asset, and it is worst on exactly the
   parts the eye follows: a hundred and fifty metre docking arm, the pylons
   under the hangar, the booms carrying the radiators. A raking key finds one
   chamfer down each corner and then nothing at all for a hundred metres, so
   the member reads as a painted rectangle whatever is written on it.

   A real one is deepest where the bending moment is and steps where a load
   comes on. `loftBox` gives that for nothing — it is the same swept eight-sided
   section with a chamfer all the way round — and the stations below are chosen
   so the depth follows the load rather than a taste curve.

   `spar` returns the shell; `sparFrames` puts the second scale on it (ring
   frames every few metres, which is what a raking key actually breaks on) and
   `sparRun` puts the third (a conduit down one flank).  All three are authored
   along +X so they drop straight into the places `slab(len, w, h)` used to. */
function spar(len, stations, cham = 0.9) {
  return loftBox(stations.map(([t, hz, hy, yo = 0, zo = 0]) =>
    [(-0.5 + t) * len, hz, hy, yo, zo]), cham);
}

/* Transverse frames standing proud of a spar.

   The section has to come from the spar's own stations, not from a guess: a
   first pass fed it one nominal depth and a taper curve, which put every frame
   at the shallow end *inside* the shell — buried triangles nobody can see —
   while the ones amidships stood too far off. Interpolating the real section
   and adding a fixed proud amount means every frame reads, everywhere. */
function sparFrames(list, len, n, stations, proud = 1.5, t0 = 0.05, t1 = 0.95) {
  const at = (t) => {
    for (let i = 1; i < stations.length; i++) {
      if (t <= stations[i][0] || i === stations.length - 1) {
        const [a, az, ay] = stations[i - 1], [b, bz, by] = stations[i];
        const u = b === a ? 0 : Math.max(0, Math.min(1, (t - a) / (b - a)));
        return [az + (bz - az) * u, ay + (by - ay) * u];
      }
    }
    return [stations[0][1], stations[0][2]];
  };
  for (let i = 0; i < n; i++) {
    const t = t0 + (i / (n - 1)) * (t1 - t0);
    const [hz, hy] = at(t);
    list.push(place(bar((hz + proud) * 2, (hy + proud) * 2, 1.6, 0.4), {
      pos: [(-0.5 + t) * len, 0, 0], rot: [0, Math.PI / 2, 0],
    }));
  }
}

/** A conduit run along a spar, with the clips that hold it off the web. */
function sparRun(list, len, r, off, n = 6) {
  list.push(place(new THREE.CylinderGeometry(r, r, len * 0.94, 10)
    .rotateZ(Math.PI / 2), { pos: [0, off[0], off[1]] }));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    list.push(place(bar(r * 1.1, r * 3.4, r * 3.0), {
      pos: [(-0.47 + t * 0.94) * len, off[0] - r * 1.6, off[1]], rot: [0, Math.PI / 2, 0],
    }));
  }
}

/* A pressure vessel, turned about +Z.

   `CapsuleGeometry(17, 62, 4, 16)` is not a tank: four cap segments on a
   seventeen metre radius is a visibly faceted dome, and a capsule's hemisphere
   runs smoothly into its barrel with no edge anywhere for the key to find. A
   real vessel has a *torispherical* head — a shallow crown, a tight knuckle,
   and a short straight flange before the girth weld — and those three breaks
   are the whole reason a tank reads as a fabricated thing rather than as a
   turned billet. */
function vessel(R, L, seg = 28) {
  const k = R * 0.26;                       // knuckle radius
  const c = R * 0.40;                       // crown rise
  const half = (s) => [
    [R, s * (L / 2 - k * 0.9)],
    [R, s * (L / 2)],                       // straight flange, then the knuckle
    [R - k * 0.14, s * (L / 2 + k * 0.42)],
    [R - k * 0.52, s * (L / 2 + k * 0.80)],
    [R * 0.72, s * (L / 2 + c * 0.72)],
    [R * 0.40, s * (L / 2 + c * 0.96)],
    [0, s * (L / 2 + c * 1.04)],
  ];
  return latheZ([...half(-1).reverse(), ...half(1)], seg);
}

/* ---------------------------------------------------------------- freight

   A container is allowed to be a box. What it is not allowed to be is a
   *smooth* box. Two things make a real one read, at two completely different
   distances: at fifty metres it is the corrugation, because a raking key turns
   a corrugated flank into a run of alternating bright and dark stripes that
   follow the form and a flat flank into one grey rectangle; and at five metres
   it is the hardware — corner castings, locking bars, hinges, a placard.
   Painting either of them on is what the audit called out.

   The corrugation is geometry. The section is taken in *plan*, which is the way
   a real container corrugates — the ribs run vertically — and extruded up, at
   the pitch and depth a real box has rather than at a pitch picked to be cheap:
   see PITCH below for why that is the whole finding and not a detail.

   `body` is the painted shell, which the caller tints; `hard` is the alloy
   hardware, which it does not. */
export const CARGO_HUES = [
  0x7f8b93,   // pale blue-grey
  0xb0a894,   // cream
  0xa2542c,   // oxide orange
  0x77473a,   // rust
  0x936860,   // faded red-brown
  0x565f68,   // slate
  0x8a8377,   // bone
];

export function container(rnd, o = {}) {
  const L = o.len ?? 20, W = o.w ?? 8, H = o.h ?? 8.6;
  const type = o.type ?? 'box';
  const body = [], hard = [];
  const post = Math.min(0.9, L * 0.05);          // the corner post, flat
  const e = L / 2 - post;

  /* Corrugation pitch and depth, in metres, and they are not free parameters.
     This was 1.17 m of pitch at 0.26 m of depth — four times too coarse and
     seven times too deep — which puts a run of *person-sized* half-round pipes
     down a twelve-metre flank. At that scale the ribs are the largest feature
     on the box, so they set its apparent size, and a stack of them over a
     uniform oxide tint reads as corrugated iron: agricultural sheeting, or
     timber. An art director reading the freighter called exactly that.

     The depth is the half that does the damage and it is now honest: a real
     ISO box is about 36 mm deep, and at 45 mm the rib is a tooth on the sheet
     rather than a pipe welded to it.

     The pitch is a *renderer* limit, not a taste one, and it was measured. Real
     is 280 mm. At 280 mm this asset came back visibly worse than the defect it
     replaced: a freighter is framed at around three pixels per metre, so a
     280 mm period lands under one pixel, and a ripple below Nyquist is not fine
     detail — it is moiré. The measured result was a dense vertical interference
     pattern that darkened every box by about a third and pulled the tints
     magenta through the chromatic-aberration taps, with the corner castings and
     posts lost inside it. There is no LOD chain out here to switch to, and the
     crease pass already smooth-shades the wave (the ramp is inside 32 degrees),
     so there is nothing left to prefilter it with. 620 mm holds about two pixels
     at that range and resolves cleanly closer in, which is where a container's
     corrugation is meant to read at all: 2.2x real instead of 4.2x, against a
     depth that is 1.25x real instead of 7.2x. */
  const PITCH = 0.62, amp = 0.045;
  // one period is two steps of 2e/n, so n = 4e/pitch
  const n = Math.max(6, Math.round((2 * e) / PITCH) * 2);

  /* Trapezoidal, not sawtooth. A triangle wave has no flat anywhere on it, so
     a raking key slides continuously from one crest to the next and the flank
     reads as a rippled sheet rather than as a ribbed one — which at 1:1 is
     indistinguishable from a normal map, and was read as exactly that. A real
     profile has a wide crest, a short ramp and a narrow valley, and it is the
     *flat* that makes the highlight break: the crest holds one value across its
     whole width and then falls off a hard edge, which is the only thing that
     says the rib is geometry. One extra point per crest buys it. */
  const wall = (sy) => {
    const out = [];
    const q = (e / n) * 0.55;                    // half the crest flat
    for (let i = 0; i <= n; i++) {
      const x = (-e + (i / n) * 2 * e) * sy;
      const y = sy * (W / 2 - (i % 2) * amp);
      if (i % 2) { out.push([x, y]); continue; } // valley: a single point
      out.push([x - q * sy, y], [x + q * sy, y]);
    }
    return out;
  };
  const plan = [[-L / 2, -W / 2], ...wall(-1).reverse(), [L / 2, -W / 2],
    [L / 2, W / 2], ...wall(1).reverse(), [-L / 2, W / 2]];
  {
    // No outline chamfer: a 160 mm bevel offsets the plan inward by four times
    // the rib depth and swallows the corrugation whole. The edges of a real
    // container are its rails and castings, and those are separate geometry
    // below.
    const g = panel(plan, type === 'open' ? H * 0.86 : H, 0);
    g.rotateX(-Math.PI / 2);                     // extrude up rather than across
    body.push(g);
  }

  /* ---- the frame.
     A container is not a corrugated box, it is a *frame* with corrugated sheet
     welded into it: four corner posts, a top and bottom rail down each flank,
     and eight corner castings. Only half of that was here — a top rail and the
     four top castings — so seen from the side, which is how a stack on a
     freighter is always seen, the box had no edge, no bottom and nothing at its
     corners. It is also what makes a stack read as a stack: two boxes touching
     along a bare painted seam is one box in two colours, and two boxes with a
     casting, a twistlock and a rail between them is freight. */
  for (const sz of [-1, 1]) {
    hard.push(place(bar(0.62, 0.62, L - post).rotateY(Math.PI / 2), { pos: [0, H / 2, sz * W / 2] }));
    // the bottom rail, which is the one a fork or a twistlock actually meets
    hard.push(place(bar(0.78, 0.72, L - post).rotateY(Math.PI / 2), { pos: [0, -H / 2 + 0.05, sz * (W / 2 - 0.03)] }));
    for (const sx of [-1, 1]) {
      // corner castings, all eight — the top four carry the cones
      for (const sy of [1, -1]) {
        hard.push(place(bar(post * 1.5, 1.0, 1.0), {
          pos: [sx * (L / 2 - post * 0.6), sy * (H / 2 - 0.4), sz * (W / 2 - 0.4)],
        }));
      }
      hard.push(place(latheZ([[0, 0], [0.34, 0], [0.36, 0.18], [0, 0.3]], 7), {
        pos: [sx * (L / 2 - post * 0.6), H / 2 + 0.15, sz * (W / 2 - 0.4)], rot: [-Math.PI / 2, 0, 0],
      }));
      // and the corner post between the two castings, standing proud of the
      // sheet: the vertical the eye uses to count boxes in a stack
      hard.push(place(bar(post * 1.6, 0.86, H - 1.5).rotateX(Math.PI / 2), {
        pos: [sx * (L / 2 - post * 0.5), 0, sz * (W / 2 - 0.10)],
      }));
    }
  }
  for (const sy of [-1, 1]) {
    hard.push(place(bar(0.55, 0.55, W - 0.4).rotateX(Math.PI / 2), { pos: [-L / 2 + post * 0.5, sy * H / 2, 0] }));
  }
  /* Roof bows. The corrugation runs vertically, so the roof is the one face
     with nothing on it — and from above, which is where a stacked container is
     usually seen from, it was the largest flat surface on the ship. */
  if (type !== 'open') {
    for (let i = 0; i < 3; i++) {
      hard.push(place(bar(0.44, 0.40, W - 0.5).rotateX(Math.PI / 2), {
        pos: [(-1 + i) * (L * 0.27), H / 2 + 0.02, 0],
      }));
    }
  }

  /* ---- the door end.  Two leaves, four locking bars with cam handles, and
     the hinge knuckles they turn in. This is the end that tells you which way
     round the thing is, and it is the whole difference between a container and
     a crate. */
  const dx = L / 2 + 0.12;
  const rect = (w, h, d, b) => panel([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], d, b);
  for (const sz of [-1, 1]) {
    body.push(place(rect(W / 2 - 0.5, H - 1.1, 0.30, 0.09), {
      pos: [dx, 0, sz * (W / 4 - 0.05)], rot: [0, Math.PI / 2, 0],
    }));
  }
  const knuckle = latheZ([[0, 0], [0.29, 0], [0.24, 0.46], [0, 0.50]], 6);
  for (let i = 0; i < 4; i++) {
    const z = (-1.5 + i) * (W / 4.6);
    hard.push(place(new THREE.CylinderGeometry(0.14, 0.14, H - 1.4, 6, 1, true), { pos: [dx + 0.30, 0, z] }));
    hard.push(place(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 5, 1, true).rotateX(Math.PI / 2), { pos: [dx + 0.5, H * 0.16, z] }));
    for (const sy of [-1, 1]) {
      hard.push(place(knuckle.clone(), { pos: [dx + 0.30, sy * (H / 2 - 0.75), z], rot: [-Math.PI / 2 * sy, 0, 0] }));
    }
  }
  for (const sz of [-1, 1]) {
    for (const sy of [-1, 1]) {
      hard.push(place(knuckle.clone(), {
        pos: [dx + 0.16, sy * (H / 2 - 1.4), sz * (W / 2 - 0.35)], rot: [Math.PI / 2, 0, 0],
      }));
    }
  }
  knuckle.dispose();
  // the placard, and a vent grille on the opposite end
  hard.push(place(rect(W * 0.30, H * 0.16, 0.16, 0.04), { pos: [dx + 0.35, -H * 0.22, W * 0.22], rot: [0, Math.PI / 2, 0] }));
  for (let i = 0; i < 2; i++) {
    hard.push(place(bar(0.30, W * 0.42, 0.5).rotateX(Math.PI / 2), { pos: [-L / 2 - 0.2, H * 0.22 - i * 0.6, 0] }));
  }

  if (type === 'open') {
    /* An open top with a tarp over it, sagging between its ropes. One lofted
       arch and five straps, and it is the part of a stack that says the cargo
       is not all the same thing. */
    const sec = [];
    for (let k = 0; k <= 7; k++) {
      const u = -1 + (k / 7) * 2;
      sec.push([u * (W / 2 - 0.1), H * 0.43 + (1 - u * u) * 1.5]);
    }
    sec.push([W / 2 - 0.1, H * 0.36], [-(W / 2 - 0.1), H * 0.36]);
    const tp = panel(sec, L - post * 2, 0.12);
    tp.rotateY(Math.PI / 2);
    body.push(tp);
    for (let i = 0; i < 5; i++) {
      const x = -L / 2 + post + ((i + 0.5) / 5) * (L - post * 2);
      hard.push(place(new THREE.TorusGeometry(W / 2 + 0.1, 0.10, 4, 11, Math.PI), {
        pos: [x, H * 0.43, 0], rot: [0, Math.PI / 2, 0],
      }));
    }
  } else if (type === 'reefer') {
    /* A refrigerated unit: a plant module bolted to the blind end, with a
       compressor can, a fan grille and its own little lit panel. */
    const px = -L / 2 - 1.5;
    body.push(place(slab(2.6, H * 0.66, W * 0.78, 0.28), { pos: [px, 0, 0], rot: [0, Math.PI / 2, 0] }));
    hard.push(place(latheZ([[0, 0], [1.5, 0], [1.6, 0.5], [1.6, 2.0], [1.2, 2.4], [0, 2.5]], 14), {
      pos: [px - 1.4, H * 0.14, -W * 0.20], rot: [0, -Math.PI / 2, 0],
    }));
    for (let i = 0; i < 4; i++) {
      hard.push(place(bar(0.26, H * 0.42, 0.4).rotateX(Math.PI / 2), { pos: [px - 1.4, -H * 0.10, W * 0.02 + i * 0.55] }));
    }
    hard.push(place(new THREE.TorusGeometry(1.35, 0.16, 5, 18), { pos: [px - 1.5, H * 0.14, -W * 0.20], rot: [0, Math.PI / 2, 0] }));
  }
  return { body, hard };
}

/** Give a placed geometry a flat vertex colour, so a whole stack of containers
    can be many colours and still cost one draw. */
export function tint(geo, col) {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = col.r; a[i * 3 + 1] = col.g; a[i * 3 + 2] = col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

/* ----------------------------------------------------------- small hardware

   The third scale. A drum with plate seams on it and nothing else is a drum;
   what makes it a pressurised module is the tank, the junction box, the
   handrail and the antenna bolted to the outside of it, each one obviously
   the size a person would install. These are scattered on the *surface* rather
   than through the volume, because hardware buried inside a hull is triangles
   nobody will ever see.

   Four fittings, not two primitives. The previous version scattered a box or a
   six-sided tube — the same two silhouettes a hundred times over at a hundred
   sizes, which at any distance close enough to resolve them read as gravel.
   These are *things*: a bottle in a clamp, a junction box with a proud lid and
   conduit off both ends, a pipe elbow with a flange, a lathed stanchion head.
   Each is welded from three or four parts, so the hardware itself has hardware
   on it, which is the whole of what the third scale means. */
function crust(rnd, list, r, z0, z1, n, sizeRange = [2.0, 6.0]) {
  const [lo, hi] = sizeRange;
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const z = z0 + rnd() * (z1 - z0);
    const s = lo + rnd() * (hi - lo);
    const roll = a + (rnd() - 0.5) * 0.5;
    const ca = Math.cos(a), sa = Math.sin(a);
    /* One frame for the whole fitting. After this rotation the part's local
       +Z points radially out of the hull, +Y runs around it and +X along it —
       so (out, round, along) below are the three directions a fitter would
       actually name, and no piece can drift off the surface. */
    const at = (geo, out, round, along) => place(geo, {
      pos: [ca * (r + out) - sa * round, sa * (r + out) + ca * round, z + along],
      rot: [0, Math.PI / 2, roll],
    });
    const kind = i % 4;

    if (kind === 0) {
      // a gas bottle in two clamp bands on a saddle, lying along the hull
      const R0 = s * 0.32, L = s * (1.5 + rnd() * 0.9);
      const g = latheZ([
        [0, -L / 2], [R0 * 0.5, -L / 2], [R0, -L / 2 + R0 * 0.8],
        [R0, L / 2 - R0 * 0.8], [R0 * 0.5, L / 2], [0, L / 2],
      ], 14);
      g.rotateY(Math.PI / 2);                       // axis -> along the hull
      list.push(at(g, R0 * 1.25, 0, 0));
      const cl = new THREE.TorusGeometry(R0 * 1.10, R0 * 0.17, 4, 12);
      cl.rotateY(Math.PI / 2);
      for (const t of [-0.30, 0.30]) {
        list.push(at(cl.clone(), R0 * 1.25, 0, L * t));
        list.push(at(bar(R0 * 0.5, R0 * 2.0, R0 * 1.3), R0 * 0.62, 0, L * t));
      }
      cl.dispose();
    } else if (kind === 1) {
      // junction box: a chamfered case, a proud lid, conduit out of both sides
      const w = s * (0.9 + rnd() * 0.7), h = s * (0.55 + rnd() * 0.5), d = s * 0.62;
      list.push(at(bar(w, h, d, Math.min(w, h) * 0.20), d * 0.5, 0, 0));
      list.push(at(bar(w * 0.70, h * 0.66, d * 0.30, d * 0.08), d * 1.12, 0, 0));
      const cd = new THREE.CylinderGeometry(s * 0.10, s * 0.10, s * 0.7, 8);
      for (const t of [-1, 1]) {
        list.push(at(cd.clone(), d * 0.42, t * (h * 0.5 + s * 0.3), 0));
      }
      cd.dispose();
    } else if (kind === 2) {
      // a pipe run with a flanged joint and an elbow turning off the hull
      const R0 = s * 0.15, L = s * (1.2 + rnd() * 0.9);
      const run = new THREE.CylinderGeometry(R0, R0, L, 11);
      run.rotateX(Math.PI / 2); run.rotateY(Math.PI / 2);
      list.push(at(run, R0 * 1.5, 0, 0));
      const riser = new THREE.CylinderGeometry(R0, R0, L * 0.55, 11);
      riser.rotateX(Math.PI / 2);
      list.push(at(riser, R0 * 1.5 + L * 0.275, 0, L / 2));
      const knee = new THREE.TorusGeometry(R0 * 1.4, R0 * 0.62, 5, 12);
      knee.rotateX(Math.PI / 2);
      list.push(at(knee, R0 * 1.5, 0, L / 2));
      const fl = latheZ([[R0, 0], [R0 * 2.2, 0], [R0 * 2.2, s * 0.09], [R0, s * 0.09]], 12);
      fl.rotateY(Math.PI / 2);
      list.push(at(fl, R0 * 1.5, 0, -L * 0.3));
    } else {
      // a stanchion with a lathed head — an aerial mount, a camera, a sensor
      const R0 = s * 0.13, L = s * (1.2 + rnd() * 1.0);
      list.push(at(latheZ([
        [R0 * 2.4, 0], [R0 * 2.4, s * 0.14], [R0, s * 0.24], [R0, L],
      ], 11), 0, 0, 0));
      list.push(at(latheZ([
        [0, 0], [R0 * 2.6, 0], [R0 * 3.0, s * 0.16], [R0 * 2.2, s * 0.42], [0, s * 0.46],
      ], 12), L, 0, 0));
    }
  }
}

/**
 * A run of handrail along a straight line — two stanchions and a top rail,
 * chunky enough that it is a line rather than a shimmer at distance. It is the
 * cheapest metre stick there is: nobody has to be told how tall a handrail is.
 */
function rail(list, from, to, up, h = 2.4) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1) return;
  const n = Math.max(2, Math.round(len / 9));
  const U = new THREE.Vector3(up[0], up[1], up[2]).normalize();
  const qUp = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), U);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // A stanchion is turned stock with a foot flange, not a stick: it is the
    // smallest *modelled* thing on the station, which is exactly what makes it
    // a metre stick — nobody has to be told how tall a handrail is.
    const st = latheZ([
      [0.62, 0], [0.62, 0.22], [0.30, 0.34], [0.30, h * 0.98], [0.44, h], [0, h],
    ], 7);
    st.applyQuaternion(qUp);
    list.push(place(st, {
      pos: [from[0] + dx * t, from[1] + dy * t, from[2] + dz * t],
    }));
  }
  // top rail and a knee rail below it, both chamfered stock
  const yaw = Math.atan2(dx, dz);
  for (const k of [1.0, 0.56]) {
    list.push(place(bar(0.72, 0.72, len).rotateY(Math.PI / 2), {
      pos: [(from[0] + to[0]) / 2 + up[0] * h * k, (from[1] + to[1]) / 2 + up[1] * h * k,
        (from[2] + to[2]) / 2 + up[2] * h * k],
      rot: [0, yaw - Math.PI / 2, 0],
    }));
  }
}

/**
 * A ladder: two stringers and a run of rungs, climbing +Z, rungs across X.
 * Nothing on a station tells you how big it is faster than a ladder, because
 * a rung is thirty centimetres and everybody already knows that. Returned as
 * loose geometry so the caller can place the whole run wherever it belongs.
 */
function ladder(len, w = 1.4) {
  const out = [];
  for (const s of [-1, 1]) out.push(place(bar(0.32, 0.60, len), { pos: [s * w / 2, 0, 0] }));
  const n = Math.max(2, Math.round(len / 2.1));
  // Open-ended: both ends of a rung are buried in a stringer, so the caps are
  // triangles nobody can ever see. Ten a rung rather than twenty-eight, and
  // there are several hundred rungs on a station.
  const rung = new THREE.CylinderGeometry(0.115, 0.115, w, 5, 1, true);
  rung.rotateZ(Math.PI / 2);
  for (let i = 0; i <= n; i++) {
    out.push(place(rung.clone(), { pos: [0, 0, -len / 2 + (i / n) * len] }));
  }
  rung.dispose();
  return out;
}

/**
 * @param {number} seed
 * @param {object} o  dead — build it as a corpse: no light, no paint, a bite
 *                    taken out of the wheel and half the array gone.
 */
export function buildStation(seed, o = {}) {
  const dead = !!o.dead;
  const rnd = mulberry32(seed >>> 0);
  const root = new THREE.Group();

  const wear = dead ? 1.0 : 0.38 + rnd() * 0.22;
  const palR = palette({ hue: 0, wear, plate: 3.0, livery: dead ? 0 : 1 });
  const palH = palette({ hue: 0, wear, plate: 4.2, livery: dead ? 0 : 1 });
  const palM = palette({ hue: rnd() < 0.5 ? 1 : 2, wear: Math.min(1, wear + 0.25), plate: 2.3 });
  const RING_R = 196 + rnd() * 56;      // metres
  const RING_W = 42;
  ringDetail(palR.paint, RING_R, dead);
  coreDetail(palH.paint, dead);
  const haz = hazardMat(dead);
  /* Stencil paint. It was 0x24211e — 1.5% reflectance, which is darker than
     anything that has ever been painted on a hull and reads as a hole rather
     than as a marking. Chalked black enamel on a sun-facing surface measures
     five or six times that, and the number matters here because these glyphs
     are the only human-made *marks* on the object: at 1.5% they vanish into
     the shadow side entirely and the registry stops being legible at all. */
  const stencilMat = dress(new THREE.MeshStandardMaterial({
    color: dead ? 0x46423c : 0x3a352e, metalness: 0.10, roughness: 0.80, envMapIntensity: 0.6,
  }), { plate: 1.0, bleach: 0.35, soot: 0.6 });
  /* One material for every container on the station, tinted per box off a
     vertex channel. `<color_fragment>` runs after `<map_fragment>`, so the
     plating law, the weathering and the soot all happen first and the tint
     modulates the result — which is what keeps a pale blue container reading
     as a *painted, chalked, sooted* pale blue rather than as flat colour. */
  const cargoMat = dress(new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, metalness: 0.05,
    roughness: 0.74 + wear * 0.14, envMapIntensity: 0.85,
  }), { plate: 1.6, bleach: 0.5 + wear * 0.35, soot: wear * 0.7, brushed: 0.3, edge: 0.30 });

  /* ---- off black ---------------------------------------------------------
     The dark composite is 1.5% reflectance and it is not a small part of this
     model: the keel, every deck, every truss, the spar webs, the raft grillage
     and the solar blankets are all on it. Lit by one raking key with nothing
     but planetshine and nebula to fill the rest, 1.5% resolves as *nothing* —
     which is why a five hundred metre object measured eighty per cent pure
     black and read as a mud lump with stickers on it. The brief's own line is
     that shadows are never black; a material this dark makes that impossible
     however good the fill is. Composite is still the darkest thing on the hull
     at 2.8%, it is still four stops under the paint, and it now has somewhere
     to put a shadow. */
  for (const p of [palR, palH, palM]) {
    p.structure.color.multiplyScalar(1.8);
    /* And the bounce that fills the other side.
       "Shadows are never black — they are filled by planetshine and by the
       nebula" is the first line of the brief, and on this object it was not
       true: the only fill reaching the shadow side is the environment probe,
       and the station was reading it at the same intensity as a thirty metre
       ship whose own hull bounces light back into everything it occludes. A
       five hundred metre structure occludes far more of the sky than it
       returns, so the *measured* fill was a third of what the same paint gets
       on the Seeker. This is the number that decides whether the dark half of
       the wheel is a shadow or a hole. */
    if (dead) continue;      // the corpse's whole read is that it is darker
    for (const k of ['paint', 'structure', 'metal', 'panel', 'accent']) {
      p[k].envMapIntensity *= 1.40;
    }
  }
  if (!dead) {
    haz.envMapIntensity *= 1.40;
    stencilMat.envMapIntensity *= 1.40;
    cargoMat.envMapIntensity *= 1.40;
  }

  if (dead) {
    /* Dead hulls are not white. Sun-bleached paint chalks off, the substrate
       oxidises to nothing, and every module loses three quarters of its value.
       This is the whole reason a derelict reads as a derelict at the distance
       you first see it — before the tear, before the debris, before anything
       else resolves, it is simply *darker than the live one*. Leaving the
       wheel's own paint out of this loop was enough on its own to make a
       corpse look like a going concern. */
    for (const p of [palH, palM, palR]) {
      p.paint.color.multiplyScalar(0.24);
      p.paint.roughness = 0.95;
      p.metal.color.multiplyScalar(0.34);
      p.structure.color.multiplyScalar(0.40);
      p.panel.color.multiplyScalar(0.24);
      p.accent.color.multiplyScalar(0.26);
    }
    haz.color.multiplyScalar(0.32);
    stencilMat.color.multiplyScalar(0.7);
    cargoMat.color.multiplyScalar(0.26);
    cargoMat.roughness = 0.95;
  }

  /* ---- shadows ----------------------------------------------------------
     Nothing on this model cast or received one, and that is most of why five
     hundred metres of structure read as a pile of parts floating in front of
     each other. The spokes cross the rim, the gantry crosses the containers,
     the tank farm occludes the keel, the docking arms cross the drum — and not
     one of those crossings put a mark on the thing behind it. Self-occlusion
     *is* the volume; without it a hull is a collection of separately-lit decals
     that happen to overlap.

     Everything opaque casts. The four exceptions are deliberate:

       numerals   painted glyphs half a metre thick, lying flat on the plate
                  they are painted on. What they would cast is a shadow the
                  thickness of the paint, which is depth-buffer noise rather
                  than structure — so they receive and do not cast;
       windows    additive quads with no opacity. A depth pass writes the whole
                  rectangle, and every lit room ends up inside its own shadow;
       beacons    the vertex stage blows a unit quad up from `aCenter`, so the
                  depth pass would draw seventy two-metre squares at the origin;
       cones      the flood shafts. They are light, not matter.

     Cost is one depth draw per welded mesh — ten for the whole station — and
     the hulls are frustum-culled at the bottom of this function, so a station
     off the back of the lens costs nothing at all. */
  const shade = (m, cast = true) => {
    if (m) { m.castShadow = cast; m.receiveShadow = true; }
    return m;
  };

  /* One list per material. Everything is modelled in metres and baked into
     object space by `place`, so a hundred parts collapse into one draw and the
     plate seams run continuously across every joint. */
  const P = [];     // palH.paint      pressure hulls, the painted bulk
  const P2 = [];    // palM.paint      the second livery: modules that differ
  const S = [];     // palH.structure  dark composite: keel, decks, backing
  const T = [];     // palH.metal      worked alloy: frames, rails, hardware
  const H = [];     // haz             hazard striping
  const D = [];     // stencilMat      painted numerals
  const RD = [];    // palH.panel      ceramic radiator faces
  const TR = [];    // palH.trim       polished rings — the one hard highlight
  const CG = [];    // cargoMat        freight, tinted per container
  const EM = [];    // strip           emissive edge lighting
  const panes = [], paneLit = [], paneSeed = [];        // fixed to the hull
  const wpanes = [], wpaneLit = [], wpaneSeed = [];     // turning with the wheel
  const bHull = [], bRing = [];                          // beacons
  const cones = [];

  const pushPane = (arr, lit, sd, g, on, bright) => {
    arr.push(g); lit.push(on ? bright : 0); sd.push(rnd());
  };
  /** A running light. Nothing burns on a corpse. */
  const bcn = (list, pos, hex, gain, px, size, mode) => {
    if (dead) return;
    list.push({ pos, hex, gain: gain * LAMP_GAIN, px: (px ?? 2.6) * 1.35, size: size ?? 1.4, mode: mode ?? 0 });
  };
  /** A cold-white flood: housing into the metal list, lens into the beacons. */
  const lamp = (pos, size, gain) => {
    T.push(place(slab(size * 2.0, size * 2.0, size * 1.1, size * 0.2), { pos }));
    bcn(bHull, pos, 0xcfe4ff, gain ?? 8.0, 3.2, size * 0.8);
  };
  /** A shaft of light: apex at pos, pointing along dir, len metres. */
  const flood = (pos, dir, len, rad) => {
    if (dead) return;
    const c = new THREE.ConeGeometry(rad, len, 30, 1, true);
    c.translate(0, -len / 2, 0);                 // apex at the origin, opening -Y
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, -1, 0), new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());
    c.applyQuaternion(q);
    c.translate(pos[0], pos[1], pos[2]);
    cones.push(c);
  };
  /** A drum: pressure hull along Z, with its ring frames and end rings. */
  const drum = (list, r, z0, z1, seg = 24, frames = 0) => {
    // A revolve with a chamfered break at each cap rather than a raw cylinder:
    // the break is what gives the key a highlight line where the drum meets its
    // end, and a knife edge gives it nothing.
    list.push(place(hullTube(r, z0, z1, seg, Math.min(2.6, r * 0.10))));
    for (let i = 0; i <= frames; i++) {
      const z = z0 + (z1 - z0) * (i / Math.max(1, frames));
      T.push(place(new THREE.TorusGeometry(r + 0.5, 1.5, 7, Math.max(20, seg)), { pos: [0, 0, z] }));
    }
    // a ladder and a cable tray up the flank of every drum: the small end of
    // the scale ladder, on the largest surfaces the station has
    const L = Math.min(z1 - z0 - 6, 46);
    if (L > 8) {
      for (const gg of ladder(L, 1.3)) {
        T.push(place(gg, { pos: [Math.cos(1.05) * (r + 0.9), Math.sin(1.05) * (r + 0.9), (z0 + z1) / 2], rot: [0, 0, 1.05] }));
      }
      for (let k = 0; k < 2; k++) {
        T.push(place(new THREE.CylinderGeometry(0.34 + k * 0.10, 0.34 + k * 0.10, (z1 - z0) * 0.9, 8)
          .rotateX(Math.PI / 2), {
          pos: [Math.cos(-2.1 + k * 0.06) * (r + 0.7), Math.sin(-2.1 + k * 0.06) * (r + 0.7), (z0 + z1) / 2],
        }));
      }
    }
  };
  /** A row of ports around a drum, at radius r, z, count n.
   *
   * Each one is a pane at the bottom of a *collar* — a head, a sill and two
   * jambs standing a metre and a half proud of the glass — rather than a lit
   * rectangle laid on the skin. That matters more than anything the shader can
   * do: the key in this game rakes, so a real reveal drops a hard shadow across
   * the top of every pane and puts a bright line down one jamb, which is the
   * whole difference between a window and a sticker. Sixteen triangles a bar
   * and four bars a port, so a hundred-odd ports cost about seven thousand.
   *
   * The frame runs in the same (out, round, along) frame `crust` uses: after
   * the placement rotation the part's +Z points radially out of the hull, +Y
   * runs around it and +X along it.
   */
  const ports = (r, z, n, w, h, cx, cy, lit) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      const ca = Math.cos(a), sa = Math.sin(a);
      const g = paneGeo(w, h, cx, cy);
      g.rotateY(Math.PI / 2); g.rotateZ(a);
      g.translate(ca * r, sa * r, z);
      pushPane(panes, paneLit, paneSeed, g, rnd() < lit, 0.45 + rnd() * 0.85);
      const at = (geo, out, round, along) => place(geo, {
        pos: [ca * (r + out) - sa * round, sa * (r + out) + ca * round, z + along],
        rot: [0, Math.PI / 2, a],
      });
      const t = 0.52, d = 1.45;
      for (const s of [-1, 1]) {
        // head and sill: run along the station's axis, across the pane's width
        T.push(at(bar(d, t, w + t * 2).rotateY(Math.PI / 2), d * 0.5 - 0.1, s * (h / 2 + t * 0.5), 0));
        // jambs: run around the hull, up the pane's height
        T.push(at(bar(t, d, h + t * 2).rotateX(Math.PI / 2), d * 0.5 - 0.1, 0, s * (w / 2 + t * 0.5)));
      }
    }
  };

  const REG = String(100 + Math.floor(rnd() * 800));

  /* ==== the wheel ========================================================
     Spin gravity. A torus is the one silhouette that is instantly readable as
     "people live here" and it is also, conveniently, a perfect circle — which
     is the strongest possible contrast against the ship's angular hull.

     Built in its own frame, ring in XZ and axis +Y, because that is the frame
     `Structures.js` writes its fracture plan in and that file is not mine to
     change. A pivot then stands the whole assembly up so the ring turns about
     the *spine* — see the note at the top of the file. The corpse keeps the
     old attitude: every rib, peel and vent the derelict bolts on afterwards is
     placed in root coordinates using the wheel's own circle, and tilting the
     wheel out from under them would leave the damage hanging in space. */
  const wheelPivot = new THREE.Group();
  const wheel = new THREE.Group();
  wheelPivot.add(wheel);
  if (!dead) wheelPivot.rotation.x = Math.PI / 2;   // local +Y -> station +Z
  // Where the hull failed. A live station has no tear; a derelict is missing
  // this arc, and the debris and the exposed frames go in exactly here.
  const tearAt = rnd() * Math.PI * 2;
  const tearSpan = dead ? 0.62 + rnd() * 0.55 : -1;
  const inTear = (a) => {
    if (!dead) return false;
    let d = ((a - tearAt) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    return d < tearSpan;
  };
  {
    const W = [], WM = [], WS = [], WT = [];
    /* Ceramic, on its own material. The rim's radiator leaves were going into
       the ring's *paint* list, which means the section-colour law in
       `ringDetail` painted them oxide — three of the largest, flattest plates
       on the wheel came out as bright orange card, the most saturated thing in
       any frame of the station. A radiator is the roughest surface in the kit
       and belongs nowhere near the livery. */
    const WRD = [];
    const HW = RING_W / 2;
    /* A partial ring for the corpse. Skipping the *modules* over the tear was
       never enough — the pressure hull itself was still a continuous unbroken
       ring behind them, so the damage read as "some huts are missing" instead
       of "this thing came apart".

       The section is a lathe rather than a torus. A doughnut is a shape that
       was extruded; a box section with a chamfer, a raised spine box on each
       face and a stepped promenade wall is a shape that was *built*, and it
       costs the same triangles. Lathe phi runs from +Z and the rest of this
       file measures angle from +X, so phi = pi/2 - a. */
    const arc = dead ? Math.PI * 2 - tearSpan : Math.PI * 2;
    const phi0 = Math.PI / 2 - tearAt;
    const lathe = (pts, seg) => new THREE.LatheGeometry(
      pts.map((p) => new THREE.Vector2(p[0], p[1])), seg, dead ? phi0 : 0, arc);

    const R = RING_R;
    const LSEG = Math.max(10, Math.round(150 * arc / (Math.PI * 2)));

    /* The pressure section, and the one change that matters most on it: the
       promenade glazing is now *recessed*. The band steps three metres back
       behind a modelled lip, top and bottom, so the raking key that this game
       is entirely made of finds a real edge and lays a shadow across the glass
       instead of sliding over a flush painted stripe. */
    WS.push(place(lathe([
      [R + 20, -HW], [R + 24, -HW + 7], [R + 24, HW - 7], [R + 20, HW],   // outer wall
      [R + 7, HW], [R + 7, HW + 5], [R - 7, HW + 5], [R - 7, HW],         // dorsal deck + spine box
      [R - 20, HW], [R - 25, HW - 8],                                     // promenade wall
      [R - 25, HW - 10.4], [R - 22, HW - 11.8],                           // header lip + reveal
      [R - 22, -HW + 11.8], [R - 25, -HW + 10.4],                         // recess back + sill
      [R - 25, -HW + 8], [R - 20, -HW],
      [R - 7, -HW], [R - 7, -HW - 5], [R + 7, -HW - 5], [R + 7, -HW],     // ventral deck
      [R + 20, -HW],
    ], LSEG)));

    // rubbing strakes, top and bottom of the outer wall
    for (const y of [-HW + 3.4, HW - 3.4]) {
      WT.push(place(lathe([[R + 24.2, y - 1.4], [R + 25.8, y], [R + 24.2, y + 1.4]],
        Math.max(10, Math.round(120 * arc / (Math.PI * 2))))));
    }

    /* A run of pipe around the outer face, standing off it on clamps. This is
       the cheapest structure on the model and it does more work than anything
       else: a raking key catches a hard bright line down the top of a pipe and
       drops a shadow off it onto the wall behind, which is exactly the read a
       flush painted band can never produce. Built as a lathe rather than a
       torus so the corpse's tear takes a bite out of it too. */
    const pipeRun = (rp, y, rt, seg) => {
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        const t = (k / 8) * Math.PI * 2;
        pts.push([rp + Math.cos(t) * rt, y + Math.sin(t) * rt]);
      }
      return lathe(pts, seg);
    };
    const PSEG = Math.max(12, Math.round(96 * arc / (Math.PI * 2)));
    for (const [rp, y, rt] of [[R + 26.6, -HW + 4.6, 1.05], [R + 26.6, -HW + 7.2, 0.72],
      [R + 26.2, HW - 5.0, 0.90]]) {
      WT.push(place(pipeRun(rp, y, rt, PSEG)));
      // clamps, so the run is bolted to something rather than floating
      for (let k = 0; k < 22; k++) {
        const ca = (k / 22) * Math.PI * 2;
        if (inTear(ca)) continue;
        WT.push(place(bar(2.4, rt * 3.4, 3.4), {
          pos: [Math.cos(ca) * (R + 24.4), y, Math.sin(ca) * (R + 24.4)],
          rot: [0, Math.PI / 2 - ca, 0],
        }));
      }
    }

    /* ---- the promenade frame ---------------------------------------------
       A mullion between every window bay, on a sill and a header that run the
       whole circumference. The shader already breaks each pane into rooms; what
       it cannot do is put a piece of aluminium in front of the glass, and a
       continuous band of light with no structure holding it in reads as a
       painted stripe however finely it is subdivided. */
    const strip = 88;
    for (const y of [-2.4, 5.6]) {
      WT.push(place(pipeRun(R - 23.4, y, 0.85, Math.max(12, Math.round(strip * arc / (Math.PI * 2))))));
    }
    for (let i = 0; i < strip; i++) {
      const a = (i / strip) * Math.PI * 2;
      if (inTear(a)) continue;
      // the mullion: a chamfered bar standing proud of the glass
      WT.push(place(bar(1.5, 9.6, 2.8, undefined, true), {
        pos: [Math.cos(a) * (R - 23.6), 1.6, Math.sin(a) * (R - 23.6)],
        rot: [0, Math.PI / 2 - a, 0],
      }));
      const rr = R - 22.4;
      const g = paneGeo(13.0, 6.6, 5, 2);
      g.rotateY(-Math.PI / 2 - a);
      g.translate(Math.cos(a) * rr, 1.6, Math.sin(a) * rr);
      pushPane(wpanes, wpaneLit, wpaneSeed, g, rnd() < 0.86, 0.3 + rnd() * 0.55);
      /* A window is a quad, and a quad three hundred metres away is a third of
         a pixel — which is not a dim window, it is no window. Every third bay
         therefore also carries a distance-locked lamp in the room's own colour,
         so the promenade still reads as *occupied* from the range the station
         is first seen at. It costs no draw: they merge into the ring's beacons. */
      if (i % 3 === 0) {
        bcn(bRing, [Math.cos(a) * (R - 23.0), 1.6, Math.sin(a) * (R - 23.0)],
          rnd() < 0.24 ? 0xffcf92 : 0xbcd8ff, 3.4, 1.9, 0.9);
      }
    }

    /* ==== the rim, module by module =======================================
       Twenty-four bays and five kinds of thing to put in one. The previous
       wheel put the *same* trapezoid in all twenty-four and let the fragment
       shader carry the second and third scales of detail, which meant that at
       a raking angle — the only angle this game lights anything from — there
       was nothing for the key to break on but paint. What follows is built:
       lofted hab blocks with real crowns, a docking collar every fifth bay,
       radiator stacks and tankage standing off the outer face, and an open
       machinery bay whose gaps are what stop the rim reading as one extrusion.

       Local frame after `onRing`: +X runs around the ring, +Y along its axis,
       +Z radially out. Every part below is authored in that frame. */
    const onRing = (geo, a, rr, y) => place(geo, {
      pos: [Math.cos(a) * rr, y, Math.sin(a) * rr], rot: [0, Math.PI / 2 - a, 0],
    });
    /* A section given as (radial, axial) and extruded *around* the ring. This
       is the whole difference between a module and a box: a lofted section has
       a crown, a shoulder and a chamfer, and every one of them is an edge. */
    const loft = (sec, len, bev = 0.7) => {
      const g = panel(sec, len, bev);
      g.rotateY(-Math.PI / 2);
      return g;
    };
    const WALL = R + 24;              // the outer wall a rim module stands on

    const TYPES = ['hab', 'mach', 'dock', 'hab', 'rad', 'tank', 'hab', 'dock',
      'mach', 'hab', 'rad', 'hab', 'dock', 'hab', 'mach', 'tank',
      'hab', 'dock', 'rad', 'hab', 'mach', 'hab', 'dock', 'hab'];
    const NB = TYPES.length;

    for (let i = 0; i < NB; i++) {
      const a = (i / NB) * Math.PI * 2;
      if (inTear(a)) continue;
      const type = TYPES[i];
      const yo = ((i % 2) ? 1 : -1) * (HW * 0.36) + (rnd() - 0.5) * 3.5;
      const bodyList = (i % 3 === 1) ? WM : W;

      if (type === 'hab') {
        /* A lofted pressure module: a wide shoulder on the wall, a step in,
           and a raised crown down the middle carrying the glazing. */
        const d0 = 12.0 + rnd() * 4.0;
        const w0 = 22.0 + rnd() * 7.0;
        const w1 = w0 * (0.52 + rnd() * 0.14);
        const cr = 3.2 + rnd() * 1.4;
        const len = 26 + rnd() * 13;
        bodyList.push(onRing(loft([
          [0, -w0 / 2], [d0 - 3.4, -w0 / 2], [d0, -w0 / 2 + 3.4],
          [d0, -w1 / 2], [d0 + cr, -w1 / 2 + 1.5],
          [d0 + cr, w1 / 2 - 1.5], [d0, w1 / 2],
          [d0, w0 / 2 - 3.4], [d0 - 3.4, w0 / 2], [0, w0 / 2],
        ], len, 0.8), a, WALL, yo));
        // roof ribs across the crown, and a lathed hatch at one end
        for (let k = -1; k <= 1; k++) {
          WT.push(onRing(bar(2.2, w1 + 2.0, 1.5), a + k * (len * 0.30) / R, WALL + d0 + cr, yo));
        }
        WT.push(onRing(latheZ([
          [0, 0], [2.6, 0], [3.0, 0.7], [2.4, 2.0], [0, 2.3],
        ], 14), a + (len * 0.34) / R, WALL + d0 + cr, yo + w1 * 0.22));
        // a conduit down the flank, into the wall
        WT.push(onRing(new THREE.CylinderGeometry(0.7, 0.7, d0 + cr, 10)
          .rotateX(Math.PI / 2), a - (len * 0.40) / R, WALL + (d0 + cr) / 2, yo - w0 * 0.42));
        // windows on the crown, two runs of them
        for (let k = 0; k < 4; k++) {
          const off = (k - 1.5) * (len * 0.21);
          const rr = WALL + d0 + cr + 0.4;
          for (const dy of [-w1 * 0.24, w1 * 0.24]) {
            const g = paneGeo(len * 0.16, 2.6, 3, 2);
            g.rotateY(Math.PI / 2 - a);
            g.translate(Math.cos(a) * rr - Math.sin(a) * off, yo + dy, Math.sin(a) * rr + Math.cos(a) * off);
            pushPane(wpanes, wpaneLit, wpaneSeed, g, rnd() < 0.62, 0.4 + rnd() * 0.9);
          }
        }
        bcn(bRing, [Math.cos(a) * (WALL + d0 + cr + 2.5), yo + w1 * 0.5 + 1.0,
          Math.sin(a) * (WALL + d0 + cr + 2.5)], 0xcfe0ff, 9.0, 2.4);
      } else if (type === 'dock') {
        /* A docking collar: one revolve, with a bore, a bolted flange, a
           tapered throat and a soft-capture lip. Nothing on it is extruded and
           nothing on it is a rectangle. */
        const prof = [
          [11.0, 0.0], [11.0, 2.4], [9.4, 4.0], [9.4, 10.0], [11.6, 12.2],
          [11.6, 15.0], [8.4, 16.8], [8.4, 19.2], [6.4, 20.2],
          [6.0, 18.4], [6.0, 2.0], [11.0, 0.0],
        ];
        WM.push(onRing(latheZ(prof, 26), a, WALL - 0.6, yo * 0.5));
        // guide vanes and latch lugs — the hardware tier
        for (let k = 0; k < 4; k++) {
          const t = (k / 4) * Math.PI * 2 + Math.PI / 4;
          // authored as (along the collar, out from its axis) and stood up so
          // the blade's plane contains the collar's own axis
          const vg = panel([[0, 9.4], [7.0, 9.7], [8.6, 12.0], [0, 12.4]], 1.2, 0.30);
          vg.rotateY(-Math.PI / 2);
          vg.rotateZ(t);
          WT.push(onRing(vg, a, WALL - 0.6, yo * 0.5));
        }
        for (let k = 0; k < 3; k++) {
          const t = (k / 3) * Math.PI * 2 + 0.4;
          WT.push(onRing(place(latheZ([[0, 0], [1.5, 0], [1.7, 0.8], [1.2, 1.9], [0, 2.1]], 12), {
            pos: [Math.cos(t) * 9.4, Math.sin(t) * 9.4, 12.6],
          }), a, WALL - 0.6, yo * 0.5));
        }
        // the apron ring the collar is bolted through, on the wall itself
        WT.push(onRing(latheZ([[11.0, 0], [14.6, 0], [14.6, 1.4], [11.0, 2.0]], 24),
          a, WALL - 1.4, yo * 0.5));
        // guide lights around the throat, and a strobe over the top
        for (let k = 0; k < 6; k++) {
          const t = (k / 6) * Math.PI * 2 + 0.2;
          bcn(bRing, [Math.cos(a) * (WALL + 19.6) - Math.sin(a) * Math.cos(t) * 7.6,
            yo * 0.5 + Math.sin(t) * 7.6,
            Math.sin(a) * (WALL + 19.6) + Math.cos(a) * Math.cos(t) * 7.6],
          k === 0 ? 0x38ff86 : 0xcfe0ff, 7.5, 2.2, 1.0);
        }
        bcn(bRing, [Math.cos(a) * (WALL + 21.5), yo * 0.5, Math.sin(a) * (WALL + 21.5)],
          0xff4020, 9.0, 2.6, 1.2, 2);
      } else if (type === 'rad') {
        /* Radiators standing off the outer face on their own heat pipes. Three
           leaves at three different cants, so the light finds each of them at a
           different angle and the stack never resolves into one flat slab. */
        for (const sy of [-1, 1]) {
          WT.push(onRing(new THREE.CylinderGeometry(1.15, 1.15, 26, 12).rotateX(Math.PI / 2),
            a, WALL + 13, yo + sy * 7.5));
        }
        WT.push(onRing(bar(3.0, 18.0, 2.6), a, WALL + 25.5, yo));
        for (let k = -1; k <= 1; k++) {
          const cant = k * 0.20 + (rnd() - 0.5) * 0.06;
          const pg = panel([[-13, -21], [13, -21], [15, -18], [15, 18], [13, 21], [-13, 21],
            [-15, 18], [-15, -18]], 1.6, 0.45);
          pg.rotateY(Math.PI / 2);        // plate lies in the radial/axial plane
          pg.rotateX(cant);
          WRD.push(onRing(pg, a + k * 9.5 / R, WALL + 38, yo));
          WT.push(onRing(bar(1.6, 1.6, 15).rotateX(cant), a + k * 9.5 / R, WALL + 30, yo + 8));
          WT.push(onRing(bar(1.6, 1.6, 15).rotateX(cant), a + k * 9.5 / R, WALL + 30, yo - 8));
        }
        bcn(bRing, [Math.cos(a) * (WALL + 58), yo, Math.sin(a) * (WALL + 58)], 0xcfe0ff, 5.5, 2.0);
      } else if (type === 'tank') {
        /* Two bottles in saddles, lying around the rim with a manifold between
           them. A cylinder that is *clamped to something* reads as tankage; the
           same cylinder floating on a wall reads as a mistake. */
        for (const sy of [-1, 1]) {
          const TR = 7.4, TL = 30;
          const tg = latheZ([
            [0, -TL / 2], [TR * 0.5, -TL / 2], [TR, -TL / 2 + TR * 0.7],
            [TR, TL / 2 - TR * 0.7], [TR * 0.5, TL / 2], [0, TL / 2],
          ], 20);
          tg.rotateY(Math.PI / 2);
          WM.push(onRing(tg, a, WALL + TR + 1.6, yo + sy * 9.5));
          for (const t of [-0.3, 0.3]) {
            const cl = new THREE.TorusGeometry(TR + 0.35, 0.6, 6, 20);
            cl.rotateY(Math.PI / 2);
            WT.push(onRing(cl, a + TL * t / R, WALL + TR + 1.6, yo + sy * 9.5));
            WT.push(onRing(bar(2.0, 4.6, 3.6), a + TL * t / R, WALL + 0.8, yo + sy * 9.5));
          }
          WT.push(onRing(latheZ([[TR * 0.5, 0], [TR * 1.05, 0], [TR * 1.05, 1.6], [TR * 0.5, 1.9]], 18)
            .rotateY(Math.PI / 2), a - TL * 0.46 / R, WALL + TR + 1.6, yo + sy * 9.5));
        }
        // the manifold and its valve stack, between the two bottles
        WT.push(onRing(new THREE.CylinderGeometry(1.0, 1.0, 19, 12), a, WALL + 8, yo));
        for (const sy of [-1, 1]) {
          WT.push(onRing(latheZ([[0, 0], [1.9, 0], [2.1, 0.9], [1.4, 2.4], [0, 2.6]], 12),
            a, WALL + 9.0, yo + sy * 4.5));
        }
        bcn(bRing, [Math.cos(a) * (WALL + 18), yo, Math.sin(a) * (WALL + 18)], 0xffb040, 6.0, 2.2, 1.0, 2);
      } else {
        /* An open machinery bay. The gap is the point: a rim with a hole in it
           has a silhouette, and a rim of solid blocks has an outline. */
        const len = 30;
        WS.push(...truss(len, 17, 3, 0.8).map((gg) => {
          gg.rotateY(Math.PI / 2);
          return onRing(gg, a, WALL + 9.5, yo);
        }));
        WT.push(onRing(latheZ([
          [0, -6], [5.4, -6], [6.2, -4.6], [6.2, 4.6], [5.4, 6], [0, 6],
        ], 18).rotateY(Math.PI / 2), a, WALL + 9.5, yo + 5.0));
        WT.push(onRing(new THREE.CylinderGeometry(1.5, 1.5, 13, 12).rotateX(Math.PI / 2),
          a - 6.0 / R, WALL + 7, yo - 5.5));
        WT.push(onRing(bar(3.2, 3.2, 12), a + 8.0 / R, WALL + 7, yo - 5.5));
        for (const sy of [-1, 1]) {
          WT.push(onRing(bar(2.4, 2.4, len * 0.9).rotateY(Math.PI / 2), a, WALL + 19, yo + sy * 8));
        }
        bcn(bRing, [Math.cos(a) * (WALL + 20), yo + 8, Math.sin(a) * (WALL + 20)], 0xffb040, 5.5, 2.2, 1.0, 2);
      }

      /* Glazing on the outer wall in the gap *between* bays. With light only
         on the inside of the wheel, three of every four angles you can approach
         a station from show you a dark object. */
      const ga = a + Math.PI / NB;
      if (!inTear(ga)) {
        for (let k = 0; k < 3; k++) {
          const off = (k - 1) * 9.0;
          const rr = R + 24.8;
          const g = paneGeo(8.0, 4.0, 4, 2);
          g.rotateY(Math.PI / 2 - ga);
          g.translate(Math.cos(ga) * rr - Math.sin(ga) * off, -1.5 + (k % 2) * 6.0,
            Math.sin(ga) * rr + Math.cos(ga) * off);
          pushPane(wpanes, wpaneLit, wpaneSeed, g, rnd() < 0.7, 0.3 + rnd() * 0.7);
        }
      }
    }

    /* And a band of them on each *face* of the ring, which is the elevation
       you see when the wheel is edge-on — precisely the case that used to be
       an unlit bar. */
    for (const fy of [-1, 1]) {
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2 + 0.05;
        if (inTear(a)) continue;
        const rr = R + 13;
        const g = paneGeo(13.0, 5.0, 5, 2);
        g.rotateX(fy > 0 ? -Math.PI / 2 : Math.PI / 2);
        g.rotateY(-a);
        g.translate(Math.cos(a) * rr, fy * (RING_W / 2 + 0.5), Math.sin(a) * rr);
        pushPane(wpanes, wpaneLit, wpaneSeed, g, rnd() < 0.55, 0.25 + rnd() * 0.5);
      }
    }

    /* ---- the bottom of the scale ladder ----------------------------------
       Handrail along the dorsal deck and a ladder up every other bay. These are
       the smallest *modelled* things on the wheel and they are the reason the
       eye can tell a six-hundred-metre wheel from a sixty-metre one: every
       other cue on the model scales with the model, and a rung does not. */
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 0.84) / 8) * Math.PI * 2;
      if (inTear(a0) || inTear(a1)) continue;
      const rr = R + 6.5, yy = HW + 5.2;
      rail(WT, [Math.cos(a0) * rr, yy, Math.sin(a0) * rr],
        [Math.cos(a1) * rr, yy, Math.sin(a1) * rr], [0, 1, 0], 2.2);
      if (i % 2 === 0) {
        // a ladder down the promenade wall, climbing radially inward
        const am = (a0 + a1) / 2;
        for (const gg of ladder(15, 1.3)) {
          gg.rotateX(-Math.PI / 2);
          WT.push(place(gg, {
            pos: [Math.cos(am) * (R - 19.4), HW - 2.5, Math.sin(am) * (R - 19.4)],
            rot: [0, Math.PI / 2 - am, 0],
          }));
        }
      }
    }

    /* Spokes. The old lattice put a hundred sub-pixel tubes across the frame
       and they crawled with aliasing at every distance — geometry thinner than
       a pixel cannot be anti-aliased, it can only be made thicker. Solid spars
       with a few heavy braces read as more structure, not less.

       Six of them, at exact multiples of pi/3: `Structures.js` counts on that
       when it decides which spars are still carrying something. */
    const spokes = 6;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      const r0 = 48, r1 = R - 22;
      const L = r1 - r0;
      /* The spar is a lofted section rather than a plank: a deep web with a
         flange top and bottom and a chamfer on every corner, which is what a
         member carrying a six-hundred-metre wheel would actually be. */
      /* Into the second livery, not the ring's paint. `ringDetail` is written
         in the *torus's* coordinates — distance around the ring for the bays,
         angle around the tube for the staves — and a spoke runs radially
         through all of them: one spar came out bright oxide with a gravel
         texture on it because the per-plate hash was sampling a hundred
         sections along its length. A member that is not part of the ring must
         not carry the ring's surface law. */
      WM.push(onRing(loft([
        [-L / 2, -8.5], [L / 2, -8.5], [L / 2, -6.0], [L / 2 - 2.2, -4.4],
        [L / 2 - 2.2, 4.4], [L / 2, 6.0], [L / 2, 8.5], [-L / 2, 8.5],
        [-L / 2, 6.0], [-L / 2 + 2.2, 4.4], [-L / 2 + 2.2, -4.4], [-L / 2, -6.0],
      ], 12.0, 0.9), a, r0 + L / 2, 0));
      for (let k = -1; k <= 1; k += 2) {
        WT.push(onRing(bar(3.8, 3.8, L * 0.96).rotateY(Math.PI / 2), a, r0 + L / 2, k * 9.6));
      }
      // diagonal bracing between the flanges, alternating hand bay by bay
      for (let b = 0; b < 5; b++) {
        const t = (b + 0.5) / 5;
        WT.push(place(new THREE.CylinderGeometry(1.9, 1.9, 19.5, 12), {
          pos: [Math.cos(a) * (r0 + L * t), 0, Math.sin(a) * (r0 + L * t)],
          rot: [0, 0, (b % 2 ? 1 : -1) * 0.55],
        }));
      }
      /* Where the spoke meets the ring: a lathed airlock trunk with a bolted
         flange and a hatch, not a block. This is the joint a passenger walks
         through and it is worth building. */
      WM.push(onRing(latheZ([
        [13.0, -15], [13.0, -8], [10.6, -5.6], [10.6, 0.4], [12.4, 2.6],
        [12.4, 5.6], [8.8, 7.0], [8.6, 4.6], [8.6, -13], [13.0, -15],
      ], 22), a, R - 25.5, 0));
      WT.push(onRing(latheZ([[8.6, 5.2], [13.6, 5.2], [13.6, 6.8], [8.6, 7.2]], 22), a, R - 25.5, 0));
      for (let k = 0; k < 4; k++) {
        const t = (k / 4) * Math.PI * 2 + 0.5;
        WT.push(onRing(place(latheZ([[0, 0], [1.4, 0], [1.6, 0.7], [1.0, 1.9], [0, 2.1]], 11), {
          pos: [Math.cos(t) * 11.2, Math.sin(t) * 11.2, 6.4],
        }), a, R - 25.5, 0));
      }
      bcn(bRing, [Math.cos(a) * (R - 40), 11, Math.sin(a) * (R - 40)], 0x9ce8ff, 8.0, 2.6, 1.2, 1);
    }
    shade(weld(W, palH.paint, wheel));
    shade(weld(WM, palM.paint, wheel));
    shade(weld(WS, palR.paint, wheel));
    shade(weld(WT, palR.metal, wheel));
    shade(weld(WRD, palR.panel, wheel));
  }
  root.add(wheelPivot);

  /* ==== the core =========================================================
     A keel that runs the length of the station and a stack of pressure hulls
     threaded on it. This is the mass the wheel used to lack: at any camera
     angle something here is occluding something else, which is the only way an
     object reads as solid rather than as a decal. */

  /* The keel. This was a `CylinderGeometry(16, 16, 500, 8)` — a five hundred
     metre *octagonal prism* thirty-two metres across, whose eight facets were
     plainly visible at any range you could read the station from, and the
     single largest modelling failure on the asset. It is now a revolve with a
     stepped section: the section changes where the load does, so the spine
     reads as something that was designed rather than as pipe stock, and six
     longerons run its length to break the barrel up under a raking key. */
  S.push(place(latheZ([
    [0, -226], [13.0, -226], [15.0, -220],
    [15.0, -150], [17.2, -142],
    [17.2, -8], [18.4, 4], [18.4, 96], [17.2, 108],
    [17.2, 190], [15.4, 200],
    [15.4, 268], [13.0, 274], [0, 274],
  ], 30)));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.26;
    T.push(place(bar(2.6, 1.9, 494), {
      pos: [Math.cos(a) * 17.4, Math.sin(a) * 17.4, 24], rot: [0, 0, a + Math.PI / 2],
    }));
  }
  for (let i = 0; i < 14; i++) {
    T.push(place(new THREE.TorusGeometry(17.6, 1.3, 6, 22), { pos: [0, 0, -220 + i * 36] }));
  }
  // a cable run and a ladder down one flank of it, for scale
  for (const zc of [[-190, 60], [40, 90], [180, 70]]) {
    for (const gg of ladder(zc[1], 1.3)) {
      T.push(place(gg, { pos: [0, 18.6, zc[0]], rot: [0, 0, 0] }));
    }
  }
  for (let k = 0; k < 3; k++) {
    T.push(place(new THREE.CylinderGeometry(0.42 + k * 0.12, 0.42 + k * 0.12, 470, 8)
      .rotateX(Math.PI / 2), { pos: [-17.2 - k * 0.35, 3.4 - k * 1.1, 24] }));
  }

  /* ---- hub: the bearing the whole wheel turns on ------------------------
     The race was a torus with twenty-four identical `BoxGeometry(5, 5, 6)`
     around it — the same block twenty-four times at the same size and the same
     attitude, which is the definition of the repeated-part failure. A real
     bearing of this size is a race with bogies on it, and no two adjacent
     bogies do the same job: every third is a *drive* unit with a motor can and
     a pinion, the rest are idlers on a rocker, and the pitch is uneven because
     the drives need clearance. */
  drum(P, 48, -52, 52, 34, 6);
  for (const z of [-54, 54]) {
    const sgn = z > 0 ? 1 : -1;
    TR.push(place(new THREE.TorusGeometry(51, 3.4, 8, 56), { pos: [0, 0, z] }));
    // the race itself: a lathed channel section, not a doughnut
    T.push(place(latheZ([
      [47.2, -3.4], [54.6, -3.4], [54.6, -1.6], [52.2, -0.6],
      [52.2, 0.6], [54.6, 1.6], [54.6, 3.4], [47.2, 3.4],
    ], 56), { pos: [0, 0, z + sgn * 4.2] }));
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + (i % 3 === 0 ? 0.06 : 0) + sgn * 0.09;
      const ca = Math.cos(a), sa = Math.sin(a);
      const at = (geo, out, round, along) => place(geo, {
        pos: [ca * (51 + out) - sa * round, sa * (51 + out) + ca * round, z + along],
        rot: [0, Math.PI / 2, a],
      });
      if (i % 3 === 0) {
        // a drive unit: motor can, gearbox, pinion, and a hazard cap
        T.push(at(latheZ([[0, 0], [3.1, 0], [3.4, 0.9], [3.4, 6.4], [2.9, 7.3], [0, 7.6]], 16)
          .rotateY(Math.PI / 2), 4.2, 0, sgn * 4.0));
        T.push(at(bar(6.2, 5.4, 3.2, 1.0), 2.0, 0, sgn * 4.0));
        T.push(at(new THREE.CylinderGeometry(2.0, 2.0, 1.8, 14).rotateZ(Math.PI / 2), 0.4, 0, sgn * 4.0));
        H.push(at(latheZ([[0, 0], [2.4, 0], [2.6, 0.6], [1.9, 1.9], [0, 2.1]], 12)
          .rotateY(Math.PI / 2), 11.4, 0, sgn * 4.0));
      } else {
        // an idler on a rocker: two rollers and the arm between them
        T.push(at(bar(2.2, 4.4, 5.4), 2.6, 0, sgn * 4.0));
        const rl = new THREE.CylinderGeometry(1.5, 1.5, 2.2, 14);
        rl.rotateZ(Math.PI / 2);
        for (const t of [-1.9, 1.9]) T.push(at(rl.clone(), 0.6, t, sgn * 4.0));
        rl.dispose();
        T.push(at(latheZ([[0, 0], [1.1, 0], [1.2, 0.5], [0.8, 1.4], [0, 1.6]], 10)
          .rotateY(Math.PI / 2), 5.6, 0, sgn * 4.0));
      }
    }
  }
  // a stationary collar outboard of the bearing, so the join reads as a joint
  P2.push(place(new THREE.CylinderGeometry(56, 56, 15, 48), { pos: [0, 0, -61], rot: [Math.PI / 2, 0, 0] }));
  P2.push(place(new THREE.CylinderGeometry(56, 56, 15, 48), { pos: [0, 0, 61], rot: [Math.PI / 2, 0, 0] }));
  ports(48.6, -42, 16, 4.0, 2.4, 2, 1, 0.7);
  ports(48.6, -24, 16, 4.0, 2.4, 2, 1, 0.7);
  ports(48.6, 24, 16, 4.0, 2.4, 2, 1, 0.7);
  ports(48.6, 42, 16, 4.0, 2.4, 2, 1, 0.7);
  crust(rnd, T, 48, -50, 50, 15, [2.2, 6.5]);

  // ---- forward drum: the docking level
  drum(P, 34, -152, -54, 24, 8);
  ports(34.6, -80, 14, 3.6, 2.2, 2, 1, 0.75);
  ports(34.6, -110, 14, 3.6, 2.2, 2, 1, 0.75);
  ports(34.6, -140, 14, 3.6, 2.2, 2, 1, 0.6);
  crust(rnd, T, 34, -150, -56, 16, [1.8, 5.0]);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    T.push(place(slab(96, 2.6, 3.4, 0.4), {
      pos: [Math.cos(a) * 35.6, Math.sin(a) * 35.6, -103], rot: [0, Math.PI / 2, a],
    }));
  }

  /* ---- command tower ----------------------------------------------------
     The one asymmetric mass, and the reason this shape has a front. Stepped
     rather than a single box: a block that steps back twice reads as a
     building, and a building is the only thing in the frame the eye already
     knows the size of. */
  {
    const cz = -184;
    /* It stepped, but every step was a `slab` — a box on a box on a box, and
       three axis-aligned rectangular silhouettes stacked up read as one. What
       a tower actually has is a *raked* front, because the bridge looks down
       the approach and a vertical screen would show the crew their own
       reflection; a brow over the glass; and a back that steps in twice where
       the decks stop. All of that is one lofted profile.

       Authored as (−z, y) and extruded across X, the same frame `hullSide`
       uses in `Fleet.js`: the profile is the *side* elevation of the tower and
       the extrusion is its beam. */
    const towerSide = (h0, rake) => [
      [-30, 8], [30, 8],                              // heel, on the drum
      [34, 16], [34 + rake, h0 - 20],                 // raked front face
      [30 + rake, h0 - 12], [30 + rake, h0 - 5],      // the brow over the glass
      [24, h0], [-16, h0],                            // roof
      [-24, h0 - 9], [-24, 22], [-30, 14],            // stepped back
    ];
    P.push(place(place(panel(towerSide(52, 6), 76, 2.2), { rot: [0, Math.PI / 2, 0] }),
      { pos: [0, 0, cz] }));
    /* The penthouse is offset to port and shorter to starboard: a symmetric cap
       on a symmetric block is the toy read, and the whole job of this mass is
       to give the station a front *and* a handedness. */
    P2.push(place(place(panel([
      [-14, 0], [22, 0], [24, 7], [22, 15], [-12, 15], [-16, 9],
    ], 46, 1.4), { rot: [0, Math.PI / 2, 0] }), { pos: [-6, 52, cz - 2] }));
    S.push(place(place(panel([
      [-40, -4], [42, -4], [44, 2], [40, 6], [-38, 6], [-42, 1],
    ], 20, 1.0), { rot: [0, Math.PI / 2, 0] }), { pos: [0, 12, cz - 22] }));
    /* Ring frames up the flanks and mullions between the bridge lights. This is
       the second scale: without it seventy-six metres of tower flank is one
       unbroken painted face however good the profile is. */
    for (const s of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        T.push(place(bar(2.4, 46, 1.6, 0.5), {
          pos: [s * 38.6, 30, cz - 22 + k * 16], rot: [0, 0, 0],
        }));
      }
      T.push(place(bar(3.0, 3.0, 78).rotateY(Math.PI / 2), { pos: [0, 51.4, cz + s * 21] }));
    }
    for (let k = -3; k <= 3; k++) {
      T.push(place(bar(1.3, 8.6, 2.2, 0.35, true), { pos: [k * 8.8, 40, cz - 35.4] }));
    }
    // the brow itself, standing proud of the glass so the key lays a shadow on it
    T.push(place(bar(56, 2.6, 5.0, 0.7, true), { pos: [0, 45.6, cz - 34.0], rot: [-0.34, 0, 0] }));
    // a stair tower and its landings, up the back where the profile steps in
    for (const gg of ladder(40, 1.4)) {
      T.push(place(gg, { pos: [22, 30, cz + 26.6], rot: [Math.PI / 2, 0, 0] }));
    }
    for (let k = 0; k < 3; k++) {
      T.push(place(bar(9.0, 1.2, 5.0, 0.3), { pos: [22, 14 + k * 13, cz + 25.0] }));
    }
    // bridge glazing: one long uninterrupted band of glass facing forward
    {
      const g = paneGeo(52, 6.0, 16, 1);
      g.rotateX(0.34);
      g.translate(0, 40, cz - 34.6);
      pushPane(panes, paneLit, paneSeed, g, true, 1.2);
    }
    // deck lights down the raked face, following the rake back as they descend
    for (let i = 0; i < 12; i++) {
      const row = Math.floor(i / 6);
      const g = paneGeo(5.0, 2.8, 2, 1);
      g.rotateX(0.34);
      g.translate(-24 + (i % 6) * 9.4, 25 + row * 7.4, cz - 33.0 + row * 1.4);
      pushPane(panes, paneLit, paneSeed, g, rnd() < 0.85, 0.6 + rnd() * 1.2);
    }
    // flanks, so the tower is lit from more than one side
    for (const s of [-1, 1]) {
      for (let i = 0; i < 8; i++) {
        const g = paneGeo(5.4, 3.2, 2, 1);
        g.rotateY(s * Math.PI / 2);
        g.translate(s * 38.2, 24 + (i % 2) * 12, cz - 18 + Math.floor(i / 2) * 13);
        pushPane(panes, paneLit, paneSeed, g, rnd() < 0.8, 0.5 + rnd());
      }
    }
    // registry on the flank, where the block is flat and faces the traffic
    for (const s of [1, -1]) {
      const tg = stencil(REG, 15, 0.6);
      D.push(...tg.geo.map((gg) => place(gg, {
        rot: [0, s * Math.PI / 2, 0], pos: [s * 38.6, 20, cz + s * tg.width / 2 - s * 6],
      })));
    }
    lamp([-32, 17, cz - 32.6], 2.6);
    lamp([32, 17, cz - 32.6], 2.6);
    /* Sensor dome and the mast farm. The dome sits on a lathed pedestal with a
       bolted flange rather than half-buried in the roof: a hemisphere sunk into
       a plane has no join, and the join is the whole reason it reads as an
       instrument bolted on rather than as a bubble in the paint. */
    T.push(place(latheZ([[0, 0], [13.6, 0], [14.2, 1.6], [12.4, 3.4], [0, 3.8]], 24),
      { pos: [-6, 67, cz - 2], rot: [-Math.PI / 2, 0, 0] }));
    P2.push(place(new THREE.SphereGeometry(12, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), { pos: [-6, 69, cz - 2] }));
    for (const s of [1, -1]) {
      T.push(place(latheZ([[1.5, 0], [1.5, 3], [0.9, 6], [0.9, 54], [0.5, 60]], 10),
        { pos: [s * 26, 66, cz + 6], rot: [-Math.PI / 2, 0, s * 0.22] }));
      bcn(bHull, [s * 30, 122, cz + 6], 0xffffff, 14.0, 3.0, 1.2, 1);
      T.push(place(new THREE.CylinderGeometry(0.9, 0.9, 24, 10), { pos: [s * 30, 58, cz - 20], rot: [0.6, 0, s * 0.4] }));
    }
    // a dish on a real yoke, off-axis, because a perfectly symmetric top is a toy
    P2.push(place(new THREE.SphereGeometry(16, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), {
      pos: [40, 62, cz + 22], rot: [-0.9, 0.6, 0],
    }));
    T.push(place(latheZ([[0, 0], [3.4, 0], [3.6, 1.4], [1.2, 2.6], [1.2, 22], [1.9, 24]], 14),
      { pos: [40, 40, cz + 22], rot: [-Math.PI / 2 + 0.4, 0, 0.3] }));
    for (const s of [1, -1]) {
      T.push(place(bar(1.1, 1.1, 13), { pos: [40 + s * 4.2, 56, cz + 22], rot: [0.4, 0, 0.3 + s * 0.3] }));
    }
    rail(T, [-34, 53, cz - 26], [30, 53, cz - 26], [0, 1, 0], 2.6);
    rail(T, [-34, 53, cz + 22], [30, 53, cz + 22], [0, 1, 0], 2.6);
  }

  // nose: the approach mast, out in front of everything
  S.push(...truss(90, 12, 4, 1.6).map((g) => place(g, { pos: [0, 0, -200] })));
  P2.push(place(new THREE.CylinderGeometry(13, 9, 22, 24), { pos: [0, 0, -256], rot: [Math.PI / 2, 0, 0] }));
  H.push(place(new THREE.TorusGeometry(13.5, 2.0, 6, 18), { pos: [0, 0, -246] }));
  bcn(bHull, [0, 0, -270], 0xffffff, 16.0, 3.4, 1.4, 1);

  /* ---- docking arms -----------------------------------------------------
     Three arms with open berths, at the docking level. An *empty* berth is as
     good as a full one: it says the traffic that fills it is elsewhere right
     now. One of them is not empty, because the fastest way to say how big a
     thing is, is to park something next to it that the player already knows
     the size of — their own hull is 30 m long, and so is the tug in berth 3. */
  const berths = [];
  const arms = 3;
  const armZ = -122;
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + 0.55;
    const ca = Math.cos(a), sa = Math.sin(a);
    // a derelict has lost one arm outboard of the first berth
    const cut = dead && i === 1;
    const armLen = cut ? 70 : 148;
    /* The spar. This was `slab(148, 15, 15)` — a hundred and fifty metres of
       constant square section with one chamfer down each corner and nothing
       else on it for its whole length, and because an arm crosses most frames
       corner to corner it was the loudest remaining rectangle on the station.

       A cantilever carrying a berth is deep at the root and shallow at the tip,
       and it *swells* under each cradle because that is where the load comes
       on. Seven stations buy all of that, and the section is chamfered the
       whole way round rather than only in plan. The arm is also rolled a few
       degrees per arm so no two present the same face. */
    const roll = (i - 1) * 0.13;
    const armSec = [
      [0.00, 9.6, 10.4], [0.05, 9.0, 9.6],
      [0.36, 7.8, 8.0], [0.42, 9.0, 8.8], [0.50, 7.4, 7.4],
      [0.80, 6.4, 6.6], [0.86, 7.6, 7.4],
      [0.96, 5.2, 5.4], [1.00, 4.4, 4.6],
    ];
    const armGeo = spar(armLen, armSec, 1.1);
    armGeo.rotateX(roll);
    S.push(place(armGeo, {
      pos: [ca * (armLen / 2 + 34), sa * (armLen / 2 + 34), armZ], rot: [0, 0, a],
    }));
    /* Second scale: transverse frames every fifteen-odd metres, which is the
       only detail on a member this long still legible at four radii. Third
       scale: the capping rail, a conduit down the flank and a ladder along the
       top — a rung is thirty centimetres and everybody already knows that. */
    {
      const fr = [], atArm = (g) => place(g, {
        pos: [ca * (armLen / 2 + 34), sa * (armLen / 2 + 34), armZ], rot: [0, 0, a],
      });
      sparFrames(fr, armLen, cut ? 5 : 9, armSec, 1.3);
      fr.push(place(ibeam(4.6, 3.4, armLen * 0.94).rotateY(Math.PI / 2), { pos: [0, 0, 9.4] }));
      sparRun(fr, armLen, 0.62, [-8.6, -3.4], cut ? 4 : 8);
      sparRun(fr, armLen, 0.44, [-8.6, -5.0], cut ? 4 : 8);
      for (const gg of ladder(Math.min(armLen * 0.62, 84), 1.3)) {
        fr.push(place(gg, { pos: [0, 6.2, 10.0], rot: [0, Math.PI / 2, 0] }));
      }
      for (const g of fr) { g.rotateX(roll); T.push(atArm(g)); }
    }
    // hazard collar where the arm leaves the hull
    H.push(place(latheZ([
      [10.0, -6], [13.6, -6], [14.4, -4.2], [14.4, 4.2], [13.6, 6], [10.0, 6],
    ], 22).rotateY(Math.PI / 2), { pos: [ca * 38, sa * 38, armZ], rot: [0, 0, a] }));
    for (let k = 0; k < 2; k++) {
      if (cut && k === 1) continue;
      const t = 0.42 + k * 0.44;
      const bx = ca * (34 + armLen * t), by = sa * (34 + armLen * t);
      // berth cradle
      T.push(place(new THREE.TorusGeometry(17, 2.1, 6, 22, Math.PI * 1.35), {
        pos: [bx, by, armZ], rot: [Math.PI / 2, 0, a],
      }));
      P2.push(place(slab(11, 4.0, 30, 0.6), { pos: [bx - sa * 17, by + ca * 17, armZ], rot: [0, 0, a] }));
      // the gantry that reaches the hatch: a walkway, and it has a handrail
      S.push(place(slab(9, 3.0, 26, 0.6), { pos: [bx + sa * 15, by - ca * 15, armZ], rot: [0, 0, a] }));
      rail(T, [bx + sa * 15 - ca * 4, by - ca * 15 - sa * 4, armZ - 13],
        [bx + sa * 15 - ca * 4, by - ca * 15 - sa * 4, armZ + 13], [-sa, ca, 0], 2.4);
      // berth floods, pointing into the cradle
      lamp([bx - sa * 20 - ca * 6, by + ca * 20 - sa * 6, armZ - 15], 2.6);
      lamp([bx - sa * 20 - ca * 6, by + ca * 20 - sa * 6, armZ + 15], 2.6);
      flood([bx - sa * 19, by + ca * 19, armZ - 15], [sa, -ca, -0.14], 70, 18);
      flood([bx - sa * 19, by + ca * 19, armZ + 15], [sa, -ca, 0.14], 70, 18);
      // berth number, painted on the cradle apron
      for (const gg of stencil(String(i * 2 + k + 1), 10, 0.4).geo) {
        D.push(place(gg, { pos: [bx - 4, by - 30, armZ - 15.4] }));
      }
      berths.push(new THREE.Vector3(bx * M, by * M, armZ * M));

      /* The tug. Thirty metres, parked nose-in at one berth, and welded into
         the same lists as everything else so it costs no draw of its own. */
      if (!dead && i === 2 && k === 1) {
        const tx = bx + sa * 30, ty = by - ca * 30;
        const yaw = a - Math.PI / 2;
        P2.push(place(slab(13, 9, 30, 1.2), { pos: [tx, ty, armZ], rot: [0, 0, yaw + Math.PI / 2] }));
        P.push(place(slab(9, 7, 9, 1.0), { pos: [tx - sa * 12, ty + ca * 12, armZ], rot: [0, 0, yaw + Math.PI / 2] }));
        for (const s of [-1, 1]) {
          T.push(place(new THREE.CylinderGeometry(3.0, 3.4, 12, 16), {
            pos: [tx + sa * 13 + ca * s * 7, ty - ca * 13 + sa * s * 7, armZ], rot: [0, 0, a],
          }));
        }
        S.push(place(slab(20, 1.6, 6, 0.4), { pos: [tx + sa * 6, ty - ca * 6, armZ + 8], rot: [0, 0, yaw] }));
        {
          const g = paneGeo(6.0, 2.6, 3, 1);
          g.rotateY(Math.PI / 2); g.rotateZ(a + Math.PI);
          g.translate(tx - sa * 15.4, ty + ca * 15.4, armZ + 1.5);
          pushPane(panes, paneLit, paneSeed, g, true, 1.0);
        }
        bcn(bHull, [tx + ca * 8, ty + sa * 8, armZ + 6], 0x38ff86, 7.0, 2.2, 1.0);
        bcn(bHull, [tx - ca * 8, ty - sa * 8, armZ + 6], 0xff3418, 7.0, 2.2, 1.0);
        bcn(bHull, [tx, ty, armZ - 8], 0xffffff, 10.0, 2.6, 1.0, 1);
      }
    }
    // arm-tip navigation lights
    const tx = ca * (34 + armLen), ty = sa * (34 + armLen);
    P2.push(place(slab(11, 11, 13, 1.2), { pos: [tx, ty, armZ] }));
    bcn(bHull, [tx, ty, armZ + 10], ca > 0 ? 0x38ff86 : 0xff3418, 10.0, 2.8);
    bcn(bHull, [tx, ty, armZ - 10], 0xffffff, 12.0, 3.0, 1.2, 1);
  }

  /* ---- tank farm --------------------------------------------------------
     Six pressure vessels in a hexagon about the keel. They are the largest
     self-occluding mass on the model — from any angle, three of them are in
     front of the other three, which is what "volume" actually looks like — and
     nobody needs to be told what a row of tanks with hazard collars is for. */
  {
    /* Five, not six, and phased so the gap faces starboard: the hangar is a
       hundred metres wide and has to reach the keel past them. */
    const z0 = 62, z1 = 158, zc = (z0 + z1) / 2, TR0 = 62, NT = 5;
    for (let i = 0; i < NT; i++) {
      const a = Math.PI / NT + (i / NT) * Math.PI * 2;
      const px = Math.cos(a) * TR0, py = Math.sin(a) * TR0;
      /* No two of these are the same vessel. Five identical bottles at five
         identical clock angles is the repeated-part failure in its purest
         form; a real farm has the big one, the pair, and the small one that
         was added later, and the fittings on each face a different way. */
      const TRAD = 17 - (i % 3) * 1.7;
      const TL = 62 + (i % 2 ? 0 : 9);
      const clock = a + 0.9 + i * 1.31;              // where this tank's fittings sit
      const cc = Math.cos(clock), sc = Math.sin(clock);
      (i % 2 ? P2 : P).push(place(vessel(TRAD, TL, 30), { pos: [px, py, zc] }));
      /* Hardware, in the vessel's own frame: +Z out of the shell, +Y around it,
         +X along it — the three directions a fitter would name. This is the
         whole third scale, and without it a seventeen metre bottle is a smooth
         chalk-white surface filling a third of the frame with nothing on it. */
      const on = (geo, out, round, along) => place(geo, {
        pos: [px + cc * (TRAD + out) - sc * round, py + sc * (TRAD + out) + cc * round, zc + along],
        rot: [0, Math.PI / 2, clock],
      });
      for (const z of [-TL / 2 + 4, TL / 2 - 4]) {
        H.push(place(new THREE.TorusGeometry(TRAD + 0.6, 2.4, 7, 26), { pos: [px, py, zc + z] }));
      }
      // the girth weld, and the two stiffening bands either side of it
      T.push(place(new THREE.TorusGeometry(TRAD + 0.25, 0.85, 6, 26), { pos: [px, py, zc] }));
      for (const z of [-TL * 0.24, TL * 0.24]) {
        T.push(place(new THREE.TorusGeometry(TRAD + 0.4, 1.3, 6, 26), { pos: [px, py, zc + z] }));
      }
      // a bolted manway with a davit, the one fitting that gives a person's size
      T.push(on(latheZ([[0, 0], [3.4, 0], [3.6, 0.9], [2.9, 2.0], [0, 2.3]], 16), 0, 0, TL * 0.18));
      T.push(on(new THREE.TorusGeometry(3.5, 0.28, 5, 18).rotateY(Math.PI / 2), 0.9, 0, TL * 0.18));
      // a valve stack and its relief line, and the fill point at the far end
      T.push(on(latheZ([[0, 0], [1.5, 0], [1.6, 0.7], [1.1, 3.4], [1.9, 3.9], [0, 4.2]], 12), 0, 3.0, -TL * 0.20));
      T.push(on(new THREE.CylinderGeometry(0.55, 0.55, TL * 0.44, 10).rotateY(Math.PI / 2), 1.5, 3.0, -TL * 0.42));
      T.push(on(bar(2.4, 3.2, 2.6, 0.5), 1.0, 3.0, -TL * 0.64));
      // a ladder up the flank, and a walkway rail along the crown
      for (const gg of ladder(TL * 0.62, 1.3)) {
        T.push(on(gg.rotateY(Math.PI / 2), 0.9, -5.2, 0));
      }
      rail(T, [px + cc * (TRAD + 2.4) - sc * 5.0, py + sc * (TRAD + 2.4) + cc * 5.0, zc - TL * 0.34],
        [px + cc * (TRAD + 2.4) - sc * 5.0, py + sc * (TRAD + 2.4) + cc * 5.0, zc + TL * 0.34],
        [cc, sc, 0], 2.2);
      // the transfer line, run along the tank's shoulder where a pipe would be
      T.push(place(new THREE.CylinderGeometry(2.2, 2.2, 104, 14), {
        pos: [Math.cos(a + 0.24) * (TR0 + 12), Math.sin(a + 0.24) * (TR0 + 12), zc], rot: [Math.PI / 2, 0, 0],
      }));
      for (const z of [-38, 0, 38]) {
        T.push(place(new THREE.TorusGeometry(2.5, 0.55, 5, 16), {
          pos: [Math.cos(a + 0.24) * (TR0 + 12), Math.sin(a + 0.24) * (TR0 + 12), zc + z],
        }));
      }
      /* Cradles back to the keel. These were three copies of `slab(52, 7, 10)`
         at the same size and attitude under every tank — fifteen identical
         planks. A saddle is deep where it takes the load and thin where it
         reaches the keel, and the middle one carries more than the ends. */
      for (let k = 0; k < 3; k++) {
        const z = [z0 + 8, zc, z1 - 8][k];
        const d = k === 1 ? 1.0 : 0.78;
        S.push(place(spar(52, [
          [0.00, 5.4 * d, 3.2 * d], [0.14, 4.4 * d, 4.4 * d],
          [0.55, 3.2 * d, 5.6 * d], [0.86, 4.6 * d, 6.4 * d], [1.00, 6.2 * d, 5.0 * d],
        ], 0.6), { pos: [Math.cos(a) * 38, Math.sin(a) * 38, z], rot: [0, 0, a] }));
        T.push(place(bar(2.0, 12.0 * d, 2.0, 0.4), {
          pos: [Math.cos(a) * 58, Math.sin(a) * 58, z], rot: [0, Math.PI / 2, a],
        }));
      }
      // a painted tank number, big, on the outboard face
      if (i % 2 === 0) {
        const tg = stencil(String(i + 1), 15, 0.5);
        D.push(...tg.geo.map((gg) => place(gg, {
          rot: [0, Math.PI / 2, a - 0.30],
          pos: [Math.cos(a - 0.30) * (TR0 + TRAD - 0.9), Math.sin(a - 0.30) * (TR0 + TRAD - 0.9), zc - 7],
        })));
      }
      bcn(bHull, [Math.cos(a) * (TR0 + TRAD + 4), Math.sin(a) * (TR0 + TRAD + 4), z1 + 4], 0xcfe0ff, 6.5, 2.2, 1.2);
      // cross-brace to the next tank, so the farm is one bolted assembly
      const b = Math.PI / NT + ((i + 1) / NT) * Math.PI * 2;
      const mx0 = (Math.cos(a) + Math.cos(b)) * 0.5 * TR0, my0 = (Math.sin(a) + Math.sin(b)) * 0.5 * TR0;
      const seg = 2 * TR0 * Math.sin(Math.PI / NT);
      for (const z of [z0 + 4, z1 - 4]) {
        T.push(place(slab(seg, 3.4, 4.4, 0.5), {
          pos: [mx0, my0, z], rot: [0, 0, Math.atan2(Math.sin(b) - Math.sin(a), Math.cos(b) - Math.cos(a))],
        }));
      }
    }
  }

  /* ---- the docking bay --------------------------------------------------
     A hangar hung off the starboard side, with a mouth a ship fits through and
     an open deck behind it. A station that has nowhere for a ship to go is a
     sculpture — and light coming out of a hole in a hull is the single most
     legible thing you can put on one. */
  const BX = 134, BY = -4, BZ = 100;      // bay centre
  const IX = 46, IY = 29, IZ = 46;        // inner half extents
  {
    const t = 7;
    const HL = IX * 2 + t * 2;                 // the hall's length along +X
    const oz = IZ + t, oy = IY + t;
    /* ---- the hall, as one lofted shell.
       This was five slabs laid round a void — a plain box with flat greeble
       plates on it, and the loudest remaining failure on the station after the
       ring. A hall is a *section*: a wall thickness carried all the way round,
       mitred at every corner, with a raised roof spine and a stepped floor
       tucked under the deck. It is one part, it is chamfered everywhere, and it
       costs a seventh of the triangles the five boxes did. */
    const hullOut = [
      [-oz + 7, -oy], [oz - 7, -oy], [oz, -oy + 7],
      [oz, oy - 12], [oz - 9, oy], [13, oy], [10, oy + 8], [-10, oy + 8],
      [-13, oy], [-oz + 9, oy], [-oz, oy - 12], [-oz, -oy + 7],
    ];
    const hullIn = [
      [-IZ + 5, -IY], [IZ - 5, -IY], [IZ, -IY + 5], [IZ, IY - 5], [IZ - 5, IY],
      [9, IY], [7, IY + 6], [-7, IY + 6], [-9, IY],
      [-IZ + 5, IY], [-IZ, IY - 5], [-IZ, -IY + 5],
    ];
    {
      const g = shell(hullOut, hullIn, HL, 1.3);
      g.rotateY(Math.PI / 2);
      P.push(place(g, { pos: [BX, BY, BZ] }));
      // the back bulkhead closes it, with its own stepped face
      S.push(place(place(panel(hullOut, 5.0, 1.0), { rot: [0, Math.PI / 2, 0] }),
        { pos: [BX - IX - t + 2.0, BY, BZ] }));
    }
    /* Transverse ring frames standing off the shell — the same section, a
       little larger, three metres wide. Real structure, and the thing a raking
       key breaks on all the way down the flank. */
    for (let i = 0; i < 6; i++) {
      const fx = BX - IX - t + 9 + i * 17.5;
      const grow = (p, k) => p.map(([u, v]) => [u + Math.sign(u) * k, v + Math.sign(v) * k]);
      const g = shell(grow(hullOut, 2.6), hullOut, 3.4, 0.6);
      g.rotateY(Math.PI / 2);
      T.push(place(g, { pos: [fx, BY, BZ] }));
    }
    /* A truss cradle under the hall, carrying it back to the keel. A hundred
       metre pressure vessel hung off a wall on nothing is the read the old
       block had; a cradle is what tells you how it is held on. */
    for (const s of [-1, 1]) {
      S.push(...truss(HL - 8, 11, 5, 0.55).map((gg) => {
        gg.rotateY(Math.PI / 2);
        return place(gg, { pos: [BX, BY - oy - 7, BZ + s * (IZ - 8)] });
      }));
      T.push(place(bar(4.0, 4.0, 40).rotateZ(Math.PI / 2), {
        pos: [BX - IX - t - 16, BY - oy - 3, BZ + s * (IZ - 8)], rot: [0, 0, 0.42 * s],
      }));
    }
    /* ---- the pressurised gallery over the roof.
       A lofted half-round section rather than a flat lid: it is the one part of
       the bay a person is inside, and it is glazed along the mouth end so the
       controllers reading the approach are visible from outside. */
    {
      const gy = BY + oy + 8;
      const gsec = [];
      for (let k = 0; k <= 10; k++) {
        const th = Math.PI * (k / 10);
        gsec.push([Math.cos(th) * 15.0, Math.sin(th) * 9.5]);
      }
      gsec.push([-15.0, -3.0], [15.0, -3.0]);
      const gg = panel(gsec, IZ * 2 - 14, 0.9);
      P2.push(place(gg, { pos: [BX - 8, gy, BZ], rot: [0, Math.PI / 2, 0] }));
      for (let k = 0; k < 5; k++) {
        const gp = paneGeo(9.0, 3.2, 4, 1);
        gp.rotateY(Math.PI / 2);
        gp.translate(BX + 7.4, gy + 3.0, BZ - 32 + k * 16);
        pushPane(panes, paneLit, paneSeed, gp, true, 0.9);
      }
      rail(T, [BX - 30, gy + 9.8, BZ - 26], [BX + 6, gy + 9.8, BZ - 26], [0, 1, 0], 2.0);
      rail(T, [BX - 30, gy + 9.8, BZ + 26], [BX + 6, gy + 9.8, BZ + 26], [0, 1, 0], 2.0);
    }
    /* ---- the mouth.
       One chamfered collar with a real opening in it, hazard-striped: the
       previous mouth was four planks laid round a gap, and there is no way to
       make that read as a hole cut in something. */
    const mx = BX + IX + t + 2;
    H.push(place(frameGeo(IZ * 2 + 26, IY * 2 + 26, IZ * 2 + 2, IY * 2 + 2, 6.0, 1.3), {
      pos: [mx, BY, BZ], rot: [0, Math.PI / 2, 0],
    }));
    T.push(place(frameGeo(IZ * 2 + 34, IY * 2 + 34, IZ * 2 + 24, IY * 2 + 24, 3.0, 1.0), {
      pos: [mx - 4.4, BY, BZ], rot: [0, Math.PI / 2, 0],
    }));
    /* A moving arm on a lathed pivot, folded back against the sill. It is the
       one part of the station that is obviously *machinery* — and an arm that
       could reach a hull is worth more for scale than any amount of plating. */
    {
      const px = mx - 3.0, py = BY + IY + 2, pz = BZ - IZ - 3;
      T.push(place(latheZ([
        [0, -3.6], [4.2, -3.6], [4.6, -2.4], [4.6, 2.4], [4.2, 3.6], [0, 3.6],
      ], 18), { pos: [px, py, pz], rot: [0, Math.PI / 2, 0] }));
      const seg = (L, w0, w1, th) => panel([[0, -w0 / 2], [L, -w1 / 2], [L, w1 / 2], [0, w0 / 2]], th, 0.30);
      const s1 = seg(26, 5.4, 3.6, 3.4);
      s1.rotateY(Math.PI / 2);
      T.push(place(s1, { pos: [px, py, pz], rot: [0, 0, -0.30] }));
      const ex = px + Math.cos(-0.30) * 26, ey = py + Math.sin(-0.30) * 26;
      T.push(place(latheZ([[0, -2.4], [3.0, -2.4], [3.2, -1.4], [3.2, 1.4], [3.0, 2.4], [0, 2.4]], 14),
        { pos: [ex, ey, pz], rot: [0, Math.PI / 2, 0] }));
      const s2 = seg(19, 3.8, 2.8, 2.6);
      s2.rotateY(Math.PI / 2);
      T.push(place(s2, { pos: [ex, ey, pz], rot: [0, 0, 0.52] }));
      const hx = ex + Math.cos(0.52) * 19, hy = ey + Math.sin(0.52) * 19;
      P2.push(place(latheZ([
        [3.4, 0], [5.4, 0], [5.4, 3.2], [4.2, 4.6], [3.2, 4.6], [3.2, 0.8], [3.4, 0],
      ], 18), { pos: [hx, hy, pz], rot: [0, Math.PI / 2 + 0.4, 0] }));
      bcn(bHull, [hx + 3.5, hy, pz], 0xffb040, 6.0, 2.2, 1.0, 2);
    }
    /* Guide lights on stalks around the mouth. A lamp on a post is a different
       thing from a lamp painted on a wall: it stands off, it casts, and it is
       the smallest silhouette on this end of the station. */
    for (let i = -2; i <= 2; i++) {
      for (const sy of [-1, 1]) {
        const stz = BZ + i * 22, sty = BY + sy * (IY + 15);
        T.push(place(latheZ([
          [1.1, 0], [1.1, 0.5], [0.5, 0.9], [0.5, 5.2], [1.0, 5.6], [0, 5.9],
        ], 10), { pos: [mx - 2.0, sty, stz], rot: [0, Math.PI / 2, 0] }));
        bcn(bHull, [mx + 4.2, sty, stz], 0xcfe0ff, 7.0, 2.4, 1.0);
      }
    }
    /* The bay's own light, seen through the mouth. Everything in here is sized
       to a person: deck panels a few metres across, a row of ordinary windows
       along the back bulkhead, painted lane markings. Authored at hangar scale
       instead, the same two quads read as one flat lightbox with nothing in it
       to say how big the hole was. */
    {
      const g = paneGeo(IX * 2 - 10, IZ * 2 - 10, 21, 20);
      g.rotateX(-Math.PI / 2);
      g.translate(BX, BY - IY + 1.4, BZ);
      pushPane(panes, paneLit, paneSeed, g, true, 0.28);
      // the back bulkhead: control room glazing over a run of ordinary ports
      for (let i = 0; i < 9; i++) {
        const b = paneGeo(9.0, 3.4, 4, 2);
        b.rotateY(Math.PI / 2);
        b.translate(BX - IX + 1.4, BY + (i % 3) * 12 - 12, BZ + ((i / 3) | 0) * 26 - 26);
        pushPane(panes, paneLit, paneSeed, b, rnd() < 0.8, 0.5 + rnd() * 0.6);
      }
    }
    /* ---- the apron.
       It was a flat plate with painted stripes on it. An apron is a *built*
       surface: a raised landing pad with a chamfered kerb, a recessed service
       trench either side of it with the deck lighting down in the trench, and
       tie-down points a person could put a strap through. */
    {
      const dy = BY - IY + 1.0;
      // the pad: a lofted plate with a chamfer all the way round
      S.push(place(panel([
        [-30, -18], [30, -18], [34, -14], [34, 14], [30, 18], [-30, 18], [-34, 14], [-34, -14],
      ], 1.8, 0.45), { pos: [BX - 8, dy + 0.9, BZ], rot: [Math.PI / 2, 0, 0] }));
      T.push(place(frameGeo(28, 28, 22, 22, 1.2, 0.35), {
        pos: [BX - 16, dy + 2.0, BZ], rot: [Math.PI / 2, 0, 0],
      }));
      EM.push(place(new THREE.TorusGeometry(13, 0.8, 5, 26), {
        pos: [BX - 16, dy + 2.1, BZ], rot: [Math.PI / 2, 0, 0],
      }));
      // service trenches, kerbed, with the lane lighting down inside them
      for (const s of [-1, 1]) {
        T.push(place(bar(1.9, 1.6, IX * 2 - 18).rotateY(Math.PI / 2), { pos: [BX, dy + 0.8, BZ + s * 21] }));
        T.push(place(bar(1.9, 1.6, IX * 2 - 18).rotateY(Math.PI / 2), { pos: [BX, dy + 0.8, BZ + s * 27] }));
        EM.push(place(slab(IX * 2 - 22, 0.9, 1.2, 0.2), { pos: [BX, dy + 0.4, BZ + s * 24] }));
        // tie-downs down the pad edge
        for (let k = -2; k <= 2; k++) {
          T.push(place(latheZ([[0, 0], [1.05, 0], [1.15, 0.5], [0.7, 1.2], [0, 1.35]], 10), {
            pos: [BX - 8 + k * 13, dy + 1.8, BZ + s * 16], rot: [-Math.PI / 2, 0, 0],
          }));
        }
      }
    }
    /* The gantry crane over the deck: two I-section rails, a travelling bridge
       and a hoist. A crane is the reference's own scale cue and it only works
       if the rail has a section you can read. */
    for (const s of [-1, 1]) {
      T.push(place(ibeam(4.6, 3.2, IX * 2 - 8).rotateY(Math.PI / 2), {
        pos: [BX, BY + IY - 6, BZ + s * (IZ - 5)],
      }));
      T.push(place(bar(2.0, 5.6, IX * 2 - 12).rotateY(Math.PI / 2), {
        pos: [BX, BY + IY - 11, BZ + s * (IZ - 5)],
      }));
    }
    S.push(place(ibeam(5.6, 4.4, IZ * 2 - 10), { pos: [BX + 12, BY + IY - 10, BZ], rot: [0, 0, Math.PI / 2] }));
    T.push(place(bar(3.4, 3.4, 15), { pos: [BX + 12, BY + IY - 20, BZ - 12], rot: [Math.PI / 2, 0, 0] }));
    T.push(place(latheZ([[0, 0], [2.4, 0], [2.6, 1.0], [2.6, 4.4], [1.4, 5.2], [0, 5.4]], 14), {
      pos: [BX + 12, BY + IY - 27, BZ - 12], rot: [Math.PI / 2, 0, 0],
    }));
    for (const s of [-1, 1]) {
      T.push(place(new THREE.CylinderGeometry(0.22, 0.22, 12, 7), {
        pos: [BX + 12 + s * 1.6, BY + IY - 34, BZ - 12],
      }));
    }
    H.push(place(latheZ([[0, 0], [3.0, 0], [3.2, 0.8], [2.3, 2.4], [0, 2.6]], 14), {
      pos: [BX + 12, BY + IY - 15.5, BZ - 12], rot: [-Math.PI / 2, 0, 0],
    }));
    /* A lighter, down on the deck with its ramp out. Twenty-six metres of hull
       standing in front of a lit floor is worth more than any amount of
       greebling: it is the one object in the frame whose size a player already
       knows, and everything else in the bay is measured against it. */
    if (!dead) {
      const sx = BX - 4, sy = BY - IY + 11, sz = BZ + 15;
      P2.push(place(slab(26, 8, 11, 1.2), { pos: [sx, sy, sz] }));
      P.push(place(slab(9, 6, 8, 0.9), { pos: [sx + 15, sy + 1, sz] }));
      S.push(place(slab(15, 1.6, 22, 0.5), { pos: [sx - 3, sy - 3, sz] }));
      for (const s of [-1, 1]) {
        T.push(place(new THREE.CylinderGeometry(2.2, 2.6, 8, 16), { pos: [sx - 13, sy + 1, sz + s * 6], rot: [0, 0, Math.PI / 2] }));
        T.push(place(slab(3.0, 5.0, 3.0, 0.4), { pos: [sx + 2, sy - 6, sz + s * 4] }));
      }
      S.push(place(slab(11, 0.9, 6, 0.3), { pos: [sx + 20, sy - 5, sz], rot: [0, 0, 0.34] }));  // ramp
      {
        const g = paneGeo(6.0, 2.4, 3, 1);
        g.rotateY(Math.PI / 2);
        g.translate(sx + 19.6, sy + 2, sz);
        pushPane(panes, paneLit, paneSeed, g, true, 1.0);
      }
      bcn(bHull, [sx + 19, sy + 5, sz], 0xffffff, 6.0, 2.0, 0.9, 1);
    }
    // deck floods in the roof, and the shafts they throw out of the mouth
    for (const s of [-1, 1]) {
      lamp([BX - IX + 14, BY + IY - 5, BZ + s * (IZ - 12)], 3.0, 11.0);
      lamp([BX + IX - 14, BY + IY - 5, BZ + s * (IZ - 12)], 3.0, 11.0);
      flood([BX + IX - 14, BY + IY - 6, BZ + s * (IZ - 12)], [0.55, -0.75, s * 0.22], 150, 34);
    }
    // mouth markers: green to starboard, red to port
    bcn(bHull, [mx + 4, BY, BZ + IZ + 6], 0x38ff86, 11.0, 3.0);
    bcn(bHull, [mx + 4, BY, BZ - IZ - 6], 0xff3418, 11.0, 3.0);
    /* The mouth, outlined in light. A rectangle of light on a dark hull is the
       most legible thing there is — it says "opening" before the eye has
       resolved anything inside it — and it was a *continuous unbroken bar* of
       it, at a gain that clipped along its whole length and dragged an
       anamorphic streak off both ends. That does not read as a structure. It
       reads as a UI widget drawn over the frame, which is what the review
       called it.

       Marker lights are individual fittings, so this is a run of them: a lamp
       every few metres in its own housing, with dark hull between. The gaps are
       the whole point — a dashed run still says "opening" at three hundred
       metres and says "these are lamps, and here is how big one is" at thirty.
       The housings go into the metal list, so each dash sits in a shadow of its
       own the moment the key rakes across the sill. */
    const markers = (n, ax, ay, az, dx, dy, dz) => {
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        const p = [ax + dx * t, ay + dy * t, az + dz * t];
        EM.push(place(slab(1.15, 1.15, 2.4, 0.26), { pos: p, rot: [0, Math.PI / 2, 0] }));
        T.push(place(bar(2.6, 2.6, 1.5, 0.5), { pos: [p[0] - 1.5, p[1], p[2]], rot: [0, Math.PI / 2, 0] }));
      }
    };
    for (const s of [-1, 1]) {
      markers(9, mx + 5.4, BY, BZ + s * (IZ + 1), 0, IY * 1.85, 0);
      markers(13, mx + 5.4, BY + s * (IY + 1), BZ, 0, 0, IZ * 1.85);
      // and a run of deck lighting down each side wall inside, where a
      // continuous strip is right: it is a cove, and it is seen through a hole.
      EM.push(place(slab(IX * 2 - 12, 1.1, 1.1, 0.25), { pos: [BX - 2, BY + IY - 4, BZ + s * (IZ - 2)] }));
    }
    /* The bay's own number, huge, on the flat outside of each side wall. The
       side walls face along z, so the glyphs keep their own normal and only the
       sign of it flips — rotating them a quarter turn about y put the lettering
       on a plane facing out of the *mouth*, i.e. floating in mid-air across the
       opening, back to front, which is exactly how it looked. */
    for (const s of [1, -1]) {
      const tg = stencil('BAY ' + REG, 15, 0.7);
      D.push(...tg.geo.map((gg) => place(gg, {
        rot: [0, s > 0 ? 0 : Math.PI, 0],
        pos: [BX - s * tg.width / 2 + s * 6, BY - 13, BZ + s * (IZ + t * 2 + 3)],
      })));
    }
    /* Pylons back to the keel, threaded through the gap in the tank farm.
       Three copies of `slab(76, 11, 15)` — the same plank at the same size and
       attitude three times over — is exactly the repeated-part failure, and a
       pylon carrying a hundred-metre hangar off a keel is deep at the keel and
       shallow at the hangar. The middle one takes the most and is the deepest;
       the outer two cant in slightly, so no two present the same face. */
    for (let k = 0; k < 3; k++) {
      const z = BZ + (k - 1) * 34;
      const d = k === 1 ? 1.0 : 0.82;
      const pySec = [
        [0.00, 7.2 * d, 10.4 * d], [0.10, 6.0 * d, 8.8 * d],
        [0.46, 4.6 * d, 6.6 * d], [0.54, 5.6 * d, 6.8 * d],
        [0.90, 4.2 * d, 5.4 * d], [1.00, 5.4 * d, 6.6 * d],
      ];
      const py = spar(76, pySec, 0.9);
      py.rotateY((k - 1) * 0.09);
      S.push(place(py, { pos: [BX - IX - 40, BY + 8, z] }));
      const fr = [];
      sparFrames(fr, 76, 5, pySec, 1.1);
      sparRun(fr, 76, 0.55, [-6.0 * d, 3.4 * d], 5);
      for (const g of fr) { g.rotateY((k - 1) * 0.09); T.push(place(g, { pos: [BX - IX - 40, BY + 8, z] })); }
    }
    // and the diagonals between them, which is what stops three parallel bars
    // reading as three parallel bars
    for (const k of [-1, 1]) {
      T.push(place(bar(3.0, 3.0, 74).rotateY(Math.PI / 2), {
        pos: [BX - IX - 40, BY - 2, BZ + k * 17], rot: [0, 0, 0],
      }));
      T.push(place(bar(2.4, 2.4, 78), { pos: [BX - IX - 40 + k * 20, BY - 2, BZ], rot: [Math.PI / 2, 0.42 * k, 0] }));
    }
    // and hardware over its roof, which is one of the few flat decks up here
    S.push(...greebles(rnd, 12, [BX - 40, BY + IY + t * 2, BZ - 36, BX + 40, BY + IY + t * 2 + 9, BZ + 36], [2.2, 7.0]));

    /* The approach lane. Paired lights marching out from the mouth, the last
       of them three hundred metres off the hull: it says where a ship comes
       in from, and it is the only thing in frame that gives the eye a ruler
       reaching *away* from the structure. */
    for (let i = 0; i < 7; i++) {
      const x = mx + 40 + i * 46;
      const g = 6.5 - i * 0.4;
      bcn(bHull, [x, BY, BZ + IZ + 10 + i * 5], 0x38ff86, g, 2.2, 1.0, 2);
      bcn(bHull, [x, BY, BZ - IZ - 10 - i * 5], 0xff3418, g, 2.2, 1.0, 2);
    }
  }

  /* ---- cargo raft -------------------------------------------------------
     The port side, and deliberately not a mirror of the bay: an open rack of
     containers with two slots empty and a gantry over the top. Containers are
     the best metre stick in the game because everyone already knows roughly
     how big one is. */
  {
    const CX = -118, CZ = 104;
    /* The raft deck. This was one 70 x 116 m slab — the largest flat unbroken
       surface anywhere on the station, and at a raking angle it read as exactly
       that. A deck is a grillage: longitudinals, transverses and a kerb, with
       the plate between them. */
    S.push(place(panel([
      [-35, -58], [35, -58], [39, -53], [39, 53], [35, 58], [-35, 58], [-39, 53], [-39, -53],
    ], 5.0, 0.9), { pos: [CX, -34, CZ], rot: [Math.PI / 2, 0, 0] }));
    for (let i = -2; i <= 2; i++) {
      T.push(place(ibeam(4.2, 3.0, 112), { pos: [CX + i * 17, -30.5, CZ] }));
    }
    for (let i = -2; i <= 2; i++) {
      T.push(place(bar(3.0, 2.4, 74).rotateY(Math.PI / 2), { pos: [CX, -37.5, CZ + i * 26] }));
    }
    for (const sx of [-1, 1]) {
      T.push(place(bar(1.8, 2.6, 114).rotateY(0), { pos: [CX + sx * 37, -30.6, CZ] }));
    }
    // the three arms carrying the raft back to the keel — tapered, and the
    // middle one deeper, for the same reason the bay's pylons are
    for (let k = 0; k < 3; k++) {
      const z = CZ + (k - 1) * 52;
      const d = k === 1 ? 1.0 : 0.80;
      const rfSec = [
        [0.00, 6.4 * d, 4.4 * d], [0.10, 5.2 * d, 5.4 * d],
        [0.52, 3.8 * d, 6.8 * d], [0.60, 4.8 * d, 6.8 * d], [1.00, 4.2 * d, 5.2 * d],
      ];
      S.push(place(spar(84, rfSec, 0.7), { pos: [CX + 52, -28, z] }));
      const fr = [];
      sparFrames(fr, 84, 5, rfSec, 1.0);
      for (const g of fr) T.push(place(g, { pos: [CX + 52, -28, z] }));
    }
    for (const k of [-1, 1]) {
      T.push(place(bar(2.6, 2.6, 96), { pos: [CX + 52 + k * 24, -28, CZ], rot: [Math.PI / 2, 0.50 * k, 0] }));
    }
    /* Real containers, in colour. This rack is the single largest area of the
       station a viewer's eye lands on and it was eighteen identical grey boxes
       — which is most of why the whole asset measured 0.12 saturation against a
       reference yard's 0.34. Every box is now corrugated, hardware-dressed and
       independently tinted out of the game's own palette: bone, cream, slate,
       oxide, rust. One extra draw for the whole rack, because the tint rides on
       a vertex channel rather than on a material. */
    for (let i = 0; i < 18; i++) {
      const col = i % 3, row = (i / 3) | 0;
      if (rnd() < 0.14) continue;                     // two slots out for pickup
      const cx = CX - 20 + col * 20, cz = CZ - 50 + row * 21;
      const stack = 1 + (rnd() < 0.5 ? 1 : 0);
      for (let k = 0; k < stack; k++) {
        const r0 = rnd();
        const type = r0 < 0.13 ? 'open' : r0 < 0.24 ? 'reefer' : 'box';
        // lengths differ, and the odd one sits askew in its slot
        const len = r0 < 0.30 ? 13 : 19;
        const yaw = (k === stack - 1 && rnd() < 0.22) ? (rnd() - 0.5) * 0.22 : 0;
        const c = container(rnd, { len, w: 17, h: 13, type });
        const hue = _lin(CARGO_HUES[Math.floor(rnd() * CARGO_HUES.length)]);
        const pl = { pos: [cx + (rnd() - 0.5) * 1.2, -23 + k * 14, cz], rot: [0, Math.PI / 2 + yaw, 0] };
        for (const gg of c.body) CG.push(tint(place(gg, pl), hue));
        for (const gg of c.hard) T.push(place(gg, pl));
      }
      if (rnd() < 0.42) {
        for (const gg of stencil(String(Math.floor(rnd() * 9)), 6, 0.3).geo) {
          D.push(place(gg, { pos: [cx - 2, -27, cz + 9.8] }));
        }
      }
    }
    /* The gantry: two portals and a travelling bridge. The legs were four
       copies of `slab(6, 44, 6)` — a square post repeated at one size — and a
       crane leg is the one member on a yard whose taper everybody has seen. */
    for (const s of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const leg = spar(44, [
          [0.00, 4.4, 4.6], [0.12, 3.4, 3.6], [0.62, 2.5, 2.8], [1.00, 3.0, 3.4],
        ], 0.5);
        leg.rotateZ(Math.PI / 2);
        T.push(place(leg, { pos: [CX + sx * 26, 0, CZ + s * 52] }));
        for (let k = 0; k < 3; k++) {
          T.push(place(bar(2.0, 2.0, 24), { pos: [CX + sx * 26, -12 + k * 12, CZ + s * 52], rot: [0, 0.5 * ((k % 2) ? 1 : -1) * sx, 0] }));
        }
      }
      // the portal head, with a knee brace into each leg
      T.push(place(ibeam(5.2, 4.2, 58).rotateY(Math.PI / 2), { pos: [CX, 22, CZ + s * 52] }));
      for (const sx of [-1, 1]) {
        T.push(place(bar(2.6, 2.6, 17), { pos: [CX + sx * 20, 16, CZ + s * 52], rot: [0, 0, sx * 0.78] }));
      }
    }
    S.push(place(ibeam(6.0, 5.0, 110), { pos: [CX + 6, 20, CZ] }));
    T.push(place(slab(4, 16, 4, 0.4), { pos: [CX + 6, 8, CZ + 14] }));
    H.push(place(slab(14, 3, 6, 0.4), { pos: [CX + 6, -1, CZ + 14] }));
    rail(T, [CX + 40, -31, CZ - 54], [CX + 40, -31, CZ + 54], [0, 1, 0], 2.4);
    bcn(bHull, [CX - 26, 24, CZ - 52], 0xffb040, 6.0, 2.2, 1.0, 2);
    bcn(bHull, [CX + 26, 24, CZ + 52], 0xffb040, 6.0, 2.2, 1.0, 2);
    for (const z of [CZ - 52, CZ + 52]) lamp([CX, 20, z], 2.4, 7.0);
  }

  /* ---- stern: truss, radiators, arrays ---------------------------------- */
  T.push(...truss(130, 30, 5, 3.0).map((g) => place(g, { pos: [0, 0, 226] })));
  P.push(place(new THREE.CylinderGeometry(24, 20, 40, 30), { pos: [0, 0, 180], rot: [Math.PI / 2, 0, 0] }));

  /* Radiators. Ceramic, nearly Lambertian and the roughest thing in the kit,
     which is exactly why they must not share a number with the paint: a big
     flat plate at a raking angle is the clearest dark side on the model.

     In three segments with gaps and a different cant on each, because one
     continuous 150 m plate is a black rectangle whichever way it faces — it
     has no internal edge for the key to catch and nothing for a star to show
     through. Segments give it both. */
  for (const s of [1, -1]) {
    const yy = s * 92;
    for (let i = -1; i <= 1; i++) {
      const tilt = i * 0.16 * s;
      RD.push(place(slab(44, 72, 2.4, 0.6), { pos: [i * 52, yy, 214], rot: [tilt, 0, s * 0.28] }));
      T.push(place(slab(3.2, 72, 4.4, 0.4), { pos: [i * 52 - 21, yy, 211], rot: [tilt, 0, s * 0.28] }));
      T.push(place(slab(3.2, 72, 4.4, 0.4), { pos: [i * 52 + 21, yy, 211], rot: [tilt, 0, s * 0.28] }));
    }
    /* The header is a *pipe* — it carries the working fluid — so it is turned,
       not extruded, and it has a flanged joint where each leaf taps into it.
       The boom back to the keel is a cantilever carrying seventy metres of
       panel and tapers accordingly. */
    T.push(place(new THREE.CylinderGeometry(2.8, 2.8, 160, 16).rotateZ(Math.PI / 2),
      { pos: [0, yy - s * 34, 211] }));
    for (let i = -2; i <= 2; i++) {
      T.push(place(latheZ([[2.8, 0], [5.2, 0], [5.2, 1.5], [2.8, 2.0]], 16).rotateY(Math.PI / 2),
        { pos: [i * 34, yy - s * 34, 211] }));
      if (i % 2 === 0) {
        T.push(place(new THREE.CylinderGeometry(1.1, 1.1, 26, 12), { pos: [i * 34, yy - s * 21, 211] }));
      }
    }
    {
      const bm = spar(62, [
        [0.00, 6.4, 6.8], [0.10, 5.4, 5.6], [0.55, 4.2, 4.4], [0.94, 5.0, 5.2], [1.00, 6.0, 6.2],
      ], 0.8);
      bm.rotateZ(Math.PI / 2);
      S.push(place(bm, { pos: [0, s * 46, 214] }));
      for (let k = 0; k < 4; k++) {
        T.push(place(bar(11.4, 11.4, 1.4, 0.4), { pos: [0, s * (20 + k * 17), 214] }));
      }
    }
    H.push(place(latheZ([
      [6.0, -7], [9.4, -7], [10.2, -5], [10.2, 5], [9.4, 7], [6.0, 7],
    ], 20).rotateX(Math.PI / 2), { pos: [0, s * 24, 214] }));
    bcn(bHull, [76, yy - s * 34, 211], 0xcfe0ff, 5.0, 2.0, 1.0);
    bcn(bHull, [-76, yy - s * 34, 211], 0xcfe0ff, 5.0, 2.0, 1.0);
  }

  for (const s of [1, -1]) {
    // A derelict's array has folded: one wing gone entirely, the other ragged.
    if (dead && s === -1) continue;
    const leaves = solarWing(180, 46, 5).map((g) => place(g, {
      pos: [0, 0, 262], rot: [0, 0, 0], scale: [s, 1, 1],
    }));
    /* Into the dark composite, not the paint. A photovoltaic blanket is close
       to black with a faint sheen; welded in with the hull paint it came out
       the same bone as the pressure vessels and read as a stack of planks. */
    for (const g of leaves) { if (!(dead && rnd() < 0.32)) S.push(g); else g.dispose(); }
    T.push(place(new THREE.CylinderGeometry(3.4, 3.4, 16, 16), { pos: [s * 14, 0, 262], rot: [0, 0, Math.PI / 2] }));
  }

  // aft cap: manoeuvring quads and the anti-collision strobe
  P2.push(place(new THREE.CylinderGeometry(19, 14, 26, 26), { pos: [0, 0, 292], rot: [Math.PI / 2, 0, 0] }));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.78;
    T.push(place(new THREE.CylinderGeometry(4.4, 5.4, 9, 16), {
      pos: [Math.cos(a) * 15, Math.sin(a) * 15, 306], rot: [Math.PI / 2, 0, 0],
    }));
  }
  bcn(bHull, [0, 0, 312], 0xff3418, 13.0, 3.2, 1.4, 1);

  // and the small hardware everywhere the eye lands. On the *surface* of the
  // keel: hardware scattered through a solid drum is triangles nobody sees.
  crust(rnd, T, 16, 162, 300, 17, [2.2, 7.0]);
  crust(rnd, T, 16, -244, -156, 10, [1.8, 5.0]);

  shade(weld(P, palH.paint, root));
  shade(weld(P2, palM.paint, root));
  shade(weld(S, palH.structure, root));
  shade(weld(T, palH.metal, root));
  shade(weld(H, haz, root));
  shade(weld(D, stencilMat, root), false);      // paint receives, paint does not cast
  shade(weld(RD, palH.panel, root));
  shade(weld(TR, palH.trim, root));
  shade(weld(CG, cargoMat, root));

  /* ---- windows ---------------------------------------------------------
     Two meshes, because the wheel turns and the hull does not. Putting the
     command block's glazing in with the ring's sent the bridge orbiting the
     station once a minute. */
  const winUniforms = {
    uWarm: { value: _lin(0xffcf92) },
    uCold: { value: _lin(0xa8d4ff) },
    /* Down from 8.5, because the room law above now carries a factor of forty
       between its dimmest and brightest cell instead of a factor of four. At
       the old gain the top of that range clipped a dozen stops past white and
       took two thirds of the distribution with it, which is what flattened
       every pane into the same rectangle. */
    uGain: { value: dead ? 0.0 : 6.0 },
    uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3() },
  };
  const winMat = new THREE.ShaderMaterial({
    vertexShader: WINDOW_VERT, fragmentShader: WINDOW_FRAG,
    side: THREE.DoubleSide, toneMapped: false, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
    uniforms: winUniforms,
  });
  /* Dead glass. The panes are still there — you can see there *were* windows —
     but they are mirrors now, catching the key and nothing else. */
  const deadGlass = new THREE.MeshPhysicalMaterial({
    color: 0x05080a, metalness: 0.0, roughness: 0.16, envMapIntensity: 1.4,
    clearcoat: 0.8, clearcoatRoughness: 0.12, side: THREE.DoubleSide,
  });

  const addWindows = (list, lit, sd, parent) => {
    if (!list.length) return null;
    if (dead) {
      // a quarter of them blew out
      const keep = [];
      for (const g of list) { if (rnd() > 0.26) keep.push(g); else g.dispose(); }
      if (!keep.length) return null;
      // Receives, never casts: a pane is glass set into a wall that is already
      // casting, and a depth pass over it would put every window in its own
      // shadow.
      const m = shade(weld(keep, deadGlass, parent), false);
      if (m) m.renderOrder = 2;
      return m;
    }
    const merged = mergeWindows(list, lit, sd);
    const mesh = new THREE.Mesh(merged, winMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.onBeforeRender = (r, s, cam) => {
      winUniforms.uCamPos.value.copy(cam.position);
      winUniforms.uTime.value = performance.now() * 0.001;
    };
    parent.add(mesh);
    return mesh;
  };
  addWindows(wpanes, wpaneLit, wpaneSeed, wheel);
  addWindows(panes, paneLit, paneSeed, root);

  /* ---- lamps and shafts ------------------------------------------------- */
  if (!dead) {
    const bh = makeBeacons(bHull); if (bh) root.add(bh);
    // the ring's own lights ride the ring, or they slide across the modules
    // they are supposed to be bolted to as it turns
    const br = makeBeacons(bRing); if (br) wheel.add(br);
    /* A metre-wide strip covers hundreds of pixels, so it needs a fraction of
       a lamp's radiance to read: at the beacons' gain it clipped to a solid
       white bar and dragged an anamorphic streak across the whole frame. 7.5
       was still doing exactly that at the bay mouth — clipped along its whole
       length, streaked off both ends, and the review read the result as a UI
       widget rather than as a structure. At 4.0 a marker still punches through
       AgX and blooms; it stops being the brightest thing in the frame. */
    weld(EM, emitter(0x9ec8ff, 4.0), root);
    if (cones.length) {
      const cu = {
        uCol: { value: _lin(0xbcd8ff) },
        uCamPos: { value: new THREE.Vector3() },
        uGain: { value: 0.62 },
      };
      const cm = new THREE.ShaderMaterial({
        vertexShader: CONE_VERT, fragmentShader: CONE_FRAG,
        uniforms: cu, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      });
      const mesh = weld(cones, cm, root);
      mesh.renderOrder = 4;
      mesh.onBeforeRender = (r, s, cam) => { cu.uCamPos.value.copy(cam.position); };
    }

    /* ---- the practical -------------------------------------------------
       Emissive geometry in this renderer lights nothing, so the four deck
       floods pointed out of the bay mouth were painted light: bright cones
       falling on a hull that stayed exactly as dark as it was before. The game
       loop parks one real point light on whichever set-piece is nearest and
       reads the spec from here.

         pos        the mouth of the bay, twenty metres proud of the sill, in
                    the model's own metres — the loop applies the root's
                    rotation and the metres-to-world factor itself.
         color      the floods' own white-blue, pulled well toward white: at
                    practical strength a saturated hue stops reading as light
                    and starts reading as a filter over the frame.
         intensity  irradiance at `radius`, not candela. A ship on final sits
                    two to four hundred metres off the sill; 0.50 at 0.62 units
                    puts about a third of the key on its shadow side there,
                    which is a flood you can see working rather than one you
                    have to be told about.
         radius     620 m — the bay, the approach lane, and the space a ship
                    manoeuvres in before it is inside. The loop cuts the light
                    off at five times this. */
    root.userData.practical = {
      pos: new THREE.Vector3(BX + IX + 29, BY, BZ),
      color: new THREE.Color(0.80, 0.87, 1.0),
      intensity: 0.50,
      radius: 0.62,
    };
  } else {
    cones.forEach((g) => g.dispose());
    EM.forEach((g) => g.dispose());
  }

  root.scale.setScalar(M);
  root.traverse((x) => { x.frustumCulled = false; });
  /* ---- except the hulls, which are worth culling.
     A system has two stations and they are hundreds of millions of kilometres
     apart, so at most one of them is ever in frame — and with everything marked
     unculled the renderer was drawing both, every frame, whichever way the
     camera pointed. That is a quarter of a million triangles of vertex work for
     an object off the back of the lens.

     The exceptions stay unculled and have to: a beacon's `position` attribute
     is a unit quad that the vertex stage blows up from `aCenter`, so its
     bounding sphere describes a two-metre box at the model's origin and three
     would cull the running lights the moment the hub left the frame. Anything
     whose vertices mean what they say is safe. */
  for (const m of root.children) {
    if (m.isMesh && m.geometry && m.geometry.attributes.aCenter === undefined) m.frustumCulled = true;
  }
  for (const m of wheel.children) {
    if (m.isMesh && m.geometry && m.geometry.attributes.aCenter === undefined) m.frustumCulled = true;
  }

  /* A station has no reason to be square to the ecliptic, and every reason not
     to be: parked axis-aligned, the wheel's plane lines up with the plane the
     camera orbits in and the whole model reads as a bar. Seeded, so a given
     station always presents the same face. The corpse keeps its own attitude —
     `Structures.js` gives it a tumble of its own. */
  if (!dead) root.rotation.set(0.46 + rnd() * 0.5, rnd() * Math.PI * 2, -0.30 + rnd() * 0.6);

  return {
    root, wheel, berths,
    tear: { at: tearAt, span: tearSpan, r: RING_R, w: RING_W },
    mats: { palH, palM, palR, stencilMat },
    /* The bounding radius the framing helpers work in. Honest rather than
       flattering: the ring is only two thirds of the object, and quoting the
       ring alone parked every posed camera close enough to crop the bow off. */
    radius: (RING_R + 132) * M,
    length: 620 * M,
  };
}

/** Merge the window quads, carrying a per-vertex lit value and pane seed. */
function mergeWindows(geos, lit, seeds) {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const aLit = new Float32Array(n);
  const aSeed = new Float32Array(n);
  const idx = [];
  let vo = 0;
  for (let i = 0; i < geos.length; i++) {
    const g = geos[i];
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    for (let k = 0; k < c; k++) { aLit[vo + k] = lit[i]; aSeed[vo + k] = seeds[i]; }
    const gi = g.index.array;
    for (let k = 0; k < gi.length; k++) idx.push(gi[k] + vo);
    vo += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('aLit', new THREE.BufferAttribute(aLit, 1));
  out.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  out.setIndex(idx);
  return out;
}
