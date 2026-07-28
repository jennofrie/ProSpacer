// Contact sheet: tile a set of shots into one image so a whole survey can be
// judged in a single look instead of one file at a time.
//   node tools/sheet.mjs shots/*.png --out shots/_sheet.png [--cols 4] [--w 520]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const OUT = opt('out', 'shots/_sheet.png');
const CW = +opt('w', 520);
const COLS = +opt('cols', Math.min(4, Math.ceil(Math.sqrt(files.length))));
const ROWS = Math.ceil(files.length / COLS);
if (!files.length) { console.error('no input files'); process.exit(1); }

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// This ffmpeg build has no freetype, so tiles cannot be labelled in the image.
// The reading order is printed instead.
const inputs = [];
const filters = [];
files.forEach((f, i) => {
  inputs.push('-i', f);
  filters.push(`[${i}:v]scale=${CW}:-1,pad=iw+6:ih+6:3:3:0x303030[t${i}]`);
});
const pad = COLS * ROWS - files.length;
for (let i = 0; i < pad; i++) {
  filters.push(`color=c=black:s=${CW}x${Math.round(CW * 9 / 16)}[t${files.length + i}]`);
}
const stack = Array.from({ length: COLS * ROWS }, (_, i) => `[t${i}]`).join('');
filters.push(`${stack}xstack=inputs=${COLS * ROWS}:layout=${
  Array.from({ length: COLS * ROWS }, (_, i) => {
    const c = i % COLS, r = Math.floor(i / COLS);
    return `${c === 0 ? '0' : Array.from({ length: c }, (_, k) => `w${k}`).join('+')}_${r === 0 ? '0' : Array.from({ length: r }, (_, k) => `h${k * COLS}`).join('+')}`;
  }).join('|')}[out]`);

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs,
  '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', OUT],
{ stdio: 'inherit' });
console.log(`${OUT}  ${COLS}x${ROWS}, reading order:`);
files.forEach((f, i) => {
  const c = i % COLS;
  process.stdout.write(path.basename(f).replace(/\.[a-z]+$/, '').padEnd(22) + (c === COLS - 1 ? '\n' : ''));
});
if (files.length % COLS) process.stdout.write('\n');
