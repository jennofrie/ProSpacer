// Interaction test: drives the real input path (keys, mouse, clicks) and
// asserts that flight, scanning, fold drive and system jump actually work.
import { chromium } from 'playwright';
import { bootGame } from './boot.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1600), H = +opt('h', 900);
const MOBILE = opt('mobile', '0') === '1';
fs.mkdirSync('shots', { recursive: true });

const results = [];
const check = (name, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
  isMobile: MOBILE, hasTouch: MOBILE,
});
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page);

const G = (fn) => page.evaluate(fn);

// ---------------------------------------------------------- take the helm
// The game now starts on foot in the habitat, so every flight assertion has to
// be preceded by actually walking to the seat and sitting in it.
check('starts on foot in the cabin', await G(() => window.__game.mode === 'walk'));
await G(() => {
  const g = window.__game;
  const st = g.interior.stations.find((x) => x.id === 'seat');
  g.player.pos.set(st.pos.x, 0, st.pos.z);
  g.player.yaw = 0;
});
await page.waitForTimeout(400);
check('helm station is in reach', await G(() => window.__game.player.station?.id === 'seat'));
await page.keyboard.press('e');
await page.waitForTimeout(1300);
check('sitting takes the helm', await G(() => window.__game.mode === 'pilot'));

// ---------------------------------------------------------------- throttle
await page.keyboard.down('w');
await page.waitForTimeout(1400);
await page.keyboard.up('w');
await page.waitForTimeout(900);
let s = await G(() => ({ thr: window.__game.ship.throttle, spd: window.__game.ship.speed }));
check('throttle responds to W', s.thr > 0.5, `throttle=${s.thr.toFixed(2)}`);
check('ship accelerates', s.spd > 5, `speed=${s.spd.toFixed(1)} km/s`);

// ---------------------------------------------------------------- rotation
const q0 = await G(() => window.__game.ship.quat.toArray());
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(700);
await page.keyboard.up('ArrowLeft');
const q1 = await G(() => window.__game.ship.quat.toArray());
check('yaw responds', q0.some((v, i) => Math.abs(v - q1[i]) > 0.01));

await page.keyboard.down('q');
await page.waitForTimeout(600);
await page.keyboard.up('q');
const q2 = await G(() => window.__game.ship.quat.toArray());
check('roll responds', q1.some((v, i) => Math.abs(v - q2[i]) > 0.01));

// ---------------------------------------------------------------- braking
await page.keyboard.press('x');
await page.waitForTimeout(700);
s = await G(() => window.__game.ship.speed);
check('full stop (X) works', s < 3, `speed=${s.toFixed(2)}`);

// ---------------------------------------------------------------- scanning
await G(() => {
  const g = window.__game;
  g.pose({ kind: 'terran', dist: 3.0, phase: 45, elev: 6 });
  // The rotation assertions above deliberately leave angular momentum in the
  // ship. A reproducible scan pose must stop that motion or the target drifts
  // off the reticle while F is held, testing inertia instead of scanning.
  g.ship.angVel.set(0, 0, 0);
});
await page.waitForTimeout(600);
const aimed = await G(() => !!window.__game.aimTarget());
check('reticle acquires a target', aimed);
await page.keyboard.down('f');
await page.waitForTimeout(1200);
const scanMid = await G(() => {
  const g = window.__game;
  const t = g.target;
  return {
    progress: g.scanProgress || 0,
    held: g.input.held('scan'),
    aimed: g.aimed?.name,
    target: t?.name,
    scanTarget: g.scanTarget?.name,
    distance: t ? t.absPos.distanceTo(g.ship.absPos) : 0,
    range: t ? g.scanRangeFor(t) + (t.radius || 0) : 0,
  };
});
// Shader warm-up can temporarily make simulated time advance more slowly than
// wall time because the runtime caps oversized frame deltas. Wait on the game
// state with a ceiling instead of assuming 3.2 wall-clock seconds is enough.
await page.waitForFunction(
  () => window.__game.discoveries.size > 0,
  { timeout: 9000, polling: 100 },
).catch(() => null);
await page.keyboard.up('f');
const scan = await G(() => ({
  n: window.__game.discoveries.size,
  name: [...window.__game.bodies].find((b) => b.scanned)?.name,
}));
check('scan completes', scan.n > 0,
  `${scan.n} discovery: ${scan.name}; mid=${JSON.stringify(scanMid)}`);

// ---------------------------------------------------------------- archive
await page.keyboard.press('Tab');
await page.waitForTimeout(500);
const archiveOpen = await G(() => window.__game.archive.open
  && document.querySelectorAll('#archiveNav .cx-item').length);
check('archive opens and lists entries', archiveOpen > 3, `${archiveOpen} entries`);
await page.screenshot({ path: 'shots/x-archive.png' });
await page.keyboard.press('Tab');
await page.waitForTimeout(400);

// ---------------------------------------------------------------- fold
// point *away* from the target so it does not arrive and auto-drop mid-measure
await G(() => {
  const g = window.__game;
  g.pose({ kind: 'gas', dist: 40, phase: 40, elev: 10 });
  g.ship.quat.setFromAxisAngle({ x: 0, y: 1, z: 0, isVector3: true }, Math.PI);
  g.camQuat.copy(g.ship.quat);
});
await page.waitForTimeout(500);
await page.keyboard.press('j');
await page.waitForTimeout(2600);
const fold = await G(() => ({ on: window.__game.ship.foldMode, spd: window.__game.ship.speed }));
check('fold drive engages', fold.on && fold.spd > 500, `speed=${Math.round(fold.spd)} km/s`);
await page.screenshot({ path: 'shots/x-fold.png' });
await page.keyboard.press('j');
await page.waitForTimeout(600);
check('fold drive disengages', !(await G(() => window.__game.ship.foldMode)));

// ---------------------------------------------------------------- star map
await page.keyboard.press('m');
await page.waitForTimeout(700);
check('star map opens', await G(() => window.__game.starmap.open));
await page.screenshot({ path: 'shots/x-map.png' });
const jumped = await page.evaluate(async () => {
  const g = window.__game;
  const from = g.currentSystemId;
  const to = g.galaxy.findIndex((x) => x.id !== from);
  // The chart is a hologram over the nav table now, not an HTML panel: pick a
  // system and confirm, the same path the J key takes.
  g.starmap.sel = to;
  g.ship.foldCharge = 1;
  g.starmap.confirm();
  await new Promise((r) => setTimeout(r, 4500));
  return { from, now: g.currentSystemId, name: g.system.star.name, bodies: g.bodies.length };
});
check('hyperjump to another system', jumped.now !== jumped.from,
  `${jumped.from} -> ${jumped.now} (${jumped.name}, ${jumped.bodies} bodies)`);
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/x-jumped.png' });

// ---------------------------------------------------------------- collision
const coll = await page.evaluate(async () => {
  const g = window.__game;
  const b = g.bodies.find((x) => x.kind === 'planet');
  g.ship.absPos.copy(b.absPos);           // teleport inside the planet
  g.ship.vel.set(0, 0, 0);
  await new Promise((r) => setTimeout(r, 700));
  return { d: g.ship.absPos.distanceTo(b.absPos), r: b.radius };
});
check('collision pushes ship out of a world', coll.d >= coll.r * 1.0,
  `dist=${Math.round(coll.d)} radius=${Math.round(coll.r)}`);

// ---------------------------------------------------------------- perf
await G(() => { const g = window.__game; g.pose({ kind: 'terran', dist: 2.6, phase: 45, elev: 8 }); g.ship.throttle = 1; });
await page.waitForTimeout(3500);
const perf = await G(() => ({
  fps: window.__game.engine.fps, px: window.__game.engine.pixelRatio,
  calls: window.__game.engine.drawCalls,
}));
check('holds frame rate', perf.fps >= 55,
  `${perf.fps.toFixed(0)} fps @ ${perf.px.toFixed(2)}x, ${perf.calls} draws`);

console.log(results.join('\n'));
if (errs.length) { console.log('--- console errors ---'); console.log([...new Set(errs)].slice(0, 12).join('\n')); }
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);

/* A failure here is very often not a failure. This suite is stateful — every
   assertion builds on the last — so a hot reload part-way through throws away
   the ship, the system and the player, and everything after it fails for a
   reason that has nothing to do with the code under test. Say so, loudly,
   rather than leaving someone to chase eleven phantom regressions. */
if (failed) {
  const live = await page.evaluate(() => !!(window.__game && window.__game.started)
    && document.getElementById('boot').style.display === 'none').catch(() => false);
  if (!live) {
    console.log('\n!! the page reloaded during the run — the dev server hot-reloaded on a');
    console.log('!! source edit. These failures are not real. Re-run on a quiet tree.');
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
