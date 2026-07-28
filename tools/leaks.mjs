// Find holes in the hull.
//
// The exterior scene is hidden and its clear colour set to magenta, so the only
// way magenta reaches the frame is through a gap in the interior geometry. The
// canopy is legitimately transparent, so the cockpit is expected to leak; every
// other station should come back clean.
//
//   node tools/leaks.mjs [--save]
import { chromium } from 'playwright';
import fs from 'node:fs';

const SAVE = process.argv.includes('--save');
const OUT = 'shots/leaks';
if (SAVE) fs.mkdirSync(OUT, { recursive: true });

// [name, x, z, yaw, pitch, expectLeak]
const SPOTS = [
  ['habitat-aft', 0, 6.4, Math.PI, 0, false],
  ['habitat-aft-up', 0, 6.4, Math.PI, 0.5, false],
  ['habitat-aft-down', 0, 6.4, Math.PI, -0.5, false],
  ['habitat-fwd', 0, 2.0, 0, 0, true],   // canopy visible down the axis
  ['habitat-left', 0, 3.5, -Math.PI / 2, 0, false],
  ['habitat-right', 0, 3.5, Math.PI / 2, 0, false],
  ['habitat-up', 0, 3.5, 0, 1.2, false],
  ['chamber', 0, 5.6, Math.PI, 0, false],
  ['corridor-mid', 0, -1.4, 0, 0, true],  // canopy down the axis
  ['corridor-up', 0, -1.4, 0, 1.2, false],
  ['corridor-aft', 0, -1.4, Math.PI, 0, false],
  ['cockpit-fwd', 0, -4.4, 0, 0, true],       // canopy: leak is correct here
  ['cockpit-aft', 0, -5.0, Math.PI, 0, false],
  ['cockpit-up', 0, -5.0, 0, 1.2, true],      // glass overhead: the canopy wraps the roof
  ['nose-down', 0, -6.5, 0, -0.7, true],  // through the canopy
];

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootStart'); return b && !b.hidden;
}, { timeout: 120000 });
await page.click('#bootStart');
await page.waitForTimeout(1800);

await page.evaluate(() => {
  const g = window.__game;
  g.scene.background = null;
  g.scene.visible = false;                       // nothing outside but the clear
  g.renderer.setClearColor(0xff00ff, 1);
  document.getElementById('hud').style.display = 'none';
});

let bad = 0;
for (const [name, x, z, yaw, pitch, expect] of SPOTS) {
  await page.evaluate(([x, z, yaw, pitch]) => {
    const g = window.__game;
    g.mode = 'walk';
    g.player.mode = 'walk';
    g.player.pos.set(x, 0, z);
    g.player.yaw = yaw; g.player.pitch = pitch;
    g.player.vel.set(0, 0, 0);
  }, [x, z, yaw, pitch]);
  await page.waitForTimeout(500);

  if (SAVE) await page.screenshot({ path: `${OUT}/${name}.png` });
  // Read the composited render target, not the canvas. A WebGL canvas has
  // undefined contents once it has been composited unless preserveDrawingBuffer
  // is set, so drawImage off it returns black and every test "passes".
  const pct = await page.evaluate(() => {
    const e = window.__game.engine;
    const rt = e.post.ldr;
    const w = rt.width, h = rt.height;
    const buf = new Uint8Array(w * h * 4);
    e.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    let n = 0, total = 0;
    for (let i = 0; i < buf.length; i += 4 * 7) {   // sparse sample
      total++;
      // magenta survives the tonemap as strong R and B with a weak G
      if (buf[i] > 80 && buf[i + 2] > 80 && buf[i + 1] < buf[i] * 0.6) n++;
    }
    return (100 * n) / Math.max(1, total);
  });

  const leaking = pct > 0.4;
  const ok = leaking === expect;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'LEAK'}  ${name.padEnd(18)} magenta=${pct.toFixed(2)}%${expect ? '  (canopy, expected)' : ''}`);
}
console.log(bad ? `\n${bad} unexpected result(s)` : '\nno unexpected leaks');
await browser.close();
