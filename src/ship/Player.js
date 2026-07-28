import * as THREE from 'three';

/* ============================================================================
   First-person crew controller, working in interior metres.

   Collision is deliberately not a physics engine: the module is a corridor of
   known width, so the walkable region is a half-width function of Z plus a
   handful of blocker rectangles. Moving each axis separately means you slide
   along a bulkhead instead of sticking to it.
   ========================================================================== */

const EYE = 1.66;          // eye height, metres
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _ctrl = new THREE.Vector3();
const RADIUS = 0.30;
const WALK = 1.75;
const RUN = 3.1;

export class Player {
  constructor(interior) {
    this.interior = interior;
    this.pos = new THREE.Vector3(0, 0, 2.4);   // standing in the habitat
    this.vel = new THREE.Vector3();
    this.yaw = 0;                       // wake facing forward, toward the helm
    this.pitch = 0;
    this.mode = 'walk';                 // walk | seated | moving | ground
    /* `ground` is the same controller standing on a planet instead of on a
       deck. Everything about walking is identical — the only two things the
       interior supplies are the corridor's walkable region and a floor at y=0,
       and outdoors both come from the terrain instead. */
    this.groundHeight = null;           // (x, z) -> metres, set by Game on foot
    this.groundY = 0;
    this.bob = 0;
    this.bobAmt = 0;
    this.seatBlend = 0;
    this.station = null;                // station currently in reach
    this.seatedAt = null;
    this._from = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
    this._t = 0;
    this._headTilt = 0;

    this.eye = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  /** Walkable half-width at a given Z (the corridor is narrower than the ends). */
  _halfWidthAt(z) {
    const V = this.interior.volumes;
    for (const v of V) if (z >= v[2] && z <= v[3]) return v[1];
    return 0.6;
  }

  _blocked(x, z) {
    for (const b of this.interior.blockers) {
      if (x > b[0] - RADIUS && x < b[1] + RADIUS && z > b[2] - RADIUS && z < b[3] + RADIUS) return true;
    }
    return false;
  }

  _tryMove(dx, dz) {
    const V = this.interior.volumes;
    const zMin = V[0][2] + RADIUS, zMax = V[V.length - 1][3] - RADIUS;

    const nx = this.pos.x + dx;
    if (Math.abs(nx) <= this._halfWidthAt(this.pos.z) - RADIUS && !this._blocked(nx, this.pos.z)) {
      this.pos.x = nx;
    }
    const nz = THREE.MathUtils.clamp(this.pos.z + dz, zMin, zMax);
    if (Math.abs(this.pos.x) <= this._halfWidthAt(nz) - RADIUS && !this._blocked(this.pos.x, nz)) {
      this.pos.z = nz;
    }
  }

  look(dx, dy, sens = 1) {
    if (this.mode === 'moving') return;
    this.yaw -= dx * 0.0024 * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0024 * sens, -1.32, 1.32);
    if (this.mode === 'seated') {
      // Seated look is limited to the arc the canopy actually covers, so you
      // cannot end up staring through the back of your own chair.
      const s = this.seatedAt;
      const rel = wrapPi(this.yaw - s.baseYaw);
      this.yaw = s.baseYaw + THREE.MathUtils.clamp(rel, -1.15, 1.15);
      this.pitch = THREE.MathUtils.clamp(this.pitch, -0.72, 0.62);
    }
  }

  sit(station) {
    if (this.mode !== 'walk') return;
    this._from.pos.copy(this.pos);
    this._from.yaw = this.yaw;
    this._from.pitch = this.pitch;
    this.seatedAt = {
      station,
      eye: station.seatEye || new THREE.Vector3(0, 1.16, -5.28),
      baseYaw: station.seatYaw !== undefined ? station.seatYaw : 0,
    };
    this.mode = 'moving';
    this._t = 0;
    this._target = 'seated';
  }

  stand() {
    if (this.mode !== 'seated') return;
    this._from.pos.set(this.seatedAt.eye.x, 0, this.seatedAt.eye.z);
    this._from.yaw = this.yaw;
    this._from.pitch = this.pitch;
    this.pos.set(0, 0, -4.35);
    this.mode = 'moving';
    this._t = 0;
    this._target = 'walk';
  }

  /**
   * Eye path between standing and seated.
   *
   * A straight line from where you are standing to the seat eye point runs
   * through the backrest, and the camera flies through it — visible as a frame
   * or two of grey shell filling the screen. The path is bowed instead: out to
   * whichever side you approached from, and lifted, so the eye swings around
   * the seat and settles into it the way a body would.
   */
  _seatPath(from, to, k, out) {
    const side = Math.abs(from.x - to.x) > 0.04 ? Math.sign(from.x - to.x) : 1;
    _ctrl.copy(from).lerp(to, 0.5);
    _ctrl.x += side * 0.30;
    _ctrl.y += 0.17;
    _ctrl.z += 0.16;                       // clear of the backrest
    const u = 1 - k;
    out.set(
      u * u * from.x + 2 * u * k * _ctrl.x + k * k * to.x,
      u * u * from.y + 2 * u * k * _ctrl.y + k * k * to.y,
      u * u * from.z + 2 * u * k * _ctrl.z + k * k * to.z);
  }

  update(dt, input, uiOpen) {
    const st = input.state;

    if (this.mode === 'moving') {
      this._t = Math.min(1, this._t + dt * 1.7);
      const k = easeInOut(this._t);
      const s = this.seatedAt;
      const stand = _tmpA.set(this._from.pos.x, EYE, this._from.pos.z);
      if (this._target === 'seated') {
        this._seatPath(stand, s.eye, k, this.eye);
        this.yaw = lerpAngle(this._from.yaw, s.baseYaw, k);
        this.pitch = THREE.MathUtils.lerp(this._from.pitch, -0.10, k);
      } else {
        this._seatPath(_tmpB.set(this.pos.x, EYE, this.pos.z), s.eye, 1 - k, this.eye);
        this.yaw = lerpAngle(this._from.yaw, s.baseYaw + Math.PI * 0.0, k);
        this.pitch = THREE.MathUtils.lerp(this._from.pitch, 0, k);
      }
      if (this._t >= 1) { this.mode = this._target; if (this._target === 'walk') this.seatedAt = null; }
    } else if (this.mode === 'seated') {
      this.eye.copy(this.seatedAt.eye);
      this.bobAmt *= Math.max(0, 1 - dt * 6);

      // Lean is *added* to wherever you are looking rather than replacing it:
      // overwriting the pilot's aim meant you could never study your own
      // console. Free-look holds the head; releasing it eases back to centre.
      const av = this.autoHead;
      const lean = av ? av : { x: 0, y: 0, z: 0 };
      this.headYawOff = THREE.MathUtils.lerp(this.headYawOff || 0, lean.y * 0.16, Math.min(1, dt * 5));
      this.headPitchOff = THREE.MathUtils.lerp(this.headPitchOff || 0, -lean.x * 0.16, Math.min(1, dt * 5));
      this._headTilt = THREE.MathUtils.lerp(this._headTilt,
        -lean.z * 0.11 - lean.y * 0.06, Math.min(1, dt * 5));

      if (!this.freeLook) {
        const k = Math.min(1, dt * 2.6);
        this.yaw = lerpAngle(this.yaw, this.seatedAt.baseYaw, k);
        this.pitch = THREE.MathUtils.lerp(this.pitch, -0.09, k);
      }
    } else {
      // ---- walking, on a deck or on a planet
      const onFoot = this.mode === 'ground';
      const run = input.held('boost');
      const speed = (run ? RUN : WALK) * (uiOpen ? 0 : 1);
      const fwd = (input.held('thrUp') ? 1 : 0) - (input.held('thrDn') ? 1 : 0)
        + (input.touch ? -input.touchL.y : 0);
      const strafe = (input.held('yawR') ? 1 : 0) - (input.held('yawL') ? 1 : 0)
        + (input.touch ? input.touchL.x : 0);

      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      let vx = (-sy * fwd + cy * strafe);
      let vz = (-cy * fwd - sy * strafe);
      const l = Math.hypot(vx, vz);
      if (l > 1) { vx /= l; vz /= l; }

      const target = new THREE.Vector3(vx * speed, 0, vz * speed);
      this.vel.lerp(target, Math.min(1, dt * 12));
      if (onFoot) {
        // No corridor to be constrained by. Terrain collision is the ground
        // height under the feet, resolved below.
        this.pos.x += this.vel.x * dt;
        this.pos.z += this.vel.z * dt;
      } else {
        this._tryMove(this.vel.x * dt, this.vel.z * dt);
      }

      const moving = this.vel.length();
      this.bob += moving * dt * (run ? 5.4 : 6.6);
      this.bobAmt += (Math.min(moving / WALK, 1.2) - this.bobAmt) * Math.min(1, dt * 8);
      this._headTilt += ((-strafe * 0.02) - this._headTilt) * Math.min(1, dt * 6);

      /* Follow the ground, but not instantly. Sampling the height field and
         writing it straight to the eye means every ripple the terrain has at
         stride scale is transmitted directly into the camera, which reads as a
         hand-held shot on a trampoline. Legs absorb the high frequencies; a
         critically-damped follow is the cheap stand-in for that. */
      if (onFoot) {
        const h = this.groundHeight ? this.groundHeight(this.pos.x, this.pos.z) : 0;
        this.groundY += (h - this.groundY) * Math.min(1, dt * 9);
      } else {
        this.groundY = 0;
      }
      this.pos.y = this.groundY;

      this.eye.set(
        this.pos.x,
        this.groundY + EYE + Math.sin(this.bob * 2) * 0.021 * this.bobAmt,
        this.pos.z
      );
      this.eye.x += Math.cos(this.bob) * 0.014 * this.bobAmt;
    }

    this._e.set(this.pitch + (this.headPitchOff || 0),
      this.yaw + (this.headYawOff || 0), this._headTilt);
    this.quat.setFromEuler(this._e);

    // ---- station in reach
    this.station = null;
    if (this.mode === 'walk') {
      let best = null, bd = 1e9;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      for (const s of this.interior.stations) {
        const dx = s.pos.x - this.pos.x, dz = s.pos.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > s.radius + 0.55) continue;
        const facing = d < 0.25 ? 1 : (dx * fx + dz * fz) / d;
        if (facing < 0.25) continue;
        if (d < bd) { bd = d; best = s; }
      }
      this.station = best;
    }
    return this;
  }
}

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function wrapPi(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
function lerpAngle(a, b, t) { return a + wrapPi(b - a) * t; }
