import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeInteriorMaterials, dressedVariant, withKitAo, emissive, emissiveWeld, bindGlass, INTERIOR_LAYER } from './interiorMaterials.js';

/* ============================================================================
   The habitable module of the Pale Seeker, built in metres.

        -Z nose                                              +Z tail
   ┌──────────────┬──────────────┬──────────────────────────┐
   │   COCKPIT    │   CORRIDOR   │        HABITAT           │
   │ seat, dash,  │  conduits,   │ nav table, archive,      │
   │ canopy       │  lockers     │ resonance chamber, port  │
   └──────────────┴──────────────┴──────────────────────────┘
      -7.6 .. -3.4    -3.4 .. 0.6      0.6 .. 7.2

   Everything is parented to the ship, so with the floating origin in play the
   local coordinates stay in the range of a few metres and precision is exact.
   The whole group is scaled to world units at the end (1 unit = 1 km).
   ========================================================================== */

// The interior is rendered in its own pass with its own camera, so it stays at
// 1 unit = 1 metre. Scaling it into world units (1 unit = 1 km) put every light
// within three's distance-attenuation clamp — max(d^decay, 0.01) — which pinned
// every lamp at 100x and blew the cabin to white.
const M_TO_WORLD = 0.001;   // only used to offset the *exterior* camera

/* Scratch for the aperture test. One raycaster, reused: `seesSky` runs once per
   contact per HUD update and allocating a Raycaster and two Vector3s each time
   is garbage in the middle of a 16 ms budget. Its layers are opened up because
   everything in the cabin is moved onto INTERIOR_LAYER, and a Raycaster only
   tests layer 0 by default — which would have returned "no glass anywhere" and
   hidden every contact in the game. */
const _rc = new THREE.Raycaster();
_rc.layers.enableAll();
_rc.far = 12;
const _rcNdc = new THREE.Vector3();
const _rcDir = new THREE.Vector3();

/* ---------------------------------------------------------------- helpers */

function roundedProfile(hw, h, r, seg = 5) {
  const p = [];
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (a1 - a0) * (i / seg);
      p.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  };
  arc(hw - r, r, -Math.PI / 2, 0);          // bottom right
  arc(hw - r, h - r, 0, Math.PI / 2);       // top right
  arc(-hw + r, h - r, Math.PI / 2, Math.PI);// top left
  arc(-hw + r, r, Math.PI, Math.PI * 1.5);  // bottom left
  return p;
}

/** Open-ended shell between two Z planes — no end caps, so you can see through. */
function shellGeo(pts, z0, z1) {
  const n = pts.length;
  const pos = [];
  const idx = [];
  for (const q of pts) pos.push(q.x, q.y, z0);
  for (const q of pts) pos.push(q.x, q.y, z1);
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n, c = i + n, d = ((i + 1) % n) + n;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Flat ring between two profiles at one Z.
 *
 * The sections have different cross-sections — the corridor is much narrower
 * than the cockpit and habitat — so where they meet there is an annular gap.
 * The tube walls simply stopped, and you could see straight out of the ship
 * through the step at every bulkhead. The collars were short lengths of tube,
 * which do not close a gap in the *plane* of the joint.
 *
 * Both profiles come from roundedProfile, which always emits the same number of
 * points, so corresponding vertices can be zipped together directly.
 */
function ringGeo(outer, inner, z) {
  const n = outer.length;
  const pos = [];
  const idx = [];
  for (const q of outer) pos.push(q.x, q.y, z);
  for (const q of inner) pos.push(q.x, q.y, z);
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n, c = i + n, d = ((i + 1) % n) + n;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Open strip lofted between two polylines — the halves of a hull, rather than a
 * closed tube.
 *
 * The cockpit was a single constant-section tube with its front end left open,
 * which is geometrically a rectangular room with a hole punched in one wall,
 * and read exactly like one. Splitting the section into a lower tub and an
 * upper roof lets the two taper independently and lets the roof stop short, so
 * the space above the waist can become glass.
 */
function stripGeo(ptsA, ptsB, zA, zB) {
  const n = Math.min(ptsA.length, ptsB.length);
  const pos = [];
  const idx = [];
  for (let i = 0; i < n; i++) pos.push(ptsA[i].x, ptsA[i].y, zA);
  for (let i = 0; i < n; i++) pos.push(ptsB[i].x, ptsB[i].y, zB);
  for (let i = 0; i < n - 1; i++) {
    const a = i, b = i + 1, c = i + n, d = i + 1 + n;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Lower half of a rounded section, from one waist corner round to the other.
 *
 * `pan` sinks the flat run between the two corner arcs by that many metres,
 * and it is the third instance of the deck z-fight in this file. Both arcs are
 * tangent to y = 0, so the run between them lands in exactly the plane the
 * kit's `cp_tub` pan occupies — 23.5 m² of it, the whole cockpit deck, and
 * made worse than a kit-against-kit fight because `hullShell` is DoubleSide,
 * so there is no winding to cull it. Standing at the spawn and looking forward
 * it contested 0.93% of the frame; the deck plates at the far end of the
 * corridor flickered between two surfaces as the camera moved and stood still
 * in a screenshot, which is what a z-fight always does.
 *
 * The skin belongs *outside* the pan, not in the same plane as it, so the run
 * drops by the pan's own thickness and the corner arcs are left alone — a
 * 12 mm lip at the tangent point, under the deck, where nothing can see it.
 * Zero when there is no kit, because then this run is the only floor there is.
 */
function tubProfile(hw, h, r, waist, seg = 5, pan = 0) {
  const p = [new THREE.Vector2(hw, waist)];
  for (let i = 0; i <= seg; i++) {
    const a = -(Math.PI / 2) * (i / seg);
    p.push(new THREE.Vector2(hw - r + Math.cos(a) * r, r + Math.sin(a) * r));
  }
  if (pan > 0) {
    p.push(new THREE.Vector2(hw - r, -pan));
    p.push(new THREE.Vector2(-hw + r, -pan));
  }
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI / 2 - (Math.PI / 2) * (i / seg);
    p.push(new THREE.Vector2(-hw + r + Math.cos(a) * r, r + Math.sin(a) * r));
  }
  p.push(new THREE.Vector2(-hw, waist));
  return p;
}

/** Upper half of the same section — the roof, or the glass that replaces it. */
function roofProfile(hw, h, r, waist, seg = 5) {
  const p = [new THREE.Vector2(hw, waist)];
  for (let i = 0; i <= seg; i++) {
    const a = (Math.PI / 2) * (i / seg);
    p.push(new THREE.Vector2(hw - r + Math.cos(a) * r, h - r + Math.sin(a) * r));
  }
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (Math.PI / 2) * (i / seg);
    p.push(new THREE.Vector2(-hw + r + Math.cos(a) * r, h - r + Math.sin(a) * r));
  }
  p.push(new THREE.Vector2(-hw, waist));
  return p;
}

/**
 * The same loft as `stripGeo`, but carrying a UV set — and built over *all* the
 * canopy's stations at once rather than one span at a time.
 *
 * The glass needs a UV set and the hull shells do not: everything else in the
 * cabin is surfaced triplanar from cabin-space position, but a pane has to know
 * how far it is from its own edge — that is where the seal is, and the seal is
 * where the dirt is. u runs across the arc from one waist sill to the other,
 * v runs aft-to-forward over the whole canopy rather than per segment, so the
 * fringe does not appear at the join between the two lofted sections.
 *
 * Two things here were wrong for a long time and both showed up as a line down
 * the middle of the windscreen.
 *
 *  · **u was the vertex index, not arc length.** `roofProfile(…, 12)` returns
 *    28 points of which 26 sit on the two corner radii, so the 2.8 m flat
 *    across the roof was *one* segment and landed between u = 0.481 and 0.519.
 *    Anything authored against uv therefore ran about thirteen times finer down
 *    the centreline of the pane than at its edges, with a hard discontinuity
 *    either side — which is exactly where the seam was. Arc length is the only
 *    parameterisation that means anything to a shader measuring distance from
 *    a seal.
 *  · **each span was its own mesh, so normals were computed per mesh.** The two
 *    strips share the whole ring at z = -6.45 and disagreed about its normal by
 *    the full angle between the two spans, which lights the shared edge as a
 *    seam. One geometry over every station shares those vertices, so
 *    `computeVertexNormals` averages across the joint the way it should.
 *
 * `stations` is a list of `{ pts, z, v }`, aft to forward.
 */
function glassGeo(stations) {
  const n = Math.min(...stations.map((s) => s.pts.length));
  const pos = [], uvs = [], idx = [];
  for (const s of stations) {
    // normalised arc length across this ring. Adjacent spans share a profile,
    // so the parameterisation is continuous through every joint.
    const acc = [0];
    for (let i = 1; i < n; i++) {
      acc.push(acc[i - 1] + Math.hypot(s.pts[i].x - s.pts[i - 1].x,
        s.pts[i].y - s.pts[i - 1].y));
    }
    const total = acc[n - 1] || 1;
    for (let i = 0; i < n; i++) {
      pos.push(s.pts[i].x, s.pts[i].y, s.z);
      uvs.push(acc[i] / total, s.v);
    }
  }
  for (let r = 0; r < stations.length - 1; r++) {
    for (let i = 0; i < n - 1; i++) {
      const a = r * n + i, b = r * n + i + 1;
      const c = a + n, d = b + n;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A shallow domed pane closing a profile, with radial UVs.
 *
 * The canopy used to be roof glass over an *open* nose: straight ahead, at the
 * one elevation the pilot actually flies at, there was nothing between the eye
 * and space but a 2.5 m hole in the front of the hull. That is why the glazing
 * read as a hazy band above the view rather than as a windscreen — the part of
 * the frame you look through was not glazed at all.
 *
 * Rings rather than a fan from one vertex: a single apex gives every triangle a
 * different normal at the centre and the Fresnel term pinches to a star there.
 * `bulge` is how far forward the centre of the pane stands — flat glass
 * photographs as a poster, and the whole read here is curvature.
 *
 * This one photographed as a **dark bowtie lying across the planet**, right
 * through the middle of the windscreen, and it was two faults compounding.
 *
 *  · **The radial profile was a hemisphere**, `sqrt(1 - k²)`, whose slope is
 *    infinite at the rim. With only three rings that put two thirds of the
 *    160 mm of bulge into the *outermost* band, so the widest ring in the pane
 *    was also the steepest — a strip of glass turned nearly edge-on to the eye.
 *    Glass at grazing incidence takes the whole Fresnel term while the pane
 *    either side of it takes almost none, so the band went dark. It read as a
 *    bowtie because the ring is fat where the rim is far from the pane's centre
 *    (the two sides, 1.24 m out) and thin where it is near (the roof and the
 *    sill, 0.37 m), and the thin top of it hides behind the coaming. A
 *    paraboloid has finite slope everywhere and is also the right shape: a
 *    canopy pane is a shallow cap, not a bubble.
 *  · **The outline handed in is open and the loft closed it with `% n`.**
 *    `roofProfile` runs from one waist sill, over the roof, to the other, so
 *    wrapping the index bridged the two sills with a single 2.5 m segment.
 *    Lofted inward that becomes one enormous near-horizontal quad lying across
 *    the bottom of the aperture — a bar at sill height, and a random metal bar
 *    across the glass is exactly how it reads. The sill is a real
 *    edge of the pane and has to be *there*; what it must not be is one
 *    segment while its neighbours are 100 mm. Resampling the closed outline at
 *    uniform arc length gives it the same treatment as every other edge.
 */
function domeGeo(pts, cx, cy, z, bulge, dir = -1, rimN = 96, rings = 7) {
  /* Close the outline, then walk it at uniform arc length. */
  const src = pts.map((p) => [p.x, p.y]);
  src.push(src[0]);
  const seg = [], cum = [0];
  for (let i = 0; i < src.length - 1; i++) {
    seg.push(Math.hypot(src[i + 1][0] - src[i][0], src[i + 1][1] - src[i][1]));
    cum.push(cum[i] + seg[i]);
  }
  const total = cum[cum.length - 1] || 1;
  const rim = [];
  for (let s = 0, i = 0; s < rimN; s++) {
    const t = (s / rimN) * total;
    while (i < seg.length - 1 && cum[i + 1] < t) i++;
    const f = seg[i] > 1e-9 ? (t - cum[i]) / seg[i] : 0;
    rim.push([src[i][0] + (src[i + 1][0] - src[i][0]) * f,
      src[i][1] + (src[i + 1][1] - src[i][1]) * f]);
  }
  const n = rim.length;
  const ang = rim.map((p) => Math.atan2(p[1] - cy, p[0] - cx));
  const pos = [], uvs = [], idx = [];
  for (let r = 0; r < rings; r++) {
    const k = 1 - r / rings;
    /* Tangent at the rim *and* at the apex. The pane's rim is not round —
       1.24 m out at the sides and 0.37 m at the roof and the sill — and every
       ring is a radial scaling of it, so the surface slope in any direction is
       the bulge divided by the rim radius in that direction. A profile with
       slope at the rim therefore turns three times as hard over the roof as it
       does over the side glass, and *that* difference is the saddle the eye
       reads. A smoothstep has zero slope at both ends and puts what curvature
       there is in the middle of the pane where it is seen face-on. */
    const t = 1 - k;
    const dz = dir * bulge * t * t * (3 - 2 * t);
    for (let i = 0; i < n; i++) {
      pos.push(cx + (rim[i][0] - cx) * k, cy + (rim[i][1] - cy) * k, z + dz);
      // Radial UV normalised against the boundary *in that direction*, so
      // |uv - 0.5| is the fractional distance in from the rim whatever shape
      // the rim happens to be — the aperture here is a rounded arch, not a
      // circle, and a plain planar projection would put the dirt fringe in a
      // ring floating inside the pane rather than against the seal.
      uvs.push(0.5 + 0.5 * k * Math.cos(ang[i]), 0.5 + 0.5 * k * Math.sin(ang[i]));
    }
  }
  pos.push(cx, cy, z + dir * bulge); uvs.push(0.5, 0.5);
  const apex = rings * n;
  for (let r = 0; r < rings - 1; r++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = r * n + i, b = r * n + j, c = (r + 1) * n + i, d = (r + 1) * n + j;
      idx.push(a, c, b, b, c, d);
    }
  }
  const last = (rings - 1) * n;
  for (let i = 0; i < n; i++) idx.push(last + i, apex, last + ((i + 1) % n));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Solid cap across a profile, fanned from its centre. Closes the hull ends. */
function capGeo(pts, z, cy) {
  const pos = [0, cy, z];
  const idx = [];
  for (const q of pts) pos.push(q.x, q.y, z);
  const n = pts.length;
  for (let i = 0; i < n; i++) idx.push(0, 1 + i, 1 + ((i + 1) % n));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* Chamfered by default. A hard 90-degree edge catches no light and is the
   single loudest "untextured box" tell; a 12 mm chamfer picks up a highlight
   from every lamp in the room and costs a few dozen triangles. */
const _rbCache = new Map();
function box(w, h, d, mat, x = 0, y = 0, z = 0, r = 0.012) {
  const rad = Math.min(r, w * 0.32, h * 0.32, d * 0.32);
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${rad.toFixed(4)}`;
  let g = _rbCache.get(key);
  if (!g) { g = new RoundedBoxGeometry(w, h, d, 1, rad); _rbCache.set(key, g); }
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}
/** Flat box, for things too thin to chamfer (light strips, decals). */
function sbox(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function cyl(rt, rb, h, seg, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}

/* ------------------------------------------------------------------ build */

export function buildInterior(assets = {}) {
  const M = makeInteriorMaterials(assets);
  const kit = assets.kit || {};
  const aoTex = assets.tex?.kitAo || null;
  const root = new THREE.Group();
  const screens = [];
  const stations = [];
  const lights = [];
  const animated = [];

  const HW = 2.05, H = 2.55, R = 0.55;          // hull half-width, height, corner
  const CHW = 1.15, CH = 2.25, CR = 0.4;        // corridor cross-section
  const DECK_TOP = 0.08;                        // walking surface, kit and JS agree
  const profile = roundedProfile(HW, H, R);
  const cProfile = roundedProfile(CHW, CH, CR);

  const add = (m) => { root.add(m); return m; };

  // Shells are viewed from the inside, so they need their own back-faced
  // materials — flipping `side` on the shared ones would invert every box too.
  M.hullShell = dressedVariant(M.hull, { side: THREE.DoubleSide });
  M.darkShell = dressedVariant(M.dark, { side: THREE.DoubleSide });
  M.accentShell = dressedVariant(M.accent, { side: THREE.DoubleSide });
  /* Thin plates laid onto another surface. The cabin had no polygonOffset
     anywhere, so every strip, placard and floor batten sat in the same depth
     plane as the thing it was stuck to and flickered against it as the camera
     moved. Pulling the decal toward the eye by a fraction of a depth unit is
     what that offset is for. */
  M.decal = dressedVariant(M.dark, {
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });

  /* ---------------------------------------------------------------- the kit
     Real geometry, modelled in Blender in these same metres and carrying a
     ray-traced occlusion atlas on its own UV set. `withKitAo` is the only
     place in the room with an aoMap, because it is the only geometry with a
     UV attribute to hang one on. */
  const KA = {
    KIT_HULL: withKitAo(M.hull, aoTex, 0.9),
    KIT_DARK: withKitAo(M.dark, aoTex, 0.9),
    KIT_ACCENT: withKitAo(M.accent, aoTex, 0.9),
    KIT_DECK: withKitAo(M.floor, aoTex, 0.8),
    KIT_RAIL: withKitAo(M.rail, aoTex, 0.7),
    KIT_SEAT: withKitAo(M.seat, aoTex, 0.85),
    KIT_RUBBER: withKitAo(M.rubber, aoTex, 0.85),
    KIT_SHELL: withKitAo(M.shell, aoTex, 0.9),
  };
  /* The same materials at cockpit scale.
     The projection is in metres of cabin space, and the tiles are authored for
     a bulkhead: 2.0 m for hull, 1.15 for dark, 1.6 for accent. That is right
     for a wall and it is why every part of the console read as one flat colour
     with a panel line cut into it. A throttle knob is 55 mm. At a 1.15 m tile
     it samples 5% of one cell of the map — which is to say it samples a
     constant, and constant albedo over a well-modelled part is exactly the
     "flat CG" tell, whatever the geometry underneath is doing. The rail
     material already learned this and was pulled to 0.26 m for the same
     reason; the flight deck is made of parts in the same size class.
     At 0.30 m the placards and stencilled type in the panel map land at 15 mm
     and stop being legible signwriting, which is the failure in the other
     direction — they become the plate grain and paint mottle that a
     hand-sized part actually has. */
  const cp = (mat, tile, over = {}) => dressedVariant(
    mat, { aoMap: aoTex || undefined, aoMapIntensity: 0.9 },
    { tile, detail: 1.15, ...over });
  const KC = !aoTex ? KA : {
    ...KA,
    KIT_HULL: cp(M.hull, 0.30),
    KIT_DARK: cp(M.dark, 0.28),
    KIT_ACCENT: cp(M.accent, 0.34),
    /* KIT_SHELL is deliberately NOT in this list, and that is the fix rather
       than an omission.
       M.shell is dressed with `set: 'panel'` — the same map that gives every
       bulkhead its plate seams — at a tile of 0.85 m, which over a seat back
       0.75 m wide and 1.0 m tall is *one plate*: a moulding with an edge and a
       grain and no seams across it, which is right. The cockpit set pulled it
       to 0.26 m along with everything else, and 260 mm plates on a moulded
       composite is exactly, literally, the review's finding — "the seat back is
       a flat slab wearing the same panel treatment as the bulkheads". It falls
       through to KA at the authored 0.85 now. (Retiling it to the soft set was
       tried and is worse: at any tile coarse enough to read as a moulding the
       weave becomes a visible herringbone across the whole shell, and at any
       tile fine enough to filter away it carries nothing at all.)

       The two genuinely soft ones do get pulled in, because they are the only
       materials in the ship the camera gets within 300 mm of: at the authored
       0.155 m a 62 mm harness strap samples a third of a cell and the whole
       belt comes back one flat value. */
    KIT_SEAT: cp(M.seat, 0.11, { detail: 0.62 }),
    KIT_RUBBER: cp(M.rubber, 0.09, { detail: 1.1 }),
  };
  const CP_PIECES = new Set(['cp_tub', 'cp_coaming', 'cp_pedestal', 'cp_seat',
    'cp_controls', 'cp_overhead', 'cp_canopy', 'cp_stow']);
  const placeKit = (name, x, y, z, ry = 0) => {
    const parts = kit[name];
    if (!parts) return false;
    const set = CP_PIECES.has(name) ? KC : KA;
    for (const p of parts) {
      const m = new THREE.Mesh(p.geo, set[p.mat] || set.KIT_HULL);
      m.position.set(x, y, z);
      if (ry) m.rotation.y = ry;
      // merged geometry keeps its UV set; see mergeStatic
      m.userData.kit = true;
      add(m);
    }
    return true;
  };
  const haveKit = !!kit.corr_bay && !!kit.hab_bay;

  /* ---------------------------------------------------------- hull shells */
  /* The cockpit is lofted rather than extruded, so it narrows into a nose.
     Stations along it: full section at the bulkhead, drawing in and dropping
     its waist toward the windscreen. The roof stops at -5.25; forward of that
     the space above the waist is glass, which is what makes it read as a
     canopy instead of a corridor with the end cut off. */
  /* These are tools/interior_bake/42_cockpit.py's NOSE, and they have to stay
     that way: the tub skin comes out of the kit and the hull shell is built
     here, so a waist that differs between the two leaves a slot of daylight
     running the length of the cockpit. The two forward waists came down 12 and
     10 cm to open the lower corners of the windscreen, which were plate. */
  const NOSE = [
    // z,     halfWidth, height, corner, waistY
    [-3.4, HW, H, R, 1.34],
    [-5.25, 1.97, 2.44, 0.57, 1.20],
    [-6.45, 1.78, 2.10, 0.60, 1.02],
    [-7.60, 1.24, 1.62, 0.52, 0.88],
  ];
  const GLASS_Z0 = NOSE[1][0], GLASS_Z1 = NOSE[NOSE.length - 1][0];
  for (let i = 0; i < NOSE.length - 1; i++) {
    const [z0, w0, h0, r0, y0] = NOSE[i];
    const [z1, w1, h1, r1, y1] = NOSE[i + 1];
    // The kit's cp_tub carries the cockpit pan; this skin has to sit under it
    // rather than in it. See tubProfile.
    const PAN = haveKit ? 0.012 : 0;
    add(new THREE.Mesh(
      stripGeo(tubProfile(w0, h0, r0, y0, 5, PAN), tubProfile(w1, h1, r1, y1, 5, PAN), z0, z1),
      M.hullShell));
    if (i === 0) {
      add(new THREE.Mesh(
        stripGeo(roofProfile(w0, h0, r0, y0), roofProfile(w1, h1, r1, y1), z0, z1), M.hullShell));
    }
    /* Canopy rail along the waist, where hull meets roof. Anodised alloy:
       this is what a pilot grabs climbing into the seat, and one of the very
       few things in the cabin allowed to be genuinely glossy.

       Only on the roofed section now. Forward of -5.25 the kit's canopy piece
       carries a real sill -- a channel with a gutter, a retaining strip and a
       sealant bead -- and a 32 mm round tube on exactly the same line was
       intersecting it. */
    for (const sx of (i === 0 ? [-1, 1] : [])) {
      const rail = cyl(0.032, 0.032, Math.abs(z1 - z0), 10, M.rail,
        sx * (w0 + w1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
      rail.rotation.x = Math.PI / 2;
      rail.rotation.z = Math.atan2((w0 - w1) * sx, Math.abs(z1 - z0));
      add(rail);
    }
  }
  /* The canopy, as one pane over every glazed station rather than a mesh per
     span. Twelve segments on each corner radius rather than five: the Fresnel
     term is driven entirely by the normal, so a faceted arc draws the sheen as
     a set of bands rather than as a gradient, and this is the one surface in
     the cabin where the normal *is* the material. See glassGeo for why the two
     spans had to be welded and why u is arc length. */
  /* The panes are kept in a list as well as in the scene. They are the cabin's
     aperture, and `seesSky` below answers "can the pilot see out along this
     ray?" by asking whether it leaves through one of them. */
  const glazing = [];
  {
    const vAt = (z) => (z - GLASS_Z0) / (GLASS_Z1 - GLASS_Z0);
    const m = new THREE.Mesh(glassGeo(NOSE.slice(1).map(([z, w, h, r, y]) => ({
      pts: roofProfile(w, h, r, y, 12), z, v: vAt(z),
    }))), M.glass);
    m.renderOrder = 14;
    bindGlass(m, M.glass);
    add(m);
    glazing.push(m);
  }
  /* The nose pane, closing the aperture the pilot actually looks through.
     Grime is pulled right back here and the polish left in: the middle of a
     windscreen is the one part of it anybody ever cleans, and it is also the
     part the whole game is played through. What is left is a rim of seal dirt
     against the nose ring and the polishing swirl when the star crosses it. */
  {
    const [zN, wN, hN, rN, yN] = NOSE[NOSE.length - 1];
    /* 55 mm, not 160. The aperture is 2.48 m across and 0.74 m tall, so
       160 mm of sag over its 370 mm half-height is a 43% rise — that is a
       bubble, not a windscreen, and it turned the pane through 40 degrees at
       the top rim. It photographed as a dark bowtie lying across the planet,
       dead centre in the one view the whole game is played through: glass at
       that angle takes the entire Fresnel term while the pane either side of
       it takes almost none. Flattening the mesh normals by hand made it
       vanish, which is what identified it. */
    const nose = new THREE.Mesh(
      domeGeo(roofProfile(wN, hN, rN, yN, 12), 0, (yN + hN) * 0.5, zN, 0.055),
      M.noseGlass);
    nose.renderOrder = 15;
    bindGlass(nose, M.noseGlass);
    add(nose);
    glazing.push(nose);
  }
  /* The corridor and the habitat are now the kit: four 1.00 m corridor bays
     and six 1.10 m habitat bays, each a complete slice of hull — deck, coving,
     walls, ceiling trough, frames, rubbing strake, conduit runs and rails, in
     one mesh, so the junctions between them are geometry rather than two
     surfaces that happen to meet. That is what carries the baked occlusion:
     the reviewer's largest single complaint was that no corner, panel join or
     floor/wall junction in the cabin ever darkened, and those places are
     unreachable by any lamp in the room by construction. */
  const CORR_Z = [-2.90, -1.90, -0.90, 0.10];
  const HAB_Z = [1.15, 2.25, 3.35, 4.45, 5.55, 6.65];
  if (haveKit) {
    for (const z of CORR_Z) placeKit('corr_bay', 0, 0, z);
    for (const z of HAB_Z) placeKit('hab_bay', 0, 0, z);
    placeKit('bulkhead', 0, 0, -3.40);
    placeKit('bulkhead', 0, 0, 0.60);
  } else {
    // Fallback if the kit failed to load: the old bare tubes, so the ship is
    // still sealed and walkable rather than open to space.
    add(new THREE.Mesh(shellGeo(cProfile, -3.4, 0.6), M.hullShell));
    add(new THREE.Mesh(shellGeo(profile, 0.6, 7.2), M.hullShell));
    const collarProfile = roundedProfile(CHW + 0.14, CH + 0.14, CR);
    for (const z of [-3.4, 0.6]) {
      add(new THREE.Mesh(ringGeo(profile, collarProfile, z), M.darkShell));
      add(new THREE.Mesh(shellGeo(collarProfile, z - 0.1, z + 0.1), M.accentShell));
      add(new THREE.Mesh(ringGeo(collarProfile, cProfile, z + (z < 0 ? 0.1 : -0.1)), M.darkShell));
    }
    for (const [z0, z1, hw] of [[-3.4, 0.6, CHW - 0.12], [0.6, 7.2, HW - 0.3]]) {
      add(box(hw * 2, 0.08, z1 - z0, M.floor, 0, 0.04, (z0 + z1) / 2));
    }
  }

  /* Aft end cap. The nose deliberately stays open: that aperture is the
     windscreen, and capping it walls the pilot in.

     This fan was deleted once, as the second half of a deck z-fight, on the
     reasoning that `hab_bay` already carries the end of the tube at z 7.2 and
     the fan was a second bulkhead in the same plane over 7.93 m² of it. Half
     of that is true and the other half opened the ship to space: the kit's end
     wall spans about ±1.75 m, the tube is ±2.05 plus its corner radius, and
     the difference is a 0.3 m slot on each side running floor to ceiling. From
     the habitat you could see stars through both of them.

     Cast a grid of rays aft and it draws itself — two vertical bands of escape
     at |x| 1.75 to 2.05, the interior sealed between them, nothing else in the
     cabin leaking anywhere. So the fan goes back, and the plane it was said to
     fight over is not there anyway: the aft-most surface any of those rays hit
     is at z 7.102, 98 mm forward of this one. The slot now shows a recessed
     end wall, which is what the back of a hull looks like. */
  add(new THREE.Mesh(capGeo(profile, 7.2, H * 0.5), M.hullShell));

  /* ------------------------------------------------- where the section *is*
     The cockpit tapers hard — half-width 2.05 down to 1.24 and roof 2.55 down
     to 1.62 over four metres — and everything that runs the length of it has
     to taper with it.

     Nothing did. Every service in here was laid out at the constant height and
     half-width of the *bulkhead* and then run 3.9 m forward into a section
     that is nothing like it. Measured against the loft: the two ceiling coves
     ended 0.90 m above the roof, the five conduit bundles 1.25 m above it and
     0.66 m outboard of the skin, and the deck plate 0.75 m outboard on each
     side. Forward of the roof line all of that is *glazing* — so from the seat
     at any upward pitch two glowing bars and five pipes hang in open space
     beyond the windscreen and stop in mid-air. That is precisely the "random
     bars sticking out" the owner has been complaining about, and it survived
     the canopy-frame rewrite because none of it is part of the canopy frame.

     These three read the same NOSE table the hull shells are lofted from, so
     a service placed through them cannot leave the ship. */
  const noseAt = (z) => {
    const zc = Math.min(Math.max(z, NOSE[NOSE.length - 1][0]), NOSE[0][0]);
    for (let i = 0; i < NOSE.length - 1; i++) {
      const a = NOSE[i], b = NOSE[i + 1];
      if (zc <= a[0] && zc >= b[0]) {
        const t = (zc - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
          a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t];
      }
    }
    return NOSE[NOSE.length - 1].slice(1);
  };
  /** Half-width of the skin at height y. The corner radius pulls the section
      in well before the nominal half-width near the deck and near the roof,
      which is exactly where the services and the deck edge run. */
  const hullX = (z, y) => {
    const [hw, h, r] = noseAt(z);
    if (y >= r && y <= h - r) return hw;
    const d = y < r ? r - y : y - (h - r);
    return hw - r + Math.sqrt(Math.max(r * r - d * d, 0));
  };
  /** Height of the skin at half-width x. */
  const roofY = (z, x) => {
    const [hw, h, r] = noseAt(z);
    const ax = Math.abs(x);
    if (ax <= hw - r) return h;
    const d = ax - (hw - r);
    return (h - r) + Math.sqrt(Math.max(r * r - d * d, 0));
  };
  // Aft edge of the glazing. Forward of this the roof is a windscreen and
  // there is no ceiling to hang anything from.
  const ROOF_Z = GLASS_Z0;

  /** A routed pipe: a smooth tube through a polyline, so a service can turn a
      corner and follow the taper instead of being one straight cylinder. */
  const pipe = (pts, rad, mat, seg = 26, rseg = 9) => {
    const curve = new THREE.CatmullRomCurve3(
      pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'catmullrom', 0.4);
    return add(new THREE.Mesh(new THREE.TubeGeometry(curve, seg, rad, rseg, false), mat));
  };

  /* --------------------------------------------------------------- floors */
  /* Only when there is no kit, and that is the whole change here.
     `cp_tub` has carried a floor pan for as long as it has existed — a closed
     swept section with the coving in it, at exactly this y — so this lofted
     sheet was a *second* deck coplanar with the first over the whole cockpit.
     Two surfaces in one plane is a z-fight, and worse than that: this one was
     surfaced with the deck tile, so what was drawn on the cockpit floor was
     painted plate joins, painted rivets and a painted anti-slip tread, while
     the kit bays either side of the bulkhead carried real relief. The floor
     visibly changed character at the threshold.

     tools/interior_bake/42_cockpit.py lays the pan's walking run 12 mm low and
     puts real plates on it — two courses each side of the centre strip, five
     bands on the frame pitch, a 26 mm groove between, a countersunk fastener
     at every corner, raised nosings at the frames — every one of them tapering
     with the section, which is what the loft here existed to do. */
  if (!haveKit) {
    const z0 = -7.58, z1 = -3.4, N = 12;
    const dhw = (z) => Math.min(HW - 0.3, hullX(z, DECK_TOP) - 0.026);
    const pos = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const z = z0 + (z1 - z0) * (i / N), w = dhw(z);
      pos.push(-w, DECK_TOP, z, w, DECK_TOP, z, -w, 0.0, z, w, 0.0, z);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 4, b = (i + 1) * 4;
      idx.push(a, b, a + 1, a + 1, b, b + 1);          // walking surface
      idx.push(a + 2, a, b + 2, a, b, b + 2);          // port edge
      idx.push(a + 1, a + 3, b + 1, a + 3, b + 3, b + 1); // starboard edge
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    dg.setIndex(idx);
    dg.computeVertexNormals();
    add(new THREE.Mesh(dg, M.floor));
    add(box(0.34, 0.03, z1 - z0 - 0.2, M.dark, 0, DECK_TOP + 0.005, (z0 + z1) / 2));
    for (let z = z0 + 0.5; z < z1; z += 0.62) {
      add(sbox(dhw(z) * 2 - 0.1, 0.016, 0.05, M.decal, 0, 0.082, z));
    }
  }

  /* ------------------------------------------------- ribs, rails, conduits */
  const ribAt = (z, hw, h, r) => {
    add(new THREE.Mesh(shellGeo(roundedProfile(hw - 0.07, h - 0.07, r), z - 0.05, z + 0.05), M.darkShell));
  };
  // Cockpit ribs stop short of the canopy: a rib at -6.15 or -5.1 arcs right
  // across the opening. The canopy carries its own frame. The corridor and
  // habitat ribs are part of the kit bays now.
  ribAt(-4.2, HW, H, R);
  if (!haveKit) {
    for (let z = 1.1; z < 7.2; z += 1.15) ribAt(z, HW, H, R);
    for (let z = -3.0; z < 0.5; z += 0.9) ribAt(z, CHW, CH, CR);
  }

  /* Conduit bundles in the upper corners. The kit runs these through the
     corridor and the habitat; what is left here is the cockpit, where the
     section tapers and the kit does not reach.
     Three pipes to port and two to starboard, at different heights and on a
     different clamp pitch — the same rule the kit bays follow.

     Routed, not extruded. These used to be five straight cylinders on the
     bulkhead's own corner line, which put them a metre above the roof and two
     thirds of a metre outboard by the nose — five pipes floating in the
     windscreen. A real service run does what this one does now: it comes
     forward in the roof corner until the roof becomes glass, turns down the
     frame at the boundary into a plenum, and carries on forward tucked under
     the canopy sill where there is still structure to clip it to. Which is
     also the more useful picture, because a bundle running the length of the
     sill is a hand-sized object at the bottom edge of the window and gives the
     canopy something to be measured against. */
  for (const sx of [-1, 1]) {
    const n = sx < 0 ? 3 : 2;
    const drop = sx < 0 ? 0.20 : 0.27;          // how far under the roof it hangs
    const inset = sx < 0 ? 0.16 : 0.21;         // and how far in from the skin
    // where the run passes at station z: aft of the glass in the roof corner,
    // forward of it under the sill, with the turn spread over 0.45 m
    const at = (z, i) => {
      const roofP = [sx * (hullX(z, H - drop) - inset - i * 0.050),
        Math.min(H - drop, roofY(z, HW - inset) - 0.055) - i * 0.045, z];
      const [, , , waist] = noseAt(z);
      const sillY = waist - 0.115 - i * 0.048;
      const sillP = [sx * (hullX(z, sillY) - 0.062 - i * 0.052), sillY, z];
      const t = Math.min(Math.max((ROOF_Z - 0.06 - z) / 0.45, 0), 1);
      const s = t * t * (3 - 2 * t);
      return [roofP[0] + (sillP[0] - roofP[0]) * s,
        roofP[1] + (sillP[1] - roofP[1]) * s, z];
    };
    for (let i = 0; i < n; i++) {
      const rad = 0.022 + i * 0.007;
      const pts = [];
      for (let k = 0; k <= 16; k++) pts.push(at(-3.36 - k * (4.10 / 16), i));
      pipe(pts, rad, i === 1 ? M.accent : M.dark, 30, 9);
    }
    /* The plenum the bundle turns down into, standing on the last frame
       before the glazing. A run that changes direction in mid-air is the same
       defect one axis over. */
    {
      const p = at(ROOF_Z - 0.10, 0);
      add(box(0.13, 0.20, 0.17, M.dark, p[0] + sx * 0.02, p[1] - 0.02, p[2], 0.018));
      add(box(0.09, 0.045, 0.11, M.accent, p[0] + sx * 0.02, p[1] + 0.085, p[2], 0.012));
    }
    // clamps, on a different pitch each side, riding the route
    for (let z = -7.28; z < -3.5; z += (sx < 0 ? 0.72 : 0.58)) {
      const a = at(z, 0), b = at(z, n - 1);
      const mx = (a[0] + b[0]) * 0.5, my = (a[1] + b[1]) * 0.5;
      const w = Math.abs(a[0] - b[0]) + 0.075, hgt = Math.abs(a[1] - b[1]) + 0.075;
      add(box(w, hgt, 0.030, M.dark, mx, my, z, 0.010));
      add(box(w * 0.42, hgt * 0.32, 0.038, M.rail, mx, my, z, 0.008));
    }
  }

  /* -------------------------------------------------------- light fixtures */
  /* A bare thin box is the worst possible case for antialiasing: five
     centimetres of geometry, twenty times brighter than anything around it,
     with a hard step at the silhouette. MSAA resolves geometric coverage, so
     it does clean the edge — but the edge it cleans is a two-value step from
     3.4 to 0.02, and one intermediate sample per pixel is not enough for that
     ratio. The strips crawled and the eye read them as jagged lines.

     A real fitting is not a bare filament either. It has a housing, a diffuser
     and a bright core, and nesting three emissive widths at falling intensity
     gives the luminance two intermediate steps to fall through on its way to
     the ceiling — which is what an antialiased edge is. It costs a dozen
     triangles inside a draw call that already exists. */
  const strip = (x, y, z, len, hex, inten, dir = -1, housing = true) => {
    // Backing plate: the fitting reads as mounted rather than floating, and it
    // stops the bloom from the core spilling straight through the hull. Where
    // the kit already models a trough the housing is switched off, or the two
    // would be two plates in the same plane.
    if (housing) add(sbox(0.215, 0.014, len + 0.04, M.dark, x, y - dir * 0.016, z));
    add(sbox(0.155, 0.026, len - 0.03, emissive(hex, inten * 0.09), x, y + dir * 0.000, z));
    add(sbox(0.098, 0.026, len - 0.015, emissive(hex, inten * 0.28), x, y + dir * 0.008, z));
    add(sbox(0.054, 0.026, len, emissive(hex, inten * 0.95), x, y + dir * 0.016, z));
  };
  // ceiling coves. The cockpit carries its own housing; the corridor and the
  // habitat drop their lamps into the trough the kit bays already model.
  /* The cockpit pair used to be 3.6 m long, centred at -5.5, at the bulkhead's
     roof height — so two thirds of each one was forward of the roof line and
     the last metre of it stood 0.9 m clear of the hull, glowing, in the middle
     of the windscreen. A ceiling fitting can only exist where there is a
     ceiling: they now stop at the glazing and die into a cast end shoe. */
  const COVE_Z0 = -3.48, COVE_Z1 = ROOF_Z + 0.06;
  for (const sx of [-1, 1]) {
    strip(sx * 1.28, H - 0.155, (COVE_Z0 + COVE_Z1) * 0.5, COVE_Z0 - COVE_Z1,
      0xffd7b0, 2.6);
    // the end shoe, and the flex conduit leaving it for the plenum
    add(box(0.235, 0.075, 0.085, M.dark, sx * 1.28, H - 0.176, COVE_Z1 - 0.030, 0.016));
    add(box(0.085, 0.048, 0.055, M.rail, sx * 1.28, H - 0.192, COVE_Z1 - 0.062, 0.010));
    /* Broken, not continuous — and this is the single biggest thing separating
       a lit tube from a lit room.

       These were one 3.4 m bar down the corridor and one 5.8 m bar down the
       habitat. A continuous line source at the ceiling/wall junction lights the
       whole wall evenly and *cannot do anything else*: that is what a line
       source is for. They were also the brightest objects in every corridor
       frame and they sat hard against both frame edges, which pulls the eye
       out of the shot on the way past.

       Three 0.9 m segments with 0.55 m of dark between them puts pools on the
       wall and gives the walk a rhythm, and the gaps are staggered port to
       starboard so the two sides are not the same picture. Levels come down
       with it (1.8 -> 1.2, 2.7 -> 1.9) but that is the smaller half: exposure
       normalises how much light is in a room within a second, so only ratio,
       direction and shape survive. */
    const runs = (x, y, z0, z1, hex, inten, phase) => {
      const SEG = 0.90, GAP = 0.55, P = SEG + GAP;
      for (let k = 0; k < 3; k++) {
        const c = z0 + phase + SEG * 0.5 + k * P;
        if (c + SEG * 0.5 > z1) break;
        strip(x, y, c, SEG, hex, inten, -1, !haveKit);
      }
    };
    runs(sx * (haveKit ? CHW * 0.62 : 0.78), CH - (haveKit ? 0.172 : 0.11),
      -3.10, 0.30, 0xdcecf8, 1.2, sx > 0 ? 0.10 : 0.62);
    runs(sx * 1.28, H - (haveKit ? 0.172 : 0.13), 1.00, 6.80,
      0xffd7b0, 1.9, sx > 0 ? 0.35 : 1.55);
  }
  /* What replaces them forward of the glazing: a sill wash, tucked under the
     canopy rail and pointing inboard across the tub. A real canopy has no
     ceiling to light from, and every aircraft that has this problem solves it
     the same way — the lamp goes in the coaming or in the sill. It is also the
     only light in the ship that rakes *along* the canopy members rather than
     across them, which is what makes a frame section read as a section. */
  for (const sx of [-1, 1]) {
    const K = 7;
    for (let k = 0; k < K; k++) {
      const z = ROOF_Z - 0.24 - k * 0.31;
      const [, , , waist] = noseAt(z);
      const x = sx * (hullX(z, waist - 0.085) - 0.052);
      add(sbox(0.030, 0.026, 0.255, M.dark, x + sx * 0.012, waist - 0.070, z));
      add(sbox(0.014, 0.020, 0.235, emissive(0xffdcb4, 0.30), x - sx * 0.004, waist - 0.078, z));
      add(sbox(0.010, 0.013, 0.225, emissive(0xffe8cc, 0.90), x - sx * 0.012, waist - 0.080, z));
    }
  }

  /* Deck lighting.
     The floor, the seat and both console banks were an unreadable near-black
     mass, because every fixture in the ship pointed at the ceiling and the only
     light reaching the deck was spill. Aircraft cabins and submarines light the
     walkway directly and from close range, and it doubles as the cleanest way
     to get a second colour temperature into a frame otherwise dominated by one:
     the deck line is tungsten-warm, the work lights above it stay cold, and the
     two meet at about waist height. */
  const deckLine = (z0, z1, hw, hex, inten, housed) => {
    const len = z1 - z0, zc = (z0 + z1) / 2;
    for (const sx of [-1, 1]) {
      // Where the kit models a skirting board the lamp is mounted proud of its
      // face; where there is no kit — the cockpit — the lip is built here.
      const x = sx * (hw - (housed ? 0.045 : 0.078));
      const y = housed ? 0.148 : 0.176;
      if (housed) {
        add(sbox(0.10, 0.075, len, M.dark, sx * (hw - 0.02), 0.255, zc));
        add(sbox(0.030, 0.115, len, M.dark, sx * (hw - 0.012), 0.170, zc));
      }
      // stepped inward the same way the ceiling coves step down
      add(sbox(0.020, 0.086, len - 0.03, emissive(hex, inten * 0.10), x + sx * 0.010, y, zc));
      add(sbox(0.020, 0.058, len - 0.015, emissive(hex, inten * 0.30), x, y, zc));
      add(sbox(0.020, 0.034, len, emissive(hex, inten * 0.95), x - sx * 0.010, y, zc));
    }
  };
  /* Kept dim on purpose. The first pass at these clipped to 255 along the whole
     run, and because the exposure is metered off the frame every extra stop in
     the brightest thing on screen comes straight back out of everything else —
     the deck lit up and the walls went darker than they had been before it was
     added. A practical only has to be the brightest thing in its own corner. */
  /* The cockpit run is cut into three, each at the half-width the skin
     actually has there: one length at the bulkhead's width would be 0.6 m
     outboard of the hull by the last section, which is the deck-plate bug one
     fitting over. */
  for (const [a, b] of [[-4.86, -3.45], [-6.22, -4.90], [-7.34, -6.26]]) {
    deckLine(a, b, Math.min(HW - 0.30, hullX((a + b) * 0.5, 0.20) - 0.032),
      0xffb478, 0.82, true);
  }
  deckLine(-3.38, 0.58, CHW, 0xffc79a, 0.50, !haveKit);
  deckLine(0.62, 7.05, HW, 0xffc79a, 0.56, !haveKit);

  /* Walkway markers. Aircraft floor-path lighting, and the reason is the same
     one it is there for in an aircraft: a line of discrete points reads as a
     route through a space in a way that an even wash never does. */
  const marker = (x, z, hex, inten) => {
    add(sbox(0.075, 0.010, 0.075, M.dark, x, 0.083, z));
    add(sbox(0.052, 0.012, 0.052, emissive(hex, inten), x, 0.087, z));
  };
  /* Staggered, not paired. Two markers exactly abreast read as a ladder and
     make the deck a mirror of itself down its own centreline; offset by half a
     pitch they read as a route, which is the whole reason aircraft floor-path
     lighting is a line of points rather than a strip. */
  for (const sx of [-1, 1]) {
    for (let z = -7.0 + (sx > 0 ? 0.39 : 0); z < 7.0; z += 0.78) {
      // In the cockpit the walkable deck narrows with the skin, so the markers
      // have to as well — at the bulkhead's half-width the forward pair sat
      // outside the ship.
      const hw = z < -3.4 ? Math.min(HW - 0.42, hullX(z, DECK_TOP) - 0.155)
        : (z < 0.6 ? CHW - 0.24 : HW - 0.42);
      marker(sx * hw, z, 0x9fe0ff, 1.45);
    }
  }
  // centreline guide down the corridor, aimed forward at the helm
  strip(0, 0.095, -1.4, 3.2, 0x7fd8ff, 1.6, 1);

  const pl = (x, y, z, hex, inten, dist) => {
    const l = new THREE.PointLight(new THREE.Color().setHex(hex, THREE.SRGBColorSpace), inten, dist, 2);
    l.position.set(x, y, z);
    l.layers.set(INTERIOR_LAYER);
    l.userData.dynamic = true;
    add(l);
    lights.push(l);
    return l;
  };

  /* Shadow casters. Contact shadows are what tell the eye that the console is
     resting on the deck rather than floating above a picture of one, so three
     of the overhead fixtures are real spot lights with depth maps. Spots rather
     than points: one shadow face each instead of six. */
  /* The maps were never the problem, and it is worth writing down what was.
     Six spots, all with real depth maps built at boot, 128 casters in the
     room — and turning `castShadow` off on all of them lifted the console by a
     flat 21/255 with no shape appearing or disappearing anywhere. Two things
     were doing that, and neither is a dead map.

     The first is here. `normalBias` was a hard-coded 22 mm on every light,
     and normalBias is not a scene-scale quantity — it is one shadow-map texel
     times the filter radius, which is what it exists to cancel. A 512 map on a
     0.72 rad cone at a 1 m throw has a 3.6 mm texel, so 22 mm is six times
     what that light needs: every occluder is pushed 22 mm along its own normal
     before the depth compare, which is more than the standoff of most of the
     things whose shadows were missing. A 20 mm fastener on the overhead panel,
     a 22 mm conduit over a strip light and a helmet resting on a locker all
     have contact geometry *smaller than the bias*, so they cannot cast at all
     — the shadow is not blurred away, it is biased away. Derived per light it
     ranges 11 to 36 mm across the six, and the two that were under-biased were
     the two that had acne.

     The second is `radius`: three texels of Vogel blur on a 108-degree cone is
     a 1-3 cm penumbra, which is most of the remaining small-object shadow. A
     star half a degree across through a cabin window does not make a 3 cm
     penumbra at 1 m; 1.6 is closer and still soft enough not to stair-step. */
  const spot = (x, y, z, tx, ty, tz, hex, inten, ang, mapSize) => {
    const l = new THREE.SpotLight(new THREE.Color().setHex(hex, THREE.SRGBColorSpace),
      inten, 14, ang, 0.55, 2);
    l.position.set(x, y, z);
    l.target.position.set(tx, ty, tz);
    l.castShadow = true;
    l.shadow.mapSize.set(mapSize, mapSize);
    l.shadow.camera.near = 0.25;
    /* `far` is overwritten by SpotLightShadow.updateMatrices from
       `light.distance` on every update, so setting it here was dead code and
       the maps have always run to 14 m. Set the distance instead. */
    l.shadow.camera.far = l.distance;
    l.shadow.bias = -0.0011;
    l.shadow.radius = 1.6;
    // one texel of the map, at the distance the light is actually throwing,
    // times the filter radius — which is the depth slope the filter spans
    const thr = Math.hypot(tx - x, ty - y, tz - z) || 1;
    l.shadow.normalBias = (2 * thr * Math.tan(ang) / mapSize) * l.shadow.radius;
    l.userData.dynamic = true;
    add(l); add(l.target);
    lights.push(l);
    return l;
  };
  // Candela at metre scale: irradiance is intensity / d^2, so a 2 m throw onto
  // a 0.10-albedo panel needs roughly 30-60 to sit at a comfortable exposure.
  // key lights (shadowed) + fill (cheap points)
  spot(0.0, H - 0.16, -5.6, 0.0, 0.55, -6.1, 0xffd9c0, 40, 0.95, 1024);
  // a cool wash raking across the instrument panel, so the console is lit as
  // deliberately as a real flight deck rather than by spill from the ceiling
  /* Off the axis, so it *rakes* the instrument panel instead of washing it
     head-on. Five shadow-casting spots stood inside a 1.6 m cube over this
     deck and four of them were on the centreline, which is the one place in a
     tube from which nothing can throw: the lamp, the occluder and the surface
     have to be roughly collinear, and the axis is 90 degrees off that for both
     sides at once. */
  spot(0.55, 1.62, -5.05, -0.10, 0.82, -6.35, 0xd4e4f2, 15, 0.72, 512);
  /* The corridor's shadow caster, moved out of the centreline and into the
     port cove. Aimed straight down the middle it lit the corridor evenly end
     to end and the conduit bundle 20 cm above it cast nothing at all -- the
     review's exact words. A wall washer *beside* the pipes is the only
     geometry that throws their shadow: for a bar to shade a wall the lamp, the
     bar and the wall have to be roughly collinear, and a lamp on the
     centreline is 80 degrees off that line. It is also where a cove light
     actually is. */
  spot(-0.92, CH - 0.09, -1.55, -1.12, 0.42, -1.82, 0xcfe2f0, 30, 1.05, 1024);
  spot(0.0, H - 0.16, 2.9, 0.0, 0.5, 3.1, 0xffcfa8, 88, 1.00, 1024);

  /* Overhead fill. Two of the seven that used to be here have moved to the
     deck: the ceiling was already the best-lit surface in the ship, and a
     forward renderer pays for every one of these on every fragment of the most
     expensive shader in the game, so they are worth spending where the frame
     is dark rather than where it is not. */
  /* These are also deliberately weaker than they were. Sitting 0.5 m above a
     standing eye, an inverse-square lamp at 18 cd puts the ceiling directly
     overhead at 200/255 — and since the exposure is metered off the frame, a
     ceiling nobody is looking at was setting the exposure for the whole room
     and everything else was being graded down to fit underneath it. Spread
     wider and driven softer, the same fixtures light more and clip nothing. */
  /* Warm and cold alternate down the ship rather than by compartment.
     The cockpit and habitat used to be lit entirely warm and the corridor
     entirely cold, which is a split you can only see by walking between them —
     inside any one frame there was still only one temperature. The coves and
     the deck stay tungsten; the overhead work lights are cold white-blue, the
     colour human-made light is everywhere else in this game. Every shot in the
     cabin now has both, and the seam between them lands about chest height. */
  /* Fewer, shorter, and off the centreline.
     The owner's reading was "everything looks uniformly lit and bright, hardly
     any shadows", and thirty sources filling a 15 m tube from every direction
     is the whole of it. Two rules apply here and they are what changed.

     The first is that a lamp *on the axis* of a tube cannot cast: for a prop to
     shade a wall the lamp, the prop and the wall have to be roughly collinear,
     and the centreline is 90 degrees off that for both walls at once. Thirteen
     of the twenty-one point lights stood at x = 0.

     The second is that `distance` is the hard cutoff, and at 7.5 m one ceiling
     lamp reaches half the ship. Nothing is ever out of range of anything, so
     there is no unlit volume anywhere for a lit one to read against. These are
     3 to 4.5 m now, which is about one compartment each, and the walk between
     them passes through real darkness. */
  pl(0.62, H - 0.34, -6.4, 0xc9dcef, 9, 4.2);
  // One corridor lamp, not two, and off the port wall rather than down the
  // middle: two fixtures 2.3 m apart in a 4 m corridor is a light box.
  pl(0.42, 1.50, -1.45, 0x9fcdf0, 6, 3.0);
  /* The aft habitat key. This was a point light on the centreline, which is
     the one place in a tube from which nothing in it can throw a shadow — for
     a prop to shade a wall the lamp, the prop and the wall have to be roughly
     collinear, and the axis is 90 degrees off that for both walls at once.
     Moved outboard and up, aimed across at the locker run, it is the same
     fixture and it is what finally puts a contact shadow under the helmet. */
  spot(0.92, H - 0.20, 4.30, -1.28, 1.02, 5.45, 0xc4d8ec, 40, 0.92, 1024);

  /* Bulkhead fill. The step from the wide sections into the corridor is a flat
     annulus facing straight down the ship, and every lamp in the cabin is
     either above it or behind it — the two rings came out as the largest
     unbroken black masses in the opening frame, right where the composition
     wants the eye to travel. One low lamp each, standing just clear of the
     collar, is all they need. */
  pl(0.62, 1.15, 1.30, 0xffc2a0, 3.0, 1.6);
  pl(-0.58, 1.15, -4.05, 0xffc2a0, 3.0, 1.6);

  /* Deck practicals, sitting in the coves above. Short throw and low power —
     they are there to put a readable value on the floor and on the underside
     of everything standing on it, not to light the room. Warm, against the
     cold overhead work lights, so the cabin has a temperature gradient from
     ankle to ceiling instead of one blue cast over everything. */
  pl(-0.48, 0.36, -6.15, 0xffbe92, 6.0, 2.1);
  // Lifted off the deck to two thirds of a metre, this one lamp does the job
  // of the deck light under the pilot seat and the practical that was picking
  // the chair out of the dark. They were 0.6 m apart and the same colour.
  // Off the centreline so the pilot's seat and the pedestal have a side to
  // throw from; on the axis they were lit flat from directly below.
  pl(-0.55, 0.72, -4.66, 0xd8ccc4, 4.6, 2.2);
  pl(0.85, 0.34, 1.90, 0xffa864, 6.0, 2.4);
  // The aft practical is gone: the sconce at 6.20 and the locker spot at 4.30
  // already cover that end, and a third source there was what removed the last
  // dark stretch of deck in the ship.

  /* Instrument spill. Every flight deck is lit from below by its own panels,
     and it is the one light in the room that is allowed to be a saturated
     colour — it comes from the screens, so it reads as information rather than
     as a lamp.
     Pushed forward against the fascia and pulled back in power. At (0, 1.02,
     -6.30) it was 0.59 m from the radar well and putting 12 units of cyan
     irradiance into it — the recess was the brightest thing in the lower half
     of the seated frame, which is the wrong way round for a projector dish.
     The screens now carry their own spill quads onto their bezels, which is
     what this lamp was really standing in for. */
  /* Deleted. The screens carry their own spill quads onto their bezels now —
     which is what this lamp was standing in for — so all it still did was add
     a fourteenth centreline source to the fragment loop and wash the one part
     of the seated frame that should be lit by its own instruments. */

  /* Wall sconces.
     Between the deck coves at ankle height and the work lights in the ceiling
     there was a two-metre band of wall lit by nothing but the hologram table,
     which is a saturated cyan — so the whole middle of the frame, the part the
     eye actually rests on, took its colour from one instrument. These are what
     the cabin is lit by at eye level, and they are tungsten. Deliberately not
     paired left and right: a room lit symmetrically has no direction to it. */
  const sconce = (sx, y, z) => {
    const x = sx * (HW - 0.10);
    add(box(0.09, 0.34, 0.20, M.dark, x, y, z, 0.02));
    add(box(0.05, 0.24, 0.13, M.accent, sx * (HW - 0.17), y, z, 0.012));
    add(sbox(0.020, 0.175, 0.075, emissive(0xffcf9e, 0.55), sx * (HW - 0.205), y, z));
    add(sbox(0.020, 0.135, 0.048, emissive(0xffd7ad, 1.9), sx * (HW - 0.215), y, z));
    pl(sx * (HW - 0.34), y, z, 0xffb681, 5.0, 2.1);
  };
  /* The starboard one used to stand at z 1.45, which is where the loose-stowage
     shelf now is — a sconce through the middle of a bookshelf. Moved aft to
     6.20 it does two jobs instead of one: it clears the shelf, and it is the
     only motivated source in the last metre and a half of the ship. The review
     measured the habitat at 14.1% pure black with p1 = 1 and said to check that
     the aft end has sources; from the resonance wall forward there was nothing
     but the ceiling trough four metres away. It now stands directly over the
     netted freight in the aft starboard corner, which is what gives that corner
     a lit object to read against instead of a silhouette. */
  sconce(1, 1.62, 6.20);
  sconce(-1, 1.62, 3.15);
  /* And a second, dimmer one low on the port side aft, aimed across the deck
     rather than along the wall. Bounce off a lit floor is what stops the aft
     bulkhead reading as the end of the level. */
  sconce(-1, 0.92, 5.72);

  /* Bounce. Without this every shadow in the cabin falls to pure black, which
     is what made the interior read as dim no matter how hard the keys were
     driven — there was no floor to the lighting, only spill.

     Warm below, cool above: the deck coves and the painted floor throw warm
     light up into everything at knee height, the ceiling coves and the pale
     overhead throw cool light down. That is the right way round for this room
     and it is also the way round that keeps the two temperatures from
     cancelling into the single blue cast the cabin used to have. The sky
     colour stays close to neutral — a saturated blue bounce on cool-grey
     panels, under a grade that already pushes shadows toward teal, compounds
     into a cabin moulded out of one piece of plastic. */
  const bounce = new THREE.HemisphereLight(0xaab2b6, 0x8a6a4c, 0.70);
  bounce.layers.set(INTERIOR_LAYER);
  add(bounce);

  /* And a true floor under the whole thing.
     A hemisphere light still leaves a surface whose normal lies on its equator
     — which in a tube is most of the wall — with half of nothing, and the wall
     of a panel groove, which points sideways and slightly down, with less than
     that. A fifth of the opening frame sat under 8/255 and almost all of it was
     panel seams, deck grooves and the undersides of the conduit runs: places no
     lamp in the room can reach by construction. Only a directionless term
     reaches into those, which is what a real cabin has — light that has
     bounced four times off pale paint and forgotten where it came from.
     Slightly warm, so it counts against the cold instrument spill rather than
     with it.

     The level is the whole argument. Too little and the seams, the deck
     grooves and the undersides of the conduit runs stay under 8/255, which was
     a fifth of the opening frame. Too much and it becomes the dominant source:
     at 1.15 the median pixel went from 37 to 78 and the cabin lost the
     staging the arch and the strip lights had built for it. It wants to sit
     just under the dimmest practical in the room. */
  /* 0.14, not 0.40. A hemisphere at least has an orientation; a constant
     cannot describe a shadow at all, so what it buys is exactly the flat read.
     Level is nearly free either way — zeroing both moved the corridor's median
     four levels out of 255, because auto-exposure normalises the room inside a
     second — so this is a ratio change, not a dimming. */
  const amb = new THREE.AmbientLight(0xbdb2a2, 0.14);
  amb.layers.set(INTERIOR_LAYER);
  add(amb);

  /* =========================================================== COCKPIT ====

     Rebuilt as a Blender kit: tub, coaming, instrument stack, centre pedestal,
     seat, flight controls, overhead panel, canopy framing and stowage. Every
     one of those was a stack of primitives before, and the seated view — which
     is the single most-looked-at frame in the game — was three flat panels
     floating on a smooth slab with nothing else in it at all.

     What stays here is what the kit cannot carry: the emissive practicals, the
     live screen definitions, and the station datum. */

  const EYE_Y = 1.34, EYE_Z = -5.26;

  if (haveKit) {
    placeKit('cp_tub', 0, 0, 0);
    placeKit('cp_coaming', 0, 0, 0);
    placeKit('cp_pedestal', 0, 0, 0);
    placeKit('cp_seat', 0, 0, 0);
    placeKit('cp_controls', 0, 0, 0);
    placeKit('cp_overhead', 0, 0, 0);
    placeKit('cp_canopy', 0, 0, 0);
    placeKit('cp_stow', 0, 0, 0);
    // nose bulkhead, closing the forward end of the tub
    add(box(2.42, 0.92, 0.09, M.panel, 0, 0.50, -7.58));
  } else {
    add(box(2.1, 0.5, 0.1, M.panel, 0, 0.3, -7.55));
    add(box(2.5, 0.34, 0.62, M.dark, 0, 0.80, -6.30));
    add(box(0.62, 0.36, 0.56, M.dark, 0, 0.57, -6.10));
    /* A bucket, not a cuboid. This branch only runs if the kit failed to
       load, but a single box is not an acceptable pilot's seat under any
       circumstances — shell, pan, back, headrest, bolsters and armrests is
       the minimum that reads as somewhere a person sits. */
    add(box(0.80, 0.10, 0.68, M.shell, 0, 0.545, -5.02, 0.03));
    const fbBack = box(0.76, 1.06, 0.09, M.shell, 0, 1.09, -4.66, 0.03);
    fbBack.rotation.x = -0.17;
    add(fbBack);
    for (let i = 0; i < 3; i++) {
      add(box(0.60, 0.085, 0.20, M.seat, 0, 0.605, -5.22 + i * 0.20, 0.03));
      add(box(0.56 - i * 0.03, 0.22, 0.11, M.seat, 0, 0.74 + i * 0.245,
        -4.79 - i * 0.042, 0.035));
    }
    add(box(0.34, 0.19, 0.13, M.seat, 0, 1.60, -4.70, 0.045));
    for (const sx of [-1, 1]) {
      add(box(0.10, 0.74, 0.17, M.seat, sx * 0.30, 1.02, -4.83, 0.04));
      add(box(0.09, 0.09, 0.50, M.seat, sx * 0.28, 0.60, -5.06, 0.035));
      add(box(0.09, 0.045, 0.80, M.shell, sx * 0.38, 0.80, -5.24, 0.02));
      add(box(0.05, 0.20, 0.05, M.shell, sx * 0.38, 0.68, -4.90, 0.02));
      add(box(0.055, 0.86, 0.018, M.rubber, sx * 0.15, 1.06, -4.82));
    }
    add(cyl(0.09, 0.14, 0.42, 22, M.shell, 0, 0.30, -5.02));
    add(box(0.46, 0.05, 0.46, M.shell, 0, 0.06, -5.02, 0.02));
  }

  /* ---- the coaming light.
     A glare shield with a strip under its lip is the single most recognisable
     thing about a lit flight deck: the light comes from above and in front of
     the instruments, wipes down the panel face, and never shines back into the
     canopy. The curve below is the same one the coaming is lofted on, so the
     lamp follows the shield rather than cutting a chord across it. */
  /* These four lines are tools/interior_bake/42_cockpit.py's `coam_crown`,
     `coam_scale` and `coam_lamp`, transcribed. The shield's underside now
     carries a real channel milled into the casting and the strip sits *in* it,
     so the two have to agree: a few centimetres out either way and the lamp is
     buried in the moulding or hanging below it in mid-air. The outboard plunge
     is in here too — the shield dives onto the tub waist past the outer
     displays, and a lamp on the old level line would leave the shield entirely
     at |x| > 1.0. */
  const cCrown = (x) => {
    const t = Math.min(Math.abs(x) / 1.34, 1);
    const p = Math.max(0, (Math.abs(x) - 0.98) / 0.36);
    return [1.096 - 0.052 * t * t - 0.300 * p * p,
      -6.530 + 0.300 * t * t + 0.150 * p * p];
  };
  const cLamp = (x) => {
    const t = Math.min(Math.abs(x) / 1.34, 1);
    const [cy, cz] = cCrown(x);
    return [cy - 0.1265 * (1 - 0.30 * t * t), cz - 0.048 * (1 - 0.14 * t * t)];
  };
  if (haveKit) {
    /* Tucked up inside the channel and pointed down the panel, so what the
       pilot sees is the *wash*, not the lamp. The first pass at this hung
       three nested bars 4 cm below the lip at 2.3 units and they read as a row
       of light boxes stuck to the shield — a practical only has to be the
       brightest thing in its own corner. */
    for (let i = 0; i < 12; i++) {
      const x = -1.21 + i * 0.22;
      const [y, z] = cLamp(x);
      add(sbox(0.205, 0.014, 0.020, emissive(0xffe6c8, 0.12), x, y + 0.010, z));
      add(sbox(0.195, 0.012, 0.013, emissive(0xffe0bc, 0.34), x, y + 0.004, z));
      add(sbox(0.195, 0.008, 0.009, emissive(0xfff0da, 0.86), x, y, z - 0.003));
    }
  }

  /* ---- lighting the flight deck.
     The forward seated frame measured p50 = 1/255 with 68% of it pure black:
     the cockpit was contributing essentially no light to its own picture, and
     the panel, coaming, side walls and pedestal all sat at one value. Four
     sources at four colour temperatures, with visible falloff between them. */
  if (haveKit) {
    /* A forward renderer charges for every one of these on every fragment of
       the most expensive shader in the game, and the first pass at lighting
       this deck ran seventeen of them and took the seated frame from 120 fps
       to 53. What is here is the smallest set that still gives four colour
       temperatures with visible falloff between them. */
    // 1. coaming wash, aimed steeply down the panel face
    spot(0.0, 1.04, -6.62, 0.0, 0.48, -6.14, 0xffe2c4, 24, 0.95, 512);
    /* 2. the overhead console's own downwash, cool against the coaming's warm.
       Demoted from a shadowed spot to a point: it sat on the centreline 0.24 m
       from the coaming wash and 0.43 m from the key, so it was paying for a
       depth map to cast nothing that the other two were not already casting.
       As a point it still does the job it is actually here for, which is
       putting a cool value on the overhead panel's underside. */
    pl(0.0, 2.03, -6.26, 0xcfe0f2, 4.5, 1.5);
    /* 2b. and a *grazing* one along the console's own face, from the lit lip
       aft. Every source over the flight deck pointed down and away from the
       overhead panel, so the best-modelled surface in the ship — raised
       panels, machined fittings, individual fasteners — was lit only by
       ambient and every one of those fittings floated. A lamp in the plane of
       a panel is what makes its relief cast; this one throws each switch guard
       and knob a shadow the length of its own bay. */
    spot(0.62, 2.005, -6.30, 0.10, 2.30, -4.92, 0xd8e6f6, 13, 0.80, 1024);
    // 3. amber footwell flood
    pl(-0.52, 0.40, -6.00, 0xffa365, 5.4, 2.8);
    // 4. the side consoles, one warm and one cool at different heights, so
    //    the two halves of the deck are not the same picture
    pl(1.46, 1.06, -5.78, 0xc8dcf0, 3.4, 2.8);
    pl(-1.48, 0.86, -6.12, 0xffc79c, 3.0, 2.6);
    /* the overhead console's lit forward lip. `at(1.0)` in 42_cockpit.py:
       the console face is the roof line less 92 mm, and the rolled lip hangs
       36 mm under it. */
    for (let i = 0; i < 9; i++) {
      const x = -0.62 + i * 0.155;
      add(sbox(0.140, 0.018, 0.026, emissive(0xd6e4f4, 0.24), x, 2.050, -6.222));
      add(sbox(0.132, 0.013, 0.017, emissive(0xe4eefa, 0.74), x, 2.044, -6.226));
      add(sbox(0.132, 0.009, 0.011, emissive(0xf2f8ff, 1.85), x, 2.038, -6.230));
    }
  }

  /* Instrument backlighting. Every flight deck is lit from below by its own
     panels, and it is the one light in the room allowed to be a saturated
     colour — it comes from the screens, so it reads as information. */
  /* Panel-frame helper: the console is raked -0.60 rad about X, so anything
     mounted on it has to be placed in its own frame or it floats.
     *
     * The sign on the v term was wrong, in both this and `wing` below, and it
     * is worth saying exactly how it read. A rotation of -0.60 about X sends
     * (u,v,n) to z = -sin(rx)*... — the same matrix three builds for the
     * screen meshes and the same one tools/interior_bake/42_cockpit.py builds
     * the recesses with. With v's sign flipped, a widget authored 0.26 above
     * the panel centre came out 0.29 m *aft* of where it belongs, which for
     * the annunciator row meant six lamps hanging in mid-air between the
     * coaming and the glass — and because they hung directly in the sight line
     * to the top of the main display, they looked from the seat like part of
     * it. Everything mounted through this helper is on the fascia now. */
  const RC = Math.cos(-0.60), RS = Math.sin(-0.60);
  const onPanel = (u, v, n) => [u, 0.805 + v * RC + n * -RS, -6.30 + v * RS + n * RC];
  // annunciator row along the top of the centre fascia
  for (let k = 0; k < 6; k++) {
    const p = onPanel(-0.26 + k * 0.104, 0.252, 0.032);
    add(sbox(0.062, 0.016, 0.005,
      emissive(k === 2 ? 0xffb060 : 0x5fc0ff, 2.4), p[0], p[1], p[2]));
  }
  /* Column of status lamps up each divider post. Placed in world coordinates
     against the post the kit actually builds — z -6.400..-6.318 — and on its
     *aft* face, which is the only one the pilot can see. Deliberately not the
     same count or colour order to port and starboard. */
  for (const sx of [-1, 1]) {
    const n = sx > 0 ? 5 : 4;
    for (let k = 0; k < n; k++) {
      const y = 0.642 + k * 0.078 + (sx > 0 ? 0 : 0.026);
      const hue = [0xff7a4a, 0x7fd8ff, 0x7fd8ff, 0x62ff8a, 0xffc040][(k + (sx > 0 ? 2 : 0)) % 5];
      add(sbox(0.026, 0.018, 0.006, emissive(hue, 3.0), sx * 0.513, y, -6.311));
    }
  }
  /* Status LEDs on the outboard switch banks. Deliberately oversized — a
     2 mm indicator is a sub-pixel emissive, which is not dim, it is absent. */
  for (const [sx, ry] of [[-1, 0.42], [1, -0.42]]) {
    const c = Math.cos(-0.60), sn = Math.sin(-0.60);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const wing = (u, v, n) => [
      sx * 0.735 + cy * u + sy * n,
      0.775 + (sn * sy) * u + c * v + (-sn * cy) * n,
      -6.24 + (-c * sy) * u + sn * v + (c * cy) * n,
    ];
    for (let k = 0; k < 8; k++) {
      const u = -0.147 + (k % 4) * 0.048;
      const v = -0.296 + Math.floor(k / 4) * 0.048;
      const p = wing(u, v, 0.052);
      const hue = [0xff5a3a, 0x62ff8a, 0x62ff8a, 0xffc040][(k + (sx > 0 ? 1 : 0)) % 4];
      add(sbox(0.020, 0.020, 0.005, emissive(hue, 3.2), p[0], p[1], p[2]));
    }
  }
  /* The lower console between the knees: the closest lit surface in the seated
     down-view, and the one place in the cockpit where a backlight is seen from
     30 cm rather than a metre. Same frame as 42_cockpit.py's keypad. */
  const LC = Math.cos(-0.534), LS = Math.sin(-0.534);
  const onLower = (u, v, n) => [u, 0.858 + v * LC + n * -LS, -5.4625 + v * LS + n * LC];
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < 5; k++) {
      const p = onLower(-0.268 + k * 0.0372, -0.0627 + r * 0.0366, 0.0135);
      const hot = r * 5 + k === 6;
      add(sbox(0.018, 0.016, 0.003,
        emissive(hot ? 0xffa860 : 0x7fd8ff, hot ? 2.4 : 1.7), p[0], p[1], p[2]));
    }
  }
  for (let k = 0; k < 3; k++) {
    const p = onLower(0.106 + k * 0.068, -0.0523, 0.0275);
    add(sbox(0.007, 0.007, 0.003, emissive(0xffd0a0, 2.6), p[0], p[1], p[2]));
  }
  // and the master guard's lamp, under its raised cover
  {
    const q = onLower(-0.065, -0.0487, 0.0295);
    add(sbox(0.012, 0.012, 0.003, emissive(0xff7a4a, 2.6), q[0], q[1], q[2]));
  }
  /* One short-range lamp per display, coloured to its content. The screens
     were the brightest thing in the cockpit and no light left them: a lit
     panel that does not touch the surface it is set into reads as a decal. */
  if (haveKit) pl(0.0, 0.90, -6.12, 0x8fd0ff, 4.2, 1.35);

  /* Radar well rim, hung just inside the machined chamfer and *below* the
     plate, so it lights the inside of the dish rather than sitting on top of
     the pedestal like a hoop. The well wall is at r 0.156. */
  {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.146, 0.0050, 8, 48),
      emissive(0x7fd8ff, 1.1));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 0.764, -5.80);
    add(rim);
  }
  // the overhead panel's night lighting
  add(sbox(1.52, 0.010, 0.020, emissive(0x9fd8ff, 1.8), 0, 2.332, -4.66));
  /* Throttle gate, edge-lit between the detent ribs on the port armrest head,
     and the sidestick's trigger lamp to starboard. These two are the only
     emissives within half a metre of the eye, so they are deliberately dim:
     the exposure is metered off the frame and a bright lamp at 0.4 m sets it
     for the whole cabin. */
  /* Slot lighting, not a light box: the first pass ran one 150 mm cyan strip
     the length of the detent plate and from the seat it read as a glowing slab
     cutting through the throttle. The quadrant now has a real gate — a 44 mm
     slot cut through the detent plate with a floor 36 mm down — so these sit
     *on that floor*, one per gap between the detent teeth, and what the eye
     sees is a lit slot with two levers standing in it. Coordinates are
     tools/interior_bake/42_cockpit.py's: slot x -0.380..-0.324, teeth from
     z -5.854 on a 21 mm pitch, floor at y 0.884. */
  for (let k = 0; k < 6; k++) {
    add(sbox(0.036, 0.004, 0.010, emissive(0x7fd8ff, 1.0),
      -0.352, 0.8865, -5.8385 + k * 0.021));
  }
  // the sidestick's trigger lamp, on the forward face of the guard, and the
  // master-arm lamp on the crown beside the hat switch
  add(sbox(0.014, 0.006, 0.004, emissive(0xff7a4a, 2.0), 0.362, 1.005, -5.7895));
  add(sbox(0.010, 0.003, 0.010, emissive(0x62ff8a, 1.6), 0.348, 1.0595, -5.722));
  // and the quadrant's aft button pair, which is the one lit thing on the port
  // armrest visible from a standing walk-past as well as from the seat
  add(sbox(0.014, 0.008, 0.003, emissive(0xffc040, 2.0), -0.323, 0.940, -5.7025));

  /* The stick, the pedals and the throttle levers are kept in the animated
     list so anything that wants to drive them still has a handle. They are
     kit geometry now, so the handle is a group placed over the piece rather
     than the piece itself. Since the controls split into a starboard stick
     and a port throttle, `side` says which is which rather than pairing. */
  {
    const g = new THREE.Group();
    g.position.set(0.352, 0.930, -5.735);
    add(g);
    animated.push({ kind: 'stick', obj: g, side: 1 });
    const t = new THREE.Group();
    t.position.set(-0.352, 0.906, -5.790);
    add(t);
    animated.push({ kind: 'throttle', obj: t, side: -1 });
    for (const sx of [-1, 1]) {
      const p = new THREE.Group();
      p.position.set(sx * 0.20, 0.25, -5.75);
      add(p);
      animated.push({ kind: 'pedal', obj: p, side: sx });
    }
  }

  /* ---- cockpit panels, raked to face the eye at (0, EYE_Y, EYE_Z)

     These are sized against the canopy, not against how much they can hold: at
     ~1.6 m the main panel subtends about 28 degrees, so the three of them
     together sit inside the lower third of a 68-degree view instead of
     spanning wider than it. Resolution is set from the on-screen pixel
     footprint rather than the metre size, so text stays crisp as they shrink.

     The numbers are load-bearing twice over now: the kit's display bays are
     modelled at exactly these transforms, so a change here has to be made in
     tools/interior_bake/42_cockpit.py as well or the canvas leaves its recess. */
  const scr = (name, w, h, x, y, z, rx, ry, rz, opts) => {
    screens.push({ name, w, h, pos: [x, y, z], rot: [rx, ry, rz], ...opts });
  };
  /* `spillZ` is the standoff from the canvas to the front of the bezel, which
     is `face + lip` in screen_bay() — 0.037 on the three console bays and
     0.024 on the shallower radar label. A spill quad behind the bezel it is
     meant to be washing is just a quad the bezel occludes. */
  scr('main', 0.86, 0.42, 0, 0.805, -6.30, -0.60, 0, 0, { res: 620, ss: 3, spillZ: 0.041 });
  scr('left', 0.44, 0.28, -0.735, 0.775, -6.24, -0.60, 0.42, 0, { res: 430, ss: 3, spillZ: 0.041 });
  scr('right', 0.44, 0.28, 0.735, 0.775, -6.24, -0.60, -0.42, 0, { res: 430, ss: 3, spillZ: 0.041 });
  scr('radarLabel', 0.30, 0.088, 0, 0.762, -5.62, -1.30, 0, 0,
    { res: 300, ss: 3, spill: 0.026, spillZ: 0.028, spillGain: 0.9 });
  /* The lower console's strip. It is the nearest display to the eye by half a
     metre, so it gets the two numbers you glance at rather than read — and it
     is what fills the band of blank plate the console's upper half used to be.
     The transform is the console keypad's own frame, 18 mm behind the plate;
     tools/interior_bake/42_cockpit.py cuts the recess at the same numbers. */
  scr('lower', 0.28, 0.044, 0.125, 0.87212, -5.48991, -0.534, 0, 0,
    { res: 480, ss: 3, spill: 0.020, spillZ: 0.028, spillGain: 0.85 });


  stations.push({
    id: 'seat', label: 'TAKE THE HELM', hint: 'Fly the ship',
    // Beside the seat, not behind it: standing on the backrest side meant the
    // sit transition had to pass straight through the shell.
    pos: new THREE.Vector3(0.62, 1.0, -4.72), radius: 1.25,
    look: new THREE.Vector3(0, 0.8, -6.2),
    // Stated explicitly rather than left to the controller's default: this is
    // the datum the whole console is laid out against.
    seatEye: new THREE.Vector3(0, EYE_Y, EYE_Z),
  });

  /* =========================================================== HABITAT ==== */

  // ---- navigation table
  const nav = new THREE.Group();
  nav.position.set(0, 0, 2.6);
  add(nav);
  nav.add(cyl(0.26, 0.40, 0.62, 28, M.dark, 0, 0.31, 0));
  /* The top is an *annulus*, not a disc. It was a capped cylinder, so the
     projector well, its optics and its graticule were all built underneath a
     solid 1.6 m lid — which is precisely why the review saw a matte void: the
     table had no opening in it at all. */
  {
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.80, 0.74, 0.10, 44, 1, true), M.panel);
    skirt.position.y = 0.67;
    nav.add(skirt);
    const top = new THREE.Mesh(new THREE.RingGeometry(0.700, 0.800, 44), M.panel);
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.720;
    nav.add(top);
  }
  const navRim = new THREE.Mesh(new THREE.TorusGeometry(0.80, 0.018, 8, 64), emissive(0x8fe4ff, 0.7));
  navRim.rotation.x = Math.PI / 2;
  navRim.position.y = 0.72;
  nav.add(navRim);
  /* The projector well, and the plate over it.

     This was one flat emissive disc at 0.55, which in a room the exposure has
     opened up for is black: a 1.6 m matte void in the middle of the best
     compartment in the ship, and the review named it. The fix is not to make
     it brighter — the table is the emitter's *housing* and the hologram above
     it is what should read as light. It is that there was nothing in it.

     So: a well sunk into the table top, a ring of projector optics round the
     rim aimed inward, a machined boss in the centre, a standby graticule at a
     level that reads as powered-down rather than off, and glass over the lot.
     Unpowered glass over a dark well is not a void, it is a *reflection*. */
  {
    /* The wall of the well, wound inward. A CylinderGeometry faces outward and
       the inside of it is exactly what has to be seen, so it is mirrored in X:
       a negative determinant makes three flip the front face for the whole
       object, which is the cheapest way to turn a tube inside out. */
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(0.705, 0.685, 0.062, 48, 1, true), M.dark);
    wall.position.set(0, 0.689, 0);
    wall.scale.x = -1;
    nav.add(wall);
    nav.add(cyl(0.70, 0.70, 0.012, 48, M.rubber, 0, 0.652, 0));  // well floor
    nav.add(cyl(0.10, 0.15, 0.052, 24, M.dark, 0, 0.684, 0));    // centre boss
    nav.add(cyl(0.105, 0.105, 0.008, 24, M.rail, 0, 0.712, 0));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.13;
      const lx = Math.cos(a) * 0.575, lz = Math.sin(a) * 0.575;
      const lens = cyl(0.028, 0.034, 0.038, 14, M.dark, lx, 0.678, lz);
      lens.rotation.z = -Math.cos(a) * 0.50;
      lens.rotation.x = Math.sin(a) * 0.50;
      nav.add(lens);
      // the emitter itself, sized to hold a few pixels — physical size loses
      nav.add(cyl(0.020, 0.020, 0.005, 12, emissive(0x2e6c86, 1.1), lx, 0.694, lz));
    }
    // standby graticule on the well floor: two rings and a bearing scale, only
    // just alight — an idle instrument is powered down, not switched off
    for (const [r, w, g] of [[0.26, 0.0035, 0.42], [0.47, 0.0030, 0.30]]) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(r, w, 6, 72),
        emissive(0x2b6478, g));
      t.rotation.x = Math.PI / 2; t.position.y = 0.660;
      nav.add(t);
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const long = i % 6 === 0;
      nav.add(sbox(long ? 0.048 : 0.024, 0.0028, 0.005,
        emissive(0x2b6478, long ? 0.46 : 0.26),
        Math.cos(a) * 0.545, 0.660, Math.sin(a) * 0.545));
    }
    const plate = new THREE.Mesh(new THREE.CircleGeometry(0.700, 56), M.navPlate);
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.7215;
    plate.renderOrder = 14;
    bindGlass(plate, M.navPlate);
    nav.add(plate);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    nav.add(box(0.10, 0.02, 0.16, M.accent, Math.cos(a) * 0.62, 0.735, Math.sin(a) * 0.62));
  }
  /* Hologram spill, pulled in close.
     At a 3.4 m throw this one cyan light was reaching both side walls and the
     whole aft half of the habitat, and it was the brightest thing on them —
     which is how a room with warm coves, cold work lights and amber deck
     lighting still came out as a single blue cast. Instrument colour has to
     stay on the instrument. */
  pl(0.58, 1.34, 2.6, 0x8fd8f0, 2.6, 2.2);
  /* The table is a Group, and mergeStatic only welds the root's own children —
     so every lens, tick and emitter added here would have been its own draw
     call. Fifty-three of them, on a frame that runs at 362. Welded inside the
     group instead, the whole table is six. */
  mergeStatic(nav);
  stations.push({
    id: 'nav', label: 'STELLAR CARTOGRAPHY', hint: 'Plot a fold',
    pos: new THREE.Vector3(0, 1.0, 1.55), radius: 1.15,
    look: new THREE.Vector3(0, 1.1, 2.6),
    holo: nav,
  });

  /* ---- archive terminal, port wall.
     A kit piece now. What was here was twenty-five meshes: `box(1.15, 0.85,
     0.12)` for a fascia, `box(0.86, 0.30, 0.34)` for a shelf, one accent
     strip, and twenty-two copies of `box(0.055, 0.012, 0.055)` laid out on an
     8-column grid to stand in for a keyboard — the whole assembly floating
     24 cm clear of the wall with nothing under it. It is one of the two
     fittings the player walks up to and stops in front of.

     tools/interior_bake's `archive_terminal` builds it as a floor-standing
     console: plinth with a toe recess and levelling feet, a cabinet with two
     doors on real hinges, a louvred vent, a lock and a data plate, a work deck
     with a rolled nosing, a keyboard whose caps are drafted, dished, legended
     and standing in their own wells, the display in a machined bay, a riser
     plated with real seams and fasteners, a media rack, breakers, a card
     reader, cooling louvres and trunking into the deck.

     What stays here is what the kit cannot carry: the live canvas, and
     everything that lights up. */
  const archX = -HW + 0.30;
  if (haveKit) {
    placeKit('archive', archX, 0, 0.95, Math.PI / 2);
  } else {
    const arch = new THREE.Group();
    arch.position.set(archX, 0, 0.95);
    arch.rotation.y = Math.PI / 2;
    add(arch);
    arch.add(box(1.15, 0.85, 0.12, M.panel, 0, 1.35, 0));
    arch.add(box(1.02, 0.06, 0.16, M.accent, 0, 0.90, 0.02));
    arch.add(box(0.86, 0.30, 0.34, M.dark, 0, 0.86, 0.16));
  }
  /* `spillZ` is the standoff from the canvas to the front of the bezel, which
     is `face + lip` in screen_bay() — 0.037 on the archive's bay. It was 0.006,
     which put the spill quad inside the bezel that is meant to be washed. */
  scr('archive', 0.98, 0.62, archX + 0.06, 1.36, 0.95, 0, Math.PI / 2, 0,
    { res: 768, spill: 0.055, spillZ: haveKit ? 0.038 : 0.006, spillGain: 1.0 });
  pl(-HW + 0.62, 1.52, 0.95, 0x9fd8ff, 3.4, 1.9);
  if (haveKit) {
    /* The lit hardware. Sized to hold pixels rather than to be right: the
       throat of a card reader is 3 mm tall and at 0.6 m that is under a pixel,
       so it is authored at 8 and the reader's mouth in the kit is cut to
       match. Each of these sits *in* something the kit machined. */
    /* Local to world: the piece is placed with ry = +90 degrees, so its own
       +X (across the console) becomes world -Z and its +Z (out of the wall)
       becomes world +X. `sbox` takes world extents, so anything that runs
       across the console is long in *z* here. Getting this backwards puts a
       160 mm strip through the wall instead of along the fascia. */
    const A = (lx, ly, lz) => [archX + lz, ly, 0.95 - lx];
    // card reader throat, in the mouth the kit cuts at (0.408, 1.610)
    add(sbox(0.004, 0.014, 0.130, emissive(0x8fd8ff, 1.4), ...A(0.408, 1.610, 0.008)));
    // the slate dock's shelf light, and the two slates left charging in it
    add(sbox(0.003, 0.008, 0.220, emissive(0x2e6c86, 0.9), ...A(0.409, 1.203, 0.079)));
    for (let k = 0; k < 2; k++) {
      add(sbox(0.002, 0.108, 0.088, emissive(k ? 0xffb060 : 0x7fd8ff, k ? 0.9 : 1.3),
        ...A(0.351 + k * 0.116, 1.258, 0.0765 - k * 0.004)));
    }
    // breaker bank tell-tales
    for (let k = 0; k < 4; k++) {
      add(sbox(0.003, 0.006, 0.016, emissive(k === 2 ? 0xff7a4a : 0x62ff8a, 1.8),
        ...A(-0.470 + k * 0.058, 1.592, -0.050)));
    }
    // the spool rack's index lamps — the one lit thing above the eye line
    for (let i = 0; i < 6; i++) {
      add(sbox(0.003, 0.006, 0.030, emissive(i % 3 === 1 ? 0xffc040 : 0x2e6c86, 1.5),
        ...A(-0.500 + i * 0.112, 1.932, 0.089 - (i === 1 || i === 4 ? 0.016 : 0))));
    }
    // and the keyboard's backlight, in the 34 mm channel the kit leaves between
    // the deck's rear lip and the key plate. A backlit keyboard at arm's length
    // is a glow round the caps, not twenty-two lit legends.
    add(sbox(0.024, 0.004, 0.640, emissive(0x9fd8ff, 0.75), ...A(-0.145, 0.766, 0.069)));
  }
  stations.push({
    id: 'archive', label: 'ARCHIVE', hint: 'Review discoveries and records',
    pos: new THREE.Vector3(-HW + 1.15, 1.0, 0.95), radius: 1.0,
    look: new THREE.Vector3(-HW + 0.3, 1.35, 0.95),
  });

  /* ---- resonance chamber, aft bulkhead.
     The wall itself is a kit piece now. What was here was two boxes — a
     3.4 x 2.4 m slab with a 1.9 x 1.6 m slab laid on it — which is one of the
     two walls the player actually walks up to and stands in front of, and by
     a distance the flattest surface in the ship. tools/interior_bake's
     `resonance_wall` builds the same wall with the detail modelled: stepped
     surround, plating with real seams and fasteners, a sunk drum, seven
     machined socket wells, a louvred stack, trunking and grab handles.

     What stays in here is what the kit cannot carry, which is everything that
     lights up: the sockets animate as the Cantos are collected, so their rings
     and cores have to be live meshes. They sit *in* the wells the kit cuts. */
  const res = new THREE.Group();
  res.position.set(0, 0, 6.9);
  add(res);
  if (!haveKit) {
    res.add(box(3.4, 2.4, 0.14, M.panel, 0, 1.2, 0.2));
    res.add(box(1.9, 1.6, 0.10, M.dark, 0, 1.30, 0.10));
  } else {
    placeKit('resonance', 0, 0, 0);
  }
  const sockets = [];
  for (let i = 0; i < 7; i++) {
    const a = -Math.PI / 2 + (i / 7) * Math.PI * 2;
    const x = Math.cos(a) * 0.52, y = 1.30 + Math.sin(a) * 0.52;
    // At the mouth of the bore the kit machines, not floating on the plate:
    // the well bore is r 0.070 running back from z 7.006, so the ring beds
    // into its chamfer and the core sits inside it.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(haveKit ? 0.068 : 0.075, haveKit ? 0.010 : 0.012, 8, 24),
      emissive(0x2a3a44, 1.0));
    ring.position.set(x, y, haveKit ? 0.104 : 0.06);
    res.add(ring);
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), emissive(0x14202a, 1.0));
    core.position.set(x, y, haveKit ? 0.124 : 0.06);
    res.add(core);
    sockets.push({ ring, core, index: i });
  }
  /* Sized against the boss the kit machines rather than against the old flat
     plate. At r 0.13 it covered the whole centre fitting and read as one grey
     polygon sitting on nothing; at 0.062 it sits *in* the collar, which is
     what a resonator in its cradle looks like when it is not lit. */
  const resCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(haveKit ? 0.062 : 0.13, 1), emissive(0x1a2a34, 1.0));
  resCore.position.set(0, 1.30, haveKit ? -0.045 : 0.05);
  res.add(resCore);
  /* Pulled in and warmed. At 2.2 m of throw this one cyan lamp was the only
     thing on a 3.4 m wall, so the whole compartment's best surface came out as
     a single blue cast — the failure the hologram table's spill already had to
     be fixed for. Instrument colour stays on the instrument; the wall is lit
     by the wash below. */
  pl(-0.66, 1.36, 6.62, 0x6fd4ff, 2.4, 1.5);
  /* And a key that actually casts. The chamber had one point light dead on the
     axis of a flat wall, which is the one position from which nothing on it
     can throw a shadow — see the note on the corridor spot. Off the
     centreline, high, and raking across the sockets and the trunking. */
  spot(-0.95, 2.16, 6.05, -0.10, 1.10, 6.95, 0xffd6b0, 30, 0.85, 1024);
  stations.push({
    id: 'resonance', label: 'RESONANCE CHAMBER', hint: 'The Cantos',
    pos: new THREE.Vector3(0, 1.0, 5.85), radius: 1.1,
    look: new THREE.Vector3(0, 1.3, 6.9),
  });

  /* ---- observation port, starboard.
     A kit piece now. What was here was eight meshes — `TorusGeometry(0.56,
     0.07)`, `CircleGeometry(0.55)` and six copies of `box(0.10, 0.10, 0.05)`
     on a bolt circle — and it read as exactly what it was, a ring stuck on a
     wall. A port is not a ring, it is a *hole*: the whole read is the depth of
     the barrel and the thickness of the hull round it, and there was none of
     either.

     tools/interior_bake's `observation_port` is a pressure fitting: a doubler
     stepped three times out of the skin, a drafted barrel with a machined
     step, a clamp ring with twelve dogs holding the pane, a raised collar with
     a sixteen-bolt circle, a shutter in a housing above with guide rails, a
     jackscrew and a manual crank, a condensate gutter draining to a catch
     bottle, handles, placards and a service valve.

     The pane stays here — it is glass, it is bound to the sun, and the kit
     cannot carry either. It sits at the *bottom* of the barrel now rather than
     flush with the wall, which is most of what makes the fitting read. */
  const portGroup = new THREE.Group();
  portGroup.position.set(HW - 0.02, 1.35, 4.3);
  portGroup.rotation.y = -Math.PI / 2;
  add(portGroup);
  if (haveKit) {
    placeKit('port', HW - 0.02, 1.35, 4.3, -Math.PI / 2);
  } else {
    portGroup.add(new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.07, 10, 40), M.dark));
  }
  /* Sized against the *bore*, not by eye: the barrel is r 0.446 at the pane
     seat, so a 0.436 pane left a 10 mm annulus open all the way round and the
     bay skin 140 mm behind it showed through as a dithered fringe. */
  const portGlass = new THREE.Mesh(
    new THREE.CircleGeometry(haveKit ? 0.448 : 0.55, 48), M.portGlass);
  portGlass.position.z = haveKit ? -0.044 : 0;
  portGlass.renderOrder = 14;
  bindGlass(portGlass, M.portGlass);
  portGroup.add(portGlass);
  if (haveKit) {
    /* Two throat lamps inside the barrel, washing the bore rather than the
       pane, and the fitting's tell-tales. A porthole with no light of its own
       is a black disc: this one had no lamp within 1.5 m and photographed as
       exactly that.

       Added to the root rather than to the group, so mergeStatic welds them
       into the emissive buckets the rest of the cabin already draws. A Group
       is kept whole by the merge, so five sprites parented to one are five
       draw calls; the same five in cabin space are none. The transform is the
       group's own: ry = -90 degrees about (HW - 0.02, 1.35, 4.30), which sends
       the piece's +x aft and its +z into the room. */
    const P = (lx, ly, lz) => [HW - 0.02 - lz, 1.35 + ly, 4.30 + lx];
    for (const sy of [-1, 1]) {
      /* Dim on purpose. These are 40 cm from the eye when the player leans in,
         and the exposure is metered off the frame: at 1.6 they set it for the
         whole compartment and blew a white band across the top of the bore.
         Dimmer again, and moved 50 mm out of the bore. They stood at lz 0.006,
         which is 50 mm *in front of* the pane at a radius of 0.420 against a
         bore of 0.448 — so their reflection in the glass landed in the outer
         annulus at a grazing angle, where the Fresnel term is at its maximum.
         The review's reading of the aperture as "a blurred mirror of the room"
         is largely these two: they are the brightest thing the pane can see.
         At the mouth of the barrel they still wash the bore, which is their
         job, and their mirror image falls outside the aperture. */
      add(sbox(0.012, 0.008, 0.230, emissive(0xbfe0ff, 0.24), ...P(0, sy * 0.420, 0.058)));
    }
    // seal-status and shutter tell-tales, on the placard and the housing
    add(sbox(0.004, 0.012, 0.022, emissive(0x62ff8a, 2.0), ...P(-0.058, -0.606, 0.060)));
    add(sbox(0.004, 0.012, 0.022, emissive(0xffc040, 1.8), ...P(0.058, -0.606, 0.060)));
    add(sbox(0.004, 0.010, 0.160, emissive(0x7fd8ff, 1.2), ...P(0.0, 0.906, 0.110)));
    /* Off the pane's axis on purpose. This stood at (HW - 0.42, 1.62, 4.30) —
       0.42 m out along the bore's own centreline and 0.27 m above it — so its
       specular image in the glass sat just inside the aperture from every
       standing eye in the compartment: a bright soft blob on a dark disc, which
       is the other half of "a blurred mirror of the room". Dropped below the
       bore and moved aft, it lights the ring, the dogs and the crank exactly as
       before and reflects up and forward, out of shot. */
    pl(HW - 0.54, 0.96, 4.66, 0xbcd8f0, 2.2, 1.6);
  }
  stations.push({
    id: 'port', label: 'OBSERVATION PORT', hint: 'Look outside',
    pos: new THREE.Vector3(HW - 1.0, 1.0, 4.3), radius: 0.9,
    look: new THREE.Vector3(HW + 4, 1.35, 4.3),
  });

  /* ------------------------------------------------------------- dressing */
  /* Personal effects. The review's comparison against Starfield came down to
     one sentence: the reference frame is "90% unique dressed props -- books, a
     cracked helmet, a strapped crate, a poster -- and ours has none." What was
     here was *equipment*: a tool board, a cable drape, transit cases, a hung
     coverall. Equipment says the ship is maintained. It does not say anyone
     lives in it. These three are the ones that do, and each is placed exactly
     once and never mirrored. */
  if (haveKit) {
    // Stowage along the port wall of the habitat, and the loose freight that
    // says somebody lives here. Placed exactly where they stood during the
    // occlusion bake, so the contact shadow under each one is the right one.
    /* Four positions, four different lockers.
       It ran A, A, B, A, and the review still read the bank as one asset:
       "same outline, same louvre group, same handle, same rivet pattern, four
       times". Repetition survives one exception — three of anything in a row
       is a pattern and the fourth is a typo. So there are four masters now and
       none is placed twice:
         A  the plain two-door carcass, T-handles
         D  a single full-height door with a canted lever, a framed placard, a
            barrel lock and a kit bag hung off the cheek
         B  the lower door standing open on its hinge, shelf and parcels
            visible, a cam strap across the upper door
         C  netted: a cam-strap lattice over both doors with a ratchet on the
            cheek, a paddle latch instead of a T-handle, a pushed-in top corner
            with the paint gone off the fold, three labels at three angles and
            a coil of line on a hook
       Three extra masters cost three meshes and nothing per draw call after
       mergeStatic; what they buy is that no two doors in the run match. */
    placeKit('locker', -HW + 0.17, 0, 3.30, Math.PI / 2);
    placeKit('locker_d', -HW + 0.17, 0, 4.16, Math.PI / 2);
    placeKit('locker_b', -HW + 0.17, 0, 5.02, Math.PI / 2);
    placeKit('locker_c', -HW + 0.17, 0, 5.88, Math.PI / 2);
    /* And the loose stowage, which is the thing the review said was louder
       than any shader problem: "a ship somebody lives in has loose objects
       with individual histories". Both are on the starboard side, where the
       habitat had two metres of blank wall and an empty aft corner.

       `stowbay` is an open shelf with a restraint bar across it, a lashing
       cord over the upper compartment, and nine objects in it of which no two
       share a size, a material or an angle: four books with boards and spine
       bands, a slumped cloth bag with a drawstring, a chocked canister, a
       labelled case with a red pull tab, a strapped bundle, a mug and a
       printed sheet taped to the back panel. `netcargo` is freight under a
       real net — a crate, a drum on its side and a sack, with the net sagging
       into the gaps between them, corner hooks, a ratchet tensioner and two
       deck rings. Transforms match 50_assemble.py exactly or the contact
       shadow baked under each one belongs to a different pose. */
    placeKit('stowbay', HW - 0.03, 1.02, 1.62, -Math.PI / 2);
    placeKit('netcargo', 1.44, DECK_TOP, 6.02, -0.34);
    placeKit('crate_a', 1.50, DECK_TOP, 1.40, 0.5);
    placeKit('crate_b', 1.35, DECK_TOP, 1.95, -0.7);
    placeKit('crate_b', 1.55, DECK_TOP + 0.36, 1.40, 1.2);
    // service boxes on otherwise blank wall
    placeKit('wallbox', HW - 0.03, 1.42, 2.30, Math.PI / 2);
    placeKit('wallbox', -CHW + 0.03, 1.46, -2.30, -Math.PI / 2);
    placeKit('wallbox', HW - 0.03, 1.38, 5.30, Math.PI / 2);
    // pipes crossing the corridor ceiling
    for (const z of [-2.35, -1.35, -0.45]) placeKit('pipe_run', 0, CH - 0.16, z);
    /* Corridor dressing. The review called this the only interior frame that
       reads as a real place, and said what it wants is not more geometry but
       signs of occupation: crates, clutter, hanging cable, personal effects.
       Everything here is either on a wall, above head height, or tight into a
       corner — the corridor is 1.72 m of walkable width and the walk to the
       helm is asserted by tools/play.mjs, so none of it may narrow the middle.
       Sizes and rotations match tools/interior_bake/50_assemble.py exactly, or
       the contact shadow baked under each prop belongs to a different pose. */
    placeKit('cable_drape', 0, CH - 0.20, -1.86);
    placeKit('toolboard', CHW - 0.035, 0.86, -2.62, Math.PI / 2);
    placeKit('stack', -CHW + 0.30, DECK_TOP, -0.30, 0.42);
    placeKit('coverall', -CHW + 0.075, 0.55, -3.02, -Math.PI / 2);
    placeKit('crate_b', CHW - 0.28, DECK_TOP, -3.05, -0.35);
    /* And the three that are somebody's rather than the ship's. Same
       transforms as 50_assemble.py, or the contact shadow baked under each
       one belongs to a different pose. */
    placeKit('pinboard', HW - 0.035, 1.62, 5.62, -Math.PI / 2);
    placeKit('helmet', -HW + 0.20, 1.585, 5.02, 0.62);
    placeKit('slates', HW - 0.115, 1.20, 3.02, -Math.PI / 2);
  } else {
    for (let i = 0; i < 4; i++) {
      const z = 3.3 + i * 0.86;
      add(box(0.30, 1.5, 0.80, M.panel, -HW + 0.18, 0.85, z));
      add(box(0.03, 0.05, 0.30, M.accent, -HW + 0.34, 0.85, z));
      add(box(0.26, 0.02, 0.72, M.dark, -HW + 0.19, 1.61, z));
    }
    for (const [x, y, z, s] of [[1.5, 0.30, 1.4, 0.5], [1.35, 0.30, 1.95, 0.42], [1.55, 0.78, 1.4, 0.34]]) {
      const c = box(s, s * 0.9, s, M.dark, x, y, z);
      c.rotation.y = (x + z) * 0.7;
      add(c);
    }
    for (let i = 0; i < 4; i++) {
      const p = cyl(0.03, 0.03, 2.1, 12, M.dark, 0, CH - 0.14, -2.9 + i * 0.95);
      p.rotation.z = Math.PI / 2;
      add(p);
    }
  }

  /* ---------------------------------------------------- finalise transform */
  /* -------------------------------------------------- merge static geometry
     ~300 individual meshes is fine to draw but ruinous once every shadow-
     casting lamp has to draw them again. Welding everything that shares a
     material takes the cabin to a handful of calls, which is what makes real
     shadows affordable. Positions end up in cabin space, so the procedural
     panel grid also runs continuously across the whole ship. */
  mergeStatic(root);

  root.traverse((o) => {
    o.frustumCulled = false;
    o.layers.set(INTERIOR_LAYER);
    if (o.isMesh) { o.castShadow = !o.userData.noShadow; o.receiveShadow = true; }
  });

  return {
    root, materials: M, screens, stations, lights, animated,
    sockets, resCore, navTable: nav,
    metresToWorld: M_TO_WORLD,
    glazing,
    /**
     * Can the pilot see out along this ray?
     *
     * The cabin is a second scene drawn over the world with its own cleared
     * depth, so anything the HUD projects into the canopy is composited on top
     * of the room whatever is in front of it. The measured symptom: a contact
     * label reading "COLD HARVEST · COURIER / RANGE 3.3 Mm" drawn across the
     * centre MFD and interleaved with the MFD's own type, and a second one over
     * the left MFD and the throttle. Bodies that are physically behind the
     * dashboard were labelled as if the dashboard were not there.
     *
     * Rather than build an occluder set — which is a second copy of the cabin,
     * kept in step by hand — this asks the question the other way round. What
     * the pilot can see out of is the *glazing*, exactly, and the glazing is two
     * meshes and about sixteen hundred triangles. A ray that leaves through a
     * pane is a contact you can see; a ray that does not has console, coaming,
     * sill, roof or bulkhead in the way, and that covers every case the review
     * found without enumerating any of them.
     *
     * @param {number} nx  NDC x, -1..1 (the same value HUD.js projects)
     * @param {number} ny  NDC y, -1..1
     * @param {THREE.Camera} cam  the *interior* camera; it shares the world
     *   camera's fov and aspect, so the two agree on NDC exactly.
     */
    seesSky(nx, ny, cam) {
      if (!cam || glazing.length === 0) return true;
      _rcNdc.set(nx, ny, 0.5).unproject(cam);
      _rcDir.subVectors(_rcNdc, cam.position).normalize();
      _rc.set(cam.position, _rcDir);
      /* `false` — no recursion. Both panes are leaves, and the spill quads and
         display canvases parented to other objects are not glazing. */
      return _rc.intersectObjects(glazing, false).length > 0;
    },
    /* walkable volumes in metres: [minX, maxX, minZ, maxZ], forward to aft.
       Player._tryMove takes zMin from the *first* entry and zMax from the last,
       and _halfWidthAt returns the half-width of the first volume whose z range
       contains the point — so the cockpit is split into bands that taper with
       the hull instead of one 1.62 m rectangle running to the nose ring.

       The rectangle was wrong. The deck closes from 1.79 m of half-width at
       the bulkhead to 1.00 m at z -7.58, so at the forward end the volume
       described 1.32 m of standing room (1.62 less the 0.30 collision radius)
       where the skin at chest height is at 1.19 — a third of a metre outside
       the ship. It was not reachable, and only by luck: the dashboard blocker
       spans the full width from z -6.90 to -5.42 and seals the nose off
       entirely, so the reachable set stops well short of it. A bound that is
       only correct because something unrelated is in the way is a bound that
       breaks the day the dashboard moves. These follow hullX at deck height,
       so the taper is derived rather than guessed. */
    volumes: [
      [-1.19, 1.19, -7.15, -6.60],
      [-1.43, 1.43, -6.60, -6.05],
      [-1.56, 1.56, -6.05, -5.40],
      [-1.62, 1.62, -5.40, -3.42],
      [-0.86, 0.86, -3.42, 0.62],
      [-1.68, 1.68, 0.62, 6.55],
    ],
    // solid obstacles the player must walk around: [minX, maxX, minZ, maxZ]
    blockers: [
      /* The seat, and its aft face is load bearing. Player.stand() drops the
         player at (0, -4.35) — and this box used to run to -4.50, which with
         the 0.30 collision radius blocks everything up to -4.20. The player
         therefore stood up *inside* a blocker, where every candidate move at
         every frame rate lands in it too: measured, holding W, S, A or D for
         three seconds each moved the player exactly zero millimetres. Leaving
         the helm soft-locked the game. The seat's own back shell reaches
         z -4.58, so the box stops at -4.72 and the player lands 0.07 m clear
         of it with the shell still solid to walk into. */
      [-0.66, 0.66, -5.66, -4.72],   // pilot seat, back included
      [-1.55, 1.55, -6.60, -5.72],   // dashboard
      /* The one route aft is the lane between these two and the port wall, and
         it was closed. The table's skirt is r 0.80 and the lockers are 0.30 m
         deep at x -2.03..-1.73, but the boxes ran to 0.92 and -1.30 — 0.12 m
         and 0.43 m of slack. Expanded by the 0.30 m collision radius that left
         a lane from x -1.38 (the volume's own limit) to -1.22 abreast of the
         table and *nothing at all* abreast of the lockers, with no z at which
         the two lanes overlap: measured by flood fill, everything aft of
         z 2.7 was unreachable on foot. The resonance chamber and the
         observation port are both back there, and both are stations the game
         asks the player to walk to. Sized to the geometry, the lane is
         0.22 m wide and continuous the length of the habitat. */
      [-0.86, 0.86, 1.76, 3.44],     // nav table
      [-2.05, -1.72, 2.85, 6.35],    // lockers
      /* No blocker for the archive console, deliberately. Its front face is at
         x -1.43 and the habitat volume already stops the player's centre at
         -1.38, so it is unreachable by 50 mm — and the one route past the nav
         table is the 160 mm lane between the table's blocker and the port wall
         at x -1.38..-1.22. Anything on that wall between z 1.4 and 1.9 seals
         the habitat off completely: adding the obvious box here cut the
         resonance chamber, the port and half the lockers out of the ship, and
         nothing in play.mjs walks that far so nothing caught it. */
      [1.05, 1.85, 1.05, 2.30],      // crates
      /* Netted freight in the aft starboard corner. It hugs the wall — the
         habitat's half-width is 1.68 and the resonance chamber's station puts
         the player at (0, 5.85), so expanded by the 0.30 collision radius this
         still leaves 2.68 m of clear lane down the middle and does not reach
         the resonance station's stand-off circle at all. Re-flood-filled after
         adding it: all five stations still reachable. */
      [1.12, 1.78, 5.66, 6.38],      // netted freight
      // corridor clutter. Both hug a wall: the walkable half-width there is
      // 1.15 and the player's own radius is 0.30, so a 0.34 m-deep prop still
      // leaves 1.0 m of clear centre and tools/play.mjs still reaches the helm.
      [-1.16, -0.56, -0.62, 0.02],   // strapped stack, port
      [0.60, 1.16, -3.30, -2.80],    // loose crate, starboard
    ],
  };
}

function mergeStatic(root) {
  const buckets = new Map();
  const keep = [];

  for (const child of [...root.children]) {
    if (!child.isMesh || !child.geometry || !child.material
      || child.userData.dynamic || child.material.transparent) {
      keep.push(child);
      continue;
    }
    child.updateMatrix();
    /* The procedural surfacing is driven entirely by cabin-space position, so
       for everything the game builds itself the UVs can go — dropping them
       (and the index) makes every geometry mergeable. The kit is the
       exception: its UV set is the occlusion atlas, and three needs a real uv
       attribute to sample an aoMap at all. */
    const keepUv = !!child.material.aoMap;
    let g = child.geometry.clone().applyMatrix4(child.matrix);
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) {
      if (name === 'position' || name === 'normal') continue;
      if (keepUv && name === 'uv') continue;
      g.deleteAttribute(name);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    /* An emissive fixture's tint travels in the vertices rather than in the
       material — see the block comment on `emissive`. Written after the strip
       above, because that would have thrown the attribute straight back out. */
    const tint = child.material.userData.emissiveTint;
    if (tint) {
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const mat = tint ? emissiveWeld() : child.material;
    const key = mat.uuid;
    if (!buckets.has(key)) buckets.set(key, { mat, geos: [] });
    buckets.get(key).geos.push(g);
  }

  root.clear();
  for (const k of keep) root.add(k);
  for (const { mat, geos } of buckets.values()) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) { geos.forEach((g, i) => root.add(new THREE.Mesh(g, mat))); continue; }
    geos.forEach((g) => { if (g !== merged) g.dispose(); });
    root.add(new THREE.Mesh(merged, mat));
  }
}

export { INTERIOR_LAYER };
