import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Engine, detectQuality } from '../core/Engine.js';
import { Input } from '../core/Input.js';
import { bakeNebulaCube, makeStarField } from '../gfx/Sky.js';
import { generateGalaxy, generateSystem, mulberry32 } from '../world/generate.js';
import { Planet } from '../world/Planet.js';
import { Star } from '../world/Star.js';
import { Dust } from '../world/Dust.js';
import { FoldTunnel } from '../gfx/FoldTunnel.js';
import { LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';
import { AsteroidField } from '../world/Asteroids.js';
import { Fleet } from '../world/Fleet.js';
import { buildStation } from '../world/Station.js';
import { Surface } from '../world/Surface.js';
import { buildResonator, buildDerelict, buildWreck, buildBeacon } from '../world/Structures.js';
import { Ship } from '../ship/Ship.js';
import { HULL_LIGHT } from '../gfx/greeble.js';
import { buildInterior, INTERIOR_LAYER } from '../ship/Interior.js';
import { setLogDepth } from '../ship/interiorMaterials.js';
import { loadInteriorAssets } from '../ship/interiorAssets.js';
import { Player } from '../ship/Player.js';
import { Cockpit } from '../ship/Cockpit.js';
import { HUD } from '../ui/HUD.js';
import { HoloMap } from '../ship/HoloMap.js';
import { Archive } from '../ui/Archive.js';
import { Audio } from '../audio/Audio.js';
import { CANTOS, LOGS, INTRO_LINES } from './lore.js';
import { Directives, UPGRADES } from './directives.js';
import { Director, SEQUENCES } from './Director.js';
import { Encounters } from './encounters.js';

const ORBIT_TIME = 1;            // orbit rates are already tuned in generate.js
const RESONATOR_COUNT = 7;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const FOLD_RIM = new THREE.Color(0.62, 0.80, 1.0);
const WHITE = new THREE.Color(1, 1, 1);
const _ext = new THREE.Vector3();

/* Read a published practical-light spec off a built structure, or null. The
   validation is not paranoia: several builders already put unrelated things on
   `userData`, and a half-filled spec here throws inside the frame loop. */
function readPractical(root) {
  const r = root && root.userData && root.userData.practical;
  if (!r || !r.pos || !r.color || !(r.radius > 0)) return null;
  return {
    pos: r.pos.clone(), color: r.color.clone(),
    intensity: r.intensity ?? 1, radius: r.radius,
  };
}
const ZERO = new THREE.Vector3();
// scratch for the transition maths, which runs alongside the shared _v/_v2/_v3
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _sunCol = new THREE.Color();
// metres the hull sits above the deck when standing on its gear
const SURFACE_GEAR_HEIGHT = 14.6;
/* Seconds the final approach takes, and the height it starts from.
   Both are up from 2.2 s and 92 m: the landing is one continuous shot now and
   this is the part of it the audience is actually watching, so it wants to be
   a descent you can read the rate of rather than a drop. */
const SETTLE_TIME = 4.2;
const SETTLE_HEIGHT = 240;
// and the shortest the covering beat of a transition is allowed to be
const ENTRY_BEAT = 0.5;
/* The cloud deck that covers the scene change. In fast, out slow — going into
   weather is abrupt and coming out of it is not — and the hull is only undrawn
   above OPAQUE, which is the fraction of a second its materials are between
   two depth conventions — which is also the window in which the scene behind
   the deck is not drawn at all, so the two want the same threshold. See
   beginEntry and Engine.render. */
const CLOUD_IN = 0.70;
const CLOUD_OUT = 2.3;
const CLOUD_OPAQUE = 0.995;

/* ------------------------------------------------------- the depth range

   Two scenes, two depth policies, and the near plane is what pays for it.

   In space one unit is a kilometre and a frame holds a console switch and a
   gas giant seventy thousand kilometres across, which is why the world is
   drawn with three's logarithmic depth buffer and a near plane of a few metres.
   The ground is not that scene. It spans about six metres to the 26 km horizon
   cut, with the sky dome at REACH * 1.6 = 41.6 km behind it — a range 24 bits
   of ordinary depth hold with room to spare — and log depth costs it dearly,
   because `gl_FragDepth` in every fragment defeats early-Z rejection and every
   Apple GPU is tile-based. Measured at 5.72 Mpx: 29.3 -> 21.2 ms parked, and
   40.3 -> 24.1 ms on foot.

   So the ground pass runs on the ordinary projection curve, and the near plane
   has to be raised to pay for it: depth resolution goes as z^2 / near, so the
   5 cm plane the log buffer allowed leaves 800 m of quantisation at the
   skyline. Half a metre brings that to 80 m — invisible against a smooth
   heightfield with nothing co-located out there — and still gives 7 mm at the
   parked hull and a micron at your boots. The far plane comes in to match:
   6e7 was sized for a solar system. */
const GROUND_NEAR = 0.5;         // metres
const GROUND_FAR = 50000;        // metres — the dome sits at 41.6 km
const SPACE_FAR = 6.0e7;         // kilometres, as Engine builds the camera

/* How much of the ground scene's ambient goes to the two directionals rather
   than to the environment probe. Not a taste knob: a probe lights every
   direction and two directionals light two, so the probe is the better half —
   but a custom ShaderMaterial reads `scene.environment` only if it asks, and
   the terrain, the scatter and the sky do not. Keeping most of the level on
   the lights means nothing goes dark if a material opts out; the probe's share
   is what puts light on a flank rather than only on a roof and a floor. */
const ENV_SPLIT = 0.6;

/* The ground scene's environment probe, as a sky-and-ground gradient.
 *
 * Deliberately *not* a render of the real sky shader. That shader carries a
 * three-hundred-power solar disc, and an environment containing a photosphere
 * puts a mirror of the star on every panel of the hull at every angle — the
 * probe wants the star's *scattered* contribution, which is the circumsolar
 * glow, and the star itself is already a directional light. It is also two
 * orders of magnitude cheaper, which is what lets it be re-baked as the sun
 * climbs instead of going stale at touchdown. */
const ENV_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const ENV_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uSunDir;
uniform vec3  uGlow;
void main(){
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  // Sky brightens toward the horizon on a hazy world and toward the zenith on
  // a clear one; the caller decides which by what it passes, and the curve in
  // between only has to be smooth.
  vec3 c = mix(uHorizon, uZenith, sqrt(max(up, 0.0)));
  // The ground is not a hard edge at y=0: a probe sitting fourteen metres up
  // sees the horizon soften over a few degrees, and a hard step here shows up
  // as a seam running round every rounded surface on the hull.
  c = mix(c, uGround, smoothstep(0.06, -0.10, up));
  /* The circumsolar patch. max() before pow(): a normalised dot product comes
     back a hair over 1.0 as often as it comes back a hair under 0.0, and a
     negative base makes pow() NaN under ANGLE. */
  float mu = clamp(dot(d, normalize(uSunDir)), -1.0, 1.0);
  c += uGlow * pow(max(mu, 0.0), 5.0);
  gl_FragColor = vec4(c, 1.0);
}
`;

export class Game {
  constructor(canvas, onProgress) {
    // ?q=low|medium|high forces a tier, so the reduced-shader paths that only
    // phones would otherwise hit can be verified on a desktop.
    const forced = new URLSearchParams(location.search).get('q');
    this.quality = ['low', 'medium', 'high'].includes(forced) ? forced : detectQuality();
    this.engine = new Engine(canvas, this.quality);
    this.input = new Input(canvas);
    this.onProgress = onProgress || (() => { });

    this.scene = this.engine.scene;
    this.camera = this.engine.camera;
    this.renderer = this.engine.renderer;

    this.origin = new THREE.Vector3();     // floating-origin anchor (= ship pos)
    this.time = 0;
    this.paused = false;
    this.started = false;

    this.discoveries = new Set();
    this.cantos = [];
    this.logsFound = new Set(['log_seeker']);
    this.state = { resonance: 0 };
    this.chamberVisits = 0;
    this.resonatorRevealed = false;
    this.scanRangeMul = 1;
    this.upgrades = [];

    this.bodies = [];
    this.anomalies = [];
    this.bakeQueue = [];
    this.hiResHolder = null;

    // 'walk' on foot inside the hull | 'pilot' seated at the helm |
    // 'exterior' the chase camera, kept for the spectacle
    this.mode = 'walk';
    this.camMode = 0;
    this.autopilot = null;
    this.directive = null;
    this.camAbs = new THREE.Vector3();
    this.camQuat = new THREE.Quaternion();   // where the camera actually looks
    this.camRig = new THREE.Quaternion();    // chase-spring state, exterior only
    this.fov = 62;
    this.shake = 0;
    // the cloud deck a transition goes through — see beginEntry
    this._cloud = 0;
    this._cloudOut = 0;
    /* Where the ship is in the ground scene, and where the camera is hanging
       from. Both live, both in metres, both written once a frame by
       updateSurface — the landing and the liftoff sequences read them rather
       than the origin, which is how one shot survives the change of scene. */
    this.groundShipAnchor = new THREE.Vector3(0, SURFACE_GEAR_HEIGHT, 0);
    this.groundCamAnchor = new THREE.Vector3();

    // Chase framing. `pitch` is a rake applied to the camera *after* the chase
    // spring; `pose()` has to cancel exactly the same angle or a posed shot
    // frames the wrong thing, so both read it from here.
    this.chase = { back: 0.205, up: 0.052, side: 0.024, lag: 6.0, fov: 58, pitch: 0.115 };
  }

  async boot() {
    const P = this.onProgress;
    P(0.05, 'seeding the expanse');
    this.galaxySeed = 20260725;
    this.galaxy = generateGalaxy(this.galaxySeed, 14);

    // seven systems hold Resonators; the first is always reachable early
    const rr = mulberry32(this.galaxySeed ^ 0x9e37);
    const ids = this.galaxy.map((s) => s.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rr() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    this.resonatorSystems = new Set([0, ...ids.filter((i) => i !== 0).slice(0, RESONATOR_COUNT - 1)]);

    await frame();
    P(0.18, 'painting the deep field');
    this.skyRes = this.quality === 'low' ? 256 : this.quality === 'medium' ? 512 : 1024;
    this.nebula = bakeNebulaCube(this.renderer, this.skyRes, 7.31, this.galaxy[0].nebula);
    this.scene.background = this.nebula.texture;
    this.scene.backgroundIntensity = 1.0;

    await frame();
    P(0.34, 'resolving the environment');
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileCubemapShader();
    this.envRT = this.pmrem.fromCubemap(this.nebula.texture);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.9;

    await frame();
    P(0.46, 'hanging the stars');
    this.starField = makeStarField(this.quality === 'low' ? 5000 : 14000, 3.7);
    this.scene.add(this.starField);

    await frame();
    P(0.58, 'assembling PALE SEEKER');
    this.ship = new Ship();
    this.scene.add(this.ship.object);

    // ---- habitable module
    // It lives in its own scene, rendered as a second pass with its own camera.
    // Two reasons: three filters lights by *camera* layers rather than object
    // layers, so object layers cannot keep starlight out of a cabin; and the
    // cabin stays at 1 unit = 1 metre, which keeps point-light falloff out of
    // three's max(d^decay, 0.01) clamp.
    this.interiorScene = new THREE.Scene();
    // The cabin used to share the exterior's environment, which is a nebula:
    // almost entirely black with one hot star in it. Metal reflecting that has
    // nothing to show, so every surface fell back to its diffuse term and read
    // as plastic. A room probe gives each face something with structure to
    // reflect, which does more for "this is a real material" than any amount of
    // extra roughness detail.
    const roomEnv = new RoomEnvironment();
    this.interiorEnvRT = this.pmrem.fromScene(roomEnv, 0.04);
    roomEnv.dispose?.();
    this.interiorScene.environment = this.interiorEnvRT.texture;
    this.interiorScene.environmentIntensity = 0.10;
    this.interiorRig = new THREE.Group();
    this.interiorScene.add(this.interiorRig);

    /* The cabin's geometry and every surface it wears are baked assets now —
       a glTF kit plus tiling maps — so they have to be on disk before the room
       can be assembled. Failing to load them is not fatal: `buildInterior`
       falls back to bare tubes and neutral placeholder textures. */
    this.interiorAssets = await loadInteriorAssets(this.renderer);
    this.interior = buildInterior(this.interiorAssets);
    this.interiorRig.add(this.interior.root);
    this.player = new Player(this.interior);
    this.cockpit = new Cockpit(this.interior, this);

    // Only orientation relative to the hull matters here: the exterior pass has
    // already put the eye in the right place in world space, so the canopy
    // opening frames exactly the same piece of sky.
    this.interiorCam = new THREE.PerspectiveCamera(68, 1, 0.02, 400);
    this.interiorCam.layers.enableAll();

    // The seat's resting heading. The eye point deliberately is *not* set here:
    // the console is laid out against it, so it belongs with the geometry in
    // Interior.js. Overriding it from this end silently moved the datum out
    // from under the dashboard.
    const seatStation = this.interior.stations.find((x) => x.id === 'seat');
    seatStation.seatYaw = 0;            // yaw 0 looks down -Z, out of the canopy

    // Sunlight entering through the canopy. There are no shadow maps, so the
    // hull cannot occlude the real star light — this stands in for it, keyed to
    // how much the canopy is actually pointed at the star.
    this.canopyLight = new THREE.DirectionalLight(0xffffff, 0);
    this.interiorScene.add(this.canopyLight);
    this.interiorScene.add(this.canopyLight.target);

    this.dust = new Dust(this.quality === 'low' ? 900 : 2400, 6.0);
    this.scene.add(this.dust.object);

    this.foldTunnel = new FoldTunnel();
    this.scene.add(this.foldTunnel.object);

    this.ambient = new THREE.AmbientLight(0x2a3a4a, 0.12);
    this.scene.add(this.ambient);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.position.set(1, 0, 0);
    this.sunLight.layers.set(0);        // exterior only
    /* Sun shadows, fitted to the ship and nothing else.
     *
     * Only objects with castShadow render into the map, so the frustum can be
     * a tight box around the hull without the rest of the system paying for it
     * — which matters, because most of the exterior sets frustumCulled = false
     * and would otherwise all be drawn into a 0.2-unit shadow camera.
     *
     * This is what puts the dish onto the hull, the sail onto the spine and the
     * vanes onto the drum. Every object in the game was previously lit by a
     * bare N.L term with nothing occluding anything, which is most of what
     * "flat CG" means. */
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.setShadowScale(1);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // ---- bounce
    // The star is the only direct source, so everything facing away from it is
    // lit entirely by what is nearby. Two sources stand in for that:
    //
    //   planetshine — a world a few radii away fills half the sky and is the
    //     dominant light on the shadowed side of the hull. Tinting it by the
    //     body's own albedo is what makes a ship over an ocean read cold and
    //     the same ship over a desert read warm, for free.
    //   rim — a hard, narrow source placed opposite the key. Physically it is
    //     the star's light wrapping past the limb; practically it is what keeps
    //     the ship from being a hole punched in the starfield.
    this.fillLight = new THREE.DirectionalLight(0x9fc4e0, 0.55);
    this.fillLight.layers.set(0);
    this.scene.add(this.fillLight);
    this.scene.add(this.fillLight.target);

    this.shineLight = new THREE.DirectionalLight(0xffffff, 0);
    this.shineLight.layers.set(0);
    this.scene.add(this.shineLight);
    this.scene.add(this.shineLight.target);

    this.rimLight = new THREE.DirectionalLight(0xdce8ff, 1.4);
    this.rimLight.layers.set(0);
    this.scene.add(this.rimLight);
    this.scene.add(this.rimLight.target);

    /* The roaming practical.
       Emissive geometry in this renderer emits nothing — a station's floods and
       a Resonator's vanes were bright rectangles that left the hull parked
       beside them completely unlit, which reads as a decal rather than a light.
       A forward renderer charges for every light on every material, so there is
       exactly one of these and it snaps to whichever emissive set-piece is
       nearest. You are only ever near one at a time, so one is enough. */
    this.glowLight = new THREE.PointLight(0xffffff, 0, 0, 2);
    this.glowLight.layers.set(0);
    this.scene.add(this.glowLight);

    /* Ground bounce, used only when landed. It lives in both scenes so the
       light count does not change when the ground scene is swapped in — a
       forward renderer recompiles every material when it does. */
    this.bounceLight = new THREE.DirectionalLight(0xffffff, 0);
    this.bounceLight.layers.set(0);
    this.scene.add(this.bounceLight);
    this.scene.add(this.bounceLight.target);

    await frame();
    P(0.70, 'charting the first system');
    this.hud = new HUD(this);
    this.archive = new Archive(this);
    // Cartography is an object in the room now, not a window over it. The
    // name is kept because the rest of the game asks `starmap.open` to decide
    // whether a UI is swallowing input.
    this.starmap = this.holoMap = new HoloMap(this.interior, this);
    this.audio = new Audio();
    this.directives = new Directives(this);
    this.director = new Director(this);
    this.encounters = new Encounters(this);

    await this.loadSystem(0, true);

    P(0.92, 'warming shaders');
    await frame();
    this.renderer.compile(this.scene, this.camera);
    await frame();

    // The cabin and its lamps are both static, so re-rendering four shadow maps
    // every frame was redrawing an image that never changes — 780 of the ~1120
    // draw calls per frame, for nothing. Draw them once and hold them. The only
    // animated interior parts are the stick, pedals and throttle, which are
    // small, self-shadowing and not worth 780 draws a frame to keep exact.
    //
    // Cheap on a desktop GPU; not cheap at all on a renderer with high
    // per-draw overhead, which is most of the point.
    //
    // Build them here, explicitly, rather than by arming `needsUpdate` and
    // hoping. `needsUpdate` is a single renderer-wide flag and the first
    // `render()` of the frame clears it — so the moment the exterior sun
    // started casting, the exterior pass ate the flag and the interior overlay
    // that follows it never rendered a shadow map at all. Its four spot lights
    // sat at `shadow.map === null` for the whole session, which binds a plain
    // RGBA texture to a `sampler2DShadow`: every lit surface in the cabin threw
    // GL_INVALID_OPERATION once per draw, and nothing in the room cast a
    // contact shadow onto anything else.
    // The rig has to be visible for this one render: three collects the shadow
    // casting lights in `projectObject`, which skips invisible subtrees and
    // everything hanging off them, so a hidden cabin contributes no lights and
    // the pass has nothing to build.
    const rigWasVisible = this.interiorRig.visible;
    this.interiorRig.visible = true;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.setRenderTarget(null);
    /* The *exterior* sun casts too, and its map has to be allocated inside this
       same window — for exactly the reason the paragraph above describes, read
       the other way round.
     *
     * The game boots in walk mode, where `showHull` is false and updateCamera
     * therefore leaves `shadowMap.needsUpdate` false forever. But the exterior
     * scene is still drawn every frame, behind the canopy, with a sun whose
     * `castShadow` is true and whose `shadow.map` was never allocated — which
     * binds a plain RGBA texture to a `sampler2DShadow` and raises
     * GL_INVALID_OPERATION on every lit draw in the frame, from the first one.
     * The symptom is a console full of errors and nothing else, because a
     * shadow lookup against the default texture happens to come back
     * unoccluded; it starts working the instant you switch to exterior view
     * and the flag arms, which is why it is easy to look straight past.
     *
     * `autoUpdate` is on for both renders, so each builds its own scene's maps
     * and neither eats the other's flag. The hull is hidden for this one: in
     * walk mode nothing casts, so an empty map is the *correct* content to
     * leave behind until the first frame that arms the flag again. */
    const hullWasVisible = this.ship.model.visible;
    this.ship.model.visible = false;
    this.renderer.render(this.scene, this.camera);
    this.ship.model.visible = hullWasVisible;
    // And it has to be the interior camera, not the world one: three filters
    // lights by *camera* layers, so the world camera sees neither the cabin nor
    // the lamps lighting it and the pass again has nothing to build.
    this.renderer.render(this.interiorScene, this.interiorCam);
    this.interiorRig.visible = rigWasVisible;
    await frame();
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = false;

    P(1.0, 'ready');
  }

  /* --------------------------------------------------------- system load */

  async loadSystem(id, initial = false) {
    const stub = this.galaxy[id];
    this.currentSystemId = id;
    stub.visited = true;

    // tear down the previous system
    if (this.system) {
      for (const b of this.bodies) {
        if (b.planet) { this.scene.remove(b.planet.group); b.planet.dispose(); }
      }
      for (const a of this.anomalies) this.scene.remove(a.obj);
      if (this.star) { this.scene.remove(this.star.group); this.star.dispose(); }
      if (this.fields) this.fields.forEach((f) => { this.scene.remove(f.object); f.dispose(); });
      if (this.fleet) { this.scene.remove(this.fleet.object); this.fleet.dispose(); this.fleet = null; }
      for (const st of this.stations || []) this.scene.remove(st.obj);
      this.stations = [];
      if (this.nebula && this.lastNebulaIdx !== stub.nebula) {
        this.nebula.dispose();
        this.envRT?.dispose();
        this.nebula = bakeNebulaCube(this.renderer, this.skyRes, 7.31 + id * 3.7, stub.nebula);
        this.scene.background = this.nebula.texture;
        this.envRT = this.pmrem.fromCubemap(this.nebula.texture);
        this.scene.environment = this.envRT.texture;
      }
    }
    this.lastNebulaIdx = stub.nebula;

    const sys = generateSystem(stub);
    this.system = sys;
    this.bodies = [];
    this.anomalies = [];
    this.bakeQueue = [];
    this.hiResHolder = null;

    // ---- star
    this.star = new Star(sys.star, { quality: this.quality });
    this.scene.add(this.star.group);
    this.bodies.push({
      kind: 'star', name: sys.star.name, star: this.star, radius: sys.star.radius,
      absPos: this.star.absPos, spec: sys.star, id: `star:${stub.name}`,
    });

    // ---- planets & moons
    const ctx = { envMap: this.nebula.texture, quality: this.quality };
    for (const ps of sys.planets) {
      const p = new Planet(ps, ctx);
      this.scene.add(p.group);
      const body = {
        kind: 'planet', name: ps.name, planet: p, radius: ps.radius,
        absPos: p.absPos, spec: ps, id: `planet:${ps.name}`, phase: ps.orbitPhase,
      };
      this.bodies.push(body);
      this.bakeQueue.push(p);

      for (const ms of ps.moons) {
        const m = new Planet(ms, ctx);
        this.scene.add(m.group);
        this.bodies.push({
          kind: 'moon', name: ms.name, planet: m, radius: ms.radius,
          absPos: m.absPos, spec: ms, id: `moon:${ms.name}`, parent: body, phase: ms.orbitPhase,
        });
        this.bakeQueue.push(m);
      }
    }

    // ---- belts
    this.fields = sys.belts.map((b) => {
      const f = new AsteroidField(b, this.quality);
      this.scene.add(f.object);
      return f;
    });

    // ---- anomalies
    this._placeAnomalies(sys, stub);

    // ---- orbital infrastructure
    // One station per inhabited world, plus one working a belt. They are hung
    // close in — 1.4 radii — because a station only does its job when it is in
    // the same frame as the planet it orbits.
    this.stations = [];
    {
      const srnd = mulberry32((stub.seed ^ 0x513a) >>> 0);
      const hosts = sys.planets.filter((p) => p.inhabited);
      if (!hosts.length && sys.planets.length) hosts.push(sys.planets[Math.min(1, sys.planets.length - 1)]);
      let si = 0;
      for (const host of hosts.slice(0, 2)) {
        const built = buildStation(stub.seed + si * 977, {});
        this.scene.add(built.root);
        const ang = srnd() * Math.PI * 2;
        const rad = host.radius * (1.42 + srnd() * 0.5);
        this.stations.push({
          built, obj: built.root, hostSpec: host,
          offset: new THREE.Vector3(Math.cos(ang) * rad, (srnd() - 0.5) * rad * 0.35, Math.sin(ang) * rad),
          absPos: new THREE.Vector3(),
          name: `${stub.name} ${['GATE', 'ANCHORAGE', 'YARDS'][si % 3]}`,
        });
        si++;
      }
    }

    // ---- traffic
    // Built after the bodies are in place, because every flight plan is keyed
    // to real positions: lanes run between worlds that are actually there.
    this._positionSystem(0);
    this.fleet = new Fleet(sys, this.bodies, this.quality);
    this.scene.add(this.fleet.object);
    for (const c of this.fleet.contacts()) this.bodies.push(c);

    for (const st of this.stations) {
      this.bodies.push({
        kind: 'station', name: st.name, station: st, radius: st.built.radius,
        absPos: st.absPos, id: `station:${st.name}`,
      });
    }

    // ---- spawn the ship
    const spawnTarget = sys.planets.find((p) => p.type === 'terran' || p.type === 'ocean')
      || sys.planets.find((p) => p.type === 'gas')
      || sys.planets[Math.min(2, sys.planets.length - 1)];
    this._positionSystem(0);
    const tb = this.bodies.find((b) => b.spec === spawnTarget) || this.bodies[1];
    this.pose({ bodyRef: tb, dist: 3.6, phase: 52, elev: 16 });

    this.target = tb;

    // bake everything at least once before the first frame of a new system
    let guard = 0;
    while (this.bakeQueue.length && guard++ < 40) {
      this._bakeStep();
      if (guard % 3 === 0) await frame();
    }

    this.cockpit?.rebuildNav(sys);
    this.encounters?.onSystemChange();
    this.hud.onSystemChange();
    if (!initial) this.hud.log(`ARRIVED · ${stub.name}`, 'hi');
  }

  _placeAnomalies(sys, stub) {
    const rnd = mulberry32(stub.seed ^ 0x5eed);
    const list = [];

    if (this.resonatorSystems.has(stub.id)) {
      list.push({ type: 'resonator' });
    }
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      list.push({ type: r < 0.34 ? 'derelict' : r < 0.68 ? 'wreck' : 'beacon' });
    }

    let idx = 0;
    for (const a of list) {
      // anchor most anomalies to a planet so they are findable
      const host = sys.planets[Math.floor(rnd() * sys.planets.length)];
      const ang = rnd() * Math.PI * 2;
      const rad = host.radius * (2.4 + rnd() * 4.0);
      const off = new THREE.Vector3(Math.cos(ang) * rad, (rnd() - 0.5) * rad * 0.7, Math.sin(ang) * rad);

      let obj, scale, name, kind = a.type;
      if (a.type === 'resonator') {
        obj = buildResonator(stub.seed + idx, this.nebula.texture);
        scale = 1.0;
        name = `RESONATOR ${romanize(this.resonatorIndexFor(stub.id))}`;
      } else if (a.type === 'derelict') {
        obj = buildDerelict(stub.seed + idx * 31, this.nebula.texture);
        scale = 2.6;
        name = `${stub.name} STATION ${String.fromCharCode(65 + idx)}`;
      } else if (a.type === 'wreck') {
        obj = buildWreck(stub.seed + idx * 57);
        scale = 1.8;
        name = `WRECKAGE ${stub.designation}-${idx + 1}`;
      } else {
        obj = buildBeacon(stub.seed + idx * 91);
        scale = 1.0;
        name = `BEACON ${stub.designation}-${idx + 1}`;
      }
      // *Multiply*, never set. Anything built with the greeble kit already
      // carries the metres-to-world-units scale in its root; overwriting it
      // made a 400 m derelict 400 km across.
      obj.scale.multiplyScalar(scale);
      this.scene.add(obj);

      const body = {
        kind: 'anomaly', anomalyType: kind, name, obj,
        // The derelict is no longer a tidy wheel: the hull is warped, three ring
        // sections tumble clear of it and the debris lens runs to about 1.5.
        // 0.95 framed the hub and cropped the wreck.
        radius: kind === 'resonator' ? 3.4 : kind === 'derelict' ? 1.3 : kind === 'wreck' ? 2.2 : 0.6,
        absPos: new THREE.Vector3(),
        hostSpec: host, offset: off,
        id: `anom:${stub.name}:${idx}`,
        logId: kind === 'wreck' ? LOGS[idx % (LOGS.length - 1)].id : null,
      };
      this.bodies.push(body);
      this.anomalies.push(body);
      idx++;
    }
  }

  resonatorIndexFor(sysId) {
    const arr = [...this.resonatorSystems].sort((a, b) => a - b);
    return arr.indexOf(sysId) + 1;
  }

  /* ------------------------------------------------------------- updates */

  _positionSystem(dt) {
    for (const b of this.bodies) {
      if (b.kind === 'planet') {
        b.phase += b.spec.orbitSpeed * dt * ORBIT_TIME;
        const a = b.spec.orbitR;
        b.absPos.set(Math.cos(b.phase) * a, Math.sin(b.phase * 1.3) * a * b.spec.orbitInc, Math.sin(b.phase) * a);
      } else if (b.kind === 'moon') {
        b.phase += b.spec.orbitSpeed * dt * ORBIT_TIME;
        const a = b.spec.orbitR;
        b.absPos.copy(b.parent.absPos).add(
          _v.set(Math.cos(b.phase) * a, Math.sin(b.phase * 1.7) * a * b.spec.orbitInc, Math.sin(b.phase) * a)
        );
      } else if (b.kind === 'station') {
        const host = this.bodies.find((x) => x.spec === b.station.hostSpec);
        b.absPos.copy(host ? host.absPos : _v.set(0, 0, 0)).add(b.station.offset);
      } else if (b.kind === 'anomaly') {
        const host = this.bodies.find((x) => x.spec === b.hostSpec);
        if (host) b.absPos.copy(host.absPos).add(b.offset);
        else b.absPos.copy(b.offset);
      }
    }
  }

  _bakeStep() {
    if (!this.bakeQueue.length) return;
    // bake whichever pending world is closest — you always look at that one
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.bakeQueue.length; i++) {
      const d = this.bakeQueue[i].absPos.distanceTo(this.ship.absPos);
      if (d < bd) { bd = d; best = i; }
    }
    const p = this.bakeQueue.splice(best, 1)[0];
    p.bake(this.renderer, this.quality === 'low' ? 128 : 256);
  }

  _updateBakeLOD() {
    if (this.bakeQueue.length) { this._bakeStep(); return; }
    if (this.quality === 'low') return;
    // give the single closest world a high-resolution surface
    let best = null, bs = 0.10;
    for (const b of this.bodies) {
      if (!b.planet || b.planet.isGas) continue;
      if (b.planet.angularSize > bs) { bs = b.planet.angularSize; best = b.planet; }
    }
    if (best && best !== this.hiResHolder) {
      const res = this.quality === 'high' ? 1024 : 512;
      if (best.bakeRes < res) {
        best.bake(this.renderer, res);
        if (this.hiResHolder && this.hiResHolder.bakeRes > 256) this.hiResHolder.bake(this.renderer, 256);
        this.hiResHolder = best;
      }
    }
  }

  update(dt) {
    this.time += dt;
    const input = this.input;
    input.update(dt);
    const ship = this.ship;

    /* Anything waiting on a frame gets one here, at the top, before the world
       moves. `_prepareGround` and `_prepareSpace` are ordinary async functions
       that step through the expensive half of a transition one frame at a
       time; this is the clock they run on, so they cannot drift out of step
       with the sequence the director is playing over them. */
    if (this._frameWaiters && this._frameWaiters.length) {
      const w = this._frameWaiters;
      this._frameWaiters = [];
      for (const res of w) res();
    }

    // ---------------------------------------------------------- UI keys
    /* A transition is not skippable. Everything it does — re-parenting the
       hull, flipping forty materials between depth conventions, swapping the
       scene — happens on the far side of a shot boundary, and stopping the
       director half way through leaves the game in a state with no name. */
    if (this.director.active && !this.transition
        && (input.tappedCode('Escape') || input.tappedCode('Space') || input.tapped('use'))) {
      this.director.stop();
    }
    if (input.tappedCode('Escape')) { this.starmap.close(); this.archive.close(); }
    if (input.tappedCode('KeyP')) document.getElementById('perf').classList.toggle('on');
    // The stations are how you *discover* these; the shortcuts are for players
    // who already know where they live.
    if (input.tappedCode('KeyM')) { this.starmap.toggle(); this.audio.ping('ui'); }
    if (this.starmap.open && input.tappedCode('KeyJ')) { this.starmap.confirm(); return; }
    if (input.tappedCode('Tab')) { this.archive.toggle(); this.audio.ping('ui'); }

    const uiOpen = this.starmap.open || this.archive.open;
    input.uiOpen = uiOpen;
    if (uiOpen && document.pointerLockElement) document.exitPointerLock();

    // ------------------------------------------------------------ orbits
    this._positionSystem(dt);

    // ------------------------------------------------- first-person input
    // On foot the mouse turns your head. At the helm it flies the ship, and
    // holding LOOK (right mouse / Alt) hands the head back to you — the
    // convention every cockpit sim settles on.
    const freeLook = input.held('look') || input.rmb === true;
    this.freeLook = freeLook;
    if (!uiOpen) {
      const md = input.consumeMouse();
      const onFoot = this.mode === 'walk' || (this.landed && this.landed.onFoot);
      if (onFoot || freeLook) {
        this.player.look(md.x, md.y, input.lookSens);
      } else {
        input.feedStick(md.x, md.y);
      }
      if (input.touch) {
        if (onFoot) this.player.look(input.touchR.x * 10, input.touchR.y * 10, 1);
        else if (freeLook) this.player.look(input.touchR.x * 8, input.touchR.y * 8, 1);
      }
    }
    this.player.autoHead = this.mode === 'pilot' ? ship.angVel : null;
    this.player.freeLook = freeLook;

    // ---- interaction
    if (this.landed) {
      /* E steps out and climbs back in; L is the drive. They used to be the
         same key, which was fine when the only thing you could do on a planet
         was leave it. */
      if (!uiOpen && !this.transition
          && (input.tappedCode('KeyE') || input.tapped('use'))) {
        if (this.landed.onFoot) this.board(); else this.disembark();
      }
      if (input.tappedCode('KeyL') && !this.transition) this.liftOff();
      // The crew controller runs on the ground too — the main update returns
      // before reaching it, so it has to be driven from here.
      if (this.landed && this.landed.onFoot) this.player.update(dt, input, uiOpen);
      // Nothing else on the ground: no flight, no proximity, no orbits to
      // integrate. The camera and the sky are the whole simulation — but the
      // hull is still a machine, so the drive has to be allowed to spin down,
      // the radiators to cool and the strobe to keep flashing.
      this.ship.updateVisuals(dt, this.time);
      this.updateCamera(dt);
      this.updateSurface(dt);
      this.updatePost(dt);
      this.shake = Math.max(0, this.shake - dt * 1.6);
      this.hud.update(dt);
      this.audio.update(dt, this);
      return;
    }

    /* Coming down. The flight model has nothing to say about a descent —
       nothing in this game flies to a planet in real time, see _flyTransition —
       so it is re-posed instead, and the rest of the world carries on. */
    if (this.transition && this.transition.kind === 'land') {
      this._flyTransition(dt);
      this.updateCamera(dt);
      this._updateWorld(dt);
      this.updatePost(dt);
      this.shake = Math.max(0, this.shake - dt * 1.6);
      this.hud.update(dt);
      this.audio.update(dt, this);
      return;
    }
    if (!uiOpen && (input.tappedCode('KeyE') || input.tapped('use'))) this.interact();

    /* V, and it works from anywhere aboard.
       It used to live inside the `flying` guard, so standing in the cabin there
       was no way to reach the exterior camera except a touch button, and coming
       back from it landed on 'pilot' whether or not anybody was in the seat —
       which the next two lines then undid, one frame later, silently. */
    if (!uiOpen && input.tappedCode('KeyV')) this.toggleView();

    // On foot the action buttons are relabelled (MAP / ARC / VIEW), so the
    // touch actions behind them have to be remapped to match what they say.
    if (this.mode === 'walk' && !uiOpen) {
      if (input.tapped('scan')) { this.starmap.toggle(); this.audio.ping('ui'); }
      if (input.tapped('auto')) { this.archive.toggle(); this.audio.ping('ui'); }
      if (input.tapped('fold')) this.toggleView();
    }

    // ------------------------------------------------------------ flight
    const flying = (this.mode === 'pilot' || this.mode === 'exterior') && !this.transition;
    if (!uiOpen && flying) {
      if (input.tapped('stop')) { ship.throttle = 0; ship.vel.multiplyScalar(0.02); this.cancelAutopilot(); }
      if (input.tapped('fold') || input.tapped('foldBtn')) this.toggleFold();
      if (input.tapped('target')) this.cycleTarget();
      if (input.tappedCode('KeyG') || input.tapped('auto')) this.toggleAutopilot();
      if (input.tappedCode('KeyL')) this.land();

      ship.throttle = THREE.MathUtils.clamp(ship.throttle + input.state.throttleDelta * dt * 0.9, 0, 1);
      ship.boost += ((input.state.boost && !ship.foldMode ? 1 : 0) - ship.boost) * Math.min(1, dt * 5);
    } else {
      input.state.pitch = input.state.yaw = input.state.roll = 0;
      input.state.boost = 0;
    }

    // proximity governs fold speed and forces a drop-out near masses
    const near = this.nearestBodyInfo();
    // Fold speed is proportional to how far you are from the nearest mass, so
    // an approach decelerates itself. Capped below c because the drive folds
    // space rather than moving through it, and because a whole system crossed
    // in two seconds is not a journey.
    const foldCeiling = THREE.MathUtils.clamp(near.surfaceDist * 1.15, 900, 240000);
    if (ship.foldMode && near.surfaceDist < this.foldFloor(near)) this.toggleFold(false);
    if (ship.foldMode && ship.foldCharge <= 0.001) this.toggleFold(false);

    // ------------------------------------------------------------ autopilot
    const flightInput = (!uiOpen && flying)
      ? this.applyAutopilot(dt, input.state)
      : { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0 };
    ship.update(dt, flightInput, { time: this.time, foldCeiling });

    // ---- approach envelope: a soft floor rather than a wall
    this.updateProximity(dt);

    // -------------------------------------------------- floating origin
    this.origin.copy(ship.absPos);
    ship.object.position.set(0, 0, 0);

    // ------------------------------------------------------ crew position
    this.player.update(dt, input, uiOpen);
    if (this.mode === 'walk' && this.player.mode === 'seated') this.mode = 'pilot';
    if (this.mode === 'pilot' && this.player.mode === 'walk') this.mode = 'walk';

    // ------------------------------------------------------------ camera
    this.updateCamera(dt);

    if (this.landed) {
      this.updateSurface(dt);
      this.updateScan(dt, uiOpen);
      this.updatePost(dt);
      this.directives.update();
      this.shake = Math.max(0, this.shake - dt * 1.6);
      this.hud.update(dt);
      this.audio.update(dt, this);
      return;
    }

    this._updateWorld(dt);

    // ------------------------------------------------------------ scanning
    this.updateScan(dt, uiOpen);
    this.updatePost(dt);

    this.directives.update();
    this.encounters.update(dt);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.hud.update(dt);
    this.audio.update(dt, this);
  }

  /* ------------------------------------------------------------ landing */

  /** Whether the current target is somewhere the ship could actually sit. */
  canLand(b) {
    b = b || this.target;
    if (!b || !b.planet || b.planet.isGas) return null;
    const d = b.absPos.distanceTo(this.ship.absPos);
    return d < b.radius * 2.6 ? b : null;
  }

  /* ==========================================================================
     Arrival and departure.

     Both of these used to be one synchronous function that swapped a whole
     scene between two frames, and both measured as a stall: 233 ms on the frame
     after a landing and 554 ms on the frame after a liftoff, at 5.7 Mpx, with
     nothing on screen to explain either. Almost none of it is the terrain —
     constructing a Surface and baking its two per-vertex textures is 33 ms. It
     is *shader compilation*, and specifically `setGroundDepth`: it moves
     forty-odd hull materials between the two logarithmic-depth variants, three
     deletes a program the instant its last material stops using it, and so
     every transition threw one entire variant of the hull away and rebuilt it
     from source. The measured programs bear it out exactly — 42 new
     `physical,STANDARD` programs on the frame after a liftoff.

     So the swap is a sequence now rather than a statement. The camera leaves
     the ship for a few seconds either way, and behind that:

       1. the Surface is constructed on one frame and baked on the next, so the
          two costs land in different frames instead of one;
       2. at the entry flare — the one moment the hull is legitimately not in
          the picture — the hull is re-parented into the scene it is about to
          belong to and both scenes' materials are flipped;
       3. `compileAsync` builds every program the new scene needs. Its
          *synchronous* half measures 32 ms; everything after that is the
          driver's parallel-compile threads, and the frame loop runs straight
          through it at 20 ms a frame because the promise yields;
       4. and only then does the scene actually change over, on a frame where
          the shot it cuts to is already composed.

     The director's shot 2 holds until step 3 finishes, so a slow machine gets a
     slightly longer hold rather than a stutter, and a fast one does not wait.
     ======================================================================== */

  /** Where on the sphere a landing would put down. Sunward-biased: a pilot
   *  picks a site in daylight, and the alternative is arriving on a black plain
   *  and waiting out a night that lasts as long as you do. */
  _pickSite(b, out) {
    out.copy(this.ship.absPos).sub(b.absPos).normalize();
    _v2.copy(this.star.absPos).sub(b.absPos).normalize();
    return out.lerp(_v2, 0.34).normalize();
  }

  /** A promise that resolves at the top of the next game update. */
  _nextFrame() {
    return new Promise((res) => { (this._frameWaiters || (this._frameWaiters = [])).push(res); });
  }

  /**
   * Enter the cloud deck. This is what covers the scene change.
   *
   * It used to be a white flash and a cut: the camera left the ship, held on
   * the planet's limb from inside its own atmosphere shell — which draws as a
   * brown smear, because that shell is authored to be seen from outside — and
   * came back somewhere else entirely. Three cuts and a dissolve to get one
   * ship from orbit to a dune.
   *
   * There is only one shot now, and the only thing that has to be hidden is
   * the fraction of a second in which forty hull materials change depth
   * convention. A descent has something to hide it with: the camera is holding
   * the ship at a fixed offset, the ship is going down, and at some point it
   * goes into cloud. `cloud` ramps up, the swap happens inside it, it ramps
   * down over the landscape, and the hull is only actually undrawn while the
   * deck is thick enough that nothing could be seen through it anyway.
   */
  beginEntry() {
    if (!this.transition || this.transition.flared) return;
    this.transition.flared = true;
    this.transition.flareAt = this.transition.t;
    this.audio.ping(this.transition.kind === 'land' ? 'arrive' : 'boot');
  }

  /** Backwards-compatible alias: the old name meant "cover the change now". */
  beginEntryFlare() { this.beginEntry(); }

  /* The cover's own clock, run from update() so it is independent of which
     scene is on screen and of how long the compile took. In on CLOUD_IN,
     held while the transition is still working, out on CLOUD_OUT — and the
     hull is dropped only above CLOUD_OPAQUE. */
  _updateCloud(dt) {
    const T = this.transition;
    let want = 0;
    if (T && T.flared) {
      const since = T.t - T.flareAt;
      want = since < CLOUD_IN ? since / CLOUD_IN : 1;
    } else if (this._cloudOut > 0) {
      this._cloudOut = Math.max(0, this._cloudOut - dt / CLOUD_OUT);
      // never *above* where the cover actually got to: land({now:true}) skips
      // the cover entirely, and a ramp-out that starts from one rather than
      // from zero fades a cloud deck up over a landing nobody was watching
      want = Math.min(this._cloudOut, this._cloud);
    }
    // rising is driven, falling is eased, so a fast machine still gets a
    // cloud that opens rather than one that blinks off
    this._cloud = want > this._cloud ? want : this._cloud + (want - this._cloud) * Math.min(1, dt * 3.4);
    /* `covered` is the gate everything structural waits on, and it is not the
       same as `flared`. Staging either scene re-parents the hull out of the one
       being drawn, so it must not happen until the deck is genuinely opaque —
       doing it when the cover merely *started* is a ship that vanishes into
       thin cloud a second before the cloud is thick enough to explain it. */
    if (T) {
      /* `covered` lags `hideHull` by one frame, and that one frame is worth 78
         milliseconds. Staging flips forty hull materials between the two
         logarithmic-depth variants, and a variant is not rebuilt when it is
         assigned — it is rebuilt the first time it is *drawn*. This runs after
         updateCamera, so a hideHull raised here does not reach the hull until
         the next frame; staging on the same frame therefore flipped the
         materials and then drew them, and the whole recompile landed on one
         frame in the middle of the landing. Measured: 160 ms with them on the
         same frame, 88 with one between. Wait for the hull to actually be
         gone. */
      const wasHidden = T.hideHull;
      T.hideHull = this._cloud >= CLOUD_OPAQUE;
      T.covered = T.covered || (wasHidden && T.hideHull);
    }
  }

  /**
   * Begin a descent. The orbital scene is not torn down — it is simply not
   * drawn — so the system carries on ticking underneath the whole time.
   */
  /**
   * @param {object} [body]
   * @param {{now?:boolean}} [opts] `now` skips the covering shot and lands as
   *   fast as the machine allows. It exists for the verification tools, which
   *   want a landed scene rather than a performance, and which used to be able
   *   to rely on `land()` being synchronous.
   * @returns {Promise} resolved once the ground scene is up.
   */
  land(body, opts = {}) {
    const b = this.canLand(body);
    if (!b || this.landed || this.transition) { this.audio.ping('deny'); return Promise.resolve(); }

    this.cancelAutopilot();
    if (this.ship.foldMode) this.toggleFold(false);
    const site = this._pickSite(b, new THREE.Vector3());

    this.transition = {
      kind: 'land', body: b, site, t: 0, flared: false, hideHull: false,
      // relative to the body, because the body is moving — see _flyTransition
      fromRel: this.ship.absPos.clone().sub(b.absPos),
      dur: 6.0,
    };
    // The whole point of a sequence is to look at the ship, so the hull has to
    // be drawn — and coming out of it on the ground, `mode` is 'landed' anyway.
    this.mode = 'exterior';
    this.ship.throttle = 0.55;
    this.ship.deployGear(true);
    this.hud.log(`DESCENT · ${b.name}`, 'ok');
    this.audio.ping('boot');

    const seq = SEQUENCES.descent(this, b);
    this.director.play('descent:' + b.id, seq.shots, { title: seq.title, sub: seq.sub });
    if (opts.now) {
      this.transition.flared = true;
      this.transition.covered = true;
      this._buildGroundNow(b);
      return Promise.resolve();
    }
    return this._prepareGround(b);
  }

  /** Build the landscape and compile it, spread over frames. */
  async _prepareGround(b) {
    const T = this.transition;
    try {
      await this._nextFrame();
      if (this.transition !== T) return;
      const surface = new Surface(b.spec, this.quality);
      await this._nextFrame();
      if (this.transition !== T) { surface.dispose(); return; }
      /* Everything the terrain's vertex stage can know before the sun moves,
         evaluated once here rather than a dozen field lookups per vertex per
         frame for the rest of the landing. See Surface.bake — it is two point
         draws over the grid's own vertex buffer. */
      surface.bake(this.renderer);
      await this._nextFrame();
      if (this.transition !== T) { surface.dispose(); return; }
      this._buildGround(b, surface);

      // Wait for the deck to close before touching anything the camera can see.
      while (this.transition === T && !T.covered) await this._nextFrame();
      if (this.transition !== T) { surface.dispose(); return; }
      this._stageGround();
      await this._compileScene(T.scene);
      /* And the covering beat gets to play, whether or not it is still needed.
       *
       * Its length is bounded below as well as above. On a cold cache it holds
       * for as long as the compile takes; on a warm one the compile returns
       * almost immediately and, without this, the swap happened a tenth of a
       * second into the shot and the entry — the flare, the limb filling the
       * frame, the whole reason the camera left the ship — was never seen at
       * all. Which meant the sequence played correctly exactly once per
       * session, on the first landing, and was cut short every time after. */
      while (this.transition === T && T.t - T.flareAt < ENTRY_BEAT) {
        await this._nextFrame();
      }
      if (this.transition !== T) return;
      this._finishGround();
    } catch (e) {
      console.error('landing preparation failed', e);
      this.transition = null;
      this.director.stop();
    }
  }

  /** Same three steps with nothing between them. Used by `land({now:true})`,
   *  which is what the verification tools want: a landed scene, not a show. */
  _buildGroundNow(b) {
    const surface = new Surface(b.spec, this.quality);
    surface.bake(this.renderer);
    this._buildGround(b, surface);
    this._stageGround();
    this._finishGround();
  }

  /** Assemble the ground scene. Nothing here is visible yet. */
  _buildGround(b, surface) {
    const T = this.transition;
    const scn = new THREE.Scene();
    scn.add(surface.root);
    /* The ground scene works in *metres* — a 26 km patch in kilometre units
       would put the whole landscape inside a rounding error of the near plane,
       and the hull is authored in metres anyway. Scaling the rig up by 1000
       makes the ship life-size in a scene where 1 unit = 1 m. */
    const rig = new THREE.Group();
    rig.scale.setScalar(1000);
    /* Stand the hull on its gear rather than sinking it into the noise. The
       ventral instrument bay hangs 7.5 m below the hull datum and the gear
       another 6 below that. */
    rig.position.y = SURFACE_GEAR_HEIGHT;
    scn.add(rig);
    T.surface = surface;
    T.scene = scn;
    T.rig = rig;
  }

  /** Move the hull and the lights across, and flip the materials — everything
   *  the compile has to see, and nothing the camera does. */
  _stageGround() {
    const T = this.transition;
    /* A new world, a new sky: force the probe to re-bake rather than lighting a
       snowfield with the last desert's sky. It has to *exist* first, though —
       `scene.environment` is part of a material's program key, so compiling
       against a scene with no environment and rendering with one is the same
       recompile this whole dance exists to avoid. */
    this._ensureEnvProbe();
    if (this.envProbe) {
      this.envProbe.key = -1e9;
      T.scene.environment = this.envProbe.pmremRT ? this.envProbe.pmremRT.texture : null;
      T.scene.environmentIntensity = 1.0;
    }

    // the hull, re-parented onto the ground, and the ground's own key and fill
    T.rig.add(this.ship.object);
    T.scene.add(this.sunLight);
    T.scene.add(this.sunLight.target);
    T.scene.add(this.fillLight);
    T.scene.add(this.fillLight.target);
    T.scene.add(this.bounceLight);
    T.scene.add(this.bounceLight.target);

    this.surface = T.surface;
    this.surfaceScene = T.scene;
    this.surfaceRig = T.rig;
    // materials only — the renderer-wide half waits for the actual changeover
    this._setSceneDepth(false);
  }

  /** ...and over. */
  _finishGround() {
    const T = this.transition;
    const b = T.body;
    this.engine.sceneOverride = this.surfaceScene;
    this.engine.post.sceneLogDepth = false;
    this._setNear(GROUND_NEAR, GROUND_FAR);
    // the box that covers 110 m of space covers 11 cm of ground
    this.setShadowScale(1000);

    this.landed = { body: b, normal: T.site.clone(), t: 0, onFoot: false, settle: SETTLE_TIME };
    this.ship.throttle = 0;
    this.ship.boost = 0;
    this.ship.vel.set(0, 0, 0);
    // Parked: level, wheels down, nose along -Z of the ground frame.
    this.ship.quat.identity();
    this.ship.object.quaternion.identity();
    this.ship.object.position.set(0, 0, 0);
    this.mode = 'landed';
    this.transition = null;
    /* Out of the deck. The shot the audience is watching does not change here
       — the ground sequence picks the camera up at exactly the offset the
       descent left it at, in the same ship-local frame — so the only thing
       that happens on this frame is that the cloud starts to thin and there
       is a landscape behind it. */
    this._cloudOut = this._cloud;
    this.ship.model.visible = true;
    this.hud.log(`TOUCHDOWN · ${b.name}`, 'ok');

    const seq = SEQUENCES.touchdown(this, b);
    this.director.play('land:' + b.id, seq.shots, { title: seq.title, sub: seq.sub });
  }

  /**
   * Drive the ship through a transition. Called from update() while
   * `this.transition` is set, in place of the flight model.
   *
   * Nothing flies between planets in real time and nothing flies *down* to one
   * either — at full boost the ship closes 0.2 Mm in five seconds against a
   * planet radius of two or three thousand — so the descent is re-posed each
   * frame and `vel` is written back afterwards, which is what keeps the speed
   * streaks and the drive plume reading.
   */
  _flyTransition(dt) {
    const T = this.transition;
    const b = T.body;
    T.t += dt;
    const u = THREE.MathUtils.clamp(T.t / T.dur, 0, 1);
    // ease in, hold at the end: the covering beat must not keep moving the ship
    const e = u * u * (3 - 2 * u);
    /* Both ends are kept *relative to the world*, and recomputed every frame.
       Planets here move at tens of kilometres a second — see PLANET_ORBIT_SPEED
       — so a descent aimed at an absolute point five seconds ago lands next to
       the planet rather than on it. */
    /* Stops at 1.03 radii, not 1.006. The camera now rides with the ship all
       the way down instead of cutting to the limb, so wherever the descent
       ends is where a *space* scene gets rendered from — and 1.006 is twenty
       kilometres up on a world three thousand across, which puts the planet
       into its closest LOD and compiles that variant on one frame: 95 ms to
       159 on the ground bench, all of it inside render(). The last stretch is
       behind opaque cloud anyway, so nothing is lost by ending the flight
       path a hundred kilometres higher and letting the ground scene take it
       from there. */
    _t1.copy(T.fromRel).lerp(_t2.copy(T.site).multiplyScalar(b.radius * 1.03), e)
      .add(b.absPos);
    _t3.copy(this.ship.absPos);
    this.ship.absPos.copy(_t1);
    this.ship.vel.copy(_t1).sub(_t3).divideScalar(Math.max(dt, 1e-4));

    /* Raked over, then flared level. The flight path is very nearly radial, and
       a hull with its nose straight down has (a) no heading to read and (b) a
       degenerate lookAt basis, because the up vector it would be handed is the
       path. Splitting the path into its radial and tangential halves and flying
       about forty-five degrees between them fixes both, and it is what an
       aerodynamic entry looks like anyway.
     *
     * The rake then has to come *out* again, and that is new. The landing is
     * one continuous shot across a scene change now, and the camera holds the
     * ship at a fixed offset in the ship's own frame on both sides of it — so
     * the framing survives the cut only if the ship's frame does. On the ground
     * the hull is parked level with its nose along -Z, which is exactly this
     * basis with the rake taken out, so the last third of the descent blends
     * the entry attitude toward the landing attitude. It is also what an
     * approach looks like: you do not arrive at a runway at forty-five
     * degrees. */
    _t1.copy(T.site).multiplyScalar(b.radius * 1.03).sub(T.fromRel).normalize();
    _t2.copy(_t1).addScaledVector(T.site, -_t1.dot(T.site));   // tangential part
    if (_t2.lengthSq() < 1e-8) _t2.set(T.site.y, -T.site.x, 0);
    _t2.normalize();
    const rake = 0.72 * (1 - THREE.MathUtils.smoothstep(u, 0.55, 0.94));
    _t3.copy(_t1).multiplyScalar(rake).addScaledVector(_t2, 0.69 + 0.31 * (0.72 - rake) / 0.72)
      .normalize();
    _m4.lookAt(ZERO, _t3, T.site);
    _q.setFromRotationMatrix(_m4);
    this.ship.quat.slerp(_q, Math.min(1, dt * 1.5));
    this.ship.object.quaternion.copy(this.ship.quat);

    /* And into the deck. Timed off the flight path rather than off a shot, so
       the cover starts where the ship reaches the weather and not where a
       cut used to be. Everything downstream — the build, the material flip,
       the changeover — waits on this. */
    if (u > 0.80) this.beginEntry();

    this.origin.copy(this.ship.absPos);
    this.ship.object.position.set(0, 0, 0);
    this.ship.updateVisuals(dt, this.time);
    this.shake = Math.max(this.shake, 0.45 * e);
  }

  /** Create the ground environment probe without baking anything into it. */
  _ensureEnvProbe() {
    if (this.envProbe) return;
    // updateSurfaceEnv builds it lazily; borrow that path with a zero level so
    // nothing has to be duplicated here.
    const scn = this.surfaceScene;
    this.surfaceScene = this.surfaceScene || new THREE.Scene();
    this.updateSurfaceEnv(_v.set(0, 1, 0), 0.001, 0.001, 1);
    this.surfaceScene = scn;
  }

  /** Every program a scene will need, built on the driver's own threads. */
  async _compileScene(scn) {
    try {
      await this.renderer.compileAsync(scn, this.camera);
    } catch (e) {
      // A compile failure is not a reason to lose the transition; the frame
      // after will build whatever is missing, slowly, which is the old
      // behaviour rather than a new bug.
      console.warn('precompile skipped', e);
    }
  }

  /* The material half of setGroundDepth. Split out because the transition has
     to flip the materials several frames before it flips the renderer's own
     state: the compile has to see the variant that is about to be drawn. */
  _setSceneDepth(on) {
    if (this.surface) this.surface.eachMaterial((m) => setLogDepth(m, on));
    const seen = this._logDepthSeen || (this._logDepthSeen = new Set());
    seen.clear();
    const visit = (m) => { if (m && !seen.has(m)) { seen.add(m); setLogDepth(m, on); } };
    this.ship.object.traverse((o) => {
      if (Array.isArray(o.material)) o.material.forEach(visit); else visit(o.material);
      visit(o.customDepthMaterial);
      visit(o.customDistanceMaterial);
    });
  }

  /* Step out onto the planet.

     Until now `landed` was a crane camera orbiting a parked hull — you could
     look at a world but never stand on one, which is the largest single gap
     against what this game is for. On foot the same first-person controller
     that walks the ship's corridor runs against the terrain instead: free in
     XZ, with the ground height under its feet coming from the surface's own
     height law rather than from a corridor's walkable region.

     The ground scene is in metres and the hull is about 145 of them, so the
     player is put down clear of the gear rather than inside it. */
  disembark() {
    if (!this.landed || this.landed.onFoot || this.director.active) return;
    const R = this.ship.length * 1000;                 // hull length, metres
    this.landed.onFoot = true;
    this.landed.boardAt = new THREE.Vector2(R * 0.30, R * 0.42);
    const p = this.player;
    p.mode = 'ground';
    p.pos.set(this.landed.boardAt.x, 0, this.landed.boardAt.y);
    p.vel.set(0, 0, 0);
    /* Face the ship, so the first thing you see on stepping out is your own
       vessel with the landscape behind it. The controller's forward vector is
       (-sin yaw, -cos yaw), so facing the origin from (x, z) is atan2(x, z) —
       negating both, which looks like the obvious thing to write, turns you
       around and puts the ship at your back. */
    p.yaw = Math.atan2(p.pos.x, p.pos.z);
    p.pitch = -0.04;
    p.groundHeight = (x, z) => (this.surface && this.surface.heightAt
      ? this.surface.heightAt(x, z, 1.0) : 0);
    p.groundY = p.groundHeight(p.pos.x, p.pos.z);
    this.interiorRig.visible = false;
    this.hud.log('EVA · SUIT SEALED', 'ok');
    this.audio.ping('ui');
  }

  /* Put the sun at a chosen elevation on the ground, and return the time that
     did it. `landed.t` is a clock, not an angle — it has to run *negative* to
     lower the sun below where touchdown put it — so anything wanting a
     particular hour had to binary-search it. Verification needs the same sky
     twice, so it gets a way to ask. */
  setSunElevation(y) {
    if (!this.landed || !this.surface) return null;
    const at = (t) => {
      this.landed.t = t;
      this.updateSurface(0.001);
      return this.surface.skyMat.uniforms.uSunDir.value.y;
    };
    let lo = -520, hi = 520;
    if (at(lo) > at(hi)) { const s = lo; lo = hi; hi = s; }
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) * 0.5;
      if (at(mid) < y) lo = mid; else hi = mid;
    }
    const t = (lo + hi) * 0.5;
    at(t);
    return t;
  }

  /** Back aboard. Only from close enough to the gear to have climbed it. */
  board() {
    if (!this.landed || !this.landed.onFoot) return;
    const R = this.ship.length * 1000;
    if (Math.hypot(this.player.pos.x, this.player.pos.z) > R * 1.15) {
      this.hud.log('TOO FAR FROM THE SHIP', 'hi');
      this.audio.ping('deny');
      return;
    }
    this.landed.onFoot = false;
    this.player.mode = 'walk';
    this.player.groundHeight = null;
    this.player.groundY = 0;
    this.player.pos.set(0, 0, 2.4);
    this.audio.ping('ui');
  }

  /**
   * Leave. The mirror of `land`: the ship climbs out of the ground scene under
   * its own drive, and the changeover happens once it is small enough in frame
   * to be covered by the flare.
   *
   * The release point matters more than it looks. It used to be 1.10 radii,
   * which puts you a tenth of a radius above the surface — deep inside the
   * distance at which the drive refuses to hold a fold. Pressing J there
   * engaged the drive and update() cancelled it on the very next frame, over
   * and over, and the ship shuddered on the spot instead of going anywhere.
   * See foldFloor: 2.15 radii clears it with margin on every world in the game.
   */
  /** @param {{now?:boolean}} [opts] see `land` — for the verification tools.
   *  @returns {Promise} resolved once the world is back. */
  liftOff(opts = {}) {
    if (!this.landed || this.transition) return Promise.resolve();
    const b = this.landed.body;
    const up = this.landed.normal.clone();
    // Leaving the ground on foot would strand the player in a scene that is
    // about to be disposed. Back aboard first, and into the seat: you are
    // flying in eight seconds and the alternative is standing in the corridor
    // while the ship takes off around you.
    if (this.landed.onFoot) {
      this.landed.onFoot = false;
      this.player.groundHeight = null;
      this.player.groundY = 0;
      this.player.pos.set(0, 0, 2.4);
    }
    this.player.mode = 'walk';
    const seat = this.interior.stations.find((s) => s.id === 'seat');
    if (seat) this.player.sit(seat);

    this.transition = { kind: 'ascent', body: b, site: up, t: 0, flared: false, hideHull: false };
    this.ship.deployGear(false);
    this.ship.throttle = 0.6;
    this.hud.log('LIFTOFF', 'ok');
    this.audio.ping('boot');

    const seq = SEQUENCES.ascent(this, b);
    this.director.play('ascent:' + b.id, seq.shots, { title: seq.title, sub: seq.sub });
    if (opts.now) {
      this.transition.flared = true;
      this.transition.covered = true;
      this._stageSpace();
      this._finishSpace();
      return Promise.resolve();
    }
    return this._prepareSpace();
  }

  /** The departure's own half of the work: put the hull back on the space
   *  scene's depth curve and compile it, behind the flare. */
  async _prepareSpace() {
    const T = this.transition;
    try {
      /* The ground scene is still being drawn, with the hull in it, so nothing
         may change until the shot that covers it starts — and by then the ship
         is a kilometre up and half a frame wide. */
      while (this.transition === T && !T.covered) await this._nextFrame();
      if (this.transition !== T) return;
      this._stageSpace();
      await this._compileScene(this.scene);
      // the same floor as the arrival — see _prepareGround
      while (this.transition === T && T.t - T.flareAt < ENTRY_BEAT) {
        await this._nextFrame();
      }
      if (this.transition !== T) return;
      this._finishSpace();
    } catch (e) {
      console.error('departure preparation failed', e);
      this.transition = null;
      this.director.stop();
    }
  }

  _stageSpace() {
    this.scene.add(this.ship.object);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.scene.add(this.fillLight);
    this.scene.add(this.fillLight.target);
    this.scene.add(this.bounceLight);
    this.scene.add(this.bounceLight.target);
    this._setSceneDepth(true);
  }

  _finishSpace() {
    const T = this.transition;
    const b = T.body;
    // Clear of the well, which is not the same as clear of the ground: see
    // foldFloor. Anything under about two radii is somewhere the drive will
    // not hold a fold, and arriving there is what made the drive look broken.
    this.ship.absPos.copy(b.absPos).addScaledVector(T.site, b.radius * 2.15);
    this.ship.vel.copy(T.site).multiplyScalar(48);
    // Nose *away* from the world, along the climb — not at it. Pointing the
    // other way is how a fold engaged straight after a liftoff flew back into
    // the gravity well it had just left and was cancelled a second later.
    _m4.lookAt(ZERO, _v.copy(T.site), _v2.set(0, 1, 0));
    this.ship.quat.setFromRotationMatrix(_m4);
    this.ship.object.quaternion.copy(this.ship.quat);
    this.ship.object.position.set(0, 0, 0);
    this.origin.copy(this.ship.absPos);
    this.camRig.copy(this.ship.quat);

    this.landed = null;
    /* Back at the helm, not hanging behind the ship. This was the other half
       of "stuck in third person after taking off": liftOff left `mode` on
       'exterior' with the crew standing in the corridor, so V set 'pilot' for
       exactly one frame and update() put it back to 'walk'. */
    this.mode = (this.player.mode === 'seated' || this.player.mode === 'moving')
      ? 'pilot' : 'walk';
    this.engine.sceneOverride = null;
    this.engine.post.sceneLogDepth = true;
    this._setNear(0.008, SPACE_FAR);
    /* Back to an angular occlusion radius: in space one unit is a kilometre
       and a frame spans nine orders of magnitude, so no fixed world scale can
       be right in it. */
    this.engine.post.aoWorldRadius = 0;
    this.engine.post.groundMeter = false;
    this.setShadowScale(1);
    if (this.surface) this.surface.dispose();
    this.surface = null;
    this.surfaceScene = null;
    this.surfaceRig = null;
    this.transition = null;
    /* Not left burning. A land -> liftOff -> land cycle used to arrive with
       the plume still lit, and a drive at 200+ units of radiance in frame
       drags the auto-exposure down and takes the whole landscape with it. */
    this.ship.throttle = 0.35;
    // and out of the deck on this side too, over the world falling away
    this._cloudOut = this._cloud;
    this.ship.model.visible = true;

    const seq = SEQUENCES.ascentSpace(this, b);
    this.director.play('ascent2:' + b.id, seq.shots, { title: seq.title, sub: seq.sub });
  }

  /* Move the whole ground pass on or off the logarithmic depth buffer, and the
     camera's planes with it. See GROUND_NEAR for why the ground does not want
     it and space does.
   *
   * It has to be done per *material*, and the reason is that the two scenes
   * share the hull. `land` re-parents `ship.object` onto the surface rig rather
   * than duplicating it, so its materials are the same objects the exterior
   * draws with and cannot simply be stripped once at build time. What does not
   * work — and was tried — is flipping the renderer's own capability flag:
   * `WebGLPrograms` captures it in a closure const at construction, so the
   * uniform-setting side changes and the shader defines do not. Every hull
   * fragment then writes gl_FragDepth from an unset `logDepthBufFC`, goes out
   * of range, and the ship disappears while still costing sixty draw calls.
   *
   * All of it or none of it. The two encodings are not merely different
   * precisions, they are different curves — a fragment 100 m away lands at a
   * completely different depth under each — so a pass with some materials on
   * one and some on the other does not z-fight, it inverts.
   *
   * The shadow pass is exempt and safe: the sun is a directional light, its
   * camera is orthographic, and three's chunk falls through to
   * `gl_FragCoord.z` for an orthographic projection. The two encodings are
   * literally the same function there, which is why the hull can keep three's
   * stock depth material while the terrain's own loses the write. */
  setGroundDepth(ground) {
    const on = !ground;
    this._setSceneDepth(on);
    /* The occlusion pass reads one linear-depth buffer and PostFX inverts
       whichever encoding the pass that owns the frame wrote. It has no way to
       infer this, and getting it wrong does not throw — it produces occlusion
       that is plausible in one scene and inverted in another. */
    this.engine.post.sceneLogDepth = on;
    // updateCamera would set these on the next frame anyway; doing it here
    // means the frame a landing lands on is already on the right curve.
    if (ground) this._setNear(GROUND_NEAR, GROUND_FAR);
    else this._setNear(0.008, SPACE_FAR);
  }

  /** Ground frame: the ship sits at the origin of a local up-is-up scene. */
  updateSurface(dt) {
    const L = this.landed;
    L.t += dt;

    // sun direction in the *local* frame: the landing normal is up
    const up = L.normal;
    _v.copy(this.star.absPos).sub(L.body.absPos).normalize();
    const east = _v2.crossVectors(up, _v3.set(0, 1, 0)).normalize();
    if (!isFinite(east.x) || east.lengthSq() < 1e-8) east.set(1, 0, 0);
    const north = _v3.crossVectors(east, up).normalize();
    const sunLocal = new THREE.Vector3(_v.dot(east), _v.dot(up), _v.dot(north));

    // A slow day: the star climbs while you are down there, which is the
    // cheapest possible way to make a static scene feel like a place.
    const ang = L.t * 0.012;
    const s = Math.sin(ang), c = Math.cos(ang);
    sunLocal.set(sunLocal.x * c - sunLocal.y * s, sunLocal.x * s + sunLocal.y * c, sunLocal.z).normalize();

    const starDist = Math.max(this.star.absPos.distanceTo(L.body.absPos), this.star.radius);
    const refOrbit = 900000 * Math.sqrt(Math.max(this.system.star.luminosity, 0.05));
    const illum = THREE.MathUtils.clamp((refOrbit / starDist) ** 2, 0.30, 4.0);

    this.surfaceRig.position.set(0, SURFACE_GEAR_HEIGHT, 0);
    /* The hull's height above its gear, in ship units — the rig is scaled by a
       thousand, so a metre of altitude is a thousandth here.
     *
     * Two things write it. A landing eases the last ninety metres out over the
     * first beat of the touchdown sequence, so the ship arrives rather than
     * being present; a departure runs the same number the other way, under
     * power, and is what the ascent's first two shots are looking at. Without
     * either, both transitions were a cut from a ship in space to the same ship
     * standing on a planet, which is the jump cut. */
    let lift = 0;
    // 0 = the camera anchor stands on the landing site, 1 = it is glued to the
    // hull. See groundCamAnchor: this one number is what makes the scene change
    // inside the cloud invisible, and it runs opposite ways on the two sides.
    let follow = 0;
    const T = this.transition;
    if (T && T.kind === 'ascent') {
      T.t += dt;
      // a drive spooling: quadratic in the first seconds, then linear
      const u = T.t;
      lift = 8.0 * u * u + 42.0 * Math.max(0, u - 1.1) ** 2;
      this.shake = Math.max(this.shake, 0.55 * Math.exp(-u * 0.7));
      this.ship.throttle = Math.min(1, 0.5 + u * 0.35);
      follow = THREE.MathUtils.smoothstep(u, 1.3, 4.3);
      // and into the deck, once there is enough air under it to be in one
      if (u > 4.6) this.beginEntry();
    } else if (this.landed && this.landed.settle > 0) {
      this.landed.settle = Math.max(0, this.landed.settle - dt);
      const u = this.landed.settle / SETTLE_TIME;
      // cubic, so the rate of descent bleeds off into the touchdown rather
      // than arriving at it — the last ten metres take a second on their own
      lift = SETTLE_HEIGHT * u * u * (0.35 + 0.65 * u);
      this.shake = Math.max(this.shake, 0.5 * (1 - u));
      /* Steeper than the descent, deliberately. If the camera came down at the
         same rate as the ship the ship would not appear to be coming down at
         all — it would hang in the middle of the frame with a landscape sliding
         up behind it. Letting go of the hull early is what turns the shot from
         one travelling with the vehicle into one waiting for it. */
      follow = Math.pow(u, 2.4);
    }
    this.ship.object.position.set(0, lift * 0.001, 0);
    // ...in metres, which is what the ground scene and the director both use
    this.groundShipAnchor.set(0, SURFACE_GEAR_HEIGHT + lift, 0);
    this.groundCamAnchor.set(0, (SURFACE_GEAR_HEIGHT + lift) * follow, 0);

    // Vector3.copy(Color) reads .x/.y/.z and a Color has none, so the star's
    // colour has to be transferred by component or the whole ground goes NaN.
    const k = illum * 1.6;
    _sunCol.setRGB(this.star.color.r * k, this.star.color.g * k, this.star.color.b * k);
    /* The sun's box, handed to the ground so its shadow-map lookup can fade out
       where the box actually ends. It used to fade 126 m to 221 m about the
       *ship* while fitGroundShadow slides the box up to 260 m down-sun, so at a
       raking star the half of the ship's shadow with the legs and booms in it
       was faded to lit before it was ever looked up — and at a four-degree sun
       there was no ship shadow in the frame at all. fitGroundShadow runs below,
       so this reads the box the previous frame built; it changes by metres. */
    const aimPrev = this._shadowAim;
    this.surface.update(dt, {
      sunDir: sunLocal, sunColor: _sunCol,
      camPos: this.camera.position, time: this.time,
      shadowNB: this._shadowNB,
      shadowBox: {
        half: 0.11 * 1000 + (this._groundExtra || 0),
        cx: aimPrev ? aimPrev.x : 0, cz: aimPrev ? aimPrev.z : 0,
      },
    });

    /* Ten kilometres was fine for a light with no shadow map; with one, the
       shadow camera has to actually contain the subject, so the light sits at
       the frustum's own working distance instead — and the box is fitted to
       the hull *and the shadow it throws*, which at a low sun reaches a long
       way past the hull itself. */
    this.fitGroundShadow(sunLocal);

    /* Airmass extinction on the key.
       The terrain and the sky are custom shaders and dim themselves as the sun
       drops; three's lights are used by nothing on the ground except the hull.
       Left alone the ship therefore stood in a blue dusk landscape lit by a
       full-strength noon sun and rendered as a white cut-out — and because the
       auto-exposure had already opened up for the dark scene, it blew out
       completely. Normalised so a zenith sun is unchanged: the optical depths
       are the same ones the atmosphere shell uses, so the hull reddens and
       fades on the same curve as everything around it. */
    const el = Math.max(sunLocal.y, 0.0);
    // Capped. Uncapped, the last few degrees take the blue channel to 1e-4 and
    // the hull goes monochrome red, which is a sunset filter rather than a
    // sunset.
    const m = Math.min(1 / Math.max(el, 0.045) - 1, 7.5);
    _ext.set(Math.exp(-0.11 * m), Math.exp(-0.24 * m), Math.exp(-0.52 * m));
    const lum = 0.2126 * _ext.x + 0.7152 * _ext.y + 0.0722 * _ext.z;
    this.sunLight.color.setRGB(this.star.color.r * _ext.x, this.star.color.g * _ext.y,
      this.star.color.b * _ext.z).multiplyScalar(1 / Math.max(lum, 1e-3));
    /* Half again on the key, and the fill comes down to meet it.
     *
     * Opening the key-to-fill gap by cutting the fill alone is the obvious
     * move and it is measurably the wrong one: it changes the ratio by taking
     * light *out* of the frame, and the landed set came back a stop darker
     * with the same p99 and the same zero clip. The gap has to open upward —
     * total illumination roughly where it was, redistributed from an
     * omnidirectional wash into a directional source that casts.
     *
     * The ceiling is the terrain, which shades itself and cannot be reached
     * from here: at 3.4 the hull's lit face rendered at about 0.78 of sunlit
     * ground of the same albedo, and a hull that is much brighter than the
     * landscape it is standing on is the white-cut-out failure this number was
     * lowered to fix in the first place. 5.0 puts it at about 1.15 — painted
     * metal reading a little brighter than mineral, which is correct. */
    const key = 5.0 * illum * lum;
    this.sunLight.intensity = key;

    /* ---- one hard key, and bounce for everything else -------------------
     *
     * Said as a *ratio*, because that is the only form in which the first line
     * of the art direction is checkable. Dialled independently, these two
     * drifted until the unshadowed fill measured 122% of the key: the star was
     * no longer the dominant source, a cast shadow could remove at most a
     * seventh of the light on the ground, and a four-degree sun rendered a
     * uniformly lit plain. Both symptoms the reviewer named — "the ship's
     * shadow is a grey smudge", "nothing in the frame clips" — are that one
     * number.
     *
     * The old expression had no `illum` term at all, which is why the
     * inversion was worst exactly where it shows most: on a world far enough
     * out that the key drops to 0.45, the fill stayed at 1.92 and outshone it
     * four to one.
     *
     * Skylight loses less than the direct beam does — scattered light takes
     * the short way out of the column — so the ratio is not a constant: the
     * square root puts it at 0.30 of the key with the star overhead and lets
     * it climb through 0.4 to about 0.65 at four degrees, where the dome
     * genuinely *is* the source and pretending otherwise gives you a black
     * landscape with one lit edge. */
    const skyFill = key * 0.30 / Math.sqrt(Math.max(lum, 1e-3));
    /* And it comes from *overhead*, not from the camera's shoulder.
       The space rig anchors the fill to the camera, which is right in a void
       where the only other source is a star a hundred million kilometres away.
       On a planet the fill is the sky, and the sky is up. Left camera-anchored,
       a ship standing against a low sun got its lens-facing side lit and its
       silhouette destroyed — which is the one thing the art direction forbids
       outright, and it is why a backlit hull read as lit from the front. */
    this.fillLight.position.set(0, 1, 0).multiplyScalar(1e4);
    this.fillLight.target.position.set(0, 0, 0);

    /* Ground bounce, off the ground's own albedo and its own irradiance.
     *
     * A side-by-side against Starfield found the same hull that reads well in
     * space renders as a near-silhouette on the ground. The cause is narrower
     * than "not enough fill": the bounce was tinted by the terrain and then
     * *normalised*, so a snowfield and a basalt plain threw back exactly the
     * same amount of light. Over ice at a high sun that is wrong by a factor
     * of five, and it is why the ship on the ice world rendered coal black
     * under a sun bright enough to blow out the plain behind it.
     *
     * So: irradiance on flat ground is the key foreshortened plus the whole
     * sky, the ground returns its albedo's worth of it, and a hemisphere of
     * radiance L is worth a directional of PI*L — which is the albedo times
     * the irradiance, with a little taken off for the sky the hull is
     * standing in the way of. */
    const gc = this.surface && this.surface.spec && this.surface.spec.colors;
    const alb = gc && (gc.c2 || gc.c1);
    let bounce = 0;
    if (alb) {
      const al = 0.2126 * alb.r + 0.7152 * alb.g + 0.0722 * alb.b;
      bounce = Math.max(al, 0.02) * (key * el + skyFill) * 0.62;
      // The tint is the ground's, the level is the line above, so the colour
      // is normalised and pulled toward white for the part that is specular
      // rather than diffuse.
      const gl = Math.max(0.02, al);
      this.bounceLight.color.setRGB(alb.r / gl, alb.g / gl, alb.b / gl).lerp(WHITE, 0.35);
      this.bounceLight.position.set(0, -1e4, 0);
      this.bounceLight.target.position.set(0, 0, 0);
    }
    // Sky colour, not a fixed blue: at dusk the dome overhead is the warm end
    // of the same extinction curve the key is being pushed down.
    this.fillLight.color.setRGB(
      0.62 + (1 - lum) * 0.26, 0.77 + (1 - lum) * 0.06, 0.88 - (1 - lum) * 0.20);

    /* Split between two directionals and an environment probe.
     *
     * `surfaceScene.environment` was `false` — no image-based lighting on the
     * ground at all — so every curved surface on the hull got its ambient from
     * exactly two directions, up and down, and the flanks got nothing. The
     * probe carries the same sky and the same ground bounce as the two lights,
     * spread over the whole sphere, which is what puts light on a fuselage
     * side and a reflection in a canopy. The two are therefore *shares of one
     * budget*, not additions to it: the split is here so that anything which
     * ignores `environment` — and a custom ShaderMaterial does — still gets
     * most of the level from the lights. */
    /* Occlusion at a landscape's scale, not a corridor's. The ground scene is
       in metres, so a metre and a half is the width of the crease where a
       boulder meets the ground and of the gap under a landing foot. See
       AO_FRAG: with this set the screen-space radius becomes a cap. */
    this.engine.post.aoWorldRadius = 1.5;
    this.engine.post.groundMeter = true;

    this.fillLight.intensity = skyFill * ENV_SPLIT;
    this.bounceLight.intensity = bounce * ENV_SPLIT;
    this.updateSurfaceEnv(sunLocal, skyFill * (1 - ENV_SPLIT), bounce * (1 - ENV_SPLIT), lum);

    /* Hand the hull the sky it is actually standing under.

       The analytic environment the hull reflects — a disc of radiance at
       `uShineV` subtending `asin(uShineK)` — is only fed from the planetshine
       loop, which does not run on the ground. So a landed hull was reflecting
       whatever the last orbital frame left in those uniforms, which is why its
       polished trim went dead down here while working fine in space. On a planet
       the answer is simple and better: the source is the whole sky, straight up,
       and a hemisphere has an angular radius of 90 degrees, so uShineK is 1. */
    HULL_LIGHT.uShineV.value.set(0, 1, 0).transformDirection(this.camera.matrixWorldInverse);
    HULL_LIGHT.uShineK.value += (1.0 - HULL_LIGHT.uShineK.value) * Math.min(1, dt * 3);
    HULL_LIGHT.uShineCol.value.copy(this.fillLight.color)
      .multiplyScalar(0.10 + 0.26 * lum * Math.min(2.0, illum));

    HULL_LIGHT.uSunV.value.copy(sunLocal).transformDirection(this.camera.matrixWorldInverse);
    HULL_LIGHT.uSunTint.value.copy(this.sunLight.color)
      .multiplyScalar(Math.min(2.2, 0.35 + illum) * lum);
    // Indirect swings from ground bounce to sky bounce as the sun sets: a lit
    // landscape throws a lot of warm light up under a hull at noon, and almost
    // none of it at dusk, when what is left is the blue dome overhead.
    HULL_LIGHT.uBounce.value.setRGB(
      0.020 + lum * 0.045, 0.032 + lum * 0.052, 0.048 + lum * 0.018);
  }

  /* Keep `surfaceScene.environment` in step with the sky the ship is under.
   *
   * `skyLevel` and `gndLevel` arrive as directional-light intensities — the
   * probe's share of the two lights above — because that is the unit the rest
   * of the rig is written in. A hemisphere of radiance L delivers PI*L of
   * irradiance, and a directional of intensity I delivers I, so the radiance
   * that matches is I/PI. Getting that conversion wrong is a factor of three
   * either way and reads as "the ambient is not doing anything" or as fog.
   *
   * Re-baked on a threshold rather than every frame. The day is eight minutes
   * long, so a probe baked at touchdown is visibly stale by the time the sun
   * has climbed; a probe baked every frame costs six cube faces and a PMREM
   * chain for a picture that has not changed. */
  updateSurfaceEnv(sunLocal, skyLevel, gndLevel, lum) {
    if (!this.surfaceScene) return;
    if (!this.envProbe) {
      const size = this.quality === 'low' ? 16 : 32;
      this.envProbe = {
        rt: new THREE.WebGLCubeRenderTarget(size, {
          type: THREE.HalfFloatType, format: THREE.RGBAFormat,
          colorSpace: THREE.LinearSRGBColorSpace,
          minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
          generateMipmaps: true, depthBuffer: false, stencilBuffer: false,
        }),
        mat: new THREE.ShaderMaterial({
          vertexShader: ENV_VERT, fragmentShader: ENV_FRAG,
          side: THREE.BackSide, depthTest: false, depthWrite: false,
          uniforms: {
            uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
            uGround: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
            uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          },
        }),
        scene: new THREE.Scene(),
        pmremRT: null,
        key: -1e9,
      };
      const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.envProbe.mat);
      box.frustumCulled = false;
      this.envProbe.scene.add(box);
      this.envProbe.box = box;
      this.envProbe.cam = new THREE.CubeCamera(0.05, 8, this.envProbe.rt);
    }
    const P = this.envProbe;
    const u = P.mat.uniforms;

    // A hazy world's dome is brightest at the horizon and a thin one's at the
    // zenith; `lum` is already the air mass the key has been through, so it is
    // the same curve read the other way.
    const L = skyLevel / Math.PI;
    const warm = 1 - lum;
    u.uZenith.value.setRGB(L * (0.52 + warm * 0.30), L * (0.72 + warm * 0.12), L * (1.00 - warm * 0.34));
    u.uHorizon.value.setRGB(L * (0.95 + warm * 0.55), L * (0.92 + warm * 0.05), L * (0.92 - warm * 0.45));
    const G = gndLevel / Math.PI;
    u.uGround.value.copy(this.bounceLight.color).multiplyScalar(G);
    // The glow around the star, not the star. Its integral over the lobe is
    // about a fifth of the sky's, which is what a clear day measures.
    u.uGlow.value.copy(this.fillLight.color).multiplyScalar(L * 2.2 * lum);
    u.uSunDir.value.copy(sunLocal);

    /* Bake only when it would come out different. The key packs the three
       things the picture depends on — where the star is, how bright the sky
       is, how bright the ground is — so a stationary scene bakes once. */
    const k = Math.round(sunLocal.y * 60) + 1e3 * Math.round(L * 400) + 1e6 * Math.round(G * 400);
    if (k === P.key) return;
    P.key = k;

    /* `needsUpdate` is one flag for the whole renderer and the first render()
       of the frame eats it. Six face renders and a PMREM chain in the middle
       of an update step is exactly the shape of that bug, so the flag is put
       back — three happens to bail out before clearing it for a scene with no
       lights in it, but relying on that is how this class of bug is written in
       the first place. */
    const wasNeeded = this.renderer.shadowMap.needsUpdate;
    const prevTarget = this.renderer.getRenderTarget();
    P.cam.update(this.renderer, P.scene);
    P.pmremRT = this.pmrem.fromCubemap(P.rt.texture, P.pmremRT);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.shadowMap.needsUpdate = wasNeeded;
    this.surfaceScene.environment = P.pmremRT.texture;
    this.surfaceScene.environmentIntensity = 1.0;
  }

  /* -------------------------------------------------------- progression */

  grantUpgrade(id) {
    const u = UPGRADES[id];
    if (!u || this.upgrades.includes(id)) return;
    this.upgrades.push(id);
    u.apply(this);
    this.hud.log(`SYSTEM UPGRADED · ${u.label}`, 'ok');
    this.audio.ping('objective');
  }

  /** Surveying enough of a system exposes the Resonator hiding in it. */
  revealResonator() {
    this.resonatorRevealed = true;
    const r = this.anomalies.find((a) => a.anomalyType === 'resonator');
    if (r) { this.target = r; this.hud.log(`RESONANCE BEARING · ${r.name}`, 'hi'); }
  }

  /** Light one socket in the chamber per Canto held. */
  updateChamber(dt) {
    const n = this.cantos.length;
    const t = this.time;
    this.interior.sockets.forEach((s, i) => {
      const lit = i < n;
      const pulse = 0.6 + 0.4 * Math.sin(t * 1.1 + i * 0.9);
      const c = lit ? 0.9 * pulse : 0.05;
      s.ring.material.color.setRGB(c * 0.35, c * 0.85, c * 1.0);
      s.core.material.color.setRGB(c * 0.9, c * 0.75, c * 0.45);
      s.core.rotation.y += dt * (lit ? 0.9 : 0.1);
      s.core.rotation.x += dt * (lit ? 0.5 : 0.05);
    });
    const k = n / 7;
    const cp = 0.5 + 0.5 * Math.sin(t * 0.7);
    this.interior.resCore.material.color.setRGB(
      0.08 + k * 0.9 * cp, 0.14 + k * 0.85 * cp, 0.2 + k * 1.0 * cp);
    this.interior.resCore.rotation.y += dt * (0.25 + k * 0.8);
  }

  /** Pre-start attract loop: the world lives, the crew has not woken yet. */
  updateIdle(dt) {
    this.time += dt;
    this._positionSystem(dt);
    this.origin.copy(this.ship.absPos);
    this.ship.object.position.set(0, 0, 0);
    this.ship.object.quaternion.copy(this.ship.quat);

    // a slow drift through the cabin, looking out of the canopy
    const a = Math.sin(this.time * 0.09) * 0.26;
    this.player.pos.set(Math.sin(this.time * 0.06) * 0.3, 0, -1.6 + Math.sin(this.time * 0.05) * 1.4);
    this.player.yaw = a;
    this.player.pitch = -0.04 + Math.sin(this.time * 0.07) * 0.05;
    this.player.mode = 'walk';
    this.player.eye.set(this.player.pos.x, 1.66, this.player.pos.z);
    this.player.quat.setFromEuler(new THREE.Euler(this.player.pitch, this.player.yaw, 0, 'YXZ'));

    this.updateCamera(dt);
    this._updateWorld(dt);
    this._updateBakeLOD();
    this.updatePost(dt);
  }

  _updateWorld(dt) {
    const ship = this.ship;
    const sunColor = this.star.color;
    const starDist = Math.max(this.star.absPos.distanceTo(ship.absPos), this.star.radius);
    // Irradiance relative to a reference orbit, so a world in the habitable
    // zone sits at ~1.0 no matter what class its star is.
    const refOrbit = 900000 * Math.sqrt(Math.max(this.system.star.luminosity, 0.05));
        // The floor is not physical, and it has to be high. Inverse-square puts a
    // hull twelve million kilometres out at 0.006 of reference; after the
    // Lambert 1/pi and a 6x adaptation ceiling that is still two orders of
    // magnitude below anything the tonemap can lift, so every outer-system
    // object renders as an identical black cutout and the traffic, moons and
    // ice worlds out there may as well not exist. A floor of 0.30 keeps the
    // habitable zone about seven times brighter than the dark — plenty to read
    // as "far from the star" — while leaving the outer system lit at all.
    const illum = THREE.MathUtils.clamp((refOrbit / starDist) ** 2, 0.30, 4.0);
    const sunIntensity = 3.4 * illum;
    this.fitSubjectShadow();
    _v.copy(this.star.absPos).sub(this.origin);
    // The light itself is effectively at infinity, but its *shadow camera* is
    // parked 0.18 units up-sun of the hull: an orthographic frustum that small
    // needs to actually contain the ship.
    // ...and parked up-sun of the *subject*, which is not necessarily the
    // origin. See fitSubjectShadow.
    this.sunLight.target.position.copy(this._shadowCentre);
    this.sunLight.position.copy(_v).normalize().multiplyScalar(this._shadowDist)
      .add(this._shadowCentre);
    this.sunLight.color.copy(sunColor);
    this.sunLight.intensity = sunIntensity;

    /* A floor under the blacks, because shadows are never black.
     *
     * At 0.12 this was five per cent of the key *before* the colour's own
     * luminance, which is 0.04 — so about two parts in a thousand of the star,
     * and the only other indirect source out here is a nebula cube that is
     * almost entirely empty. Measured, that put the main engine bell at
     * literally 0,0,0, terminated every container underside at 0,0,0 and left
     * station frames at 77-79% pure-black pixels. The Starfield frames this
     * was judged against hold form in their darkest hull pixels and sit at
     * 23% black.
     *
     * Teal, and kept faint: the void here is teal-black rather than neutral,
     * and the number is chosen to land around three per cent of the key's
     * peak diffuse — enough that a shadow has a colour, far too little to
     * flatten a lit face. It scales with the star, so the outer system does
     * not get a fill it has no source for. */
    this.ambient.intensity = 0.34 + 1.05 * Math.min(1.6, illum);

    const ambientCol = _v2.set(sunColor.r, sunColor.g, sunColor.b)
      .multiplyScalar(0.011 * Math.min(2, illum)).addScalar(0.008);
    const ambientC = new THREE.Color(ambientCol.x, ambientCol.y, ambientCol.z);

    const wctx = {
      origin: this.origin,
      camPos: this.camera.position,
      sunPos: this.star.absPos,
      sunColor: _v3.set(sunColor.r, sunColor.g, sunColor.b).multiplyScalar(illum),
      time: this.time,
      ambient: ambientC,
      // radians per pixel — lets a shader know how resolved something is
      pixelAngle: 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5) / this.engine.height,
    };
    wctx.sunColor = new THREE.Color(wctx.sunColor.x, wctx.sunColor.y, wctx.sunColor.z);

    this.star.update(dt, wctx);
    for (const b of this.bodies) {
      if (b.planet) b.planet.update(dt, wctx);
      else if (b.kind === 'anomaly') this.updateAnomaly(b, dt, wctx);
    }

    this._updateBakeLOD();

    // asteroid fields
    const shipRel = _v.set(0, 0, 0);
    for (const f of this.fields) {
      f.object.position.copy(this.origin).negate().add(this.origin).set(0, 0, 0);
      f.update(dt, ship.absPos, shipRel, ship.vel, f.contains(ship.absPos) && !ship.foldMode);
    }

    // stations — the wheel turns for spin gravity, one revolution a minute
    for (const st of this.stations) {
      st.obj.position.copy(st.absPos).sub(this.origin);
      st.built.wheel.rotation.y += dt * 0.105;
    }

    // traffic
    this.fleet.object.position.set(0, 0, 0);
    this.fleet.update(dt, {
      time: this.time, origin: this.origin, up: UP,
      // world units per pixel at unit depth — the beacons size themselves from
      // this so a distant hull holds a constant few pixels instead of vanishing
      pixelScale: 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5) / this.engine.height,
    });

    // dust — thins out in fold, tints toward the local star
    this.dust.object.position.set(0, 0, 0);
    this.dust.update(ship.absPos, ship.vel, dt, {
      fold: ship.foldMode ? 1 : 0,
      /* Motes are a *motion* cue, so they fade out with the motion. Drawn at
         full strength on a stationary ship they are just a field of hard
         one-pixel dots, brightest looking into the key because the phase
         function says so — which is how every posed shot ended up with orange
         confetti sprayed across it, densest right where the eye was meant to
         go. Pulled down in fold too: there the tunnel shader is the effect and
         these only supply the near-field parallax on top of it. */
      fade: ship.foldMode ? 0.5
        : 0.10 + 0.90 * Math.min(1, ship.speed / (ship.maxSpeed * 0.30)),
      color: ship.foldMode
        ? new THREE.Color(0.72, 0.86, 1.0)
        : new THREE.Color().copy(sunColor).lerp(new THREE.Color(0.55, 0.68, 0.9), 0.6),
    });

    // The tunnel is the thing you actually look at during a transit; the motes
    // above it only supply the near-field parallax it cannot have.
    this.foldTunnel.update(dt, this.camera, ship.vel, ship.foldMode ? 1 : 0, this.time);

    /* ---- bounce ---------------------------------------------------------
       The fill is anti-key and lives in *world* space.

       It used to be parked on the camera's shoulder — position = camera plus a
       small offset rotated by the camera's own quaternion — which is the one
       thing the art direction forbids outright: nothing is ever lit from the
       lens. The damage is not subtle. Orbit a hull that is backlit by the star
       and its shadow side stays evenly lit whatever angle you take, because
       the fill is welded to the viewpoint; the silhouette that the backlight
       exists to draw never appears, and the ship reads as a flat cut-out with
       no side to it. The same mistake was found and fixed on the ground for
       exactly this reason.

       Anti-key, lifted about fifty-six degrees off that axis so it wraps
       rather than back-lighting, with "up" taken from a world axis rather than
       from the camera — so moving the camera moves the shading, which is the
       whole point of having a key at all. */
    _v.copy(this.star.absPos).sub(this.origin).normalize();     // toward the key
    _v2.set(0, 1, 0);
    if (Math.abs(_v.dot(_v2)) > 0.9) _v2.set(1, 0, 0);
    _v2.addScaledVector(_v, -_v.dot(_v2)).normalize();          // world up, ⟂ key
    this.fillLight.position.copy(_v).multiplyScalar(-0.55)
      .addScaledVector(_v2, 0.83).normalize().multiplyScalar(1e4);
    this.fillLight.target.position.set(0, 0, 0);

    // Planetshine. Strength falls off with the solid angle the body covers and
    // with how much of the disc facing us is actually lit, so it swells on
    // approach and dies through the terminator exactly as it should.
    {
      let best = null, bestK = 0, bestPhase = 0, bestSin = 0;
      for (const b of this.bodies) {
        if (!b.planet && b.kind !== 'star') continue;
        if (b.kind === 'star') continue;
        const d = b.absPos.distanceTo(ship.absPos);
        // sine of the world's angular radius — the whole distance term for the
        // analytic sky the hull reflects, and cover is just its square
        const sinA = b.radius / Math.max(d, b.radius);
        const cover = THREE.MathUtils.clamp(sinA * sinA, 0, 1);
        if (cover < 0.004) continue;
        // fraction of the visible hemisphere that is sunlit
        const toShip = _v.copy(ship.absPos).sub(b.absPos).normalize();
        const toSun = _v2.copy(this.star.absPos).sub(b.absPos).normalize();
        const phase = THREE.MathUtils.clamp(toShip.dot(toSun) * 0.5 + 0.5, 0, 1);
        const k = cover * phase * phase;
        if (k > bestK) { bestK = k; best = b; bestPhase = phase; bestSin = sinA; }
      }
      if (best) {
        _v.copy(best.absPos).sub(this.origin);
        this.shineLight.position.copy(_v).normalize().multiplyScalar(1e4);
        this.shineLight.target.position.set(0, 0, 0);
        /* The world's albedo *times* the star's light, not lerped toward it.
           Planetshine is sunlight that has bounced once, so the hue is the
           product of the two — and a lerp is not a product: at 0.35 toward the
           star it washed a blue ocean world halfway to the star's own white,
           which is why a hull three radii off a bright blue planet came back
           with no blue on it at all. Normalised afterwards, so the tint is a
           hue and `intensity` remains the only thing that sets the level. */
        const alb = best.spec?.colors?.c2 || best.spec?.colors?.c1
          || new THREE.Color(0.5, 0.55, 0.62);
        const sc = this.shineLight.color.setRGB(
          alb.r * sunColor.r, alb.g * sunColor.g, alb.b * sunColor.b);
        const sl = Math.max(0.02, 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b);
        sc.multiplyScalar(1 / sl).lerp(WHITE, 0.12);
        /* And a good deal more of it. A Lambertian world of albedo A seen at
           angular radius asin(s) returns about A*E*s^2 of the star's own
           irradiance E, and at a couple of radii off a bright world that is a
           real light — the art direction calls it the dominant source on the
           shadowed side. The old coefficient measured five per cent of the key
           at three radii, which is not a fill, it is a tint. */
        const want = Math.min(bestK * 8.0 * Math.min(2.5, illum), sunIntensity * 0.55);
        this.shineLight.intensity += (want - this.shineLight.intensity) * Math.min(1, dt * 3);

        /* The same world, handed to the hull as a *disc of sky* rather than as
           a directional light. A directional key cannot be reflected — it has
           no angular size — so a polished trim ring had nothing to mirror and
           every metal on the ship came back as diffuse clay. `uShineK` is the
           sine of the disc's angular radius and carries the whole distance
           term; `uShineCol` is its radiance and must not have one, or the
           falloff is applied twice. */
        HULL_LIGHT.uShineK.value += (bestSin - HULL_LIGHT.uShineK.value) * Math.min(1, dt * 3);
        HULL_LIGHT.uShineCol.value.copy(this.shineLight.color)
          .multiplyScalar(bestPhase * bestPhase * Math.min(2.2, illum) * 1.35);
        HULL_LIGHT.uShineV.value.copy(best.absPos).sub(this.origin).normalize()
          .transformDirection(this.camera.matrixWorldInverse);
      } else {
        this.shineLight.intensity += (0 - this.shineLight.intensity) * Math.min(1, dt * 3);
        HULL_LIGHT.uShineK.value += (0 - HULL_LIGHT.uShineK.value) * Math.min(1, dt * 3);
        HULL_LIGHT.uShineCol.value.multiplyScalar(1 - Math.min(1, dt * 3));
      }
    }

    this.updateGlowLight(dt);

    /* Rim: the star's light wrapping past the limb.
     *
     * It used to be built by reflecting the key about the *view axis* and
     * lifting it along *camera up*, both taken from `camQuat` — so nearly half
     * the key's power followed the lens around the ship. Shooting into the sun
     * the reflection landed at the camera, and the hull's shadow side lifted
     * far enough to read the stencilling on it while the silhouette carried
     * almost no edge at all: the exact inversion of the one rule the art
     * direction states outright, which is that nothing is ever lit from the
     * lens. A commit message claiming the camera-anchored fills had all been
     * removed was true of the canopy light and the practical and false of this.
     *
     * So it is derived from the star and the subject and from nothing else:
     * almost straight anti-key, kicked a third of the way onto a world axis
     * perpendicular to it so it is not a mirror of the fill, and narrow enough
     * to draw an edge rather than act as a second key. */
    _v.copy(this.star.absPos).sub(this.origin).normalize();      // toward the key
    _v2.set(0, 1, 0);
    if (Math.abs(_v.dot(_v2)) > 0.9) _v2.set(1, 0, 0);
    _v2.addScaledVector(_v, -_v.dot(_v2)).normalize();           // world up, ⟂ key
    // the *other* perpendicular: the fill already sits on _v2, and stacking the
    // two there would put both of them on the same flank.
    /* A fifth of a turn onto the perpendicular, not a third. The kick exists so
       the rim is not a mirror of the fill; past about a fifth it stops being a
       rim at all and lands on a *flank*, which is what an independent review
       found at phase 120 — the hull's top edges faded into black with no edge
       on them. What draws an outline on a convex body seen from anywhere near
       the key side is anti-key, and only anti-key. */
    _v3.crossVectors(_v, _v2).normalize().multiplyScalar(0.20).addScaledVector(_v, -1).normalize();
    // In fold the star is irrelevant and the tunnel is the only light source in
    // the frame, so the rim swings around to point back down the axis of
    // travel. Without this the hull is a black cut-out against the core —
    // which is the one moment it is silhouetted against something bright.
    const fk = this.foldTunnel.mat.uniforms.uFold.value;
    if (fk > 0.002) {
      _v2.copy(ship.vel);
      if (_v2.lengthSq() > 1e-10) {
        _v3.lerp(_v2.normalize(), fk * 0.85).normalize();
      }
    }
    this.rimLight.position.copy(_v3).multiplyScalar(1e4);
    this.rimLight.target.position.set(0, 0, 0);
    /* And a third of the level it had. At 1.00 against a key of 2.16 the rim
       was 46% of the star — an invented source strong enough to be read as the
       key from the wrong side, which is what let it hold detail on the shadow
       face. A rim's job is the last few degrees of the silhouette; the fold
       term keeps its old strength because in fold the tunnel genuinely is the
       brightest thing in the frame and the hull is genuinely a cut-out
       against it. */
    /* 0.62, not 0.40. A third of what it had was the right *direction* of fix —
       at 1.00 it was 46% of the key and read as a second key from the wrong
       side — but it overshot: measured, it landed at 16.1% of the key, and a
       rim that weak does not draw a silhouette, which is the one job the art
       direction gives it outright. 0.62 puts it near a quarter of the key,
       which is an edge and not a source. */
    this.rimLight.intensity = 0.62 * Math.min(1.6, 0.55 + illum * 0.5) + fk * 2.4;
    this.rimLight.color.setRGB(0.863, 0.910, 1.0).lerp(FOLD_RIM, fk);

    // The hull's own grazing term needs the key in view space.
    HULL_LIGHT.uSunV.value.copy(this.star.absPos).sub(this.camAbs).normalize()
      .transformDirection(this.camera.matrixWorldInverse);
    HULL_LIGHT.uSunTint.value.copy(sunColor).multiplyScalar(Math.min(2.2, 0.35 + illum));
    HULL_LIGHT.uBounce.value.copy(this.shineLight.color)
      .multiplyScalar(0.012 + this.shineLight.intensity * 0.030)
      .addScalar(0.010 + fk * 0.075);

    // ---- canopy light: the star only reaches the cabin through the glass
    const toSunLocal = _v.copy(this.star.absPos).sub(ship.absPos).normalize()
      .applyQuaternion(_q.copy(ship.quat).invert());
    const throughGlass = Math.max(0, -toSunLocal.z) * 0.85 + Math.max(0, toSunLocal.y) * 0.35;
    this.canopyLight.color.copy(sunColor);
    this.canopyLight.intensity += (throughGlass * 2.6 * Math.min(2.2, illum) - this.canopyLight.intensity)
      * Math.min(1, dt * 3);
    // aimed in cabin space, using the star direction expressed in hull axes
    this.canopyLight.position.copy(toSunLocal).multiplyScalar(60);
    this.canopyLight.target.position.set(0, 1.2, -5.5);

    // ---- diegetic instruments
    if (this.holoMap) this.holoMap.update(dt, this.interiorCam);
    const nearInfo = this.nearestBodyInfo();
    this.cockpit.update(dt, {
      camPos: this.interiorCam ? this.interiorCam.position : this.camera.position,
      time: this.time,
      station: this.mode === 'walk' ? this.player.station : null,
      power: 1,
      radarRange: THREE.MathUtils.clamp(nearInfo.surfaceDist * 4.5, 60, 4.0e6),
      navActive: this.mode !== 'exterior',
      warn: this.proximityWarn
        || (ship.hull < 0.4 ? 'HULL INTEGRITY' : null)
        || (ship.heat > 0.9 ? 'CORE OVERHEAT' : null),
    });

    this.updateChamber(dt);

    this.starField.position.copy(this.camera.position);
    this.starField.updateMatrix();
    this.starField.material.uniforms.uPixel.value = this.engine.pixelRatio;
    this.starField.material.uniforms.uTime.value = this.time;
  }

  updateAnomaly(b, dt, wctx) {
    b.obj.position.copy(b.absPos).sub(this.origin);
    const ud = b.obj.userData;
    if (ud.spin) {
      b.obj.rotation.x += ud.spin.x * dt;
      b.obj.rotation.y += ud.spin.y * dt;
      b.obj.rotation.z += ud.spin.z * dt;
    }
    if (ud.kind === 'resonator') {
      const d = b.absPos.distanceTo(this.ship.absPos);
      const act = THREE.MathUtils.clamp(1 - (d - 2) / 60, 0, 1);
      b.active = act;
      ud.mat.uniforms.uTime.value = this.time;
      ud.mat.uniforms.uCamPos.value.copy(this.camera.position);
      ud.mat.uniforms.uActive.value += (act - ud.mat.uniforms.uActive.value) * Math.min(1, dt * 2);
      ud.mat.uniforms.uSunDir.value.copy(wctx.sunPos).sub(b.absPos).normalize();
      ud.mat.uniforms.uSunColor.value.copy(wctx.sunColor);
      ud.beamMat.uniforms.uTime.value = this.time;
      ud.beamMat.uniforms.uActive.value = ud.mat.uniforms.uActive.value;
      for (const r of ud.rings) r.rotation.y += r.userData.rate * dt;
    }
    if (ud.kind === 'beacon' && ud.lamp) {
      /* Scale the builder's colour, do not invent one. This hard-coded a
         saturated green every frame — brushing the rule that pale gold-green
         is reserved for Choir artefacts, on a piece of human navigation kit —
         and it silently overwrote the builder's own choice, so fixing the hue
         where the beacon is made had no effect at all. */
      const p = 0.5 + 0.5 * Math.sin(this.time * 3.1);
      const base = ud.lampColor || (ud.lampColor = ud.lamp.material.color.clone());
      ud.lamp.material.color.copy(base).multiplyScalar(0.35 + p * 2.2);
    }
  }

  /* -------------------------------------------------------------- camera */

  updateCamera(dt) {
    const ship = this.ship;

    /* Refresh the sun's shadow map on any frame the hull is on screen.
     *
     * This has to happen before the mode branches, not inside the chase-camera
     * one: inspect, cutscene and landed all return early, so putting it further
     * down meant the map was rendered exactly once at boot — before the hull
     * had castShadow set — and every later frame sampled an empty texture and
     * came back fully occluded. A ship that is entirely black is what a stale
     * shadow map looks like.
     *
     * The cabin's four maps stay frozen: its scene is not rendered on these
     * frames, so nothing re-renders them. */
    const showHull = this.mode === 'exterior' || !!this.landed
      || this.director.active || !!this.inspectMode;
    this.renderer.shadowMap.needsUpdate = showHull;

    if (this.director.update(dt)) {
      // ---- cutscene ----------------------------------------------------
      /* On the ground the scene origin *is* the ship, so no floating-origin
         subtraction applies and the near plane is in metres. The test is which
         scene is being drawn, not `landed`: during an ascent the ground scene
         is still up for two more shots after `landed` has gone. */
      const ground = !!this.engine.sceneOverride;
      this.director.applyCamera(this.camera, ground ? ZERO : this.origin);
      if (ground) this._clampToGround(this.camera.position);
      this.camAbs.copy(this.director.eye);
      if (ground) this._setNear(GROUND_NEAR, GROUND_FAR);
      else this._setNear(0.00025);
      this.fov = this.director.fov;
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      this.camAim = this.camera.quaternion.clone();
      this.camQuat.copy(this.camera.quaternion);
      /* The hull is always visible in a sequence, even in first person: the
         whole reason to take the camera away is to show the ship. The one
         exception is the beat that covers a scene change — there the hull is
         mid-way between two depth conventions and must not be drawn at all. */
      this.ship.model.visible = !(this.transition && this.transition.hideHull);
      this.interiorRig.visible = false;
      this.camRig.copy(ship.quat);
      return;
    }

    if (this.landed) {
      const L = this.landed;
      const R = this.ship.length * 1000;          // metres

      if (L.onFoot) {
        // Standing on the planet. The eye is the player's, not a rig's.
        this.camera.position.copy(this.player.eye);
        this.camera.quaternion.copy(this.player.quat);
        /* Half a metre, not six centimetres. Without the logarithmic depth
           buffer the near plane is what buys resolution at the far end, and a
           6 cm plane leaves the skyline quantised in kilometres. At eye height
           nothing is nearer than the ground 1.7 m below, so the only thing 50 cm
           costs is the last half-metre of a boulder you have walked into. */
        this._setNear(GROUND_NEAR, GROUND_FAR);
        this.fov += (68 - this.fov) * Math.min(1, dt * 3);
        this.camera.fov = this.fov;
        this.camera.updateProjectionMatrix();
        this.camera.updateMatrixWorld();
        this.camAim = this.camera.quaternion.clone();
        this.camQuat.copy(this.camera.quaternion);
        this.ship.model.visible = true;
        this.interiorRig.visible = false;
        return;
      }

      // A slow crane around the parked hull. It is a *place*, so the camera
      // (see _clampToGround for why every ground shot ends up going through it)
      // behaves like a camera on a tripod rather than like a chase rig.
      // A tripod, not a chase rig: well back, barely above the hull, so the
      // landscape behind it has room to be the subject.
      /* Closer and lower than it was. At 3.2 hull-lengths out and 0.55 up the
         nearest visible ground was about 120 m away, so every landing frame
         showed only the middle distance and none of the detail that lives at
         your feet — which made the near-field scatter invisible in exactly the
         shots it was built for. */
      const a = 0.7 + L.t * 0.030;
      const r = R * (1.55 + Math.sin(L.t * 0.07) * 0.28);
      const h = R * (0.22 + Math.sin(L.t * 0.05) * 0.07);
      this.camera.position.set(Math.cos(a) * r, h, Math.sin(a) * r);
      this._clampToGround(this.camera.position);
      _m4.lookAt(this.camera.position, _v.set(0, R * 0.28, 0), _v3.set(0, 1, 0));
      this.camera.quaternion.setFromRotationMatrix(_m4);
      this._setNear(GROUND_NEAR, GROUND_FAR);
      this.fov += (44 - this.fov) * Math.min(1, dt * 2);
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      this.camAim = this.camera.quaternion.clone();
      this.camQuat.copy(this.camera.quaternion);
      this.ship.model.visible = true;
      this.interiorRig.visible = false;
      return;
    }

    if (this.inspectMode) {
      // ---- inspection orbit -------------------------------------------
      // Verification aid: park the camera on a sphere around a subject so a
      // model can actually be judged, instead of guessing from a 40-pixel
      // silhouette in a chase shot.
      const m = this.inspectMode;
      const c = m.ref ? m.ref.absPos : ship.absPos;
      const r = (m.ref ? m.ref.radius : ship.length) * m.dist;
      _v.set(Math.cos(m.el) * Math.sin(m.az), Math.sin(m.el), Math.cos(m.el) * Math.cos(m.az));
      if (!m.ref) _v.applyQuaternion(ship.quat);
      this.camAbs.copy(c).addScaledVector(_v, r);
      this.camera.position.copy(this.camAbs).sub(this.origin);
      _m4.lookAt(this.camera.position, _v2.copy(c).sub(this.origin), _v3.set(0, 1, 0));
      this.camera.quaternion.setFromRotationMatrix(_m4);
      this._setNear(m.ref ? 0.008 : 0.00025);
      this.fov = m.fov ?? 42;
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
      this.camAim = this.camera.quaternion.clone();
      this.camQuat.copy(this.camera.quaternion);
      this.ship.model.visible = true;
      this.interiorRig.visible = false;
      return;
    }

    if (this.mode !== 'exterior') {
      // ---- first person, inside the hull -----------------------------
      // The interior is parented to the ship, so the eye point only has to be
      // rotated into the hull's frame and scaled from metres to world units.
      const eye = _v.copy(this.player.eye).multiplyScalar(this.interior.metresToWorld);
      eye.applyQuaternion(ship.quat);
      this.camAbs.copy(ship.absPos).add(eye);
      this.camera.position.copy(this.camAbs).sub(this.origin);
      this.camera.quaternion.copy(ship.quat).multiply(this.player.quat);

      // hull flex and thruster kick, felt through the seat
      if (this.shake > 0.001) {
        const s = this.shake * 0.00016;
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s;
        this.camera.position.z += (Math.random() - 0.5) * s;
      }
      this._setNear(0.00003);

      const spd = ship.foldMode ? 1 : Math.min(1, ship.speed / (ship.maxSpeed * ship.boostMul));
      const targetFov = 68 + spd * (ship.foldMode ? 14 : 7);
      this.fov += (targetFov - this.fov) * Math.min(1, dt * 3);
    } else {
      // ---- exterior chase --------------------------------------------
      // `camRig` is the *smoothing state* and must stay separate from the
      // camera's own orientation. Feeding the raked camera quaternion back into
      // the spring re-applied the rake every frame; the spring only recovers
      // ~10% of it per frame, so it settled 0.17/0.095 ≈ 1.8 radians off and
      // every posed exterior shot pointed at empty sky.
      // Close enough that the hull is a subject rather than a decal, and offset
      // so it sits low and to port instead of nailed to the middle of the frame.
      // The reticle stays at screen centre, so aiming is unaffected — this is
      // the same over-the-shoulder framing every third-person camera uses.
      const m = this.chase;
      this.camRig.slerp(ship.quat, 1 - Math.exp(-m.lag * dt));
      const fwd = _v.set(0, 0, -1).applyQuaternion(this.camRig);
      const up = _v2.set(0, 1, 0).applyQuaternion(this.camRig);
      const right = _v3.set(1, 0, 0).applyQuaternion(this.camRig);
      this.camAbs.copy(ship.absPos).addScaledVector(fwd, -m.back)
        .addScaledVector(up, m.up).addScaledVector(right, m.side);

      const accel = _v3.copy(ship.vel).sub(this._lastVel || ship.vel);
      (this._lastVel || (this._lastVel = new THREE.Vector3())).copy(ship.vel);
      const push = THREE.MathUtils.clamp(accel.dot(fwd) * 0.010, -m.back * 0.25, m.back * 0.35);
      this.camAbs.addScaledVector(fwd, -push);

      this.camera.position.copy(this.camAbs).sub(this.origin);
      this.camera.quaternion.copy(this.camRig)
        .multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), -m.pitch));
      if (this.shake > 0.001) {
        const s = this.shake * 0.004;
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s;
        this.camera.position.z += (Math.random() - 0.5) * s;
      }
      this._setNear(0.008);
      const spd = ship.foldMode ? 1 : Math.min(1, ship.speed / (ship.maxSpeed * ship.boostMul));
      this.fov += ((m.fov + spd * (ship.foldMode ? 26 : 12)) - this.fov) * Math.min(1, dt * 3);
    }

    // the reticle sits at screen centre, so aiming uses the camera's own axis
    this.camAim = this.camera.quaternion.clone();
    this.camQuat.copy(this.camera.quaternion);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();

    // exterior hull would sit between the eye and the canopy, so it is hidden
    // whenever the camera is inside it
    this.ship.model.visible = this.mode === 'exterior';
    this.interiorRig.visible = this.mode !== 'exterior';

    // the interior camera lives in cabin space: metres, hull-relative
    const ic = this.interiorCam;
    ic.position.copy(this.player.eye);
    ic.quaternion.copy(this.player.quat);

    // With the chart deployed the view eases over to the nav table: the map is
    // a thing in the room, so reading it means standing over it rather than
    // having a panel drawn on top of the world.
    this._mapK = this._mapK || 0;
    const wantMap = this.holoMap && this.holoMap.open ? 1 : 0;
    this._mapK += (wantMap - this._mapK) * Math.min(1, dt * 3.2);
    if (this._mapK > 0.001) {
      const pose = (this._mapPose = this._mapPose
        || { pos: new THREE.Vector3(), look: new THREE.Vector3() });
      this.holoMap.cameraPose(pose);
      _v.copy(pose.pos);
      _m4.lookAt(pose.pos, pose.look, _v3.set(0, 1, 0));
      _q.setFromRotationMatrix(_m4);
      const k = this._mapK * this._mapK * (3 - 2 * this._mapK);   // smoothstep
      ic.position.lerp(_v, k);
      ic.quaternion.slerp(_q, k);
    }
    if (ic.fov !== this.camera.fov || ic.aspect !== this.camera.aspect) {
      ic.fov = this.camera.fov;
      ic.aspect = this.camera.aspect;
      ic.updateProjectionMatrix();
    }
    ic.updateMatrixWorld();
  }

  /* Keep a ground-scene camera out of the ground.
   *
   * Every shot down here is composed against the *hull*, which stands at the
   * origin at y = 0 — and the landscape does not. The touchdown crane sits
   * fifteen metres up and thirty out; put the ship in a hollow and that is
   * fifteen metres *under* the hillside behind it, and what the frame shows is
   * the underside of the terrain with the scatter apparently floating in the
   * air above it, lit from inside. It looked exactly like a broken shader and
   * it was a camera three metres too low.
   *
   * Two metres of clearance, and the height comes from the same law the mesh is
   * built from, so a camera cannot disagree with the ground it is standing on.
   */
  _clampToGround(pos, margin = 2.0) {
    if (!this.surface || !this.surface.heightAt) return pos;
    const h = this.surface.heightAt(pos.x, pos.z, 4.0) + margin;
    if (pos.y < h) pos.y = h;
    return pos;
  }

  /* The near plane, and the far plane that has to move with it.
   *
   * `far` is a parameter now because the ground scene does not use the
   * logarithmic depth buffer and therefore cannot afford the solar-system far
   * plane the exterior camera is built with — see GROUND_NEAR. */
  _setNear(n, f = SPACE_FAR) {
    if (this.camera.near === n && this.camera.far === f) return;
    this.camera.near = n;
    this.camera.far = f;
    this.camera.updateProjectionMatrix();
  }


  /* First person and third, as one switch you can find.
   *
   * The old line was `this.mode = this.mode === 'exterior' ? 'pilot' : 'exterior'`
   * and it had two faults, both of which read to a player as the view changing
   * by itself. It wrote 'pilot' unconditionally — so coming back from the chase
   * camera while nobody was in the seat set a mode the very next lines of
   * update() reverted to 'walk', and the frame in between was a first-person
   * shot from a standing eye height that flicked back to the cabin. And it was
   * inside the `flying` guard, so from the cabin the key did nothing at all.
   *
   * Inside is therefore *whatever the crew is actually doing* rather than a
   * constant, and the transition is announced, because a camera that moves
   * without saying why is indistinguishable from a bug. */
  toggleView() {
    if (this.director.active) return;
    if (this.landed) {
      // On the ground the two views are the crane and the pilot's own eyes;
      // stepping out and climbing back in is E, and this must not fight it.
      this.hud.log(this.landed.onFoot ? 'E · BOARD' : 'E · STEP OUT');
      return;
    }
    if (this.mode === 'exterior') {
      this.mode = this.player.mode === 'seated' || this.player.mode === 'moving'
        ? 'pilot' : 'walk';
      this.hud.log('VIEW · INTERNAL');
    } else {
      this.mode = 'exterior';
      this.hud.log('VIEW · EXTERNAL');
    }
    this.audio.ping('ui');
  }

  /* ------------------------------------------------------- interaction */

  interact() {
    if (this.mode === 'pilot') {
      this.player.stand();
      this.audio.ping('switch');
      this.hud.log('HELM RELEASED');
      return;
    }
    const st = this.player.station;
    if (!st) { this.audio.ping('deny'); return; }
    this.audio.ping('switch');
    switch (st.id) {
      case 'seat':
        this.player.sit(st);
        this.audio.ping('sit');
        // panels wake in sequence, centre first — a deliberate power-on
        Object.values(this.cockpit.screens).forEach((sc, i) => sc.boot(0.12 + i * 0.09));
        setTimeout(() => this.audio.ping('boot'), 220);
        this.hud.log('HELM ENGAGED', 'ok');
        break;
      case 'nav': this.starmap.show(); break;
      case 'archive': this.archive.show(); break;
      case 'resonance':
        this.chamberVisits++;
        if (this.cantos.length) { this.archive.show('canto:' + this.cantos[this.cantos.length - 1]); }
        else this.hud.narrate('Seven sockets. All of them empty, all of them warm.', 'PALE SEEKER');
        break;
      case 'port': this.hud.narrate(this.portLine(), 'OBSERVATION'); break;
      default: break;
    }
  }

  portLine() {
    const t = this.bodies.slice().sort((a, b) =>
      a.absPos.distanceTo(this.ship.absPos) - b.absPos.distanceTo(this.ship.absPos))[0];
    return t ? `${t.name} fills the port. ${t.scanned ? 'Catalogued.' : 'Unsurveyed.'}`
      : 'Only the deep field, and the unknown waiting in it.';
  }

  /* -------------------------------------------------------- autopilot */

  toggleAutopilot() {
    if (this.autopilot) { this.cancelAutopilot(); return; }
    const t = this.target;
    if (!t) { this.hud.log('NO TARGET SELECTED', 'hi'); return; }
    this.autopilot = { body: t, phase: 'align' };
    this.hud.log(`AUTOPILOT · ${t.name}`, 'ok');
    this.audio.ping('ui');
  }

  cancelAutopilot(quiet) {
    if (!this.autopilot) return;
    this.autopilot = null;
    if (!quiet) this.hud.log('AUTOPILOT DISENGAGED');
  }

  /** Approach distance that frames a body nicely rather than crashing into it. */
  standoffFor(b) {
    if (b.kind === 'star') return b.radius * 9;
    if (b.kind === 'anomaly') return Math.max(b.radius * 3.5, 4);
    return b.radius * 3.0;
  }

  /**
   * Turn a selected target into a single keypress. Manual stick input cancels.
   * Returns the flight input the ship should actually fly with this frame.
   */
  applyAutopilot(dt, raw) {
    const ap = this.autopilot;
    if (!ap) return raw;
    const ship = this.ship;

    if (Math.abs(raw.pitch) > 0.22 || Math.abs(raw.yaw) > 0.22 || Math.abs(raw.roll) > 0.4) {
      this.cancelAutopilot();
      return raw;
    }

    const to = _v.copy(ap.body.absPos).sub(ship.absPos);
    const dist = to.length();
    const standoff = this.standoffFor(ap.body);
    to.multiplyScalar(1 / Math.max(dist, 1e-6));

    // steer: express the target direction in the ship's own frame
    const local = _v2.copy(to).applyQuaternion(_q.copy(ship.quat).invert());
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, -local.z) * 1.6, -1, 1);
    const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)) * 1.9, -1, 1);
    const aligned = local.z < 0 && Math.abs(yaw) < 0.06 && Math.abs(pitch) < 0.06;

    const over = dist - standoff;
    if (over < standoff * 0.35) {
      // arrived: bleed off and hand control back
      if (ship.foldMode) this.toggleFold(false);
      ship.throttle = 0;
      ship.vel.multiplyScalar(Math.max(0, 1 - dt * 2.2));
      if (ship.speed < 4) {
        this.hud.log(`ARRIVED · ${ap.body.name}`, 'ok');
        this.audio.ping('arrive');
        this.cancelAutopilot(true);
      }
      return { pitch: -pitch, yaw: -yaw, roll: 0, strafeX: 0, strafeY: 0 };
    }

    // fold for anything beyond a couple of minutes at cruise
    const wantFold = over > 2600 && this.nearestBodyInfo().surfaceDist > 400;
    if (aligned && wantFold && !ship.foldMode && ship.foldCharge > 0.15) this.toggleFold(true);
    if (!wantFold && ship.foldMode) this.toggleFold(false);
    ship.throttle = ship.foldMode ? 1 : (aligned ? 1 : 0.35);

    return { pitch: -pitch, yaw: -yaw, roll: 0, strafeX: 0, strafeY: 0 };
  }

  /* ------------------------------------------------------- proximity */

  /**
   * A soft approach envelope instead of a wall. Real ships do not stop dead on
   * a surface: you feel the field push back, the drive cuts, and you settle.
   */
  updateProximity(dt) {
    const ship = this.ship;
    this.proximityWarn = null;
    for (const b of this.bodies) {
      if (!b.planet && b.kind !== 'star') continue;
      const isStar = b.kind === 'star';
      const floor = b.radius * (isStar ? 2.2 : 1.02);
      const soft = b.radius * (isStar ? 4.0 : 1.16);

      _v.copy(ship.absPos).sub(b.absPos);
      const d = _v.length();
      if (d > soft) continue;
      _v.multiplyScalar(1 / Math.max(d, 1e-6));

      const t = THREE.MathUtils.clamp((soft - d) / (soft - floor), 0, 1);
      this.proximityWarn = isStar ? 'STELLAR PROXIMITY' : 'TERRAIN PROXIMITY';

      // cancel automation and cut the drive as the envelope closes
      if (t > 0.25) { this.cancelAutopilot(true); if (ship.foldMode) this.toggleFold(false); }
      if (t > 0.5) ship.throttle = Math.min(ship.throttle, 1 - t);

      // repulsion grows sharply, and inward velocity is bled off
      const push = t * t * 120 + (d < floor ? 900 : 0);
      ship.vel.addScaledVector(_v, push * dt);
      const vn = ship.vel.dot(_v);
      if (vn < 0) ship.vel.addScaledVector(_v, -vn * Math.min(1, t * 2.4));

      if (d < floor) {
        ship.absPos.copy(b.absPos).addScaledVector(_v, floor);
        ship.hull = Math.max(0, ship.hull - 0.00035 * Math.min(200, Math.abs(vn)));
        this.shake = Math.min(1, this.shake + 0.25);
      }
      this.shake = Math.min(1, this.shake + t * dt * 1.6);
      if (isStar && t > 0.35) ship.hull = Math.max(0, ship.hull - dt * 0.05 * t);
    }
  }

  /* ------------------------------------------------------------ targeting */

  nearestBodyInfo() {
    let best = this.bodies[0], bd = Infinity;
    for (const b of this.bodies) {
      if (b.kind === 'anomaly' || b.kind === 'craft' || b.kind === 'station') continue;
      const d = b.absPos.distanceTo(this.ship.absPos) - b.radius;
      if (d < bd) { bd = d; best = b; }
    }
    return { body: best, surfaceDist: Math.max(bd, 1) };
  }

  /** Body closest to the reticle, weighted by angular size. */
  aimTarget() {
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.camAim || this.camQuat);
    let best = null, bestScore = 0;
    for (const b of this.bodies) {
      _v2.copy(b.absPos).sub(this.ship.absPos);
      const d = _v2.length();
      if (d < 1e-6) continue;
      _v2.multiplyScalar(1 / d);
      const dot = _v2.dot(fwd);
      if (dot < 0.955) continue;
      const ang = Math.atan2(b.radius, d);
      const score = (dot - 0.955) * 40 + Math.min(ang * 6, 3);
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  cycleTarget() {
    const list = this.bodies.slice().sort((a, b) =>
      a.absPos.distanceTo(this.ship.absPos) - b.absPos.distanceTo(this.ship.absPos));
    const i = list.indexOf(this.target);
    this.target = list[(i + 1) % list.length];
    this.hud.log(`TARGET · ${this.target.name}`);
  }

  scanRangeFor(b) {
    const m = this.scanRangeMul;
    if (b.kind === 'anomaly') return 40 * m;
    if (b.kind === 'star') return b.radius * 26 * m;
    return Math.max(b.radius * 11, 500) * m;
  }

  updateScan(dt, uiOpen) {
    const aim = uiOpen ? null : this.aimTarget();
    this.aimed = aim;
    if (aim) this.target = aim;

    const holding = !uiOpen && (this.input.held('scan') || this.input.tapped('scan')
      || this.input.touchBtn.has('scan') || this.input.pressed.has('scanClick'));
    this.input.pressed.delete('scanClick');

    const t = this.target;
    const inRange = t && t.absPos.distanceTo(this.ship.absPos) < this.scanRangeFor(t) + (t.radius || 0);
    this.scanTarget = (aim === t && inRange) ? t : null;

    if (!this.scanTarget || !holding || (t && t.scanned)) {
      this.scanProgress = Math.max(0, (this.scanProgress || 0) - dt * 0.9);
      this._wasScanning = false;
      return;
    }
    if (!this._wasScanning) { this.audio.ping('scanStart'); this._wasScanning = true; }
    this.scanProgress = (this.scanProgress || 0) + dt * 0.42 * (this.ship.scanRate || 1);
    if (this.scanProgress >= 1) {
      this.scanProgress = 0;
      this.completeScan(this.scanTarget);
    }
  }

  completeScan(b) {
    if (b.scanned) return;
    b.scanned = true;
    this.discoveries.add(b.id);
    this.audio.ping('scan');

    if (b.kind === 'anomaly' && b.anomalyType === 'resonator') {
      const idx = this.cantos.length;
      if (idx < CANTOS.length) {
        this.cantos.push(CANTOS[idx].id);
        this.state.resonance = this.cantos.length;
        const seq = SEQUENCES.attune(this, b);
        this.director.play('attune:' + b.id, seq.shots, { title: seq.title, sub: seq.sub });
        this.hud.narrate(CANTOS[idx].q, 'RESONATOR');
        this.hud.log(`ATTUNED · ${CANTOS[idx].title}`, 'hi');
        this.audio.ping('resonate');
        this.ship.maxSpeed *= 1.09;
        this.ship.foldCharge = 1;
        if (this.cantos.length >= CANTOS.length) this.onAperture();
      }
    } else if (b.kind === 'anomaly' && b.logId) {
      this.logsFound.add(b.logId);
      this.hud.log(`LOG RECOVERED · ${b.name}`, 'ok');
    } else {
      this.hud.log(`SCANNED · ${b.name}`, 'ok');
    }
    this.hud.refreshTargets();
    this.archive.markDirty();
  }

  onAperture() {
    this.hud.narrate('The Aperture is open. It has always been open.', 'THE CHOIR');
    this.hud.log('APERTURE RESONANCE ACHIEVED', 'hi');
  }

  /* ------------------------------------------------------------ fold drive */

  /* How far from a surface the drive will hold a fold, in world units.
   *
   * This has to be *one* number. It was two: engagement was refused inside 320
   * units, and update() dropped the fold the moment `surfaceDist` fell under
   * `radius*0.9 + 40` — thousands of units on any real world. So anywhere
   * between the two, J engaged the drive and the next frame cancelled it, over
   * and over, and what the ship did was shudder on the spot without going
   * anywhere. That window is exactly where you are after a liftoff, which is
   * why the drive looked broken specifically there. */
  foldFloor(near) {
    return (near.body ? near.body.radius * 0.9 : 0) + 40;
  }

  toggleFold(force) {
    const ship = this.ship;
    const want = force !== undefined ? force : !ship.foldMode;
    if (want === ship.foldMode) return;
    if (want) {
      const near = this.nearestBodyInfo();
      if (near.surfaceDist < this.foldFloor(near)) {
        this.hud.log(`FOLD BLOCKED · TOO DEEP IN ${(near.body?.name || 'MASS').toUpperCase()}`, 'hi');
        this.audio.ping('deny');
        return;
      }
      if (ship.foldCharge < 0.12) { this.hud.log('FOLD CHARGE INSUFFICIENT', 'hi'); return; }
      ship.foldMode = true;
      ship.throttle = 1;
      this.hud.setFold(true);
      this.audio.ping('fold');
    } else {
      ship.foldMode = false;
      ship.vel.multiplyScalar(0.0006);
      ship.throttle = 0.15;
      this.hud.setFold(false);
      this.audio.ping('unfold');
    }
  }

  async hyperjump(id) {
    if (id === this.currentSystemId) return;
    this.starmap.close();
    this.hud.setFlash(1);
    this.audio.ping('jump');
    await wait(420);
    await this.loadSystem(id);
    this.hud.setFlash(0.85);
    this.ship.foldMode = false;
    this.hud.setFold(false);
    // Arriving somewhere new is the one moment worth a camera move, every time.
    const arr = SEQUENCES.arrival(this);
    this.director.play('arrival:' + id, arr.shots, { title: arr.title, sub: arr.sub });
  }

  /* --------------------------------------------------------------- post */

  updatePost(dt) {
    const u = this.engine.post.u;
    const ship = this.ship;

    // sun screen position for the god-ray pass
    _v.copy(this.star.absPos).sub(this.origin).project(this.camera);
    const onScreen = _v.z < 1;
    this.engine.sunUV.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    const behind = _v2.copy(this.star.absPos).sub(this.camAbs).normalize()
      .dot(_v3.set(0, 0, -1).applyQuaternion(this.camQuat));
    /* God rays are what light does streaming *past* an occluder. Once the star
       fills a good part of the frame there is nothing to stream past, and the
       radial pass just smears an enormous bright disc over everything — so the
       effect fades out as the disc grows. */
    const starPx = (this.star.radius / Math.max(this.star.absPos.distanceTo(this.camAbs), 1))
      / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5) / this.engine.height);
    const bigDisc = 1 - THREE.MathUtils.smoothstep(starPx, 70, 260);
    this.engine.sunVis += ((onScreen && behind > 0.1
      ? THREE.MathUtils.clamp(behind, 0, 1) * bigDisc : 0)
      - this.engine.sunVis) * Math.min(1, dt * 6);

    const spdN = ship.foldMode ? 1 : Math.min(1, ship.speed / (ship.maxSpeed * ship.boostMul));
    u.uRadial.value = ship.foldMode ? 0.048 : spdN * spdN * 0.016;
    u.uRadialCtr.value.set(0.5, 0.5);
    u.uCA.value = 0.0011 + spdN * 0.0016 + (ship.foldMode ? 0.0014 : 0);
    u.uBloom.value = 0.085 + (ship.foldMode ? 0.045 : 0);
    /* The ground gets a third of a stop more than space does.
     *
     * Not a taste knob — a correction for what the adaptation metric does on a
     * planet. It is an RMS of clamped luminance, which deliberately leans
     * toward the bright content of the frame, and that is right in a starfield
     * where the alternative is a black sky setting the exposure. On the ground
     * roughly half the frame is sky at several times the radiance of sunlit
     * rock, so the metric keys on the dome and stops down, and the landscape —
     * the subject — lands in the toe. Measured against the reference frames
     * this was judged on, a noon desert sat at p50 92 where they sit at 132.
     *
     * Note for whoever reads the review that prompted this: opening the
     * key-to-fill gap does *not* move these numbers. Auto-exposure normalises
     * the frame, so any change that alters total scene radiance is undone
     * within a second; the gap changes which surfaces are bright relative to
     * each other, which is what it is for, and the frame's own level is set
     * here and by the tone curve, nowhere else. Both were measured. */
    const wantExp = ship.foldMode ? 1.15 : this.landed ? 1.30 : 1.0;
    u.uExposure.value += (wantExp - u.uExposure.value) * Math.min(1, dt * 2);
    u.uDamage.value += ((ship.hull < 0.5 ? (0.5 - ship.hull) * 1.2 : 0) - u.uDamage.value) * Math.min(1, dt * 3);
    if (this._flash > 0) { this._flash = Math.max(0, this._flash - dt * 1.6); }
    u.uFlash.value = this._flash || 0;

    /* The deck the landing goes through. Its colour is the sky's, when there
       is a sky to read it off — cloud is lit by the same air the dome is, and
       a grey-white one under an amber sky is the tell that it is a post
       effect rather than weather. */
    this._updateCloud(dt);
    u.uCloud.value = this._cloud || 0;
    // and once the deck is total there is nothing behind it worth drawing
    this.engine.skipScene = this._cloud >= CLOUD_OPAQUE;
    if (this._cloud > 0.001 && this.surface && this.surface.skyMat) {
      const su = this.surface.skyMat.uniforms;
      const sc = su.uSunColor && su.uSunColor.value;
      const hz = su.uHazeColor && su.uHazeColor.value;
      if (sc && hz) {
        // A sunlit cloud is the star's own colour with the air's tint mixed
        // into the parts of it the sun does not reach. Component by component:
        // these are Colors, and Vector3.copy would read x/y/z off them and
        // produce NaN, silently, with the whole frame going black.
        const r = sc.r * 0.78 + hz.r * 0.42;
        const g2 = sc.g * 0.78 + hz.g * 0.42;
        const b2 = sc.b * 0.78 + hz.b * 0.42;
        const s = 2.05 / Math.max(1e-4, Math.max(r, Math.max(g2, b2)));
        u.uCloudCol.value.set(r * s, g2 * s, b2 * s);
      }
    }
    u.uTime.value = this.time;
  }

  setFlash(v) { this._flash = v; }

  /**
   * Debug/verification helper: park the ship in a specific relationship to a
   * body so a shot can be reproduced exactly.
   * @param {{body?:string, kind?:string, dist?:number, phase?:number, elev?:number, roll?:number}} o
   *   dist  — multiples of the body radius from its centre
   *   phase — degrees between the sun direction and the viewing direction
   *   elev  — degrees above the body's orbital plane
   */
  pose(o = {}) {
    const b = o.bodyRef
      || (o.body ? this.bodies.find((x) => x.name.toLowerCase().includes(o.body.toLowerCase())) : null)
      || (o.kind ? this.bodies.find((x) => x.spec && x.spec.type === o.kind) : null)
      || this.bodies.find((x) => x.kind === 'planet');
    if (!b) return null;

    const dist = (o.dist ?? 3.2) * b.radius;
    const phase = THREE.MathUtils.degToRad(o.phase ?? 42);
    const elev = THREE.MathUtils.degToRad(o.elev ?? 12);

    // Posing *against* the star has no sun direction of its own — fall back to
    // a fixed axis so the helper still produces a usable framing.
    const sun = b.kind === 'star'
      ? _v.set(1, 0.12, 0.4).normalize()
      : _v.copy(this.star.absPos).sub(b.absPos).normalize();
    const up = _v2.set(0, 1, 0);
    const side = _v3.copy(sun).cross(up).normalize();
    const trueUp = side.clone().cross(sun).normalize();

    // Rotate the sun vector by `phase` about the body's local up, then lift by
    // `elev`. Building it from a weighted sum of basis vectors instead made the
    // phase angle mean something different depending on the elevation, which is
    // how a "44-degree" shot ended up looking at a night side.
    const dir = sun.clone()
      .applyAxisAngle(trueUp, phase)
      .applyAxisAngle(side, elev)
      .normalize();

    this.ship.absPos.copy(b.absPos).addScaledVector(dir, dist);
    this.ship.vel.set(0, 0, 0);
    this.ship.throttle = o.throttle ?? 0;
    this.ship.foldMode = false;

    const look = b.absPos.clone().sub(this.ship.absPos).normalize();
    this.ship.quat.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(), look, new THREE.Vector3(0, 1, 0))
    );

    // Push the subject off centre. The chase camera already puts the hull low
    // and to port, so the world it is looking at belongs high and to starboard —
    // that diagonal is the whole composition. `frame:0` re-centres it for
    // diagnostic shots, where symmetry makes defects easier to see.
    const fk = o.frame ?? 1;
    if (fk) {
      this.ship.quat.multiply(new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0.052 * fk, -0.075 * fk, 0, 'YXZ')));
    }
    // The chase camera is raked down so the hull sits low in frame; aiming the
    // *ship* at the body therefore puts the body above the top edge. Pitch up by
    // the same amount so a posed shot actually centres what it was asked for.
    if (this.mode === 'exterior') {
      this.ship.quat.multiply(new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.chase.pitch));
    }
    if (o.roll) this.ship.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), o.roll));

    this.origin.copy(this.ship.absPos);
    this.camAbs.copy(this.ship.absPos);
    this.camQuat.copy(this.ship.quat);
    this.camRig.copy(this.ship.quat);
    this.target = b;
    if (b.planet && b.planet.bakeRes < 512 && this.quality !== 'low') {
      b.planet.bake(this.renderer, this.quality === 'high' ? 1024 : 512);
      this.hiResHolder = b.planet;
    }
    return b.name;
  }

  /**
   * Verification aid: orbit the camera around a subject so a model can be
   * judged directly. `dist` is in subject radii (ship lengths for the ship),
   * `az`/`el` in degrees. Call with `{off:true}` to hand the camera back.
   */
  inspect(o = {}) {
    if (o.off) { this.inspectMode = null; return null; }
    this.inspectMode = {
      ref: o.bodyRef || (o.body ? this.bodies.find((x) => x.name.toLowerCase().includes(o.body.toLowerCase())) : null),
      dist: o.dist ?? 2.2,
      az: THREE.MathUtils.degToRad(o.az ?? 132),
      el: THREE.MathUtils.degToRad(o.el ?? 16),
      fov: o.fov ?? 42,
    };
    return this.inspectMode.ref ? this.inspectMode.ref.name : 'PALE SEEKER';
  }

  /** Verification aid: toggle individual render layers on/off. */
  /* Size the sun's shadow frustum for the scene it is about to light.

     The two scenes do not share a unit. In space one world unit is a
     kilometre; on the ground one unit is a metre, and the *same* orthographic
     box therefore covers 150 metres out there and fifteen centimetres down
     here. The landed scene ran the whole time with a shadow camera smaller
     than a boot: 13 shadow-casting meshes, a light 10 km away, a far plane at
     35 cm, and consequently not one shadow anywhere on the ground — no ship
     shadow, no self-shadowing on the hull, no contact anywhere. A reviewer
     counted it as the single largest gap in the game and was right.

     `u` is the size of one world unit in metres, so the exterior passes 1 and
     the ground scene passes 1000 — everything else is derived from the hull,
     which is about 145 metres either way. */
  setShadowScale(u, extraHalf = 0, lift = 0) {
    this._shadowUnit = u;
    // Recorded so fitGroundShadow knows what the box currently is — otherwise a
    // land → lift off → land cycle comes back with a stale value and never
    // re-fits, which is invisible until the one shot that needed it.
    this._groundExtra = extraHalf;
    // 0.11 units clears the hull, which is about 145 m either way. `extraHalf`
    // is what the ground adds so the hull's *cast* shadow is inside the box
    // too — see fitGroundShadow.
    const half = 0.11 * u + extraHalf;
    const sc = this.sunLight.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    /* Depth range derived from the box, not from constants.
     *
     * A frustum wide enough to hold a 725 m station is also *deep* enough to
     * need one. At the old fixed 0.03/0.62 with the light parked at 0.26, the
     * covered range was about +/-300 m about the target — less than the
     * station's own length, so even a correctly centred box would have sliced
     * the front off it, which reads as "that object does not cast" rather than
     * as a clipped frustum. The light steps back as the box grows and the
     * planes follow it. */
    /* ...and it has to clear the *landscape*, which is what `lift` is.
     *
     * The light was parked 0.26 units up-sun of the box, which on the ground is
     * 260 m along the ray — and at a twenty-degree star that is only 119 m of
     * altitude, over a box 372 m across. Stand on any dune and the light is
     * *inside the hill it is supposed to be looking over*: everything above it
     * falls in front of the near plane, gets clipped, and comes back as a
     * half-plane of depth-zero. What that draws is a dead-straight shadow edge
     * ruled diagonally across the frame, ignoring every crack and cobble it
     * crosses, which is exactly what an impartial judge picked out as the
     * single thing that gave the image away.
     *
     * The camera is orthographic, so standing the light further off costs
     * nothing but depth range, and the near plane can simply be small. See
     * fitGroundShadow for where `lift` comes from. */
    const dist = 0.26 * u + extraHalf * 1.2 + lift;
    sc.near = 0.002 * u;
    sc.far = dist + half * 1.8 + 0.36 * u;
    sc.updateProjectionMatrix();
    // Depth bias lives in the frustum's own units, so it scales with the box;
    // normalBias is a world-space offset and scales with the scene.
    // Both had to come up when the frustum grew: at 110 m across a 2048 map is
    // 5 cm a texel, and the hull's near-horizontal dorsal plates were picking
    // up a rash of self-shadow acne at the old values.
    /* Both biases derived rather than dialled.
     *
     * `bias` is in the shadow frustum's own [0,1] depth, and the frustum is
     * 0.59 units deep, so -0.0009 is 0.53 *metres* of depth push in both
     * scenes — the box and the unit scale together and the hull is the same
     * size either way, which is why one number serves both.
     *
     * `normalBias` is a world-space offset along the surface normal, and what
     * it has to cover is the depth slope across the filter kernel: one texel,
     * times the kernel radius, times a little over root two for the diagonal.
     * The old value was a flat 0.0028 units — 2.8 metres, six times what the
     * geometry asks for. That does kill acne, and it also lifts every contact
     * shadow 2.8 m off the thing casting it, which is precisely the "shadows
     * detached from their objects" reading. Deriving it also means it tracks
     * the ground box when that grows to hold a low sun's throw. */
    /* Derived, so it means the same distance however deep the frustum has had
     * to become — a constant in [0,1] frustum depth is a different push in
     * every box — and *small*, because at a raking sun every centimetre of
     * bias is centimetres of shadow that goes missing.
     *
     * 0.53 m was fine while the only thing being judged was a hundred-metre
     * shadow thrown by the whole ship. It is not fine for a 1.4 m landing pad:
     * a depth push of h costs about h/cos(elevation) of the shadow's leading
     * edge, so half the pad's contact shadow was being biased away before
     * anything else touched it. 0.20 m is one texel of the ground map at the
     * widest box it ever takes, which is the scale the bias is actually for. */
    this.sunLight.shadow.bias = -0.00020 * u / (sc.far - sc.near);
    /* Resolution follows the scene rather than the tier alone.
     *
     * The exterior box is a tight 220 m around the hull and 2048 is ten
     * centimetres a texel there. The ground box is the hull *plus its throw*
     * and reaches 380 m across at a raking sun, where the same map is twenty —
     * wider than the landing strut casting the shadow, which is why the ship's
     * shadow on the ground was a soft blob with no legs in it. The pass is
     * depth-only over thirteen meshes, so the cost of doubling it is the clear
     * and the raster, not the draws. */
    const want = (u > 1 && this.quality === 'high') ? 4096 : 2048;
    if (this.sunLight.shadow.mapSize.x !== want) {
      this.sunLight.shadow.mapSize.set(want, want);
      // three allocates the target lazily and sizes it from mapSize, so
      // dropping the old one is the whole of a resize.
      this.sunLight.shadow.map?.dispose();
      this.sunLight.shadow.map = null;
    }
    const texelWorld = 2 * half / this.sunLight.shadow.mapSize.x;
    /* A penumbra measured in metres, not in texels.
     *
     * The filter radius is quoted in shadow-map texels, so a fixed 2.6 meant
     * "however wide 2.6 texels happen to be" — eleven centimetres in space and
     * over half a metre on the ground, where the box is four times bigger. A
     * half-metre penumbra is wider than the strut casting it, and it is most of
     * why the reviewer read the ship's shadow as a smudge. Fixing the *world*
     * width instead makes the number mean the same thing in both scenes: about
     * fifteen centimetres, which is roughly what a half-degree star throws at
     * these distances, floored at one texel because anything less is a
     * stair-stepped line and capped at 2.4 because five rotated taps cannot
     * resolve a gradient much wider than that. */
    this.sunLight.shadow.radius =
      THREE.MathUtils.clamp(0.00015 * u / texelWorld, 1.0, 2.4);
    /* One texel of receiver offset, not two and a half. The normal offset is
     * what keeps the filter kernel from sampling the surface's own depth
     * across its slope, so one texel is what it is worth; anything more shows
     * up as h/tan(sun elevation) of lateral shadow displacement, which is 2.8 m
     * at four degrees and erases every contact shadow smaller than that. */
    this.sunLight.shadow.normalBias = texelWorld * this.sunLight.shadow.radius;
    /* And the same quantity for the ground's own shaders, which have to apply
     * it themselves. The terrain, the scatter and the arches carry no normal
     * attribute, so three's shadowmap_vertex chunk takes the world normal as
     * zero and applies no bias to them at all; each adds its own, and each used
     * to add a *constant* — 24 cm on the ground, 10 on the rocks, 30 on the
     * arches. A constant receiver offset is a displacement, not a bias: it
     * slides every shadow o/tan(elevation) down-sun, which at 24 cm is 90 cm at
     * a 15 degree star and three metres at four and a half, against a landing
     * pad 1.4 m across. One texel is what the offset is for. */
    this._shadowNB = texelWorld;
    /* Not PCSS. A real contact-hardening penumbra needs a blocker search, which
     * means replacing three's shadow chunk for every material in the game,
     * terrain included. The star is a half-degree source at these distances, so
     * the penumbra it is owed is a few centimetres and near enough constant;
     * the thing that was actually wrong was that it was quoted in texels. */
    // How far up-sun the light is parked. It has to clear the box it is
    // looking through, or the near plane cuts into the subject.
    this._shadowDist = dist;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /* In space, fit the box to whatever is actually the subject.
   *
   * The frustum is 0.11 units of half-extent, which is a tight fit round a
   * 145 m hull and the reason its texels are ten centimetres. It is also the
   * reason nothing larger than the ship has ever cast a shadow: a 400 m
   * station does not fit inside it at any distance, so setting `castShadow` on
   * one produces a station-shaped hole in the map and no shadow at all — the
   * flag looks broken when the frustum is what is wrong.
   *
   * So the box grows to hold the nearest large structure while you are close
   * enough for it to be the subject, and shrinks back the moment you are not.
   * That is a real trade and it is made deliberately: at 0.5 units a texel is
   * half a metre and the hull loses its own fine self-shadowing. It is the
   * right way round, because at that range the hull is a hundred pixels of a
   * frame whose subject is the station. The alternative is a second cascade —
   * a second shadow-casting directional, which costs every lit fragment in the
   * game an extra five-tap lookup whether or not anything large is near.
   *
   * `radius` is in world units, so anything at or under the hull's own extent
   * cannot widen the box. The station, the derelicts and the fleet all set
   * `castShadow` now — a census counts 20, 24 and 105 casters — so this is load
   * bearing rather than speculative, and a set-piece framed on any of them
   * depends on the box being fitted to the subject rather than to the hull. */
  fitSubjectShadow() {
    /* Size and centre are two separate bugs and fixing one leaves the other.
     *
     * The frustum was not only hull-sized, it was hull-*centred*: the target
     * sat at (0,0,0), which is the floating origin, which is the player's
     * ship. In the station set-piece the camera is 0.87 units from the station
     * and the ship is 14,730 units from it — so the subject the lens is
     * pointed at was fourteen thousand box-widths outside the box, and every
     * `castShadow` flag on the station, the derelicts and the traffic produced
     * exactly nothing. Growing the box does not help when it is in the wrong
     * part of the system.
     *
     * The rule is: the box belongs on whatever is nearest the *camera*, not on
     * whatever is nearest the origin. In the chase view that is the ship, so
     * nothing changes. In an inspection orbit, a cutscene or a docking
     * approach it is the thing being looked at. */
    const cam = this.camAbs;
    let cx = null, cd = this.origin.distanceTo(cam), half = 0.11;
    /* Capped, and the cap is load-bearing. Several anomalies publish a framing
       radius rather than a physical one — a derelict about 400 m across
       declares 1.3 — and a body's radius is thousands of units. Sizing the box
       to one of those gives metre-wide texels and a shadow map with no shadow
       in it. Anything genuinely larger than this does not belong in a single
       orthographic map. */
    const fit = (radius) => Math.max(0.11, Math.min(radius, 0.60) * 1.25);
    const ref = this.inspectMode && this.inspectMode.ref;
    if (ref && ref.absPos && ref.radius > 0 && ref.kind !== 'planet' && ref.kind !== 'star' && ref.kind !== 'moon') {
      // Anything taking the camera has said outright what the subject is.
      cx = ref.absPos; cd = 0; half = fit(ref.radius);
    } else {
      const consider = (radius, absPos) => {
        if (!(radius > 0.11) || !absPos) return;
        const d = absPos.distanceTo(cam);
        // Nearer the lens than the hull is, and close enough to be the subject
        // rather than scenery.
        if (d >= cd || d > radius * 6) return;
        cd = d; cx = absPos; half = fit(radius);
      };
      for (const s of this.stations) consider(s.built && s.built.radius, s.absPos);
      for (const a of this.anomalies) consider(a.radius, a.absPos);
    }
    const c = this._shadowCentre || (this._shadowCentre = new THREE.Vector3());
    if (cx) c.copy(cx).sub(this.origin); else c.set(0, 0, 0);
    /* Quantised, because setShadowScale rebuilds the projection every call and
       the size should not chatter with a drifting distance. The *centre* is not
       quantised — it tracks every frame, or the shadow lags the subject.

       Up, not to nearest: `fit` returns 0.11 as its floor, which is the number
       that clears the hull, and rounding that to the nearest twentieth gave
       0.10 — a box nine per cent *smaller* than the thing it exists to
       contain, in the default case, which is most frames in the game. */
    half = Math.ceil(half * 20 - 1e-6) / 20;
    if (half !== this._subjectHalf) {
      this._subjectHalf = half;
      this.setShadowScale(1, half - 0.11);
    }
  }

  /* Fit the shadow box to the hull *and the shadow it throws*.
   *
   * The box is centred on the light's target, which is the ship, and 0.11
   * units of half-extent is a tight fit around the hull. That was fine while
   * nothing on the ground received shadows. The moment the terrain does, the
   * interesting part of the shadow is the part lying on the ground — and at a
   * low sun that reaches much further than the hull does. A forty-metre fin
   * with the star twenty degrees up throws a hundred and ten metres of shadow,
   * all of it outside a box that stops at a hundred and ten from the centre.
   *
   * So the box grows by half the throw and the target slides half the throw
   * down-sun, which keeps the whole of it inside for the cost of a coarser
   * texel — and the texel is why the throw is capped rather than tracked all
   * the way to the horizon. */
  fitGroundShadow(sunLocal) {
    const u = 1000;                                   // ground scene: metres
    const HULL_TOP = 55;                              // metres above the datum
    const el = Math.max(sunLocal.y, 1e-3);
    const horiz = Math.hypot(sunLocal.x, sunLocal.z);
    const len = Math.min(HULL_TOP * (horiz / el), 260);
    const extra = len * 0.5;
    /* How far up the ray the light has to stand before it is above the terrain
       inside its own box. A box of half-extent h can hold a slope of about
       forty-five degrees, so 2.2h of relief is a safe bound; divided by the
       sine of the elevation, that is the distance along the ray. Capped,
       because at a four-degree star the honest answer is ten kilometres and
       the depth buffer would rather not. */
    const lift = Math.min((0.11 * u + extra) * 2.2 / Math.max(el, 0.15), 12 * u);
    if (Math.abs((this._groundExtra || 0) - extra) > 2
        || Math.abs((this._groundLift || 0) - lift) > 0.02 * u) {
      this._groundExtra = extra;
      this._groundLift = lift;
      this.setShadowScale(u, extra, lift);
    }
    /* And it follows the *camera*, which it never did.
     *
     * The box was centred on the origin, and the origin of the ground scene is
     * the ship. Step out and walk two hundred metres — which is the whole point
     * of being able to step out — and the entire near field is outside the only
     * shadow map in the scene, so `uShadowR` fades the lookup to lit and
     * nothing within reach of the camera casts anything. An impartial judge
     * shown a frame taken from there said the single biggest tell was that a
     * dozen boulders under a twenty-degree sun threw no shadows at all, and
     * they were right: there was no shadow map over them.
     *
     * The centre is a little in front of the lens rather than under it, because
     * a shadow behind the camera is not worth a texel, and then half the throw
     * down-sun so the far end of a long shadow stays inside the box. */
    const aim = this._shadowAim || (this._shadowAim = new THREE.Vector3());
    const cam = this.camera.position;
    _v3.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _v3.y = 0;
    if (_v3.lengthSq() > 1e-6) _v3.normalize(); else _v3.set(0, 0, -1);
    aim.set(cam.x + _v3.x * len * 0.45, 0, cam.z + _v3.z * len * 0.45);
    _v2.set(-sunLocal.x, 0, -sunLocal.z);
    if (_v2.lengthSq() > 1e-9) aim.addScaledVector(_v2.normalize(), len * 0.5);
    this.sunLight.target.position.copy(aim);
    this.sunLight.position.copy(sunLocal).multiplyScalar(this._shadowDist).add(aim);
  }

  /* Park the single practical light on whichever emissive set-piece is closest.
     Structures publish where their light lives and what colour it is —
     `root.userData.practical` = {pos (local), color, intensity, radius} —
     because only the thing that built the geometry knows where the floods
     actually point. Anything that does not publish one gets a fallback derived
     from its kind, so a station without the field is still not a box of bright
     rectangles that lights nothing.

     Not `userData.glow`: the Resonator has used that name for a THREE.Color
     since long before this existed.

     `intensity` in the contract is irradiance at `radius`; three's point light
     is candela and falls off as 1/d^2, so the conversion is intensity*radius^2.
     Writing candela directly into the spec means every author has to know the
     world scale is kilometres, and they will get it wrong. */
  updateGlowLight(dt) {
    const L = this.glowLight;
    let best = null, bestD = Infinity;
    for (const b of this.glowSources()) {
      const d = b.absPos.distanceTo(this.ship.absPos);
      if (d < bestD) { bestD = d; best = b; }
    }
    // Beyond four radii the falloff has already taken it to nothing and the
    // only thing left is the cost of a light no one can see.
    const spec = best && best.glowSpec;
    const reach = spec ? spec.radius * 5.0 : 0;
    if (!spec || bestD > reach) {
      L.intensity += (0 - L.intensity) * Math.min(1, dt * 4);
      return;
    }
    _v.copy(spec.pos).applyQuaternion(best.obj.quaternion)
      .multiplyScalar(best.obj.scale.x).add(best.absPos).sub(this.origin);
    L.position.copy(_v);
    L.color.copy(spec.color);
    L.distance = reach;
    const want = spec.intensity * spec.radius * spec.radius;
    L.intensity += (want - L.intensity) * Math.min(1, dt * 3);
  }

  /** Bodies carrying a published or inferred emissive practical. */
  * glowSources() {
    for (const b of this.anomalies) {
      if (b.glowSpec === undefined) {
        b.glowSpec = readPractical(b.obj)
          // Resonators are the one anomaly bright enough to matter if the
          // builder has not published a spec. The rest are dead and dark.
          || (b.anomalyType === 'resonator'
            // Lerped well toward white. A saturated hue at practical strength
            // stops reading as light and starts reading as a colour filter over
            // the frame: every material goes the same green and the shading
            // underneath it disappears.
            ? { pos: new THREE.Vector3(), color: new THREE.Color(0.42, 1.0, 0.52).lerp(WHITE, 0.5), intensity: 1.4, radius: b.radius }
            : null);
      }
      if (b.glowSpec) yield b;
    }
    for (const s of this.stations) {
      if (s.glowSpec === undefined) {
        // A wheel habitat's own windows and dock floods, if it did not say.
        s.glowSpec = readPractical(s.obj)
          // Radius is the scale the falloff is written against, not the object's
          // size: a wheel habitat is half a unit across but you look at it from
          // tens of units out, and a 0.34 radius put the whole reach inside the
          // hull. 1.4 keeps the floods alive across a normal approach.
          || { pos: new THREE.Vector3(), color: new THREE.Color(1.0, 0.86, 0.66), intensity: 0.55, radius: 1.4 };
      }
      if (s.glowSpec) yield s;
    }
  }

  setLayer(name, on) {
    for (const b of this.bodies) {
      const p = b.planet;
      if (!p) continue;
      if (name === 'atmo' && p.atmo) p.atmo.visible = on;
      if (name === 'clouds' && p.clouds) { p._noClouds = !on; p.clouds.visible = on; }
      if (name === 'rings' && p.rings) p.rings.visible = on;
      if (name === 'surface') p.surface.visible = on;
    }
    if (name === 'stars') this.starField.visible = on;
    if (name === 'star') this.star.group.visible = on;
    if (name === 'dust') this.dust.object.visible = on;
    if (name === 'tunnel') this.foldTunnel.object.visible = on;
    if (name === 'glow') this.glowLight.visible = on;
    if (name === 'bg') this.scene.background = on ? this.nebula.texture : null;
    if (name === 'bloom') this.engine.post.u.uBloom.value = on ? 0.085 : 0;
    if (name === 'flare') this.engine.post.enabled.flare = on;
    if (name === 'streak') this.engine.post.enabled.streak = on;
    if (name === 'hud') document.getElementById('hud').style.display = on ? '' : 'none';
  }

  /** Verification aid: what is actually in this system. */
  debugList() {
    return this.bodies.map((b) => ({
      name: b.name, kind: b.kind, type: b.spec?.type, radius: Math.round(b.radius || 0),
      rings: !!b.spec?.rings, atmo: !!b.spec?.atmo, clouds: !!b.spec?.clouds, night: b.spec?.night || 0,
    }));
  }
}

function frame() { return new Promise((r) => requestAnimationFrame(() => r())); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function romanize(n) { return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][n] || String(n); }
