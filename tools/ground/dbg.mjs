/* Scratch: same mountain pose, once per terrain debug channel. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { bootGame } from '../boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', '/tmp/dbg/x');
const WORLD = opt('world', 'desert');
const ELEV = +opt('elev', 0.30);
const RANGE = +opt('range', 1400);
const MODES = opt('modes', '0,1,2,3,4,5,6').split(',').map(Number);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({
  viewport: { width: +opt('w', 1512), height: +opt('h', 850) },
  deviceScaleFactor: +opt('dpr', 1),
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await page.goto('http://localhost:5173/' + (opt('q', null) ? '?q=' + opt('q') : ''), { waitUntil: 'domcontentloaded' });
await bootGame(page, { setup: '1' });

await bootGame(page, {
  setup: `(()=>{
    const g = window.__game;
    g.director.stop(); g.inspect({off:true});
    if (g.landed) { try { delete g.landed.t; } catch(e){} g.liftOff({now:true}); }
    g.mode='exterior';
    g.pose({kind:${JSON.stringify(WORLD)}, dist:1.6, phase:70, elev:8});
    g.land(g.target, {now:true}); g.director.stop();
    g.setSunElevation(${ELEV});
    const T = g.landed.t;
    Object.defineProperty(g.landed, 't', { get:()=>T, set:()=>{}, configurable:true });
    g.setLayer('hud', false);
    g.disembark();
    let best = null;
    for (let i = 0; i < 180; i++) {
      const a = i / 180 * Math.PI * 2;
      for (const R of [2500, 4000, 6000]) {
        const x = Math.cos(a) * R, z = Math.sin(a) * R;
        const y = g.surface.heightAt(x, z, 2.0);
        if (!best || y > best.y) best = { a, R, x, z, y };
      }
    }
    const d = Math.hypot(best.x, best.z);
    const k = Math.max(0, (d - ${RANGE})) / d;
    g.player.pos.set(best.x*k, 0, best.z*k);
    g.player.groundY = g.player.groundHeight(g.player.pos.x, g.player.pos.z);
    g.player.yaw = Math.atan2(best.x - g.player.pos.x, best.z - g.player.pos.z) + Math.PI;
    g.player.pitch = 0.06;
    return 1;
  })()`,
  settle: 3000,
});

for (const m of MODES) {
  await page.evaluate(`window.__game.surface.U.uDbg.value = ${m};`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/dbg${m}.png` });
}
await browser.close();
