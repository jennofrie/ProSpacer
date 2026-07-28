/* ============================================================================
   Directives.

   The complaint that a sandbox is "boring" is almost always a complaint that
   nothing tells you what the next interesting thing is. So there is always
   exactly one active directive; it names a concrete next action, it is visible
   on the dashboard, and completing it pays out something you can see: a Canto,
   a recovered log, or a measurable upgrade to the ship.

   The chain also doubles as the tutorial — the first four steps happen to teach
   sitting, targeting, scanning and folding without ever saying "tutorial".
   ========================================================================== */

export const UPGRADES = {
  scanner: { label: 'SCANNER GAIN', apply: (g) => { g.ship.scanRate *= 1.35; } },
  drive: { label: 'FOLD REGENERATION', apply: (g) => { g.ship.foldRegen *= 1.6; } },
  thrust: { label: 'THRUST', apply: (g) => { g.ship.maxSpeed *= 1.22; } },
  hull: { label: 'HULL PLATING', apply: (g) => { g.ship.hullMax = 1.0; g.ship.hull = 1.0; } },
  range: { label: 'SENSOR RANGE', apply: (g) => { g.scanRangeMul *= 1.4; } },
};

function bodiesScannedHere(g) {
  return g.bodies.filter((b) => b.scanned && b.kind !== 'anomaly').length;
}

export const CHAIN = [
  {
    id: 'helm',
    short: 'Take the helm',
    full: 'TAKE THE HELM',
    hint: 'The pilot seat is forward, through the corridor.',
    check: (g) => g.mode === 'pilot',
    onDone: (g) => {
      g.hud.narrate('Drive is warm. Scanner is yours. Find me something, Seeker.',
        'INSTITUTE RELAY');
    },
  },
  {
    id: 'firstScan',
    short: 'Scan any world',
    full: 'SURVEY A WORLD',
    hint: 'Put a body in the reticle and hold F.',
    check: (g) => bodiesScannedHere(g) >= 1,
    onDone: (g) => {
      g.hud.narrate('Logged. Every body you catalogue narrows where the Choir went.',
        'INSTITUTE RELAY');
      g.grantUpgrade('scanner');
    },
  },
  {
    id: 'survey3',
    short: 'Survey 3 bodies in this system',
    full: 'SURVEY THREE BODIES',
    hint: 'Target with T, fly with G, scan with F.',
    total: 3,
    progress: (g) => bodiesScannedHere(g),
    check: (g) => bodiesScannedHere(g) >= 3,
    onDone: (g) => {
      g.revealResonator();
      g.hud.narrate('Triangulation holds. There is a Resonator in this system — bearing marked.',
        'INSTITUTE RELAY');
      g.grantUpgrade('range');
    },
  },
  {
    id: 'resonator',
    short: 'Reach the Resonator',
    full: 'INVESTIGATE THE RESONANCE',
    hint: 'It is marked on the tactical plate. Scan it.',
    check: (g) => g.cantos.length >= 1,
    onDone: (g) => { g.grantUpgrade('drive'); },
  },
  {
    id: 'chamber',
    short: 'Seat the Canto in the resonance chamber',
    full: 'RETURN TO THE CHAMBER',
    hint: 'Leave the helm and walk aft.',
    check: (g) => g.chamberVisits >= 1,
    onDone: (g) => {
      g.hud.narrate('One of seven. The chamber remembers the rest of the shape.',
        'PALE SEEKER');
      g.grantUpgrade('thrust');
    },
  },
  {
    id: 'fold',
    short: 'Fold to another system',
    full: 'CHART A NEW SYSTEM',
    hint: 'Use the navigation table in the habitat.',
    check: (g) => g.galaxy.filter((s) => s.visited).length >= 2,
    onDone: (g) => {
      g.hud.narrate('Every system in the Silence holds part of the record. Keep going.',
        'INSTITUTE RELAY');
    },
  },
];

/** After the scripted chain, directives are generated from the world state. */
function proceduralDirective(g) {
  const res = g.anomalies.find((a) => a.anomalyType === 'resonator' && !a.scanned);
  if (res && g.resonatorRevealed) {
    return { id: 'res:' + res.id, short: `Attune ${res.name}`, full: 'ATTUNE THE RESONATOR', hint: 'Scan it.' };
  }
  const unscanned = g.bodies.filter((b) => !b.scanned && b.kind !== 'anomaly').length;
  if (unscanned > 0 && bodiesScannedHere(g) < 3) {
    return {
      id: 'survey:' + g.currentSystemId,
      short: `Survey this system`,
      full: 'CONTINUE THE SURVEY',
      hint: 'Three bodies reveals any Resonator here.',
      total: 3, done: bodiesScannedHere(g),
    };
  }
  const sig = g.anomalies.find((a) => !a.scanned);
  if (sig) {
    return { id: 'sig:' + sig.id, short: `Investigate ${sig.name}`, full: 'UNRESOLVED SIGNAL', hint: 'Scan it.' };
  }
  const next = g.galaxy.find((s) => !s.visited);
  if (next) {
    return {
      id: 'jump:' + next.id,
      short: `Fold to ${next.designation}`,
      full: 'CHART A NEW SYSTEM',
      hint: 'Use the navigation table.',
    };
  }
  return { id: 'done', short: 'Attune all seven Resonators', full: 'THE APERTURE', hint: '' };
}

export class Directives {
  constructor(game) {
    this.game = game;
    this.index = 0;
    this.current = null;
    this._announced = null;
  }

  update() {
    const g = this.game;
    let step = CHAIN[this.index];

    if (step && step.check(g)) {
      this.index++;
      step.onDone?.(g);
      g.hud.log(`DIRECTIVE COMPLETE · ${step.full}`, 'ok');
      g.audio.ping('objective');
      step = CHAIN[this.index];
    }

    const src = step || proceduralDirective(g);
    const done = step
      ? (step.progress ? step.progress(g) : 0)
      : (src.done || 0);

    this.current = {
      id: src.id,
      short: src.short,
      full: src.full,
      hint: src.hint,
      total: src.total || 1,
      done: Math.min(done, src.total || 1),
    };
    g.directive = this.current;

    if (this._announced !== this.current.id) {
      this._announced = this.current.id;
      g.hud.log(`DIRECTIVE · ${this.current.short}`, 'hi');
    }
  }
}
