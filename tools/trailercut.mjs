// Assemble the trailer from the rushes in shots/raw.
//
// The cut is data, at the top, so it can be argued with. Everything below it is
// mechanical: pull each in-point out of its take, re-encode all of them to one
// format so the concat demuxer will accept them, join, and lay the title over
// the tail.
//
// The title is rendered by the *game*, not by ffmpeg — this build has no
// drawtext filter, and more to the point the boot overlay is already the right
// type at the right tracking, so screenshotting it with the progress bar and
// the button hidden gives a card that matches the product instead of one that
// approximates it.
//
//   node tools/trailercut.mjs [--out shots/trailer.mp4]
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const RAW = opt('raw', 'shots/raw');
const OUT = opt('out', 'shots/trailer.mp4');
const TMP = 'shots/.cut';
const W = 1920, H = 1080, FPS = 30;

/* ---------------------------------------------------------------- the cut
 *
 * The second version, and both notes on the first one were about pace.
 *
 * **Longer takes.** The first cut averaged a shot and a half a second, which
 * reads as a montage of a rendering rather than as a game being played. This
 * one averages four and a half and nothing is under four: a player's experience
 * of this game is continuous and slow, and a trailer that cuts every forty
 * frames is advertising a different one. Ten shots instead of sixteen, over
 * nearly twice the running time.
 *
 * **No silhouettes.** Every shot that put the star behind the hull came back as
 * a black outline inside a blue halo — the fold tunnel, the star crossing, the
 * arrival flash. They are gone, and the anamorphic streak that drew the halo
 * has been pulled back besides (see PostFX). Every exterior here is lit between
 * fifty-five and ninety degrees of phase, so the hull has a lit face, a
 * terminator and a shadowed side.
 *
 * The order is the shape of a session rather than a highlight reel: the seat
 * you fly from, the ship you live in, the world you are over, the way down, and
 * the ground.
 */
const EDL = [
  // --- open in the chair, on the thing outside it
  { src: 'b-canopy', in: 0.25, dur: 4.60, note: 'the canopy, and a ringed world' },
  // --- and this is the ship it belongs to: walk up, sit down, one take
  { src: 'a-cabin', in: 1.20, dur: 5.10, note: 'the cabin, to the helm' },
  // --- over a world. two takes off one orbit, wide then close
  { src: 'd-orbit', in: 0.70, dur: 5.40, note: 'in orbit' },
  { src: 'e-orbit2', in: 1.00, dur: 4.40, note: 'closer' },
  /* --- down. Four beats off one unbroken landing, in one light. The in-points
     avoid the three seconds of cloud deck in the middle of the entry, which at
     speed is a brown smear and was the one dead frame in the last cut. */
  { src: 'f-landing', in: 1.70, dur: 4.20, note: 'the dive' },
  { src: 'f-landing', in: 5.30, dur: 5.20, note: 'through the deck, and down' },
  { src: 'f-landing', in: 11.20, dur: 4.60, note: 'parked' },
  // --- and out of it
  { src: 'g-ground', in: 2.60, dur: 5.30, note: 'the surface' },
  { src: 'h-foot', in: 1.40, dur: 4.50, note: 'under the boots' },
  /* The last shot is the same landing, widest, because ending on another world
     is an unmotivated jump and this one has forty seconds of investment in it.
     It holds, because the title lands on it. */
  { src: 'f-landing', in: 14.30, dur: 5.60, note: 'into the deep frontier' },
];

/* The title lands over the last shot rather than on a card of its own: a hard
   cut to black type on black at the end of a twenty-five second cut is two
   seconds of nothing, and the last shot is still worth looking at. */
const TITLE_IN = 2.60;      // seconds before the end of the film
const TITLE_FADE = 0.70;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const run = (a) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + a.join(' '));
};

// ---- 1. the title card, typeset with the game's own tokens
//
// Not a screenshot of the boot overlay, which was the first attempt and comes
// back empty: `#boot` carries a backdrop-filter and an opacity transition, and
// captured with `omitBackground` there is nothing behind the type for the
// filter to sample, so the whole card composites to zero. The type is three
// declarations — the mono stack, the tracking, and the two colours — and
// setting them here is both shorter and the only version that cannot be broken
// by a change to the loading screen.
const TITLE_HTML = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent}
  .w{position:fixed;inset:0;display:grid;place-items:center;
     font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
  h1{margin:0;font-size:38px;font-weight:400;letter-spacing:.40em;white-space:nowrap;
     text-indent:.40em;color:#eaf7ff;text-shadow:0 0 30px rgba(143,228,255,.40)}
  p{margin:16px 0 0;font-size:13px;letter-spacing:.30em;text-indent:.30em;
     color:rgba(168,204,222,.80);text-align:center}
  .a{color:#ffc48a}
</style><div class="w"><div>
  <h1>PROSPACER</h1>
  <p>DEEP SURVEY VESSEL &middot; <span class="a">PALE SEEKER</span></p>
</div></div>`;

const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: W / 2, height: H / 2 },
  deviceScaleFactor: 2 });
await page.setContent(TITLE_HTML, { waitUntil: 'load' });
await page.screenshot({ path: `${TMP}/title.png`, omitBackground: true });
await browser.close();

// ---- 2. pull the cut
const list = [];
EDL.forEach((c, i) => {
  const src = `${RAW}/${c.src}.mp4`;
  if (!fs.existsSync(src)) throw new Error(`missing take: ${src}`);
  const seg = `${TMP}/${String(i).padStart(2, '0')}-${c.src}.mp4`;
  /* -ss before -i seeks on keyframes and would slip the in-point by up to a
     GOP; after -i it decodes from the start and cuts exactly, which at these
     lengths costs nothing and is the difference between an in-point that was
     chosen and one that was nearly chosen. */
  run(['-i', src, '-ss', String(c.in), '-t', String(c.dur),
    '-vf', `scale=${W}:${H}:flags=lanczos,fps=${FPS},setsar=1`
      + (c.grade ? ',' + c.grade : ''),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-an', seg]);
  list.push(seg);
  console.log(`${String(i).padStart(2, '0')}  ${c.src.padEnd(12)} `
    + `${c.in.toFixed(2)}+${c.dur.toFixed(2)}  ${c.note}`);
});

/* The measured cut, not the intended one.
 *
 * Every segment is quantised to whole frames, and any in-point close to the end
 * of its take is quantised to whatever is left — one of these came out half a
 * second short and dragged the last three cuts of the film early with it. The
 * score is written against these times, so it hits the picture rather than the
 * spreadsheet. */
const cuts = { total: 0 };
let acc = 0;
EDL.forEach((c, i) => {
  cuts[c.src + ':' + i] = +acc.toFixed(4);
  const d = +spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', list[i]], { encoding: 'utf8' }).stdout.trim();
  if (Math.abs(d - c.dur) > 0.05) {
    console.log(`   !! ${c.src} wanted ${c.dur.toFixed(2)}s, got ${d.toFixed(2)}s `
      + '— the in-point runs off the end of the take');
  }
  acc += d;
});
cuts.total = +acc.toFixed(4);
fs.writeFileSync(`${TMP}/cuts.json`, JSON.stringify(cuts, null, 2));

fs.writeFileSync(`${TMP}/list.txt`,
  list.map((f) => `file '${path.basename(f)}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', `${TMP}/list.txt`, '-c', 'copy', `${TMP}/joined.mp4`]);

// ---- 3. the title over the tail, and the fades
const total = EDL.reduce((a, c) => a + c.dur, 0);
const t0 = total - TITLE_IN;
run(['-i', `${TMP}/joined.mp4`, '-loop', '1', '-i', `${TMP}/title.png`,
  '-filter_complex',
  `[1:v]format=rgba,fade=t=in:st=${t0.toFixed(2)}:d=${TITLE_FADE}:alpha=1`
  + `,scale=${W}:${H}[t];`
  + `[0:v][t]overlay=0:0:shortest=1[v0];`
  /* No fade in. Twenty frames of ramp is a fifth of a second of dim, and in a
     feed that is the whole audition — the first frame has to arrive at full
     strength. Only the tail fades, under the type. */
  + `[v0]fade=t=out:st=${(total - 0.85).toFixed(2)}:d=0.85[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', String(FPS), OUT]);

/* ---- 4. the score.
 *
 * tools/score.mjs --arr trailer renders it from the game's own audio engine,
 * against the same cut points as the EDL above. If it has not been rendered
 * the film is still assembled, silent, rather than failing — but say so,
 * because a silent trailer that was meant to have music is not obviously
 * broken until someone plays it.
 *
 * loudnorm rather than a gain: this is going to a feed, and a feed will
 * normalise it anyway. Doing it here means the platform's normaliser has
 * nothing left to do and the quiet beats — the ground, the Choir — survive on
 * a phone speaker. -14 LUFS with 9 LU of range keeps the touchdown and the
 * fold as hits without flattening the two places the score gets out of the way.
 */
const SCORE = opt('score', 'shots/score.wav');
const withAudio = fs.existsSync(SCORE);
if (withAudio) {
  fs.renameSync(OUT, `${TMP}/mute.mp4`);
  run(['-i', `${TMP}/mute.mp4`, '-i', SCORE,
    '-filter_complex', '[1:a]loudnorm=I=-14:TP=-1.5:LRA=9,alimiter=limit=0.94[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart', OUT]);
} else {
  console.log('\n!! no score at ' + SCORE + ' — the cut is silent.'
    + '\n   node tools/score.mjs --arr trailer --secs 26.4 --out ' + SCORE);
}

/* And a delivery encode. The master is CRF 17 and about 45 MB, which is right
   for keeping and wrong for uploading; a capped 12 Mbit pass lands the same
   twenty-six seconds under 21 MB with no visible difference on a phone. */
const social = OUT.replace(/\.mp4$/, '-social.mp4');
run(['-i', OUT, '-c:v', 'libx264', '-preset', 'slow', '-crf', '21',
  '-maxrate', '12M', '-bufsize', '24M', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  ...(withAudio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), social]);

console.log(`\n${OUT}  ${cuts.total.toFixed(2)}s  ${EDL.length} shots`);
console.log(`${social}  delivery encode`);
