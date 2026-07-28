/* Is the AO's depth reconstruction actually right?
 *
 * The renderer writes two different depth encodings in one frame — the world
 * and the ground scene use three's logarithmic buffer, the cabin is a second
 * pass on the ordinary projection curve — and PostFX normalises both into one
 * linear view-space Z buffer before the occlusion pass ever runs. A mistake
 * there does not throw and does not look like a mistake: you get occlusion
 * that is plausible in one scene and inverted or missing in another.
 *
 * So it is checked against arithmetic instead of against a screenshot. For a
 * scattering of pixels this fires a raycast at the same pixel, takes the hit
 * point, transforms it into view space, and compares -z against what came back
 * out of the linear-depth target. Anything over a fraction of a percent means
 * the inversion is wrong.
 *
 *   node tools/aocheck.mjs [--w 1512] [--h 945] [--dpr 2]
 */
import { chromium } from 'playwright';
import { bootGame } from './boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1512), H = +opt('h', 945), DPR = +opt('dpr', 2);

// Each case: set the camera up, then say which object to raycast and with
// which camera.
//
// The point of three cases is that this renderer carries *two* depth encodings
// and the AO pass has to reconstruct linear depth from either. `space` is the
// logarithmic buffer, which the floating origin needs; `cabin` and `ground` are
// both projection depth. The ground used to be logarithmic too and no longer
// is — it spans about 6 m to 26 km, which a 24-bit buffer holds comfortably,
// and log depth writes gl_FragDepth in every fragment, which kills early-Z.
// Keep at least one case on each encoding or this gate stops testing the thing
// it exists to test.
const CASES = [
  {
    name: 'space (log depth, km)', target: 'g.ship.object', cam: 'g.camera',
    js: `g.director.stop(); g.inspect({off:true}); if(g.landed) g.liftOff({now:true}); g.mode='exterior';
         g.ship.object.visible = true;
         g.pose({kind:'terran', dist:2.6, phase:78, elev:8});
         g.inspect({dist:1.05, az:216, el:14, fov:32});`,
  },
  {
    name: 'cabin (projection depth, m)', target: 'g.interior.root', cam: 'g.interiorCam',
    js: `g.director.stop(); g.inspect({off:true}); if(g.landed) g.liftOff({now:true});
         g.pose({kind:'terran', dist:2.4, phase:70, elev:6});
         Object.defineProperty(g.player,'freeLook',{get:()=>true,set:()=>{},configurable:true});
         g.player.mode='walk'; g.mode='walk';
         g.player.pos.set(0.15, 0, 1.2); g.player.yaw = 3.05; g.player.pitch = -0.10;`,
  },
  {
    name: 'ground (projection depth, m)', target: 'g.ship.object', cam: 'g.camera',
    js: `g.director.stop(); g.inspect({off:true}); if(g.landed) g.liftOff({now:true});
         g.pose({kind:'terran',dist:1.6,phase:70,elev:8});
         g.land(g.target, {now:true}); g.director.stop(); g.setSunElevation(0.34); g.disembark();
         Object.defineProperty(g.player,'freeLook',{get:()=>true,set:()=>{},configurable:true});
         g.player.yaw = Math.atan2(g.player.pos.x, g.player.pos.z);
         g.player.pitch = -0.06;`,
  },
];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page, { settle: 800 });

let worst = 0;
for (const c of CASES) {
  let rows = [], dropped = 0;
  // The dev server hot-reloads on any source edit, which throws the game back
  // to spawn mid-case: the set-up is gone, the camera is somewhere else, and
  // every ray misses. That reads as a failure and is not one.
  for (let attempt = 0; attempt < 4 && !rows.length; attempt++) {
    await page.evaluate(`(()=>{ const g = window.__game; ${c.js} })()`);
    await page.waitForTimeout(2500);
    rows = await page.evaluate(`(async () => {
    const g = window.__game, e = g.engine;
    const cam = ${c.cam}, obj = ${c.target};
    const THREE = await import('/node_modules/three/build/three.module.js');
    const rc = new THREE.Raycaster();
    // The cabin lives on its own object layer, and a Raycaster only tests
    // layer 0 — without this it silently finds nothing inside the hull.
    rc.layers.enableAll();
    // A ray hits geometry; a depth buffer holds only what wrote depth. Glass,
    // holographic panels and additive decals are hit by one and absent from
    // the other, and comparing those two is a bug in the check, not in the
    // renderer.
    const shown = (o) => {
      for (let n = o; n; n = n.parent) if (!n.visible) return false;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      return !!m && m.depthWrite !== false && m.transparent !== true;
    };
    const Wp = e.renderer.domElement.width, Hp = e.renderer.domElement.height;
    const out = [];
    let dropped = 0;
    // A grid of candidate pixels; keep the ones whose ray actually hits.
    for (let gy = 1; gy < 8 && out.length < 8; gy++){
      for (let gx = 1; gx < 8 && out.length < 8; gx++){
        // Odd pixels: the linear-depth buffer is half resolution and each of
        // its texels carries the odd full-res texel's depth, so the ray has to
        // go through exactly that pixel or the comparison is against a
        // neighbour and every oblique surface looks like an error.
        const px = Math.floor(Wp * gx / 8) | 1, py = Math.floor(Hp * gy / 8) | 1;
        const ndcx = (px + 0.5) / Wp * 2 - 1, ndcy = (py + 0.5) / Hp * 2 - 1;
        rc.setFromCamera({ x: ndcx, y: ndcy }, cam);
        // Stowed gear and swapped-out LODs are still in the graph and are still
        // raycastable; only what was actually drawn can be in the depth buffer.
        const hit = rc.intersectObject(obj, true).find((h) => shown(h.object));
        if (!hit) continue;
        const p = hit.point.clone().applyMatrix4(cam.matrixWorldInverse);
        const want = -p.z;
        const got = e.post.readLinearDepth(px, py);
        /* A ray hits the object it was told to test; the depth buffer holds
           whatever was actually nearest. On the ground those differ, because
           the terrain has relief in front of the hull now — it used to be held
           flat to the datum for 110 m around the ship, so nothing was ever in
           front of anything and the question never came up.

           Dropping every disagreement would let this gate pass by dropping all
           of its samples, so the drop is *verified* rather than assumed: the
           buffer value is reconstructed back to a world point and the height
           field is asked whether that point is on the ground. If it is, the
           buffer is right and the raycast was simply looking through a hill.
           Anything else is still counted as an error. */
        let onGround = false;
        if (g.landed && g.surface && got < want - 0.05) {
          const tx = Math.tan(cam.fov * Math.PI / 360);
          const vp = new THREE.Vector3(ndcx * tx * cam.aspect * got, ndcy * tx * got, -got)
            .applyMatrix4(cam.matrixWorld);
          g.surface.root.worldToLocal(vp);
          const gy2 = g.surface.heightAt(vp.x, vp.z, 0.5);
          // one metre: the mesh interpolates linearly between rings and the
          // field does not, and the two are checked to millimetres by
          // tools/fieldcheck.mjs, so anything inside this is the same surface
          onGround = Math.abs(vp.y - gy2) < 1.0;
        }
        if (onGround) { dropped++; continue; }
        out.push({ px, py, want: +want.toPrecision(8), got: +got.toPrecision(8),
                   err: +(Math.abs(got - want) / Math.max(want, 1e-12) * 100).toPrecision(3) });
      }
    }
    // as an object: a property hung on an array does not survive serialisation,
    // and the drop count is the safeguard against this gate passing by
    // discarding every sample it took
    return { rows: out, dropped };
  })()`);
    dropped = rows.dropped || 0; rows = rows.rows || [];
    if (!rows.length) console.log(`[aocheck] ${c.name}: no ray hits, retrying`);
  }
  if (!rows.length) { console.log(`${c.name}: NO RAY HITS — check the setup`); worst = 999; continue; }
  const maxErr = Math.max(...rows.map((r) => r.err));
  worst = Math.max(worst, maxErr);
  console.log(`\n${c.name}   worst error ${maxErr.toFixed(4)}%   (${rows.length} pixels`
    + `${dropped ? `, ${dropped} occluded by verified terrain` : ''})`);
  for (const r of rows) {
    console.log(`  (${String(r.px).padStart(4)},${String(r.py).padStart(4)})  raycast ${String(r.want).padEnd(13)} buffer ${String(r.got).padEnd(13)} ${r.err.toFixed(4)}%`);
  }
}
console.log(`\n${worst < 0.5 ? 'PASS' : 'FAIL'}  worst reconstruction error across all scenes: ${worst.toFixed(4)}%`);
await browser.close();
process.exit(worst < 0.5 ? 0 : 1);
