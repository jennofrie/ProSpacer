import * as THREE from 'three';
import { holoMat } from './Cockpit.js';
import { HoloScreen, AM, DIM } from './HoloScreen.js';
import { INTERIOR_LAYER } from './interiorMaterials.js';
import { LOGD_V_PARS, LOGD_V } from '../gfx/glsl/noise.js';
import { kelvinColor } from '../world/generate.js';

/* ============================================================================
   Stellar cartography, as an object in the room.

   The first pass at this was fourteen dots over a table, which is a diagram,
   not a chart — the eye had nothing to hold on to, and it read as low detail
   however sharp the pixels actually were. Density is what sells a hologram, so
   the volume now carries, back to front:

     · a field of ~900 background stars in a lens-shaped disc, so the galaxy has
       substance for the fourteen playable systems to sit inside;
     · dust bands — broad, very dim additive sheets rotating against each other,
       giving the volume interior structure instead of empty air;
     · a polar survey grid on the base plane, dense at the hub and fading out,
       with a sweep arm that rotates like a scanning radar;
     · the systems themselves: cores coloured by temperature, each dropping a
       stalk to a footprint ring on the grid, which is what turns a floating dot
       into a *position*;
     · lanes between near neighbours, so the scatter reads as a network;
     · a label on every system, and a bracket reticle on the selection.

   The galaxy generates as a 2D scatter, so height comes from the system seed.
   It is not physics, it is parallax: a flat sheet of dots reads as a diagram,
   and the same dots given depth read as a volume.
   ========================================================================== */

const TABLE = new THREE.Vector3(0, 1.17, 2.6);
const SCALE = 0.0080;        // light-years -> metres on the table
const LIFT = 0.235;          // vertical spread of the volume
const DISC = 0.50;           // radius of the base grid
const DEPLOY = 1.06;         // deployed size, relative to the table

/* Radiance.
 *
 * The chart was authored under unity. `holoMat` blends additively with
 * SrcAlpha, so what lands in the buffer is colour * alpha * alpha, and with
 * alpha held under unity except on the build-up band — 0.14 to 0.26 for
 * anything structural — a grid line arrived at four hundredths of a unit of
 * scene radiance. This codebase needs of the order of 120 to reach white.
 * The whole object was therefore *present and invisible*: barely there at all,
 * a few faint white aliased wisps, which is what a
 * sub-unit additive line looks like once auto-exposure has opened up to find
 * it and the room behind it has come up with it.
 *
 * These are the gains that put each element in a real HDR range, and they are
 * spread over four stops rather than flat, because a chart in which every line
 * is the same value is the diagram problem again in a different form.
 */
const G_GRID = 8;            // base plate, rings, spokes: the quiet layer
const G_STRUCT = 17;         // lanes, stalks, footprints
const G_BODY = 4.5;          // containment wall and projector cone
const G_WARM = 42;           // reticle, route, hub — the one warm layer
const G_SWEEP = 16;

/* ---------------------------------------------------------------- textures */

/* A soft radial falloff. An additively blended plane with a flat colour is just
   a bright square — the falloff is the whole difference between "a light" and
   "a tile". Built once and shared. */
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0.00, 'rgba(255,255,255,1)');
  gr.addColorStop(0.16, 'rgba(255,255,255,0.62)');
  gr.addColorStop(0.42, 'rgba(255,255,255,0.16)');
  gr.addColorStop(1.00, 'rgba(255,255,255,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

/** Uneven cloud for the dust sheets: a ring of overlapping soft blobs. */
let _dustTex = null;
function dustTexture() {
  if (_dustTex) return _dustTex;
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, N, N);
  x.globalCompositeOperation = 'lighter';
  let seed = 99173;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI * 2;
    const r = (0.18 + Math.pow(rnd(), 0.7) * 0.30) * N;
    const px = N / 2 + Math.cos(a) * r, py = N / 2 + Math.sin(a) * r;
    const rad = N * (0.05 + rnd() * 0.12);
    const g = x.createRadialGradient(px, py, 0, px, py, rad);
    const w = 26 + rnd() * 30;
    g.addColorStop(0, `rgba(${Math.round(w * 0.7)},${Math.round(w * 0.9)},${Math.round(w)},1)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.beginPath(); x.arc(px, py, rad, 0, 6.2832); x.fill();
  }
  _dustTex = new THREE.CanvasTexture(c);
  _dustTex.colorSpace = THREE.SRGBColorSpace;
  return _dustTex;
}

/* ------------------------------------------------------- the star field
   A dedicated material, because `PointsMaterial` can do neither of the two
   things this field needs.

   The first is a *pixel floor*. Attenuated size on a 8.5 mm sprite puts most
   of the nine hundred background stars under one pixel at a metre, and a
   sub-pixel emissive is not dim, it is absent — it aliases into and out of
   existence as the volume turns, which is exactly the "aliasy wisps" reading.
   The floor is three pixels, and it conserves flux: a sprite spread over more
   area is dimmed by the area it gained, so the far end of the field thins
   instead of the frame carpeting with hard little squares.

   The second is *depth cueing*. A scatter of identically bright dots is a
   diagram however much parallax it has; what makes a volume read as a volume
   is that the near half comes forward. Near is bright and near-white, far
   falls away into the blue, and the two ends are two and a half stops apart. */
const FIELD_VERT = /* glsl */`${LOGD_V_PARS}
uniform float uPx;      // half the drawing buffer height, in pixels, over tan(fov/2)
uniform float uSize;    // world radius of a star
uniform float uNear;
uniform float uSpan;
varying vec3 vCol;
varying float vFade;
varying float vDepth;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(-mv.z, 1e-4);
  float px = uSize * uPx / d;
  float pxc = max(px, 3.0);
  gl_PointSize = pxc;
  vFade = min(1.0, (px * px) / (pxc * pxc));
  vDepth = clamp((d - uNear) / uSpan, 0.0, 1.0);
  vCol = color;
  gl_Position = projectionMatrix * mv;
  ${LOGD_V}
}
`;

const FIELD_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uMap;
uniform float uPower;
uniform float uGain;
varying vec3 vCol;
varying float vFade;
varying float vDepth;
void main(){
  // no LOGD_F: interior-only, and writing gl_FragDepth would cost early-Z
  float t = texture2D(uMap, gl_PointCoord).a;
  vec3 c = mix(vCol, vCol * vec3(0.30, 0.52, 0.92), vDepth);
  float lum = mix(1.0, 0.17, vDepth);
  float a = t * vFade * uPower;
  gl_FragColor = vec4(c * lum * uGain, a);
}
`;

/** A label rendered to its own canvas, returned as a billboard plane. */
function labelPlane(text, sub, colour) {
  const W = 256, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.font = '600 21px ui-monospace, "SF Mono", Menlo, monospace';
  x.fillStyle = colour;
  x.textBaseline = 'middle';
  x.fillText(text, 12, 21);
  x.font = '14px ui-monospace, "SF Mono", Menlo, monospace';
  x.fillStyle = 'rgba(150,190,210,0.8)';
  x.fillText(sub, 12, 44);
  // tick joining the label back toward its star
  x.strokeStyle = colour; x.globalAlpha = 0.55; x.lineWidth = 2;
  x.beginPath(); x.moveTo(3, 14); x.lineTo(3, 50); x.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(0.118, 0.0295),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 0,
    }));
}

export class HoloMap {
  constructor(interior, game) {
    this.game = game;
    this.interior = interior;
    this.open = false;
    this.sel = 0;
    this._k = 0;
    this._t = 0;

    const g = new THREE.Group();
    g.position.copy(TABLE);
    g.scale.setScalar(0.001);
    g.visible = false;
    this.root = g;
    interior.root.add(g);

    this.spin = new THREE.Group();          // everything that drifts together
    g.add(this.spin);

    this.matDim = holoMat(0x8fd8ff, 0.55, G_GRID);
    this.matLane = holoMat(0x7fc8f0, 0.55, G_STRUCT);
    this.matBody = holoMat(0x5f9fd8, 0.90, G_BODY);
    this.matWarm = holoMat(0xffb070, 0.55, G_WARM);
    this.mats = [this.matDim, this.matLane, this.matBody, this.matWarm];

    this._buildGrid();
    this._buildBody();
    this._buildDust();
    this._buildField();
    this._buildLanes();
    this._buildSystems();
    this._buildReticle();

    this.info = new HoloScreen({
      name: 'navinfo', w: 0.42, h: 0.27, res: 520, ss: 4, curve: 0.04,
    });
    this.info.mesh.position.set(0.50, 0.24, -0.22);
    this.info.material.uniforms.uPower.value = 1;
    g.add(this.info.mesh);

    g.traverse((o) => o.layers.set(INTERIOR_LAYER));
    this._v = new THREE.Vector3();
  }

  /* ------------------------------------------------------------- geometry */

  _buildGrid() {
    const base = new THREE.Group();
    base.position.y = -LIFT - 0.05;
    this.spin.add(base);
    this.base = base;

    /* Everything here was authored between 0.8 and 2.2 mm. At the metre this
       chart is read from that is one to three pixels *at best*, and a one-pixel
       line under an additive blend that is already an order of magnitude too
       dark is the whole "thin white wisps" complaint. Radii are 3 to 6 mm now
       — three to seven pixels — and the hierarchy is carried by value and
       colour rather than by a width difference the display cannot resolve. */
    for (let i = 1; i <= 9; i++) {
      const f = i / 9;
      const major = i % 3 === 0;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(DISC * f, major ? 0.0042 : 0.0026, 6, 132),
        major ? this.matLane : this.matDim);
      ring.rotation.x = Math.PI / 2;
      base.add(ring);
    }
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const long = i % 8 === 0;
      const len = long ? DISC : DISC * 0.14;
      const off = long ? DISC / 2 : DISC - len / 2;
      const sp = new THREE.Mesh(
        new THREE.BoxGeometry(long ? 0.0034 : 0.0044, 0.0030, len),
        long ? this.matLane : this.matDim);
      sp.position.set(Math.sin(a) * off, 0, Math.cos(a) * off);
      sp.rotation.y = a;
      base.add(sp);
    }
    const hub = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.0050, 8, 44), this.matWarm);
    hub.rotation.x = Math.PI / 2;
    base.add(hub);

    /* A base plate. The chart had no floor: nine wire rings in mid-air read as
       rings in mid-air, and the volume had nothing to stand on and no bottom
       edge to be bounded by. A soft disc of light under it is what makes the
       thing above it read as *projected*. */
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(DISC * 2.15, DISC * 2.15),
      new THREE.MeshBasicMaterial({
        map: glowTexture(), color: 0x2f7bb0, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.004;
    base.add(plate);
    this.plate = plate;

    // sweep arm — reads instantly as "this is scanning"
    const sweepMat = holoMat(0x8fe4ff, 0.9, G_SWEEP);
    this.mats.push(sweepMat);
    const sweep = new THREE.Mesh(new THREE.CircleGeometry(DISC, 40, 0, 0.42), sweepMat);
    sweep.rotation.x = -Math.PI / 2;
    sweep.position.y = 0.001;
    base.add(sweep);
    this.sweep = sweep;
  }

  /** The volume's own body: a containment wall and the cone that fills it.
   *
   *  Without these the chart is a scatter with no edges, which is why it read
   *  as wisps over the room rather than as an object standing on the table.
   *  The wall gives it a silhouette from any angle, the cone ties it back to
   *  the emitters in the table's well, and both are dim enough that the chart
   *  still reads through them. */
  _buildBody() {
    const H = LIFT * 2 + 0.10;
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(DISC * 1.015, DISC * 1.015, H, 72, 1, true),
      this.matBody);
    wall.position.y = 0.0;          // the volume runs -(LIFT+0.05) .. +(LIFT+0.05)
    this.spin.add(wall);
    this.wall = wall;

    for (const y of [-LIFT - 0.05, LIFT + 0.05]) {
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(DISC * 1.015, 0.0038, 6, 132), this.matLane);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = y;
      this.spin.add(rim);
    }
    // four uprights, so the containment has corners to read the turn against
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0040, 0.0040, H, 6), this.matLane);
      post.position.set(Math.sin(a) * DISC * 1.015, 0, Math.cos(a) * DISC * 1.015);
      this.spin.add(post);
    }
    /* The projector cone, from the ring of optics the table already carries in
       its well up to the base plate. `root` local -0.490 lands on the well
       floor at the deployed scale, which is where the emitters are. It is not
       parented to `spin`: the beam does not turn with the chart. */
    const y0 = -0.490, y1 = -LIFT - 0.05;
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(DISC * 1.01, 0.11, y1 - y0, 44, 1, true),
      this.matBody);
    cone.position.y = (y0 + y1) * 0.5;
    this.root.add(cone);
    this.cone = cone;
  }

  _buildDust() {
    this.dust = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(DISC * 1.95, DISC * 1.95),
        new THREE.MeshBasicMaterial({
          map: dustTexture(), transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
          color: i === 1 ? 0x7fa8d0 : 0x4a6f96, opacity: 0,
        }));
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = i * 2.1;
      m.position.y = (i - 1) * LIFT * 0.55;
      this.spin.add(m);
      this.dust.push(m);
    }
  }

  /** Background stars: the substance the playable systems sit inside. */
  _buildField() {
    const N = 900;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const c = new THREE.Color();
    let seed = 20260725;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 0.55) * DISC * 1.02;
      const thin = 1 - (r / DISC) * 0.75;          // lens: thinner at the rim
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = (rnd() - 0.5) * 2 * LIFT * thin;
      pos[i * 3 + 2] = Math.sin(a) * r;
      c.setHSL(rnd() < 0.72 ? 0.56 : 0.085, 0.42, 0.62 + rnd() * 0.30);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.fieldMat = new THREE.ShaderMaterial({
      vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexColors: true,
      uniforms: {
        uMap: { value: glowTexture() },
        uPx: { value: 900 }, uSize: { value: 0.0062 },
        uNear: { value: 0.55 }, uSpan: { value: 1.35 },
        uPower: { value: 0 }, uGain: { value: 26 },
      },
    });
    this.field = new THREE.Points(geo, this.fieldMat);
    this.field.frustumCulled = false;
    this.spin.add(this.field);
  }

  /** Lanes, as thin prisms rather than as `LineSegments`.
   *
   *  A GL line is one pixel wide at every distance on every platform, and one
   *  pixel of a 0.30-opacity additive blue is nothing at all — which is what
   *  the network between the systems has been. These are 3 mm triangular
   *  sections, welded into a single geometry so the whole network is one draw
   *  call, and they carry the same scan treatment as the rest of the volume. */
  _buildLanes() {
    const gal = this.game.galaxy;
    const seg = [];
    for (let i = 0; i < gal.length; i++) {
      const near = gal
        .map((s, j) => ({ j, d: Math.hypot(s.x - gal[i].x, s.y - gal[i].y) }))
        .filter((x) => x.j !== i).sort((a, b) => a.d - b.d).slice(0, 2);
      for (const { j } of near) {
        if (j < i) continue;
        seg.push([this._posOf(gal[i]), this._posOf(gal[j])]);
      }
    }
    const R = 0.0030, pos = [], idx = [];
    const dir = new THREE.Vector3(), sx = new THREE.Vector3(), sy = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), alt = new THREE.Vector3(1, 0, 0);
    for (const [a, b] of seg) {
      dir.subVectors(b, a).normalize();
      sx.crossVectors(Math.abs(dir.y) > 0.9 ? alt : up, dir).normalize();
      sy.crossVectors(dir, sx).normalize();
      const base = pos.length / 3;
      for (const p of [a, b]) {
        for (let k = 0; k < 3; k++) {
          const t = (k / 3) * Math.PI * 2;
          pos.push(p.x + (sx.x * Math.cos(t) + sy.x * Math.sin(t)) * R,
            p.y + (sx.y * Math.cos(t) + sy.y * Math.sin(t)) * R,
            p.z + (sx.z * Math.cos(t) + sy.z * Math.sin(t)) * R);
        }
      }
      for (let k = 0; k < 3; k++) {
        const n = (k + 1) % 3;
        idx.push(base + k, base + n, base + 3 + k, base + n, base + 3 + n, base + 3 + k);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.lanes = new THREE.Mesh(g, this.matLane);
    this.spin.add(this.lanes);
  }

  _buildSystems() {
    this.nodes = [];
    const coreGeo = new THREE.IcosahedronGeometry(0.0125, 2);
    const glowGeo = new THREE.PlaneGeometry(0.19, 0.19);
    for (const sys of this.game.galaxy) {
      const n = new THREE.Group();
      n.position.copy(this._posOf(sys));
      this.spin.add(n);

      const kc = kelvinColor((sys.starClass.temp[0] + sys.starClass.temp[1]) / 2);
      const tint = new THREE.Color(kc.r, kc.g, kc.b);
      const m = holoMat(0x000000, 0.35);
      m.uniforms.uColor.value.copy(tint);
      this.mats.push(m);

      const core = new THREE.Mesh(coreGeo, m);
      core.scale.setScalar(0.8 + sys.starClass.lum * 0.6);
      n.add(core);

      const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
        map: glowTexture(), color: tint, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      n.add(glow);

      /* Stalk and footprint: what turns a floating dot into a *position*, and
         the strongest depth cue in the whole volume, so both are sized to hold
         pixels. 0.7 mm and 0.7 mm were a quarter of a pixel each. */
      const h = n.position.y + LIFT + 0.05;
      const stalk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0026, 0.0026, h, 5), this.matLane);
      stalk.position.y = -h / 2;
      n.add(stalk);
      const foot = new THREE.Mesh(
        new THREE.TorusGeometry(0.016, 0.0028, 5, 28), this.matLane);
      foot.rotation.x = Math.PI / 2;
      foot.position.y = -h;
      n.add(foot);

      const label = labelPlane(
        sys.visited ? sys.name.toUpperCase() : sys.designation,
        sys.visited ? `${sys.starClass.cls}-CLASS` : 'UNCHARTED',
        sys.visited ? '#dff4ff' : 'rgba(160,200,220,0.8)');
      label.position.set(0.072, 0.021, 0);
      n.add(label);

      this.nodes.push({ sys, group: n, core, glow, mat: m, label });
    }
  }

  _buildReticle() {
    const g = new THREE.Group();
    this.spin.add(g);
    this.reticle = g;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.0042, 0.058, 0.0042), this.matWarm);
      bar.position.set(Math.sin(a) * 0.034, 0, Math.cos(a) * 0.034);
      g.add(bar);
    }
    for (const r of [0.034, 0.044]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0032, 6, 48), this.matWarm);
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
    }
    /* Baked into the geometry, not set on the mesh: `update` aims this with
       lookAt(), which rewrites the mesh's rotation every frame. */
    const routeGeo = new THREE.CylinderGeometry(0.0038, 0.0038, 1, 5);
    routeGeo.rotateX(Math.PI / 2);
    this.route = new THREE.Mesh(routeGeo, this.matWarm);
    this.spin.add(this.route);
  }

  /* ---------------------------------------------------------------- state */

  _posOf(sys) {
    const h = Math.sin(sys.seed * 0.0001) * 0.5 + Math.sin(sys.seed * 0.00037) * 0.5;
    return new THREE.Vector3(sys.x * SCALE, h * LIFT * 0.85, sys.y * SCALE);
  }

  toggle() { this.open ? this.close() : this.show(); }

  show() {
    this.open = true;
    this.sel = this.game.currentSystemId;
    this.root.visible = true;
    this.game.audio?.ping('boot');
    this.info.boot(0.15);
  }

  close() { this.open = false; this.game.audio?.ping('ui'); }

  cameraPose(out) {
    // Nearly level with the volume, so it reads as something floating rather
    // than a pattern lying on the table top. Aimed at the middle of the volume
    // rather than at the table: sighting on the table top pushed the chart into
    // the upper third and gave the bottom half of the frame to the rim.
    // Far enough back that the whole containment fits the frame: at 0.98 m the
    // 1.25 m volume overflowed both edges, which is its own kind of illegible.
    out.pos.set(0.10, 1.46, 1.34);
    out.look.copy(TABLE).add(new THREE.Vector3(0.02, LIFT * 0.52, 0.02));
    return out;
  }

  _pickByGaze(cam) {
    let best = -1, bestDot = 0.988;
    const fwd = this._v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < this.nodes.length; i++) {
      tmp.copy(this.nodes[i].group.position).applyMatrix4(this.spin.matrixWorld).sub(cam.position);
      const d = tmp.normalize().dot(fwd);
      if (d > bestDot) { bestDot = d; best = i; }
    }
    return best;
  }

  update(dt, cam) {
    const target = this.open ? 1 : 0;
    this._k += (target - this._k) * Math.min(1, dt * 5);
    this._t += dt;

    if (this._k < 0.004 && !this.open) {
      this.root.visible = false;
      // restore the cabin exactly, or every close leaves it a shade darker
      if (this._lamps) for (const [l, base] of this._lamps) l.intensity = base;
      return;
    }
    this.root.visible = true;
    // Deployed slightly larger than the table it stands on — at 1:1 the volume
    // read as a pattern etched into the rim rather than as something projected
    // above it, and there was nothing to look at from a standing eye height.
    this.root.scale.setScalar(Math.max(0.001, this._k) * DEPLOY);
    this.spin.rotation.y = this._t * 0.045;
    this.root.updateMatrixWorld();

    const k = this._k;

    /* Take the cabin lights down while the chart is deployed. You would dim the
       room to read a hologram, and there is a rendering reason too: exposure is
       metered over the whole frame, so a lit corridor washes a dim additive
       volume out completely. Doing both at once is why it now reads. */
    if (!this._lamps) {
      this._lamps = [];
      this.interior.root.traverse((o) => {
        if (o.isLight) this._lamps.push([o, o.intensity]);
      });
    }
    /* 0.62, not 0.88. Taking the room down almost to nothing was compensating
       for a chart authored two orders of magnitude too dark: auto-exposure then
       opened up to find it, which brought the whole cabin back up with it as
       noise and left the chart still reading as a veil over the room. With the
       chart in a real HDR range the room only has to come down far enough to
       stop competing, and it stays legible as the place you are standing in. */
    for (const [l, base] of this._lamps) l.intensity = base * (1 - 0.45 * k);

    for (const m of this.mats) {
      m.uniforms.uTime.value = this._t;
      m.uniforms.uPower.value = k;
    }
    this.matBody.uniforms.uPower.value = 0.13 * k;
    this.sweep.rotation.z = -this._t * 0.55;
    this.sweep.material.uniforms.uPower.value = 0.22 * k;

    if (cam) {
      // pixels per world unit at one metre: the field's size floor is in pixels
      const hpx = this.game.renderer ? this.game.renderer.domElement.height : 900;
      this.fieldMat.uniforms.uPx.value = 0.5 * hpx * cam.projectionMatrix.elements[5];
      // the depth cue is measured from the camera to the near face of the volume
      const d = cam.position.distanceTo(this.root.position);
      this.fieldMat.uniforms.uNear.value = Math.max(0.1, d - DISC * DEPLOY * 0.95);
      this.fieldMat.uniforms.uSpan.value = DISC * DEPLOY * 1.9;
    }
    this.fieldMat.uniforms.uPower.value = k;
    this.plate.material.opacity = 0.70 * k;
    this.cone.visible = k > 0.02;
    this.dust.forEach((d, i) => {
      d.material.opacity = (i === 1 ? 0.22 : 0.13) * k;
      d.rotation.z += dt * (i === 1 ? -0.02 : 0.013);
    });

    if (this.open && cam) {
      const hit = this._pickByGaze(cam);
      if (hit >= 0 && hit !== this.sel) { this.sel = hit; this.game.audio?.ping('switch'); }
    }

    const node = this.nodes[this.sel];
    if (node) {
      this.reticle.position.copy(node.group.position);
      this.reticle.rotation.y = this._t * 0.8;
      this.reticle.scale.setScalar(1 + Math.sin(this._t * 3) * 0.05);
      const cur = this.nodes[this.game.currentSystemId];
      if (cur && cur !== node) {
        const a = cur.group.position, b = node.group.position;
        this.route.visible = true;
        this.route.position.copy(a).lerp(b, 0.5);
        this.route.scale.z = a.distanceTo(b);
        this.route.lookAt(this.spin.localToWorld(b.clone()));
      } else this.route.visible = false;
    }

    for (const n of this.nodes) {
      const isSel = this.nodes[this.sel] === n;
      const vis = n.sys.visited;
      if (cam) {
        n.glow.quaternion.copy(cam.quaternion);
        n.label.quaternion.copy(cam.quaternion);
      }
      n.mat.uniforms.uPower.value = (vis ? 5.0 : 2.2) * (isSel ? 1.8 : 1.0) * k;
      n.glow.material.opacity = (vis ? 1.0 : 0.52) * (isSel ? 1.7 : 1.0) * k;
      // labels stay quiet unless the system matters, so fourteen do not shout
      n.label.material.opacity = (isSel ? 1.0 : vis ? 0.50 : 0.20) * k;
    }

    if (cam) {
      this.info.mesh.quaternion.copy(cam.quaternion);
      if (this.info.update(dt, cam.position, k)) this._drawInfo();
    }
  }

  _drawInfo() {
    const g = this.game;
    const s = g.galaxy[this.sel];
    if (!s) return;
    const cur = g.galaxy[g.currentSystemId];
    const dist = Math.hypot(s.x - cur.x, s.y - cur.y);
    const cost = Math.min(1, dist / 80);
    const isCur = this.sel === g.currentSystemId;
    const canJump = !isCur && g.ship.foldCharge >= cost;

    this.info.draw((c) => {
      const w = c.w;
      c.text('STELLAR CARTOGRAPHY', 20, 28, { size: 12, color: DIM, track: 3 });
      c.line(20, 37, w - 20, 37, DIM, 1, 0.4);
      c.text(s.visited ? s.name.toUpperCase() : 'UNCHARTED', 20, 74,
        { size: 28, color: s.visited ? '#eafaff' : DIM, track: 0.6 });
      c.text(`${s.designation}  ·  ${s.starClass.cls}-CLASS`, 20, 98,
        { size: 13, color: AM, track: 1.6 });

      const row = (label, val, y, col = '#dff4ff') => {
        c.text(label, 20, y, { size: 13, color: DIM, track: 2 });
        c.text(val, w - 20, y, { size: 15, color: col, align: 'right' });
      };
      row('DISTANCE', `${dist.toFixed(1)} ly`, 140);
      row('FOLD COST', `${Math.round(cost * 100)}%`, 168,
        cost > g.ship.foldCharge ? '#ff8f7a' : '#dff4ff');
      row('CHARGE', `${Math.round(g.ship.foldCharge * 100)}%`, 196);
      if (g.resonatorSystems.has(this.sel) && s.visited) row('SIGNAL', 'RESONATOR', 224, AM);

      const y = c.h - 48;
      if (isCur) {
        c.fill(20, y, w - 40, 36, 'rgba(143,228,255,0.08)');
        c.text('CURRENT SYSTEM', w / 2, y + 24, { size: 15, color: DIM, align: 'center', track: 2 });
      } else {
        c.fill(20, y, w - 40, 36, canJump ? 'rgba(255,170,110,0.16)' : 'rgba(120,140,150,0.08)');
        c.fill(20, y, 3, 36, canJump ? AM : DIM);
        c.text(canJump ? 'PRESS  J  TO FOLD' : 'INSUFFICIENT CHARGE', w / 2, y + 24,
          { size: 15, color: canJump ? '#ffe0c0' : DIM, align: 'center', track: 2 });
      }
    });
  }

  confirm() {
    const g = this.game;
    if (this.sel === g.currentSystemId) return false;
    const s = g.galaxy[this.sel], cur = g.galaxy[g.currentSystemId];
    const cost = Math.min(1, Math.hypot(s.x - cur.x, s.y - cur.y) / 80);
    if (g.ship.foldCharge < cost) { g.audio?.ping('deny'); return false; }
    g.ship.foldCharge = Math.max(0, g.ship.foldCharge - cost);
    this.close();
    g.hyperjump(this.sel);
    return true;
  }
}
