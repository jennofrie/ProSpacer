// Capture the social-embed art straight out of the running game.
//
// The whole game is procedural, so there is no art to ship as a file — the
// honest splash image is a real frame. This boots the game, parks the ship at
// the helm looking at a world, hides the screen-space overlay so nothing
// transient ends up baked into a permanent image, and shoots at OG size.
//
//   node tools/splash.mjs [--w 1200] [--h 630] [--out public/og.png]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1200), H = +opt('h', 630);
const OUT = opt('out', 'public/og.png');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
// deviceScaleFactor 2 so the image is crisp when a card renders it large.
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootStart'); return b && !b.hidden;
}, { timeout: 90000 });
await page.click('#bootStart');
await page.waitForTimeout(2000);

const POSE = args.includes('--pose');

await page.evaluate((pose) => {
  const g = window.__game;
  g.ship.throttle = 0; g.ship.vel.set(0, 0, 0);

  // Optionally park against a world at a lit angle. A phase near 60 degrees
  // puts the terminator in frame, which is far more dramatic than the flat
  // fully-lit disc you get looking straight down the sun line.
  if (pose) g.pose({ kind: 'terran', dist: 3.0, phase: 58, elev: 10 });

  // Sit at the helm, looking out of the canopy.
  const st = g.interior.stations.find((x) => x.id === 'seat');
  g.player.mode = 'walk';
  g.player.sit(st);
  g.player._t = 1; g.player.mode = 'seated';
  g.player.yaw = st.seatYaw;
  g.player.pitch = -0.055;          // a touch of sky over the glare shield
  g.mode = 'pilot';
  g.player.autoHead = null;
  g.player.freeLook = true;
  g.input.keys.add('look');

  // The overlay is state, not art: a directive card or a half-faded log line
  // would be frozen into the image forever.
  document.getElementById('hud').style.display = 'none';
}, POSE);
await page.waitForTimeout(2600);   // let exposure settle and screens finish booting

await page.screenshot({ path: OUT });
const st = await page.evaluate(() => ({
  fps: +window.__game.engine.fps.toFixed(0),
  sys: window.__game.system?.name,
}));
console.log(`wrote ${OUT}  ${W}x${H}@2  fps=${st.fps}  system=${st.sys}`);
await browser.close();
