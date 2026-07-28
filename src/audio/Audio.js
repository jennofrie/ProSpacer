/* ============================================================================
   Procedural audio.

   Every previous version of this file droned, and the cause was structural
   rather than tonal: oscillators were started once and never stopped, with only
   their gain modulated. However pretty the harmony is, an unbroken sound reads
   as machinery, not music. Two other things made it worse — a sine sub held
   open forever, and room tone made by running pink noise through a *resonant
   bandpass at 320 Hz*, which is precisely how you synthesise a honk.

   So this version is built out of events, not held notes:

     · Music happens in phrases. A phrase is scheduled all at once — a pad
       swell, a bass note, a few plucked tones — and then the score is silent
       for several seconds before the next one. The rests are the point: silence
       is what makes what surrounds it sound composed rather than emitted.
     · Every voice is created, enveloped, stopped and discarded. Nothing
       sustains. If the game paused mid-phrase the score would simply end.
     · Room tone is broadband air, gently lowpassed with no resonant peak, sat
       near the floor of audibility so you notice it only when it stops.
     · The drive is rushing air, gated hard to true zero at idle, and gains a
       tonal body only when it is genuinely working.

   Everything is synthesised. There are no assets.
   ========================================================================== */

// Roots in semitones from A, with the chord tones stacked above them. A slow
// modal turn that never resolves hard — melancholy without being maudlin.
const PROGRESSION = [
  { root: 0, tones: [0, 3, 7, 10, 14] },     // Am9
  { root: -4, tones: [0, 4, 7, 11, 14] },    // Fmaj7(9)
  { root: 3, tones: [0, 4, 7, 11, 14] },     // Cmaj7(9)
  { root: -2, tones: [0, 4, 7, 9, 14] },     // G6/9
];
const BASE_HZ = 110;                          // A2
const semi = (n) => BASE_HZ * Math.pow(2, n / 12);
const rnd = (a, b) => a + Math.random() * (b - a);

export class Audio {
  constructor() {
    this.ready = false;
    this.enabled = true;
    this.master = null;
    this._chordIdx = 0;
    this._phraseT = 2.0;      // first phrase lands shortly after you arrive
    this._stepPhase = 0;
  }

  /**
   * @param {BaseAudioContext} [external] render into a supplied context — an
   *   OfflineAudioContext, so the score can be bounced to a file for capture
   *   footage instead of being re-performed live.
   */
  init(external) {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!external && !AC) return;
    const ctx = this.ctx = external || new AC();

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Gentle bus glue so transients and pad share the space without pumping.
    this.bus = ctx.createDynamicsCompressor();
    this.bus.threshold.value = -18;
    this.bus.knee.value = 24;
    this.bus.ratio.value = 3;
    this.bus.attack.value = 0.03;
    this.bus.release.value = 0.4;
    this.bus.connect(this.master);

    // "Space" without shipping an impulse response: a pair of cross-panned
    // feedback delays, darkened in the loop so the tail decays into nothing.
    this.wet = ctx.createGain(); this.wet.gain.value = 0.30;
    this.wet.connect(this.bus);
    for (const [time, pan] of [[0.29, -0.62], [0.44, 0.62]]) {
      const d = ctx.createDelay(1.0); d.delayTime.value = time;
      const fb = ctx.createGain(); fb.gain.value = 0.40;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2000;
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(p); p.connect(this.bus);
      this.wet.connect(d);
    }

    this.music = ctx.createGain(); this.music.gain.value = 0.62;
    this.music.connect(this.bus); this.music.connect(this.wet);

    // A shared shelf on the pad keeps phrases soft-edged. It is a filter, not a
    // voice — nothing is connected to it between phrases.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 1500;
    this.padFilter.Q.value = 0.4;
    this.padFilter.connect(this.music);

    // ------------------------------------------------- noise source (shared)
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
      }
    }
    this.noiseBuf = buf;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buf; this.noise.loop = true;

    // ------------------------------------------------------------ room tone
    // Broadband air with no resonant peak, and a high-pass to take out the
    // rumble that made the old one sit on the chest. Barely there by design.
    this.roomHP = ctx.createBiquadFilter();
    this.roomHP.type = 'highpass';
    this.roomHP.frequency.value = 240;
    this.roomLP = ctx.createBiquadFilter();
    this.roomLP.type = 'lowpass';
    this.roomLP.frequency.value = 1400;
    this.roomLP.Q.value = 0.4;
    this.room = ctx.createGain(); this.room.gain.value = 0.0;
    this.noise.connect(this.roomHP);
    this.roomHP.connect(this.roomLP);
    this.roomLP.connect(this.room);
    this.room.connect(this.bus);

    // --------------------------------------------------------------- drive
    // Rushing air rather than a tone. Bandwidth opens with load; there is no
    // oscillator here at all, so idle is true silence.
    this.engHP = ctx.createBiquadFilter();
    this.engHP.type = 'highpass';
    this.engHP.frequency.value = 380;
    this.engLP = ctx.createBiquadFilter();
    this.engLP.type = 'lowpass';
    this.engLP.frequency.value = 900;
    this.engLP.Q.value = 0.5;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.noise.connect(this.engHP);
    this.engHP.connect(this.engLP);
    this.engLP.connect(this.engGain);
    this.engGain.connect(this.bus);

    this.noise.start();
    this.ready = true;
  }

  async resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.master) {
      this.master.gain.linearRampToValueAtTime(this.enabled ? 0.75 : 0, this.ctx.currentTime + 3.0);
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.linearRampToValueAtTime(on ? 0.75 : 0, this.ctx.currentTime + 0.3);
  }

  /* --------------------------------------------------------- voice helpers */

  /** A plucked tone: triangle through a lowpass that closes as it decays. */
  _pluck(freq, at, gain = 0.030, dur = 2.4) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.type = 'triangle';
    o.frequency.value = freq;
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(6000, freq * 7), at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 1.2), at + dur * 0.7);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.010);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(lp); lp.connect(g); g.connect(this.music); g.connect(this.wet);
    o.start(at); o.stop(at + dur + 0.05);
  }

  /** A struck bell: two sines a twelfth apart, long tail. */
  _bell(freq, at, gain = 0.030, dur = 5.0) {
    const ctx = this.ctx;
    for (const [mul, amp, d] of [[1, 1, dur], [3.0, 0.32, dur * 0.55]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq * mul;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain * amp, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + d);
      o.connect(g); g.connect(this.music); g.connect(this.wet);
      o.start(at); o.stop(at + d + 0.05);
    }
  }

  /**
   * Schedule one complete musical phrase and return how long it lasts.
   *
   * The whole phrase is committed to the WebAudio clock in one go, so its
   * timing is sample-accurate regardless of frame rate, and every voice it
   * creates has a stop time. Nothing survives the phrase.
   */
  _schedulePhrase(t0, calm) {
    const ctx = this.ctx;
    const prog = PROGRESSION[this._chordIdx % PROGRESSION.length];
    const len = rnd(9.0, 13.0);

    // ---- pad: partials that swell in and die inside the phrase
    [0, 2, 4].forEach((ti, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = semi(prog.root + prog.tones[ti] + (i === 0 ? 0 : 12));
      o.detune.value = (i - 1) * 5;                 // gentle beating between partials
      const attack = 2.4 + i * 0.6;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.050 - i * 0.010, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g); g.connect(this.padFilter);
      o.start(t0); o.stop(t0 + len + 0.1);
    });

    // ---- one bass note per phrase: weight without a permanent sub
    {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = semi(prog.root - 12);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.085, t0 + 0.9);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len * 0.85);
      o.connect(g); g.connect(this.music);
      o.start(t0); o.stop(t0 + len);
    }

    // ---- melody: a short line that wanders by step through the chord
    const notes = 3 + Math.floor(Math.random() * 3);
    let idx = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < notes; k++) {
      const at = t0 + 1.6 + (k * (len - 3.2)) / notes + rnd(0, 0.45);
      idx = Math.max(0, Math.min(prog.tones.length - 1, idx + (Math.random() < 0.5 ? -1 : 1)));
      this._pluck(semi(prog.root + prog.tones[idx] + 24), at, 0.028 + calm * 0.010);
    }

    // ---- a bell to close, sometimes
    if (Math.random() < 0.55) {
      this._bell(semi(prog.root + prog.tones[2 + Math.floor(Math.random() * 3)] + 24),
        t0 + len * 0.62, 0.026, 5.5);
    }

    return len;
  }

  /* ------------------------------------------------------------- events */

  ping(kind) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;

    const tone = (freq, dur, type, gain, delay = 0, glide) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + delay);
      if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + delay + dur);
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(gain, t + delay + 0.010);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g); g.connect(this.bus); g.connect(this.wet);
      o.start(t + delay); o.stop(t + delay + dur + 0.05);
    };

    // A filtered slice of the shared noise buffer — the body of every mechanism.
    const noiseBurst = (dur, freq, q, gain, delay = 0, type = 'bandpass') => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(gain, t + delay + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      src.connect(f); f.connect(g); g.connect(this.bus);
      src.start(t + delay); src.stop(t + delay + dur + 0.05);
    };

    switch (kind) {
      // A switch has three parts: the click of the mechanism, the thud of the
      // panel behind it, and a short ring from the housing.
      case 'ui':
        noiseBurst(0.020, 4200, 6.0, 0.13);
        noiseBurst(0.075, 520, 1.4, 0.06, 0.006);
        tone(1240, 0.035, 'square', 0.014, 0.004);
        break;
      case 'switch':
        noiseBurst(0.014, 5200, 8.0, 0.15);
        noiseBurst(0.055, 340, 1.6, 0.07, 0.005);
        tone(1720, 0.028, 'square', 0.016);
        break;
      case 'boot':
        noiseBurst(0.45, 240, 0.8, 0.08, 0, 'lowpass');
        tone(110, 0.65, 'sine', 0.06, 0.0, 440);
        tone(659.25, 0.30, 'sine', 0.040, 0.28);
        tone(987.77, 0.40, 'sine', 0.030, 0.38);
        break;
      case 'deny':
        noiseBurst(0.05, 260, 2.0, 0.07);
        tone(174, 0.16, 'square', 0.045);
        tone(164, 0.20, 'square', 0.035, 0.09);
        break;
      case 'scanStart':
        tone(520, 0.5, 'sine', 0.045, 0, 1040);
        noiseBurst(0.30, 1800, 1.2, 0.03, 0, 'highpass');
        break;
      case 'scan':
        tone(659.25, 0.55, 'sine', 0.065);
        tone(987.77, 0.70, 'sine', 0.048, 0.09);
        tone(1318.5, 0.90, 'sine', 0.032, 0.19);
        break;
      case 'objective':
        tone(392, 0.5, 'sine', 0.055);
        tone(587.33, 0.8, 'sine', 0.042, 0.12);
        break;
      case 'resonate':
        [0, 7, 12, 19].forEach((n, i) =>
          this._bell(semi(n + 24), t + i * 0.16, 0.055 - i * 0.008, 4.5 - i * 0.4));
        break;
      case 'fold':
        noiseBurst(1.6, 220, 0.5, 0.16, 0, 'lowpass');
        tone(55, 1.8, 'sine', 0.14, 0, 220);
        break;
      case 'unfold':
        tone(220, 1.2, 'sine', 0.11, 0, 55);
        noiseBurst(0.9, 500, 0.7, 0.08, 0, 'lowpass');
        break;
      case 'jump':
        noiseBurst(2.4, 300, 0.4, 0.20, 0, 'lowpass');
        tone(110, 2.4, 'sine', 0.16, 0, 27.5);
        break;
      case 'arrive':
        tone(330, 0.8, 'sine', 0.050);
        tone(440, 1.0, 'sine', 0.038, 0.1);
        break;
      case 'sit':
        noiseBurst(0.30, 190, 1.0, 0.13, 0, 'lowpass');
        noiseBurst(0.14, 900, 1.8, 0.04, 0.02);
        break;
      case 'step':
        noiseBurst(0.075, 180 + Math.random() * 120, 1.8, 0.040, 0, 'lowpass');
        noiseBurst(0.030, 2400 + Math.random() * 900, 3.0, 0.014, 0.004);
        break;
      case 'alarm':
        tone(740, 0.16, 'square', 0.045);
        tone(740, 0.16, 'square', 0.045, 0.24);
        break;
      default:
        tone(660, 0.2, 'sine', 0.045);
    }
  }

  /* ------------------------------------------------------------- update */

  update(dt, game) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const ship = game.ship;

    const calm = 1 - Math.min(1, ship.speed / (ship.maxSpeed * 1.2));
    const inside = game.mode !== 'exterior';

    // ---- the score: one phrase, then a real rest. The rest is not a gap in
    // the implementation, it is the reason the music does not drone.
    this._phraseT -= dt;
    if (this._phraseT <= 0) {
      const len = this._schedulePhrase(t + 0.05, calm);
      this._chordIdx++;
      this._phraseT = len + rnd(5.5, 11.0);
      // The pad shelf opens up when you are still and closes under way, so
      // phrases sit further back in the mix while you are busy flying.
      this.padFilter.frequency.setTargetAtTime(900 + calm * 1400, t, 3.0);
    }

    // ---- room tone: present in the hull, absent outside it
    this.room.gain.setTargetAtTime(inside ? 0.030 : 0.0, t, 1.2);

    // ---- drive: gated to true silence at idle
    const load = ship.foldMode ? 1 : ship.throttle * (0.55 + ship.boost * 0.75);
    const gated = load < 0.03 ? 0 : load;
    this.engGain.gain.setTargetAtTime(gated * (inside ? 0.055 : 0.10), t, 0.25);
    this.engLP.frequency.setTargetAtTime(700 + gated * 2600 + (ship.foldMode ? 1200 : 0), t, 0.35);
    this.engHP.frequency.setTargetAtTime(380 - gated * 180, t, 0.35);

    // ---- footsteps
    if (game.mode === 'walk' && game.player) {
      const p = game.player;
      const sp = p.vel.length();
      if (sp > 0.25) {
        this._stepPhase += dt * sp * 1.15;
        if (this._stepPhase > 1) { this._stepPhase = 0; this.ping('step'); }
      } else this._stepPhase = 0.75;
    }
  }
}
