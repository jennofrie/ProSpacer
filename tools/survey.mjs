// Multi-shot survey: boots once, then walks a list of scripted setups,
// screenshotting each. Much faster than one browser launch per frame.
//   node tools/survey.mjs [--w 1600] [--h 900] [--only name]
import { chromium } from 'playwright';
import { bootGame } from './boot.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1600), H = +opt('h', 900);
const ONLY = opt('only', null);
const MOBILE = opt('mobile', '0') === '1';
const outDir = opt('out', 'shots');
fs.mkdirSync(outDir, { recursive: true });

// Reset the camera owners before every shot. A cutscene from an earlier
// shot runs for ten seconds and letterboxes everything after it.
const PRE = `g.director.stop(); g.inspect({off:true}); if(g.landed) g.liftOff({now:true}); g.mode='exterior';
  /* w-traffic hides the player's hull so it does not sit in front of the
     freighter it is framing, and nothing put it back — so every shot after it,
     including the one whose entire job is a hull close-up, quietly rendered an
     empty starfield. State a shot changes has to be reset here, not by the
     shot that happens to run next. */
  g.ship.object.visible = true;
  /* Pick a world by type priority, but never the same world twice in one run.
     Several shots share candidate types — "dry" and "alt-b" both accept desert
     and iron — so without this they both land on the system's one desert world
     and the set ships two photographs of the same planet, which is the exact
     duplication the review called out. Returns null if everything is taken;
     the caller SKIPs rather than posing a fallback. */
  g.__used = g.__used || new Set();
  g.pick = (types) => {
    for (const t of types) {
      const b = g.bodies.find((x) => x.spec && x.spec.type === t && !g.__used.has(x.id || x.name));
      if (b) { g.__used.add(b.id || b.name); return b; }
    }
    return null;
  };`;
const SHOTS = [
  { name: 'a-spawn', settle: 2200, js: `g.setLayer('hud', true);` },
  // wide, low, near-half phase so the terminator crosses the disc
  { name: 'b-terran', settle: 2500, js: `g.mode='exterior';
      g.pose({kind:'terran', dist:1.95, phase:82, elev:5, frame:1.7, throttle:0.22}); g.setLayer('hud',false);` },
  // The mirror of b-terran: same world, opposite diagonal, and close enough
  // that the terminator runs off both edges instead of floating in a void.
  // Two shots of one planet only earn their place if they are not the same
  // picture. (Not via inspect() — that frames the *ship*, which throws the
  // planet out of shot and leaves a redundant hull close-up.)
  { name: 'c-terran-crescent', settle: 2500, js: `g.mode='exterior';
      g.pose({kind:'terran', dist:1.7, phase:139, elev:-9, frame:-1.1, throttle:0.20});
      g.setLayer('hud',false);` },
  { name: 'd-gas', settle: 2500, js: `g.mode='exterior'; if(!g.bodies.some(b=>b.spec&&b.spec.type==='gas')) throw new Error('no gas in system'); g.pose({kind:'gas', dist:1.55, phase:96, elev:-4, frame:2.6, throttle:0.18}); g.setLayer('hud',false);` },
    { name: 'e-barren', settle: 2500, js: `g.mode='exterior';
      const b = g.pick(['barren']);
      if(!b) return 'SKIP: this system has no barren world';
      g.pose({bodyRef:b, dist:1.9, phase:84, elev:-8}); g.setLayer('hud',false);` },
  { name: 'f-ice', settle: 2500, js: `g.mode='exterior'; if(!g.bodies.some(b=>b.spec&&b.spec.type==='ice')) throw new Error('no ice in system'); g.pose({kind:'ice', dist:2.05, phase:74, elev:26, frame:2.4, throttle:0.14}); g.setLayer('hud',false);` },
  // Not every system has every world. Hunt down a priority list rather than
  // silently posing whatever `pose` falls back to — two identical "lava" and
  // "desert" shots of the same blue planet is worse than no shot at all.
  { name: 'g-hot', settle: 2500, js: `
      /* Molten only. Falling through to iron produced the worst frame in the
         set: a distant, genuinely dark rock lit at a tenth of an inner orbit,
         standing in for a lava world and reading as a black disc. A missing
         frame is honest; a dark one labelled "hot" is not. */
      const b = g.pick(['lava','toxic']);
      if(!b) return 'SKIP: this system has no molten world';
      g.pose({bodyRef:b, dist:1.85, phase:72, elev:14, frame:2.0, throttle:0.18}); g.setLayer('hud',false);` },
  { name: 'h-dry', settle: 2500, js: `
      const b = g.pick(['desert','iron','toxic','barren']);
      if(!b) return 'SKIP: this system has no dry world';
      g.pose({bodyRef:b, dist:2.2, phase:58, elev:-18, frame:-1.8, throttle:0.15}); g.setLayer('hud',false);` },
  { name: 'i-rings', settle: 2500, js: `
      const rb = g.bodies.find(b=>b.spec && b.spec.rings);
      if(rb) g.pose({bodyRef:rb, dist:2.15, phase:118, elev:-11, frame:2.2, throttle:0.16});
      g.setLayer('hud',false);` },
  { name: 'j-star', settle: 2500, js: `g.mode='exterior'; g.pose({bodyRef:g.bodies[0], dist:16, phase:26, elev:4}); g.setLayer('hud',false);` },
  // Hull hero. Deliberately a fixed three-quarter rather than one derived from
  // where the planet is: the camera then has to sit on the anti-planet side,
  // which in most poses puts the *star* behind the ship, and the auto-exposure
  // stops down for it and takes the hull with it. A backlit silhouette is a
  // different shot; this one exists to show the plating.
  { name: 'k-ship', settle: 2000, js: `
      g.mode='exterior'; g.pose({kind:'terran', dist:7.0, phase:84, elev:8});
      g.inspect({dist:1.15, az:214, el:14, fov:28});
      g.setLayer('hud',false);` },
  {
    name: 'l-resonator', settle: 2200, js: `
      const a = g.bodies.find(b=>b.anomalyType==='resonator');
      if(a) g.pose({bodyRef:a, dist:3.0, phase:78, elev:12});
      g.setLayer('hud',false);` },
  {
    name: 'm-derelict', settle: 2200, js: `
      const a = g.bodies.find(b=>b.anomalyType==='derelict');
      if(a) g.pose({bodyRef:a, dist:3.2, phase:96, elev:18});
      g.setLayer('hud',false);` },
  {
    name: 'v-station', settle: 2400, js: `
      const b = g.bodies.find(x=>x.kind==='station');
      /* pose() cannot stage this one. buildStation seeds the root attitude with
         its own seeded rotation, so a world-axis azimuth lands wherever that
         roll happens to put it — which is how this shot ended up looking
         straight down the bore of the wheel with the core, tanks, bay and tower
         all compressed inside it. Derive the direction from the root instead
         and every mass separates. */
      if(b){
        const V = g.ship.absPos.constructor;
        const Q = g.camera.quaternion.constructor;
        const R = b.station ? b.station.built.root : b.obj;
        const d = new V(0.72, 0.30, -0.62).normalize()
          .applyQuaternion(R.getWorldQuaternion(new Q()));
        g.inspect({bodyRef:b, dist:2.4,
          az: Math.atan2(d.x, d.z)*180/Math.PI,
          el: Math.asin(d.y)*180/Math.PI, fov:36});
      }
      g.setLayer('hud',false);` },
  {
    // Traffic has to be staged against something. Framed in a void it is a
    // small unlit box in a black rectangle; put a planet behind it and the same
    // freighter reads as commerce.
    //
    // inspect()'s az/el are in world axes, so the direction is worked out here
    // and converted — az is measured from +Z, el from the equator, matching
    // inspect's own basis. Posing the player's ship instead does not work: the
    // floating origin follows it, so the chase camera just frames the Seeker.
    name: 'w-traffic', settle: 2600, js: `
      /* An orbital craft, not a freighter. Freighters run the lanes *between*
         worlds, so they are millions of kilometres from anything that could
         fill a backdrop — framed there they are a lit speck in a black
         rectangle, which is the exact failure this shot exists to fix. */
      const c = g.fleet.craft.find(x=>x.path==='orbit') || g.fleet.craft[0];
      const b = g.bodies.find(x=>x.craft===c);
      if(!b) return 'SKIP: no traffic in this system';
      const host = g.bodies.filter(x=>x.kind==='planet')
        .sort((p,q)=>p.absPos.distanceTo(b.absPos)-q.absPos.distanceTo(b.absPos))[0];
      const V = b.absPos.constructor;
      const away = b.absPos.clone().sub(host.absPos).normalize();
      const up = new V(0,1,0);
      const side = away.clone().cross(up).normalize();
      // stand off along planet->craft so the world fills the backdrop
      const dir = away.clone().multiplyScalar(2.2)
        .addScaledVector(side, 1.4).addScaledVector(up, 0.45).normalize();
      const az = Math.atan2(dir.x, dir.z) * 180/Math.PI;
      const el = Math.asin(dir.y) * 180/Math.PI;
      g.ship.object.visible = false;      // not overwritten by updateCamera
      g.inspect({bodyRef:b, dist:5.5, az, el, fov:30});
      g.setLayer('hud',false);` },
  {
    name: 'x-orbit', settle: 2400, js: `
      g.inspect({off:true});
      const p = g.bodies.find(x=>x.spec && x.spec.inhabited) || g.bodies.find(x=>x.kind==='planet');
      g.pose({bodyRef:p, dist:2.2, phase:134, elev:6});
      g.setLayer('hud',false);` },
  {
    // Not aimed at the star. Looking straight down the key turns every rock
    // into an evenly-lit grey lump with the light behind it — the shot that
    // got called dirt on the lens. Swing sixty degrees off and the same rocks
    // get a terminator, a lit face and a shadowed one, which is the only thing
    // that says "solid body" rather than "smudge".
    name: 't-belt', settle: 2600, js: `
      const f = g.fields[0];
      if(f){
        const b = g.system.belts[0];
        const r = (b.inner + b.outer)*0.5, a = 1.1;
        const V = g.ship.absPos.constructor;
        g.ship.absPos.set(Math.cos(a)*r, 0, Math.sin(a)*r);
        g.ship.vel.set(0,0,0);
        const toStar = g.star.absPos.clone().sub(g.ship.absPos).normalize();
        const up = new V(0,1,0);
        const look = toStar.clone().applyAxisAngle(up, 1.05)
          .addScaledVector(up, -0.10).normalize();
        g.ship.quat.setFromRotationMatrix(new (g.camera.matrix.constructor)().lookAt(
          new V(), look, up));
        g.origin.copy(g.ship.absPos); g.camAbs.copy(g.ship.absPos); g.camQuat.copy(g.ship.quat);
      }
      g.setLayer('hud',false);` },
  {
    // An actual hero close-up of the hull. This used to pose a *planet* at
    // dist 3.4 and was named for a ship, so the set never contained the one
    // shot that shows the player's vessel at readable size.
    name: 'u-shipclose', settle: 2200, js: `
      g.mode='exterior'; g.pose({kind:'terran', dist:5.5, phase:64, elev:12});
      g.ship.throttle = 0.85;
      g.inspect({dist:0.95, az:212, el:16, fov:34});
      g.setLayer('hud',false);` },
  { name: 'n-map', settle: 1200, js: `g.setLayer('hud',true); g.starmap.show();` },
  { name: 'o-archive', settle: 1200, js: `g.starmap.close(); g.bodies.slice(0,6).forEach(b=>g.completeScan(b)); g.archive.show();` },
  { name: 'q-jump', settle: 5200, js: `g.archive.close(); g.starmap.close(); g.setLayer('hud',false); g.hyperjump(3);` },
  {
    name: 'r-alt-a', settle: 1900, js: `
      const b = g.pick(['lava','toxic','ocean','ice']);
      if(!b) return 'SKIP: no world left for this slot';
      g.pose({bodyRef:b, dist:2.1, phase:58, elev:12, frame:1.9}); g.setLayer('hud',false);` },
  {
    name: 's-alt-b', settle: 1900, js: `
      const b = g.pick(['ocean','iron','desert','barren','ice']);
      if(!b) return 'SKIP: no world left for this slot';
      g.pose({bodyRef:b, dist:2.0, phase:64, elev:14, frame:-1.5}); g.setLayer('hud',false);` },
  // Off the axis on purpose. The vanishing point *is* the direction of travel,
  // so a camera parked directly astern puts it dead centre and the whole frame
  // becomes a bullseye; a couple of dozen degrees off puts the caustic in a
  // third and gives the hull something to be silhouetted against.
  //
  // That angle has to be measured from the *heading*, though. inspect()'s az/el
  // are world axes, so a hard-coded "206, near enough astern" put the camera
  // ahead of the ship instead, with the vanishing point behind the lens: the
  // frame filled with the receding tunnel wall and the caustic never appeared.
  { name: 'p-fold', settle: 3000, js: `g.archive.close(); g.mode='exterior';
      const gas = g.bodies.find(x=>x.spec && x.spec.type==='gas') || g.bodies.find(x=>x.kind==='planet');
      g.pose({bodyRef:gas, dist:14, phase:60, elev:10});
      // Recharge first — the drive burns charge while folded and the hyperjump
      // three shots earlier spends most of it.
      g.ship.foldCharge = 1;
      g.toggleFold(true);
      const V = g.ship.absPos.constructor;
      // pose() aims the ship at the body, so that is the heading it will
      // accelerate along; vel is still zero at this instant and cannot be used.
      const fwd = gas.absPos.clone().sub(g.ship.absPos).normalize();
      const up = new V(0,1,0);
      const side = fwd.clone().cross(up).normalize();
      const dir = fwd.clone().negate()
        .addScaledVector(side, 0.26).addScaledVector(up, 0.10).normalize();
      g.inspect({dist:1.7, az: Math.atan2(dir.x, dir.z)*180/Math.PI,
                 el: Math.asin(dir.y)*180/Math.PI, fov:54});
      g.setLayer('hud',false);` },
];

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
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const Q = opt('q', null);
await page.goto('http://localhost:5173/' + (Q ? '?q=' + Q : ''), { waitUntil: 'domcontentloaded' });
await bootGame(page);
await page.waitForTimeout(1800);

const report = [];
for (const s of SHOTS) {
  if (ONLY && !s.name.includes(ONLY)) continue;
  // A source edit part-way through a run hot-reloads the page and puts the
  // title card back up, and every shot after it is a screenshot of the title
  // card with a plausible fps next to it. Check before each one.
  const live = await page.evaluate(() => !!(window.__game && window.__game.started)
    && document.getElementById('boot').style.display === 'none').catch(() => false);
  if (!live) {
    logs.push(`[shot ${s.name}] page had reloaded — re-booted`);
    await bootGame(page);
    await page.waitForTimeout(1800);
  }
  let skip = null;
  try {
    skip = await page.evaluate(`(()=>{ const g = window.__game; ${s.name === 'a-spawn' ? '' : PRE} ${s.js} })()`);
  } catch (e) { logs.push(`[shot ${s.name}] ${e.message}`); }
  // A set-piece the current system cannot stage is not a failure — say so and
  // move on, rather than screenshotting whatever the camera happened to be on.
  if (typeof skip === 'string' && skip.startsWith('SKIP')) {
    // Delete the old frame. Leaving it behind is worse than having no frame:
    // `judgeset.mjs` copies whatever PNG is lying in this directory, so a
    // skipped shot silently ships a render of a *different system* from an
    // earlier run — which is exactly how a reviewer came to compare two
    // unrelated ice worlds and conclude they were the same asset recoloured.
    fs.rmSync(`${outDir}/${s.name}.png`, { force: true });
    report.push(`${s.name.padEnd(20)} ${skip}`);
    continue;
  }
  await page.waitForTimeout(s.settle);
  await page.screenshot({ path: `${outDir}/${s.name}.png` });
  const st = await page.evaluate(() => ({
    fps: +window.__game.engine.fps.toFixed(0),
    px: +window.__game.engine.pixelRatio.toFixed(2),
    calls: window.__game.engine.drawCalls,
    tris: window.__game.engine.triangles,
    tgt: window.__game.target?.name,
  })).catch(() => ({ fps: 0, px: 0, calls: 0, tris: 0, tgt: 'RELOADED MID-SHOT' }));
  report.push(`${s.name.padEnd(20)} fps=${String(st.fps).padStart(3)} px=${st.px} calls=${String(st.calls).padStart(4)} tris=${String(Math.round(st.tris / 1000)).padStart(5)}k  ${st.tgt || ''}`);
}
console.log(report.join('\n'));
if (logs.length) { console.log('--- issues ---'); console.log([...new Set(logs)].slice(0, 25).join('\n')); }
await browser.close();
