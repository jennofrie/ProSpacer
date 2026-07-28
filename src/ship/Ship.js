import * as THREE from 'three';
import { buildHull } from './hull.js';

/* ------------------------------------------------------------- flight model */

export class Ship {
  constructor() {
    const built = buildHull();
    this.object = new THREE.Group();
    this.model = built.root;
    this.object.add(this.model);
    this.engineMats = built.engineMats;
    this.radiator = built.radiator;
    this.vanes = built.vanes;
    this.dishPivot = built.dishPivot;
    this.strobe = built.strobe;
    this.nacelles = built.nacelles;
    this.gear = built.gear;
    this.length = built.length;

    this.absPos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();

    this.throttle = 0;
    this.boost = 0;
    this.assist = true;

    this.maxSpeed = 60;          // km/s cruise
    this.boostMul = 4.2;
    this.accel = 22;
    this.turnAccel = new THREE.Vector3(2.6, 2.2, 3.4);   // pitch, yaw, roll
    this.turnDamp = 3.1;
    this.maxTurn = new THREE.Vector3(1.15, 0.95, 1.7);

    this.foldMode = false;
    this.foldSpeed = 0;
    this.foldCharge = 1;
    this.foldRegen = 1;
    this.hull = 1;
    this.hullMax = 1;
    this.heat = 0.12;
    this.scanRate = 1;

    this._fwd = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tq = new THREE.Quaternion();
  }

  /** Gear is down only on the ground; in flight it is stowed and invisible. */
  deployGear(on) { if (this.gear) this.gear.visible = !!on; }

  get forward() { return this._fwd.set(0, 0, -1).applyQuaternion(this.quat); }
  get speed() { return this.vel.length(); }

  update(dt, input, env) {
    const q = this.quat;

    // ---------------------------------------------------------- rotation
    const ta = this.turnAccel;
    const damp = this.foldMode ? this.turnDamp * 2.4 : this.turnDamp;
    const authority = this.foldMode ? 0.20 : 1.0;
    this.angVel.x += (input.pitch * ta.x * authority - this.angVel.x * damp) * dt;
    this.angVel.y += (input.yaw * ta.y * authority - this.angVel.y * damp) * dt;
    this.angVel.z += (input.roll * ta.z * authority - this.angVel.z * damp) * dt;
    this.angVel.x = THREE.MathUtils.clamp(this.angVel.x, -this.maxTurn.x, this.maxTurn.x);
    this.angVel.y = THREE.MathUtils.clamp(this.angVel.y, -this.maxTurn.y, this.maxTurn.y);
    this.angVel.z = THREE.MathUtils.clamp(this.angVel.z, -this.maxTurn.z, this.maxTurn.z);

    this._tq.setFromEuler(new THREE.Euler(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, 'XYZ'));
    q.multiply(this._tq).normalize();

    // ------------------------------------------------------------ thrust
    const fwd = this.forward.clone();
    if (this.foldMode) {
      // fold speed scales with distance to the nearest mass — you accelerate
      // out of a gravity well and decelerate into one
      const targetFold = env.foldCeiling;
      this.foldSpeed += (targetFold - this.foldSpeed) * Math.min(1, dt * 0.55);
      this.vel.copy(fwd).multiplyScalar(this.foldSpeed);
      this.heat = Math.min(1, this.heat + dt * 0.02);
      this.foldCharge = Math.max(0, this.foldCharge - dt * 0.012);
    } else {
      this.foldSpeed = 0;
      const boostF = 1 + this.boost * (this.boostMul - 1);
      const target = this._tmp.copy(fwd).multiplyScalar(this.throttle * this.maxSpeed * boostF);

      // lateral / vertical translation thrusters
      if (input.strafeX || input.strafeY) {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        target.addScaledVector(right, input.strafeX * this.maxSpeed * 0.35);
        target.addScaledVector(upv, input.strafeY * this.maxSpeed * 0.35);
      }

      const rate = this.assist ? this.accel * (1 + this.boost * 1.8) : this.accel * 0.35;
      const dv = target.sub(this.vel);
      const dvLen = dv.length();
      if (dvLen > 1e-6) {
        dv.multiplyScalar(Math.min(1, (rate * dt) / dvLen));
        this.vel.add(dv);
      }
      this.heat += ((0.10 + this.throttle * 0.30 + this.boost * 0.5) - this.heat) * dt * 0.4;
      this.foldCharge = Math.min(1, this.foldCharge + dt * 0.045 * this.foldRegen);
    }

    this.absPos.addScaledVector(this.vel, dt);
    this.object.quaternion.copy(q);

    this.updateVisuals(dt, env.time);
  }

  /* Everything the hull does that is not flight: the drive, the radiators, the
   * dish and the strobe.
   *
   * Split out because the landed branch of Game.update returns long before
   * `update` — there is no flight to integrate on the ground — and the plume's
   * decay lived at the bottom of it. `land()` sets throttle to zero, but
   * `this.power` is a spring toward the throttle and nothing was stepping it,
   * so it froze at whatever it held on the approach and the ship sat parked on
   * a planet with both engines at full burn for the length of the landing. */
  updateVisuals(dt, time) {
    const power = this.foldMode ? 1.6
      : THREE.MathUtils.clamp(this.throttle * (1 + this.boost * 1.2), 0, 1.6);
    this.power = (this.power || 0) + (power - (this.power || 0)) * Math.min(1, dt * 6);
    for (const m of this.engineMats) {
      m.uniforms.uTime.value = time;
      m.uniforms.uPower.value = this.power;
    }

    // Waste heat lags the drive by a long way — the vanes are still glowing
    // minutes after a burn, which is the detail that sells them as radiators
    // rather than as wings.
    this.heatGlow = (this.heatGlow || 0) + (this.power * 0.42 + this.heat * 0.35 - (this.heatGlow || 0))
      * Math.min(1, dt * 0.28);
    // Radiators run a few hundred kelvin, not orange-hot. Anything more than a
    // faint ember reads as damage.
    this.radiator.emissiveIntensity = this.heatGlow * 0.28;

    // The vanes open wider under load to present more area, and settle back
    // when the drive is cold. Slow — they are structures, not control surfaces.
    for (let i = 0; i < this.vanes.length; i++) {
      const s = i === 0 ? 1 : -1;
      const g = this.vanes[i];
      const want = g.userData.baseZ + s * this.heatGlow * 0.26;
      g.rotation.z += (want - g.rotation.z) * Math.min(1, dt * 0.9);
    }
    this.dishPivot.rotation.y += dt * 0.10;
    this.dishPivot.rotation.z = Math.sin(time * 0.21) * 0.16;

    // anti-collision strobe: a double flash, then a long gap
    const cyc = (time * 0.72) % 1;
    const flash = (cyc < 0.035 || (cyc > 0.09 && cyc < 0.125)) ? 6.0 : 0.0;
    this.strobe.material.color.setRGB(flash, flash, flash);
  }
}
