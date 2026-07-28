import * as THREE from 'three';
import { NOISE, LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from './glsl/noise.js';

/* ============================================================================
   Deep-sky background.

   Two parts, because one alone never looks right:
     1. A baked nebula cubemap — large, soft, mostly *dark* structure. Real
        astrophotography is 95% black; the moment the sky is full of purple
        clouds it reads as a screensaver. Density is kept low and the dynamic
        range high so bloom does the work.
     2. A real HDR point-star field with a physical magnitude distribution and
        blackbody colours, so the bright ones bloom and streak like a lens.
   ========================================================================== */

const NEBULA_FRAG = /* glsl */`
precision highp float;
${NOISE}
varying vec3 vDir;
uniform float uSeed;
uniform vec3  uColA;
uniform vec3  uColB;
uniform vec3  uColC;
uniform float uDensity;
uniform vec3  uGalAxis;

void main(){
  vec3 d = normalize(vDir);
  vec3 s = vec3(uSeed*11.7, uSeed*4.1, -uSeed*7.9);
  vec3 p = d*1.15 + s;

  float x = dot(d, uGalAxis);

  // ---- galactic plane: a thin milky lane of unresolved starlight -------
  float bandCore = exp(-x*x*140.0);
  float bandWide = exp(-x*x*26.0);
  float rag = fbm(d*3.2 + uSeed*3.3, 4)*0.5 + 0.5;
  float band = (bandCore*0.72 + bandWide*0.34) * mix(0.45, 1.0, rag);

  // ---- emission complexes ---------------------------------------------
  // Only a few percent of any real sky has visible nebulosity. A very
  // low-frequency mask raised to a high power gives isolated complexes with
  // black between them, instead of an all-over marble texture.
  float region = fbm(p*0.42 + 3.0, 4)*0.5 + 0.5;
  region = smoothstep(0.54, 0.90, region);
  region *= region;
  // complexes hug the galactic plane, like real star-forming regions
  region *= mix(0.10, 1.0, bandWide);

  vec3 q = warp3(p*1.6 + 11.0, 0.55, 3);
  float fine = fbm(q*1.9, 6)*0.5 + 0.5;
  float fil  = ridged(q*3.4 + 21.0, 5);

  float emis = region * pow(max(fine, 0.0), 2.4);
  float filaments = region * pow(max(fil, 0.0), 4.0);

  // ---- dark absorption -------------------------------------------------
  float dust = fbm(warp3(p*1.9 - 9.0, 0.45, 3)*1.4, 5)*0.5 + 0.5;
  dust = smoothstep(0.40, 0.88, dust);

  // ---- integrated starlight --------------------------------------------
  // The faint, structured wash that fills the gaps between the bright
  // complexes. Real deep-sky frames are dark but they are never *empty*: there
  // is always unresolved starlight and reflection nebulosity carrying texture
  // at a level just above black. Without it a space shot is a black rectangle
  // with one object in it, which is exactly how these frames were reading.
  float wash = fbm(p*0.62 + 47.0, 5)*0.5 + 0.5;
  wash = pow(max(wash, 0.0), 2.2);

  // ---- compose ---------------------------------------------------------
  vec3 col = vec3(0.0);
  col += uColA * emis * 0.42;
  col += uColB * filaments * 0.30;
  col += uColC * pow(emis*filaments, 0.7) * 0.55;

  // ionised cores: tiny, rare, bright enough for bloom to find them
  float core = pow(max(fbm(q*4.2 + 41.0, 4)*0.5+0.5, 0.0), 22.0) * region;
  col += (uColC*0.5 + vec3(0.85,0.72,0.58)) * core * 6.0;

  col *= uDensity;

  // diffuse starlight of the plane itself
  col += vec3(0.052, 0.058, 0.082) * band;
  // and the all-sky wash, tinted cold so the void stays teal-black
  col += vec3(0.0075, 0.0098, 0.0155) * wash * mix(0.55, 1.6, bandWide);

  // dust cuts into everything, including the band — this is what makes the
  // Milky Way read as a *structure* rather than a smear
  col *= (1.0 - dust*0.72*mix(0.25, 1.0, bandWide));

  // cosmic floor: never pure black, never visible as a colour
  col += vec3(0.0008, 0.0011, 0.0019);

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

const NEBULA_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Palettes chosen to read as real deep-sky objects rather than candy. */
export const NEBULA_PALETTES = [
  { name: 'Carina',    a: [0.42, 0.13, 0.10], b: [0.10, 0.16, 0.30], c: [0.60, 0.30, 0.16] },
  { name: 'Cygnus',    a: [0.09, 0.20, 0.34], b: [0.30, 0.12, 0.26], c: [0.24, 0.34, 0.46] },
  { name: 'Orion',     a: [0.34, 0.16, 0.30], b: [0.10, 0.22, 0.36], c: [0.46, 0.34, 0.28] },
  { name: 'Rho',       a: [0.36, 0.20, 0.09], b: [0.08, 0.14, 0.32], c: [0.44, 0.28, 0.34] },
  { name: 'Veil',      a: [0.08, 0.26, 0.28], b: [0.24, 0.10, 0.30], c: [0.20, 0.38, 0.40] },
  { name: 'Tarantula', a: [0.30, 0.11, 0.22], b: [0.13, 0.18, 0.34], c: [0.50, 0.26, 0.22] },
];

export function bakeNebulaCube(renderer, size, seed, paletteIndex = 0) {
  const pal = NEBULA_PALETTES[paletteIndex % NEBULA_PALETTES.length];
  const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
  });

  const galAxis = new THREE.Vector3(
    Math.sin(seed * 1.7), Math.cos(seed * 2.3) * 0.8, Math.sin(seed * 0.9 + 1.1)
  ).normalize();

  const mat = new THREE.ShaderMaterial({
    vertexShader: NEBULA_VERT,
    fragmentShader: NEBULA_FRAG,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSeed: { value: seed },
      uColA: { value: new THREE.Vector3(...pal.a) },
      uColB: { value: new THREE.Vector3(...pal.b) },
      uColC: { value: new THREE.Vector3(...pal.c) },
      uDensity: { value: 1.35 },
      uGalAxis: { value: galAxis },
    },
  });

  const scene = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), mat);
  box.frustumCulled = false;
  scene.add(box);

  const cam = new THREE.CubeCamera(0.1, 100, cubeRT);
  const prevTarget = renderer.getRenderTarget();
  cam.update(renderer, scene);
  renderer.setRenderTarget(prevTarget);

  box.geometry.dispose();
  mat.dispose();

  cubeRT.texture.name = pal.name;
  return cubeRT;
}

/* --------------------------------------------------------------- stars */

const STAR_VERT = /* glsl */`${LOGD_V_PARS}
attribute float aSize;
attribute vec3  aColor;
attribute float aPhase;
uniform float uPixel;
uniform float uTime;
uniform float uBoost;
varying vec3 vCol;
varying float vCore;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  ${LOGD_V}
  // very slight scintillation keeps the field from looking like static
  float tw = 0.94 + 0.06*sin(uTime*0.7 + aPhase*40.0);

  /* Every star gets at least a few pixels to spread over. A one-pixel point
     cannot express a point-spread function — it is a hard square, and a sky
     full of hard squares reads as dead pixels or sensor noise rather than as
     stars. Widening them alone would make the faint ones *brighter*, so the
     flux is held constant: spreading a star over more pixels dims it in
     proportion, which is what finally lets the faint end fall away below the
     noise floor instead of carpeting the frame at uniform brightness. */
  /* Sizing the quad is not enough on its own, and that is the trap here.
     Widening the sprite while conserving flux exactly divides the peak by the
     area gained, and the peak is what the display sees: on a 6 px quad a
     mid-magnitude star ends up with everything except its centre texel *below
     black*, so it still renders as a hard 1-2 pixel dot with cut corners no
     matter how soft the profile is. The visible size of a star is set by where
     its profile crosses the display floor, not by the quad.

     So: size scales with brightness, the way a real point spread does, and the
     flux is only *partly* conserved — enough that the faint end still falls
     away, not so much that the skirt is extinguished before it can be seen. */
  /* Four, not seven. The floor exists so the profile has samples to resolve
     itself in; seven was chosen when the renderer shaded exactly one sample per
     output pixel, and it made a star seven *screen* pixels across — a bokeh
     blob. With supersampling the shading rate is well above one per output
     pixel, so the profile resolves at a much smaller quad and the floor can go
     back to something that looks like a star. */
  float want = max(aSize * 1.15, 4.0);
  float spread = pow((aSize*aSize) / (want*want), 0.78);
  gl_PointSize = want * uPixel * tw;
  vCol  = aColor * uBoost * tw * spread;
  vCore = aSize;
}
`;

const STAR_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying vec3 vCol;
varying float vCore;
void main(){
  ${LOGD_F}
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if(r2 > 0.25) discard;
  float r = sqrt(r2)*2.0;
  // A real point spread: a tight Gaussian core, a wider Airy-ish skirt, and a
  // faint outer wing. The wing is what makes a bright star read as bright
  // rather than as a bigger dot.
  // Widened. At 13 the core's half-maximum sat inside a pixel and a star
  // resolved to one hot texel with cut corners — an octagon, which magnifies
  // into the little squares-with-an-x that made the sky look like stuck
  // pixels. The flux is conserved in the vertex stage, so spreading the core
  // costs brightness rather than adding it.
  float core  = exp(-r*r*5.0);
  float skirt = exp(-r*r*1.4)*0.38;
  float wing  = exp(-r*1.9)*0.12;
  float a = (core + skirt + wing) * (1.0 - smoothstep(0.82, 1.0, r));
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

/**
 * Physical-ish star field: power-law magnitude distribution, blackbody colours,
 * clustered toward a galactic plane. Radius is huge; the object is re-centred
 * on the camera every frame so it behaves as an infinite backdrop.
 */
export function makeStarField(count, seed, radius = 4.0e6) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const siz = new Float32Array(count);
  const pha = new Float32Array(count);

  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };

  const galAxis = new THREE.Vector3(
    Math.sin(seed * 1.7), Math.cos(seed * 2.3) * 0.8, Math.sin(seed * 0.9 + 1.1)
  ).normalize();
  const tmp = new THREE.Vector3();
  const c = new THREE.Color();

  /* Open clusters. A uniformly scattered field — however carefully its
     magnitudes are distributed — reads as television static, because the one
     thing a real sky is *not* is uniform. Real stars come in groups: a dozen
     obvious clumps near the plane, each a few dozen stars within a couple of
     degrees. Putting a modest fraction of the field into clusters is the single change
     that makes the backdrop look photographed. Keep the fraction low and the
     spread generous: a fifth of the field packed into fourteen tight knots
     reads as confetti, not as sky. */
  const CLUSTERS = 14;
  const clusterAt = [];
  for (let i = 0; i < CLUSTERS; i++) {
    const t = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const along = t.dot(galAxis);
    t.addScaledVector(galAxis, -along * (0.80 + rnd() * 0.18)).normalize();
    clusterAt.push({ dir: t, spread: 0.030 + rnd() * 0.075, n: 0 });
  }

  for (let i = 0; i < count; i++) {
    // uniform on sphere, then biased toward the galactic plane
    let x, y, z, l;
    do {
      x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1;
      l = x * x + y * y + z * z;
    } while (l > 1 || l < 1e-6);
    l = Math.sqrt(l); x /= l; y /= l; z /= l;

    tmp.set(x, y, z);
    const roll = rnd();
    if (roll < 0.12) {
      // in a cluster: jitter a small angle off its centre
      const cl = clusterAt[Math.floor(rnd() * CLUSTERS)];
      cl.n++;
      tmp.copy(cl.dir)
        .addScaledVector(new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1), cl.spread)
        .normalize();
    } else if (roll < 0.82) {
      // pull toward the plane — harder than before, so the band actually reads
      const along = tmp.dot(galAxis);
      tmp.addScaledVector(galAxis, -along * (0.70 + rnd() * 0.28)).normalize();
    }

    pos[i * 3] = tmp.x * radius;
    pos[i * 3 + 1] = tmp.y * radius;
    pos[i * 3 + 2] = tmp.z * radius;

    // magnitude: heavy power law — a few brilliant stars, a haze of faint ones
    const u = rnd();
    const bright = Math.pow(u, 5.5);
    const size = 1.05 + bright * 7.5;
    siz[i] = size;
    pha[i] = rnd();

    // spectral type distribution skewed to cool dwarfs, rare hot giants
    const t = rnd();
    let kelvin;
    if (t < 0.70) kelvin = 2900 + rnd() * 1500;
    else if (t < 0.90) kelvin = 4400 + rnd() * 1600;
    else if (t < 0.975) kelvin = 6000 + rnd() * 2200;
    else kelvin = 8500 + rnd() * 13000;

    kelvinToRGB(kelvin, c);
    /* Couple brightness to temperature. Cool dwarfs genuinely outnumber hot
       stars four to one, but they are also two orders of magnitude fainter —
       so a real naked-eye sky is mostly white and blue with a few orange
       giants in it. Sampling the *population* without the luminosity leaves
       the field a wash of orange confetti. */
    const lumBias = kelvin < 4000 ? 0.30 : kelvin < 6000 ? 0.70 : kelvin < 9000 ? 1.35 : 2.40;
    const inten = (0.30 + bright * 9.0) * lumBias;
    col[i * 3] = c.r * inten;
    col[i * 3 + 1] = c.g * inten;
    col[i * 3 + 2] = c.b * inten;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(pha, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.1);

  const mat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: {
      uPixel: { value: 1 },
      uTime: { value: 0 },
      uBoost: { value: 1 },
    },
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -900;
  points.matrixAutoUpdate = false;
  return points;
}

function kelvinToRGB(k, out) {
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
  out.setRGB(
    Math.min(1, Math.max(0, r / 255)),
    Math.min(1, Math.max(0, g / 255)),
    Math.min(1, Math.max(0, b / 255)),
    THREE.SRGBColorSpace
  );
  return out;
}
