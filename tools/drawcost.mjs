// Is the frame bound by fill rate or by draw submission?
//   node tools/drawcost.mjs [url] [--webkit]
import { chromium, webkit } from 'playwright';
const args = process.argv.slice(2);
const URL = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:4173/';
const WK = args.includes('--webkit');
const B = WK ? webkit : chromium;
const b = await B.launch({ headless:false, ...(WK?{}:{args:['--use-angle=default','--enable-gpu','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']}) });
const ctx = await b.newContext({ viewport:{width:1512,height:945}, deviceScaleFactor:2 });
const p = await ctx.newPage();
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>{const x=document.getElementById('bootStart');return x&&!x.hidden;},{timeout:120000});
await p.click('#bootStart');
await p.waitForTimeout(3000);
await p.evaluate(()=>{ const e=window.__game.engine; e.prFloor=e.prCeil=e.maxPixelRatio; });
const s = async (n=5)=>{ await p.waitForTimeout(n*1000); return p.evaluate(()=>({fps:+window.__game.engine.fps.toFixed(1),draws:window.__game.engine.drawCalls})); };

const where = await p.evaluate(()=>{
  const g=window.__game; let ext=0, int=0;
  g.scene.traverse(o=>{ if(o.isMesh||o.isPoints||o.isLine) ext++; });
  g.interiorScene.traverse(o=>{ if(o.isMesh||o.isPoints||o.isLine) int++; });
  const shadowLights = g.interior.lights.filter(l=>l.castShadow).length;
  return {ext,int,shadowLights};
});
console.log(`${WK?'webkit':'chromium'}  meshes: exterior=${where.ext} interior=${where.int}  shadow lights=${where.shadowLights}`);
let r = await s(); console.log(`baseline                 ${r.fps} fps  ${r.draws} draws`);

await p.evaluate(()=>{ window.__game.renderer.shadowMap.autoUpdate=false; });
r = await s(4); console.log(`shadows frozen           ${r.fps} fps  ${r.draws} draws`);

await p.evaluate(()=>{ window.__game.renderer.shadowMap.enabled=false;
  window.__game.interiorScene.traverse(o=>{o.castShadow=false;o.receiveShadow=false;}); });
r = await s(4); console.log(`shadows off              ${r.fps} fps  ${r.draws} draws`);

await p.evaluate(()=>{ window.__game.interiorRig.visible=false; });
r = await s(4); console.log(`interior hidden          ${r.fps} fps  ${r.draws} draws`);

await p.evaluate(()=>{ window.__game.interiorRig.visible=true; window.__game.engine.post.enabled.fxaa=false; });
r = await s(4); console.log(`(interior back) no fxaa  ${r.fps} fps  ${r.draws} draws`);
await b.close();
