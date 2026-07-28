/* Ground bench: boot once, land on a list of worlds, pin the clock, measure and
   shoot.  Not part of the ship — a scratch tool for the landed-scene work.

   node tools/gnd.mjs --out /tmp/gnd/base --worlds terran,desert,barren,ice
                      --elev 0.34 [--also 0.08,0.7] [--dpr 2 --w 1512 --h 945]

   Everything it reports is taken with `landed.t` redefined as a non-writable
   getter after setSunElevation, so two runs shoot the same sun. */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { readFileSync } from 'fs';
import { bootGame } from './boot.mjs';

/* The grid constants, read out of the source rather than copied into here —
   a bench that quotes a stale RING_MIN reports the octave count of the build
   you were trying to change. */
const SRC = readFileSync(new URL('../src/world/Surface.js', import.meta.url), 'utf8');
const num = (n) => {
  const m = SRC.match(new RegExp(n + '\\s*=\\s*([0-9.]+)'));
  if (!m) throw new Error('cannot find ' + n + ' in Surface.js');
  return +m[1];
};
const RING_MIN = num('RING_MIN'), RING_MAX = num('RING_MAX'),
  RING_A = num('RING_A'), RING_P = num('RING_P');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', '/tmp/gnd/x');
const WORLDS = opt('worlds', 'terran').split(',').filter(Boolean);
const ELEVS = opt('elev', '0.34').split(',').map(Number);
const SETTLE = +opt('settle', 3500);
const SHOTS = opt('shots', 'crane,foot,sky').split(',');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage({
  viewport: { width: +opt('w', 1512), height: +opt('h', 945) },
  deviceScaleFactor: +opt('dpr', 2),
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await bootGame(page, { setup: '1' });

/* Land, pin the clock, and hand back what the harness measured. */
const LAND = (kind, elev) => `(()=>{
  const g = window.__game;
  g.director.stop(); g.inspect({off:true});
  if (g.landed) { try { delete g.landed.t; } catch(e){} g.liftOff({now:true}); }
  g.mode='exterior';
  g.pose({kind:${JSON.stringify(kind)}, dist:1.6, phase:70, elev:8});
  g.land(g.target, {now:true}); g.director.stop();
  g.setSunElevation(${elev});
  const T = g.landed.t;
  Object.defineProperty(g.landed, 't', { get:()=>T, set:()=>{}, configurable:true });
  g.setLayer('hud', false);
  return { world:g.landed.body.name, type:g.landed.body.spec.type, t:T,
           sunY:+g.surface.skyMat.uniforms.uSunDir.value.y.toFixed(5) };
})()`;

const results = [];
for (const kind of WORLDS) {
  for (const elev of ELEVS) {
    let info;
    try {
      info = await bootGame(page, { setup: LAND(kind, elev), settle: SETTLE });
    } catch (e) { console.log(`skip ${kind}: ${String(e.message).split('\n')[0]}`); continue; }
    const tag = `${kind}-${String(elev).replace('.', 'p')}`;
    // crane: the default landed camera, worst pose of the orbit is what perf
    // quotes; here we only need it reproducible.
    if (SHOTS.includes('crane')) {
      await page.screenshot({ path: `${OUT}/${tag}-crane.png` });
    }
    const setPose = async (js) => {
      // Another agent editing src/ mid-run throws away the JS context, and a
      // bare evaluate then dies with "execution context destroyed". Re-land and
      // retry rather than losing the whole sweep.
      for (let k = 0; k < 3; k++) {
        try { await page.evaluate(js); return true; } catch (e) {
          console.log('  [re-land] ' + String(e.message).split('\n')[0]);
          try { await bootGame(page, { setup: LAND(kind, elev), settle: SETTLE }); }
          catch (e2) { return false; }
        }
      }
      return false;
    };
    if (SHOTS.includes('foot')) {
      await setPose(`(()=>{ const g=window.__game;
        if (!g.landed.onFoot) g.disembark();
        g.player.pos.set(26, 0, 34); g.player.yaw = Math.atan2(-26,-34)+0.9; g.player.pitch = -0.22;
      })()`);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `${OUT}/${tag}-foot.png` });
    }
    if (SHOTS.includes('sky')) {
      await setPose(`(()=>{ const g=window.__game;
        if (!g.landed.onFoot) g.disembark();
        g.player.pos.set(26, 0, 34); g.player.pitch = 0.02;
        // face away from the ship, at the horizon
        g.player.yaw = Math.atan2(-26,-34) + Math.PI;
      })()`);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/${tag}-sky.png` });
    }
    let m; try { m = await page.evaluate(`(()=>{ const g=window.__game; const s=g.surface;
      const out = { fps:+g.engine.fps.toFixed(1), calls:g.engine.drawCalls };
      /* Relief, at full detail so this cannot be an LOD artifact: peak-to-peak
         of the ground height on a ring of radius r about the landing site. */
      const band = (r, n, lod) => { let lo=1e9, hi=-1e9;
        for (let i=0;i<n;i++){ const a=i/n*Math.PI*2;
          const y=s.heightAt(Math.cos(a)*r, Math.sin(a)*r, lod);
          if(y<lo)lo=y; if(y>hi)hi=y; }
        return +(hi-lo).toFixed(3); };
      out.relief = { r45: band(45, 96, 0.3), r150: band(150, 96, 0.3),
                     r800: band(800, 128, 2), r4000: band(4000, 192, 8) };
      /* The skyline, counted. Walk an arc at range and count local maxima of
         the height field, at the lod the mesh actually hands it and at a fine
         lod. A row of equal triangles gives few, evenly spaced peaks at render
         lod and many, unevenly spaced ones when it is allowed more octaves. */
      const peaks = (R, arcDeg, lod, n) => {
        const ys = []; const a0 = 0.7;
        for (let i=0;i<n;i++){
          const a = a0 + (i/(n-1) - 0.5)*arcDeg*Math.PI/180;
          ys.push(s.heightAt(Math.cos(a)*R, Math.sin(a)*R, lod));
        }
        let c=0; const xs=[];
        for (let i=2;i<n-2;i++)
          if (ys[i]>ys[i-1] && ys[i]>ys[i-2] && ys[i]>=ys[i+1] && ys[i]>=ys[i+2]) { c++; xs.push(i); }
        // how even the spacing is: 1.0 = a perfect picket fence
        let ev = 0;
        if (xs.length>2){ const d=[]; for(let i=1;i<xs.length;i++) d.push(xs[i]-xs[i-1]);
          const mu=d.reduce((a,b)=>a+b,0)/d.length;
          const sd=Math.sqrt(d.reduce((a,b)=>a+(b-mu)*(b-mu),0)/d.length);
          ev = +(1 - sd/Math.max(mu,1e-6)).toFixed(3); }
        return { n:c, even:ev };
      };
      const ml = (d) => { const U=s.U; const k=U.uLodK.value;
        const RMIN=${RING_MIN}, RMAX=${RING_MAX}, K1=${(RING_A * Math.pow(1000, RING_P)).toFixed(9)};
        const p = k*Math.pow(Math.max(d,1), ${(1 - RING_P).toFixed(4)});
        return 0.26 + Math.min(Math.max(p, d*k*RMIN/K1), d*k*RMAX/K1); };
      out.lod = { at4k:+ml(4000).toFixed(1), at7k:+ml(7000).toFixed(1), at10k:+ml(10000).toFixed(1) };
      out.oct = { at7k:+Math.min(1+Math.log2(330/Math.max(ml(7000),0.5))*0.95238,5).toFixed(2),
                  at10k:+Math.min(1+Math.log2(330/Math.max(ml(10000),0.5))*0.95238,5).toFixed(2) };
      out.peaks7kRender = peaks(7000, 26, ml(7000), 400);
      out.peaks7kFine   = peaks(7000, 26, 4, 400);
      return out;
    })()`); } catch (e) { console.log('  [measure failed] ' + String(e.message).split('\n')[0]); continue; }
    console.log(`${tag}  ${info.world} (${info.type})  sunY=${info.sunY}  fps=${m.fps} calls=${m.calls}`);
    console.log(`   relief  45m=${m.relief.r45}  150m=${m.relief.r150}  800m=${m.relief.r800}  4km=${m.relief.r4000}`);
    console.log(`   lod ${JSON.stringify(m.lod)}  oct ${JSON.stringify(m.oct)}`);
    console.log(`   peaks@7km/26deg  render=${m.peaks7kRender.n} (even ${m.peaks7kRender.even})`
      + `  fine=${m.peaks7kFine.n} (even ${m.peaks7kFine.even})`);

    /* Shadow A/B: how much of the frame the sun's shadow map is actually
       deciding. Two captures of one pose with castShadow flipped. */
    if (SHOTS.includes('ab')) {
      await setPose(`(()=>{ const g=window.__game;
        if (!g.landed.onFoot) g.disembark();
        g.player.pos.set(26, 0, 34); g.player.yaw = Math.atan2(-26,-34)+0.9; g.player.pitch = -0.22;
      })()`);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/${tag}-ab-on.png` });
      await page.evaluate(`window.__game.sunLight.castShadow=false; window.__game.renderer.shadowMap.needsUpdate=true;`);
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${OUT}/${tag}-ab-off.png` });
      await page.evaluate(`window.__game.sunLight.castShadow=true; window.__game.renderer.shadowMap.needsUpdate=true;`);
      await page.waitForTimeout(600);
    }
    results.push({ tag, ...info, ...m });
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));
await browser.close();
