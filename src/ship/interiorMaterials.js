import * as THREE from 'three';

/* ============================================================================
   Interior surfacing.

   This file used to hold a procedural surface model — panel grid, weld beads,
   rivets, anti-slip tread, stencilled markings, woven cloth and a bump built
   from screen-space derivatives, all evaluated analytically per fragment. It
   was carefully tuned and it could not be made to stop aliasing, for a reason
   no amount of tuning reaches: **MSAA antialiases triangle coverage, not
   shading.** It resolves one shaded sample per pixel across a geometric edge.
   Every one of those features was a hard step computed *inside* the shader,
   and there was no mip chain to prefilter it because there were no textures.
   Widening each step by its pixel footprint (which the old model did, at
   length) keeps a transition a pixel wide; it cannot make it a *filtered
   average* of the fifty features that really fall under that pixel at a
   grazing angle. Starfield and everything like it ship prefiltered, mipmapped
   maps. That is the whole difference.

   So the surface model now lives in Blender, baked into tiling maps:

     · a 2 m tile of hull plating and a 1.5 m tile of deck plate, each with
       albedo, a filtered normal derived from a ray-traced height field, and a
       packed ORM (R occlusion, G roughness, B metalness);
     · a glTF kit of real geometry whose ambient occlusion is baked, at corner
       scale, with the whole ship assembled around each piece.

   What is still computed here is only what genuinely varies with *where you
   are in the room* and is smooth enough that it cannot alias: grime that
   deepens toward the deck, scuffs along the kick line, wear where hands go, a
   walking lane down the middle of the deck, and the grazing-incidence term
   that stops GGX turning matte paint into glass down the length of a tube you
   spend the whole game looking along.

   Maps are sampled triplanar from cabin-space position. No UV attribute is
   required, so the merge pass can still weld the whole cabin into a handful of
   draw calls, and the plate grid runs continuously across the ship the way
   real panelling does.
   ========================================================================== */

export const INTERIOR_LAYER = 1;

/**
 * One shared trim on the cabin's bounce fill — see the `aomap_fragment`
 * injection in `dressInterior`.
 *
 * It is a single uniform object handed to every dressed material rather than a
 * per-material constant, for two reasons. Every surface in the room is filled
 * by the same bounced light, so there is exactly one number to turn; and it can
 * be turned *from outside*, which is the only way to measure what the fill is
 * actually contributing. The frame is a moving target — two other passes and an
 * auto-exposure sit downstream of it — so "black% fell by nine points" is only
 * meaningful as an A/B taken inside one session, and that needs a switch.
 *
 * A material carries it as `userData.fill`, so:
 *   g.interior.root.traverse(o => { if (o.material?.userData?.fill)
 *                                     o.material.userData.fill.value = 0; });
 */
export const INTERIOR_FILL = { value: 1.0 };

/**
 * The same switch for the specular occlusion term — see the injection above
 * `aomap_fragment` in `dressInterior`.
 *
 * It exists for the same reason INTERIOR_FILL does: a term that changes how
 * *shiny* a room looks cannot be judged from a still, because the auto-exposure
 * and the tone curve both move under it. The only honest measurement is an A/B
 * inside one session with the clock pinned, and that needs a switch:
 *
 *   g.interior.root.traverse(o => { if (o.material?.userData?.specOcc)
 *                                     o.material.userData.specOcc.value = 0; });
 */
export const INTERIOR_SPEC_OCC = { value: 1.0 };

/**
 * And the same switch again for the shaping applied to the cabin's *ambient* —
 * see the `aomap_fragment` injection in `dressInterior`.
 *
 * The cabin carries an AmbientLight and a HemisphereLight at 0.4 apiece, which
 * between them are a constant added to every fragment in the room. That is the
 * one thing in here that provably cannot describe a shadow, and it is most of
 * why the room reads as uniformly lit. The shaping multiplies it by cavity and
 * by a steep hemisphere so it lands like a room probe instead of like a
 * constant; this turns it off so the difference can be measured rather than
 * argued about:
 *
 *   g.interior.root.traverse(o => { if (o.material?.userData?.shape)
 *                                     o.material.userData.shape.value = 0; });
 */
export const INTERIOR_SHAPE = { value: 1.0 };

/**
 * Remove the logarithmic-depth fragment write from a material.
 *
 * three enables log depth renderer-wide, and its fragment chunk writes
 * gl_FragDepth for every pixel. Writing depth from the fragment shader disables
 * the GPU's early-Z rejection, so every occluded fragment still executes its
 * full shader — and the cabin's shader is the most expensive one in the game.
 * On a tile-based GPU, which is every Apple machine, that turned out to be the
 * single largest cost in the frame: measured at 44 -> 72 fps with it gone,
 * against 44 -> 51 for deleting the entire post-processing chain.
 *
 * The exterior genuinely needs it — planet surfaces z-fight against their
 * atmosphere shells across a ~1e7 depth range without it. The interior does
 * not. It is a 15 m cabin drawn into a freshly cleared depth buffer with near
 * 0.02 and far 400, where ordinary depth precision is far more than enough.
 * They are separate passes, so one can drop it while the other keeps it.
 */
export function stripLogDepth(mat) { return setLogDepth(mat, false); }

/**
 * Turn the logarithmic depth buffer on or off for one material, reversibly.
 *
 * The ground scene needs the same relief the cabin gets — it spans 6 m to
 * 26 km, which 24 bits of ordinary depth hold comfortably — but it *shares* the
 * hull's materials with the exterior, which genuinely does need log depth. So
 * this is a switch rather than a one-way strip: `Game.land` throws it off for
 * everything drawn on the ground and `Game.liftOff` throws it back on.
 *
 * Two things make it work, and the obvious implementation has neither.
 *
 * **Not the renderer flag.** `WebGLPrograms` captures
 * `capabilities.logarithmicDepthBuffer` in a closure const at construction, so
 * flipping the renderer's own flag at runtime changes the uniform-setting side
 * and *not* the shader defines. Every hull fragment then writes gl_FragDepth
 * from an unset `logDepthBufFC`, goes out of range, and the ship vanishes from
 * the frame while still costing its sixty draw calls. That was observed.
 *
 * **`#undef`, not a text replacement.** three's define lives in the prefix it
 * puts in front of this source, and every log-depth chunk in the game — three's
 * own `logdepthbuf_*` and this project's `LOGD_*` — is guarded by that one
 * macro. Undefining it at the top of the body therefore covers a stock
 * `MeshStandardMaterial` and a hand-written `ShaderMaterial` with the same two
 * lines. Undefining a macro that was never defined is legal, so `?logdepth=0`
 * costs nothing.
 *
 * The paired `customProgramCacheKey` is what keeps the two variants from
 * sharing a compiled program. three keys each material's programs in a Map, so
 * flipping the switch back and forth compiles each variant once and then only
 * looks it up.
 */
export function setLogDepth(mat, on) {
  if (!mat) return mat;
  /* Is our hook still the one installed?
   *
   * `clone()` deep-copies userData but drops onBeforeCompile back to the
   * prototype no-op — the same three behaviour dressedVariant exists for — so a
   * clone arrives carrying the *flag* and none of the machinery, and a marker
   * kept in userData alone would report the job already done. The hook records
   * itself instead, on the material rather than in userData, so a clone or a
   * later re-dress reads as "not installed" and gets it back. */
  if (mat._logDepthHook !== mat.onBeforeCompile) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (sh, renderer) {
      if (prev) prev.call(this, sh, renderer);
      if (!this.userData.noLogDepth) return;
      sh.vertexShader = '#undef USE_LOGARITHMIC_DEPTH_BUFFER\n' + sh.vertexShader;
      sh.fragmentShader = '#undef USE_LOGARITHMIC_DEPTH_BUFFER\n' + sh.fragmentShader;
    };
    mat._logDepthHook = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = function () {
      return (prevKey ? prevKey.call(this) : '') + (this.userData.noLogDepth ? '|nologd' : '');
    };
    mat.userData.noLogDepth = undefined;
  }
  const strip = !on;
  if (mat.userData.noLogDepth === strip) return mat;
  mat.userData.noLogDepth = strip;
  mat.needsUpdate = true;
  return mat;
}

/* ============================================================================
   The cabin, reflected.

   Shared by every reflective surface in the room — the MFD glass, the canopy
   panes, the nav plate — because they all have to reflect *the same room* or
   the illusion comes apart the moment two of them are in frame together.

   This used to be four smoothsteps of direction alone, and it was the single
   worst thing in the ship. A function of `r` and nothing else is *constant*
   over any surface whose normal is nearly constant, and from the seat the
   canopy wraps the upper field at seventy to eighty-five degrees of incidence:
   Fresnel, thickness and coat are all flat across the whole pane, so a flat
   environment on top of them makes the windscreen one uniform grey veil edge
   to edge. Measured, hiding the glass changed the up-view by a mean of 15.8
   levels over 43% of the frame, and the planet's cloud and ocean detail — crisp
   with the glass off — disappeared. A veil is not glass. You cannot see a clean
   sheet of glass; what you see is the *room in it*, and a room has edges.

   So the room is now evaluated with parallax, from the reflecting point:

     · a dark, near-flat ambient by direction — the painted shell, which is
       genuinely almost featureless and is allowed to be;
     · the actual lamps of the ship as *line* emitters at their real cabin
       coordinates — the two tungsten ceiling coves, the coaming strip under
       the glareshield lip, the overhead console's cold forward edge, the
       corridor and habitat coves — reflected as streaks that slide across the
       pane with the head, because that is what a windscreen does;
     · the main display cluster as a rectangle on the raked fascia, which is
       the one reflected thing in here with a recognisable *shape*.

   Lobes are angular, not metric. A reflected strip light subtends the same
   angle wherever it is, which is what makes it read as a reflection rather
   than as something painted on the glass; and a fixed angular width cannot
   fall under a pixel, which is what every hard feature computed in a shader
   with no mip chain under it eventually does.

   Everything here is in cabin space: metres, hull-relative, -Z toward the
   nose, deck at y = 0.08, seated eye at (0, 1.34, -5.26). The lamp positions
   are Interior.js's, transcribed; if a fixture moves there it should move here
   or the reflection stops agreeing with the room.

   `cabinRoom(r)` is the painted shell by direction alone and `cabinLamps(p, r)`
   is the fixtures with parallax, both in scene radiance; a caller multiplies
   their sum by the surface's own reflectance. `cabinEnv(r)` is the old
   direction-only environment at its old reflectance scale, kept because
   HoloScreen.js shares this chunk and is calibrated against it.
   ========================================================================== */
export const CABIN_ENV_GLSL = /* glsl */`
/* Angular lobe of a line emitter, seen from o along d.

   Closest approach between the ray and the segment, with the miss distance
   divided by the range so it comes out as an angle. Both clamps matter: s off
   the end of the segment means the lamp stops rather than running to infinity,
   and t behind the eye means a fixture that is *behind* the pane contributes
   nothing instead of reflecting through it. */
float lineLobe(vec3 o, vec3 d, vec3 a, vec3 b, float sig){
  vec3 u = b - a;
  vec3 w = o - a;
  float uu = dot(u, u), ud = dot(u, d), uw = dot(u, w), dw = dot(d, w);
  float s = clamp((uw - dw * ud) / max(uu - ud * ud, 1e-4), 0.0, 1.0);
  float t = max(s * ud - dw, 0.0);
  float m = length(w + t * d - s * u) / max(t, 0.30);
  float q = m / sig;
  return exp(-q * q);
}

/* The same for a lit rectangle — a panel rather than a lamp.

   ax and ay are unit, in the plane; hw is the half-extent along each. The
   parametric distance is clamped rather than branched on, because a ray nearly
   parallel to the plane otherwise produces an infinity that comes back through
   length() as a NaN, and a NaN in an additively blended HDR target is a black
   pixel with two blown neighbours. */
float rectLobe(vec3 o, vec3 d, vec3 c, vec3 ax, vec3 ay, vec2 hw, float soft){
  vec3 pn = cross(ax, ay);
  float dn = dot(d, pn);
  float t = clamp(dot(c - o, pn) / (dn + (step(0.0, dn) * 2.0 - 1.0) * 1e-3),
                  -1.0, 40.0);
  vec3 h = o + t * d - c;
  vec2 q = abs(vec2(dot(h, ax), dot(h, ay))) - hw;
  float sd = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
  return step(0.02, t) * (1.0 - smoothstep(0.0, soft * max(t, 0.30), sd));
}

/* The painted shell, as radiance rather than as reflectance.

   Three values and not two, because the two that matter most are next to each
   other: the *walls* are the brightest thing the room has to offer a mirror —
   bone paint washed directly by the coves — and the *deck* is the darkest,
   and a single up/down ramp puts the crossover in the wrong place and makes
   the canopy brightest where it reflects the ceiling. Across a wrapped pane
   what that produces is a gradient running from dark at the crown, where the
   glass is looking straight down at the floor, to bright at the sills, where
   it is looking across the cabin — which is both correct and, not by accident,
   the same direction the edge sheen climbs in.

   And a hole where the canopy is, because most of what a windscreen reflects
   is the window. */
vec3 cabinRoom(vec3 r){
  vec3 c = mix(vec3(0.100, 0.070, 0.042), vec3(0.240, 0.210, 0.170),
               smoothstep(-0.80, -0.06, r.y));
  c = mix(c, vec3(0.200, 0.220, 0.262), smoothstep(0.02, 0.72, r.y));
  c = mix(c, vec3(0.009, 0.015, 0.024),
          smoothstep(0.02, 0.55, -r.z) * smoothstep(-0.35, 0.28, r.y) * 0.88);
  return c;
}

/* The old direction-only environment, kept at its old scale and shape.

   HoloScreen.js is in this chunk too and its env gains are calibrated against
   what this returned before — a reflectance around 0.05 to 0.12 with the
   ceiling coves and the glareshield as direction-only lobes. A small MFD does
   not need parallax and cannot afford the lobes, so it keeps this; the glazing
   uses cabinRoom + cabinLamps and does not go through here at all. Changing
   the units under a caller in another file would have quietly rescaled every
   screen in the ship.

   The two squarings used to be pow(x, 2.0) with x a difference that goes
   negative on one side of the lobe, which is undefined in GLSL ES and returns
   NaN under ANGLE. It never showed because the lobe was narrow and the NaN
   landed where the mask was already zero, but it was one normal away from a
   black pixel with two blown neighbours. */
vec3 cabinEnv(vec3 r){
  vec3 c = cabinRoom(r) * 0.42;
  // the two tungsten ceiling coves, high and outboard
  float xr = (abs(r.x) - 0.46) / 0.21;
  c += vec3(1.00, 0.84, 0.64)
     * smoothstep(0.40, 0.90, r.y) * exp(-xr * xr) * 0.80;
  // the overhead console's cold forward lip, high and ahead
  c += vec3(0.70, 0.82, 1.00)
     * smoothstep(0.22, 0.72, r.y) * smoothstep(0.12, 0.58, -r.z) * 0.30;
  // the glareshield, down and forward: seven lit displays and a light strip
  float xg = r.x / 0.62;
  c += vec3(0.62, 0.78, 1.00)
     * smoothstep(-0.24, -0.72, r.y) * smoothstep(0.08, 0.58, -r.z)
     * exp(-xg * xg) * 0.34;
  return c;
}

/* The room with its lamps in it, from the point p along the reflected ray r.

   The branch is on cabin z and is coherent for every fragment of a given pane
   — the canopy is entirely forward of the cockpit bulkhead and the nav plate
   and the observation port are entirely aft of it — so it costs a scalar
   compare and saves half the lobes on every pixel. */
vec3 cabinLamps(vec3 p, vec3 r){
  vec3 c = vec3(0.0);
  if(p.z < -3.40){
    /* The two tungsten ceiling coves, 0xffd7b0 at 2.66. The longest bright
       thing in the cockpit and the streak a canopy is made of.

       The forward end is -5.19, which is where the coves physically stop:
       ROOF_Z + 0.06, sixty millimetres aft of the glazing edge. This was
       guessed at -6.30 while the geometry was mid-rewrite, and the guess put
       1.1 m of reflected cove forward of the roof line — reflecting a lamp
       that is not there, in the part of the pane you look through. Keep it
       tied to the geometry: if the coves move, this moves. */
    vec3 cove = vec3(1.000, 0.679, 0.434) * 2.66;
    c += cove * lineLobe(p, r, vec3(-1.28, 2.42, -5.19), vec3(-1.28, 2.42, -3.48), 0.085);
    c += cove * lineLobe(p, r, vec3( 1.28, 2.42, -5.19), vec3( 1.28, 2.42, -3.48), 0.085);
    /* The coaming strip, tucked under the glareshield lip and aimed down the
       panel. It never shines back into the canopy, but the canopy can see it.
       0xfff0da at 0.86, and it follows the shield's curve, so the segment sits
       on the mean of Interior.js's cLamp() rather than on its centre. */
    c += vec3(1.000, 0.871, 0.701) * 1.05
       * lineLobe(p, r, vec3(-1.19, 0.905, -6.44), vec3(1.19, 0.905, -6.44), 0.075);
    // the overhead console's cold forward lip, 0xf2f8ff at 1.85
    c += vec3(0.888, 0.940, 1.000) * 1.85
       * lineLobe(p, r, vec3(-0.62, 2.038, -6.230), vec3(0.62, 2.038, -6.230), 0.050);
    /* The main display cluster, on the fascia raked -0.60 rad about X. This is
       Interior.js's onPanel() frame: the one thing in the reflection with a
       shape rather than a length, and the reason the pane reads as a surface
       instead of as fog. */
    c += vec3(0.347, 0.631, 1.000) * 0.62
       * rectLobe(p, r, vec3(0.0, 0.838, -6.292),
                  vec3(1.0, 0.0, 0.0), vec3(0.0, 0.8253, -0.5646),
                  vec2(0.60, 0.235), 0.200);
  } else {
    // habitat coves, 0xffd7b0 at 2.57, and the corridor pair, 0xdcecf8 at 1.71
    vec3 cove = vec3(1.000, 0.679, 0.434) * 2.57;
    c += cove * lineLobe(p, r, vec3(-1.28, 2.378, 1.00), vec3(-1.28, 2.378, 6.80), 0.085);
    c += cove * lineLobe(p, r, vec3( 1.28, 2.378, 1.00), vec3( 1.28, 2.378, 6.80), 0.085);
    vec3 cool = vec3(0.740, 0.848, 0.955) * 1.71;
    c += cool * lineLobe(p, r, vec3(-0.713, 2.078, -3.10), vec3(-0.713, 2.078, 0.30), 0.075);
    c += cool * lineLobe(p, r, vec3( 0.713, 2.078, -3.10), vec3( 0.713, 2.078, 0.30), 0.075);
  }
  return c;
}
`;

/* ============================================================================
   The light loop, with the lights that contribute nothing skipped.

   This was the single largest cost in the game, and it hid behind a
   misdiagnosis: the cabin was read as draw-call bound, on the strength of a
   TIME_ELAPSED_EXT query that reported 46 ms against a 20 ms wall clock. It is
   not. Scale the render target and the frame scales with it — 5.72 Mpx cost
   20.3 ms, 1.43 Mpx cost 8.3 and 0.09 Mpx cost 3.5, so under three of those
   twenty milliseconds were CPU. A depth prepass over the whole cabin changed
   nothing, so it was not overdraw either.

   What it was: measured at 5.72 Mpx with everything else held still, hiding the
   cabin took the corridor frame from 20.2 ms to 3.6 ms, and *inside* the cabin,
   removing its point lights took it from 20.2 to 7.3 and the spots from 7.3 to
   5.1. Every other thing the interior shader does — nine triplanar textureGrad
   taps, the wear model, the bounce fill — comes to about 1.5 ms put together.
   The room is twenty-one point lights and nine shadowed spots, and three
   unrolls all thirty into every fragment of every surface.

   Unrolled means unconditional. `getPointLightInfo` already computes an
   attenuation that is *exactly* zero outside `light.distance` — the windowing
   term in `getDistanceAttenuation` is pow2(saturate(1 - pow4(d/cutoff))) — and
   sets `directLight.visible` from it; `getSpotLightInfo` does the same outside
   the cone. Then the chunk goes on to run a full GGX evaluation, and for a spot
   a five-tap PCF shadow lookup, against a light it has just proved black.

   The lamps in here have ranges of 1.5 to 7.5 m in a 15 m tube, so a typical
   fragment is inside four or five of the twenty-one. Skipping the rest is not
   an approximation: the term being skipped is zero. The branch is also about as
   coherent as a branch gets — which lamps reach a fragment is a function of
   where that fragment is, and a simdgroup is a handful of adjacent pixels.

   Derived from three's own chunk at load rather than transcribed, so a three
   upgrade cannot leave a stale copy of the light loop behind.
   ========================================================================== */
const LIGHTS_SKIP_DEAD = (() => {
  const guard = (src, marker) => {
    const i = src.indexOf(marker);
    if (i < 0) return src;
    const head = i + marker.length;
    /* The loop body ends at the last brace before the unroll pragma — which is
       the `for`'s own closing brace, since three's unroller matches up to it.
       Nesting a block inside is invisible to that regex. */
    const tail = src.indexOf('#pragma unroll_loop_end', head);
    if (tail < 0) return src;
    const body = src.slice(head, tail);
    const close = body.lastIndexOf('}');
    if (close < 0) return src;
    return src.slice(0, head) + '\n\t\tif ( directLight.visible ) {\n'
      + body.slice(0, close) + '\n\t\t}\n\t' + body.slice(close)
      + src.slice(tail);
  };
  let src = THREE.ShaderChunk.lights_fragment_begin;
  src = guard(src, 'getPointLightInfo( pointLight, geometryPosition, directLight );');
  src = guard(src, 'getSpotLightInfo( spotLight, geometryPosition, directLight );');
  return src;
})();

/**
 * Install the skip on one compiled shader. Called from every dressed material,
 * and from anything else in the cabin that is lit by these lamps.
 */
export function skipDeadLights(sh) {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <lights_fragment_begin>', LIGHTS_SKIP_DEAD);
  return sh;
}

/* ============================================================================
   Micro-surface: the centimetre scale, which nothing in this ship had.

   The baked plate tile is authored for a 2 m bulkhead and it is *correct* at
   2 m — the walls and the deck are the two things in here that never drew a
   complaint. Everything smaller is the same tile at the same 2 m projection,
   which means a 60 mm sidestick grip samples roughly one texel of it and comes
   back a single flat colour with a smooth shading gradient over it. Measured
   against the reference, the 90th percentile of 8x8 block standard deviation
   was 7.6 on a locker door and 18.8 on the stick, against 39.0 and 41.7 for
   the same objects in Starfield. That is the whole of the "N64 graphics"
   complaint, and it is a surfacing problem rather than a geometry one: the
   ship is 897,214 triangles and there is no faceting anywhere in it.

   So there is a second projection, an order of magnitude finer, carrying the
   things that live at one to five centimetres: the cast-and-blasted texture of
   painted alloy, drag scratches, impact dings, grime settled into the low
   spots and paint rubbed off the high ones.

   It is a *texture*, generated once at load, and not an analytic field — which
   is the one lesson this file already paid for. A procedural feature evaluated
   per fragment has no mip chain under it, MSAA resolves one shaded sample per
   pixel, and the result aliases at any distance where the feature falls under a
   pixel. Rasterising the same thing into 512x512 once and letting the hardware
   prefilter and anisotropically sample it costs nothing per frame and cannot
   alias: as the projection shrinks, every channel converges on its own mean,
   which is what a real surface seen from far away does.

   Generating it rather than baking it is deliberate. It is 340 kB of nothing —
   noise, line segments and dents — with no authored content in it at all, so a
   file would be a download of a pseudo-random number generator's output. What
   *is* authored is the scale, and that lives in the tile size.

   Packed: RG a tangent-space normal, B height (grime settles in the low
   ground), A exposure (scratches and rubbed-through peaks, where the paint has
   gone and the alloy shows).
   ========================================================================== */
function _mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _micro = null;
/**
 * The shared micro-surface map. Built on first use, which is the first call to
 * `makeInteriorMaterials`; about ten milliseconds, once.
 */
export function microTexture(S = 512) {
  if (_micro) return _micro;
  const rnd = _mulberry(0x5eed1a7e);
  const h = new Float32Array(S * S);

  /* Periodic value noise. Periodic because the tile has to meet itself on all
     four sides — the lattice index is taken modulo the octave, so the last cell
     interpolates back into the first. */
  const octave = (gn, amp) => {
    const g = new Float32Array(gn * gn);
    for (let i = 0; i < gn * gn; i++) g[i] = rnd();
    for (let y = 0; y < S; y++) {
      const fy = y * gn / S, iy = fy | 0, ty = fy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (iy % gn) * gn, r1 = ((iy + 1) % gn) * gn;
      for (let x = 0; x < S; x++) {
        const fx = x * gn / S, ix = fx | 0, tx = fx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = ix % gn, c1 = (ix + 1) % gn;
        const u = g[r0 + c0] + (g[r0 + c1] - g[r0 + c0]) * sx;
        const v = g[r1 + c0] + (g[r1 + c1] - g[r1 + c0]) * sx;
        h[y * S + x] += (u + (v - u) * sy) * amp;
      }
    }
  };
  /* 8 cells over a ~0.25 m tile is 3 cm; 192 is a millimetre and a bit.
     The spectrum used to be the usual 1/f ramp — 0.44 at 8 cells falling to
     0.03 at 192 — and two thirds of its energy therefore sat in features three
     to six centimetres across. That is the same band the *baked* plate albedo
     is made of, which is itself nothing but soft cloud noise at about a tenth
     of its 2 m tile, and the two stacked. Multiplying one slow blotch by
     another slow blotch does not read as surface, it reads as a smeared
     low-resolution texture — which is exactly the complaint. A real painted or
     blasted finish is nearly flat at 5 cm and carries almost all of its
     structure at one to three millimetres.
     So the energy is moved to the fine end. It costs nothing (same six
     octaves), it cannot alias because the map mips down to its own mean, and
     it is what gives a surface a *finish* instead of a fog. */
  octave(8, 0.15); octave(16, 0.17); octave(32, 0.20);
  octave(64, 0.21); octave(128, 0.16); octave(192, 0.11);

  /* Scratches. Drag marks, not hairlines: a few hundred short segments with a
     mild preference for one direction, because a panel gets wiped and slid
     against along its length far more often than across it. Tapered at both
     ends — a scratch that starts and stops with a step is a *step*, and steps
     are what the analytic model could never filter. */
  const wear = new Float32Array(S * S);
  const scratch = (n, lenMin, lenMax, depth, widMax) => {
    for (let k = 0; k < n; k++) {
      const ang = rnd() < 0.58 ? (rnd() - 0.5) * 0.55 : rnd() * Math.PI;
      const len = lenMin + (lenMax - lenMin) * rnd() * rnd();
      const x0 = rnd() * S, y0 = rnd() * S;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const dep = depth * (0.35 + 0.65 * rnd());
      const wid = 0.55 + rnd() * widMax;
      const steps = Math.max(2, Math.ceil(len));
      const r = Math.ceil(wid) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const taper = Math.min(1, Math.sin(Math.PI * t) * 2.6);
        const px = x0 + dx * len * t, py = y0 + dy * len * t;
        for (let oy = -r; oy <= r; oy++) {
          const yi = ((((py + oy) | 0) % S) + S) % S;
          for (let ox = -r; ox <= r; ox++) {
            const d = Math.sqrt(ox * ox + oy * oy);
            if (d > wid + 1) continue;
            const w = 1 - d / (wid + 1);
            const xi = ((((px + ox) | 0) % S) + S) % S;
            const i = yi * S + xi;
            const v = dep * taper * w * w;
            if (v > wear[i]) wear[i] = v;
          }
        }
      }
    }
  };
  /* Counts halved from 250/16/120. Two hundred and fifty scratches in a 26 cm
     square is one every 4 mm, which is not a scuffed panel, it is a carpet —
     and a carpet has the same effect as no marks at all, because nothing in it
     is a *mark*. The shader concentrates what is left into patches (see iPatch)
     so a bulkhead is mostly clean paint with worn places in it, which is what
     the reference frames actually show. */
  scratch(110, 4, 32, 1.0, 0.85);     // the everyday scuff
  scratch(10, 34, 130, 0.75, 1.2);    // the occasional long drag

  // Impact dings: a crewed volume is full of things that get dropped.
  for (let k = 0; k < 58; k++) {
    const cx = rnd() * S, cy = rnd() * S;
    const rad = 1.6 + rnd() * rnd() * 9.0, dep = 0.20 + rnd() * 0.55;
    const r = Math.ceil(rad) + 1;
    for (let oy = -r; oy <= r; oy++) {
      const yi = ((((cy + oy) | 0) % S) + S) % S;
      for (let ox = -r; ox <= r; ox++) {
        const d = Math.sqrt(ox * ox + oy * oy) / rad;
        if (d > 1) continue;
        const i = yi * S + ((((cx + ox) | 0) % S) + S) % S;
        h[i] -= dep * (1 - d * d) * 0.32;
      }
    }
  }

  // Cut the scratches into the height field, then normalise what is left.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < S * S; i++) {
    h[i] -= wear[i] * 0.19;
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  const inv = 1 / Math.max(hi - lo, 1e-6);
  for (let i = 0; i < S * S; i++) h[i] = (h[i] - lo) * inv;

  /* Normal by central difference on the wrapped height field. The scale is in
     texels, so it is a slope. It was 2.6 against a spectrum whose steepest
     wall was a 3 cm dune; against the fine spectrum above, the same number
     puts a 1.5 mm grain at roughly forty degrees and turns every painted
     surface in the ship into sandpaper — and a strong normal at three pixels
     per period is also the one thing here that *can* still sparkle, because
     mipping a normal map loses the roughness it averages away. 1.4 keeps the
     grain as a break in the specular lobe rather than as relief; the value
     read of the same map goes through roughness instead, which mips honestly. */
  const data = new Uint8Array(S * S * 4);
  const K = 1.4;
  for (let y = 0; y < S; y++) {
    const yn = ((y - 1) + S) % S, yp = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const xn = ((x - 1) + S) % S, xp = (x + 1) % S;
      const i = y * S + x;
      const gx = (h[y * S + xp] - h[y * S + xn]) * K;
      const gy = (h[yp * S + x] - h[yn * S + x]) * K;
      const l = Math.sqrt(gx * gx + gy * gy + 1);
      const o = i * 4;
      data[o] = Math.round((-gx / l * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-gy / l * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(h[i] * 255);
      /* Exposure: where the paint is gone. Scratches, plus the crowns of the
         relief — a surface wears from its high points down, which is the whole
         reason "bare metal at the wear edges" reads as wear at all. */
      const crown = Math.max(0, (h[i] - 0.70) / 0.30);
      data[o + 3] = Math.round(Math.min(1, wear[i] * 1.15 + crown * crown * 0.85) * 255);
    }
  }

  _micro = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  _micro.wrapS = _micro.wrapT = THREE.RepeatWrapping;
  _micro.minFilter = THREE.LinearMipmapLinearFilter;
  _micro.magFilter = THREE.LinearFilter;
  _micro.generateMipmaps = true;
  _micro.anisotropy = 8;
  _micro.colorSpace = THREE.NoColorSpace;
  _micro.needsUpdate = true;
  return _micro;
}

const SURFACE_PARS = /* glsl */`
  varying vec3 vLocalPos;
  varying vec3 vLocalNrm;
  uniform sampler2D tAlb;
  uniform sampler2D tNrm;
  uniform sampler2D tOrm;
  uniform sampler2D tMicro;
  uniform float uTile;      // reciprocal of the tile size in metres
  uniform float uMicro;     // reciprocal of the micro tile in metres
  uniform float uFill;      // shared trim on the bounce fill
  uniform float uSpecOcc;   // shared trim on the specular occlusion
  uniform float uShape;     // shared trim on the shaping of the flat ambient

  /* Triplanar weights, sharpened hard.
     The cabin is a rounded-rectangle tube: the flats are axis-aligned and only
     the corner fillets need blending at all, so the blend band is worth
     keeping narrow. Four squarings puts it inside a few degrees of the
     diagonal, which is where the fillet is anyway. */
  vec3 iWeights(vec3 n){
    vec3 w = max(abs(n) - 0.22, vec3(0.0));
    w *= w; w *= w;
    return w / max(w.x + w.y + w.z, 1e-5);
  }

  float iStep(float x, float e, float w){ return smoothstep(e-w, e+w, x); }
  float iBand(float x, float a, float b, float w){
    return clamp(iStep(x,a,w) - iStep(x,b,w), 0.0, 1.0);
  }

  /* Per-cell dihedral shuffle of the tiling projection.

     A 2 m tile repeating across a wall puts the same stencil, the same
     inspection placard and the same hatch roundel down in a grid, and an art
     review counted the same circle-and-dot motif four times at identical
     scale in one frame. Rotating and mirroring each cell by a hash of its
     index breaks that without a second texture: the tile's border is a plate
     seam on all four sides, so any of the eight transforms still meets its
     neighbour at a seam.

     It has to be sampled with textureGrad. The transform is discontinuous at
     the cell boundary, so implicit derivatives there are garbage and the
     hardware picks the smallest mip for one pixel — a bright crawling line
     along every cell edge. The transform is rigid, so the correct gradients
     are just the original ones put through the same rotation.

     And the lattice has to be *offset*. floor(uv) puts a cell boundary at
     every integer, which for the Z projection means one at x = 0 — the ship's
     own centreline, the plane the whole cabin is built symmetric about and the
     one place the eye is guaranteed to be looking. Two neighbouring cells draw
     different plates at different tones, so what that produced was a hard
     vertical seam straight down the middle of the centre pedestal, splitting
     the tactical hologram in half, and a matching one down the overhead
     console in the forward view. The offset is per-axis and deliberately not a
     simple fraction of any tile size in the ship, so no boundary lands on the
     centreline, the deck plane, or a bulkhead. */
  const vec2 CELL_OFF = vec2(0.373, 0.229);

  mat2 iCellRot(float h, out float mir){
    float r = floor(h * 4.0);
    mir = step(0.5, fract(h * 7.31)) * 2.0 - 1.0;
    mat2 m = mat2(1.0, 0.0, 0.0, 1.0);
    if (r > 2.5)      m = mat2( 0.0, 1.0, -1.0, 0.0);
    else if (r > 1.5) m = mat2(-1.0, 0.0,  0.0,-1.0);
    else if (r > 0.5) m = mat2( 0.0,-1.0,  1.0, 0.0);
    m[0][0] *= mir; m[0][1] *= mir;
    return m;
  }
  vec4 iCellTex(sampler2D t, vec2 uv, vec2 ddx, vec2 ddy){
    vec2 p = uv + CELL_OFF;
    vec2 c = floor(p);
    float h = fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453);
    float mir;
    mat2 m = iCellRot(h, mir);
    vec2 f = m * (p - c - 0.5) + 0.5;
    return textureGrad(t, c + f, m * ddx, m * ddy);
  }

  vec3 iCellNrm(sampler2D t, vec2 uv, vec2 ddx, vec2 ddy){
    vec2 p = uv + CELL_OFF;
    vec2 c = floor(p);
    float h = fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453);
    float mir;
    mat2 m = iCellRot(h, mir);
    vec2 f = m * (p - c - 0.5) + 0.5;
    vec3 n = textureGrad(t, c + f, m * ddx, m * ddy).xyz * 2.0 - 1.0;
    // inverse-rotate the tangent-space direction back into cell space
    vec2 xy = transpose(m) * n.xy;
    return vec3(xy, n.z);
  }

  /* A slow, cheap blotch. The old model spent three nine-octave value-noise
     fbms per fragment on this; everything they were doing at high frequency is
     in the baked maps now, and all that is still wanted is a large-scale mask
     that decorrelates the wear terms from one another. Two sines cost about
     four instructions and are indistinguishable at this scale. */
  float iBlot(vec3 p){
    return clamp(0.5
      + 0.26*sin(p.x*1.73 + p.z*0.91 + 1.7)
      + 0.24*sin(p.y*2.11 - p.z*1.37 + 0.4), 0.0, 1.0);
  }

  /* Where the wear is, as opposed to how much of it there is.

     The micro map was applied everywhere at one strength, and the review of
     that is the whole reason this function exists: "the ship interior is a big
     soup of textures", "everything looks the same", "the textures are all
     messy". Detail spread evenly over every surface is worth exactly as much
     as no detail, because what the eye reads is *contrast between* a clean
     area and a marked one. A painted panel in any of the reference frames is
     mostly flat paint; the scuffs are in patches, along the edges, and where
     hands and boots and stowed cases actually reach.

     So this is a decisive mask rather than a gradient: three sines at
     twenty-five to seventy centimetres, put through a smoothstep tight enough
     that roughly a third of the area is inside it and the rest is genuinely
     clean. It is deliberately *not* iBlot — that one is a slow metre-scale
     decorrelator shared by half a dozen terms, and reusing it here would make
     the wear agree with the grime and the dust, which is precisely how six
     independent modulations collapse back into one blotch. */
  float iPatch(vec3 p){
    float v = 0.5
      + 0.30*sin(p.x*2.37 - p.y*1.61 + 2.6)
      + 0.27*sin(p.z*3.11 + p.y*0.83 - 1.1)
      + 0.17*sin(p.x*5.73 + p.z*4.19 + 0.3);
    return smoothstep(0.44, 0.80, v);
  }
`;

/**
 * Dress a MeshStandardMaterial so it samples the baked interior maps.
 *
 * @param {THREE.MeshStandardMaterial} mat
 * @param {{tex?:object, set?:'panel'|'deck', tile?:number, detail?:number,
 *          wear?:number, grime?:number, bump?:number, bare?:number,
 *          roughLo?:number, roughHi?:number, sheenKill?:number,
 *          lane?:number, hands?:number, kick?:number, dust?:number,
 *          bounce?:number, edgeTint?:number[], key?:string}} o
 */
export function dressInterior(mat, o = {}) {
  const set = o.set || 'panel';
  const tile = o.tile ?? (set === 'deck' ? 1.5 : set === 'soft' ? 0.5 : 2.0);
  const detail = (o.detail ?? 1.0).toFixed(3);
  const wear = (o.wear ?? 0.6).toFixed(3);
  const grime = (o.grime ?? 0.6).toFixed(3);
  const bump = (o.bump ?? 1.0).toFixed(3);
  const bare = (o.bare ?? 0.5).toFixed(3);
  const dust = (o.dust ?? 0.4).toFixed(3);
  const kick = (o.kick ?? 1.0).toFixed(3);
  const lane = (o.lane ?? 0.0).toFixed(3);
  const hands = (o.hands ?? 0.0).toFixed(3);
  /* How much of the micro wear a *clean* area of this material keeps — the
     floor under `si_mark`, which otherwise confines scratches, exposed alloy
     and dust to the patch mask and the three motivated wear zones.
     A painted bulkhead is genuinely mostly clean and wants the default. A grab
     rail is not: the whole point of the rail material is that it is anodised
     alloy rubbed bright by hands, and hands do not restrict themselves to a
     third of it. Deck plate is walked on everywhere, not only down the lane.
     So this is per material rather than a constant, and the difference between
     "a painted panel with worn places in it" and "a handle" is exactly what
     the owner meant by hierarchy. */
  const markFloor = (o.markFloor ?? 0.16).toFixed(3);
  const sheenKill = (o.sheenKill ?? 0.5).toFixed(3);
  const bounce = (o.bounce ?? 1.0).toFixed(3);
  const et = o.edgeTint || [0.66, 0.68, 0.71];
  const edgeTint = `vec3(${et.map((v) => v.toFixed(3)).join(',')})`;
  /* The micro layer. `micro` is the master, 0 removes the three taps from the
     compiled shader entirely; `microTile` is the projection in metres and is
     the one number that decides what scale the eye reads the surface at. */
  const micro = o.micro ?? 1.0;
  const microTile = o.microTile ?? 0.26;
  const mBump = (micro * (o.microBump ?? 1.0)).toFixed(3);
  const mGrime = (micro * (o.microGrime ?? 1.0)).toFixed(3);
  const mWear = (micro * (o.microWear ?? 1.0)).toFixed(3);
  const mRough = (micro * (o.microRough ?? 1.0)).toFixed(3);

  const base = mat.roughness ?? 0.85;
  const RLO = (o.roughLo ?? Math.max(0.05, base - 0.22)).toFixed(3);
  const RHI = (o.roughHi ?? Math.min(1.0, base + 0.12)).toFixed(3);

  const tex = o.tex || {};
  const A = tex[set + 'Alb'] || tex.panelAlb;
  const N = tex[set + 'Nrm'] || tex.panelNrm;
  const O = tex[set + 'Orm'] || tex.panelOrm;

  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFill = INTERIOR_FILL;
    sh.uniforms.uSpecOcc = INTERIOR_SPEC_OCC;
    sh.uniforms.uShape = INTERIOR_SHAPE;
    sh.uniforms.tAlb = { value: A || null };
    sh.uniforms.tNrm = { value: N || null };
    sh.uniforms.tOrm = { value: O || null };
    sh.uniforms.tMicro = { value: micro > 0 ? microTexture() : null };
    sh.uniforms.uTile = { value: 1 / tile };
    sh.uniforms.uMicro = { value: 1 / microTile };

    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocalPos;\nvarying vec3 vLocalNrm;')
      /* Cabin space, not object space.
         Only the meshes that mergeStatic welds together end up with their
         vertices already in cabin coordinates; everything that lives inside a
         Group — the seat, the whole dashboard, the nav table, the lockers, the
         crates — keeps its own centred local frame. Running the projection in
         object space put a fresh symmetric tile inside every single box. The
         interior root and its rig are both identity, so the model matrix alone
         puts every mesh, merged or not, into one continuous coordinate system,
         and the plating runs across the joins between them. */
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvLocalPos = (modelMatrix * vec4(position, 1.0)).xyz;\n'
        + 'vLocalNrm = mat3(modelMatrix) * normal;');

    skipDeadLights(sh);

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SURFACE_PARS)

      /* ---- one triplanar evaluation, shared by every channel below.
         Declared at main() scope on purpose: three injects the roughness,
         metalness and normal chunks further down the same function, and each
         of them would otherwise re-fetch all nine taps. */
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        vec3  si_P = vLocalPos;
        vec3  si_N = normalize(vLocalNrm);
        vec3  si_w = iWeights(si_N);
        vec3  si_s = sign(si_N + 1e-6);
        vec2  si_uX = vec2(si_P.z, si_P.y) * uTile;
        vec2  si_uY = vec2(si_P.x, si_P.z) * uTile;
        vec2  si_uZ = vec2(si_P.x, si_P.y) * uTile;

        vec2 si_dXx = dFdx(si_uX), si_dXy = dFdy(si_uX);
        vec2 si_dYx = dFdx(si_uY), si_dYy = dFdy(si_uY);
        vec2 si_dZx = dFdx(si_uZ), si_dZy = dFdy(si_uZ);
        vec3 si_alb = iCellTex(tAlb, si_uX, si_dXx, si_dXy).rgb * si_w.x
                    + iCellTex(tAlb, si_uY, si_dYx, si_dYy).rgb * si_w.y
                    + iCellTex(tAlb, si_uZ, si_dZx, si_dZy).rgb * si_w.z;
        vec3 si_orm = iCellTex(tOrm, si_uX, si_dXx, si_dXy).rgb * si_w.x
                    + iCellTex(tOrm, si_uY, si_dYx, si_dYy).rgb * si_w.y
                    + iCellTex(tOrm, si_uZ, si_dZx, si_dZy).rgb * si_w.z;

${micro > 0 ? /* glsl */`
        /* ---- the micro projection, an order of magnitude finer.
           Plain texture2D and not textureGrad: unlike the plate tile there is
           no per-cell transform here, so the implicit derivatives are the
           correct ones and cost nothing. No dihedral shuffle either — the
           shuffle exists to stop a *placard* repeating in a grid, and this map
           has no feature in it large enough to recognise twice.
           .b is height, .a is where the paint has gone. */
        vec4 mcX = texture2D(tMicro, vec2(si_P.z, si_P.y) * uMicro);
        vec4 mcY = texture2D(tMicro, vec2(si_P.x, si_P.z) * uMicro);
        vec4 mcZ = texture2D(tMicro, vec2(si_P.x, si_P.y) * uMicro);
        vec4 si_mic = mcX * si_w.x + mcY * si_w.y + mcZ * si_w.z;
        /* World-space perturbation, built the same way the plate normal is:
           for the X plane the map's (s,t) are world (z,y), for Y (x,z), for Z
           (x,y). Only the tangential part is wanted — the normal component of a
           flat map is exactly what the geometric normal already is — so the
           subtraction the plate map does explicitly is done here by simply not
           writing the third component. */
        vec3 si_mn = vec3(0.0, mcX.y * 2.0 - 1.0, mcX.x * 2.0 - 1.0) * si_w.x
                   + vec3(mcY.x * 2.0 - 1.0, 0.0, mcY.y * 2.0 - 1.0) * si_w.y
                   + vec3(mcZ.x * 2.0 - 1.0, mcZ.y * 2.0 - 1.0, 0.0) * si_w.z;
` : /* glsl */`
        vec4 si_mic = vec4(0.5, 0.5, 0.5, 0.0);
        vec3 si_mn = vec3(0.0);
`}

        /* Grazing incidence, and it earns its two instructions.
           GGX keeps a mirror lobe alive at glancing angles on surfaces that in
           life have none, and this cabin is a tube you spend the whole game
           looking down the length of: most of the wall area in any frame is
           seen at seventy degrees or worse. abs(), because the hull shells are
           double-sided and the normal here is the one that faces out. */
        vec3  si_V  = normalize(cameraPosition - si_P);
        float si_gz = 1.0 - abs(dot(si_N, si_V));
        si_gz *= si_gz; si_gz *= si_gz;

        float si_up   = clamp(si_N.y, 0.0, 1.0);
        float si_vert = 1.0 - abs(si_N.y);
        float si_blot = iBlot(si_P);
        float si_wear = clamp((1.0 - si_orm.g) * 1.6, 0.0, 1.0) * (0.35 + si_blot*0.9);
        float si_lane = ${lane} > 0.0
          ? (1.0 - smoothstep(0.30, 0.95, abs(si_P.x))) * si_up * (0.4 + si_blot*0.7) * ${lane}
          : 0.0;
        float si_hand = ${hands} > 0.0
          ? si_vert * iBand(si_P.y, 0.84, 1.44, 0.20) * (0.35 + si_blot*0.85) * ${hands}
          : 0.0;
        /* Kick scuffs. The bottom half-metre of every vertical face in a
           crewed vehicle is walked into, and it is bare alloy long before
           anything else is. Hoisted out of the albedo block because it is one
           of the three places wear is *motivated*, and the micro layer below
           is now concentrated into those places rather than spread evenly. */
        float si_kick = (1.0 - smoothstep(0.06, 0.62, si_P.y)) * si_vert * ${kick};
        /* Where the surface is allowed to be marked at all. A third of the
           area from the patch mask, plus every place a human being physically
           touches this ship. Outside it a panel keeps a sixth of the micro
           wear, which is enough to stop the clean areas reading as vinyl and
           nowhere near enough to compete with the marked ones. */
        float si_touch = clamp(iPatch(si_P)*0.80 + si_kick*1.30
                             + si_hand*1.15 + si_lane*1.05, 0.0, 1.0);
        float si_mark  = ${markFloor} + (1.0 - ${markFloor})*si_touch;

        {
          diffuseColor.rgb *= mix(vec3(1.0), si_alb, ${detail});
          // A touch of the baked cavity on top of what is already in the
          // albedo: the seams want to read as holes, not as printed lines.
          diffuseColor.rgb *= mix(1.0, si_orm.r, 0.30);

          /* Grime. Deepens toward the deck, which is where a crewed volume
             actually collects it.
             The gradient used to run from the deck to 2.35 m — the whole
             height of the room — with a 0.28 floor under it, so *everything*
             in here was 30-90% dirty and the term was a second slow blotch
             laid over the whole ship rather than a floor gradient. It now
             dies out at 1.3 m, above which a bulkhead is simply paint. */
          float low  = 1.0 - smoothstep(0.0, 1.30, si_P.y);
          float dirt = clamp((0.10 + low*0.92) * si_blot * ${grime}, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb,
                                 diffuseColor.rgb*vec3(0.60,0.56,0.50),
                                 clamp(dirt*0.36, 0.0, 0.36));

          float kick = si_kick;
          diffuseColor.rgb = mix(diffuseColor.rgb, ${edgeTint}*0.70,
                                 clamp(kick*(0.20 + si_blot*0.85)*${wear}*0.45, 0.0, 0.38));

          // dust only settles on surfaces that face up
          diffuseColor.rgb = mix(diffuseColor.rgb,
                                 diffuseColor.rgb*vec3(1.10,1.06,0.99) + 0.012,
                                 si_up*${dust}*si_blot*0.5);
          // the lane down the deck, scrubbed back toward bare alloy
          diffuseColor.rgb = mix(diffuseColor.rgb, ${edgeTint}*0.82,
                                 clamp(si_lane*0.26, 0.0, 0.26));
          // and the greasy shadow round anything held
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(0.76,0.73,0.68),
                                 clamp(si_hand*0.40, 0.0, 0.40));

          /* ---- and the centimetre scale on top of all of it.
             Both terms are written so that the *mean* of the map leaves the
             colour where it was — si_mic.b averages 0.5, and 0.93 + 0.14*0.5
             is 1.0. That matters more than it looks: the map filters down to
             its own mean as the projection shrinks, so a modulation centred
             anywhere else would quietly shift the albedo of the whole ship
             with distance.

             The swing was 0.55 + 0.90*b, which is plus or minus forty-five per
             cent of the albedo — a bigger value modulation than the *lighting*
             puts across most of a bulkhead. That one line was measured to be
             most of the "big soup of textures": with the plate albedo switched
             off entirely, so no seam, fastener or placard was drawn at all, the
             bulkhead still came back covered in a one-to-two centimetre grey
             mottle, and that mottle was this. Seven per cent is a finish;
             forty-five is camouflage.

             What the map should be carrying at this scale is *roughness*,
             which is below. Roughness variation breaks the specular lobe —
             which is what makes painted alloy read as painted alloy — without
             putting a second cloud into the value, and it mips honestly. */
          diffuseColor.rgb *= mix(1.0, 0.93 + 0.14*si_mic.b, ${mGrime}*0.92);
          // grime is not a neutral darkening; it is warm-grey dust in a recess,
          // and only where the surface is dirty in the first place
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(0.78,0.75,0.70),
                                 clamp((1.0-si_mic.b)*si_mark*${mGrime}*0.26, 0.0, 0.26));
          /* Paint gone: scratches and the crowns of the relief. This is the
             art direction's "bare metal only at wear edges" at the scale it
             actually happens at, and it is most of what separates a painted
             surface from a moulded one at 45 cm.

             The colour it goes to is *relative to the paint*, and that is the
             correction to the first version of this. edgeTint is a raw vec3
             literal near 0.7 — which is linear, not sRGB — while a panel
             painted 0x847c6c sits at 0.23 linear. Mixing the two put every
             scratch three times brighter than the wall it was cut into, and at
             1:1 the bulkhead came back covered in pale straws lying on top of
             it rather than in marks cut into it. Bare alloy under paint is
             lighter and greyer than the paint by something like half a stop,
             not by seven. */
          vec3 si_bare = mix(diffuseColor.rgb * 1.85, ${edgeTint} * 0.30, 0.45);
          diffuseColor.rgb = mix(diffuseColor.rgb, si_bare,
                                 clamp(si_mic.a*si_mark*${mWear}*${wear}*0.46, 0.0, 0.46));
        }
      `)

      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        {
          // The baked band is roughly 0.5-1.0; remap it into this material's own.
          float t = clamp((si_orm.g - 0.50) * 2.0, 0.0, 1.0);
          roughnessFactor = mix(${RLO}, ${RHI}, t);
          // The three reasons a real surface is allowed under its own floor:
          // something rubs it, boots walk it, hands hold it.
          roughnessFactor -= si_wear*0.06 + si_lane*0.16 + si_hand*0.18;
          /* Micro-roughness, and this is the term that stops a small metal
             part reading as chrome. A wide specular lobe on a knob is not a
             roughness *value* problem — 0.44 is already matte by any number —
             it is that the value is the same across the whole part, so the lobe
             is smooth and unbroken. Breaking it at the millimetre scale is what
             "matte and mineral" physically is. Recesses hold dust and are
             rougher; scratches and rubbed crowns are barer and take a little
             off. Centred so the mean of the map is a no-op. */
          roughnessFactor += (0.5 - si_mic.b) * ${mRough} * 0.44;
          roughnessFactor -= si_mic.a * si_mark * ${mRough} * 0.16;
          // Grazing incidence, answered. Matte paint does not turn to glass at
          // seventy degrees; GGX does, and the whole length of this hull is
          // seen at seventy degrees.
          roughnessFactor = mix(roughnessFactor, 1.0, si_gz*${sheenKill});
          /* A hard floor at the art direction's own number rather than at
             0.06. Nothing in this ship is polished: the floor exists so that
             the three subtractions above cannot stack a painted panel down into
             glass, which they could, and which is the read the review called
             "broad specular highlights on chrome knobs". */
          roughnessFactor = clamp(roughnessFactor, 0.35, 1.0);
        }
      `)
      /* ---- grazing Fresnel, damped by roughness.
         Measured before assuming: switching the cabin's environment off
         entirely (environmentIntensity 0.10 -> 0) moved the seat-shell crop's
         mean by 1.9 levels out of 255 and its peak highlight not at all —
         255,255,248 either way. So the "everything is faintly shiny and it
         looks fake" read in here is *not* reflection strength, and specular
         occlusion on the indirect term alone could never have fixed it. It is
         the Fresnel.
         three sets material.specularF90 to exactly 1.0 for every dielectric,
         so a chalky painted panel returns *all* of the incident light at
         grazing incidence regardless of how rough it is — which draws a pale
         shroud round every silhouette in the room and is the same defect the
         exterior's MATTE_HOOK was fixed for. Physically a rough surface does
         not: the microfacets shadow each other and the grazing response falls
         well short of white. Filament derives F90 from F0 rather than
         assuming it, which for a 4% dielectric lands near 0.66.
         Scaled back to 1.0 with metalness, so the worn bare-alloy edges the
         wear model exposes keep their hard rim — that rim is the art
         direction's, and it is the one place a hard highlight belongs. */
      .replace('#include <lights_physical_fragment>', /* glsl */`
        #include <lights_physical_fragment>
        material.specularF90 = mix(
          mix(material.specularF90, 0.62, smoothstep(0.30, 0.78, material.roughness)),
          material.specularF90, metalnessFactor);
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        #include <metalnessmap_fragment>
        /* Bare alloy only where the bake says the paint has actually gone. A
           metal surface has no diffuse term at all, so anything driven metal
           by mistake returns a reflection of the room probe and nothing else —
           which is most of what "mirror-like" was. */
        metalnessFactor = clamp(metalnessFactor + si_orm.b*${bare}
                                + si_mic.a*si_mark*${mWear}*${bare}*0.45, 0.0, 1.0);
      `)

      /* ---- relief, from the baked normal map.
         No UV attribute and no tangent attribute exists on most of this
         geometry, so the tangent frame is the projection's own: for the X
         plane the map's (s,t,n) are world (z,y,x), for Y they are (x,z,y), for
         Z they are (x,y,z). Blending the three and subtracting what a *flat*
         map would have produced leaves a pure world-space perturbation, which
         can then be added to the real geometric normal — so the fillets round
         the corners of the tube stay curved instead of being snapped to the
         nearest axis. */
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
        {
          /* The normal has to be rotated by the same transform its cell was:
             a tangent-space normal carries a direction, so shuffling the cell
             without turning the vector lights every rotated plate from the
             wrong side. */
          vec3 tX = iCellNrm(tNrm, si_uX, si_dXx, si_dXy);
          vec3 tY = iCellNrm(tNrm, si_uY, si_dYx, si_dYy);
          vec3 tZ = iCellNrm(tNrm, si_uZ, si_dZx, si_dZy);
          vec3 nX = vec3(tX.z*si_s.x, tX.y, tX.x);
          vec3 nY = vec3(tY.x, tY.z*si_s.y, tY.y);
          vec3 nZ = vec3(tZ.x, tZ.y, tZ.z*si_s.z);
          vec3 blended = nX*si_w.x + nY*si_w.y + nZ*si_w.z;
          vec3 flat_   = vec3(si_s.x*si_w.x, si_s.y*si_w.y, si_s.z*si_w.z);
          /* Plate relief and micro relief added as two independent
             perturbations of the same geometric normal, which is what they
             physically are: the cast texture of the paint does not know where
             the panel seams are. */
          vec3 wN = normalize(si_N + (blended - flat_) * ${bump}
                                   + si_mn * ${mBump} * 0.55);
          normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
        }
      `)

      /* ---- bounce, and only into the shadows.
         "Shadows are never black" is the first line of the art direction and
         the cabin was not obeying it: measured across the interior set, every
         frame had 0.000% of its pixels clipping and up to 19.3% of them at
         pure black, against a reference whose *dark* ship interior has the
         same mean with 0.0% black and a 1st percentile of 13. A room with no
         floor to its histogram does not read as moody, it reads as unfinished
         geometry, and no amount of extra lamp fixes it because the places that
         are black are unreachable by a lamp by construction.

         What fills them in life is bounce, and bounce has a direction: warm off
         the painted deck and the amber footwell flood onto everything facing
         down and everything low, cold off the pale ceiling and the coves onto
         everything facing up, and — in the cockpit only — planetshine and
         nebula through the canopy, which is the complement of the key and is
         what the art direction says a shadow here is filled by.

         Gated on how much *direct* light the fragment already got, so it lifts
         the floor of the histogram and leaves the lit two-thirds of the frame
         alone: that is the difference between a fill and a flat ambient, and a
         flat ambient is what makes a room look like a render.

         Injected after the occlusion chunk on purpose, with its own softened
         copy of the cavity term. Real bounce does reach into a crease — less
         than open light does, which is the mix() — and running it through the
         full baked AO would take it back out of exactly the pixels it exists
         for. */
      /* ---- specular occlusion, and it is the single largest remaining cause
         of the "everything is faintly shiny and it looks fake" read.

         Every surface in the cabin samples an environment for its specular
         response, and until now *nothing told a crevice it cannot see the
         room*. The inside of a louvre, the gap behind a grab handle, the well
         under a fastener and an open panel face pointing at the ceiling all
         returned the same reflected environment and the same specular lobe.
         Diffuse occlusion does not substitute and cannot: darkening the
         diffuse term while the specular keeps glowing on top of it is exactly
         what produces a uniform sheen laid over an object regardless of shape,
         which is the CG-plastic signature.

         Two terms, and they are different things.

         *Occlusion* is how much of the environment the point can see, and it is
         the baked plate cavity times the micro relief — a scratch and a rivet
         well are both places light does not reach. It feeds three's own
         computeSpecularOcclusion, which is the standard
         saturate(pow(NoV + ao, exp2(-16r - 1)) - 1 + ao): a rough surface is
         occluded about as much as its diffuse is, a smooth one much less
         (a mirror in a slot still shows you the slot), and a grazing view less
         again.

         *Cavity* is micro-shadowing of the direct lights, which the cabin's
         thirty lamps produce almost all of the specular in this room from. No
         shadow map resolves a two-millimetre scratch, so the only thing that
         can shade one is the surface model. It is applied at three quarters,
         because a cavity term is a statistical stand-in for geometry and
         taking it to one flattens a lit surface into its own bump map.

         Sits after three's aomap chunk on purpose: that chunk already does the
         same thing from the aoMap for the twelve kit materials that carry one,
         and the two compose correctly. */
      .replace('#include <aomap_fragment>', /* glsl */`
        #include <aomap_fragment>
        float si_cav = clamp(si_orm.r * mix(1.0, 0.45 + 1.10 * si_mic.b, ${mRough}),
                             0.0, 1.0);
        {
          float si_nv = clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0);
          float si_so = mix(1.0,
            computeSpecularOcclusion(si_nv, si_cav, material.roughness), uSpecOcc);
          reflectedLight.indirectSpecular *= si_so;
          reflectedLight.directSpecular *= mix(1.0, si_so, 0.75);
        }
        /* ---- the ambient, shaped.
           An AmbientLight is a constant added to every fragment in the room
           regardless of which way it faces, what is in front of it or how deep
           into a corner it sits, and a HemisphereLight is the same thing with a
           single cosine on it. Between them the cabin carries 0.8 of flat
           irradiance, and that — not the lamps, and not the bounce fill — is
           the largest single reason the owner's read is "everything looks
           uniformly lit and bright, hardly any shadows, feels really fake".
           A constant cannot describe shadow. It is the definition of no shadow.

           It cannot simply be turned down, because auto-exposure undoes any
           change to the frame's overall level within a second — measured:
           setting both lights to zero moved the corridor's median by four
           levels out of 255. What survives normalisation is *shape*, so that
           is what this does, and it leaves the total roughly where it was:

             · cavity, so a crease, a seam and a fastener well see less of the
               room than an open face does — the one thing a flat ambient is
               most obviously wrong about. It composes with three's own aomap
               chunk immediately above, which does the same job at corner scale
               for the twelve kit materials that carry a baked atlas, and with
               the screen-space pass in PostFX, which does it at room scale;
               this is the millimetre-to-centimetre term neither of those can
               resolve. Applied at 0.72 rather than 1 because it is a
               statistical stand-in for geometry and taking it to one turns a
               lit surface into its own bump map.
             · a hemisphere weighting steeper than three's own, because the
               light in this ship is in the ceiling coves and there is a
               painted deck under it, not a sky. A face pointing at the deck
               keeps a third; one pointing at the coves keeps all of it.

           Normalised so an open, upward-facing, uncreased surface is unchanged
           and everything else falls away from it — so it costs no exposure. It
           is a light probe with two terms in it rather than none, which is the
           cheapest honest thing short of baking irradiance volumes into the
           ship, and about twelve ALU with no new texture fetch. */
        {
          float si_hemi = 0.34 + 0.66 * clamp(si_N.y * 0.62 + 0.38, 0.0, 1.0);
          float si_open = mix(1.0, si_cav, 0.72);
          reflectedLight.indirectDiffuse *= mix(1.0, si_hemi * si_open, uShape);
        }
        {
          float si_lit = dot(reflectedLight.directDiffuse, vec3(0.3333));
          /* Steepened from 11. The gate decides how much *direct* light a
             fragment has to have before the bounce stops arriving, and at 11 a
             surface at a third of full key still collected two thirds of it —
             so the fill was not filling shadows, it was raising the whole
             room. At 20 it is confined to pixels that are genuinely unlit,
             which is what the term was built for. */
          float si_fill = exp(-si_lit * 20.0);
          float si_low = 1.0 - smoothstep(0.10, 2.30, si_P.y);
          /* These three were (0.720,0.429,0.219), (0.309,0.363,0.449) and
             (0.207,0.297,0.456), and between them they were most of a measured
             colour problem: the fill lands in the *shadows*, which is most of
             the area of any frame in here, so its hue is the room's hue. The
             cockpit put 77% of its chromatic energy into two adjacent ten-degree
             bins at 200-210 — which is precisely the hue of the second and third
             of those — at a mean saturation of 0.47 against 0.19-0.24 for the
             reference. It read as a colour-graded screenshot rather than as lit
             materials, and walking aft was a 180-degree hue jump.
             They keep their direction, at 58% of the chroma. The art direction
             asks for a shadow filled by planetshine and shifted toward the
             key's complement; it does not ask for the shadow to *be* that
             colour. */
          /* And two thirds of the strength they had. The fill closed a genuine
             fault — 19.3% of the habitat was at pure 0,0,0 — but it closed it
             by adding an almost-constant to the two thirds of every frame that
             is in shadow, which is the same mistake the ambient above makes.
             At this strength the histogram still has a floor (black% under one
             per cent, p1 in single figures) and there is somewhere for the
             shadows to go. */
          vec3 si_b = vec3(0.586, 0.455, 0.360) * 0.66
                    * (0.22 + 0.78 * clamp(-si_N.y, 0.0, 1.0)) * (0.24 + 0.76 * si_low);
          si_b += vec3(0.337, 0.360, 0.398) * 0.66
                * (0.18 + 0.82 * clamp(si_N.y, 0.0, 1.0));
          si_b += vec3(0.254, 0.293, 0.360) * 0.72 * clamp(-si_N.z, 0.0, 1.0)
                * (1.0 - smoothstep(-4.10, -2.30, si_P.z));
          /* Against a floor on the albedo, not against the albedo itself.
             Most of the pure black in this room is not black *paint* — it is
             the panel gaps, weld reliefs and fastener recesses in the baked
             map, which are dark because the bake put occlusion into the albedo
             as well as into the ORM. Multiplying the fill by that gives the
             darkest pixels in the frame the least fill, which is precisely
             backwards. Six percent is about the floor of a real anodised or
             painted surface, and nothing in here is charcoal. */
          vec3 si_fa = max(diffuseColor.rgb, vec3(0.058))
                     * (1.0 - metalnessFactor);
          reflectedLight.indirectDiffuse += si_b * si_fa * si_fill
            * ${bounce} * uFill * mix(1.0, si_cav, 0.62);
        }
      `);
  };
  mat.customProgramCacheKey = () => 'bake5:' + (o.key
    || `${set}_${tile}_${detail}_${wear}_${grime}_${bump}_${bare}_${dust}`
     + `_${kick}_${lane}_${hands}_${sheenKill}_${RLO}_${RHI}_${edgeTint}`)
    + '_k' + markFloor
    + '_b' + bounce + '_m' + [mBump, mGrime, mWear, mRough, microTile].join(',');
  // Kept so a variant can be re-dressed — see dressedVariant below.
  mat.userData.dress = o;
  mat.userData.fill = INTERIOR_FILL;
  mat.userData.specOcc = INTERIOR_SPEC_OCC;
  mat.userData.shape = INTERIOR_SHAPE;
  return mat;
}

/**
 * A variant of a dressed material with some properties overridden.
 *
 * This exists because `clone()` cannot be used for it. three's `Material.copy`
 * copies an explicit list of known properties and `onBeforeCompile` is not on
 * it, so a cloned material silently loses its entire injected shader. The hull
 * shells are the largest surfaces in the ship and were once built by cloning,
 * which is why they rendered as flat untextured plastic while every box in the
 * room had detail. Re-dressing from the stored options is the only way across.
 */
export function dressedVariant(mat, over = {}, dressOver = {}) {
  const m = mat.clone();
  Object.assign(m, over);
  dressInterior(m, { ...(mat.userData.dress || {}), ...dressOver,
    key: (mat.userData.dress?.key || '?') + ':' + Object.keys(over).join(',')
       + ':' + Object.keys(dressOver).join(',') });
  // clone() dropped the source's onBeforeCompile — the same three behaviour
  // documented above — so the log-depth strip has to be reapplied too, or the
  // hull shells go back to writing gl_FragDepth and lose early-Z.
  return stripLogDepth(m);
}

/* ============================================================================
   Canopy glazing.

   The windscreen used to be a MeshPhysicalMaterial at opacity 0.04, which is
   to say it was a hole with a number on it. You cannot see a clean sheet of
   glass; you see what it *does to light*, and a 4%-alpha blend does four
   things wrong at once: it scales the specular by the alpha as well as the
   diffuse, so the one term that makes glass legible is the term it deletes;
   it has no Fresnel, so the sheen does not climb toward the edges of the
   pane where the surface turns away; there is no thickness, no coating, no
   dirt and no polish; and it composites as though the glass were a dim grey
   film rather than as a reflection *added* on top of the world behind it.

   This is the same surface written as what it is:

     · Fresnel for a slab rather than a single interface (light meets two
       air/glass boundaries on the way through, so the plate returns rather
       more than Schlick alone predicts).
     · An anti-reflective coating, which is the honest way out of the fight
       the old material lost. Uncoated glass returns essentially *everything*
       at grazing incidence, so the outer thirds of a curved canopy become a
       mirror of the cabin and the corners of the window stop being windows.
       That is real physics, and dropping envMapIntensity to fight it just
       makes the whole pane dimmer everywhere. Every real spacecraft window is
       coated; a coating leaves the normal-incidence reflection alone and
       flattens the grazing rise, which is exactly the knob wanted.
     · Long polishing strokes and micro-scratches, anisotropic along the run
       of the pane, which are invisible until the star is near the mirror
       direction and then flare into the broad smeared band that is the single
       most recognisable thing a windscreen does.
     · Dust, dried salt and a printed frit border at the seals, where no wiper
       reaches, forward-scattering hard when the star is behind them.
     · The green-blue of the plate seen in its own thickness, which only shows
       up where the path through the glass is long.

   Composited premultiplied: colour is radiance *added* by the glass and alpha
   is the fraction of the world behind it that the glass removes, which is
   what a reflective transparent surface physically is. Straight alpha blending
   cannot express "adds a reflection and passes 96% of the sky" at all.

   Two things about *where* the glass is allowed to show, both of which the
   first version of this shader got wrong:

   The coat flattens the grazing rise almost completely, to within a few
   percent of the normal-incidence 8%. It has to: from the seat the pane wraps
   the whole upper field at 70-85 degrees, so a Fresnel curve that climbs with
   incidence does not put sheen at the *edges of the pane*, it puts sheen over
   the entire windscreen at one constant value, which is a grey veil with a
   physical justification. What the eye actually reads as "the pane turns away"
   is the last few hundred millimetres before the seal, where the glass curves
   hard into its frame — so the sheen is keyed on distance from the pane's own
   rim, not on incidence, and climbs by about 4x over that band. That is what
   the reference frame shows and it is measurable in it.

   And coverage is not the same number as the reflection. Premultiplied
   compositing keeps the two independent, and they have to be: a reflection
   bright enough to read as glass, applied as coverage as well, takes that much
   of the sky out of the frame everywhere the canopy wraps — which is all of
   it. What removes sky here is (a) a small fixed fraction of the reflectance,
   tuned so the clean centre of the pane passes better than 99% of what is
   behind it, and (b) the *luminance actually reflected*, so a hot streak
   genuinely hides what is behind it and clean glass genuinely does not. Film
   does the same cheat with a polariser. The window stays a window.
   ========================================================================== */

const GLASS_VERT = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec2 vGuv;
void main(){
  vGuv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vWNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GLASS_FRAG = /* glsl */`
precision highp float;
varying vec3 vWPos;
varying vec3 vWNrm;
varying vec2 vGuv;

uniform vec3  uCamPos;
uniform vec3  uSunDir;     // cabin space, unit, toward the star
uniform vec3  uSunCol;     // star colour scaled by how much reaches the glass
uniform vec3  uTint;       // the colour of the plate in its own thickness
uniform float uEnvGain;    // trim on the painted shell's own radiance
uniform float uSheen;      // master gain on everything specular
uniform float uCover;      // fraction of the reflectance that removes sky
uniform float uCoverLum;   // extra coverage per unit of reflected luminance
uniform float uCoat;       // 0 uncoated (mirror at the edges), 1 fully coated
uniform float uGrime;      // dust and salt in the perimeter fringe
uniform float uPolish;     // scratch and swirl density
uniform float uLamp;       // gain on the reflected fixtures of the cabin
uniform float uRim;        // metres of pane over which the sheen climbs
uniform float uFrit;       // printed border band at the seal, 0..1
uniform vec2  uSpan;       // metres spanned by uv.x and uv.y
uniform float uRadial;     // 1 for a round port, 0 for a rectangular pane
uniform vec2  uArc;        // shoulder line of the section: y = uArc.x + uArc.y*z
uniform float uOutside;    // 1 when there is deep space behind the plate

${CABIN_ENV_GLSL}

float h21(vec2 p){
  p = fract(p * vec2(139.71, 271.13));
  p += dot(p, p + 41.7);
  return fract(p.x * p.y);
}
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float a = 0.5, s = 0.0;
  for(int i = 0; i < 4; i++){ s += a * vn(p); p *= 2.03; a *= 0.5; }
  return s;
}

/* What is on the other side.
 *
 * The observation port was a disc of flat emissive in a ring, which reads as a
 * lamp set into the wall rather than as a hole in the hull -- the review called
 * it a blank white disc. It cannot show the real sky: the cabin is a separate
 * scene drawn over the world with its own cleared depth, and the hull skin
 * behind the port occludes it. So the view is authored here.
 *
 * Voronoi-ish rather than thresholded noise, for the reason the starfield in
 * the exterior already knows: noise cannot separate density from size. One
 * star per cell, kept or thrown away on a per-cell random, with a per-cell
 * brightness -- so the count is set by the cell scale and the size by the
 * radius, independently. Authored well above the clip point, because a window
 * onto space in a lit room is the one place a few pixels are allowed to blow.
 */
vec3 outside(vec3 d, vec3 sunDir, vec3 sunCol){
  // the void is teal-black, never neutral grey
  vec3 c = mix(vec3(0.0035, 0.0062, 0.0088), vec3(0.0060, 0.0098, 0.0130),
               d.y * 0.5 + 0.5);
  /* Density, size and brightness, and all three were wrong in the same
     direction: 6.2% of cells kept at a cell scale of 52, a disc radius of 0.11
     cells and a magnitude of mag-cubed came to about thirty stars across the
     whole aperture, nearly all of them faint, and each of them 0.12 degrees
     across — under one and a half pixels at any sane size for a 1.1 m port on
     screen. This project has learned twice that a sub-pixel emissive is not
     dim, it is *absent*: the sky sprites and the dust motes both needed
     explicit pixel floors. So the keep rate goes to 22%, the disc to a quarter
     of a cell (about three and a half pixels), and the magnitude distribution
     from a cube to a square with a real floor under it, which raises the faint
     end without touching the bright one. */
  vec3 p = d * 52.0;
  vec3 gi = floor(p);
  vec3 gf = fract(p) - 0.5;
  float h = h21(gi.xy * 1.7 + gi.z * 37.13);
  if(h > 0.780){
    vec3 j = vec3(h21(gi.xy + 11.3), h21(gi.yz + 7.7), h21(gi.zx + 3.1)) - 0.5;
    float r = length(gf - j * 0.62);
    float mag = fract(h * 913.7);
    c += smoothstep(0.25, 0.0, r) * (1.1 + 30.0 * mag * mag)
       * mix(vec3(1.0, 0.86, 0.70), vec3(0.80, 0.88, 1.0), fract(h * 57.1));
  }
  // and the star itself, plus the glare it throws across the plate
  float sd = dot(d, sunDir);
  c += sunCol * (smoothstep(0.99976, 0.99994, sd) * 240.0
                 + pow(max(sd, 0.0), 90.0) * 0.9
                 + pow(max(sd, 0.0), 6.0) * 0.030);
  return c;
}

void main(){
  vec3 N = normalize(vWNrm);
  vec3 V = normalize(uCamPos - vWPos);
  // the pane is a single sheet drawn double-sided; face the normal at the eye
  if(dot(N, V) < 0.0) N = -N;
  float ndv = clamp(dot(N, V), 0.002, 1.0);

  /* ---- metres from the nearest edge of the pane, and a metric coordinate to
     print things in.

     Neither can come from uv, and this is the hard vertical seam down the
     middle of the canopy. The wrap panes are lofted by glassGeo, whose u is
     the *vertex index* along the section: twenty-eight points, of which
     twenty-six are spent on the two corner radii and exactly one span covers
     the flat of the roof. That one span is 2.8 m of pane inside a u-step of
     0.037, and it sits at u = 0.5 — dead centre. Anything authored against uv
     is therefore thirteen times finer down the middle of the windscreen than
     it is at the sills, with a hard discontinuity either side of it: the
     scratch set's own pixel-footprint fade keeps the scratches on the flat and
     throws them away on the arcs, so what the eye sees is a corduroy stripe
     down the centreline with a sharp edge on both sides.

     So the scale is *measured*, by inverting the uv Jacobian against the
     world-space one, which is exact and costs six instructions; and the print
     coordinate for the wrap panes is a real arc-length-and-station pair taken
     from cabin space, which is continuous whatever the tessellation does. The
     dome, the port and the nav plate all carry a genuinely geometric uv, so
     they keep theirs. */
  vec3 dPx = dFdx(vWPos), dPy = dFdy(vWPos);
  vec2 dUx = dFdx(vGuv),  dUy = dFdy(vGuv);
  float det = dUx.x * dUy.y - dUx.y * dUy.x;
  float idet = 1.0 / (det + (step(0.0, det) * 2.0 - 1.0) * 1e-9);
  vec2 sp = clamp(vec2(length((dPx * dUy.y - dPy * dUx.y) * idet),
                       length((dPy * dUx.x - dPx * dUy.x) * idet)),
                  uSpan * 0.15, uSpan * 4.0);

  vec2 e2 = min(vGuv, 1.0 - vGuv) * sp;
  float edge = max(mix(min(e2.x, e2.y),
                       (0.5 - length(vGuv - 0.5)) * sp.x, uRadial), 0.0);

  /* ---- arc length across the section, and this replaced a polar coordinate
     that put a *pole on the windscreen*.

     What was here was atan(x, max(y - 0.55, 0.03)) — an angle about a point at
     (0, 0.55). Two things are wrong with that and the second is fatal. The
     point is only 470 mm above the deck, so it is nowhere near the centre of
     the section and the angle is badly non-uniform along the arc; and the
     clamp means that for every fragment below y = 0.58 the second argument is
     the constant 0.03, so atan flips from +pi/2 to -pi/2 the instant x changes
     sign. The swirl field rotates the anisotropic tangent frame from this
     coordinate, so every polish stroke and every scratch on the pane radiates
     from that singularity.

     It is invisible until the anisotropic lobe lights up, which needs the star
     within a few degrees of the mirror direction — so it never appeared in any
     shot taken with the star ahead. Put the star behind the ship at a phase
     near 150 and it draws a hard four-lobed X across the whole canopy with a
     fan of about ten radial spokes off the pole, with bloom, streak and flare
     all switched off. The seam this coordinate was introduced to fix was real;
     the cure had a worse defect in it than the disease.

     What the pane actually wants is arc length from the crown, in metres,
     continuous, and with no pole anywhere. For a rounded-rectangle section
     that is exactly x across the roof flat, and x plus the vertical descent
     down the shoulder and the sill. The two agree at the centreline because
     the descent term is identically zero there — the crown is the highest part
     of the section by construction — so there is nothing to flip. uArc carries
     the shoulder line as a linear function of z, which is what makes it hold
     over a canopy that tapers from 2.44 m tall at the header to 1.62 m at the
     nose ring: below that line the section is running vertically, above it,
     horizontally. The corner radius is measured a little short (it counts the
     chord rather than the arc, so a fillet is compressed by about a third),
     which for a noise field is not a thing the eye can find. */
  float shoulder = uArc.x + uArc.y * vWPos.z;
  float run = max(shoulder - vWPos.y, 0.0);
  vec2 mp = mix(vec2(vWPos.x + clamp(vWPos.x * 8.0, -1.0, 1.0) * run, vWPos.z),
                vGuv * sp, uRadial);

  /* ---- Fresnel, for a slab rather than an interface, then coated nearly
     flat. See the block comment: an incidence-driven sheen on a pane that is
     everywhere at 70-85 degrees is not a sheen, it is a veil. What is left
     after the coat is a near-constant 8%, which is what a coated window
     actually returns. */
  float f = 0.040 + 0.960 * pow(max(1.0 - ndv, 0.0), 5.0);
  float R = f * (2.0 - f);
  R *= mix(1.0, 0.145, uCoat * smoothstep(0.72, 0.04, ndv));

  /* ---- and the sheen put back where the pane does turn away: the band before
     the seal, where the glass curves hard into its frame. Squared so the clean
     middle of the pane is untouched and the climb happens in the last third of
     the band. */
  float rim = 1.0 - smoothstep(0.0, uRim, edge);
  rim *= rim;
  R *= (1.0 + rim * 5.0) * uSheen;

  // ---- polish. The pane was drawn and buffed along its length, so the
  //      anisotropy runs with the hull axis, swirled by a slow field: a
  //      perfectly parallel scratch set reads as brushed metal, not glass.
  vec3 tanZ = vec3(0.0, 0.0, 1.0) - N * N.z;
  float tl = length(tanZ);
  vec3 T = tl > 1e-3 ? tanZ / tl : normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 Bt = cross(N, T);
  float sw = (fbm(mp * vec2(0.62, 0.71)) - 0.5) * 1.6;
  vec3 Ts = normalize(T * cos(sw) + Bt * sin(sw));
  vec3 Bs = cross(N, Ts);

  vec3 L = uSunDir;
  vec3 Hv = normalize(L + V);
  float ht = dot(Hv, Ts) / 0.022;      // tight along the stroke
  float hb = dot(Hv, Bs) / 0.30;       // smeared across it
  float aniso = exp(-(ht * ht + hb * hb));

  /* Individual scratches: long along the run of the pane, sparse and hard
     across it -- and *prefiltered by their own footprint*. Forty cycles to the
     metre puts a scratch under two pixels wide at working resolution, which
     does not read as polish, it reads as a corduroy over the whole windscreen.
     The same failure the procedural surface model died of: a hard step
     computed in the shader with no mip chain under it. Fading the term out as
     its period approaches a pixel is the filter it never had.

     Skipped entirely where the star is nowhere near the mirror direction,
     which is most of the pane most of the time: the whole term is multiplied
     by an anisotropic lobe that has already gone to zero, and it costs two
     value-noise fetches to compute a number that will be multiplied by 1e-9.
     The branch is on a smooth function of the half-vector, so it is a band
     across the pane rather than per-pixel confetti, and a warp takes it
     together. */
  float polish = 0.0;
  if(aniso > 1.0e-4){
    const float SFREQ = 39.0;          // cycles per metre, across the pane
    float scr = vn(mp * vec2(SFREQ, 3.75) + sw * 3.0);
    scr = smoothstep(0.56, 1.0, scr);
    scr *= scr * clamp(1.0 - fwidth(mp.x) * SFREQ * 2.4, 0.0, 1.0);
    // and the broad swirl band the buffing wheel left
    float band = pow(max(vn(mp * vec2(4.6, 2.1) + 3.7), 0.0), 3.0);
    /* Weighted to the perimeter. A wiper sweeps the middle of a windscreen and
       never reaches its corners, so that is where the swirl and the fine
       scratch set survive; run flat across the pane it is one more constant
       term over the part of the frame the whole game is played through. */
    float worn = 0.30 + 1.70 * rim;
    polish = uPolish * (0.03 + (2.4 * scr + 1.0 * band) * worn);
  }

  // ---- the star's own disc, reflected. Half a degree wide, and it has to be
  //      authored in real HDR or the bloom has nothing to find.
  float mir = dot(reflect(-V, N), L);
  float disc = smoothstep(0.99900, 0.99986, mir);

  /* ---- the seal. Dirt, dried salt and the printed frit border, all of them
     in the last few centimetres against the frame and none of them across the
     middle. The frit is the strongest single cue that a pane is a physical
     object: every glazed panel ever made has a ceramic band screened round its
     edge to hide the adhesive, solid at the rim and dithered out into a dot
     matrix. It is opaque, so it goes into coverage rather than into colour.

     All of it is confined to a band of a few centimetres, so all of it is
     inside a branch: two fbms and a value-noise fetch, skipped over the ninety
     percent of the pane the seal cannot reach. Same argument as the polish —
     the band is contiguous, so warps either take it or skip it whole. */
  float film = 0.0, salt = 0.0, frit = 0.0;
  if(edge < max(0.135, uRim * 0.58)){
    float grit = fbm(mp * 26.0);
    float fringe = 1.0 - smoothstep(0.0, 0.115, edge);
    fringe *= fringe;
    film = uGrime * fringe * (0.24 + 0.76 * grit);
    salt = uGrime * smoothstep(0.60, 0.90, fbm(mp * 38.0 + 11.3))
         * (1.0 - smoothstep(0.0, 0.055, edge));
    const float DFREQ = 78.0;
    float dots = smoothstep(0.38, 0.86, vn(mp * DFREQ + 5.1))
               * clamp(1.0 - fwidth(mp.x) * DFREQ * 2.2, 0.0, 1.0);
    // scaled off the same band the sheen climbs in, so a 1.1 m porthole does
    // not get the 5 m canopy's border printed round it
    frit = uFrit * clamp((1.0 - smoothstep(uRim * 0.04, uRim * 0.24, edge))
                         + dots * (1.0 - smoothstep(uRim * 0.14, uRim * 0.52, edge)) * 0.85,
                         0.0, 1.0);
  }
  // a scattering layer blazes when the source is behind it and merely glows
  // when the room lights it
  float fwd = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 4.0);
  vec3 dustLit = uSunCol * (0.03 + 0.97 * fwd) * 0.055
               + cabinRoom(N) * uEnvGain * 0.55;

  /* ---- the plate seen in its own thickness. Rim-gated, not incidence-gated,
     for the same reason the sheen is: from the seat the canopy wraps the whole
     upper field at 70-85 degrees, so anything proportional to path length is a
     veil over half the frame before it is a colour in the glass. Where you
     genuinely do look through a long path of it is at the rim, where the pane
     curves away. */
  float thick = clamp(1.0 / ndv - 1.0, 0.0, 2.0) * rim;

  /* ---- the room, with parallax and with its lamps in it. This is the whole
     point of the rewrite: an environment sampled by direction alone is
     constant over a pane whose normal barely changes, and constant is fog. */
  vec3 Rv = reflect(-V, N);
  vec3 refl = (cabinRoom(Rv) * uEnvGain + cabinLamps(vWPos, Rv) * uLamp) * R;

  vec3 spec = refl
            + uSunCol * aniso * polish * uSheen
            + uSunCol * disc * 34.0 * uSheen
            + dustLit * (film * 0.9 + salt * 1.7)
            + uTint * uEnvGain * 0.055 * thick;

  /* Coverage. A small fixed share of the reflectance — tuned so the clean
     centre of the pane passes better than 99% of the sky — plus what the glass
     is actually showing you, so a hot streak hides what is behind it and clean
     glass does not. The seal is opaque and simply counts. */
  float lum = dot(spec, vec3(0.2126, 0.7152, 0.0722));
  float alpha = clamp(R * uCover + lum * uCoverLum
                      + (film + salt) * 0.30 + frit, 0.0, 1.0);
  vec3 col = spec * (1.0 - frit * 0.88);
  if(uOutside > 0.5){
    // an opening, not a film: whatever the renderer drew behind this is the
    // cabin's own far wall, and it has to be replaced rather than tinted
    col += outside(-V, uSunDir, uSunCol) * (1.0 - R) * (1.0 - frit * 0.95);
    alpha = 1.0;
  }
  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * One pane of canopy glazing.
 *
 * `uCamPos`, `uSunDir` and `uSunCol` are refreshed by `bindGlass`, which hangs
 * an `onBeforeRender` on the mesh — the alternative is reaching into Game.js
 * from here for a value the render already has in hand.
 */
export function makeCanopyGlass(o = {}) {
  const m = new THREE.ShaderMaterial({
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    uniforms: {
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 0.3, -1).normalize() },
      uSunCol: { value: new THREE.Color(0, 0, 0) },
      uTint: { value: new THREE.Color(0.42, 0.72, 0.68) },
      uEnvGain: { value: o.envGain ?? 1.0 },
      uSheen: { value: o.sheen ?? 1.0 },
      /* 0.13 of an 8% reflectance is one part in a hundred of the sky, which
         is the number the brief asks for: nothing dims the planet dead ahead.
         The glass earns its coverage back through uCoverLum wherever it is
         actually showing something. */
      uCover: { value: o.cover ?? 0.13 },
      uCoverLum: { value: o.coverLum ?? 0.55 },
      uCoat: { value: o.coat ?? 1.0 },
      uGrime: { value: o.grime ?? 1.0 },
      uPolish: { value: o.polish ?? 1.0 },
      uLamp: { value: o.lamp ?? 1.30 },
      uRim: { value: o.rim ?? 0.30 },
      uFrit: { value: o.frit ?? 1.0 },
      uSpan: { value: new THREE.Vector2(o.spanU ?? 5.0, o.spanV ?? 2.4) },
      uRadial: { value: o.radial ? 1 : 0 },
      /* Where the canopy's section stops running vertically and starts running
         across, as a line in z. Taken straight off Interior.js's NOSE table:
         h - r is 1.87 at the z = -5.25 header and 1.10 at the z = -7.60 nose
         ring. Unused when uRadial is 1. If the canopy loft changes, this
         changes with it — the same standing obligation the reflected cove
         positions carry. */
      uArc: { value: new THREE.Vector2(o.arcA ?? 3.590, o.arcB ?? 0.3277) },
      uOutside: { value: o.outside ? 1 : 0 },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // interior-only: no log depth, and no toneMapping fixups — PostFX owns both
  return m;
}

/**
 * Feed a glass material the eye and the star, from inside the render.
 *
 * The star direction the cabin needs is already in the scene: the canopy's
 * DirectionalLight is aimed down it, in cabin space, every frame. Reading it
 * off the light keeps this file from knowing anything about the world.
 */
export function bindGlass(mesh, mat) {
  // A pane must not cast: three derives a depth material that ignores opacity
  // entirely, so a transparent sheet writes a *solid* silhouette into the
  // cabin's shadow maps and the windscreen throws a shadow across the console.
  mesh.userData.noShadow = true;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    const u = mat.uniforms;
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    let sun = mesh.userData._sun;
    if (sun === undefined) {
      sun = null;
      scene.traverse((o) => { if (!sun && o.isDirectionalLight) sun = o; });
      mesh.userData._sun = sun;
    }
    if (sun) {
      u.uSunDir.value.copy(sun.position).sub(sun.target.position).normalize();
      u.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    }
  };
  return mesh;
}

/**
 * The full interior material set, built once and shared.
 *
 * Metalness here is zero on everything that is painted, which is most of the
 * ship. Driving painted panels at metalness 0.3-0.8 was the single largest
 * cause of the "shiny plastic" read: a metal surface has no diffuse term, so it
 * returns nothing but a specular reflection of the environment, and a bright
 * uniform environment turns that into a glossy sheen with no material identity.
 * Bare alloy still appears — the baked ORM raises metalness exactly where the
 * paint has been rubbed through — so the metal shows up on the edges and rivet
 * crowns that would really be polished, and nowhere else. The one family
 * authored as metal is M.rail, which is a bare anodised grab handle.
 *
 * Albedo is paler than it was. Every surface in here once sat between 0x23 and
 * 0x4c, which is a linear reflectance of 1.6% to 8%. Coal is 4%. No amount of
 * light rescues a room built out of coal. Real crewed volumes are painted pale
 * for exactly this reason — you have to be able to find a dropped bolt.
 */
export function makeInteriorMaterials(assets = {}) {
  const tex = assets.tex || {};
  const M = {};
  const std = (p) => new THREE.MeshStandardMaterial(p);

  /* Painted structural panelling — the dominant surface, and the warm half of
     the pair. Bone, and deliberately a touch warmer and paler than it was, so
     that the graphite family below reads as a different substance rather than
     as the same one in shadow. */
  M.panel = dressInterior(std({
    color: 0x827b70, metalness: 0.0, roughness: 0.86, envMapIntensity: 0.14,
  }), {
    tex, set: 'panel', wear: 0.75, grime: 0.55, bump: 1.0, bare: 0.45,
    dust: 0.6, hands: 0.35, edgeTint: [0.72, 0.73, 0.75],
    roughLo: 0.62, roughHi: 0.97, sheenKill: 0.55,
    microTile: 0.28, key: 'panel',
  });

  // hull shell behind the panelling: rawer, cooler and a shade greener
  M.hull = dressInterior(std({
    color: 0x6c716c, metalness: 0.0, roughness: 0.90, envMapIntensity: 0.12,
  }), {
    tex, set: 'panel', wear: 0.9, grime: 0.7, bump: 1.1, bare: 0.5,
    dust: 0.7, hands: 0.25, edgeTint: [0.66, 0.69, 0.72],
    roughLo: 0.66, roughHi: 0.99, sheenKill: 0.6,
    microTile: 0.32, microWear: 1.15, key: 'hull',
  });

  /* Dark machined structure: frames, brackets, consoles, conduit runs and
     crates — between them most of what a frame in here actually contains. At
     metalness 0.42 all of that had no diffuse term at all and returned a
     reflection of the room probe and nothing else, which is exactly the mirror
     the review saw. It is anodised and painted alloy, not chrome.

     This is also the cabin's *second material family*, and that is a measured
     problem rather than a decorative one: about ninety percent of every frame
     in here came back one blue-grey or one sandy khaki, where the reference
     puts painted grey, gloss black, bare aluminium, warm paper and orange in
     the same shot. One hue across a whole room is what makes it read as a
     texture pass rather than as a built object.

     So the difference from the painted family is not only colour, it is
     *response*. The panelling is chalky paint at a 0.62 roughness floor; this
     is an anodised casting at 0.44, which is still a long way from shiny — the
     floor here is 0.44, not 0.05 — but it is enough that a bracket catches the
     coves where the bulkhead behind it does not, and the eye reads two
     substances instead of two shades.

     It was 0x474e59, and the trouble with that is that so were most of its
     neighbours: dark, shell, rubber and rail all sat between 210 and 215
     degrees of hue, so the cockpit — which is built almost entirely out of
     those four — measured 77% of its chromatic energy inside two adjacent
     ten-degree bins at a mean saturation of 0.47, against 0.19-0.24 for the
     reference, and walking aft into the bone-and-sand habitat was a 180-degree
     hue jump. A restricted palette means bone, oxide and rust *appear*; it does
     not mean every object in a room is one of them. This is now a near-neutral
     cool grey, the moulded shell below is a near-neutral warm one, and the two
     read as different substances by value and response rather than by tint. */
  M.dark = dressInterior(std({
    color: 0x4a4c4e, metalness: 0.07, roughness: 0.66, envMapIntensity: 0.26,
  }), {
    tex, set: 'panel', tile: 1.15, wear: 0.6, grime: 0.45, bump: 0.75,
    bare: 0.58, dust: 0.35, hands: 0.5, edgeTint: [0.60, 0.63, 0.68],
    markFloor: 0.34,
    roughLo: 0.50, roughHi: 0.86, sheenKill: 0.45,
    /* The finest projection of the painted families, because this is the
       material of *parts*: brackets, bezels, console cheeks, crate corners,
       the sidestick pad. A 60 mm object has to hold several centimetres of
       surface or it is a colour swatch. */
    microTile: 0.19, microRough: 1.15, microBump: 0.62, key: 'dark',
  });

  /* Deck plate. This is where "polished to a hotel-lobby mirror sheen"
     started, and it is worth being precise about why, because the obvious fix
     does nothing: forcing this material to roughness 1.0 and metalness 0.0
     changed the frame by a mean of 1.5 display levels out of 255 and the floor
     still looked wet. What the eye was reading was never the specular lobe —
     it was a smooth untextured plate with a tight inverse-square pool of light
     on it. The answer is relief, and it is now real baked relief: raised
     anti-slip lozenges, countersunk fasteners and plate seams, with a lane
     worn down the middle by boots. */
  M.floor = dressInterior(std({
    color: 0x5b5851, metalness: 0.04, roughness: 0.88, envMapIntensity: 0.11,
  }), {
    tex, set: 'deck', wear: 1.0, grime: 0.8, bump: 1.0, bare: 0.5,
    dust: 0.2, kick: 0.0, lane: 0.85, edgeTint: [0.62, 0.63, 0.64],
    markFloor: 0.42,
    roughLo: 0.58, roughHi: 0.96, sheenKill: 0.45,
    microTile: 0.30, microGrime: 1.25, microWear: 0.60, key: 'floor',
  });

  /* Oxide orange, and only just. This is the one saturated colour in the room
     and it is spread across every collar, rail and grab handle; at full
     strength, once the cabin was lit properly, the bulkhead arch went from a
     detail to the loudest object in the opening frame. */
  M.accent = dressInterior(std({
    color: 0x84582f, metalness: 0.0, roughness: 0.80, envMapIntensity: 0.12,
  }), {
    tex, set: 'panel', tile: 1.6, wear: 1.0, grime: 0.5, bump: 0.8,
    bare: 0.35, dust: 0.5, hands: 0.7, edgeTint: [0.66, 0.62, 0.56],
    markFloor: 0.50,
    roughLo: 0.58, roughHi: 0.93, sheenKill: 0.5,
    microTile: 0.16, microWear: 1.25, key: 'accent',
  });

  /* Rubber: matting, grips, harness webbing, the inlay under the instrument
     plates. Deadest response in the set, almost no relief, and no plate
     structure at all — moulded rubber has no seams. */
  M.rubber = dressInterior(std({
    color: 0x2e2e30, metalness: 0.0, roughness: 0.96, envMapIntensity: 0.05,
  }), {
    tex, set: 'soft', tile: 0.26, detail: 0.85, wear: 0.3, grime: 0.5,
    bump: 0.55, bare: 0.0, dust: 0.25, kick: 0.0,
    edgeTint: [0.34, 0.34, 0.36], roughLo: 0.90, roughHi: 1.0,
    sheenKill: 0.35,
    // moulded rubber does not scratch through to alloy; it scuffs and holds dirt
    microTile: 0.10, microWear: 0.0, microBump: 0.85, key: 'rubber',
  });

  /* Upholstery. Warmer than the panelling on purpose: a cool neutral seat is
     itself half of why the pilot's chair read as the same moulding as the wall
     behind it. Fine tile, low detail contrast, dead roughness. */
  M.seat = dressInterior(std({
    color: 0x4c4438, metalness: 0.0, roughness: 0.96, envMapIntensity: 0.07,
  }), {
    tex, set: 'soft', tile: 0.155, detail: 0.42, wear: 0.4, grime: 0.6,
    bump: 0.55, bare: 0.0, dust: 0.3, kick: 0.0,
    edgeTint: [0.50, 0.47, 0.43], roughLo: 0.88, roughHi: 1.0,
    sheenKill: 0.25,
    microTile: 0.085, microWear: 0.0, microBump: 0.70, microGrime: 0.85,
    key: 'seat',
  });

  /* Anodised alloy, worn bright by hands. The grab rails, the glazing
     retaining strips and the canopy waist rails, and almost nothing else — this is the one solid material in the
     cabin allowed a real highlight, and it only means anything because the
     painted alloy either side of it sits three times rougher. */
  /* The tile is 0.26 m here and the detail contrast is a third, and both
     numbers are about *what is in the map*. The panel tile is authored for a
     2 m bulkhead: it carries inspection placards, a hatch roundel and blocks
     of stencilled type. M.rail is the material of switch caps, bezel corners,
     armrest beads and grab rails — parts between 15 and 60 mm. At the old
     0.55 m tile a 100 mm placard landed at 70 mm, so every anodised bead in
     the cockpit came back with a fragment of legible signwriting smeared
     across it, and the pale ones (this is the brightest material in the
     cabin) showed it loudest. Shrinking the projection turns the same map
     into grain, which is what a machined surface has. Polished alloy is also
     the one thing in here that would never be painted with a placard. */
  /* Pulled back from 0.82/0.44/0.50. The art direction's floor is around 0.35
     and this was the only family near it, which is defensible for a grab rail
     and is not defensible for the switch caps and bezel beads that share the
     material — a 15 mm sphere at metalness 0.82 returns the room probe and
     nothing else, which is what "broad specular highlights on chrome knobs"
     means. Anodised alloy is not chrome: it keeps a real highlight, but a
     narrower one, over a surface that still has a diffuse term. */
  M.rail = dressInterior(std({
    color: 0x9a9a97, metalness: 0.70, roughness: 0.52, envMapIntensity: 0.34,
  }), {
    tex, set: 'panel', tile: 0.26, detail: 0.32, wear: 0.8, grime: 0.25,
    bump: 0.30, bare: 0.12, dust: 0.15, kick: 0.0, markFloor: 0.62,
    edgeTint: [0.80, 0.82, 0.84], roughLo: 0.44, roughHi: 0.64,
    sheenKill: 0.0,
    /* The strongest micro-roughness in the set, and it is the whole answer to
       "broad specular highlights on chrome knobs". A switch cap 15 mm across
       carries one roughness value and one unbroken GGX lobe; what makes real
       machined alloy read as metal-but-not-mirror is that the lobe is chopped
       up at the millimetre scale by the finish. */
    microTile: 0.115, microRough: 1.45, microWear: 1.2, key: 'rail',
  });

  /* Acoustic liner. A crewed volume is not bare plate at head height — it is
     lined with something soft, because a hull full of pumps is loud. And it
     carries the one warm note in a room otherwise built from bone and
     graphite: sand-coloured woven cloth, at head height, over a large enough
     area to put a second hue in every frame of the corridor and the habitat.
     Bone, oxide and rust is the palette; this is the paper in it. */
  M.liner = dressInterior(std({
    color: 0x6e6355, metalness: 0.0, roughness: 0.97, envMapIntensity: 0.05,
  }), {
    tex, set: 'soft', tile: 0.26, detail: 0.78, wear: 0.35, grime: 0.55,
    bump: 0.6, bare: 0.0, dust: 0.5, hands: 0.4,
    edgeTint: [0.52, 0.52, 0.50], roughLo: 0.90, roughHi: 1.0,
    sheenKill: 0.25,
    microTile: 0.10, microWear: 0.0, microBump: 0.65, key: 'liner',
  });

  /* Moulded composite: the pilot seat's shell, and anything else that is a
     pressed part rather than a painted bracket. Dark on purpose — a seat you
     walk past at arm's length is the one object in the cabin whose value the
     eye reads against the pale bulkhead behind it. */
  M.shell = dressInterior(std({
    color: 0x3b3934, metalness: 0.06, roughness: 0.78, envMapIntensity: 0.14,
  }), {
    tex, set: 'panel', tile: 0.85, wear: 0.5, grime: 0.4, bump: 0.6,
    bare: 0.42, dust: 0.3, hands: 0.4, edgeTint: [0.54, 0.57, 0.61],
    /* Was 0.46-0.84 at sheenKill 0.35, and the seat back is what proved that
       wrong: a 700 mm lofted shell seen at a grazing angle carried one broad
       unbroken sheen across the whole curve, with the spine channel and the six
       louvre slots reflecting exactly as much as the crown. A moulded composite
       is matte — the floor here is well above the art direction's 0.35 — and
       what breaks the lobe up is the micro projection, at a tile fine enough
       that a 40 mm louvre land has several centimetres of surface across it. */
    roughLo: 0.60, roughHi: 0.94, sheenKill: 0.55,
    microTile: 0.135, microRough: 1.35, key: 'shell',
  });

  /* Canopy glazing — see the block comment above makeCanopyGlass. The pane is
     2.4 m from the aft header to the nose ring and about 5 m round the arc
     from one waist sill to the other, which is what sizes the seal band. */
  M.glass = makeCanopyGlass({ spanU: 5.0, spanV: 2.4, rim: 0.34 });
  /* The nose pane, straight ahead. Radial UV, barely any dirt — this is the
     one piece of glass in the ship that gets wiped, and it is also the piece
     the entire game is played through. Everything about it is pulled back:
     half the sky coverage of the wrap panes, a narrower seal band, and the
     lowest lamp gain in the ship. Whatever is in front of this pane has to
     survive being behind it. */
  M.noseGlass = makeCanopyGlass({
    spanU: 2.5, spanV: 2.5, radial: true, grime: 0.40, polish: 1.05,
    cover: 0.09, coverLum: 0.42, lamp: 0.85, rim: 0.26,
  });
  /* The observation port is the same plate in a 1.1 m bore: heavier fringe
     because a porthole is a pocket nobody cleans, and no polishing swirl
     because it is a cast blank rather than a drawn canopy pane. It is also
     the one pane in the ship with a genuinely dark hemisphere behind it, so
     the room in it can be allowed to read a little harder. */
  /* The port is the one pane in the ship with genuinely dark sky behind it,
     and that is exactly why the room in it must be *quieter* than it is in the
     canopy, not louder. At envGain 1.4 and lamp 1.5 the reflected bay skin was
     roughly an order of magnitude brighter than the starfield behind the
     plate, so a 1.1 m hole onto deep space read as a dark disc with the wall
     painted on it. The throat lamps have been moved out of the bore and dimmed
     from the other side; this is the rest of it. Grime comes down with them —
     a fringe that is heavier than the canopy's is right, one that fogs the
     aperture is not. */
  M.portGlass = makeCanopyGlass({
    spanU: 1.1, spanV: 1.1, radial: true, grime: 0.70, polish: 0.35,
    envGain: 0.42, lamp: 0.40, rim: 0.13, outside: true, cover: 1.0,
  });

  /* The nav table's projector plate.
     It was flat emissive at 0.55 against a room the exposure has opened up
     for, which is to say it was black — a 1.6 m matte void in the middle of
     the best-looking compartment in the ship. It is a glass plate over a lit
     well now, so at idle it does what unpowered glass does: returns an image
     of the room, catches the coves, and shows the optics underneath. Barely
     coated, because a horizontal plate is seen at grazing incidence from every
     standing eye in the compartment and that grazing rise is the only thing
     that makes it read as a plate at all. */
  M.navPlate = makeCanopyGlass({
    spanU: 1.4, spanV: 1.4, radial: true, grime: 0.7, polish: 0.55,
    envGain: 1.6, lamp: 1.3, coat: 0.35, rim: 0.16,
    cover: 0.30, coverLum: 0.85,
  });

  // Nothing in this set is ever drawn in the exterior pass, so none of it needs
  // the logarithmic depth buffer — and paying for it costs early-Z on all of it.
  for (const k of Object.keys(M)) stripLogDepth(M[k]);
  return M;
}

/**
 * The same material, with the kit's baked occlusion atlas bound.
 *
 * three has exactly one `aoMap` slot and it needs a real UV attribute, which
 * only the glTF kit has. The atlas is what puts a dark line where the deck
 * meets the wall, under the rubbing strake and behind the lockers — the
 * reviewer's single largest complaint was that no corner, panel join or
 * floor/wall junction in the cabin darkened at all, and no lamp placement
 * fixes that because those places are unreachable by construction.
 *
 * `aoMapIntensity` is the tuning knob: the bake is deliberately a little
 * stronger than wanted so this can be pulled back without a round trip.
 */
export function withKitAo(mat, aoTex, intensity = 0.85) {
  if (!aoTex) return mat;
  return dressedVariant(mat, { aoMap: aoTex, aoMapIntensity: intensity });
}

/* ============================================================================
   Emissive fixtures.

   These are shared by colour+intensity so the merge pass can weld them, and for
   a long time the comment here claimed that collapsed "every light strip in the
   ship into a single draw call". It did not, and the reason is worth writing
   down because the same trap catches any measurement of this cabin: `mergeStatic`
   buckets by `material.uuid`, and this cache mints a *new material* for every
   distinct colour and every distinct intensity. Strip lights are authored as
   three nested widths at falling gain to build a soft core, indicator lamps come
   in a dozen states, and every one of those pairs became its own bucket —
   measured, 117 emissive meshes in 105 buckets, drawing 10,418 triangles in 105
   draw calls. A tenth of a percent of the geometry was two thirds of the calls.

   So the tint moves out of the material and into a vertex attribute, exactly the
   way `LampBank` in HoloScreen.js already does it. A `MeshBasicMaterial` is
   `color * vColor`, and a float attribute carries values well over one straight
   into the HDR target — which matters here, because these are authored in real
   radiance and some of them are meant to clip. One material, one bucket, one
   call, and not a pixel moves.

   `emissive()` still hands back a per-tint material, because a handful of
   fixtures are *animated* — the resonance chamber's sockets and its core are
   recoloured from Game.updateChamber every frame — and those live inside Groups
   that the merge pass leaves alone. Anything the merge does weld reads the tint
   off `userData.emissiveTint` and bakes it into the vertices instead.
   ========================================================================== */
const _emCache = new Map();
export function emissive(hex, intensity = 1) {
  const key = hex + '|' + intensity;
  if (!_emCache.has(key)) {
    const m = stripLogDepth(new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHex(hex, THREE.SRGBColorSpace).multiplyScalar(intensity),
      toneMapped: true,
    }));
    // the merge pass's signal that this tint can travel in the geometry
    m.userData.emissiveTint = m.color;
    _emCache.set(key, m);
  }
  return _emCache.get(key);
}

/** The single material every welded emissive in the cabin is drawn with. */
let _emWeld = null;
export function emissiveWeld() {
  if (!_emWeld) {
    _emWeld = stripLogDepth(new THREE.MeshBasicMaterial({
      vertexColors: true, toneMapped: true,
    }));
  }
  return _emWeld;
}
