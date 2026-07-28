import * as THREE from 'three';

/* ============================================================================
   The fold tunnel.

   A screen-aligned quad, drawn before the opaque pass with depth writes off,
   so the ship silhouettes against it instead of being washed away by it.

   The whole effect lives in *tunnel space*: the ray through each pixel is
   resolved into an angle around the direction of travel and an angular
   distance from it, and the second is inverted into a depth coordinate. A
   feature at a fixed depth therefore compresses toward the vanishing point
   exactly as a real one would, and scrolling that coordinate sweeps the whole
   field past the camera at once — no particles, no overdraw, no popping.

   Three things separate this from a line-particle starfield:

   - The centre is the brightest thing on screen, not a hole. Streaks are born
     out of a caustic and stretch outward. (It doubles as the fix for the
     aliasing the 1/angle mapping causes near the axis: the pattern is faded
     out under the core well before its features fall below a pixel.)
   - The main layer is sampled three times at slightly different depths, once
     per channel, which splits every streak into a blue leading edge and a red
     trailing one. That dispersion is what reads as *speed* rather than motion.
   - The tunnel corkscrews. A constant twist per unit depth means the streaks
     rotate as they pass, so the field has a handedness and an axis instead of
     being flat radial spray.
   ========================================================================== */

const VERT = /* glsl */`
varying vec2 vNdc;
void main(){
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vNdc;

uniform float uFold;      // 0..1 transit ramp
uniform float uFlash;     // entry/exit spike
uniform float uT;
uniform float uTanHalf;
uniform float uAspect;
uniform vec3  uAxis;      // direction of travel, view space
uniform vec3  uCoolCol;
uniform vec3  uWarmCol;

const float TAU = 6.28318530718;

float h21(vec2 p, float per){
  p.x = mod(p.x, per);
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Value noise that tiles in x, so a lane count divides the ring evenly and the
// seam at theta = +-pi does not show as a bright scar down one side.
float vn(vec2 p, float per){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0 - 2.0*f);
  float a = h21(i,               per), b = h21(i + vec2(1.0, 0.0), per);
  float c = h21(i + vec2(0.0,1.0), per), d = h21(i + vec2(1.0, 1.0), per);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}

float fbm3(vec2 p, float per){
  float s = vn(p, per) * 0.60;
  s += vn(p * vec2(2.0, 2.13) + 11.3, per*2.0) * 0.27;
  s += vn(p * vec2(4.0, 4.31) + 27.7, per*4.0) * 0.13;
  return s;
}

float fbm2(vec2 p, float per){
  return vn(p, per) * 0.68 + vn(p * vec2(2.0, 2.17) + 5.1, per*2.0) * 0.32;
}

void main(){
  if(uFold <= 0.0015 && uFlash <= 0.0015){ gl_FragColor = vec4(0.0); return; }

  vec3 rd = normalize(vec3(vNdc.x * uTanHalf * uAspect, vNdc.y * uTanHalf, -1.0));
  vec3 F = normalize(uAxis);
  vec3 A = abs(F.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 R = normalize(cross(A, F));
  vec3 U = cross(F, R);

  float ang = acos(clamp(dot(rd, F), -1.0, 1.0));
  float th  = atan(dot(rd, U), dot(rd, R));

  // Behind the ship there is no tunnel, only the wake closing up.
  float behind = smoothstep(1.75, 1.15, ang);
  if(behind <= 0.0){ gl_FragColor = vec4(0.0); return; }

  // Depth along the tunnel. 1/angle, not 1/tan(angle): the extra curvature of
  // the tangent buys nothing at these field of views and costs a transcendental.
  float depth = 1.0 / max(ang, 0.020);

  // Corkscrew. Twist proportional to depth, so the far end of the tunnel is
  // rotated relative to the near end and the streaks appear to spiral in.
  float lane = th / TAU + depth * 0.0085 + uT * 0.013;

  // Fade the pattern out under the core. Past here 1/angle is changing faster
  // than a pixel and the streaks would alias into a shimmering rosette.
  float inner = smoothstep(0.018, 0.085, ang);

  // --- outer sheath: slow, wide, deep colour ------------------------------
  // Enough lanes to break up across the frame. At thirteen only three cells
  // span the field of view and the sheath is a flat wash over half the screen.
  float sheath = fbm3(vec2(lane * 29.0, depth * 0.62 - uT * 1.05), 29.0);
  sheath = pow(smoothstep(0.42, 0.96, sheath), 2.6);

  // --- main streaks, dispersed --------------------------------------------
  // One sample per channel, offset along the tunnel. The offset has to grow
  // with depth: a feature near the vanishing point is a couple of pixels long
  // and a feature at the frame edge is a couple of hundred, so a constant
  // offset is invisible where the streaks are fast and splits them into a full
  // prism spectrum where they are slow — exactly backwards. Scaling by depth
  // puts the dispersion where the speed is. It must not include the scroll
  // term, or the split widens without bound as the clock runs.
  const float LANES = 112.0;
  float sc = 2.35, sp = 3.9;
  float base = depth * sc - uT * sp;
  float disp = depth * sc * 0.0042 * uFold;
  float nB = fbm3(vec2(lane * LANES, base + disp), LANES);
  float nG = fbm3(vec2(lane * LANES, base),        LANES);
  float nR = fbm3(vec2(lane * LANES, base - disp), LANES);
  vec3 streak = vec3(
    pow(smoothstep(0.46, 0.99, nR), 3.4),
    pow(smoothstep(0.46, 0.99, nG), 3.4),
    pow(smoothstep(0.46, 0.99, nB), 3.4));

  // --- fine filaments -----------------------------------------------------
  const float FINE = 154.0;
  float fine = fbm2(vec2(lane * FINE, depth * 5.4 - uT * 7.2), FINE);
  fine = pow(smoothstep(0.62, 1.0, fine), 5.0);

  // --- assemble -----------------------------------------------------------
  // Radial falloff: the sheath owns the edge of the frame, the streaks own the
  // middle distance, the filaments live close to the core.
  float edge  = smoothstep(0.06, 0.62, ang);
  float mid   = 1.0 - smoothstep(0.30, 1.10, ang);

  vec3 col = vec3(0.0);
  col += uWarmCol * sheath * edge * 0.26;
  col += uCoolCol * streak * (0.35 + mid * 0.95) * 1.70;
  col += mix(uCoolCol, vec3(1.0), 0.55) * fine * mid * 0.70;
  col *= inner;

  // --- core ---------------------------------------------------------------
  // The caustic the streaks are born out of. Two lobes: a small white one that
  // clips, and a wide coloured halo that gives it a size on screen.
  // Small and hot beats large and bright — the bloom does the growing, and a
  // core wide enough to read on its own comes back from post as a white hole.
  float c0 = exp(-ang * ang / (2.0 * 0.019 * 0.019));
  float c1 = exp(-ang * ang / (2.0 * 0.068 * 0.068));
  float breathe = 0.86 + 0.14 * sin(uT * 5.3) * sin(uT * 2.1);
  col += vec3(1.0, 0.985, 0.97) * c0 * 15.0 * breathe;
  col += mix(uCoolCol, vec3(1.0), 0.35) * c1 * 1.35;

  // Bubble wall: the frame edge compresses into the violet end as the drive
  // spins up, which keeps the corners from being flat black.
  float wall = smoothstep(0.55, 1.35, ang);
  col += uWarmCol * wall * 0.040 * (0.55 + 0.45 * sheath);

  col *= behind;

  // Entry and exit flash: a full-field white bloom that the streaks resolve
  // out of, so the transition is an event instead of a fade.
  col += vec3(0.86, 0.93, 1.0) * uFlash * (2.2 + c1 * 22.0);

  // Not higher than this. The exposure metric is an RMS over the frame; a
  // screen of medium-bright streaks makes the camera stop down and takes the
  // rest of the image with it. Brightness belongs in the core, which is small.
  gl_FragColor = vec4(col * uFold, 1.0);
}
`;

export class FoldTunnel {
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
      transparent: false,                 // keeps it in the opaque list, so the
      blending: THREE.AdditiveBlending,   // hull can draw over it afterwards
      uniforms: {
        uFold: { value: 0 }, uFlash: { value: 0 }, uT: { value: 0 },
        uTanHalf: { value: 0.6 }, uAspect: { value: 1.78 },
        uAxis: { value: new THREE.Vector3(0, 0, -1) },
        uCoolCol: { value: new THREE.Color(0.44, 0.70, 1.0) },
        uWarmCol: { value: new THREE.Color(0.30, 0.11, 0.42) },
      },
    });
    this.object = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = -1000;
    this.object.matrixAutoUpdate = false;
    this._v = new THREE.Vector3();
    this._prev = 0;
  }

  /** @param fold 0..1 — how far into the transit the drive is. */
  update(dt, camera, velocity, fold, time) {
    const u = this.mat.uniforms;
    const k = Math.min(1, dt * 2.2);
    u.uFold.value += (fold - u.uFold.value) * k;
    u.uT.value = time;

    // Flash on either edge of the transit, from the *commanded* state rather
    // than the smoothed one, so it leads the ramp instead of trailing it.
    if (fold !== this._prev) u.uFlash.value = 1.0;
    this._prev = fold;
    u.uFlash.value *= Math.exp(-dt * 6.5);
    if (u.uFlash.value < 0.002) u.uFlash.value = 0;

    u.uTanHalf.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    u.uAspect.value = camera.aspect;

    // Direction of travel in view space. Falls back to straight ahead while
    // the ship is still building speed, otherwise the axis whips around at the
    // moment the drive engages and the tunnel appears sideways.
    const sp = velocity.length();
    if (sp > 1e-4) {
      this._v.copy(velocity).multiplyScalar(1 / sp)
        .applyQuaternion(camera.quaternion.clone().invert());
    } else this._v.set(0, 0, -1);
    u.uAxis.value.lerp(this._v, Math.min(1, dt * 3.5)).normalize();
  }

  setPalette(cool, warm) {
    this.mat.uniforms.uCoolCol.value.copy(cool);
    this.mat.uniforms.uWarmCol.value.copy(warm);
  }
}
