import * as THREE from 'three';

/* ============================================================================
   The director.

   A cutscene here is a *camera*, not a canned animation: the world keeps
   simulating underneath, the ship keeps flying, the traffic keeps moving, and
   the director simply takes the camera away for a few seconds and puts it
   somewhere better. That is why these sequences never desync and never need an
   exit state — hand the camera back and the game is exactly where it was.

   Every shot is a function of normalised time returning an absolute eye
   position, an absolute look-at point and a focal length. Anchors are resolved
   *live* each frame against a subject, so a shot composed around a freighter
   still works while the freighter is doing thirty kilometres a second.

   Three rules, all of them learned from the footage:

   **Move the camera or move the subject, rarely both.** Two simultaneous
   motions read as drift.

   **Never cut to a shot whose framing you cannot predict.** Every shot's start
   and end are anchored to something with a known position.

   **Ease everything.** A linear dolly is the single most obvious tell that a
   camera is a matrix and not an object with mass.
   ========================================================================== */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const ease = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  // a long, slow settle — the camera arriving, not stopping
  settle: (t) => 1 - Math.pow(1 - t, 3.2),
};

/**
 * Anchors. Each returns a live absolute position.
 *   subject     the thing the shot is about
 *   offset      in the subject's own frame if it has one, else world axes
 */
function anchor(subject, off, out) {
  out.set(off[0], off[1], off[2]);
  if (subject.quat) out.applyQuaternion(subject.quat);
  return out.add(subject.absPos);
}

export class Director {
  constructor(game) {
    this.game = game;
    this.seq = null;
    this.t = 0;
    this.shotIdx = 0;
    this.eye = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fov = 46;
    this.roll = 0;
    this.letterbox = 0;
    this.up = new THREE.Vector3(0, 1, 0);
  }

  get active() { return !!this.seq; }

  /**
   * @param {string} name    for logging and for suppressing repeats
   * @param {object[]} shots [{dur, fov, eye:[..], look:[..], subject, ease, on}]
   * @param {object} o       {title, sub, skippable}
   */
  play(name, shots, o = {}) {
    if (this.seq && this.seq.name === name) return;
    this.seq = { name, shots, ...o };
    this.t = 0;
    this.shotIdx = 0;
    this.game.hud?.cinematic?.(true, o.title, o.sub);
    if (shots[0]?.on) shots[0].on(this.game);
  }

  stop() {
    if (!this.seq) return;
    this.seq = null;
    this.game.hud?.cinematic?.(false);
  }

  update(dt) {
    if (!this.seq) {
      this.letterbox = Math.max(0, this.letterbox - dt * 2.2);
      return false;
    }
    this.letterbox = Math.min(1, this.letterbox + dt * 2.2);

    const shot = this.seq.shots[this.shotIdx];
    this.t += dt;
    /* A shot may refuse to end.
     *
     * The landing and the liftoff both have a beat whose job is to cover work
     * that takes an unknown amount of time — building a landscape, and letting
     * the driver finish compiling forty shaders. Timing that beat by the clock
     * means picking a number that is either too short on a slow machine (and
     * the stall shows) or too long on a fast one (and the sequence drags). So a
     * shot can hold: it stops at its end pose and waits, and the eases below
     * clamp, so what the audience sees is a camera that has arrived and is
     * simply holding the frame. */
    if (this.t >= shot.dur && !(shot.hold && shot.hold(this.game))) {
      this.t -= shot.dur;
      this.shotIdx++;
      if (this.shotIdx >= this.seq.shots.length) { this.stop(); return false; }
      const next = this.seq.shots[this.shotIdx];
      if (next.on) next.on(this.game);
    }

    const s = this.seq.shots[this.shotIdx];
    const u = THREE.MathUtils.clamp(this.t / s.dur, 0, 1);
    const e = (ease[s.ease] || ease.inOut)(u);
    const subj = typeof s.subject === 'function' ? s.subject(this.game) : s.subject;
    if (!subj) { this.stop(); return false; }
    /* A shot may hang its eye on one thing and its gaze on another, and a
       landing is why. The camera has to arrive glued to the ship — that is
       what makes the scene change under the cloud invisible — and end up
       standing on the ground watching it settle, which is the only framing in
       which the last two hundred metres read as a descent at all. One anchor
       cannot do both, so the eye rides a subject that eases from the ship to
       the ground while the gaze stays on the ship throughout. */
    const lsubj = s.lookSubject
      ? (typeof s.lookSubject === 'function' ? s.lookSubject(this.game) : s.lookSubject)
      : subj;
    if (!lsubj) { this.stop(); return false; }

    // eye and look-at, each lerped between a start and an end offset
    anchor(subj, s.eye[0], _a);
    anchor(subj, s.eye[1] || s.eye[0], _b);
    this.eye.copy(_a).lerp(_b, e);

    anchor(lsubj, s.look[0], _a);
    anchor(lsubj, s.look[1] || s.look[0], _b);
    this.look.copy(_a).lerp(_b, e);

    /* Upright. See applyCamera: a shot anchored to something with a rotation
       can borrow it, and anything on a planet has to. */
    if (s.up === 'subject' && subj.quat) this.up.set(0, 1, 0).applyQuaternion(subj.quat);
    else if (s.up === 'look' && lsubj.quat) this.up.set(0, 1, 0).applyQuaternion(lsubj.quat);
    else this.up.set(0, 1, 0);

    this.fov = THREE.MathUtils.lerp(s.fov ? s.fov[0] : 44, s.fov ? (s.fov[1] ?? s.fov[0]) : 44, e);
    this.roll = THREE.MathUtils.lerp(s.roll ? s.roll[0] : 0, s.roll ? (s.roll[1] ?? s.roll[0]) : 0, e);
    return true;
  }

  /** Write the current shot onto the game camera.
   *
   * The up vector is the whole reason a landing looked like the ship rolling
   * over on its back. It was world +Y, and world +Y means nothing on a planet:
   * a landing site is a point on a sphere, and the one the origin system hands
   * you sits 87 degrees off the world axis. So the camera held the world's idea
   * of upright while the ship held the planet's, the horizon came in vertically
   * and the hull read as inverted — every time, on most worlds, and it was the
   * camera doing it rather than the ship.
   *
   * A shot that says `up: 'subject'` takes its upright from the thing it is
   * pointed at instead. For the descent that is the hull, which is exactly what
   * the audience is using to judge which way up the shot is; on the ground the
   * anchors carry no rotation and it falls back to +Y, which down there is the
   * local vertical anyway. */
  applyCamera(camera, origin) {
    camera.position.copy(this.eye).sub(origin);
    _a.copy(this.look).sub(origin);
    const m = new THREE.Matrix4().lookAt(camera.position, _a, this.up);
    camera.quaternion.setFromRotationMatrix(m);
    if (this.roll) {
      camera.quaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.roll));
    }
  }
}

/* ============================================================== sequences */

/**
 * Every sequence is built from the subject's own size, so the same code frames
 * a 90 m courier and a 4 km monolith without a single magic number.
 */
export const SEQUENCES = {

  /** Dropping out of a fold into a new system. */
  arrival(game) {
    const ship = game.ship;
    const shipSubj = { absPos: ship.absPos, quat: ship.quat };
    const star = game.star;
    const R = ship.length;
    return {
      title: game.system.stub.name,
      sub: `${game.system.star.desc} · ${game.system.planets.length} worlds`,
      shots: [
        // 1. the ship arrives out of nothing, seen broadside and very close
        {
          dur: 3.2, ease: 'out', subject: shipSubj,
          eye: [[R * 5.5, R * 1.2, R * 0.4], [R * 3.0, R * 0.8, R * 1.6]],
          look: [[0, 0, 0], [0, 0, 0]],
          fov: [28, 38],
        },
        // 2. drift back over the dorsal spine and let the system open out
        {
          dur: 4.0, ease: 'inOut', subject: shipSubj,
          eye: [[R * 0.4, R * 1.1, R * 3.4], [R * 0.1, R * 2.6, R * 9.0]],
          look: [[0, 0, -R * 2], [0, 0, -R * 18]],
          fov: [46, 58], roll: [0.02, -0.015],
        },
        // 3. hold on the star
        {
          dur: 3.4, ease: 'settle',
          subject: { absPos: star.absPos },
          eye: [
            [star.radius * 9, star.radius * 2.2, star.radius * 9],
            [star.radius * 7, star.radius * 1.6, star.radius * 7.4],
          ],
          look: [[0, 0, 0]],
          fov: [30, 26],
        },
      ],
    };
  },

  /** Attuning to a Resonator: the one moment the Choir answers. */
  attune(game, body) {
    const R = body.radius;
    const subj = { absPos: body.absPos };
    return {
      title: body.name,
      sub: 'RESONANCE ESTABLISHED',
      shots: [
        // rise up the outside of the colonnade
        {
          dur: 4.6, ease: 'inOut', subject: subj,
          eye: [[R * 1.5, -R * 0.9, R * 1.5], [R * 1.15, R * 0.75, R * 1.15]],
          look: [[0, -R * 0.4, 0], [0, 0, 0]],
          fov: [40, 34],
        },
        // then a slow arc through the ring, looking at the core
        {
          dur: 5.4, ease: 'linear', subject: subj,
          eye: [[R * 0.95, R * 0.30, -R * 0.95], [-R * 0.95, R * 0.22, -R * 0.75]],
          look: [[0, 0, 0]],
          fov: [44, 50], roll: [-0.02, 0.03],
        },
      ],
    };
  },

  /**
   * Going down, and there is only one shot in it.
   *
   * This used to be two here and three more on the other side: a broadside on
   * the ship, a cut to the planet's limb seen from *inside* its own atmosphere
   * shell — which is authored to be looked at from outside and draws as a brown
   * smear from in there — a flash to white, and then three separate framings of
   * a ship that had already landed. Five shots to move one vehicle from orbit
   * to a dune, four of them cuts, and the reading of it was exactly right: a
   * montage of a landing rather than a landing.
   *
   * So: one camera, holding the ship at a fixed offset in the ship's own frame,
   * easing in as the world comes up behind it. It never leaves the ship. The
   * scene change happens inside the cloud deck (see Game.beginEntry) and the
   * ground sequence picks the camera up at exactly the offset this one ends on,
   * in a frame that has been flared level to match — so what continues after
   * the swap is this shot, with weather in front of it and a landscape behind.
   *
   * The hold is the same mechanism as before: the landscape is being built and
   * its shaders compiled behind the cloud, and that takes as long as it takes.
   */
  descent(game, body) {
    const ship = game.ship;
    const shipSubj = { absPos: ship.absPos, quat: ship.quat };
    const R = ship.length;
    return {
      title: body.name,
      sub: 'DESCENT · ATTITUDE NOMINAL',
      shots: [
        {
          dur: 6.4, ease: 'inOut', subject: shipSubj, up: 'subject',
          hold: (g) => !!g.transition,
          /* Rear three-quarter, high side, closing. The world is behind and
             below the hull the whole way down and grows on its own — the ship
             is the thing that is moving, so the camera does not have to be. */
          eye: [[R * 2.15, R * 0.78, R * 3.30], [R * 1.28, R * 0.34, R * 1.92]],
          look: [[0, R * 0.06, 0], [0, -R * 0.04, 0]],
          fov: [38, 50], roll: [0.014, -0.006],
        },
      ],
    };
  },

  /**
   * And going up: the landing played backwards, and one shot again.
   *
   * The camera starts on the ground, low and close under the flank, and the
   * hull leaves it. Then the eye anchor climbs onto the ship — `groundCamAnchor`
   * eases the other way on this side — so that by the time the deck closes over
   * the frame the camera is travelling with the vehicle, which is the only way
   * the change of scene underneath it can go unnoticed. The gaze never leaves
   * the ship.
   */
  ascent(game, body) {
    const R = game.ship.length * 1000;      // the ground scene is in metres
    return {
      title: body.name,
      sub: 'ASCENT · DRIVE LIT',
      shots: [
        {
          dur: 6.2, ease: 'inOut',
          subject: (g) => ({ absPos: g.groundCamAnchor }),
          lookSubject: (g) => ({ absPos: g.groundShipAnchor }),
          hold: (g) => !!g.transition,
          eye: [[R * 0.92, R * 0.055, R * 0.78], [R * 1.24, R * 0.30, R * 1.86]],
          look: [[0, R * 0.10, 0], [0, 0, 0]],
          fov: [52, 46], roll: [0, 0.012],
        },
      ],
    };
  },

  /** The other side of the same shot: out of the deck, with the world falling
   *  away underneath. It opens at the offset the ground half ended on, in the
   *  ship's own frame, and finishes wide enough that handing the camera back to
   *  the chase rig is a move rather than a jump. */
  ascentSpace(game, body) {
    const R = game.ship.length;
    const shipSubj = { absPos: game.ship.absPos, quat: game.ship.quat };
    return {
      title: body.name,
      sub: 'ORBIT · CLEAR OF THE WELL',
      shots: [
        {
          dur: 6.0, ease: 'settle', subject: shipSubj, up: 'subject',
          eye: [[R * 1.24, R * 0.30, R * 1.86], [R * 0.62, R * 0.24, R * 1.28]],
          look: [[0, 0, 0], [0, R * 0.02, 0]],
          fov: [46, 54], roll: [0.012, 0],
        },
      ],
    };
  },

  /**
   * The second half of the same shot, on the other side of the cloud.
   *
   * Nothing is cut here. The eye starts at the offset the descent ended on,
   * measured from a subject that is still the ship — `groundCamAnchor` is glued
   * to the hull at this instant — so the frame the audience is looking at does
   * not move when the world under it changes. Over the next few seconds that
   * anchor eases down to the landing site while the gaze stays on the ship, and
   * the camera turns from something flying alongside into something standing on
   * the ground watching the ship come down to it. One move, no cuts, and it
   * ends parked where the landed crane begins so the handback is not one
   * either.
   */
  touchdown(game, body) {
    const R = game.ship.length * 1000;    // the ground scene is in metres
    return {
      title: body.name,
      sub: 'SURFACE · ATMOSPHERE NOMINAL',
      shots: [
        {
          dur: 7.6, ease: 'inOut',
          subject: (g) => ({ absPos: g.groundCamAnchor }),
          lookSubject: (g) => ({ absPos: g.groundShipAnchor }),
          /* Both offsets are in the hull's own frame at the crossing, which is
             why the numbers match the descent's last ones — and the far end is
             where updateCamera's crane starts, at 1.55 out and 0.22 up looking
             at 0.28 of a hull-length. */
          eye: [[R * 1.28, R * 0.34, R * 1.92], [R * 0.95, R * 0.252, R * 1.434]],
          look: [[0, 0, 0], [0, R * 0.28, 0]],
          fov: [50, 44], roll: [-0.006, 0],
        },
      ],
    };
  },

  /** Coming alongside a station. */
  approach(game, body) {
    const R = body.radius;
    const subj = { absPos: body.absPos };
    const ship = { absPos: game.ship.absPos, quat: game.ship.quat };
    return {
      title: body.name,
      sub: 'APPROACH · HOLDING',
      shots: [
        // the station passes overhead
        {
          dur: 4.2, ease: 'inOut', subject: subj,
          eye: [[R * 2.6, -R * 0.85, R * 2.2], [R * 0.7, -R * 0.55, R * 0.5]],
          look: [[0, 0, 0]],
          fov: [36, 52],
        },
        // and the ship slides in under it
        {
          dur: 3.6, ease: 'settle', subject: ship,
          eye: [[game.ship.length * 3.0, game.ship.length * 0.6, game.ship.length * 2.6],
            [game.ship.length * 1.6, game.ship.length * 0.35, game.ship.length * 1.5]],
          look: [[0, 0, 0]],
          fov: [40, 34],
        },
      ],
    };
  },
};
