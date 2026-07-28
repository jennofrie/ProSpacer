// Raw footage for a trailer.
//
// Same harness as tools/capture.mjs — ?record=N hands the frame loop over, one
// fixed 1/N step per grabbed frame, so the footage plays back at exactly the
// intended speed however long the grab took — but a different brief. capture.mjs
// shoots a cut: every clip is already its final length and the edit only joins
// them. This shoots *rushes*. Each take runs long and unbroken, because the two
// best things in the game are now sequences the director plays in real time
// (see SEQUENCES.descent / .ascent) and the only honest way to get those is to
// let them run and choose the seconds afterwards.
//
//   node tools/trailer.mjs [--fps 30] [--w 1280] [--h 720] [--only name]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FPS = +opt('fps', 30), W = +opt('w', 1280), H = +opt('h', 720);
const ONLY = opt('only', null);
const OUT = opt('out', 'shots/raw');
fs.mkdirSync(OUT, { recursive: true });

/* Seat the player instantly, with no transition to catch mid-flight. */
const SEATED = `
  const st = g.interior.stations.find(x => x.id === 'seat');
  g.player.mode = 'walk'; g.player.sit(st); g.player._t = 1;
  g.player.mode = 'seated'; g.player.yaw = 0; g.player.pitch = -0.05;
  g.mode = 'pilot'; g.player.freeLook = true; g.input.keys.add('look');
`;

/* Land and leave once, instantly, before recording anything.
 *
 * The landing sequence holds its covering shot until the ground scene's shaders
 * have compiled, which is the whole point of it — but the hold is measured in
 * *frames*, and in record mode a frame is however long a screenshot takes. Left
 * cold, a 300 ms compile becomes ten seconds of footage of a held frame. One
 * throwaway cycle puts every program in the cache, and the take that follows
 * holds for exactly as long as a player's machine would. */
const WARM = (kind) => `
  g.mode = 'exterior';
  g.pose({ kind: ${JSON.stringify(kind)}, dist: 2.2, phase: 62, elev: 8 });
  g.land(g.target, { now: true }); g.director.stop();
  g.liftOff({ now: true }); g.director.stop();
`;

const RESET = `
  g.holoMap.close(); g.holoMap._k = 0; g._mapK = 0;
  g.archive.hide(); g.starmap.close();
  g.input.keys.clear(); g.player.freeLook = false;
  g.ship.boost = 0;
  g.director.stop(); g.inspect({ off: true });
  if (g.landed && !g.transition) { g.liftOff({ now: true }); g.director.stop(); }
  if (g.player.mode === 'moving') { g.player._t = 1; g.player.mode = g.player._target; }
`;

/* The rushes.
 *
 * Two rules, both of them notes on the first cut.
 *
 * **Long takes.** The first version averaged a shot and a half a second and
 * read as a montage of a rendering rather than as a game being played. Nothing
 * here is under five seconds, and the three that matter — walking to the helm,
 * the orbit, the landing — run seven or more unbroken. A player's experience of
 * this game is continuous and slow; a trailer that cuts every forty frames is
 * advertising a different one.
 *
 * **The ship is always lit.** Every shot that put the star behind the hull came
 * back as a black outline inside a blue halo, and that is not a style, it is
 * something the eye reads as a rendering fault — the fold tunnel, the star
 * crossing, the arrival. All of them are gone. Every exterior here is posed
 * between fifty-five and ninety degrees of phase, so there is a lit face, a
 * terminator and a shadowed side, which is what the art direction asks for
 * anyway: one hard key, and bounce for everything else.
 *
 * Order is the shape of a session: you are in a ship, you look out of it, you
 * fly it somewhere, you go down, you stand on it.
 */
const SHOTS = [
  /* ---- you are in a ship -------------------------------------------- */
  {
    /* Driven by the actual controls, not by teleporting the eye: the walk is a
       held key, so the collision, the head bob and the lean are the game's and
       not a curve I drew. It costs nothing and it is the difference between
       footage and an animatic. */
    name: 'a-cabin', secs: 8.0,
    setup: `
      ${RESET}
      g.mode = 'walk'; g.player.mode = 'walk';
      g.player.pos.set(0.05, 0, 2.25);
      g.player.yaw = 0.03; g.player.pitch = -0.02;
      const gas = g.bodies.find(x => x.spec && x.spec.rings) || g.bodies.find(x => x.kind === 'planet');
      g.__gas = gas;
      g.pose({ bodyRef: gas, dist: 2.1, phase: 68, elev: 9, frame: 1.5, throttle: 0.28 });
      g.mode = 'walk'; g.player.mode = 'walk';
    `,
    frame: `
      const WALK = 0.52, SIT = 0.60;
      if (p < WALK) g.input.keys.add('thrUp'); else g.input.keys.delete('thrUp');
      if (p >= SIT && g.player.mode === 'walk') {
        g.player.sit(g.interior.stations.find(x => x.id === 'seat'));
        g.mode = 'pilot';
      }
      // a little life in the head, the way a person walking looks around
      g.player.yaw = 0.03 + Math.sin(p * 4.1) * 0.030;
      if (p < SIT) g.player.pitch = -0.02 + Math.sin(p * 3.0) * 0.020;
    `,
  },
  {
    // Seated. A slow look up off the panel and across the canopy to the world
    // outside it — the shot that says the window is not a texture.
    name: 'b-canopy', secs: 6.5,
    setup: `
      ${SEATED}
      g.pose({ bodyRef: g.__gas, dist: 1.95, phase: 70, elev: 10, frame: 1.6, throttle: 0.30 });
      g.player.yaw = -0.06; g.player.pitch = -0.03;
    `,
    frame: `
      const t = EASE(p);
      g.player.freeLook = true; g.input.keys.add('look');
      /* A drift, not a pan. It opens *on* the world — this is the first frame
         of the film and it has to earn the next four seconds — and then eases
         down and across the panel, so the shot ends somewhere different from
         where it started without ever leaving the thing worth looking at. */
      g.player.yaw = LERP(-0.06, 0.30, t) + Math.sin(p * 1.7) * 0.010;
      g.player.pitch = LERP(-0.03, -0.20, t) + Math.sin(p * 1.3) * 0.007;
    `,
  },
  /* ---- flying it ----------------------------------------------------- */
  {
    /* A real orbit, not a pose swept in phase. pose() re-aims the hull at the
       body every frame, which reads as diving at it; here the ship is put on a
       circular path and pointed along its own tangent, so the chase camera
       trails it and the world turns underneath. The plane is tilted off the
       terminator so the lit limb runs across the bottom of frame and the ship
       keeps a key on its flank the whole way round. */
    name: 'd-orbit', secs: 8.0,
    setup: `
      ${RESET}
      g.mode = 'exterior';
      // self-sufficient, so --only can re-shoot this take on its own
      if (!g.__world) { g.pose({ kind: 'terran', dist: 3, phase: 60, elev: 8 }); g.__world = g.target; }
      g.pose({ bodyRef: g.__world, dist: 1.85, phase: 66, elev: 8 });
      const V = g.ship.absPos.constructor;
      const b = g.__world;
      const sun = g.star.absPos.clone().sub(b.absPos).normalize();
      const up = new V(0, 1, 0);
      const side = sun.clone().cross(up).normalize();
      const trueUp = side.clone().cross(sun).normalize();
      // start on the lit side, sixty degrees round from the sub-solar point
      g.__u = sun.clone().applyAxisAngle(trueUp, 1.05).normalize();
      g.__v = trueUp.clone().applyAxisAngle(g.__u, 0.22).normalize();
      g.__r = b.radius * 1.62;
      g.__a0 = 0;
    `,
    frame: `
      const V = g.ship.absPos.constructor;
      const M = g.camera.matrix.constructor;
      const b = g.__world;
      const ang = g.__a0 + p * 0.62;
      const rad = g.__u.clone().multiplyScalar(Math.cos(ang))
        .addScaledVector(g.__v, Math.sin(ang)).normalize();
      const tan = g.__v.clone().multiplyScalar(Math.cos(ang))
        .addScaledVector(g.__u, -Math.sin(ang)).normalize();
      g.ship.absPos.copy(b.absPos).addScaledVector(rad, g.__r);
      g.ship.vel.copy(tan).multiplyScalar(240);
      /* Nose on the track but pitched *down* into the well by twenty degrees.
         Flying a true tangent puts the world ninety degrees under the keel,
         where a chase camera raked six degrees will never find it — the first
         version of this shot was the hull as a speck in an empty starfield.
         Twenty degrees of nose-down is also what an actual approach looks like,
         and it fills the bottom two thirds of frame with planet. */
      const nose = tan.clone().multiplyScalar(Math.cos(0.36))
        .addScaledVector(rad, -Math.sin(0.36)).normalize();
      g.ship.quat.setFromRotationMatrix(new M().lookAt(new V(), nose, rad));
      // and banked into the turn, easing in and out of it
      g.ship.quat.multiply(new (g.ship.quat.constructor)()
        .setFromAxisAngle(new V(0, 0, 1), 0.30 * Math.sin(p * 3.14159)));
      g.ship.object.quaternion.copy(g.ship.quat);
      g.origin.copy(g.ship.absPos);
      g.ship.throttle = 0.8;
      /* Ship-relative, which is the opposite of inspect()'s usual rule that az
         and el are world axes. That rule holds for the bodyRef form and not for
         this one: with no reference, updateCamera applies the *ship's*
         quaternion to the
         direction, so az and el are in the hull's own frame. Deriving a world
         direction and converting it to az/el — which is what the first pass of
         this shot did — gets it rotated a second time and points the camera at
         empty sky. Off the starboard quarter and above, held through the whole
         orbit, which is exactly what a fixed ship-relative angle gives. */
      g.inspect({ dist: LERP(4.2, 3.0, EASE(p)), az: 40 - p * 10, el: 38 - p * 8, fov: 46 });
    `,
  },
  {
    // Closer, and the other way round the hull, so the two orbit shots are not
    // the same picture with a different number on it.
    name: 'e-orbit2', secs: 6.5,
    setup: `
      g.mode = 'exterior';
      if (!g.__world) { g.pose({ kind: 'terran', dist: 3, phase: 60, elev: 8 }); g.__world = g.target; }
      if (!g.__u) {
        const V = g.ship.absPos.constructor;
        const b = g.__world;
        const sun = g.star.absPos.clone().sub(b.absPos).normalize();
        const up = new V(0, 1, 0);
        const side = sun.clone().cross(up).normalize();
        const trueUp = side.clone().cross(sun).normalize();
        g.__u = sun.clone().applyAxisAngle(trueUp, 1.05).normalize();
        g.__v = trueUp.clone().applyAxisAngle(g.__u, 0.22).normalize();
      }
      g.__r = g.__world.radius * 1.26;
      g.__a0 = 1.15;
      g.inspect({ dist: 1.9, az: 34, el: 12, fov: 44 });
    `,
    frame: `
      const V = g.ship.absPos.constructor;
      const M = g.camera.matrix.constructor;
      const b = g.__world;
      const ang = g.__a0 + p * 0.40;
      const rad = g.__u.clone().multiplyScalar(Math.cos(ang))
        .addScaledVector(g.__v, Math.sin(ang)).normalize();
      const tan = g.__v.clone().multiplyScalar(Math.cos(ang))
        .addScaledVector(g.__u, -Math.sin(ang)).normalize();
      g.ship.absPos.copy(b.absPos).addScaledVector(rad, g.__r);
      g.ship.vel.copy(tan).multiplyScalar(200);
      const nose = tan.clone().multiplyScalar(Math.cos(0.30))
        .addScaledVector(rad, -Math.sin(0.30)).normalize();
      g.ship.quat.setFromRotationMatrix(new M().lookAt(new V(), nose, rad));
      g.ship.object.quaternion.copy(g.ship.quat);
      g.origin.copy(g.ship.absPos);
      g.ship.throttle = 0.7;
      // ship-relative — see d-orbit
      g.inspect({ dist: LERP(2.3, 1.55, EASE(p)), az: 26 - p * 7, el: 24 - p * 7, fov: 44 });
    `,
  },

  /* ---- and down ------------------------------------------------------ */
  {
    // The whole arrival, unbroken: the bank over, the entry, the settle onto
    // the gear and the crane pulling back off it.
    name: 'f-landing', secs: 20.0,
    setup: `
      ${RESET}
      ${WARM('terran')}
      g.mode = 'exterior';
      g.pose({ kind: 'terran', dist: 2.25, phase: 62, elev: 8 });
      g.ship.throttle = 0.5;
      g.land(g.target);
    `,
    frame: '',
  },
  {
    // Standing on it, with the ship for scale and the light raking.
    name: 'g-ground', secs: 9.0,
    setup: `
      g.setSunElevation(0.30);
      const T = g.landed.t;
      Object.defineProperty(g.landed, 't', { get: () => T, set: () => {}, configurable: true });
      g.disembark();
      g.player.pos.set(190, 0, 215);
    `,
    frame: `
      const a = Math.atan2(190, 215);
      g.player.yaw = a - 0.60 + p * 1.00;
      g.player.pitch = -0.09 + Math.sin(p * 2.0) * 0.03;
      g.player.pos.set(190 - p * 40, 0, 215 - p * 46);
      g.player.groundY = g.player.groundHeight(g.player.pos.x, g.player.pos.z);
    `,
  },
  {
    // Low and close, the ground under the boots, and the sky over it.
    name: 'h-foot', secs: 7.0,
    setup: `
      g.player.pos.set(96, 0, 108);
    `,
    frame: `
      /* Down, not up. This is the only shot in the film at boot scale, and it
         was pitching *up* into the same wide vista its two neighbours already
         have — three shots of one landscape at one distance. Looking at the
         ground under the feet is what the near-field work is for. */
      g.player.yaw = Math.atan2(96, 108) + 0.30 - p * 0.50;
      g.player.pitch = -0.42 + p * 0.20;
      g.player.pos.set(96 - p * 30, 0, 108 - p * 34);
      g.player.groundY = g.player.groundHeight(g.player.pos.x, g.player.pos.z);
    `,
  },
  {
    // And off it again, for the tail.
    name: 'i-liftoff', secs: 13.0,
    setup: `
      try { delete g.landed.t; } catch (e) {}
      if (g.landed.onFoot) g.board();
      g.liftOff();
    `,
    frame: '',
  },

  /* ---- one more world, for the title to land on ---------------------- */
  {
    name: 'j-crescent', secs: 8.0,
    setup: `
      ${RESET}
      g.mode = 'exterior';
      g.pose({ kind: 'terran', dist: 2.4, phase: 128, elev: 4, frame: 2.4 });
      g.__cw = g.target;
      g.inspect({ bodyRef: g.__cw, dist: 2.6, az: 186, el: 5, fov: 40 });
    `,
    frame: `
      g.inspect({ bodyRef: g.__cw, dist: LERP(2.7, 2.05, EASE(p)),
                  az: 186 + p * 14, el: 5 + p * 5, fov: 40 });
    `,
  },
];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1.5,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:5173/?record=${FPS}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootStart'); return b && !b.hidden;
}, { timeout: 240000 });
await page.click('#bootStart');
await page.evaluate(() => {
  // The overlay is state, not scenery: directive cards and key hints pop
  // mid-shot and pull the eye off the thing being shown. The in-world panels
  // stay, because those are the game.
  document.getElementById('hud').style.display = 'none';
  /* And no letterbox, and no title card. `HUD.cinematic` builds `#cine` lazily
     on its first call, so hiding the element up front finds nothing — the bars
     and the world's name arrive with the first sequence and are burnt into the
     footage. The trailer sets its own type; the game's belongs to the game. */
  window.__game.hud.cinematic = () => {};
  for (let i = 0; i < 240; i++) window.__step();
});

const manifest = [];
for (const shot of SHOTS) {
  if (ONLY && !shot.name.includes(ONLY)) continue;
  const seg = `${OUT}/${shot.name}.mp4`;

  const skip = await page.evaluate(
    new Function('g', `return (async () => {${shot.setup}})()`),
    await page.evaluateHandle(() => window.__game));
  if (skip === 'SKIP') { console.log(`${shot.name.padEnd(14)} SKIP`); continue; }
  await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__step(); });

  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', seg], { stdio: ['pipe', 'inherit', 'inherit'] });

  const n = Math.round(shot.secs * FPS);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate(
      ([src, p, ms]) => {
        for (const a of document.getAnimations()) {
          if (a.playState === 'running') a.pause();
          a.currentTime = (a.__capT = (a.__capT || 0) + ms);
        }
        const g = window.__game;
        const EASE = (t) => t * t * (3 - 2 * t);
        const LERP = (a, b, t) => a + (b - a) * t;
        // eslint-disable-next-line no-new-func
        if (src) new Function('g', 'p', 'EASE', 'LERP', src)(g, p, EASE, LERP);
        window.__step();
      },
      [shot.frame, i / Math.max(1, n - 1), 1000 / FPS]);
    const buf = await page.screenshot({ type: 'jpeg', quality: 98 });
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  await once(ff, 'close');
  manifest.push({ name: shot.name, secs: shot.secs });
  console.log(`${shot.name.padEnd(14)} ${n}f  ${shot.secs.toFixed(1)}s  `
    + `${((Date.now() - t0) / 1000).toFixed(0)}s to grab`);
}
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ fps: FPS, shots: manifest }, null, 2));
await browser.close();
