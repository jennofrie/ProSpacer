// Record the launch footage.
//
// Runs the game in ?record=N mode, which hands the frame loop over to us: one
// fixed 1/N step per captured frame. Capture is slower than real time, so
// sampling a free-running loop would produce uneven motion — stepping by hand
// means the footage plays back at exactly the intended speed no matter how long
// the grab took.
//
// Frames go straight down a pipe into one ffmpeg per shot, so each shot lands
// as a finished clip and nothing touches the disk in between. Two measurements
// drove that (tools/_probe): a 1080p PNG screenshot costs ~400 ms, the same
// frame as JPEG q98 costs ~30 ms and scores 50 dB PSNR against it — invisible
// under an x264 encode. The window is headless too; Chrome's new headless mode
// still gets the real Metal device, which is easy to assume it does not.
//
//   node tools/capture.mjs [--fps 30] [--w 1280] [--h 720] [--only shotName]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FPS = +opt('fps', 30), W = +opt('w', 1280), H = +opt('h', 720);
const ONLY = opt('only', null);
const OUT = 'shots/clips';
fs.mkdirSync(OUT, { recursive: true });

/* Every set-up teleports the player, and teleporting must not leave easing
   state behind. The chart camera blends back to the body over about a second;
   a shot that opened mid-blend flew the eye through the hull on its way to the
   seat, which is the clip-through that kept showing up in the cut.
   `keepUI` shots opt out of dismissing the archive, because they open with it
   still up and close it on camera. */
const reset = (shot) => `
  g.holoMap.close(); g.holoMap._k = 0; g._mapK = 0;
  ${shot.keepUI ? '' : 'g.archive.hide();'}
  g.input.keys.clear(); g.player.freeLook = false;
  g.ship.boost = 0;
  if (g.player.mode === 'moving') { g.player._t = 1; g.player.mode = g.player._target; }
`;

/* Seat the player instantly, with no transition to catch mid-flight. */
const SEATED = `
  const st = g.interior.stations.find(x => x.id === 'seat');
  g.player.mode = 'walk'; g.player.sit(st); g.player._t = 1;
  g.player.mode = 'seated'; g.player.yaw = 0; g.player.pitch = -0.05;
  g.mode = 'pilot'; g.player.freeLook = true; g.input.keys.add('look');
`;

/* Shot list.
 *
 * Ordered as a story rather than as a tour, and cut as few times as possible:
 * walking to the chair, sitting, and the run-up on a world are one unbroken
 * take, because sitting down in front of a planet and then cutting to being far
 * away from that same planet is nonsense. Surveying it and reading what the
 * survey wrote is a second take, with the archive opening on camera. The ship
 * walk-through sits in the middle where a breath is welcome. Only then does it
 * travel, and the jump between systems is the fold drive doing it on screen
 * followed by a real hyperjump — the bodies in act three belong to a different
 * star.
 *
 * Shots run in order and inherit each other's state; --only is for looking at
 * one, not for rebuilding the cut.
 *
 * Each shot is recorded at its final length; the edit only joins them. */
const SHOTS = [
  /* ---- act one: one take from standing to a world in the windscreen -- */
  {
    name: '01-open',
    secs: 8.6,
    // No cut between the walk-up, the sit and the burn. The planet is nine
    // radii out for all of it and only the last stretch closes on it, so the
    // shot never contradicts itself about where the ship is.
    setup: `
      g.mode = 'walk'; g.player.mode = 'walk';
      g.player.pos.set(0.10, 0, -3.55); g.player.yaw = -0.10; g.player.pitch = -0.02;
      g.pose({ kind: 'terran', dist: 9.0, phase: 58, elev: 6 });
      g.mode = 'walk'; g.ship.throttle = 0;
    `,
    frame: `
      const A = 0.256, B = 0.454;              // walk | sit | run-up
      if (p < A) {
        const t = EASE(p / A);
        g.player.pos.set(LERP(0.10, 0.62, t), 0, LERP(-3.55, -4.72, t));
        g.player.yaw = LERP(-0.10, -0.14, t) + Math.sin(p * 5.2) * 0.02;
        g.player.pitch = LERP(-0.02, -0.06, t) + Math.sin(p * 8.0) * 0.010;
      } else if (p < B) {
        if (g.player.mode === 'walk') {
          g.player.sit(g.interior.stations.find(x => x.id === 'seat'));
          g.mode = 'pilot';
        }
        g.player.freeLook = false;
      } else {
        const t = EASE((p - B) / (1 - B));
        g.player.freeLook = true; g.input.keys.add('look');
        // Posed rather than flown: at full boost the ship closes 0.2 Mm in the
        // length of the shot out of the 22 Mm it would need. Velocity is
        // written back so the streaks and the speed-linked FOV still read.
        g.pose({ kind: 'terran', dist: LERP(9.0, 2.5, t), phase: 58, elev: 6 });
        g.ship.throttle = 1; g.ship.boost = 1;
        g.ship.vel.set(0, 0, -1).applyQuaternion(g.ship.quat)
          .multiplyScalar(g.ship.maxSpeed * (g.ship.boostMul || 1));
        g.player.yaw = Math.sin(t * 1.3) * 0.030;
        g.player.pitch = -0.05 + Math.sin(t * 1.0) * 0.018;
      }
    `,
  },
  {
    name: '02-survey',
    secs: 6.8,
    // Scan to completion, then the archive opens over the top of it. One take
    // again: the panel arrives with its own animation instead of being cut to.
    setup: `
      ${SEATED}
      g.pose({ kind: 'terran', dist: 2.5, phase: 58, elev: 6 });
      g.ship.throttle = 0.06;
    `,
    frame: `
      if (p > 0.06 && p < 0.54) g.input.keys.add('scan'); else g.input.keys.delete('scan');
      if (p >= 0.58 && !g.archive.open) {
        const b = g.bodies.find(x => x.spec && x.spec.type === 'terran')
               || g.bodies.find(x => x.kind === 'planet');
        g.completeScan(b);
        g.archive.show('body:' + b.id);
      }
      g.player.yaw = Math.sin(p * 1.4) * 0.024;
      g.player.pitch = -0.05 + Math.sin(p * 1.1) * 0.014;
    `,
  },

  /* ---- act two: it is a ship, and you live in it --------------------- */
  {
    name: '03-stand',
    secs: 3.2,
    keepUI: true,
    // Opens with the archive still up, dismisses it on camera, then gets out of
    // the seat and steps clear before turning — turning on the spot swung the
    // headrest through the lens and read exactly like the clipping it was not.
    setup: `
      const st = g.interior.stations.find(x => x.id === 'seat');
      g.player.mode = 'walk'; g.player.sit(st); g.player._t = 1;
      g.player.mode = 'seated'; g.mode = 'pilot';
      g.player.yaw = -0.14; g.player.pitch = -0.05;
      if (!g.archive.open) {
        // Only reached when this shot is captured on its own; in sequence the
        // survey leaves the archive up. Snap it open so --only matches.
        const b = g.bodies.find(x => x.spec && x.spec.type === 'terran')
               || g.bodies.find(x => x.kind === 'planet');
        g.completeScan(b); g.archive.show('body:' + b.id);
        for (const a of document.getAnimations()) a.finish();
      }
      g.ship.throttle = 0;
    `,
    frame: `
      if (p > 0.12 && g.archive.open) g.archive.close();
      if (p > 0.30 && g.player.mode === 'seated') g.player.stand();
      const t = EASE(Math.max(0, (p - 0.52) / 0.48));
      g.player.pos.set(LERP(0.62, 1.00, t), 0, LERP(-4.72, -4.15, t));
      g.player.yaw = LERP(-0.14, Math.PI, t);
      g.player.pitch = LERP(-0.05, 0.02, t);
    `,
  },
  {
    name: '04-walk',
    secs: 3.8,
    setup: `
      g.mode = 'walk'; g.player.mode = 'walk';
      g.player.pos.set(1.00, 0, -4.15); g.player.yaw = Math.PI; g.player.pitch = 0.02;
      g.ship.throttle = 0;
    `,
    frame: `
      const t = EASE(p);
      g.player.pos.set(LERP(1.00, 0, t) + Math.sin(p * 3.4) * 0.04, 0, LERP(-4.15, 1.30, t));
      g.player.yaw = Math.PI + Math.sin(p * 2.4) * 0.05;
      g.player.pitch = 0.02 + Math.sin(p * 3.0) * 0.02;
    `,
  },
  {
    name: '05-chart',
    secs: 5.0,
    setup: `
      g.mode = 'walk'; g.player.mode = 'walk';
      g.player.pos.set(0, 0, 1.32); g.player.yaw = 0; g.player.pitch = -0.10;
      g.holoMap.show();
    `,
    frame: `
      g.player.yaw = Math.sin(p * 3.0) * 0.14;
      g.player.pitch = -0.10 + Math.sin(p * 1.9) * 0.04;
    `,
  },

  /* ---- act three: the size of it ------------------------------------- */
  {
    name: '06-return',
    secs: 2.0,
    setup: `
      g.mode = 'walk'; g.player.mode = 'walk';
      g.player.pos.set(0, 0, -1.10); g.player.yaw = 0; g.player.pitch = 0;
      g.ship.throttle = 0;
    `,
    frame: `
      const t = EASE(p);
      g.player.pos.set(LERP(0, 0.55, t) + Math.sin(p * 3.6) * 0.03, 0, LERP(-1.10, -4.55, t));
      g.player.yaw = Math.sin(p * 2.0) * 0.05;
      g.player.pitch = LERP(0, -0.04, t) + Math.sin(p * 3.2) * 0.018;
    `,
  },
  {
    name: '07-fold',
    secs: 3.6,
    // Deliberately does not re-pose: the ship is exactly where the survey left
    // it, so the fold departs from the world we just catalogued instead of
    // teleporting back out to admire it a second time.
    setup: `
      ${SEATED}
      g.ship.throttle = 1;
    `,
    frame: `
      if (p > 0.16 && !g.ship.foldMode) { g.ship.foldCharge = 1; g.toggleFold(true); }
      g.player.yaw = Math.sin(p * 1.2) * 0.03;
      g.player.pitch = -0.03;
    `,
  },
  {
    name: '08-arrive',
    secs: 4.2,
    // Tried this as a real hyperjump so the fold would land somewhere new, and
    // reverted it: the next system along is procedurally dim — its ringed giant
    // renders near-black at every phase and its station is a fleck — so the
    // payoff shot of the whole video became four seconds of empty. Arriving at
    // another world in this system is a difference nobody watching can see.
    setup: `
      ${SEATED}
      const b = g.bodies.find(x => x.spec && x.spec.rings)
             || g.bodies.find(x => x.spec && x.spec.type === 'gas')
             || g.bodies.find(x => x.kind === 'planet');
      g._hero = b;
      g.pose({ bodyRef: b, dist: 3.4, phase: 34, elev: 14 });
      g.ship.throttle = 0.14;
    `,
    frame: `
      g.player.yaw = LERP(-0.30, 0.26, EASE(p));
      g.player.pitch = -0.02 + Math.sin(p * 1.6) * 0.03;
    `,
  },
  {
    name: '09-exterior',
    secs: 4.0,
    // Same body as the shot before, from outside — a change of camera reads as
    // a change of camera; a different world would read as another teleport.
    // Under the ring plane, which is the one framing in the system where the
    // ship is unmistakably a speck.
    setup: `
      g.mode = 'exterior';
      const b = g._hero || g.bodies.find(x => x.spec && x.spec.rings)
             || g.bodies.find(x => x.kind === 'planet');
      g.pose({ bodyRef: b, dist: 3.0, phase: 40, elev: 10 });
      g.ship.throttle = 0.55;
    `,
    frame: `g.ship.throttle = 0.55 + Math.sin(p * 2.0) * 0.12;`,
  },
  {
    name: '10-anomaly',
    secs: 3.4,
    // End on the thing the game is actually about. The star was the obvious
    // closer and it is not usable: it is 46,000 km of radius, so any framing
    // that fits it puts the camera far enough out that it stops drawing.
    setup: `
      ${SEATED}
      const b = g.bodies.find(x => x.kind === 'anomaly' && /RESONATOR/i.test(x.name))
             || g.bodies.find(x => x.kind === 'anomaly' && x.radius > 1)
             || g.bodies.find(x => x.kind === 'planet');
      g.pose({ bodyRef: b, dist: 8, phase: 40, elev: 5 });
      g.ship.throttle = 0.06;
    `,
    frame: `
      g.player.yaw = Math.sin(p * 1.1) * 0.03;
      g.player.pitch = LERP(-0.06, 0.01, EASE(p));
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
await page.goto(`http://localhost:5173/?record=${FPS}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootStart'); return b && !b.hidden;
}, { timeout: 180000 });
await page.click('#bootStart');
await page.evaluate(() => {
  // Cinematic pass: the overlay is state, not scenery. Directive cards, the
  // narration and the key hints all pop mid-shot and pull the eye straight off
  // the thing being shown. The in-world panels stay — those are the game.
  document.getElementById('hud').style.display = 'none';
  for (let i = 0; i < 240; i++) window.__step();
});

const manifest = [];
for (const shot of SHOTS) {
  manifest.push(shot.name);
  if (ONLY && !shot.name.includes(ONLY)) continue;
  const seg = `${OUT}/${shot.name}.mp4`;

  // Async because a set-up may hyperjump, which rebuilds the system.
  await page.evaluate(
    new Function('g', `return (async () => {${reset(shot)}\n${shot.setup}})()`),
    await page.evaluateHandle(() => window.__game));
  // settle the set-up, and let any eased transition begin
  await page.evaluate(() => { for (let i = 0; i < 6; i++) window.__step(); });

  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', seg], { stdio: ['pipe', 'inherit', 'inherit'] });

  const n = Math.round(shot.secs * FPS);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate(
      ([src, p, ms]) => {
        // CSS animations run on the wall clock, and the first screenshot after
        // a panel opens costs ~400 ms because of its backdrop filter — so a
        // 0.4 s opening was over before the second frame was grabbed and the UI
        // popped. Pin every animation to the capture's own timestep, the same
        // way the simulation is pinned.
        for (const a of document.getAnimations()) {
          if (a.playState === 'running') a.pause();
          a.currentTime = (a.__capT = (a.__capT || 0) + ms);
        }
        const g = window.__game;
        const EASE = (t) => t * t * (3 - 2 * t);
        const LERP = (a, b, t) => a + (b - a) * t;
        // eslint-disable-next-line no-new-func
        new Function('g', 'p', 'EASE', 'LERP', src)(g, p, EASE, LERP);
        window.__step();
      },
      [shot.frame, i / Math.max(1, n - 1), 1000 / FPS]);
    const buf = await page.screenshot({ type: 'jpeg', quality: 98 });
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  await once(ff, 'close');
  console.log(`${shot.name.padEnd(14)} ${n}f  ${shot.secs.toFixed(1)}s  ` +
    `${((Date.now() - t0) / 1000).toFixed(0)}s to grab`);
}
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ fps: FPS, shots: manifest }, null, 2));
await browser.close();
