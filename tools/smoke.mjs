// Boot-and-fly smoke test against any URL — the production bundle, or the
// deployed site. Minification and asset-path rewriting break things the dev
// server never shows, so this runs against the built artifact, not the source.
//
//   node tools/smoke.mjs [url]        default http://localhost:4173/
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:4173/';

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

const errs = [];
const failed = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootStart'); return b && !b.hidden;
}, { timeout: 120000 });
await page.click('#bootStart');
await page.waitForTimeout(4000);

const boot = await page.evaluate(() => ({
  fps: +window.__game.engine.fps.toFixed(0),
  mode: window.__game.mode,
  bodies: window.__game.bodies.length,
  draws: window.__game.engine.drawCalls,
}));

// Take the helm and put some throttle in, so the flight path is exercised too.
// You wake up in the habitat, a cabin away from the seat, so E does nothing
// until the player is actually stood at the station.
await page.evaluate(() => {
  const g = window.__game;
  const st = g.interior.stations.find((x) => x.id === 'seat');
  g.player.pos.set(st.pos.x, 0, st.pos.z);
  g.player.yaw = 0;
});
await page.waitForTimeout(500);
await page.keyboard.press('e');
await page.waitForTimeout(1300);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1800);
await page.keyboard.up('KeyW');

const fly = await page.evaluate(() => ({
  mode: window.__game.mode,
  speed: +window.__game.ship.speed.toFixed(1),
  fps: +window.__game.engine.fps.toFixed(0),
}));

console.log(`url    : ${URL}`);
console.log(`boot   : fps=${boot.fps} mode=${boot.mode} bodies=${boot.bodies} draws=${boot.draws}`);
console.log(`fly    : mode=${fly.mode} speed=${fly.speed} km/s fps=${fly.fps}`);
console.log(`console: ${errs.length ? [...new Set(errs)].slice(0, 6).join(' | ') : 'clean'}`);
console.log(`network: ${failed.length ? [...new Set(failed)].slice(0, 8).join(' | ') : 'clean'}`);

const ok = boot.bodies > 0 && fly.mode === 'pilot' && fly.speed > 0 && !failed.length;
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
