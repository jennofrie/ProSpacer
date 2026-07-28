// Cut the captured shots into the launch video.
//
// capture.mjs now records each shot at its final length, so there is nothing to
// trim here: this joins the clips, renders the end card with the game's own
// type, and lays the bounced score underneath. Hard cuts throughout — a demo
// this short has no room for transitions, and the game's own changes of place
// (walking -> seated -> flying) already carry the rhythm.
//
//   node tools/edit.mjs [--out shots/prospacer.mp4]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', 'shots/prospacer.mp4');
const TMP = 'shots/_edit';
const CARD_SECS = 2.2;
fs.mkdirSync(TMP, { recursive: true });

const man = JSON.parse(fs.readFileSync('shots/clips/manifest.json', 'utf8'));
const FPS = man.fps;
const segs = man.shots.map((n) => `shots/clips/${n}.mp4`);
for (const s of segs) if (!fs.existsSync(s)) throw new Error(`missing clip: ${s} — run tools/capture.mjs`);

const ff = (a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a],
  { stdio: 'inherit' });
const probe = (f, k) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', k,
  '-of', 'default=nw=1:nk=1', f]).toString().trim().split('\n')[0];

/* ---- end card, rendered in the browser so it uses the game's own type ---- */
const CARD = `${TMP}/card.png`;
{
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#04080d;overflow:hidden}
    .w{height:100%;display:grid;place-content:center;justify-items:center;
       font-family:ui-monospace,"SF Mono",Menlo,monospace;color:#dff4ff;text-align:center}
    svg{margin-bottom:40px}
    .r{fill:none;stroke:#8fe4ff;stroke-width:.7;opacity:.5}
    .r2{stroke:#ffc48a;opacity:.32;stroke-dasharray:6 10}
    .d{fill:#ffc48a}
    h1{margin:0;font-size:52px;font-weight:400;letter-spacing:.42em;text-indent:.42em;
       text-shadow:0 0 60px rgba(143,228,255,.45)}
    .s{margin-top:22px;font-size:16px;letter-spacing:.34em;text-indent:.34em;color:rgba(160,196,214,.62)}
    .u{margin-top:64px;font-size:23px;letter-spacing:.26em;text-indent:.26em;color:#8fe4ff;
       text-shadow:0 0 34px rgba(143,228,255,.5)}
  </style><div class="w">
    <svg viewBox="0 0 120 120" width="150" height="150">
      <circle cx="60" cy="60" r="46" class="r"/><circle cx="60" cy="60" r="34" class="r r2"/>
      <circle cx="60" cy="60" r="4" class="d"/>
      <path d="M60 4 L60 18 M60 102 L60 116 M4 60 L18 60 M102 60 L116 60" class="r"/>
    </svg>
    <h1>PROSPACER</h1>
    <div class="s">DEEP SURVEY VESSEL &middot; PALE SEEKER</div>
    <div class="u">PROSPACER · PROFEXOR</div>
  </div>`, { waitUntil: 'load' });
  await p.screenshot({ path: CARD });
  await b.close();
}
// Encoded to match the clips exactly, so the join is a stream copy.
const cardSeg = `${TMP}/card.mp4`;
ff(['-loop', '1', '-framerate', String(FPS), '-i', CARD, '-t', String(CARD_SECS),
  '-vf', 'scale=1920:1080,fade=t=in:st=0:d=0.4',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', cardSeg]);

const list = [...segs, cardSeg];
fs.writeFileSync(`${TMP}/list.txt`,
  list.map((f) => `file '${process.cwd()}/${f}'`).join('\n'));

const total = list.reduce((a, f) => a + probe(f, 'format=duration'), 0);
console.log(list.map((f, i) => `  ${String(i + 1).padStart(2)} ${f.split('/').pop().padEnd(18)}` +
  `${probe(f, 'format=duration').toFixed(1)}s`).join('\n'));

/* Score: the music is synthesised, so tools/score.mjs bounces the game's own
   audio engine offline rather than dropping a stock track under it. Rendered
   quiet by design, so it gets normalised here and faded under the end card. */
const SCORE = `${TMP}/score.wav`;
const vf = 'fade=t=in:st=0:d=0.35';
const head = ['-f', 'concat', '-safe', '0', '-i', `${TMP}/list.txt`];
if (fs.existsSync(SCORE)) {
  ff([...head, '-i', SCORE, '-vf', vf,
    '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${(total - CARD_SECS - 0.2).toFixed(2)}:d=2.4`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest',
    '-movflags', '+faststart', OUT]);
} else {
  ff([...head, '-vf', vf,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', OUT]);
}

const size = (fs.statSync(OUT).size / 1e6).toFixed(1);
console.log(`\n${OUT}  ${probe(OUT, 'format=duration').toFixed(1)}s  ${size} MB  1920x1080 @${FPS}`);
