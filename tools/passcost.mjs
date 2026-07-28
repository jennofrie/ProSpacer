// Where does the frame go? Toggles individual passes and measures the delta.
//   node tools/passcost.mjs [url] [--webkit] [--w 1512] [--h 945] [--dpr 2]
import { chromium, webkit } from 'playwright';
const args = process.argv.slice(2);
const opt = (k,d)=>{const i=args.indexOf('--'+k);return i>=0?+args[i+1]:d;};
const URL = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:4173/';
const W=opt('w',1512),H=opt('h',945),DPR=opt('dpr',2);
const WK = args.includes('--webkit');
const B = WK ? webkit : chromium;

const b = await B.launch({ headless:false, ...(WK?{}:{args:['--use-angle=default','--enable-gpu','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']}) });
const ctx = await b.newContext({ viewport:{width:W,height:H}, deviceScaleFactor:DPR });
const p = await ctx.newPage();
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>{const x=document.getElementById('bootStart');return x&&!x.hidden;},{timeout:120000});
await p.click('#bootStart');
await p.waitForTimeout(3000);
// pin resolution so the adaptive controller cannot confound the comparison
await p.evaluate(()=>{ const e=window.__game.engine; e.prFloor=e.prCeil=e.maxPixelRatio; });

const sample = async (secs=5) => {
  await p.waitForTimeout(secs*1000);
  return p.evaluate(()=>+window.__game.engine.fps.toFixed(1));
};
const set = (name,on) => p.evaluate(([n,o])=>window.__game.setLayer(n,o),[name,on]);

console.log(`${WK?'webkit':'chromium'}  ${W}x${H}@${DPR}  ${((W*DPR*H*DPR)/1e6).toFixed(1)} MP`);
const base = await sample();
console.log(`baseline                 ${base} fps`);
for (const layer of ['bloom','streak','flare','atmo','clouds','stars','bg']) {
  await set(layer,false);
  const f = await sample(4);
  console.log(`without ${layer.padEnd(16)} ${String(f).padStart(5)} fps   (${f>base?'+':''}${(f-base).toFixed(1)})`);
  await set(layer,true);
  await p.waitForTimeout(600);
}
await b.close();
