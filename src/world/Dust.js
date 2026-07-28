import * as THREE from 'three';
import { LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';

/* ============================================================================
   Interplanetary dust — the single cheapest trick for conveying motion.
   Particles live in a wrapping box around the ship and are drawn as line
   segments stretched along the velocity vector, so they streak when you move.
   ========================================================================== */

const VERT = /* glsl */`${LOGD_V_PARS}
attribute float aSide;
attribute float aRand;
uniform vec3  uOffset;
uniform vec3  uStreak;     // world-space streak vector (velocity * length)
uniform float uBox;
uniform float uFade;
uniform float uFoldK;
varying float vA;
void main(){
  float L = uBox;
  vec3 p = mod(position - uOffset + L*0.5, L) - L*0.5;
  float d = length(p);
  // fade in from the far edge and out at the very centre (avoids popping)
  float a = (1.0 - smoothstep(L*0.28, L*0.5, d)) * smoothstep(0.0, L*0.075, d);
  // Squared, so most motes are short and a few run long. Equal-length streaks
  // are the single loudest tell that a warp field is a particle system.
  p -= uStreak * aSide * (0.12 + aRand*aRand*1.9);
  // Taper toward the tail. An additive line of constant brightness reads as a
  // scratch on the lens no matter how short it is; the same line fading out
  // behind the mote reads as motion, which is the entire point of the effect.
  // In fold the head of each streak is a hard bright point and the tail runs
  // far behind it; at cruise it is the reverse of subtle.
  float head = mix(0.08, 0.02, uFoldK);
  // Not higher than this. The exposure metric is an RMS over the frame, and a
  // fold transit fills the screen with medium-bright motes: pushing them
  // brighter makes the auto-exposure stop down and takes the whole image with
  // it. Measured at 16x the frame's 99th percentile *fell* from 143 to 36.
  vA = a * uFade * (0.10 + aRand*0.34) * mix(1.0, head, aSide) * (1.0 + uFoldK*2.2);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  ${LOGD_V}
}
`;

const FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
varying float vA;
uniform vec3 uColor;
void main(){
  ${LOGD_F}
  if(vA <= 0.002) discard;
  gl_FragColor = vec4(uColor*vA, 1.0);
}
`;

export class Dust {
  constructor(count = 2400, box = 6.0) {
    const pos = new Float32Array(count * 2 * 3);
    const side = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * box;
      const y = (Math.random() - 0.5) * box;
      const z = (Math.random() - 0.5) * box;
      const r = Math.random();
      for (let k = 0; k < 2; k++) {
        pos[(i * 2 + k) * 3] = x;
        pos[(i * 2 + k) * 3 + 1] = y;
        pos[(i * 2 + k) * 3 + 2] = z;
        side[i * 2 + k] = k;
        rnd[i * 2 + k] = r;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uOffset: { value: new THREE.Vector3() },
        uStreak: { value: new THREE.Vector3() },
        uBox: { value: box },
        uFade: { value: 1 },
        uFoldK: { value: 0 },
        uColor: { value: new THREE.Color(0.55, 0.68, 0.85) },
      },
    });
    this.box = box;
    this.object = new THREE.LineSegments(geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this._v = new THREE.Vector3();
  }

  /**
   * @param opts  fade — global opacity; color — tint;
   *              fold — 0..1, how far into a fold transit the ship is
   */
  update(shipAbsPos, velocity, dt, opts = {}) {
    const u = this.mat.uniforms;
    const L = this.box;
    const fold = opts.fold || 0;
    u.uOffset.value.set(
      ((shipAbsPos.x % L) + L) % L,
      ((shipAbsPos.y % L) + L) % L,
      ((shipAbsPos.z % L) + L) % L
    );
    const sp = velocity.length();
    /* Streak length. In normal flight this stays short — past about 4% of the
       box a streak stops reading as a dust mote in motion and starts reading as
       a scratch on the lens. Fold relaxes the cap but does not lift it: the
       tunnel shader owns the transit, and these motes exist only to give it the
       near-field parallax a screen-space effect cannot have. Run them long
       enough to be the effect and they read as a particle system again. */
    const cruiseLen = Math.min(sp * 0.0018, L * 0.042);
    const foldLen = L * 0.26;
    const len = THREE.MathUtils.lerp(cruiseLen, foldLen, fold);
    this._v.copy(velocity);
    if (sp > 1e-5) this._v.multiplyScalar(len / sp); else this._v.set(0, 0, 0);
    u.uStreak.value.copy(this._v);
    const fade = opts.fade !== undefined ? opts.fade : 1;
    u.uFade.value += (fade - u.uFade.value) * Math.min(1, dt * 4);
    u.uFoldK.value += (fold - u.uFoldK.value) * Math.min(1, dt * 2.5);
    if (opts.color) u.uColor.value.copy(opts.color);
  }
}
