/* Scratch: land, pin the sun, and shoot a panorama from one spot on foot.
   node tools/ground/pano.mjs --out /tmp/pano/base --world terran --elev 0.34 --n 6 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { bootGame } from '../boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', '/tmp/pano/x');
const WORLD = opt('world', 'terran');
const ELEV = +opt('elev', 0.34);
const N = +opt('n', 6);
const PITCH = +opt('pitch', 0.02);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({
  viewport: { width: +opt('w', 1512), height: +opt('h', 850) },
  deviceScaleFactor: +opt('dpr', 2),
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page, { setup: '1' });

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
    g.player.pos.set(180, 0, 220); g.player.pitch = ${PITCH};
    return { world:g.landed.body.name, type:g.landed.body.spec.type,
             sunY:+g.surface.skyMat.uniforms.uSunDir.value.y.toFixed(4),
             sunAz:+Math.atan2(g.surface.skyMat.uniforms.uSunDir.value.x,
                               g.surface.skyMat.uniforms.uSunDir.value.z).toFixed(3) };
  })()`,
  settle: 3000,
});
console.log(JSON.stringify(info));

for (let i = 0; i < N; i++) {
  const yaw = (i / N) * Math.PI * 2;
  await page.evaluate(`(()=>{ const g=window.__game; g.player.yaw=${yaw}; g.player.pitch=${PITCH}; })()`);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${WORLD}-${String(ELEV).replace('.', 'p')}-y${i}.png` });
}
await browser.close();
