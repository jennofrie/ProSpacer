// Frame the deployed cartography hologram.
//   node tools/mapshot.mjs [out.png]
import { chromium } from 'playwright';
const OUT = process.argv[2] || 'shots/holomap.png';
const b = await chromium.launch({ headless:false, args:['--use-angle=default','--enable-gpu','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required','--hide-scrollbars'] });
const ctx = await b.newContext({ viewport:{width:1600,height:900}, deviceScaleFactor:2 });
const p = await ctx.newPage();
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>{const x=document.getElementById('bootStart');return x&&!x.hidden;},{timeout:120000});
await p.click('#bootStart');
await p.waitForTimeout(2200);
await p.evaluate(()=>{
  const g = window.__game;
  g.mode='walk'; g.player.mode='walk';
  g.player.pos.set(0, 0, 1.5); g.player.yaw = 0; g.player.pitch = -0.25;
  g.holoMap.show();
  document.getElementById('hud').style.display='none';
});
await p.waitForTimeout(3500);
await p.screenshot({path:OUT});
console.log('wrote', OUT);
await b.close();
