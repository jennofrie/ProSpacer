/* Ground A/B: boot once, land, pin the clock, then shoot a list of scripted
   mutations of the same pinned pose. For isolating which term owns an artifact.

   node tools/gndab.mjs --out /tmp/gc/ab --world terran --elev 0.34 \
        --pose foot --cases "base:;nonrm:g.surface.U.uTerK.value.x=0"

   Every case is applied on top of the previous one being undone, so each is
   given as a pair sep by '|' — apply|undo. If no undo is given the page is
   re-landed between cases. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { bootGame } from './boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', '/tmp/gc/ab');
const WORLD = opt('world', 'terran');
const ELEV = +opt('elev', '0.34');
const POSE = opt('pose', 'foot');
const SETTLE = +opt('settle', 3200);
mkdirSync(OUT, { recursive: true });

const POSES = {
  foot: `g.player.pos.set(26,0,34); g.player.yaw=Math.atan2(-26,-34)+0.9; g.player.pitch=-0.22;`,
  sky: `g.player.pos.set(26,0,34); g.player.yaw=Math.atan2(-26,-34)+Math.PI; g.player.pitch=0.02;`,
  // straight down at the ground two metres from the boots
  boots: `g.player.pos.set(26,0,34); g.player.yaw=Math.atan2(-26,-34)+0.9; g.player.pitch=-0.62;`,
  // a massif, from the landing site
  hill: `g.player.pos.set(26,0,34); g.player.yaw=Math.atan2(-26,-34)+0.9; g.player.pitch=-0.02;`,
};

const LAND = `(()=>{
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
  if (!g.landed.onFoot) g.disembark();
  ${POSES[POSE] || POSES.foot}
  return { world:g.landed.body.name, sunY:+g.surface.skyMat.uniforms.uSunDir.value.y.toFixed(4) };
})()`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({
  viewport: { width: +opt('w', 1512), height: +opt('h', 945) },
  deviceScaleFactor: +opt('dpr', 2),
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page, { setup: '1' });

const cases = opt('cases', 'base:').split(';').filter(Boolean);
for (const c of cases) {
  const i = c.indexOf(':');
  const name = c.slice(0, i), js = c.slice(i + 1);
  const info = await bootGame(page, { setup: LAND, settle: SETTLE });
  if (js.trim()) {
    await page.evaluate(`(()=>{ const g=window.__game; ${js} })()`);
    await page.waitForTimeout(1400);
  }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, JSON.stringify(info));
}
await browser.close();
