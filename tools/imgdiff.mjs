/* How much two frames actually differ. Reports the fraction of pixels that
 * change by more than N levels, and the mean absolute difference — the only
 * honest way to answer "does this pass do anything".
 *   node tools/imgdiff.mjs a.png b.png [--thr 10]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const [a, b] = args.filter((f) => !f.startsWith('--'));
const THR = +opt('thr', 10);
const dec = (f, t) => {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f,
    '-vf', 'scale=756:472,format=gray', '-f', 'rawvideo', t]);
  return fs.readFileSync(t);
};
const A = dec(a, '/tmp/_d0.gray'), B = dec(b, '/tmp/_d1.gray');
let over = 0, sum = 0, mx = 0;
for (let i = 0; i < A.length; i++) {
  const d = Math.abs(A[i] - B[i]);
  if (d > THR) over++;
  sum += d; if (d > mx) mx = d;
}
console.log(`${(100 * over / A.length).toFixed(3)}% of pixels differ by >${THR}`
  + `   mad=${(sum / A.length).toFixed(2)}   max=${mx}`);
fs.rmSync('/tmp/_d0.gray', { force: true }); fs.rmSync('/tmp/_d1.gray', { force: true });
