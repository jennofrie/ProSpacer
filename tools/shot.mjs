// Browser verification harness.
//   node tools/shot.mjs <name> [--w 1600] [--h 900] [--wait 9000] [--script file.js]
// Launches headed Chromium with real GPU rasterisation, waits for the game to
// boot, optionally runs a driver script inside the page, then screenshots and
// dumps console output + an fps sample.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const name = args[0] || 'shot';
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const W = +opt('w', 1600), H = +opt('h', 900);
const WAIT = +opt('wait', 9000);
const SCRIPT = opt('script', null);
const START = opt('start', '1') !== '0';
const outDir = 'shots';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: [
    '--use-angle=default',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  isMobile: opt('mobile', '0') === '1',
  hasTouch: opt('mobile', '0') === '1',
});
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });

// wait for boot to finish
try {
  await page.waitForFunction(() => {
    const b = document.getElementById('bootStart');
    return b && !b.hidden;
  }, { timeout: 60000 });
} catch {
  logs.push('[harness] boot never completed');
}

if (START) {
  await page.click('#bootStart').catch(() => { });
  await page.waitForTimeout(1500);
}

if (SCRIPT) {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  try {
    await page.evaluate(`(async () => { ${src} })()`);
  } catch (e) {
    logs.push('[script error] ' + e.message);
  }
}

await page.waitForTimeout(WAIT);

// sample fps + renderer stats
const stats = await page.evaluate(() => {
  const g = window.__game;
  if (!g) return null;
  return {
    fps: +g.engine.fps.toFixed(1),
    pixelRatio: +g.engine.pixelRatio.toFixed(2),
    quality: g.quality,
    calls: g.engine.drawCalls,
    tris: g.engine.triangles,
    system: g.system?.star?.name,
    bodies: g.bodies.length,
    memGeo: g.renderer.info.memory.geometries,
    memTex: g.renderer.info.memory.textures,
    shipSpeed: +g.ship.speed.toFixed(2),
    target: g.target?.name,
  };
});

await page.screenshot({ path: path.join(outDir, name + '.png') });
console.log(JSON.stringify(stats, null, 2));
const errs = logs.filter((l) => /error|warn|invalid|fail/i.test(l));
console.log('--- console (' + logs.length + ' lines, showing issues + last 15) ---');
console.log(errs.slice(0, 40).join('\n'));
console.log(logs.slice(-15).join('\n'));

await browser.close();
