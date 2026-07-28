/* Where the landed frame goes, by subtraction, at one pinned pose.
 *
 * Same pinning as gndperf: resolution held, `adapt` stubbed, vsync off,
 * `landed.t` a non-writable getter. Each row hides one thing and re-measures;
 * the difference is that thing's cost, and only differences taken inside one
 * run mean anything on a loaded machine.
 *
 *   node tools/gndattr.mjs [--dpr 2 --w 1512 --h 945] [--trials 6]
 */
import { chromium } from 'playwright';
import { bootGame } from './boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
const W = opt('w', 1512), H = opt('h', 945), DPR = opt('dpr', 2), TRIALS = opt('trials', 6);

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-gpu-vsync', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page);
await page.waitForTimeout(4000);
await page.evaluate(`(()=>{ const g = window.__game;
  g.director.stop(); g.inspect({off:true}); if (g.landed) g.liftOff({now:true}); g.mode='exterior';
  g.pose({kind:'terran', dist:1.6, phase:70, elev:8});
  g.land(g.target, {now:true}); g.director.stop();
  const e = g.engine; e.prFloor = e.prCeil = e.maxPixelRatio = ${DPR}; e.adapt = () => {};
  g.landed.t = 42.0; g.updateSurface(0.001);
  const T = g.landed.t;
  Object.defineProperty(g.landed, 't', { get:()=>T, set:()=>{}, configurable:true });
  return 1; })()`);
await page.waitForTimeout(3000);

const sample = async () => page.evaluate(() => new Promise((res) => {
  const t = []; let last = performance.now();
  const t0 = performance.now();
  const step = () => {
    const n = performance.now(); t.push(n - last); last = n;
    if (n - t0 < 1100) requestAnimationFrame(step);
    else { t.sort((a, b) => a - b); res(t[t.length >> 1]); }
  };
  requestAnimationFrame(step);
}));
const measure = async (js) => {
  await page.evaluate(`(()=>{ const g = window.__game; ${js} })()`);
  await page.waitForTimeout(800);
  let best = 1e9;
  for (let k = 0; k < TRIALS; k++) best = Math.min(best, await sample());
  return best;
};

const R = (n) => `g.surface.rocks.find(m=>m.name===${JSON.stringify(n)})`;
const CASES = [
  ['baseline', '1', '1'],
  ['terrain mesh hidden', 'g.surface.terrain.visible=false', 'g.surface.terrain.visible=true'],
  ['terrain does not cast', 'g.surface.terrain.castShadow=false; g.renderer.shadowMap.needsUpdate=true',
    'g.surface.terrain.castShadow=true; g.renderer.shadowMap.needsUpdate=true'],
  ['cobble does not cast', `${R('cobble')}.castShadow=false; g.renderer.shadowMap.needsUpdate=true`,
    `${R('cobble')}.castShadow=true; g.renderer.shadowMap.needsUpdate=true`],
  ['boulder+outcrop do not cast',
    `${R('boulder')}.castShadow=false; ${R('outcrop')}.castShadow=false; g.renderer.shadowMap.needsUpdate=true`,
    `${R('boulder')}.castShadow=true; ${R('outcrop')}.castShadow=true; g.renderer.shadowMap.needsUpdate=true`],
  ['all scatter hidden', 'g.surface.rocks.forEach(m=>m.visible=false)',
    'g.surface.rocks.forEach(m=>m.visible=true)'],
  ['sun casts nothing', 'g.sunLight.castShadow=false; g.renderer.shadowMap.needsUpdate=true',
    'g.sunLight.castShadow=true; g.renderer.shadowMap.needsUpdate=true'],
];

console.log(`${W}x${H} @${DPR}x = ${((W * DPR * H * DPR) / 1e6).toFixed(2)} MP, min of ${TRIALS}`);
let base = 0;
for (const [name, on, off] of CASES) {
  const ms = await measure(on);
  if (name === 'baseline') base = ms;
  console.log(`  ${name.padEnd(30)} ${ms.toFixed(2)} ms`
    + (name === 'baseline' ? '' : `   (${(base - ms >= 0 ? '-' : '+')}${Math.abs(base - ms).toFixed(2)} ms)`));
  await page.evaluate(`(()=>{ const g = window.__game; ${off} })()`);
}
await browser.close();
