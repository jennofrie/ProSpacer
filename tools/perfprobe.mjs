// Reproduce a real Retina laptop, not a 720p test window.
//
// The suites run at deviceScaleFactor 1 on a small viewport, which is about a
// megapixel. A 14" MacBook at default scaling is 1512x945 CSS at DPR 2 — 5.7
// megapixels, six times the fill. This samples fps AND the renderer's own
// pixelRatio over time, because the dynamic-resolution controller can quietly
// trade the image away to hold frame rate.
//
//   node tools/perfprobe.mjs [url] [--w 1512] [--h 945] [--dpr 2] [--secs 24]
import { chromium, webkit } from 'playwright';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? +args[i + 1] : d; };
const URL = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:4173/';
const W = opt('w', 1512), H = opt('h', 945), DPR = opt('dpr', 2), SECS = opt('secs', 24);
// WebKit is the one that matters for Safari, and its WebGL backend is not
// Chrome's — measure it rather than extrapolating from Chromium numbers.
const ENGINE = args.includes('--webkit') ? webkit : chromium;
const ENGINE_NAME = args.includes('--webkit') ? 'webkit' : 'chromium';

const browser = await ENGINE.launch({
  headless: false,
  ...(ENGINE_NAME === 'chromium' ? {
    args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
  } : {}),
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: DPR,
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const b = document.getElementById('bootStart'); return b && !b.hidden;
}, { timeout: 120000 });
await page.click('#bootStart');

const q = await page.evaluate(() => window.__game?.quality);
console.log(`${ENGINE_NAME}  ${URL}   ${W}x${H} @${DPR}x = ${((W*DPR*H*DPR)/1e6).toFixed(1)} MP  quality=${q}`);
console.log('  t   fps   pxRatio  renderPx   draws   mode');
for (let i = 0; i < SECS; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const e = window.__game.engine;
    return {
      fps: +e.fps.toFixed(0), pr: +e.pixelRatio.toFixed(2),
      maxpr: +e.maxPixelRatio.toFixed(2),
      w: e.renderer.domElement.width, h: e.renderer.domElement.height,
      draws: e.drawCalls, mode: window.__game.mode,
    };
  });
  console.log(`${String(i + 1).padStart(3)}  ${String(s.fps).padStart(4)}   ${String(s.pr).padStart(5)} (max ${s.maxpr})  ${s.w}x${s.h}  ${String(s.draws).padStart(5)}   ${s.mode}`);
}
await browser.close();
