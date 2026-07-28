import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* ============================================================================
   Baked assets for the habitable module.

   The interior used to be surfaced entirely by a procedural surface model
   evaluated per fragment: panel grid, weld beads, rivets, tread, stencils and
   a screen-space-derivative bump, all computed analytically. It aliased at
   full strength and there was nothing that could be done about it, because
   MSAA resolves *triangle coverage* — it shades once per pixel — and a
   procedural field has no mip chain to prefilter it. Every one of those
   features was a hard step evaluated at one sample per pixel.

   All of it is now baked in Blender into tiling maps that the GPU can
   prefilter and sample anisotropically, plus a glTF kit of real geometry that
   carries an occlusion atlas. The pipeline lives in the blender-hardsurface
   skill's socket scripts; what arrives here is:

     panel_*   2 m tile of hull plating   — irregular plates, welds, rivets,
               a recessed hatch, a louvre vent, stencilled markings
     deck_*    1.5 m tile of deck plate   — raised anti-slip, countersunk
               fasteners, plate seams
     kit_ao    2048 atlas of ray-traced ambient occlusion for the kit meshes,
               baked with the whole ship assembled around each piece, so the
               corners a lamp can never reach are dark because they are dark

   Albedo is authored near white and carries only modulation; the palette
   lives in `material.color`, where it is one place to change instead of six
   texture files.
   ========================================================================== */

const BASE = 'models/';

/**
 * A texture that is safe to bind before its image exists.
 *
 * Everything in the cabin is built synchronously at boot and the materials
 * hold these as raw sampler uniforms, so a null texture would bind sampler
 * unit 0 to nothing and the whole pass would be undefined. A 1x1 canvas of the
 * right neutral value renders as an untextured cabin for the frame or two
 * before the real image lands, and swaps in with `needsUpdate`.
 */
function placeholder(rgb) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d');
  g.fillStyle = rgb;
  g.fillRect(0, 0, 1, 1);
  const t = new THREE.Texture(c);
  t.needsUpdate = true;
  return t;
}

function loadTiling(loader, file, { srgb = false, aniso = 8, neutral = '#ffffff' } = {}) {
  const tex = placeholder(neutral);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = aniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  loader.load(BASE + file, (img) => {
    tex.image = img.image;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
  }, undefined, () => { /* keep the placeholder */ });
  return tex;
}

/**
 * Load the kit and every baked map. Awaited once, at boot, before the cabin is
 * assembled — the geometry has to exist before `buildInterior` can place it,
 * and every material wants its maps before the first shadow-map render.
 */
export async function loadInteriorAssets(renderer) {
  const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
  const aniso = Math.min(8, maxAniso);
  const tl = new THREE.TextureLoader();

  const tex = {
    panelAlb: loadTiling(tl, 'panel_albedo.webp', { srgb: true, aniso, neutral: '#d8d5cf' }),
    panelNrm: loadTiling(tl, 'panel_normal.webp', { aniso, neutral: '#8080ff' }),
    panelOrm: loadTiling(tl, 'panel_orm.webp', { aniso, neutral: '#ffd400' }),
    deckAlb: loadTiling(tl, 'deck_albedo.webp', { srgb: true, aniso, neutral: '#cfccc6' }),
    deckNrm: loadTiling(tl, 'deck_normal.webp', { aniso, neutral: '#8080ff' }),
    deckOrm: loadTiling(tl, 'deck_orm.webp', { aniso, neutral: '#ffd400' }),
    // Upholstery, acoustic liner and rubber. They need a set of their own:
    // running the plate model over the pilot's seat put panel seams, an
    // inspection placard and a stencilled roundel across the headrest.
    softAlb: loadTiling(tl, 'soft_albedo.webp', { srgb: true, aniso, neutral: '#d0cdc8' }),
    softNrm: loadTiling(tl, 'soft_normal.webp', { aniso, neutral: '#8080ff' }),
    softOrm: loadTiling(tl, 'soft_orm.webp', { aniso, neutral: '#e8e000' }),
    kitAo: null,
  };

  const kitAo = await new Promise((res) => {
    tl.load(BASE + 'kit_ao.webp', (t) => {
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = aniso;
      t.flipY = false;                 // glTF UVs, not three's default
      t.needsUpdate = true;
      res(t);
    }, undefined, () => res(null));
  });
  tex.kitAo = kitAo;

  /* The kit. One glTF node per piece, one primitive per material slot, which
     three surfaces as a Group of Meshes named after the Blender materials. We
     keep the raw geometries keyed by piece and slot and build our own meshes,
     so nothing from Blender's material export reaches the frame. */
  /* Draco. The kit carries no images at all — every map in the cabin is a
     separate webp — so the GLB is pure vertex data, and pure vertex data at
     float32 was most of this game's first load: 16.3 MB for a cabin whose
     geometry is only interesting because it is dense. Quantised to 14 bits of
     position over a 16 m ship — 1 mm, a tenth of the smallest chamfer in the
     kit — it decodes to the same mesh and ships at 1.8 MB.

     No `setDecoderPath`. three's DRACOLoader already resolves its decoder
     through `new URL(..., import.meta.url)`, which Vite statically rewrites to
     a hashed asset it emits itself, so the default is both bundled and
     content-addressed. Overriding it with a public/ path builds a second copy
     of the same wasm into the output *and* makes the loader look for a
     `draco_decoder.js` fallback alongside it — which is a 404 waiting for the
     first browser without wasm. */
  const draco = new DRACOLoader();
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const kit = {};
  try {
    const gltf = await loader.loadAsync(BASE + 'interior_kit.glb');
    for (const node of gltf.scene.children) {
      const parts = [];
      const collect = (o) => {
        if (o.isMesh) parts.push({ geo: o.geometry, mat: o.material?.name || 'KIT_HULL' });
        o.children.forEach(collect);
      };
      collect(node);
      if (parts.length) kit[node.name] = parts;
    }
  } catch (e) {
    console.warn('[interior] kit unavailable, falling back to primitives', e);
  }
  draco.dispose();
  return { tex, kit };
}
