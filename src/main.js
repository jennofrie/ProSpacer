import './ui/style.css';
import { Game } from './game/Game.js';
import { INTRO_LINES } from './game/lore.js';

const bootEl = document.getElementById('boot');
const fill = document.getElementById('bootFill');
const status = document.getElementById('bootStatus');
const startBtn = document.getElementById('bootStart');

function progress(p, text) {
  fill.style.right = `${Math.max(0, (1 - p) * 100)}%`;
  if (text) status.textContent = text;
}

function fatal(msg, err) {
  status.innerHTML = `<span style="color:#ff6b5e">${msg}</span>`;
  if (err) console.error(err);
}

/**
 * Phones are turned away at the door rather than served a reduced build.
 *
 * This game spends its entire budget on one thing: how it looks at full
 * resolution on a discrete GPU. Everything that makes it worth looking at —
 * the raymarched atmospheres, the volumetric cloud decks, the terrain
 * self-shadowing, the twenty-pass post chain — is exactly what a phone cannot
 * afford. The honest options were to cut those features for everyone or to
 * ship a phone build that misrepresents the game. Neither is worth it, so a
 * handset gets a short, clear message instead of a bad first impression.
 */
function isHandset() {
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const small = Math.min(window.screen.width, window.screen.height) < 820;
  return coarse && small;
}

function desktopOnly() {
  bootEl.innerHTML = `
    <div class="boot-inner">
      <h1 class="boot-title">PROSPACER</h1>
      <div class="boot-sub">DEEP SURVEY VESSEL &middot; <span class="accent">PALE SEEKER</span></div>
      <p class="boot-gate">
        This one wants a real screen and a real GPU.<br>
        Open it on a desktop or laptop.
      </p>
      <div class="boot-legal">requires WebGL2 &middot; headphones recommended</div>
    </div>`;
  bootEl.classList.add('gate');
}

(async () => {
  const canvas = document.getElementById('scene');

  if (isHandset()) { desktopOnly(); return; }

  // WebGL2 gate
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) { fatal('WebGL2 unavailable on this device'); return; }

  let game;
  try {
    game = new Game(canvas, progress);
    window.__game = game;
    await game.boot();
  } catch (e) {
    fatal('initialisation failed — see console', e);
    return;
  }

  status.textContent = 'systems nominal';
  startBtn.hidden = false;

  const begin = async () => {
    startBtn.hidden = true;
    bootEl.classList.add('out');
    setTimeout(() => bootEl.style.display = 'none', 1000);
    game.hud.show();
    game.started = true;
    try { await game.audio.resume(); } catch { /* autoplay policy */ }

    // opening beats
    INTRO_LINES.forEach((l, i) => {
      setTimeout(() => game.hud.narrate(l.text, l.who), 1200 + i * 5200);
    });
    setTimeout(() => {
      game.hud.log('SCANNER ONLINE', 'ok');
      game.hud.log(`SYSTEM · ${game.system.star.name.toUpperCase()}`);
    }, 900);
  };

  startBtn.addEventListener('click', begin);
  window.addEventListener('keydown', (e) => {
    if (!game.started && (e.code === 'Enter' || e.code === 'Space')) begin();
  });

  /* ---------------------------------------------------------------- loop
     ?record=N drives the loop by hand at a fixed 1/N second step instead of
     from the wall clock. Capture is far slower than real time, so a recorder
     that samples a free-running loop gets uneven, stuttering motion; stepping
     one frame per captured image means the footage plays back at exactly the
     intended speed however long the grab took. */
  const RECORD = +(new URLSearchParams(location.search).get('record') || 0);
  let last = performance.now();
  const MAX_DT = 1 / 15;

  function step(dt) {
    try {
      if (game.started) game.update(dt);
      else game.updateIdle?.(dt);
      game.engine.time = game.time;
      game.engine.dt = dt;
      // the cabin is a second pass with its own camera; see Engine.render
      game.engine.render(
        game.interiorRig && game.interiorRig.visible ? game.interiorScene : null,
        game.interiorCam);
      if (!RECORD) game.engine.adapt(dt);
    } catch (e) {
      console.error(e);
      fatal('runtime error — see console', e);
      throw e;
    }
  }

  function tick(now) {
    requestAnimationFrame(tick);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > MAX_DT) dt = MAX_DT;
    if (document.hidden) return;
    step(dt);
  }

  if (RECORD) {
    // one frame per call, so the capture tool controls time exactly
    window.__step = (n = 1) => { for (let i = 0; i < n; i++) step(1 / RECORD); };
    step(1 / RECORD);
  } else {
    requestAnimationFrame(tick);
  }
})();
