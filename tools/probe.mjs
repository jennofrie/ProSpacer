// Ad-hoc probe: boot the game, run JS, optionally screenshot.
//   node tools/probe.mjs "expr" [--shot path] [--settle ms] [--w 1600] [--h 900]
import { chromium } from 'playwright';
import { bootGame } from './boot.mjs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const EXPR = args[0] && !args[0].startsWith('--') ? args[0] : '1';
const SHOT = opt('shot', null);
const SETTLE = +opt('settle', 1200);
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
/* deviceScaleFactor matters more than the viewport. A capture at 1 is about a
   megapixel; the laptop this is judged on is a 2x Retina panel at nearly six.
   Sharpness and aliasing verdicts taken at 1 are worthless — pass --dpr 2. */
const page = await browser.newPage({
  viewport: { width: +opt('w', 1600), height: +opt('h', 900) },
  deviceScaleFactor: +opt('dpr', 1),
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await page.goto('http://localhost:5173/' + (opt('q', null) ? '?q=' + opt('q') : ''), { waitUntil: 'domcontentloaded' });
const AFTER = opt('after', null);
const out = await bootGame(page, { setup: EXPR, settle: (SHOT || AFTER) ? SETTLE : 0, after: AFTER });
if (out !== undefined && out !== null) console.log(JSON.stringify(out, null, 2));
if (SHOT) {
  await page.screenshot({ path: SHOT });
  const st = await page.evaluate(() => ({
    fps: +window.__game.engine.fps.toFixed(0), calls: window.__game.engine.drawCalls,
  }));
  console.log(`shot ${SHOT}  fps=${st.fps} calls=${st.calls}`);
}
await browser.close();
