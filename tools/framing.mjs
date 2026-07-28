// How much of the seated frame is actually space?
//
// "The cockpit is so gigantic you can barely see any of space" is a real
// complaint and it is measurable, so it should be measured rather than argued
// about. This sits the player at the helm, renders the frame twice — once with
// the cabin drawn and once with it hidden — and counts the pixels that did not
// change. Those are the pixels the canopy lets through.
//
// It also reports where the sky sits vertically, because a cockpit can pass on
// area while still putting the window in a letterbox slot: a canopy that opens
// upward reads as a windscreen, one that opens as a horizontal band across the
// middle reads as a gunslit.
//
//   node tools/framing.mjs [--pitch -0.09] [--dpr 2] [--w 1512] [--h 945]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { bootGame } from './boot.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1512), H = +opt('h', 945), DPR = +opt('dpr', 2);
const PITCH = +opt('pitch', -0.09);          // the seated rest pitch
const OUT = opt('out', '/tmp/_framing');

/* Sit at the helm, look where the game itself looks when you sit down, and
   frame something worth seeing out of the window. `freeLook` has to be pinned
   or the seated look springs back to base and the pitch is silently ignored. */
const SEAT = (pitch) => `(()=>{
  const st = g.interior.stations.find(s => s.id === 'seat');
  g.mode='walk'; g.player.mode='walk'; g.player.sit(st);
  g.player.mode='seated'; g.player._t = 1;
  Object.defineProperty(g.player,'freeLook',{get:()=>true,set:()=>{},configurable:true});
  g.mode='pilot'; g.player.yaw = 0; g.player.pitch = ${pitch};
  g.pose({kind:'terran', dist:2.4, phase:70, elev:8});
  g.setLayer('hud', false);
  return null; })()`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page, { setup: SEAT(PITCH), settle: 5000 });

fs.mkdirSync(OUT, { recursive: true });

/* Measure by *hue*, not by difference.

   The obvious method — shoot with the cabin and without it, and count the
   pixels that did not change — is wrong here, and wrong in the direction that
   flatters nothing: hiding the cabin removes most of the light in the frame, so
   auto-exposure opens and the sky changes too. Measured, the frame mean falls
   34.9 to 9.7 and about 45% of the planet's pixels move further than any sane
   difference threshold, so sky gets counted as cabin. Pinning the exposure does
   not fix it either — the uniform that looks like exposure is a multiplier on
   top of the adaptation, not the adaptation itself.

   So: paint the whole world a saturated green and hide everything in it. Green
   appears nowhere in the cabin (the one reserved hue in this game is a pale
   gold-green used only on Choir artefacts, and none are aboard). Anything that
   comes back green-dominant is a pixel the canopy let through. Hue survives any
   exposure the tonemap picks, which is the entire point. */
await page.evaluate(() => {
  const g = window.__game;
  g.setLayer('stars', false);
  g.bodies.forEach((b) => { if (b.obj) b.obj.visible = false; if (b.planet) b.planet.group.visible = false; });
  g.star.group.visible = false;
  g.fleet.object.visible = false;
  g.scene.background = new (g.scene.background.constructor.name === 'Color'
    ? g.scene.background.constructor : Object)();
  g.scene.background = null;
  g.engine.renderer.setClearColor(0x00ff00, 1);
});
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/with.png` });
await browser.close();

const SW = 504, SH = 315;                    // analyse at a reduced size
const RGB = `${OUT}/with.rgb`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${OUT}/with.png`,
  '-vf', `scale=${SW}:${SH},format=rgb24`, '-f', 'rawvideo', RGB]);
const buf = fs.readFileSync(RGB);

// Green-dominant, and by a margin — the tonemap desaturates hard at the top end
// so a blown highlight drifts toward white and must not count.
const rowSky = new Float32Array(SH);
let sky = 0;
for (let y = 0; y < SH; y++) {
  let n = 0;
  for (let x = 0; x < SW; x++) {
    const i = (y * SW + x) * 3;
    const r = buf[i], gr = buf[i + 1], b = buf[i + 2];
    if (gr > 40 && gr > r * 1.35 && gr > b * 1.35) n++;
  }
  rowSky[y] = n / SW;
  sky += n;
}
const frac = sky / (SW * SH);

// Where is it? A band across the middle and a windscreen that opens upward are
// very different pictures at the same area.
let top = -1, bot = -1;
for (let y = 0; y < SH; y++) if (rowSky[y] > 0.25) { if (top < 0) top = y; bot = y; }
const bandTop = top < 0 ? 0 : top / SH, bandBot = bot < 0 ? 0 : (bot + 1) / SH;

const rows = 24, prof = [];
for (let r = 0; r < rows; r++) {
  let s2 = 0, c = 0;
  for (let y = Math.floor(r * SH / rows); y < Math.floor((r + 1) * SH / rows); y++) { s2 += rowSky[y]; c++; }
  prof.push(s2 / c);
}

console.log(`seated frame ${W}x${H} @${DPR}x, pitch ${PITCH}, fov 68\n`);
console.log(`sky visible        ${(frac * 100).toFixed(1)}%  of the frame`);
console.log(`opening spans      ${(bandTop * 100).toFixed(0)}% to ${(bandBot * 100).toFixed(0)}% of frame height`
  + `  (${((bandBot - bandTop) * 100).toFixed(0)}% tall)`);
console.log('\nrow profile, top to bottom — each bar is the sky fraction of that band');
for (let r = 0; r < rows; r++) {
  const v = prof[r];
  console.log(`  ${String(Math.round(r * 100 / rows)).padStart(3)}%  ${'#'.repeat(Math.round(v * 44)).padEnd(44, '.')} ${(v * 100).toFixed(0)}%`);
}
/* The bar. A space game's cockpit is a windscreen you fly through, not a
   dashboard with a slot above it — the reference is Starfield, where the
   canopy is the dominant element of the frame and the instruments live below
   the sightline. Half the frame is the floor, not the target. */
console.log(`\nverdict: ${frac >= 0.45 ? 'PASS' : 'FAIL'} — needs >= 45% sky; measured ${(frac * 100).toFixed(1)}%`);
