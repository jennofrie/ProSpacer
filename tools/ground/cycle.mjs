/* Land and lift off for real, through the cutscenes, recording frame times. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { bootGame } from '../boot.mjs';
const args = process.argv.slice(2);
const opt=(k,d)=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:d;};
const OUT = opt('out','/tmp/cycle');
mkdirSync(OUT,{recursive:true});
const browser = await chromium.launch({ headless: true, args: ['--use-angle=default','--enable-gpu','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required','--hide-scrollbars'] });
const page = await browser.newPage({ viewport:{width:1512,height:850}, deviceScaleFactor:+opt('dpr',2) });
page.on('pageerror', e=>console.log('[pageerror]',e.message));
page.on('console', m=>{ if(m.type()==='error') console.log('[err]',m.text()); });
await page.goto('http://localhost:5173/', { waitUntil:'domcontentloaded' });
await bootGame(page, { settle: 1500 });
await page.evaluate(() => {
  const g=window.__game;
  g.__fr=[]; let last=performance.now();
  const tick=()=>{ const n=performance.now(); g.__fr.push(+(n-last).toFixed(1)); last=n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const b=g.bodies.find(x=>x.planet&&!x.planet.isGas&&x.spec);
  g.target=b;
  g.ship.absPos.copy(b.absPos).addScaledVector(new g.ship.absPos.constructor(0,1,0), b.radius*1.5);
  g.setLayer('hud', false);
  g.__b=b;
});
await page.waitForTimeout(600);
await page.evaluate(() => { window.__game.__fr.length=0; window.__game.land(window.__game.__b); });
for (let i=0;i<10;i++){ await page.waitForTimeout(700); await page.screenshot({path:`${OUT}/land${String(i).padStart(2,'0')}.jpg`, quality:88, type:'jpeg'}); }
let r = await page.evaluate(()=>({ fr: window.__game.__fr.slice(), landed: !!window.__game.landed, mode: window.__game.mode, dir: window.__game.director.active }));
console.log('LAND worst frames', r.fr.slice().sort((a,b)=>b-a).slice(0,6), 'landed', r.landed, 'mode', r.mode);
await page.waitForTimeout(3000);
await page.evaluate(()=>{ window.__game.director.stop(); window.__game.__fr.length=0; window.__game.liftOff(); });
for (let i=0;i<12;i++){ await page.waitForTimeout(700); await page.screenshot({path:`${OUT}/lift${String(i).padStart(2,'0')}.jpg`, quality:88, type:'jpeg'}); }
r = await page.evaluate(()=>({ fr: window.__game.__fr.slice(), landed: !!window.__game.landed, mode: window.__game.mode, dir: window.__game.director.active,
  fold: (()=>{ const g=window.__game; const n=g.nearestBodyInfo(); return {surfaceDist:+n.surfaceDist.toFixed(0), floor:+g.foldFloor(n).toFixed(0)}; })() }));
console.log('LIFT worst frames', r.fr.slice().sort((a,b)=>b-a).slice(0,6), 'landed', r.landed, 'mode', r.mode, 'dir', r.dir, JSON.stringify(r.fold));
// and can we fold?
const f = await page.evaluate(()=>{ const g=window.__game; g.director.stop(); g.toggleFold(true); return g.ship.foldMode; });
await page.waitForTimeout(1500);
const f2 = await page.evaluate(()=>({fold:window.__game.ship.foldMode, spd:+window.__game.ship.speed.toFixed(0)}));
console.log('fold engaged', f, 'after 1.5s', JSON.stringify(f2));
await browser.close();
