// Bounce the game's own score to a WAV.
//
// The music is synthesised, not sampled, so there is no track to drop under the
// footage — but the same code that performs it live will perform it into an
// OfflineAudioContext. Phrases are scheduled explicitly across the timeline
// because offline rendering has no wall clock for update() to advance against.
//
// Two arrangements:
//
//   --arr ambient   what the game plays: phrases end to end with the rests the
//                   live score would leave. For the long launch video.
//   --arr trailer   the same instrument, arranged to picture. The game's score
//                   drifts on purpose — it is scored for hours of flying, and
//                   under a twenty-six second cut it reads as ambience with no
//                   opinion. This mode keeps every voice, the key, the
//                   progression, the delay bus and the room, and gives them a
//                   shape: hits on the cuts, a pulse only where the picture is
//                   moving, the whole thing out of the way on the ground, and
//                   the one timbre reserved for the Choir.
//
//   node tools/score.mjs [--arr trailer] [--secs 26.4] [--out shots/score.wav]
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ARR = opt('arr', 'ambient');
let SECS = +opt('secs', ARR === 'trailer' ? 26.4 : 32);
const OUT = opt('out', ARR === 'trailer' ? 'shots/score.wav' : 'shots/_edit/score.wav');
fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });

/* Cut points, verbatim from the EDL in tools/trailercut.mjs.
 *
 * The music is cut to the picture and not the other way round: the shot lengths
 * were chosen for what is in them, and dragging them onto a bar grid would be
 * fixing the wrong thing. So there is no tempo — there are *events*, and the
 * only metrical thing in the arrangement is a sub pulse that runs inside two
 * sections and stops at their boundaries. */
const NOMINAL = {
  canopy: 0.00, cabin: 4.60, orbit: 9.70, closer: 15.10,
  dive: 19.50, deck: 23.70, parked: 28.90,
  ground: 33.50, boots: 38.80, title: 43.30, end: 48.90,
};
/* ...and if the cut has actually been assembled, the *measured* times instead.
 *
 * Every segment is quantised to whole frames, so the real cut drifts from the
 * intended one — and an in-point near the end of its take is quantised to
 * whatever is left, which on one shot was half a second. Music that hits the
 * spreadsheet rather than the picture is worse than music that does not hit
 * anything, because the miss reads as sloppiness rather than as a choice. */
const CUT = { ...NOMINAL };
const MEASURED = 'shots/.cut/cuts.json';
if (fs.existsSync(MEASURED)) {
  const m = JSON.parse(fs.readFileSync(MEASURED, 'utf8'));
  const at = (i) => Object.entries(m).find(([k]) => k.endsWith(':' + i))?.[1];
  const map = ['canopy', 'cabin', 'orbit', 'closer', 'dive', 'deck', 'parked',
    'ground', 'boots', 'title'];
  map.forEach((name, i) => { const t = at(i); if (t !== undefined) CUT[name] = t; });
  CUT.end = m.total;
  console.log(`cut times from ${MEASURED} — ends at ${CUT.end.toFixed(2)}s`);
}

// render exactly as long as the picture, plus a breath for the tail
if (ARR === 'trailer' && !args.includes('--secs')) SECS = CUT.end + 0.30;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game, { timeout: 120000 });

const b64 = await page.evaluate(async ({ secs, arr, C }) => {
  const { Audio } = await import('/src/audio/Audio.js');
  const SR = 44100;
  const off = new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
  const a = new Audio();
  a.init(off);
  a.master.gain.value = 0.9;

  if (arr !== 'trailer') {
    // Lay phrases end to end with the rests the live score would leave.
    let t = 0.15;
    let guard = 0;
    while (t < secs - 2 && guard++ < 64) {
      const len = a._schedulePhrase(t, 0.85);
      a._chordIdx++;
      t += len + 4.5;
    }
    // a low bed of room air so the gaps are not digital silence
    a.room.gain.setValueAtTime(0.05, 0);
  } else {
    /* ---------------------------------------------------- the arrangement
     *
     * Everything here is built from `off` directly rather than from the
     * Audio class's helpers where the helper does not exist — but it all
     * routes into the *game's* buses (`music`, `wet`, `padFilter`), so the
     * compressor glue, the cross-panned delay and the room are the ones the
     * game uses, and the result sits in the same space as the game does. */
    const BASE = 110;                                  // A2, as src/audio has it
    const semi = (n) => BASE * Math.pow(2, n / 12);
    // the game's own progression, as scale degrees over A
    const Am9 = [0, 3, 7, 10, 14];
    const Fmaj = [-4, 0, 3, 7, 11];
    const Cmaj = [3, 7, 10, 14, 17];
    const G69 = [-2, 2, 5, 9, 14];

    const gain = (v = 0) => { const g = off.createGain(); g.gain.value = v; return g; };
    const osc = (type, f) => {
      const o = off.createOscillator(); o.type = type; o.frequency.value = f; return o;
    };
    /* One buffer of white noise, reused. Allocating a fresh one per event is a
       megabyte a hit and the offline renderer does not thank you for it. */
    const NOISE = off.createBuffer(1, SR * 3, SR);
    { const d = NOISE.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const noiseSrc = () => { const s = off.createBufferSource(); s.buffer = NOISE; s.loop = true; return s; };

    /** A swell of pure weight. Never sent to the delay — forty hertz in a tail
     *  is how a mix turns to mud. */
    const sub = (at, dur, n, amp) => {
      const o = osc('sine', semi(n)), g = gain(0);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(amp, at + dur * 0.26);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(a.music);
      o.start(at); o.stop(at + dur + 0.05);
    };

    /** Detuned saws under a low-pass that opens with the envelope. */
    const drone = (at, dur, n, amp, open = 1) => {
      const lp = off.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 0.6;
      lp.frequency.setValueAtTime(240, at);
      lp.frequency.linearRampToValueAtTime(240 + 1600 * open, at + dur * 0.3);
      lp.frequency.exponentialRampToValueAtTime(220, at + dur);
      const g = gain(0);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(amp, at + dur * 0.22);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      lp.connect(g); g.connect(a.music); g.connect(a.wet);
      for (const cents of [0, 7, -6, 13]) {
        const o = osc('sawtooth', semi(n));
        o.detune.value = cents;
        o.connect(lp); o.start(at); o.stop(at + dur + 0.05);
      }
    };

    /** The chord. Partials spread across the image, beating gently. */
    const pad = (at, dur, chord, oct, amp) => {
      chord.forEach((tone, i) => {
        const o = osc('sine', semi(tone + oct));
        o.detune.value = (i - 2) * 4;
        const g = gain(0), p = off.createStereoPanner();
        p.pan.value = (i / (chord.length - 1)) * 1.4 - 0.7;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(amp / (1 + i * 0.5), at + dur * 0.30 + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g); g.connect(p); p.connect(a.padFilter); g.connect(a.wet);
        o.start(at); o.stop(at + dur + 0.05);
      });
    };

    /** A hit: pitch swept into the floor, with a short noise body on it. */
    const impact = (at, amp, dur = 1.6) => {
      const o = osc('sine', 96), g = gain(0);
      o.frequency.setValueAtTime(96, at);
      o.frequency.exponentialRampToValueAtTime(28, at + 0.42);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(amp, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(a.music);
      o.start(at); o.stop(at + dur + 0.05);
      const s = noiseSrc(), f = off.createBiquadFilter(), ng = gain(0);
      f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.8;
      ng.gain.setValueAtTime(0.0001, at);
      ng.gain.linearRampToValueAtTime(amp * 0.55, at + 0.008);
      ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      s.connect(f); f.connect(ng); ng.connect(a.music); ng.connect(a.wet);
      s.start(at); s.stop(at + 0.3);
    };

    /** Noise and pitch climbing together into whatever comes next. */
    const riser = (at, dur, amp) => {
      const s = noiseSrc(), f = off.createBiquadFilter(), g = gain(0);
      f.type = 'bandpass'; f.Q.value = 1.6;
      f.frequency.setValueAtTime(320, at);
      f.frequency.exponentialRampToValueAtTime(5600, at + dur);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(amp, at + dur * 0.92);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.10);
      s.connect(f); f.connect(g); g.connect(a.music); g.connect(a.wet);
      s.start(at); s.stop(at + dur + 0.2);
      const o = osc('sine', 140), og = gain(0);
      o.frequency.setValueAtTime(140, at);
      o.frequency.exponentialRampToValueAtTime(430, at + dur);
      og.gain.setValueAtTime(0.0001, at);
      og.gain.exponentialRampToValueAtTime(amp * 0.5, at + dur * 0.92);
      og.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.06);
      o.connect(og); og.connect(a.music);
      o.start(at); o.stop(at + dur + 0.2);
    };

    /** Air moving past. Used once, on the fold. */
    const whoosh = (at, dur, amp) => {
      const s = noiseSrc(), f = off.createBiquadFilter(), g = gain(0);
      f.type = 'bandpass'; f.Q.value = 1.1;
      f.frequency.setValueAtTime(2800, at);
      f.frequency.exponentialRampToValueAtTime(160, at + dur);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(amp, at + dur * 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      s.connect(f); f.connect(g); g.connect(a.music); g.connect(a.wet);
      s.start(at); s.stop(at + dur + 0.1);
    };

    /** The heartbeat, and it only runs where the picture is moving. */
    const pulse = (at, amp, f = 55) => {
      const o = osc('sine', f), g = gain(0);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(amp, at + 0.010);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      o.connect(g); g.connect(a.music);
      o.start(at); o.stop(at + 0.4);
    };

    /* The one timbre reserved for the Choir. Pale gold-green is the only
       saturated colour in the game and is never spent on anything else; this is
       the audio of that rule. Pure partials, no attack transient, slightly
       inharmonic at the top so it shimmers rather than sits. */
    const choirVoice = (at, dur, n, amp) => {
      [1, 2, 3, 4.03, 6.01].forEach((mul, i) => {
        const o = osc('sine', semi(n) * mul), g = gain(0);
        const lfo = osc('sine', 0.21 + i * 0.07), lg = gain(2.5 + i);
        lfo.connect(lg); lg.connect(o.detune);
        const p = off.createStereoPanner();
        p.pan.value = Math.sin(i * 1.9) * 0.55;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(amp / (1 + i * 1.7), at + dur * 0.15);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g); g.connect(p); p.connect(a.music); g.connect(a.wet);
        o.start(at); o.stop(at + dur + 0.05);
        lfo.start(at); lfo.stop(at + dur + 0.05);
      });
    };

    // ---- room tone, wall to wall. The gaps are not digital silence.
    a.room.gain.setValueAtTime(0.055, 0);

    /* One bed under the whole film, and every section's chord overlapping the
       next by three seconds.
     *
     * Measured on the first pass, the per-second RMS fell into a hole between
     * every pair of sections — six of them, the deepest at -42 dB — because
     * each pad decayed to nothing before the next one attacked. That is not
     * dynamics, it is the score stopping and starting eight times in
     * forty-nine seconds, and it reads as unfinished. A sustaining root under
     * everything and a long crossfade between chords is what makes the whole
     * thing one piece. */
    drone(0, C.end + 0.5, -24, 0.085, 0.22);
    pad(0.4, C.end - 0.2, Am9, -12, 0.026, 0.4);

    /* --- the canopy. No hit on the first frame this time: the picture opens on
       a held cockpit shot rather than on an impact, and a braam over a static
       frame is a promise the shot does not keep. A low drone arriving from
       nothing, and one bell. */
    drone(C.canopy, 9.0, -12, 0.15, 0.45);
    sub(C.canopy + 0.2, 4.2, -24, 0.24);
    pad(C.canopy + 0.15, (C.cabin - C.canopy) + 3.4, Am9, 0, 0.070);
    a._bell(semi(12), C.canopy + 0.25, 0.055, 7.0);
    a._bell(semi(19), C.canopy + 2.6, 0.034, 5.5);

    /* --- the cabin. The most intimate thing in the film is a person walking
       down a corridor, so the score gets small: no low end to speak of, a
       pluck, and the room. */
    pad(C.cabin, (C.orbit - C.cabin) + 3.2, Am9, 12, 0.036);
    a._pluck(semi(15), C.cabin + 0.5, 0.034, 3.6);
    a._pluck(semi(19), C.cabin + 2.3, 0.032, 3.4);
    a._bell(semi(22), C.cabin + 3.9, 0.032, 6.0);

    /* --- orbit. The first time the picture shows a whole world, so this is the
       first time the chord opens out. */
    impact(C.orbit, 0.34, 2.2);
    drone(C.orbit, 6.4, -16, 0.185, 1.0);
    pad(C.orbit, (C.closer - C.orbit) + 3.4, Fmaj, 0, 0.088);
    pad(C.orbit + 0.4, (C.closer - C.orbit) + 2.4, Fmaj, 12, 0.038);
    sub(C.orbit, 3.4, -24, 0.30);
    a._bell(semi(24), C.orbit + 0.15, 0.046, 7.0);

    // --- closer. The pulse enters, and from here the film is going somewhere.
    drone(C.closer, 5.2, -14, 0.175, 1.0);
    pad(C.closer, (C.dive - C.closer) + 3.2, Fmaj, 0, 0.078);
    for (let t = C.closer + 0.2; t < C.dive - 0.1; t += 0.40) pulse(t, 0.115, 55);
    a._bell(semi(19), C.closer + 0.1, 0.038, 6.0);

    /* --- the dive. Riser from the moment the hull tips over until it breaks
       out of the cloud deck, with the pulse tightening under it. */
    drone(C.dive, 5.0, -16, 0.19, 1.0);
    pad(C.dive, (C.deck - C.dive) + 3.4, Cmaj, 0, 0.072);
    riser(C.dive, C.deck - C.dive + 0.15, 0.115);
    // and a second one into the touchdown, so the last four seconds of the
    // descent climb rather than decay
    riser(C.deck + 0.3, 2.75, 0.105);
    for (let t = C.dive; t < C.deck + 2.9; t += 0.34) {
      pulse(t, 0.10 + 0.055 * ((t - C.dive) / (C.deck + 3.05 - C.dive)));
    }

    // --- out of the cloud into blue sky: the release, not the climax
    impact(C.deck, 0.44, 1.5);
    pad(C.deck, (C.parked - C.deck) + 3.6, Cmaj, 12, 0.082);
    a._bell(semi(28), C.deck + 0.1, 0.050, 6.0);

    /* --- touchdown. The biggest hit in the film, and then the score stops. The
       ground is the one place it gets out of the way; a trailer that never lets
       go has nothing left to spend at the end. */
    const TOUCH = C.deck + 3.05;
    impact(TOUCH, 0.86, 2.6);
    sub(TOUCH, 3.4, -24, 0.34);
    drone(TOUCH + 0.2, (C.ground - TOUCH) + 3.0, -19, 0.095, 0.30);
    pad(TOUCH + 0.6, (C.ground - TOUCH) + 2.6, G69, 0, 0.036);

    /* --- the surface. Warm, open, and almost nothing under it. */
    pad(C.ground - 0.4, C.title - C.ground + 0.6, Cmaj, 0, 0.090);
    a._bell(semi(19), C.ground + 0.3, 0.040, 7.0);
    a._pluck(semi(22), C.ground + 2.4, 0.028, 3.6);
    pad(C.boots - 0.8, (C.title - C.boots) + 3.0, Cmaj, 12, 0.052);
    a._bell(semi(26), C.boots + 0.4, 0.044, 7.5);
    a._pluck(semi(17), C.boots + 2.5, 0.026, 3.4);

    /* --- the title. Back to the root, a last swell, and a long tail. Quieter
       than the touchdown on purpose: a resolve that is louder than the thing it
       resolves is not a resolve. */
    drone(C.title, C.end - C.title + 0.5, -24, 0.080, 0.35);
    pad(C.title, C.end - C.title + 0.4, Am9, 0, 0.040);
    pad(C.title + 0.3, C.end - C.title, Am9, 12, 0.018);
    sub(C.title, 3.8, -24, 0.15);
    a._bell(semi(12), C.title + 0.35, 0.046, 8.0);
    a._pluck(semi(7), C.title + 1.8, 0.026, 4.2);

    /* And out on the master rather than on every voice, so the tail decays
       under the fade instead of being truncated by it — and against the length
       of the *picture*, not of the render. */
    a.master.gain.setValueAtTime(0.9, C.end - 1.25);
    a.master.gain.linearRampToValueAtTime(0.0001, C.end - 0.02);
  }

  const buf = await off.startRendering();

  // WAV (16-bit PCM) — ffmpeg will take it straight
  const n = buf.length, ch = 2;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const tag = (o, str) => { for (let i = 0; i < str.length; i++) data.setUint8(o + i, str.charCodeAt(i)); };
  tag(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
  data.setUint16(22, ch, true); data.setUint32(24, SR, true);
  data.setUint32(28, SR * ch * 2, true); data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true); tag(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const src of [L, R]) {
      const v = Math.max(-1, Math.min(1, src[i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  let s = '';
  const bytes = new Uint8Array(data.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}, { secs: SECS, arr: ARR, C: CUT });

fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
console.log(`wrote ${OUT}  ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB  ${SECS}s`);
await browser.close();
