/* Scratch: land, find the biggest relief within a few km, stand a set distance
   from it and shoot it. For chasing the banding artifact on mountain flanks.
   node tools/ground/mtn.mjs --out /tmp/mtn/base --world terran --elev 0.30 --range 2600 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { bootGame } from '../boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', '/tmp/mtn/x');
const WORLDS = opt('world', 'terran').split(',');
const ELEVS = opt('elev', '0.30').split(',').map(Number);
const RANGES = opt('range', '2600').split(',').map(Number);
const TAG = opt('tag', '');
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
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page, { setup: '1' });

for (const WORLD of WORLDS) {
  for (const ELEV of ELEVS) {
    const info = await bootGame(page, {
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
        // find the highest ground on a ring 4 km out
        let best = null;
        for (let i = 0; i < 180; i++) {
          const a = i / 180 * Math.PI * 2;
          for (const R of [2500, 4000, 6000]) {
            const x = Math.cos(a) * R, z = Math.sin(a) * R;
            const y = g.surface.heightAt(x, z, 2.0);
            if (!best || y > best.y) best = { a, R, x, z, y };
          }
        }
        g.__mtn = best;
        return { world:g.landed.body.name, type:g.landed.body.spec.type, peak:best };
      })()`,
      settle: 2500,
    });
    console.log(WORLD, ELEV, JSON.stringify(info.peak));
    for (const RANGE of RANGES) {
      await page.evaluate(`(()=>{ const g=window.__game; const m=g.__mtn;
        const d = Math.hypot(m.x, m.z);
        const k = Math.max(0, (d - ${RANGE})) / d;
        g.player.pos.set(m.x*k, 0, m.z*k);
        g.player.groundY = g.player.groundHeight(g.player.pos.x, g.player.pos.z);
        g.player.yaw = Math.atan2(m.x - g.player.pos.x, m.z - g.player.pos.z) + Math.PI;
        g.player.pitch = 0.06;
      })()`);
      await page.waitForTimeout(1800);
      const t = `${TAG}${WORLD}-${String(ELEV).replace('.', 'p')}-r${RANGE}`;
      await page.screenshot({ path: `${OUT}/${t}.png` });
    }
  }
}
await browser.close();
