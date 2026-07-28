import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './generate.js';
import { HULL_LIGHT } from '../gfx/greeble.js';
import { LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';

/* ============================================================================
   Asteroid fields.

   Real belts are mostly vacuum, so scattering a few thousand rocks across
   millions of km would show you nothing. Instead we keep a dense local shell
   of instances around the ship and recycle any rock that falls behind — the
   belt reads as thick and dangerous exactly where the player is looking.

   Three things have to be true or a belt reads as a dozen grey lumps in a void:

   **It must be a volume, not a handful of objects.** Boulders alone give you
   separated silhouettes with nothing between them. Under them sits a much
   larger population of chips, and under *that* a mote field — collision
   families clumped into wisps, not white noise — so there is always something
   at every depth and the parallax does the work.

   **The rock has to be rock at arm's length.** One instanced standard material
   carries a procedural surface in the rock's own object space: regolith,
   fracture ridges, impact craters with analytic rims, strata on the big bodies
   and ice or metal veining on a minority. Craters get their normal from the
   Worley cell vector rather than from extra height taps, which is what keeps
   three noise evaluations from turning into thirty.

   **The silhouette has to be broken.** A smooth ellipsoid is a pebble at any
   size, so the geometry is carved by half-space cuts (the flats a fragment
   breaks along) and by real basins that bite into the limb.
   ========================================================================== */

/* --------------------------------------------------------------- geometry */

function rndDir(rnd, v) {
  // rejection-free: uniform on the sphere
  const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return (v || new THREE.Vector3()).set(Math.cos(th) * s, u, Math.sin(th) * s);
}

/**
 * One rock. Icosahedron geometry is non-indexed, so computeVertexNormals would
 * give hard facets on every triangle; welding first yields weathered rock
 * rather than low-poly art. Chips skip the weld on purpose — a shard *should*
 * be all flats.
 */
function rockGeometry(seed, o = {}) {
  const detail = o.detail ?? 2;
  const rnd = mulberry32(seed);
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, detail), 1e-4);
  const pos = g.attributes.position;

  // broad lobes: the mass is never centred
  const lobes = [];
  for (let i = 0; i < 7; i++) {
    lobes.push({ d: rndDir(rnd), a: 0.2 + rnd() * 0.55, w: 0.5 + rnd() * 1.6 });
  }
  // Half-space cuts. A rock is a piece of something bigger and its shape is
  // dominated by the faces it broke along; clamping the radial function against
  // a plane makes the icosphere follow a genuine flat.
  const cuts = [];
  const cn = o.cuts ?? 5;
  for (let i = 0; i < cn; i++) {
    cuts.push({ n: rndDir(rnd), c: (o.cutMin ?? 0.66) + rnd() * (o.cutSpan ?? 0.28) });
  }
  // Impact basins carved into the *silhouette*. A crater you cannot see on the
  // limb is not a crater, it is a texture.
  const craters = [];
  for (let i = 0; i < (o.craters ?? 4); i++) {
    const t = rnd();
    craters.push({ c: rndDir(rnd), w: 0.18 + t * t * 0.72, d: 0.03 + t * 0.11 });
  }

  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r = 1;
    for (const l of lobes) r -= l.a * Math.pow(Math.max(0, v.dot(l.d)), l.w) * 0.5;
    r += (Math.sin(v.x * 9.1 + seed) * Math.cos(v.y * 7.3) * Math.sin(v.z * 11.7)) * 0.07;
    r += (Math.sin(v.x * 22.7 + seed * 1.7) * Math.cos(v.y * 17.3 + seed)
        * Math.sin(v.z * 25.1)) * 0.026;
    for (const c of craters) {
      const ang = Math.acos(Math.min(1, Math.max(-1, v.dot(c.c)))) / c.w;
      if (ang < 1.5) {
        const u = Math.min(ang, 1);
        r -= c.d * (1 - u * u);                                    // bowl
        const e = (ang - 1.04) / 0.22;
        r += c.d * 0.28 * Math.exp(-e * e);                        // raised rim
      }
    }
    for (const p of cuts) {
      const dp = v.dot(p.n);
      if (dp > 1e-3) r = Math.min(r, p.c / dp);
    }
    // Roughen *after* the cuts. A perfectly flat break face reads as a cut gem,
    // and enough of them in a row turn the limb into a regular polygon.
    r *= 1 + (Math.sin(v.x * 14.3 + seed * 2.3) * Math.cos(v.y * 12.1 - seed)
            * Math.sin(v.z * 15.9 + 1.7)) * 0.045;
    v.multiplyScalar(Math.max(0.2, r));
    pos.setXYZ(i, v.x, v.y, v.z);
  }

  const out = o.flat ? g.toNonIndexed() : g;
  if (o.flat) g.dispose();
  out.computeVertexNormals();
  return out;
}

/* --------------------------------------------------------------- surfacing */

// Varyings shared by both stages. Object space is the rock's own frame, which
// is what keeps the surface glued on while the rock tumbles.
const RK_VARY = /* glsl */`
varying vec3  vRkP;
varying vec3  vRkN;
varying vec4  vRk0;    // xyz domain seed, w size class (0 chip .. 1 boulder)
varying vec4  vRk1;    // x ice, y metal, z roughness jitter, w crater density
varying mat3  vRkOV;   // object -> view rotation, instance included
varying float vRkS;    // instance radius in world units
`;

const RK_VERT_PARS = /* glsl */`
attribute vec4 aRock0;
attribute vec4 aRock1;
${RK_VARY}
`;

const RK_VERT = /* glsl */`
  #include <begin_vertex>
  vRkP = position;
  vRkN = normalize(normal);
  vRk0 = aRock0;
  vRk1 = aRock1;
  #ifdef USE_INSTANCING
    vRkOV = normalMatrix * mat3(instanceMatrix);
    vRkS  = length(instanceMatrix[0].xyz);
  #else
    vRkOV = normalMatrix;
    vRkS  = 1.0;
  #endif
`;

/* Value noise rather than simplex: three height taps per fragment is the whole
   budget, and a trilinear hash is a third of the cost for detail this small.
   The ridged variant is the one that reads as fracture. */
const RK_FRAG_PARS = /* glsl */`
${RK_VARY}
uniform vec3  uSunV;
uniform vec3  uSunTint;
uniform float uRimGain;
uniform vec3  uBounce;

float rkAO   = 1.0;      // cavity, written by the surface block
float rkRgV  = 0.0;      // ridge value at the centre tap
float rkRough = 1.0;
float rkMetal = 0.0;
float rkVein  = 0.0;     // ice or metal cover, 0..1

float rkH(vec3 p){
  p = fract(p*0.3183099 + vec3(0.71,0.113,0.419));
  p *= 17.0;
  return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
}
vec3 rkH3(vec3 p){
  p = fract(p*vec3(0.1031,0.1030,0.0973));
  p += dot(p, p.yxz+33.33);
  return fract((p.xxy+p.yxx)*p.zyx);
}
float rkN3(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f*f*(3.0-2.0*f);
  return mix(mix(mix(rkH(i+vec3(0,0,0)), rkH(i+vec3(1,0,0)), f.x),
                 mix(rkH(i+vec3(0,1,0)), rkH(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(rkH(i+vec3(0,0,1)), rkH(i+vec3(1,0,1)), f.x),
                 mix(rkH(i+vec3(0,1,1)), rkH(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float rkFbm(vec3 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<5;i++){
    if(i>=oct) break;
    s += a*rkN3(p); n += a; p = p*2.03 + 11.7; a *= 0.5;
  }
  return s/max(n,1e-4);
}
float rkRidge(vec3 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<4;i++){
    if(i>=oct) break;
    s += a*(1.0 - abs(rkN3(p)*2.0-1.0)); n += a; p = p*2.11 + 3.3; a *= 0.5;
  }
  return s/max(n,1e-4);
}

/* Worley cell that also hands back the vector to the feature point. The
   gradient of the distance field *is* that vector, so a crater gets an exact
   normal from one evaluation instead of three more. */
float rkCell(vec3 p, out vec3 toC, out float cr){
  vec3 ip = floor(p), fp = fract(p);
  float best = 9.0;
  toC = vec3(0.0,0.0,1.0); cr = 0.0;
  for(int z=-1;z<=1;z++)
  for(int y=-1;y<=1;y++)
  for(int x=-1;x<=1;x++){
    vec3 o = vec3(float(x),float(y),float(z));
    vec3 hh = rkH3(ip+o);
    vec3 r = fp - (o + 0.08 + hh*0.84);
    float d = dot(r,r);
    if(d < best){ best = d; toC = r; cr = fract(hh.x*13.7 + hh.z*7.3); }
  }
  return sqrt(max(best,1e-9));
}

/* Regolith plus fracture, in object units of height. Called three times for
   the gradient, so the centre tap goes LAST and leaves its ridge value behind
   for the albedo to reuse. */
float rkFine(vec3 p, float gf, float fw, float amp, int oct){
  float g  = rkFbm(p*gf, oct) - 0.5;
  // The ridge runs *finer* than the grain, not coarser: fracture is the crisp
  // thing on a rock and blurring it is what makes procedural stone read as clay.
  float rg = rkRidge(p*gf*1.15, oct > 3 ? 3 : 2);
  rkRgV = rg;
  return (g*0.9 + (rg - 0.55)*fw*1.15) * amp;
}
`;

/* The surface itself. Everything is written into the globals declared above so
   the roughness, metalness and normal chunks further down can just read them. */
const RK_SURFACE = /* glsl */`
  #include <map_fragment>
  {
    vec3  P   = vRkP;
    vec3  Q   = vRkP + vRk0.xyz;
    float cls = vRk0.w;
    float ice = vRk1.x;
    float met = vRk1.y;

    // Level of detail by apparent size, not by distance: a boulder at 40 units
    // still deserves craters, a chip at 4 does not. Instances are coherent, so
    // these branches cost nothing.
    float dist = max(length(vViewPosition), 1e-4);
    float apx  = vRkS / dist;
    float lod  = smoothstep(0.0016, 0.012, apx);

    vec3 nO = normalize(vRkN);
    vec3 t1 = normalize(cross(nO, abs(nO.y) < 0.9 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));
    vec3 t2 = cross(nO, t1);

    float gf  = mix(14.0, 11.5, cls);       // grain frequency
    float fw  = mix(1.25, 0.68, cls);       // fracture weight: chips are shards
    float amp = mix(0.022, 0.019, cls);     // height in object units

    // The tap has to be well inside the finest wavelength in the field or the
    // top octaves fold into each other and the grain quietly disappears — at
    // gf 14 over four octaves that is a period of about 0.009.
    vec3 grad = vec3(0.0);
    float h1 = 0.0, h2 = 0.0;
    int oct = lod > 0.45 ? 4 : 2;
    float e = lod > 0.45 ? 0.0028 : 0.010;
    if(lod > 0.05){
      h1 = rkFine(Q + t1*e, gf, fw, amp, oct);
      h2 = rkFine(Q + t2*e, gf, fw, amp, oct);
    }
    float h0 = rkFine(Q, gf, fw, amp, oct);
    float rg = rkRgV;
    if(lod > 0.05) grad = ((h1-h0)*t1 + (h2-h0)*t2) / e;

    float broad = rkFbm(Q*1.55 + 5.1, 2);

    // ---- craters, with an analytic rim.
    // The cell grid is a *candidate* list, not a crater each: most cells stay
    // empty and the ones that fire vary by four to one in radius. A crater in
    // every cell is a golf ball, which is the first thing that goes wrong.
    float cAmt = vRk1.w;
    float cH = 0.0;
    if(lod > 0.14 && cAmt > 0.02){
      float cf = mix(6.5, 4.0, cls);
      vec3 toC; float cr;
      float d = rkCell(Q*cf, toC, cr);
      float rad = 0.13 + cr*cr*0.62;
      float u = d / rad;
      if(u < 1.3 && cr > 0.28){
        float dep = cAmt * (0.006 + cr*cr*0.055);
        float su  = clamp(u/0.84, 0.0, 1.0);
        float sb  = su*su*(3.0-2.0*su);
        float rx  = u - 0.95;
        float rr  = exp(-13.0*rx*rx);
        cH = dep * ((sb - 1.0)*0.95 + rr*0.20);
        float dsb = (u < 0.84) ? (6.0*su*(1.0-su)/0.84) : 0.0;
        float dcd = dep * (dsb*0.95 - 26.0*rx*rr*0.20);
        grad += (toC/max(d,1e-4)) * dcd * cf / rad;
      }
    }

    // ---- strata: only the big bodies were ever layered
    float strat = 0.0;
    if(cls > 0.35){
      float ph = fract(vRk0.x*0.317 + vRk0.z*0.113) * 6.2831;
      vec3  ax = normalize(vec3(cos(ph), 0.62, sin(ph)));
      float bf = mix(7.0, 15.0, fract(vRk0.y*0.41));
      float bd = dot(P, ax)*bf + broad*3.1;
      strat = sin(bd);
      float w = smoothstep(0.35, 0.9, cls);
      grad += ax * (cos(bd) * bf * 0.004 * w);
    }

    // Keep the perturbation tangential, then rebuild the normal in object
    // space so the instance rotation carries it into view space intact.
    grad -= nO*dot(grad, nO);
    vec3 nObj = normalize(nO - grad*(0.5 + 0.5*lod));
    rkNrm = normalize(vRkOV * nObj);
    rkGeo = normalize(vRkOV * nO);

    // Cavity is a *fine* scale term — pinned to the grain amplitude, with the
    // craters only leaning on it. Scale it to the crater and every basin gets
    // a black disc and a white ring, which is a target, not a rock.
    float cav = smoothstep(-amp*0.6, amp*0.5, h0 + cH*0.16);
    rkAO = mix(0.42, 1.0, cav) * (0.84 + broad*0.24);
    rkAO = mix(1.0, rkAO, lod*0.75 + 0.25);

    // ---- albedo. Two scales of blotching: a broad one that separates one rock
    // from the next, and a mid one that keeps the surface from reading as a
    // single flat fill under the bump.
    float mott = rkFbm(Q*5.2 + 3.7, 2);
    vec3 alb = diffuseColor.rgb;
    alb *= 0.60 + broad*0.56 + mott*0.40;
    alb *= 0.90 + clamp(h0/max(amp,1e-4), -1.0, 1.0)*0.13*lod;
    // regolith tooth: one high-frequency albedo octave, close range only. It
    // costs a single lookup and it is the difference between stone and clay.
    if(lod > 0.55) alb *= 0.86 + rkN3(Q*46.0)*0.28;
    alb = mix(alb, alb*vec3(0.82,0.89,1.05), smoothstep(0.48,0.82,broad)*0.8);
    alb *= 1.0 + strat*0.14*smoothstep(0.35,0.9,cls);
    // fresh fracture faces are brighter than the weathered regolith around them
    alb = mix(alb, alb*1.55, smoothstep(0.46, 0.80, rg)*mix(0.5,0.22,cls)*lod);
    // dust pools in the basins
    alb *= mix(0.60, 1.05, cav);

    // ---- ice and metal veining, on a minority of bodies
    float vein = 0.0;
    if(ice + met > 0.01){
      float vr = rkRidge(Q*mix(4.2,2.6,cls) + 19.0, 3);
      vein = smoothstep(0.66, 0.90, vr) * (0.35 + 0.65*cav);
    }
    alb = mix(alb, vec3(0.27,0.28,0.30), vein*ice);
    alb = mix(alb, vec3(0.075,0.068,0.060), vein*met);
    diffuseColor.rgb = alb;

    // Matte and mineral: the floor stays near 0.4 even on the ice. What picks
    // the veins out is that they are *tighter* than the regolith, not shiny.
    rkRough = clamp(0.97 + vRk1.z - vein*(ice*0.50 + met*0.44)
                    - smoothstep(0.5,0.9,rg)*0.06, 0.40, 1.0);
    rkMetal = vein*met*0.80;
    rkVein  = clamp(vein*(ice + met), 0.0, 1.0);
  }
`;

const RK_RIM = /* glsl */`
  #include <lights_fragment_end>
  {
    // Kill the GGX grazing sheen before anything else. Schlick drives F to 1
    // at the horizon no matter how rough the surface is, so a roughness-0.97
    // rock lit by three directionals wears a pale shroud a fifth of its radius
    // deep around the limb — the single thing that stops a procedural asteroid
    // reading as stone. Regolith has no specular lobe worth the name.
    reflectedLight.directSpecular *= mix(0.13, 0.75, rkVein);

    // The shared rim law, with two departures from the hull's. It runs on the
    // *geometric* normal, because a rim belongs to the silhouette and feeding
    // it the bumped normal lights every crater wall in the frame; and the
    // exponent is far tighter, because a hull is small enough that a broad
    // falloff reads as an edge while a boulder filling a third of the screen
    // wears the same falloff as a pale shroud a hundred pixels deep.
    vec3 Vv = normalize(vViewPosition);
    /* The exponent is a trap in both directions. At sixteen the term went from
       nothing to full over less than a pixel at the silhouette and *clipped*,
       drawing a hard white outline one pixel wide that reads as a compositing
       error; at seven it becomes the pale shroud a hundred pixels deep that the
       tight exponent was chosen to avoid in the first place. The line was never
       the exponent's fault — it was the gain, which put the peak above the clip
       point so the roll-off had nowhere to happen. Keep it tight and stop it
       clipping. */
    float fres  = pow(clamp(1.0 - dot(rkGeo, Vv), 0.0, 1.0), 12.0);
    float back  = clamp(-dot(uSunV, Vv), 0.0, 1.0);
    float graze = clamp(1.0 - abs(dot(rkGeo, uSunV)), 0.0, 1.0);
    // Squared on the backlight, because a rock is not carved out of a flat
    // sphere: the wall between a flat top and a flat break face sits at 80
    // degrees to the eye over a fifth of the disc, and a rim that fires there
    // at half phase paints that whole wall pale. At true backlight it fires.
    reflectedLight.directSpecular += uSunTint * fres * back*back * graze * uRimGain * 0.42;

    // Cavity closes down the sky, not the key.
    reflectedLight.indirectDiffuse  *= rkAO;
    reflectedLight.indirectSpecular *= rkAO;

    float wrap = clamp(dot(normal, uSunV)*0.5 + 0.5, 0.0, 1.0);
    reflectedLight.indirectDiffuse += uBounce * diffuseColor.rgb * (0.4 + 0.6*wrap) * 2.2;
  }
`;

function rockMaterial(tint) {
  const m = new THREE.MeshStandardMaterial({
    color: tint, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.85,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSunV = HULL_LIGHT.uSunV;
    sh.uniforms.uSunTint = HULL_LIGHT.uSunTint;
    sh.uniforms.uRimGain = HULL_LIGHT.uRimGain;
    sh.uniforms.uBounce = HULL_LIGHT.uBounce;

    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + RK_VERT_PARS)
      .replace('#include <begin_vertex>', RK_VERT);

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\n' + RK_FRAG_PARS + '\nvec3 rkNrm = vec3(0.0);\nvec3 rkGeo = vec3(0.0);')
      .replace('#include <map_fragment>', RK_SURFACE)
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = rkRough;')
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n  metalnessFactor = rkMetal;')
      .replace('#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n  normal = rkNrm;')
      .replace('#include <lights_fragment_end>', RK_RIM);
  };
  m.customProgramCacheKey = () => 'lsRock1';
  return m;
}

/* ------------------------------------------------------------------- motes

   The finest population. Points, one draw call, wrapped in a box around the
   ship exactly like the interplanetary dust — but lit, with a forward-scatter
   phase, so looking sunward through the belt fills the frame instead of
   leaving 86% of it at zero. Sized in pixels: a sub-pixel mote is not dim, it
   is absent.                                                                */

const MOTE_VERT = /* glsl */`
${LOGD_V_PARS}
attribute vec2 aMote;    // x world radius, y brightness
uniform vec3  uOfs;
uniform float uBox;
uniform float uScale;    // drawing-buffer height * 0.5 * P[1][1]
uniform float uFade;
uniform vec3  uSunV;
varying float vB;
void main(){
  float L = uBox;
  vec3 p = mod(position - uOfs + L*0.5, L) - L*0.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dv = length(mv.xyz);

  // fade at the box edge and out of the cabin's own volume
  float a = (1.0 - smoothstep(L*0.33, L*0.50, dv)) * smoothstep(1.5, 6.0, dv);

  // Forward scattering. Dust is many times brighter looking into the key than
  // away from it, which is what makes a belt read as a medium and not a lattice.
  float c  = dot(normalize(mv.xyz), uSunV);
  float hg = 0.13 + 4.4*pow(clamp(c, 0.0, 1.0), 6.0) + 0.70*pow(clamp(c, 0.0, 1.0), 1.6);

  float px = aMote.x * uScale / max(dv, 1e-3);
  /* Every mote gets at least three pixels to spread over, and loses brightness
     in proportion to the area it gained. A sprite clamped to 1.4 px is a 2x2
     quad: gl_PointCoord never gets far enough from the centre for the radial
     falloff below to do anything, so the mote draws as a hard bright square —
     a field of them reads as sensor noise or dirt on the lens, which is exactly
     what it was called. Three pixels is the smallest quad that can hold an
     edge. The flux is conserved so widening them does not brighten the belt,
     and the exponent is short of energy-exact because dust nobody can see is
     not dust. */
  /* Same trap the star field fell into: conserving flux exactly across the
     widening divides the peak by the area gained, and on a small quad that puts
     everything except the centre texel below black — so the mote still draws as
     a hard bright square however soft the profile is. Give it room *and* leave
     it some peak. Three pixels was not enough of either. */
  const float MIN_PX = 5.0;
  float want = max(px, MIN_PX);
  float spread = pow((px*px) / (want*want), 0.55);
  gl_PointSize = min(want, 26.0);
  /* And half the brightness. Past a certain density a field of small bright
     dots reads as sensor noise no matter how soft each one is — the eye reads
     the *count*, not the profile. Dust is a medium you see through, not a
     second starfield: it should sit just above the floor and let the parallax
     do the work. */
  vB = a * hg * uFade * spread * aMote.y * 0.45;

  gl_Position = projectionMatrix * mv;
  ${LOGD_V}
}
`;

const MOTE_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
uniform vec3 uTint;
varying float vB;
void main(){
  ${LOGD_F}
  vec2 d = gl_PointCoord - 0.5;
  // Gentler than r*r: a squared falloff on a five-pixel quad puts half the
  // profile inside one texel, which is the whole reason these drew as squares.
  float r = clamp(1.0 - dot(d,d)*4.0, 0.0, 1.0);
  gl_FragColor = vec4(uTint * vB * pow(r, 1.25), 1.0);
}
`;

/* -------------------------------------------------------------------------- */

export class AsteroidField {
  constructor(belt, quality) {
    this.belt = belt;
    this.radius = 22;                 // boulder shell radius (world units)
    this.rnd = mulberry32(belt.seed * 7919);
    const rnd = this.rnd;
    const low = quality === 'low', med = quality === 'medium';
    const hi = !low && !med;

    // Three size classes. The counts are a pyramid because that is what a
    // collisional population looks like — and because the mid-ground is what
    // was missing.
    const pools = [
      { name: 'boulder', geos: 3, detail: hi ? 4 : 2, flat: false, cls: 1.0,
        n: low ? 34 : med ? 58 : 84, sMin: 0.40, sMax: 1.85, pow: 2.0,
        radius: 22, cuts: 3, cutMin: 0.86, cutSpan: 0.20, craters: 5, swarm: 0 },
      { name: 'rock', geos: 2, detail: 2, flat: false, cls: 0.5,
        n: low ? 110 : med ? 200 : 320, sMin: 0.085, sMax: 0.45, pow: 1.7,
        radius: 22, cuts: 4, cutMin: 0.70, cutSpan: 0.28, craters: 3, swarm: 0.35 },
      { name: 'chip', geos: 3, detail: 1, flat: true, cls: 0.0,
        n: low ? 300 : med ? 700 : 1350, sMin: 0.010, sMax: 0.105, pow: 1.5,
        radius: 34, cuts: 7, cutMin: 0.46, cutSpan: 0.34, craters: 0, swarm: 0.72 },
    ];

    this.geos = [];
    this.meshes = [];
    this.mat = rockMaterial(belt.tint);
    this.object = new THREE.Group();
    this.items = [];

    let gseed = belt.seed * 131 + 7;
    for (const p of pools) {
      const first = this.meshes.length;
      const per = Math.ceil(p.n / p.geos);
      for (let i = 0; i < p.geos; i++) {
        const g = rockGeometry(gseed++, p);
        const m = new THREE.InstancedMesh(g, this.mat, per);
        m.frustumCulled = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.count = 0;
        const a0 = new THREE.InstancedBufferAttribute(new Float32Array(per * 4), 4);
        const a1 = new THREE.InstancedBufferAttribute(new Float32Array(per * 4), 4);
        a0.setUsage(THREE.DynamicDrawUsage);
        a1.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('aRock0', a0);
        g.setAttribute('aRock1', a1);
        this.geos.push(g);
        this.meshes.push(m);
        this.object.add(m);
      }
      for (let i = 0; i < p.n; i++) {
        const mi = first + (i % p.geos);
        const mesh = this.meshes[mi];
        this.items.push({
          pool: p, mesh, slot: mesh.count++,
          p: new THREE.Vector3(),
          q: new THREE.Quaternion(),
          spin: new THREE.Vector3((rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4),
          s: 0,
          swarm: rnd() < p.swarm ? Math.floor(rnd() * 14) : -1,
          gen: -1,
          init: false,
        });
      }
      // Every instance is written every frame, so the draw count is just the
      // population — but it is the *assigned* population, not the allocation:
      // an unwritten slot draws an identity matrix, which is a unit rock
      // sitting on the camera.
      for (let i = first; i < this.meshes.length; i++) {
        this.meshes[i].userData.pop = this.meshes[i].count;
        this.meshes[i].count = 0;
      }
    }
    this.count = this.items.length;

    // Collision families: debris travels in clumps, and a clumped field reads
    // as structure where a uniform one reads as film grain.
    this.swarms = [];
    for (let i = 0; i < 14; i++) {
      this.swarms.push({ p: new THREE.Vector3(), r: 2.5 + rnd() * 6.0, gen: 0, init: false });
    }

    this._buildMotes(quality);

    this.object.visible = false;
    this._m = new THREE.Matrix4();
    this._sv = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._e = new THREE.Euler();
    this._q = new THREE.Quaternion();
  }

  _buildMotes(quality) {
    const rnd = this.rnd;
    const n = quality === 'low' ? 6000 : quality === 'medium' ? 13000 : 26000;
    const box = 88;
    const pos = new Float32Array(n * 3);
    const mv = new Float32Array(n * 2);
    // wisps rather than white noise
    let cx = 0, cy = 0, cz = 0, left = 0, spread = 1;
    for (let i = 0; i < n; i++) {
      if (left <= 0) {
        cx = (rnd() - 0.5) * box; cy = (rnd() - 0.5) * box; cz = (rnd() - 0.5) * box;
        left = 4 + Math.floor(rnd() * 26);
        spread = 1.2 + rnd() * 8.5;
      }
      left--;
      const g = () => (rnd() + rnd() + rnd() - 1.5) * spread;
      let x = cx + g(), y = cy + g() * 0.7, z = cz + g();
      // wrap into the box so the modulo in the shader is seamless
      x = ((x + box * 1.5) % box + box) % box - box * 0.5;
      y = ((y + box * 1.5) % box + box) % box - box * 0.5;
      z = ((z + box * 1.5) % box + box) % box - box * 0.5;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      // Two populations. The grains are what you see going past; the puffs are
      // wide and nearly transparent and are what makes the space between the
      // rocks stop being vacuum. Without them a mote field is a lattice of
      // dots that reads as sensor noise.
      const r = rnd();
      if (rnd() < 0.26) {
        mv[i * 2] = 0.30 + r * r * 1.5;
        mv[i * 2 + 1] = 0.020 + r * 0.040;
      } else {
        mv[i * 2] = 0.009 + r * r * 0.055;
        mv[i * 2 + 1] = 0.26 + r * 0.85;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMote', new THREE.BufferAttribute(mv, 2));

    const tint = this.belt.tint.clone();
    // dust is what the rocks are made of, lifted a little so it survives AgX
    tint.r = tint.r * 0.7 + 0.16; tint.g = tint.g * 0.7 + 0.15; tint.b = tint.b * 0.7 + 0.14;

    this.moteMat = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uOfs: { value: new THREE.Vector3() },
        uBox: { value: box },
        uScale: { value: 450 },
        uFade: { value: 1 },
        uTint: { value: tint },
        uSunV: HULL_LIGHT.uSunV,
      },
    });
    this.moteBox = box;
    this.motes = new THREE.Points(geo, this.moteMat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 6;
    this.motes.onBeforeRender = (renderer, scene, camera) => {
      const s = renderer.getDrawingBufferSize(this._dbs || (this._dbs = new THREE.Vector2()));
      this.moteMat.uniforms.uScale.value = s.y * 0.5 * camera.projectionMatrix.elements[5];
    };
    this.object.add(this.motes);
  }

  _respawn(it, shipRel, dir, fresh) {
    const pool = it.pool;
    const r = pool.radius;
    const rnd = this.rnd;
    const v = this._v;
    const sw = it.swarm >= 0 ? this.swarms[it.swarm] : null;
    if (sw) {
      // inside a family: gaussian-ish about the clump centre
      v.set((rnd() + rnd() - 1) * sw.r, (rnd() + rnd() - 1) * sw.r * 0.8,
            (rnd() + rnd() - 1) * sw.r).add(sw.p);
      it.p.copy(v);
      it.gen = sw.gen;
    } else if (fresh) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, sr = Math.cbrt(rnd()) * r;
      const s2 = Math.sqrt(1 - u * u);
      it.p.set(Math.cos(th) * s2, u, Math.sin(th) * s2).multiplyScalar(sr).add(shipRel);
    } else {
      // place ahead of travel on the shell boundary
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
      const s2 = Math.sqrt(1 - u * u);
      v.set(Math.cos(th) * s2, u, Math.sin(th) * s2);
      if (v.dot(dir) < 0) v.negate();
      it.p.copy(v).multiplyScalar(r * (0.85 + rnd() * 0.15)).add(shipRel);
    }

    const t = Math.pow(rnd(), pool.pow);
    it.s = pool.sMin + t * (pool.sMax - pool.sMin);
    it.q.setFromEuler(this._e.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
    it.init = true;

    // Per-instance surfacing. Class blends with actual size inside the pool so
    // the biggest rock of a class is layered and the smallest is a shard.
    const g = it.mesh.geometry;
    const a0 = g.attributes.aRock0, a1 = g.attributes.aRock1;
    const cls = Math.min(1, pool.cls * (0.55 + 0.75 * t));
    a0.setXYZW(it.slot, rnd() * 40, rnd() * 40, rnd() * 40, cls);
    // A minority is icy or metallic. Never both, or every rock looks the same.
    const roll = rnd();
    const veinAmt = 0.45 + rnd() * 0.55;
    const ice = roll < 0.16 ? veinAmt : 0;
    const met = roll >= 0.16 && roll < 0.26 ? veinAmt : 0;
    a1.setXYZW(it.slot, ice, met, (rnd() - 0.5) * 0.06, 0.55 + rnd() * 0.65);
    a0.needsUpdate = true;
    a1.needsUpdate = true;
  }

  /** @param {THREE.Vector3} shipAbs absolute ship position (belt is centred on the star at 0) */
  update(dt, shipAbs, shipRel, velocity, active) {
    if (!active) {
      if (this.object.visible) {
        this.object.visible = false;
        this.items.forEach((i) => (i.init = false));
        this.swarms.forEach((s) => (s.init = false));
      }
      return;
    }
    const wasHidden = !this.object.visible;
    this.object.visible = true;

    const dir = velocity.lengthSq() > 1e-8
      ? this._sv.copy(velocity).normalize() : this._sv.set(0, 0, -1);
    const rnd = this.rnd;

    // Swarms drift with the field and recycle like anything else. Members
    // follow the *swarm*, never their own distance test — a clump straddling
    // the shell boundary would otherwise respawn half its rocks every frame.
    const swR2 = (this.radius * 1.55) ** 2;
    for (const s of this.swarms) {
      if (!s.init || wasHidden || s.p.distanceToSquared(shipRel) > swR2) {
        const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
        const s2 = Math.sqrt(1 - u * u);
        const v = this._v.set(Math.cos(th) * s2, u, Math.sin(th) * s2);
        if (s.init && !wasHidden) { if (v.dot(dir) < 0) v.negate(); v.multiplyScalar(this.radius * 1.25); }
        else v.multiplyScalar(Math.cbrt(rnd()) * this.radius * 1.25);
        s.p.copy(v).add(shipRel);
        s.gen++;
        s.init = true;
      }
    }

    for (const it of this.items) {
      const sw = it.swarm >= 0 ? this.swarms[it.swarm] : null;
      const r2 = (it.pool.radius * 1.15) ** 2;
      if (!it.init || wasHidden) this._respawn(it, shipRel, dir, true);
      else if (sw) { if (it.gen !== sw.gen) this._respawn(it, shipRel, dir, false); }
      else if (it.p.distanceToSquared(shipRel) > r2) this._respawn(it, shipRel, dir, false);

      it.q.multiply(this._q.setFromEuler(
        this._e.set(it.spin.x * dt, it.spin.y * dt, it.spin.z * dt)));

      this._m.compose(it.p, it.q, this._sv.setScalar(it.s));
      it.mesh.setMatrixAt(it.slot, this._m);
    }

    for (const m of this.meshes) {
      m.count = m.userData.pop;
      m.instanceMatrix.needsUpdate = true;
    }

    const L = this.moteBox;
    this.moteMat.uniforms.uOfs.value.set(
      ((shipAbs.x % L) + L) % L, ((shipAbs.y % L) + L) % L, ((shipAbs.z % L) + L) % L);
    const f = this.moteMat.uniforms.uFade;
    f.value += ((wasHidden ? 0.15 : 1) - f.value) * Math.min(1, dt * 2.5);
  }

  contains(absPos) {
    const b = this.belt;
    const r = Math.hypot(absPos.x, absPos.z);
    return r > b.inner && r < b.outer && Math.abs(absPos.y) < b.thickness * 2.5;
  }

  dispose() {
    this.geos.forEach((g) => g.dispose());
    this.mat.dispose();
    this.motes.geometry.dispose();
    this.moteMat.dispose();
  }
}
