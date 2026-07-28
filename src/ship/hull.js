import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  M, dress, slab, panel, place, weld, polished, emitter, skyLit,
  occupancy, bakeSurface, creaseNormals, loftBox, strut, HULL_LIGHT,
} from '../gfx/greeble.js';
import { LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';

/* ============================================================================
   PALE SEEKER — the hull.

   A long-duration survey vessel, modelled in metres and scaled to world units
   (1 unit = 1 km) at the very end. Read the silhouette front to back:

     hammerhead sensor prow · lit cockpit · truss neck · pressure hull ·
     swept radiator vanes · dorsal sail · engine outriggers · a survey dish
     offset to port

   Four rules shape it.

   **Silhouette first.** At the distance the chase camera actually sits, the
   hull is a few hundred pixels wide and every surface detail is sub-pixel. What
   survives is the outline, so the parts that define it — the hammerhead, the
   vane V, the sail, the splayed nacelles — are large, separated by empty space,
   and swept, so the ship reads as *facing* somewhere rather than as a cross.

   **A material story, not one moulded piece.** Four things a viewer can name:
   bone paint on the pressure vessel and the aerodynamic-looking parts; near
   black composite on everything that runs hot or takes the drive load; bare
   polished alloy on rings, rails and struts; glass you can see through. The
   value jump between the bone and the black is what stops the hull reading as
   a single extruded lump, and the polished alloy is the only thing on the ship
   allowed a hard specular hit.

   **Someone lives here.** The cockpit is glazed, lit, and has a pilot in it.
   Portholes are lit from inside. That is the one detail that connects the model
   to the cabin the player walks around in, and no amount of greebling
   substitutes for it.

   **One geometry per material.** See `gfx/greeble.js`; the surfacing, the
   markings and the merge convention all live there and are shared with every
   station and derelict in the game.
   ========================================================================== */

/* ============================================================ engine plume

   A fusion torch, and the thing that has to be true about it before anything
   else is that it is *hot*. After auto-exposure bottoms out and the
   pre-contrast curve has run, a pixel needs something like 120 units of scene
   radiance before AgX returns white — so a plume authored at 3, as this one
   was, can never clip and reads as a pale sticker whatever else is done to it.
   The core here runs past 200 at full throttle and clips; the skirt does not,
   which is the other half of the job — a torch that clips everywhere is a
   light meter problem, and it takes the hull down with it.

   The second thing is that it is a volume. The mesh is a cone of revolution,
   *added* rather than blended, and the shading is the chord the view ray cuts
   through it rather than the shell it happens to hit — see the note in the
   fragment shader. That is the whole difference between a plume and a
   lens-shaped decal: it is bright down the axis, thin at the edge, and it
   stays that way from every angle.

   The third is that it lights things. `plume` on the hull materials puts a
   segment source down the axis of each torch, which is what finally puts light
   inside the bells. */

const PLUME_VERT = /* glsl */`
${LOGD_V_PARS}
varying vec2 vUvP;
varying vec3 vNv;
varying vec3 vVv;
varying vec3 vAx;
void main(){
  vUvP = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vVv = -mv.xyz;                       // toward the eye, view space
  vNv = normalMatrix * normal;
  vAx = normalMatrix * vec3(0.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
${LOGD_V}
}
`;

const PLUME_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec2 vUvP;
varying vec3 vNv;
varying vec3 vVv;
varying vec3 vAx;
uniform float uTime;
uniform float uPower;
uniform vec3  uColA;      // throat, hottest
uniform vec3  uColB;      // cooled sheath
uniform vec3  uColC;      // the ionised fringe, coldest

float ph(vec2 p){ return fract(sin(dot(p, vec2(41.7, 289.3)))*43758.5453); }
float pn(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(ph(i), ph(i+vec2(1,0)), f.x),
             mix(ph(i+vec2(0,1)), ph(i+vec2(1,1)), f.x), f.y);
}

void main(){
  float t = clamp(vUvP.y, 0.0, 1.0);           // 0 at the throat -> 1 at the tip

  /* Throttle. Below about a twentieth there is no torch at all — only the
     throat core, which is the drive lit and idling. A plume that is always
     burning is a plume the eye stops reading, and a full-length one in a
     parked shot walks the auto-exposure down and takes the hull with it.
     Tested first because this cone is twenty-six metres long and covers a large
     part of the frame at chase distance: the idle case must not pay for the
     noise, and the branch is uniform, so it costs nothing when it is taken. */
  float pw = clamp(uPower, 0.0, 1.8);
  float lit = smoothstep(0.02, 0.30, pw);
  if (lit < 0.002) {
    gl_FragColor = vec4(0.0);
${LOGD_F}
    return;
  }
  pw = max(pw, 0.10);

  vec3 N = normalize(vNv), V = normalize(vVv), A = normalize(vAx);

  /* ---- the chord, not the shell ---------------------------------------
     For a convex body of revolution the length of gas a view ray crosses is
     2R|N.V| at the point where it enters, and that ray passes the axis at
     R.sqrt(1-(N.V)^2). So one dot product gives both how much plume is in
     front of this pixel and *where across the plume* it is — and because the
     cone is drawn double sided and added, the near and far faces sum to the
     whole chord for nothing. Shading a shell without this is limb-bright,
     which is exactly backwards: it draws a bright ring and a hollow middle.

     Looking straight down the axis is the one case the identity does not
     cover — N.V goes to zero all round the rim while the true chord is the
     whole remaining length of the torch — so it is blended out by how axial
     the view is. That is the view from dead astern, which is the view the
     plume has to survive. */
  float nv = abs(dot(N, V));
  float axial = abs(dot(A, V));
  float rr = sqrt(max(0.0, 1.0 - nv*nv));      // 0 on the axis, 1 at the edge
  float chord = mix(nv*0.92 + 0.08, 1.35, axial*axial*axial);

  /* Radial temperature. A fusion exhaust is not one colour: the collimated
     core is white with the blue barely in it, the sheath around it is where
     the recombination light comes from, and the outermost skirt is cold
     enough to go violet. */
  vec3 col = mix(uColA, uColB, smoothstep(0.05, 0.52, rr));
  col = mix(col, uColC, smoothstep(0.50, 1.0, rr));

  // Axial density: dense and collimated at the throat, thinning fast as the
  // flow expands and cools.
  float dens = pow(1.0 - t*0.97, 2.9);

  /* Standing shock cells. Closely spaced at the throat and stretching out as
     the flow expands, and only in the first third — a torch banded from end to
     end reads as corduroy. */
  float cell = 0.5 + 0.5*sin(pow(t, 0.70)*30.0 - uTime*8.0);
  cell *= smoothstep(0.40, 0.03, t) * (1.0 - rr*0.6);

  /* Turbulent break-up downstream, and a fast flicker near the throat. There
     is no scene texture to refract here so this stands in for heat shimmer:
     the density itself boils, which is what the eye reads as heat. One octave
     — this shader covers a large, doubled-up area of the frame and the second
     octave cost four sines a fragment for something nothing could see. */
  float turb = pn(vec2(t*8.0 - uTime*2.6, rr*3.4 + uTime*0.7));
  float boil = mix(1.0, 0.42 + turb*1.10, smoothstep(0.06, 0.72, t));
  float flick = 0.94 + 0.06*sin(uTime*41.0 + t*23.0);

  // radial falloff at the skirt, so the cone has no hard edge anywhere
  float skirt = 1.0 - smoothstep(0.55, 1.0, rr);

  /* One face, doubled. The chord identity wants the near and the far wall of
     the cone summed, and drawing the mesh double sided does that for free —
     but it also doubles the fragments, and at chase distance this quad was
     half the frame. The two walls carry very nearly the same |N.V| at the same
     pixel, so the near one is worth exactly two of itself. */
  float amt = dens * chord * skirt * boil * flick * pow(pw, 0.9) * lit * 2.0;
  /* And it *ends*. A torch that fades all the way to the far end of its mesh
     puts a large dim area in the frame, and a large dim area is exactly what
     auto-exposure meters on: the first cut had the hull at 84% black in a burn
     shot not because the core was too bright but because the tail was too big. */
  amt *= smoothstep(0.80, 0.06 + pw*0.30, t);
  /* Bright enough that the core clips — a frame in which nothing clips reads
     as flat — but no brighter. At 170 the torches were most of the light in
     the frame, auto-exposure stopped down to meet them, and a burn shot came
     back with the hull at 85% black. Clipping a thin core is the read; boiling
     the whole plume is a light meter problem. */
  vec3 rad = col * amt * 108.0 + uColA * cell * amt * 46.0;

  gl_FragColor = vec4(rad, 1.0);
${LOGD_F}
}
`;

/* ---------------------------------------------------------- the throat core
   The one part of the drive that must never be allowed to fall below a few
   pixels: a sub-pixel emissive is not dim, it is absent. A camera-facing quad
   deep in each bell, sized so the bell mouth always contains a hot core no
   matter what angle the ship is seen from, and occluded by the nozzle wall
   from the side the way the real thing would be. */
const THROAT_VERT = /* glsl */`
${LOGD_V_PARS}
attribute vec3 aCenter;
uniform float uSize;
uniform float uPower;
varying vec2 vQ;
void main(){
  vQ = uv;
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  mv.xy += position.xy * uSize * (0.74 + 0.34*clamp(uPower, 0.0, 1.8));
  gl_Position = projectionMatrix * mv;
${LOGD_V}
}
`;
const THROAT_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
uniform float uPower;
uniform vec3  uColA;
uniform vec3  uColB;
varying vec2 vQ;
void main(){
  vec2 d = vQ*2.0 - 1.0;
  float r = length(d);
  float m = step(r, 1.0);
  float core = pow(max(1.0 - r, 0.0), 3.6);
  float halo = pow(max(1.0 - r, 0.0), 1.3)*0.28;
  /* Idle is a *lit* drive, not a burning one. The exponent is what separates
     the two: a linear ramp made a parked ship look like it was under power,
     which is the same mistake as a plume that never goes out. */
  float pw = max(clamp(uPower, 0.0, 1.8), 0.10);
  vec3 c = mix(uColB, uColA, core);
  gl_FragColor = vec4(c * (core*250.0 + halo*40.0) * pow(pw, 1.45) * m, 1.0);
${LOGD_F}
}
`;

/* A cone of revolution with a barrel profile: it leaves the throat narrow,
   fills the bell, then necks down into a long collimated column. Normals are
   analytic rather than averaged, because a surface of revolution welded at the
   seam gets one bad column of normals and this shader reads the normal
   directly. */
function plumeCone(len, seg = 26, rings = 24) {
  const ss = (x) => { const u = Math.min(1, Math.max(0, x)); return u * u * (3 - 2 * u); };
  const prof = (t) => (1.68 + 1.20 * ss(t / 0.17)) * (1 - 0.87 * ss((t - 0.18) / 0.52));
  const g = new THREE.CylinderGeometry(1, 1, len, seg, rings, true);
  const p = g.attributes.position, n = g.attributes.normal;
  const h = 1 / (rings * 4);
  for (let i = 0; i < p.count; i++) {
    const cx = p.getX(i), cz = p.getZ(i), y = p.getY(i);
    const t = Math.min(1, Math.max(0, (y + len / 2) / len));
    const r = prof(t);
    const dr = (prof(Math.min(1, t + h)) - prof(Math.max(0, t - h))) / (2 * h);
    p.setX(i, cx * r); p.setZ(i, cz * r);
    const nx = len * cx, ny = -dr, nz = len * cz;
    const l = Math.hypot(nx, ny, nz) || 1;
    n.setXYZ(i, nx / l, ny / l, nz / l);
  }
  g.translate(0, len / 2, 0);
  g.rotateX(Math.PI / 2);
  return g;
}

/* ================================================================ markings
   Where the paint shop put the stencils. Rectangles in ship space; the kit
   projects the shared atlas into them. Every one is somewhere a real operator
   would put it: the name and number on the flank at eye height, the vessel
   name along the spine where a docking crew reads it from above, hull numbers
   on the engines, hazard chevrons on the doors that move, a squadron mark on
   the sail because that is the biggest flat panel on the ship. */

const MARKS_PAINT = [
  /* Registration stripe along both flanks of the pressure hull. It is on a
     14-sided drum, so it is unwrapped *cylindrically* rather than projected
     down X: a flat projector is right for a flank and wrong for a barrel, and
     past about thirty degrees of wrap the lettering stretches. It still stops
     short of the cryo tanks, which are a different barrel entirely. */
  {
    cell: 'reg', rect: [-19.5, -1.5],
    cyl: { c: [0, 0], r: 5.2, a0: -0.83, a1: -0.275, mirror: true },
  },
  // vessel name along the top of the dorsal housing              (z, x)
  { cell: 'name', plane: 'y', rect: [-16.5, -1.55, 5.5, 1.55], side: 1 },
  // squadron mark on the sail                                    (z, y)
  { cell: 'mark', plane: 'x', rect: [10.4, 7.6, 15.9, 13.1], both: true },
  // access hatch stencil, starboard flank only                   (z, y)
  { cell: 'hatch', plane: 'x', rect: [-9.0, -0.5, -5.8, 2.7], side: 1, flipU: true },
  // rescue arrow on the cheek fairings                           (z, y)
  { cell: 'arrow', plane: 'x', rect: [-49.5, -1.4, -44.5, 0.2], both: true },
];

const MARKS_DARK = [
  /* Hull number on the outboard cheek of each nacelle. This is the one that
     smeared worst — a 2.6 m drum projected down X wraps past sixty degrees
     before the fade catches it — so it is unwrapped round the nacelle's own
     axis, and the aspect of the ship-space patch matches the atlas cell so the
     digits are not stretched along the barrel either. */
  {
    cell: 'num', rect: [12.9, 17.0],
    cyl: { c: [11.0, -3.4], r: 2.6, a0: -0.62, a1: 0.62, mirror: true },
  },
  // and the stencil every real vehicle carries aft of a nozzle, up on the
  // shoulder where a crew walking the pylon would read it
  {
    cell: 'caut', rect: [17.8, 22.4],
    cyl: { c: [11.0, -3.4], r: 2.6, a0: 0.96, a1: 1.31, mirror: true },
  },
  // hazard chevrons on the ventral bay doors                     (z, x)
  { cell: 'haz', plane: 'y', rect: [-13.6, -1.1, -5.2, 1.1], side: -1 },
];

/* ========================================================== radial gauge

   The rule, as a function rather than as a number remembered at each call
   site. Keep a facet under about 0.2 m of chord and a barrel reads as round
   at any distance the player can reach; that is 14 sides on a 0.84 m tube and
   82 on a 5.2 m fuselage, and those are different problems that must not get
   the same count. Applying it by hand is how the primary drum ended up a
   fourteen-sided prism with 2.3 m facets — the widest thing in the
   silhouette of every exterior shot, and the worst single offender in the
   game — while a 0.3 m handrail beside it was correctly gauged.

   Capped, because the cost is real even though it is small: at 96 a 5.2 m
   drum still holds a 0.34 m facet, whose sagitta is under half a pixel at the
   distance the hull is judged from. What the cap gives up is shading, not
   silhouette, and creaseNormals() in the kit answers that directly — it
   averages across any joint under 32 degrees, so a 96-sided barrel is round
   rather than banded and a 45-degree chamfer still cuts. */
const RCHORD = 0.20;
const rseg = (r, min = 6, max = 96) =>
  Math.max(min, Math.min(max, 2 * Math.ceil(Math.PI * Math.abs(r) / RCHORD)));
/** The same rule along an arc of `ang` radians at radius `r`. */
const aseg = (r, ang, min = 3, max = 64) =>
  Math.max(min, Math.min(max, Math.ceil(Math.abs(r * ang) / RCHORD)));

/* ====================================================== machined primitives

   The kit in `gfx/greeble.js` builds *structure*: slabs, lofted booms, framed
   panels, trusses. What it has never had is the vocabulary of a machine — a
   part that came off a lathe, a member that runs between two lugs at an angle
   nothing on the ship is aligned to, a hose. Those three shapes are the entire
   difference between a landing leg and four sticks with a disc on the end, so
   they live here.  */

/**
 * A turned part: an [radius, height] profile revolved about +Y.
 *
 * three's `LatheGeometry` would do this, and then the barrel would be inside
 * out or not, depending on which way the profile happened to run — which is a
 * bug that costs an hour every time and looks like a lighting fault. So the
 * rule is stated instead: the profile is traversed **counter-clockwise in the
 * (r, y) half-plane**, exactly as a section drawing is, and the winding then
 * always faces out. Bottom face runs outward, the flank runs up, the top face
 * runs back in. A radius of zero closes an end.
 */
function turned(profile, seg) {
  const n = profile.length;
  const pos = [], uv = [];
  const put = (r, y, a, u, v) => {
    pos.push(r * Math.cos(a), y, r * Math.sin(a));
    uv.push(u, v);
  };
  for (let i = 0; i < n - 1; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    if (r0 < 1e-5 && r1 < 1e-5) continue;
    const v0 = i / (n - 1), v1 = (i + 1) / (n - 1);
    for (let k = 0; k < seg; k++) {
      const u0 = k / seg, u1 = (k + 1) / seg;
      const a0 = u0 * Math.PI * 2, a1 = u1 * Math.PI * 2;
      if (r0 < 1e-5) {                       // a cone closing downward
        put(0, y0, a0, u0, v0); put(r1, y1, a0, u0, v1); put(r1, y1, a1, u1, v1);
      } else if (r1 < 1e-5) {                // a cone closing upward
        put(r0, y0, a0, u0, v0); put(0, y1, a0, u0, v1); put(r0, y0, a1, u1, v0);
      } else {
        put(r0, y0, a0, u0, v0); put(r1, y1, a0, u0, v1); put(r1, y1, a1, u1, v1);
        put(r0, y0, a0, u0, v0); put(r1, y1, a1, u1, v1); put(r0, y0, a1, u1, v0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * A tapered box carried between two points in space.
 *
 * `loftBox` sweeps along +X, which is the right tool for a boom bolted to a
 * frame and the wrong one for a brace: a jury strut runs from a lug to a lug
 * and nothing about it is axis aligned. Stations are `[t, halfWidth,
 * halfHeight, yOffset]` with `t` in 0..1 along the run, so the *same* list
 * describes a smooth taper or a ribbed casting — a rib is two stations two per
 * cent apart, which is how the drag braces get their relief without a single
 * part being placed against a curve by hand.
 *
 * `up` fixes the roll. A quaternion between two directions picks its own axis,
 * and a member whose section rolls to wherever that lands is precisely what
 * makes a brace read as extruded stock rather than as a casting with a top and
 * a bottom.
 */
function beam(a, b, stations, cham = 0.06, up = [0, 1, 0]) {
  const A = new THREE.Vector3(a[0], a[1], a[2]);
  const d = new THREE.Vector3(b[0], b[1], b[2]).sub(A);
  const len = d.length();
  if (len < 1e-6) return null;
  const g = loftBox(stations.map(
    ([t, hz, hy, yo = 0, zo = 0]) => [t * len, hz, hy, yo, zo]), cham);
  const ex = d.multiplyScalar(1 / len);
  const ez = new THREE.Vector3().crossVectors(ex, new THREE.Vector3(up[0], up[1], up[2]));
  if (ez.lengthSq() < 1e-8) ez.crossVectors(ex, new THREE.Vector3(0, 0, 1));
  ez.normalize();
  const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();
  g.applyMatrix4(new THREE.Matrix4().makeBasis(ex, ey, ez));
  g.translate(A.x, A.y, A.z);
  return g;
}

/**
 * A routed hose. A hydraulic line is the one thing on a machine allowed to be
 * a curve, it is what tells you the joint below it *moves*, and it has to have
 * slack in it — a taut cylinder between two lugs is a strut, not a hose.
 */
function hose(pts, r, tub = 24, rad = 7) {
  return new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]))),
    tub, r, rad, false);
}

/**
 * A link plate: two bosses joined by a waisted web, which is the shape every
 * torque link, drag link and rocker arm ever made has been. Laid out along +X
 * from a boss at the origin, extruded through Z.
 */
function linkPlate(len, r0, r1, waist, thick) {
  const pts = [];
  const N = 6;
  for (let i = 0; i <= N; i++) {          // over boss A, from the top round to the bottom
    const a = Math.PI * 0.5 + (i / N) * Math.PI;
    pts.push([Math.cos(a) * r0, Math.sin(a) * r0]);
  }
  pts.push([len * 0.32, -waist], [len * 0.68, -waist]);
  for (let i = 0; i <= N; i++) {          // and back over boss B
    const a = -Math.PI * 0.5 + (i / N) * Math.PI;
    pts.push([len + Math.cos(a) * r1, Math.sin(a) * r1]);
  }
  pts.push([len * 0.68, waist], [len * 0.32, waist]);
  return panel(pts, thick, Math.min(0.055, thick * 0.4));
}

/** A hex fastener head — six sides, because that is what a bolt is. */
const bolt = (r, h) => new THREE.CylinderGeometry(r, r * 0.94, h, 6);

/* ============================================================== the vessel */

export function buildHull() {
  const root = new THREE.Group();
  const hullOut = {};

  // ---------------------------------------------------------- materials
  // Painted, chalky, sun-bleached. Roughness never goes near a mirror: a broad
  // specular highlight on a *hull* is the single fastest way to read as
  // plastic. The gloss on this ship is rationed to `trim`, below.
  // The painted band the shared kit stencils at the frame stations is off here:
  // this ship carries a real livery stripe as a decal, and two orange marking
  // systems on the same flank fight each other.
  /* Five surfaces a viewer can name. The number that separates them used to be
     roughness, spread from a mirrored 0.16 up to a chalky 0.94 — and two of
     those five sat at metalness 0.92 with roughness under a third, which on a
     thirteen-metre nacelle is not a highlight, it is a chrome band running the
     whole length of the tube with a dark reflection above it. That is the
     loudest violation there is of this project's own brief: matte and mineral,
     never shiny, roughness floors around 0.35, bare metal only at wear edges.

     So nothing here starts below 0.42, and nothing is metal. The separation
     comes from albedo, from the anti-glare top coat, from the plate law, and
     from *where* the bare alloy is allowed back in — the lips, rims, collars
     and nozzle edges the bake found, which is one or two per cent of the
     surface and is exactly where a real hull is rubbed through. The one hard
     specular the ship needs survives; the chrome does not. */

  /* The drive glow, shared. `plumePower` is the same uniform object the plume
     shaders carry as uPower, so Ship.js's one write per frame drives the
     torches and the light they cast on the hull together — there is no second
     place that has to be kept in step. */
  const plumePower = { value: 0 };
  const PLUME_AT = [[11.0, -3.4, 24.4], [-11.0, -3.4, 24.4]];
  const drive = {
    power: plumePower, at: PLUME_AT, len: 20, rad: 2.7,
    col: [0.52, 0.72, 1.0], gain: 34,
  };

  const paint = dress(new THREE.MeshStandardMaterial({
    color: 0x8e8d86, metalness: 0.04, roughness: 0.74, envMapIntensity: 0.85,
  }), {
    plate: 2.4, bleach: 0.85, soot: 0.55, livery: 0, glare: 0.82, edge: 0.24,
    brushed: 0.35, frame: 1, marks: MARKS_PAINT, plume: drive,
  });

  /* The same bone paint, rolled to two other gauges.
     A yard does not roll one sheet size for a fuselage ring, a nose fairing and
     an access door, and until now this one did: `paint` at 2.4 m ran at the
     same pitch on the drum, the prow, the sail and the booms, and at 1:1 that
     single repeating rectangle is the loudest tell that the whole hull came out
     of one texture. Large plate on the big pressure vessels, small plate on the
     bolt-on fairings and doors — and `machinery` below for the parts that are
     not skin at all. Four scales in one silhouette instead of one. */
  const paintBig = dress(new THREE.MeshStandardMaterial({
    color: 0x8e8d86, metalness: 0.04, roughness: 0.74, envMapIntensity: 0.85,
  }), {
    plate: 3.7, bleach: 0.85, soot: 0.55, livery: 0, glare: 0.82, edge: 0.24,
    brushed: 0.35, frame: 1, marks: MARKS_PAINT, plume: drive,
  });
  /* `marks` is not optional here, and finding that out cost a wordmark: the
     decal set is keyed by *world position*, so a stencil prints on whatever
     material happens to own the surface under it. Moving the dorsal housing
     onto this gauge silently took the vessel's name off the spine, because the
     name's rect is over the housing and only `paint` was carrying the sheet.
     Any painted material a marking can land on has to carry the same list. */
  const paintFine = dress(new THREE.MeshStandardMaterial({
    color: 0x8b8a83, metalness: 0.05, roughness: 0.72, envMapIntensity: 0.85,
  }), {
    plate: 1.15, bleach: 0.80, soot: 0.55, livery: 0, glare: 0.82, edge: 0.30,
    brushed: 0.35, rivet: 1.15, frame: 1, marks: MARKS_PAINT, plume: drive,
  });

  // Near-black ablative composite. Everything that runs hot, takes the drive
  // load or must not glare into an instrument is made of it, and the value jump
  // against the bone paint is what gives the hull its structure at a distance.
  // It is a laid-up sheet, not paint, so it is a little smoother than the chalk
  // beside it and holds a long soft sheen where the paint holds none — but it
  // is a *sheet*, not a metal, and it used to be shaded as one.
  const structure = dress(new THREE.MeshStandardMaterial({
    color: 0x23252a, metalness: 0.10, roughness: 0.58, envMapIntensity: 0.85,
  }), {
    plate: 1.3, bleach: 0.20, soot: 0.85, edge: 0.20, brushed: 0.75,
    frame: 1, marks: MARKS_DARK, plume: drive,
  });

  // Fittings: primed alloy. RCS bells, handrails, masts, bottles, the outside
  // of the nozzle. Painted like everything else and worn through at the edges.
  const metal = dress(new THREE.MeshStandardMaterial({
    color: 0x7b746a, metalness: 0.15, roughness: 0.52, envMapIntensity: 1.05,
  }), {
    plate: 0.9, bleach: 0.25, soot: 0.7, edge: 0.50, brushed: 1.0,
    frame: 1, doors: 0, plume: drive,
  });

  /* Rings, rails, hinges, oleos, nozzle lips. See polished(): matte alloy with
     the bare metal masked back to the rims, which is where it belongs.

     This is the largest single mesh on the ship — thirty-eight thousand
     triangles of ring, collar, rail and strake — so whatever it does to the key
     it does across the whole silhouette, and what it was doing was carrying a
     soft neutral highlight all the way round every curved mass it touches: the
     propellant domes, the trunnion collars, the boom tubes. Two changes, and
     they are not the same change. `matteMin` is the real one, and it is about
     the grazing Fresnel (see MATTE_HOOK) rather than about roughness, which
     already clears the brief's floor. `env` at 1.7 was measured at three per
     cent of the peak — the environment probe is a PMREM of a nearly-black
     nebula, so it was never the cause however it reads in the source — but a
     painted fitting has no business reflecting twice what the paint beside it
     does, so it comes down to the fittings' own 1.05 anyway. */
  const trim = polished({
    soot: 0.6, env: 1.05, matteMin: 1.0, frame: 1, doors: 0, plume: drive,
  });

  /* Machinery, as distinct from skin.

     The plate law is this ship's one global texture, and at 1:1 an art
     director counted the same rectangle grid running at the same pitch on the
     wings, the drum, the fins, the nose and the booms — one material scale
     across a whole silhouette, where the reference carries four or five in a
     single frame. Part of the answer is to spread the *painted* surfaces
     (below); the other part is that some of a vehicle is not plate at all. A
     cast trunnion, an oleo barrel, a footpad, a gear bay: those are machined
     parts at half a metre of feature pitch, not two and a half metres of
     rolled sheet, and putting them on their own scale is what stops the leg
     reading as hull with legs drawn on it. Darker and greyer than the paint,
     because a casting is not painted the same colour as the ship. */
  const machinery = dress(new THREE.MeshStandardMaterial({
    color: 0x62655f, metalness: 0.18, roughness: 0.58, envMapIntensity: 1.0,
  }), {
    /* A casting has no plates. Half a metre of plate pitch was the first
       attempt at "a different material scale", and on a one-metre leg it drew
       a dense grid of narrow rectangles that read at 1:1 as *wood grain* —
       with the anisotropic brushing running down the member it looked like a
       leg made of two-by-fours. The scale that separates machinery from skin
       is coarse seams and fine hardware, not fine seams: at 1.5 m most of a
       leg is inside one panel, the fasteners and the wear edges carry the
       detail, and the brushing comes right down because a sand casting is not
       drawn stock. */
    plate: 1.5, bleach: 0.10, soot: 0.44, edge: 0.52, brushed: 0.38,
    rivet: 0.95, bump: 0.85, frame: 1, plume: drive,
  });

  /* The one genuinely polished thing on the ship, and it is three hundred
     millimetres of piston rod.

     `polished()` is matte alloy with the bare metal masked back to the wear
     edges, which is right for a handrail and wrong for the part of an oleo
     that slides through a seal: that surface is ground and hard-chromed
     because it has to be, and it is the only place on this hull where a hard
     specular streak is telling the truth rather than making a painted part
     look like plastic. It is also about a thousandth of the ship's area, which
     is the whole reason the brief's matte discipline survives it — the rule is
     "bare metal appears only at wear edges", and a sliding surface is the
     limiting case of a wear edge. No plate law: nobody rolls a seam into a
     ground rod. */
  const chrome = dress(new THREE.MeshStandardMaterial({
    color: 0xc6c9cb, metalness: 0.88, roughness: 0.19, envMapIntensity: 1.9,
  }), {
    plate: 5.0, bleach: 0.0, soot: 0.30, edge: 0.14, brushed: 1.0,
    rivet: 0.0, bump: 0.2, plume: drive,
  });

  const accent = dress(new THREE.MeshStandardMaterial({
    color: 0x8c4418, metalness: 0.14, roughness: 0.66, envMapIntensity: 0.8,
  }), {
    plate: 1.1, bleach: 0.9, soot: 0.4, edge: 0.22, brushed: 0.3,
    frame: 1, doors: 0, plume: drive,
  });

  // Radiator vanes: a pale ceramic face — they have to *reject* heat, so they
  // are the brightest thing on the hull, and against a black sky that is what
  // makes them read as panels rather than as shadow. A real emissive ramps with
  // drive load; waste heat is the only thing on this ship that glows warm.
  // Nearly Lambertian: a ceramic that catches a specular is a tile, not a
  // radiator, and it is the top end of the roughness spread.
  const radiator = dress(new THREE.MeshStandardMaterial({
    color: 0xa8a9a4, metalness: 0.0, roughness: 0.94, envMapIntensity: 0.7,
    emissive: new THREE.Color(0x501c05), emissiveIntensity: 0.0,
    side: THREE.DoubleSide,
  }), {
    plate: 2.1, bleach: 0.5, soot: 0.15, edge: 0.12, brushed: 0.15,
    rivet: 0.35, bump: 0.45, frame: 1, doors: 0, plume: drive,
  });

  // The canopy. Actually transparent, with a lit cockpit behind it — an opaque
  // black windscreen is the single loudest tell that a ship is a prop. Low
  // roughness and a clearcoat give it the one mirror-sharp reflection on the
  // model that is not metal — but only if there is something in the sky to
  // reflect, which is what `skyLit` supplies and the scene's black nebula
  // probe never did.
  const glass = skyLit(new THREE.MeshPhysicalMaterial({
    color: 0x0b1a22, metalness: 0.0, roughness: 0.040,
    envMapIntensity: 3.4, clearcoat: 1.0, clearcoatRoughness: 0.02,
    emissive: new THREE.Color(0x0d2634), emissiveIntensity: 0.5,
    transparent: true, opacity: 0.46, depthWrite: false, side: THREE.DoubleSide,
  }));

  // Everything lit from inside: instrument glow, cabin lights, lit portholes,
  // deck strips. Cold white-blue, because human-made light in this game always
  // is. One material so the whole ship's interior lighting is one draw.
  const lit = emitter(0x9ec8ff, 1.9);

  // Interior surfaces are lit by lamps this renderer does not have — there is
  // one directional star and nothing else — so anything behind the glass is
  // shaded flat rather than lit. Unlit at a low gain reads exactly like a
  // cabin under its own lighting, and it costs one draw for the whole cockpit.
  const cabin = emitter(0x8c96a4, 0.55);

  const P = [];   // painted hull
  const PB = [];  // painted hull, coarse plate: the big pressure vessels
  const PF = [];  // painted hull, fine plate: fairings, doors, cladding
  const S = [];   // dark composite
  const T = [];   // bare metal hardware
  const MC = [];  // machinery: castings, housings, mechanism
  const R = [];   // polished trim
  const A = [];   // oxide accent
  const G = [];   // glass
  const L = [];   // lit from inside
  const C = [];   // cabin, unlit

  /* ---------------------------------------------------- hammerhead prow
     Wide, flat and blunt: the instrument face. It is the part that tells you
     which way the ship is pointing from a kilometre away. A chin fairing under
     it and a brow over it turn the slab into a wedge, so the head has a front
     rather than just a forward-most surface.

     It is also the *nearest* mass to the lens in half the shots this ship is
     ever framed in, and for a long time it was a plain rounded box with five
     identical round apertures in a blank black face and nothing at all on its
     sides. An art director reading it at 1:1 against a Starfield ship said ours
     "reads as extruded from one piece where theirs reads as assembled from
     modules", which is exactly right and is a statement about *seams*, not
     about greebles: a real head is a structural box with skin panels bolted to
     it, and every one of those panels has an edge, a gap, a run of fasteners
     and a neighbour that is a different size.

     So the box stays — the silhouette is correct and is not the problem — and
     it gets clad. Deck panels with a channel between them, three flank plates
     a side at three different lengths with the dark structure showing through
     the gaps, corner castings, a rub strake that turns the corner, an access
     hatch that is unmistakably a hatch, and five sensors that are five
     different instruments instead of five copies of one hole. */
  {
    const head = slab(19, 4.6, 11, 1.4);
    P.push(place(head, { pos: [0, 0.2, -52] }));

    // A dark composite band around the lower half of the head. At chase
    // distance the prow is forty pixels of pale block, and a hard value break
    // across it is the only thing at that size that reads as construction.
    S.push(place(slab(19.4, 1.6, 11.3, 1.2), { pos: [0, -1.55, -52] }));

    // polished rub rail along the top edge of the head, either side of the
    // canopy — the line that reads the wedge out to the corners
    for (const s of [1, -1]) {
      R.push(place(slab(0.42, 0.30, 10.4, 0.10), { pos: [8.9 * s, 2.44, -52] }));
    }

    /* ---- the deck. Two panels and a service channel between them, rather
       than one blank white face nine metres across. The channel carries the
       conduit run forward to the sensor head, which is the reason a channel is
       there at all.

       `loftBox` sweeps along +X and everything here runs along Z, so the whole
       prow is authored with `rot: [0, -PI/2, 0]` — the turn that sends local +X
       to world +Z. The other one sends it to −Z and mirrors the part into the
       hull, which is invisible until you notice the panels are missing. The
       port side is a sign on the *offset*, never a negative scale. */
    const ZX = { rot: [0, -Math.PI / 2, 0] };
    for (const s of [1, -1]) {
      /* Proud by nearly half a metre, not by a hundred and seventy
         millimetres. The first pass put a 0.17 m step on a nineteen-metre face
         and at the distance this head is actually judged from that is two
         pixels — it measured as a panel and read as nothing. A seam has to
         subtend enough to catch the key on one side and shade on the other. */
      PF.push(place(loftBox([
        [-56.9, 3.16, 0.24, 0, -5.42 * s], [-54.2, 3.34, 0.27, 0, -5.36 * s],
        [-51.0, 3.34, 0.27, 0, -5.36 * s], [-48.6, 3.06, 0.24, 0, -5.26 * s],
      ], 0.09), { rot: ZX.rot, pos: [0, 2.44, 0] }));
      // fasteners down both edges of each deck panel
      for (let i = 0; i < 8; i++) {
        const z = -56.2 + i * 1.05;
        for (const ex of [2.42, 8.42]) {
          R.push(place(bolt(0.11, 0.09), { pos: [ex * s, 2.68, z] }));
        }
      }
    }
    // the channel floor and the conduit in it
    S.push(place(loftBox([
      [-57.0, 2.05, 0.12], [-48.4, 2.05, 0.12],
    ], 0.05), { rot: ZX.rot, pos: [0, 2.30, 0] }));
    MC.push(place(new THREE.CylinderGeometry(0.26, 0.26, 8.4, rseg(0.26, 12)), {
      pos: [0.78, 2.58, -52.5], rot: [Math.PI / 2, 0, 0],
    }));
    for (const z of [-55.8, -52.6, -49.4]) {
      MC.push(place(loftBox([[-0.40, 0.18, 0.30], [0.40, 0.18, 0.30]], 0.05),
        { pos: [0.78, 2.44, z] }));
    }

    /* ---- flank cladding. Three plates a side, three different lengths, at
       three different heights, with a gap between each pair that shows the dark
       structure underneath. The differing *runs* are the whole point: equal
       panels in a row read as a texture, unequal ones read as a build. */
    /* All three forward of z = −51.5. Aft of that the cheek fairing stands
       outboard of this flank and swallows it whole — a fourth plate back there
       was drawn, shaded, shadow-cast and completely invisible, which is the
       cheapest kind of geometry to notice and delete. */
    const FLANK = [
      [-57.20, -55.55, 1.00, 1.24],
      [-55.25, -53.90, 0.66, 1.46],
      [-53.60, -51.65, 1.04, 1.20],
    ];
    for (const s of [1, -1]) {
      // the dark backing the gaps expose
      S.push(place(loftBox([
        [-57.3, 0.20, 1.80, 0.55], [-46.7, 0.20, 1.80, 0.55],
      ], 0.06), { rot: ZX.rot, pos: [9.36 * s, 0, 0] }));
      for (const [z0, z1, yc, hy] of FLANK) {
        PF.push(place(loftBox([
          [z0, 0.26, hy], [z0 + 0.30, 0.30, hy + 0.07],
          [z1 - 0.30, 0.30, hy + 0.07], [z1, 0.26, hy],
        ], 0.07), { rot: ZX.rot, pos: [9.72 * s, yc, 0] }));
        for (let i = 0; i < 4; i++) {
          const z = z0 + 0.32 + (i / 3) * (z1 - z0 - 0.64);
          for (const ey of [hy - 0.20, -(hy - 0.20)]) {
            R.push(place(bolt(0.10, 0.09), {
              rot: [0, 0, Math.PI / 2 * s], pos: [10.02 * s, yc + ey, z],
            }));
          }
        }
      }
      // a rub strake below the plate run, and the corner castings it dies into
      R.push(place(loftBox([
        [-57.5, 0.34, 0.22], [-46.9, 0.28, 0.18],
      ], 0.06), { rot: ZX.rot, pos: [9.88 * s, -0.72, 0] }));
      MC.push(place(loftBox([
        [-1.35, 0.66, 1.50], [-0.55, 0.80, 1.66], [0.45, 0.60, 1.36],
      ], 0.16), { pos: [8.70 * s, 0.30, -57.30] }));
      MC.push(place(loftBox([
        [-1.10, 0.34, 0.17], [0.45, 0.28, 0.14],
      ], 0.07), { pos: [8.76 * s, 2.44, -57.20] }));
    }

    // chin fairing — the ventral half of the wedge, and where the terrain
    // sensors live
    S.push(place(panel([[-5.5, 0], [5.5, 0], [4.2, -2.5], [-4.2, -2.5]], 9.6, 0.3), {
      pos: [0, -1.9, -53.0], rot: [0, Math.PI / 2, 0],
    }));
    L.push(place(new THREE.CircleGeometry(0.42, rseg(0.42, 24)), { pos: [0, -3.1, -57.3], rot: [-0.5, 0, 0] }));
    R.push(place(new THREE.TorusGeometry(0.56, 0.09, 8, rseg(0.56, 26)), { pos: [0, -3.05, -57.25], rot: [-0.5, 0, 0] }));

    /* ---- the instrument face.

       Five apertures on a 3 m pitch, all the same diameter, all with the same
       collar and half of them lit: at 1:1 that does not read as a sensor suite,
       it reads as five portholes, and the review named it. A survey ship's
       instrument face is a rack of *different* instruments, fitted at different
       times, of different sizes, and they are what the ship is for. So: a
       square lidar window under a sun hood, a stepped baffle round the main
       optic, a shuttered aperture with the louvres visible, a cluster of three
       small lenses on one pallet, and a flush phased-array plate. Nothing is
       repeated and nothing is centred. */
    const face = slab(15.5, 3.1, 1.2, 0.5);
    S.push(place(face, { pos: [0, 0.2, -57.6] }));

    /* A lens on the front of the ship faces −Z, and `CircleGeometry` faces +Z.
       Every lit aperture on the old face was therefore a back-facing plane and
       drew nothing at all; what read as "the lens" was the polished end cap of
       the collar behind it. Turn them round. */
    const FACE = { rot: [0, Math.PI, 0] };

    // 1. lidar window, square, recessed under a sun hood
    MC.push(place(loftBox([
      [-58.86, 1.34, 1.14], [-58.30, 1.44, 1.24], [-57.9, 1.30, 1.10],
    ], 0.10), { rot: ZX.rot, pos: [-5.35, 0.25, 0] }));
    S.push(place(slab(2.16, 1.86, 0.16, 0.06), { pos: [-5.35, 0.25, -58.52] }));
    G.push(place(new THREE.PlaneGeometry(1.92, 1.62), { pos: [-5.35, 0.25, -58.61] }));
    MC.push(place(panel([
      [-1.42, 0], [1.42, 0], [1.16, 0.78], [-1.16, 0.78],
    ], 0.14, 0.06), { rot: [1.24, 0, 0], pos: [-5.35, 1.66, -58.86] }));

    /* 2. the main optic. A stack of three discs of decreasing radius was the
       obvious way to draw a baffle and it is exactly wrong: a solid cylinder
       occludes everything behind it, so what the camera saw was the front cap
       of the largest one — a flat white plate a metre across, which is worse
       than the porthole it replaced. A baffle is a *bore*, so it has to be one
       closed section of revolution: out along the front face, up the outside,
       in across the back, and then down the stepped inside, which is where the
       winding turns over and the surface faces in. See `turned()`. */
    MC.push(place(turned([
      [1.02, 0.00], [1.28, 0.00], [1.28, 0.95], [0.42, 0.95],
      [0.42, 0.74], [0.62, 0.74], [0.62, 0.50], [0.82, 0.50],
      [0.82, 0.26], [1.02, 0.26], [1.02, 0.00],
    ], rseg(1.28, 26)), { rot: [Math.PI / 2, 0, 0], pos: [-1.65, 0.25, -58.34] }));
    L.push(place(new THREE.CircleGeometry(0.40, rseg(0.40, 20)),
      { rot: FACE.rot, pos: [-1.65, 0.25, -57.42] }));

    // 3. a shuttered aperture — the louvres are the whole read
    MC.push(place(loftBox([
      [-58.46, 1.00, 0.88], [-58.14, 1.08, 0.96],
    ], 0.08), { rot: ZX.rot, pos: [1.35, 0.25, 0] }));
    S.push(place(slab(1.72, 1.52, 0.14, 0.05), { pos: [1.35, 0.25, -58.30] }));
    for (let i = 0; i < 5; i++) {
      MC.push(place(loftBox([
        [-0.84, 0.16, 0.055], [0.84, 0.16, 0.055],
      ], 0.03), { rot: [0.44, 0, 0], pos: [1.35, -0.56 + i * 0.29, -58.42] }));
    }

    // 4. a pallet of three small lenses, bolted on later than the rest
    MC.push(place(loftBox([
      [-58.44, 0.72, 1.04], [-58.12, 0.78, 1.10],
    ], 0.07), { rot: ZX.rot, pos: [4.20, 0.25, 0] }));
    /* Collars in `machinery`, not in `polished`: three 0.3 m rings of worked
       alloy side by side on a dark face come back as three bright white coins
       and undo the whole point of making the instruments different. One lens is
       lit; the other two are capped, because a suite where everything is live
       reads as a decoration. */
    for (const [lx2, ly, lr] of [[-0.42, 0.44, 0.28], [0.40, 0.40, 0.21], [0.02, -0.40, 0.24]]) {
      MC.push(place(new THREE.CylinderGeometry(lr + 0.08, lr + 0.10, 0.26, rseg(lr, 16)), {
        pos: [4.20 + lx2, 0.25 + ly, -58.50], rot: [Math.PI / 2, 0, 0],
      }));
      (lr > 0.25 ? L : S).push(place(new THREE.CircleGeometry(lr, rseg(lr, 16)),
        { rot: FACE.rot, pos: [4.20 + lx2, 0.25 + ly, -58.56] }));
    }
    for (let i = 0; i < 4; i++) {
      R.push(place(bolt(0.085, 0.08), {
        rot: [Math.PI / 2, 0, 0],
        pos: [4.20 + (i % 2 ? 0.88 : -0.88), 0.25 + (i < 2 ? 0.94 : -0.94), -58.44],
      }));
    }

    // 5. a flush phased-array plate, ribbed
    S.push(place(loftBox([
      [-58.34, 1.12, 0.82], [-58.16, 1.16, 0.86],
    ], 0.05), { rot: ZX.rot, pos: [6.95, 0.25, 0] }));
    for (let i = 0; i < 6; i++) {
      MC.push(place(loftBox([
        [-0.72, 0.055, 0.055], [0.72, 0.055, 0.055],
      ], 0.02), { rot: [0, 0, Math.PI / 2], pos: [6.95 - 0.90 + i * 0.36, 0.25, -58.28] }));
    }

    /* ---- the hatch. A door is worth more than a dozen greebles, and the one
       thing this head never had was a way in. Coaming, a proud door on a
       different material, three hinge knuckles, a centre lever with two dogs
       off it, a grab rail and a boot step on the flank below — everything a
       crewman in a suit would actually put a glove on. */
    {
      const hx = 4.85, hz = -50.9;
      for (const [dx, dz, hw, hd] of [
        [0, -1.30, 1.62, 0.13], [0, 1.30, 1.62, 0.13],
        [-1.49, 0, 0.13, 1.43], [1.49, 0, 0.13, 1.43],
      ]) {
        MC.push(place(loftBox([[-hw, hd, 0.14], [hw, hd, 0.14]], 0.05),
          { pos: [hx + dx, 2.68, hz + dz] }));
      }
      PF.push(place(panel([
        [-1.36, -1.14], [1.36, -1.14], [1.36, 1.14], [-1.36, 1.14],
      ], 0.20, 0.08), { rot: [Math.PI / 2, 0, 0], pos: [hx, 2.62, hz] }));
      for (const kz of [-0.86, 0, 0.86]) {
        R.push(place(new THREE.CylinderGeometry(0.13, 0.13, 0.40, 10), {
          pos: [hx + 1.40, 2.74, hz + kz], rot: [Math.PI / 2, 0, 0],
        }));
      }
      R.push(place(loftBox([[-0.62, 0.11, 0.09], [0.62, 0.11, 0.09]], 0.04),
        { rot: [0, 0.34, 0], pos: [hx, 2.80, hz] }));
      MC.push(place(new THREE.CylinderGeometry(0.20, 0.22, 0.16, 12), { pos: [hx, 2.76, hz] }));
      for (const dz of [-1.05, 1.05]) {
        R.push(place(bolt(0.14, 0.12), { pos: [hx - 1.10, 2.76, hz + dz] }));
      }
      // grab rail alongside, and a step down onto the flank
      for (const dz of [-0.95, 0.95]) {
        R.push(place(new THREE.TorusGeometry(0.30, 0.075, 6, 14, Math.PI), {
          pos: [hx - 2.35, 2.62, hz + dz],
        }));
      }
      MC.push(place(loftBox([[-0.52, 0.36, 0.09], [0.52, 0.36, 0.09]], 0.04),
        { rot: [0, 0, -0.30], pos: [9.86, 1.10, hz + 1.9] }));
    }

    // swept cheek fairings that carry the head back into the neck
    for (const s of [1, -1]) {
      const cheek = slab(5.0, 3.0, 15, 1.0);
      P.push(place(cheek, { pos: [8.0 * s, 0.1, -44], rot: [0, 0, 0.20 * s] }));
      // leading-edge strake, oxide orange — the only warm paint forward
      A.push(place(slab(0.9, 0.5, 12, 0.2), { pos: [10.6 * s, 1.4, -48], rot: [0, -0.06 * s, 0] }));
      // polished rub rail along the top of the cheek
      R.push(place(slab(0.42, 0.30, 13.5, 0.10), { pos: [9.3 * s, 1.75, -44.5], rot: [0, -0.05 * s, 0] }));
    }
  }

  /* ------------------------------------------------------------- cockpit
     The one part of the ship that says a person is aboard. Faceted glass over a
     tub with a console, two seats and a pilot in one of them; the glow spilling
     out of it is visible from every forward angle and from directly above
     through the roof pane. Everything in here is exterior dressing — the
     walkable cabin is its own scene — but it has to *agree* with that cabin,
     which is why the seats face out over the console the same way. */
  {
    /* Side profile of the canopy fairing, in (−z, y). Two solid cheeks carry
       this outline and the glazing spans between them; a canopy assembled from
       rectangles perched on the deck reads as scaffolding, and the difference
       is entirely in whether the fairing has a *profile*. */
    // The solid cheeks stop at waist height and glass carries on above them, so
    // the cockpit is see-through from the side as well as the front. That is
    // the difference between a canopy and a slot: from a chase camera three
    // quarters behind, the only way the crew is ever visible is sideways.
    const p0 = [45.5, 2.20], p1 = [57.4, 2.25], p2 = [56.4, 3.30],
      p3 = [54.2, 5.25], p4 = [50.0, 5.40], p5 = [46.4, 3.50];
    const q3 = [54.2, 4.05], q4 = [50.0, 4.20];
    const CHEEK = 3.28, TH = 0.46, GX = CHEEK + TH / 2;
    for (const s of [1, -1]) {
      P.push(place(panel([p0, p1, p2, q3, q4, p5], TH, 0.12), {
        pos: [CHEEK * s, 0, 0], rot: [0, Math.PI / 2, 0],
      }));
      // glazed shoulder above the cheek, and the rail it sits in
      G.push(place(new THREE.PlaneGeometry(4.3, 1.35), {
        pos: [GX * s, 4.75, -52.1], rot: [0, Math.PI / 2, 0],
      }));
      R.push(place(slab(0.36, 0.32, 4.5, 0.09), { pos: [CHEEK * s, 4.12, -52.1] }));
      // corner posts carrying the roof
      R.push(place(slab(0.32, 1.5, 0.32, 0.08), { pos: [CHEEK * s, 4.75, -54.1] }));
      R.push(place(slab(0.32, 1.5, 0.32, 0.08), { pos: [CHEEK * s, 4.80, -50.1] }));
    }
    // nose deck below the windscreen sill, roof-aft deck, and the coaming
    P.push(place(slab(6.6, 0.45, 1.5, 0.15), { pos: [0, 2.55, -56.9] }));
    P.push(place(panel([p4, p5, p0, [50.0, 2.20]], 6.5, 0.14), { rot: [0, Math.PI / 2, 0] }));
    S.push(place(slab(6.6, 0.55, 7.2, 0.15), { pos: [0, 2.45, -53.0] }));

    // ---- interior, seen through the glass
    // console, angled up at the crew, with its instrument glow spilling onto
    // the underside of the screen
    S.push(place(slab(4.6, 0.55, 1.6, 0.15), { pos: [0, 3.15, -55.5], rot: [-0.45, 0, 0] }));
    L.push(place(new THREE.PlaneGeometry(3.8, 1.15), { pos: [0, 3.46, -55.4], rot: [-1.10, 0, 0] }));
    L.push(place(new THREE.PlaneGeometry(1.5, 0.5), { pos: [0, 3.02, -56.4], rot: [-0.2, 0, 0] }));
    // a light bar on the rear bulkhead, behind the crew
    L.push(place(new THREE.PlaneGeometry(4.2, 0.20), { pos: [0, 4.55, -49.35], rot: [0, Math.PI, 0] }));
    // seats — dark, so the crew read against them
    for (const s of [1, -1]) {
      S.push(place(slab(1.20, 1.85, 0.32, 0.10), { pos: [1.30 * s, 3.85, -51.6], rot: [-0.14, 0, 0] }));
      S.push(place(slab(1.30, 0.28, 1.4, 0.10), { pos: [1.30 * s, 3.00, -52.4] }));
    }
    // A pilot in the port seat. It is four primitives and it does more for the
    // ship than any amount of greebling: a hull with a person visible in it is
    // crewed, and a hull without one is a model.
    C.push(place(new THREE.CapsuleGeometry(0.40, 0.85, 5, 14), {
      pos: [-1.30, 3.72, -52.05], rot: [0.22, 0, 0],
    }));
    C.push(place(new THREE.SphereGeometry(0.33, 12, 10), { pos: [-1.30, 4.48, -52.20] }));
    C.push(place(new THREE.CapsuleGeometry(0.16, 0.85, 4, 10), {
      pos: [-1.84, 3.50, -52.95], rot: [1.1, 0, 0],
    }));
    C.push(place(new THREE.CapsuleGeometry(0.16, 0.75, 4, 10), {
      pos: [-0.80, 3.52, -52.95], rot: [1.1, 0, 0],
    }));

    // ---- glazing.  A raked front pane and a flat roof pane, split by polished
    // mullions: a single curved bubble reads as a toy, and the mullions are
    // what give the glass a scale.
    const wsZ = -(p2[0] + p3[0]) / 2;                         // -55.30
    const wsY = (p2[1] + p3[1]) / 2;                          // 4.275
    const wsL = Math.hypot(p2[0] - p3[0], p3[1] - p2[1]);     // 2.94
    const t = Math.atan2(p2[0] - p3[0], p3[1] - p2[1]);       // rake from vertical
    G.push(place(new THREE.PlaneGeometry(6.2, wsL), { pos: [0, wsY, wsZ], rot: [t - Math.PI, 0, 0] }));
    G.push(place(new THREE.PlaneGeometry(6.2, 4.3), { pos: [0, 5.34, -52.1], rot: [-Math.PI / 2, 0, 0] }));
    // mullions and the windscreen frame
    R.push(place(slab(6.7, 0.28, 0.28, 0.08), { pos: [0, p3[1], -p3[0]] }));
    R.push(place(slab(6.7, 0.32, 0.32, 0.09), { pos: [0, p2[1], -p2[0]] }));
    R.push(place(slab(6.7, 0.26, 0.26, 0.07), { pos: [0, p4[1], -p4[0]] }));
    for (const s of [1, -1]) {
      R.push(place(slab(0.30, 0.32, wsL, 0.08), { pos: [1.75 * s, wsY, wsZ], rot: [t - Math.PI / 2, 0, 0] }));
      R.push(place(slab(0.30, 0.32, 4.2, 0.08), { pos: [1.75 * s, 5.38, -52.1] }));
    }
  }

  /* --------------------------------------------------------- truss neck
     Exposed structure between head and hull. The gap is deliberate: it is what
     separates two masses in the silhouette instead of one continuous lump.

     ---- radial gauge ----------------------------------------------------
     See `rseg` at the top of the file: the rule is arc length, not a number,
     and it is applied rather than remembered because applying it by hand is
     how a 0.3 m handrail ended up correctly gauged next to a 5.2 m fuselage
     that was a fourteen-sided prism. None of it is worth a triangle budget —
     the whole ship comes to a few tens of thousands against a frame that
     already draws about a million. */
  {
    for (const s of [1, -1]) {
      // longerons — polished, because a raking star running down four parallel
      // bright lines is the cheapest depth cue on the ship
      R.push(place(new THREE.CylinderGeometry(0.42, 0.42, 26, rseg(0.42, 18)), {
        pos: [2.6 * s, 1.5, -30], rot: [Math.PI / 2, 0, 0],
      }));
      R.push(place(new THREE.CylinderGeometry(0.42, 0.42, 26, rseg(0.42, 18)), {
        pos: [2.6 * s, -1.5, -30], rot: [Math.PI / 2, 0, 0],
      }));
      // diagonal bracing
      for (let i = 0; i < 6; i++) {
        const z = -42 + i * 4.4;
        S.push(place(new THREE.CylinderGeometry(0.28, 0.28, 5.2, rseg(0.28, 12)), {
          pos: [2.6 * s, 0, z], rot: [0, 0, 0],
        }));
        S.push(place(new THREE.CylinderGeometry(0.24, 0.24, 6.6, rseg(0.24, 12)), {
          pos: [2.6 * s, 0, z + 2.2], rot: [(i % 2 ? 1 : -1) * 0.75, 0, 0],
        }));
      }
      // conduit bundle running the length of the neck
      S.push(place(new THREE.CylinderGeometry(0.55, 0.55, 25, rseg(0.55, 18)), {
        pos: [3.4 * s, -0.2, -30], rot: [Math.PI / 2, 0, 0],
      }));
    }
    // spine keel
    S.push(place(slab(2.0, 1.4, 26, 0.3), { pos: [0, 0, -30] }));
    // umbilical run along the keel, with three inspection lamps on it
    for (let i = 0; i < 3; i++) {
      L.push(place(new THREE.PlaneGeometry(0.30, 0.30), {
        pos: [0, -0.78, -38 + i * 8], rot: [Math.PI / 2, 0, 0],
      }));
    }
  }

  /* ------------------------------------------------------- pressure hull
     The habitable core, and the widest thing in the silhouette of every
     exterior shot. It spent a long time as a fourteen-sided prism with 2.3 m
     facets on the argument that faceting reads as built rather than extruded.
     It does not: at 26 degrees a step the drum reads as a *prism*, the
     cylindrical decal unwrap creases at every corner, and the anti-glare top
     coat — which keys off the surface normal — arrives as fourteen hard
     vertical bands instead of a gradient over the shoulder. What reads as
     built is the plating law and the frame rings, and both are still here.
     Gauged off arc length like everything else. */
  {
    const drum = new THREE.CylinderGeometry(5.2, 5.2, 30, rseg(5.2), 1, false);
    PB.push(place(drum, { pos: [0, 0, -6], rot: [Math.PI / 2, 0, 0] }));

    // forward and aft bulkhead rings, polished — a torus always presents a
    // tangent to the star from somewhere, so these are the specular hit that
    // never goes away whatever angle the ship is seen from
    for (const z of [-21.2, 9.2]) {
      R.push(place(new THREE.TorusGeometry(5.3, 0.42, 12, rseg(5.3)), { pos: [0, 0, z] }));
    }
    // intermediate frames
    for (const z of [-15, -9, -3, 3]) {
      S.push(place(new THREE.TorusGeometry(5.28, 0.30, 10, rseg(5.28)), { pos: [0, 0, z] }));
    }

    // Dorsal spine housing — instruments, and it breaks the round silhouette.
    // Its top deck is left clear and rails run down the edges instead of the
    // centre, because that deck is where the vessel name is painted and a
    // conduit run straight down the middle of it hid the whole wordmark.
    PF.push(place(slab(3.4, 2.2, 27, 0.4), { pos: [0, 6.0, -6] }));
    for (const s of [1, -1]) {
      R.push(place(slab(0.42, 0.34, 25, 0.11), { pos: [1.58 * s, 7.18, -6] }));
    }
    S.push(place(slab(1.0, 0.7, 5.0, 0.15), { pos: [0, 7.35, -19.5] }));

    // ventral instrument bay with open bay doors
    S.push(place(slab(6.0, 2.4, 13, 0.4), { pos: [0, -6.0, -8] }));
    for (const s of [1, -1]) {
      PF.push(place(slab(0.25, 2.6, 12, 0.1), { pos: [2.9 * s, -7.3, -8], rot: [0, 0, 0.55 * s] }));
    }

    // habitation viewports along the flank — small, cold, and the strongest
    // "someone lives in there" cue in the whole model. Four of the eight are
    // dark: a hull where every window is lit reads as a hotel, not a ship on a
    // three-year survey with half the crew asleep.
    const litPort = [true, false, true, true, false, true, true, false];
    for (let i = 0; i < 4; i++) {
      for (const s of [1, -1]) {
        const k = i * 2 + (s > 0 ? 0 : 1);
        (litPort[k] ? L : S).push(place(new THREE.CircleGeometry(0.62, rseg(0.62, 28)), {
          pos: [5.15 * s, 1.4, -16 + i * 6], rot: [0, Math.PI / 2 * s, 0],
        }));
        R.push(place(new THREE.TorusGeometry(0.78, 0.20, 9, rseg(0.78, 30)), {
          pos: [5.1 * s, 1.4, -16 + i * 6], rot: [0, Math.PI / 2 * s, 0],
        }));
      }
    }

    // starboard airlock: a raised hatch with a polished coaming and a lamp over
    // it. A door is worth more than a dozen greebles — it is the only part that
    // states a human scale outright.
    MC.push(place(new THREE.CylinderGeometry(1.85, 1.95, 0.55, rseg(1.95)), {
      pos: [5.25, -1.1, 4.4], rot: [0, 0, Math.PI / 2],
    }));
    R.push(place(new THREE.TorusGeometry(1.9, 0.14, 8, rseg(1.9)), { pos: [5.5, -1.1, 4.4], rot: [0, Math.PI / 2, 0] }));
    L.push(place(new THREE.PlaneGeometry(0.5, 0.22), { pos: [5.45, 1.05, 4.4], rot: [0, Math.PI / 2, 0] }));

    // cryogenic tankage, slung either side aft
    for (const s of [1, -1]) {
      PB.push(place(new THREE.CapsuleGeometry(2.5, 9, aseg(2.5, Math.PI / 2, 4, 10), rseg(2.5)), {
        pos: [6.4 * s, -1.6, 4], rot: [Math.PI / 2, 0, 0],
      }));
      R.push(place(new THREE.TorusGeometry(2.55, 0.22, 9, rseg(2.55)), { pos: [6.4 * s, -1.6, 0.6] }));
      R.push(place(new THREE.TorusGeometry(2.55, 0.22, 9, rseg(2.55)), { pos: [6.4 * s, -1.6, 7.4] }));
      // saddle straps back to the hull
      S.push(place(slab(2.4, 0.5, 1.2, 0.1), { pos: [4.3 * s, -0.9, 1.2], rot: [0, 0, 0.5 * s] }));
      S.push(place(slab(2.4, 0.5, 1.2, 0.1), { pos: [4.3 * s, -0.9, 7.0], rot: [0, 0, 0.5 * s] }));
    }
  }

  /* ---------------------------------------------------------- dorsal sail
     A swept fin aft of the pressure hull, carrying the phased array and the
     squadron mark. It exists for the outline: a hull with a cross of flat
     panels through it reads as a satellite, and one tall raked plane at the
     back is what makes the same shape read as a vehicle with a stern. */
  {
    // polygon in (−z, y); the leading edge rakes aft as it rises
    P.push(place(panel([[-2.0, 4.8], [-19.0, 5.0], [-18.3, 15.4], [-11.8, 15.4]], 0.95, 0.22), {
      rot: [0, Math.PI / 2, 0],
    }));
    // polished leading edge and cap — the longest uninterrupted specular line
    // on the ship, and the one a raking star reads down like a struck match
    R.push(place(new THREE.CylinderGeometry(0.32, 0.32, 14.4, 14), {
      pos: [0, 10.1, 6.9], rot: [0.746, 0, 0],
    }));
    R.push(place(slab(0.62, 0.44, 6.6, 0.13), { pos: [0, 15.5, 15.1] }));
    // phased-array face, recessed into the sail on both flanks
    for (const s of [1, -1]) {
      S.push(place(slab(0.22, 4.4, 6.2, 0.10), { pos: [0.56 * s, 9.0, 12.0] }));
      L.push(place(new THREE.PlaneGeometry(5.4, 0.14), { pos: [0.70 * s, 7.1, 12.0], rot: [0, Math.PI / 2 * s, 0] }));
    }
    // root fillets into the dorsal housing
    for (const s of [1, -1]) {
      S.push(place(panel([[-2.0, 0], [-11.0, 0], [-9.0, 2.6]], 0.35, 0.08), {
        pos: [0.62 * s, 4.9, 0], rot: [0, Math.PI / 2, 0],
      }));
    }
  }

  /* ------------------------------------------------------ radiator vanes
     Two large flat panels in a shallow V, swept aft. These are the ship's
     signature: they present a big, simple, angled plane that catches the key
     light and throws a hard edge across the frame, which is what gives every
     shot a diagonal. The sweep is what stops the pair reading as a crossbar. */
  const vanes = [];
  const lamps = [];
  const lampGeo = new THREE.SphereGeometry(0.30, 12, 9);
  const lampMat = (hex, i) => new THREE.MeshBasicMaterial({
    color: new THREE.Color(hex).multiplyScalar(i), toneMapped: false,
  });
  const addLamp = (pos, hex, i, parent) => {
    const l = new THREE.Mesh(lampGeo, lampMat(hex, i));
    l.position.set(pos[0], pos[1], pos[2]);
    l.frustumCulled = false;
    (parent || root).add(l);
    lamps.push(l);
    return l;
  };

  /* ---- how a leaf is actually built -------------------------------------
     Each leaf was one slab: `slab(len, 0.30, 4.6, 0.18)`, which the kit clamps
     to 34 mm of chamfer on a 4.6 m chord and a 20 m span — under a pixel at any
     distance the vane is ever framed from, so the leading edge produced no
     highlight line at all under a raking key. Three of them, uniform section
     end to end, mirrored exactly port and starboard.

     What replaces it is a framed panel. Edge rails and chordwise stiffeners of
     real section carry a core recessed to three different depths, so a raking
     sun cuts three separate lines down the chord instead of sliding off one
     flat face. The planform tapers and the forward tip corner is cropped and
     capped. Nothing about the silhouette changes: same span, same sweep, same
     shallow V — this is section and construction, not a redesign. */
  const VWR = 0.52, VHR = 0.90;      // edge rail: across the chord, and depth
  const VWRIB = 0.36, VHRIB = 0.64;  // spanwise rib between two bays
  // f0, f1 across the core; half thickness; and where that bay sits in depth.
  // The three are deliberately unequal — a core stepped to one depth is still
  // one plane, and it is the *difference* between the steps that draws a line.
  const VBAY = [
    [0.000, 0.300, 0.115, 0.065],
    [0.345, 0.635, 0.075, -0.050],
    [0.680, 1.000, 0.150, 0.010],
  ];
  const VRIBF = [0.322, 0.657];
  const VSTIFF = [0.115, 0.285, 0.455, 0.625, 0.775, 0.905];

  /* A bar of real section between two points in the vane's plan (x, z). The
     rails follow the taper, so no member on the assembly is axis aligned. */
  const barXZ = (a, b, y, wid, hgt, bev) => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    return place(slab(Math.hypot(dx, dz), hgt, wid, bev), {
      rot: [0, Math.atan2(-dz, dx), 0],
      pos: [(a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2],
    });
  };

  /* Sutherland–Hodgman against one half-plane. The cropped corner is a single
     straight cut across the whole planform, so every strip it touches is
     clipped by the same line rather than authored short by hand — which is
     what keeps the crop reading as one cut rather than as a staircase. */
  const clipHalf = (pts, nx, nz, d) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const A = pts[i], B = pts[(i + 1) % pts.length];
      const da = nx * A[0] + nz * A[1] - d, db = nx * B[0] + nz * B[1] - d;
      if (da <= 0) out.push(A);
      if ((da < 0) !== (db < 0)) {
        const t = da / (da - db);
        out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]);
      }
    }
    return out;
  };

  const prng = (seed) => {
    let x = seed >>> 0;
    return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  };

  const VX0 = 6.4;                   // where a leaf's root rib meets the header
  const buildLeaf = (L, face, frame) => {
    const { len, zc, cR, cT, sw, crop, cdep, ph } = L;
    const x1 = VX0 + len;
    const zl0 = zc - cR / 2, zl1 = zc - cT / 2 + sw;
    const zt0 = zc + cR / 2, zt1 = zc + cT / 2 + sw;
    const X = (t) => VX0 + t * len;
    const LEz = (t) => zl0 + t * (zl1 - zl0);
    const TEz = (t) => zt0 + t * (zt1 - zt0);
    // f runs between the rails, so a bay tapers with the planform the way a
    // real bay does — the ribs converge toward the tip instead of running
    // parallel down a rectangle.
    const pt = (t, f) => {
      const a = LEz(t) + VWR, b = TEz(t) - VWR;
      return [X(t), a + f * (b - a)];
    };
    const P = [x1 - crop, LEz(1 - crop / len)];
    const Q = [x1, LEz(1) + cdep];
    let nx = Q[1] - P[1], nz = -(Q[0] - P[0]);
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    let d = nx * P[0] + nz * P[1];
    if (nx * VX0 + nz * zc - d > 0) { nx = -nx; nz = -nz; d = -d; }
    const sd = (p) => nx * p[0] + nz * p[1] - d;
    const cut = (A, B) => {          // fraction of A->B still inside the crop
      const a = sd(A), b = sd(B);
      if (b <= 0) return 1;
      if (a > 0) return 0;
      return a / (a - b);
    };
    const mix2 = (A, B, t) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];

    // the recessed core, three bays at three depths
    for (const [f0, f1, half, yo] of VBAY) {
      const q = clipHalf([pt(0, f0), pt(1, f0), pt(1, f1), pt(0, f1)], nx, nz, d);
      if (q.length < 3) continue;
      face.push(place(panel(q, half * 2, half * 0.75), { rot: [Math.PI / 2, 0, 0], pos: [0, yo, 0] }));
    }
    // spanwise ribs between them, proud of the core and below the rails
    for (const f of VRIBF) {
      const A = pt(0, f), B = pt(1, f);
      face.push(barXZ(A, mix2(A, B, cut(A, B)), 0, VWRIB, VHRIB, 0.18));
    }
    /* Chordwise stiffeners. Unevenly spaced, every one a different length
       because the planform tapers, and *offset leaf to leaf* — three leaves
       whose rungs line up across the gaps read as one ladder, which is the one
       thing in a frame the eye goes to first and the reason cross bracing
       between the leaves was tried here once and taken out again. */
    for (let k = 0; k < VSTIFF.length; k++) {
      const t = Math.min(0.955, Math.max(0.06, VSTIFF[k] + ph));
      const A = pt(t, 0), B = pt(t, 1);
      const f0 = 1 - cut(B, A);
      if (f0 > 0.86) continue;
      face.push(barXZ(mix2(A, B, f0), B, 0, 0.34 + (k % 3) * 0.05, 0.50 + (k % 2) * 0.09, 0.16));
    }
    // edge rails, and the cap that closes the frame round the cropped corner
    const lrA = [X(0), LEz(0) + VWR / 2], lrB = [x1, LEz(1) + VWR / 2];
    face.push(barXZ(lrA, mix2(lrA, lrB, cut(lrA, lrB)), 0, VWR, VHR, 0.22));
    face.push(barXZ([X(0), TEz(0) - VWR / 2], [x1, TEz(1) - VWR / 2], 0, VWR, VHR, 0.22));
    face.push(barXZ(P, Q, 0, VWR * 0.86, VHR * 0.82, 0.20));
    face.push(barXZ([x1 - VWR / 2, Q[1]], [x1 - VWR / 2, TEz(1)], 0, VWR * 0.86, VHR * 0.82, 0.20));

    /* A dark backbone under the leaf, stepped down at half span. Three pale
       rectangles with nothing behind them is the "printed wing" read; the step
       is what says the section was sized for the load it carries. */
    const m0 = pt(0, 0.5), m1 = pt(0.52, 0.5), m2 = pt(1, 0.5);
    frame.push(barXZ(m0, m1, -0.66, 0.70, 0.76, 0.22));
    frame.push(barXZ(m1, mix2(m0, m2, cut(m0, m2)), -0.60, 0.48, 0.52, 0.18));
    return { pt, cut, sd, mix2, x1, LEz, TEz, X };
  };

  /* Two assemblies, and they are not each other's reflection: different trim
     angles, a different outer leaf length, a different sweep on the planform
     and their own micrometeoroid patching. */
  const VANE_SIDES = [
    { s: 1, baseZ: 0.400, yaw: -0.260, sw: 0.95, short: 0.0, seed: 0x5f27a1 },
    { s: -1, baseZ: -0.344, yaw: 0.222, sw: 0.58, short: 1.8, seed: 0xa14b09 },
  ];

  for (const V of VANE_SIDES) {
    const s = V.s;
    const g = new THREE.Group();
    const face = [];    // pale ceramic: the panel and its own frame
    const frame = [];   // dark structure: spars, boom, header, patching
    const rn = prng(V.seed);

    const leaves = [];
    for (let i = 0; i < 3; i++) {
      leaves.push(buildLeaf({
        len: 19.8 + i * 2.6 - (i === 2 ? V.short : 0),
        zc: -5.2 + i * 5.2,
        cR: 4.90 - i * 0.10,
        cT: 3.25 - i * 0.10,
        sw: V.sw + i * 0.22,
        crop: 2.5 + i * 0.35,
        cdep: 1.45 + i * 0.12,
        ph: (i - 1) * 0.055 + (V.s > 0 ? 0 : 0.028),
      }, face, frame));
    }

    /* The header. Waste heat has to *get* to a radiator, and the pipe that
       carries it is the one part of the assembly that explains what the panels
       are for — with a supply and a return where each leaf ties in, so the
       hardware repeats without any two fittings being the same. */
    frame.push(place(new THREE.CylinderGeometry(0.46, 0.46, 17.4, 18), {
      pos: [VX0 - 1.1, -0.12, 0], rot: [Math.PI / 2, 0, 0],
    }));
    for (const e of [-8.7, 8.7]) {
      frame.push(place(new THREE.CylinderGeometry(0.30, 0.50, 0.62, 18), {
        pos: [VX0 - 1.1, -0.12, e], rot: [Math.PI / 2 * Math.sign(e), 0, 0],
      }));
    }
    for (let i = 0; i < 3; i++) {
      const zc = -5.2 + i * 5.2;
      for (let k = 0; k < 2; k++) {
        const zf = zc + (k ? 1.55 : -1.32) - i * 0.12;
        const r = k ? 0.27 : 0.22;
        frame.push(place(new THREE.CylinderGeometry(r, r, 1.9 + k * 0.35, 14), {
          pos: [VX0 - 0.35, -0.06, zf], rot: [0, 0, Math.PI / 2],
        }));
        frame.push(place(new THREE.TorusGeometry(r * 1.5, 0.085, 8, 16), {
          pos: [VX0 + 0.5 + k * 0.18, -0.06, zf], rot: [0, Math.PI / 2, 0],
        }));
        // a saddle clamp where the stub leaves the header
        frame.push(place(slab(0.55, 0.80, r * 2.6, 0.16), { pos: [VX0 - 1.05, -0.10, zf] }));
      }
    }

    /* The boom, turned in three steps with a collar at each joint rather than
       run out as one seven-sided prism 380 mm across and 24 m long — the facets
       on that were countable at half a ship-length. */
    const bx = [5.9, 14.0, 22.0, 29.4], br = [0.46, 0.38, 0.30, 0.22];
    for (let i = 0; i < 3; i++) {
      frame.push(place(new THREE.CylinderGeometry(br[i], br[i + 1], bx[i + 1] - bx[i], 16), {
        pos: [(bx[i] + bx[i + 1]) / 2, -0.72, 0], rot: [0, 0, Math.PI / 2],
      }));
      frame.push(place(new THREE.TorusGeometry(br[i + 1] * 1.30, 0.075, 8, 18), {
        pos: [bx[i + 1], -0.72, 0], rot: [0, Math.PI / 2, 0],
      }));
    }
    // and a triangulated fan off it to the outer leaves, with real end fittings
    for (const [bxx, li, t] of [[11.4, 0, 0.30], [11.4, 2, 0.30], [21.0, 0, 0.72], [21.0, 2, 0.70]]) {
      const a = leaves[li].pt(t, 0.5);
      if (leaves[li].sd(a) > -0.4) continue;
      frame.push(...strut([bxx, -0.72, 0], [a[0], -0.34, a[1]], 0.20, 0.16, 12, 0.15));
    }

    /* Micrometeoroid patching. A survey boat three years out has taken hits,
       and the doublers riveted over them are the cheapest thing on the ship
       that says so — dark plate on a pale ceramic face, in different places on
       each side, which is most of what stops the pair reading as one asset
       drawn twice. */
    const np = 5 + Math.floor(rn() * 4);
    for (let k = 0; k < np; k++) {
      const lf = leaves[Math.floor(rn() * 3)];
      const by = VBAY[Math.floor(rn() * 3)];
      const p = lf.pt(0.10 + rn() * 0.80, by[0] + 0.14 + rn() * Math.max(0.02, by[1] - by[0] - 0.28));
      if (lf.sd(p) > -0.6) continue;
      const r = 0.30 + rn() * 0.44;
      const up = rn() < 0.55 ? 1 : -1;
      const y = by[3] + up * (by[2] + 0.05);
      frame.push(place(new THREE.CylinderGeometry(r, r * 0.88, 0.12, rseg(r, 14)), {
        pos: [p[0], y, p[1]], rot: [0, rn() * 3.1, 0],
      }));
      if (r > 0.52) {
        frame.push(place(new THREE.TorusGeometry(r * 0.97, 0.055, 6, rseg(r * 0.97, 20)), {
          pos: [p[0], y + up * 0.03, p[1]], rot: [Math.PI / 2, 0, 0],
        }));
      }
    }

    const faceGeo = mergeGeometries(face, false);
    faceGeo.computeVertexNormals();
    creaseNormals(faceGeo);
    face.forEach((x) => x.dispose());
    const mesh = new THREE.Mesh(faceGeo, radiator);
    mesh.scale.x = s;
    mesh.frustumCulled = false;
    g.add(mesh);

    const sparGeo = mergeGeometries(frame, false);
    sparGeo.computeVertexNormals();
    creaseNormals(sparGeo);
    frame.forEach((x) => x.dispose());
    const spar = new THREE.Mesh(sparGeo, structure);
    // The vanes live in their own frame, so they get their own occupancy: the
    // spar under a leaf and the header at its root are what cast the contact
    // shadows that stop three pale panels reading as one printed wing.
    bakeSurface([faceGeo, sparGeo], occupancy([faceGeo, sparGeo], 0.50));
    spar.scale.x = s;
    spar.frustumCulled = false;
    g.add(spar);

    // A shallow V opening upward, raked aft. The pair reads as one continuous
    // diagonal across the frame, which is the whole reason the vanes exist.
    g.position.set(3.4 * s, 1.2, 2);
    g.rotation.y = V.yaw;
    g.rotation.z = V.baseZ;
    g.userData.baseZ = g.rotation.z;
    root.add(g);
    vanes.push(g);

    // port red / starboard green, riding the tip of the outermost leaf so they
    // stay at the widest points of the ship however the vanes are trimmed
    const tip = leaves[2];
    addLamp([(tip.x1 - 1.0) * s, 0.35, tip.TEz(1) - 0.8], s > 0 ? 0x30ff60 : 0xff3020, 5.0, g);

    /* Hinge and root fairing. The trunnion carries knuckles rather than being
       one length of pipe, and the fairing is a profile rather than a box — an
       axis-aligned rectangle is exactly what a housing must not be. */
    R.push(place(new THREE.CylinderGeometry(0.95, 0.95, 4.2, rseg(0.95, 24)), {
      pos: [4.4 * s, 1.2, 2], rot: [0, 0, Math.PI / 2],
    }));
    for (const kz of [-1.55, 1.55]) {
      R.push(place(new THREE.TorusGeometry(1.06, 0.15, 8, rseg(1.06, 24)), {
        pos: [4.4 * s, 1.2, 2 + kz], rot: [0, Math.PI / 2, 0],
      }));
    }
    S.push(place(panel([
      [-6.0, -0.35], [-4.6, -1.10], [4.4, -1.15], [6.0, -0.40],
      [6.0, 0.50], [4.4, 1.20], [-4.6, 1.05], [-6.0, 0.42],
    ], 3.4, 0.30), { rot: [0, Math.PI / 2, 0.40 * s], pos: [4.9 * s, 0.6, 2] }));
  }

  /* --------------------------------------------------- engine outriggers
     Dark composite bodies on bone pylons. The value inversion is deliberate:
     the engines are the heaviest, hottest thing on the ship and painting them
     the same cream as the pressure hull is what made the whole stern read as
     one continuous lump. */
  const nacelles = [];

  /* The thrust frame. Both booms used to root at the ship's centreline in open
     space aft of the pressure hull, overlapping each other there, and the mass
     that read as their attachment was that accidental overlap. Thrust has to
     get into the hull somewhere; this is where. Stepped, so the collar that
     bolts to the aft ring is a separate thing from the keel that runs away
     from it. */
  S.push(place(loftBox([
    [0.0, 2.45, 1.62], [0.5, 2.72, 1.86], [1.1, 2.66, 1.80],
    [1.5, 2.44, 1.60], [4.4, 2.30, 1.52], [6.6, 2.10, 1.38, -0.06],
    [8.6, 1.84, 1.16, -0.14],
  ], 0.34), { rot: [0, -Math.PI / 2, 0], pos: [0, -1.30, 8.7] }));

  for (const s of [1, -1]) {
    const x = 11.0 * s, y = -3.4, z = 17.0;

    /* ---- the outrigger boom.
       It was `slab(11.5, 2.2, 3.4, 0.4)`: one rectangular section, the same at
       the root as at the nacelle, axis aligned, and the mirror of the other
       one. A strut is deepest where the bending moment is and every real one
       shows it, so this is a loft — 4.7 m of section at the root down to 2.6 at
       the nacelle, with a stepped fairing collar where it leaves the frame and
       a triangulated jury strut under it. Same sweep, same drop, same place in
       the silhouette; it is the section that was wrong, not the layout.

       Authored along +X from the root and carried out to the nacelle by one
       transform, so the conduit and the strut lugs are placed against the boom
       rather than guessed at in ship space. The port side is turned about Y
       rather than scaled: a negative scale bakes reversed winding into the
       geometry, which the merge has no way to undo. */
    const XF = { rot: [0.16, s > 0 ? 0 : Math.PI, -0.26 * s], pos: [1.3 * s, -1.30, 13.5] };
    const bl = (list, geo) => { const t = place(geo, XF); geo.dispose(); list.push(t); };

    bl(P, loftBox([
      // the first station is buried inside the thrust frame: a boom that ends
      // in a visible capped face is a part standing next to a hull, not in it
      [-1.1, 2.26, 1.34], [0.0, 2.30, 1.36], [1.9, 2.22, 1.32],
      [4.1, 1.98, 1.16, -0.06],
      // a knuckle at the jury-strut station: a pylon changes section where a
      // load comes into it, and a pure linear taper never does
      [5.9, 1.82, 1.06, -0.11], [6.2, 1.66, 0.98, -0.12],
      [9.0, 1.46, 0.79, -0.22], [11.4, 1.30, 0.72, -0.28],
    ], 0.38));
    // the fairing: a shroud round the root that steps down onto the boom
    bl(S, loftBox([
      [0.4, 2.58, 1.66], [2.1, 2.48, 1.56], [3.0, 2.44, 1.50, -0.03],
      [3.16, 2.18, 1.28, -0.04], [4.6, 2.04, 1.18, -0.09],
    ], 0.26));
    // A rubbing strake and a conduit run, both proud of the top face and both
    // following it down as the section shrinks. These are the third scale of
    // detail: the boom has form, it has parting lines, and now it has hardware.
    bl(R, loftBox([
      [1.6, 0.22, 0.17, 1.42, 1.05], [5.4, 0.19, 0.15, 1.08, 0.90],
      [10.4, 0.16, 0.13, 0.58, 0.72],
    ], 0.06));
    bl(T, loftBox([
      [1.2, 0.22, 0.22, 1.44, -1.06], [6.0, 0.20, 0.20, 1.00, -0.86],
      [10.6, 0.16, 0.16, 0.54, -0.70],
    ], 0.06));
    for (const cx of [2.7, 5.4, 8.3]) {
      const f = (cx - 1.2) / 9.4;
      bl(T, place(slab(0.28, 0.56, 0.60, 0.14), {
        pos: [cx, 1.44 - f * 0.90, -1.06 + f * 0.36],
      }));
    }

    /* The jury strut: a vee in plan from two lugs on the thrust frame out to
       two lugs on the boom, plus the short member that closes the triangle.
       An 11 m cantilever carrying a fusion drive with nothing bracing it is
       the detail that makes a pylon read as a placed box. */
    const JU = [
      [[2.15 * s, -2.45, 10.4], [8.2 * s, -3.40, 12.3]],
      [[2.15 * s, -2.45, 16.4], [8.2 * s, -3.40, 14.7]],
    ];
    for (const [a, b] of JU) {
      T.push(...strut(a, b, 0.23, 0.18, 12, 0.16));
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      T.push(...strut(m, [5.9 * s, -3.05, 13.5], 0.16, 0.14, 12, 0.12));
    }

    // nacelle body
    // Segment counts run high on everything cylindrical aft. The merge
    // recomputes normals on de-indexed geometry, so every primitive here is
    // flat shaded whatever it was authored as, and a twenty-sided capsule in a
    // metallic material turns into black and white stripes under a hard key.
    S.push(place(new THREE.CapsuleGeometry(2.6, 13, aseg(2.6, Math.PI / 2, 4, 10), rseg(2.6)), {
      pos: [x, y, z], rot: [Math.PI / 2, 0, 0],
    }));
    // intake shroud, forward
    R.push(place(new THREE.CylinderGeometry(2.75, 2.3, 3.0, rseg(2.75), 1, true), {
      pos: [x, y, z - 8.0], rot: [Math.PI / 2, 0, 0],
    }));
    S.push(place(new THREE.TorusGeometry(2.5, 0.3, 11, rseg(2.5)), { pos: [x, y, z - 9.4] }));
    // magnetic containment rings — the drive's visual rhythm
    for (let i = 0; i < 4; i++) {
      (i === 1 ? R : A).push(place(new THREE.TorusGeometry(2.72, 0.30, 11, rseg(2.72)), { pos: [x, y, z - 4.5 + i * 3.2] }));
    }
    // a lit coolant run along the top of each nacelle
    L.push(place(new THREE.PlaneGeometry(0.16, 11.0), { pos: [x, y + 2.68, z], rot: [-Math.PI / 2, 0, 0] }));
    /* Bell nozzle, aft. It used to be built the wrong way round — three's
       CylinderGeometry puts radiusTop at +Y, which after the quarter turn is
       +Z, so `(2.05, 3.15)` was a nozzle that *converged* going aft with its
       3.15 lip hoop floating clear of a 2.05 throat. Read from behind that is
       a shroud ring with a disc behind it, which is exactly what the engines
       looked like. A nozzle expands. */
    T.push(place(new THREE.CylinderGeometry(3.15, 2.05, 5.2, rseg(3.15), 1, true), {
      pos: [x, y, z + 9.4], rot: [Math.PI / 2, 0, 0],
    }));
    /* The liner, wound *inside out*. An open tube seen from astern shows the
       renderer its back faces and is culled, so the thing the art director
       described as "the bell interior, which stays dark grey" was never the
       bell at all — it was the nacelle cap seen straight down an empty pipe.
       Mirroring a cylinder in X leaves the shape alone and reverses the
       winding, which is what puts a real, lit surface inside the nozzle for
       the drive glow to fall on. */
    S.push(place(new THREE.CylinderGeometry(2.85, 1.85, 5.0, rseg(2.85), 1, true), {
      pos: [x, y, z + 9.4], rot: [Math.PI / 2, 0, 0], scale: [-1, 1, 1],
    }));
    R.push(place(new THREE.TorusGeometry(3.15, 0.26, 11, rseg(3.15)), { pos: [x, y, z + 11.9] }));
    // a throat collar where the bell meets the nacelle: the join is what tells
    // you the nozzle is bolted to the drive rather than moulded out of it
    R.push(place(new THREE.TorusGeometry(2.16, 0.20, 10, rseg(2.16)), { pos: [x, y, z + 6.9] }));

    nacelles.push({ x, y, z });
  }

  /* --------------------------------------------------------- survey dish
     Offset to port. The asymmetry is the point — a perfectly mirrored ship
     reads as a decal, and this is the part that says the vessel has a job. */
  const dishPivot = new THREE.Group();
  dishPivot.position.set(-4.2, 7.2, -14);
  {
    // A shallow open bowl, not a hemisphere: a deep dome reads as a featureless
    // egg from every angle, and the whole value of a dish in silhouette is the
    // concave face and the feed standing off it.
    const parts = [];
    const bowl = new THREE.SphereGeometry(6.4, rseg(6.4), aseg(6.4, Math.PI * 0.20, 6, 16),
      0, Math.PI * 2, Math.PI * 0.80, Math.PI * 0.20);
    parts.push(place(bowl, { rot: [Math.PI, 0, 0] }));
    // The rim hoop is a twelve-metre circle seen almost edge-on from most
    // angles, so it is the single worst offender on the ship for sub-pixel
    // crawl. A quarter-metre section is still a rim and it holds together.
    parts.push(place(new THREE.TorusGeometry(6.35, 0.26, 10, rseg(6.35)), { rot: [Math.PI / 2, 0, 0], pos: [0, 1.05, 0] }));
    // radial stiffeners across the back
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push(place(slab(6.0, 0.34, 0.50, 0.10), {
        pos: [Math.cos(a) * 3.2, 0.35, Math.sin(a) * 3.2], rot: [Math.PI / 2, -a, 0],
      }));
    }
    // tripod feed legs and the feed horn itself
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      parts.push(place(new THREE.CylinderGeometry(0.18, 0.18, 4.6, rseg(0.18, 12)), {
        pos: [Math.cos(a) * 1.9, 2.4, Math.sin(a) * 1.9], rot: [0.42 * Math.cos(a + Math.PI / 2), 0, -0.42 * Math.cos(a)],
      }));
    }
    parts.push(place(new THREE.ConeGeometry(0.60, 1.5, rseg(0.60, 20)), { pos: [0, 4.5, 0], rot: [Math.PI, 0, 0] }));
    const dg = mergeGeometries(parts, false);
    dg.computeVertexNormals();
    creaseNormals(dg);
    parts.forEach((x) => x.dispose());
    bakeSurface([dg], occupancy([dg], 0.60));
    const dish = new THREE.Mesh(dg, dress(new THREE.MeshStandardMaterial({
      color: 0x8b877c, metalness: 0.20, roughness: 0.74, side: THREE.DoubleSide, envMapIntensity: 0.9,
    }), { plate: 1.6, bleach: 0.9, soot: 0.0, edge: 0.30 }));
    dish.frustumCulled = false;
    dishPivot.add(dish);
    root.add(dishPivot);

    // gimbal mast
    R.push(place(new THREE.CylinderGeometry(0.75, 0.95, 3.2, rseg(0.95, 24)), { pos: [-4.2, 5.6, -14] }));
  }

  /* --------------------------------------------------- greebles and rigging
     Small hardware at the scale a human would install it: RCS quads, handrails,
     antennae, tanks. Kept mostly along edges and junctions, which is where real
     hardware lives, rather than scattered. */
  {
    // RCS thruster quads at the four extremes — where they would actually work
    const quad = (px, py, pz, rz) => {
      for (const d of [[0.9, 0], [-0.9, 0], [0, 0.9], [0, -0.9]]) {
        T.push(place(new THREE.CylinderGeometry(0.28, 0.40, 0.8, rseg(0.40, 14)), {
          pos: [px + d[0], py + d[1], pz], rot: [Math.PI / 2, 0, rz],
        }));
      }
      S.push(place(slab(2.6, 2.6, 0.6, 0.2), { pos: [px, py, pz + 0.5] }));
    };
    quad(7.2, 1.6, -46, 0); quad(-7.2, 1.6, -46, 0);
    quad(4.6, 3.2, 6, 0); quad(-4.6, 3.2, 6, 0);

    /* ---- minimum gauge -----------------------------------------------
       An 84 m hull is about three hundred pixels wide from the chase camera,
       so a metre of ship is three and a half pixels and a ten-centimetre whip
       antenna is a third of one. That does not render as a thin antenna, it
       renders as a stair-stepped ladder that crawls as the camera moves,
       because MSAA resolves a different subset of samples every frame.
       Nothing on this ship is allowed to be slenderer than about a quarter of
       a metre across; it makes the rigging read as *mast* rather than as
       wire, which is more honest about what a survey boom actually is. */

    // handrails along the dorsal spine — pure scale cue
    for (let i = 0; i < 9; i++) {
      T.push(place(new THREE.TorusGeometry(0.34, 0.105, 7, 16, Math.PI), {
        pos: [1.8, 7.1, -17 + i * 2.6], rot: [0, 0, 0],
      }));
    }

    // antenna farm on the dorsal housing
    for (let i = 0; i < 4; i++) {
      T.push(place(new THREE.CylinderGeometry(0.135, 0.21, 4.5 - i * 0.6, rseg(0.21, 12)), {
        pos: [1.4 - i * 0.9, 9.4, 2 + i * 1.4], rot: [0.1 * i, 0, 0.12 * (i - 1.5)],
      }));
      // a collar at the base, which is what stops a mast reading as a spike
      R.push(place(new THREE.CylinderGeometry(0.34, 0.40, 0.45, rseg(0.40, 14)), {
        pos: [1.4 - i * 0.9, 7.35 + i * 0.10, 2 + i * 1.4], rot: [0.1 * i, 0, 0.12 * (i - 1.5)],
      }));
    }

    // pressure bottles clustered on the ventral bay
    for (let i = 0; i < 3; i++) {
      T.push(place(new THREE.CapsuleGeometry(0.55, 2.2, 6, rseg(0.55, 18)), {
        pos: [-1.7 + i * 1.7, -7.5, -3], rot: [Math.PI / 2, 0, 0],
      }));
    }

    /* ---- landing gear ------------------------------------------------

       The most photographed part of the ship. Landing is something the player
       does and docking is not, so the camera spends more time within ten
       metres of a footpad than of anything else on this hull — and the gear
       was six primitives a leg: two cylinders, a thin brace, a bare sphere for
       a knee, a disc for a pad, a torus and one flat slab for a door. An art
       director reading the ship at 1:1 against Starfield called it a stick
       figure, and it was: a flat strap, a ball on a plate, and pads that never
       looked like they were touching the ground.

       What is here now is an oleo-pneumatic leg with the parts a leg has:

         a cast trunnion bolted through the belly, carrying a pin
         a cast head on that pin, and a turned barrel hanging off it
         a hard-chromed piston sliding out of a gland — the one polished
           surface on the ship, and about a thousandth of its area
         torque links across the sliding joint, so the piston cannot rotate
         a ribbed cast A-frame taking drag and side load back into the hull
         hydraulic lines routed down the aft face, clamped, with slack in them
         an articulated ankle on a cross pin
         a splayed four-toe footpad, bolted, that stays level while the leg
           leans — which is the entire reason an ankle exists

       Almost all of it is authored in **leg space**: X outboard, Y up the
       strut, Z aft, origin on the trunnion pin. One transform maps that onto
       the ship, and the port legs are turned about Y rather than mirrored —
       a negative scale bakes reversed winding into geometry the merge has no
       way to undo, which is the same reason the outrigger booms are built that
       way.

       The footpad is the deliberate exception: it is built in *ship* space,
       level, because the whole point of an articulated ankle is that the leg
       leans by nineteen degrees and the foot does not. Its dark sole plate
       finishes eight centimetres below the touchdown datum, so the pad cuts
       into the regolith instead of resting on it — the "the pads do not
       visibly touch the ground" note is half lighting and half the fact that
       nothing was ever pressed into anything. */
    const gearPaint = [];   // bone skin: the bay doors, which are hull
    const gearMach = [];    // castings, barrels, pads: machinery, not skin
    const gearDark = [];    // bay lining, sole plates, hose, clamps
    const gearTrim = [];    // pins, caps, rings, fasteners
    const gearRod = [];     // the chromed piston, and nothing else

    const LEAN = 0.34;              // radians the strut leans outboard
    const TY = -4.90;               // trunnion pin, in ship y
    const LEGLEN = 8.70;            // pin to ankle pivot

    for (const [lx, lz] of [[3.6, -16], [-3.6, -16], [10.2, 15], [-10.2, 15]]) {
      const out = Math.sign(lx);
      /* Leg space -> ship space. `place()` does the local rotate-and-move;
         everything after it is the leg's own attitude and station. */
      const put = (list, geo, o) => {
        const g = place(geo, o);
        if (out < 0) g.rotateY(Math.PI);
        g.rotateZ(out * LEAN);
        g.translate(lx, TY, lz);
        list.push(g);
        geo.dispose();
      };
      /* ...and the same map applied to a point, for anything that has to be
         built in ship space against something built in leg space. It has to be
         the *same* map, sign for sign. Written once with an unsigned lean it
         put every port footpad five metres outboard of the leg standing on it,
         which reads as a modelling collapse and is one wrong minus. */
      const cO = Math.cos(out * LEAN), sO = Math.sin(out * LEAN);
      const toShip = (p) => {
        const x = out < 0 ? -p[0] : p[0], z = out < 0 ? -p[2] : p[2];
        return [lx + x * cO - p[1] * sO, TY + x * sO + p[1] * cO, lz + z];
      };

      // ---- trunnion. A cast saddle let into the belly, and two lugs off it.
      // Swept fore-and-aft, deepest under the pin, because that is where the
      // load turns the corner.
      gearMach.push(place(loftBox([
        [-2.85, 0.95, 0.42], [-2.10, 1.28, 0.86], [-1.10, 1.42, 1.12],
        [1.10, 1.42, 1.12], [2.10, 1.28, 0.86], [2.85, 0.95, 0.42],
      ], 0.20), { rot: [0, Math.PI / 2, 0], pos: [lx + out * 0.30, -3.62, lz] }));
      gearDark.push(place(loftBox([
        [-3.25, 1.62, 0.30], [-2.60, 1.86, 0.52], [2.60, 1.86, 0.52],
        [3.25, 1.62, 0.30],
      ], 0.14), { rot: [0, Math.PI / 2, 0], pos: [lx + out * 0.25, -4.02, lz] }));
      for (const kz of [-0.98, 0.98]) {
        put(gearMach, panel([
          [-1.24, 1.30], [1.24, 1.30], [1.06, 0.22], [0.62, -0.46],
          [0, -0.62], [-0.62, -0.46], [-1.06, 0.22],
        ], 0.28, 0.09), { pos: [0, 0, kz] });
        put(gearTrim, new THREE.CylinderGeometry(0.52, 0.52, 0.34, rseg(0.52, 16)),
          { rot: [Math.PI / 2, 0, 0], pos: [0, 0, kz + (kz > 0 ? 0.18 : -0.18)] });
      }
      // the pin, and the caps that say it is a pin and not a hole
      put(gearTrim, new THREE.CylinderGeometry(0.30, 0.30, 2.86, rseg(0.30, 16)),
        { rot: [Math.PI / 2, 0, 0] });
      for (const kz of [-1.46, 1.46]) {
        put(gearTrim, new THREE.CylinderGeometry(0.44, 0.40, 0.16, rseg(0.44, 16)),
          { rot: [Math.PI / 2, 0, 0], pos: [0, 0, kz] });
        put(gearTrim, bolt(0.16, 0.14), { rot: [Math.PI / 2, 0, 0], pos: [0, 0, kz + Math.sign(kz) * 0.14] });
      }
      // fasteners round the trunnion flange — six a side, on the hull line
      for (let i = 0; i < 6; i++) {
        const bz = -2.35 + i * 0.94;
        for (const bx of [-1.28, 1.28]) {
          gearTrim.push(place(bolt(0.15, 0.13), { pos: [lx + out * 0.30 + bx, -4.36, lz + bz] }));
        }
      }

      // ---- head casting. The lump that turns a pin into a barrel; deeper
      // outboard, where the bending moment from the pad actually is.
      put(gearMach, loftBox([
        [0.00, 0.92, 0.80], [0.44, 0.98, 0.94], [1.05, 0.92, 0.90],
        [1.62, 0.84, 0.80], [1.92, 0.80, 0.74],
      ], 0.14), { rot: [0, 0, -Math.PI / 2], pos: [0, 0.54, 0] });

      // ---- barrel. Turned, with the raised bands a real cylinder carries
      // where it is thickened for a gland, a port and a mounting lug.
      put(gearMach, turned([
        [0.340, -6.16], [0.760, -6.16], [0.820, -6.06], [0.820, -5.70],
        [0.760, -5.58], [0.712, -5.50], [0.700, -4.34], [0.800, -4.26],
        [0.800, -4.08], [0.700, -4.00], [0.700, -2.94], [0.800, -2.86],
        [0.800, -2.68], [0.700, -2.60], [0.716, -1.60], [0.830, -1.50],
        [0.830, -1.26], [0.738, -1.18], [0.738, -1.02], [0.000, -0.96],
      ], rseg(0.83, 22)), {});
      /* Longitudinal ribs, on the quadrants the torque links and the hose run
         leave free. Lofted rather than extruded: a four-station loft is 60
         triangles where a bevelled slab is 240, and across four legs that
         difference paid for the whole footpad.

         `place()` applies rotations X, Y, Z and this needs Z then Y — stand the
         bar up the strut first, *then* swing it round the barrel — so the first
         turn and the radial offset are baked into the geometry and only the
         azimuth is left for `place`. */
      for (const th of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
        const rib = loftBox([
          [-1.92, 0.15, 0.10], [-1.62, 0.20, 0.15],
          [1.62, 0.20, 0.15], [1.92, 0.15, 0.10],
        ], 0.05);
        rib.rotateZ(Math.PI / 2);
        rib.translate(0.76, -3.50, 0);
        put(gearMach, rib, { rot: [0, th, 0] });
      }
      // gland nut and wiper: the joint the piston comes out of
      put(gearMach, bolt(0.90, 0.32), { pos: [0, -6.30, 0] });
      put(gearTrim, new THREE.TorusGeometry(0.42, 0.075, 6, rseg(0.42, 18)),
        { rot: [Math.PI / 2, 0, 0], pos: [0, -6.50, 0] });

      // ---- the piston. Ground, chromed, and the only hard specular streak
      // the brief allows anywhere on this vessel.
      put(gearRod, new THREE.CylinderGeometry(0.345, 0.345, 2.95, 22),
        { pos: [0, -7.00, 0] });
      put(gearMach, new THREE.CylinderGeometry(0.44, 0.40, 0.26, rseg(0.44, 18)),
        { pos: [0, -8.30, 0] });

      // ---- torque links. Two plates and three pins across the sliding joint;
      // the single detail that says "oleo" rather than "tube in a tube".
      const KNEE = [1.52, -6.98];
      const link = (a, b, r0, r1, w, th, zs) => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (const dz of zs) {
          put(gearMach, linkPlate(len, r0, r1, w, th), {
            rot: [0, 0, Math.atan2(b[1] - a[1], b[0] - a[0])], pos: [a[0], a[1], dz],
          });
        }
      };
      link([0.80, -5.58], KNEE, 0.30, 0.26, 0.16, 0.19, [0]);
      link(KNEE, [0.44, -8.14], 0.26, 0.28, 0.16, 0.16, [-0.26, 0.26]);
      for (const [px, py, pr] of [[0.80, -5.58, 0.15], [KNEE[0], KNEE[1], 0.14], [0.44, -8.14, 0.15]]) {
        put(gearTrim, new THREE.CylinderGeometry(pr, pr, 0.78, 10),
          { rot: [Math.PI / 2, 0, 0], pos: [px, py, 0] });
      }
      // the lugs the links hang off, on the barrel and on the piston end
      put(gearMach, loftBox([
        [-0.30, 0.24, 0.22], [0.30, 0.24, 0.22],
      ], 0.06), { rot: [0, 0, 0], pos: [0.86, -5.58, 0] });

      /* ---- drag braces. A vee in elevation from two points on the trunnion
         down to lugs on the barrel. Every other station is a rib: a cast
         member gets its stiffness from relief, and that relief is what a
         raking sun reads down the leg.

         They sit in the *fore-and-aft* plane, on the strut's own centreline,
         not outboard of it. Standing them proud of the barrel was the obvious
         first arrangement and it hid the entire oleo: from anywhere outboard —
         which is every angle a camera on the ground can reach — the barrel,
         the ribs, the gland and the torque links were behind two converging
         castings and the leg read as one solid trouser. A brace belongs behind
         the thing it braces. */
      const RIB = [
        [0.00, 0.50, 0.40], [0.05, 0.39, 0.31], [0.11, 0.32, 0.25],
        [0.16, 0.42, 0.34], [0.21, 0.31, 0.24],
        [0.34, 0.40, 0.32], [0.39, 0.29, 0.23],
        [0.52, 0.38, 0.31], [0.57, 0.28, 0.22],
        [0.70, 0.36, 0.29], [0.75, 0.27, 0.21],
        [0.86, 0.35, 0.28], [0.91, 0.28, 0.23], [1.00, 0.40, 0.33],
      ];
      for (const bz of [-1, 1]) {
        put(gearMach, beam([0.12, 0.16, bz * 2.62], [0.24, -4.16, bz * 0.86],
          RIB, 0.055, [1, 0, 0]));
        put(gearTrim, bolt(0.19, 0.16),
          { rot: [Math.PI / 2, 0, 0], pos: [0.12, 0.16, bz * 2.78] });
        put(gearMach, loftBox([
          [-0.24, 0.40, 0.30], [0.24, 0.40, 0.30],
        ], 0.07), { rot: [0, Math.PI / 2, 0], pos: [0.20, -4.16, bz * 0.86] });
      }

      // ---- hydraulic lines. Two, down the aft face, clamped three times, with
      // a slack loop across the moving joint so the run reads as flexible.
      for (const [dz, sag] of [[0.00, 0.36], [0.26, 0.21]]) {
        put(gearDark, hose([
          [0.10, 0.34, 1.00 + dz], [0.52, -0.55, 0.96 + dz], [0.70, -1.90, 0.86 + dz],
          [0.74, -3.60, 0.84 + dz], [0.78, -5.20, 0.84 + dz],
          [0.94 + sag, -6.10, 0.74 + dz], [0.72 + sag, -7.10, 0.60 + dz],
          [0.38, -7.95, 0.46 + dz], [0.20, -8.34, 0.32 + dz],
        ], 0.105, 26, 7), {});
      }
      for (const cy of [-1.90, -3.60, -5.20]) {
        put(gearMach, loftBox([
          [-0.16, 0.30, 0.13], [0.16, 0.30, 0.13],
        ], 0.05), { pos: [0.80, cy, 0.92] });
      }

      // ---- ankle. A fork on the piston, a cross pin, and the pad's own
      // knuckle between them — three parts, articulated, instead of a ball.
      for (const dz of [-0.46, 0.46]) {
        put(gearMach, panel([
          [-0.44, 0.34], [0.44, 0.34], [0.40, -0.30], [0.22, -0.52],
          [-0.22, -0.52], [-0.40, -0.30],
        ], 0.26, 0.08), { pos: [0, -8.62, dz] });
      }
      put(gearTrim, new THREE.CylinderGeometry(0.21, 0.21, 1.42, 12),
        { rot: [Math.PI / 2, 0, 0], pos: [0, -8.70, 0] });
      for (const dz of [-0.74, 0.74]) {
        put(gearTrim, bolt(0.21, 0.11), { rot: [Math.PI / 2, 0, 0], pos: [0, -8.70, dz] });
      }

      /* ---- the footpad, in ship space and level.
         Four toes on a dished hub, bolted round, with a dark sole plate that
         finishes below the touchdown datum. `pz` is the pad's own centre,
         taken from where the ankle pin actually lands rather than guessed. */
      const [pcx, , pcz] = toShip([0, -LEGLEN, 0]);
      const PY = -13.10;              // ankle pin, ship y  (TY - LEGLEN*cos)
      const pad = (list, geo, o = {}) => {
        const g = place(geo, o);
        g.translate(pcx, 0, pcz);
        list.push(g);
        geo.dispose();
      };
      // the knuckle that reaches up between the fork plates
      pad(gearMach, loftBox([
        [0.00, 0.50, 0.54], [0.30, 0.40, 0.44], [0.72, 0.31, 0.35], [1.06, 0.28, 0.32],
      ], 0.09), { rot: [0, 0, Math.PI / 2], pos: [0, -14.02, 0] });
      // a crush ring under it: a footpad has to absorb the last of the descent
      for (const ry of [-13.96, -13.84]) {
        pad(gearTrim, new THREE.TorusGeometry(0.50, 0.070, 6, rseg(0.50, 18)),
          { rot: [Math.PI / 2, 0, 0], pos: [0, ry, 0] });
      }
      /* The hub — turned, dished, with a raised bolt land round the knuckle.
         The bolt circle and the land ring were `trim` for one pass, and
         `polished()`'s wear mask turned a 2.4 m ring and twelve heads into a
         bright white hoop with teeth in it, which is the single loudest thing
         in the frame at ten metres. They are castings. They go on the same
         material as the pad they are cast into, and only the pins stay
         polished — which is exactly the rule the brief states. */
      pad(gearMach, turned([
        [0.000, -14.54], [1.18, -14.54], [1.42, -14.47], [1.60, -14.30],
        [1.68, -14.12], [1.63, -13.97], [1.45, -13.87], [1.18, -13.81],
        [0.94, -13.78], [0.76, -13.75], [0.66, -13.69], [0.000, -13.65],
      ], rseg(1.68, 24, 40)), {});
      pad(gearMach, new THREE.TorusGeometry(1.28, 0.10, 6, rseg(1.28, 22, 36)),
        { rot: [Math.PI / 2, 0, 0], pos: [0, -13.82, 0] });
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
        pad(gearMach, bolt(0.12, 0.11),
          { pos: [Math.cos(a) * 1.04, -13.71, Math.sin(a) * 1.04] });
      }
      // four toes, splayed, tapering in plan *and* in section, tips turned up
      // so the pad can rock onto an uneven site instead of teetering on a disc
      for (let i = 0; i < 4; i++) {
        const th = i * Math.PI / 2;
        pad(gearMach, loftBox([
          [1.02, 0.82, 0.24, 0.00], [1.75, 0.86, 0.21, 0.03], [2.35, 0.76, 0.17, 0.09],
          [2.80, 0.56, 0.14, 0.19], [3.02, 0.36, 0.11, 0.31],
        ], 0.08), { rot: [0, th, 0], pos: [0, -14.32, 0] });
        // a rib along the spine of each toe, standing proud of it
        const spine = loftBox([
          [-0.90, 0.15, 0.13], [-0.60, 0.19, 0.19], [0.60, 0.17, 0.15], [0.92, 0.13, 0.10],
        ], 0.05);
        spine.translate(1.92, -14.06, 0);
        pad(gearMach, spine, { rot: [0, th, 0] });
        /* The dark sole. It is what actually meets the ground, it follows the
           toe's own lift so the two do not separate at the tip, and it finishes
           below the touchdown datum: the pad has to *cut* into the regolith,
           because a pad resting exactly on a plane reads as floating however
           good the shadow is. */
        pad(gearDark, loftBox([
          [1.00, 0.78, 0.060, 0.000], [1.90, 0.80, 0.055, 0.030],
          [2.45, 0.68, 0.050, 0.095], [2.92, 0.42, 0.045, 0.245],
        ], 0.03), { rot: [0, th, 0], pos: [0, -14.60, 0] });
      }
      pad(gearDark, new THREE.CylinderGeometry(1.24, 1.32, 0.12, rseg(1.32, 20, 36)),
        { pos: [0, -14.60, 0] });

      /* ---- bay doors. Two, hinged on the long edges, hanging open. Each is a
         stiffened panel rather than a plank: skin, edge rails, three ribs and
         three hinge knuckles, because at ten metres a door with no inside is
         the loudest thing in the frame. */
      for (const dir of [1, -1]) {
        const flip = out * dir < 0;
        const rot = [0, flip ? Math.PI : 0, -(out * dir) * 1.28];
        const pos = [lx + out * dir * 1.72, -4.46, lz];
        const dp = (list, geo, o) => {
          const g = place(geo, o);
          if (rot[1]) g.rotateY(rot[1]);
          g.rotateZ(rot[2]);
          g.translate(pos[0], pos[1], pos[2]);
          list.push(g);
          geo.dispose();
        };
        /* The skin is bone, because a bay door is hull and reads as hull when
           it is closed. Everything on its inner face is frame, and the frame is
           lofted: eight two-station lofts cost less than one bevelled slab, and
           the whole point is that a door seen from underneath has ribs on the
           back of it rather than being a plank with two sides. */
        dp(gearPaint, panel([
          [0.06, -2.66], [1.70, -2.52], [1.70, 2.52], [0.06, 2.66],
        ], 0.15, 0.06), { rot: [Math.PI / 2, 0, 0] });
        for (const [ex, hw] of [[0.20, 0.14], [1.60, 0.13]]) {
          dp(gearMach, loftBox([
            [-2.58, hw, 0.16], [2.58, hw, 0.16],
          ], 0.05), { rot: [0, Math.PI / 2, 0], pos: [ex, 0.16, 0] });
        }
        for (const ez of [-2.55, 2.55]) {
          dp(gearMach, loftBox([
            [0.14, 0.13, 0.15], [1.64, 0.13, 0.15],
          ], 0.05), { pos: [0, 0.16, ez] });
        }
        for (const rz of [-1.28, 1.28]) {
          dp(gearMach, loftBox([
            [0.20, 0.11, 0.13], [1.58, 0.11, 0.13],
          ], 0.04), { pos: [0, 0.15, rz] });
        }
        for (const hz of [-2.05, 0, 2.05]) {
          dp(gearTrim, new THREE.CylinderGeometry(0.17, 0.17, 0.44, 10),
            { rot: [Math.PI / 2, 0, 0], pos: [0.03, 0, hz] });
          dp(gearMach, loftBox([
            [-0.06, 0.20, 0.20], [0.34, 0.18, 0.16],
          ], 0.05), { pos: [0, 0, hz] });
        }
        // and a ram, so the door is held open by something
        dp(gearTrim, new THREE.CylinderGeometry(0.075, 0.075, 1.20, 8),
          { rot: [0, 0, 0.52], pos: [0.66, 0.50, -2.05] });
        dp(gearMach, bolt(0.14, 0.16), { rot: [0, 0, 0.52], pos: [1.18, 0.20, -2.05] });
      }
    }

    const gear = new THREE.Group();
    const gearMesh = [weld(gearPaint, paint, gear), weld(gearMach, machinery, gear),
      weld(gearDark, structure, gear), weld(gearTrim, trim, gear),
      weld(gearRod, chrome, gear)].filter(Boolean).map((m) => m.geometry);
    /* Finer than the hull's 0.85 m grid. A leg is a metre across where the
       fuselage is thirty, so at hull resolution the whole assembly reads as one
       solid block and the bake finds neither the shadow under a torque link nor
       the wear on a pad rim — which is most of what makes an articulated joint
       read as articulated. */
    bakeSurface(gearMesh, occupancy(gearMesh, 0.42));
    gear.visible = false;
    root.add(gear);
    hullOut.gear = gear;

    // sensor boom off the prow — long, thin, and it gives the nose a point
    R.push(place(new THREE.CylinderGeometry(0.10, 0.32, 16, rseg(0.32, 14)), {
      pos: [0, 0.2, -66], rot: [Math.PI / 2, 0, 0],
    }));
    for (let i = 0; i < 3; i++) {
      T.push(place(new THREE.TorusGeometry(0.58 - i * 0.12, 0.115, 8, rseg(0.58 - i * 0.12, 20)), { pos: [0, 0.2, -62 + i * -3.2] }));
    }
  }

  /* ------------------------------------------------------ merge and mount */
  const allGeo = [];       // everything solid, for the occupancy bake
  const bakeGeo = [];      // the subset that carries the hull shader
  const mkMesh = (list, mat, order, dressed) => {
    if (!list.length) return null;
    const g = mergeGeometries(list, false);
    /* Flat shading is what a de-indexed merge gives you, and it is why every
       barrel on this ship has always been a prism. creaseNormals() averages
       across any joint under 32 degrees, which is every step of a gauged
       cylinder and no chamfer, bevel or box corner anywhere. */
    g.computeVertexNormals();
    creaseNormals(g);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    if (order) m.renderOrder = order;
    root.add(m);
    list.forEach((x) => x.dispose());
    allGeo.push(g);
    if (dressed) bakeGeo.push(g);
    return m;
  };
  mkMesh(P, paint, 0, true);
  mkMesh(PB, paintBig, 0, true);
  mkMesh(PF, paintFine, 0, true);
  mkMesh(S, structure, 0, true);
  mkMesh(T, metal, 0, true);
  mkMesh(MC, machinery, 0, true);
  mkMesh(R, trim, 0, true);
  mkMesh(A, accent, 0, true);
  mkMesh(C, cabin);
  mkMesh(L, lit);
  mkMesh(G, glass, 4);

  /* The bake. A shader knows a position and a normal and nothing at all about
     what the rest of the ship is doing three metres away, which is why a
     procedural hull has no shadow where a collar lands on a tube and no wear
     on the lip of a nozzle. One coarse occupancy pass over the whole vessel
     answers both at once — see bakeSurface(). It costs tens of milliseconds,
     once, and nothing per frame. */
  bakeSurface(bakeGeo, occupancy(allGeo, 0.85));

  /* ------------------------------------------------------------- lights
     Navigation lights are the only thing on the hull that is emissive at rest,
     and they are what stops the ship being a hole in the starfield when it is
     between the camera and the dark side of a world. */
  const strobe = addLamp([0, 15.9, 15.4], 0xffffff, 0.0);
  addLamp([0, 0.2, -59.6], 0xffd8a8, 2.2);

  /* -------------------------------------------------------- engine plumes
     Both torches are one mesh and both throat cores are another, so the whole
     drive costs two draws rather than the four the old disc-and-cone pair did.
     Radiance is authored in real HDR: the core runs 200-500 units against a
     clip point around 120, which is what makes an engine read as a light
     source rather than as a pale shape painted inside the bell. */
  const engineMats = [];
  {
    const PLEN = 26;
    const cones = nacelles.map((n) => place(plumeCone(PLEN), {
      pos: [n.x, n.y, n.z + 7.4],
    }));
    const geo = mergeGeometries(cones, false);
    cones.forEach((c) => c.dispose());
    const mat = new THREE.ShaderMaterial({
      vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG,
      transparent: true, depthWrite: false,
      // the far wall only — see the note by the chord term
      side: THREE.BackSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: {
        uTime: { value: 0 }, uPower: plumePower,
        uColA: { value: new THREE.Color(1.00, 0.97, 0.94) },
        uColB: { value: new THREE.Color(0.40, 0.62, 1.00) },
        uColC: { value: new THREE.Color(0.16, 0.20, 0.78) },
      },
    });
    const plume = new THREE.Mesh(geo, mat);
    plume.renderOrder = 12;
    plume.frustumCulled = false;
    root.add(plume);
    engineMats.push(mat);

    // the throat cores, one quad each, camera facing
    const q = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
    const nq = nacelles.length;
    const pos = new Float32Array(nq * 12), uvv = new Float32Array(nq * 8);
    const ctr = new Float32Array(nq * 12);
    const idx = new Uint16Array(nq * 6);
    for (let i = 0; i < nq; i++) {
      const n = nacelles[i];
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        pos[v * 3] = q[k][0]; pos[v * 3 + 1] = q[k][1];
        uvv[v * 2] = q[k][2]; uvv[v * 2 + 1] = q[k][3];
        ctr[v * 3] = n.x; ctr[v * 3 + 1] = n.y; ctr[v * 3 + 2] = n.z + 10.9;
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    tg.setAttribute('uv', new THREE.BufferAttribute(uvv, 2));
    tg.setAttribute('aCenter', new THREE.BufferAttribute(ctr, 3));
    tg.setIndex(new THREE.BufferAttribute(idx, 1));
    const tmat = new THREE.ShaderMaterial({
      vertexShader: THROAT_VERT, fragmentShader: THROAT_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: {
        uTime: { value: 0 }, uPower: plumePower,
        // Sized so the bell mouth always holds a hot core, and no larger: the
        // nozzle wall has to be able to occlude it from the side or the ship
        // wears a glowing halo round each nacelle.
        uSize: { value: 1.90 * M },
        uColA: { value: new THREE.Color(1.00, 0.98, 0.95) },
        uColB: { value: new THREE.Color(0.42, 0.66, 1.00) },
      },
    });
    const throat = new THREE.Mesh(tg, tmat);
    throat.renderOrder = 11;
    throat.frustumCulled = false;
    root.add(throat);
    engineMats.push(tmat);
  }

  root.scale.setScalar(M);
  root.traverse((o) => {
    o.frustumCulled = false;
    // Solid hull casts and receives; emitters, plumes and glass do not — an
    // additive quad in a shadow map is a black rectangle.
    if (o.isMesh && o.material && !o.material.transparent && o.material.type !== 'MeshBasicMaterial') {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return {
    root, engineMats, radiator, vanes, dishPivot, strobe, lamps, gear: hullOut.gear,
    nacelles: nacelles.map((n) => new THREE.Vector3(n.x * M, n.y * M, (n.z + 13) * M)),
    length: 84 * M,
  };
}
