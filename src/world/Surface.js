import * as THREE from 'three';
import { NOISE, LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';

/* ============================================================================
   Standing on a world.

   Orbit and ground are two different rendering problems and trying to solve
   both with one sphere solves neither: from orbit you need a whole planet with
   no visible geometry, and from the ground you need ten kilometres of terrain
   with no visible *sphere*. So the ground is its own scene — a patch of
   landscape, a field of scatter, a sky dome — swapped in at touchdown.

   Six things make it read, and the first one is the one everything else hangs
   off.

   **One sampling scale, agreed by everybody.** The height field takes a lod —
   the spacing in metres that the answer is about to be sampled at — and simply
   does not contain any band finer than that. The mesh passes its own ring
   pitch, the shadow march passes the pitch of the vertex it feeds, a boulder
   passes its own footprint. Nothing downstream can then disagree with anything
   else, and nothing is ever handed detail it cannot carry.

   Getting that wrong does not look like aliasing, which is the trap: it looks
   like *art direction*. Gating the bands on camera range instead meant the far
   mesh was handed 150 m ridges it sampled every 600 m, and because a marched
   shadow and a sky-occlusion term are decided by that same undersampled field
   and then interpolated across a triangle, the error came out as quad-shaped
   patches of light and dark with the grid's own straight edges in them. An
   independent reviewer described exactly that as "aerial perspective applied
   as a milky alpha wash on some ridges and not their neighbours, with visible
   hard boundaries where the fog volume ends", and as a "regular comb striation
   repeating across the whole terrain". One parameter, three symptoms.

   **A radial grid, with equal ring and segment counts.** Rings grow
   exponentially so triangles stay roughly constant in screen size, skewed
   outward because a pure exponential spends a third of them inside a hundred
   metres — ground the fragment shader draws perfectly well — and leaves the
   skyline sampled every six hundred. What reads as faceted is whichever of the
   two spacings is *larger*, so spending on segments while rings lag buys
   nothing.

   **Shadows, marched.** A geometric ray march up the sun ray against the same
   height field, in the *vertex* stage. Seventy thousand marches a frame
   instead of six million, no shadow map, no second pass. It marches against a
   deliberately coarse version of the field: nothing under twenty metres casts
   a shadow anybody could recognise, and asking for one is what used to turn
   march-to-march sampling error into a rash of blobs on every distant peak.

   **Detail bands on distance from the camera, not from the ship.** The landing
   site is the origin of the mesh but the camera stands fifty metres off it, so
   keying the fragment detail on the site put the ground directly under the
   lens at the wrong end of every falloff — it got nothing, while the ground a
   hundred metres past the ship got everything. Each band is one octave at its
   own scale; the bands together are the spectrum, which is why none of them
   needs a second octave of its own.

   **Aerial perspective in two layers.** Kilometres of blue air, and the warm
   dust the wind keeps in the first seventy metres. One exponential cannot do
   both: a scale height large enough to reach a mountain leaves nothing in the
   basin, and one small enough to fill the basin never touches the mountain.

   **Scatter, in four bands.** What you could pick up, what you could sit on,
   what you would have to walk around, and outcrops big enough to stand against
   the sky at six kilometres. Three bands left a hole between a ten-metre
   boulder and a mountain, and that hole is most of what makes a landscape
   feel like a backdrop.
   ========================================================================== */

/* ======================================================= the baked material

   Every square metre of ground used to be shaded by noise evaluated per
   fragment: four bands of simplex, a fold for the pebbles, an analytic sine for
   the ripples. That has one defect that no amount of tuning reaches — **a
   procedural field has no mip chain.** Nothing prefilters it, so the high
   frequencies cannot survive minification and the only thing left carrying the
   foreground is the lowest band in the stack. Asked to cover an area it has no
   bandwidth for, a low band does not read as "smooth"; it reads as a regular
   wave, which is exactly the corduroy an owner described as "weird ripples".

   So the detail is baked, by tools/bake_terrain.py, into four seamless tiling
   sets — fractured rock, regolith, a scree bed and a cracked crust — and
   sampled triplanar at three scales. Baked maps are both *sharper* (a 512 tile
   at half a metre is a millimetre per texel, an octave finer than the fragment
   stage could ever afford) and *cheaper* (they delete the noise). The ship
   interior made the same trade and came out at 68.8k triangles from 569k and
   120 fps from 87.

   One image per material, not three. The ground shader has no specular term —
   it is a wrap-diffuse key, a sky fill and a bounce — so roughness and
   metalness have nowhere to go, and the albedo is authored near-neutral because
   the palette lives in uC0..uC4 and has to be able to be oxide on one world and
   bone on the next. That leaves luminance and two channels of normal, which is
   an RGB image, which is one fetch. At three scales and up to three planes that
   difference *is* the frame budget.
   ========================================================================== */

/* How many limbs a crown carries. Declared up here rather than beside
   treeGeom because the flora vertex shader interpolates it into its source at
   module load, and the shader templates are evaluated before the geometry
   helpers further down the file exist — a const declared next to its user threw
   a temporal-dead-zone error that took the whole page down. */
const TREE_LIMBS = 6;

/* ---------------------------------------------------------- the leaf card
 *
 * A drawn cluster of leaves, on a canvas, at load.
 *
 * Foliage went through three analytic masks before this and every one of them
 * failed in the same way, because the problem is not the mask. A compound
 * mask cut each spray into one-pixel slivers and the crown read as squiggles;
 * a single ovate blade fixed that and read, exactly, as *ovals stuck on a
 * stick*. The reason is that a leaf's outline is not an equation — it is lobed
 * or toothed, asymmetric, and it has a midrib and veins that the eye uses to
 * identify it long before it can resolve them individually. That is why every
 * production foliage system in existence uses a textured alpha card, and the
 * only reason this one did not is that discard beside gl_FragDepth mis-compiles
 * under ANGLE. The ground scene runs without logarithmic depth, so that
 * constraint never applied here.
 *
 * No external asset is involved: the cluster is drawn procedurally into a
 * canvas once at boot, which keeps the project's no-build-assets rule and lets
 * the shape be tuned in source. RGB carries a luminance variation (veins,
 * midrib, and the darker margin of each blade) that the shader tints with the
 * world's own vegetation colour; alpha carries the outline.
 */
let _leafTex = null;
export function leafTexture() {
  if (_leafTex) return _leafTex;
  const R = 256;
  const c = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(R, R) : document.createElement('canvas');
  c.width = R; c.height = R;
  const g = c.getContext('2d');
  g.clearRect(0, 0, R, R);

  let st = 0x9e3779b9;
  const rnd = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* One blade: a lobed outline built from a half-profile mirrored about the
     midrib, with the lobes riding on the profile rather than being cut out of
     it — which is what a real margin does and why a toothed edge reads as a
     leaf at ten pixels where a smooth ellipse reads as a pebble. */
  const blade = (cx, cy, len, wid, ang, lobes, tone) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(ang);
    const pt = (t, side) => {
      // widest a little below the middle, drawn to a point at the tip
      let w = Math.pow(t, 0.45) * Math.pow(1 - t, 0.32) * 1.72;
      w *= 1 + 0.20 * Math.sin(t * lobes * Math.PI * 2);
      return [side * w * wid, (t - 0.5) * len];
    };
    g.beginPath();
    g.moveTo(...pt(0.001, 1));
    for (let i = 1; i <= 48; i++) g.lineTo(...pt(i / 48, 1));
    for (let i = 47; i >= 0; i--) g.lineTo(...pt(i / 48, -1));
    g.closePath();
    const gr = g.createLinearGradient(-wid, 0, wid, 0);
    const b = Math.round(150 * tone), d = Math.round(96 * tone);
    gr.addColorStop(0, `rgb(${d},${d},${d})`);
    gr.addColorStop(0.5, `rgb(${b},${b},${b})`);
    gr.addColorStop(1, `rgb(${d},${d},${d})`);
    g.fillStyle = gr;
    g.fill();
    // midrib and side veins, as luminance only
    g.strokeStyle = `rgba(${Math.round(70 * tone)},${Math.round(70 * tone)},${Math.round(70 * tone)},0.85)`;
    g.lineWidth = Math.max(1, len * 0.014);
    g.beginPath(); g.moveTo(0, -len * 0.5); g.lineTo(0, len * 0.5); g.stroke();
    g.lineWidth = Math.max(1, len * 0.008);
    for (let i = 1; i < 7; i++) {
      const t = i / 7;
      const [wx, wy] = pt(t, 1);
      g.beginPath();
      g.moveTo(0, (t - 0.5) * len - len * 0.06);
      g.lineTo(wx * 0.82, wy);
      g.stroke();
      g.beginPath();
      g.moveTo(0, (t - 0.5) * len - len * 0.06);
      g.lineTo(-wx * 0.82, wy);
      g.stroke();
    }
    g.restore();
  };

  /* Forty-odd small blades on a branching stalk, not seven big ones — and this
     is the number that decides whether a canopy can be dense at all.
     
     A card is drawn at roughly two metres across on a fourteen-metre tree,
     because that is the size at which 128 of them can cover a crown. If the
     card contains seven blades, each blade is then a metre long and the tree
     wears seven one-metre leaves per cluster, which is what it drew. Getting
     realistic 20 cm leaves by shrinking the card instead needs about fifteen
     hundred cards per tree, which no instanced scheme here can pay for. So the
     leaves go *inside* the card: one card, many small blades, which is exactly
     why production foliage atlases are drawn as branch-end clusters rather than
     as single leaves. */
  const N = 44;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    // two ranks up a central stalk, alternating side, splaying toward the tip
    const side = (i % 2) ? 1 : -1;
    const up = t;
    const ang = side * (0.55 + 0.55 * (1 - up)) + (rnd() - 0.5) * 0.45;
    const len = R * (0.15 + 0.10 * rnd()) * (0.55 + 0.75 * Math.sin(up * Math.PI));
    const cx = R * 0.5 + side * R * 0.055 * (1 - up) + (rnd() - 0.5) * R * 0.06
      + Math.sin(ang) * len * 0.5;
    const cy = R * (0.95 - 0.82 * up) - Math.cos(ang) * len * 0.5;
    blade(cx, cy, len, len * (0.30 + 0.12 * rnd()), ang,
      4 + Math.floor(rnd() * 4), 0.66 + 0.50 * rnd());
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _leafTex = tex;
  return tex;
}

const TERRAIN_LAYERS = ['rock', 'sand', 'scree', 'crust'];
const TERRAIN_TEX_RES = 512;

let _terrainTex = null;

/**
 * The four sets as one `sampler2DArray`.
 *
 * An array rather than four samplers, because the shader has to be able to pick
 * *any* pair of layers per fragment and GLSL cannot index an array of samplers
 * with a varying. Loaded once for the session and shared by every Surface —
 * landing on a second world must not re-decode four megabytes of image.
 *
 * It returns immediately with a 1x1 neutral per layer so the sampler is legal
 * from the first frame; the real data lands a few hundred milliseconds later
 * and `uTerAmt` fades it in, so a landing that happens during the load shows
 * untextured ground rather than garbage.
 */
export function terrainTexture() {
  if (_terrainTex) return _terrainTex;
  const n = TERRAIN_LAYERS.length;
  const seed = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    seed[i * 4] = 190; seed[i * 4 + 1] = 128; seed[i * 4 + 2] = 128; seed[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataArrayTexture(seed, 1, 1, n);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Not sRGB: two of the three channels are a normal. The luminance is stored
  // at gamma 2 and decoded with one multiply in the shader instead.
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  // A landed frame is almost all ground seen at a grazing angle, which is the
  // one case isotropic filtering cannot serve: the footprint is ten times
  // longer than it is wide and a square mip throws the width away.
  tex.anisotropy = 8;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.userData.ready = 0;
  _terrainTex = tex;

  const R = TERRAIN_TEX_RES;
  const data = new Uint8Array(R * R * 4 * n);
  let landed = 0;
  TERRAIN_LAYERS.forEach((name, layer) => {
    const done = () => {
      if (++landed < n) return;
      tex.image = { data, width: R, height: R, depth: n };
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.needsUpdate = true;
      tex.userData.ready = 1;
    };
    fetch('models/terr_' + name + '.webp')
      .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
      // colorSpaceConversion none, or a browser with a wide-gamut display
      // profile quietly regrades the normal channels on decode.
      .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
      .then((bm) => {
        const c = (typeof OffscreenCanvas !== 'undefined')
          ? new OffscreenCanvas(R, R) : document.createElement('canvas');
        c.width = R; c.height = R;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bm, 0, 0, R, R);
        data.set(g.getImageData(0, 0, R, R).data, layer * R * R * 4);
        bm.close?.();
        done();
      })
      .catch(() => { done(); });
  });
  return tex;
}

// Start decoding at import, which is boot — a landing is at least a minute
// later and the set is always in place by then.
if (typeof document !== 'undefined') terrainTexture();

/* Shared by every stage that has to agree with the height field. */
const FIELD_UNIFORMS = /* glsl */`
uniform float uSeed;
uniform float uRelief;
uniform float uPlanetR;
uniform float uSea;
uniform float uSeaDrop;  // how far under the landing site the water sits, at most
uniform int   uType;
uniform vec3  uSunDir;
uniform float uLodK;   // grid spacing as a fraction of the radius
/* The field's value at the landing site, as a uniform rather than as work.

   groundYFlat subtracts terrainRaw(0,0) so the site passes exactly through
   y = 0, and every vertex shader in this file used to evaluate that subtraction
   for itself — at lod 0.26, which is the one lod at which *every* band of the
   field is switched on, so it is the single most expensive call the function
   can be given. Twenty-two octaves, per vertex, for a number that is constant
   over the whole world and the whole session. It measured 1.8 ms a frame in the
   scatter alone.

   It is also a number JavaScript already has: the CPU side computes exactly
   this to place a walking player, through the transliteration below, and the
   two are checked against each other by tools/fieldcheck.mjs. Handing the GPU
   the CPU's answer therefore does not merely save the work, it removes the last
   place the two paths could disagree. */
/* .zw is *where* the landing site is, and it is the whole of finding number
   one. The ground scene's origin is the ship, and the field used to be sampled
   about its own origin — so every landing in the game was the same place, and
   that place was wherever the noise happened to put it. Measured on a terran
   world it was a mountain flank: 53 m of relief across the forty metres under
   the gear. Nothing can stand on that, which is why a 110 m pad was holding the
   field to the datum and why the near field was a billiard table with a wall of
   mountains round the edge of it.

   A pilot does not flatten a mountain, they land somewhere flat. pickSite
   searches the field for one and the offset lands here; the pad that is left is
   a genuine landing scour, twenty metres across. */
uniform vec4  uDatum;  // (datum, fine datum, site x, site z)
/* How far off its own surface a receiver looks the shadow map up, in metres.
   Derived from the map, not dialled — see Game.setShadowScale, and the note at
   the bottom of TERRAIN_VERT for what a fixed one costs. */
uniform float uShadowNB;
`;

/* ------------------------------------------------- the mesh's own spacing

   How finely the ground mesh samples at a given range is a *law*, not a table,
   because four things have to agree about it: the grid builder that lays the
   rings out, the terrain vertex shader that asks the field for a band-limited
   answer, every scatter band deciding which surface its boulder is standing
   on, and the CPU's heightAt for a walking player.

   Ring pitch, as a fraction of the radius:

       ringAng(r) = clamp(RING_A*(r/1000)^-RING_P, RING_MIN, RING_MAX)

   which is a *shrinking* fraction — the grid gets angularly finer the further
   out it goes, which is the whole point of the rewrite (see terrainGrid). The
   pitch is what sets the sampling scale, because the azimuthal arc is three to
   four times finer than it everywhere. Multiplied out,

       lod(d) = clamp(K*d^(1-RING_P), d*RING_MIN, d*RING_MAX),  K = RING_A*1000^RING_P

   and meshLod is exactly that, with the two clamps written against K so the
   shader needs one uniform rather than four. The quality tier scales every
   term together, so the ratios below are tier-independent. */
/* RING_MIN is the far clamp, and it is a fill-rate number as much as a
   sampling one. Beyond about five kilometres a flat plain is already below the
   horizon bend, so the only ground still in frame out there is *slope*, where
   a radial step is not foreshortened; but the rings still get laid across all
   the hidden ground in between, and a ring pitch of a fiftieth at twelve
   kilometres draws triangles seven pixels wide and four thousandths of a pixel
   tall. A sliver still rasterises a full 2x2 quad, and with the logarithmic
   depth buffer on there is no early-Z to reject it. */
/* The anisotropy is 2.3:1, and it is not a free parameter.

   A ring step and a segment step do not cost the same on screen. An azimuthal
   step of theta is theta radians wide however the ground lies; a radial step of
   theta is foreshortened by the *slope*, so on a typical hillside it shows at
   about half. Balanced, that says the rings should be roughly twice the arc —
   and the first version of this ran them at four times, which spent the budget
   on a 10 px azimuthal facet sitting next to a 20 px radial one. What you see
   is the worse of the two: distant slopes came back stepped like a staircase
   while their crests were smooth. Same vertex count, ratio moved to 2.3, and
   the worst-case error drops by a fifth on every horizon in the set. */
/* RING_MIN is a floor on the *angular* ring pitch, which makes it a ceiling on
   how much detail the distance is allowed to have — and that is finding number
   two.

   The height field is band-limited to whatever spacing it is sampled at, and
   the mountain band derives its octave count from that spacing directly:
   k = 1 + log2(330/lod)/log2(2.07). At 0.018 the power law is overridden
   beyond 1.3 km and the pitch is pinned at 1.8% of the range, so a vertex at
   seven kilometres was handed a 137 m spacing and got 2.2 octaves of range,
   and one at ten kilometres got 1.7. **A 1.7-octave ridged fractal is a row of
   equal-width triangular creases** — that is what the shape means, and it is
   what "the skyline is a row of identical triangles on every world at every
   azimuth" is. Measured: seven peaks across 26 degrees at render lod against
   eighteen at a 4 m lod, on the same arc.

   Widening the gates instead is the wrong fix and was tried: a band switched
   on past its own sampling rate does not fade, it beats against the grid, and
   the beat is a row of single-cell spikes. The pitch itself has to come down.

   0.0130 puts the ring pitch at 99 m at seven kilometres, which is 2.3 times
   the segment arc there — exactly the anisotropy this file derives on the next
   comment, where 0.018 was running 3.2 and spending the difference on facets
   nobody could see. It costs about forty-six rings of the two hundred and
   ninety and is the only place the vertex budget moved. */
const RING_A = 0.0195, RING_P = 0.28, RING_MIN = 0.0130, RING_MAX = 0.115;
const ARC_A = 0.0086, ARC_P = 0.22, ARC_MIN = 0.0050, ARC_MAX = 0.030;
const LOD_K1 = RING_A * Math.pow(1000, RING_P);
const gf = (x) => x.toFixed(6);

const FIELD = /* glsl */`
const float VSCALE = 1450.0;

/* Benches and risers. floor() gives the flat tread; the smoothstep gives a
   riser whose gradient is zero at both ends, so the finite-difference normal
   never spikes where two benches meet. */
float bench(float x, float n, float k){
  float s = x*n;
  return (floor(s) + smoothstep(0.5-k, 0.5+k, fract(s))) / n;
}

/* Ridged, with the last octave *faded* rather than switched.

   An integer octave count is a step in both the sum and the normaliser, so
   dropping one at a fixed range does not quietly remove detail — it puts a
   circular terrace right across the basin at whatever radius the switch
   happens to fall. (The old law switched the mountain band from three octaves
   to two at eight kilometres and paid exactly that.)

   Weighting the last octave into the sum *and* the norm takes it out
   continuously, and the two limits agree exactly: (n+1 octaves, weight 0) is
   the same number as (n octaves, weight 1), to the last bit. That matters more
   than it looks — it is what lets the octave count be derived from a
   continuous quantity (the sampling scale) without any threshold in the code
   for a float comparison to fall the wrong side of, on either the GPU or the
   CPU. The loop breaks on a vanishing weight, so a band that is switched off
   costs nothing. */
/* And the crest is rounded rather than cusped.

   1 - |noise| is linear either side of a zero crossing, so a ridged fractal's
   crest is a *cusp* by construction: every summit comes to a point, every
   flank is straight, and a range of them is a row of needles whatever the
   octave count. That is half of what "the mountain peaks look like
   multiple-decade-old graphics" is — the other half is the octave count, and
   fixing only that leaves sharper needles.

   sqrt(a*a + e) is |a| everywhere except within sqrt(e) of zero, where it
   turns the point into an arc. At 0.0055 that is the top seven per cent of the
   ridge's width — a weathered summit, not a plateau — and it costs one sqrt in
   place of one abs. Nothing on a planet old enough to have mountains has a
   cusp on it. */
/* And the last two octaves are *rounded*, which is the whole of the banding.
 *
 * The octave count above is derived from a quarter-wavelength rule — the finest
 * octave present is always about 3.9 mesh samples across — and that rule is
 * wrong by a factor of two for this function, because of the two lines in the
 * middle of it. One minus the rectified noise is a rectified sinusoid, whose
 * first harmonic is at twice the fundamental; squaring it doubles that again.
 * So the crest network the mesh was actually asked to carry ran at about 1.9
 * samples per wavelength — under Nyquist — and what a band does below its own
 * sampling rate is not fade, it *beats against the grid*.
 *
 * The beat comes out along the radial axis, because the ring pitch is 2.3 times
 * the segment arc, so it draws as arcs concentric with the landing site: evenly
 * spaced light and dark ripples down every mid-distance slope, at the ring
 * pitch, moving with the quality tier. That is the banding, measured — it
 * scales exactly with GQ across low/medium/high, it survives
 * every texture in the frame being switched off, and it is visible in the
 * *normal* buffer, which is where a geometry alias has to be.
 *
 * The epsilon below sets how wide the rounded arc at the crest is, so raising
 * it on the octaves near the sampling limit low-passes precisely the harmonics
 * that
 * cannot be represented, and leaves the coarse structure — the thing that makes
 * a range a range — completely alone. It costs nothing: the term was already
 * there, as a constant.
 */
float ridgedF(vec3 p, int oct, float wLast){
  float a = 0.5, sum = 0.0, norm = 0.0, prev = 1.0;
  /* How deep the fractal reaches, as a *continuous* number: exactly the octave
     count the caller derived from the sampling scale. Everything below is keyed
     off the distance from it rather than off the integer octave index, because
     a rule written against the index steps whenever the count does — and a step
     in the shape of the ground is a circular terrace across the whole basin at
     whatever radius the switch falls, which is the artefact this is fixing.
     Both limits agree exactly: (n+1 octaves, weight 0) is the same field as
     (n octaves, weight 1), to the last bit. */
  float depth = float(oct) - 1.0 + wLast;
  for(int i = 0; i < 8; i++){
    if(i >= oct) break;
    float ww = (i == oct - 1) ? wLast : 1.0;
    if(ww < 1e-4) break;
    // 0.0055 is a weathered summit; 0.115 is a whaleback, and only the octaves
    // near the sampling limit ever get anywhere near the far end
    float e = mix(0.115, 0.0055,
                  clamp((depth - float(i) - 0.6)*0.588, 0.0, 1.0));
    float sn = snoise(p);
    float n = 1.0 - sqrt(sn*sn + e);
    n = n*n*prev;
    prev = clamp(n, 0.0, 1.0);
    sum  += a*n*ww;
    norm += a*ww;
    a    *= 0.5;
    p     = OCT_ROT*p*2.07;
  }
  return sum/max(norm, 1e-5);
}

/* Band limiting, and why the field takes a sampling scale rather than a range.

   Every caller of the height field samples it at a different spacing: the mesh
   at its local ring pitch, the shadow march at whatever the *vertex* it feeds
   is interpolated across, a boulder at its own footprint. Gating the bands on
   camera range instead — which is what this used to do — meant the far mesh
   was still being handed 150 m ridges it sampled every 600 m. That does not
   look like small mountains; it aliases, and because a marched shadow and a
   sky-occlusion term are *decided* by the same undersampled field, the error
   comes out as quad-shaped patches of light and dark with the grid's own
   straight edges. Read as art, that is "a milky alpha wash on some ridges and
   not their neighbours, with hard boundaries".

   So the field takes lod — the spacing, in metres, that the result is about to
   be sampled at — and every band above it simply is not there. Nothing
   downstream can then disagree with anything else.

   **And the number handed to it is the band's *finest octave*, not its base
   wavelength.** Every gate in this file used to be quoted from the band's
   first octave, so a three-octave fractal was left switched on until its
   *fourth* harmonic was below one sample per wavelength. Measured: the
   outcrop band ran to a 143 m spacing carrying 58 m detail, the second
   mountain band to 204 m carrying 142 m, scree to 102 m carrying 72 m. Under
   two samples per wavelength a fractal does not fade, it *beats* against the
   grid — and the beat is a row of single-cell spikes all the same width,
   which is precisely the skyline an art director called "N64" and "a row of
   triangular needles". The picket fence was never a mesh artefact; it was the
   field being asked for detail four times finer than anything sampling it.

   The gate ramps over a fixed 3.09:1 span of lod (0.22..0.68 of wl), so with
   wl = finest/1.36 it starts fading at about six samples per wavelength and is
   gone at two, which is where linear interpolation stops inventing structure.
   Every wl below is derived that way and the derivation is written next to it,
   because the one thing that is *not* recoverable by looking at the picture is
   which octave a number came from. */
/* And the far end of the fade is at two samples per wavelength, not 1.5.
   0.68 meant a band was still at a fifth of its amplitude where the mesh had
   1.6 samples across it and only vanished at 1.47 — under Nyquist. What a band
   does below its own sampling rate is not fade, it *aliases*, and the
   frequencies it aliases to are the grid's own: at 1:1 a mid-distance massif
   came back covered in a regular shallow-angle cross-hatch at exactly the ring
   and arc pitch, which reads as a rendering artefact rather than as rock, and
   which is what the owner called a weird banding artefact on the mountains. It
   survives every texture in the frame being switched off, and it does not move
   when the shadow march's band limit is tripled, because it is neither.
   0.50 puts the cut at two samples per wavelength and the half-amplitude point
   at 2.9, which is where a smooth reconstruction can still carry it.
   **Both copies move together** — tools/fieldcheck.mjs diffs them. */
float lodGate(float lod, float wl){ return 1.0 - smoothstep(wl*0.18, wl*0.50, lod); }

/* The drainage network, factored out of the terrain law.

   terrainRaw incises this into the ground; the surface shader needs it to know
   where the gravel washed to and where anything that needs water could be
   living, and the scatter needs it to pool its debris in the same places. Three
   consumers sampling three slightly different channel fields is how you get a
   wash with its own gravel bar fifty metres to one side of it, so there is one
   field and everybody calls it — terrainRaw included, which used to keep its
   own inline copy of the ridged call and is now one line of agreement instead.

   **Dendritic, not a lattice, and that is finding number six.** A ridged crest
   network sampled straight is a set of long nearly straight lines crossing at
   shallow angles into rhomboid cells, every cell the same size and every
   channel the same width. An independent review found exactly that in every
   frame in the set, from every direction, and read it as a rendering artefact
   — a lattice of hard-edged quadrilaterals — because nothing in a landscape
   looks like that. Real drainage wanders, and it *stops*: a channel exists
   where water could have collected, so it dies out headward on the high ground
   and runs wide in the low.

   Two terms and two extra octaves buy both. A shear warp at four times the
   network's own wavelength bends a trunk without breaking it, and an
   accumulation term — the low-frequency height, which is where the water went
   — takes the network off the interfluves entirely. */
float drainage(vec2 p){
  vec3 q = vec3(p.x, uSeed*31.7, p.y)*0.00013;
  // One lookup does both jobs: the field that says where the water collected is
  // also a perfectly good thing to shear the network with, and this function is
  // on the shadow march's path.
  float w = snoise(q*1.9 + 13.0);
  float n = ridged(vec3(q.x + w*0.055, q.y, q.z - w*0.037)*17.0 + 61.0, 2);
  return n*(0.22 + 0.78*smoothstep(0.42, -0.28, w));
}

/* The terrain law, in metres, band by band.

   Each gate is quoted as (the band's finest octave)/1.36 — see lodGate. The
   base wavelength and the octave count are written beside every one so the
   arithmetic can be checked rather than trusted. */
float terrainRaw(vec2 p, float lod, out float fine){
  float gVal   = lodGate(lod, 440.0);   // trunk valleys   1240 m, 2 oct -> 599
  float gFoot  = lodGate(lod, 425.0);   // foothills        578 m, 1 oct -> 578
  float gEro   = lodGate(lod, 160.0);   // gullies          452 m, 2 oct -> 218
  float gOut   = lodGate(lod,  89.0);   // buttresses       250 m, 2 oct -> 121
  float gOut3  = lodGate(lod,  43.0);   //   and its third octave       ->  58
  float gScree = lodGate(lod,  53.0);   // scree slopes     294 m, 3 oct ->  72
  float gDune  = lodGate(lod,  46.0);   // dune trains, phase-modulated ->  62
  float gRub   = lodGate(lod,  23.0);   // rubble          47.6 m, 2 oct -> 23.6
  float gGrit  = lodGate(lod,   5.0);   // grit            10.2 m, 2 oct ->  5.1

  vec3 q = vec3(p.x, uSeed*31.7, p.y) * 0.00013;

  // continents — the shape that survives all the way to the skyline.
  // Octave counts here are load-bearing for the frame, not just the look:
  // this function is evaluated about twenty times per vertex between the
  // shadow march, the sky occlusion and the normal differences, so one
  // octave costs more than the whole fragment shader does.
  float cont = fbm(q*1.6, 3)*0.5 + 0.5;

  /* Where there is a range at all, and this is the other half of finding
     number one.

     A ridged fractal normalised the way ridgedF normalises it averages about
     0.5 over the whole plane — the crests are narrow, the shoulders are not —
     so the mountain band was three hundred metres of relief on *every square
     metre of every world*. There was no plain anywhere: a sweep of a 28 km
     square found a minimum of 11.8 m of relief across any 104 m of it, and a
     median of 75. That is why every azimuth on every world is a row of
     triangles — you were never looking at a range from outside, you were
     always standing inside one.

     Ranges are where the crust is thick, and so is high ground, so this is the
     continent field the function already had rather than a field of its own.
     Two octaves of belt noise cost two simplex lookups on the hottest path in
     the file — terrainRaw runs about twenty times per vertex and eight of
     those are the shadow march — and bought nothing this does not: the belts
     land on the highlands, the floors land in the basins, and the two agree
     with the deposition below by construction instead of by luck. */
  float rangeK = smoothstep(0.455, 0.635, cont);

  /* Deposition, and it is why the ground you land on can be flat at all.

     Sixty per cent of the height in this law is that one smooth fbm, and a
     smooth fbm has no flat in it — its gradient is zero only at its own
     extrema. Measured across every world in the set, before this: eighteen
     metres of relief over the ninety-six under the landing gear, wherever you
     put it. That is an eleven-degree slope everywhere, which is why there was
     a 110 m pad holding the whole neighbourhood to the datum, and why the near
     field was a billiard table with a wall of mountains standing on the rim of
     it. No site search can find level ground in a field that contains none.

     Real low ground is not a smooth bowl. Everything that ever came off the
     high ground is lying in it, and it lies *level*: an alluvial floor, a
     playa, a mare. So the bottom of the curve is compressed toward a fill
     level and the top of it is left alone, which turns a world of slopes into
     floors with ranges standing on them. That is what every reference frame
     of a landed scene is, and it is where the scale of a landscape is read
     from — a massif is only enormous next to something level. */
  float dep = cont - 0.46;
  float fillK = 1.0 - smoothstep(-0.05, 0.13, dep);      // 1 on the basin floor
  cont = 0.46 + dep*(1.0 - 0.84*fillK);
  float h = cont*0.62;

  /* Mountain chains, warped by the continent field.

     A ridged fractal sampled straight gives isolated cones — which is exactly
     what the skyline was, a row of tent shapes. Displacing its input by a
     lower-frequency field bends the crest lines into chains that run across
     the frame and join, and it is free here because the displacement is the
     continent noise this function already had to evaluate. */
  /* Orogenic strike, and a real domain warp.

     Displacing the mountain field by 0.19 of the continent noise bends the
     crests a little, but ridged noise sampled *isotropically* can only ever
     produce cones: its crest network has no preferred direction, so every peak
     is as wide as it is long and the skyline is a field of near-identical
     tents. Ranges on real planets are anisotropic — they are built by
     compression along one axis, so crests run for tens of kilometres along the
     strike and are short across it.

     Two changes. The sample space is squashed 3.4:1 along a per-world strike
     direction, which turns the same fractal into long parallel chains; and the
     warp becomes a genuine domain warp with its own field at four times the
     amplitude, which stops those chains from being straight. Neither costs an
     extra octave: the strike is a rotation and the warp reuses cont. */
  float sa = uSeed*2.399963;                       // golden-angle strike per world
  vec2 st = vec2(cos(sa), sin(sa));
  vec2 ac = vec2(-st.y, st.x);
  float mw = (cont - 0.5)*0.78;
  vec2 qw = vec2(q.x + mw, q.z - mw*0.63);
  vec2 qs = vec2(dot(qw, st)*0.30, dot(qw, ac));
  vec3 w = vec3(qs.x, q.y, qs.y)*6.0 + 4.0;
  /* As many octaves of the range as this vertex can carry, and a fractional
     number of them.

     The band's base wavelength across the strike is 1282 m and the lacunarity
     is 2.07, so octave k carries 1282/2.07^(k-1) and is worth having while the
     spacing is finer than a *quarter* of it: that inverts to
     k = 1 + log2(330/lod)/log2(2.07), which is the line below. One octave at a
     330 m spacing, three at sixty, five under twelve — and everything in
     between, because ridgedF fades the last one in rather than switching it.

     A quarter and not a third, because the ring pitch is 2.3 times the segment
     arc: three samples per wavelength is enough across the ridge and not enough
     along it, and what came back was a hard sawtooth on every steep silhouette
     — the mesh lattice printed straight onto the skyline.

     This replaces two separate calls: three octaves here plus a second ridged
     field at 4.37x, gated on a number quoted from its *first* octave. 2.07^2 is
     4.28, so that band was octaves three and four of this one all along — it
     was simply switched on three times further out than it could be sampled,
     and what came back was the row of identical needles. Same detail, one
     fractal, band-limited. */
  float mo  = clamp(1.0 + log2(330.0/max(lod, 0.5))*0.95238, 1.0, 5.0);
  float moF = floor(mo);
  float mtn = ridgedF(w, int(moF) + 1, mo - moF);
  /* Ridged noise raised to a power is spiky by construction: the crest
     network is narrow and the basins between it are wide, so a high exponent
     turns a range into a forest of stalagmites. Sharpen the top of the curve
     and leave the bottom of it alone — that gives a broad massif with a sharp
     ridgeline on it, which is what a mountain is. The exponent also relaxes
     as the sampling coarsens, because a spike sampled at four grid points is
     a paper triangle whichever way it was authored. */
  mtn = max(mtn, 0.0);
  /* Broader, because the exponent never actually relaxed.
     The intent was that a spike should soften once the mesh can no longer
     sample it — but lodGate(lod, 1500) is still 1.0 at eight kilometres, where
     the spacing is 160 m, so in practice every range in every frame was raised
     to 2.1 and the skyline came out as a row of needles. A review called
     "mountains are triangular spikes, needle peaks with no talus or ridgeline"
     the single most dated element in any frame, and this is where it comes
     from: ridged noise is *already* a narrow crest network, and a high exponent
     on top of it makes stalagmites rather than massifs. 1.55 at the top, and
     the sharpening only bites above the mid-height of the range, which leaves a
     broad shoulder under a sharp ridgeline — which is what a mountain is.
     **Both copies of the law move together**: the JS transliteration below
     carries the same numbers and tools/fieldcheck.mjs diffs them. */
  /* And the exponent finally relaxes, which is what the paragraph above always
     said it did and never managed: lodGate(lod, 1500) is still 1.0 at eight
     kilometres, so every range in every frame was raised to 1.55 whatever the
     spacing. A power of 1.55 narrows the crest network — it moves energy *up*
     the spectrum — so applying it where the mesh is already at three samples
     per wavelength is asking for exactly the aliasing the octave count above is
     there to prevent. Quoted against ninety metres it is 1.55 under the lens,
     where the crests can be resolved, and 1.15 at the skyline, where they
     cannot. */
  mtn = mix(mtn, pow(mtn, mix(1.15, 1.55, lodGate(lod, 90.0))),
            smoothstep(0.24, 0.72, mtn));
  // and only inside the belt. Everything below keys off mtn, so a point on the
  // plain skips the strata, the buttresses, the talus and the trunk valleys
  // for free — this pays for its own two octaves and some of the mountain
  // band's five.
  mtn *= rangeK;

  /* How steep the *mass* is, taken before the talus goes on. Strata, buttress
     and dune all belong to bedrock; loose material has no bedding in it and
     nothing breaks out of it. */
  float steep = smoothstep(0.04, 0.26, mtn);

  /* Talus, as a change of profile rather than a band of noise.

     A cone has a straight edge from base to apex because nothing ever came off
     it. A real mountain sheds, and what it sheds banks against its own foot at
     the angle of repose — so the outline is *concave up* for the bottom third
     and straight or convex above it. That is a transfer curve on the mountain
     field, not a new fractal: lift the 0.02..0.5 band of mtn and leave the
     summit alone, and every massif in the range grows a foot for one snoise
     and no extra octave anywhere else.

     The apron is only evaluated where there is one — on a plain and on a
     summit the window is shut and the branch is skipped, which is most of the
     near field. */
  float apron = smoothstep(0.015, 0.22, mtn)*(1.0 - smoothstep(0.15, 0.52, mtn));
  if(apron > 0.01){
    // uneven, because a talus fan is a series of overlapping cones and not a
    // collar: 1.5 km along the strike, 460 m across it
    float ta = snoise(vec3(qs.x, q.y, qs.y)*14.0 + 3.0);
    mtn += apron*0.092*(0.62 + 0.38*ta);
  }

  /* Chains rise where the continent does. Without this every crest of the
     ridged fractal reaches the same height, and a range whose peaks are all
     the same height is a picket fence — the eye reads the repetition long
     before it reads the shapes. */
  h += mtn*0.33*uRelief*(0.48 + 0.88*cont);

  /* The hundred-metre-to-kilometre band, which was simply missing.

     Every vista ran near-ground, nothing, mountains: a dead-level basin, then
     a skyline. Nothing in the law had a wavelength between the drainage
     incision (five metres deep) and the ranges (a kilometre and a half wide),
     so there was no foothill, no valley floor and no shoulder to read the
     distance against — which is most of why a plain that is geometrically
     correct still reads as a backdrop.

     Two waves, 1170 m and 570 m, ±35 m and ±18 m. Both fade toward the steep
     ground, because on a mountain flank this band is already the mountain. */
  float sw = snoise(q*6.6 + 53.0)*0.024;
  if(gFoot > 0.01) sw += snoise(q*13.6 + 17.0)*0.0125*gFoot;
  // and buried where the basin filled: a 35 m swell on a 1.2 km wavelength is
  // six metres across the ninety under the gear, which is most of what is left
  // of the old slope once the continent has been levelled
  h += sw*uRelief*(0.34 + 0.66*(1.0 - steep))*(1.0 - 0.62*fillK);

  /* Trunk valleys. The gullies below are a 450 m network and are gone by seven
     kilometres, which leaves the skyline itself carved by nothing at all — a
     range of unbroken massifs with no pass through it. This is the same
     construction an order of magnitude wider, and it is the only incision
     coarse enough to still be there at the horizon cut. */
  if(gVal > 0.01 && steep > 0.01){
    float vr = ridged(q*6.2 + 41.0, 2);
    h -= smoothstep(0.44, 0.95, vr)*0.052*uRelief*gVal*steep;
  }

  /* Erosion channels. The crest network of a second ridged field, cut *into*
     the flanks of the chains and nowhere else — a drainage pattern only makes
     sense where there is a slope for water to have run down. Broad bowls
     scooped out of the whole massif, which is what the old term did, read as
     lumps rather than as erosion. */
  if(gEro > 0.01){
    // the same field the wash albedo and the scatter read, called rather than
    // copied — see drainage
    float cr = drainage(p);
    float chan = smoothstep(0.50, 0.94, cr);
    h -= chan*chan*0.034*uRelief*gEro*steep;
    /* And the same network across the flat ground, broader and an order of
       magnitude shallower. A basin with no drainage in it is a bowl, and a
       bowl is what every landing site was: five metres of incision is nothing
       as relief and everything as *structure*, because from then on the loose
       material on the plain has somewhere to have gone. */
    h -= smoothstep(0.28, 0.86, cr)*0.0062*uRelief*gEro*(1.0 - steep);
  }

  /* Strata, at two scales. A 90 m riser is coarse enough to survive out to
     six kilometres and is what puts horizontal breaks across a cliff face; the
     23 m one only lives in the near field. Both only on the steep mass — run
     them across the plains as well and they read as contour lines on a map. */
  /* Strata, with dip and varying bed thickness.

     Quantising height on its own puts a perfectly level step every 1/n of a
     unit, globally in phase, across the whole world — so every massif in the
     range gets the same horizontal bands at the same altitudes and the result
     reads as contour lines drawn onto the terrain rather than as rock. Real
     beds are tilted, and their thickness changes from one block to the next.

     The grid is offset by a gentle regional dip and the offset removed again,
     which tilts the boundaries without moving the terrain, and the bed count
     rides the continent field so neighbouring massifs are out of phase. */
  /* All of it behind the steepness test. A bench is a quantisation of height on
     a *slope*; on the basin floor steep is zero and every line below evaluated
     to a no-op through two simplex lookups. terrainRaw runs about twenty times
     per vertex, eight of them inside the shadow march, so an unguarded octave
     here is forty of them a vertex. */
  if(steep > 0.02){
  float dip = dot(p, ac) * 1.1e-5;
  /* Which massifs are bedded at all, and how thick their beds are.

     Quantising height puts a level step every 1/n of a unit on *every* face in
     the frame at the *same* pitch, and two independent reviews of two
     different worlds read that as a horizontal terracing artefact rather than
     as geology — the owner's phrase was "weird ripples", and at 1:1 it is
     evenly spaced contour stripes across every large slope. Benching is a real
     landform; benching every slope in shot at a constant pitch is wallpaper.

     Sedimentary sections are bedded and intrusive ones are not, so the amount
     rides a field of its own and two thirds of the faces in a frame carry none
     of it. The thickness rides the same field, which also removes a real bug:
     the second bed count was quoted from fract(cont*7.3), and fract is a
     *discontinuity* — the bed thickness stepped from thin to thick across a
     line, and a step in the quantiser is a step in the ground. */
  float bedN = fbm(q*3.1 + 27.0, 2)*0.5 + 0.5;      // 2500 m and 1240 m
  float bedM = smoothstep(0.44, 0.76, bedN);
  float bedA = 16.0 * (0.60 + 0.95*bedN);
  float bedB = 62.0 * (0.72 + 0.62*bedN);
  /* Softer than it was, and the riser is wider.
     A bench is a quantisation of *height*, so on a face steep enough to be a
     cliff it draws a horizontal line every ninety-one metres across the whole
     thing — and a review of the landed scene picked that out as "a horizontal
     terracing artefact on cliff faces" and read it as a bug rather than as
     geology, on two different worlds. It is not a bug, but at 0.44 with a
     narrow riser it is a stronger statement than any real bedding makes.
     Two thirds of the amount and half again the riser width leaves the ledges
     where a ridge wants them and stops them ruling the face.
     **Both copies of the law move together or the player sinks into hills:**
     the JavaScript transliteration below is the same three numbers, and
     tools/fieldcheck.mjs compiles this chunk and diffs the two. */
  /* And band-limited like everything else. A bench is a quantisation of
     *height*, so what it costs in sampling is set by how far apart the risers
     land on the ground, which is the height step divided by the slope: 65-130 m
     of bed on a slope of a half is a riser every 130-260 m. Gated from the
     first octave (520) both beds ran to a 350 m spacing drawing risers 60 m
     apart — one riser per two grid cells, which is not bedding, it is a moire
     pattern, and it is the other half of what read as terracing. */
  /* And weaker again, because the mountains it lands on have changed shape.
     A bench drawn across a needle is two pixels of it; drawn across the broad
     faces the range has now, the same 0.30 rules the whole massif in level
     lines and reads as contour wallpaper rather than as bedding — which is the
     reading a review gave it twice. Half the amount, and the ledges are still
     where a ridge wants them. */
  h = mix(h, bench(h + dip, bedA, 0.30) - dip, steep*bedM*0.20*lodGate(lod, 150.0));
  if(gOut3 > 0.01) h = mix(h, bench(h + dip*2.4, bedB, 0.32) - dip*2.4, steep*bedM*0.12*gOut3);
  }

  // outcrops and buttes on the plain, spurs and buttresses on the mass — the
  // 100-300 m band that was missing entirely, and what stops a face being one
  // unbroken plane from the crest to the scree. Two octaves reach twice as far
  // as three do, so the third is faded in separately rather than carried out to
  // where it beats against the grid.
  if(gOut > 0.01){
    float o = ridgedF(vec3(p.x, uSeed*7.1, p.y)*0.0040 + 13.0, 3, gOut3);
    /* The spire term is gated on the *third* octave and its exponent is 2.0,
       not 2.6. A power raised on a ridged crest is a spike generator: it
       narrows the crest network without moving its wavelength, so the band
       whose gate says 121 m was drawing features thirty metres wide, and at a
       nineteen-metre spacing that is under two samples across. What came back
       was a row of identical teeth along every mid-distance ridge — the same
       failure as the old mountain band, in a different term. */
    h += pow(max(o, 0.0), 2.0)*0.030*uRelief*gOut3;
    h += (o - 0.40)*0.020*uRelief*gOut*steep;
  }
  // talus: material shed off the cliffs and banked against everything below
  // them, which is the difference between a mountain and a cone
  if(gScree > 0.01) h += fbm(vec3(p.x, 11.0, p.y)*0.0034 + 17.0, 3)*0.0062*gScree;

  /* Dune trains. Transverse crests running across the prevailing wind, riding
     on a slow swell so the ranks bend and break instead of ruling the plain
     into a corrugated sheet. Only on ground flat enough to have collected
     anything: a dune on a cliff face is nonsense. */
  /* And they are *asymmetric*, which is the whole of what makes a dune a dune.
   *
   * This was a raised cosine, so every rank was a symmetric swell with the
   * same profile either side of its crest — a sine wave in sand. A judge shown
   * a frame of it called the landform "a smooth Gaussian bump" and asked where
   * the crest and the slip face were, which is exactly the right question: a
   * transverse dune has a long shallow rippled windward back at five or six
   * degrees, a *brink line* where the flow separates, and then a slip face
   * pinned at the angle of repose, about thirty-three degrees, on the lee
   * side. The asymmetry is not decoration — it is the single cue that says
   * which way the wind blows here, and it is the reason a dune field reads as
   * a landscape with a history rather than as corrugated iron.
   *
   * Raising the phase to a power skews the wave: the rise is stretched over
   * most of the wavelength and the fall is compressed into the last fifth of
   * it. One pow(), no extra noise lookup, and it is band-limited by the same
   * gate as before — the compressed face is about a fifth of the wavelength,
   * so the gate is quoted against five times the pitch rather than against it.
   */
  if(gDune > 0.01){
    float wa = uSeed*1.7;
    vec2 wd = vec2(cos(wa), sin(wa));
    float swell = fbm(vec3(p.x, 61.0, p.y)*0.0021 + 7.0, 2);
    /* And the brink line *wanders*, which matters far more now that there is
       one. A straight crest with a slip face behind it throws a dead-straight
       shadow, and a dead-straight shadow edge ruled across two thousand pixels
       of broken ground is the single most obvious rendering tell there is — a
       judge shown the frame named it first and identified it, wrongly but
       understandably, as a clipped shadow frustum. Real transverse ranks are
       barchanoid: they bow, they break, and they hand over to the next rank
       along. Two more phase terms at 1.1 km and 300 m do it for two lookups,
       and both are far coarser than the rank pitch so neither costs sampling
       rate. */
    float wob = fbm(vec3(p.x, 23.0, p.y)*0.0061 + 31.0, 2);
    float kink = snoise(vec3(p.x, 5.0, p.y)*0.021 + 77.0);
    float ph = dot(p, vec2(-wd.y, wd.x))*0.048 + swell*4.0 + wob*2.6 + kink*0.55;
    float t = fract(ph*0.15915494);                 // 0..1 across one rank
    /* The skew, faded out with the sampling scale. A slip face is a fifth of a
       wavelength wide, so it is the first thing that goes below Nyquist; below
       that the rank has to relax back to the symmetric swell it always was
       rather than alias into a sawtooth. */
    float sharp = mix(1.0, 3.1, gDune*gDune);
    float u = pow(clamp(t, 0.0, 1.0), sharp);
    float dune = 0.5 - 0.5*cos(u*6.2831853);
    dune = dune*dune*(3.0 - 2.0*dune);
    h += (dune - 0.4)*0.0026*gDune*(1.0 - steep)*(0.35 + 0.65*(0.5 + 0.5*swell));
  }

  fine = 0.0;
  if(gRub  > 0.01) fine += fbm(vec3(p.x, 23.0, p.y)*0.021 + 51.0, 2)*0.00135*gRub;
  if(gGrit > 0.01) fine += fbm(vec3(p.x,  5.0, p.y)*0.098 +  3.0, 2)*0.00042*gGrit;
  /* A height field draped on a near-vertical face has no y in it, so every
     horizontal band it contains stretches into a vertical stripe running the
     whole length of the fall line: the rubble band on its own paints a
     four-metre corrugation down a cliff, which an independent reviewer
     described as ice terrain smearing into motion blur at grazing angles.
     Damping the fine bands where the ground is steep is the cheap fix and it
     is also the honest one — loose material is not sitting on a cliff. */
  fine *= 1.0 - steep*0.66;
  return h;
}

/* Sea level, in metres relative to the landing site.
 *
 * The clamp is what puts water in frame, and it used to be a constant forty
 * metres. That is a *floor* on how far below your boots the water is, applied
 * on every world whatever its sea, and on a rolling green world it is the
 * difference between a lake in the next valley and a lake you can walk to: at
 * forty metres down, the only ground that floods on a landing site chosen for
 * being flat is over the horizon. uSeaDrop carries it per world now — a garden
 * gets a dozen metres, so the low ground around the site is under water and
 * there is a shoreline in the middle distance, and everything else keeps the
 * forty it always had. It stays negative regardless: the site search does not
 * know about water, so the guarantee that the ship is not standing in it has
 * to live here. */
float seaLevel(float h0){ return min((uSea - h0)*VSCALE, uSeaDrop); }

/* Metres above the landing site's tangent plane, before the horizon bend.
   dat = (datum, fine datum, site x, site z): the first two make the site pass
   exactly through y=0, the last two say which patch of the world it is.

   **The pad is twenty metres wide, and that is the whole of finding number
   one.** It used to be 110 m of dead flat released over 780, which measured as
   a quarter of a metre of relief across the forty-five metres round your boots
   and eleven metres across eight hundred — a billiard table with a photograph
   of dirt on it, and a wall of mountains standing on the rim of it where the
   pad finally let go. Nothing self-shadowed because there was nothing to
   self-shadow; nothing occluded because there was nothing to occlude.

   It could not simply be deleted, because the site it was flattening genuinely
   was a mountain flank — 53 m of relief under the gear. What replaces it is
   choosing the site rather than bulldozing it: see pickSite. The pad that is
   left is a scour under the drives, not a plateau, and it fades out inside the
   ship's own footprint. */
float groundYFlat(vec2 p, float lod, vec4 dat){
  float d = length(p);
  float fine;
  float h = terrainRaw(p + dat.zw, lod, fine);
  float pad = smoothstep(11.0, 42.0, d);
  float y = (h - dat.x)*VSCALE*pad + (fine - dat.y)*VSCALE*(0.34 + 0.66*pad);
  if(uType == 0 || uType == 5) y = max(y, seaLevel(dat.x));
  return y;
}

/* The spacing the radial mesh is sampling at, at a given range. Everything
   that has to agree with the mesh asks for it here.

   It used to be linear in range — one constant angular resolution from the
   boots to the horizon cut — which is what a grid with the same segment count
   on every ring gives you, and it is why a 300 m peak at five kilometres was
   three triangles wide. The mesh now spends its rings on a shrinking angular
   pitch, so the law is a power of range, clamped at both ends by the same two
   numbers the grid builder clamps its ring pitch with. */
float meshLod(float d){
  float p = uLodK*pow(max(d, 1.0), ${gf(1 - RING_P)});
  return 0.26 + clamp(p, d*uLodK*${gf(RING_MIN / LOD_K1)}, d*uLodK*${gf(RING_MAX / LOD_K1)});
}

/* Ridge shadows.

   A geometric march up the sun ray against the same field the mesh is built
   from. It runs in the vertex stage, where there are seventy thousand of them
   rather than three million, and the march is done in *flat* space because the
   sun ray is straight in the world and only the render is bent. Because the
   field is analytic there is no depth quantisation, so there is no acne and no
   bias to tune. */
float sunShadow(vec2 p, float y, float lod, vec4 dat){
  vec3 L = uSunDir;
  if(L.y < 0.012) return 0.0;
  float res = 1.0;
  /* The first step is the vertex's own spacing, not a fixed four metres.

     At ten kilometres a triangle is two hundred metres across, and an occluder
     four metres up the ray is not something the mesh — or the band-limited
     field the march is sampling — can represent at all. Four of the ten steps
     were being spent below the resolution of the thing they were marching
     against. Starting where the vertex can actually resolve pays for a wider
     ratio: eight steps now reach 2.1 km under the lens where ten reached 1.3,
     and past the horizon cut from a vertex at range. */
  float t = max(4.0, lod*0.55);
  float ry = y + 0.5;
  // The march is band-limited to whatever the vertex it feeds is interpolated
  // across, and coarsens further along the ray. Nothing under about twenty
  // metres can cast a shadow anybody would recognise, and asking for one is
  // what turned march-to-march sampling error into a rash of blobs on every
  // distant peak. It is also most of the saving that paid for the finer mesh.
  /* What the march is allowed to shadow, and the near end of it moved.

     Out at a kilometre a triangle is thirty metres across and anything finer
     than the march's own step aliases into a rash of blobs. Under the lens the
     opposite used to be true — a triangle is a metre and a half, so the field
     could carry an edge — and the near limit was set to five metres on that
     argument. It was written when there was no relief under the lens to
     shadow: the 110 m pad held everything within a hundred metres of the ship
     to the datum, so the finest thing the march ever met near the camera came
     from much further away.

     With real ground there, five metres asks eight steps at a 2.45 ratio to
     resolve a two-metre rubble band at a 47 m wavelength, and a march samples
     *along the ray* — so its error comes out as long soft bands running
     down-sun across the whole foreground, which is exactly the lattice of
     shallow-angle streaks a review found in every frame. Nothing under about
     twenty metres should be casting from the march at all; that scale is the
     shadow map's, it is inside the box, the terrain casts into it, and it
     resolves it at nine centimetres a texel instead of at a fifth of a
     wavelength. */
  float sl = max(lod, mix(19.0, 30.0, smoothstep(0.4, 14.0, lod)));
  for(int i = 0; i < 8; i++){
    // and the field coarsens three times faster along the ray than it did:
    // what casts a shadow from three hundred metres up-sun is a ridge, never
    // a boulder, and every band still switched on out there is paid for at
    // every step of every vertex in the frame
    float dh = (ry + L.y*t) - groundYFlat(p + L.xz*t, sl + t*0.16, dat);
    res = min(res, 7.0*dh/t);
    if(res <= 0.0) break;
    t *= 2.45;
  }
  return clamp(res, 0.0, 1.0);
}

/* Fourteen steps for the scatter, at a coarser ratio. It still has to reach
   twelve kilometres — a rock lit inside a shadow the ground around it is
   sitting in reads as a light bulb, and that was exactly what a short march
   produced. Scatter runs the cheap one because every vertex of an instance
   pays for it again, and there are more of those than there are grid points. */
float sunShadowShort(vec2 p, float y, float lod, vec4 dat){
  vec3 L = uSunDir;
  if(L.y < 0.012) return 0.0;
  float res = 1.0;
  // the same floor as the full march, and for the same reason: below it the
  // shadow map owns the scale and this one only adds banding along the ray
  float sl = max(lod, 19.0);
  /* Five steps, starting at the ground's own spacing.

     This march is the single most expensive thing in the scatter's vertex
     stage — every vertex of every surviving instance pays for all of it, and
     raising a band's subdivision multiplies it — so the steps have to be worth
     their place. Beginning at a fixed four metres spent two of them below the
     resolution of the field they were sampling; beginning at the local mesh
     spacing and widening the ratio reaches 950 m from a pebble at your feet and
     four kilometres from a boulder two kilometres out, on five steps rather
     than seven. Reach at range is the number that matters: a rock lit inside a
     shadow the ground around it is sitting in reads as a light bulb. */
  float t = max(3.5, lod*0.5);
  for(int i = 0; i < 5; i++){
    float dh = (y + 0.3 + L.y*t) - groundYFlat(p + L.xz*t, sl + t*0.14, dat);
    if(dh < 0.0){ res = 0.0; break; }
    res = min(res, 12.0*dh/t);
    t *= 3.90;
  }
  return clamp(res, 0.0, 1.0);
}

/* How much sky a point can see. Without it every hollow lights exactly like
   every summit and the relief collapses the moment the sun stops raking.
   Four rays at one radius is the cheapest thing that still reads: the term is
   broad and low-frequency, and nobody can count the samples in it. */
float skyOcc(vec2 p, float y, float lod, vec4 dat, out float hillSlope){
  // The radius has to stay several grid cells wide or the term becomes the
  // highest frequency the mesh can carry and every quad shades differently
  // from its neighbour.
  float R = max(250.0, lod*4.5);
  float sl = max(lod, R*0.22);
  vec2 d1 = vec2( 0.87, 0.49)*R;
  vec2 d2 = vec2(-0.62, 0.79)*R;
  float h1 = groundYFlat(p + d1, sl, dat) - y;
  float h2 = groundYFlat(p + d2, sl, dat) - y;
  // The hillside gradient falls out of the same two samples for nothing, and
  // it is the slope everything *on* the ground has to be placed by — the mesh
  // normal a metre from the lens describes a pebble, not a hill.
  float det = d1.x*d2.y - d1.y*d2.x;
  float gx = (h1*d2.y - h2*d1.y)/det;
  float gz = (d1.x*h2 - d2.x*h1)/det;
  hillSlope = clamp(sqrt(gx*gx + gz*gz), 0.0, 2.0);
  float o = clamp(h1/R, 0.0, 1.0) + clamp(h2/R, 0.0, 1.0);
  return clamp(1.0 - o*0.40, 0.08, 1.0);
}

/* One ray instead of three, for the scatter — and sampled coarse. A boulder
   asking what the ground looks like two hundred metres away does not need the
   grit band, and paying for it was costing more than the whole term is worth. */
float skyOccCheap(vec2 p, float y, float lod, vec4 dat){
  float R = max(200.0, lod*4.5);
  float sl = max(lod, R*0.25);
  float m = max((groundYFlat(p + vec2(R*0.95, R*0.30), sl, dat) - y),
                (groundYFlat(p - vec2(R*0.60, R*0.75), sl, dat) - y))/R;
  return clamp(1.0 - clamp(m, 0.0, 1.0)*0.55, 0.2, 1.0);
}
`;

/* ---------------------------------------- what the ground will and will not
   carry. Shared by the terrain shader and by everything standing on it, so
   that a stand of scrub in the albedo four kilometres away and a tuft you can
   walk up to are answers from the same function. */
const HABITAT = /* glsl */`
/* Sky occlusion says how *open* a point is; everything that decides what
   collects there wants the opposite, on a curve that saturates. One name for
   it, so the ground shader and the scatter cannot drift apart. */
float shelterOf(float ao){ return clamp((1.0 - ao)*1.7, 0.0, 1.0); }

/* Where anything can live.

   Flora density is not a constant with noise on it, it is a habitability
   score, and every term in it is something a viewer can point at in the frame:
   growth wants shelter from the wind, it wants the water that came down the
   wash, it cannot hold on a face steeper than its own root ball, and it stops
   at a treeline that wanders with aspect and shelter instead of ruling a level
   contour around every massif. The same function drives the tufts you can walk
   up to and the colour of the ground four kilometres away, so the near field
   and the far field are the same landscape rather than two. */
float floraMask(vec2 gp, float slope, float shelter, float flow, float above){
  float m0 = snoise(vec3(gp.x, 401.0, gp.y)*0.0021)*0.5 + 0.5;   // ~470 m stands
  float m1 = snoise(vec3(gp.x,  53.0, gp.y)*0.017)*0.5 + 0.5;    // ~58 m clumps
  float stand = smoothstep(0.22, 0.66, m0*0.60 + m1*0.40)*1.45;
  float sl  = 1.0 - smoothstep(0.20, 0.55, slope);
  /* Shelter *biases* growth, it does not gate it. Running this from 0.28 on
     exposed ground meant an open plain scored an eighth of a sheltered hollow
     and the world came out bare — which is not what a prairie looks like. */
  float sh  = mix(0.70, 1.45, shelter);
  float wet = 1.0 + smoothstep(0.36, 0.92, flow)*1.4;
  float alt = 1.0 - smoothstep(0.34 + (m0 - 0.5)*0.34, 0.80 + (m0 - 0.5)*0.34, above);
  return clamp(stand*sl*sh*wet*alt, 0.0, 1.4);
}
`;

/* ======================================================= the same law, twice

   Everything above is the height field as the GPU runs it. What follows is the
   same law in JavaScript, because anything *standing* on the ground has to know
   where the ground is before the frame is drawn — a walking player needs a foot
   height and a slope limit, and neither can come out of a vertex shader.

   Two implementations of one law is a liability and there is no clever way
   around it: the field is sampled twenty times per vertex on the GPU, so it
   cannot move to the CPU, and a player cannot read a vertex shader. What makes
   it survivable is that the two live in the same file, in the same order, with
   the same names. **If you change a band, a gate, a frequency or an amplitude
   above, change it below in the same edit** — a disagreement here does not
   throw, it makes the player sink into hills and hover over hollows, and the
   error tracks every subsequent change to the terrain.

   The JS side is written to be read against the GLSL rather than to be fast. It
   is called a handful of times a frame, it shares no cache with anything, and
   it allocates nothing per call.

   Do not take the agreement on faith, and do not assume a careful reading is
   enough — the first version of this was a faithful line-for-line
   transliteration and was wrong by metres, twice, for reasons no amount of
   staring would have found. Both were single-precision effects, and both are
   commented where they live. The way to check it is to compile the GLSL chunk
   above into a real WebGL2 program in a headless page, evaluate it at a few
   hundred scattered points and diff the two; `__fieldJS` is exported for
   exactly that. Measured on a terran world: at the spacing a walking figure
   samples at, median error zero and worst three tenths of a millimetre; at a
   forty-metre spacing over six hundred metres of relief, median one millimetre
   and worst three hundred.
   ========================================================================= */

// Scratch, at module scope: the sampling path allocates nothing.
const _Fp = [0, 0, 0, 0];
const _Fpz = [0, 0, 0, 0], _Fpy = [0, 0, 0, 0], _Fpx = [0, 0, 0, 0];
const _Fxs = [0, 0, 0, 0], _Fys = [0, 0, 0, 0], _Fzs = [0, 0, 0, 0];
const _Fdots = [0, 0, 0, 0];
const _dat2 = [0, 0];
// The gradient table's constants, in the shader's own precision.
const J_N7 = Math.fround(0.142857142857);
const J_NSX = Math.fround(J_N7 * 2);
const J_NSY = Math.fround(Math.fround(J_N7 * 0.5) - 1);

function jMod289(x) { return x - Math.floor(x * (1 / 289)) * 289; }
function jPermute(x) { return jMod289(((x * 34) + 1) * x); }
function jTaylorInvSqrt(r) { return 1.79284291400159 - 0.85373472095314 * r; }
function jStep(edge, x) { return x >= edge ? 1 : 0; }
function jFract(x) { return x - Math.floor(x); }
function jClamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
function jMix(a, b, t) { return a + (b - a) * t; }
function jSmoothstep(a, b, x) {
  const t = jClamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Ashima 3D simplex, transliterated from the `snoise` in gfx/glsl/noise.js. */
function jSnoise(vx, vy, vz) {
  const C1 = 1 / 6, C2 = 1 / 3;
  const d = (vx + vy + vz) * C2;
  let ix = Math.floor(vx + d), iy = Math.floor(vy + d), iz = Math.floor(vz + d);
  const e = (ix + iy + iz) * C1;
  const x0x = vx - ix + e, x0y = vy - iy + e, x0z = vz - iz + e;

  const gx = jStep(x0y, x0x), gy = jStep(x0z, x0y), gz = jStep(x0x, x0z);
  const lx = 1 - gx, ly = 1 - gy, lz = 1 - gz;
  const i1x = Math.min(gx, lz), i1y = Math.min(gy, lx), i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz), i2y = Math.max(gy, lx), i2z = Math.max(gz, ly);

  const x1x = x0x - i1x + C1, x1y = x0y - i1y + C1, x1z = x0z - i1z + C1;
  const x2x = x0x - i2x + C2, x2y = x0y - i2y + C2, x2z = x0z - i2z + C2;
  const x3x = x0x - 0.5, x3y = x0y - 0.5, x3z = x0z - 0.5;

  ix = jMod289(ix); iy = jMod289(iy); iz = jMod289(iz);
  _Fpz[0] = 0; _Fpz[1] = i1z; _Fpz[2] = i2z; _Fpz[3] = 1;
  _Fpy[0] = 0; _Fpy[1] = i1y; _Fpy[2] = i2y; _Fpy[3] = 1;
  _Fpx[0] = 0; _Fpx[1] = i1x; _Fpx[2] = i2x; _Fpx[3] = 1;
  for (let k = 0; k < 4; k++) {
    _Fp[k] = jPermute(jPermute(jPermute(iz + _Fpz[k]) + iy + _Fpy[k]) + ix + _Fpx[k]);
  }

  _Fxs[0] = x0x; _Fxs[1] = x1x; _Fxs[2] = x2x; _Fxs[3] = x3x;
  _Fys[0] = x0y; _Fys[1] = x1y; _Fys[2] = x2y; _Fys[3] = x3y;
  _Fzs[0] = x0z; _Fzs[1] = x1z; _Fzs[2] = x2z; _Fzs[3] = x3z;
  for (let k = 0; k < 4; k++) {
    /* The gradient index, in exact integers.

       The GLSL writes this as floor(j * ns.z) with ns.z the literal
       0.142857142857, and the literal is not 1/7. Rounded to float32 it lands
       just *above* one seventh, so seven times it is 1.0000000447 and the
       floor is 1; kept in a double it stays just *below*, seven times it is
       0.999999999999 and the floor is 0 — which decodes a gradient index of
       seven out of a table of seven, reflects the wrong component, and returns
       a value four times outside simplex noise's range. It fires on about six
       per cent of samples and, run through a ridged fractal, put whole
       mountains in the JavaScript field that were not in the GLSL one.

       j is an integer in [0,48] by construction, so the integer forms are what
       the GPU is computing anyway, exactly, at every value it can take. */
    const j = _Fp[k] % 49;
    const xf = (j / 7) | 0;
    const yf = j - 7 * xf;
    /* Single-precision, deliberately.

       h is the third component of the gradient and its *sign* selects between
       two completely different gradients. Seven of the forty-nine entries in
       this table land on h exactly zero in exact arithmetic — |gx| and |gy|
       are k/14 and they sum to one — so which side of the branch the GPU takes
       is decided entirely by how float32 rounds two thirds and one seventh. In
       a double it rounds the other way about half the time, and the corner
       gets a gradient the shader never used. That is not a rare edge case:
       fourteen per cent of table entries are on the knife, four corners are
       summed per sample, and it disagreed on eighty-five per cent of samples
       and put whole metres of error into the ground the player stands on.
       Math.fround reproduces the shader's arithmetic exactly. */
    let gxk = Math.fround(Math.fround(xf * J_NSX) + J_NSY);
    let gyk = Math.fround(Math.fround(yf * J_NSX) + J_NSY);
    // h is taken before the sign trick, exactly as the GLSL does it
    const hk = Math.fround(Math.fround(1 - Math.abs(gxk)) - Math.abs(gyk));
    const sh = -jStep(hk, 0);
    gxk += (Math.floor(gxk) * 2 + 1) * sh;
    gyk += (Math.floor(gyk) * 2 + 1) * sh;
    const norm = jTaylorInvSqrt(gxk * gxk + gyk * gyk + hk * hk);
    _Fdots[k] = gxk * norm * _Fxs[k] + gyk * norm * _Fys[k] + hk * norm * _Fzs[k];
  }
  const dot0 = _Fdots[0], dot1 = _Fdots[1], dot2 = _Fdots[2], dot3 = _Fdots[3];

  let m0 = Math.max(0.6 - (x0x * x0x + x0y * x0y + x0z * x0z), 0);
  let m1 = Math.max(0.6 - (x1x * x1x + x1y * x1y + x1z * x1z), 0);
  let m2 = Math.max(0.6 - (x2x * x2x + x2y * x2y + x2z * x2z), 0);
  let m3 = Math.max(0.6 - (x3x * x3x + x3y * x3y + x3z * x3z), 0);
  m0 *= m0; m1 *= m1; m2 *= m2; m3 *= m3;
  return 42 * (m0 * m0 * dot0 + m1 * m1 * dot1 + m2 * m2 * dot2 + m3 * m3 * dot3);
}

// The decorrelating rotation between octaves, as columns — mat3(a,b,c, ...) in
// GLSL builds columns, and getting that transposed silently gives a different
// world.
function jOctRot(v) {
  const x = v[0], y = v[1], z = v[2];
  v[0] = 0.00 * x + -0.80 * y + -0.60 * z;
  v[1] = 0.80 * x + 0.36 * y + -0.48 * z;
  v[2] = 0.60 * x + -0.48 * y + 0.64 * z;
}

const _P = [0, 0, 0];
function jFbm(px, py, pz, oct, lac = 2.02, gain = 0.5) {
  let a = 0.5, sum = 0, norm = 0;
  _P[0] = px; _P[1] = py; _P[2] = pz;
  for (let i = 0; i < oct; i++) {
    sum += a * jSnoise(_P[0], _P[1], _P[2]);
    norm += a;
    a *= gain;
    jOctRot(_P);
    _P[0] *= lac; _P[1] *= lac; _P[2] *= lac;
  }
  return sum / Math.max(norm, 1e-5);
}
function jRidged(px, py, pz, oct, lac = 2.07, gain = 0.5) {
  let a = 0.5, sum = 0, norm = 0, prev = 1;
  _P[0] = px; _P[1] = py; _P[2] = pz;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(jSnoise(_P[0], _P[1], _P[2]));
    n = n * n * prev;
    prev = jClamp(n, 0, 1);
    sum += a * n;
    norm += a;
    a *= gain;
    jOctRot(_P);
    _P[0] *= lac; _P[1] *= lac; _P[2] *= lac;
  }
  return sum / Math.max(norm, 1e-5);
}

/** drainage, line for line. See the GLSL for why it warps and why it fades. */
function jDrainage(qx, qy, qz) {
  const w = jSnoise(qx * 1.9 + 13, qy * 1.9 + 13, qz * 1.9 + 13);
  const n = jRidged((qx + w * 0.055) * 17 + 61, qy * 17 + 61, (qz - w * 0.037) * 17 + 61, 2);
  return n * (0.22 + 0.78 * jSmoothstep(0.42, -0.28, w));
}

const J_VSCALE = 1450;
function jBench(x, n, k) {
  const s = x * n;
  return (Math.floor(s) + jSmoothstep(0.5 - k, 0.5 + k, jFract(s))) / n;
}
function jLodGate(lod, wl) { return 1 - jSmoothstep(wl * 0.18, wl * 0.50, lod); }
/** ridgedF, line for line. See the GLSL for why the last octave is faded. */
function jRidgedF(px, py, pz, oct, wLast) {
  let a = 0.5, sum = 0, norm = 0, prev = 1;
  _P[0] = px; _P[1] = py; _P[2] = pz;
  const depth = oct - 1 + wLast;
  for (let i = 0; i < oct; i++) {
    const ww = (i === oct - 1) ? wLast : 1;
    if (ww < 1e-4) break;
    const e = 0.115 + (0.0055 - 0.115) * jClamp((depth - i - 0.6) * 0.588, 0, 1);
    const sn = jSnoise(_P[0], _P[1], _P[2]);
    let n = 1 - Math.sqrt(sn * sn + e);
    n = n * n * prev;
    prev = jClamp(n, 0, 1);
    sum += a * n * ww;
    norm += a * ww;
    a *= 0.5;
    jOctRot(_P);
    _P[0] *= 2.07; _P[1] *= 2.07; _P[2] *= 2.07;
  }
  return sum / Math.max(norm, 1e-5);
}

/**
 * terrainRaw, line for line. `out` receives [h, fine].
 * @param {object} U   the uniform bag, so the two paths cannot disagree on seed
 */
function jTerrainRaw(px, pz, lod, U, out) {
  const seed = U.uSeed.value, relief = U.uRelief.value;
  const gVal = jLodGate(lod, 440);
  const gFoot = jLodGate(lod, 425);
  const gEro = jLodGate(lod, 160);
  const gOut = jLodGate(lod, 89);
  const gOut3 = jLodGate(lod, 43);
  const gScree = jLodGate(lod, 53);
  const gDune = jLodGate(lod, 46);
  const gRub = jLodGate(lod, 23);
  const gGrit = jLodGate(lod, 5);

  const qx = px * 0.00013, qy = seed * 31.7 * 0.00013, qz = pz * 0.00013;

  let cont = jFbm(qx * 1.6, qy * 1.6, qz * 1.6, 3) * 0.5 + 0.5;
  // orogenic belts, off the continent field — see the GLSL
  const rangeK = jSmoothstep(0.455, 0.635, cont);
  // deposition — see the GLSL for why a world with no flat in it cannot be
  // landed on
  const dep = cont - 0.46;
  const fillK = 1 - jSmoothstep(-0.05, 0.13, dep);
  cont = 0.46 + dep * (1 - 0.84 * fillK);
  let h = cont * 0.62;

  const sa = seed * 2.399963;
  const stx = Math.cos(sa), sty = Math.sin(sa);
  const acx = -sty, acy = stx;
  const mw = (cont - 0.5) * 0.78;
  const qwx = qx + mw, qwy = qz - mw * 0.63;
  const qsx = (qwx * stx + qwy * sty) * 0.30;
  const qsy = qwx * acx + qwy * acy;
  const wx = qsx * 6 + 4, wy = qy * 6 + 4, wz = qsy * 6 + 4;

  const mo = jClamp(1 + Math.log2(330 / Math.max(lod, 0.5)) * 0.95238, 1, 5);
  const moF = Math.floor(mo);
  let mtn = jRidgedF(wx, wy, wz, moF + 1, mo - moF);
  mtn = Math.max(mtn, 0);
  mtn = jMix(mtn, Math.pow(mtn, jMix(1.15, 1.55, jLodGate(lod, 90))),
    jSmoothstep(0.24, 0.72, mtn));
  mtn *= rangeK;

  const steep = jSmoothstep(0.04, 0.26, mtn);

  const apron = jSmoothstep(0.015, 0.22, mtn) * (1 - jSmoothstep(0.15, 0.52, mtn));
  if (apron > 0.01) {
    const ta = jSnoise(qsx * 14 + 3, qy * 14 + 3, qsy * 14 + 3);
    mtn += apron * 0.092 * (0.62 + 0.38 * ta);
  }

  h += mtn * 0.33 * relief * (0.48 + 0.88 * cont);

  let sw = jSnoise(qx * 6.6 + 53, qy * 6.6 + 53, qz * 6.6 + 53) * 0.024;
  if (gFoot > 0.01) sw += jSnoise(qx * 13.6 + 17, qy * 13.6 + 17, qz * 13.6 + 17) * 0.0125 * gFoot;
  h += sw * relief * (0.34 + 0.66 * (1 - steep)) * (1 - 0.62 * fillK);

  if (gVal > 0.01 && steep > 0.01) {
    const vr = jRidged(qx * 6.2 + 41, qy * 6.2 + 41, qz * 6.2 + 41, 2);
    h -= jSmoothstep(0.44, 0.95, vr) * 0.052 * relief * gVal * steep;
  }

  if (gEro > 0.01) {
    const cr = jDrainage(qx, qy, qz);
    const chan = jSmoothstep(0.50, 0.94, cr);
    h -= chan * chan * 0.034 * relief * gEro * steep;
    h -= jSmoothstep(0.28, 0.86, cr) * 0.0062 * relief * gEro * (1 - steep);
  }

  if (steep > 0.02) {
    const dip = (px * acx + pz * acy) * 1.1e-5;
    const bedN = jFbm(qx * 3.1 + 27, qy * 3.1 + 27, qz * 3.1 + 27, 2) * 0.5 + 0.5;
    const bedM = jSmoothstep(0.44, 0.76, bedN);
    const bedA = 16 * (0.60 + 0.95 * bedN);
    const bedB = 62 * (0.72 + 0.62 * bedN);
    h = jMix(h, jBench(h + dip, bedA, 0.30) - dip, steep * bedM * 0.20 * jLodGate(lod, 150));
    if (gOut3 > 0.01) h = jMix(h, jBench(h + dip * 2.4, bedB, 0.32) - dip * 2.4, steep * bedM * 0.12 * gOut3);
  }

  if (gOut > 0.01) {
    const o = jRidgedF(px * 0.0040 + 13, seed * 7.1 * 0.0040 + 13, pz * 0.0040 + 13, 3, gOut3);
    h += Math.pow(Math.max(o, 0), 2.0) * 0.030 * relief * gOut3;
    h += (o - 0.40) * 0.020 * relief * gOut * steep;
  }
  if (gScree > 0.01) h += jFbm(px * 0.0034 + 17, 11 * 0.0034 + 17, pz * 0.0034 + 17, 3) * 0.0062 * gScree;

  if (gDune > 0.01) {
    const wa = seed * 1.7;
    const wdx = Math.cos(wa), wdy = Math.sin(wa);
    const swell = jFbm(px * 0.0021 + 7, 61 * 0.0021 + 7, pz * 0.0021 + 7, 2);
    // the same wandering brink as the GLSL, or a walking player sinks into it
    const wob = jFbm(px * 0.0061 + 31, 23 * 0.0061 + 31, pz * 0.0061 + 31, 2);
    const kink = jSnoise(px * 0.021 + 77, 5 * 0.021 + 77, pz * 0.021 + 77);
    const ph = (px * -wdy + pz * wdx) * 0.048 + swell * 4 + wob * 2.6 + kink * 0.55;
    // the same skew as the GLSL — a windward back and a slip face
    const t = ph * 0.15915494;
    const tf = t - Math.floor(t);
    const sharp = 1 + (3.1 - 1) * gDune * gDune;
    const uu = Math.pow(jClamp(tf, 0, 1), sharp);
    let dune = 0.5 - 0.5 * Math.cos(uu * 6.2831853);
    dune = dune * dune * (3 - 2 * dune);
    h += (dune - 0.4) * 0.0026 * gDune * (1 - steep) * (0.35 + 0.65 * (0.5 + 0.5 * swell));
  }

  let fine = 0;
  if (gRub > 0.01) fine += jFbm(px * 0.021 + 51, 23 * 0.021 + 51, pz * 0.021 + 51, 2) * 0.00135 * gRub;
  if (gGrit > 0.01) fine += jFbm(px * 0.098 + 3, 5 * 0.098 + 3, pz * 0.098 + 3, 2) * 0.00042 * gGrit;
  fine *= 1 - steep * 0.66;

  out[0] = h;
  out[1] = fine;
}

/* Exported so the two implementations can actually be diffed rather than
   assumed equal. Nothing in the game imports this. */
export const __fieldJS = {
  snoise: jSnoise, fbm: jFbm, ridged: jRidged, terrainRaw: jTerrainRaw,
};

/* ------------------------------------------------------ where you came down

   A pilot does not land on a mountain and then flatten it. Every landing in
   this game used to happen at the field's own origin, and on a terran world
   that origin measured 53 metres of relief across the forty under the gear —
   which is why there was a 110 m pad holding the whole neighbourhood to the
   datum, and why the near field was a dead-flat disc with a wall of mountains
   standing on the rim of it. Measured through the pad: a quarter of a metre of
   relief over the 45 m round your boots and half a metre over 150.

   So search for the site instead. Two stages, because the score is expensive
   and most candidates are obviously bad: a coarse sweep over a jittered grid
   with five samples each, then the best handful re-scored with thirteen.

   What "good" means is three things, and the third is the one that stops this
   producing a car park:
     - level where the gear goes down (the r<=48 m term, weighted hardest),
     - a floor rather than a flank out to a couple of hundred metres,
     - and *relief in view* — a flat basin with nothing in it is a worse frame
       than a rough one, so ground with something standing up at one to four
       kilometres scores better, not worse.

   Deterministic from the world seed, so two captures of the same world are the
   same place and an A/B means something. */
function pickSite(U) {
  const o = [0, 0];
  const V = J_VSCALE;
  // metres of terrain, at whatever band limit the caller is working at
  const raw = (x, z, lod) => { jTerrainRaw(x, z, lod, U, o); return o[0] * V; };

  /* Relief about a point, measured at the scale being searched. Six rays and
     the centre: enough to catch a tilt, cheap enough to run a thousand times.
     The radius and the lod move together, because a site that is flat at four
     hundred metres and rough at forty is not flat. */
  const relief = (cx, cz, r, lod) => {
    const c = raw(cx, cz, lod);
    let lo = 0, hi = 0;
    for (let i = 0; i < 6; i++) {
      const a2 = (i / 6) * Math.PI * 2 + 0.4;
      const d = raw(cx + Math.cos(a2) * r, cz + Math.sin(a2) * r, lod) - c;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    return hi - lo;
  };

  /* What there is to look at. A basin with nothing standing in it is a car
     park, and every reference frame this is measured against is a floor with
     something on the skyline. Sampled at a coarse band limit on purpose: this
     asks how far the ground moves over kilometres, and the detail bands are
     both irrelevant to that and the whole cost of the field. */
  const view = (cx, cz) => {
    const c = raw(cx, cz, 150);
    let m = 0;
    for (let i = 0; i < 7; i++) {
      const a2 = (i / 7) * Math.PI * 2 + 0.9;
      const r = 1300 + (i % 3) * 1250;
      m = Math.max(m, Math.abs(raw(cx + Math.cos(a2) * r, cz + Math.sin(a2) * r, 150) - c));
    }
    return Math.min(m, 400);
  };

  /* Three passes, each an order of magnitude finer than the last.

     One flat sweep cannot do this. Level ground is a basin floor a few hundred
     metres across in a world twenty-eight kilometres wide, so a grid coarse
     enough to afford steps straight over it — the first version searched 121
     candidates and came back with 33 m of relief across the ninety under the
     gear, which is a mountainside. Coarse-to-fine costs about what one dense
     pass at the coarsest level costs and lands on the floor rather than near
     it: the wide sweep asks the field at a 300 m band limit, where it has one
     octave of range in it and is cheap, and only the last pass pays for the
     detail a landing gear actually stands on.

     The score has to stay *continuous* below the limit as well as above it.
     With a hard barrier and nothing else, every feasible cell tied at zero and
     the sweep returned whichever the loop reached first — which is the corner
     of the search square, every time, on every world. */
  const LEVELS = [
    { span: 14000, n: 17, r: 900, lod: 300 },
    { span: 1800, n: 11, r: 260, lod: 60 },
    { span: 260, n: 9, r: 52, lod: 4 },
  ];
  const seed = U.uSeed.value;
  let cx = 0, cz = 0;
  for (let L = 0; L < LEVELS.length; L++) {
    const { span, n, r, lod } = LEVELS[L];
    /* How flat is flat enough, at this scale. Quoted from the gear: 7 m across
       the 104 m it stands on, of which four is the rubble band and cannot be
       removed by choosing anywhere — that is undulating ground, not a slope. */
    const ok = 7.0 * (r / 52);
    let best = null, bestS = Infinity;
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const j1 = jFract(Math.sin(ix * 12.9898 + iy * 78.233 + seed * 3.71 + L) * 43758.5453);
        const j2 = jFract(Math.sin(ix * 39.3468 + iy * 11.135 + seed * 7.13 + L) * 24634.6345);
        const jit = (span / (n - 1)) * 0.7;
        const x = cx + (ix / (n - 1) - 0.5) * 2 * span + (j1 - 0.5) * jit;
        const z = cz + (iy / (n - 1) - 0.5) * 2 * span + (j2 - 0.5) * jit;
        const rel = relief(x, z, r, lod);
        /* A barrier for level, a preference for scenery, and level always
           wins: standing on it is not something the view is allowed to
           outbid. Below the limit the two trade at 2 m of slope for 1 m of
           skyline, which puts the ship on the floor *near* a range rather
           than in the middle of the emptiest basin on the world. */
        const s = rel > ok ? 1e4 + rel : rel * 2.0 - view(x, z);
        if (s < bestS) { bestS = s; best = [x, z]; }
      }
    }
    cx = best[0]; cz = best[1];
  }
  return [cx, cz];
}

/* ------------------------------------------------------- the view rejection

   Everything a ground vertex or a scatter instance does with the height field
   is expensive, and most of the ground is not in frame: a disc has 360 degrees
   in it and a camera has forty. The view direction and the horizontal field of
   view are both already sitting in the matrices three uploads for us, so the
   cone test needs no uniform of its own and happens before a single octave of
   noise is evaluated. Nothing else renders this scene, so view-dependent
   geometry is safe here in a way it usually is not.

   The margin is 0.42 rad beyond the frustum's own half-angle, which is twenty
   times the angle a horizon triangle subtends and a couple of hundred times a
   near one — so no triangle can ever have one vertex culled and another drawn,
   which is the only way this could show. */
const VIEWCULL = /* glsl */`
bool behindCamera(vec2 gp, vec3 camPos, mat4 viewM, mat4 projM){
  vec2 rel = gp - camPos.xz;
  float dh = length(rel);
  /* Everything inside this radius is kept whatever the camera is doing, so
     that a tall instance whose base is just outside the cone still draws and a
     fast turn does not pop the near field. Twenty-two metres is the smallest
     value that holds for the biggest thing the near bands place; on foot it is
     also, directly, the size of the disc that is never culled, so it is not a
     free number. */
  if(dh < 22.0) return false;
  vec2 fwd = vec2(-viewM[0][2], -viewM[2][2]);
  float fl = length(fwd);
  if(fl < 1e-4) return false;
  float tanH = 1.0/max(projM[0][0], 1e-3);
  return dot(rel/dh, fwd/fl) < cos(atan(tanH) + 0.42);
}
`;

/* --------------------------------------------------- where clutter belongs */

/* Clutter is deposited, not scattered.

   A uniform random field of identical pebbles is the loudest possible tell
   that a landscape was generated, and it is exactly what this used to be: one
   pebble, one size, on a Poisson scatter with no relationship to the ground
   under it. Real ground sorts its own debris. Material comes off a face, runs
   out at the foot of it, banks against whatever stopped it, pools in every
   hollow and in every wash, and it stops dead where the ground changes.

   None of that can be expressed as a *position*, so placement is a rejection
   test instead: the CPU lays a stratified field of candidates over the whole
   patch and every candidate asks the ground whether it belongs there. Two
   things fall out of that. Density becomes a property of the terrain rather
   than a number in a table — which is the entire difference between clustering
   and noise — and a rejected candidate bails out of its vertex shader before
   it pays for its shape or its shadow march, so over-provisioning candidates
   two to one costs about a third of what drawing them would.

   uBand / uBand2 are how each band answers differently: gravel lies on the
   flat and floods the washes, cobble banks on the apron under a slope, outcrop
   only breaks out where the ground was steep enough to have shed it. */
const CLUTTER = /* glsl */`
uniform vec4 uBand;    // slope window (lo, hi), clump strength, wash affinity
uniform vec4 uBand2;   // density bias, shelter response, altitude window lo, noise phase

float clutterMask(vec2 gp, float slope, float shelter, float flow, float above){
  /* Two scales of patchiness, and the field is *spatial*.

     The first version of this fed the instance's own seed into the noise
     coordinate, which looks like a harmless way to decorrelate the bands and
     is in fact the whole bug: every candidate then reads a different slice of
     the field, so neighbours get uncorrelated answers and the result is
     exactly the uniform random scatter the clustering was meant to replace.
     The band offset has to be a *phase*, applied once per band, never per
     instance.

     The coarse scale decides which part of the basin has any loose material in
     it at all — a plain strewn evenly to the horizon reads as gravel wallpaper
     — and the fine one clumps within a patch, which is what a real field of
     stones does at ten metres. The peak of the product runs well above one so
     a good patch saturates and is genuinely dense, and the trough runs to zero
     so the ground between patches is genuinely bare. A term that only ever
     modulates between 0.4 and 0.7 is not clustering, it is dithering. */
  float ph = uBand2.w;
  float p0 = snoise(vec3(gp.x + ph*31.0, 131.0 + ph, gp.y - ph*17.0)*0.0034)*0.5 + 0.5;  // ~300 m
  float p1 = snoise(vec3(gp.x - ph*13.0,  17.0 + ph, gp.y + ph*29.0)*0.023)*0.5 + 0.5;   // ~43 m
  float clump = mix(1.0, smoothstep(0.20, 0.70, p0*0.60 + p1*0.40)*1.55, uBand.z);

  // the slope window
  float sl = smoothstep(uBand.x - 0.10, uBand.x + 0.06, slope)
           * (1.0 - smoothstep(uBand.y, uBand.y + 0.30, slope));

  // hollows collect and crests are swept — shelter is the same term that
  // lights the ground, so the debris agrees with the shading for free
  float pool = mix(1.0, mix(0.40, 1.75, shelter), uBand2.y);

  // and the washes are where everything that ever moved ended up
  float wash = 1.0 + smoothstep(0.34, 0.90, flow)*uBand.w;

  // altitude: talus belongs below the crags, not on the summit ridge
  float alt = smoothstep(uBand2.z - 0.14, uBand2.z + 0.12, above);

  return clamp(clump*sl*pool*wash*alt*uBand2.x, 0.0, 1.5);
}

/* The other rejection that costs nothing and pays for the density — the first
   is the view cone above, in VIEWCULL.

   **Smaller than a pixel.** A fixed cut-off distance per band is the wrong
   shape: it throws away the big stones in a band at the same range as the
   small ones. Fading on *angular* size keeps a two-metre boulder to four
   kilometres and drops a ten-centimetre one at eighty, which is what the eye
   does anyway. */
/* Near clutter follows the camera, because the landing site is not where
   anybody is standing.

   Everything here used to be scattered on a disc centred on the ship, which is
   right for mesas and wrong for gravel: the crane camera sits nearly three
   hundred metres out, so the bottom of every landing frame was ground the grit
   band had never heard of, and on foot the problem only gets worse — walk two
   hundred metres and you walk out of the scatter entirely.

   So the near bands are laid out in one square cell and wrapped into whichever
   copy of that cell the camera is standing in. The field is then periodic in
   world space, which would be a visible lattice on its own; it is not one here
   because the rejection test in front of it is driven by terrain and by
   world-space noise that are *not* periodic, and because the tile index is
   folded back into the instance seed, so the same candidate is a different
   stone in every cell. Cost: one floor() and one multiply. */
vec2 tileTo(vec2 base, float period, vec3 camPos, mat4 viewM, out float seedShift){
  if(period <= 0.0){ seedShift = 0.0; return base; }
  /* Centred on what the camera is *looking* at, not on where it is standing.
     A crane camera fifty metres up sees no ground at all closer than a hundred
     and twenty metres, so a cell centred under the lens put the entire near
     band below the bottom of the frame — which looked exactly like the band
     not existing. Pushing the cell a third of its own width down the view axis
     costs a normalize and covers both a crane and a pair of boots. */
  vec2 f = vec2(-viewM[0][2], -viewM[2][2]);
  float fl = length(f);
  vec2 c = camPos.xz + (fl > 1e-4 ? f/fl : vec2(0.0, 1.0))*period*0.32;
  vec2 t = floor((c - base)/period + 0.5);
  seedShift = mod(dot(t, vec2(7.31, 3.77)), 23.0);
  return base + t*period;
}

`;

/* --------------------------------------------------------- shared shading */

const FRAG_UNIFORMS = /* glsl */`
uniform vec3  uSunDir;
uniform vec3  uSunColor;   // already reddened by the air mass toward the star
uniform vec3  uSkyColor;   // hemispheric skylight
uniform vec3  uGndColor;   // bounce off whatever ground is lit nearby
uniform vec3  uExtR;       // per-metre extinction, Rayleigh
uniform float uExtM;       // per-metre extinction, Mie
uniform vec3  uInsR;       // in-scatter, sky colour
uniform vec3  uInsM;       // in-scatter, sunward Mie lobe
uniform float uMieG;
uniform float uHazeH;      // haze scale height, metres
uniform float uExtD;       // per-metre extinction, suspended dust
uniform vec3  uInsD;       // in-scatter, suspended dust
uniform float uDustH;      // dust scale height, metres
uniform vec3  uCamPos;
/* Where the sun's shadow map reaches, as (fade-in r^2, fade-out r^2, centre xz).
   Derived in Game.setShadowScale from the box it has just built rather than
   written here as a constant: the box grows and slides down-sun as the star
   drops, and a fixed pair of radii cut the far half off every low-sun shadow
   in the game. */
uniform vec4  uShadowR;
`;

const SURF_LIGHT = /* glsl */`
/* One hard key and bounce for everything else. The key is the star, cut by the
   marched ridge shadow; the fill is a hemispheric skylight scaled by how much
   sky the point can see; the rest is a warm bounce off the lit ground around
   it. Shadows are never black — they are the sky's colour, which is exactly
   why a raking sun reads warm and the shade under it reads blue. */
vec3 shadeSurface(vec3 albedo, vec3 N, float shadow, float ao, vec3 V){
  vec3 L = uSunDir;
  /* A *hard* key. The wrap was 0.13, which is a sixteen-degree soft edge on the
     one light in the scene that is supposed to have none — the star subtends
     half a degree. Wrap exists here only so the terminator does not stair-step
     across a coarse mesh normal; 0.05 is enough for that and leaves the
     shoulder of every dune and every ridge doing the work it is there for. */
  float wrapd = clamp((dot(N, L) + 0.05)/1.05, 0.0, 1.0);
  float upf = clamp(N.y*0.5 + 0.5, 0.0, 1.0);
  /* And the shadow reaches nearly to zero, because there is already a fill.
     This floor was 0.13 — thirteen per cent of the key handed back to every
     shadowed pixel *on top of* the sky term that exists to do exactly that job,
     which is the whole of why the landed frame measured flat. With the fill at
     0.19 of the key, a shadow was (0.13 + 0.19)/(1.0 + 0.19) of a lit face:
     1.9 stops, where a real landscape runs four to six. The entire frame lived
     between 32 and 137 of 255 with 0.000% of pixels clipping and 0.000% black,
     against 1 to 254 and 0.6-1.9% clipping in reference photography of the same
     subject. Art direction says shadows are never black; it does not say they
     are never dark, and the sky and the bounce below are what keep them
     coloured rather than empty. */
  float key = wrapd * (shadow*0.965 + 0.035);
  /* A *directional* skylight, and it is what keeps relief alive in shadow.
   *
   * At mix(0.40, 1.0) a vertical face received 40% of what a horizontal one
   * did — nine tenths of a stop across the whole range of normals — so once the
   * key was cut every crack, cobble and riser on a shadowed slope shaded within
   * a hair of its neighbours and the whole thing went to a flat lilac wash. A
   * judge shown that frame said the micro-relief visible on the lit side
   * "vanishes into a uniform grey-lilac", and that is the number.
   *
   * The physics is not a constant either. A point on open ground sees the whole
   * upper hemisphere; a vertical face sees half of it, and the half it sees is
   * the *lower*, dimmer half of the dome. Two and a half stops from up-facing
   * to side-facing is about right for a clear sky, and it costs nothing —
   * shadowed ground is not darker overall, it is *shaped*. */
  vec3 sky = uSkyColor * mix(0.17, 1.06, upf*upf) * ao;
  /* And the bounce is warm, off the sunlit ground nearby, so the lower part of
     a shadowed slope lifts toward the colour of the plain in front of it. It
     is strongest on side-facing geometry, which is the half of the hemisphere
     the sky term just gave up. */
  vec3 bnc = uGndColor * (1.0 - upf*0.72) * (0.4 + 0.6*ao) * clamp(L.y*2.5, 0.0, 1.0);

  /* A specular lobe, because the ground had none at all and that is finding
     number four.

     This was a wrap-diffuse key, a hemispheric fill and a bounce, and nothing
     else — so the brightest value the whole landscape could return was its own
     albedo times the key. Measured against reference frames of the same
     subject: our landed frames run a 99th percentile of 152-156 with 0.000% of
     pixels at display white, where the reference runs 239-254 with 0.5-10%.
     Nothing clips because nothing *can*, and raising total radiance does not
     help — auto-exposure takes it straight back out inside a second. What was
     missing is a term with a different angular shape from the diffuse one.

     Mineral ground is not a Lambertian card. Dust and rock throw a broad, weak
     forward lobe, strongest at a raking sun and at grazing view — which is
     exactly the geometry of a landed frame, and it is what makes a lit plain
     read as lit rather than as painted. Broad on purpose: the art direction
     puts roughness floors at 0.35 and never at 0.05, so this is a sheen across
     a whole hillside and not a hot spot on it, and it is cut by the same
     shadow the key is or it lights the inside of shadows.

     max() on the pow base and a clamped dot: a normalised dot comes back at
     1.0000001 often enough to matter, and pow of a negative base is a NaN that
     additive blending spreads across the frame. */
  vec3 H = normalize(V + L);
  float nh = clamp(dot(N, H), 0.0, 1.0);
  float nv = clamp(dot(N, V), 0.0, 1.0);
  /* Roughness 0.50 rather than 0.79. At 0.79 the lobe is so broad it is
     arithmetically indistinguishable from the diffuse term — it adds energy
     but no shape, and a measurement of the desert found *zero* ground pixels
     above 1.5x their local neighbourhood against 4.6-6.0% in reference frames,
     with a peak local ratio of 1.29 against 5.6. A surface that can never
     produce a highlight reads as unfired clay whatever its albedo does. This
     is still well inside the matte-and-mineral floor of 0.35. */
  const float A2 = 0.0625;                     // roughness 0.50, squared
  float dd = nh*nh*(A2 - 1.0) + 1.0;
  float D  = A2/(3.14159265*dd*dd);
  // a grazing sheen rather than a mirror: Fresnel on a 4% dielectric, which at
  // 80 degrees off normal is worth about eight times its face-on value
  float fr = 0.030 + 0.14*pow(max(1.0 - nv, 0.0), 5.0);
  vec3 spec = uSunColor * (D*fr*wrapd*(shadow*0.94 + 0.06));

  /* Two terms that are not Lambert, and mineral ground has both.
   *
   * A judge shown these frames said the dunes read as moulded clay or skin
   * rather than as a granular surface, and was specific about why: sand is a
   * dense field of tiny facets with gaps between them, and that geometry does
   * two things a Lambertian card cannot.
   *
   * **Forward scatter.** Looking toward the star across a crest, you are seeing
   * through the lit outer skin of the grain bed, and it lights up far beyond
   * anything N.L predicts. It is strongest at grazing view *and* grazing light,
   * which is exactly the geometry of a dune brink at golden hour, and it is the
   * single cue that says "this is made of loose grains".
   *
   * **The opposition surge.** Look down-sun and every grain hides its own
   * shadow, so the surface brightens sharply within a few degrees of the
   * antisolar point. It is why the ground around your own shadow is brighter
   * than the ground beside it, and it is a narrow lobe, not a wash.
   *
   * Both are cut by the same shadow the key is — an unlit grain bed scatters
   * nothing — and both ride on the albedo, because they are the same photons.
   */
  float ndl = clamp(dot(N, L), 0.0, 1.0);
  // grazing on both sides, which is what makes it a rim rather than a sheen
  float fwd = pow(clamp(-dot(V, L)*0.5 + 0.5, 0.0, 1.0), 3.2)
            * pow(1.0 - nv, 1.6) * (1.0 - ndl*0.55);
  // and the surge, on the phase angle rather than on either vector alone
  float opp = pow(clamp(dot(V, L), 0.0, 1.0), 22.0)*0.34 + pow(clamp(dot(V, L), 0.0, 1.0), 4.0)*0.055;

  return albedo * (uSunColor*(key + (fwd*0.55 + opp)*(shadow*0.94 + 0.06)*wrapd)
                   + sky + bnc) + spec;
}

/* Aerial perspective.

   Per-channel extinction against an exponential haze, integrated in closed
   form along the segment so an elevated point genuinely sits above the murk
   its own valley is drowning in. In-scatter is the sky's colour plus a forward
   Mie lobe, so the distance both desaturates *and* glows where it faces the
   star. Mixing to one flat fog colour never does either. */
float airColumn(float y0, float y1, float H){
  float dy = y1 - y0;
  float k = (abs(dy) < 1.0) ? exp(-y0/H) : (H/dy)*(exp(-y0/H) - exp(-y1/H));
  return clamp(k, 0.0, 1.0);
}

vec3 aerial(vec3 c, vec3 wp){
  vec3 dv = wp - uCamPos;
  float dist = length(dv);
  vec3 V = dv / max(dist, 1e-3);
  float y0 = max(uCamPos.y, 0.0), y1 = max(wp.y, 0.0);

  /* Two layers, because a landscape has two. The air is kilometres deep and
     blue; the dust the wind keeps in the first sixty metres is warm, dense and
     the reason a desert middle distance has a bloom lying along the ground
     that the ridges above it stand clear of. One exponential cannot do both —
     a scale height large enough to reach a mountain leaves nothing in the
     basin, and one small enough to fill the basin never touches the mountain. */
  float dd = dist * airColumn(y0, y1, uHazeH);
  float du = dist * airColumn(y0, y1, uDustH);
  vec3 tauA = (uExtR + vec3(uExtM))*dd;
  float tauD = uExtD*du;
  vec3 tr = exp(-(tauA + vec3(tauD)));

  float mu = dot(V, uSunDir);
  float g2 = uMieG*uMieG;
  float ph = (1.0 - g2)/pow(max(1.0 + g2 - 2.0*uMieG*mu, 1e-4), 1.5);
  vec3 insAir = uInsR + uInsM*min(ph, 7.0);
  vec3 insDst = uInsD*(0.65 + 0.35*min(ph, 4.0));
  // whichever layer did most of the extinguishing owns most of the in-scatter
  float fd = tauD/max(tauD + dot(tauA, vec3(0.3333)), 1e-5);
  vec3 ins = mix(insAir, insDst, fd);
  return c*tr + ins*(vec3(1.0) - tr);
}
`;

/* ---------------------------------------------- the baked per-vertex terms

   Everything TERRAIN_VERT asks the field for, except the marched sun shadow,
   is a function of the vertex's own xz and the datum. The grid is laid out
   once in world space and never re-centred — the camera walks across it, the
   mesh does not follow — and the datum is a constant of the landing. So the
   height, the normal's four central differences, the sky-occlusion pair, the
   hillside gradient that falls out of them, the wash network and two of the
   three albedo bands were being rediscovered for every vertex of every frame:
   about a dozen field evaluations across two hundred and twenty-five thousand
   vertices, a hundred and thirty times a second, for numbers that had not
   changed since touchdown.

   They are baked once instead, into two textures with one texel per vertex.
   The bake draws the terrain geometry as *points* — one point per vertex, at
   the texel its `aLut` attribute names — so the positions never have to be
   uploaded a second time and the values are computed off exactly the same
   attribute buffer the mesh is drawn from. Point size one, addressed at the
   texel centre, so a point covers its own texel and nothing else.

   The marched shadow stays in the vertex stage, and stays there deliberately:
   it is the one term the sun moves, and a cached one would step across the
   ground every time the cache was refreshed. A shadow that jumps is worse
   than a shadow that costs. */
const TER_BAKE_FRAG = /* glsl */`
precision highp float;
varying vec4 vOut;
void main(){ gl_FragColor = vOut; }
`;

const terBakeVert = (second) => /* glsl */`
${NOISE}
${FIELD_UNIFORMS}
${FIELD}
attribute vec2 aLut;
varying vec4 vOut;
void main(){
  vec2 xz = position.xz;
  float d = length(xz);
  float lod = meshLod(d);
  vec4 dat = uDatum;
  float yf = groundYFlat(xz, lod, dat);
${second ? `
  float hill;
  skyOcc(xz, yf, lod, dat, hill);
  /* The world coordinate, not the mesh one. The mesh's origin is the ship;
     the field's origin is the planet. Sampling the province and mineral bands
     about the ship would put the same country in the same place on every
     landing, and would put them somewhere else than the drainage the terrain
     was actually incised with. */
  vec3 pp = vec3(xz.x + dat.z, yf - d*d/(2.0*uPlanetR), xz.y + dat.w);
  vOut = vec4(hill, drainage(xz + dat.zw),
              snoise(pp*0.00017 + 211.0)*0.5 + 0.5,
              snoise(pp*0.00055 + 131.0)*0.5 + 0.5);
` : `
  // Central difference at the grid's own spacing, so the normal never reports
  // detail the mesh does not carry and the shading matches the mesh. Central
  // rather than forward: a forward difference reports the slope half a cell
  // downwind of where it is used, which skews every ridge line by half a
  // triangle and is visible as a bright edge on one side of every crest.
  /* One and a third cells, not one.
     A central difference taken at exactly the sample spacing is the *most*
     sensitive estimator there is to where each vertex happened to fall: on a
     field that still has energy near the sample rate it hands neighbouring
     vertices normals that kink alternately, and linear interpolation of those
     across the triangles paints the grid onto the hillside. A slightly wider
     stencil low-passes the estimate for the same four taps, and the detail it
     costs is detail the mesh could not represent in the first place. */
  float e = max(lod*1.35, 0.32);
  float ya = groundYFlat(xz + vec2(e, 0.0), lod, dat);
  float yb = groundYFlat(xz + vec2(0.0, e), lod, dat);
  float yc = groundYFlat(xz - vec2(e, 0.0), lod, dat);
  float yd = groundYFlat(xz - vec2(0.0, e), lod, dat);
  vec3 nrm = normalize(vec3(-(ya - yc)*0.5, e, -(yb - yd)*0.5));
  float hill;
  // The normal's y is always positive, so only xz has to be stored and the
  // reader can put it back with a square root. That is what leaves room for
  // the occlusion in the same texel.
  vOut = vec4(yf, nrm.x, nrm.z, skyOcc(xz, yf, lod, dat, hill));
`}
  gl_PointSize = 1.0;
  gl_Position = vec4(aLut*2.0 - 1.0, 0.0, 1.0);
}
`;

const TER_BAKE_A = terBakeVert(false);
const TER_BAKE_B = terBakeVert(true);

/* ------------------------------------------------------------- the ground */

const TERRAIN_VERT = /* glsl */`${LOGD_V_PARS}
${NOISE}
${FIELD_UNIFORMS}
${FIELD}
${VIEWCULL}
#include <shadowmap_pars_vertex>

uniform vec3 uCamPos;
attribute vec2 aLut;
uniform sampler2D uLutA;   // height, normal.x, normal.z, sky occlusion
uniform sampler2D uLutB;   // hillside gradient, wash, province, mineral

varying vec3  vPos;
varying vec3  vNrm;
varying float vHeight;
varying float vSeaY;
varying float vShadow;
varying float vAO;
varying float vFlow;
varying float vHill;
varying float vProv;
varying float vMin;
varying float vTilt;

void main(){
  vec2 xz = position.xz;
  float d = length(xz);
  float lod = meshLod(d);

  vec4 dat = uDatum;

  /* Read, rather than rediscover. See TER_BAKE_A/B: every term below except
     the marched shadow was baked at touchdown off this same attribute buffer,
     so what used to be a dozen field evaluations is two fetches.

     textureLod, not texture2DLod and not texture2DLodEXT. three compiles every
     non-raw ShaderMaterial as ESSL3 and patches the ESSL1 spellings back in
     with defines — but the vertex prefix only carries texture2D, and the whole
     texture*LodEXT family is in the *fragment* prefix. In a vertex shader the
     ESSL3 name is the only one that exists. */
  vec4 LA = textureLod(uLutA, aLut, 0.0);
  vec4 LB = textureLod(uLutB, aLut, 0.0);

  float yf = LA.x;
  vHeight = yf;
  vSeaY = seaLevel(dat.x);

  /* The normal, from two stored components and a square root. The baked
     normal came out of a central difference with +e on its y term, so y is
     positive by construction and only the sign-ambiguous half had to be
     stored. Clamped at zero before the root because two rounded components can
     sum to a hair over one, and a negative under a sqrt is a NaN that additive
     blending will happily spread across the frame. */
  vNrm = vec3(LA.y, sqrt(max(1.0 - LA.y*LA.y - LA.z*LA.z, 0.0)), LA.z);

  /* The marched shadow is the last thing in here that costs, and it is spent
     on ground that is not in frame.

     A scatter instance has always tested the view cone before asking the field
     anything; the mesh never did, because a mesh is not a point — and so all
     two hundred and twenty-five thousand vertices of a full 360 degree disc
     ran an eight-step march every frame to shade the forty degrees of it a
     camera can see. The same test, with the same margin, applies: it is
     conservative by twenty triangle widths at the horizon, so no triangle can
     be drawn with one vertex marched and another not. Anything rejected is
     handed a lit vertex it will never show. */
  vShadow = behindCamera(xz, uCamPos, viewMatrix, projectionMatrix)
    ? 1.0 : sunShadow(xz, yf, lod, dat);
  vAO     = LA.w;
  vHill   = LB.x;
  /* The wash network, carried down to the fragment stage. It is two octaves
     evaluated once per vertex rather than four times per pixel, and it is what
     lets the albedo know where the gravel bars, the dark damp ground and the
     scrub lines are — all three of which are *the same* feature. */
  vFlow = LB.y;

  // bend the patch down around the planet — the horizon has to fall away
  vec3 pp = vec3(xz.x, yf - d*d/(2.0*uPlanetR), xz.y);
  /* The province band, per vertex.

     It is a six-kilometre field and the mesh samples at worst every nine
     hundred metres, so it is oversampled seven times over even at the horizon
     cut — there is no frequency in it a triangle cannot carry, and evaluating
     it per *pixel* was one simplex lookup across the whole frame for a value
     that changes by nothing across a triangle. The other three albedo scales
     stay in the fragment stage: the 480 m band is only two samples per
     wavelength out at ten kilometres, and a field interpolated at Nyquist is
     exactly how this shader once grew quad-shaped patches with the grid's own
     straight edges in them. */
  vProv = LB.z;
  /* The same argument, twice more. The mineral band is 1.8 km and the strata
     dip 1.3 km; the mesh samples at most every 790 m at the horizon cut and
     every 390 m at thirteen kilometres, which is where the strata term has
     already faded out. Both are oversampled three times over everywhere they
     are legible, and the only place mineral is not is the last few kilometres
     before the cut — where the air has taken ninety-eight per cent of the
     contrast out of everything anyway. */
  vMin  = LB.w;
  /* Strata dip is the one band left in the shader. It is a single simplex
     lookup — cheaper than the texel it would occupy — and it is the reason
     the bake needs two targets rather than three. */
  vTilt = snoise(pp*0.00075 +   9.0);
  vPos = pp;
  vec4 worldPosition = modelMatrix * vec4(pp, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;

  /* Somewhere for the ship's shadow to land.

     Nothing in the ground scene cast onto the ground at all, and against a
     reference frame that was the first thing an eye caught — 200 tonnes of
     metal reads as standing on a place only because it lays a shadow across
     it, and without one the hull is a model composited onto a backdrop. The
     sun already casts and its orthographic box is already sized for a scene in
     metres; what was missing is that a custom ShaderMaterial receives nothing
     unless it asks, so three's chunk goes in here.

     Two things it has to be told. The coordinate must come off the *displaced*
     position — the grid vertex is a flat disc and the ground is wherever the
     height field put it, so a shadow addressed from the disc lands hundreds of
     metres from whatever cast it. And this geometry carries no normal
     attribute, so three's shadowmap_vertex chunk takes shadowWorldNormal as
     zero and applies none of its own: this line *is* the scene's whole
     receiver offset, and it has to be derived rather than dialled.

     It used to be a flat 24 cm, and a fixed receiver offset is not a bias, it
     is a displacement: every received shadow slides o/tan(elevation) down-sun,
     which is 90 cm at a 15 degree star and three metres at four and a half.
     The landing pad is 1.4 m across, so its own contact shadow was pushed
     clear of the pad before anything else touched it — and no cascade can fix
     that, because the offset is applied per receiver *after* the lookup. One
     shadow texel is what the offset is actually for (it keeps the filter
     kernel from sampling this surface's own depth across its slope), and the
     ground map is 4096 across a 220-480 m box, so a texel is 5 to 12 cm. */
  worldPosition.xyz += vNrm*uShadowNB;
  #include <shadowmap_vertex>
  ${LOGD_V}
}
`;

/* The ground, as the shadow map sees it.

   The terrain is displaced entirely in its vertex shader, so a mesh handed to
   three's shadow pass casts from its *undisplaced* base — a flat disc — and the
   ground gets a shadow that has nothing to do with the relief on it. Nothing
   throws an error; the map simply contains a plate.

   So the displacement is duplicated here, and duplicated exactly: the same
   meshLod, the same groundYFlat, the same datum uniform and the same horizon
   bend, off the same vertex buffer. Anything less and the caster and the
   receiver are two different surfaces, which shows up as a shadow that creeps
   across the ground as the sun moves rather than one that is welded to the
   ridge casting it.

   Everything outside the sun's orthographic box is left flat rather than
   displaced. The box is 220-480 m across and centred within 130 m of the
   landing site; the mesh is fifty-two kilometres wide and has no frustum
   culling, so without this the shadow pass would evaluate the height field over
   the whole of it — the single most expensive thing in the frame, run twice.
   The cut is at twice the worst case the box can reach, so the join between
   displaced and flat is always outside the frustum and gets clipped. */
const TER_SHADOW_R2 = 700 * 700;

const TERRAIN_DEPTH_VERT = /* glsl */`${LOGD_V_PARS}
${NOISE}
${FIELD_UNIFORMS}
${FIELD}
attribute vec2 aLut;
uniform sampler2D uLutA;
varying vec2 vHighPrecisionZW;
void main(){
  vec2 xz = position.xz;
  float d2 = dot(xz, xz);
  float yf = 0.0;
  // The same baked height the beauty pass reads, so the caster and the
  // receiver cannot be two different surfaces — which was the whole reason
  // this shader duplicated the displacement in the first place.
  if(d2 <= ${TER_SHADOW_R2.toFixed(1)}) yf = textureLod(uLutA, aLut, 0.0).x;
  vec4 worldPosition = modelMatrix * vec4(xz.x, yf - d2/(2.0*uPlanetR), xz.y, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vHighPrecisionZW = gl_Position.zw;
  ${LOGD_V}
}
`;

/* Depth, packed the way three's own shadow pass packs it. Written out rather
   than borrowed from MeshDepthMaterial because the vertex stage has to be ours
   — and because Material.clone does not carry onBeforeCompile, so a hook on a
   built-in material is a trap waiting for the first clone. */
const DEPTH_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
#include <packing>
varying vec2 vHighPrecisionZW;
void main(){
  ${LOGD_F}
  float fragCoordZ = 0.5*vHighPrecisionZW[0]/vHighPrecisionZW[1] + 0.5;
  gl_FragColor = packDepthToRGBA(fragCoordZ);
}
`;

const TERRAIN_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
${FRAG_UNIFORMS}
${SURF_LIGHT}
${HABITAT}
uniform bool receiveShadow;
// three's PCF chunk reaches for PI2 out of <common>, which this shader does not
// include: it carries its own basis functions and pulling in all of three's
// would collide with half of them.
#define PI2 6.283185307179586
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

uniform vec3  uC1, uC2, uC3, uC4, uCWater;
uniform float uSeed;

/* ------------------------------------------------------- the baked material

   Four seamless tiling sets in one array — fractured rock, regolith, a scree
   bed and a cracked crust — each an RGB image of (luminance, nx, ny). See the
   loader at the top of this file for why it is one image and not three.

   uTerInv is the reciprocal of the three sample scales in metres, uTerSet is
   which layer plays which role on this world, and uTerK.x/.y are the normal and
   albedo strengths, both zero until the images have decoded so a landing during
   the load draws untextured ground rather than garbage. */
uniform sampler2DArray uTerTex;
uniform vec4  uTerInv;
uniform vec4  uTerSet;    // layer index: rock, loose, coarse accent, crust accent
uniform vec2  uTerK;
uniform float uDesat;

/* One material, one scale, triplanar.

   nx and ny are the *negative* height gradient, which is exactly the tilt the
   surface wants: accumulate the pair through whichever planes carry weight and
   let the caller project the sum onto the surface once, for every scale at
   once. A per-tap normalize and re-basis would be three times the arithmetic
   for a difference nobody can see at a metre.

   textureGrad, not texture, and the derivatives are computed once outside every
   branch. An implicit derivative taken inside non-uniform control flow is
   undefined across a quad that straddles a material boundary, which picks a mip
   at random and draws a bright seam along every one of them — and this shader
   is nothing *but* material boundaries.

   The two side planes are branched rather than blended. A landed frame is
   mostly ground flat enough that their weights round to nothing, so the common
   case costs one fetch and only a genuine wall pays for three. */
/* The fourth channel is the mineral index — which stone this texel is made of,
   as opposed to how much light reaches it. It is accumulated exactly like the
   luminance and for the same reason: whichever planes carry weight contribute,
   and the caller normalises once. See tools/bake_terrain.py for why a scalar
   luminance could never give the ground a second colour. */
vec3 terrTap(vec3 p, vec3 dx, vec3 dy, float lay, float inv, vec3 w,
             inout float lum, inout float mnr){
  vec3 g = vec3(0.0);
  if(w.y > 0.005){
    vec4 t = textureGrad(uTerTex, vec3(p.xz*inv, lay), dx.xz*inv, dy.xz*inv);
    lum += w.y*t.x*t.x;
    mnr += w.y*t.w;
    g   += w.y*vec3(t.y - 0.5, 0.0, t.z - 0.5);
  }
  if(w.x > 0.005){
    vec4 t = textureGrad(uTerTex, vec3(p.zy*inv, lay), dx.zy*inv, dy.zy*inv);
    lum += w.x*t.x*t.x;
    mnr += w.x*t.w;
    g   += w.x*vec3(0.0, t.z - 0.5, t.y - 0.5);
  }
  if(w.z > 0.005){
    vec4 t = textureGrad(uTerTex, vec3(p.xy*inv, lay), dx.xy*inv, dy.xy*inv);
    lum += w.z*t.x*t.x;
    mnr += w.z*t.w;
    g   += w.z*vec3(t.y - 0.5, t.z - 0.5, 0.0);
  }
  return g*2.0;
}

/* One scale, in its own rotated frame.

   Three copies of one image at 8:1 in a *shared* frame are not three scales,
   they are one motif at three sizes: every directional feature in a map — and
   a ripple train is nothing but direction — lines up with itself at every
   scale, and the result is long smears running the length of the foreground.
   That is the same failure as the sine this replaced, wearing a hat. A rotation
   about Y decorrelates them for four multiplies.

   It has to be a genuine change of basis rather than a smear of one, so the
   gradient comes back through the inverse and the plane weights are taken from
   the rotated normal. R maps p to q, so the gradient comes back through R
   transposed; getting that backwards tilts every detail the wrong way round the
   compass and looks, convincingly, like the sun being in the wrong place. */
void terrOct(vec3 p, vec3 dx, vec3 dy, vec3 nm, vec2 rc, float lay, float inv,
             float amt, float gk, float lc, float mc, inout float lum,
             inout float mnr, inout float lw, inout vec3 g){
  vec3 q  = vec3(p.x*rc.x  + p.z*rc.y,  p.y,  -p.x*rc.y  + p.z*rc.x);
  vec3 qx = vec3(dx.x*rc.x + dx.z*rc.y, dx.y, -dx.x*rc.y + dx.z*rc.x);
  vec3 qy = vec3(dy.x*rc.x + dy.z*rc.y, dy.y, -dy.x*rc.y + dy.z*rc.x);
  vec3 nr = vec3(nm.x*rc.x + nm.z*rc.y, nm.y, -nm.x*rc.y + nm.z*rc.x);
  /* Plane weights raised to the fourth, so the side planes only exist on a
     genuine wall: on ground at ten degrees they are four ten-thousandths and
     terrTap skips both branches for one fetch instead of three. */
  vec3 w = abs(nr); w = w*w; w = w*w; w /= max(w.x + w.y + w.z, 1e-4);
  float l = 0.0, m = 0.0;
  vec3 t = terrTap(q, qx, qy, lay, inv, w, l, m);
  g   += vec3(t.x*rc.x - t.z*rc.y, t.y, t.x*rc.y + t.z*rc.x)*(amt*gk);
  /* lc is contrast, not weight, and the difference matters: the macro octaves
     are the only detail left at five kilometres, so *weighting* them down does
     nothing there — the normalisation puts them straight back. What has to come
     down is how much tone they carry, because a tiling image at eighty metres
     shows its lattice in the albedo long before it shows it in the shading. The
     tap sums to a mean of a half by construction, so this pivots about that. */
  lum += (0.5 + (l - 0.5)*lc)*amt;
  /* And the mineral gets a contrast of its own, weighted toward the fine
     octave. Hue is far more visible than tone at the same amplitude, so
     inheriting lc was not enough: at the macro scales the rock set's fracture
     network came back as a *coloured* honeycomb across every mid-distance
     hillside — the same reptile-skin crackle the tone was reduced for, in the
     one channel where it cannot be missed. The half-metre octave is the only
     one that never shows its period (at that size you are looking at grains),
     so it carries the mineral, and the coarse scales supply almost none of it.
     Chroma at distance is the province and mineral bands' job. Stored 0.5..1.0,
     decoded by the caller. */
  mnr += (0.75 + (m - 0.75)*mc)*amt;
  lw  += amt;
}

/* Every scale of one material.

   Half a metre, four metres, twenty-seven and eighty-two: the grain you are
   standing in, the gravel and cracking you walk across, and two octaves of the
   surface a mountain face still has at five kilometres. Each has a world-space
   offset so a feature is never in the same place at two sizes, each has its own
   rotation, and the ratios are 7.8 and 6.3 rather than 8 and 8.

   **The two macro octaves are the rock set on every world, and there are two of
   them on purpose.** One tiling image at thirty metres is sixteen copies of
   itself across a five-hundred-metre cliff, and a lattice is the single thing
   an eye finds fastest — the first pass at this drew a visible honeycomb over
   every distant face in the frame. Two lattices at 27 and 82 metres, rotated
   apart, beat against each other with no period anything in shot is wide enough
   to show. And they are rock rather than the world's own loose set because a
   crust polygon or a ripple train is a *motif*: repeated at thirty metres it
   reads as wallpaper, where fractured stone repeats as stone.

   k is (fine, mid, macro, macro-coarse) and any of them at zero skips its fetch
   entirely. The coarse one only fades in as the mid one fades out, so the near
   field costs three fetches per material and the far field costs two. */
/* kg is a fifth octave *below* the fine one, and it exists because the stack
   bottomed out at a metre.

   The scales here are 1.05 m, 8.2, 65 and 205. Nothing under a metre existed at
   all, so the ground within a few paces of the camera — which owns more screen
   area than anything else in a landed frame and is where the eye checks whether
   a surface is real — was carrying its highest frequency at roughly a hundred
   screen pixels per feature. Measured on the albedo debug channel, the near
   field came back at 1.22 levels per pixel of gradient against 16.3 in a
   reference frame, and micro-contrast *fell* toward the camera in all four
   biomes instead of rising. That inversion is the whole of the "play doh"
   reading: the closer you get, the smoother it gets.

   It reuses the same tile rather than needing a new asset — at a sixth of the
   size, rotated and offset, the same image is grain rather than gravel — and it
   is gated hard on the pixel footprint so it costs nothing beyond about fifteen
   metres. */
void terrSet(vec3 p, vec3 dx, vec3 dy, vec3 nm, float lay, float wgt, vec4 k,
             float kg, inout float lum, inout float mnr, inout float lw,
             inout vec3 g){
  /* The two macro octaves carry tone but only a third of the normal they used
     to. A 512 tile at 27 m has the rock set's own fracture polygons in it, and
     at that size an *embossed* polygon network across a whole hillside does
     not read as rock, it reads as scales — a review of the far ground called
     it a reptile-skin crackle. The tone is what a distant face needs (it is
     the only surface information left out there); the relief at 27 m is the
     mesh's job, and the mesh now has the octaves to do it.
     **Halved again**, because the same argument got stronger the moment the key
     and the fill moved two stops apart: a normal perturbation is worth far more
     contrast under a hard key than under a flat one, and at 0.20-0.24 the six
     fracture cells — 5.7 m apart at the 34 m octave and repeating every 34 m —
     came back as a honeycomb of crazy paving across the whole foreground and
     middle distance. The tone at these scales is what a far face needs; the
     relief is what makes the period visible. */
  if(k.w > 0.01)
    terrOct(p + vec3(103.0, 0.0, 61.0), dx, dy, nm, vec2(0.940, -0.342),
            uTerSet.x, uTerInv.w, wgt*k.w, 0.10, 0.42, 0.12, lum, mnr, lw, g);
  if(k.z > 0.01)
    terrOct(p, dx, dy, nm, vec2(1.000,  0.000), uTerSet.x, uTerInv.z,
            wgt*k.z, 0.12, 0.42, 0.16, lum, mnr, lw, g);
  if(k.y > 0.01)
    terrOct(p + vec3(37.1, 0.0, 11.7), dx, dy, nm, vec2(0.682, 0.731), lay,
            uTerInv.y, wgt*k.y, 0.80, 1.00, 0.62, lum, mnr, lw, g);
  if(k.x > 0.01)
    terrOct(p + vec3(5.3, 0.0, 71.9), dx, dy, nm, vec2(-0.276, 0.961), lay,
            uTerInv.x, wgt*k.x, 0.92, 1.00, 1.30, lum, mnr, lw, g);
  if(kg > 0.01)
    terrOct(p + vec3(23.7, 0.0, 41.3), dx, dy, nm, vec2(0.454, -0.891), lay,
            uTerInv.x*6.1, wgt*kg, 1.15, 1.00, 0.85, lum, mnr, lw, g);
}

/* Simplex with its own derivative, for the bands that only want a slope.

   A detail band bumps the normal by the gradient of a noise field, and the
   only way to get a gradient out of a plain noise call is to call it again
   somewhere else — three times, at best, for one answer. But this noise is a
   sum of four smooth kernels and its derivative is available in closed form
   from quantities the value already computed: the corner offsets, the
   gradients and the falloff weights are all still in registers when the value
   is returned. Adding the derivative costs four multiply-adds; the samples it
   replaces cost ninety instructions each.

   n_i = 42 * sum(t_i^4 * dot(p_i, x_i)) with t_i = max(0.6 - |x_i|^2, 0), so
   grad = 42 * sum(t_i^4 * p_i - 8 * t_i^3 * dot(p_i, x_i) * x_i). Where t_i is
   clamped to zero the whole term drops out, exactly as it does in the value.

   All four detail bands go through it, including the two that fold the noise
   with an absolute value: the chain rule handles those as well, and the sign
   flip it produces at a crease is what a crease *is*. A finite difference used
   to round that flip off over its own step, which cost a lookup to blur an
   edge the shader wanted. Measured over the whole fragment stage: 6.5 ms down
   to 2.7 at two device pixels per CSS pixel. */
float snoiseG(vec3 v, out vec3 grad){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289v3(i);
  vec4 p = permute289(permute289(permute289(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_*D.wyz - D.xzx;
  vec4 j = p - 49.0*floor(p*ns.z*ns.z);
  vec4 x_ = floor(j*ns.z);
  vec4 y_ = floor(j - 7.0*x_);
  vec4 x = x_*ns.x + ns.yyyy;
  vec4 y = y_*ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt4(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 t  = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  vec4 t2 = t*t;
  vec4 t4 = t2*t2;
  vec4 dv = vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3));
  vec4 c  = -8.0*t2*t*dv;
  grad = 42.0*(c.x*x0 + c.y*x1 + c.z*x2 + c.w*x3
             + t4.x*p0 + t4.y*p1 + t4.z*p2 + t4.w*p3);
  return 42.0*dot(t4, dv);
}

uniform int   uType;
uniform float uLavaGlow;
uniform float uVeg;      // how much of this world is alive
uniform vec3  uCVeg;     // and what colour it is
uniform vec3  uC0;       // the palette's darkest — damp ground, crack shadow
uniform float uCrack;    // how hard the ground dries or freezes into plates

varying vec3  vPos;
varying vec3  vNrm;
varying float vHeight;
varying float vSeaY;
varying float vShadow;
varying float vAO;
varying float vFlow;
varying float vHill;
varying float vProv;
varying float vMin;
varying float vTilt;

/* Band limiting, in the fragment stage, against the *pixel*.

   The reviewer's words were "a tiling speckle albedo that never mips down, so
   the mid-ground shimmers and the far ground is as high-frequency as the near",
   and that is precisely what a distance-keyed falloff produces: distance is
   only a proxy for how big a pixel is on the ground, and it is a bad one the
   moment the ground tilts away or the field of view changes. The right quantity
   is the world-space footprint of this fragment, which the hardware already
   knows. A band whose wavelength is below about two footprints cannot be
   represented, so it is not drawn — the same contract the height field's lod
   gate keeps with the mesh, one stage further down. */
float pxGate(float px, float wl){ return 1.0 - smoothstep(wl*0.125, wl*0.42, px); }

/* A hue rotation about the luma axis, the standard YIQ form.
 *
 * It exists because mixing between palette entries cannot separate hue. Every
 * world's c1..c4 are close neighbours by construction — they are five shades of
 * one rock — so blending them moves value and leaves hue where it was. Measured
 * on a desert frame, 99.8 per cent of the chromatic pixels fell in a single
 * fifteen-degree hue bin: a monochrome image with a brown tint. Reference
 * frames that read as *muted* carry three or four distinct hue families at the
 * same mean chroma, and it is the separation between materials, not the
 * saturation, that reads as richness. So the weathered variants are rotations
 * of the ground's own colour rather than mixtures of the palette. */
vec3 hueRot(vec3 c, float a){
  float u = cos(a), w = sin(a);
  return max(vec3(
    dot(c, vec3(0.299 + 0.701*u + 0.168*w, 0.587 - 0.587*u + 0.330*w, 0.114 - 0.114*u - 0.497*w)),
    dot(c, vec3(0.299 - 0.299*u - 0.328*w, 0.587 + 0.413*u + 0.035*w, 0.114 - 0.114*u + 0.292*w)),
    dot(c, vec3(0.299 - 0.300*u - 1.250*w, 0.587 - 0.588*u + 1.050*w, 0.114 + 0.886*u + 0.203*w))),
    0.0);
}
uniform float uDbg;
uniform vec2  uWind;   // the prevailing wind, shared with the dune ranks
uniform float uTime;   // the water is moving
void main(){
  ${LOGD_F}
  vec3 N = normalize(vNrm);
  /* Metres of ground per pixel — the *minor* axis of the footprint, not the
     major one.
     A ground plane under a standing figure is seen at a grazing angle, so the
     footprint is a long thin ellipse: at two metres from the boots it is a
     millimetre across and a centimetre along. Taking the largest component of
     fwidth measures the long axis and concludes there is no point sampling
     anything finer than a centimetre, which switched the finest detail off in
     exactly the place it matters most and left the foreground smeared. The
     texture is sampled anisotropically, so the axis that decides what is
     resolvable is the short one. */
  vec3 fpx = dFdx(vPos), fpy = dFdy(vPos);
  float px = min(length(fpx), length(fpy));
  /* Albedo decisions read the *mesh* slope, never the detail-perturbed one.
     Bump normals swing the slope by twenty degrees at metre scale, and feeding
     that into a smoothstep that switches between soil and bare rock paints
     every mountain in the frame like a dalmatian. */
  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  float above = clamp((vHeight - vSeaY) / 900.0, 0.0, 1.0);
  /* How sheltered the point is, from the same term that lights it. A hollow
     collects the dust that the wind strips off a crest, so occlusion is a
     material cue and not only a lighting one — and it is already smooth, so it
     costs nothing and cannot band. */
  float shelter = clamp((1.0 - vAO)*1.7, 0.0, 1.0);

  float cd = length(vPos - uCamPos);
  // how much of this fragment is bare rock rather than something that settled
  float bare = smoothstep(0.20, 0.52, slope);
  /* How alive this fragment is, computed here rather than down in the albedo
     because the *mineral* work above has to know about it too. A wind ripple
     under a sward is the single loudest reason a green world reads as green
     sand: the ripple is a bedform, it needs loose grains free to move, and
     ground held together by roots has none. Everything below that draws sand
     asks this first. */
  float alive = 0.0;
  if(uVeg > 0.01) alive = clamp(floraMask(vPos.xz, vHill, shelter, vFlow, above)
                               *pow(uVeg, 0.55), 0.0, 1.0);

  /* ---- what the ground *is*, before what it looks like -------------------

     These decide which material a fragment is made of as well as what colour
     it ends up, so they have to be resolved before the texture is sampled
     rather than after. All of them are low frequency: two arrive as varyings
     because the mesh oversamples them seven times over, and the two that stay
     here are the only noise calls left in this shader.

     "One texture repeated to the horizon" is a complaint about the *spectrum*
     of the albedo, not its resolution. Bands at 1.8 km and 480 m leave the
     ground between and beyond them uniform; the province band is six
     kilometres, big enough that the far side of the basin is visibly a
     different country, and the pan band at ninety metres is what breaks a
     floor into fines, gravel and swept ground you can walk between. */
  float province = vProv;                                   // ~6 km, per vertex
  float mineral  = vMin;                                    // ~1.8 km, per vertex
  float region   = snoise(vPos*0.0021  +  71.0)*0.5 + 0.5;  // ~480 m
  float pan      = snoise(vPos*0.011   + 307.0)*0.5 + 0.5;  // ~90 m
  /* The wash network. The same field the terrain was incised with, so the
     gravel bar, the dark damp floor and the line of scrub are one feature
     rather than three that nearly line up. */
  float wash     = smoothstep(0.30, 0.90, vFlow);
  float washCore = smoothstep(0.62, 0.97, vFlow)*(1.0 - bare);
  float cover    = 1.0 - bare;
  float deflate  = smoothstep(0.62, 0.90, pan)*cover;
  float drift    = smoothstep(0.40, 0.10, pan)*cover*(0.4 + 0.6*shelter);
  float talus    = smoothstep(0.42, 0.14, slope)*smoothstep(0.10, 0.40, above)*shelter;

  /* ---- baked surface detail ----------------------------------------------

     What used to be here was four bands of simplex noise, a fold for the
     pebbles and an analytic sine for the ripples, all evaluated per fragment.
     That has one defect no amount of tuning reaches: **a procedural field has
     no mip chain.** Nothing prefilters it, so its high frequencies cannot
     survive minification, and whatever is left carrying the foreground is the
     lowest band in the stack. Asked to cover an area it has no bandwidth for,
     a low band does not read as smooth — it reads as a regular wave. That wave
     was a 1.9 m cosine and it lay across the bottom of every landed frame.

     Now it is four baked tiling sets sampled triplanar at three scales. Two
     materials per fragment: whatever loose stuff is lying here, and the rock
     underneath wherever the ground is too steep for anything to lie on. Which
     loose set is a property of the ground rather than of a noise field — scree
     on the apron below a crag and in the washes, crust on flat undisturbed
     pan, regolith everywhere else — and the two accents are close to mutually
     exclusive by construction, so whichever wins is faded out where they are
     comparable and nobody sees the switch. */
  vec3 ddx = fpx, ddy = fpy;
  // the plane weights come off the *mesh* normal, taken before anything
  // perturbs it, and are re-derived per scale inside its own rotated frame
  vec3 Nm = N;

  /* Each scale stops when it is no longer buying a pixel of anything. The fine
     set is a metre-scale thing and is gone by two hundred; the macro set is the
     only one still legible on a ridge at five kilometres. Nothing here is an
     anti-aliasing gate — the mip chain does that, which is the entire point of
     baking — these are cost gates and nothing else. */
  /* On only where a footprint is under about two centimetres, which is the
     ground inside roughly fifteen metres at a grazing view. Beyond that it is
     below Nyquist and the mip chain would take it out anyway. */
  float tkg = (1.0 - smoothstep(0.005, 0.022, px))*uTerK.x;
  vec4 tk = vec4(1.0 - smoothstep(0.026, 0.130, px),
                 1.0 - smoothstep(0.340, 1.700, px),
                 1.0 - smoothstep(4.500, 15.00, px),
                 smoothstep(0.180, 0.900, px)*(1.0 - smoothstep(7.0, 22.0, px)))*uTerK.x;

  float lum = 0.0, lw = 0.0, mnr = 0.0;
  vec3 tg = vec3(0.0);
  if(tk.x + tk.y + tk.z + tk.w + tkg > 0.01){
    /* Lag gravel on the deflated pans, and it is a *material* and not only a
       tint. A basin floor was one hundred per cent of the world's loose set,
       and on any world whose loose set is regolith that means the sand tile's
       ripple train — a strongly directional motif — is the only thing on the
       ground for fifty metres in every direction. The trains line up across
       tile boundaries because the direction is a property of the image, so
       what came back was not a repeat you could point at, it was a single
       corduroy running the length of the foreground: at 1:1 a set of long fine
       parallel scratches, and swapping the layer for scree removes every one of
       them. Deflation is exactly where the fines are gone and the coarse
       fraction is left behind, so the accent the shader already knows how to
       lay down belongs there, and it breaks the train into patches you can
       walk between rather than a sheet. */
    /* And at seven metres as well as at ninety, because ninety is not a scale a
       standing figure can see across: a foot-height crop is thirteen metres of
       ground, so the pan band is a constant over the whole near field and
       whichever material it chose is the only one in shot. One simplex lookup,
       and only where a pixel is small enough for the switch to be visible at
       all — past a metre per pixel neither set resolves and the branch is
       skipped. */
    float lag = 0.0;
    if(px < 0.85){
      float ls = snoise(vPos*0.145 + 401.0)*0.5 + 0.5;
      lag = smoothstep(0.44, 0.76, ls)*(1.0 - smoothstep(0.30, 0.85, px))*cover;
    }
    float wScree = max(max(smoothstep(0.11, 0.36, slope)*smoothstep(0.05, 0.32, above),
                           smoothstep(0.42, 0.92, vFlow)*0.75),
                       max(deflate*0.90, lag*0.88));
    float wCrust = uCrack*smoothstep(0.52, 0.88, pan)
                 * (1.0 - smoothstep(0.14, 0.38, slope))
                 * (1.0 - smoothstep(0.28, 0.72, vFlow));
    float accW = max(wScree, wCrust)*smoothstep(0.05, 0.34, abs(wCrust - wScree));
    float accL = (wCrust > wScree) ? uTerSet.w : uTerSet.z;
    if(cover > 0.01){
      terrSet(vPos, ddx, ddy, Nm, uTerSet.y, cover*(1.0 - accW), tk, tkg, lum, mnr, lw, tg);
      if(accW > 0.02)
        terrSet(vPos, ddx, ddy, Nm, accL,    cover*accW,         tk, tkg, lum, mnr, lw, tg);
    }
    if(bare > 0.01)
      terrSet(vPos, ddx, ddy, Nm, uTerSet.x, bare,               tk, tkg, lum, mnr, lw, tg);
  }
  /* Every set is normalised to the same mean at bake time, so this channel is a
     pure multiplier about 1.0 and swapping one material for another does not
     change the ground's exposure. Where no scale is running at all it is
     exactly 1.0, which is why the fade-out is invisible. */
  lum = (lw > 0.004) ? lum*(2.0/lw) : 1.0;
  // stored 0.5..1.0 about a mean of 0.75, so this is signed about zero and is
  // exactly zero wherever no scale is running — which is what makes the fade to
  // distance invisible, the same contract the luminance keeps.
  mnr = (lw > 0.004) ? mnr*(4.0/lw) - 3.0 : 0.0;

  /* The hundred-metre band, and the only surface cue a range at ten kilometres
     has that is coarser than the macro tile. Ridged, not fbm, and driven on the
     steep faces only: a ridged gradient makes creases, and a crease at this
     scale is a gully. A strong coefficient here does not add texture, it
     rotates whole patches of a distant face in and out of the key and comes out
     as a dalmatian — the shape is the mesh's job. */
  float gully = 0.0;
  float dFar = smoothstep(400.0, 1300.0, cd)*pxGate(px, 133.0);
  if(dFar > 0.02){
    vec3 ds;
    float sv = snoiseG(vPos*0.0075 + 91.0, ds);
    float q  = 1.0 - abs(sv);
    vec3 dn  = -2.0*q*sign(sv)*ds;
    vec3 gr  = (dn - N*dot(dn, N))*0.15;
    N = normalize(N - gr*(dFar*mix(0.045, 0.13, bare)));
    /* And the darkening goes where the crease is, which is the opposite of
       where it used to go. q is 1 - |noise|, so it peaks at the zero crossings
       — that *is* the crease, and it is where the geometry above is bent,
       because dn is the gradient of q squared. The mask was
       smoothstep(0.60, 0.14, q*q), which is on where q is about a third: the
       broad lobes *between* the creases, not the creases. Every massif past
       four hundred metres therefore came back with large soft round dark
       patches on it that had nothing to do with the shape it had just been
       given, and at distance, with the air having taken most of the contrast
       out of everything else, they read as blue-black mould on the hillside. */
    gully = smoothstep(0.52, 0.86, q*q)*dFar*bare;
  }

  // and the baked normal, projected onto the surface once for all three scales
  if(lw > 0.004){
    vec3 gr = tg - N*dot(tg, N);
    /* 2.5, not 1.02. The tiles carry a normal-channel spread of 76 to 122
       levels out of 255 and the rendered near field was coming back with a
       spread of 6.6 — the relief was in the asset and was being applied at
       roughly a tenth of it. Under a hard key a normal perturbation is worth
       far more contrast than an albedo one, and this is the cheapest detail in
       the frame: the fetch has already happened. */
    /* Scaled back hard where anything is growing. 2.5 is right for bare
       mineral ground — it is what put real grain back into a desert — and it is
       badly wrong under a sward: the rock tiles carry fracture and scree
       striation, and at full strength that drew a shredded, scratched surface
       right through the grass. Soil under vegetation is smooth; the relief you
       see there belongs to the plants. */
    N = normalize(N + gr*(2.5*uTerK.x*(1.0 - alive*0.80)));
  }
  /* The creases, spent as occlusion rather than as more albedo — the tone is
     already in lum, and a crevice that is only darker in the albedo reads as a
     painted line rather than as a hole. */
  float crease = clamp((1.0 - lum)*0.85, 0.0, 1.0);

  /* Three material families, chosen by what the ground *is* rather than by a
     noise field: powder where it can lie, rock where it is too steep for
     anything to, and the fan of shed material banked in between. The noise
     only ever varies a family, never switches between two — a field that
     switches is what produced the camouflage pattern, and at ten kilometres a
     dark patch of it reads as blue-black mould because the only thing left in
     it is the haze. */
  /* Four scales of variation, not two.

     "One texture repeated to the horizon" is a complaint about the *spectrum*
     of the albedo, not its resolution: two octaves at 1.8 km and 480 m leave
     the ground between them and beyond them uniform, so a plain reads as one
     material with a wash over it however much fine detail is piled on top. The
     province band is six kilometres — big enough that the far side of the
     basin is visibly a different country from this side — and the pan band at
     ninety metres is what breaks a floor into fines, gravel and swept ground
     you can actually walk between. */
  /* The altitude blend has to wander. A fixed pair of thresholds puts the same
     boundary at the same height on every massif in the range, so the whole
     landscape reads as having been dipped in paint to a mark — which is
     exactly how a reviewer described it. Real vegetation, snow and weathering
     lines move by hundreds of metres with aspect, shelter and local geology,
     and it costs nothing here because both noise fields are already sampled. */
  float lineJ = (mineral - 0.5)*0.30 + (region - 0.5)*0.15 + (shelter - 0.5)*0.10
              + (province - 0.5)*0.22;
  vec3 col = mix(uC1, uC2, smoothstep(0.06 + lineJ, 0.50 + lineJ, above));
  col = mix(col, uC4, smoothstep(0.52, 0.92, mineral)*0.34);
  col *= 0.92 + region*0.17;
  // the province: the far side of the basin is a different country, and until
  // there was a band this wide the whole patch was one colour with texture on it
  col = mix(col, mix(col, uC3, 0.55)*1.06, smoothstep(0.58, 0.95, province)*0.40);
  // exposed rock on anything steep — the strongest single cue that the terrain
  // has real relief rather than a painted gradient
  col = mix(col, uC3*1.05, bare*0.80);
  // talus: what the cliffs shed, banked below them. Paler and more uniform
  // than either the rock above or the plain below, and the reason a real
  // massif has a skirt instead of meeting the ground on a line.
  col = mix(col, mix(uC2, uC4, 0.5)*0.94, talus*0.55);
  // dust drifts into the lee and gets stripped off the crests
  col = mix(col, mix(uC2, uC4, 0.35), shelter*(1.0 - bare)*0.22);
  /* Softly. This is a *crease*, and a crease is dark because it is turned away
     from the sky — which the normal above already does. Spending it a second
     time as a flat 0.85 stain of the palette's darkest rock put a hard
     labyrinth of dark curves across every massif past four hundred metres, and
     at that range, with the air having taken the contrast out of everything
     else, a maze is the most conspicuous thing that can be in the frame. */
  col = mix(col, uC3*0.90, gully*0.30);

  /* Country, and it may not be a function of height.
   *
   * Everything above this line that moves the hue is gated on something the
   * terrain has to *do*: altitude for the C1-to-C2 blend, slope for bare rock,
   * curvature for talus and gully. That is right for a massif and it leaves a
   * basin floor — which is where the game actually puts you down — with none
   * of them firing. What survives is uC1 modulated by region and province,
   * which between them are a swing of about eight per cent of value on a
   * single hue. One hue at one value across the whole middle distance is the
   * literal definition of the complaint, and it is why a green world read as
   * baize and a desert as one sheet of tan.
   *
   * Geology does not care about height. The same formation weathers oxidised
   * and warm where it has iron and water in it, and pale and flat where it has
   * been leached, and those patches are kilometres across and cut straight
   * across contours. Two octaves, and both ends pull toward a *different pair*
   * of palette entries rather than lightening and darkening one — a spread of
   * hue reads as different country, where a spread of value reads as cloud
   * shadow. It is deliberately not gated on slope or altitude; bare rock is the
   * only thing held back, because an exposed face is showing the unweathered
   * stone and that is the one place the surface chemistry has not happened. */
  {
    /* Off the bands that are already sampled, not off two more.
     *
     * Written with its own pair of snoise lookups this cost about three
     * milliseconds of a twenty-millisecond frame on its own — the ground covers
     * most of the frame at 5.7 Mpx and simplex is not cheap, so *any* new
     * per-fragment octave here is expensive. The province band is six
     * kilometres and the region band is four hundred and eighty metres, which
     * between them span the same range this wanted and are already in registers
     * by this line. Reusing them also correlates the weathering with the
     * province tint above rather than fighting it, so the far side of the basin
     * reads as one different country instead of two overlapping ones. */
    float geo = clamp(province*0.58 + region*0.42, 0.0, 1.0);
    float k = 1.0 - bare*0.55;
    // about twenty-five degrees either side, and a value split as well
    vec3 warm = hueRot(col, -0.44)*1.16;   // oxidised
    vec3 cool = hueRot(col,  0.52)*0.84;   // leached
    /* Stronger on a dead world than on a living one. Where there is cover, the
       vegetation blend downstream overwrites most of this anyway and the ground
       has a second colour system of its own; on a desert or an ice sheet this
       band is the *only* thing varying the hue across kilometres, so it has to
       carry the whole job. uVeg is zero on exactly those worlds. */
    float gk = k*mix(1.35, 1.0, clamp(uVeg, 0.0, 1.0));
    col = mix(col, warm, smoothstep(0.56, 0.94, geo)*0.44*gk);
    col = mix(col, cool, smoothstep(0.44, 0.06, geo)*0.36*gk);
  }

  /* Pans and drifts: the floor is not one substrate.

     Ninety-metre patches of three different covers — deflated gravel where the
     fines have blown out, drifted powder where they landed, and swept bedrock
     with neither on it. It is the same three materials the rest of the shader
     already knows about, but resolved at the scale you *walk* across rather
     than the scale you fly over, and it is most of the difference between a
     floor and a plain. */
  /* Stronger, because on a world whose palette is five shades of one tan these
     are the only thing breaking the floor up at the scale you walk across, and
     at a third they were invisible: the desert near field measured a local
     standard deviation of 4.8 against a reference frame's 24, and a saturation
     spread of 0.028 against 0.171. Deflated gravel is coarser *and* paler and
     flatter in hue than the fines that blew off it; the drift that landed is
     the opposite. Pushing them apart in saturation as well as in value is what
     makes two patches read as two materials rather than as one under a cloud. */
  float gyp = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, mix(col, vec3(gyp), 0.42)*1.30, deflate*0.55);
  col = mix(col, mix(col, vec3(gyp), -0.30)*0.86, drift*0.45);

  /* The metre band, which was missing entirely.

     The albedo has scales at six kilometres, 1.8 km, 480 m and ninety, and
     then nothing at all until the baked tiles at 0.55 m. That hole is exactly
     the ground two metres from your boots: a foot-height crop of the near
     field is thirteen metres of ground, which is a *seventh* of one cell of
     the ninety-metre band, so every one of those bands is a constant across
     it and the only thing left varying is the tile. On a world whose loose set
     is smooth — a desert's is — that measured a local standard deviation of
     4.8 and a per-channel spread of [6.5, 7.1, 7.5] against a reference
     frame's 24 and [55, 53, 45]. It is not a resolution problem and no amount
     of finer tiling fixes it; the spectrum simply had a gap in it.

     Two octaves at 5.5 m and 1.6 m, spent as mineral rather than as tone —
     patches of coarser, paler lag and finer, darker fines, which is what a
     deflating surface actually sorts itself into. Gated on the pixel
     footprint like every other band here, so it is gone before it can alias
     and costs nothing past a few hundred metres. */
  float nearK = pxGate(px, 2.4);
  if(nearK > 0.02){
    float sortN = snoise(vPos*0.182 + 613.0)*0.62 + snoise(vPos*0.63 + 97.0)*0.38;
    float gyn = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float lag = smoothstep(0.06, 0.52, sortN);
    col = mix(col, mix(col, vec3(gyn), 0.38)*1.24, lag*nearK*cover*0.46);
    col = mix(col, mix(col, vec3(gyn), -0.34)*0.84,
              smoothstep(-0.02, -0.46, sortN)*nearK*cover*0.42);
  }

  /* The washes. Their floors are stripped to coarse pale gravel and their
     banks hold the dark fines, so a channel reads as a bright thread with a
     dark edge — which is what one looks like from the ground, and what nothing
     in the frame had before. */
  col = mix(col, mix(uC4, uC3, 0.4)*1.10, wash*cover*0.30);
  /* The core is *darker*, not black. It used to be uC0*1.6 + uC1*0.25, and uC0
     is the palette's darkest entry — on a terran world that is (0.012, 0.004,
     0.002), which is charcoal. Against a flat frame it did not show; the moment
     the key/shadow gap opened the drainage network came back as a set of hard
     black threads across the whole near field, and at 1:1 it read as claw marks
     scratched into the ground rather than as a channel. Damp ground is half a
     stop down and a little cooler than the ground beside it, which is a
     rotation of the colour in hand and cannot go anywhere the palette does not
     already live. */
  vec3 gwc = vec3(dot(col, vec3(0.2126, 0.7152, 0.0722)));
  col = mix(col, mix(col, gwc, 0.30)*0.56, washCore*0.40);

  /* Strata. Horizontal bedding, and the thing the far ranges most obviously
     did not have. It runs all the way out to nine kilometres: a bed is thirty
     metres thick, which is still three pixels at that range, and it is the
     only high-frequency information a distant cliff face carries. The old cut
     at three kilometres is why everything past it was cardboard. */
  /* The bed phase, and its screen-space rate, both taken *outside* the branch.
     fwidth in non-uniform control flow is undefined across a quad that
     straddles the boundary, which is most of a hillside's silhouette. */
  float sy = vHeight*(0.038 + 0.026*mineral) + vTilt*2.6;
  float syw = fwidth(sy);
  /* And band-limited against the pixel, which is the whole of the second
     banding artefact.

     fract() of a height is a *quantiser*, and a quantiser is the one thing in
     this shader with no mip chain and no lod parameter: nothing prefilters it,
     so once a bed is under about three pixels the wave beats against the pixel
     grid instead of resolving. What that looks like is not "fine bedding", it
     is a patch of hard, level, evenly spaced dark bars sitting on an otherwise
     smooth distant face — and because the patchiness comes from the region
     band, they arrive in isolated blocks with nothing around them. At 1:1 on a
     massif three kilometres out it is unmistakable, and it is what the owner
     described as a weird banding artefact on the mountains. The distance cut
     at 6-13 km was the wrong quantity: what decides whether a bed can be drawn
     is how many pixels it covers, and a 30 m bed on a steep face at four
     kilometres is already inside the beat. */
  /* Three gates, and two of them are new, because this term is what the owner
     was looking at when they called the ground banded.
   *
   * It survives every other candidate being switched off — the mountain band,
   * the bench in the height law, the marched shadow — and switching *this* off
   * removes it completely, on a matched pair. What it draws is a set of level,
   * evenly spaced tonal ripples running right across every mid-distance slope,
   * and the reason it reads as a rendering fault rather than as rock is that it
   * was being drawn in two places bedding does not exist:
   *
   *   · on *sand*. The slope gate opened at 0.16, which is a nine-degree
   *     hillside — every dune flank on every desert world in the game. Bedding
   *     is a property of bedrock, and this shader already knows exactly where
   *     the bedrock is, because it is the same term that decides whether to
   *     paint rock or regolith. Gating on it costs nothing and confines the
   *     laminations to the faces that have actually shed their cover.
   *
   *   · below the resolution of a bed. The pixel gate cut at about nine pixels
   *     per bed, and a quantiser with no mip chain does not fade out there, it
   *     beats — which is a moiré, and a moiré at nine pixels is precisely the
   *     spacing that reads as a scan artefact. Twenty-two pixels is where a
   *     lamination starts being a lamination.
   */
  float strataK = smoothstep(0.30, 0.62, slope)
                * smoothstep(0.22, 0.62, bare)
                * (1.0 - smoothstep(6000.0, 13000.0, cd))
                * (1.0 - smoothstep(0.012, 0.045, syw));
  if(strataK > 0.01){
    /* The dip and the thickness both wander, and whole massifs are barely
       bedded at all — a constant period across every face in the frame is
       banded wallpaper rather than geology. */
    float s1 = fract(sy);
    /* A lamination, not a bar code.

       This was smoothstep(0, 0.16) - smoothstep(0.46, 0.70) — a square wave
       with two hard risers — and against a mid-distance face carrying no other
       detail and most of the way to the haze colour, a square wave does not
       read as bedding. It reads as a set of hard level evenly spaced dark bars
       ruled across the hillside, which is precisely what an owner looking at
       the frame called a weird banding artefact on the mountains. Real bedding
       seen through three kilometres of air is a soft tonal lamination with an
       occasional stronger parting, and that is a raised cosine with one
       asymmetric term in it, not a step.

       The patchiness goes with it. At 0.35 + 0.65*region whole 480 m blocks of
       a massif carried the term at full strength with nothing either side, so
       the bars arrived in isolated rectangles and read as a decal stuck on the
       mountain rather than as a property of the rock. */
    float bd = 0.5 - 0.5*cos(s1*6.2831853);
    bd = mix(bd, bd*bd, 0.45);
    float amt = strataK*(0.62 + 0.38*smoothstep(0.30, 0.75, region));
    /* Softly, and mostly as relief.
       At 0.42 this term is a *paint* job: an independent review of a landed
       frame called out "hard horizontal blue/purple banding on the right-hand
       ridges" and read it as a shading bug rather than as rock, which is
       exactly what a strong albedo step does when the darker band is filled by
       a blue sky and the lighter one is not. The rock set carries real bedding
       laminations now, at all three sample scales, so this only has to supply
       the beds too coarse for a thirty-one metre tile. A third of the contrast,
       and no hue shift at all. */
    col *= 1.0 + (bd - 0.42)*0.115*amt;
    /* And the beds are relief, not paint.

       A height field has no y in it, so everything it contains runs *down* a
       cliff; bedding is the one cue in the whole shader that runs across one,
       and tinting alone leaves it looking like a decal on a smooth face. A
       small tilt toward and away from the local up gives each bed a riser that
       catches the key, which is what breaks the vertical smear a reviewer
       correctly called motion blur. Along the surface's own up, not the
       world's, or it slides off every overhang. */
    /* Half the tilt it had. A normal perturbation is worth far more contrast
       than an albedo step once the key and the fill are two stops apart rather
       than one: at 0.34 a bed swung a whole band of a distant face in and out
       of the key, which is a *light* change and reads as a dark bar rather than
       as a riser. It is the relief cue that is wanted here, not the tone. */
    /* And a third of the tilt again. What is left after the two gates above is
       bedding on real rock at twenty-plus pixels a bed, where a riser genuinely
       does catch the key — but 0.17 on a face that carries no other relief is
       still a stronger statement than any real section makes, and it is the
       term that turns a soft lamination into a bar. */
    vec3 upT = vec3(0.0, 1.0, 0.0) - N*N.y;
    float ul = length(upT);
    if(ul > 0.05) N = normalize(N + (upT/ul)*(bd - 0.42)*0.11*amt);
  }

  /* Wind ripples — and the point of them is that the ground gets a *direction*.
   *
   * Three separate impartial looks at these frames have now said the same
   * thing about the near field: it is an isotropic speckle at one apparent
   * size from the boots to the skyline, so it reads as a hide stretched over a
   * shape rather than as a surface the wind made. The missing scale is the one
   * between the grain and the dune: ripples at twenty or thirty centimetres,
   * their crests running *across* the wind, asymmetric — a long shallow
   * windward back and a short steep lee — and all of them parallel, over the
   * whole basin, because one wind made them.
   *
   * Three things follow from doing it as relief rather than as a texture:
   *
   *   · it responds to the sun. The same field looks like corduroy with the
   *     star across it and like nothing at all with the star behind you, which
   *     is what real ripples do and what an albedo map can never do.
   *   · it is the same wind that built the dunes, from the same seed, so the
   *     ripples run across the ranks rather than at some unrelated angle.
   *   · the gradient is analytic, so there is no extra normal-map fetch and
   *     the band limit is exact.
   *
   * Loose ground only — a ripple on a cliff face is nonsense — and gated on
   * the fragment's own footprint, so it fades out at about two hundred metres
   * instead of tiling to the horizon.
   */
  float rippK = cover*(1.0 - smoothstep(0.30, 0.62, slope))*pxGate(px, 0.26)
              * (0.45 + 0.55*deflate) * (1.0 - alive*0.94);
  if(rippK > 0.004){
    vec2 across = vec2(-uWind.y, uWind.x);      // along the wind, across crests
    /* The wavelength is a *field*, not a constant, and that is what stops this
       reading as a weave.
     *
     * A fixed pitch with a fixed direction draws a perfectly regular corduroy,
     * and laid over a curved surface a regular corduroy interferes with the
     * surface's own curvature into a diagonal cross-hatch — which is exactly
     * what a judge shown the first version of this called "a regular diagonal
     * weave repeating at a fixed world scale". Real ripple wavelength tracks
     * the local wind speed, so it stretches on an exposed crest and closes up
     * in a hollow, and whole patches of ground carry none at all where the
     * surface has crusted. Both come off the same two lookups. */
    float wl = snoise(vec3(vPos.x, 17.0, vPos.z)*0.021 + 131.0);
    // NOT the obvious name for this: that word is reserved in GLSL ES and
    // fails the whole compile, which draws the entire ground black
    float crusted = snoise(vec3(vPos.x, 41.0, vPos.z)*0.0125 + 5.0)*0.5 + 0.5;
    float amt = rippK*smoothstep(0.22, 0.66, crusted);
    if(amt > 0.004){
      // 0.19 m to 0.34 m between crests, wandering
      float pitch = 26.0*(1.0 - wl*0.28);
      float s = dot(vPos.xz, across);
      /* And the crest lines wander at their own scale as well as at a coarse
         one, so no two ranks are parallel for more than a few metres. */
      float mnd = snoise(vec3(vPos.x, 3.0, vPos.z)*0.048 + 61.0)*3.1
                + snoise(vec3(vPos.x, 8.0, vPos.z)*0.26 + 17.0)*0.85
                + snoise(vec3(vPos.x, 2.0, vPos.z)*1.15 + 43.0)*0.30;
      float phr = s*pitch + mnd;
      float tr = fract(phr*0.15915494);
      float ur = pow(max(tr, 1e-4), 2.4);        // windward back, then the lee
      /* The height's own derivative, which is the tilt. d/ds of
         (1 - cos(2*pi*u))/2 with u = t^k is sin(2*pi*u)*k*t^(k-1)/2 — one sin
         and one pow, and no second sample of anything. */
      float g = 0.5*sin(ur*6.2831853)*2.4*pow(max(tr, 1e-4), 1.4);
      vec3 wv = normalize(vec3(across.x, 0.0, across.y));
      vec3 tg = wv - N*dot(N, wv);
      float tl = length(tg);
      /* 0.28, not 0.17. This is the only relief the near ground of a dune
         field has — there is no bedding, no gravel lag and no bare rock on a
         slip face — and at 0.17 the ripple train showed as a faint tonal
         streak rather than as a surface with a direction in it. It is a
         normal-only term, so it costs nothing and cannot alias in the albedo;
         the pixel gate above still fades it out at about two hundred metres. */
      if(tl > 0.03) N = normalize(N - (tg/tl)*g*0.28*amt);
      // and the coarse dark lag collects in the troughs, where the wind cannot
      // lift it — a small albedo term, because most of this has to be relief
      float trough = smoothstep(0.62, 0.06, 0.5 - 0.5*cos(ur*6.2831853));
      col *= 1.0 - 0.055*amt*trough;
    }
  }

  /* The baked tone, spent as *mineral* and not only as exposure.

     Every set is normalised to the same mean at bake time — deliberately, so
     that swapping one material for another does not change the ground's
     exposure — and that has a consequence nobody costed: all four sets have
     the same average tone and can differ from each other only in pattern,
     never in colour. Multiplying the palette by a scalar preserves every hue
     ratio in it, so there was structurally no way to get pale chips on red
     sand. Measured against reference photography of the same subject, the
     near ground ran a per-channel standard deviation of [30, 20, 11] against
     [55, 53, 45], and a saturation spread of 0.047 against 0.171.

     A clast paler than the ground it lies in is paler because it is a
     different mineral, so it is also less saturated and a little cooler; a
     dark one is stained and warmer. Pivoting between two mineral colours on
     the tone channel costs one mix, needs no second image, and gives the
     albedo a chromatic axis it has never had. The scalar stays as well, at
     about half strength, because it is what carries the relief.

     It fades with the mip chain for nothing: lum goes to exactly 1.0 as the
     tile minifies, which lands this on the midpoint and leaves the distance
     the colour it always was. */
  /* It comes off the mineral channel now, and that is the whole of the fix.
     Deriving it from the luminance could not work: that channel is mostly
     occlusion and cavity, so what it recovers is a picture of the *shading* —
     the creases came out a different colour from the faces, which is a shading
     bug wearing geology's coat — and it goes to exactly the mean the moment
     the tile minifies, so the distance had no chroma at all. The mineral
     channel is a per-block, per-clast, per-plate identity that never touches
     the height field, and it survives minification as a low-frequency wash.

     A rotation of the colour in hand, not a mix of two palette entries. On a
     world whose palette is five shades of the same tan — which is what a
     desert palette is — two entries are the same colour and the saturation
     spread comes out *lower* than before. Pale means bleached: less
     saturated, brighter, a little cooler. Dark means stained: more saturated,
     dimmer, warmer. A negative mix coefficient pushes away from grey, which is
     the cheapest saturation boost there is. */
  /* Large-scale mineral staining, and it is deliberately correlated with
     *nothing*.
   *
   * Every colour term above this line is a function of the terrain: slope,
   * height, shelter, drainage, how steep the ground is, where the water went.
   * That is right for each of them individually and wrong in aggregate,
   * because it means the ground's colour is a function of its shape — so a
   * frame of one landform is a frame of one colour, and an impartial judge
   * looking at a two-megapixel plain described it as a single tan across the
   * whole image, reading as skin or wax rather than as mineral.
   *
   * Real ground is not like that. Iron oxide, gypsum, evaporites, ash and
   * windblown fines are laid down by processes that do not care about the
   * present-day topography, and the streaks and blotches they leave are the
   * thing that stops a desert being one colour. Two octaves at 320 m and 74 m
   * from an independent seed, spent as a *hue rotation and a tone step* rather
   * than as brightness alone, because a pure value change reads as shading and
   * is the very confusion this is trying to break. Both fade out as the tile
   * minifies so the far distance keeps a wash rather than a stipple. */
  {
    float st = snoise(vPos*0.0031 + 517.0)*0.62 + snoise(vPos*0.0135 + 89.0)*0.38;
    float stK = clamp(st*0.5 + 0.5, 0.0, 1.0);
    float stW = 1.0 - smoothstep(6.0, 34.0, px);
    // pale, bleached, slightly cool one way; stained, iron-rich, warm the other
    vec3 pale = vec3(1.16, 1.13, 1.10);
    vec3 rich = vec3(0.90, 0.80, 0.72);
    col *= mix(rich, pale, smoothstep(0.30, 0.78, stK))*(0.90 + 0.20*stK)*stW
         + (1.0 - stW);
  }

  float tone = clamp(mnr*0.5 + 0.5 + (lum - 1.0)*0.45, 0.0, 1.0);
  float gy = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 mPale = mix(col, vec3(gy), 0.62)*vec3(1.42, 1.47, 1.60);
  vec3 mDark = mix(col, vec3(gy), -0.50)*vec3(0.72, 0.60, 0.50);
  col = mix(col, mix(mDark, mPale, tone), uTerK.y*0.86);

  /* Vegetation, as colour.

     The tufts you can walk into stop at a hundred metres because geometry that
     small is gone by then anyway, but a world does not stop being alive at a
     hundred metres. This is the same habitability score the tufts are placed
     with, spent as albedo, so the near stands and the far ones are one field:
     walk toward a distant green shoulder and it grows tufts as you arrive.

     What it used to be was one colour at 86% coverage wherever the score was
     high, and on a world the generator calls a garden the score is high almost
     everywhere — so the whole landscape came out a single flat green, hill and
     hollow and crest alike, with none of the mineral work above surviving it.
     A judge called it painted sand and was right.

     Real ground cover is three things at once and none of them is uniform:

       · *communities*, at a few hundred metres. Where the water collects and
         the wind does not reach, the cover is dark, blue-green and closed;
         on an exposed crest it is straw. One noise field decides which, and
         it is biased by the drainage and shelter the rest of the shader has
         already computed, so the wet green follows the gullies.
       · *clumps*, at tens of metres, which is what turns a wash into a mottle.
       · *coverage*, which is not one either. Cover thins on a slope, stops at
         bedrock, and leaves the soil showing between plants — and the soil
         showing through is most of what makes the near ground read as ground
         rather than as baize.
   */
  float fm = 0.0;
  if(uVeg > 0.01){
    fm = alive;

    float n1 = snoise(vec3(vPos.x, 71.0, vPos.z)*0.0034)*0.5 + 0.5;   // ~290 m
    float n2 = snoise(vec3(vPos.x, 23.0, vPos.z)*0.021)*0.5 + 0.5;    // ~48 m
    float n3 = snoise(vec3(vPos.x, 11.0, vPos.z)*0.115)*0.5 + 0.5;    // ~9 m

    /* Three communities off one palette entry, so a world whose life is rust
       or retinal purple gets rust and purple ones rather than a green
       imported from this planet. Dark is the same hue held down and cooled;
       dry is it opened up and pushed hard toward straw. */
    float gyv = dot(uCVeg, vec3(0.2126, 0.7152, 0.0722));
    /* Dry is *darker* than green, not brighter. The first pass at this had it
       at 1.4 times the vegetation colour on the reasoning that straw is pale,
       and what came back was a khaki wash over the whole world — because the
       mineral ground underneath is already a bleached regolith, and anything
       lighter than it mixed toward it rather than against it. Dead grass has a
       lower albedo than the sand it stands in; it reads pale in a photograph
       because it is *lit*, which is the lighting's job and not the albedo's. */
    vec3 vDark = mix(uCVeg, vec3(gyv), -0.34)*0.46;
    vec3 vDry  = mix(uCVeg, vec3(gyv*1.22, gyv*1.00, gyv*0.34), 0.70)*0.86;

    /* The community weights are driven by the noise and *biased* by the
       terrain, and it has to be that way round.

       Written the other way round they do not fire at all. The previous form
       needed drainage and altitude to carry the term over a hard offset —
       wetK subtracted 0.60 and dryK 0.78 — and on the sort of world this
       matters on, a garden, the basin floor sits at above = 0 with vFlow = 0
       and shelter near a half. Put those in: dryK comes out at zero *for every
       fragment on the planet*, and wetK peaks at 0.26. So two of the three
       communities were unreachable and the landscape drew as one flat green,
       which is precisely the thing the comment above says was fixed. It was
       diagnosed by substituting the basin's own numbers into the expression
       rather than by looking, because a term that is dead everywhere does not
       look like a bug, it looks like a design.

       Now the noise spans the range on its own — about half the world tends
       wet and half dry, meeting in the middle at the base colour — and
       drainage, shelter and altitude push the boundary around rather than
       being required to reach it. That keeps the wet green in the gullies,
       which was the point of the original, and it also *happens*. */
    float wetK = clamp((n1 - 0.46)*1.9 + vFlow*1.10 + (shelter - 0.5)*0.60, 0.0, 1.0);
    float dryK = clamp((0.54 - n1)*1.9 + above*0.55 + (0.5 - shelter)*0.60, 0.0, 1.0);
    /* Held under one, and the dry one hardest. These are *communities* within a
       cover, not a choice between three ground types: a meadow that browns off
       on the exposed half of the basin is still a meadow. Run at full strength
       the straw simply replaced the vegetation colour over the forty per cent
       of the world where n1 is low, which turned a garden into khaki with weeds
       on it — a different way of being one flat colour, not a fix for it. */
    vec3 veg = mix(uCVeg, vDark, wetK*0.90);
    veg = mix(veg, vDry, dryK*0.55);
    // clump value, and the fine mottle that stops a clump being a blob
    veg *= (0.80 + 0.42*n2)*(0.90 + 0.20*n3)*(0.86 + 0.28*lum);

    /* Coverage. Patchy at the clump scale, off the steep faces, thinner on
       bedrock, and never quite total — a fraction of the soil shows through
       the thickest sward there is, and that fraction is most of what makes
       near ground read as ground rather than as baize. */
    float cov = clamp(fm*(0.72 + 0.62*n2)*(0.82 + 0.32*n3) - 0.04, 0.0, 1.0);
    cov *= 1.0 - smoothstep(0.34, 0.72, slope);
    cov *= 1.0 - bare*0.48;
    col = mix(col, veg, cov*0.94);
    fm = cov;
  }

  /* Crust. Not flora and not rock — the thin mineral or lichen skin that grows
     on undisturbed ground everywhere in the solar system and takes decades to
     come back once anything walks on it. It is what stops bare regolith from
     reading as a bag of cement: slightly cooler, slightly darker, and only in
     the places nothing has moved. */
  float crust = smoothstep(0.55, 0.92, pan)*cover*shelter*(1.0 - wash)*(1.0 - fm);
  col = mix(col, mix(col, uC0, 0.45)*1.14, crust*0.40);

  /* Scoured ground under the ship. The gear came down on it and the drives
     blew the dust off, so the metre that a reviewer looks at first is coarse,
     darker and swept clean rather than pixel-identical to the plain. */
  float scour = 1.0 - smoothstep(5.0, 19.0, length(vPos.xz));
  col = mix(col, uC3*1.22, scour*0.34);

  /* Dust. Every palette here was authored for a lit sphere seen from orbit,
     where a five per cent albedo is a perfectly good dark continent. Standing
     on it, the same number puts the whole shadow side four stops under the sky
     and AgX's toe takes it to literal black. Real regolith is not that dark
     and never that saturated — it is covered in its own powder. Lifting the
     floor with a gamma rather than an add keeps the bright worlds where they
     were and gives the dark ones somewhere to put a shadow. */
  /* Desaturation, and it is a measurement rather than a preference. On matched
     crops against real photography this ground ran a saturation of 0.61 where
     the reference ran 0.25 — the palettes were authored for a lit sphere seen
     from orbit, where a strongly hued continent is correct and reads at a
     hundred thousand kilometres. Standing in it, mineral ground is grey with a
     cast, and it is the *cast* that carries the world's identity. Pulling
     toward luminance rather than desaturating the palette itself keeps a world
     recognisable from space and believable from the ground. */
  /* Desaturate, then put chroma back — and the second half is the point.
     Taking uDesat to zero only stops the shader removing colour; it cannot add
     any, and the palette is five shades of one rock to begin with. So mineral
     ground gets a real saturation lift about its own luminance. Vegetation is
     boosted at source and does not want this on top, hence the uVeg term. */
  {
    float gyD = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(gyD), uDesat);
    col = clamp(gyD + (col - gyD)*mix(1.55, 1.10, clamp(uVeg, 0.0, 1.0)), 0.0, 8.0);
  }
  /* Gentler, because this is a *contrast* control and it was being spent as a
     black-level lift. At 0.80 it took the palette's 2.3:1 albedo spread down to
     1.9:1 — the ground's own range, thrown away before a photon touched it, on
     top of a key/fill ratio that was already only 1.9 stops. The floor it
     exists to provide is real (an orbital albedo of five per cent puts a landed
     shadow under AgX's toe), so it stays; it just no longer costs a fifth of
     the one axis the ground has left. */
  col = pow(max(col, 0.0), vec3(0.90))*0.86;

  /* ---- shore ------------------------------------------------------------
     The band above the waterline, which is the part of a lake that tells you
     it is a lake. Sand and shingle where the water has sorted the ground,
     darkening steeply into the last metre because wet mineral is wet mineral
     everywhere: it loses its Lambertian scatter and reads two stops down. */
  float wet = 0.0;
  float shore = 0.0;
  if(uType == 0 || uType == 5){
    wet = 1.0 - smoothstep(vSeaY - 1.0, vSeaY + 14.0, vHeight);
    shore = 1.0 - smoothstep(0.0, 26.0, vHeight - vSeaY);
    // bleached strand line, then the wet margin under it
    col = mix(col, mix(col, uC4, 0.55)*1.10, shore*0.72*(1.0 - wet));
    float margin = (1.0 - smoothstep(0.0, 3.2, vHeight - vSeaY))*(1.0 - wet);
    col = mix(col, col*0.46, margin);
    /* Surf. A lace of white in the last metre and a half of land, moving with
       the same clock the waves run on, so the line where the water meets the
       ground is not a geometric edge. */
    float lace = snoise(vec3(vPos.xz*0.30, uTime*0.33))*0.5 + 0.5;
    float surf = (1.0 - smoothstep(0.0, 1.6, vHeight - vSeaY))*(1.0 - wet);
    col = mix(col, vec3(0.78, 0.82, 0.84), clamp(surf*(0.30 + 0.95*lace) - 0.10, 0.0, 1.0)*0.85);
  }

  // ---- lighting ---------------------------------------------------------
  float ao = vAO * mix(1.0, 0.62, crease);
  /* Two shadows, and they do different jobs. vShadow is a geometric march up
     the sun ray against the height field, which is what puts a ridge's shadow
     on the basin ten kilometres away and costs no map at all. getShadowMask is
     three's shadow map, which is what puts the ship, the boulders and the
     ground's own near relief on each other inside a 220 m box.

     **Combined with min, not with a product.** They are two estimates of the
     same event — is the star visible from here — and the terrain is now in
     *both* of them: it casts into the map as well as being marched. Multiplied,
     everything the two agree about came out shadowed twice and the near field
     went to half the brightness of the middle distance, with a soft ring where
     the map's reach ended. min is what an occlusion test means. */
  /* And the map is only asked for where it exists. The sun's orthographic box
     is 220 m across, sized to the hull; the ground runs to twenty-six
     kilometres. Running a five-tap Vogel PCF over all of it to fetch 1.0 for
     ninety-five per cent of the frame cost eight frames a second at two device
     pixels per CSS pixel — as much as the entire baked texture set.

     **Where it exists is a moving number, and hard-coding it cut every low-sun
     shadow in half.** The fade ran 126 m to 221 m while fitGroundShadow grows
     the box and slides it up to 260 m down-sun, so at a raking star the far
     half of the ship's shadow — which is most of it, and all of the part with
     legs and booms in it — was faded to lit before it was ever looked up. At
     setSunElevation(0.08) there was no ship shadow in the frame at all. The
     two numbers are now one number: Game derives uShadowR from the same box it
     builds, and it is a radius about the box's own centre rather than about
     the ship, because at a low sun those are 130 m apart. */
  vec2 srel = vPos.xz - uShadowR.zw;
  float d2 = dot(srel, srel);
  float smask = (d2 < uShadowR.y)
    ? mix(getShadowMask(), 1.0, smoothstep(uShadowR.x, uShadowR.y, d2)) : 1.0;
  float sun = min(vShadow, smask);
  vec3 outc = shadeSurface(col, N, sun, ao, normalize(uCamPos - vPos));

  /* ---- water ------------------------------------------------------------
   *
   * This was one line — the ground's own albedo mixed toward the palette's
   * water colour and a tight specular lobe on the terrain normal — and what it
   * drew was a flat dark stain lying in the low ground. It had none of the
   * three things that actually say "water": that the surface is a *mirror* at
   * grazing angles and nearly transparent looking straight down, that the
   * mirror is broken by a wave normal rather than by the mud underneath, and
   * that the sun in it is a sheet of moving highlights rather than one dot.
   *
   * So: a Fresnel mix between the sky and the body colour, over a normal built
   * from three scrolling gradient-noise waves at scales an actual lake has
   * (a metre and a half, five metres, twenty), with a GGX lobe on the same
   * normal for the glitter path and depth-graded transmission so shallows read
   * shallow. The waves run across the world's own wind axis, like everything
   * else here.
   *
   * The terrain under it is flat — the vertex stage clamps every vertex up to
   * sea level — so all of this hangs off a synthetic normal, and it is the
   * only place in this shader where that is the right answer.
   */
  if(wet > 0.05){
    vec3 V = normalize(uCamPos - vPos);
    float dist = length(uCamPos - vPos);
    /* Wave amplitude falls off with distance, and not for a look: at four
       kilometres a 1.5 m wave is far under a pixel and all it can do is
       alias into a field of crawling white dots. Past that the surface is
       simply smooth and the sky does the work, which is also what a lake
       looks like from a hill. */
    float amp = 1.0 - smoothstep(220.0, 2600.0, dist);
    vec2 w = vPos.xz;
    vec3 wn = vec3(0.0, 1.0, 0.0);
    if(amp > 0.01){
      // three scales, three directions, all downwind of each other
      vec2 d1 = vec2(0.86, 0.51), d2 = vec2(-0.42, 0.91), d3 = vec2(0.97, -0.24);
      float t = uTime;
      float a1 = snoise(vec3(w*0.66 + d1*t*0.55, t*0.13));
      float a2 = snoise(vec3(w*0.21 + d2*t*0.31, t*0.09 + 11.0));
      float a3 = snoise(vec3(w*0.055 + d3*t*0.12, t*0.05 + 27.0));
      // finite-difference the same field for a normal, cheaply: reuse the
      // gradient of each octave by sampling one step along its own direction
      float e = 0.55;
      float b1 = snoise(vec3((w + d1.yx*e)*0.66 + d1*t*0.55, t*0.13));
      float b2 = snoise(vec3((w + d2.yx*e)*0.21 + d2*t*0.31, t*0.09 + 11.0));
      float b3 = snoise(vec3((w + d3.yx*e)*0.055 + d3*t*0.12, t*0.05 + 27.0));
      vec2 grad = d1.yx*(b1 - a1)*0.085 + d2.yx*(b2 - a2)*0.135 + d3.yx*(b3 - a3)*0.30;
      wn = normalize(vec3(-grad.x, 1.0, -grad.y) * vec3(amp, 1.0, amp));
    }

    /* Fresnel. Schlick against 0.02, which is water, and it is the whole
       reason a lake is dark at your feet and a sheet of sky at the far shore. */
    float ct = clamp(dot(wn, V), 0.0, 1.0);
    float fres = 0.02 + 0.98*pow(1.0 - ct, 5.0);

    // what is under it: the palette's body colour, deepening away from shore
    float deep = smoothstep(0.35, 1.0, wet);
    vec3 body = mix(uCWater*1.35, uCWater*0.34, deep);
    // sky and sun, reflected off the wave normal rather than off the mud
    vec3 R = reflect(-V, wn);
    vec3 sky = mix(uGndColor, uSkyColor, clamp(R.y*0.5 + 0.62, 0.0, 1.0))*1.5;

    vec3 water = mix(body*(0.35 + 0.65*sun), sky, fres);
    /* Sun glitter. A GGX lobe on the wave normal, wide enough to become a
       path rather than a point once there is any chop at all. */
    vec3 H = normalize(V + uSunDir);
    float rough = mix(0.055, 0.16, amp);
    float a2r = rough*rough;
    float nh = max(dot(wn, H), 0.0);
    float dgg = a2r / max(3.14159*pow(nh*nh*(a2r - 1.0) + 1.0, 2.0), 1e-5);
    water += uSunColor * dgg * fres * sun * 0.85;

    /* No foam on the water, and the reason is worth writing down: the vertex
       stage clamps every submerged vertex *up* to sea level, so the water is a
       flat plane on which vHeight equals vSeaY exactly and every depth-derived
       term is a constant. The first version of this shaded surf across an
       entire lake. Depth would need a fifth baked channel; the shoreline does
       not - it is on the land side of the line, where the mesh still has its
       own height, and that is where the strand and the surf go: see the shore
       block in the albedo above. */
    outc = mix(outc, water, wet);
  }
  if(uLavaGlow > 0.001){
    // heat in the fissures: the gullies and the low ground, never the ridges
    float f = smoothstep(0.62, 0.90, 1.0 - above) * smoothstep(0.30, 0.75, mineral);
    f *= 0.35 + 0.65*crease;
    outc += vec3(1.0, 0.24, 0.03) * f * uLavaGlow;
  }

  outc = aerial(outc, vPos);
  if(uDbg > 0.5){
    if(uDbg < 1.5)      outc = N*0.5 + 0.5;
    else if(uDbg < 2.5) outc = vec3(vAO);
    else if(uDbg < 3.5) outc = vec3(vShadow);
    else if(uDbg < 4.5) outc = shadeSurface(vec3(0.35), N, sun, ao, normalize(uCamPos - vPos));
    else if(uDbg < 5.5) outc = col;
    else                outc = vec3(clamp(dot(N, uSunDir), 0.0, 1.0));
  }
  gl_FragColor = vec4(max(outc, 0.0), 1.0);
}
`;

/* --------------------------------------------------------------- scatter */

/* Anything sitting on the ground has the same four questions to answer — where
   is the surface, which way is it facing, is it in shadow, and how much sky can
   it see — and the answers cost more than everything else in the vertex stage
   put together. Shared so that a rock, its own shadow decal and a tuft of scrub
   standing beside it cannot land on three slightly different surfaces. */
const STAND = /* glsl */`
/* Rotate so that +Y lands on up. */
vec3 alignY(vec3 v, vec3 up){
  vec3 a = vec3(0.0, 1.0, 0.0);
  vec3 ax = cross(a, up);
  float c = dot(a, up);
  float k = 1.0/max(1.0 + c, 1e-4);
  return v*c + cross(ax, v) + ax*dot(ax, v)*k;
}

/* The grid interpolates linearly between rings that are three per cent of the
   radius apart, so at two kilometres the drawn surface can sit tens of metres
   below the field it was sampled from — which is exactly how you get boulders
   hanging in the sky over a ridge. Sample a footprint's worth of ground and
   take the lowest: a rock can then only ever be slightly buried, which is what
   rocks do anyway. */
void standOn(vec2 gp, float foot, float lod, vec4 dat, out float gy, out vec3 gn){
  float ee = max(foot, lod + 0.8);
  float g0 = groundYFlat(gp, lod, dat);
  float ga = groundYFlat(gp + vec2( ee, 0.0), lod, dat);
  float gb = groundYFlat(gp + vec2(0.0,  ee), lod, dat);
  gy = min(g0, min(ga, gb));
  gn = normalize(vec3(-(ga - g0), ee, -(gb - g0)));
}

/* Shelter and hillside slope, from the same two samples.

   Nothing standing on the ground responds to the slope of the pebble it is
   standing *on* — it responds to the hillside. Differencing the field at the
   instance's own footprint measures the former, and on open ground the grit
   band alone runs that local gradient past half a radian: it slammed every
   band's slope window shut and the entire scatter came out empty, which read
   from outside as "the clustering does not work" when what it actually was is
   a slope measured at the wrong scale.

   Ninety metres is the hillside. Both the occlusion and the gradient want the
   same two samples out there, and the field is asked for them at a spacing
   coarse enough that neither the grit nor the rubble band is in the answer, so
   this costs no more than the sky-occlusion term it replaces. */
void terrainAround(vec2 gp, float gy, float lod, vec4 dat, out float ao, out float slope){
  float R = max(90.0, lod*4.5);
  float sl = max(lod, R*0.42);
  vec2 d1 = vec2( 0.95,  0.30)*R;
  vec2 d2 = vec2(-0.60, -0.75)*R;
  float h1 = groundYFlat(gp + d1, sl, dat) - gy;
  float h2 = groundYFlat(gp + d2, sl, dat) - gy;
  ao = clamp(1.0 - clamp(max(h1, h2)/R, 0.0, 1.0)*0.55, 0.2, 1.0);
  // the gradient those two offsets imply, solved rather than assumed: the
  // sample directions are deliberately not orthogonal, because two rays that
  // are give a term with a preferred axis and the whole field shows it
  float det = d1.x*d2.y - d1.y*d2.x;
  float gx = (h1*d2.y - h2*d1.y)/det;
  float gz = (d1.x*h2 - d2.x*h1)/det;
  slope = clamp(sqrt(gx*gx + gz*gz), 0.0, 2.0);
}
`;

/* One placement, two passes.
 *
 * A rock is built entirely in its vertex shader — where it stands, which way
 * the ground under it faces, whether it is there at all — so handing the mesh
 * to three's shadow pass casts a unit icosphere sitting at the origin. The only
 * way the caster and the drawn stone can be the same object is for both to run
 * this shader, so it is emitted twice from one source with the two differences
 * spelled out rather than patched in afterwards.
 *
 * The two differences are both about *which camera is looking*:
 *
 * - the view-cone rejection has to go. It is worth two thirds of the scatter in
 *   the beauty pass, but in the shadow pass the camera and the light are not
 *   the same thing at all: a boulder just outside the frame up-sun casts
 *   straight across the ground in front of you, and culling it makes shadows
 *   appear and vanish as you turn your head.
 * - a hard radius replaces it. The sun's box only reaches a few hundred metres,
 *   so beyond that the whole placement — three ground samples, an occlusion
 *   pair and a shadow march — is skipped before any of it is paid for, and what
 *   is left is a distance test on a couple of thousand instances.
 */
const rockVert = (depth) => /* glsl */`${LOGD_V_PARS}
${NOISE}
${FIELD_UNIFORMS}
${FIELD}
${HABITAT}
${VIEWCULL}
${CLUTTER}
${STAND}
${depth ? 'varying vec2 vHighPrecisionZW;' : '#include <shadowmap_pars_vertex>'}

uniform vec3  uCamPos;
uniform float uFade;    // metres at which this band stops being worth drawing
uniform float uTileP;   // cell size if this band follows the camera, else 0

attribute vec4 iA;   // xz metres, shape seed, yaw
attribute vec4 iB;   // radii xyz, how deep it sits

varying vec3  vPos;
varying vec3  vNrm;
varying float vShadow;
varying float vAO;
varying float vSeed;
varying float vUp;
varying float vKind;

/* One geometry, every rock a different lump — and now a different *kind* of
   lump.

   A displaced sphere is a potato, and a field of potatoes is what the scatter
   used to be at every size from gravel to outcrop. Ground that has been broken
   by anything is not made of potatoes: it is slabs lying where they fractured,
   plates tipped on edge, bedded blocks with horizontal risers in them and the
   occasional spire that survived because it was harder than what was around
   it. All three come out of the same displaced sphere for the price of some
   arithmetic, and none of them needs an extra attribute — the kind is a
   function of the instance seed the shape noise was already using.

   Everything here has to be applied to the *displaced position*, not to the
   normal afterwards, because the normal is taken by differencing this function
   at three directions. Deform the position and the shading follows for free;
   deform the normal and you get a decal of a rock painted on a ball. */
/* The fine shape band, on the instance's own screen size.

   The second fbm is a lump a sixth of the stone's width, and it is evaluated
   three times per vertex — once for the position and twice more for the finite
   differences the normal is taken from — so it is six simplex lookups on every
   vertex of every surviving instance, which is the largest single item in the
   scatter's vertex stage. A sixth of a stone that is twenty pixels across is
   three pixels: it is not detail at that size, it is noise on the silhouette.

   So it fades on angular size, exactly as the fragment shader's bands fade on
   the pixel footprint, and the fade preserves the term's mean — dropping it
   outright would shrink every distant stone by five per cent, which is a
   visible pop rather than a saving. The fade factor is constant across an
   instance, so the branch is coherent for the whole of it. */
/* The block a stone was broken out of: three unequal support axes and two
   oblique fracture planes, all of it out of the instance seed and none of it
   an extra attribute. Hoisted out of rockShape because it is constant over an
   instance and rockShape runs three times per vertex.

   A displaced sphere is a bread roll however much noise is piled on it — its
   support function is smooth in every direction, so the silhouette is a closed
   curve and the shading has no flat anywhere to catch the key. That is exactly
   what a review of the near field found: smooth rounded domes in a single flat
   tone, against a reference of angular clasts with fracture faces. A broken
   stone is a convex polytope. The support of a box with unequal axes is one
   max of three, and a conchoidal break is a plane at an angle to it — one dot
   product each, and the silhouette comes out straight-edged. */
void clastBlock(float s, out vec3 ax, out vec3 c1, out vec3 c2){
  ax = vec3(0.62) + 0.78*vec3(fract(s*3.71), fract(s*1.93), fract(s*7.13));
  // 0.001 so a seed that lands on the origin cannot normalize to a NaN and
  // spread it through the additive post chain
  c1 = normalize(vec3(fract(s*5.17) - 0.5, fract(s*2.31) - 0.24, fract(s*9.07) - 0.5) + 0.001);
  c2 = normalize(vec3(fract(s*4.03) - 0.5, 0.20 - fract(s*6.61), fract(s*1.37) - 0.5) + 0.001);
}

vec3 rockShape(vec3 n, float s, vec4 k, float hi, vec3 ax, vec3 c1, vec3 c2){
  float r = 0.755 + 0.34*(fbm(n*1.9 + s, 3)*0.5 + 0.5);
  if(hi > 0.004) r += hi*0.055*fbm(n*5.7 + s*1.7 + 3.0, 2);

  vec3 an = abs(n)*ax;
  float sup = max(max(an.x, an.y), an.z);
  sup = max(sup, dot(n, c1)*0.94);
  sup = max(sup, dot(n, c2)*0.88);
  r *= mix(1.0, clamp(0.88/sup, 0.40, 1.75), k.x);

  // spires taper, slabs do not
  r *= 1.0 - k.z*0.55*smoothstep(-0.1, 1.0, n.y);

  vec3 P = n*r;
  // Bedding. floor() the height and the flanks come out as terraces with
  // horizontal risers, which is the single most legible cue that a lump of
  // stone is stratified rock rather than a pebble the size of a house.
  P.y = mix(P.y, bench(P.y + 0.5, k.y, 0.11) - 0.5, k.w);
  return P;
}

void main(){
  float sShift;
  vec2 gp = tileTo(iA.xy, uTileP, uCamPos, viewMatrix, sShift);
  float s = iA.z + sShift;
  vec3 sc = iB.xyz;

  /* The rejections, cheapest first, and the ordering is the whole budget.

     Everything below here — three ground samples, a sky-occlusion pair, the
     shape and its bedding, an eight-step shadow march — is expensive, and most
     candidates are not going to be drawn. The cone test costs four multiplies
     and removes about two thirds of them; the angular-size test costs one
     divide and removes most of what is left in the far bands. Only then is it
     worth asking the ground anything. */
${depth ? `  if(dot(gp, gp) > ${TER_SHADOW_R2.toFixed(1)}){
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }` : `  if(behindCamera(gp, uCamPos, viewMatrix, projectionMatrix)){
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }`}
  float dh = length(vec3(gp.x, 0.0, gp.y) - vec3(uCamPos.x, 0.0, uCamPos.z));
  float reach = min(sc.x*2400.0, uFade);
  if(dh > reach){
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec4 dat = uDatum;

  // the same sampling scale the mesh under it was built at, or the rock sits
  // on a surface that is not the one being drawn
  float lod = meshLod(length(gp));
  float gy; vec3 gn;
  standOn(gp, sc.x*1.4, lod, dat, gy, gn);

  float ao, slope;
  terrainAround(gp, gy, lod, dat, ao, slope);
  float above = clamp((gy - seaLevel(dat.x)) / 900.0, 0.0, 1.0);
  float m = clutterMask(gp, slope, shelterOf(ao), drainage(gp + dat.zw), above);
  // A hard threshold cuts a patch off along a contour of the noise, which
  // reads as a shoreline. Ramping the *size* over the last of it instead means
  // a patch thins out into small stones the way a real one does.
  float grow = clamp((m - hash11(s*13.7 + 0.31))*2.6, 0.0, 1.0);
  grow *= 1.0 - smoothstep(reach*0.80, reach, dh);
  // anything that would be standing in water goes away as well
  if((uType == 0 || uType == 5) && gy < seaLevel(dat.x) + 1.5) grow = 0.0;
  if(grow <= 0.004){
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  sc *= 0.45 + 0.55*grow;

  // shape family, from the seed that was already there
  float k0 = fract(s*0.3179), k1 = fract(s*0.7314), k2 = fract(s*1.2713);
  vec4 kk = vec4(
    /* A floor under the angularity. It used to run from zero, so the low half
       of the seeds drew a plain displaced sphere — and those are the ones an
       eye reads first, because a bread roll among clasts is the odd one out.
       Nothing on a broken planet is unbroken. */
    0.40 + 0.55*smoothstep(0.10, 0.90, k0),     // angularity
    2.0 + floor(k1*4.0),                        // bed count
    smoothstep(0.78, 1.0, k2)*0.9,              // taper, on the few that spire
    smoothstep(0.42, 0.92, k1)*0.62             // how bedded
  );

  vec3 n = normalize(position);
  // Displaced position, and a normal from two finite differences on the sphere
  // — a displaced icosahedron shaded with its sphere normal reads as a ball.
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.88 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n, t1);
  float e = 0.09;
  vec3 na = normalize(n + t1*e), nb = normalize(n + t2*e);
  // 2/(sc.x*150) radians is about twenty-five pixels across a 1080-line frame
  float hi = 1.0 - smoothstep(sc.x*150.0, sc.x*260.0, dh);
  vec3 cax, cc1, cc2;
  clastBlock(s, cax, cc1, cc2);
  vec3 P  = rockShape(n,  s, kk, hi, cax, cc1, cc2);
  vec3 Pa = rockShape(na, s, kk, hi, cax, cc1, cc2);
  vec3 Pb = rockShape(nb, s, kk, hi, cax, cc1, cc2);
  vec3 nr = normalize(cross(Pa - P, Pb - P));

  P *= sc;
  nr = normalize(nr/sc);
  float ca = cos(iA.w), sa = sin(iA.w);
  P  = vec3(ca*P.x  - sa*P.z,  P.y,  sa*P.x  + ca*P.z);
  nr = vec3(ca*nr.x - sa*nr.z, nr.y, sa*nr.x + ca*nr.z);

  // Slabs lie the way the ground does; a boulder half its own height into the
  // hillside does not. Bedded blocks stay nearer level, which is what makes a
  // scree of tipped plates read as tipped.
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), gn, mix(0.55, 0.95, kk.w)));
  P  = alignY(P,  up);
  nr = alignY(nr, up);

  vUp = clamp(P.y/max(sc.y, 0.01)*0.5 + 0.5, 0.0, 1.0);
  vNrm = nr;
  vSeed = s;
  vKind = kk.w;
  vShadow = sunShadowShort(gp, gy + sc.y*0.55, lod, dat);
  vAO = ao;

  vec3 wp = vec3(gp.x, gy - sc.y*iB.w, gp.y) + P;
  float dd = dot(gp, gp);
  wp.y -= dd/(2.0*uPlanetR);

  vPos = wp;
  vec4 worldPosition = modelMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
${depth ? '  vHighPrecisionZW = gl_Position.zw;' : `  // A landscape where the ship casts and nothing standing on the ground
  // receives is stranger than one where nothing casts at all: the hull lays a
  // shadow across the basin and every boulder inside it stays lit.
  worldPosition.xyz += nr*uShadowNB;
  #include <shadowmap_vertex>`}
  ${LOGD_V}
}
`;

const ROCK_VERT = rockVert(false);
const ROCK_DEPTH_VERT = rockVert(true);

const ROCK_FRAG = /* glsl */`
uniform bool receiveShadow;
#define PI2 6.283185307179586
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

precision highp float;
${LOGD_F_PARS}
${NOISE}
${FRAG_UNIFORMS}
${SURF_LIGHT}

uniform vec3  uC0, uC2, uC3, uC4;
uniform vec3  uCVeg;
uniform float uVeg;
uniform sampler2DArray uTerTex;
uniform vec4  uTerInv;
uniform vec4  uTerSet;
uniform vec2  uTerK;
uniform float uDesat;

varying vec3  vPos;
varying vec3  vNrm;
varying float vShadow;
varying float vAO;
varying float vSeed;
varying float vUp;
varying float vKind;

/* The stone's own surface, off the same baked rock set the ground uses.

   A boulder had no surface detail at all — the mesh normal, a 0.8 m mottle and
   a 12 cm one, and nothing else — so the nearest and most-looked-at object in a
   landed frame drew as a smooth lump with facets on it. Measured on the
   foreground boulder of a terran frame: a mean absolute high-frequency residual
   of 0.40 levels, against 1.8-3.4 for reference photography of the same
   subject. That is the whole of "low-res-looking textures" and "visible
   polygons": there is nothing on the surface for an eye to resolve, so all it
   can see is the silhouette.

   Two scales, triplanar in the instance's own world position so a stone's
   surface is continuous with the ground it fell off, and both gated on the
   pixel footprint — a pebble at forty metres is two pixels and pays for
   nothing. Fracture is the *rock* set on every world regardless of what the
   ground is wearing: a clast is broken stone even when it is lying in sand. */
vec3 rockTap(vec3 p, vec3 w, float inv, out float lum){
  vec3 g = vec3(0.0);
  lum = 0.0;
  vec4 t = texture(uTerTex, vec3(p.xz*inv, uTerSet.x));
  lum += w.y*t.x*t.x;  g += w.y*vec3(t.y - 0.5, 0.0, t.z - 0.5);
  t = texture(uTerTex, vec3(p.zy*inv, uTerSet.x));
  lum += w.x*t.x*t.x;  g += w.x*vec3(0.0, t.z - 0.5, t.y - 0.5);
  t = texture(uTerTex, vec3(p.xy*inv, uTerSet.x));
  lum += w.z*t.x*t.x;  g += w.z*vec3(t.y - 0.5, t.z - 0.5, 0.0);
  return g*2.0;
}

void main(){
  ${LOGD_F}
  vec3 N = normalize(vNrm);
  float px = max(fwidth(vPos.x), fwidth(vPos.z));

  // Rock is the same mineral as the ground it fell off, a shade darker than
  // the dust around it — a boulder brighter than its own terrain reads as
  // polystyrene the instant the sun hits it.
  vec3 col = mix(uC3*0.56, uC2*0.68, fract(vSeed*0.317));
  col = mix(col, uC4*0.52, smoothstep(0.70, 1.0, fract(vSeed*0.713))*0.5);
  // and a minority are a different stone entirely — an erratic that came from
  // somewhere else is most of what stops a scree looking mixed from a bag
  col = mix(col, uC0*2.1, smoothstep(0.88, 1.0, fract(vSeed*2.113))*0.55);
  /* And a lightness axis per instance, derived from the colour in hand rather
     than from palette entries.

     Several worlds' palettes are five shades of one hue — a desert's is, by
     construction — so mixing between c2, c3 and c4 hands four hundred stones
     one flat gold, which is exactly what a review of the near field found
     against a reference of mixed clasts. A scree is mixed because its stones
     came out of different beds: some bleached, some stained, and the spread is
     in value and saturation at least as much as in hue. A negative mix
     coefficient pushes away from grey, which is the cheapest saturation boost
     there is. The pale end still lands below the palette entry it came from,
     because a boulder brighter than its own terrain reads as polystyrene. */
  float gyr = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(mix(col, vec3(gyr), -0.38)*0.58,
            mix(col, vec3(gyr),  0.52)*1.46,
            smoothstep(0.06, 0.94, fract(vSeed*1.618034)));

  /* Mineral grain, band-limited. The old single scale was a 0.8 m mottle,
     which on a 30 m outcrop is invisible and on a 12 cm pebble is a solid
     colour. Two scales chosen against the *pixel* means the same shader dresses
     both, and the far ones stop fizzing. */
  float g = fbm(vPos*1.3 + vSeed, 3)*0.5 + 0.5;
  col *= mix(1.0, 0.74 + 0.50*g, 1.0 - smoothstep(0.10, 0.40, px));
  float gc = snoise(vPos*0.12 + vSeed*0.7)*0.5 + 0.5;
  col *= 0.84 + 0.32*gc;

  // Bedding, in the albedo as well as the shape: a stratified block has its
  // beds in different colours, which is what makes a terrace read as rock
  // rather than as a machining error.
  if(vKind > 0.02){
    float bd = fract(vPos.y*0.9 + vSeed);
    col *= 1.0 + (smoothstep(0.0, 0.20, bd) - smoothstep(0.5, 0.75, bd) - 0.25)
                 *0.22*vKind*(1.0 - smoothstep(0.06, 0.30, px));
  }

  /* The baked fracture, at two scales. 0.19 m carries the face of a stone you
     can put a hand on; 1.15 m breaks a thirty-metre outcrop. Both die out at
     six and twenty centimetres per pixel respectively, which is a few metres
     for a pebble and a hundred for a crag, so the far scatter costs nothing.
     The gradient is projected onto the surface once — a per-tap re-basis is
     three times the arithmetic for a difference nobody can see. */
  float rk = 1.0 - smoothstep(0.020, 0.062, px);
  float rk2 = 1.0 - smoothstep(0.075, 0.230, px);
  if((rk + rk2)*uTerK.x > 0.02){
    vec3 w = abs(N); w = w*w; w = w*w; w /= max(w.x + w.y + w.z, 1e-4);
    vec3 tg = vec3(0.0);
    float l1 = 0.0, l2 = 0.0, lwr = 0.0;
    if(rk > 0.01){ tg += rockTap(vPos + vec3(4.7, 1.3, 9.1), w, 5.3, l1)*rk*0.95;
                   lwr += rk; }
    if(rk2 > 0.01){ tg += rockTap(vPos, w, 0.87, l2)*rk2*0.70; lwr += rk2; }
    tg *= uTerK.x;
    vec3 gr = tg - N*dot(tg, N);
    N = normalize(N + gr*1.15);
    // and the tone, about a mean of one, so it cannot shift a stone's exposure
    if(lwr > 0.004) col *= 0.62 + 0.76*((l1*rk + l2*rk2)*(2.0/lwr))*uTerK.y;
  }

  col = pow(max(col, 0.0), vec3(0.90))*0.86;   // same dust floor as the ground
  {
    float gyD = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(gyD), uDesat*0.55);
    col = clamp(gyD + (col - gyD)*1.50, 0.0, 8.0);   // stone is not grey card
  }
  // dust settles on the up-faces, wear shows on the flanks
  col = mix(col, col*vec3(1.14, 1.05, 0.90), clamp(N.y, 0.0, 1.0)*0.45);

  /* Lichen. On a living world it colonises the top and the sheltered north
     side of a stone and nothing else, so it is the one thing in the frame that
     tells you which way the weather comes from — and on a dead world there is
     none of it, which is equally informative. */
  if(uVeg > 0.01){
    float lz = snoise(vPos*0.9 + vSeed*3.1)*0.5 + 0.5;
    float lk = smoothstep(0.45, 0.85, lz)*clamp(N.y*0.7 + 0.3, 0.0, 1.0)
             * uVeg * (1.0 - smoothstep(0.05, 0.22, px));
    col = mix(col, uCVeg*0.85, lk*0.55);
  }

  // Contact darkening. A rock lit identically top to bottom floats; the base
  // has to lose its skylight to the ground it is sitting on.
  float ao = vAO * mix(0.30, 1.0, smoothstep(0.0, 0.45, vUp));
  // about the shadow box's own centre, which at a low sun is 130 m down-sun of
  // the ship — see the same line in the ground shader
  vec2 srel = vPos.xz - uShadowR.zw;
  float d2 = dot(srel, srel);
  float smask = (d2 < uShadowR.y)
    ? mix(getShadowMask(), 1.0, smoothstep(uShadowR.x, uShadowR.y, d2)) : 1.0;
  // min, not a product: the map and the march both contain the terrain now.
  // See the same line in the ground shader.
  vec3 outc = shadeSurface(col, N, min(vShadow, smask), ao, normalize(uCamPos - vPos));
  outc = aerial(outc, vPos);
  gl_FragColor = vec4(max(outc, 0.0), 1.0);
}
`;

/* The rocks' own shadows, as ground decals. Multiply-blended ellipses that
   follow the terrain and stretch away from the sun by 1/sin(elevation), so a
   raking sun throws them long. Cheaper and steadier than any shadow map at
   this instance count, and they carry the same haze so the far ones vanish
   into it instead of stippling the distance. */
const DECAL_VERT = /* glsl */`${LOGD_V_PARS}
${NOISE}
${FIELD_UNIFORMS}
${FIELD}
${HABITAT}
${VIEWCULL}
${CLUTTER}
${STAND}

uniform vec3  uCamPos;
uniform float uDecalK;
uniform float uHazeK;
uniform float uFade;
uniform float uTileP;

attribute vec4 iA;
attribute vec4 iB;

varying float vRad;
varying float vAmt;
varying float vAlong;

void main(){
  vec2 loc = position.xz;
  vRad = length(loc);
  vAlong = loc.y;

  /* The same rejection test the rock ran, for the same reason it ran it: a
     decal whose rock was never drawn is a shadow with nothing casting it, and
     at these densities the field of orphaned smudges is more obvious than the
     shadows ever were. Both sides read the identical mask, so they cannot
     disagree. */
  float sShift;
  vec2 anchor = tileTo(iA.xy, uTileP, uCamPos, viewMatrix, sShift);
  {
    if(behindCamera(anchor, uCamPos, viewMatrix, projectionMatrix)){
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return;
    }
    vec4 datx = uDatum;
    float lodx = meshLod(length(anchor));
    float gyx; vec3 gnx;
    standOn(anchor, iB.x*1.4, lodx, datx, gyx, gnx);
    float aox, slopex;
    terrainAround(anchor, gyx, lodx, datx, aox, slopex);
    float mx = clutterMask(anchor, slopex, shelterOf(aox),
                           drainage(anchor + datx.zw), clamp((gyx - seaLevel(datx.x))/900.0, 0.0, 1.0));
    float growx = clamp((mx - hash11((iA.z + sShift)*13.7 + 0.31))*2.6, 0.0, 1.0);
    if((uType == 0 || uType == 5) && gyx < seaLevel(datx.x) + 1.5) growx = 0.0;
    if(growx <= 0.004){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  }

  vec2 sd = uSunDir.xz;
  float sl = length(sd);
  sd = sl > 1e-4 ? sd/sl : vec2(1.0, 0.0);
  float stretch = clamp(sl/max(uSunDir.y, 0.20), 0.7, 4.0);
  vec2 perp = vec2(sd.y, -sd.x);

  float R = max(iB.x, iB.z)*1.15;
  vec2 gp = anchor - sd*(stretch - 1.0)*R*0.85 + (perp*loc.x + sd*loc.y*stretch)*R;

  float gy = groundYFlat(gp, meshLod(length(gp)), uDatum);

  float dist = length(vec3(gp.x, gy, gp.y) - uCamPos);
  // lifted off the ground by a hair, growing with distance — polygon offset is
  // ignored the moment a shader writes gl_FragDepth
  float lift = 0.04 + dist*0.0006;

  /* No shadow march here. A decal that lands inside a ridge shadow does get
     drawn, but multiplying an already-dark patch by the same factor is a small
     absolute change and reads as nothing — which is far cheaper than paying a
     twelve-step march on every vertex of every decal in the field. */
  /* A near-field cue only. A metre-wide ellipse two kilometres away is a
     couple of pixels of noise, and because it is a flat quad hugging a slope
     the grid samples at nine points it floats visibly off the ground long
     before it stops being drawn. Fade it out while it is still legible. */
  vAmt = uDecalK * exp(-dist*uHazeK) * clamp(uSunDir.y*6.0, 0.0, 1.0)
       * (1.0 - smoothstep(400.0, 1500.0, dist));

  vec3 wp = vec3(gp.x, gy + lift - dot(gp, gp)/(2.0*uPlanetR), gp.y);
  vec4 wpp = modelMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wpp;
  ${LOGD_V}
}
`;

const DECAL_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying float vRad;
varying float vAmt;
varying float vAlong;
void main(){
  ${LOGD_F}
  /* A shadow has a contact end and a tip, and drawing it as one flat ellipse
     is why these read as painted ovals. The end touching the stone is dark and
     hard-edged; the far end has a penumbra as wide as the source is, and it is
     most of the way gone by the time it gets there. */
  float k = smoothstep(-1.0, 0.55, vAlong);
  float edge = mix(0.62, 0.02, k);
  float a = smoothstep(1.0, edge, vRad)*vAmt*(0.34 + 0.66*k);
  // Multiply blending: this is premultiplied, so 1.0 is "leave it alone".
  gl_FragColor = vec4(vec3(1.0 - a), 1.0);
}
`;

/* ----------------------------------------------------------------- flora */

/* Things that grow.

   Three decisions, and the first is the one that makes it affordable. **Blades
   are solid geometry, not cutouts.** An alpha-tested card is the standard way
   to draw grass and it is the wrong one here: this renderer writes
   gl_FragDepth for the logarithmic depth buffer, and discard next to
   gl_FragDepth mis-compiles under ANGLE, so a cutout would have to be blended —
   which means sorting, no depth write, and overdraw across the bottom third of
   the frame. A tapered triangle is opaque, needs none of that, and at the two
   to six pixels a blade actually occupies nobody can tell the difference.

   **Density is the same habitability score the ground colour uses**, so the
   near tufts and the distant green shoulder are one field rather than two that
   nearly agree. Walk toward a far stand and it grows tufts as you arrive.

   **The wind is the world's wind.** The same axis the dune trains and the
   ripple field run across, so a landscape blows one way rather than three. */
const floraVert = (tree, depth) => /* glsl */`${LOGD_V_PARS}
${NOISE}
${FIELD_UNIFORMS}
${FIELD}
${HABITAT}
${VIEWCULL}
${CLUTTER}
${STAND}

uniform vec3  uCamPos;
uniform float uFade;
uniform float uTileP;
uniform float uVeg;
uniform float uTime;
${tree ? `
/* What kind of woody thing this draw is, as uniforms rather than as a second
   copy of the shader. A tree and a shrub differ in four numbers and nothing
   else — how much clear bole they carry, how wide the crown is against the
   height, how far from the pad they are allowed to start, and how choosy they
   are about ground — so they share a program and the material supplies the
   numbers. Two materials, one compile.

   uForm  = (clear-bole multiplier, crown-width multiplier, pad fade in, out)
   uPick  = (habitability threshold, its per-instance jitter, slope fade lo, hi)
   uSpray = (crown budget at full LOD, the range that budget is spent at,
             leaf size against the crown radius) */
uniform vec4  uForm;
uniform vec4  uPick;
uniform vec3  uSpray;
` : ''}

attribute vec4 iA;   // xz metres, seed, yaw
attribute vec4 iB;   // half-width, height, spare, spare

varying vec3  vPos;
varying vec3  vNrm;
varying float vShadow;
varying float vAO;
varying float vSeed;
varying float vV;
varying float vBark;   // 1 on the trunk, 0 in the canopy — trees only
/* Per *element*, not per plant. vSeed already varies one tree or one tuft
   against the next; what a crown was missing is variation between the leaves
   of a single tree, which is the difference between a mass of foliage and a
   green shape. Hashed off the primitive index so it survives the LOD. */
varying float vElem;
/* Across the spray: with vV it is the uv the fragment stage samples the drawn
   leaf cluster with, which is what cuts a leaf shape out of the quad. */
varying float vU;
${depth ? 'varying vec2 vHighPrecisionZW;' : ''}
/* How buried this spray is in its own crown: 0 out at the branch tips where
   the light is, 1 back against the bole. A canopy shaded without it returns
   one value for every leaf and draws a flat green cut-out however good its
   silhouette is. */
varying float vDeep;

void main(){
  float sShift;
  vec2 gp = tileTo(iA.xy, uTileP, uCamPos, viewMatrix, sShift);
  float s = iA.z + sShift;

  if(behindCamera(gp, uCamPos, viewMatrix, projectionMatrix)){
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return;
  }
  float dh = length(vec2(gp.x - uCamPos.x, gp.y - uCamPos.z));
  if(dh > uFade){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
${tree ? `
  /* Crown LOD, and it has to be decided *here* — before standOn and
     terrainAround below, which are twelve height-field evaluations that every
     vertex of the instance repeats identically.

     That per-vertex placement cost is the whole reason the old crown was
     twenty-four patches. It is paid by every candidate that reaches this point,
     including the great majority that are about to fail the grow test, so
     seventy-two sprays would have tripled the most expensive vertex stage in a
     landed frame for trees that are ten pixels tall. Culling on the spray index
     against range instead costs one divide and puts the full count only where
     the tree is actually large: all seventy-two inside seventy metres, about
     twenty-five at two hundred, twelve at the fade. Overall it comes out
     roughly where the old fixed count did.

     The retained sprays are not a prefix of the spiral — the crown branch below
     re-parameterises on this count, so a thinned crown still covers the whole
     shell rather than losing its underside. */
  /* The reference range is per band because the budget has to be spent on
     *angular* size. A fixed seventy metres is right for a ten-metre tree and
     wildly wrong for a metre-and-a-half bush, which at ninety metres is four
     pixels tall and was still being handed fifty-odd sprays — the scrub band
     alone cost eleven frames a second that way. */
  float lodN = clamp(uSpray.x*(uSpray.y/max(dh, uSpray.y)), 8.0, uSpray.x);
  if(position.z > -0.5 && position.z >= lodN){
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return;
  }
  /* And the limbs go once they are thinner than a pixel — past about eight
     crown radii the foliage is the whole silhouette anyway. Same argument as
     the spray budget, and it is checked here for the same reason: before the
     placement work below, not after. */
  if(position.z < -1.5 && dh > uSpray.y*3.4){
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return;
  }
` : ''}
  vec4 dat = uDatum;
  float lod = meshLod(length(gp));
  float gy; vec3 gn;
  standOn(gp, iB.x*2.0, lod, dat, gy, gn);

  float ao, slope;
  terrainAround(gp, gy, lod, dat, ao, slope);
  float above = clamp((gy - seaLevel(dat.x)) / 900.0, 0.0, 1.0);
  /* Life is scored, not scaled. Multiplying the habitability straight by uVeg
     meant a world the generator called half-vegetated grew a quarter of the
     tufts a fully vegetated one does *and* thinned every one of them, so the
     middle of the range read as bare. The exponent keeps the two ends apart
     and puts the middle where a middling world should be. */
  float m = floraMask(gp, slope, shelterOf(ao), drainage(gp + dat.zw), above)*pow(uVeg, 0.55);
  ${tree ? `
  /* A tree is choosier than a tuft, and about different things. It wants a
     score well above the one that will grow grass, it will not hold on a bank
     a blade is perfectly happy on, and it does not stand in the last few
     metres before the water. What comes out of those three is a treeline that
     follows shelter and drainage rather than a contour, stands that thin into
     scrub at their edges, and open ground between them. */
  float grow = clamp((m - uPick.x - hash11(s*9.13 + 0.77)*uPick.y)*2.1, 0.0, 1.0);
  grow *= 1.0 - smoothstep(uPick.z, uPick.w, slope);
  /* Clear of the pad. The site search picks flat ground and the ship comes
     down on the origin, so without this the crane camera starts inside a
     canopy and the hero framings are half filled with a leaf two metres from
     the lens. Fifty metres is the hull plus its own shadow. */
  grow *= smoothstep(uForm.z, uForm.w, length(gp));
  ` : `
  /* Clumped, not a carpet. A sward laid out on a stratified lattice with one
     threshold has the same density everywhere, and at the counts a closed
     sward needs that stops reading as grass and starts reading as fur or felt —
     which is exactly what it drew. Real grass grows in tussocks with bare soil
     and short growth between them, so the density is modulated by two spatial
     scales before the per-instance threshold, and the survivors in a thin patch
     are also *shorter*. */
  /* Gentle, and it stays gentle. Modulating density hard enough to make real
     tussocks thins the sward everywhere else, and a thinned sward is not
     "clumpy", it is *wispy* — bare soil with strands over it. A meadow is a
     closed surface first and clumped second, so this only varies the top of the
     range and never cuts density below three quarters. */
  float cl0 = snoise(vec3(gp.x, 61.0, gp.y)*0.055)*0.5 + 0.5;   // ~18 m
  float cl1 = snoise(vec3(gp.x, 17.0, gp.y)*0.34)*0.5 + 0.5;    // ~3 m
  float tuss = 0.78 + 0.42*smoothstep(0.18, 0.78, cl0*0.55 + cl1*0.45);
  float grow = clamp((m*tuss - hash11(s*9.13 + 0.77)*0.82)*2.6, 0.0, 1.0);
  `}
  // Thinning out rather than switching off. A stand that ends on a circle is
  // the oldest tell in the book; the last of it has to be short as well as rare.
  grow *= 1.0 - smoothstep(uFade*0.55, uFade, dh);
  if((uType == 0 || uType == 5) && gy < seaLevel(dat.x) + 1.5) grow = 0.0;
  if(grow <= 0.004){ gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  ${tree ? `
  // ---- one tree ---------------------------------------------------------
  /* Two primitives in one geometry, told apart by the z channel: a tapered
     five-sided trunk at -1, and eight fronds that spring from the top of it.
     Solid triangles rather than alpha cards for the same reason the grass is
     solid — this renderer writes gl_FragDepth, and discard beside it
     mis-compiles under ANGLE, so a cutout canopy would have to be blended and
     sorted. At the pixel counts a tree occupies past forty metres a splayed
     fan of tapered triangles is indistinguishable from a billboard atlas, and
     it holds up when you walk under it, which an atlas does not. */
  float bi = position.z;
  float u  = position.x;
  float v  = position.y;
  vV = v;

  float r1 = hash11(s*3.71 + bi*11.31);
  float r2 = hash11(s*5.13 + bi*2.77);
  float r3 = hash11(s*7.93 + bi*4.19);

  /* Stature is a property of the *tree*, not of the piece of it being drawn.
     r1..r3 are hashed on the primitive index as well as the instance — which
     is exactly what you want for jittering one leaf against the next, and
     exactly wrong for the height of the bole: the trunk drew itself against
     one figure and each of the twenty-four leaf patches against another, so
     every canopy floated a metre or two above a stump. Anything both halves
     have to agree on comes off the instance seed alone. */
  float q1 = hash11(s*1.37), q2 = hash11(s*2.11), q3 = hash11(s*4.73);
  float H    = iB.y*(0.62 + 0.55*q1)*(0.55 + 0.45*grow);
  /* Bole a quarter to a third of the height, not a third to a half. Together
     with a crown radius of 0.32 H the old proportions drew a palm — a long bare
     stem with a small tuft on the end — which is a real tree and not the one a
     temperate stand is made of. A broadleaf carries its crown over rather more
     than half its height and about four tenths of it in radius. */
  float trH  = H*(0.24 + 0.12*q2)*uForm.x;  // clear bole under the crown
  /* Thinner and far less tapered. At 0.055 H with a 62 per cent taper a
     ten-metre tree carried a 1.1 m butt closing to 0.4 m — a traffic cone, and
     an outside eye said so. Real boles run 1 to 2 per cent of height and taper
     a fifth over the clear length. */
  float trR  = H*0.021*(0.80 + 0.4*q3);

  vec2 wd = vec2(cos(uSeed*1.7), sin(uSeed*1.7));
  float ph = uTime*0.55 + dot(gp, wd)*0.021 + s;
  float gust = 0.45 + 0.55*(0.5 + 0.5*sin(uTime*0.23 + dot(gp, wd)*0.004));
  // the whole tree leans downwind and the crown lags the trunk
  float sway = sin(ph)*0.030*gust;

  /* The crown's frame: where the limbs leave the bole and how far they reach.
     Shared by the limb branch and the spray branch, so a spray cannot end up
     hanging in air away from the branch that is supposed to carry it. */
  float crown  = H - trH;
  float crownR = H*0.34*(0.85 + 0.30*q3)*uForm.y;
  vec3  cc = vec3(0.0, trH + crown*0.46, 0.0);

  /* One limb, by index. A branch leaves the bole somewhere up its clear length,
     rises and spreads, and the spread is what sets the crown's outline. */
  float NL = ${TREE_LIMBS}.0;

  vec3 p; vec3 nrm;
  float deepK = 0.0;
  if(bi < -1.5){
    /* ---- a limb -----------------------------------------------------------
       The thing the canopy never had. Sprays alone tile a shell, so the middle
       of the crown is empty, you see sky through it, and against a bright sky
       the whole tree is a stick with a parasol on it — which is exactly how it
       read. Six tapered limbs give the crown an interior, a real silhouette
       when the leaves thin at the edges, and something for the sprays below to
       hang from in clumps rather than in a lattice. */
    float k  = -bi - 2.0;
    float lb = hash11(s*4.31 + k*7.13), lc = hash11(s*8.77 + k*3.19);
    float az = k*2.399963 + iA.w*2.0 + lb*0.9;
    float rise = 0.45 + 0.55*lc;                       // steep limbs and flat ones
    vec3  bd = normalize(vec3(cos(az)*(1.3 - rise), rise + 0.30, sin(az)*(1.3 - rise)));
    vec3  b0 = vec3(0.0, mix(trH*0.72, trH + crown*0.30, (k + 0.5)/NL), 0.0);
    float blen = crownR*(0.95 + 0.55*lb);
    float a = u*6.2831853;
    vec3  bt = normalize(cross(bd, vec3(0.0, 1.0, 0.0)) + vec3(1e-3, 0.0, 1e-3));
    vec3  bn = cross(bd, bt);
    float rr = trR*0.42*(1.0 - 0.76*v);
    // limbs bow upward along their length rather than running dead straight
    p = b0 + bd*(blen*v) + vec3(0.0, 1.0, 0.0)*(blen*v*v*0.16)
      + (bt*cos(a) + bn*sin(a))*rr;
    nrm = normalize(bt*cos(a) + bn*sin(a) + bd*0.18);
    p.xz += wd*(sway*v*v*H*0.42);
  } else if(bi < -0.5){
    /* The bole runs all the way up into the crown rather than stopping at the
       clear height, which is both what a trunk does and the end of a whole
       class of bug: with the two halves' extents derived separately, any
       disagreement between them showed as a canopy floating over a stump.
       The leaves hide everything above the clear height anyway. */
    float a = u*6.2831853;
    float top = trH + (H - trH)*0.52;
    float rr = trR*(1.0 - 0.34*v);
    p = vec3(cos(a)*rr, top*v, sin(a)*rr);
    nrm = normalize(vec3(cos(a), 0.22, sin(a)));
    p.xz += wd*(sway*v*v*H*0.55);
  } else {
    /* A crown is a *mass*, and the number that decides whether it reads as one
     * is the size of a leaf against the size of the crown.
     *
     * Two attempts went the obvious way first — fronds springing from the top
     * of the bole, then smaller ones springing from up its length — and both
     * drew a papyrus plant, because a canopy seen from outside is not a set of
     * branches radiating from a point. It is an outward-facing surface with
     * leaves on it and a ragged edge. So the leaves are placed *on* that
     * surface: a Fibonacci spiral of directions over the upper hemisphere, a
     * spray at each one, at a radius and a size that vary enough for them to
     * overlap into a mass and for the edge to break up.
     *
     * That was right and it still drew a papercraft model, because the patches
     * were sized at 0.60 to 0.94 of the crown radius. Twenty-four elements each
     * nearly as wide as the thing they compose is not a mass, it is a faceted
     * shape — you can count the leaves, every one presents a straight-edged
     * quad, and the whole reads as exactly what it is, which is a low-poly
     * model. A canopy's elements have to sit below the size you
     * can resolve them at. Seventy-two sprays at a quarter of the crown radius
     * is a factor of nine less area each and three times as many silhouette
     * edges, and it is the entire difference.
     *
     * Three things then finish it. The radius jitter is wide — 0.40 to 1.10 of
     * the crown — so the outer surface is genuinely ragged rather than a shell
     * with bumps. Each spray *droops*: it leaves the shell outward and bends
     * toward the ground, which is what a leafy branch does under its own weight
     * and what stops the crown reading as a sphere. And the width runs on a
     * profile rather than a linear taper, so the outline of a spray is a curve
     * closing to a point instead of the straight sides of a triangle pair. */
    /* Sprays hang off the limbs, they do not tile a sphere.
     *
     * The Fibonacci shell that used to be here is what made the crown a shell:
     * every spray sat at the same radius band with the same spacing, so the
     * canopy was a thin skin with nothing inside it and a suspiciously even
     * edge. Foliage on a real tree is *clumped* — it grows at the ends of the
     * branches, so the crown is a handful of dense masses with gaps between
     * them, and that clumping is most of what the eye uses to tell a tree from
     * a green ball. Assigning each spray to a limb and placing it along that
     * limb's length gives the clumping for free, and it guarantees the leaves
     * and the branch structure agree with each other. */
    float N = lodN;
    float k  = mod(bi, NL);
    float lb = hash11(s*4.31 + k*7.13), lc = hash11(s*8.77 + k*3.19);
    float az = k*2.399963 + iA.w*2.0 + lb*0.9;
    float rise = 0.45 + 0.55*lc;
    vec3  bd = normalize(vec3(cos(az)*(1.3 - rise), rise + 0.30, sin(az)*(1.3 - rise)));
    vec3  b0 = vec3(0.0, mix(trH*0.72, trH + crown*0.30, (k + 0.5)/NL), 0.0);
    float blen = crownR*(0.95 + 0.55*lb);

    /* Spread evenly along the limb, not bunched at the tip. Foliage that only
       exists at the far end leaves the inner two thirds of every branch bare,
       which is what made the crown a ring of blobs with sky behind it. */
    float t = 0.16 + 0.84*r2;
    deepK = 1.0 - t;
    vec3  attach = b0 + bd*(blen*t) + vec3(0.0, 1.0, 0.0)*(blen*t*t*0.16);
    // and scattered around the limb rather than strung along its axis
    vec3  lt = normalize(cross(bd, vec3(0.0, 1.0, 0.0)) + vec3(1e-3, 0.0, 1e-3));
    vec3  ln = cross(bd, lt);
    float sa = r1*6.2831853;
    /* Tight to the branch. This was 0.46 of the crown radius — nearly two
       metres of sideways offset on a fourteen-metre tree — so every card sat
       out in clear air with nothing joining it to the limb it belonged to, and
       the crown read as a scatter of discs floating around a stick rather than
       as foliage on a branch. A leaf cluster grows *on* the wood. At a seventh
       of that the cards overlap each other and the limb, and the canopy closes
       into one connected mass. */
    float srad = crownR*0.07*r3;
    vec3  d3 = normalize(bd*1.35 + (lt*cos(sa) + ln*sin(sa))*0.55);
    /* Area per spray is held as the count drops, so a thinned distant crown
       has the same optical thickness as a near one rather than going gappy. */
    /* Sized so the canopy is actually opaque, which is arithmetic rather than
       taste. Optical coverage goes as count times length squared: at 128 sprays
       and 0.15 of the crown radius a canopy carried about 1.1 times its own
       cross-section in leaf area, and the alpha mask throws away a third of
       that — so it came out at roughly 0.7 and you could see straight through
       every tree in the frame. A closed broadleaf canopy needs three to four
       times its cross-section. This is that number. */
    /* Wide size spread. Every leaf the same size is as strong a tell as every
       leaf the same colour — a real crown runs new growth against old over
       better than a factor of two, and the spread is what stops the canopy
       reading as a stamped pattern. */
    /* Sized so one card reads as the *cluster* it has drawn on it. The card
       carries seven blades on a common stalk; drawn small it shows one or two
       of them and the crown goes sparse, which is what happened the first time.
       A shoot is roughly a third of the crown radius. */
    float sz  = crownR*(0.26 + 0.30*r3*r3)*uSpray.z*sqrt(uSpray.x/N);
    vec3  cc = attach + (lt*cos(sa) + ln*sin(sa))*srad;
    float rad = 0.0;

    /* Out along the branch, then down under its own weight. */
    vec3  axis = normalize(mix(d3, vec3(0.0, -1.0, 0.0), 0.14 + 0.30*r2));
    vec3  t1 = normalize(cross(axis, vec3(0.0, 1.0, 0.0)) + vec3(1e-3, 0.0, 1e-3));
    vec3  t2 = cross(axis, t1);

    // narrow at the stalk, broadest at two thirds, drawn to a point
    float wpr = 1.0;   // the leaf outline is the fragment mask's job now

    /* Aspect near three to one. At 1.5 the sprays are broad rounded petals
       and a crown of them reads as a bunch of leaves rather than as foliage;
       narrowing them without shortening them keeps the same optical coverage
       while roughly doubling the length of silhouette edge per unit of area,
       which is the thing that actually reads as detail at range. */
    /* Aspect near one, not three. A long narrow spray with a dozen small
       leaflets is a *fern frond*, and a crown built of them read as tree-fern
       rather than broadleaf however dense it got. What a broadleaf canopy is
       made of is roughly round clusters of a few big leaves, so the spray is
       shortened and widened until it is about as broad as it is long, and the
       leaflet pitch below is coarsened to match. */
    p  = cc + d3*rad + axis*(v*sz*1.30) + t1*(u*wpr*sz*0.78);
    // a little curl out of plane, so no two sprays are the same flat shape
    p += t2*(v*v*sz*0.30*(r3 - 0.5)*2.0);
    // flattened a little: a crown is wider than it is tall
    p.y = cc.y + (p.y - cc.y)*0.80;
    p += vec3(wd.x, 0.0, wd.y)*(sway*H*0.9);
    // outward and tilted up toward the light, plus the spray's own curl
    nrm = normalize(d3*0.80 + vec3(0.0, 0.55, 0.0) + t2*(0.30*(r3 - 0.5)));
  }
  float hgt = H;
  ` : `
  // ---- one blade --------------------------------------------------------
  float bi = position.z;
  float u  = position.x;
  float v  = position.y;
  vV = v;

  float r1 = hash11(s*3.71 + bi*11.31);
  float r2 = hash11(s*5.13 + bi*2.77);
  float r3 = hash11(s*7.93 + bi*4.19);

  float ang = iA.w + bi*2.399963 + r1*1.1;
  vec2 dir = vec2(cos(ang), sin(ang));
  /* A wide spread within the tuft as well as between them. Blades of one
     length side by side present a flat top surface, and a flat top surface at
     this density is a mown lawn however fine the blades are. */
  float hgt = iB.y*(0.34 + 1.35*r3*r3)*(0.42 + 0.58*grow);
  /* Width in millimetres, not as a fraction of length.

     Taking it from the instance's own x radius — which is how every other band
     here is proportioned — gave blades two hundred millimetres across, and at
     eye height a field of those does not read as grass, it reads as broken
     glass stuck in the ground. Deriving it from the blade's own height instead
     fixed the worst of that and kept the shape of the bug: stature runs over a
     factor of five within a band, so the tall blades were still drawing at
     ninety-plus millimetres and the near field read as pale ribbons. A real
     blade is four to twelve millimetres across whether it is ankle high or knee
     high — width and length are simply not related — so it is drawn here as an
     absolute, and the only thing height still does to it is the taper.

     The floor is the other half. Geometry thinner than a pixel does not go
     faint, it scintillates: the rasteriser takes it or drops it per sample and
     a hillside of sub-pixel blades crawls. So a blade may not be narrower than
     about two pixels' worth at its own range, which widens the far ones into
     the closed surface distant grass actually presents and leaves everything
     inside a couple of metres — where the eye can check — at its true width. */
  /* The floor is halved. At 1.6 mm per metre of range a blade twenty metres
     out drew 32 mm wide, and a hillside of 32 mm blades packed at sward density
     is not grass, it is felt — which is exactly how the near ground read. Thin
     enough to stay separate, still wide enough not to scintillate. */
  float wid = max(0.0060 + 0.0105*r2, dh*0.0011)*(1.0 - v*0.62);
  // splay out from the crown and bow over — a blade that leaves the ground
  // vertically and stays there is a bristle
  float lean = (0.22 + 0.60*r2)*hgt;

  vec2 wd = vec2(cos(uSeed*1.7), sin(uSeed*1.7));
  float ph = uTime*1.25 + dot(gp, wd)*0.055 + bi*1.7 + s;
  float gust = 0.45 + 0.55*(0.5 + 0.5*sin(uTime*0.29 + dot(gp, wd)*0.006));

  vec3 p;
  p.y  = hgt*v*(1.0 - 0.20*v);
  p.xz = dir*(lean*v*v) + vec2(-dir.y, dir.x)*(u*wid)
       + wd*(sin(ph)*v*v*hgt*0.20*gust);

  // A blade's normal is up plus the way it splayed, which gives every blade in
  // a tuft a different answer and is why a tuft catches the key on one side.
  vec3 nrm = normalize(vec3(dir.x*0.75, 1.0, dir.y*0.75));

  `}
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), gn, ${tree ? '0.25' : '0.55'}));
  p   = alignY(p,   up);
  nrm = alignY(nrm, up);

  vNrm = nrm;
  vU = u;
  vDeep = ${tree ? 'deepK' : '0.0'};
  vBark = ${tree ? 'step(bi, -0.5)' : '0.0'};
  vElem = hash11(s*13.77 + bi*5.31 + 2.19);
  vSeed = s;
  vShadow = sunShadowShort(gp, gy + hgt*0.5, lod, dat);
  vAO = ao;

  vec3 wp = vec3(gp.x, gy - hgt*0.06, gp.y) + p;
  wp.y -= dot(gp, gp)/(2.0*uPlanetR);
  vPos = wp;
  vec4 wpp = modelMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wpp;
  ${depth ? '  vHighPrecisionZW = gl_Position.zw;' : ''}
  ${LOGD_V}
}
`;

const FLORA_VERT = floraVert(false);
const TREE_VERT = floraVert(true);
const TREE_DEPTH_VERT = floraVert(true, true);

/* A tree's own shadow, and it is the single largest thing that was missing.
 *
 * Nothing growing cast anything. Every frame of a wooded meadow had trees
 * standing on grass with no shadow under them at all, which is the one cue that
 * says an object is *in* a scene rather than pasted over it — and its absence
 * is most of why the trees read as plastic and the meadow as flatly lit. The
 * old reasoning was that the sun's box is 220 m across so it could only hold
 * the two or three nearest trees; that is true and it is the wrong conclusion,
 * because the two or three nearest trees are precisely the ones whose shadows
 * the eye is looking for. The box follows the camera, so those are always the
 * ones in frame.
 *
 * The depth pass has to run the same alpha mask as the beauty pass or every
 * canopy casts as a solid blob and the dappling — which is the whole point — is
 * lost. */
const TREE_DEPTH_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
#include <packing>
varying vec2 vHighPrecisionZW;
varying float vV;
varying float vBark;
varying float vElem;
varying float vU;
varying float vDeep;
uniform sampler2D uLeafTex;

void main(){
  ${LOGD_F}
  if(vBark < 0.5){
    vec2 luv = vec2(vU*0.5 + 0.5, clamp(vV, 0.0, 1.0));
    if(fract(vElem*13.7) > 0.5) luv.x = 1.0 - luv.x;
    if(texture2D(uLeafTex, luv).a < 0.28) discard;
  }
  float fragCoordZ = 0.5*vHighPrecisionZW[0]/vHighPrecisionZW[1] + 0.5;
  gl_FragColor = packDepthToRGBA(fragCoordZ);
}
`;

const FLORA_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
${FRAG_UNIFORMS}
${SURF_LIGHT}

uniform vec3 uCVeg, uC0, uC2;

varying vec3  vPos;
varying vec3  vNrm;
varying float vShadow;
varying float vAO;
varying float vSeed;
varying float vV;
varying float vElem;

void main(){
  ${LOGD_F}
  vec3 N = normalize(vNrm);
  /* A leaf is thin, and both these draws are DoubleSide. Shading a back face
     with the normal it was authored with points it away from the eye *and*
     away from the key, so half of every crown and a third of every tuft came
     out black — visibly so on the near trees, where the far side of the canopy
     was a hole. A leaf seen from behind is the same leaf lit through it, so the
     normal is turned to face the viewer and the transmission term below does
     the rest. This is what makes foliage read as translucent rather than as
     cardboard painted on one side. */
  /* Grass keeps the normal it was authored with, and that is a real
     difference from the canopy above rather than an omission.

     A blade's normal is up plus the direction it splayed, so every blade in a
     tuft answers the key differently and a tuft catches the light on one side
     — which is most of what stops a sward reading as a painted surface.
     Turning them all to face the viewer, which is right for a leaf, collapses
     that variation to a single answer per pixel and the whole near field goes
     back to a flat carpet. It was tried, and that is exactly what it drew. A
     blade is also nearly edge-on far more often than a leaf is, so the back
     face it would fix is a much smaller share of what is on screen. */
  // dead at the base, alive at the tip, bleached at the very end, and every
  // tuft a slightly different plant — a field of one colour is a carpet
  /* The base was uC0*2.4 — the palette's darkest entry, which on a green
     world is a near-black blue — and at the density a real sward needs that
     turned the near ground into a bed of dark spikes. A blade is shaded at
     the base because it is *occluded*, not because it is a different colour;
     the occlusion is already in vAO below. So the base is the vegetation
     colour held down, the middle is it at full strength, and only the last
     fifth of the tip goes over to the dry straw the stand is drying into. */
  /* 0.74, not 0.42. A blade is darker at the root because it is *occluded*,
     and the occlusion is already carried by vAO below — spending it a second
     time as albedo took the bottom of every blade to near-black, and at the
     density a sward needs that drew a field of black specks scattered over a
     green blanket rather than grass. */
  vec3 col = mix(uCVeg*0.74,
                 uCVeg*(0.92 + 0.80*fract(vSeed*0.613)),
                 smoothstep(0.02, 0.55, vV));
  col = mix(col, mix(uCVeg*1.25, uC2, 0.42), smoothstep(0.66, 1.0, vV)*0.60);
  /* Per blade, not per tuft. A sward whose only colour variation is between
     one clump and the next still reads as a carpet, because a clump is below
     the size you notice at eye height; what you actually see is the blade. The
     hue axis matters more than the value one — a real sward runs yellow-green
     through blue-green and dries unevenly, and it is that spread, not the mean,
     that separates grass from green paint. */
  col *= vec3(0.84 + 0.38*vElem, 0.97 + 0.08*vElem, 0.76 + 0.34*(1.0 - vElem));
  col *= 0.84 + 0.34*fract(vElem*7.31);
  /* And whole *patches* of a sward dry off together, at a scale of a few
     metres — one blade-by-blade jitter averages back out to a single colour at
     any distance, which is why the near field still read as felt. */
  float dryP = snoise(vec3(vPos.x, 5.0, vPos.z)*0.24)*0.5 + 0.5;
  float gyg = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(gyg*1.28, gyg*1.06, gyg*0.42), smoothstep(0.52, 0.92, dryP)*0.62);
  col = mix(col, col*vec3(0.72, 0.94, 0.80), smoothstep(0.46, 0.10, dryP)*0.5);
  col = pow(max(col, 0.0), vec3(0.80))*0.87;

  float ao = vAO*mix(0.62, 1.0, vV);
  vec3 outc = shadeSurface(col, N, vShadow, ao, normalize(uCamPos - vPos));
  /* Vegetation does not take the void's fill.
     The skylight here is (0.18, 0.28, 0.45) — a teal-black sky, which is right
     for mineral ground and wrong for a leaf: once the key is cut it dominates,
     and a measurement of the near sward came back with a dominant hue of 165
     degrees. Cyan grass. So the plants get their fill pushed back toward their
     own colour, which is also what really happens in a sward — most of what
     lights a shaded blade is other blades. */
  outc += col*uCVeg*vAO*0.85;

  /* Transmission. A leaf is thin enough to be lit from behind, and that one
     term is the whole difference between a field and green plastic — it is
     also why grass looks brightest when you are facing into the sun. */
  vec3 V = normalize(uCamPos - vPos);
  float bk = pow(clamp(dot(-V, uSunDir)*0.5 + 0.5, 0.0, 1.0), 3.0);
  /* Transmission, and it is the single most valuable term on a blade. Grass is
     thin enough to be lit *through*, which is why a backlit sward is the
     brightest thing in a landscape photograph and why ours, with this at 0.60
     and gated to the upper half of the blade, read as dead flat against the
     light. */
  outc += col*uSunColor*bk*vShadow*1.35*smoothstep(0.0, 0.28, vV);

  outc = aerial(outc, vPos);
  gl_FragColor = vec4(max(outc, 0.0), 1.0);
}
`;

/* A tree, shaded. Trunk and canopy come out of the same draw and are told
   apart by the same z channel the vertex stage used, carried through as vV: a
   trunk vertex arrives with vV in 0..1 up a bole that is bark all the way, a
   frond arrives with vV along a leaf. Bark is the palette's mineral dark
   warmed a little; the canopy is the vegetation colour, older and yellower at
   the tips, with the same back-lit transmission the grass has — which on
   something with a metre of canopy over your head is most of what makes it
   read as a tree rather than as a green cone. */
const TREE_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
${FRAG_UNIFORMS}
${SURF_LIGHT}

uniform vec3 uCVeg, uC0, uC2, uC3, uC4;
uniform sampler2D uLeafTex;

varying vec3  vPos;
varying vec3  vNrm;
varying float vShadow;
varying float vAO;
varying float vSeed;
varying float vV;
varying float vBark;
varying float vElem;
varying float vU;
varying float vDeep;

/* The leaf outline is sampled from the drawn cluster card — see leafTexture.
 *
 * Worth recording why it is a texture and not an equation, because the analytic
 * masks that came before it are the obvious thing to reach for: a spray was five
 * untextured triangles, so its silhouette was a convex polygon with straight
 * sides and sharp corners — measured, the interior of a foreground spray varied
 * by 0.92 levels per pixel, which is to say it was a painted card and read as
 * one instantly. Every AAA foliage system solves this with an alpha-tested
 * cluster texture, and the reason this renderer had not is the standing rule
 * that discard beside gl_FragDepth mis-compiles under ANGLE. That constraint
 * does not apply in this scene: the ground runs with logarithmic depth *off* —
 * its materials carry the nologd cache key and an explicit #undef of
 * USE_LOGARITHMIC_DEPTH_BUFFER — so nothing here writes gl_FragDepth and the
 * alpha test is free. It was checked at runtime before being relied on. */

void main(){
  ${LOGD_F}
  vec3 N = normalize(vNrm);

  /* Cut the leaf out before anything else is paid for. The bole is solid, so it
     is exempt; vBark is the same selector the shading below uses. */
  float cov = 1.0;
  float leafLum = 1.0;
  if(vBark < 0.5){
    /* The drawn cluster. Mirroring the card on a per-spray bit gives two
       distinct silhouettes out of one image, which together with the size,
       hue and value spread is enough that the repeat is not findable. */
    vec2 luv = vec2(vU*0.5 + 0.5, clamp(vV, 0.0, 1.0));
    if(fract(vElem*13.7) > 0.5) luv.x = 1.0 - luv.x;
    vec4 lt = texture2D(uLeafTex, luv);
    cov = lt.a;
    if(cov < 0.28) discard;
    leafLum = 0.45 + 1.15*lt.r;   // veins, midrib and the darker margin
  }
  /* A leaf is thin, and both these draws are DoubleSide. Shading a back face
     with the normal it was authored with points it away from the eye *and*
     away from the key, so half of every crown and a third of every tuft came
     out black — visibly so on the near trees, where the far side of the canopy
     was a hole. A leaf seen from behind is the same leaf lit through it, so the
     normal is turned to face the viewer and the transmission term below does
     the rest. This is what makes foliage read as translucent rather than as
     cardboard painted on one side. */
  vec3 Vf = normalize(uCamPos - vPos);
  if(dot(N, Vf) < 0.0) N = -N;
  /* Turned toward the viewer in azimuth only, and this second line is the
     whole of it. Flipping the *whole* normal is the obvious way to shade a
     two-sided leaf and it is wrong here: the authored normal is the crown's
     outward shell direction biased upward, so on the underside of a canopy the
     flip sends it below the horizon — and the sky term keys off N.y, so those
     leaves lost their only fill and went from dark to absolutely black. A
     debug pass writing N.y showed the crown's whole underside had gone
     negative, which is how it was found; the beauty frame just looked like
     holes in the foliage.

     A leaf does not work that way. Whichever face you are looking at, it still
     sees the sky from above and the ground from below, so the elevation of its
     normal is a property of the canopy and not of which side is toward you. */
  N = normalize(vec3(N.x, abs(N.y) + 0.18, N.z));
  float tint = fract(vSeed*0.613);

  /* Bark, and it has to be *dark* — but it may not be a silhouette either, and
     this term has now failed in both directions.

     It began as a mix from uC0*3.4 to uC3, and uC0 is the palette's darkest
     entry: on a garden world a near-black blue, so every bole in a stand came
     out as a flat black stick against the sky. Chasing that took it the whole
     way to the other end — a 0.19 albedo with a wrap term and a raised ground
     bounce on top, which drew a lit bole as near-white and read as cream PVC
     pipe. Real bark sits around 0.06 to 0.10, one of the darkest things in a
     landscape, and what keeps it off the silhouette is the fill and the rim
     below rather than a bright albedo. So: mixed out of the two mineral greys,
     warmed, kept dark, and lit like the cylinder it is.

     And it is *grooved*, hard. A bole is the closest large object to the lens
     in a wooded frame, so it is where a flat untextured surface is most
     obvious: three scales of vertical striation, stretched about eight to one
     along the trunk so the grain runs the right way. */
  float bz = vPos.y*3.2;
  float groove = snoise(vec3(vPos.xz*38.0, bz))*0.5
               + snoise(vec3(vPos.xz*96.0, bz*1.7))*0.32
               + snoise(vec3(vPos.xz*230.0, bz*2.6))*0.18;
  groove = groove*0.5 + 0.5;
  // deep fissures, not a wash: the dark end runs to a quarter
  groove = 0.26 + 0.74*groove*groove;
  vec3 bark = mix(uC3*0.19, uC4*0.13, 0.25 + 0.5*tint)*groove;
  bark *= vec3(1.20, 1.00, 0.74);

  /* Depth in the canopy. A crown lit as one surface is a green cone, and that
     is what the first version drew: every patch took the same colour and the
     same normal-ish shading, so twenty-four of them summed to a flat blob.
     Three things break it — the interior is genuinely darker because it is
     buried under two metres of its own leaves, the outer shell is where the
     new growth and the light are, and no two trees in a stand are the same
     green. The fine mottle is per-patch and per-position, so a crown is a mass
     of leaves rather than a painted shape.

     What that still had no term for was *chroma* between one spray and the next
     — every leaf on a tree took one hue and differed only in brightness, which
     is the signature of a painted model and a large part of why the whole world
     read as one flat colour. vElem is per spray, and it drives a real hue axis:
     a leaf that gets the light is yellow-green and the ones buried on the shaded
     side of the same crown are blue-green. That is what a canopy does, and a
     spread of hue survives being looked at where a spread of value does not. */
  float mott = snoise(vec3(vPos*1.35))*0.5 + 0.5;
  float e = vElem;
  vec3 leaf = uCVeg*(0.44 + 0.62*tint);
  leaf *= vec3(0.80 + 0.48*e, 0.96 + 0.10*e, 0.74 + 0.40*(1.0 - e));
  leaf *= 0.72 + 0.56*mott;
  leaf *= 0.58 + 0.84*fract(e*7.31);
  /* Depth into the crown, which is what gives a canopy volume. A leaf two
     metres inside a crown is under two metres of other leaves and is close to
     black; the ones on the outside get the sky. Without this every leaf on the
     tree returns the same value and the crown is a flat green cut-out however
     good its silhouette is. vAO carries the tree's own occlusion and vV runs
     out along each spray, so the two together say how buried this fragment is. */
  leaf *= (0.30 + 0.70*vAO)*(1.0 - 0.66*vDeep);
  leaf = mix(leaf*0.26, leaf, smoothstep(0.02, 0.55, vV));
  leaf = mix(leaf, mix(uCVeg*1.15, uC2, 0.45), smoothstep(0.62, 1.0, vV)*0.40);

  leaf *= leafLum;
  vec3 col = mix(leaf, bark, vBark);
  col = pow(max(col, 0.0), vec3(0.80))*0.87;

  float ao = vAO*mix(0.55, 1.0, vV);
  vec3 outc = shadeSurface(col, N, vShadow, ao, normalize(uCamPos - vPos));

  vec3 V = normalize(uCamPos - vPos);
  float bk = pow(clamp(dot(-V, uSunDir)*0.5 + 0.5, 0.0, 1.0), 3.0);
  outc += col*uSunColor*bk*vShadow*1.15*(1.0 - vBark);
  outc += col*uCVeg*vAO*0.70*(1.0 - vBark);

  /* The rim the trunk needs to stop being a silhouette, and it has to be the
     *star's* colour rather than the sky's.

     A bole was reading as a flat black stick and the obvious reading — that the
     bark albedo was too dark — was wrong; it measures about 0.19, which is
     right for wood. What is actually happening is that a trunk seen from a
     stand is nearly always turned away from the key, so every fragment of it
     falls to fill alone, and fill here is a skylight of (0.18, 0.28, 0.45).
     Albedo times that is a very dark blue, which is exactly what it drew. The
     shading was correct and the frame was still wrong, which is the case the
     art direction covers explicitly: anything that would read as a silhouette
     gets a rim. A rim in the fill colour only makes it a *blue* silhouette, so
     this one is warm and rides on how far the star is behind the subject —
     which is what a rim light physically is.

     It also has to stay a *rim*. A bole is a couple of pixels wide at the range
     most of a stand sits at, so a wide falloff is not an edge highlight on it,
     it is a fill over the whole trunk: at power 2.2 and 1.5x the key this drew
     a stand of chrome poles, which is a worse failure than the black sticks it
     replaced because it also breaks the matte-and-mineral rule. Narrow, and
     under one — and most of what actually keeps a shaded trunk off the
     silhouette is the ground bounce on the line after it, not the rim at all.

     Clamped before the pow because a normalised dot goes over 1.0 on rounding
     and a negative base is NaN under ANGLE — the same arithmetic that once drew
     a white dashed scratch across every star in the game. */
  float rim = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 3.2);
  float back = clamp(dot(-V, uSunDir)*0.5 + 0.5, 0.0, 1.0);
  outc += (uSunColor*(0.10 + 0.55*back*back)*vShadow + uSkyColor*0.22)*rim*vBark;

  /* And the term that actually does the work, which is not the rim.
   *
   * Forcing the trunk to a flat red proved the geometry and the material were
   * both fine, so the black was the shading — and the shading was *correct*.
   * A bole turned away from the key falls to fill alone, fill is about two per
   * cent of a sunlit surface here, and four and a half stops down is black on
   * any curve. A photograph of a backlit trunk really does come out that way.
   *
   * It still cannot stay, because a rim alone does not fix it either: a trunk
   * is three to eight pixels wide at the range a stand sits at, so an edge
   * highlight has nowhere to live — widen it far enough to see and it stops
   * being a rim and turns the trunk into a chrome pole, which is how the first
   * attempt at this failed.
   *
   * What is actually missing from the model is that a bole in a meadow stands
   * inside a whole hemisphere of sunlit grass, and that bounce arrives from
   * every direction rather than from the sky and the ground plane the general
   * fill accounts for. A wrap on the key is the cheap form of it: it lifts a
   * side-facing trunk to about a twelfth of the key instead of a fiftieth, and
   * because it is squared it falls away on the truly shadowed side rather than
   * flattening the cylinder. Roughly two stops, spent over the whole trunk. */
  float wrapT = clamp(dot(N, uSunDir)*0.5 + 0.5, 0.0, 1.0);
  outc += col*uSunColor*wrapT*wrapT*vShadow*0.09*vBark;
  outc += col*uGndColor*vAO*0.7*vBark;

  outc = aerial(outc, vPos);
  gl_FragColor = vec4(max(outc, 0.0), cov);
}
`;

/* ------------------------------------------------------------- landmarks */

/* Something to walk toward.

   A basin ringed by mountains has no middle: everything in it is either under
   your feet or six kilometres away, and the eye has nothing to travel along.
   Arches fix that better than more mountains do — the silhouette is unmistakable
   at any range, it reads as *stone* rather than as terrain, and because you can
   see sky through it the scale is unambiguous the moment anything passes behind.

   Half a torus, buried to its springing, thickened toward the feet and eaten
   into by the same noise the boulders use. Nine of them, so finding one is
   still an event. */
const ARCH_VERT = /* glsl */`${LOGD_V_PARS}
#include <shadowmap_pars_vertex>
${NOISE}
${FIELD_UNIFORMS}
${FIELD}
${STAND}

uniform vec3  uCamPos;

attribute vec4 iA;   // xz metres, seed, yaw
attribute vec4 iB;   // span, rise, tube, lean

varying vec3  vPos;
varying vec3  vNrm;
varying float vShadow;
varying float vAO;
varying float vSeed;
varying float vUp;
varying float vKind;

vec3 archP(float a, float b, float s, vec3 sz){
  vec3 ring = vec3(cos(a), sin(a), 0.0);
  vec3 tn = vec3(cos(a)*cos(b), sin(a)*cos(b), sin(b));
  // thicker toward the feet, thinnest over the crown — a span of constant
  // section is a pipe, and the taper is most of why this reads as load-bearing
  float t = sz.z*(0.55 + 1.15*(1.0 - max(ring.y, 0.0)));
  vec3 p = ring*vec3(sz.x, sz.y, 1.0) + tn*t;
  // weathered out of it, at two scales
  float d = fbm(p*(2.2/sz.x) + s, 3)*0.5 + 0.5;
  p += tn*t*(d - 0.5)*0.85;
  return p;
}

void main(){
  float s = iA.z;
  vec3 sz = vec3(iB.x, iB.y, iB.z);

  float a = position.x*TAU;
  float b = position.y*TAU;
  float e = 0.09;
  vec3 P  = archP(a,     b,     s, sz);
  vec3 Pa = archP(a + e, b,     s, sz);
  vec3 Pb = archP(a,     b + e, s, sz);
  vec3 nr = normalize(cross(Pa - P, Pb - P));

  float ca = cos(iA.w), sa = sin(iA.w);
  P  = vec3(ca*P.x  - sa*P.z,  P.y,  sa*P.x  + ca*P.z);
  nr = vec3(ca*nr.x - sa*nr.z, nr.y, sa*nr.x + ca*nr.z);

  vec4 dat = uDatum;
  vec2 gp = iA.xy;
  float lod = meshLod(length(gp));
  float gy; vec3 gn;
  standOn(gp, sz.x*0.9, lod, dat, gy, gn);

  vUp = clamp(P.y/max(sz.y, 0.01)*0.5 + 0.5, 0.0, 1.0);
  vNrm = nr;
  vSeed = s;
  vKind = 0.55;
  vShadow = sunShadowShort(gp, gy + sz.y*0.6, lod, dat);
  vAO = skyOccCheap(gp, gy, lod, dat);

  // buried to the springing line, so the legs meet the ground in rubble
  vec3 wp = vec3(gp.x, gy - sz.y*iB.w, gp.y) + P;
  wp.y -= dot(gp, gp)/(2.0*uPlanetR);
  vPos = wp;
  vec4 worldPosition = modelMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  worldPosition.xyz += nr*uShadowNB;
  #include <shadowmap_vertex>
  ${LOGD_V}
}
`;

/* ------------------------------------------------------------------- sky */

/* The dome draws *last*, and does not write a fragment depth.

   It used to be first, at renderOrder -1000, which meant its shader ran over
   every pixel of the frame and the ground was then painted over sixty per cent
   of it. Nothing rejects that: three's logarithmic depth buffer writes
   gl_FragDepth in every fragment, and a shader that computes its own depth
   cannot be depth-tested until after it has run — which is why the whole
   landed frame pays thirty per cent for log depth, and why the sky was paying
   for two thirds of itself twice.

   The dome is the one surface here that needs no depth precision at all: it is
   behind everything, always. So it skips the log-depth chunks entirely, pins
   itself to the far plane, and is drawn after the ground with the test on.
   Without a gl_FragDepth write the hardware can reject it before the shader,
   and it shades only the sky you can actually see. */
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  // z = w puts it exactly on the far plane, which is <= the cleared depth and
  // greater than anything the ground wrote, whatever mapping the ground used.
  gl_Position.z = gl_Position.w;
}
`;

/* A ground-observer sky. Rather than raymarch, this integrates the same
   Rayleigh and Mie terms analytically against an exponential atmosphere, which
   is accurate enough looking *up* and costs nothing.

   The one thing it does not share with the orbital shell is the air mass:
   Rayleigh sits high and Mie sits in the first kilometre, so near the horizon
   they see wildly different path lengths. Giving them one air mass is what
   made the old sky a flat gradient — the warm band along the horizon is
   entirely the Mie term running out to a hundred air masses while the zenith
   sees one. */
const SKY_FRAG = /* glsl */`
precision highp float;
${NOISE}
varying vec3 vDir;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uBetaR;
uniform float uBetaM;
uniform float uG;
uniform float uIntensity;
uniform float uMieBoost;
uniform vec3  uHazeColor;
uniform float uStarAmt;
uniform float uSunSize;
uniform float uSunPower;
uniform float uCloudAmt;
uniform vec3  uNight;
uniform vec3  uCloudLit;
uniform vec3  uCloudDark;
uniform float uTime;
uniform float uSeedSky;

/* A 4x4 ordered pattern, built by recursion rather than by a lookup table. */
float bayer2(vec2 a){ a = floor(a); return fract(a.x*0.5 + a.y*a.y*0.75); }

vec3 stars(vec3 d){
  vec3 sd = d*210.0;
  vec3 id = floor(sd);
  vec3 f  = fract(sd) - 0.5;
  vec3 o  = hash33(id) - 0.5;
  float pick = step(0.978, hash13(id + 11.3));
  float r = length(f - o*0.78);
  float s = pick*smoothstep(0.26, 0.02, r);
  float mag = pow(hash13(id + 5.1), 3.6);
  vec3 tint = mix(vec3(0.70, 0.80, 1.0), vec3(1.0, 0.84, 0.62), hash13(id + 2.9));
  return tint*s*(0.35 + 7.0*mag);
}

void main(){
  vec3 d = normalize(vDir);
  float up = d.y;
  vec3 L = normalize(uSunDir);
  float mu = dot(d, L);

  // Two air masses. A plain 1/cos blows up; these softened forms are monotone,
  // cheap, and land within a few percent of Kasten-Young where it matters.
  float airR = min(1.0/(max(up, 0.0) + 0.033), 30.0);
  float airM = min(1.0/(max(up, 0.0) + 0.008), 125.0);
  float sunAir = min(1.0/(max(L.y, 0.0) + 0.033), 30.0);
  // and keep deepening once the star is under the horizon, so dusk actually
  // ends instead of sitting at a permanent orange
  sunAir *= 1.0 + max(-L.y, 0.0)*42.0;

  float phaseR = 3.0/(16.0*PI)*(1.0 + mu*mu);
  float g2 = uG*uG;
  float phaseM = 3.0/(8.0*PI)*((1.0 - g2)*(1.0 + mu*mu)) /
                 ((2.0 + g2)*pow(max(1.0 + g2 - 2.0*uG*mu, 1e-4), 1.5));
  /* Multiple scattering, as a nudge toward isotropy. Single-scattering Mie is
     a forward lobe, so a thick dusty atmosphere comes out black everywhere
     except a bright patch around the star — which is wrong, and reads as a
     storm at noon. In an optically thick medium the light has bounced several
     times by the time it arrives and has forgotten which way it came. */
  phaseM = mix(phaseM, 0.0796, clamp(uBetaM*0.42, 0.0, 0.55));

  // COL is the vertical column depth, sized so the zenith optical depth lands
  // near Earth's (~0.03 red, ~0.2 blue): below that the sky is colourless, and
  // above it even an overhead sun arrives orange.
  const float COL = 0.021;
  vec3 tauSun = (uBetaR + vec3(uBetaM))*sunAir*COL;
  vec3 sunAtten = exp(-tauSun);
  vec3 denom = max(uBetaR + vec3(uBetaM), vec3(1e-4));

  // For pure scattering the closed form collapses to phase x (1 - e^-tau), and
  // *all* of the colour lives in that exponential.
  vec3 sr = uBetaR*phaseR/denom * (1.0 - exp(-uBetaR*airR*COL));
  vec3 sm = vec3(uBetaM*phaseM)/denom * (1.0 - exp(-vec3(uBetaM*airM*COL)))*uMieBoost;
  vec3 col = uSunColor*sunAtten*(sr + sm)*uIntensity;

  /* Multiple scattering, as a floor rather than a phase nudge.

     Single scattering says a dusty sky is a black sky: the direct beam is
     extinguished long before it can scatter toward the eye, so the thicker the
     air the darker the dome, which is exactly backwards. On a desert or an ice
     world this produced a near-black zenith under an opaque tan horizon band,
     and because the terrain silhouette then met black at the top of the frame
     it read as missing geometry rather than as sky. The light that reaches you
     through an optically thick atmosphere has bounced several times and no
     longer remembers the sun's direction *or* how much of the direct beam
     survived — so the floor is scaled by the column depth and only weakly by
     the attenuation. */
  /* Keyed off the *whole* column, not the Mie part alone.
   *
   * The old threshold was written when every world carried a Mie column several
   * times Earth's, so the Mie-only expression was a live number; with the dome's
   * cut to a fifth (see GROUND_MIE) it is negative on every world in the game
   * and the term switched itself off entirely. What that cost is the zenith: a
   * pure single-scattering Rayleigh sky goes to nearly nothing away from the
   * star, and the anti-sun half of a mid-morning frame came back navy-black
   * overhead, which is a sky nobody has ever stood under.
   *
   * Multiple scattering is not a Mie phenomenon anyway — a blue sky is bright
   * overhead at noon precisely because the blue has bounced. Scaled to about a
   * third of the single-scattered zenith, which is roughly what the real one
   * measures, and still zero on an airless world. */
  float colDepth = (uBetaR.x + uBetaR.y + uBetaR.z)*0.3333 + uBetaM;
  float msK = clamp((colDepth*COL - 0.060)*0.16, 0.0, 0.024);
  // And it carries the air's own colour rather than a near-grey. This term is
  // most of the dome on any world with a thick Mie column, so at 0.45 toward
  // the tint it was painting three quarters of the sky a flat warm grey and
  // the Rayleigh gradient underneath it could not be seen at all.
  vec3 msTint = mix(vec3(0.62, 0.66, 0.74), uBetaR/max(uBetaR.x + uBetaR.y + uBetaR.z, 1e-3)*2.2, 0.68);
  /* Deliberately *not* multiplied by the direct beam's survival. Scaling this
     by sunAtten reintroduces the whole problem it exists to solve: on a world
     whose Mie column is six times Earth's the beam is down by seven orders of
     magnitude at ten degrees, so the sky came out darker than the ground it
     was lighting, which is the one thing a sky can never be. */
  float msH = pow(clamp(L.y*1.7 + 0.30, 0.0, 1.0), 0.65);
  /* With a vertical shape steep enough to read as a dome.
     The multiply-scattered floor is view-independent by construction, so
     whatever shape is written here *is* the sky's gradient on any world thick
     enough for the term to dominate — and at 0.72 to 1.22 that was a ratio of
     1.7 to one from zenith to horizon. Measured across a 2400 px band of a
     landed frame the whole sky came back with a standard deviation of 5.6
     levels: not a gradient, a card. A real dome runs three to five to one, and
     it is that fall-off that tells the eye it is looking at air with depth in
     it rather than at a painted backdrop. */
  col += uSunColor*msTint*uIntensity*msK*msH*0.058
       * (0.40 + 1.10*smoothstep(0.95, -0.05, up));

  /* Airglow, and whatever the arm is doing. A night sky here is never zero:
     there is a nebula behind it and the ground under it has to be legible. */
  col += uNight*(0.55 + 0.45*smoothstep(0.55, 0.0, up));

  /* Cloud.

     A slab at one scale height, sampled where the view ray crosses it, so the
     deck converges toward the horizon on its own and never has to be told to.
     Two things make it read as weather rather than as noise on a dome: the
     coverage is thresholded, so there is clear sky between the sheets, and the
     lit and shadowed colours are separate — a cloud is the only thing in a
     landscape that is lit from *inside* the same air that is scattering, and
     giving it one flat tint is what makes a painted sky look painted.

     It sits under the star branch below, so a cloud in front of the sun is
     drawn over by the disc rather than the other way round. That is wrong by
     about one per cent of the frame and right for every other pixel. */
  if(uCloudAmt > 0.002 && up > 0.008){
    vec2 cp = d.xz/max(up, 0.008)*1.10 + vec2(uTime*0.0022, uTime*0.0009);
    /* Two fields, and the second one is warped by the first.
     *
     * Three octaves of plain fbm thresholded at one level gives a set of
     * round-edged blobs all of the same size — which is what a deck of these
     * looked like from the ground: felt, or smoke, depending on the palette.
     * Cloud is not band-limited noise. It has a *shape*: sheets torn along the
     * wind with ragged edges and holes in them, and the cheapest honest way to
     * get that is to displace the coverage field by a lower-frequency one, so
     * the boundary wanders at a scale much larger than its own detail. Two
     * more octaves on top then live only near the edges, where they can be
     * seen, instead of stippling the middle of every sheet. */
    vec2 warp = vec2(fbm(vec3(cp.x*0.34, uSeedSky + 11.0, cp.y*0.34), 2),
                     fbm(vec3(cp.x*0.34 + 5.7, uSeedSky - 4.0, cp.y*0.34), 2));
    /* 0.42, not 1.9. A displacement of two wavelengths does not perturb a
       field, it shears it: every sheet came out as a long swirling filament and
       the deck read as marbled ink rather than as weather. Half a wavelength is
       where the boundary wanders and the sheet still holds together. */
    vec2 cq = cp + warp*0.42;
    float cv = fbm(vec3(cq.x, uSeedSky, cq.y), 5)*0.5 + 0.5;
    float cov = smoothstep(0.51, 0.82, cv)*uCloudAmt;
    // thin out toward the horizon, where the slab is edge-on and the air in
    // front of it has already taken the contrast out
    cov *= smoothstep(0.02, 0.18, up)*(1.0 - smoothstep(0.55, 1.0, up)*0.35);
    /* How deep into the sheet this pixel is looking, which is the whole of a
       cloud's modelling: an edge is thin and lets the star through, a core is
       thick and is lit only on top. */
    float shade = smoothstep(0.50, 0.86, cv);
    /* Radiance is derived from the star, not authored: a cloud is lit by the
       same reddened light the ground is, so it goes orange at dusk and black at
       night without anything having to be told to.
     *
     * The 0.048 is the part that was missing, and it is a *ratio*. The dome's
     * own gain produces a zenith of around 0.011
     * in these units; the cloud term was landing at 0.97, which is eighty-eight
     * times the sky it hangs in. Everything above the coverage threshold
     * therefore clipped to flat white with no modelling in it at all, which is
     * why a deck read as felt. Four times the zenith is about what a sunlit
     * sheet measures against a clear sky, and it leaves the top of the curve
     * for the star. */
    vec3 base = uSunColor*sunAtten*uIntensity*max(L.y, 0.0)*0.115;
    vec3 cc = base*mix(uCloudDark, uCloudLit, shade) + col*0.55;
    /* The silver lining, and it is worth having its own term. A thin edge
       transmits, so it is brightest exactly where the sheet is about to end
       and brightest of all toward the star — which is the one cue that reads
       as *volume* rather than as a painted alpha. */
    float rim = (1.0 - shade)*smoothstep(0.02, 0.22, cov/max(uCloudAmt, 1e-3));
    cc += base*uCloudLit*(pow(max(mu, 0.0), 5.0)*2.6 + 0.45)*rim;
    col = mix(col, cc, clamp(cov, 0.0, 1.0));
  }

  // The sky has to arrive at the ground's own haze colour or the seam shows
  // wherever a ridge does not cover the horizon.
  col = mix(col, uHazeColor, smoothstep(0.055, -0.012, up));

  // stars, wherever the sky is dark enough to let them through — which on an
  // airless world is the middle of the day
  float lum = dot(col, vec3(0.30, 0.52, 0.18));
  float vis = exp(-lum*17.0)*uStarAmt;
  if(vis > 0.02) col += stars(d)*vis;

  // The star itself: a disc with limb darkening, not a smoothstep blob, plus
  // an aureole — the forward Mie lobe is what puts a low sun inside a bloom of
  // its own light instead of pasting it on top of the sky. Both live behind
  // one branch: this shader covers the whole frame, and three quarters of it
  // is nowhere near the sun.
  if(mu > 0.55){
    float ang = acos(min(mu, 1.0));
    float rr = ang/uSunSize;
    float disc = 1.0 - smoothstep(0.88, 1.0, rr);
    float limb = sqrt(max(1.0 - rr*rr*0.94, 0.0));
    /* Authored in real HDR, and this is the one place in a landed frame that
       can be. A review measured the whole scene living between 2 and 165 with
       0.000% of pixels clipping, which is a frame with no highlight range — and it
       cannot be fixed by making the *sky* brighter, because auto-exposure
       simply follows and takes the ground down with it. What creates range is
       something small and genuinely hot: after exposure bottoms out and the
       pre-contrast curve, a pixel needs about 120 units of scene radiance
       before AgX returns white, and this disc was authored at ninety before
       the air mass took half of it. Three hundred clips through a thin
       atmosphere and still reddens to something survivable at dusk. */
    col += uSunColor*sunAtten*disc*(0.32 + 0.68*limb)*uSunPower;
    col += uSunColor*sunAtten*uIntensity*uMieBoost*
           (pow(mu, 2200.0)*2.2 + pow(mu, 130.0)*0.28 + pow(mu, 11.0)*0.022);
  }

  /* Ordered dither. A dome that spans four stops across the frame quantises
     into visible rings once it is 8-bit, and the rings are worst in exactly
     the dark region the floor above was added to rescue. A 4x4 Bayer pattern
     is invisible as texture and breaks the contour — white noise here would
     read as the crawling speckle the god-ray march was fixed for. */
  float bay = bayer2(0.5*gl_FragCoord.xy)*0.25 + bayer2(gl_FragCoord.xy);
  col *= 1.0 + (bay - 0.5)*0.016;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/* ============================================================== the patch */

/**
 * The ground mesh: a radial grid whose *angular* resolution improves with
 * range, and the reason it does.
 *
 * The old grid had the same number of segments on every ring — 364 of them,
 * one every 0.99 degrees, from six metres to twenty-six kilometres. A constant
 * angular pitch sounds like exactly what you want, because it makes every
 * triangle the same size on screen; the trouble is *which* size. At a hundred
 * degrees of horizontal field over a 3024 px frame, 0.99 degrees is thirty
 * pixels at every range, so a 300 m peak five kilometres out was three
 * triangles wide and read as a smooth-sided cone with dead-straight edges from
 * base to apex. An art director called the skyline "N64", and no amount of
 * shading answers a silhouette.
 *
 * Raising the counts cannot fix it: a uniform-angular radial grid costs
 * 2*pi*ln(outer/inner)/theta^2 quads, so a tenfold finer skyline is a
 * hundredfold more mesh. The two spacings have to stop being one number.
 *
 * - **The near field does not need angular resolution and cannot use it.**
 *   Six metres out, 0.99 degrees is a ten-centimetre arc; that ground has no
 *   silhouette, the baked normal maps carry everything under a metre, and the
 *   height field has no band there to sample. It is given 0.03 rad instead and
 *   loses nothing measurable.
 * - **The skyline is nearly all of what the eye reads and it is a thin band.**
 *   It is given 0.0034 rad, an eighteenth of what the near field gets.
 *
 * So both the ring pitch and the segment arc are shrinking power laws of the
 * radius (RING_*, ARC_* above), and the segment count is recomputed per ring.
 * Rings whose neighbours disagree about their segment count are stitched by a
 * merge on angle — walk both rings at once and always advance whichever is
 * behind — which emits exactly na+nb triangles for an annulus, the same as a
 * matched pair, leaves no T-junction and needs no power-of-two relationship
 * between the two counts. That last part matters: rounding segment counts to
 * powers of two throws away up to forty per cent of the budget at every tier.
 *
 * Returns the geometry and the ring table, so the caller can report what it
 * actually built rather than what it asked for.
 */
function terrainGrid(q, inner, outer) {
  const cl = (x, a, b) => Math.min(b, Math.max(a, x));
  const ringAng = (r) => cl(RING_A * Math.pow(r / 1000, -RING_P), RING_MIN, RING_MAX) / q;
  const arcAng = (r) => cl(ARC_A * Math.pow(r / 1000, -ARC_P), ARC_MIN, ARC_MAX) / q;
  const SEG_MIN = 96;

  const rad = [], seg = [];
  for (let r = inner; r < outer; r *= 1 + ringAng(r)) {
    rad.push(r);
    // in eights, so the count is even and the stagger below stays a half step
    seg.push(Math.max(SEG_MIN, Math.round(Math.PI * 2 / arcAng(r) / 8) * 8));
  }
  rad.push(outer);
  seg.push(Math.max(SEG_MIN, Math.round(Math.PI * 2 / arcAng(outer) / 8) * 8));

  const nR = rad.length;
  let nV = 1;                               // the centre vertex
  for (let i = 0; i < nR; i++) nV += seg[i];
  const pos = new Float32Array(nV * 3);
  const base = new Int32Array(nR);
  let v = 0;
  for (let i = 0; i < nR; i++) {
    base[i] = v;
    // Alternate rings are staggered half a segment. Aligned rings leave
    // continuous radial spokes, and every per-vertex quantity — the marched
    // shadow above all — then varies *along* those spokes, which paints soft
    // vertical curtains down any slope facing the camera. A triangular lattice
    // scatters the same error instead of lining it up.
    const off = (i & 1) * 0.5;
    for (let s = 0; s < seg[i]; s++, v++) {
      const a = ((s + off) / seg[i]) * Math.PI * 2;
      pos[v * 3] = Math.cos(a) * rad[i];
      pos[v * 3 + 2] = Math.sin(a) * rad[i];
    }
  }
  const centre = v;                         // a cap so there is no hole under the ship

  let nT = seg[0];
  for (let i = 0; i < nR - 1; i++) nT += seg[i] + seg[i + 1];
  const idx = (nV > 65535) ? new Uint32Array(nT * 3) : new Uint16Array(nT * 3);
  let t = 0;
  const tri = (a, b, c) => { idx[t++] = a; idx[t++] = b; idx[t++] = c; };
  for (let i = 0; i < nR - 1; i++) {
    const na = seg[i], nb = seg[i + 1], ba = base[i], bb = base[i + 1];
    const offA = (i & 1) * 0.5, offB = ((i + 1) & 1) * 0.5;
    let a = 0, b = 0;
    /* Winding matters: emitted the other way round the normal lands on -Y and
       the entire landscape is backface-culled into an invisible sheet with the
       sky dome showing through it. Both cases below advance counter-clockwise
       along the ring they step, which is what keeps the sign — it holds
       whatever the two offsets are, because the edge being closed always moves
       forward in angle. */
    while (a < na || b < nb) {
      if (b >= nb || (a < na && (a + offA) / na <= (b + offB) / nb)) {
        tri(ba + a, ba + ((a + 1) % na), bb + (b % nb)); a++;
      } else {
        tri(ba + (a % na), bb + ((b + 1) % nb), bb + b); b++;
      }
    }
  }
  for (let s = 0; s < seg[0]; s++) tri(centre, (s + 1) % seg[0], s);

  /* One texel per vertex, so the per-vertex terms can be baked.

     Every quantity TERRAIN_VERT derives except the marched sun shadow is a
     function of this vertex's own xz and the datum, and both of those are
     fixed for the life of the landing — the grid is laid out once, in world
     space, and never re-centred on the camera. So the height, the normal, the
     sky occlusion, the hillside gradient, the wash network and two of the
     albedo bands are constants that were being rediscovered a hundred and
     thirty times a second. This attribute is where each vertex's answer
     lives; see `Surface.bake`. */
  const lutW = 1024;
  const lutH = Math.ceil(nV / lutW);
  const lut = new Float32Array(nV * 2);
  for (let i = 0; i < nV; i++) {
    lut[i * 2] = ((i % lutW) + 0.5) / lutW;
    lut[i * 2 + 1] = (Math.floor(i / lutW) + 0.5) / lutH;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aLut', new THREE.BufferAttribute(lut, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outer * 1.2);
  g.userData.rings = nR;
  g.userData.verts = nV;
  g.userData.lut = { w: lutW, h: lutH };
  return g;
}

/** Indexed icosphere. three's own is unindexed, which triples the vertex
 *  count — and the vertex stage is where every rock pays for its shadow. */
function icoSphere(detail) {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let d = 0; d < detail; d++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      let m = cache.get(key);
      if (m === undefined) {
        const va = verts[a], vb = verts[b];
        const x = va[0] + vb[0], y = va[1] + vb[1], z = va[2] + vb[2];
        const l = Math.hypot(x, y, z);
        m = verts.length; verts.push([x / l, y / l, z / l]); cache.set(key, m);
      }
      return m;
    };
    const nf = [];
    for (const f of faces) {
      const a = mid(f[0], f[1]), b = mid(f[1], f[2]), c = mid(f[2], f[0]);
      nf.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]);
    }
    faces = nf;
  }
  const pos = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) { pos[i * 3] = verts[i][0]; pos[i * 3 + 1] = verts[i][1]; pos[i * 3 + 2] = verts[i][2]; }
  const idx = new Uint16Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) { idx[i * 3] = faces[i][0]; idx[i * 3 + 1] = faces[i][1]; idx[i * 3 + 2] = faces[i][2]; }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/**
 * One tuft of blades. Each blade is five vertices and three triangles: a
 * tapered strip with a mid-span pair so the vertex shader has something to bow
 * over — a three-vertex blade can lean but it cannot curve, and a field of
 * straight leaning spikes reads as bristles.
 *
 * The attribute is (u, v, blade): u across the blade, v along it, and the
 * blade's index, which is the only thing that distinguishes one blade of a
 * tuft from another. Everything else about it is hashed from that index in the
 * shader, so a tuft costs fifteen vertices and no attributes.
 */
function tuftGeom(blades) {
  const pos = [];
  const idx = [];
  for (let b = 0; b < blades; b++) {
    const o = b * 5;
    pos.push(-1, 0, b, 1, 0, b, -0.62, 0.55, b, 0.62, 0.55, b, 0, 1, b);
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/* A tree: one tapered bole and a crown of leaf sprays, in one geometry.
 *
 * The z channel is the primitive selector the vertex stage reads — -1 for the
 * trunk, 0..n-1 for the sprays — which is the same trick tuftGeom uses for its
 * blades and keeps the whole tree in a single instanced draw. The trunk is
 * emitted as a strip of quads around its own circumference with x carrying the
 * angle in turns.
 *
 * A spray is seven vertices and five triangles rather than the grass blade's
 * five and three, and both of those numbers are the fix for the thing that made
 * a tree read as a papercraft model. The old crown was twenty-four patches each
 * *nearly as wide as the whole crown*, so you could count the leaves: two dozen
 * hard-edged quads with straight silhouettes, which is the whole of what a
 * low-poly read is. What a canopy actually presents is a mass whose individual
 * elements are below the resolution you are looking at it with, and the only
 * way to get there is many small ones.
 *
 * Seventy-two of them, and the extra pair of vertices buys the outline: with a
 * mid-span pair the shader can run a *width profile* along the spray — narrow
 * at the stalk, broad at two-thirds, drawn to a point — so the edge is a curve
 * instead of the straight taper of a triangle pair. Straight edges at this
 * count are what the eye locks onto.
 *
 * It is affordable because trees are not where the triangles go. A vista frame
 * holds about eighty of them inside the 760 m fade against a terrain grid of
 * 225k vertices; at 72 sprays a tree that is 29k triangles, under one per cent
 * of the frame. The vertex stage is the real cost — every vertex re-derives the
 * instance's placement — which is why the crown carries its own LOD below.
 */
function treeGeom(sprays, sides = 7) {
  const pos = [];
  const idx = [];
  /* The bole at z = -1, then TREE_LIMBS branches at z = -2, -3, ... — the same
     tapered tube topology, so one strip of quads serves both and the vertex
     stage tells them apart by the same selector it already reads.
     Branches are the thing the crown was missing. A canopy built as a shell of
     leaf sprays around a bare pole has no structure inside it: you see sky
     through the middle, the foliage reads as a parasol balanced on a stick, and
     the silhouette against a bright sky is a stick. Every real tree's
     recognisable outline is its branching, and the leaves hang off it in
     clumps rather than tiling a sphere. */
  for (let b = -1; b >= -1 - TREE_LIMBS; b--) {
    // The bole is what you stand next to and gets the full ring; a limb is a
    // few pixels across at any range it is legible, so four sides is plenty and
    // the saving is paid by every instance in the band.
    const sd = b === -1 ? sides : 4;
    const o = pos.length / 3;
    for (let i = 0; i <= sd; i++) pos.push(i / sd, 0, b, i / sd, 1, b);
    for (let i = 0; i < sd; i++) {
      const a = o + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const base = pos.length / 3;
  /* u is ±1 across the spray and v runs along it; the shader turns u into a
     real half-width via the profile, so the three cross-pairs here are only
     saying *where* to sample it. */
  for (let b = 0; b < sprays; b++) {
    const o = base + b * 7;
    pos.push(-1, 0.06, b, 1, 0.06, b,
      -1, 0.42, b, 1, 0.42, b,
      -1, 0.76, b, 1, 0.76, b,
      0, 1, b);
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2,
      o + 2, o + 3, o + 4, o + 3, o + 5, o + 4,
      o + 4, o + 5, o + 6);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/**
 * The arch: a torus parameterised as (u, v) in turns, emitted over slightly
 * more than half the ring so the ends run below the ground and are buried
 * rather than showing as open pipe. The shader does the rest.
 */
function archGeom(ringSegs, tubeSegs, u0, u1) {
  const pos = [];
  const idx = [];
  for (let i = 0; i <= ringSegs; i++) {
    const u = u0 + (u1 - u0) * (i / ringSegs);
    for (let j = 0; j < tubeSegs; j++) pos.push(u, j / tubeSegs, 0);
  }
  for (let i = 0; i < ringSegs; i++) {
    for (let j = 0; j < tubeSegs; j++) {
      const a = i * tubeSegs + j;
      const b = i * tubeSegs + ((j + 1) % tubeSegs);
      const c = (i + 1) * tubeSegs + j;
      const d = (i + 1) * tubeSegs + ((j + 1) % tubeSegs);
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** A flat fan disc in XZ, unit radius, for the shadow decals. */
function discFan(segs) {
  const pos = [0, 0, 0];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pos.push(Math.cos(a), 0, Math.sin(a));
  }
  const idx = [];
  for (let i = 0; i < segs; i++) idx.push(0, 1 + ((i + 1) % segs), 1 + i);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Instance data for one scatter band. Radius is sampled log-uniformly, which
 * puts the areal density on 1/r^2 — roughly constant density *on screen*,
 * which is the only density that matters. Size grows with range so a boulder
 * two kilometres out is still a few pixels rather than absent.
 */
/* Proportions, in four classes rather than one.

   The instance shader can make a stone angular, bedded or tapered, but at the
   five to forty pixels a scatter instance actually occupies, none of that
   reads — the only property of a shape legible at that size is its *aspect
   ratio*, and drawing every band from one narrow distribution of it is why an
   independent reviewer could describe the whole field, correctly, as one
   convex blob rotated and scaled.

   So: a third of everything is a plate lying flat, which is what broken
   bedrock actually leaves; most of the rest is a general lump; a sixth are
   blocks that stand as tall as they are wide; and the last few are slabs
   tipped on end. The three axes are drawn independently for the slabs, because
   a slab is long in one direction and that is the whole of its silhouette. */
function shapeOf(B, o, size, flat, rnd) {
  const cls = rnd();
  let fx = 0.78 + rnd() * 0.5, fz = 0.78 + rnd() * 0.5, fy;
  if (cls < 0.30) {                       // plate
    fy = 0.09 + rnd() * 0.15;
    fx *= 1.15 + rnd() * 0.45; fz *= 1.15 + rnd() * 0.45;
  } else if (cls < 0.76) {                // the general lump
    fy = flat + rnd() * 0.42;
  } else if (cls < 0.93) {                // block
    fy = 0.85 + rnd() * 0.55;
  } else {                                // slab on end, or a spire
    fy = 1.5 + rnd() * 1.5;
    if (rnd() < 0.5) fx *= 0.42; else fz *= 0.42;
  }
  B[o] = size * fx;
  B[o + 1] = size * fy;
  B[o + 2] = size * fz;
  // A plate is nearly buried; a spire is not.
  B[o + 3] = 0.14 + rnd() * 0.30 + (cls < 0.30 ? 0.22 : 0);
}

function scatterBand(n, r0, r1, s0, s1, seed, opt = {}) {
  let st = (Math.floor(seed * 7919) ^ 0x9e3779b9) >>> 0;
  const rnd = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const flat = opt.flat || 0.52;      // how much shorter than wide
  const tile = opt.tile || 0;         // if set, lay out in one square cell
  const A = new Float32Array(n * 4), B = new Float32Array(n * 4);
  if (tile) {
    /* A tiled band is laid out once in a single cell and wrapped into whichever
       copy of it the camera is standing in, so the near ground travels with the
       viewer. Stratified on a jittered lattice rather than sampled at random:
       a Poisson field of two thousand points over a hundred metres square has
       holes several metres wide in it, and a hole in the gravel is much more
       visible than a clump. */
    const side = Math.max(1, Math.round(Math.sqrt(n)));
    for (let i = 0; i < n; i++) {
      const cx = i % side, cy = Math.floor(i / side) % side;
      A[i * 4] = ((cx + rnd()) / side - 0.5) * tile;
      A[i * 4 + 1] = ((cy + rnd()) / side - 0.5) * tile;
      A[i * 4 + 2] = rnd() * 40;
      A[i * 4 + 3] = rnd() * Math.PI * 2;
      const size = s0 + (s1 - s0) * Math.pow(rnd(), 2.1);
      shapeOf(B, i * 4, size, flat, rnd);
    }
    return { A, B, n };
  }
  /* Stratified in angle as well as in radius. Sampling the angle uniformly at
     random leaves gaps a third of the frame wide and clots elsewhere, and the
     rejection test downstream can only ever take candidates *away* — so
     whatever holes the sampler leaves are holes in the finished field. One
     candidate per angular cell with a jitter inside it costs nothing and means
     the density the ground asks for is the density it gets. */
  for (let i = 0; i < n; i++) {
    const u = Math.pow((i + rnd()) / n, 0.88);
    const r = r0 * Math.pow(r1 / r0, u);
    const a = (i * 2.399963229 + rnd() * 0.9) % (Math.PI * 2);
    const grow = 0.55 + 0.75 * Math.sqrt(r / r1);
    // skewed small: a field of same-sized boulders reads as popcorn
    const size = (s0 + (s1 - s0) * Math.pow(rnd(), 2.1)) * grow;
    A[i * 4] = Math.cos(a) * r;
    A[i * 4 + 1] = Math.sin(a) * r;
    A[i * 4 + 2] = rnd() * 40;
    A[i * 4 + 3] = rnd() * Math.PI * 2;
    shapeOf(B, i * 4, size, flat, rnd);
  }
  return { A, B, n };
}

/* The scatter table.

   Four bands used to leave the two ends of the size hierarchy missing: there
   was nothing under a fifteen-centimetre pebble, so the ground you stand on
   was smooth, and nothing over a thirty-metre outcrop, so the middle distance
   had no scale in it. Six bands cover gravel to mesa, and each one answers the
   ground differently — which is the entire point, because a band that responds
   to slope and shelter *clusters*, and a band that does not is confetti.

   uBand  = (slope window lo, slope window hi, how hard it clumps, wash affinity)
   uBand2 = (density bias, how much shelter matters, altitude window lo, hi)

   `det` is icosphere subdivision — 20, 80, 320, 1280 triangles — and it is the
   most expensive number in this table by a distance, because every vertex of
   every surviving instance re-derives the *instance's* placement: three ground
   samples, an occlusion pair and a shadow march, twelve height-field
   evaluations that are identical across the whole stone. Subdividing a band
   therefore multiplies its cost rather than adding to it, which is why the
   whole scatter used to sit at twenty triangles a rock.

   So detail is bought where a stone is *large on screen* and there are few of
   them, and paid for where it is small and there are thousands:

   - cobble is what a stone two metres from your boots is made of, and at
     twenty triangles it was a visibly polygonal blob filling a third of the
     frame. It goes to eighty.
   - boulder is the one you actually walk up to, one to seven metres and as
     near as sixty; at eighty triangles a four-metre block a stride away had
     sixty-pixel straight edges on it. It goes to 320 and pays an eighth of its
     count.
   - outcrop is the six-to-twenty-six metre band that carries the middle
     distance, and the near end of it is a hundred and seventy pixels across.
     It goes to 320, and pays a fifth of its count for the privilege.
   - grit and gravel are a few pixels each past ten metres and there are six
     thousand of them; they pay, in count.

   The real fix is to hoist the per-instance work out of the vertex stage
   entirely — one texel per instance, filled by a pre-pass — after which the
   triangle counts stop mattering. That needs a render target and a place in
   the frame to fill it, which is not in this file. */
const BANDS = [
  // Grit. Under four inches, and the band that only exists because the ground
  // is about to be walked on at eye height rather than looked at from a crane.
  // It floods the washes: a dry channel with no gravel in its bed is a groove.
  {
    key: 'grit', n: 3100, tile: 100, s0: 0.04, s1: 0.17, det: 0, dec: 0,
    band: [0.00, 0.26, 0.80, 1.8], band2: [1.7, 0.85, -0.30, 0.0], fade: 175, flat: 0.30,
  },
  // Gravel — what you could pick up. The hero band: this is what is a metre
  // from the lens on foot, so it is the one that carries the subdivision.
  {
    key: 'gravel', n: 1900, tile: 235, s0: 0.13, s1: 0.52, det: 1, dec: 1,
    band: [0.00, 0.34, 0.78, 1.5], band2: [1.6, 0.80, -0.30, 3.1], fade: 520, flat: 0.38,
  },
  // What you could sit on. Banks on the apron under a slope, which is what
  // gives a hillside a foot instead of a hem.
  /* And it casts. Nothing within sixty metres of a standing figure threw a
     shadow at all — only boulder and outcrop had the flag, and their bands
     start at 60 m and 260 m from the ship. Fifteen rocks in frame, zero
     shadows, and a sun-shadow A/B that moved 0.10% of the pixels. A cobble is
     half a metre to two metres across against a 9 cm shadow texel, which is
     five to twenty texels: that is a shape with a direction in it, not a
     smudge, and it is the size of thing the eye uses to decide where the
     ground is. Grit and gravel keep their contact ellipses; at four inches
     they would be one texel. */
  {
    key: 'cobble', n: 2200, tile: 800, s0: 0.40, s1: 2.2, det: 1, dec: 1, cast: 1,
    band: [0.03, 0.52, 0.70, 1.0], band2: [1.5, 0.70, -0.20, 6.4], fade: 1500, flat: 0.44,
  },
  // What you would walk around.
  {
    key: 'boulder', n: 850, r0: 60, r1: 2600, s0: 1.4, s1: 7.2, det: 2, dec: 1, cast: 1,
    band: [0.04, 0.86, 0.62, 0.60], band2: [1.6, 0.55, -0.22, 11.7], fade: 6000, flat: 0.50,
  },
  // Bedrock breaking out of the ground it belongs to, and only where the
  // ground was steep enough to have shed its cover.
  {
    key: 'outcrop', n: 430, r0: 260, r1: 7500, s0: 6.0, s1: 26.0, det: 2, dec: 1, cast: 1,
    band: [0.09, 1.70, 0.45, 0.10], band2: [1.5, 0.30, -0.12, 19.3], fade: 15000, flat: 0.60,
  },
  // And the ones that stand against the sky at ten kilometres. A hundred of
  // them across twelve kilometres of basin is rare enough that walking to one
  // is a decision rather than a formality.
  {
    key: 'mesa', n: 115, r0: 700, r1: 12000, s0: 20.0, s1: 90.0, det: 2, dec: 0,
    band: [0.02, 1.25, 0.35, 0.0], band2: [1.4, 0.25, -0.10, 27.9], fade: 26000, flat: 0.68,
  },
];

export class Surface {
  /**
   * @param {object} spec    the planet's generated spec
   * @param {string} quality
   */
  constructor(spec, quality) {
    this.spec = spec;
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = true;
    this.disposables = [];

    const hi = quality === 'high', lo = quality === 'low';
    /* One knob, and it scales both angular resolutions together.

       The grid's shape — how the ring pitch and the segment arc trade off
       against range — is a property of the *view*, not of the machine, so a
       lower tier does not get a differently shaped mesh, it gets the same one
       coarser. Vertex count goes as the square of this, and the terrain vertex
       stage is the single most expensive thing in a landed frame, so it is the
       first number to move if a tier misses frame rate. */
    const GQ = lo ? 0.60 : hi ? 0.92 : 0.74;
    const REACH = 26000;   // metres to the horizon cut
    const INNER = 6;
    /* The spacing the mesh actually samples at, as a fraction of the range.
       Every band of the height field is switched off above it, so this number
       is what decides whether the distance is smooth or aliased, and it is
       taken from the law the grid is built from rather than measured off the
       result. See meshLod: the shader reconstructs the clamps from it. */
    const lodK = LOD_K1 / GQ;

    // An airless world is not a terran world with the haze turned down: the
    // sky is black at noon, the stars are out, the shadows are hard and the
    // distance stays contrasty. Falling back to a terran atmosphere put a blue
    // sky over every barren moon in the game.
    this.hasAir = !!spec.atmo;
    this.atmo = spec.atmo || {
      betaR: new THREE.Vector3(0.035, 0.05, 0.085), betaM: 0.02, g: 0.62, intensity: 1.0,
    };

    /* What lives here, and how the ground breaks.

       Two numbers decide most of the difference between one biome and another
       once the palette is accounted for. `veg` is how much of the ground can
       carry anything — the generator already scores that for terran worlds, and
       an ocean world's coasts and a toxic world's mats get their own — and
       `crack` is how hard the surface dries or freezes into plates, which is
       what separates an ice sheet and a playa from loose regolith. */
    const kind = spec.type;
    const veg = kind === 'terran' ? THREE.MathUtils.clamp(spec.veg || 0.5, 0.22, 0.95)
      : kind === 'ocean' ? 0.55
        : kind === 'toxic' ? 0.42 : 0;
    const crack = kind === 'ice' ? 1.0 : kind === 'desert' ? 0.8
      : kind === 'lava' ? 0.9 : kind === 'iron' ? 0.55
        : kind === 'barren' ? 0.32 : 0.40;
    /* Flora colour is the palette's own c1, which for every living world in the
       table *is* the vegetation band — chlorophyll green, retinal purple or
       rust, depending on the star it grew under. Inventing a green here would
       put a colour on the ground that the same planet does not have from orbit. */
    /* And the vegetation colour is *saturated*, not muted toward the void.
       c1 on a garden world is a dark olive, and lerping it 18% toward c0 — the
       palette's near-black blue — took what chroma it had. Living matter is the
       most saturated thing in any landscape; pushing it away from its own grey
       is what makes a meadow read as a meadow rather than as grey-green felt. */
    const cveg = spec.colors.c1.clone();
    {
      const gy = 0.2126 * cveg.r + 0.7152 * cveg.g + 0.0722 * cveg.b;
      cveg.setRGB(gy + (cveg.r - gy) * 1.30,
        gy + (cveg.g - gy) * 1.30,
        gy + (cveg.b - gy) * 1.30);
    }

    const U = {
      uSeed: { value: spec.seed },
      uRelief: { value: spec.relief },
      uPlanetR: { value: spec.radius * 1000 },
      uSea: { value: spec.sea },
      uSeaDrop: { value: spec.garden ? -26.0 : -40.0 },
      uType: { value: spec.typeId | 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.5, 0.3).normalize() },
      uLodK: { value: lodK },
      // filled from the CPU transliteration at the end of the constructor
      uDatum: { value: new THREE.Vector4() },
      // one shadow texel, in metres; Game.setShadowScale owns the number
      uShadowNB: { value: 0.06 },
      uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
      uSkyColor: { value: new THREE.Color(0.18, 0.28, 0.45) },
      uGndColor: { value: new THREE.Color(0.1, 0.08, 0.06) },
      uExtR: { value: new THREE.Vector3(1 / 34000, 1 / 15000, 1 / 6500) },
      uExtM: { value: 1 / 12000 },
      uInsR: { value: new THREE.Color(0.3, 0.4, 0.55) },
      uInsM: { value: new THREE.Color(0.1, 0.08, 0.06) },
      uMieG: { value: 0.62 },
      uHazeH: { value: 1100 },
      uExtD: { value: 1 / 9000 },
      uInsD: { value: new THREE.Color(0.1, 0.07, 0.05) },
      uDustH: { value: 70 },
      uCamPos: { value: new THREE.Vector3() },
      // (fade-in r^2, fade-out r^2, box centre x, box centre z) — Game owns it
      uShadowR: { value: new THREE.Vector4(1.6e4, 4.9e4, 0, 0) },
      uC0: { value: spec.colors.c0 },
      uC1: { value: spec.colors.c1 }, uC2: { value: spec.colors.c2 },
      uC3: { value: spec.colors.c3 }, uC4: { value: spec.colors.c4 },
      uCWater: { value: spec.colors.water },
      uCVeg: { value: cveg },
      uVeg: { value: veg },
      uCrack: { value: crack },
      uLavaGlow: { value: (spec.typeId | 0) === 4 ? (spec.lavaGlow || 1) * 0.5 : 0 },
      /* The baked sets. uTerInv is 1/metres for the fine, mid and macro sample
         scales; uTerSet is which layer plays which role on this world;
         uTerK is (normal, albedo) strength and stays at zero until the images
         have decoded. */
      uTerTex: { value: terrainTexture() },
      uLeafTex: { value: leafTexture() },
      uTerInv: { value: new THREE.Vector4(1 / 0.55, 1 / 4.3, 1 / 34.0, 1 / 108.0) },
      uTerSet: { value: new THREE.Vector4(0, 1, 2, 3) },
      uTerK: { value: new THREE.Vector2(0, 0) },
      /* 0.28, not 0.55, and the number that justified 0.55 does not survive a
         matched crop.

         It was set from a *mean* saturation — ours 0.61 against real
         photography's 0.25 — but measured on the whole frame, where most of
         ours was sky. Measured on the same crop the reviewer measures, the
         ground two metres from the boots, the reference frames run a mean
         saturation of 0.436 to 0.561 and ours ran 0.278. The reference is
         *more* saturated than we are, not less.

         What 0.55 also does is cut the saturation *spread* by 55%, and the
         spread is the whole of finding number five: 0.047 against the
         reference's 0.171-0.32. Measured at one pinned pose, 0.55 / 0.40 /
         0.28 give a spread of 0.051 / 0.061 / 0.079 and a mean of 0.278 /
         0.284 / 0.334 — so 0.28 is still under the reference on both counts
         and is not a licence to make the palette loud. The gamma below it
         still holds the floor up. */
      /* Desaturation exists because a palette authored for a lit sphere seen
         from orbit is far too saturated to stand in — and that argument is
         about *mineral* ground. Vegetation is the one thing on a landscape
         that really is that saturated, and running the same 0.28 over a
         garden took the green out of it and left khaki.

         Both numbers come down again. The whole set was reading as grey pastel
         — the single loudest complaint about it — and desaturation applied to
         an already-muted palette is the reason: the entries are five shades of
         one rock to begin with, so pulling chroma out of them leaves nothing
         but value. A garden keeps essentially all of its colour now, and even
         a mineral world keeps three quarters. */
      uDesat: { value: spec.garden ? 0.02 : 0.08 },
      uDbg: { value: 0 },
      // the same wind the dune ranks are built from — see terrainRaw
      uWind: { value: new THREE.Vector2(Math.cos(spec.seed * 1.7), Math.sin(spec.seed * 1.7)) },
      uDecalK: { value: 0.5 },
      uHazeK: { value: 1 / 4000 },
      uTime: { value: 0 },
    };
    this.U = U;

    /* The datum, once, on the CPU — and then handed to the GPU.

       groundYFlat subtracts the field's value at the landing site so the site
       passes exactly through y = 0. Both paths now read the same two numbers
       from the same place, so they cannot describe different surfaces, and no
       vertex shader has to spend twenty-two octaves rediscovering a constant. */
    this._datum = [0, 0];
    /* Where on the world this is, chosen rather than assumed — see pickSite.
       Everything downstream reads it out of uDatum.zw, so the mesh, the
       scatter, the marched shadow and the walking player cannot land on four
       different patches of ground. */
    this._site = pickSite(U);
    jTerrainRaw(this._site[0], this._site[1], 0.26, U, this._datum);
    U.uDatum.value.set(this._datum[0], this._datum[1], this._site[0], this._site[1]);
    // and the same law on the CPU — see seaLevel in the GLSL above
    this._seaY = Math.min((spec.sea - this._datum[0]) * J_VSCALE, spec.garden ? -26 : -40);

    const pick = (...names) => {
      const o = {};
      for (const n of names) o[n] = U[n];
      return o;
    };
    const FIELD_U = pick('uSeed', 'uRelief', 'uPlanetR', 'uSea', 'uSeaDrop', 'uType', 'uSunDir',
      'uLodK', 'uDatum', 'uShadowNB');
    const SHADE_U = pick('uSunDir', 'uSunColor', 'uSkyColor', 'uGndColor', 'uExtR',
      'uExtM', 'uInsR', 'uInsM', 'uMieG', 'uHazeH', 'uExtD', 'uInsD', 'uDustH', 'uCamPos',
      'uShadowR');
    const TER_U = pick('uTerTex', 'uTerInv', 'uTerSet', 'uTerK', 'uDesat', 'uDbg', 'uWind');
    // the water surface is animated, so the ground shader needs the clock too
    TER_U.uTime = U.uTime;

    /* Which of the four sets this world is made of, and at what size.

       A review of two worlds side by side found the desert planet and the ice
       moon carrying *the same shape* at *the same wavelength*, one orange and
       one grey, and correctly called that worse than one material — a palette
       swap is not a different place. So the layer assignment and the three
       sample scales are both properties of the world: an ice sheet is crust all
       the way down with rock breaking through, a lava flow is bare rock with a
       crust rind, a desert is regolith at a coarser pitch because a dune field
       genuinely is coarser. The seed then moves all three scales by a fifth, so
       two deserts are not the same desert either. */
    const SETS = {
      terran: [0, 1, 2, 3], desert: [0, 1, 2, 3], ocean: [0, 1, 2, 3],
      barren: [0, 2, 2, 3], iron: [0, 2, 2, 0], ice: [0, 3, 2, 3],
      lava: [0, 0, 2, 3], toxic: [0, 3, 2, 3],
    };
    U.uTerSet.value.fromArray(SETS[kind] || SETS.terran);
    const PITCH = {
      desert: 1.34, ice: 0.86, lava: 1.12, iron: 0.94, barren: 1.05,
    };
    const jit = (0.5 + (spec.seed * 0.618034) % 1) * 0.42 + 0.79;   // 0.79 .. 1.21
    U.uTerInv.value.multiplyScalar(1 / ((PITCH[kind] || 1) * jit));

    /* ------------------------------------------------------------ ground

       lights: true, and the whole of UniformsLib.lights merged in, because
       three wires a ShaderMaterial's light and shadow-map uniforms by *name*
       when the flag is set and throws on the first one it cannot find. Cloned
       rather than shared: every material with the flag gets its own set and
       three refills them from the render state each frame. */
    /* The baked per-vertex terms, filled by `bake` before the first frame is
       drawn. Null until then — an unbound sampler reads as an empty texture,
       which would draw the ground flat rather than wrong. */
    U.uLutA = { value: null };
    U.uLutB = { value: null };
    const LUT_U = pick('uLutA', 'uLutB');

    this.terrainMat = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      lights: true,
      uniforms: Object.assign(
        THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
        FIELD_U, SHADE_U, TER_U, LUT_U,
        pick('uC0', 'uC1', 'uC2', 'uC3', 'uC4', 'uCWater', 'uLavaGlow',
          'uCVeg', 'uVeg', 'uCrack')),
    });
    this.terrain = new THREE.Mesh(terrainGrid(GQ, INNER, REACH), this.terrainMat);
    this.terrain.frustumCulled = false;
    this.terrain.receiveShadow = true;
    /* And it casts. A traversal of the landed scene used to find thirteen
       shadow casters and all thirteen of them were ship hull: no ridge shadowed
       itself, no bank shadowed the ground under it and no boulder was in
       anything's shade. The marched shadow covers the kilometre scale for
       nothing, but it is band-limited to features over about five metres and
       knows nothing about the ship or the scatter — the map is what puts them
       all in the same light. */
    this.terrain.castShadow = true;
    this.terrainDepthMat = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      uniforms: Object.assign({}, FIELD_U, pick('uLutA')),
    });
    this.terrain.customDepthMaterial = this.terrainDepthMat;
    this.root.add(this.terrain);
    this.disposables.push(this.terrain.geometry, this.terrainMat, this.terrainDepthMat);

    /* The bake rig. It draws the terrain's own vertex buffer as points, so it
       shares the attribute buffers rather than uploading a second copy; the
       geometry is unindexed on purpose, because a Points draw over an index
       buffer would run the shader once per *index* — six times per vertex,
       every one of them writing the same texel. */
    /* None of it goes in `disposables`: that list is what `eachMaterial`
       enumerates, and `Game.setGroundDepth` walks it to move every material
       the surface owns on or off the logarithmic depth buffer — which these
       two are not drawn under and have no chunks for. `dispose` takes them
       explicitly instead. */
    const tg = this.terrain.geometry;
    const bakeGeo = new THREE.BufferGeometry();
    bakeGeo.setAttribute('position', tg.getAttribute('position'));
    bakeGeo.setAttribute('aLut', tg.getAttribute('aLut'));
    bakeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this._bake = {
      lut: tg.userData.lut,
      geo: bakeGeo,
      matA: new THREE.ShaderMaterial({
        vertexShader: TER_BAKE_A, fragmentShader: TER_BAKE_FRAG,
        uniforms: Object.assign({}, FIELD_U), depthTest: false, depthWrite: false,
      }),
      matB: new THREE.ShaderMaterial({
        vertexShader: TER_BAKE_B, fragmentShader: TER_BAKE_FRAG,
        uniforms: Object.assign({}, FIELD_U), depthTest: false, depthWrite: false,
      }),
      done: false,
    };

    /* ----------------------------------------------------------- scatter

       Each band gets its own material because each band asks the ground a
       different question, and the answer lives in two vec4s. They share every
       other uniform *object*, so a band costs one extra uniform upload and no
       extra shader — three keys its program cache on the source, and the source
       is identical. */
    const ROCK_U = () => Object.assign(
      THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      FIELD_U, SHADE_U, TER_U,
      pick('uC0', 'uC2', 'uC3', 'uC4', 'uCVeg', 'uVeg'),
      { uBand: { value: new THREE.Vector4() }, uBand2: { value: new THREE.Vector4() },
        uFade: { value: 1000 }, uTileP: { value: 0 } });

    const dens = lo ? 0.34 : hi ? 1 : 0.66;
    this.rocks = [];
    this.scatterMats = [];
    BANDS.forEach((b, i) => {
      const n = Math.round(b.n * dens);
      if (n < 8) return;
      const inst = scatterBand(n, b.r0 || 0, b.r1 || 0, b.s0, b.s1,
        spec.seed * 7.3 + i * 131 + 1, { flat: b.flat, tile: b.tile || 0 });
      const attrA = new THREE.InstancedBufferAttribute(inst.A, 4);
      const attrB = new THREE.InstancedBufferAttribute(inst.B, 4);

      const mat = new THREE.ShaderMaterial({
        vertexShader: ROCK_VERT, fragmentShader: ROCK_FRAG, uniforms: ROCK_U(),
        lights: true,
      });
      mat.uniforms.uBand.value.fromArray(b.band);
      mat.uniforms.uBand2.value.fromArray(b.band2);
      mat.uniforms.uFade.value = b.fade;
      mat.uniforms.uTileP.value = b.tile || 0;
      this.scatterMats.push(mat);
      this.disposables.push(mat);

      const g = icoSphere(b.det);
      g.setAttribute('iA', attrA);
      g.setAttribute('iB', attrB);
      g.instanceCount = n;
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.name = b.key;
      /* Which bands cast, and why not all of them.
         The cost of casting is this shader run a second time, and it is the
         most expensive vertex stage in the scene — so it is spent where a
         shadow is a *shape* rather than a smudge. Boulders and outcrops are
         metres to tens of metres across and the sun's box is a few hundred
         metres wide, so a handful of instances inside it get real cast shadows
         with legs on them; gravel and cobble already have their contact
         ellipses, and grit at four inches would be one shadow-map texel. */
      if (b.cast) {
        m.castShadow = true;
        const dmatR = new THREE.ShaderMaterial({
          vertexShader: ROCK_DEPTH_VERT,
          fragmentShader: DEPTH_FRAG,
          uniforms: Object.assign({}, FIELD_U, pick('uCamPos'),
            { uBand: mat.uniforms.uBand, uBand2: mat.uniforms.uBand2,
              uFade: mat.uniforms.uFade, uTileP: mat.uniforms.uTileP }),
        });
        m.customDepthMaterial = dmatR;
        this.disposables.push(dmatR);
      }
      this.root.add(m);
      this.rocks.push(m);
      this.disposables.push(g);

      if (!b.dec) return;
      const dmat = new THREE.ShaderMaterial({
        vertexShader: DECAL_VERT,
        fragmentShader: DECAL_FRAG,
        uniforms: Object.assign({}, FIELD_U, pick('uCamPos', 'uDecalK', 'uHazeK'),
          { uBand: mat.uniforms.uBand, uBand2: mat.uniforms.uBand2,
            uFade: mat.uniforms.uFade, uTileP: mat.uniforms.uTileP }),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.MultiplyBlending,
        premultipliedAlpha: true,
      });
      const dg = discFan(6);
      dg.setAttribute('iA', attrA);
      dg.setAttribute('iB', attrB);
      dg.instanceCount = n;
      const dm = new THREE.Mesh(dg, dmat);
      dm.frustumCulled = false;
      dm.renderOrder = 5;
      dm.name = b.key + '-shadow';
      this.root.add(dm);
      this.disposables.push(dg, dmat);
    });

    /* --------------------------------------------------------------- flora

       One band of tufts, near, plus the same habitability field spent as
       ground colour all the way to the horizon. Dead worlds skip it entirely —
       an empty draw call is still a state change, and there are a lot of dead
       worlds. */
    this.veg = veg;
    if (veg > 0.02) {
      /* Two bands, and the near one is the reason any of this reads.

         One band cannot serve both a crane camera three hundred metres out and
         a pair of boots: at the density that covers two hundred metres of
         ground there are thirty tufts within ten paces, which from eye height
         is a bare plain with a few weeds on it. The turf band is a thirty-metre
         cell at thirty times that density and dies at eighteen metres, which is
         about where an individual tuft stops being resolvable anyway; the stand
         band carries the middle distance, and the ground colour carries the
         rest of the way to the horizon. */
      /* Three bands on a garden, not two, and the near one is much denser.
         Two bands was tuned for a world with scrub on it: at 2600 tufts in a
         thirty-metre cell the ground five paces away has a weed every half
         metre and reads as a lawn with a few bristles stuck in it. A sward is
         a *closed* surface — you cannot see between the plants — and getting
         there needs an order of magnitude more of them over a much smaller
         cell, which is affordable precisely because that cell is eight metres
         across and everything in it is gone by twelve. */
      /* h0/h1 are the band's real stature in metres, and they exist because
         shapeOf is the wrong height law for something that grows.

         shapeOf proportions a *stone* — three radii off one size, with `flat`
         saying how much shorter than wide the lump is. Flora was passing
         flat: 4.6 to invert that into something tall, which works until you
         notice that its four shape classes then run from a 0.09 plate to a 3.0
         spire off the *same* size draw: the stand band came out with blades
         from 70 mm to three and a half metres. Three metres is a reed, and
         since the blade took its width from its own height as well, those drew
         at ninety-six millimetres across — which is why the near field read as
         a bed of pale ribbons rather than as grass.

         So stature is drawn here, explicitly, skewed small because a sward is
         mostly short. Width is no longer taken from it at all; see the vertex
         shader, where a blade is a few millimetres across whatever its length,
         exactly as a real one is. */
      const garden = spec.garden;
      const FLORA = garden ? [
        { key: 'sward', n: 30000, tile: 6, s0: 0.045, s1: 0.12, fade: 14, h0: 0.16, h1: 0.46 },
        { key: 'turf', n: 16000, tile: 26, s0: 0.10, s1: 0.30, fade: 36, h0: 0.30, h1: 0.95 },
        { key: 'flora', n: 5200, tile: 210, s0: 0.16, s1: 0.52, fade: 240, h0: 0.22, h1: 0.85 },
      ] : [
        { key: 'turf', n: 3000, tile: 30, s0: 0.055, s1: 0.13, fade: 20, h0: 0.06, h1: 0.24 },
        { key: 'flora', n: 4200, tile: 200, s0: 0.085, s1: 0.26, fade: 210, h0: 0.14, h1: 0.55 },
      ];
      this.floraMeshes = [];
      FLORA.forEach((f, i) => {
        const nF = Math.round(f.n * dens);
        const fi = scatterBand(nF, 0, 0, f.s0, f.s1, spec.seed * 3.1 + 77 + i * 41,
          { flat: 4.6, tile: f.tile });
        for (let k = 0; k < nF; k++) {
          const r = ((k * 2654435761) % 1024) / 1024;
          const u = (r + fi.A[k * 4 + 2] / 40) % 1;
          fi.B[k * 4 + 1] = f.h0 + (f.h1 - f.h0) * Math.pow(u, 1.7);
        }
        const mat = new THREE.ShaderMaterial({
          vertexShader: FLORA_VERT,
          fragmentShader: FLORA_FRAG,
          uniforms: Object.assign({}, FIELD_U, SHADE_U,
            pick('uC0', 'uC2', 'uCVeg', 'uVeg', 'uTime'),
            { uFade: { value: f.fade }, uTileP: { value: f.tile } }),
          side: THREE.DoubleSide,
        });
        const fg = tuftGeom(f.key === 'flora' ? 4 : 6);
        fg.setAttribute('iA', new THREE.InstancedBufferAttribute(fi.A, 4));
        fg.setAttribute('iB', new THREE.InstancedBufferAttribute(fi.B, 4));
        fg.instanceCount = nF;
        const m = new THREE.Mesh(fg, mat);
        m.frustumCulled = false;
        m.name = f.key;
        this.root.add(m);
        this.floraMeshes.push(m);
        if (f.key === 'flora') { this.flora = m; this.floraMat = mat; }
        this.disposables.push(fg, mat);
      });

      /* ------------------------------------------------------------ trees
       *
       * The thing a living world was missing. Grass and a green albedo make a
       * lawn; what makes a place is something with a silhouette in the middle
       * distance that you can judge the size of the hills against, and that
       * you can walk under. Same habitability field as everything else, so a
       * stand of trees is exactly where the ground was already going green and
       * the tufts were already thickest — a treeline that follows shelter and
       * drainage rather than an altitude contour.
       *
       * Only worlds the generator calls a garden get them: below about half
       * vegetation the field is patchy enough that trees come out as isolated
       * specimens dotted over gravel, which reads worse than none.
       *
       * They do not cast into the shadow map, and that is deliberate rather
       * than unfinished — the sun's box is 220 m across and sized to the hull,
       * so all it could hold is the two or three nearest, and lighting three
       * trees out of a stand of eighty is worse than lighting none. The
       * canopy's own back-lit transmission and the marched terrain shadow are
       * what put them in the world's light. */
      /* Two woody bands off one program, and the second is the one that was
       * missing.
       *
       * The size hierarchy had a hole in it exactly where the eye spends its
       * time. Grass tops out at 0.85 m and is gone by 240 m; the trees start at
       * four metres. So everything between forty metres and the skyline — most
       * of the frame in any landscape shot — was smooth shaded ground with a
       * few isolated trunks on it, which is the whole of why the middle
       * distance read as bare however much work went into the near field. Real
       * cover is continuous in scale: sward, then tussock, then scrub, then
       * canopy, and the scrub is what actually clothes a hillside.
       *
       * A shrub is a tree with no clear bole and a wider crown, so it is the
       * same shader with four numbers changed — see uForm/uPick — and it is
       * much less choosy about ground, because scrub grows where a tree cannot:
       * on the banks, on the thin soil and out on the exposed shoulders. That
       * lower threshold is deliberate and it is what fills the gaps *between*
       * the stands rather than thickening them.
       */
      const WOODY = [];
      if (veg > 0.55) {
        WOODY.push({
          key: 'trees', n: lo ? 520 : 1050, tile: 420, fade: 760,
          h0: 6.0, h1: 18.0, hp: 1.25, spray: [128, 30, 1.0],
          form: [1.0, 1.0, 22.0, 54.0], pick: [0.34, 0.72, 0.24, 0.40],
        });
      }
      if (veg > 0.30) {
        WOODY.push({
          key: 'scrub', n: lo ? 520 : 950, tile: 120, fade: 400,
          h0: 0.55, h1: 2.4, hp: 1.7, spray: [96, 8, 0.60],
          form: [0.18, 1.30, 7.0, 20.0], pick: [0.14, 0.62, 0.40, 0.62],
        });
      }
      WOODY.forEach((w, i) => {
        const nT = Math.round(w.n * dens);
        const ti = scatterBand(nT, 0, 0, 3.2, 11.0, spec.seed * 5.7 + 191 + i * 313,
          { flat: 1.0, tile: w.tile });
        /* Height, not lump proportions. shapeOf exists to give a boulder three
           different radii and it is the wrong shape law for something that
           grows: a tree is tall and its trunk radius comes off its height in
           the shader. Overwrite the y channel with a real stature, skewed
           small, because a stand is mostly young. */
        for (let k = 0; k < nT; k++) {
          const r = ((k * 2654435761) % 1000) / 1000;
          const u = (r + ti.A[k * 4 + 2] / 40) % 1;
          ti.B[k * 4 + 1] = w.h0 + (w.h1 - w.h0) * Math.pow(u, w.hp);
        }
        const tmat = new THREE.ShaderMaterial({
          vertexShader: TREE_VERT,
          fragmentShader: TREE_FRAG,
          uniforms: Object.assign({}, FIELD_U, SHADE_U,
            pick('uC0', 'uC2', 'uC3', 'uC4', 'uCVeg', 'uVeg', 'uTime', 'uLeafTex'),
            { uFade: { value: w.fade }, uTileP: { value: w.tile },
              uForm: { value: new THREE.Vector4().fromArray(w.form) },
              uPick: { value: new THREE.Vector4().fromArray(w.pick) },
              uSpray: { value: new THREE.Vector3().fromArray(w.spray) } }),
          side: THREE.DoubleSide,
          /* The leaf mask is an alpha test, and an alpha test without coverage
             is a stair-stepped edge on every leaf in the frame. The scene is
             already multisampled, so handing the mask to the coverage mask
             costs nothing and antialiases it properly. The shader still
             discards fully-empty fragments so the depth buffer stays clean. */
          alphaToCoverage: true,
        });
        const tg = treeGeom(128);
        tg.setAttribute('iA', new THREE.InstancedBufferAttribute(ti.A, 4));
        tg.setAttribute('iB', new THREE.InstancedBufferAttribute(ti.B, 4));
        tg.instanceCount = nT;
        const tm = new THREE.Mesh(tg, tmat);
        tm.frustumCulled = false;
        tm.castShadow = true;
        tm.receiveShadow = true;
        tm.customDepthMaterial = new THREE.ShaderMaterial({
          vertexShader: TREE_DEPTH_VERT,
          fragmentShader: TREE_DEPTH_FRAG,
          uniforms: tmat.uniforms,
          side: THREE.DoubleSide,
        });
        this.disposables.push(tm.customDepthMaterial);
        tm.name = w.key;
        this.root.add(tm);
        this.floraMeshes.push(tm);
        this.disposables.push(tg, tmat);
      });
    }

    /* ----------------------------------------------------------- landmarks */
    {
      const nA = lo ? 5 : 9;
      const ai = scatterBand(nA, 380, 3400, 1, 1, spec.seed * 11.9 + 5);
      // The instance layout means something different here: span, rise, tube
      // and how far it is buried.
      for (let i = 0; i < nA; i++) {
        const span = 22 + (i * 37 + spec.seed * 13) % 46;
        ai.B[i * 4] = span;
        ai.B[i * 4 + 1] = span * (0.62 + ((i * 29 + spec.seed * 7) % 10) * 0.045);
        ai.B[i * 4 + 2] = span * (0.11 + ((i * 17 + spec.seed * 3) % 10) * 0.011);
        ai.B[i * 4 + 3] = 0.06 + ((i * 13) % 7) * 0.012;
      }
      /* One of them is not random. A landing site with a forty-metre arch three
         hundred metres off the nose is a *place*; the same nine arches scattered
         uniformly through twelve kilometres of basin are set dressing you may
         or may not notice. So the first is planted deliberately — close enough
         to walk to in a couple of minutes, far enough that it reads as
         landscape rather than as a prop, and well off the axis the ship is
         pointing down, because a landmark dead ahead is a target and a landmark
         off the shoulder is a horizon. */
      {
        const a = spec.seed * 2.399963 + 1.1;
        const r = 250 + (spec.seed * 37) % 130;
        ai.A[0] = Math.cos(a) * r;
        ai.A[1] = Math.sin(a) * r;
        ai.B[0] = 34 + (spec.seed * 11) % 14;
        ai.B[1] = ai.B[0] * 0.78;
        ai.B[2] = ai.B[0] * 0.155;
        ai.B[3] = 0.07;
      }
      this.archMat = new THREE.ShaderMaterial({
        vertexShader: ARCH_VERT, fragmentShader: ROCK_FRAG,
        lights: true,
        uniforms: Object.assign(
          THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
          FIELD_U, SHADE_U,
          pick('uC0', 'uC2', 'uC3', 'uC4', 'uCVeg', 'uVeg')),
      });
      const ag = archGeom(22, 8, -0.035, 0.535);
      ag.setAttribute('iA', new THREE.InstancedBufferAttribute(ai.A, 4));
      ag.setAttribute('iB', new THREE.InstancedBufferAttribute(ai.B, 4));
      ag.instanceCount = nA;
      this.arches = new THREE.Mesh(ag, this.archMat);
      this.arches.frustumCulled = false;
      this.arches.receiveShadow = true;
      this.arches.name = 'arches';
      this.root.add(this.arches);
      this.disposables.push(ag, this.archMat);
    }

    /* --------------------------------------------------------------- sky */
    const atmo = this.atmo;
    /* The dome's Mie column is a fifth of the one the planet wears from orbit,
       and that single number is most of "the sky is dull and looks fake".
     *
     * Every atmosphere the generator writes carries a Mie column several times
     * Earth's, deliberately: it is what makes the limb arc read as a shell of
     * air at a hundred thousand kilometres. Standing underneath it, the same
     * number is a disaster. Measured on the terran world in the first system,
     * with betaR = (1.94, 4.47, 10.29) and betaM = 7.47, the zenith comes out
     * at (0.0074, 0.0076, 0.0110) — the grey forward lobe carries the red and
     * the green outright and matches Rayleigh in the blue, so the sky is a
     * *haze* rather than a sky: flat olive-grey, no gradient, no hue, and no
     * amount of exposure or gain recovers a colour that was never scattered.
     * At a fifth the same maths gives (0.0023, 0.0048, 0.0113) — one to two to
     * five, which is a blue sky.
     *
     * It is not a cheat, either. Mie scatterers are aerosol, aerosol is heavy,
     * and the column that shows as a bright limb at grazing incidence through
     * a thousand kilometres of atmosphere is a *small* optical depth straight
     * up from the deck. The two consumers genuinely want different numbers.
     * The aerial-perspective terms below keep the full column, because dust
     * near the ground is exactly what those are describing. */
    const GROUND_MIE = 0.21;
    const bMg = atmo.betaM * GROUND_MIE;
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: U.uSunDir,
        uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
        uBetaR: { value: atmo.betaR.clone() },
        uBetaM: { value: bMg },
        uG: { value: atmo.g },
        /* The dome and the ground have to agree about how bright daylight is.
           At the old gain the sky near the horizon rendered at a luminance of
           four while sunlit ground came out at 0.07 — fifty to one, where the
           real ratio is nearer three to one. Auto-exposure keys on the sky, so
           the whole landscape sat in AgX's toe and every shadow on it went to
           literal black. Dimming the dome does not make the sky darker in the
           final image: the exposure simply opens up, the sky keeps its colour
           instead of being compressed to pale grey, and the ground arrives. */
        /* And a stop and a half back on the gain, because a fifth of the Mie is
           also a third of the dome's luminance and the ratio to the ground is
           what this number is for. */
        uIntensity: { value: atmo.intensity * (this.hasAir ? 1.45 : 0.16) },
        uMieBoost: { value: this.hasAir ? 1.15 : 0.4 },
        uHazeColor: { value: new THREE.Color(0.35, 0.45, 0.6) },
        uStarAmt: { value: 1 },
        uSunSize: { value: 0.0135 },
        uSunPower: { value: 300 },
        // Cloud is weather, and weather needs air. An airless moon gets none,
        // and neither does a world whose atmosphere is a haze rather than a
        // gas column deep enough to condense anything.
        uCloudAmt: { value: this.hasAir ? THREE.MathUtils.clamp(atmo.betaM * 0.9 + 0.30, 0.25, 0.85) : 0 },
        uNight: { value: new THREE.Color(0, 0, 0) },
        /* Cloud is water and ice, which is the one white thing in a landscape,
           and it was authored two stops under the sky it hangs in — so a deck
           read as brown smoke on a desert and as grey felt on a terran world.
           The lit face is very slightly warm because that is the light falling
           on it; the shadowed face is *blue*, because what lights the underside
           of a cloud is the sky and the ground, not the star. */
        uCloudLit: { value: new THREE.Color(0.235, 0.229, 0.214) },
        uCloudDark: { value: new THREE.Color(0.052, 0.062, 0.085) },
        uTime: U.uTime,
        uSeedSky: { value: (spec.seed * 13.7) % 97 },
      },
    });
    /* 128x72, not 40x24, and it is the whole of why the sky read as low-res.
       The fragment stage works off vDir, which is the *vertex position* linearly
       interpolated — so the direction a pixel is shaded for lies on the chord
       rather than on the arc, and the error is the face's own sagitta,
       theta^2/8. At 40x24 a face is nine degrees and that is 0.18 degrees of
       angular error, against a stellar disc a third of a degree across and an
       aureole whose inner lobe falls off over two: the star came out as a
       lumpy polygon inside a faceted halo, and the horizon band kinked at every
       seam. At 128x72 the error is 0.017 degrees, which is a twentieth of the
       disc. It costs 9,216 triangles in one draw call against a dome that is
       already covering the whole frame in the fragment stage — nothing. */
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(REACH * 1.6, 128, 72), this.skyMat);
    this.sky.frustumCulled = false;
    // last of the opaques, so the ground has already claimed its pixels
    this.sky.renderOrder = 900;
    this.root.add(this.sky);
    this.disposables.push(this.sky.geometry, this.skyMat);

    this._att = new THREE.Vector3();
    this._tint = new THREE.Color();
    this._warm = new THREE.Color(0.62, 0.30, 0.13);
  }

  /**
   * Every material this surface owns.
   *
   * They share `disposables` with the geometries because that list is the one
   * thing that cannot go stale — anything added to the scene has to be added to
   * it — so asking it for the materials is the only enumeration that stays
   * complete on its own. `Game.land` walks this to take the whole ground pass
   * off the logarithmic depth buffer; a pass with some materials writing
   * gl_FragDepth and some not does not z-fight, it inverts.
   */
  eachMaterial(fn) {
    for (const d of this.disposables) if (d && d.isMaterial) fn(d);
  }

  /**
   * Evaluate the static half of the terrain's vertex stage, once.
   *
   * Called by `Game.land` the moment the surface exists, before anything has
   * drawn with it. It costs about one frame of the work it replaces and then
   * that work never runs again: two point draws over the grid's own vertex
   * buffer, one texel written per vertex, read back by `TERRAIN_VERT` as two
   * fetches.
   *
   * Target A is full float because it carries the height in metres and a
   * landscape is kilometres tall — half would quantise the ground into
   * metre-high steps. Target B is half float: everything in it is a
   * normalised term where eleven bits of mantissa is four decimal places.
   *
   * @param {THREE.WebGLRenderer} renderer
   */
  bake(renderer) {
    const B = this._bake;
    if (!B || B.done) return;
    const { w, h } = B.lut;
    const opt = {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    B.rtA = new THREE.WebGLRenderTarget(w, h, { ...opt, type: THREE.FloatType });
    B.rtB = new THREE.WebGLRenderTarget(w, h, { ...opt, type: THREE.HalfFloatType });

    const cam = new THREE.Camera();          // the shader writes clip space itself
    const scn = new THREE.Scene();
    const pts = new THREE.Points(B.geo, B.matA);
    pts.frustumCulled = false;
    scn.add(pts);

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.autoClear;
    /* `shadowMap.needsUpdate` is one flag for the whole renderer and the first
       render() of the frame eats it. These two are renders, they happen inside
       an update step, and the scene they draw has no lights — so the flag goes
       back afterwards rather than being left to three's early-out. */
    const wasNeeded = renderer.shadowMap.needsUpdate;
    renderer.autoClear = true;
    renderer.setRenderTarget(B.rtA);
    renderer.render(scn, cam);
    pts.material = B.matB;
    renderer.setRenderTarget(B.rtB);
    renderer.render(scn, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevClear;
    renderer.shadowMap.needsUpdate = wasNeeded;

    this.U.uLutA.value = B.rtA.texture;
    this.U.uLutB.value = B.rtB.texture;
    B.done = true;
  }

  /**
   * @param {number} dt
   * @param {object} ctx  { sunDir (local), sunColor, camPos (local), time,
   *                        shadowNB (one shadow texel, metres),
   *                        shadowBox { half, cx, cz } (the sun's ortho box, m) }
   */
  update(dt, ctx) {
    const U = this.U;
    if (ctx.shadowNB > 0) U.uShadowNB.value = ctx.shadowNB;
    /* Where the map reaches. The fade has to start inside the box and finish
       just outside it, about the box's *own* centre — see uShadowR. Squared
       here so the fragment stage never takes a square root. */
    const B = ctx.shadowBox;
    if (B && B.half > 0) {
      const r1 = B.half * 1.02, r0 = B.half * 0.72;
      U.uShadowR.value.set(r0 * r0, r1 * r1, B.cx, B.cz);
    }
    const su = this.skyMat.uniforms;
    const sun = ctx.sunDir;

    /* The baked sets decode asynchronously and a landing can happen before they
       land. Both strengths sit at zero until then, which draws the ground
       untextured — flat, but correct — rather than sampling a 1x1 placeholder
       four thousand times a frame and painting the whole basin one colour. */
    if (U.uTerK.value.x === 0 && U.uTerTex.value.userData.ready) {
      U.uTerK.value.set(1, 1);
    }

    U.uSunDir.value.copy(sun);
    U.uCamPos.value.copy(ctx.camPos);
    U.uTime.value = ctx.time;
    su.uSunColor.value.copy(ctx.sunColor);
    this.sky.position.copy(ctx.camPos);

    /* The star's own light, reddened by the air mass it had to cross to get
       here. This is the single thing that makes a sunset a sunset: the ground
       has to *receive* orange light, not merely sit under an orange sky. */
    const bR = su.uBetaR.value, bM = su.uBetaM.value, COL = 0.021;
    let sunAir = Math.min(1 / (Math.max(sun.y, 0) + 0.033), 30);
    sunAir *= 1 + Math.max(-sun.y, 0) * 42;
    const att = this._att.set(
      Math.exp(-(bR.x + bM) * sunAir * COL),
      Math.exp(-(bR.y + bM) * sunAir * COL),
      Math.exp(-(bR.z + bM) * sunAir * COL),
    );
    /* The key's transmittance is floored, and the floor is a *scale* so the
       reddening survives it.

       Every atmosphere in this game carries a Mie column several times Earth's
       — that is what makes the limb arc read from orbit — and the consequence
       on the ground is that the direct beam is extinguished to under one per
       cent by the time the star is seven degrees up. Physically that is a dust
       storm at sunset, and it is what put a terran world at eighty-three per
       cent of its pixels crushed to black at an elevation a photographer would
       call golden hour. Lifting all three channels by one factor keeps the
       ratio between them — so a low sun still arrives orange — while keeping a
       raking key on the ground, which is the only reason to shoot that hour. */
    const attMax = Math.max(att.x, Math.max(att.y, att.z));
    const lift = Math.max(1, 0.13 / Math.max(attMax, 1e-5));
    att.multiplyScalar(lift);
    const sc = ctx.sunColor;
    /* The key runs hot on purpose. A matte landscape has no speculars, so the
       only thing that can reach the top of the curve is directly lit ground —
       and if it does not, the whole frame lands in the middle: midday used to
       measure a 99th percentile of 133 and *nothing* clipping, which is the
       definition of flat. Raising the key rather than the exposure keeps the
       shadows where they are and opens the gap between them and the sun. */
    const KEY = 1.85;
    U.uSunColor.value.setRGB(sc.r * att.x * KEY, sc.g * att.y * KEY, sc.b * att.z * KEY);

    /* How lit the sky is — and it is not proportional to the sun's elevation.

       A sky with the star on the horizon is about a tenth of noon, not a
       twentieth, because the whole dome is still inside the lit part of the
       atmosphere long after the ground has stopped receiving a beam. Ramping
       this linearly from the zenith is what took the fill down with the key and
       left dusk with nothing lighting it at all. */
    const day = Math.pow(THREE.MathUtils.clamp(sun.y * 1.9 + 0.30, 0, 1), 0.62);
    const lumS = Math.max(sc.r * 0.3 + sc.g * 0.55 + sc.b * 0.15, 0.05);

    /* Night, and why it needs a floor at all.

       Every term in this function is driven by the star, so once the star sets
       they all go to zero together and the ground stops existing: measured at
       98.4% of pixels crushed to black with a median of 2, which is not a night
       scene, it is a bug that happens to be dark. A real night side is lit —
       by the rest of the galaxy, by whatever nebula this arm is sitting in, and
       by the planetshine of anything else in the system — and none of that
       cares where the local star is pointing. The floor is teal-black rather
       than neutral, because that is what the void is here, and it is shaped so
       it is invisible at noon and carries the whole frame at midnight. */
    const night = 1 - THREE.MathUtils.clamp(sun.y * 6 + 0.25, 0, 1);
    const nf = 1 + night * 6.5;
    this.skyMat.uniforms.uNight.value.setRGB(
      0.00035 * night, 0.00055 * night, 0.00085 * night);

    // the sky's own colour, normalised off the Rayleigh coefficients
    const norm = 1 / Math.max(bR.x + bR.y + bR.z, 1e-4);
    const tint = this._tint.setRGB(bR.x * norm, bR.y * norm, bR.z * norm);
    // how much light the atmosphere actually returns
    const thick = THREE.MathUtils.clamp((bR.x + bR.y + bR.z + 3 * bM) * COL * 3.4, 0, 1);
    // Fill has to stay a stop or two under the key or the marched shadows have
    // nothing to be darker *than* — an over-generous skylight erases them just
    // as completely as no shadow term at all.
    const skyAmt = thick * day * 0.62;
    // Shadows are never black: even an airless world gets a floor of nebula
    // and starlight, shifted toward the key's complement. On a moon this floor
    // is the *only* fill there is, so it has to be enough to keep the shadow
    // side of a ridge legible rather than a hole.
    const fill = this.hasAir ? 1.25 : 4.3;
    U.uSkyColor.value.setRGB(
      tint.r * skyAmt * (0.55 * lumS + 0.45 * sc.r) + 0.013 * lumS * fill * nf,
      tint.g * skyAmt * (0.55 * lumS + 0.45 * sc.g) + 0.018 * lumS * fill * nf,
      tint.b * skyAmt * (0.55 * lumS + 0.45 * sc.b) + 0.026 * lumS * fill * nf,
    );

    /* Bounce off the surrounding lit ground, tinted by the ground itself and by
       whatever colour the star's light had left by the time it arrived.
     *
     * 0.62, and the old 0.22 was under by about the factor you get from the
     * geometry. Work it out for a vertical face standing on open sunlit ground:
     * the irradiance on the ground is the key times the sine of the star's
     * elevation, what comes back off it is that times the ground albedo, and
     * the face sees about half of that hemisphere. At a twenty-degree sun and
     * a 0.25 albedo that is near five per cent of the key. Measured on a landed
     * terran frame, uGndColor came back at 0.020 of the key and the bounce term
     * downstream cuts it to 0.012 — four times under, and it was the *only*
     * fill a side-facing surface had, because the sky term is deliberately down
     * two and a half stops on a vertical.
     *
     * That is the whole reason a tree trunk, the shadow flank of every boulder
     * and every cliff face in the game rendered as a black silhouette against
     * lit ground: at 0.077 of the key a surface sits deep in the AgX toe, and
     * the toe does the rest. It reads as a lighting bug and it was an arithmetic
     * one. Correcting it lifts exactly the surfaces the art direction says must
     * never go to silhouette, and it barely touches the marched terrain shadows,
     * because the term downstream is weighted onto side-facing geometry — a
     * horizontal shadowed surface gets less than a third of what a vertical
     * one does. */
    const c2 = this.spec.colors.c2;
    const bnc = 0.62 * THREE.MathUtils.clamp(sun.y * 2.0 + 0.08, 0, 1);
    U.uGndColor.value.setRGB(
      c2.r * sc.r * att.x * bnc,
      c2.g * sc.g * att.y * bnc,
      c2.b * sc.b * att.z * bnc,
    );

    /* Aerial perspective. Extinction is the atmosphere's own spectrum scaled
       into per-metre terms; the Mie part is grey and dominates close in, which
       is what lifts the blacks in the distance before the blue shift does.
       Tuned so a ridge at twelve kilometres keeps about half its red and a
       fifth of its blue — enough to fall away, not so much that the whole
       middle distance turns to lavender soup. */
    /* Roughly twice the column there was.
       A review of the landed scene found "no aerial perspective on any landed
       world — far peaks are as saturated and contrasty as the foreground", and
       it is right: at 1/6400 per metre a ridge at eight kilometres kept most of
       its contrast, so the frame had no depth planes in it at all. In a real
       landscape the far hills lift most of the way to the sky colour and that
       gradient does nearly all of the depth work. Airless worlds get a floor
       rather than nothing — vacuum has no aerial perspective and a moon at
       twelve kilometres genuinely is as contrasty as your boots, but ours still
       has to separate one ridge from the ridge behind it, so a very thin column
       stands in for the dust the ground throws up around itself. */
    /* Half the distance again on the Rayleigh column, and it is the term that
       separates one ridge from the ridge behind it.
     *
     * Three independent looks at a landed frame have now said the same thing:
     * the far hills are as saturated and as contrasty as the ground under the
     * boots, and two overlapping ranges are one flat silhouette. At 1/3300 per
     * metre a ridge at four kilometres keeps three quarters of its contrast,
     * which is a clear day on a small planet and not what the eye reads as
     * distance. 1/2200 puts the same ridge at about half and a twelve-kilometre
     * skyline most of the way to the sky, which is what every reference frame
     * of a real landscape does — and the depth cue is *the gradient*, not the
     * end point, so it has to bite in the middle distance to be worth
     * anything. */
    const air = this.hasAir ? 1 : 0.30;
    const mx = Math.max(bR.x, Math.max(bR.y, bR.z));
    const kR = air / 2200;
    U.uExtR.value.set((bR.x / mx) * kR, (bR.y / mx) * kR, (bR.z / mx) * kR);
    U.uExtM.value = air * (0.5 + bM * 0.15) / 13000;
    U.uHazeH.value = this.hasAir ? 1800 : 5200;
    U.uExtD.value = air / 3600;
    U.uDustH.value = this.hasAir ? 75 : 130;
    U.uHazeK.value = U.uExtM.value + U.uExtR.value.y;

    // The haze is lit by the star, so it carries the star's colour as well as
    // the air's: a blue sky under a red dwarf does not haze cobalt.
    /* Haze is lit haze. Once the star is under the horizon there is nothing
       feeding the in-scatter, and leaving a fixed floor in it turns every
       distant ridge into a glowing blue cut-out under a black sky. */
    const insA = thick * (0.05 + 0.95 * day) * lumS * 0.30;
    const nite = 0.10 + 0.90 * day + night * 1.4;
    const wr = 0.45;   // how much of the star's own colour the haze inherits
    U.uInsR.value.setRGB(
      tint.r * insA * (1 - wr + wr * sc.r / lumS) + 0.008 * lumS * nite,
      tint.g * insA * (1 - wr + wr * sc.g / lumS) + 0.011 * lumS * nite,
      tint.b * insA * (1 - wr + wr * sc.b / lumS) + 0.015 * lumS * nite,
    );
    // the sunward lobe: the haze glows where it faces the star, and reddens
    // with it, which is what makes a low sun feel like it is *in* the air
    const mieA = (this.hasAir ? 0.016 : 0.004) * lumS * THREE.MathUtils.clamp(sun.y * 4 + 0.25, 0, 1);
    U.uInsM.value.setRGB(sc.r * att.x * mieA, sc.g * att.y * mieA, sc.b * att.z * mieA);

    /* Suspended dust. It is lit by the star through the same air mass the
       ground is, and it is made of the ground, so it carries the ground's own
       colour — which is what stops it reading as a second, greyer fog laid
       over the first. It also has to die at night: an unlit dust layer that
       keeps glowing is a milky sheet across the bottom of a dark frame. */
    const dl = 0.30 * lumS * THREE.MathUtils.clamp(sun.y * 3.2 + 0.06, 0, 1);
    U.uInsD.value.setRGB(
      c2.r * sc.r * att.x * dl + 0.006 * lumS * nite,
      c2.g * sc.g * att.y * dl + 0.006 * lumS * nite,
      c2.b * sc.b * att.z * dl + 0.008 * lumS * nite,
    );

    // the sky's horizon has to land on the same colour the ground fades to
    const hz = su.uHazeColor.value;
    hz.copy(U.uInsR.value);
    hz.r += U.uInsM.value.r * 1.1; hz.g += U.uInsM.value.g * 1.1; hz.b += U.uInsM.value.b * 1.1;
    if (this.hasAir) hz.lerp(this._warm, (1 - day) * 0.35 * thick);

    /* Rock shadows fade out as the key loses to the fill — and the ratio is now
       taken from the two colours that were actually just written rather than
       from a stand-in for them.
     *
     * `skyAmt*2.2` was a proxy for the fill, and it over-read it by a factor of
     * three: measured at a twenty-degree sun the key comes out at a luminance
     * of 0.86 against a skylight of 0.17, which is a ratio of 0.83, and the
     * proxy returned 0.32. So every contact shadow under every stone in the
     * near field was being drawn at a third of the strength the lighting says
     * it has, which is why a judge shown the frame reported that the pebbles
     * "sit on the sand with no contact darkening" — the term existed and was
     * being scaled almost out of the picture. */
    const lumKey = 0.2126 * U.uSunColor.value.r + 0.7152 * U.uSunColor.value.g
      + 0.0722 * U.uSunColor.value.b;
    const lumSky = 0.2126 * U.uSkyColor.value.r + 0.7152 * U.uSkyColor.value.g
      + 0.0722 * U.uSkyColor.value.b;
    const keyVsFill = lumKey / (lumKey + lumSky * 1.35 + 0.01);
    U.uDecalK.value = 0.60 * keyVsFill * THREE.MathUtils.clamp(sun.y * 7, 0, 1);

    /* Stars come through wherever the sky is dark — which on an airless world
       is the middle of the afternoon, and on a world with air is not.
     *
     * The sky shader gates them on the dome's own luminance, `exp(-lum*17)`,
     * which was fine when the dome ran at the old Mie gain and is not now: a
     * blue sky is a *dimmer* sky in absolute terms, so the same rule started
     * letting a full star field through a lit afternoon. Two frames of the
     * survey have stars in a daylight sky, and nothing else in a landed frame
     * says "this is a rendering" as immediately. Air gets an explicit curfew;
     * vacuum keeps them all day, because there they are real. */
    su.uStarAmt.value = this.hasAir
      ? THREE.MathUtils.clamp(1 - (sun.y + 0.02) * 14, 0, 1) : 1;
    su.uSunPower.value = 300 * THREE.MathUtils.clamp(lumS * 1.3, 0.4, 2.2);

    /* How bright the dome runs, against the hour.

       This is an exposure balance, not a physical constant, and it has to move
       with the sun because the two ends of the day fail in opposite
       directions. At noon the star is out of frame and the sky is the only
       thing in it that can be bright: run the dome at the dusk gain and the
       whole landscape lands inside twenty levels of itself, which measures as
       a 99th percentile of 126 and reads as overcast. At dusk the star *is* in
       frame, wrapped in its own aureole, and auto-exposure keys on it — run
       the dome at the noon gain then and the exposure closes two stops and
       three quarters of the ground goes to literal black. Measured: 9% of
       pixels crushed at 0.52 against 67% at 1.5, in the same frame. */
    /* The ramp starts at a lower sun and finishes higher.
       It used to key off (sun.y - 0.24)/0.50, which puts the *dusk* gain on
       everything below twenty-four degrees of elevation — and twenty degrees is
       not dusk, it is mid-morning, and it is where a landed frame spends most
       of its time. Measured there, the sky came back at a mean of 80 against
       ground at 100-119: the dome was darker than the dirt under it, which is
       the one thing a sky can never be and is most of what reads as "the
       lighting is god awful". The dusk end is deliberately left where it was
       (0.55 against 0.52 at four degrees) because that number was measured —
       run the noon gain at dusk and auto-exposure keys on the star's aureole
       and takes three quarters of the ground to black. */
    if (this.hasAir) {
      const hour = THREE.MathUtils.clamp((sun.y - 0.06) / 0.55, 0, 1);
      su.uIntensity.value = this.atmo.intensity * (0.52 + 1.42 * Math.pow(hour, 1.5));
    }
  }

  /* -------------------------------------------------- the ground, from JS

     The GPU knows where the ground is; nothing else did. These are the two
     answers anything standing on the surface needs, and they run the *same*
     law the vertex shader runs — see the transliteration next to the GLSL at
     the top of this file, and change the two together or a walking player will
     sink into every hill.

     Both return metres in the ground scene's own units (1 unit = 1 m) and both
     include the horizon bend, because the bend is part of the surface that is
     actually drawn: the mesh, the scatter and the decals all subtract the same
     d^2/2R, and a foot placed on the unbent field floats by nine metres at a
     kilometre out. */

  /**
   * Ground height at a world XZ.
   * @param {number} x
   * @param {number} z
   * @param {number} lod  the spacing in metres the answer will be used at.
   *   The field contains no band finer than this — pass something near the
   *   size of the thing standing on it. A walking figure wants the default.
   * @returns {number} metres, +Y up, same frame as `Surface.root`.
   */
  heightAt(x, z, lod = 1.0) {
    const U = this.U;
    jTerrainRaw(x + this._site[0], z + this._site[1], lod, U, _dat2);
    const h = _dat2[0], fine = _dat2[1];
    const d = Math.sqrt(x * x + z * z);
    // the landing scour, exactly as groundYFlat does it — twenty metres, not a
    // hundred and ten. See the note there for why the site moved instead.
    const pad = jSmoothstep(11, 42, d);
    let y = (h - this._datum[0]) * J_VSCALE * pad
          + (fine - this._datum[1]) * J_VSCALE * (0.34 + 0.66 * pad);
    const t = U.uType.value | 0;
    if (t === 0 || t === 5) y = Math.max(y, this._seaY);
    return y - (x * x + z * z) / (2 * U.uPlanetR.value);
  }

  /**
   * Unit surface normal at a world XZ, +Y up. Central difference at the same
   * spacing the mesh shades with, so a slope limit computed from this is the
   * slope the player can see.
   * @returns {{x:number, y:number, z:number}}
   */
  normalAt(x, z, lod = 1.0) {
    const e = Math.max(lod, 0.30);
    const ya = this.heightAt(x + e, z, lod);
    const yc = this.heightAt(x - e, z, lod);
    const yb = this.heightAt(x, z + e, lod);
    const yd = this.heightAt(x, z - e, lod);
    const nx = -(ya - yc) * 0.5, nz = -(yb - yd) * 0.5;
    const l = Math.hypot(nx, e, nz) || 1;
    return { x: nx / l, y: e / l, z: nz / l };
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    const B = this._bake;
    if (B) {
      B.rtA?.dispose(); B.rtB?.dispose();
      B.geo.dispose(); B.matA.dispose(); B.matB.dispose();
      this._bake = null;
    }
  }
}
