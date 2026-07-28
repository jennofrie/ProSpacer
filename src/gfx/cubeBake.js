import * as THREE from 'three';

/* Render an arbitrary direction-driven material into a cubemap.
   Using a CubeCamera (rather than hand-rolled face matrices) means three
   handles the six face orientations, so `textureCube(dir)` at runtime returns
   exactly what the shader drew for that direction. */

const _boxGeo = new THREE.BoxGeometry(10, 10, 10);

export function renderToCube(renderer, material, size, opts = {}) {
  const rt = new THREE.WebGLCubeRenderTarget(size, {
    type: opts.type || THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: opts.mipmaps === false ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: opts.mipmaps !== false,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const prevSide = material.side;
  const prevDepth = material.depthTest;
  material.side = THREE.BackSide;
  material.depthTest = false;
  material.depthWrite = false;

  const scene = new THREE.Scene();
  const box = new THREE.Mesh(_boxGeo, material);
  box.frustumCulled = false;
  scene.add(box);

  const cam = new THREE.CubeCamera(0.1, 100, rt);
  cam.update(renderer, scene);

  material.side = prevSide;
  material.depthTest = prevDepth;
  scene.remove(box);

  return rt;
}
