// Interior tour: boots once and photographs the cabin from fixed stations.
//   node tools/tour.mjs [--w 1600] [--h 900] [--only name]
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1600), H = +opt('h', 900);
const ONLY = opt('only', null);
const outDir = opt('out', 'shots/interior');
fs.mkdirSync(outDir, { recursive: true });

// pos = [x, z] in metres, yaw in radians (PI = looking aft, 0 = looking forward)
const SHOTS = [
  { name: 'a-wake', pos: [0, 2.0], yaw: Math.PI * 0.0, pitch: 0.0, note: 'habitat looking forward' },
  { name: 'b-navtable', pos: [0, 0.9], yaw: Math.PI, pitch: -0.10, note: 'nav table' },
  { name: 'c-corridor', pos: [0, -1.6], yaw: 0, pitch: 0.0, note: 'corridor toward the cockpit' },
  // Was parked inside the pilot seat, which filled the frame with upholstery.
  { name: 'd-cockpit', pos: [0, -3.7], yaw: 0, pitch: -0.05, note: 'entering the cockpit' },
  { name: 'd2-seat', pos: [0.62, -3.75], yaw: -0.45, pitch: -0.20, note: 'the pilot seat, 3/4' },
  { name: 'e-seated', seat: true, note: 'at the helm' },
  { name: 'f-seated-look', seat: true, yawOff: -0.7, pitch: -0.28, note: 'helm, looking down-left' },
  { name: 'f2-console', seat: true, yawOff: 0, pitch: -0.62, note: 'helm, looking at the console' },
  { name: 'g-archive', pos: [-0.8, 0.95], yaw: -Math.PI / 2, pitch: 0.02, note: 'archive terminal' },
  { name: 'h-chamber', pos: [0, 5.6], yaw: Math.PI, pitch: 0.03, note: 'resonance chamber' },
  { name: 'i-port', pos: [1.0, 4.3], yaw: Math.PI / 2, pitch: 0.0, note: 'observation port' },
  { name: 'j-aft', pos: [0, -3.0], yaw: Math.PI, pitch: 0.0, note: 'corridor looking aft' },
];

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => { const b = document.getElementById('bootStart'); return b && !b.hidden; }, { timeout: 90000 });
await page.click('#bootStart');
await page.waitForTimeout(1600);

const report = [];
for (const s of SHOTS) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  await page.evaluate((sh) => {
    const g = window.__game;
    g.ship.throttle = 0; g.ship.vel.set(0, 0, 0);
    if (sh.seat) {
      const st = g.interior.stations.find((x) => x.id === 'seat');
      g.player.mode = 'walk';
      g.player.sit(st);
      g.player._t = 1; g.player.mode = 'seated';
      g.player.yaw = st.seatYaw + (sh.yawOff || 0);
      g.player.pitch = sh.pitch ?? -0.09;
      g.mode = 'pilot';
      g.player.autoHead = null;
      g.player.freeLook = true;   // hold the head where the shot wants it
      g.input.keys.add('look');
    } else {
      g.player.mode = 'walk';
      g.mode = 'walk';
      g.player.pos.set(sh.pos[0], 0, sh.pos[1]);
      g.player.yaw = sh.yaw;
      g.player.pitch = sh.pitch || 0;
      g.player.vel.set(0, 0, 0);
    }
  }, s);
  await page.waitForTimeout(s.settle || 1400);
  await page.screenshot({ path: `${outDir}/${s.name}.png` });
  const st = await page.evaluate(() => ({
    fps: +window.__game.engine.fps.toFixed(0),
    calls: window.__game.engine.drawCalls,
    tris: window.__game.engine.triangles,
    mode: window.__game.mode,
  }));
  report.push(`${s.name.padEnd(16)} fps=${String(st.fps).padStart(3)} calls=${String(st.calls).padStart(4)} tris=${String(Math.round(st.tris / 1000)).padStart(4)}k  ${st.mode.padEnd(8)} ${s.note}`);
}
console.log(report.join('\n'));
if (logs.length) { console.log('--- errors ---'); console.log([...new Set(logs)].slice(0, 12).join('\n')); }
await browser.close();
