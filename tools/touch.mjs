// Touch-control test: drives the virtual sticks and buttons with real touch
// events and asserts the flight model responds.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => { const b = document.getElementById('bootStart'); return b && !b.hidden; }, { timeout: 90000 });
await page.tap('#bootStart');
await page.waitForTimeout(1600);

const out = [];
const check = (n, ok, d = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(32)} ${d}`);
const G = fn => page.evaluate(fn);

check('touch UI is visible', await G(() => !document.getElementById('touchUI').classList.contains('hidden')));

// no HUD element may overlap the thumb sticks
const overlap = await G(() => {
  const r = el => el.getBoundingClientRect();
  const sticks = ['stickL', 'stickR'].map(id => r(document.getElementById(id)));
  const bad = [];
  for (const el of document.querySelectorAll('#leftPanel, #rightPanel, #scanPanel, #log, #touchThr, #touchBtns')) {
    if (getComputedStyle(el).display === 'none') continue;
    const b = r(el);
    for (const s of sticks) {
      if (b.left < s.right && b.right > s.left && b.top < s.bottom && b.bottom > s.top) bad.push(el.id);
    }
  }
  return [...new Set(bad)];
});
check('no instrument overlaps a stick', overlap.length === 0, overlap.join(',') || 'clear');

// nothing may spill outside the viewport
const spill = await G(() => {
  const bad = [];
  for (const el of document.querySelectorAll('#hud [id], #touchUI [id]')) {
    if (getComputedStyle(el).display === 'none' || !el.id) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0) continue;
    if (b.right > innerWidth + 1 || b.left < -1 || b.bottom > innerHeight + 1 || b.top < -1) bad.push(el.id);
  }
  return bad;
});
check('nothing spills off-screen', spill.length === 0, spill.join(',') || 'clear');

// Flight sticks only mean anything at the helm, so sit down first.
await G(() => {
  const g = window.__game;
  const st = g.interior.stations.find((x) => x.id === 'seat');
  g.player.pos.set(st.pos.x, 0, st.pos.z); g.player.yaw = 0;
  g.player.sit(st); g.player._t = 1; g.player.mode = 'seated'; g.mode = 'pilot';
});
await page.waitForTimeout(500);
check('at the helm for stick tests', await G(() => window.__game.mode === 'pilot'));

// right stick vertical = throttle
const rs = await page.locator('#stickR').boundingBox();
await page.touchscreen.tap(rs.x + rs.width / 2, rs.y + rs.height / 2);
await page.evaluate(async ([x, y]) => {
  const el = document.getElementById('stickR');
  const mk = (t, cx, cy) => new TouchEvent(t, { bubbles: true, cancelable: true,
    changedTouches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })] });
  el.dispatchEvent(mk('touchstart', x, y));
  for (let i = 0; i < 30; i++) { el.dispatchEvent(mk('touchmove', x, y - 44)); await new Promise(r => setTimeout(r, 33)); }
  el.dispatchEvent(mk('touchend', x, y - 44));
}, [rs.x + rs.width / 2, rs.y + rs.height / 2]);
await page.waitForTimeout(500);
let s = await G(() => window.__game.ship.throttle);
check('right stick raises throttle', s > 0.3, `throttle=${s.toFixed(2)}`);

// left stick = pitch/yaw
const q0 = await G(() => window.__game.ship.quat.toArray());
const ls = await page.locator('#stickL').boundingBox();
await page.evaluate(async ([x, y]) => {
  const el = document.getElementById('stickL');
  const mk = (t, cx, cy) => new TouchEvent(t, { bubbles: true, cancelable: true,
    changedTouches: [new Touch({ identifier: 2, target: el, clientX: cx, clientY: cy })] });
  el.dispatchEvent(mk('touchstart', x, y));
  for (let i = 0; i < 25; i++) { el.dispatchEvent(mk('touchmove', x + 44, y)); await new Promise(r => setTimeout(r, 33)); }
  el.dispatchEvent(mk('touchend', x + 44, y));
}, [ls.x + ls.width / 2, ls.y + ls.height / 2]);
const q1 = await G(() => window.__game.ship.quat.toArray());
check('left stick steers', q0.some((v, i) => Math.abs(v - q1[i]) > 0.01));

await G(() => { window.__game.player.stand(); });
await page.waitForTimeout(1200);

// action buttons
// action buttons are relabelled per mode: on foot, `scan` reads MAP and
// `auto` reads ARC, and the handlers have to follow the labels
await G(() => { window.__game.mode = 'walk'; window.__game.player.mode = 'walk'; });
await page.waitForTimeout(300);
await page.tap('[data-act="scan"]'); await page.waitForTimeout(600);
check('MAP button opens star map', await G(() => window.__game.starmap.open));
// The chart is a hologram in the room now, so there is no panel chrome to tap.
await G(() => window.__game.starmap.close()); await page.waitForTimeout(400);
check('MAP button closes again', !(await G(() => window.__game.starmap.open)));
await page.tap('[data-act="auto"]'); await page.waitForTimeout(600);
check('ARC button opens archive', await G(() => window.__game.archive.open));
await page.tap('.p-close[data-close="archive"]'); await page.waitForTimeout(400);

// the USE button must reach a station
await G(() => {
  const g = window.__game;
  const st = g.interior.stations.find((x) => x.id === 'seat');
  g.player.pos.set(st.pos.x, 0, st.pos.z); g.player.yaw = 0;
});
await page.waitForTimeout(400);
await page.tap('[data-act="use"]'); await page.waitForTimeout(1400);
check('USE button takes the helm', await G(() => window.__game.mode === 'pilot'));
await page.screenshot({ path: 'shots/mobile/touch.png' });

console.log(out.join('\n'));
if (errs.length) console.log('errors:\n' + errs.slice(0, 6).join('\n'));
const f = out.filter(r => r.startsWith('FAIL')).length;
console.log(`\n${out.length - f}/${out.length} passed`);
await browser.close();
process.exit(f ? 1 : 0);
