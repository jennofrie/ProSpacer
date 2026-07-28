/* Does the JS transliteration of the height field agree with the GLSL?
 *
 * Compiles the real FIELD chunk into a WebGL2 program in a headless page,
 * evaluates groundYFlat at a few hundred scattered points, and diffs it
 * against Surface.heightAt for the same landed world.
 */
import { chromium } from 'playwright';
import { bootGame } from './boot.mjs';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 600)); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });

const KIND = process.argv[2] || 'terran';
await bootGame(page, {
  setup: `(()=>{ g.mode='exterior'; g.pose({kind:'${KIND}',dist:1.6,phase:70,elev:8});
    g.land(g.target, {now:true}); g.director.stop(); g.setLayer('hud',false); return null; })()`,
  settle: 1500,
});

const res = await page.evaluate(async () => {
  const g = window.__game;
  const S = g.surface;
  const mod = await import('/src/gfx/glsl/noise.js');
  const surfMod = await import('/src/world/Surface.js');
  // The FIELD source is not exported, so lift it out of the material three
  // already compiled: the terrain vertex shader contains the whole chunk.
  const vsrc = S.terrainMat.vertexShader;
  const start = vsrc.indexOf('const float VSCALE');
  const end = vsrc.indexOf('float skyOccCheap');
  const fieldSrc = vsrc.slice(start, vsrc.indexOf('}', vsrc.indexOf('return clamp(1.0 - clamp(m, 0.0, 1.0)*0.55, 0.2, 1.0);')) + 1);

  const FJ = surfMod.__fieldJS;

  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const gl = cv.getContext('webgl2', { antialias: false });
  if (!gl) return { err: 'no webgl2' };
  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) return { err: 'no float rt' };

  const VS = `#version 300 es
  in vec2 aPos; out vec2 vUv;
  void main(){ vUv = aPos*0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FS = `#version 300 es
  precision highp float;
  ${mod.NOISE.replace(/^#ifndef LS_NOISE|#define LS_NOISE|#endif$/gm, '')}
  uniform float uSeed, uRelief, uPlanetR, uSea, uLodK;
  uniform int uType;
  uniform vec3 uSunDir;
  ${fieldSrc}
  uniform vec2 uP0;
  uniform vec2 uStep;
  uniform float uLod;
  uniform vec4 uDat;   // (datum, fine datum, site x, site z)
  uniform int uMode;
  in vec2 vUv;
  out vec4 oCol;
  void main(){
    vec2 ij = floor(gl_FragCoord.xy);
    vec2 p = uP0 + ij*uStep;
    if(uMode == 1){
      vec3 q = vec3(p.x*0.013, 0.37, p.y*0.013);
      vec3 r = vec3(p.x*0.031 - 6.0, -2.37, p.y*0.017 + 1.5); oCol = vec4(fbm(r, 4), r.x, r.z, 1.0);
      return;
    }
    float y = groundYFlat(p, uLod, uDat);
    oCol = vec4(y, p.x, p.y, 1.0);
  }`;

  function sh(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) { return { err: String(e).slice(0, 1200) }; }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 64, 64);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  gl.useProgram(prog);
  const U = S.U;
  const u = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1f(u('uSeed'), U.uSeed.value);
  gl.uniform1f(u('uRelief'), U.uRelief.value);
  gl.uniform1f(u('uPlanetR'), U.uPlanetR.value);
  gl.uniform1f(u('uSea'), U.uSea.value);
  gl.uniform1f(u('uLodK'), U.uLodK.value);
  gl.uniform1i(u('uType'), U.uType.value | 0);
  gl.uniform3f(u('uSunDir'), 0.3, 0.6, 0.4);
  gl.uniform4f(u('uDat'), S._datum[0], S._datum[1], S._site[0], S._site[1]);

  const out = [];
  // ---- stage 1: the basis functions on their own -------------------------
  gl.uniform1i(u('uMode'), 1);
  gl.uniform2f(u('uP0'), -13.7, 41.3);
  gl.uniform2f(u('uStep'), 1.37, 0.91);
  gl.viewport(0, 0, 64, 64);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  {
    const px = new Float32Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.FLOAT, px);
    let ws = 0, wf = 0, wr = 0, sf = 0, nbad = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const ix = i % 64, iy = (i / 64) | 0;
      const x = -13.7 + ix * 1.37, z = 41.3 + iy * 0.91;
      const qx = x * 0.013, qy = 0.37, qz = z * 0.013;
      const rx = px[i*4+1], rz = px[i*4+2];
      const ej = Math.abs(FJ.fbm(rx, -2.37, rz, 4) - px[i*4]);
      wf = Math.max(wf, ej); sf += ej; if (ej > 1e-4) { nbad++; if (nbad === 1) out.push({ first: [rx, -2.37, rz, px[i*4], FJ.fbm(rx,-2.37,rz,4)] }); }
    }
    
  }
  gl.uniform1i(u('uMode'), 0);
  const LODS = [1.0, 6.0, 40.0];
  for (const lod of LODS) {
    const step = lod < 2 ? 3.0 : lod * 12.0;
    const p0 = [-32 * step + 137.0, -32 * step - 91.0];
    gl.uniform2f(u('uP0'), p0[0], p0[1]);
    gl.uniform2f(u('uStep'), step, step);
    gl.uniform1f(u('uLod'), lod);
    gl.viewport(0, 0, 64, 64);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Float32Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.FLOAT, px);
    let worst = 0, worstAt = null, sum = 0, n = 0, maxAbs = 0;
    const errs = [];
    for (let i = 0; i < 64 * 64; i++) {
      const gy = px[i * 4], x = px[i * 4 + 1], z = px[i * 4 + 2];
      // heightAt adds the horizon bend, groundYFlat does not
      const js = S.heightAt(x, z, lod) + (x * x + z * z) / (2 * U.uPlanetR.value);
      const d = Math.abs(js - gy);
      sum += d; n++; errs.push(d);
      maxAbs = Math.max(maxAbs, Math.abs(gy));
      if (d > worst) { worst = d; worstAt = [x, z, gy, js]; }
    }
    errs.sort((a, b) => a - b);
    out.push({ lod, mean: sum / n, median: errs[n >> 1], p90: errs[(n * 0.9) | 0],
      worst, worstAt, range: maxAbs });
  }
  return { out };
});

console.log(JSON.stringify(res, null, 2));
await browser.close();
