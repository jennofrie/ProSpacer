import * as THREE from 'three';
import { NOISE, LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';
import { mulberry32 } from './generate.js';
import { CHOIR_HUE, place, slab, weld, palette, dress } from '../gfx/greeble.js';
import { buildStation } from './Station.js';

/* ============================================================================
   Things the Choir left behind.

   Resonators  — monoliths. The only objects in the game that are *not* natural,
                 and the only ones with a material language of their own.
   Derelicts   — a station that came apart, forty thousand years ago, and has
                 been spreading along its own orbit ever since.
   Wrecks      — everyone else who came looking.
   Beacons     — the signal sources that lead you to all of the above.
   ========================================================================== */

/* ------------------------------------------------------------- monolith */

const GLYPH_VERT = /* glsl */`${LOGD_V_PARS}
attribute vec3  aLocal;
attribute vec3  aTan;
attribute vec4  aPart;
varying vec3  vLoc;
varying vec3  vTan;
varying vec4  vPart;
varying vec3  vN;
varying vec3  vW;
varying vec3  vObj;
varying vec3  vCoreW;
void main(){
  // Relief is written in the part's own frame, where "across" is a third of a
  // unit. The plinth ring is fifteen times that, so without a per-part rescale
  // its fluting lands at six hundred cycles and turns the whole ring into a
  // boiling speckle. aPart carries (relief scale, part seed, part kind,
  // authored emissive) — four things that were four attributes and four
  // varying slots, which this shader is close enough to the limit to care about.
  vLoc  = aLocal*aPart.x;
  vPart = aPart;
  vObj  = position;
  vN    = normalize(mat3(modelMatrix)*normal);
  vTan  = normalize(mat3(modelMatrix)*aTan);
  vec4 wp = modelMatrix*vec4(position,1.0);
  vW = wp.xyz;
  // The structure's own origin *is* the core, so the light that hangs in the
  // middle of the colonnade can be reconstructed here for free rather than
  // being pushed in from the game loop every frame.
  vCoreW = (modelMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
  gl_Position = projectionMatrix*viewMatrix*wp;
  ${LOGD_V}
}
`;

const GLYPH_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
varying vec3  vLoc;
varying vec3  vTan;
varying vec4  vPart;
varying vec3  vN;
varying vec3  vW;
varying vec3  vObj;
varying vec3  vCoreW;
uniform float uTime;
uniform vec3  uCamPos;
uniform vec3  uGlow;
uniform float uActive;
uniform float uSeed;
uniform float uRingR;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform samplerCube uEnv;

/* ---- relief ---------------------------------------------------------------
   The single loudest complaint a flat-shaded megastructure earns is that each
   face is one colour edge to edge, so it reads as cut paper. Real relief is
   the fix, and most of it can be had for the price of one height field and the
   hardware derivatives that are already sitting there.

   Three scales, and they have to be three genuinely *different* sizes or the
   whole thing collapses back into one frequency of noise:

     strata   metres across. The stone was grown in courses, and the courses
              are the only surface event still legible from a kilometre out.
     fluting  centimetres. The worked surface, across the blade.
     grain    millimetres. The tooth that stops any one facet being a flat fill.

   The part-local frame is the only one that means anything — x across, y along,
   z through. Returns (height, strata, grain): the last two are wanted again by
   the weathering below and fetching them twice is not free. */
vec3 relief(vec3 p, float bl){
  /* aRk normalises the part's width, not its length: a blade runs seven units
     along its own y and the plinth ring runs a tenth of one, so a single
     frequency for both gives seventy courses on one and none on the other.
     The along-axis frequencies are picked per kind, and on a blade they are
     picked to *agree with* the terraces the geometry now carries — painted
     relief that disagrees with modelled relief beats against it, and the beat
     is what read as corrugated card. */
  float fCourse = mix(9.0, 0.85, bl);
  float fReg    = mix(26.0, 2.1, bl);
  float fGrain  = mix(143.0, 27.0, bl);
  float strata = 0.5 + 0.5*cos(p.y*fCourse + cos(p.x*2.7 + uSeed)*1.1);
  strata *= strata;
  // The wander stays small. At 0.6 the flutes meander instead of running, and
  // a meandering highlight down a column reads as poured chrome.
  float flute = 0.5 + 0.5*cos(p.x*185.0 + sin(p.y*7.0)*0.22);
  flute *= flute;
  // No hard edges anywhere in here. A smoothstep terrace looks right until the
  // normal is taken from screen-space derivatives, at which point every riser
  // becomes a one-pixel spike and the whole colonnade crawls with white sparks.
  //
  // And no noise either. This runs once per fragment on an object that fills
  // the screen when you fly through it, with three or four blades of overdraw
  // behind it and no early-Z to reject any of it, because the log depth buffer
  // writes gl_FragDepth. Three octaves of simplex in here cost thirty frames.
  // Trig and one hash buy the same surface.
  float ter = p.y*fReg + hash13(vec3(floor(p.x*9.0), 0.0, uSeed))*0.3;
  float reg = 0.5 + 0.5*cos(TAU*ter);
  reg *= reg;
  float fine = 0.5 + 0.5*cos(p.y*fGrain + p.x*61.0);
  // The central channel is a *blade's* feature. Run over the plinth ring —
  // whose part-local x sweeps the whole diameter — it lands as two grooves cut
  // across the masonry at no particular radius.
  float chan = (1.0 - smoothstep(0.02, 0.075, abs(p.x)))*bl;
  float h = strata*0.34 + flute*0.20 + reg*0.20 + fine*0.09 - chan*0.35;
  return vec3(h, strata, fine);
}

/* Quantised marks that read as writing without any texture. Writing and a
   checkerboard differ in exactly one way: a checkerboard fills its cell. Half
   the rows here are blank and a mark never runs to its own edges. */
float glyphs(vec2 uvg){
  vec2 c = vec2(uvg.x*3.0, uvg.y*38.0);
  vec2 cell = floor(c);
  float row = hash13(vec3(0.0, cell.y, uSeed));
  float on  = hash13(vec3(cell, uSeed*1.7));
  float live = step(0.42, row)*step(0.34, on);
  vec2 f = fract(c);
  float bar = step(abs(f.x - 0.5), 0.05 + on*0.13)*step(abs(f.y - 0.5), 0.16);
  return bar*live;
}

void main(){
  ${LOGD_F}
  float rk = vPart.x, pSeed = vPart.y, kind = vPart.z, emitA = vPart.w;
  // 1 on anything with a blade's grain and a blade's spine; 0 on the plinth,
  // on the core armature and on the debris the ring has shed.
  float bl = 1.0 - min(abs(kind - 1.0), 1.0);
  float shard = 1.0 - min(abs(kind - 3.0), 1.0);

  vec3 N = normalize(vN);
  vec3 Ng = N;                       // geometric normal, kept unperturbed
  vec3 V = normalize(uCamPos - vW);
  float dist = length(uCamPos - vW);

  // Relief has to fade out with distance or it turns into a shimmering mess
  // long before it stops costing anything.
  float lod = 1.0 - smoothstep(6.0, 34.0, dist);
  vec3 rf = relief(vLoc, bl);
  float h = rf.x;
  {
    vec3 dpx = dFdx(vW), dpy = dFdy(vW);
    // clamped, so a fragment that straddles a feature cannot spike the normal
    float hx = clamp(dFdx(h), -0.09, 0.09);
    float hy = clamp(dFdy(h), -0.09, 0.09);
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det)*(hx*r1 + hy*r2);
    N = normalize(abs(det)*N - grad*0.022*lod);
  }
  float fres = pow(1.0 - max(dot(N,V), 0.0), 4.0);
  // The rim has to come off the *geometric* normal. Taken from the bumped one,
  // every terrace on every blade turns edge-on somewhere and the whole
  // colonnade lights up green — which spends the game's one reserved colour on
  // a surface treatment instead of on a signal.
  float fresG = pow(1.0 - max(dot(Ng,V), 0.0), 4.0);
  float cav = 1.0 - clamp(h, 0.0, 1.0)*0.55;      // relief occlusion
  float ndl = max(dot(N, uSunDir), 0.0);

  /* ---- forty thousand years inside a grinding ring -----------------------
     Two things happen to a surface left that long in a debris field, and
     between them they are most of the difference between "old" and "rendered
     this morning":

       scour  the exposed arrises are sandblasted back to raw mineral. Keyed
              off the *geometric* grazing angle, which is where the arrises
              are, so it needs no mask of its own.
       silt   everything that is not exposed fills up. Keyed off the relief
              height already in hand — which is the definition of a recess —
              and biased toward the faces that have been ploughing through the
              ring for four hundred centuries.

     Neither costs a fetch, and dust in the recesses is the one weathering cue
     that survives being seen from a kilometre away. */
  float scour = smoothstep(0.34, 0.95, fresG)*smoothstep(0.44, 0.96, rf.z);
  float silt  = clamp(1.0 - h*3.4, 0.0, 1.0)*(0.30 + 0.70*rf.y)
              * clamp(Ng.y*0.72 + 0.34, 0.0, 1.0)*(1.0 + shard*1.3);

  /* ---- the stone ---------------------------------------------------------
     It absorbs almost everything. The environment term has to stay very low:
     at 0.55 the grazing faces picked up enough of the nebula to read as pale
     grey slabs, which is the one thing a monolith must never do. */
  vec3 base = vec3(0.0035, 0.0045, 0.0062)*cav;
  vec3 env = textureCube(uEnv, reflect(-V, N)).rgb;

  /* Thin-film interference. The Choir did not paint this and they did not
     weld it, so it cannot carry a single plate seam or a single flake of
     oxide — the only vocabulary left for "manufactured" is a surface that
     does something no rock does. The order runs with the grazing angle and
     with slow position, so the sheen crawls as you move past.

     And it is *gone* wherever the surface has been blasted back, which is what
     turns a shader effect into a history: the made skin survives in the
     protected recesses and nowhere else. */
  // Never keyed off the relief field: driven from the fine grain it turned
  // every blade into a curtain of rainbow speckle, the cheapest-looking thing
  // a surface can do.
  float th = 3.1*(1.0 - max(dot(Ng,V),0.0)) + vLoc.y*0.55 + vLoc.x*1.6 + pSeed*0.6;
  vec3 irid = 0.5 + 0.5*cos(TAU*(th + vec3(0.00, 0.36, 0.68)));
  irid = mix(vec3(1.0), irid, 0.72*(1.0 - scour*0.8));

  vec3 col = base + env*irid*(0.075 + 0.24*fres)*cav;

  /* Anisotropic highlight, stretched along the blade. A round specular lobe
     is what makes a surface read as plastic; a lobe smeared along the grain is
     what makes it read as drawn, extruded, grown. */
  {
    vec3 T = normalize(vTan - N*dot(N, vTan));
    vec3 B = cross(N, T);
    vec3 Hv = normalize(uSunDir + V);
    float ax = 0.55, ay = 0.09;
    float xt = dot(Hv,T)/ax, yt = dot(Hv,B)/ay, zt = max(dot(Hv,N), 1e-4);
    float d = xt*xt + yt*yt + zt*zt;
    float spec = min(1.0/(PI*ax*ay*d*d), 3.0);
    // Only the blades have a grain to smear a highlight along. On the plinth
    // the same lobe is a broad sheen down a black ring, which reads as moulded
    // plastic — the one finish nothing here is allowed to have.
    col += uSunColor*spec*0.027*cav*ndl*smoothstep(0.25, 0.75, rk);
    // and a broad wrap so the shadow side is not a hole
    col += uSunColor*0.017*clamp(dot(N,uSunDir)*0.5+0.5, 0.0, 1.0)*cav;
  }

  /* ---- the core actually lights the colonnade ---------------------------
     An emissive that illuminates nothing is a decal. The core hangs at the
     structure's own origin, so every blade can be lit by it directly — which
     is what turns nine separate slabs into one object with a light in it. */
  vec3 coreFill;
  {
    vec3 Lc = vCoreW - vW;
    float dc = max(length(Lc), 1e-4);
    vec3 Ld = Lc/dc;
    float att = 2.2/(2.2 + dc*dc);
    float lam = max(dot(N, Ld), 0.0);
    // Kept deliberately faint. The core has to *touch* the blades, not paint
    // them: at any strength you can comfortably see, the colonnade stops being
    // black stone with a light in it and becomes a green building.
    coreFill = uGlow*att*(lam*0.9 + 0.10)*(0.030 + uActive*0.115)*cav;
    col += coreFill;
  }

  /* ---- the dust itself ---------------------------------------------------
     Silt is mineral, so it is bone, and it is lit by the key and by the core
     like anything else rather than being a grey wash painted into the grooves.
     It is the only pale pigment anywhere on this object, which makes it the
     thing that stops the shadow side of a blade being a hole — and on the shed
     debris, where it is heaviest, the thing that lets a two hundred metre
     splinter read as a metre stick against a seven kilometre blade. */
  // Lit mostly by the *key*. Fed off the core instead it turned every
  // up-facing tread on every terrace into a green band, and a hundred green
  // bands is the flat-lime read this rebuild exists to remove: dust is bone,
  // and bone under a white star is the one warm value on the whole object.
  col += vec3(0.66, 0.62, 0.53)*silt*(uSunColor*ndl*0.058 + coreFill*0.22
                                      + vec3(0.0022, 0.0027, 0.0036));

  /* ---- where the light in this thing actually lives ----------------------
     Not paint, and not a decal: one circuit, and a circuit has sources and it
     has a length. The sources are the lens hanging in the middle of the ring
     and the conduit cut into the plinth crown; everything else is lit by how
     far down the path from one of them it happens to sit. That is the whole
     difference between an emissive with form and a flat fill, and it is why
     the tip of a seven kilometre blade is black stone. */
  float rXZ = length(vObj.xz);
  float dCore = length(vObj);
  float dRing = length(vec2(rXZ - uRingR, vObj.y));
  float feed = max(2.4/(2.4 + dCore*dCore*3.0), 1.0/(1.0 + dRing*dRing*2.6));
  // Nothing shed off the ring is still connected to it.
  feed *= 1.0 - shard*0.94;

  /* ---- inscription ------------------------------------------------------
     Light *escaping* from inside the stone, not paint on the outside of it.
     The emissive has to occupy a small fraction of the surface: mapped over a
     whole face it turned nine monoliths into nine glowing billboards. */
  float across = vLoc.x;
  float along  = vLoc.y;
  float spine = (1.0 - smoothstep(0.010, 0.038, abs(across)))*bl;
  float band  = (1.0 - smoothstep(0.05, 0.17, abs(across)))*bl;
  // Multiplied by the cavity, so the marks sit *in* the stone and take the
  // relief with them. Added flat on top they are quantised green rectangles
  // painted over the terraces, which is precisely the projected-checker read
  // this object was failed for.
  float gl = glyphs(vec2(across*3.4, along*0.30))*band*cav;
  /* Nodes: discrete swellings down the spine, and — with the conduit and the
     lens — the only part of this object authored above the clip point. A frame
     in which nothing clips reads as flat, measurably so, and this is the
     brightest thing in the system: a handful of small sources go to something
     like 250 units of radiance, come back pure white through AgX, and let the
     halation spill the hue out around them. Everything else stays well under,
     which is what makes them read as sources rather than as paint. */
  float nx = along*1.55 + pSeed*3.0;
  float nodeOn = step(0.62, hash13(vec3(floor(nx), uSeed, 3.0)));
  float node = pow(1.0 - smoothstep(0.0, 0.16, abs(fract(nx) - 0.5)), 3.0)*spine*nodeOn;
  // A pulse travelling *out* from the sources, so the light has a direction as
  // well as a place it comes from.
  float trav = 0.42 + 0.58*sin(uTime*0.9 - (dCore + dRing*0.8)*2.2 + uSeed);
  float lit = 0.05 + uActive*0.95;

  // seams sit *in* the stone, so the surface darkens either side of them
  col *= 1.0 - smoothstep(0.0, 1.0, spine)*0.4;
  // the circuit: dim, and shaped entirely by the feed
  col += uGlow*(spine*1.35 + gl*0.13)*feed*trav*lit*cav;
  /* The sources: the conduit groove in the plinth crown, the collars where a
     blade takes its feed off it, and the nodes climbing the spine. Each part
     gets its own level off its seed — an installation where every circuit is
     drawing exactly the same current is an installation nobody has been
     maintaining for forty thousand years. */
  float draw = 0.55 + 0.45*hash13(vec3(pSeed*13.0, 2.0, 7.0));
  col += uGlow*(emitA*104.0*draw*(0.76 + 0.24*rf.z) + node*205.0)*feed*trav*lit;

  /* Rim. A cold one off the void so the silhouette survives against a black
     sky whatever the emissive happens to be doing, and a Choir one that exists
     only where there is light to leak: the tip of a dead blade is not allowed
     to glow green just because it turned edge-on. */
  col += vec3(0.030, 0.044, 0.062)*pow(fresG, 3.0)*(0.55 + 0.45*silt);
  col += uGlow*pow(fresG, 2.6)*(0.03 + uActive*0.15)*feed;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* Additive volumetrics: the shafts the core throws out through its apertures,
   and the column standing on it. Occluded by the blades, which is the whole
   trick — a shaft you can see between two slabs and not through them is what
   tells you the light is coming from inside the ring. */
const SHAFT_VERT = /* glsl */`${LOGD_V_PARS}
attribute vec3 aSrc;
attribute vec3 aAxis;
attribute vec2 aParam;
varying vec3 vW;
varying vec3 vSrcW;
varying vec3 vAxisW;
varying vec2 vParam;
void main(){
  vec4 wp = modelMatrix*vec4(position,1.0);
  vW = wp.xyz;
  // The shaft's own axis and mouth, carried into world space. They are
  // constant across every vertex of a given shaft, so the interpolator
  // delivers them exactly rather than approximately.
  vSrcW  = (modelMatrix*vec4(aSrc,1.0)).xyz;
  vAxisW = normalize(mat3(modelMatrix)*aAxis);
  vParam = aParam;
  gl_Position = projectionMatrix*viewMatrix*wp;
  ${LOGD_V}
}
`;
const SHAFT_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec3 vW;
varying vec3 vSrcW;
varying vec3 vAxisW;
varying vec2 vParam;
uniform vec3  uGlow;
uniform float uTime;
uniform float uActive;
uniform vec3  uCamPos;
void main(){
  ${LOGD_F}
  /* A shaft is a volume, not a quad with a gradient painted down it.

     The geometry this fragment sits on is a proxy and nothing else. It is a
     cone two and a half sigma wide, so its own silhouette never appears; the
     shape comes from integrating a Gaussian tube along the view ray, which is
     a closed form and costs about what the gradient it replaced cost:

         I  =  sigma * sqrt(pi) / sin(theta) * exp(-(d/sigma)^2)

     with d the closest approach between the ray and the shaft's axis and theta
     the angle between them. That buys the three things a gradient quad can
     never have: a soft round section from every angle, a brightening as you
     come round to look down the length of it, and no edge anywhere. */
  vec3 ro = uCamPos;
  vec3 rd = normalize(vW - ro);
  vec3 A  = normalize(vAxisW);
  vec3 w0 = ro - vSrcW;
  float bb = dot(rd, A);
  float dd = dot(rd, w0);
  float ee = dot(A, w0);
  float den = max(1.0 - bb*bb, 2.0e-3);      // sin^2 between the ray and the axis
  float tAx = (ee - bb*dd)/den;              // where along the shaft
  float len = vParam.x;
  float tC = clamp(tAx, 0.0, len);
  vec3 Q = vSrcW + A*tC;
  vec3 toQ = Q - ro;
  float sQ = dot(toQ, rd);
  float dPerp = length(toQ - rd*sQ);

  // the shaft opens out as it leaves the aperture
  float u = tC/len;
  float sig = vParam.y*(1.0 + u*3.2);
  float g = exp(-(dPerp*dPerp)/(sig*sig));
  // Looking straight down a shaft means looking through the whole length of
  // it. Clamped, or the axis itself is an infinity.
  float axial = min(1.0/sqrt(den), 5.0);
  // and it runs out of light: inverse-square off the mouth, taken to nothing
  // at the tip, so no shaft ever ends in a visible edge
  float fall = (1.0 - u)*(1.0 - u)/(1.0 + u*u*7.0);

  /* Dust. There is something in the beam and it is moving — motes drifting out
     along the shaft, which is the only thing that says the light has a medium
     to cross. Trig, not noise: these are additive, they do not write depth,
     and flying into the colonnade puts several of them over every pixel. */
  // Strictly along the axis. Modulated by the radius as well it was the
  // product of two functions of (along, |across|), and a product like that is
  // symmetric about the axis: the beam filled up with a lattice of hard green
  // chevrons, which is a worse artefact than the flat gradient it replaced.
  float mote = 0.74 + 0.26*sin(tC*3.3 - uTime*1.15 + vParam.y*47.0)
                    + 0.10*sin(tC*8.7 - uTime*2.05 + vParam.y*23.0);
  float breathe = 0.62 + 0.38*sin(uTime*0.5 - tC*1.6);

  float a = g*axial*sig*fall*mote*breathe*(0.05 + uActive*0.95);
  a *= step(0.0, sQ);                        // nothing behind the lens is lit
  gl_FragColor = vec4(uGlow*a*2.1, 1.0);
}
`;

/* The lens. Two pixels of this decide whether the whole colonnade reads as
   lit, and a ball of one flat colour is not a light source, it is a sticker —
   so it gets a hot centre falling off to a limb, and it gets authored well
   above the clip point where a star lives. */
const CORE_VERT = /* glsl */`${LOGD_V_PARS}
varying vec3 vW;
varying vec3 vN;
varying vec3 vObj;
void main(){
  vObj = position;
  vN = normalize(mat3(modelMatrix)*normal);
  vec4 wp = modelMatrix*vec4(position,1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix*viewMatrix*wp;
  ${LOGD_V}
}
`;
const CORE_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec3 vW;
varying vec3 vN;
varying vec3 vObj;
uniform vec3  uGlow;
uniform float uTime;
uniform float uActive;
uniform vec3  uCamPos;
void main(){
  ${LOGD_F}
  vec3 V = normalize(uCamPos - vW);
  float face = max(dot(normalize(vN), V), 0.0);
  float core = pow(face, 1.7);
  float churn = 0.74 + 0.26*sin(vObj.y*22.0 + uTime*0.8)*cos(vObj.x*17.0 - uTime*0.5);
  float lvl = (0.10 + uActive*0.90)*churn;
  vec3 col = uGlow*(14.0 + core*core*260.0)*lvl;
  // the last stop before white: a source this bright bleaches its own hue, and
  // the halation carries the colour back out around it
  col += vec3(1.0)*pow(core, 6.0)*80.0*lvl;
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Merge parts into one geometry, carrying the pre-transform local frame. */
function mergeParts(parts) {
  const geos = parts.map((p) => (p.geo.index ? p.geo.toNonIndexed() : p.geo));
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const loc = new Float32Array(n * 3);
  const tan = new Float32Array(n * 3);
  const prt = new Float32Array(n * 4);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const t = new THREE.Vector3();
  let o = 0;
  for (let i = 0; i < geos.length; i++) {
    const g = geos[i], p = parts[i];
    const mtx = p.matrix || new THREE.Matrix4();
    nm.getNormalMatrix(mtx);
    // the part's own long axis, carried into world space for the anisotropy
    t.set(0, 1, 0).applyMatrix3(nm).normalize();
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    /* Authored emissive. A formula can say how much light *reaches* a place;
       only the thing that laid out the profile knows that the groove cut into
       the plinth crown is the conduit and the fascia below it is not. */
    const E = g.attributes.aEmit ? g.attributes.aEmit.array : null;
    const c = g.attributes.position.count;
    for (let k = 0; k < c; k++) {
      const a = (o + k) * 3, b = k * 3;
      loc[a] = P[b]; loc[a + 1] = P[b + 1]; loc[a + 2] = P[b + 2];
      v.set(P[b], P[b + 1], P[b + 2]).applyMatrix4(mtx);
      pos[a] = v.x; pos[a + 1] = v.y; pos[a + 2] = v.z;
      v.set(N[b], N[b + 1], N[b + 2]).applyMatrix3(nm).normalize();
      nrm[a] = v.x; nrm[a + 1] = v.y; nrm[a + 2] = v.z;
      tan[a] = t.x; tan[a + 1] = t.y; tan[a + 2] = t.z;
      const q = (o + k) * 4;
      prt[q] = p.rk === undefined ? 1 : p.rk;
      prt[q + 1] = p.seed || 0;
      prt[q + 2] = p.kind || 0;
      prt[q + 3] = E ? E[k] : 0;
    }
    o += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('aLocal', new THREE.BufferAttribute(loc, 3));
  out.setAttribute('aTan', new THREE.BufferAttribute(tan, 3));
  out.setAttribute('aPart', new THREE.BufferAttribute(prt, 4));
  return out;
}

/* ---------------------------------------------------------------- sweeping
   Everything the Choir built is a cross-section carried along a spine, and the
   only thing separating that from a box is what happens at the corners. A
   chamfer is two more points in the section and one more band of quads, and it
   is the entire difference between an edge that dissolves into the void and an
   edge that holds a hard bright line when the key rakes across it.

   Every band gets its own face normal, which is the other half of the point.
   three's LatheGeometry and computeVertexNormals both average across a break
   in the profile, and an averaged chamfer is not a chamfer — it is a fillet
   with no edge in it. That is how a five-step plinth ends up reading as one
   soft rubber tyre with a tread pattern on it.

   Rings must wind so increasing index runs counter-clockwise seen from +Y, and
   stations must run in increasing Y, or the shell is inside out and backface
   culling deletes the whole structure. */
function sweep(rings, capA, capB) {
  const m = rings.length, n = rings[0].p.length / 3;
  const tris = (m - 1) * n * 2 + (capA ? n - 2 : 0) + (capB ? n - 2 : 0);
  const pos = new Float32Array(tris * 9);
  const nrm = new Float32Array(tris * 9);
  const emi = new Float32Array(tris * 3);
  let t = 0;
  const put = (r0, k0, r1, k1, r2, k2) => {
    const A = rings[r0].p, B = rings[r1].p, C = rings[r2].p;
    const ax = A[k0 * 3], ay = A[k0 * 3 + 1], az = A[k0 * 3 + 2];
    const bx = B[k1 * 3], by = B[k1 * 3 + 1], bz = B[k1 * 3 + 2];
    const cx = C[k2 * 3], cy = C[k2 * 3 + 1], cz = C[k2 * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const o = t * 9, q = t * 3;
    pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
    pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
    pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
    for (let i = 0; i < 3; i++) {
      nrm[o + i * 3] = nx; nrm[o + i * 3 + 1] = ny; nrm[o + i * 3 + 2] = nz;
    }
    emi[q] = rings[r0].e[k0]; emi[q + 1] = rings[r1].e[k1]; emi[q + 2] = rings[r2].e[k2];
    t++;
  };
  for (let j = 0; j < m - 1; j++) {
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      put(j, k, j + 1, k, j, k2);
      put(j, k2, j + 1, k, j + 1, k2);
    }
  }
  if (capA) for (let k = 1; k < n - 1; k++) put(0, 0, 0, k, 0, k + 1);
  if (capB) for (let k = 1; k < n - 1; k++) put(m - 1, 0, m - 1, k + 1, m - 1, k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aEmit', new THREE.BufferAttribute(emi, 1));
  return g;
}

/** A cross-section carried up a list of stations — [y, halfWidth, halfDepth, emit]. */
function loft(sect, stations, capA, capB) {
  const n = sect.length;
  const rings = stations.map((s) => {
    const p = new Float32Array(n * 3), e = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      p[k * 3] = sect[k][0] * s[1]; p[k * 3 + 1] = s[0]; p[k * 3 + 2] = sect[k][1] * s[2];
      e[k] = s[3] || 0;
    }
    return { p, e };
  });
  return sweep(rings, capA, capB);
}

/**
 * A profile — [radius, height, emit] — turned about Y. The profile has to run
 * counter-clockwise in the (r, y) plane or the shell comes out inside out.
 *
 * `wob` scallops the radius. A ring that thickens at every blade station reads
 * as something carrying a load; a perfect circle of constant section is what a
 * torus primitive looks like, and the eye has seen a great many of those.
 */
function revolve(profile, seg, closed, wob) {
  const list = closed ? profile.concat([profile[0]]) : profile;
  const rings = list.map(([r, y, e]) => {
    const p = new Float32Array(seg * 3), em = new Float32Array(seg);
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const rr = r * (wob ? 1 + wob[0] * Math.cos(th * wob[1] + (wob[2] || 0)) : 1);
      p[k * 3] = Math.cos(th) * rr; p[k * 3 + 1] = y; p[k * 3 + 2] = Math.sin(th) * rr;
      em[k] = e || 0;
    }
    return { p, e: em };
  });
  return sweep(rings, false, false);
}

/* A chamfered hexagonal section. The hexagon is what stops a blade reading as
   a rectangular prism the instant the key comes round to rake it; the chamfer
   on every arris is what gives it a third value between the lit face and the
   dark one, and a third value is the read the eye actually uses to decide
   something was cut rather than extruded by a program. */
function hexSect(c) {
  const P = [[1, 0], [0.52, 1], [-0.52, 1], [-1, 0], [-0.52, -1], [0.52, -1]];
  const out = [];
  for (let i = 0; i < P.length; i++) {
    const pr = P[(i + P.length - 1) % P.length], cu = P[i], nx = P[(i + 1) % P.length];
    out.push([cu[0] + (pr[0] - cu[0]) * c, cu[1] + (pr[1] - cu[1]) * c]);
    out.push([cu[0] + (nx[0] - cu[0]) * c, cu[1] + (nx[1] - cu[1]) * c]);
  }
  return out;
}

/* A chamfered rectangle, for the ribs and the small stuff. */
function boxSect(cu, cv) {
  return [
    [1, 1 - cv], [1 - cu, 1], [-(1 - cu), 1], [-1, 1 - cv],
    [-1, -(1 - cv)], [-(1 - cu), -1], [1 - cu, -1], [1, -(1 - cv)],
  ];
}

const BLADE_SECT = hexSect(0.26);
const RIB_SECT = boxSect(0.30, 0.34);

/* Splice a proud collar into a station list at a given height, dropping
   whatever stations it lands on top of. Used where a blade passes through the
   plinth ring: architecturally it is the bearing, and it is also where the
   blade takes its feed off the conduit, which is why it is the one course
   authored as a source. */
function collar(st, y, half, ow, od, em) {
  let i = 0;
  while (i < st.length && st[i][0] < y - half * 2.2) i++;
  let j = i;
  while (j < st.length && st[j][0] < y + half * 2.2) j++;
  if (i === 0 || j >= st.length) return st;
  const lo = st[i - 1], hi = st[j];
  const at = (yy) => {
    const t = (yy - lo[0]) / Math.max(hi[0] - lo[0], 1e-5);
    return [lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t];
  };
  /* The light escapes through the *joint*, not out of the whole casting: a
     hairline slot two or three pixels across at the distance anyone looks at
     this from. Authored as a band the height of the collar it read as four
     white blobs the size of the blades, which is the billboard failure this
     whole rebuild exists to fix — an emissive with form has to be small
     wherever it is bright. */
  const a = at(y - half * 2.0), b = at(y - half), c = at(y + half), d = at(y + half * 2.0);
  const s0 = at(y - half * 0.14), s1 = at(y + half * 0.14);
  // The shoulders sit hard against the slot so the mask ramps over a
  // centimetre rather than over the whole collar: emit is interpolated across
  // the band, and a slot with a long ramp on it is not a slot, it is the band.
  st.splice(i, j - i,
    [y - half * 2.0, a[0], a[1], 0],
    [y - half, b[0] * ow, b[1] * od, 0],
    [y - half * 0.20, s0[0] * ow * 0.955, s0[1] * od * 0.955, 0],
    [y - half * 0.14, s0[0] * ow * 0.955, s0[1] * od * 0.955, em * 0.5],
    [y, s0[0] * ow * 0.950, s0[1] * od * 0.950, em],
    [y + half * 0.14, s1[0] * ow * 0.955, s1[1] * od * 0.955, em * 0.5],
    [y + half * 0.20, s1[0] * ow * 0.955, s1[1] * od * 0.955, 0],
    [y + half, c[0] * ow, c[1] * od, 0],
    [y + half * 2.0, d[0], d[1], 0]);
  return st;
}

/**
 * A blade: a tapering shaft whose edges are a staircase rather than a straight
 * line. The steps are the scale cue. A smooth taper could be a metre tall or a
 * kilometre and the eye has no way to choose; twenty terraces give it something
 * to count, and counting is how anybody has ever judged the size of a cathedral.
 *
 * Every terrace is a vertical run, a chamfer and a tread — three stations, not
 * one line in a 2D shape — so each course takes the key at its own value and
 * the silhouette is notched rather than straight. Every third course carries a
 * proud collar, and the whole thing finishes in a chisel, because a flat cut is
 * where a blade stops reading as grown.
 */
function bladeStations(h, w0, w1, d0, steps) {
  const st = [];
  const wAt = (t) => w0 + (w1 - w0) * Math.pow(t, 0.82);
  const dAt = (t) => d0 * (0.58 + 0.42 * (wAt(t) / w0));
  const stepH = h / steps;
  st.push([-stepH * 0.34, w0 * 1.16, dAt(0) * 1.16, 0]);   // a splayed foot
  st.push([-stepH * 0.10, w0 * 1.16, dAt(0) * 1.16, 0]);
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const wi = wAt(t0), wn = wAt(t1), di = dAt(t0), dn = dAt(t1);
    const y0 = h * t0, y1 = h * t1;
    const cH = Math.min(stepH * 0.34, di * 0.62);
    st.push([y0, wi, di, 0]);
    if (i % 3 === 1 && i < steps - 1) {
      const yb = y0 + stepH * 0.30, hb = stepH * 0.26, cb = stepH * 0.09;
      st.push([yb - cb, wi, di, 0]);
      st.push([yb, wi * 1.085, di * 1.17, 0]);
      st.push([yb + hb, wi * 1.085, di * 1.17, 0]);
      st.push([yb + hb + cb, wi, di, 0]);
    }
    st.push([y1 - cH, wi, di, 0]);
    st.push([y1, wn, dn, 0]);
  }
  const wT = wAt(1), dT = dAt(1);
  st.push([h + wT * 1.7, wT * 0.40, dT * 0.09, 0]);        // a chisel, not a cut
  return st;
}

function bladeGeo(h, w0, w1, depth, steps, o = {}) {
  const st = bladeStations(h, w0, w1, depth, steps);
  // Collars go in from the top down, so an earlier splice cannot move the
  // station a later one was aiming at.
  for (const y of (o.bearings || []).slice().sort((a, b) => b - a)) {
    collar(st, y, Math.min(h * 0.035, 0.13), 1.28, 1.32, o.emit === undefined ? 0.10 : o.emit);
  }
  return loft(o.sect || BLADE_SECT, st, true, true);
}

/* Debris: a chamfered splinter with a kink in it. Six stations and eight
   section points, because there are fifty of them and they are two hundred
   metres long — but not one primitive, because "default octahedron" was the
   review's word for what used to be here. */
function shardGeo(len, w, d) {
  return loft(RIB_SECT, [
    [0, w * 0.16, d * 0.16, 0],
    [len * 0.16, w * 0.92, d * 0.86, 0],
    [len * 0.30, w, d, 0],
    [len * 0.60, w * 0.74, d * 0.82, 0],
    [len * 0.66, w * 0.62, d * 0.68, 0],
    [len, w * 0.10, d * 0.08, 0],
  ], true, true);
}

export function buildResonator(seed, env) {
  const rnd = mulberry32(seed);
  const g = new THREE.Group();

  // Pale gold-green, and only ever this. It is the one saturated emissive in
  // the game, so it has to mean "Choir" everywhere it appears — a cyan
  // monolith reads as the same technology as the ship's own instrument panels.
  const glow = new THREE.Color(CHOIR_HUE).offsetHSL((rnd() - 0.5) * 0.035, 0.05, 0.04);

  const RING_R = 2.35;

  const mat = new THREE.ShaderMaterial({
    vertexShader: GLYPH_VERT, fragmentShader: GLYPH_FRAG,
    uniforms: {
      uTime: { value: 0 }, uCamPos: { value: new THREE.Vector3() },
      uGlow: { value: glow }, uActive: { value: 0 }, uSeed: { value: rnd() * 40 },
      uRingR: { value: RING_R },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uEnv: { value: env },
    },
  });

  /* A Resonator is architecture, not a prop. What reads is a *colonnade*:
     blades standing in a ring five kilometres across around a suspended core.
     That silhouette is legible from a hundred kilometres, it has an inside and
     an outside so you can fly through it, and the repetition is what makes it
     feel deliberate.

     The repetition is also what nearly killed it: seven identical blades at two
     alternating heights is a picket fence, and a picket fence has no front, no
     centre and no scale. What it needs is a *cascade* — a few enormous blades,
     a ring of small ones inside them, one snapped off at the base and one lying
     across the ring where it fell — so the eye has a sequence of sizes to walk
     down and lands on something it can measure.

     It is also the only structure in the game with no panel line, no weld and
     no running light anywhere on it. Everything that has to say "built" has to
     say it with section and chamfer instead. */
  const parts = [];
  const mtx = new THREE.Matrix4();
  const eul = new THREE.Euler();
  const q = new THREE.Quaternion();
  const KIND = { PLINTH: 0, BLADE: 1, CORE: 2, SHARD: 3 };
  const push = (geo, o) => {
    if (o.quat) q.copy(o.quat);
    else { const r = o.rot || [0, 0, 0]; q.setFromEuler(eul.set(r[0], r[1], r[2])); }
    const p = o.pos || [0, 0, 0];
    const s = o.sc === undefined ? 1 : o.sc;
    mtx.compose(new THREE.Vector3(p[0], p[1], p[2]), q, new THREE.Vector3(s, s, s));
    (o.into || parts).push({
      geo, matrix: mtx.clone(), seed: o.sd || 0, rk: o.rk, kind: o.kind || 0,
    });
  };

  const BLADES = 7;
  // one blade is a stump and one has come down: the two events that give the
  // ring a history and the frame a diagonal
  const fallen = 2 + Math.floor(rnd() * 3);
  const stump = (fallen + 3) % BLADES;
  for (let i = 0; i < BLADES; i++) {
    const a = (i / BLADES) * Math.PI * 2;
    // heights walk a sequence rather than alternating, so no two neighbours
    // agree and the ring has a tallest side
    const h = [6.6, 3.8, 5.2, 7.2, 4.1, 5.9, 3.3][i] * (0.93 + rnd() * 0.14);
    const sd = rnd();
    const px = Math.cos(a) * RING_R, pz = Math.sin(a) * RING_R;
    const steps = Math.max(5, Math.min(14, Math.round(h * 1.9)));
    const lean = 0.055;
    const rot = [-Math.sin(a) * lean, -a, Math.cos(a) * lean];
    // The collars go where the blade actually passes through the ring — one
    // above the crown and one under the soffit. That is the bearing, and it is
    // also where the blade takes its feed off the conduit.
    const bearings = [h * 0.5 + 0.31, h * 0.5 - 0.37];
    if (i === stump) {
      // snapped off just above the ring, with the break left ragged
      push(bladeGeo(h * 0.58, 0.36, 0.26, 0.30, 6, { bearings }),
        { pos: [px, -h * 0.5, pz], rot, sd, kind: KIND.BLADE });
      for (let k = 0; k < 5; k++) {
        push(slab(0.10 + rnd() * 0.16, 0.05 + rnd() * 0.20, 0.24, 0.05), {
          pos: [px + (rnd() - 0.5) * 0.5, h * 0.08 + rnd() * 0.14, pz + (rnd() - 0.5) * 0.5],
          rot: [rnd() * 3, -a + (rnd() - 0.5), rnd() * 0.6], sd, kind: KIND.BLADE,
        });
      }
      continue;
    }
    if (i === fallen) {
      // down across the ring, buried at the near end
      push(bladeGeo(h * 0.86, 0.36, 0.09, 0.30, 11, { bearings: [0.5], emit: 0.07 }), {
        pos: [px * 0.98, -h * 0.5 + 0.14, pz * 0.98],
        rot: [Math.PI * 0.5 - 0.10, -a + 0.22, 0.0], sd, kind: KIND.BLADE,
      });
      continue;
    }
    push(bladeGeo(h, 0.36, 0.07, 0.30, steps, { bearings }),
      { pos: [px, -h * 0.5, pz], rot, sd, kind: KIND.BLADE });
    // a raised central rib, proud of both faces, running most of the height
    push(bladeGeo(h * 0.94, 0.11, 0.03, 0.42, Math.max(4, Math.round(steps * 0.55)),
      { sect: RIB_SECT, bearings, emit: 0.11 }),
    { pos: [px, -h * 0.5, pz], rot, sd, kind: KIND.BLADE });
  }

  /* An inner ring of small blades. The cascade from a seven kilometre blade
     down to a seven hundred metre one is what makes the seven kilometre blade
     read as seven kilometres. */
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.31;
    const h = 1.05 + rnd() * 0.75;
    const r = RING_R * 0.44;
    push(bladeGeo(h, 0.12, 0.03, 0.11, 5, { sect: RIB_SECT, bearings: [h * 0.5], emit: 0.10 }), {
      pos: [Math.cos(a) * r, -h * 0.5, Math.sin(a) * r], rot: [0, -a, 0],
      sd: rnd(), kind: KIND.BLADE,
    });
  }

  /* ---- the plinth --------------------------------------------------------
     A moulded ring, turned from a profile, rather than five stacked tori. The
     tori were the loudest single defect on this object: eight radial segments
     put a visible octagon along the crown, and blade-scale fluting running over
     a part fifteen times larger landed as a chevron band that read as tread off
     a tractor tyre.

     All the architecture lives in the profile — an outer fascia, two courses of
     tread and riser with a chamfer on every arris, a crown, and the conduit
     groove cut into the top of it. The groove is the ring's half of the
     lighting circuit and the only part of the plinth allowed to emit. */
  {
    const R = RING_R, E = 0.80;
    const prof = [
      [R + 0.340, -0.300, 0], [R + 0.340, 0.020, 0], [R + 0.300, 0.070, 0],
      [R + 0.240, 0.085, 0], [R + 0.240, 0.135, 0], [R + 0.205, 0.175, 0],
      [R + 0.135, 0.195, 0], [R + 0.135, 0.245, 0], [R + 0.100, 0.280, 0],
      [R + 0.050, 0.292, 0], [R + 0.026, 0.268, 0], [R + 0.019, 0.262, E*0.5],
      [R, 0.2585, E], [R - 0.019, 0.259, E*0.5], [R - 0.026, 0.266, 0],
      [R - 0.050, 0.292, 0], [R - 0.100, 0.280, 0], [R - 0.135, 0.245, 0],
      [R - 0.135, 0.100, 0], [R - 0.200, 0.050, 0], [R - 0.200, -0.300, 0],
    ];
    // The ring thickens at every blade station, because that is where the load
    // is. Constant section is what a torus primitive has.
    push(revolve(prof, 112, true, [0.004, BLADES, 0]),
      { pos: [0, -0.02, 0], rk: 0.16, sd: 0.5, kind: KIND.PLINTH });
    for (let i = 0; i < BLADES; i++) {
      const a = (i / BLADES) * Math.PI * 2;
      // radial ties from the plinth in to the core
      push(slab(RING_R * 0.92, 0.035, 0.14, 0.017), {
        pos: [Math.cos(a) * RING_R * 0.54, -0.12, Math.sin(a) * RING_R * 0.54],
        rot: [0, -a, 0], rk: 0.20, sd: 0.2, kind: KIND.PLINTH,
      });
      // and an outboard knee under each blade station, so the ring is visibly
      // carrying something rather than floating past it
      push(loft(boxSect(0.34, 0.34), [
        [0, 0.230, 0.160, 0], [0.05, 0.215, 0.152, 0],
        [0.34, 0.095, 0.090, 0], [0.40, 0.055, 0.060, 0],
      ], true, true), {
        pos: [Math.cos(a) * (RING_R + 0.30), -0.34, Math.sin(a) * (RING_R + 0.30)],
        rot: [0, -a, 0], rk: 0.45, sd: 0.3, kind: KIND.PLINTH,
      });
    }
  }

  /* ---- the core ----------------------------------------------------------
     Nothing holds it up. A lens in a gimbal of three turned rings, with eight
     apertures round it — and the apertures matter far more than they look,
     because a shaft of light with no source geometry at the end of it is the
     fastest way there is to say "this is a quad with a gradient on it". */
  const SHAFTS = [];
  {
    const lens = [
      [0.000, -0.500, 0], [0.100, -0.440, 0], [0.260, -0.260, 0], [0.365, -0.100, 0],
      [0.390, 0.000, 0], [0.365, 0.100, 0], [0.260, 0.260, 0], [0.100, 0.440, 0],
      [0.000, 0.500, 0],
    ];
    push(revolve(lens, 48, false, [0.022, 6, 0]), { rk: 0.42, sd: 0.9, kind: KIND.CORE });
    const t = 0.042, Rg = 0.78;
    const band = [
      [Rg - t, -t * 0.55, 0], [Rg - t * 0.5, -t, 0], [Rg + t * 0.5, -t, 0],
      [Rg + t, -t * 0.55, 0], [Rg + t, t * 0.55, 0], [Rg + t * 0.5, t, 0],
      [Rg - t * 0.5, t, 0], [Rg - t, t * 0.55, 0],
    ];
    for (const r of [[0, 0, 0], [Math.PI / 2, 0, 0.22], [0.18, 0, Math.PI / 2]]) {
      push(revolve(band, 56, true), { rot: r, rk: 0.5, sd: 0.7, kind: KIND.CORE });
    }

    /* The apertures, and the shafts that leave through them. The profile folds
       back on itself at the lip so the throat has an inside wall you can see
       down — which is where the emissive is, so the light reads as coming out
       of something rather than as starting in mid-air. */
    const mouth = [
      [0.000, -0.010, 0], [0.115, -0.010, 0], [0.130, 0.020, 0], [0.112, 0.090, 0],
      [0.098, 0.135, 0], [0.086, 0.150, 0], [0.070, 0.150, 0], [0.058, 0.132, 0.45],
      [0.052, 0.060, 0.80], [0.048, 0.030, 1.05], [0.024, 0.027, 1.45], [0.000, 0.026, 1.70],
    ];
    const AP = 8;
    const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), qq = new THREE.Quaternion();
    for (let i = 0; i < AP; i++) {
      const a = (i / AP) * Math.PI * 2 + 0.19;
      const el = (rnd() - 0.5) * 0.85;
      dir.set(Math.cos(a) * Math.cos(el), Math.sin(el), -Math.sin(a) * Math.cos(el)).normalize();
      qq.setFromUnitVectors(up, dir);
      push(revolve(mouth, 24, false), {
        pos: [dir.x * 0.72, dir.y * 0.72, dir.z * 0.72], quat: qq,
        rk: 0.55, sd: 0.6, kind: KIND.CORE,
      });
      SHAFTS.push({
        src: dir.clone().multiplyScalar(0.86), dir: dir.clone(),
        len: 6.5 + rnd() * 5.0, rad: 0.070 + rnd() * 0.040,
      });
    }
    // and the column standing on the lens, both ways
    for (const s of [1, -1]) {
      SHAFTS.push({
        src: new THREE.Vector3(0, s * 0.44, 0), dir: new THREE.Vector3(0, s, 0),
        len: 11, rad: 0.15,
      });
    }
  }

  const monolith = new THREE.Mesh(mergeParts(parts), mat);
  monolith.frustumCulled = false;
  g.add(monolith);

  const coreMat = new THREE.ShaderMaterial({
    vertexShader: CORE_VERT, fragmentShader: CORE_FRAG,
    uniforms: {
      uGlow: { value: glow }, uTime: { value: 0 }, uActive: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
    },
  });
  const coreGlow = new THREE.Mesh(revolve([
    [0.000, -0.300, 0], [0.090, -0.250, 0], [0.180, -0.120, 0], [0.205, 0.000, 0],
    [0.180, 0.120, 0], [0.090, 0.250, 0], [0.000, 0.300, 0],
  ], 36, false), coreMat);
  /* The lens tracks the monolith's own clock rather than being wired into the
     frame loop separately: one structure, one activation, and nothing new for
     Game.js to remember to drive. */
  coreGlow.onBeforeRender = (r, s, cam) => {
    coreMat.uniforms.uCamPos.value.copy(cam.position);
    coreMat.uniforms.uTime.value = mat.uniforms.uTime.value;
    coreMat.uniforms.uActive.value = mat.uniforms.uActive.value;
  };
  g.add(coreGlow);

  /* ---- where the light in this thing actually lives ---------------------
     The monolith shades itself from the core analytically, but the *ship* and
     whatever rock is drifting past it cannot, and an alien reactor that does
     not touch the hull of the craft parked inside it is a lamp painted on a
     wall. This structure used to carry its own PointLight for that, at 3.4
     candela over 34 units — which works out to four per cent of the key at the
     distance you actually park at, i.e. nothing, and it charged every material
     in the scene for a second forward light to deliver it.

     So the structure no longer owns a light. It publishes where one should sit
     and what colour it should be, and the game loop parks its single roaming
     practical there. The lens hangs at the group's own origin, and the plinth
     conduit — the second source added in this rebuild — is a ring of light the
     same radius in every direction at once, which averages back to the same
     place, so the spec has not had to move.

       pos        local space, metres are already world units on this object
       color      lerped well toward white: at practical strength a saturated
                  hue stops reading as light and starts reading as a filter
                  over the frame, and the shading underneath it disappears.
                  What survives the lerp is still unmistakably Choir.
       intensity  irradiance at `radius`, not candela — the loop converts.
                  Calibrated against the key rather than picked: the star runs
                  between three and seven or so, a hull parks about nine units
                  off the core, and 1.25 at twelve units puts a quarter of the
                  key on its shadow side there. Under that it is not visible
                  and the whole exercise is pointless; far over it, every
                  material in frame goes the same green and the shading
                  underneath disappears.
       radius     the colonnade is five units across and the tallest blade is
                  seven, so twelve covers the whole structure and the space a
                  ship can sit in inside it. */
  const practical = {
    pos: new THREE.Vector3(0, 0, 0),
    color: glow.clone().lerp(new THREE.Color(1, 1, 1), 0.40),
    intensity: 1.25,
    radius: 12,
  };

  /* Shard rings — what the colonnade has been grinding off itself for forty
     thousand years, and the only things in frame small enough to be a metre
     stick. They used to be subdivided octahedra on a half-metal standard
     material, which under a raking key is one broad specular per flat facet:
     the plastic-bead read the house style forbids outright, and the review's
     word for it was "default primitives".

     They are cut from the same stone as the blades because they *are* the
     blades, so they take the same shader — three scales of surface, the thin
     film, the cold rim — with the feed switched off, since nothing shed off
     the ring is still connected to it. What catches the star is the dust on
     them, which is precisely the metre stick that was wanted. */
  const rings = [];
  for (let r = 0; r < 3; r++) {
    const ring = new THREE.Group();
    const list = [];
    const n = 14 + Math.floor(rnd() * 8);
    const rad = RING_R * (0.62 + r * 0.26);
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + rnd() * 0.5;
      const sc = 0.05 + rnd() * 0.10;
      push(shardGeo(sc * (2.0 + rnd() * 3.4), sc * 0.52, sc * 0.36), {
        pos: [Math.cos(ang) * rad, (rnd() - 0.5) * 3.4, Math.sin(ang) * rad],
        rot: [rnd() * 6, rnd() * 6, rnd() * 6],
        rk: 1.7, sd: rnd(), kind: KIND.SHARD, into: list,
      });
    }
    const m = new THREE.Mesh(mergeParts(list), mat);
    m.frustumCulled = false;
    ring.add(m);
    ring.userData.rate = (r % 2 ? -1 : 1) * (0.05 + rnd() * 0.09);
    ring.rotation.x = (rnd() - 0.5) * 0.45;
    rings.push(ring);
    g.add(ring);
  }

  /* The conduit, seen from far enough out that the groove itself is sub-pixel
     — which is to say from anywhere you first catch sight of this thing. A
     sub-pixel emissive is not dim, it is absent, so the ring keeps a taut wire
     of its own that never falls below about a pixel and a half. */
  const haloMat = new THREE.MeshBasicMaterial({
    color: glow.clone().multiplyScalar(4), transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(RING_R, 0.013, 5, 150), haloMat);
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.24;
  halo.renderOrder = 9;
  g.add(halo);

  /* ---- volumetrics ------------------------------------------------------
     One merged additive mesh carrying every shaft. The geometry is a proxy and
     the shape is integrated analytically per fragment — see SHAFT_FRAG. */
  const beamMat = new THREE.ShaderMaterial({
    vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.FrontSide, toneMapped: false,
    uniforms: {
      uGlow: { value: glow }, uTime: { value: 0 }, uActive: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
    },
  });
  {
    const geos = [];
    const up = new THREE.Vector3(0, 1, 0), qq = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4();
    for (const s of SHAFTS) {
      const r0 = s.rad * 2.5, r1 = s.rad * 4.2 * 2.5;
      const cone = revolve([[0, 0, 0], [r0, 0, 0], [r1, s.len, 0], [0, s.len, 0]], 12, false);
      qq.setFromUnitVectors(up, s.dir);
      m4.compose(s.src, qq, one);
      cone.applyMatrix4(m4);
      const c = cone.attributes.position.count;
      const src = new Float32Array(c * 3), ax = new Float32Array(c * 3), pr = new Float32Array(c * 2);
      for (let k = 0; k < c; k++) {
        src[k * 3] = s.src.x; src[k * 3 + 1] = s.src.y; src[k * 3 + 2] = s.src.z;
        ax[k * 3] = s.dir.x; ax[k * 3 + 1] = s.dir.y; ax[k * 3 + 2] = s.dir.z;
        pr[k * 2] = s.len; pr[k * 2 + 1] = s.rad;
      }
      cone.deleteAttribute('aEmit');
      cone.setAttribute('aSrc', new THREE.BufferAttribute(src, 3));
      cone.setAttribute('aAxis', new THREE.BufferAttribute(ax, 3));
      cone.setAttribute('aParam', new THREE.BufferAttribute(pr, 2));
      geos.push(cone);
    }
    let total = 0;
    for (const geo of geos) total += geo.attributes.position.count;
    const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3);
    const src = new Float32Array(total * 3), ax = new Float32Array(total * 3);
    const pr = new Float32Array(total * 2);
    let o = 0;
    for (const geo of geos) {
      const c = geo.attributes.position.count;
      pos.set(geo.attributes.position.array, o * 3);
      nrm.set(geo.attributes.normal.array, o * 3);
      src.set(geo.attributes.aSrc.array, o * 3);
      ax.set(geo.attributes.aAxis.array, o * 3);
      pr.set(geo.attributes.aParam.array, o * 2);
      o += c;
      geo.dispose();
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    bg.setAttribute('aSrc', new THREE.BufferAttribute(src, 3));
    bg.setAttribute('aAxis', new THREE.BufferAttribute(ax, 3));
    bg.setAttribute('aParam', new THREE.BufferAttribute(pr, 2));
    const beam = new THREE.Mesh(bg, beamMat);
    beam.renderOrder = 9;
    beam.onBeforeRender = (r, s, cam) => { beamMat.uniforms.uCamPos.value.copy(cam.position); };
    g.add(beam);
  }

  g.traverse((o) => { o.frustumCulled = false; });
  /* `userData.glow` has been the Choir colour on this object since long before
     the practical existed and Game.js reads the spec from `userData.practical`,
     so the spec is also hung off the returned group as `.glow` — one object,
     two handles, no second source of truth and no name collision. */
  g.userData = { mat, beamMat, coreMat, rings, glow, halo, practical, kind: 'resonator' };
  g.glow = practical;
  return g;
}

/* ------------------------------------------------------------- derelict */

/* A cold plume out of a rupture. Whatever was still pressurised in there forty
   thousand years ago is still leaving, one molecule at a time, and it is the
   only thing on the whole hull that moves. */
const VENT_VERT = /* glsl */`${LOGD_V_PARS}
attribute float aFade;
varying float vFade; varying vec3 vW; varying vec3 vN; varying vec3 vObj;
void main(){
  vFade = aFade; vObj = position;
  vec4 wp = modelMatrix*vec4(position,1.0);
  vW = wp.xyz; vN = normalize(mat3(modelMatrix)*normal);
  gl_Position = projectionMatrix*viewMatrix*wp;
  ${LOGD_V}
}
`;
const VENT_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
varying float vFade; varying vec3 vW; varying vec3 vN; varying vec3 vObj;
uniform vec3 uCol; uniform vec3 uCamPos; uniform float uTime;
void main(){
  ${LOGD_F}
  vec3 V = normalize(uCamPos - vW);
  float graze = pow(1.0 - abs(dot(normalize(vN), V)), 1.6);
  float churn = fbm(vObj*0.055 + vec3(0.0, -uTime*0.35, 0.0), 3);
  float a = vFade*vFade*vFade*graze*(0.25 + churn*0.9)*0.075;
  gl_FragColor = vec4(uCol*a, 1.0);
}
`;

/* ---------------------------------------------------------- breaking things

   A derelict starts life as `buildStation(dead: true)` and that is the right
   place to start — the two share a yard, a plating law and a livery, and the
   moment a player recognises the *architecture* the corpse means something.

   What it cannot share is a silhouette. A dead station that still owns its
   circle reads as the live one with the lights off, which is the loudest way
   there is to say "these are the same asset"; the wheel has to stop being a
   wheel at thumbnail size, from every angle, before any amount of soot helps.

   Everything below is the machinery for taking the finished station apart. */

const TWO_PI = Math.PI * 2;
const wrapT = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
/** Shortest angular separation, 0..PI. Continuous across the wrap, which is
    the only reason the deformation field below does not crack at u = 0. */
const arcGap = (a, b) => { const d = wrapT(a - b); return d > Math.PI ? TWO_PI - d : d; };
const sstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const dHash = (a, b, c) => {
  const s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

/** A geometry from a flat triangle soup, pushed through a warp on the way in. */
function fromTris(arr, warp, uv) {
  const pos = new Float32Array(arr.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < arr.length; i += 3) {
    v.set(arr[i], arr[i + 1], arr[i + 2]);
    if (warp) warp(v);
    pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  // Everything the greeble kit welds is non-indexed, so this is a flat normal
  // per face — exactly what the mesh already had before it was carved.
  g.computeVertexNormals();
  return g;
}

/**
 * Rewrite one merged mesh in place against a fracture plan.
 *
 * `fate` is asked once per *triangle*, from its centroid: 1 keeps it, 0 deletes
 * it, and −n hands it to bucket n−1 in its original coordinates. `warp` then
 * moves every surviving *vertex*.
 *
 * That split is the whole trick. Cutting per vertex opens holes along every
 * plate seam; moving whole triangles rigidly leaves a staircase down every
 * fold. Cutting per triangle and bending per vertex gives a ragged tear and an
 * unbroken surface, and it works on geometry that was merged an hour ago by
 * code this file is not allowed to touch.
 */
function carve(mesh, fate, warp, buckets) {
  /* Almost everything the kit welds is non-indexed, because `place` de-indexes
     on the way in — but the glazing is merged straight from PlaneGeometry and
     comes back indexed, and read as a triangle soup that is a pane of glass
     with its corners in the wrong places. */
  const flat = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const geo = flat;
  const src = geo.attributes.position.array;
  const suv = geo.attributes.uv ? geo.attributes.uv.array : null;
  const tris = (src.length / 9) | 0;
  const keep = [], kuv = [];
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const f = fate((src[o] + src[o + 3] + src[o + 6]) / 3,
      (src[o + 1] + src[o + 4] + src[o + 7]) / 3,
      (src[o + 2] + src[o + 5] + src[o + 8]) / 3);
    if (f === 0) continue;
    if (f < 0) {
      const b = buckets && buckets[-f - 1];
      if (b) for (let k = 0; k < 9; k++) b.push(src[o + k]);
      continue;
    }
    for (let k = 0; k < 9; k++) keep.push(src[o + k]);
    if (suv) for (let k = 0; k < 6; k++) kuv.push(suv[t * 6 + k]);
  }
  if (flat !== mesh.geometry) flat.dispose();
  mesh.geometry.dispose();
  if (!keep.length) { mesh.removeFromParent(); return; }
  mesh.geometry = fromTris(keep, warp, suv ? kuv : null);
}

/** Push an already-welded mesh through the same warp, so bolted-on parts land
    where the hull they belong to actually ended up. */
function warpMesh(mesh, warp) {
  if (!mesh) return;
  const attr = mesh.geometry.attributes.position;
  const a = attr.array, v = new THREE.Vector3();
  for (let i = 0; i < a.length; i += 3) {
    v.set(a[i], a[i + 1], a[i + 2]);
    warp(v);
    a[i] = v.x; a[i + 1] = v.y; a[i + 2] = v.z;
  }
  attr.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

/**
 * A derelict is the same *architecture* as a living station and none of its
 * shape. The builder hands over a corpse — no light, no paint, one arm short,
 * half an array — and everything here is the accident on top of it:
 *
 *   the wheel loses nearly half of itself in two bites, and what is left no
 *   longer lies in a plane: a long arc still bolted to three spokes, and a
 *   short one swung out of true on the single strut still holding it;
 *   the spokes that used to carry the missing hull end in nothing;
 *   the spine is folded where whatever did this went through it;
 *   three sections of wheel are tumbling a few hundred metres off;
 *   and the rest of it is a field spreading along the orbit.
 *
 * Nothing added here emits. The only light on it is the star, the world it
 * orbits, and the rim.
 */
export function buildDerelict(seed, env) {
  const rnd = mulberry32(seed);
  const built = buildStation(seed ^ 0x4dead, { dead: true });
  const g = built.root;
  const tear = built.tear;
  const R = tear.r, W = tear.w;
  const SPOKE_STEP = Math.PI / 3;                       // buildStation uses six

  /* ---- the fracture plan ------------------------------------------------
     Written in the wheel's own frame with u = 0 at the rupture the station
     builder already opened. Two survivors and two holes. The numbers are fixed
     rather than seeded: a wreck that is *sometimes* unrecognisable is a wreck
     that failed, and the variation the eye actually reads comes from the tear
     the builder rolled, the spoke phase, and where everything ended up. */
  const base = tear.at;
  const span = tear.span;                               // 0.62 .. 1.17 rad
  const A0 = span + 0.62, A1 = Math.PI + 0.30;          // the long survivor
  const B0 = Math.PI + 1.16, B1 = TWO_PI - 0.50;        // the one on one strut
  const Bc = (B0 + B1) / 2, Bh = (B1 - B0) / 2;
  const inA = (u) => u >= A0 && u < A1;
  const inB = (u) => u >= B0 && u < B1;

  /* Which struts are still carrying something. The short arc is deliberately
     left hanging off exactly one of them — a section of ring swinging on a
     single spar says more about what happened here than any amount of soot. */
  const spokeU = [];
  for (let i = 0; i < 6; i++) spokeU.push(wrapT(i * SPOKE_STEP - base));
  let anchor = -1;
  for (let i = 0; i < 6; i++) {
    if (!inB(spokeU[i])) continue;
    if (anchor < 0 || arcGap(spokeU[i], Bc) < arcGap(spokeU[anchor], Bc)) anchor = i;
  }
  const spokeAlive = spokeU.map((u, i) => inA(u) || i === anchor);
  const anchorA = anchor >= 0 ? anchor * SPOKE_STEP : base + Bc;

  /* The four free ends, and which way the void lies from each. The lift sign
     alternates so the two ends of an arc peel opposite ways — a rigid tilt
     leaves a circle that is merely tipped, and a circle that is merely tipped
     still reads as a circle. */
  const ends = [
    { u: A0, s: 1, into: -1 }, { u: A1, s: -1, into: 1 },
    { u: B0, s: 1, into: -1 }, { u: B1, s: -1, into: 1 },
  ];
  const DEC = 1.05;                       // radians the spring-open decays over
  const LIFT = R * 0.30, FLARE = 0.13, BUCK = R * 0.035;
  const buckPh = rnd() * TWO_PI;
  const TILT = (0.58 + rnd() * 0.26) * (rnd() < 0.5 ? -1 : 1);

  /* The deformation field. Continuous in r, u and y everywhere — including
     across the wrap, which is why every angular term goes through arcGap and
     the buckle runs at an integer number of cycles. */
  const warpWheel = (v) => {
    const r = Math.hypot(v.x, v.z);
    if (r < 1e-4) return;
    const a = Math.atan2(v.z, v.x);
    const u = wrapT(a - base);
    const wr = sstep(R * 0.26, R * 0.82, r);         // the hub end holds still
    let lift = 0, flare = 0;
    for (const e of ends) {
      const k = Math.max(0, 1 - arcGap(u, e.u) / DEC);
      lift += e.s * LIFT * k * k;
      flare += FLARE * k * k;
    }
    lift += BUCK * Math.sin(3 * u + buckPh);         // a long buckle all round
    const rr = r * (1 + flare * wr);
    let x = Math.cos(a) * rr, y = v.y + lift * wr, z = Math.sin(a) * rr;

    // and the short arc swings about the strut still holding it
    const tw = TILT * (1 - sstep(Bh - 0.05, Bh + 0.55, arcGap(u, Bc))) * wr;
    if (tw !== 0) {
      const c = Math.cos(tw), s = Math.sin(tw);
      const ax = Math.cos(anchorA), az = Math.sin(anchorA);
      const px = x, py = y, pz = z;
      const d = px * ax + pz * az;                   // Rodrigues about (ax,0,az)
      x = px * c + (-az * py) * s + ax * d * (1 - c);
      y = py * c + (az * px - ax * pz) * s;
      z = pz * c + (ax * py) * s + az * d * (1 - c);
    }
    v.set(x, y, z);
  };

  /* Three sections of wheel that are no longer attached to anything. They are
     harvested in their *original* coordinates and moved by a parent transform
     rather than baked, because the ring's whole surface treatment is written in
     toroidal coordinates about the hub: bake the drift into the vertices and
     every plate seam, bay and stave on them turns to noise. */
  const chunkSpans = [
    [span + 0.10, span + 0.52],
    [TWO_PI - 0.44, TWO_PI - 0.06],
    [Math.PI + 0.42, Math.PI + 1.04],
  ];
  const buckets = chunkSpans.map(() => []);

  const fateWheel = (x, y, z) => {
    const r = Math.hypot(x, z);
    const aa = Math.atan2(z, x);
    if (r < R * 0.80) {
      // Nothing else in the wheel lives this far in, so this is a spoke. The
      // ones that used to reach the missing hull are snapped a little past
      // halfway, and the break steps across the spar rather than cutting it
      // off square.
      const i = ((Math.round(wrapT(aa) / SPOKE_STEP) % 6) + 6) % 6;
      if (spokeAlive[i]) return 1;
      return r < R * (0.34 + 0.24 * dHash(i * 7.3, Math.floor(y * 0.25), 3.1)) ? 1 : 0;
    }
    const u = wrapT(aa - base);
    if (inA(u) || inB(u)) return 1;
    for (let c = 0; c < chunkSpans.length; c++) {
      if (u >= chunkSpans[c][0] && u < chunkSpans[c][1]) return -(c + 1);
    }
    return 0;
  };

  for (const m of built.wheel.children.filter((c) => c.isMesh)) {
    // The dead glazing goes with whatever it is bolted to and never travels:
    // a torn-off section of ring has no windows left in it.
    carve(m, m.material === built.mats.palR.paint || m.material === built.mats.palR.metal
      || m.material === built.mats.palH.paint || m.material === built.mats.palM.paint
      ? fateWheel
      : (x, y, z) => (fateWheel(x, y, z) > 0 ? 1 : 0), warpWheel, buckets);
  }

  /* ---- the spine ---------------------------------------------------------
     Whatever opened the wheel went on through the hub. The forward half of the
     structure is folded off its own axis and the array beyond it is shredded:
     a hinge is worth more than a hundred separated parts because it is the one
     kind of damage that cannot be mistaken for how a thing was built. */
  const bendP = (0.30 + rnd() * 0.16) * (rnd() < 0.5 ? -1 : 1);
  const bendY = (0.10 + rnd() * 0.14) * (rnd() < 0.5 ? -1 : 1);
  const warpRoot = (v) => {
    const t = (v.z - 36) / 150;
    if (t <= 0) return;
    const k = Math.min(1.6, Math.pow(t, 1.4));
    const dz = v.z - 36;
    const cp = Math.cos(bendP * k), sp = Math.sin(bendP * k);
    const y1 = v.y * cp - dz * sp;
    const z1 = v.y * sp + dz * cp;
    const cy = Math.cos(bendY * k), sy = Math.sin(bendY * k);
    v.set(v.x * cy + z1 * sy, y1, 36 + (-v.x * sy + z1 * cy));
  };
  // Whole leaf sections gone rather than a speckle of missing triangles: the
  // array failed in bays, and a random per-triangle cull reads as a bug.
  const fateRoot = (x, y, z) => (z > 238 && dHash(Math.floor(x / 24), 1.7, 5.3) < 0.45 ? 0 : 1);
  for (const m of g.children.filter((c) => c.isMesh)) carve(m, fateRoot, warpRoot, null);

  const rip = new THREE.Group();

  /* ---- exposed frames ----------------------------------------------------
     Where the pressure hull went, the ring frames it hung on are still there.
     The hull stops, the skeleton runs on for another twenty degrees getting
     progressively more bent, and then that stops too — which is the single most
     legible way to say "this was torn, not built like this". */
  const ribs = [];
  for (const e of ends) {
    const n = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const a = base + e.u + e.into * (0.015 + i * 0.045);
      const wob = (rnd() - 0.5) * 0.7 * t;
      ribs.push(place(new THREE.TorusGeometry(W * 0.52, 1.0 + rnd() * 0.6, 5, 16,
        Math.max(0.7, Math.PI * (1.3 - t * 0.9 + rnd() * 0.4))), {
        pos: [Math.cos(a) * R, 0, Math.sin(a) * R],
        rot: [0, -a + wob, Math.PI / 2 + (rnd() - 0.5) * 0.6 * t],
      }));
      // stringers along the arc between the frames, and they go first
      if (i < n - 1 && rnd() < 0.9 - t * 0.7) {
        const a2 = base + e.u + e.into * (0.015 + (i + 1) * 0.045);
        const x0 = Math.cos(a) * R, z0 = Math.sin(a) * R;
        const x1 = Math.cos(a2) * R, z1 = Math.sin(a2) * R;
        const len = Math.hypot(x1 - x0, z1 - z0);
        const th = Math.atan2(x1 - x0, z1 - z0);
        for (const yy of [-W * 0.36, 0, W * 0.36]) {
          if (rnd() < 0.25) continue;
          ribs.push(place(new THREE.CylinderGeometry(0.8, 0.8, len * 1.02, 5), {
            pos: [(x0 + x1) / 2, yy, (z0 + z1) / 2], rot: [Math.PI / 2, th, 0],
          }));
        }
      }
    }
  }
  const ribMat = dress(new THREE.MeshStandardMaterial({
    color: 0x1c1a17, metalness: 0.88, roughness: 0.58, envMapIntensity: 0.9,
  }), { plate: 2.6, bleach: 0.12, soot: 1.0, edge: 0.22, brushed: 0.8 });
  warpMesh(weld(ribs, ribMat, rip), warpWheel);

  /* Torn plating still attached at one edge, peeled back off the frames. The
     hull did not vanish, it opened. */
  const peel = [];
  for (const e of ends) {
    for (let i = 0; i < 5; i++) {
      const a = base + e.u - e.into * (0.02 + rnd() * 0.34);
      const side = rnd() < 0.5 ? 1 : -1;
      const lift = 0.4 + rnd() * 1.2;
      peel.push(place(slab(10 + rnd() * 22, 0.5, 7 + rnd() * 14, 0.4), {
        pos: [Math.cos(a) * (R + side * W * 0.55), side * W * 0.42 * lift, Math.sin(a) * (R + side * W * 0.55)],
        rot: [(rnd() - 0.5) * 1.5, -a, side * (0.5 + rnd() * 1.0)],
      }));
    }
  }
  const plateMat = dress(new THREE.MeshStandardMaterial({
    color: 0x39332c, metalness: 0.30, roughness: 0.84, envMapIntensity: 0.9,
  }), { plate: 3.2, bleach: 0.55, soot: 0.9, edge: 0.30 });
  warpMesh(weld(peel, plateMat, rip), warpWheel);

  /* ---- what came off -----------------------------------------------------
     Three sections of ring, hab blocks and all, tumbling at their own rate a
     few hundred metres out. Each is one mesh under one group; the group's
     transform is rebuilt every frame from absolute time so it is idempotent
     however many passes the frame ends up with. */
  const seen = new THREE.Vector3();
  for (let i = 0; i < buckets.length; i++) {
    const raw = buckets[i];
    if (raw.length < 90) continue;
    const grp = new THREE.Group();
    const mesh = new THREE.Mesh(fromTris(raw, null, null), built.mats.palR.paint);
    // Its transform is written in onBeforeRender, which runs after the cull
    // test — so it can never be culled against a matrix that is up to date.
    grp.userData.tumbling = true;
    grp.add(mesh);

    const ac = base + (chunkSpans[i][0] + chunkSpans[i][1]) / 2;
    const C = new THREE.Vector3(Math.cos(ac) * R, 0, Math.sin(ac) * R);
    const tan = new THREE.Vector3(-Math.sin(ac), 0, Math.cos(ac));
    const rad = new THREE.Vector3(Math.cos(ac), 0, Math.sin(ac));
    // Mostly along the orbit, because that is the direction anything separating
    // from a ring at these speeds actually goes.
    const D = new THREE.Vector3()
      .addScaledVector(tan, (rnd() < 0.5 ? -1 : 1) * R * (0.42 + rnd() * 0.62))
      .addScaledVector(rad, (rnd() - 0.5) * R * 0.55);
    D.y = (rnd() - 0.5) * R * 0.70;
    const axis = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const rate = (rnd() < 0.5 ? -1 : 1) * (0.030 + rnd() * 0.055);
    const ph0 = rnd() * TWO_PI;
    const q = new THREE.Quaternion();
    mesh.onBeforeRender = () => {
      q.setFromAxisAngle(axis, ph0 + performance.now() * 0.001 * rate);
      // pivot about where the section used to sit, then drift
      seen.copy(C).applyQuaternion(q).negate().add(C).add(D);
      grp.quaternion.copy(q);
      grp.position.copy(seen);
      grp.updateMatrixWorld(true);
    };
    g.add(grp);
  }

  /* ---- the field ---------------------------------------------------------
     Most of what sells the size of a wreck is not the wreck. Everything that
     used to be in those two arcs is on the same orbit and still spreading along
     it, and it is the only thing in frame small enough to be a metre stick — so
     it gets more parts than the hull does.

     Three populations, because one uniform scatter reads as static: a spray
     still leaving the rupture, a long lens drifting through the hulk, and a
     slow near cloud of the heavy pieces that never got away. Two materials, so
     the cloud has a value range instead of one grey — chalky plate that catches
     the key and burnt structure that does not. */
  const chalk = [], burnt = [];
  const rupA = base + span * 0.5;
  const rupP = new THREE.Vector3(Math.cos(rupA) * R, 0, Math.sin(rupA) * R);
  const driftV = new THREE.Vector3(-Math.sin(rupA), 0.14, Math.cos(rupA)).normalize();
  const sideV = new THREE.Vector3(Math.cos(rupA), 0, Math.sin(rupA));
  const p = new THREE.Vector3();
  for (let i = 0; i < 300; i++) {
    const pop = rnd();
    let s;
    if (pop < 0.34) {
      // spall out of the rupture: a cone, the small pieces thrown farthest
      const t = Math.pow(rnd(), 0.75);
      p.set(Math.cos(rupA), 0, Math.sin(rupA))
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), (rnd() - 0.5) * 1.2);
      p.y = (rnd() - 0.5) * 0.9;
      p.normalize().multiplyScalar(R * (0.18 + t * 1.9)).add(rupP);
      s = 0.8 + (1 - t) * (1 + rnd() * 6);
    } else if (pop < 0.78) {
      // the lens: a long shallow drift through the wreck, not a ring around it
      const t = rnd() * 2 - 1;
      p.set(0, 0, 0)
        .addScaledVector(driftV, t * R * 2.2)
        .addScaledVector(sideV, (rnd() - 0.5) * R * (0.55 + Math.abs(t) * 0.9));
      p.y += (rnd() - 0.5) * R * (0.3 + Math.abs(t) * 0.55);
      s = 1.2 + Math.pow(rnd(), 2.2) * 18;
    } else {
      // the heavy near cloud, still inside the wreck's own volume
      const th = rnd() * TWO_PI, el = Math.acos(2 * rnd() - 1);
      const d = R * (0.45 + rnd() * 0.85);
      p.set(Math.sin(el) * Math.cos(th) * d, Math.cos(el) * d * 0.55, Math.sin(el) * Math.sin(th) * d);
      s = 2.5 + Math.pow(rnd(), 2.0) * 22;
    }
    const pos = [p.x, p.y, p.z];
    const rot = [rnd() * 6, rnd() * 6, rnd() * 6];
    const list = rnd() < 0.42 ? chalk : burnt;
    /* The shape mix carries as much of the read as the count does. A field of
       boxes is a pile of crates however well it is lit; what says "this was
       built and then it wasn't" is a *curved* section of tube, a girder, and a
       torn sheet with an aspect ratio no factory ever cut. Boxes are here for
       the small hardware and because they are twelve triangles — and only for
       the small hardware: a thirty metre cube of clean plate a hundred metres
       from the camera is a cardboard carton, whatever is painted on it. */
    const k = s > 9 ? 0.22 + rnd() * 0.78 : rnd();
    if (k < 0.22) {
      list.push(place(new THREE.BoxGeometry(s * (0.5 + rnd()), s * (0.3 + rnd() * 0.6), s * (0.4 + rnd())), { pos, rot }));
    } else if (k < 0.44) {
      list.push(place(slab(s * (0.7 + rnd() * 1.3), s * (0.10 + rnd() * 0.28), s * (0.6 + rnd()), s * 0.07), { pos, rot }));
    } else if (k < 0.62) {
      list.push(place(new THREE.CylinderGeometry(s * 0.17, s * 0.17, s * (1.4 + rnd() * 2.6), 6), { pos, rot }));
    } else if (k < 0.78) {
      /* Ring fragments. A curved section of hull among the rubble is the one
         shape that says what this debris used to be, and it costs eighty
         triangles. */
      list.push(place(new THREE.TorusGeometry(s * 1.7, s * 0.26, 5, 8, 0.8 + rnd() * 1.5), { pos, rot }));
    } else if (k < 0.90) {
      // a girder out of the truss, bent
      list.push(place(slab(s * (2.6 + rnd() * 1.8), s * 0.20, s * 0.24, s * 0.06), { pos, rot }));
    } else {
      // array panel: thick enough not to be a sub-pixel line edge-on
      list.push(place(slab(s * 2.2, Math.max(0.45, s * 0.05), s * 0.9, 0.2), { pos, rot }));
    }
  }
  weld(chalk, dress(new THREE.MeshStandardMaterial({
    color: 0x585047, metalness: 0.16, roughness: 0.84, envMapIntensity: 1.0,
  }), { plate: 3.6, bleach: 0.6, soot: 0.8, edge: 0.35 }), rip);
  weld(burnt, dress(new THREE.MeshStandardMaterial({
    color: 0x22201d, metalness: 0.72, roughness: 0.52, envMapIntensity: 1.1,
  }), { plate: 2.4, bleach: 0.1, soot: 1.0, edge: 0.45, brushed: 0.9 }), rip);

  /* No scale here. The station root already carries the metres-to-world-units
     factor and everything above is modelled in metres, so scaling the rip
     group again put the entire debris field at one millionth of its size —
     which is why there had never been any visible wreckage. */
  g.add(rip);

  /* The vent. One plume out of a fracture edge, and the only thing on the whole
     corpse that moves under its own steam. */
  {
    const va = base + ends[0].u - 0.05;
    // Short and faint. At six hundred metres and full strength this read as a
    // searchlight, which is the one thing a corpse must not have.
    const len = 210, r0 = 3, r1 = 34;
    const cg = new THREE.CylinderGeometry(r1, r0, len, 12, 1, true);
    cg.translate(0, len / 2, 0);
    const c = cg.attributes.position.count;
    const f = new Float32Array(c);
    const pv = cg.attributes.position.array;
    for (let k = 0; k < c; k++) f[k] = Math.max(0, 1 - pv[k * 3 + 1] / len);
    cg.setAttribute('aFade', new THREE.BufferAttribute(f, 1));
    const vm = new THREE.ShaderMaterial({
      vertexShader: VENT_VERT, fragmentShader: VENT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, toneMapped: false,
      uniforms: {
        uCol: { value: new THREE.Color(0x9fc0d8) },
        uCamPos: { value: new THREE.Vector3() }, uTime: { value: 0 },
      },
    });
    const vent = new THREE.Mesh(cg, vm);
    // sits on the warped hull, not on the circle the hull used to be
    const vp = new THREE.Vector3(Math.cos(va) * R, 0, Math.sin(va) * R);
    warpWheel(vp);
    vent.position.copy(vp);
    vent.rotation.set(0, -va, -Math.PI * 0.5);
    vent.renderOrder = 8;
    vent.frustumCulled = false;
    vent.onBeforeRender = (r, s, cam) => {
      vm.uniforms.uCamPos.value.copy(cam.position);
      vm.uniforms.uTime.value = performance.now() * 0.001;
    };
    g.add(vent);
  }

  /* ---- shadows -----------------------------------------------------------
     The corpse inherits `buildStation`'s cast/receive flags on everything it
     carved, which is most of what this hull needed: the trusses cross the
     spine, the surviving arc crosses the hub, the folded bow crosses the tank
     farm, and until now none of those crossings marked the thing behind it. A
     wreck with no self-shadowing reads as a *diagram* of a wreck — separate
     pieces, each evenly lit, floating at the same depth.

     What is added here is the accident: exposed ring frames, peeled plating,
     and three hundred pieces of debris. The debris in particular is the whole
     reason to do this — a field of rubble that shadows itself and the hulk it
     came out of is a volume of wreckage, and one that does not is a decal.

     Culling is by whether a thing holds still relative to the hulk. The carved
     hull and the rip group do, so they may be culled and cost nothing when the
     derelict is off the lens. The three tumbling sections write their group
     transform in `onBeforeRender`, which runs *after* the cull test, so they
     would be tested against last frame's matrix; and the vent is a shader
     billboard whose bounds mean nothing. Both stay unculled. */
  g.traverse((o) => {
    if (!o.isMesh) return;
    const loose = !!(o.parent && o.parent.userData.tumbling);
    if (loose || o.parent === rip) { o.castShadow = true; o.receiveShadow = true; }
    o.frustumCulled = !loose && !o.material.transparent;
  });
  g.userData = {
    kind: 'derelict',
    /* A flat tumble about one axis with a slow precession on top. Nothing has
       trimmed this for forty thousand years, but nothing has spun it up either:
       whatever angular momentum the break left it with is all it has. */
    spin: new THREE.Vector3(
      (rnd() < 0.5 ? -1 : 1) * (0.013 + rnd() * 0.009),
      (rnd() - 0.5) * 0.006,
      (rnd() < 0.5 ? -1 : 1) * (0.004 + rnd() * 0.006)),
    /* Deliberately nothing. Every lamp, window and flood on this hull went out
       forty thousand years ago, so it asks the game loop for no practical: it
       is lit by the star, by whatever world it orbits, and by nothing else. */
    practical: null,
  };
  g.glow = null;
  return g;
}

export function buildWreck(seed) {
  const rnd = mulberry32(seed);
  const g = new THREE.Group();
  const pal = palette({ hue: 2, wear: 1.0, plate: 1.4 });
  pal.paint.color.multiplyScalar(0.5);
  const hull = [], burnt = [];
  const n = 9 + Math.floor(rnd() * 9);
  for (let i = 0; i < n; i++) {
    const kind = rnd();
    const pos = [(rnd() - .5) * 2.4, (rnd() - .5) * 1.2, (rnd() - .5) * 2.4];
    const rot = [rnd() * 6, rnd() * 6, rnd() * 6];
    const list = rnd() < 0.45 ? burnt : hull;
    if (kind < 0.45) list.push(place(slab(0.06 + rnd() * 0.5, 0.04 + rnd() * 0.16, 0.06 + rnd() * 0.3, 0.01), { pos, rot }));
    else if (kind < 0.72) list.push(place(new THREE.CylinderGeometry(0.03 + rnd() * 0.09, 0.03 + rnd() * 0.09, 0.2 + rnd() * 0.7, 8, 1, true), { pos, rot }));
    else list.push(place(new THREE.SphereGeometry(0.05 + rnd() * 0.12, 10, 7, 0, Math.PI * 1.4), { pos, rot }));
  }
  // a scatter of small fragments so a wreck has a field around it, not an edge
  for (let i = 0; i < 40; i++) {
    const s = 0.008 + rnd() * rnd() * 0.05;
    burnt.push(place(new THREE.BoxGeometry(s, s * (0.4 + rnd()), s * (0.4 + rnd())), {
      pos: [(rnd() - .5) * 6.5, (rnd() - .5) * 3.0, (rnd() - .5) * 6.5],
      rot: [rnd() * 6, rnd() * 6, rnd() * 6],
    }));
  }
  pal.paint.side = THREE.DoubleSide;
  pal.structure.side = THREE.DoubleSide;
  pal.structure.color.multiplyScalar(0.5);
  weld(hull, pal.paint, g);
  weld(burnt, pal.structure, g);
  g.traverse((o) => { o.frustumCulled = false; });
  g.userData = { kind: 'wreck', spin: new THREE.Vector3((rnd() - .5) * .06, (rnd() - .5) * .06, (rnd() - .5) * .06) };
  return g;
}

/* --------------------------------------------------------------- beacon */

export function buildBeacon(seed) {
  const rnd = mulberry32(seed);
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.85, roughness: 0.4, envMapIntensity: 1.2 });
  const parts = [place(new THREE.OctahedronGeometry(0.09, 1), {})];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(place(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 6), {
      pos: [Math.cos(a) * 0.16, 0, Math.sin(a) * 0.16],
      rot: [Math.sin(a) * 0.5, 0, Math.cos(a) * 0.5],
    }));
  }
  weld(parts, body, g);

  /* The lamp.

     It used to be 0x60ffc0 — a saturated green that is *not* CHOIR_HUE, on the
     one object in the game most likely to be seen next to a Resonator. That
     brushes the only colour rule the palette has: pale gold-green means Choir
     and nothing else, so a second saturated green a few degrees off it does not
     read as "a different thing", it reads as the same thing rendered wrong. A
     beacon is human-made, and human-made light here is cold white-blue.

     And it was at gain 6, which after the exposure floor and the pre-contrast
     curve is nowhere near the ~120 units AgX needs to return white — so it
     never clipped, never bloomed, and lit nothing. A navigation light that does
     not punch is a bright dot of paint. This one runs to a few hundred at the
     top of its pulse, which is what a strobe on a mast actually does.

     The pulse itself is written into this material's colour by the frame loop,
     which knows the level but has the hue hard-coded, so the hue has to be
     re-established after it. onBeforeRender is the one hook in this file that
     runs between the update and the draw. */
  const LAMP = new THREE.Color(0x9ec8ff);
  const lampMat = new THREE.MeshBasicMaterial({ color: LAMP.clone(), toneMapped: false });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), lampMat);
  lamp.position.y = 0.14;
  lamp.onBeforeRender = () => {
    const p = 0.5 + 0.5 * Math.sin(performance.now() * 0.0031 + seed);
    lampMat.color.copy(LAMP).multiplyScalar(24 + p * p * 300);
  };
  g.add(lamp);
  g.traverse((o) => { o.frustumCulled = false; });
  /* No `userData.practical`. The frame loop snaps its single roaming light to
     the *nearest* published source, and a beacon parked in front of a Resonator
     would take it off the Resonator — which is the one object in the game that
     has to be lighting its own surroundings. */
  g.userData = { kind: 'beacon', lamp, spin: new THREE.Vector3(0, 0.35, 0) };
  return g;
}
