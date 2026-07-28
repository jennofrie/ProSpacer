/* A fixed set of surface frames, so two runs are comparable.
   node tools/ground/hero.mjs --out /tmp/hero/r1 [--world terran] [--elev 0.34] */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { bootGame } from '../boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', '/tmp/hero/x');
const WORLDS = opt('world', 'terran,desert,ice,barren').split(',');
const ELEV = +opt('elev', 0.34);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({
  viewport: { width: +opt('w', 1600), height: +opt('h', 900) },
  deviceScaleFactor: +opt('dpr', 2),
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page, { setup: '1' });

/* Four framings a photographer would actually take, chosen so that between them
   they exercise everything: near ground under the boots, a mid-distance mass,
   the skyline, the sky on its own, and the ship as the scale witness. */
const POSES = [
  ['a-vista', `g.player.pos.set(120,0,190); g.player.yaw = 2.30; g.player.pitch = -0.05;`],
  ['b-near', `g.player.pos.set(60,0,90); g.player.yaw = 1.05; g.player.pitch = -0.30;`],
  ['c-sky', `g.player.pos.set(120,0,190); g.player.yaw = -0.55; g.player.pitch = 0.24;`],
  ['d-ship', `g.player.pos.set(150,0,170); g.player.yaw = Math.atan2(-150,-170); g.player.pitch = -0.04;`],
];

for (const WORLD of WORLDS) {
  let info;
  try {
    info = await bootGame(page, {
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
        return { world:g.landed.body.name, type:g.landed.body.spec.type,
                 sunY:+g.surface.skyMat.uniforms.uSunDir.value.y.toFixed(3) };
      })()`,
      settle: 3000,
    });
  } catch (e) { console.log(`skip ${WORLD}: ${String(e.message).split('\n')[0]}`); continue; }
  console.log(WORLD, JSON.stringify(info));
  for (const [tag, js] of POSES) {
    await page.evaluate(`(()=>{ const g=window.__game; ${js} })()`);
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${OUT}/${WORLD}-${tag}.jpg`, type: 'jpeg', quality: 92 });
  }
}
await browser.close();
