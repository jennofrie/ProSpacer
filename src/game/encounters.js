import * as THREE from 'three';

/* ============================================================================
   Encounters.

   The traffic exists whether or not you talk to it, which is the point: this
   module adds no entities and moves nothing. It watches distances, and when the
   Pale Seeker gets close enough to something crewed, that something says
   whatever a ship of its trade would say to a survey vessel it did not expect.

   Two rules keep it from becoming noise:

   **Hail once, ever.** A ship that greets you every time you pass turns the one
   inhabited thing in the system into a vending machine. Each contact has
   exactly one line, and once it is spent the ship goes quiet for good.

   **Say something only they could say.** A hauler talks about mass and margins,
   a patrol about your registration, a salvager about what it is cutting up. The
   Choir motes do not talk at all — the silence *is* the content, and nothing
   would spend it faster than giving them dialogue.
   ========================================================================== */

const _v = new THREE.Vector3();

/** How close, in ship lengths, a contact has to be before it notices you. */
const HAIL_RANGE = 900;

const LINES = {
  freighter: [
    ['Survey vessel, you are inside my braking cone. I cannot stop. You can.', 'BULK HAULER'],
    ['Institute markings. Long way out for a chart-maker.', 'BULK HAULER'],
    ['Nine hundred tonnes of nothing anyone needs. Same as last run.', 'BULK HAULER'],
    ['We keep the lanes lit. Nobody keeps them safe. Mind that.', 'BULK HAULER'],
  ],
  courier: [
    ['Courier on schedule. Do not follow me, I have nothing aboard worth it.', 'COURIER'],
    ['You are the Pale Seeker. They talk about you at the Gate.', 'COURIER'],
    ['Whatever you are looking for out here — it was gone before we got here.', 'COURIER'],
  ],
  tug: [
    ['Working. Keep your wash off my cable.', 'YARD TENDER'],
    ['Found a hull last month with the coffee still in the cups. Forty thousand years.', 'YARD TENDER'],
    ['If you are going near the Resonator, do not touch anything. Ask the last one who did.', 'YARD TENDER'],
  ],
  patrol: [
    ['Pale Seeker, Institute Vigil. Registration confirmed. Carry on.', 'INSTITUTE PATROL'],
    ['We log everything that moves in this system. Today that is you and four freighters.', 'INSTITUTE PATROL'],
    ['Chart it, scan it, do not attune to it without telling us first.', 'INSTITUTE PATROL'],
  ],
  drone: [
    ['<automated survey drone — carrier tone only>', 'CONTACT'],
    ['<telemetry burst · 4.2 Mb · unencrypted · a mineral survey>', 'CONTACT'],
  ],
  station: [
    ['Pale Seeker, you have the outer berth. Mind the tender traffic.', 'TRAFFIC CONTROL'],
    ['Welcome in, Seeker. Eleven thousand souls aboard and every one of them wants news.', 'TRAFFIC CONTROL'],
  ],
};

export class Encounters {
  constructor(game) {
    this.game = game;
    this.spoken = new Set();
    this._cool = 0;
  }

  onSystemChange() { this.spoken.clear(); this._cool = 3; }

  update(dt) {
    const g = this.game;
    if (!g.fleet || g.landed) return;
    // one hail at a time, with a long beat after each
    this._cool = Math.max(0, this._cool - dt);
    if (this._cool > 0) return;

    const shipPos = g.ship.absPos;

    for (const c of g.fleet.craft) {
      if (c.hailed || c.faction === 'choir') continue;
      const range = c.length * HAIL_RANGE;
      if (_v.copy(c.absPos).sub(shipPos).lengthSq() > range * range) continue;
      c.hailed = true;
      this._speak(LINES[c.kind], c.name);
      return;
    }

    for (const st of g.stations || []) {
      if (st.hailed) continue;
      const range = st.built.radius * 5.0;
      if (_v.copy(st.absPos).sub(shipPos).lengthSq() > range * range) continue;
      st.hailed = true;
      this._speak(LINES.station, st.name);
      return;
    }

    // The Choir answer differently, and only once per system.
    const mote = g.fleet.craft.find((c) => c.faction === 'choir' && !c.hailed);
    if (mote && _v.copy(mote.absPos).sub(shipPos).lengthSq() < (mote.length * 600) ** 2) {
      mote.hailed = true;
      g.hud.narrate('It does not answer. It changes course, very slightly, to keep you in view.',
        'UNRESOLVED CONTACT');
      g.audio.ping('resonate');
      this._cool = 14;
    }
  }

  _speak(pool, who) {
    if (!pool || !pool.length) return;
    const g = this.game;
    // deterministic per system, so a given contact always says the same thing
    const i = Math.abs(hash(who + g.currentSystemId)) % pool.length;
    const [line, tag] = pool[i];
    g.hud.narrate(line, tag);
    g.hud.log(`HAIL · ${who}`, 'ok');
    g.audio.ping('ui');
    this._cool = 12;
  }
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}
