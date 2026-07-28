// Frame rate across the set-pieces that actually cost something, at the real
// display resolution. One browser, one boot, several poses — so a slow scene
// cannot hide behind a fast one, and shader compilation is paid once.
//
//   node tools/perfset.mjs [--dpr 2] [--w 1512] [--h 945] [--hold 6]
import { chromium } from 'playwright';
import { bootGame } from './boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
/* HOLD is 14, not 6. Approaching a world triggers a re-bake of its cubemap at
   1024 per face, which runs across many frames and costs about 15 seconds of
   wall clock — so a six-second window parked in front of a planet measures the
   bake and reports ~51 fps for a scene that settles at 120 with no change in
   render scale. Every "planet is slow" investigation here has started by
   measuring that transient. */
const W = opt('w', 1512), H = opt('h', 945), DPR = opt('dpr', 2), HOLD = opt('hold', 14);

const POSES = [
  ['cabin (boot)', `g.mode='walk';`],
  ['planet, framed', `g.mode='exterior'; g.pose({kind:'terran', dist:2.35, phase:82, elev:5});`],
  ['planet, filling frame', `g.mode='exterior'; g.pose({kind:'terran', dist:1.25, phase:70, elev:0});`],
  ['ringed giant', `g.mode='exterior'; const rb=g.bodies.find(b=>b.spec&&b.spec.rings); if(rb) g.pose({bodyRef:rb, dist:2.5, phase:112, elev:4});`],
  ['star, close', `g.mode='exterior'; g.pose({bodyRef:g.bodies[0], dist:4.0, phase:34, elev:9});`],
  ['station', `g.mode='exterior'; const b=g.bodies.find(x=>x.kind==='station'); if(b) g.pose({bodyRef:b, dist:4.2, phase:112, elev:12});`],
  ['resonator', `g.mode='exterior'; const a=g.bodies.find(b=>b.anomalyType==='resonator'); if(a) g.pose({bodyRef:a, dist:3.0, phase:78, elev:12});`],
  ['asteroid belt', `g.mode='exterior'; const b=g.system.belts[0]; if(b){ const r=(b.inner+b.outer)*0.5,a=1.1;
      g.ship.absPos.set(Math.cos(a)*r,0,Math.sin(a)*r); g.ship.vel.set(0,0,0);
      g.origin.copy(g.ship.absPos); g.camAbs.copy(g.ship.absPos); }`],
  ['fold transit', `g.mode='exterior'; g.pose({kind:'gas', dist:14, phase:60, elev:10}); g.toggleFold(true);`],
  ['landed', `g.mode='exterior'; g.pose({kind:'terran', dist:1.6, phase:70, elev:8}); g.land(g.target, {now:true}); g.director.stop();`],
];

// Headed, deliberately. Headless Chromium's numbers here are worthless —
// identical scenes measure anywhere from 22 to 112 fps run to run, while a
// headed window is stable to within a frame over a ten-second window.
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 300)); });

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page);
await page.waitForTimeout(6000);   // let shaders compile and exposure settle

console.log(`${W}x${H} @${DPR}x = ${((W * DPR * H * DPR) / 1e6).toFixed(1)} MP`);
console.log('scene                      fps   pxRatio  draws    tris');
let worst = { fps: 1e9, name: '' };
for (const [name, js] of POSES) {
  /* A hot reload mid-run does not just lose the pose — it puts the game back in
     the cabin, so the row reports the *interior* draw count against an exterior
     scene name and the number looks like a catastrophic regression. */
  const live = await page.evaluate(() => !!(window.__game && window.__game.started)
    && document.getElementById('boot').style.display === 'none').catch(() => false);
  if (!live) {
    console.log('  (page had reloaded — re-booting)');
    await bootGame(page);
    await page.waitForTimeout(6000);
  }
  await page.evaluate(`(()=>{ const g = window.__game;
    g.director.stop(); g.inspect({off:true}); if(g.landed && !${JSON.stringify(js)}.includes('land(')) g.liftOff({now:true});
    ${js} })()`);
  await page.waitForTimeout(HOLD * 1000);
  const s = await page.evaluate(() => {
    const e = window.__game.engine;
    return {
      fps: +e.fps.toFixed(0), pr: +e.pixelRatio.toFixed(2),
      draws: e.drawCalls, tris: e.triangles,
    };
  });
  if (s.fps < worst.fps) worst = { fps: s.fps, name };
  const flag = s.fps < 60 ? '  << under 60' : '';
  console.log(`${name.padEnd(24)} ${String(s.fps).padStart(4)}   ${String(s.pr).padStart(5)}`
    + `  ${String(s.draws).padStart(5)}  ${String(Math.round(s.tris / 1000)).padStart(5)}k${flag}`);
}
console.log(`\nworst: ${worst.name} at ${worst.fps} fps`);
await browser.close();
