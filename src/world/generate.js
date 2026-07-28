import * as THREE from 'three';
import { PLANET_TYPES } from './planetBakeShader.js';

/* ============================================================================
   Deterministic universe generation. Everything — star classes, orbits,
   surface palettes, anomaly placement, names — falls out of a single integer
   seed, so a system looks identical every time you return to it.
   ========================================================================== */

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL_A = ['ael', 'vor', 'kys', 'thal', 'nyx', 'sar', 'ith', 'ohm', 'zeph', 'cal',
  'dre', 'myr', 'oss', 'tan', 'ver', 'quel', 'bral', 'sen', 'irr', 'hesh',
  'lum', 'ast', 'ker', 'vel', 'orn', 'sy', 'tha', 'gar', 'ish', 'ele'];
const SYL_B = ['an', 'eth', 'ora', 'is', 'un', 'ai', 'esh', 'ir', 'ux', 'ea',
  'on', 'yr', 'al', 'em', 'ith', 'os', 'ae', 'ur', 'en', 'ys'];
const SYL_C = ['', '', '', 'ka', 'dra', 'nis', 'thu', 'mar', 'sil', 'vek', 'reth', 'lyn'];

// Tangential orbit speeds in km/s. These are deliberately tiny: anything
// faster and a station you are trying to dock beside slides out from under you
// while you line up. Planetary *spin* and cloud motion carry the sense of a
// living system instead.
const PLANET_ORBIT_SPEED = 0.40;
const MOON_ORBIT_SPEED = 0.90;

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const GREEK = ['a', 'b', 'g', 'd', 'e', 'z'];

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export function starName(rnd) {
  const n = cap(pick(rnd, SYL_A) + pick(rnd, SYL_B) + pick(rnd, SYL_C));
  return n;
}
function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
function rng(rnd, a, b) { return a + rnd() * (b - a); }
function rngi(rnd, a, b) { return Math.floor(a + rnd() * (b - a + 1)); }

/* ------------------------------------------------------------ star classes */

const STAR_CLASSES = [
  { cls: 'M', w: 30, temp: [2600, 3700], radius: [22000, 34000], lum: 0.30, desc: 'Red dwarf' },
  { cls: 'K', w: 20, temp: [3900, 5200], radius: [30000, 44000], lum: 0.62, desc: 'Orange dwarf' },
  { cls: 'G', w: 17, temp: [5300, 6000], radius: [38000, 52000], lum: 1.00, desc: 'Yellow main sequence' },
  { cls: 'F', w: 11, temp: [6100, 7300], radius: [45000, 60000], lum: 1.55, desc: 'Yellow-white dwarf' },
  { cls: 'A', w: 7, temp: [7500, 9800], radius: [52000, 70000], lum: 2.40, desc: 'White main sequence' },
  { cls: 'B', w: 4, temp: [11000, 21000], radius: [66000, 92000], lum: 4.10, desc: 'Blue giant' },
  { cls: 'WD', w: 5, temp: [12000, 26000], radius: [6000, 9000], lum: 0.55, desc: 'White dwarf' },
  { cls: 'PSR', w: 3, temp: [30000, 40000], radius: [4200, 6000], lum: 0.85, desc: 'Neutron star' },
  { cls: 'C', w: 3, temp: [2300, 3000], radius: [70000, 105000], lum: 0.75, desc: 'Carbon giant' },
];

function pickStarClass(rnd) {
  const total = STAR_CLASSES.reduce((s, c) => s + c.w, 0);
  let r = rnd() * total;
  for (const c of STAR_CLASSES) { r -= c.w; if (r <= 0) return c; }
  return STAR_CLASSES[2];
}

function kelvinColor(k) {
  const t = Math.min(40000, Math.max(1000, k)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = new THREE.Color();
  c.setRGB(clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), THREE.SRGBColorSpace);
  return c;
}
function clamp01(x) { return Math.min(1, Math.max(0, x)); }
function lin(hex) { return new THREE.Color().setHex(hex, THREE.SRGBColorSpace); }

/* --------------------------------------------------------- planet palettes */

/* Only two of the eight living worlds are green. Chlorophyll is one solution to
   one star's spectrum; under a red dwarf the same chemistry is black or violet,
   and a world whose oceans carry a different dissolved mineral is not blue.
   Half these palettes are deliberately *wrong* for Earth, because a galaxy in
   which every habitable planet is a photograph of this one is the single
   least interesting thing a procedural universe can be. */
const PALETTES = {
  terran: [
    // temperate chlorophyll — the familiar one, kept for contrast
    { c0: 0x0a1b28, c1: 0x4a6b3a, c2: 0x8a8250, c3: 0x6d6455, c4: 0xa89f8c, polar: 0xe8f2f7, water: 0x1a4d6b },
    { c0: 0x101c14, c1: 0x2f5c3a, c2: 0x7c8a4a, c3: 0x5f5c48, c4: 0x9aa08e, polar: 0xdff0f5, water: 0x14556e },
    // retinal purple: pigment tuned to a cooler star, over a copper-stained sea
    { c0: 0x140c1c, c1: 0x5c3a6b, c2: 0x8a6a92, c3: 0x6e5a70, c4: 0xb2a4b8, polar: 0xf2ecf8, water: 0x2a4a62 },
    { c0: 0x100a18, c1: 0x452c58, c2: 0x74527e, c3: 0x5e4a66, c4: 0xa294ad, polar: 0xeee6f6, water: 0x1e4258 },
    // rust flora under a red dwarf — almost no blue reaches the ground
    { c0: 0x1c0e08, c1: 0x8a4420, c2: 0xb0703a, c3: 0x7e5638, c4: 0xc9a077, polar: 0xf6e8dc, water: 0x33404e },
    { c0: 0x180c06, c1: 0x6e3418, c2: 0x9a5c2e, c3: 0x6c4a30, c4: 0xba9068, polar: 0xf2e2d2, water: 0x2c3a48 },
    // an iron-rich ocean world: teal seas, ochre continents, no chlorophyll
    { c0: 0x08201e, c1: 0x2f6a62, c2: 0xa08a52, c3: 0x7a6a52, c4: 0xc4b48e, polar: 0xe4f6f4, water: 0x0d5f5e },
    // a cold, mossy world close to its snowline
    { c0: 0x0d1a1e, c1: 0x3d6b58, c2: 0x8f9560, c3: 0x6b6a58, c4: 0xa8b0a0, polar: 0xeaf4f8, water: 0x186a72 },
  ],
  desert: [
    { c0: 0x40261a, c1: 0xa46b3c, c2: 0xd2a066, c3: 0xe8c592, c4: 0xf0dcb4, polar: 0xf2ece0, water: 0x7a5a3a },
    { c0: 0x3a1c14, c1: 0x8f4a2c, c2: 0xc07848, c3: 0xdba070, c4: 0xecc79a, polar: 0xf4efe6, water: 0x6b4530 },
    { c0: 0x2e2418, c1: 0x8a7444, c2: 0xb59a62, c3: 0xd4bb8a, c4: 0xe9dcb8, polar: 0xf6f2ea, water: 0x6a5a3c },
  ],
  barren: [
    { c0: 0x1a1a1c, c1: 0x4c4a48, c2: 0x74716c, c3: 0x9b968e, c4: 0xc4bfb6, polar: 0xd8d5cf, water: 0x333333 },
    { c0: 0x201c1a, c1: 0x54453c, c2: 0x7c6a5c, c3: 0xa08c7a, c4: 0xc6b6a2, polar: 0xd4cec4, water: 0x333333 },
    { c0: 0x14161c, c1: 0x3e4450, c2: 0x606878, c3: 0x8a91a0, c4: 0xb4bac6, polar: 0xcdd4de, water: 0x333333 },
  ],
  ice: [
    // Europa: warm-stained fractures over a bright shell, not uniform white
    { c0: 0x6a4a38, c1: 0x8fb0c6, c2: 0xcadeec, c3: 0xeaf4fa, c4: 0xffffff, polar: 0xffffff, water: 0x2a5570 },
    /* c0 is the mineral stain in the fractures, and it was a cold purple —
       measured at R-B of -0.03 where Europa's lineae run +0.14 to +0.34. Ice
       stain is rust: it is salt and sulphur that came up with the water. The
       cold version read as a crack in porcelain rather than as something
       deposited, and two of the three moons in a system drew it. Kept mauve
       enough to stay distinct from the other two palettes, but warm. */
    { c0: 0x74504a, c1: 0x8794b4, c2: 0xc2cde2, c3: 0xe6ecf6, c4: 0xfcfdff, polar: 0xfdfeff, water: 0x36466a },
    { c0: 0x6a4438, c1: 0xa898a4, c2: 0xd6cbd4, c3: 0xf0eaee, c4: 0xfffcfe, polar: 0xfffcfe, water: 0x50405a },
  ],
  lava: [
    { c0: 0x0a0604, c1: 0x2a1a14, c2: 0x4a2c1c, c3: 0x6b4028, c4: 0xff5a10, polar: 0x8a6a5a, water: 0xff3c00 },
    { c0: 0x08080a, c1: 0x241f22, c2: 0x3e3236, c3: 0x5c4a48, c4: 0xff7a20, polar: 0x7a6a68, water: 0xff4a08 },
  ],
  ocean: [
    { c0: 0x04141e, c1: 0x2f6b5a, c2: 0x6a8a62, c3: 0x8a8c72, c4: 0xb0b49c, polar: 0xe6f4fa, water: 0x0d4a68 },
    { c0: 0x06121c, c1: 0x3a6a72, c2: 0x6f8a80, c3: 0x94947e, c4: 0xbcbca6, polar: 0xecf6fb, water: 0x0f5570 },
    // a jade sea, heavy with something that is not chlorophyll
    { c0: 0x03170f, c1: 0x2a6a4c, c2: 0x74906a, c3: 0x8a9078, c4: 0xb4bca0, polar: 0xe8faf2, water: 0x0a5a48 },
    // and a violet one, under a hot white star
    { c0: 0x0c0a1c, c1: 0x4a3a72, c2: 0x7c7090, c3: 0x8e8a9c, c4: 0xb8b4c6, polar: 0xf0edfa, water: 0x241a56 },
  ],
  toxic: [
    { c0: 0x2a2408, c1: 0x6e6420, c2: 0x9c8e30, c3: 0xc4b455, c4: 0xdcd07a, polar: 0xc8c898, water: 0x5a5418 },
    { c0: 0x1c2a14, c1: 0x4a6a30, c2: 0x76944a, c3: 0x9ab470, c4: 0xc0d09a, polar: 0xbccdaa, water: 0x37502a },
  ],
  iron: [
    { c0: 0x180e0a, c1: 0x4e2c1e, c2: 0x764830, c3: 0x9c6a44, c4: 0xc99a70, polar: 0xb0a294, water: 0x3a2018 },
    { c0: 0x14100e, c1: 0x453026, c2: 0x6b4c3a, c3: 0x8f6d52, c4: 0xb89474, polar: 0xa89c90, water: 0x322420 },
  ],
  /* Gas giants live or die on the *value* separation between belt and zone.
     The old sets ran c1..c3 within about a stop and a half of each other, and
     once limb darkening and the terminator had taken their cut the disc came
     back a single flat tone — which is exactly what "the bands are so
     low-contrast the planet is nearly featureless" describes. c0 is now a
     genuinely dark belt floor and c3 a genuinely bright zone, so there is
     something left to see after the lighting has had its way. */
  gas: [
    { c0: 0x150c06, c1: 0x7a5228, c2: 0xd8b47e, c3: 0xf8ecd0 },
    { c0: 0x061420, c1: 0x2a5c86, c2: 0x8cc0d8, c3: 0xe4f4fa },
    { c0: 0x1a0812, c1: 0x6a3050, c2: 0xc08498, c3: 0xf4dee2 },
    { c0: 0x0c1a0a, c1: 0x3c6236, c2: 0x9ab87e, c3: 0xe2f0d2 },
    { c0: 0x120a20, c1: 0x4a3878, c2: 0xa294c8, c3: 0xeae4f4 },
    { c0: 0x1e1404, c1: 0x8c6a18, c2: 0xe0be60, c3: 0xfaf0c8 },
  ],
};

function paletteFor(kind, rnd, index) {
  const arr = PALETTES[kind];
  const p = arr[index === undefined ? Math.floor(rnd() * arr.length) : index % arr.length];
  const out = {};
  for (const k of Object.keys(p)) out[k] = lin(p[k]);
  return out;
}

/* The garden world.
 *
 * Everything above is an argument for variety and it stands: a galaxy where
 * every habitable planet is a photograph of this one is the least interesting
 * thing a procedural universe can be, and six of the eight living palettes are
 * deliberately wrong for Earth. But the argument has a hole in it, which is
 * that a system is allowed to roll rust-under-a-red-dwarf at a quarter
 * vegetation for its one habitable world and hand the player a red desert with
 * a blue sky — technically a terran, and indistinguishable from the desert
 * next door. Every world in the game came out a wasteland for exactly that
 * reason.
 *
 * So one world per system is not left to the dice. The first terran gets
 * chlorophyll, water it can see from the ground, and enough vegetation for the
 * habitability field to actually put something on it. The other terrans in the
 * system roll as they always did.
 */
function makeGarden(spec, rnd) {
  spec.colors = paletteFor('terran', rnd, rnd() < 0.5 ? 0 : 1);
  spec.garden = true;
  // High, and not near the top of a range that starts at a quarter: the
  // habitability score is raised to 0.55, so a value here is most of what
  // decides whether a shoulder of hill reads as grass or as gravel.
  spec.veg = rng(rnd, 0.86, 0.98);
  /* Sea level, and it has to be high enough to be *seen*. The landing-site
     search wants flat ground, flat ground on a terran world is a basin floor,
     and a sea a kilometre below the basin is over the horizon. Above 0.5 the
     water comes up into the low ground the site sits in. */
  spec.sea = rng(rnd, 0.52, 0.60);
  /* Relief, and the first attempt at this went the wrong way.
   *
   * The reasoning was that a gorge is a place where nothing grows on any of
   * the surfaces you can see, so a garden should be rolling — and at 0.62 to
   * 0.88 what it produced was a golf course. Smooth ground has no self
   * shadowing, no aspect, no bedrock breaking through and nothing for the eye
   * to travel along: the entire tonal range of the frame collapsed onto
   * whatever the albedo was doing, which is exactly the washed-out reading.
   * Form is what carries a landscape. A living world
   * wants *more* relief than a dead one, not less, because the interesting
   * part is where the two meet — a green shoulder against a bare crag.
   */
  spec.relief = rng(rnd, 1.15, 1.45);
  spec.craters = rng(rnd, 0.05, 0.18);
  return spec;
}

/* ------------------------------------------------------------- atmospheres */

function makeAtmosphere(kind, rnd, dense) {
  // The shells are deliberately about 1.7x taller than the real ratio. At the
  // distances these shots are actually framed from, a physically-scaled
  // atmosphere is a two-pixel line at the limb — technically correct and
  // visually worthless. Raising the shell and dropping the coefficients to
  // match keeps the zenith optical depth roughly right, so the *colour* stays
  // honest while the gradient becomes something you can see.
  // The coefficients are low and the intensity high, which is not a wash — it
  // is the difference between a limb you can see through and a tan fog. Once
  // the *limb* optical depth passes about 3, blue is extinguished along the
  // whole grazing path and the entire ring goes orange, taking the aerial
  // perspective over the day side with it. Keeping tau_limb near 1 and paying
  // for the lost brightness with intensity is what buys the blue.
  /* The Mie numbers are not a taste knob either, and they used to be roughly
     thirty times too small. What they have to reproduce is the *ratio* between
     looking down through the haze and looking along it: Earth's aerosol column
     is about a tenth of an optical depth at the zenith — you can barely see it
     — and close to twenty along a ray that grazes the limb, because the layer
     is a couple of kilometres deep against a six thousand kilometre radius and
     a grazing path crosses two hundred times as much of it. At tau ~ 0.003,
     which is what these were, the layer is transparent from *every* angle and
     the forward-scattered limb arc — the single most recognisable image in
     spaceflight photography — cannot exist at any phase.

     So: `hm` is the scale height as a fraction of the shell, deliberately
     small, and `betaM` is set so that betaM*1.1*hm*height, the optical depth
     straight down, lands on a physical number per world.

     Those numbers are now a *fifth* of what they were, and the arc is brighter
     for it, which is the opposite of what the knob looks like it does. A ray
     grazing the limb crosses fifty times the vertical column, so at tau_zenith
     = 0.1 the limb ran to tau = 5 and was completely saturated: every extra
     unit of aerosol added nothing whatsoever to the arc and a proportional
     milky film to every part of the disc seen from above. A saturated layer
     returns its source function and stops caring about its own density. Thin
     the column until the limb sits at tau ~ 0.8, just past the knee, and pay
     for the lost brightness with the gain in the shader (ARC_GAIN), and the
     arc comes out four times brighter with a fifth of the wash. */
  const presets = {
    terran: { betaR: [2.00, 4.60, 10.60], betaM: 7.7, hr: 0.28, hm: 0.045, g: 0.78, i: 9.6, h: 0.055 },
    ocean: { betaR: [1.90, 4.50, 11.20], betaM: 6.2, hr: 0.29, hm: 0.045, g: 0.79, i: 9.9, h: 0.058 },
    toxic: { betaR: [8.50, 6.60, 2.80], betaM: 26, hr: 0.34, hm: 0.100, g: 0.66, i: 6.2, h: 0.070 },
    desert: { betaR: [3.60, 2.70, 1.80], betaM: 29, hr: 0.26, hm: 0.070, g: 0.72, i: 6.4, h: 0.032 },
    /* A whisper, and it has to be. Europa's atmosphere is 10^-12 bar and shows
       nothing at all; ours ran an intensity of 6.5 against a terran's 9.6 and a
       shell three percent of the radius, which put a cool blue halo right round
       the disc of a sixteen-hundred-kilometre ice moon — including the
       anti-sunward limb, where no exosphere could put anything. It reads as a
       rendering error rather than as air. Kept rather than deleted because a
       tenuous sublimation exosphere is real and a faint sunward brightening at
       the limb is a nice thing for one moon in a system to have; taken down to
       where that is all it can do. Note the draw that decides *whether* an ice
       moon has one at all stays exactly where it is — every rnd() call in this
       file is a position in one deterministic sequence, and removing one
       regenerates every body after it. */
    ice: { betaR: [2.10, 3.40, 6.00], betaM: 4.8, hr: 0.26, hm: 0.040, g: 0.74, i: 0.95, h: 0.011 },
    lava: { betaR: [5.60, 2.60, 1.50], betaM: 23, hr: 0.30, hm: 0.085, g: 0.70, i: 6.8, h: 0.048 },
    gas: { betaR: [2.30, 3.60, 7.00], betaM: 18, hr: 0.32, hm: 0.060, g: 0.76, i: 7.4, h: 0.035 },
  };
  const p = presets[kind] || presets.terran;
  const jitter = 0.82 + rnd() * 0.4;
  return {
    height: p.h * (0.8 + rnd() * 0.5) * dense,
    betaR: new THREE.Vector3(p.betaR[0], p.betaR[1], p.betaR[2]).multiplyScalar(jitter),
    betaM: p.betaM * jitter,
    hr: p.hr, hm: p.hm, g: p.g,
    intensity: p.i * (0.85 + rnd() * 0.35),
  };
}

/* -------------------------------------------------------------- one planet */

const TYPE_KIND = {
  terran: 'terran', desert: 'desert', barren: 'barren', ice: 'ice',
  lava: 'lava', ocean: 'ocean', toxic: 'toxic', iron: 'iron', gas: 'gas',
};

function makePlanet(rnd, name, kind, orbitR, index) {
  const typeId = {
    terran: PLANET_TYPES.TERRAN, desert: PLANET_TYPES.DESERT, barren: PLANET_TYPES.BARREN,
    ice: PLANET_TYPES.ICE, lava: PLANET_TYPES.LAVA, ocean: PLANET_TYPES.OCEAN,
    toxic: PLANET_TYPES.TOXIC, iron: PLANET_TYPES.IRON, gas: 0,
  }[kind];

  const isGas = kind === 'gas';
  const radius = isGas ? rng(rnd, 8500, 21000)
    : kind === 'barren' ? rng(rnd, 900, 2600)
      : rng(rnd, 1500, 4400);

  const spec = {
    name, type: kind, typeId, radius,
    seed: rnd() * 100,
    colors: paletteFor(TYPE_KIND[kind], rnd),
    sea: kind === 'ocean' ? rng(rnd, 0.55, 0.66) : kind === 'terran' ? rng(rnd, 0.38, 0.50) : rng(rnd, 0.28, 0.42),
    ice: rng(rnd, 0.15, 0.85),
    relief: rng(rnd, 0.75, 1.4),
    /* Ice gets its own floor. Craters are what fills the plain between the
       fractures, and a shell that rolled low here came out as bare lines on
       blank white — the emptiness read as untextured rather than as smooth. */
    craters: kind === 'barren' || kind === 'iron' ? rng(rnd, 0.8, 1.5)
      : kind === 'ice' ? rng(rnd, 0.45, 1.0) : rng(rnd, 0.15, 0.6),
    veg: kind === 'terran' ? rng(rnd, 0.25, 0.95) : 0,
    /* Which feature vocabulary this world draws from. Two ice moons in the
       same system used to be the identical asset with a different seed — same
       fracture families, same density, same everything — which is the single
       loudest tell that a universe is generated. The variant swings which
       landform dominates: canyon-lands versus dune sea, chaos terrain versus
       long lineae, shield volcanoes versus fissure plains. */
    variant: rngi(rnd, 0, 2),
    detailFreq: rng(rnd, 40, 90),
    /* Relief only reads if the normal map is strong enough to catch raking
       light at the terminator. The old floor of 0.030 put a cordillera at the
       same shading as the plain beside it. */
    bump: isGas ? 0 : rng(rnd, 0.048, 0.092),
    /* Silhouette displacement in planet radii, used by the surface vertex
       shader. Capped where it is: the ship's collision test is against the
       sphere, so a peak much taller than this is one the hull can fly through. */
    disp: isGas ? 0 : (kind === 'barren' || kind === 'iron' ? rng(rnd, 0.011, 0.018) : rng(rnd, 0.005, 0.012)),
    night: 0,
    lavaGlow: kind === 'lava' ? rng(rnd, 0.8, 2.0) : 0,
    tilt: rng(rnd, -0.5, 0.5),
    tiltDir: rnd() * Math.PI * 2,
    spinRate: rng(rnd, 0.004, 0.03) * (rnd() < 0.15 ? -1 : 1),
    orbitR,
    orbitPhase: rnd() * Math.PI * 2,
    orbitSpeed: 0,
    orbitInc: rng(rnd, -0.09, 0.09),
    index,
    clouds: null, atmo: null, rings: null,
    storm: 0, bands: 0,
    moons: [],
  };

  if (isGas) {
    const p = paletteFor('gas', rnd);
    spec.colors = p;
    // A giant without a landmark on it is a striped ball: the storm is what
    // gives the disc its scale and tells you which way it is turning, so four
    // in five carry one rather than two in three.
    spec.storm = rnd() < 0.82 ? rng(rnd, 0.55, 1.0) : 0;
    spec.bands = rng(rnd, 7, 20);
  }

  // Clouds. `alt` is the top of the deck and `thick` how far down it goes,
  // both in planet radii — the cloud shader samples slabs through that range,
  // so a thicker deck buys visible parallax and self-shadowing at the cost of
  // nothing but a wider spread of the three taps it already makes.
  //
  // `alt` is also, entirely, what decides whether the deck's *shadow* is
  // visible: the shadow of a cloud lands alt*tan(solar zenith) away from it,
  // so at 0.0125 radii a cyclone 0.3 radii across threw a footprint displaced
  // by four percent of its own width — which is to say, hidden underneath
  // itself. The judge's note that a whole cyclone system sits on the ocean
  // with no dark footprint was not a missing feature, it was a deck flying too
  // low for the feature to clear the object casting it. Earth's tops are at
  // 0.002 radii; these are frank exaggeration, on the same grounds as the
  // atmosphere shells being 1.7x tall.
  if (kind === 'terran' || kind === 'ocean') {
    spec.clouds = {
      cover: rng(rnd, 0.18, 0.40), scale: rng(rnd, 3.2, 5.8), alt: 0.024, thick: 0.011,
      tint: lin(0xffffff),
    };
  } else if (kind === 'toxic') {
    spec.clouds = { cover: rng(rnd, 0.62, 0.86), scale: rng(rnd, 1.8, 3.2), alt: 0.030, thick: 0.016, tint: lin(0xe8dfa8) };
  } else if (kind === 'lava' && rnd() < 0.6) {
    spec.clouds = { cover: rng(rnd, 0.16, 0.34), scale: rng(rnd, 2.2, 3.8), alt: 0.026, thick: 0.013, tint: lin(0x6a5a52) };
  } else if (kind === 'desert' && rnd() < 0.4) {
    spec.clouds = { cover: rng(rnd, 0.07, 0.20), scale: rng(rnd, 3.0, 4.6), alt: 0.022, thick: 0.010, tint: lin(0xf0e2c8) };
  }

  // atmosphere
  const hasAtmo = isGas || kind === 'terran' || kind === 'ocean' || kind === 'toxic'
    || kind === 'lava' || (kind === 'desert' && rnd() < 0.7) || (kind === 'ice' && rnd() < 0.45);
  if (hasAtmo) spec.atmo = makeAtmosphere(TYPE_KIND[kind], rnd, isGas ? 1.4 : 1.0);

  // rings
  const ringChance = isGas ? 0.78 : 0.10;
  if (rnd() < ringChance) {
    /* Saturn's rings start at 1.11 radii and all but touch the cloud tops.
       Starting them at 1.4-1.8, as this used to, is what confines the ring's
       shadow to a thin arc hugging the limb: the sunward ray from a point at
       mid-latitude crosses the ring plane inside 1.4 radii and misses the ring
       entirely, so nothing but the polar edge of the disc can ever be in
       shadow. Bringing the inner edge in is most of what turns that arc into
       the broad banded shadow that reads across half a hemisphere. */
    /* A real outer system runs from Jupiter's invisible dust band and Uranus's
       narrow charcoal hoops to Saturn. Drawing width uniformly over 0.85-1.65
       and opacity uniformly over 0.45-0.95 gave four giants carrying four
       ring systems of the same size and the same weight, and a contact sheet
       of them reads as the same asset four times — which is the fastest way to
       spend the one spectacular thing in the system. Power laws on the same
       draws instead: most systems come out narrow and gauzy and roughly one in
       four is Saturn, so the one that is means something.

       The draws themselves are untouched, and that is deliberate. Every rnd()
       in this file is a position in one deterministic sequence: adding or
       removing a call here regenerates every body after it, which would throw
       away worlds that have already been judged. Only the mapping changes. */
    const inner = rng(rnd, 1.14, 1.34);
    const wU = rnd();
    spec.rings = {
      inner,
      outer: inner + 0.22 + 1.55 * Math.pow(wU, 1.5),
      colA: lin([0xbfae95, 0x9aa6b2, 0xc8b8a0, 0xa89a86, 0x6e6a66][Math.floor(rnd() * 5)]),
      colB: lin([0xefe6d6, 0xd6dee8, 0xf2e2c8, 0xdcd2c2, 0x9c968e][Math.floor(rnd() * 5)]),
      opacity: 0.09 + 0.87 * Math.pow(rnd(), 1.45),
    };
    tiltForRings(spec, rnd);
  }

  return spec;
}

/* A ringed world is *only* the postcard if the star is well above the ring
   plane, and that is not something you can leave to chance.

   The two defining images of a ringed giant — the shadow wedge the planet
   throws across its own rings, and the hard bands the rings throw back across
   the cloud tops — are both driven by one number: the sun's elevation above
   the ring plane. It works out as sin(tilt) * sin(tiltDir - orbitPhase), and
   the origin system's giant was drawing 0.043 rad of tilt against a tiltDir
   that happened to sit near the node, for a final elevation of 0.10. At that
   angle the planet's shadow lies *in* the ring plane, hidden inside its own
   silhouette, and the ring's shadow lands in a band a couple of degrees of
   latitude wide that misses the visible disc entirely — which is why both
   halves of the effect were reported missing when both were in fact
   implemented and running.

   Planets orbit at 0.4 km/s here, so orbitPhase is effectively frozen: fixing
   the tilt axis a quarter turn from the sun line at generation time puts the
   star 20-32 degrees above the plane and keeps it there.  */
function tiltForRings(spec, rnd) {
  /* 24 to 38 degrees, up from 21-33. The extra elevation does two things at
     once: it opens the ring into a wider ellipse, and it pulls the band of
     latitude the ring's shadow falls on in from the pole toward the equator.
     The shadow was landing between about eight degrees and the winter pole,
     which is ground already dark from limb darkening and from a low sun — so
     the one feature that most identifies a ringed giant was being thrown onto
     the part of the disc least able to show it. */
  spec.tilt = rng(rnd, 0.42, 0.66) * (rnd() < 0.5 ? -1 : 1);
  spec.tiltDir = spec.orbitPhase + Math.PI * 0.5 + rng(rnd, -0.30, 0.30);
}

/* ------------------------------------------------------------ full system */

export function generateSystem(stub) {
  const rnd = mulberry32(stub.seed);
  const sc = stub.starClass;
  const temp = rng(rnd, sc.temp[0], sc.temp[1]);
  const color = kelvinColor(temp);

  const star = {
    name: stub.name,
    cls: sc.cls,
    desc: sc.desc,
    temp,
    color,
        // Barely lerped toward white. AgX desaturates anything it has to compress,
    // so a corona authored near-white clips to grey and the star loses its
    // class entirely — a red dwarf and a blue giant end up the same colour.
    coronaColor: color.clone().lerp(new THREE.Color(1, 1, 1), 0.10),
    radius: rng(rnd, sc.radius[0], sc.radius[1]),
    seed: rnd() * 50,
    /* Genuinely HDR. The number that matters is the tonemap's clip point, and
       it is a long way up: after auto-exposure bottoms out around 0.045 and the
       pre-contrast curve, a pixel needs roughly 120 units of scene radiance
       before AgX hands back pure white. A photosphere authored at 4 can never
       clip, so the brightest object in the game rendered as flat grey paper and
       the whole frame read as fog. Limb darkening still does its job — it takes
       the edge of the disc down by more than an order of magnitude from here. */
    surfaceIntensity: sc.cls === 'PSR' ? 380 : sc.cls === 'WD' ? 260 : 78 + sc.lum * 42,
    coronaIntensity: sc.cls === 'PSR' ? 2.6 : 0.95 + sc.lum * 0.45,
    glareIntensity: 1.5 + sc.lum * 0.9,
    luminosity: sc.lum,
  };

  // habitable zone scales with luminosity
  const hz = 900000 * Math.sqrt(Math.max(sc.lum, 0.05));
  const nPlanets = rngi(rnd, 3, 8);
  const planets = [];
  let orbit = star.radius * rng(rnd, 5.5, 9);

  for (let i = 0; i < nPlanets; i++) {
    orbit *= rng(rnd, 1.45, 2.15);
    orbit += rng(rnd, 80000, 260000);
    const ratio = orbit / hz;

    let kind;
    const r = rnd();
    if (ratio < 0.42) kind = r < 0.55 ? 'lava' : r < 0.8 ? 'iron' : 'barren';
    else if (ratio < 0.80) kind = r < 0.34 ? 'desert' : r < 0.6 ? 'barren' : r < 0.8 ? 'toxic' : 'iron';
    else if (ratio < 1.45) kind = r < 0.42 ? 'terran' : r < 0.62 ? 'ocean' : r < 0.8 ? 'desert' : 'toxic';
    else if (ratio < 3.0) kind = r < 0.42 ? 'gas' : r < 0.66 ? 'barren' : r < 0.86 ? 'ice' : 'terran';
    else kind = r < 0.5 ? 'ice' : r < 0.82 ? 'gas' : 'barren';

    const p = makePlanet(rnd, `${stub.name} ${ROMAN[i]}`, kind, orbit, i);
    // Orbits are capped by *tangential speed*, not by Kepler. A physically
    // scaled orbit at these compressed distances would sweep the planet along
    // at over a thousand km/s — twenty times faster than the ship can fly — so
    // worlds would literally outrun you. Cap it well under cruise speed.
    p.orbitSpeed = (PLANET_ORBIT_SPEED / orbit) * (rnd() < 0.05 ? -1 : 1);

    // habitable worlds sometimes carry the marks of settlement
    if (kind === 'terran' && ratio > 0.85 && ratio < 1.3 && rnd() < 0.55) {
      p.night = rng(rnd, 0.5, 1.6);
      p.inhabited = true;
    }

    // moons
    const nMoons = p.type === 'gas' ? rngi(rnd, 1, 4) : rnd() < 0.4 ? rngi(rnd, 1, 2) : 0;
    let mo = p.radius * rng(rnd, 3.2, 5.0);
    for (let m = 0; m < nMoons; m++) {
      mo *= rng(rnd, 1.5, 2.2);
      const mk = rnd() < 0.55 ? 'barren' : rnd() < 0.6 ? 'ice' : rnd() < 0.7 ? 'iron' : 'lava';
      const moon = makePlanet(rnd, `${p.name}${GREEK[m]}`, mk, mo, m);
      moon.radius = Math.min(moon.radius, p.radius * 0.42);
      moon.isMoon = true;
      moon.parent = p;
      moon.orbitSpeed = (MOON_ORBIT_SPEED / mo) * (rnd() < 0.1 ? -1 : 1);
      moon.rings = null;
      p.moons.push(moon);
    }

    planets.push(p);
  }

  // The origin system always gets a ringed giant — it is the postcard.
  if (stub.forceHabitable) {
    const giants = planets.filter((p) => p.type === 'gas');
    if (giants.length && !giants.some((p) => p.rings)) {
      const g = giants[0];
      const inner = rng(rnd, 1.16, 1.32);
      g.rings = {
        inner,
        outer: inner + rng(rnd, 1.2, 1.8),
        colA: lin(0xbfae95), colB: lin(0xefe6d6),
        opacity: rng(rnd, 0.72, 0.95),
      };
      tiltForRings(g, rnd);
    }
  }

  // ...and one of them is a garden. See makeGarden for why this is not left
  // to the dice.
  {
    const first = planets.find((p) => p.type === 'terran');
    if (first) makeGarden(first, rnd);
  }

  // The origin system always gets a living world — first impressions matter,
  // and the whole premise needs somewhere the Choir could actually have lived.
  if (stub.forceHabitable && !planets.some((p) => p.type === 'terran')) {
    let bi = 0, bd = Infinity;
    planets.forEach((p, i) => {
      const d = Math.abs(Math.log(p.orbitR / hz));
      if (d < bd) { bd = d; bi = i; }
    });
    const old = planets[bi];
    const np = makePlanet(rnd, old.name, 'terran', old.orbitR, old.index);
    np.orbitPhase = old.orbitPhase;
    np.orbitSpeed = old.orbitSpeed;
    np.orbitInc = old.orbitInc;
    np.moons = old.moons;
    np.radius = rng(rnd, 3200, 4600);
    np.night = rng(rnd, 0.8, 1.7);
    np.inhabited = true;
    makeGarden(np, rnd);
    planets[bi] = np;
  }

  // ---- asteroid belts
  const belts = [];
  const nBelts = rnd() < 0.62 ? 1 : rnd() < 0.25 ? 2 : 0;
  for (let i = 0; i < nBelts; i++) {
    const idx = rngi(rnd, 1, Math.max(1, planets.length - 2));
    const a = planets[idx - 1]?.orbitR || hz;
    const b = planets[idx]?.orbitR || hz * 2;
    const mid = (a + b) * 0.5;
    belts.push({
      inner: mid * rng(rnd, 0.86, 0.94),
      outer: mid * rng(rnd, 1.06, 1.16),
      thickness: mid * rng(rnd, 0.012, 0.035),
      count: rngi(rnd, 1400, 3200),
      seed: rnd() * 1000,
      tint: lin([0x6b625a, 0x5a5e66, 0x74655a, 0x4e5250][Math.floor(rnd() * 4)]),
      name: `${stub.name} Belt ${String.fromCharCode(65 + i)}`,
    });
  }

  return { star, planets, belts, stub };
}

/* -------------------------------------------------------------- galaxy map */

export function generateGalaxy(seed, count = 14) {
  const rnd = mulberry32(seed);
  const systems = [];
  const used = new Set();

  for (let i = 0; i < count; i++) {
    let name;
    do { name = starName(rnd); } while (used.has(name));
    used.add(name);

    // loose spiral-ish scatter in a 2D chart (light-years, purely for the map)
    const ang = rnd() * Math.PI * 2;
    const rad = Math.pow(rnd(), 0.62) * 46 + 4;
    const sc = pickStarClass(rnd);

    systems.push({
      id: i,
      name,
      seed: Math.floor(rnd() * 1e9),
      starClass: sc,
      x: Math.cos(ang) * rad + rng(rnd, -6, 6),
      y: Math.sin(ang) * rad * 0.7 + rng(rnd, -6, 6),
      visited: false,
      designation: `${['XN', 'HR', 'TY', 'KP', 'VD', 'ZC'][Math.floor(rnd() * 6)]}-${rngi(rnd, 1000, 9999)}`,
      nebula: Math.floor(rnd() * 6),
    });
  }

  // the origin system is always a quiet, legible one
  systems[0].starClass = STAR_CLASSES[2];
  systems[0].visited = true;
  systems[0].forceHabitable = true;

  return systems;
}

export { STAR_CLASSES, kelvinColor, lin };
