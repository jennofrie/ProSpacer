/* Colour and local-contrast statistics for a crop of a frame.
 *
 * "The ground has no albedo variation" is not actionable; "per-channel std
 * [30,20,11] against the reference's [55,53,45], saturation std 0.047 against
 * 0.171" is. Reports, over the region given (default: the bottom third, which
 * on a landed frame is the ground two metres from your boots):
 *
 *   per-channel std, saturation std, local std (8 px window), p1..p99 span.
 *
 *   node tools/chroma.mjs shot.png [--crop W:H:X:Y]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((f) => !f.startsWith('--') && (f.endsWith('.png') || f.endsWith('.jpg')));
const CROP = opt('crop', null);
const W = 480;

console.log('shot                     stdR  stdG  stdB   satMean satStd  locStd  p1  p99  span');
for (const f of files) {
  const TMP = '/tmp/_chroma.rgb';
  const vf = [];
  if (CROP) vf.push(`crop=${CROP}`);
  vf.push(`scale=${W}:-1`, 'format=rgb24');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-vf', vf.join(','),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', TMP]);
  const buf = fs.readFileSync(TMP);
  const n = buf.length / 3;
  const H = Math.round(n / W);
  const m = [0, 0, 0]; let sm = 0;
  const sat = new Float32Array(n), lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
    m[0] += r; m[1] += g; m[2] += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat[i] = mx > 0 ? (mx - mn) / mx : 0;
    sm += sat[i];
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  m[0] /= n; m[1] /= n; m[2] /= n; sm /= n;
  const v = [0, 0, 0]; let sv = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { const d = buf[i * 3 + c] - m[c]; v[c] += d * d; }
    const d = sat[i] - sm; sv += d * d;
  }
  // local std: the mean over 8x8 blocks of the std inside the block. Global std
  // counts a light sky over dark ground as "variation"; this counts texture.
  let loc = 0, blocks = 0;
  for (let by = 0; by + 8 <= H; by += 8) {
    for (let bx = 0; bx + 8 <= W; bx += 8) {
      let s = 0, s2 = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const L = lum[(by + y) * W + bx + x]; s += L; s2 += L * L;
      }
      const mu = s / 64;
      loc += Math.sqrt(Math.max(s2 / 64 - mu * mu, 0)); blocks++;
    }
  }
  loc /= Math.max(blocks, 1);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.round(lum[i]))]++;
  const pct = (p) => { let c = 0; for (let x = 0; x < 256; x++) { c += hist[x]; if (c >= n * p) return x; } return 255; };
  const p1 = pct(0.01), p99 = pct(0.99);
  console.log(`${path.basename(f).padEnd(22)} ${Math.sqrt(v[0] / n).toFixed(1).padStart(5)} `
    + `${Math.sqrt(v[1] / n).toFixed(1).padStart(5)} ${Math.sqrt(v[2] / n).toFixed(1).padStart(5)} `
    + `${sm.toFixed(3).padStart(7)} ${Math.sqrt(sv / n).toFixed(3).padStart(6)} ${loc.toFixed(1).padStart(7)} `
    + `${String(p1).padStart(3)} ${String(p99).padStart(4)} ${String(p99 - p1).padStart(5)}`);
  fs.rmSync(TMP, { force: true });
}
