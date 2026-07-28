import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ============================================================================
   The greeble kit.

   Everything built out of hard vacuum-rated matter in this game — the player's
   hull, freighters, stations, derelicts, Choir monuments — is surfaced by the
   same code, because a universe whose objects were shaded by five different
   authors reads as five different games. One plate-seam law, one weathering
   law, one rim term, one set of base materials.

   Two conventions matter:

   **Metres in, world units out.** Everything here is modelled at 1 unit = 1
   metre and scaled by `M` when it is mounted. Numbers stay legible.

   **Bake transforms into geometry, then merge.** `place()` returns geometry
   already positioned, so `position` in the shader is the *object's own* space
   and plate seams run continuously across part boundaries instead of
   restarting on every mesh. Merging by material then collapses a hundred parts
   into a handful of draws.
   ========================================================================== */

export const M = 0.001;                       // metres -> world units (1 unit = 1 km)

/* ----------------------------------------------------------------- rimming
   Shared by every hull material. three's standard shader has no grazing term
   in its diffuse lobe, so a backlit hull collapses to a flat black cut-out no
   matter how bright the star is — which is exactly what a real backlit object
   never does, because light wraps around the limb and scatters off the dust
   and paint at the edge.

   The fix is one Fresnel lobe gated on how much the key is *behind* the
   subject. Fed the star direction in view space, it costs nothing and it is
   the difference between a spacecraft and a hole in the starfield. */
export const HULL_LIGHT = {
  uSunV: { value: new THREE.Vector3(0, 0, -1) },   // toward the star, view space
  uSunTint: { value: new THREE.Color(1, 1, 1) },
  uRimGain: { value: 1.0 },
  uBounce: { value: new THREE.Color(0.04, 0.05, 0.07) },

  /* ------------------------------------------------------- the environment
     `scene.environment` is a PMREM of the nebula, and the nebula is very
     nearly black. So three's IBL path returns zero however high
     `envMapIntensity` is set, every hull falls back on its diffuse term, and
     the whole game reads as painted clay. A real probe per frame is not
     affordable and is not needed either: in deep space the environment is
     exactly two things, a star and whichever world is nearby, and both of
     them are analytic. One disc plus a void is not an approximation of this
     sky — it *is* this sky, and it costs a reflect and two dot products.

       uShineV    direction of that world, view space. Game.js already picks
                  the body for `shineLight`; this is the same direction.
       uShineCol  its radiance — the body's albedo tinted by the star and
                  scaled by how much of the disc facing us is lit. Distance
                  does *not* belong in here; that is uShineK's job.
       uShineK    sine of its angular radius, r / dist. Drives how broad the
                  reflected disc is and how far the fill wraps.
       uVoidCol   everything else. Teal-black, never neutral grey.

     Defaults are a dim cool sky under the keel rather than nothing, so a hull
     still has something to reflect before Game.js writes them. */
  uShineV: { value: new THREE.Vector3(0, -1, 0) },
  uShineCol: { value: new THREE.Color(0.075, 0.092, 0.120) },
  uShineK: { value: 0.26 },
  uVoidCol: { value: new THREE.Color(0.0090, 0.0135, 0.0180) },
};

/* A handle for `tools/probe.mjs`. The environment terms above are driven from
   Game.js and there is no other way to poke them from a scripted shot. */
if (typeof window !== 'undefined') window.__hullLight = HULL_LIGHT;

const LIGHT_DECL = /* glsl */`
uniform vec3 uSunV;
uniform vec3 uSunTint;
uniform float uRimGain;
uniform vec3 uBounce;
uniform vec3 uShineV;
uniform vec3 uShineCol;
uniform float uShineK;
uniform vec3 uVoidCol;
`;

function bindLight(shader) {
  shader.uniforms.uSunV = HULL_LIGHT.uSunV;
  shader.uniforms.uSunTint = HULL_LIGHT.uSunTint;
  shader.uniforms.uRimGain = HULL_LIGHT.uRimGain;
  shader.uniforms.uBounce = HULL_LIGHT.uBounce;
  shader.uniforms.uShineV = HULL_LIGHT.uShineV;
  shader.uniforms.uShineCol = HULL_LIGHT.uShineCol;
  shader.uniforms.uShineK = HULL_LIGHT.uShineK;
  shader.uniforms.uVoidCol = HULL_LIGHT.uVoidCol;
}

/* three's GGX drives the Fresnel term to `specularF90` — a hard-coded 1.0 for
   every non-metal — as the view goes grazing, whatever the roughness is. On a
   chalky painted hull under this scene's four directional sources that puts a
   pale shroud around the entire silhouette, once per light, and it is the
   fastest way there is to lose the value separation between a bone hull and a
   black nacelle: it lifts the edge of both to the same near-white.

   Real rough dielectrics do brighten at grazing, but nothing remotely like
   this. Rolling f90 off with roughness fixes it at the source — it leaves the
   head-on f0 reflection alone, it leaves metal alone because it scales out with
   metalness, and it leaves the polished trim and the glass alone because they
   are below the roughness threshold. The one hard highlight on the ship
   survives; the shroud does not.

   This also feeds `computeMultiscattering`, so the same shroud coming off the
   environment probe goes with it.

   `MATTE_MIN` is a floor on how much of that roll-off a material gets whatever
   its roughness says, and it exists because the smoothstep is a proxy and the
   proxy has a hole in the middle of it. A worked-alloy fitting at 0.44 sits
   exactly half way up the ramp, so it keeps a grazing Fresnel of 0.60 against
   the paint's 0.12 — five times the shroud, on the largest curved masses on the
   ship, which is measurably "a broad neutral highlight wrapping the whole form"
   and reads as painted plastic. Flooring it puts the fitting on the paint's
   footing; the term still scales out with `metalnessFactor`, so the bare metal
   the wear mask brings back at the rims gets its hard highlight anyway. The
   rule survives — bare metal only at wear edges — and so does the highlight. */
const MATTE_HOOK = /* glsl */`
  #include <lights_physical_fragment>
  {
    float matte = max(smoothstep(0.22, 0.62, material.roughness), MATTE_MIN)
                * (1.0 - metalnessFactor);
    material.specularF90 = mix(material.specularF90, MATTE_F90, matte);
  }
`;

/* The shared lighting tail: cavity occlusion, the backlit rim, and the
   analytic environment. CAVITY is substituted by whoever installs the hook —
   the hull kit hands it the plate grooves so indirect light cannot leak into a
   seam, and a plain material hands it 1.0. */
const RIM_HOOK = /* glsl */`
  #include <lights_fragment_end>
  {
    // Indirect light does not reach into a groove. Applied to what three has
    // already accumulated, before anything of ours is added.
    float cav = CAVITY;
    reflectedLight.indirectDiffuse *= cav;
    reflectedLight.indirectSpecular *= cav;

    vec3 Vv = normalize(vViewPosition);
    float fres = pow(clamp(1.0 - dot(normal, Vv), 0.0, 1.0), 3.2);
    // 1 when the key is directly behind the subject, 0 when it is behind us
    float back = clamp(-dot(uSunV, Vv), 0.0, 1.0);
    // and only along the true silhouette, where the surface turns away
    float graze = clamp(1.0 - abs(dot(normal, uSunV)), 0.0, 1.0);
    reflectedLight.directSpecular += uSunTint * fres * back * graze * uRimGain * 2.6;

    /* ---- the analytic environment.  See HULL_LIGHT.
       The world nearby is a disc of radiance uShineCol subtending an angular
       radius whose sine is uShineK. Reflect the view about the normal, ask
       whether that ray lands on the disc, and blur the answer by the surface
       roughness: a mirrored trim ring returns the disc's hard edge, chalky
       paint returns a soft gradient across its whole planet-facing side, and
       the same number does both. */
    float rgh = material.roughness;
    vec3 Rv = reflect(-Vv, normal);
    float cA = sqrt(max(0.0, 1.0 - uShineK*uShineK));   // cos of the angular radius
    float blur = 0.02 + rgh*rgh*2.7 + rgh*0.28;
    float disc = smoothstep(cA - blur, min(1.0, cA + blur*0.22), dot(Rv, uShineV));
    // A rough surface smears the same energy over a wide lobe, so what comes
    // back is never brighter than what went in.
    vec3 radiance = uShineCol * disc * mix(0.42, 1.0, 1.0/(1.0 + rgh*rgh*8.0)) + uVoidCol;
    reflectedLight.indirectSpecular += radiance * cav
      * EnvironmentBRDF(normal, Vv, material.specularColorBlended, material.specularF90, rgh);

    // Diffuse off the same disc. Game.js runs planetshine as a real
    // directional, which delivers the N.L part already, so only the wrap is
    // added here: the light a source half a sky wide puts *past* the
    // terminator, which is the one thing a directional can never do.
    float nl = dot(normal, uShineV);
    float wk = 0.18 + 0.82*uShineK;
    float wr = clamp((nl + wk) / (1.0 + wk), 0.0, 1.0);
    float pastTerm = max(0.0, wr*wr - max(0.0, nl));
    reflectedLight.indirectDiffuse += uShineCol * (uShineK*uShineK*3.2) * pastTerm
                                   * material.diffuseContribution * cav;

    // A wrapped bounce term so the shadow side sits on a colour instead of on
    // zero. Real vacuum shadows are filled by whatever large thing is nearby.
    float nsun = dot(normal, uSunV);
    float wrap = clamp(nsun*0.5 + 0.5, 0.0, 1.0);
    reflectedLight.indirectDiffuse += uBounce * diffuseColor.rgb * (0.35 + 0.65*wrap);

    /* ---- the void, on the diffuse lobe.
       uVoidCol is the one term in this rig whose entire job is the brief's
       first rule — shadows are never black — and it was only ever handed to
       the environment BRDF, which for chalky paint returns about four per
       cent. So it arrived at four hundredths of its own value, and every face
       in the game that the key did not reach rendered at zero: measured, a
       nacelle in silhouette sat at 10/255 against 230 on its lit side, which
       is a cut-out, not a shadow. Deep space is not a black room. It is a
       full sphere of very dim, very cold light, and the honest place for that
       is the diffuse lobe.

       It is *shaped*, not flat, which is the whole difference between this
       and raising ambient. The weight is zero wherever the key already lands
       and rises to one as a face turns away from it, so the lit side, the
       terminator and the value separation between a bone hull and a black
       nacelle are all untouched — only the part of the frame that was
       previously a hole gets anything at all. */
    float unlit = clamp(0.5 - nsun*0.5, 0.0, 1.0);
    reflectedLight.indirectDiffuse += uVoidCol * diffuseColor.rgb
                                    * (unlit*unlit*2.2 + 0.18) * cav;
PLUME_LIGHT
  }
`;

/**
 * Give a material the shared lighting tail — rim, planet bounce and the
 * analytic environment — and nothing else. For the things the plating law has
 * no business touching: glass, canopies, anything already carrying its own
 * surface treatment. Without this a pane of glass has a black probe to
 * reflect and reads as a painted hole.
 */
export function skyLit(mat) {
  mat.onBeforeCompile = (shader) => {
    bindLight(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + LIGHT_DECL)
      .replace('#include <lights_fragment_end>',
        RIM_HOOK.replace('CAVITY', '1.0').replace('PLUME_LIGHT', ''));
  };
  mat.customProgramCacheKey = () => 'skyLit';
  return mat;
}

/* --------------------------------------------------------------- materials */

/* Surface treatment shared by every hull material: plate seams, weld beads,
   sun-bleaching that keys off which way a face points, and soot aft of the
   nozzles. All of it is driven from ship-space position, so it is continuous
   across the merged geometry and costs nothing per part. */
const HULL_PARS = /* glsl */`
  varying vec3 vShipPos;
  varying vec3 vShipNrm;
  varying vec2 vHull;          // baked: x occlusion, y exposed-edge

  float hHash(vec3 p){
    p = fract(p*0.3183099 + vec3(0.71,0.113,0.419));
    p *= 17.0;
    return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
  }
  float hNoise(vec3 x){
    vec3 i = floor(x), f = fract(x);
    f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hHash(i+vec3(0,0,0)), hHash(i+vec3(1,0,0)), f.x),
                   mix(hHash(i+vec3(0,1,0)), hHash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hHash(i+vec3(0,0,1)), hHash(i+vec3(1,0,1)), f.x),
                   mix(hHash(i+vec3(0,1,1)), hHash(i+vec3(1,1,1)), f.x), f.y), f.z);
  }
  /* Five octaves, for whoever injects their own weathering into a dressed
     material — Station.js draws its ruin burns with this. Nothing in the
     plating law below uses it: see hFbm3. */
  float hFbm(vec3 p){
    float s = 0.0, a = 0.5;
    for(int i=0;i<5;i++){ s += a*hNoise(p); p *= 2.07; a *= 0.5; }
    return s;
  }
  /* Three octaves. This shader pays for its noise three times over, and the
     fourth and fifth octaves of a nine-metre blotch mask, a two-metre flow
     streak and a forty-centimetre paint tooth all land under a pixel from
     anywhere anyone looks at this hull. */
  float hFbm3(vec3 p){
    float s = 0.0, a = 0.5;
    for(int i=0;i<3;i++){ s += a*hNoise(p); p *= 2.07; a *= 0.5; }
    return s;
  }

  /* Brushed metal, in one line. Real anisotropy wants a tangent frame and a
     second GGX lobe; a roughness that varies twenty times faster around the
     hull than along it buys the same read — a highlight that smears into
     lengthwise bands as the key rakes across — for two noise fetches. */
  float brush(vec3 p){
    return hNoise(vec3(p.x*3.4, p.y*3.4, p.z*0.16))*0.62
         + hNoise(vec3(p.x*9.3, p.y*9.3, p.z*0.44))*0.38;
  }

  /* ---- how big a pixel is, in metres of ship -----------------------------
     The renderer supersamples, so anything authored below the sample spacing
     is not detail, it is noise that crawls. Every sub-panel feature below —
     fastener heads, weld beads, the fine seam octave, the detail normal — is
     multiplied by this, which is the shader's own mip chain: a rivet six
     millimetres wide fades out at exactly the distance it stops being
     resolvable instead of sparkling all the way to the horizon. It also buys
     back most of what the detail costs, because the branches it gates are
     screen-coherent and skip whole tiles at once. */
  float hullLod(float s, float px){ return clamp(s/(px*3.2) - 0.55, 0.0, 1.0); }

  /* ---- one plate edge ----------------------------------------------------
     A dark groove with a burnished lip either side of it, not a flat dark
     stripe. The groove sits at a jittered place inside its cell and one edge
     in six is missing altogether, because plates of exactly one length in a
     perfect grid is the definition of the brick-pattern read.

     Two joints in three are bolted and carry a row of fastener heads just
     outboard of the gap; the rest are welded, which is a *raised bead* and no
     gap at all. Mixing the two is most of what stops a hull reading as one
     repeated panel, and it is the detail an art director means by "no rivets,
     no weld seams". x runs across the seam and y along it.

     The reg argument is registration, and it is the difference between plating
     texture. At 0 the joint sits at a jittered place inside its cell, one cell
     in eight has no joint at all, and two joints in three are bolted — which is
     right for a butt strap between two plates, where the yard put the joint
     wherever the stock ran out. At 1 the joint is at the *same* place in every
     cell, no cell is ever skipped, and every joint is bolted: that is a
     structural frame, and a frame ring is at its station because the ship was
     designed around it. Running the jittered law over both families is what
     makes a hull read as an arbitrary scatter of dashes rather than as bays.

     Out: gv = (groove, lip); dt = (fastener, weld bead, dirt washing aft). */
  void seamLine(float x, float y, float w, float fine, float reg, out vec2 gv, out vec3 dt){
    float c = floor(x);
    float j = hHash(vec3(c, 7.7, 1.3));
    float sp = mix(0.33 + 0.34*j, 0.5, reg);
    float d = fract(x) - sp;
    float g = abs(d);
    float keep = max(step(0.12, hHash(vec3(c, 3.1, 9.2))), reg);
    float bolt = max(step(0.34, hHash(vec3(c, 11.3, 4.9))), reg);
    // a welded joint still shows, but as a line rather than as a gap
    float core = (1.0 - smoothstep(0.0, w, g)) * keep * mix(0.42, 1.0, bolt);
    // The lip has to stay *narrower* than the groove. Wider and every plate
    // acquires a bright border, which reads as quilting rather than as metal.
    float lip  = smoothstep(w*2.0, w*1.05, g) * (1.0 - core) * keep;
    gv = vec2(core, lip);

    float riv = 0.0, bead = 0.0;
    if (fine > 0.002){
      /* Fastener heads, in a row either side of the gap. Sized like fasteners:
         the first pass made the band six times too wide and the row read as a
         soft lump beside the seam rather than as hardware. A head is three
         centimetres on a two-and-a-half metre plate. */
      float band = 1.0 - smoothstep(w*0.30, w*0.95, abs(g - w*2.3));
      float fy = fract(y*6.0) - 0.5;
      riv = band * (1.0 - smoothstep(0.05, 0.15, abs(fy))) * bolt * keep * fine;
      // a weld bead, wandering along its length the way a hand-run bead does
      float wob = (hNoise(vec3(y*2.6, c*0.7, 4.0)) - 0.5) * w*1.4;
      bead = (1.0 - smoothstep(w*0.7, w*2.2, abs(d - wob))) * (1.0 - bolt) * keep * fine;
    }
    /* Dirt washes out of a gap and dies away within one plate. This is the
       streaking a hull gets from vented gas and handling, and unlike fbm
       staining it is *registered to the panel grid*, which is the whole
       reason it reads as coming from the seam.

       The onset is a ramp across the gap rather than a hard step. As a stain
       that is merely more honest — dirt comes out of a joint, it does not begin at a
       mathematical line down the middle of one. As *height* it is the
       difference between a lap joint and a defect: this field is also the
       plate overlap in the relief block, a hard step there is an infinite
       screen-space gradient, and an infinite gradient through
       perturbNormalArb is one pixel of arbitrary normal down the centre of
       every seam on the ship — which at 1:1 is a bright dotted chain and in
       motion is a crawling one. */
    float wash = keep * smoothstep(-w*1.3, w*1.3, d) * exp2(-max(d, 0.0)*6.5)
               * (0.25 + 0.75*hHash(vec3(c, floor(y*2.3), 5.1)));
    dt = vec3(riv, bead, wash);
  }

  /* Seams follow the form, and the form is read off the surface normal.
     A pressure vessel is rolled plate: rings around it and stringers along it
     in its own cylindrical frame. A fin, a deck or a bulkhead is cut plate: a
     rectangular grid in the plane it actually lies in. Running the cylindrical
     law over everything is what turned the tail fin into vertical dashes on a
     plain field — a flat plate on the centreline has no radius to run rings
     around, so all it ever got was the one family of lines.

     Plate *size* varies by surface class, which is the fix for the tiled read:
     a barrel is plated in sheets that scale with its radius, flanks and fins
     are plated finer than decks, and a spine and a wing therefore never share
     a grid. One cell size over the whole ship is a texture; four is structure.

     The fr argument turns the *transverse* family into real frames — see the
     reg argument above — and opens the hatch field below. It is off for
     everything the shared kit builds and on for the player's hull, which is
     the one asset anybody ever reads at one to one.

     Out: sm = (groove, lip, plate seed) — the seed matters most, because no
     two panels were rolled in the same year or faded by the same amount;
     dt = (fastener, weld bead, gap wash); hd = (hatch recess, hatch rim). */
  void plating(vec3 p, vec3 n, float S, float w, float fine, float fr,
               out vec3 sm, out vec3 dt, out vec2 hd){
    vec3 an = abs(n);
    float rad = length(p.xy);
    float ln = length(n.xy);
    float radial = (rad > 0.05 && ln > 0.02) ? dot(p.xy/rad, n.xy/ln) : 0.0;
    // rolled plate only where the surface genuinely wraps a barrel
    float cw = smoothstep(0.60, 0.92, radial) * smoothstep(1.2, 2.6, rad)
             * (1.0 - an.z*an.z);

    vec2 gv = vec2(0.0), g0, g1;
    vec3 dd = vec3(0.0), d0, d1;
    float seed = 0.5;
    vec2 puv = vec2(0.0);        // the plate coordinate of whichever law won

    /* cylindrical: rings across, stringers around, and the stringers stagger
       by bay so the joints never line up into one long ladder — which is how
       plating is actually laid, and the reason it does not read as brick.
       The rings wobble, but *smoothly*: jittering them per angular cell
       shatters every ring into staggered dashes.

       Under fr the ring stops wobbling at all and the stagger goes to exactly
       half a plate. A rolled barrel is built on frames, and a frame is a ring
       of the same section at the same station all the way round: the wobble was
       there to keep a perfect grid from reading as a texture and it does the
       opposite, because a line that drifts has no station to be at. Half-plate
       stagger is what a shipwright actually lays, and unlike 0.41 of a plate it
       repeats every second bay, so the eye can count the bays. */
    if (cw > 0.004){
      float Sc = S / clamp(rad*0.23, 0.60, 1.55);
      float ang = atan(p.y, p.x) * (1.55 + rad*0.045);
      float uCyl = p.z*Sc + hNoise(vec3(ang*0.30, 0.0, 0.0))*0.17*(1.0 - fr);
      float vCyl = ang*2.0 + floor(p.z*Sc)*mix(0.41, 0.5, fr);
      seamLine(uCyl, vCyl, w,     fine, fr,  g0, d0);   // frames
      seamLine(vCyl, uCyl, w*1.4, fine, 0.0, g1, d1);   // butt straps
      gv = max(g0, g1*0.85);
      dd = vec3(max(d0.xy, d1.xy*0.85), d0.z);
      puv = vec2(uCyl, vCyl);
      seed = hHash(vec3(floor(puv), 2.7));
    }

    /* cut plate, in whichever plane the surface lies in. Only the frames that
       actually carry weight are evaluated: an axis-aligned face has one, and
       computing the other two for it tripled the cost of the busiest shader
       in the game for a contribution of 0.4%. */
    if (cw < 0.996){
      float wx = an.x*an.x*an.x, wy = an.y*an.y*an.y, wz = an.z*an.z*an.z;
      float ws = wx + wy + wz + 1e-4;
      vec2 cg = vec2(0.0); vec3 cd = vec3(0.0);
      vec2 cc = vec2(0.0); float best = -1.0;
      if (wx > 0.004*ws){
        float Sx = S*1.34;                       // flanks and fins: fine plate
        vec2 u = vec2(p.z*Sx + 0.31, p.y*Sx*1.3 + floor(p.z*Sx)*mix(0.37, 0.5, fr));
        seamLine(u.x, u.y, w,     fine, fr,  g0, d0);
        seamLine(u.y, u.x, w*1.3, fine, 0.0, g1, d1);
        cg += max(g0, g1*0.85)*wx;
        cd += vec3(max(d0.xy, d1.xy*0.85), d0.z)*wx;
        cc = u; best = wx;
      }
      if (wy > 0.004*ws){
        float Sy = S*0.71;                       // decks and roofs: long sheets
        vec2 u = vec2(p.z*Sy + 0.13, p.x*Sy*1.3 + floor(p.z*Sy)*mix(0.29, 0.5, fr));
        seamLine(u.x, u.y, w,     fine, fr,  g0, d0);
        seamLine(u.y, u.x, w*1.3, fine, 0.0, g1, d1);
        cg += max(g0, g1*0.85)*wy;
        cd += vec3(max(d0.xy, d1.xy*0.85), d0.z)*wy;
        if (wy > best){ cc = u; best = wy; }
      }
      if (wz > 0.004*ws){
        vec2 u = vec2(p.x*S + 0.57, p.y*S*1.3 + floor(p.x*S)*mix(0.23, 0.5, fr));
        seamLine(u.x, u.y, w,     fine, fr,  g0, d0);
        seamLine(u.y, u.x, w*1.3, fine, 0.0, g1, d1);
        cg += max(g0, g1*0.85)*wz;
        cd += vec3(max(d0.xy, d1.xy*0.85), 0.0)*wz;   // a face plate has no aft
        if (wz > best){ cc = u; best = wz; }
      }
      cg /= ws; cd /= ws;
      /* One plate identity, taken from whichever frame actually won rather
         than blended between them — a blended hash is a smooth gradient,
         which is the one thing a plate boundary must never be. */
      float cSeed = hHash(vec3(floor(cc), 2.7));
      gv = mix(cg, gv, cw);
      dd = mix(cd, dd, cw);
      seed = mix(cSeed, seed, step(0.5, cw));
      puv = mix(cc, puv, step(0.5, cw));
    }

    /* ---- doors, hatches and access panels.
       The plate law can say where a joint is. What it could never say is that
       something was *cut out* of the hull and hinged, and the difference is the
       whole of an art director's reading of this ship against a reference:
       theirs has doors with hinges and real recesses that catch the key, ours
       had rectangles drawn on with a hairline bevel.

       A hatch fills its own bay. That is not a simplification, it is how one is
       built — an opening interrupts the plating, so it is framed by the seams
       that are already there rather than laid across them, and its size comes
       out of the material's own plate gauge. A 3.7 m pressure-hull bay gives a
       2.5 by 1.4 m door; a 1.15 m fairing bay gives a 780 mm access panel; the
       same four lines do both. hd.y is the perimeter, and it is handed to the
       fastener channel so the dogs round the edge answer the key exactly as the
       fasteners on a plate joint do. */
    hd = vec2(0.0);
    if (fr > 0.5){
      float dh = hHash(vec3(floor(puv), 31.7));
      float on = step(0.928, dh);              // about one bay in fourteen
      vec2 f2 = abs(fract(puv) - 0.5) - vec2(0.30, 0.26);
      float e = max(f2.x, f2.y);
      // A soft-shouldered step, for the same reason the gap wash has one: a
      // hard step in a height field is an infinite screen-space gradient, and
      // an infinite gradient through perturbNormalArb is one pixel of arbitrary
      // normal all the way round every hatch on the ship.
      hd = vec2(on * (1.0 - smoothstep(-0.020, 0.020, e)),
                on * (1.0 - smoothstep(0.0, 0.034, abs(e))));
    }

    sm = vec3(gv, seed);
    dt = dd;
  }

  /* ---- micrometeoroid pitting -------------------------------------------
     A hull three years out is not flat between its seams. Every square metre
     of it has been sandblasted by grit at fifteen kilometres a second, and
     what that leaves is a scatter of shallow dishes a few centimetres across
     with the ejecta burr still standing round the rim. It is the one piece of
     surface history that cannot be painted on: a crater has *relief*, and
     under a raking key it is a bright crescent against a dark one, which is
     precisely what an albedo blotch can never do.

     One cell owns one crater and neighbours are not consulted. Eight more
     hash lookups would let them overlap; at four to ten centimetres across
     nothing in this game is ever close enough to notice that they do not, and
     this function is evaluated on every hull fragment in the frame. */
  float pitH(vec3 p, float sc){
    vec3 c = floor(p*sc);
    float h = hHash(c + 3.7);
    vec3 j = vec3(hHash(c + 1.3), hHash(c + 5.9), hHash(c + 9.1));
    // centre and radius both held clear of the cell wall, so a crater is never
    // sliced in half by the grid it was drawn in
    float rad = 0.13 + 0.16*fract(h*23.0);
    float d = length(fract(p*sc) - (0.35 + j*0.30)) / rad;
    // A crater is a bowl, not a dimple: deepest in the middle and *steepest at
    // the rim*, which is the opposite of the smoothstep shape reached for
    // first and the reason that one read as a soft smudge.
    float dd = min(d, 1.0);
    float e = (d - 1.0)*5.0;
    // the dish, and the burr of melt thrown up around it
    return step(0.72, h) * (dd*dd - 1.0 + exp2(-e*e*1.44)*0.26);
  }

  /* ---- doublers, standoffs and access pads -------------------------------
     Small plates laid *on* the hull and bolted down. Every real vehicle is
     covered in them, and between its seams this one was a plane — which is
     what left the largest, palest and most-looked-at surfaces on the ship
     with nothing in them for the key to find. The plate law can only draw
     where a joint *is*; this draws what was later bolted over one.

     A box in ship space cuts a rectangle out of any surface it meets, so one
     cell distance answers this for a flank, a deck and a barrel alike without
     paying for the plating law's three-frame projection a third time — and
     stretching that box along the *surface normal* is what turns it from a
     cube into a plate lying on the hull. Across the surface it is the size of
     the doubler; through it, it is deep enough that the hull can never slip
     between two of them. Without that stretch a two-dimensional surface
     misses a three-dimensional cube two times in three, and the field reads
     as one pad every few metres instead of a vehicle covered in them. */
  float padH(vec3 p, vec3 n, float sc){
    vec3 c = floor(p*sc);
    float h = hHash(c + 21.3);
    vec3 j = vec3(hHash(c + 2.9), hHash(c + 7.1), hHash(c + 13.7));
    vec3 d = abs(fract(p*sc) - (0.35 + j*0.30));
    // deliberately unequal in the three axes, so a pad is a rectangle rather
    // than the square that gives a cell grid away
    vec3 hs = vec3(0.09 + 0.15*fract(h*13.0), 0.09 + 0.15*fract(h*29.0),
                   0.09 + 0.15*fract(h*53.0)) + abs(n)*0.42;
    float e = max(max(d.x - hs.x, d.y - hs.y), d.z - hs.z);
    return step(0.62, h) * (1.0 - smoothstep(-0.012, 0.012, e));
  }

  /* Height into normal, from screen derivatives — three's perturbNormalArb,
     inlined because the bump chunk is only compiled in when a bump *map* is
     bound and there is no map here. Without it the seams are a printed
     pattern: they change the albedo and never catch the key, which is why a
     panel line at a raking angle looked drawn on rather than cut in.

     The height must arrive in the *same units as vpos*, which is world space
     and not ship metres — a groove authored at twenty millimetres and handed
     to a derivative taken in kilometres perturbs the normal by a factor of a
     thousand, and the whole hull dissolves into crawling static. Callers
     multiply by hullU2M for that reason. */
  vec3 hullBump(vec3 N, vec3 vpos, float h, float k){
    vec3 dpx = dFdx(vpos), dpy = dFdy(vpos);
    vec2 dH = vec2(dFdx(h), dFdy(h)) * k;
    vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dH.x*r1 + dH.y*r2);
    return normalize(abs(det)*N - grad);
  }
`;

const HULL_VERT_HOOK = /* glsl */`
  #include <begin_vertex>
  vShipPos = position;
  vShipNrm = normalize(normal);
  vHull = aHull;
`;

/* ------------------------------------------------------------------ decals
   Hull markings are the difference between a shape and a *vehicle*. Registration
   numbers, a squadron mark, hazard chevrons around an efflux, a hatch outline:
   they are what tells the eye the thing was built by an organisation, operated,
   and maintained. AAA never ships a hero asset without them.

   The atlas is drawn once into a canvas and shared by everything. Its channels
   are *inks*, not colour — R is bone stencil, G is dark stencil, B is oxide
   paint — and the shader picks the pigment, so a marking can never drift out of
   the game's palette however the atlas is redrawn. */

/* DW/DH is the sheet's *drawing* space and DQ is how many device pixels each
   of those units gets. Splitting the two means the whole layout below stays in
   one readable coordinate system while the raster is as fine as the ship needs.
   At DQ 1 the registration stripe was 636 texels covering eighteen metres of
   flank — which is about 250 screen pixels at the distance anyone actually
   looks at the ship, so every letter was landing on a texel and a half and the
   small line under it was illegible mush. Text is the one thing on a hull with
   no tolerance for undersampling: a blurred plate seam still reads as a plate
   seam, and a blurred word reads as a bug. */
const DW = 1024, DH = 512, DQ = 2;
let _decal = null;

export function decalSheet() {
  if (_decal) return _decal;
  const cells = {};
  const cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
  if (!cv) return (_decal = { tex: null, cells });
  cv.width = DW * DQ; cv.height = DH * DQ;
  const c = cv.getContext('2d');
  c.scale(DQ, DQ);
  c.fillStyle = '#000'; c.fillRect(0, 0, DW, DH);

  const LIGHT = '#ff0000', DARK = '#00ff00', OXIDE = '#0000ff';
  const cell = (n, x0, y0, x1, y1) => { cells[n] = [x0 / DW, 1 - y1 / DH, x1 / DW, 1 - y0 / DH]; };
  const font = (px, w) => (w || 'bold') + ' ' + px + 'px "Helvetica Neue", Helvetica, Arial, sans-serif';
  /* Tracked text. Canvas letterSpacing is not portable, so glyphs are stepped
     by hand; wide tracking is most of what makes lettering read as stencilled
     rather than as a word processor. */
  const txt = (s, x, y, px, col, track = 0, align = 'left', weight) => {
    c.save(); c.font = font(px, weight); c.fillStyle = col; c.textBaseline = 'alphabetic';
    let w = -track;
    for (const ch of s) w += c.measureText(ch).width + track;
    let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    for (const ch of s) { c.fillText(ch, cx, y); cx += c.measureText(ch).width + track; }
    c.restore();
    return w;
  };
  const bar = (x0, y0, x1, y1, col) => { c.fillStyle = col; c.fillRect(x0, y0, x1 - x0, y1 - y0); };

  /* Cell aspect ratios are chosen to match the ship-space rectangles they get
     projected into. A stencil stretched to twice its drawn aspect reads as a
     texturing mistake long before anyone notices what it says. */

  // --- the flank stripe: livery band, registration, and the vessel name -----
  cell('reg', 8, 8, 644, 110);
  bar(8, 36, 644, 88, OXIDE);
  bar(8, 28, 644, 33, LIGHT);
  bar(8, 91, 644, 96, LIGHT);
  txt('PS-114', 26, 78, 44, LIGHT, 6);
  txt('PALE SEEKER', 258, 76, 38, LIGHT, 11);
  // The two service lines are the smallest lettering on the ship. Set them at
  // a size that survives the mip chain rather than one that fits comfortably.
  txt('CREW 04', 26, 23, 17, LIGHT, 3);
  txt('DEEP SURVEY / LONG DURATION', 636, 23, 17, LIGHT, 2, 'right');

  // --- dorsal wordmark ------------------------------------------------------
  cell('name', 8, 124, 700, 222);
  txt('PALE SEEKER', 354, 190, 62, LIGHT, 22, 'center');
  bar(60, 202, 648, 209, LIGHT);
  bar(60, 132, 300, 138, OXIDE);
  bar(408, 132, 648, 138, OXIDE);

  // --- hull number, for the nacelles ---------------------------------------
  cell('num', 716, 124, 856, 234);
  txt('07', 792, 210, 104, DARK, 4, 'center');
  txt('07', 786, 204, 104, LIGHT, 4, 'center');

  // --- squadron mark --------------------------------------------------------
  cell('mark', 872, 8, 1000, 136);
  c.save();
  c.translate(936, 72);
  c.strokeStyle = LIGHT; c.lineWidth = 9;
  c.beginPath(); c.arc(0, 0, 52, 0, Math.PI * 2); c.stroke();
  c.fillStyle = OXIDE;
  c.beginPath(); c.moveTo(0, -40); c.lineTo(34, 26); c.lineTo(0, 10); c.lineTo(-34, 26); c.closePath(); c.fill();
  c.fillStyle = LIGHT;
  c.fillRect(-52, 30, 104, 8);
  c.restore();

  // --- hazard chevrons ------------------------------------------------------
  cell('haz', 8, 236, 228, 292);
  bar(8, 236, 228, 292, DARK);
  c.save();
  c.beginPath(); c.rect(8, 236, 220, 56); c.clip();
  for (let i = -2; i < 10; i++) {
    c.fillStyle = OXIDE;
    c.beginPath();
    const x = 8 + i * 46;
    c.moveTo(x, 292); c.lineTo(x + 24, 292); c.lineTo(x + 24 + 56, 236); c.lineTo(x + 56, 236);
    c.closePath(); c.fill();
  }
  bar(8, 236, 228, 241, LIGHT);
  bar(8, 287, 228, 292, LIGHT);
  c.restore();

  // --- a caution stencil ----------------------------------------------------
  cell('caut', 716, 250, 1000, 306);
  txt('CAUTION', 722, 282, 30, LIGHT, 5);
  txt('ENGINE EFFLUX', 722, 302, 17, LIGHT, 4);

  // --- an access hatch ------------------------------------------------------
  cell('hatch', 244, 236, 372, 364);
  c.save();
  c.strokeStyle = LIGHT; c.lineWidth = 5;
  c.strokeRect(252, 244, 112, 92);
  c.fillStyle = LIGHT;
  for (const [bx, by] of [[262, 254], [354, 254], [262, 326], [354, 326]]) {
    c.beginPath(); c.arc(bx, by, 5, 0, Math.PI * 2); c.fill();
  }
  c.restore();
  txt('ACCESS', 308, 296, 19, LIGHT, 4, 'center');
  txt('NO STEP', 308, 358, 17, LIGHT, 4, 'center');

  // --- a rescue arrow -------------------------------------------------------
  cell('arrow', 388, 236, 692, 336);
  c.save();
  c.fillStyle = LIGHT;
  c.beginPath();
  c.moveTo(396, 286); c.lineTo(450, 242); c.lineTo(450, 268); c.lineTo(536, 268);
  c.lineTo(536, 304); c.lineTo(450, 304); c.lineTo(450, 330); c.closePath();
  c.fill();
  c.restore();
  txt('RESCUE', 556, 278, 24, LIGHT, 4);
  txt('CUT HERE', 556, 316, 20, OXIDE, 4);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace ?? THREE.LinearSRGBColorSpace;
  // A decal projected onto a cylinder is always seen at a rake from somewhere,
  // and lettering read at a rake is exactly what anisotropic filtering is for.
  tex.anisotropy = 16;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  _decal = { tex, cells };
  return _decal;
}

/* Ink pigments, linear. Bone stencil, near-black stencil, oxide paint — the
   same three colours the rest of the game is built from. */
const INK = /* glsl */`
  const vec3 INK_L = vec3(0.600, 0.575, 0.500);
  const vec3 INK_D = vec3(0.012, 0.014, 0.017);
  const vec3 INK_O = vec3(0.332, 0.068, 0.009);
`;

/* Build the placement code for one marking. A mark is a rectangle in ship
   space, projected down one axis onto whatever geometry is inside it — the
   same thing a decal projector does in a DCC package, minus the bake. */
function markGLSL(m, cells) {
  const cell = cells[m.cell];
  if (!cell) return '';
  const [u0, v0, u1, v1] = cell;
  const g = (n) => n.toFixed(4);

  /* ---- cylindrical unwrap ------------------------------------------------
     A flat projector aimed down one axis is right for a flank and wrong for a
     barrel: past about thirty degrees of wrap the stencil stretches, and a
     hull number smeared along a nacelle is the classic tell that a decal was
     projected rather than laid. This maps the mark into (axial, angular)
     instead, so it lies on the drum the way a transfer actually does.

       cyl: { c: [x, y], r, a0, a1, mirror }   rect: [z0, z1] */
  if (m.cyl) {
    const c = m.cyl;
    const sg = c.mirror ? 'sign(vShipPos.x)' : '1.0';
    const [z0, z1] = m.rect;
    const flip = m.flipU ? '1.0 - ' : '';
    return /* glsl */`
  {
    float sg = ${sg};
    vec2 rel = vec2((vShipPos.x - ${g(c.c[0])}*sg)*sg, vShipPos.y - ${g(c.c[1])});
    float ang = atan(rel.y, rel.x);
    float u = ${flip}((vShipPos.z - ${g(z0)}) / ${g(z1 - z0)});
    // Lettering reads the right way round on both flanks, which means the
    // atlas lookup mirrors with the side rather than the geometry doing it.
    u = mix(u, 1.0 - u, step(0.0, sg));
    float v = (ang - ${g(c.a0 ?? -0.6)}) / ${g((c.a1 ?? 0.6) - (c.a0 ?? -0.6))};
    float inr = step(0.0, u)*step(u, 1.0)*step(0.0, v)*step(v, 1.0);
    // only where the surface actually faces out of the barrel
    vec2 nr = vec2(vShipNrm.x*sg, vShipNrm.y);
    float fc = clamp(dot(normalize(rel + 1e-5), normalize(nr + 1e-5))*3.0 - 1.4, 0.0, 1.0);
    fc *= 1.0 - smoothstep(${g((c.r ?? 3) * 1.35)}, ${g((c.r ?? 3) * 2.1)}, length(rel));
    vec2 duv = mix(vec2(${g(u0)}, ${g(v0)}), vec2(${g(u1)}, ${g(v1)}),
                   clamp(vec2(u, ${m.flipV ? '1.0 - v' : 'v'}), 0.0, 1.0));
    ink += texture2D(uDecal, duv).rgb * inr * fc;
  }`;
  }

  const [a0, b0, a1, b1] = m.rect;
  const ax = m.plane === 'x' ? 'x' : m.plane === 'y' ? 'y' : 'z';
  // (a, b) are the two axes the mark lies in; a is the atlas u direction.
  const A = m.plane === 'x' ? 'vShipPos.z' : m.plane === 'y' ? 'vShipPos.z' : 'vShipPos.x';
  const B = m.plane === 'x' ? 'vShipPos.y' : m.plane === 'y' ? 'vShipPos.x' : 'vShipPos.y';
  const f = (n) => n.toFixed(4);
  // Lettering must read the right way round on both flanks, which means the
  // atlas lookup mirrors with the side rather than the geometry mirroring it.
  const flipU = m.both ? 'step(0.0, sg)' : f(m.flipU ? 1 : 0);
  const flipV = f(m.flipV ? 1 : 0);
  const gate = m.both ? '' : `  fc *= step(0.0, sg*${f(m.side ?? 1)});\n`;
  return /* glsl */`
  {
    float sg = sign(vShipNrm.${ax});
    float fc = clamp(abs(vShipNrm.${ax})*${f(m.wrap ?? 2.6)} - ${f((m.wrap ?? 2.6) * 0.36)}, 0.0, 1.0);
${gate}    vec2 t = (vec2(${A}, ${B}) - vec2(${f(a0)}, ${f(b0)})) / vec2(${f(a1 - a0)}, ${f(b1 - b0)});
    float inr = step(0.0, t.x)*step(t.x, 1.0)*step(0.0, t.y)*step(t.y, 1.0);
    vec2 tt = vec2(mix(t.x, 1.0 - t.x, ${flipU}), mix(t.y, 1.0 - t.y, ${flipV}));
    vec2 duv = mix(vec2(${f(u0)}, ${f(v0)}), vec2(${f(u1)}, ${f(v1)}), clamp(tt, 0.0, 1.0));
    ink += texture2D(uDecal, duv).rgb * inr * fc;
  }`;
}

/* ---------------------------------------------------------- the drive glow
   A drive plume is a twenty-metre column of light a few metres from the bell
   wall, and a bell that stays dark grey while it burns is the single most
   obviously wrong thing about an engine. There is no light in this scene but
   the star, so the column is evaluated here as a segment source in ship space:
   closest point on the axis, inverse square with a softening radius, and a
   wrap so the lip of the nozzle is not a hard terminator.

   It is a *material* term rather than a real PointLight on purpose. A light
   added to the world scene recompiles and re-costs every standard material in
   the system — a couple of hundred draws — to light two nozzles. */
const PLUME_DECL = /* glsl */`
uniform float uPlumePow;
float plumeSeg(vec3 A, float len, float rad, vec3 P, vec3 N){
  float t = clamp(P.z - A.z, 0.0, len);
  vec3 L = vec3(A.x, A.y, A.z + t) - P;
  float q = dot(L, L) + rad*rad;
  vec3 Ln = L * inversesqrt(q);
  float nl = clamp(dot(N, Ln)*0.72 + 0.28, 0.0, 1.0);
  return nl*nl / q;
}
`;

/**
 * Dress a standard material with the shared hull treatment.
 * @param {THREE.Material} mat
 * @param {object} o  plate — plate size in metres; soot — 0..1 aft staining;
 *                    bleach — 0..1 how much the sun-facing side fades;
 *                    livery — 0..1 strength of the painted accent band;
 *                    glare — 0..1 coverage of the anti-glare top coat;
 *                    edge — 0..1 how much bare alloy shows at wear;
 *                    grazeF90 — grazing Fresnel left on the matte range;
 *                    brushed — 0..1 anisotropic roughness streaking;
 *                    rivet — 0..1 fastener rows and weld beads;
 *                    bump — 0..1 detail normal from the seam height field;
 *                    ao — 0..1 strength of the baked occlusion (see bakeSurface);
 *                    frame — plate the surface on a *structural* grid: regular
 *                            bay pitch, no missing frames, fastener rows on
 *                            every one, half-plate stagger (see plating);
 *                    doors — cut hatches and access panels into that grid;
 *                    marks — array of decal placements (see markGLSL);
 *                    plume — { power: <uniform>, at: [[x,y,z]…], len, rad,
 *                              col: [r,g,b], gain } drive glow, ship space
 */
export function dress(mat, o = {}) {
  const plate = (o.plate ?? 2.2);
  const soot = (o.soot ?? 0.5);
  const bleach = (o.bleach ?? 0.7);
  const livery = (o.livery ?? 0.0);
  const glare = (o.glare ?? (livery > 0 ? 0.82 : 0.55));
  const edge = (o.edge ?? 0.35);
  const f90 = (o.grazeF90 ?? 0.08);
  const brushed = (o.brushed ?? 0.5);
  const rivet = (o.rivet ?? 1.0);
  const bump = (o.bump ?? 1.0);
  const aoK = (o.ao ?? 1.0);
  const frame = o.frame ? 1 : 0;
  const doors = (o.doors ?? o.frame) ? 1 : 0;
  const matteMin = (o.matteMin ?? 0.0);
  const marks = o.marks || null;
  const plume = o.plume || null;
  const f = (n) => n.toFixed(4);
  const key = `hull_${plate}_${soot}_${bleach}_${livery}_${glare}_${edge}_${f90}_${brushed}`
    + `_${rivet}_${bump}_${aoK}_${frame}_${doors}_${matteMin}`
    + `_${marks ? JSON.stringify(marks) : 0}`
    + `_${plume ? JSON.stringify(plume.at) + plume.gain : 0}`;

  // Geometry that has not been through bakeSurface() has no aHull channel, and
  // (0,0) is exactly "no occlusion, no exposed edge" — so a station built from
  // the same kit is unchanged rather than fully shadowed.
  mat.defaultAttributeValues = Object.assign({}, mat.defaultAttributeValues, { aHull: [0, 0] });

  mat.onBeforeCompile = (shader) => {
    bindLight(shader);

    let decalDecl = '', decalCode = '';
    if (marks && marks.length) {
      const sheet = decalSheet();
      if (sheet.tex) {
        shader.uniforms.uDecal = { value: sheet.tex };
        decalDecl = '\nuniform sampler2D uDecal;\n' + INK;
        decalCode = marks.map((m) => markGLSL(m, sheet.cells)).join('');
      }
    }

    let plumeDecl = '', plumeCode = '';
    if (plume) {
      shader.uniforms.uPlumePow = plume.power;
      plumeDecl = PLUME_DECL;
      const c = plume.col || [0.60, 0.76, 1.0];
      const seg = plume.at.map((a) =>
        `      pg += plumeSeg(vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])}), `
        + `${f(plume.len ?? 22)}, ${f(plume.rad ?? 2.4)}, vShipPos, vShipNrm);`).join('\n');
      plumeCode = /* glsl */`
    {
      float pg = 0.0;
${seg}
      // a floor, so the bell is still lit from inside when the drive is idling
      vec3 pc = vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])})
              * (pg * ${f(plume.gain ?? 40)} * max(uPlumePow, 0.075));
      reflectedLight.directDiffuse += pc * BRDF_Lambert(material.diffuseContribution) * cav;
      // the nozzle lip and the alloy aft of it pick it up as a highlight too
      reflectedLight.directSpecular += pc * material.specularColorBlended
                                     * (0.35 / (1.0 + rgh*rgh*22.0)) * cav;
    }`;
    }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aHull;\n'
        + 'varying vec3 vShipPos;\nvarying vec3 vShipNrm;\nvarying vec2 vHull;')
      .replace('#include <begin_vertex>', HULL_VERT_HOOK);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + HULL_PARS + LIGHT_DECL + decalDecl + plumeDecl)
      .replace('#include <lights_physical_fragment>',
        MATTE_HOOK.replace('MATTE_F90', f90.toFixed(3))
          .replace('MATTE_MIN', matteMin.toFixed(3)))
      // Grooves are geometry the mesh does not have, so they have to occlude
      // the indirect terms themselves or the ambient floods straight back into
      // them and the plating reads as a printed pattern rather than a surface.
      .replace('#include <lights_fragment_end>',
        RIM_HOOK.replace('CAVITY', 'hullCav').replace('PLUME_LIGHT', plumeCode))
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        /* Everything the rest of the shader needs is computed once, here.
           <map_fragment> runs before roughness, metalness and emissive, so the
           expensive noise is paid for exactly once instead of three times. */
        float hullWear = 0.0;
        float hullCav = 1.0;
        float hullSeam = 0.0, hullLip = 0.0, hullTooth = 0.5;
        float hullBrush = 0.5, hullGrime = 0.0, hullAft = 0.0, hullPlate = 0.5;
        float hullDrip = 0.0;
        float hullHgt = 0.0, hullFine = 0.0, hullRiv = 0.0, hullBead = 0.0;
        /* Band-limited copies of the two noise fields that end up in the
           *specular* answer, and the projected-size gate for the wear. See the
           note at the band limits below: procedural detail has no mip chain, so
           anything that steers roughness, metalness or the normal has to be
           faded out by hand at the size it stops being resolvable, or it comes
           back as a dotted white fringe on every truss member and plate edge. */
        float hullToothQ = 0.5, hullBrushQ = 0.5, hullDet = 1.0;
${decalCode ? '        float hullInk = 0.0;' : ''}
        {
          float mpp = max(length(fwidth(vShipPos)), 1e-6);   // metres per pixel
          /* Plate size is not one number. It already varies by surface class —
             a barrel is plated to its radius, a flank finer than a deck — but
             within a class it was one grid over the whole ship, and at 1:1 that
             is what gives away a tiled texture: a yard does not roll the same
             sheet for the prow, the tank saddles and the sail. A slow draw over
             about twenty metres puts a different sheet size on each module
             without ever putting a seam between them, which a per-part id
             could not do anyway — the whole hull is four merged meshes.

             Except that a structural grid cannot drift. A bay pitch that wanders
             by a third over twenty metres is exactly why the flank read as an
             arbitrary scatter rather than as panelling: no two seams are
             parallel and no run of plates is one length, so there is no station
             for a frame to be at. Under the frame option the pitch is fixed
             and the variety comes from where it belongs: the four gauges the
             hull actually rolls, which is a yard's answer, not a shader's. */
          float S  = ${(1.0 / plate).toFixed(4)}
                   ${frame ? '' : '* (0.84 + 0.30*hNoise(vShipPos*0.046 + 17.0))'};
          // A fastener head is about 30 mm and a weld bead about 60; both are
          // gone long before the plate they sit on is.
          float fine = hullLod(${(0.055 * plate).toFixed(4)}, mpp) * ${rivet.toFixed(3)};
          hullFine = fine;
          vec3 sm, dt, fnm = vec3(0.0, 0.0, 0.5), fdt;
          vec2 hd, fhd;
          plating(vShipPos, vShipNrm, S, 0.026, fine, ${frame ? '1.0' : '0.0'}, sm, dt, hd);
          ${doors ? '' : 'hd = vec2(0.0);   // frames, but nothing cut into them'}
          // The second, finer octave of plating is a whole traversal of the
          // law; at chase distance it lands under a pixel and there is no
          // reason to walk it at all.
          float fLod = hullLod(${(0.30 * plate).toFixed(4)}, mpp);
          if (fLod > 0.004) plating(vShipPos + 41.0, vShipNrm, S*3.1, 0.040, 0.0, 0.0, fnm, fdt, fhd);
          /* The hatch perimeter is folded straight into the seam channel rather
             than shaded separately, because that is what it physically is: the
             gap round a door leaf is a plate joint, and every term downstream —
             the dark groove, the burnished lip, the dirt that washes out of it,
             the cavity that stops indirect light reaching in, the roughness
             lift and the relief — is already written for one. Shading it on its
             own account is how a hatch ends up as a drawn rectangle with a
             hairline bevel, which is the finding. */
          float pl = max(sm.x, hd.y*0.85), px = fnm.x * fLod;
          float lip = sm.y*0.55 + fnm.y*0.20*fLod;
          hullSeam = pl; hullLip = lip; hullPlate = sm.z;
          float rivets = max(dt.x, hd.y*fine*0.9), bead = dt.y, wash = dt.z;
          float door = hd.x;
          hullRiv = rivets; hullBead = bead;

          /* ---- band limits.
             Everything below this line that steers *roughness, metalness or the
             normal* is faded out at the size its own feature stops being
             resolvable. Procedural detail has no mip chain — nothing prefilters
             it — and MSAA antialiases coverage, not shading, so a wear patch or
             a brush streak that lands under a pixel does not read as fine
             detail. It reads as a specular answer that changes completely from
             one pixel to the next, which the chromatic-aberration taps in post
             then pull apart into a dotted white and magenta fringe: glitter
             crawling on every truss member and plate edge, worst on the
             thinnest geometry and closest to the lens, which is exactly where
             an art director found it.

             The gauge for each is the feature's own wavelength in metres.
             hullLod holds full strength above about five pixels and is gone
             under two, which is where a normal stops being a normal and becomes
             a distribution of normals. The *albedo* half of each term is left
             alone: an albedo that averages is simply a slightly darker plate,
             which is the correct answer, and it is what keeps the panel read at
             chase distance after the relief has gone. */
          float lodT = hullLod(0.40, mpp);                            // paint tooth
          float lodB = hullLod(0.14, mpp);                            // brushing
          float lodP = hullLod(${(0.052 * plate).toFixed(4)}, mpp);   // one plate groove
          hullDet = hullLod(0.25, mpp);                               // a wear patch

          // Weathering at three scales: broad blotching from vacuum exposure,
          // streaks that run aft along the flow, and a fine tooth so the paint
          // never reads as a flat fill.
          float blotch = hFbm3(vShipPos*0.09);
          float streak = hFbm3(vec3(vShipPos.x*0.55, vShipPos.y*0.55, vShipPos.z*0.055));
          float tooth  = hFbm3(vShipPos*2.6);
          hullTooth = tooth;
          hullBrush = brush(vShipPos);
          hullToothQ = mix(0.5, tooth, lodT);
          hullBrushQ = mix(0.5, hullBrush, lodB);
          /* One patchiness draw, read at several scales — by the wear masks
             below, and by the relief at the end. Three separate noise fetches
             for three masks that are all "some places, not others" is
             twenty-four hashes a fragment for a difference nobody can see. */
          float mottle = hNoise(vShipPos*0.62 + 5.0);

          /* ---- what the bake knows that no amount of noise does.
             aHull.x is how enclosed this point is — the inside of a collar,
             the angle where a strut lands on a tube, the throat of a nozzle.
             aHull.y is the opposite: a lip, a rim, a corner, the one place on
             a painted hull where bare alloy is allowed to show. */
          float occ = vHull.x * ${aoK.toFixed(3)};
          float exposed = vHull.y;

          // Anti-glare paint on everything that faces the sky. Two-tone is what
          // gives the hull value contrast; without it every surface sits in the
          // same narrow band and the whole ship reads as one moulded piece.
          // Keying off the *normal* means it wraps the curves correctly and
          // needs no UVs across the merged geometry.
          float up = clamp(vShipNrm.y, 0.0, 1.0);
          float top = smoothstep(0.42, 0.86, up + (blotch-0.5)*0.22);
          vec3 antiGlare = vec3(0.030, 0.038, 0.046);
          diffuseColor.rgb = mix(diffuseColor.rgb, antiGlare, top*${glare.toFixed(3)});

          // Sun-bleaching, applied *after* the paint so the dark panel chalks
          // rather than staying showroom-fresh.
          float fade = pow(up, 1.9) * ${bleach.toFixed(2)} * (0.55 + blotch*0.7);
          diffuseColor.rgb = mix(diffuseColor.rgb,
                                 mix(diffuseColor.rgb, vec3(0.30,0.30,0.29), 0.42)*1.20, fade*0.75);

          // Soot: exhaust wash that starts behind the nozzles and thins forward.
          float aft = smoothstep(6.0, 46.0, vShipPos.z);
          float grime = aft * ${soot.toFixed(2)} * (0.35 + streak*0.9);
          hullAft = aft; hullGrime = grime;

          /* ---- grime.  One layer, and it is most of what separates a vehicle
             from a render of one. Side by side against a real game's ship this
             hull was bone white and *perfectly clean*: theirs has dirt running
             out of every panel joint, pooled around every housing and staining
             the greebles yellow, and ours had a mask so shy that a flank — the
             largest, palest, most-looked-at surface on the ship — picked up
             about nine per cent of it.

             Grime needs a direction, and a spacecraft has two. Thrust carries
             the exhaust wash *aft* along the hull on every burn, and every hour
             this ship spends standing on its gear runs the same dirt *down*
             toward the pads. So the flow is aft and down, and the noise is
             squashed across that axis rather than sampled round it — which is
             the whole difference between a streak and a blotch.

             And it needs a source. Dirt does not appear in the middle of a
             clean plate: it comes out of a gap — the wash term, registered to
             the panel grid, which already dies within one plate of the seam it
             left — or out of the fold where a fitting lands on a hull, which is
             the occlusion the bake found and which no amount of noise knows.
             Source times flow is the effect; either alone is a stain map. */
          vec3 FLOW = vec3(0.0, -0.5289, 0.8487);            // aft and down
          vec3 sp = vShipPos - FLOW*dot(vShipPos, FLOW)*0.86;
          float run = hFbm3(sp*0.62 + 11.0);
          // A surface streaks when the flow runs across it. One that faces
          // straight into it is scoured instead, and one facing away is dry.
          float face = 1.0 - abs(dot(vShipNrm, FLOW));
          float pool = smoothstep(0.05, 0.44, occ);
          float src  = clamp(wash*1.20 + pool*0.90 + pl*0.35, 0.0, 1.0);
          float drip = smoothstep(0.28, 0.80, run) * face * (0.26 + 0.95*src)
                     * smoothstep(-44.0, -4.0, vShipPos.z);
          // and it caked in the folds whether anything ran out of them or not.
          // Scaled by the material's own aft-staining number, because a ceramic
          // radiator face has to stay the brightest thing on the hull and a
          // drive shroud is allowed to be filthy — one grime layer, but not one
          // amount of it.
          drip = clamp(drip*1.30 + pool*0.34, 0.0, 1.0) * ${(0.34 + 0.66 * soot).toFixed(3)};
          hullDrip = drip;

          // The groove itself: dark, and dirtier than the plate face. The lip
          // either side of it is burnished by handling, so it comes back up.
          diffuseColor.rgb *= 1.0 - pl*0.58 - px*0.14 + lip*0.055;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.048,0.044,0.040),
                                 pl*(0.20 + 0.30*streak) + px*0.06);
          /* Per-plate albedo. This is the whole difference between a hull and
             a moulded shell, and it is the one thing the previous plating law
             had no way to express: it knew where the seams were but not which
             side of one it was on. Two independent draws — one for the panel,
             one for the batch of panels around it — so the drum reads as
             sections of plate rather than as static. */
          float batch = hHash(vec3(floor(vShipPos.z*${(0.18 / plate).toFixed(4)}), 5.5, 1.9));
          diffuseColor.rgb *= 0.80 + 0.38*sm.z;
          diffuseColor.rgb *= 0.90 + 0.20*batch;
          // and some panels were replaced later than others, so they are less
          // chalked and a shade colder than the paint around them
          diffuseColor.rgb = mix(diffuseColor.rgb,
                                 diffuseColor.rgb*vec3(0.86,0.92,1.02),
                                 smoothstep(0.72, 0.94, sm.z));
          diffuseColor.rgb *= 0.74 + blotch*0.44;
          diffuseColor.rgb *= 0.90 + tooth*0.20;
          diffuseColor.rgb *= 1.0 - grime*0.55 - drip*0.22;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.026,0.024,0.023), grime*0.42);
          /* Two steps, because dirt is not a grey filter. First the paint under
             it goes warm and dark — that is the stain itself, and keeping it a
             multiply means a bleached panel stains lighter than a sooted one,
             which is what actually happens. Then a little opaque muck on top,
             for the heavy end. Doing only the second put a flat grey wash over
             the livery and killed the one warm colour on the ship. */
          diffuseColor.rgb = mix(diffuseColor.rgb,
                                 diffuseColor.rgb*vec3(0.66,0.575,0.475), drip*0.86);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.050,0.042,0.033), drip*0.34);

          /* A hatch is a different sheet from the hull it is let into — a door
             leaf gets replaced, repainted and handled on its own schedule — and
             it sits *in* a shadowed recess, which is the half of it that the
             drawn rectangle could never do. Kept small on the albedo: the read
             has to come from the recess catching the key, not from a darker
             rectangle, or it is the same defect in a different colour. */
          diffuseColor.rgb *= 1.0 - door*0.10;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(0.95,0.97,1.03), door*0.55);

          // Fastener heads catch the light; a weld bead is proud of the plate
          // and burned clean of paint along its crown.
          diffuseColor.rgb *= 1.0 + rivets*0.26;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(1.16,1.06,0.92), bead*0.70);

          // Dirt collects where a surface folds into itself, and no amount of
          // fbm puts it in the right place.
          diffuseColor.rgb *= 1.0 - occ*0.26;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.030,0.028,0.027), occ*0.16);

          // The cavity term the lighting tail uses. A seam, the fine detail
          // scale, the caked soot and the baked occlusion all shade what
          // indirect light can reach.
          hullCav = clamp(1.0 - pl*0.50 - px*0.18 - grime*0.20 - drip*0.20 - occ*0.58
                              - door*0.22, 0.08, 1.0);
${decalCode ? /* glsl */`
          // ---- markings.  Painted on top of the weathering and then worn back
          // into it, so a stencil sits in the paint instead of floating over it.
          // The wear mask reuses the fine tooth rather than fetching its own
          // fbm: five octaves of 3D noise is the most expensive thing in this
          // shader and there is no reason to pay for it twice.
          //
          // It is a *wear* mask and nothing else. Anything that pulls the ink
          // below about 0.8 stops reading as paint and starts reading as an
          // out-of-focus texture, which is what made the small lettering mush.
          vec3 ink = vec3(0.0);
${decalCode}
          ink = clamp(ink, 0.0, 1.0);
          float dwear = (0.86 + 0.14*tooth) * (1.0 - grime*0.45) * (1.0 - pl*0.55);
          diffuseColor.rgb = mix(diffuseColor.rgb, INK_L, ink.r*dwear);
          diffuseColor.rgb = mix(diffuseColor.rgb, INK_D, ink.g*dwear);
          diffuseColor.rgb = mix(diffuseColor.rgb, INK_O, ink.b*dwear);
          // Paint is a film on top of the plate, so it is smoother than the
          // chalk around it and it is the giveaway that a marking is painted
          // on rather than printed in.
          hullInk = max(max(ink.r, ink.g), ink.b) * dwear;
` : ''}
${edge > 0.001 ? /* glsl */`
          /* ---- bare alloy where a hull actually wears.  Three causes, all
             physical: a lip or a rim is what a boot, a toolbox and a docking
             collar actually hit; plate edges get handled and scuffed; and
             everything facing into the direction of travel is scoured by dust.
             Nothing else on the ship is allowed to show metal, which is what
             keeps the wear reading as history rather than as noise — and it is
             why every ring, rail and nozzle lip here is *painted* alloy with
             the bare metal masked back in, rather than a chrome cylinder. */
          float lead  = clamp(-vShipNrm.z, 0.0, 1.0);
          float scour = pow(lead, 2.2) * smoothstep(0.30, 0.64, mottle);
          float chip  = (lip*1.25 + pl*0.55) * smoothstep(0.62, 0.26, mottle) * lodP;
          /* The rim mask is *broken*, not drawn. A 30 cm handrail in a 85 cm
             voxel has almost no matter around it, so the bake reads the whole
             rail as exposed — which is fair, a rail is exposed — but running
             an unbroken line of bare alloy down every rail, ring and bevel on
             the ship put a white outline round every part in the frame. Paint
             wears off in patches. The tooth is already in hand and is exactly
             the right frequency for one.

             And the *break* has to converge on its own mean once it goes under
             a pixel, rather than resolving to whichever side of 0.34 the noise
             happened to land on. A binary mask sampled below its own Nyquist is
             not detail, it is a coin toss per pixel, and the coin was being
             tossed on the thinnest geometry on the ship — every truss member
             read as bare metal here and painted there, one pixel apart. */
          float rim   = exposed * mix(0.62, smoothstep(0.34, 0.70, tooth), lodT)
                      * (0.55 + 0.45*mottle);
          hullWear = clamp(chip*1.05 + scour*0.75 + rim*0.85, 0.0, 1.0)
                   * ${edge.toFixed(2)} * (1.0 - grime*0.5) * (1.0 - occ*0.6);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.150,0.142,0.130), hullWear*0.62);
` : ''}
          /* ================================================= relief =========
             Everything above changes what a surface *is*; this is the same
             surface expressed as height, and it is the difference between a
             hull that is lit and a hull that is printed. An audit of the live
             scene graph found zero normal maps on 243 exterior materials and
             called it the largest single contributor to "the lighting looks
             unrealistic" — larger than the light rig. It is right: a panel
             line that is only an albedo stripe cannot catch a highlight, and
             a rivet with no normal is a dot.

             Authored in real metres of relief, coarse to fine, in the order
             the eye actually reads them: the plate bows, it laps its
             neighbour, the joint is cut into it, hardware stands on it, the
             hull is pitted, and the paint has a tooth. Nothing here is a new
             noise field except the craters — the bow, the tooth, the grain
             and the wash are all octaves this shader has already paid for,
             which is why a great deal more surface costs almost nothing.

             Everything under about a decimetre is gated by hullLod, because a
             feature authored below the sample spacing is not detail, it is
             static that crawls. */
          float u2m = max(length(fwidth(vViewPosition)), 1e-9) / mpp;
          float hgt = 0.0;

          /* Rolled plate is never flat. It bows between its frames by a few
             millimetres — what a coachbuilder calls oil-canning — and it is
             the one thing that separates sheet metal from a solid billet
             under a raking key: a flat face returns one value across its
             whole width and a bowed one returns a slow gradient with an edge
             at every frame. The streak octave is already in hand and is
             squashed *across* the hull, which is the axis a plate bows on. */
          hgt += (streak - 0.5)*0.030 + (mottle - 0.5)*0.011;

          /* A lap joint. Plates overlap; the sheet on one side of a seam
             stands a few millimetres proud of the one on the other, and that
             asymmetry is most of what reads as construction rather than as a
             scored line. The gap wash is already exactly this field — one
             sided, registered to the panel grid, dying within one plate —
             which is also why the dirt and the step co-register, as they do
             on anything that has ever been outside. */
          hgt += wash*0.0045;

          /* The joint itself, and the hardware standing on it.

             Band-limited by the groove's own width, which for a 2.4 m plate is
             about 125 mm: under two pixels of that, a normal taken from the
             screen-space gradient of the height field is not the seam's normal,
             it is whatever the gradient happened to be inside one pixel. The
             albedo groove stays — a seam that averages to a darker line is the
             right answer — and hullSeam still lifts the roughness at the same
             place, which is the honest way to spend the variance a normal map's
             mip chain would have absorbed. */
          hgt += (-pl*0.034 - px*0.013 + lip*0.005)*lodP + rivets*0.016 + bead*0.012;

          /* The hatch: a real recess, 30 mm deep with a lipped edge, which is
             the whole of what separates a door from a drawn rectangle. Under a
             raking key one side of it goes dark and the other catches a hard
             line; a painted rectangle does neither, at any light angle. */
          hgt += (-door*0.030 - hd.y*0.006)*lodP;

          /* Doublers bolted over the plate. Held off the rims and edges the
             bake found — a pad standing on a nozzle lip or a handrail is not
             a doubler, it is a bug — and scaled by the material's own
             hardware number, so a ceramic radiator face stays clean and a
             drive shroud does not. */
          float dk = hullLod(0.30, mpp) * ${rivet.toFixed(3)} * (1.0 - exposed);
          if (dk > 0.01) {
            float pad = padH(vShipPos, vShipNrm, 1.45) * dk;
            hgt += pad*0.0095;
            // a doubler is its own sheet, cut from its own batch of stock
            diffuseColor.rgb *= 1.0 - pad*0.09;
          }

          /* Impact history. Gated hard: a five-centimetre crater is under a
             pixel from anywhere but a close pass, and the branch is
             screen-coherent, so whole tiles skip it at once. */
          float pk = hullLod(0.10, mpp);
          if (pk > 0.01) hgt += pitH(vShipPos, 2.8)*0.0110*pk;

          /* The tooth of the paint and the grain of the metal under it. Both
             sub-millimetre, both gone by the time the ship is a hundred
             metres away, and between them they are the reason a surface at
             1:1 stops being a plane with marks on it. */
          float tk = hullLod(0.13, mpp);
          if (tk > 0.01) {
            hgt += (tooth - 0.5)*0.0016*tk
                 + (hullBrush - 0.5)*0.0011*${brushed.toFixed(3)}*tk;
          }

          // Caked soot has thickness, and a stencil is a film of paint on top
          // of the plate rather than a change of colour in it.
          hgt += drip*0.0020${decalCode ? ' + hullInk*0.00045' : ''};

          hullHgt = hgt * u2m;
        }
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        {
          // A polished part stays polished: the surface noise below is scaled by
          // how matte the material already is, so a mirrored trim ring is not
          // quietly sanded back to 0.28 and the ship keeps its one hard highlight.
          float grit = clamp((roughnessFactor - 0.13)*4.5, 0.0, 1.0);
          /* The floor, and it is the brief's floor. Brushing swings roughness
             by a quarter either way, which was taking a 0.55 composite down to
             0.32 on the light side of every band — a tight highlight on a
             near-black surface, which is the exact read of glossy plastic.
             Variation is allowed to make a surface *rougher* freely and
             smoother only down to here. */
          float rMin = min(0.36, roughnessFactor);
          /* Five causes, and the whole point of listing them separately is that
             one roughness for a whole material is what makes a hull read as one
             moulded piece however good the lighting and the albedo are:
               the groove is raw and dusty and the lip beside it is burnished;
               each plate weathered on its own schedule;
               the paint has a tooth that varies over a couple of metres;
               brushing runs *along* the hull, so the highlight breaks into
                 lengthwise bands instead of one soft blob;
               soot aft kills the sheen outright. */
          /* The tooth and the brushing arrive here *band-limited* — see the
             note where they are drawn. Both are sub-decimetre fields and both
             swing roughness by a quarter; sampled below their own Nyquist they
             put a different specular answer in every pixel, which is the
             glitter that was crawling on the trusses. Converged to their mean
             they are a slightly wider highlight instead, which is what the real
             surface would have done. */
          float dr = hullSeam*0.24 - hullLip*0.07
                   + (hullPlate-0.5)*0.20
                   + (hullToothQ-0.5)*0.22
                   + (hullBrushQ-0.5)*${(brushed * 0.62).toFixed(3)}
                   // a dirty streak is dust held on paint, and dust is matte:
                   // without this the grime reads as a dark *polish*
                   + hullDrip*0.30
                   + hullAft*${soot.toFixed(2)}*0.20;
          roughnessFactor = clamp(roughnessFactor + dr*grit, rMin, 1.0);
          /* Worn-through alloy is the only hard highlight left on the ship, so
             it has to be genuinely hard where it appears. It appears on rims
             and lips and nowhere else — and only while a patch of it is still
             several pixels across. Past that, the honest average of a metal rim
             and the paint around it is mostly paint: the albedo lightening above
             stays and the *specular character* goes, which is the difference
             between wear that reads as history and wear that reads as sparkle. */
          roughnessFactor = mix(roughnessFactor, 0.30, hullWear*0.70*hullDet);
          /* A fastener head is turned stock and gets handled, so it is
             burnished; a weld bead is scaled and never was painted. Half of
             what makes hardware read as hardware is that it answers the key
             differently from the plate it is set into. */
          roughnessFactor = clamp(roughnessFactor - hullRiv*0.20 + hullBead*0.16, 0.05, 1.0);
${decalCode ? '          roughnessFactor = mix(roughnessFactor, 0.42, hullInk*0.55);' : ''}
        }
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        #include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.82, hullWear*0.60*hullDet);
${decalCode ? '        metalnessFactor *= 1.0 - hullInk*0.7;' : ''}
      `);

    /* The detail normal. Without it the plating is a *print*: it changes the
       albedo and never catches the key, which is why a panel line seen at a
       raking angle read as drawn on rather than cut in. The relief is taken
       from the same height field the albedo used, so a groove, a fastener head
       and a weld bead all shade themselves for free.

       And then the roughness has to be widened to match it, which is the other
       half of the same job. A panel groove is about sixty millimetres across;
       at 1:1 on a Retina panel that is two or three pixels, and a normal that
       swings through its whole range inside three pixels puts a different
       specular answer in each one. Every panel line on the landed hull came
       back as a dotted magenta and cyan chain — sub-pixel specular sparkle,
       picked up and separated into its channels by the chromatic aberration
       pass, so it read as dirt at rest and would have crawled in motion.

       The fix is not in the post chain. A normal that varies inside a pixel is
       not a normal, it is a *distribution* of normals, and the honest way to
       shade a distribution is to fold its variance into the roughness — the
       same trade a mip chain makes for a normal map, done analytically from
       the screen-space derivative because this normal has no mip chain to make
       it from. Sparkle becomes a slightly wider highlight, which is what the
       real surface would have done. */
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
${bump > 0.001 ? `        normal = hullBump(normal, -vViewPosition, hullHgt, ${bump.toFixed(3)});` : ''}
        {
          vec3 dnx = dFdx(normal), dny = dFdy(normal);
          float nvar = dot(dnx, dnx) + dot(dny, dny);
          // Capped: past a quarter this stops being anti-aliasing and starts
          // sanding the trim rings flat wherever the geometry is dense.
          float widen = min(nvar*0.68, 0.24);
          roughnessFactor = sqrt(clamp(roughnessFactor*roughnessFactor + widen, 0.0, 1.0));
        }
      `);

    if (livery > 0.001) {
      // Stencilled markings: crisp transverse bands at the frame stations,
      // scuffed but never smeared. Sharp edges are the whole point — noisy
      // paint reads as corrosion, and corrosion reads as a shader bug.
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          // only on flanks that face outward, never on the anti-glare tops
          float side = 1.0 - abs(vShipNrm.y);
          float band = 0.0;
          band = max(band, 1.0 - smoothstep(0.30, 0.55, abs(vShipPos.z + 19.5)));
          band = max(band, 1.0 - smoothstep(0.30, 0.55, abs(vShipPos.z + 17.9)));
          band = max(band, 1.0 - smoothstep(0.55, 0.85, abs(vShipPos.z - 7.4)));
          // the fine tooth is already in hand from <map_fragment>; a second
          // five-octave fbm for a scuff mask is the most expensive thing in
          // the shader bought twice
          float scuff = smoothstep(0.26, 0.62, hullTooth);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36,0.105,0.022),
                                 band*side*scuff*${livery.toFixed(2)});
        }
      `);
    }
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}


/* =============================================================== the bake

   Everything above is evaluated per fragment from a position and a normal,
   and there is one thing a position and a normal cannot know: what the rest of
   the ship is doing three metres away. That is why a procedural hull has no
   contact shadow where a collar lands on a tube and no wear on the lip of a
   nozzle — the shader has no idea either exists.

   So it is baked, once, at build. A coarse voxel occupancy of the whole vessel
   answers one question per vertex — how much matter surrounds this point —
   and that single number is both halves of the answer:

     more matter than a flat plate has  ->  a crevice, a corner, a throat.
                                            Occlusion, and dirt collects there.
     less                               ->  a lip, a rim, an edge, a boss.
                                            This is where paint wears through.

   The calibration is taken from the distribution rather than from constants,
   so a 400 m derelict and an 84 m survey boat both come out with flat plate at
   zero. Cost is a few tens of milliseconds at build for the player's hull and
   nothing at all per frame, which is the same trade the interior took when it
   went from procedural shaders to baked maps and got both sharper and cheaper.
   ========================================================================== */

/** 26 directions — the face, edge and corner neighbours of a cube. */
const _dirs = (() => {
  const d = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (x || y || z) {
          const l = Math.hypot(x, y, z);
          d.push(x / l, y / l, z / l);
        }
      }
    }
  }
  return new Float32Array(d);
})();

/**
 * Coarse voxel occupancy of a set of placed geometries, in their shared space.
 * @param {THREE.BufferGeometry[]} geos
 * @param {number} cell  voxel size in metres
 */
export function occupancy(geos, cell = 0.85) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const g of geos) {
    const p = g.attributes.position;
    if (!p) continue;
    const a = p.array;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i] < x0) x0 = a[i]; if (a[i] > x1) x1 = a[i];
      if (a[i + 1] < y0) y0 = a[i + 1]; if (a[i + 1] > y1) y1 = a[i + 1];
      if (a[i + 2] < z0) z0 = a[i + 2]; if (a[i + 2] > z1) z1 = a[i + 2];
    }
  }
  if (!isFinite(x0)) return null;
  // one voxel of margin, so a sample stepping off the hull lands in the grid
  const pad = cell * 5;
  x0 -= pad; y0 -= pad; z0 -= pad; x1 += pad; y1 += pad; z1 += pad;
  const inv = 1 / cell;
  const nx = Math.max(2, Math.min(200, Math.ceil((x1 - x0) * inv)));
  const ny = Math.max(2, Math.min(200, Math.ceil((y1 - y0) * inv)));
  const nz = Math.max(2, Math.min(200, Math.ceil((z1 - z0) * inv)));
  const data = new Uint8Array(nx * ny * nz);
  const grid = { x0, y0, z0, inv, nx, ny, nz, data, cell };

  const mark = (x, y, z) => {
    const i = ((x - x0) * inv) | 0, j = ((y - y0) * inv) | 0, k = ((z - z0) * inv) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    data[(k * ny + j) * nx + i] = 1;
  };
  // Rasterise every triangle at better than one sample per voxel. A hull is a
  // few thousand square metres; at this cell size that is tens of thousands of
  // samples, not millions.
  for (const g of geos) {
    const p = g.attributes.position;
    if (!p) continue;
    const a = p.array;
    const idx = g.index ? g.index.array : null;
    const n = idx ? idx.length : p.count;
    for (let t = 0; t < n; t += 3) {
      const i0 = (idx ? idx[t] : t) * 3;
      const i1 = (idx ? idx[t + 1] : t + 1) * 3;
      const i2 = (idx ? idx[t + 2] : t + 2) * 3;
      const ax = a[i0], ay = a[i0 + 1], az = a[i0 + 2];
      const bx = a[i1], by = a[i1 + 1], bz = a[i1 + 2];
      const cx = a[i2], cy = a[i2 + 1], cz = a[i2 + 2];
      const e = Math.max(
        Math.hypot(bx - ax, by - ay, bz - az),
        Math.hypot(cx - ax, cy - ay, cz - az),
        Math.hypot(cx - bx, cy - by, cz - bz));
      const s = Math.min(12, Math.max(1, Math.ceil(e * inv * 1.4)));
      for (let u = 0; u <= s; u++) {
        for (let v = 0; v <= s - u; v++) {
          const wu = u / s, wv = v / s, ww = 1 - wu - wv;
          mark(ax * ww + bx * wu + cx * wv,
            ay * ww + by * wu + cy * wv,
            az * ww + bz * wu + cz * wv);
        }
      }
    }
  }
  return grid;
}

/**
 * Write the `aHull` channel — (occlusion, exposed edge) — onto every geometry
 * in `geos`, from a grid built by `occupancy()`. Calibrated across the whole
 * list at once so "flat plate" means the same thing on all of them.
 */
export function bakeSurface(geos, grid) {
  if (!grid) return;
  const { x0, y0, z0, inv, nx, ny, nz, data, cell } = grid;
  const at = (x, y, z) => {
    const i = ((x - x0) * inv) | 0, j = ((y - y0) * inv) | 0, k = ((z - z0) * inv) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
    return data[(k * ny + j) * nx + i];
  };
  // Two shells. The near one finds a lip; the far one finds a pocket.
  const R = [cell * 1.7, cell * 3.4];
  const W = [0.62, 0.38];
  const nd = _dirs.length / 3;

  // One value per distinct position: a merged, de-indexed hull carries each
  // corner three or four times over and the answer is the same every time.
  const seen = new Map();
  const enc = [];
  const key = (x, y, z) => (
    (Math.round(x * 8) + 8192) * 16777216
    + (Math.round(y * 8) + 8192) * 4096
    + (Math.round(z * 8) + 8192));

  const perGeo = [];
  for (const g of geos) {
    const p = g.attributes.position;
    if (!p) { perGeo.push(null); continue; }
    const a = p.array, ids = new Int32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
      const k = key(x, y, z);
      let id = seen.get(k);
      if (id === undefined) {
        id = enc.length;
        seen.set(k, id);
        let s = 0, tot = 0;
        for (let r = 0; r < R.length; r++) {
          const rr = R[r], w = W[r];
          for (let d = 0; d < nd; d++) {
            s += w * at(x + _dirs[d * 3] * rr, y + _dirs[d * 3 + 1] * rr, z + _dirs[d * 3 + 2] * rr);
            tot += w;
          }
        }
        enc.push(s / tot);
      }
      ids[i] = id;
    }
    perGeo.push(ids);
  }

  /* Calibrate off the distribution, but with a floor under the span.
     Percentiles alone adapt to *any* object, which is wrong: a landing leg is
     nothing but struts, its enclosure values are all within a few per cent of
     each other, and stretching that to 0..1 painted the whole leg as an
     exposed edge. The absolute numbers are knowable — a flat plate sits near
     0.3 of the shell occupied, a lip near 0.15, a crevice past 0.5 — so the
     ramp is never allowed to be narrower than that, and a uniform object comes
     out uniform. The curves are deliberately steep: wear belongs on a couple
     of per cent of a hull, not a third of it. */
  const sorted = Float32Array.from(enc).sort();
  const q = (t) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(t * (sorted.length - 1))))];
  const flatA = q(0.62), flatB = q(0.42);
  const deep = Math.max(flatA + 0.13, q(0.97));
  const lip = Math.min(flatB - 0.13, q(0.03));

  const out = new Float32Array(enc.length * 2);
  for (let i = 0; i < enc.length; i++) {
    const e = enc[i];
    const a = Math.min(1, Math.max(0, (e - flatA) / (deep - flatA)));
    const b = Math.min(1, Math.max(0, (flatB - e) / (flatB - lip)));
    out[i * 2] = a * a * (3 - 2 * a);
    out[i * 2 + 1] = Math.pow(b, 2.3);
  }

  for (let gi = 0; gi < geos.length; gi++) {
    const ids = perGeo[gi];
    if (!ids) continue;
    const buf = new Uint8Array(ids.length * 2);
    for (let i = 0; i < ids.length; i++) {
      buf[i * 2] = (out[ids[i] * 2] * 255) | 0;
      buf[i * 2 + 1] = (out[ids[i] * 2 + 1] * 255) | 0;
    }
    geos[gi].setAttribute('aHull', new THREE.BufferAttribute(buf, 2, true));
  }
}

/* ------------------------------------------------------------ part helpers */

/**
 * Bake a transform into a geometry so `position` stays object space.
 *
 * Everything is de-indexed on the way through: `ExtrudeGeometry` comes back
 * non-indexed and the primitives come back indexed, and `mergeGeometries`
 * refuses a mixed list. Uniform attributes matter too — merge compares the
 * attribute *set*, so anything carrying a stray channel has to lose it.
 */
export function place(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = null } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (scale) g.scale(scale[0], scale[1], scale[2]);
  if (rot[0]) g.rotateX(rot[0]);
  if (rot[1]) g.rotateY(rot[1]);
  if (rot[2]) g.rotateZ(rot[2]);
  g.translate(pos[0], pos[1], pos[2]);
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

/* --------------------------------------------------------- chamfer floor
   A chamfer is not decoration, it is the only thing that makes an edge *visible*
   against a black sky: the key rakes across it and leaves a bright line where a
   knife edge leaves nothing at all. So the number that matters is not a
   proportion of the part, it is how many pixels the break subtends — and at the
   distance the hull is actually judged from (a metre of ship is roughly a
   hundred pixels) anything under about five centimetres is gone.

   This used to be one number for both the corner radius in plan *and* the
   chamfer along the extrusion, clamped to 45% of the thinnest axis and then
   halved. On a radiator leaf 300 mm thick that produced 34 mm of chamfer on a
   4.6 m chord and a 20 m span — a sheet of card, and the audit called it
   exactly that. The two numbers are now separate: the corner radius still
   cannot exceed the part, but the chamfer gets a floor in absolute metres and
   is only limited by geometry (it can never exceed the radius it is cut into,
   or half the extrusion depth, or the shape inverts). Chunky parts are
   unaffected — for anything with a radius over ~140 mm the old b*0.5 already
   clears the floor. */
const CHAMFER_FLOOR = 0.07;

/** A rounded slab — the workhorse for panels, pylons and structure. */
export function slab(w, h, d, bevel = 0.12) {
  const s = new THREE.Shape();
  const hw = w / 2, hh = h / 2, b = Math.min(bevel, hw * 0.45, hh * 0.45);
  const c = Math.min(Math.max(b * 0.5, CHAMFER_FLOOR), b * 0.92, d * 0.42);
  s.moveTo(-hw + b, -hh);
  s.lineTo(hw - b, -hh); s.quadraticCurveTo(hw, -hh, hw, -hh + b);
  s.lineTo(hw, hh - b); s.quadraticCurveTo(hw, hh, hw - b, hh);
  s.lineTo(-hw + b, hh); s.quadraticCurveTo(-hw, hh, -hw, hh - b);
  s.lineTo(-hw, -hh + b); s.quadraticCurveTo(-hw, -hh, -hw + b, -hh);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: d, bevelEnabled: true, bevelSize: c, bevelThickness: c, bevelSegments: 2, curveSegments: 4,
  });
  g.translate(0, 0, -d / 2);
  return g;
}

/**
 * An arbitrary flat polygon, extruded and bevelled — a tapered fin, a bracket,
 * a swept vane. `slab()` can only make rectangles, and a hull built entirely
 * out of rectangles is exactly what reads as a kit-bash: a *taper* is what tells
 * the eye a part was designed for its load rather than cut from stock.
 *
 * @param {Array<[number,number]>} pts  polygon in the XY plane, extruded along Z
 */
export function panel(pts, thick, bevel = 0.10) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  /* Same floor as slab(): the bevel here offsets the whole outline inward at
     both ends of the extrusion, so it is the chamfer that reads round the
     silhouette of a fin. The caller still owns the upper bound — a bevel wider
     than half the polygon's narrowest neck turns that neck inside out, and
     nothing here can measure that.

     Zero (or negative) turns it off outright, and that is not a shortcut: the
     offset is applied to the *whole* outline, so a profile whose own features
     are shallower than the bevel — a corrugated sheet at 38 mm of depth under a
     160 mm chamfer — self-intersects, and the ribs vanish into a swollen
     rectangle. It is also three times the side geometry, which on a plan
     section with two hundred points a flank is what pays for the pitch being
     right in the first place. */
  const off = bevel > 0;
  const b = Math.min(Math.max(bevel, CHAMFER_FLOOR), thick * 0.45);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: thick, bevelEnabled: off, bevelSize: b, bevelThickness: b,
    bevelSegments: 1, curveSegments: 2,
  });
  g.translate(0, 0, -thick / 2);
  return g;
}

/**
 * A chamfered rectangular section carried along +X — a boom that tapers into
 * what it carries, a pylon that steps where it leaves the hull, a fairing that
 * swells and closes again.
 *
 * `slab()` and `panel()` can only taper in one plane: an extrusion has one
 * constant depth by definition, so a pylon built out of either has the same
 * section at the root as it has at the nacelle. That uniform rectangular
 * section is the single loudest tell that a part was placed rather than
 * designed — a real strut is deepest where the bending moment is, and the
 * eye knows it even when it cannot say why.
 *
 * Stations are `[x, halfDepth(z), halfHeight(y), yOffset, zOffset]`, in
 * increasing x. The chamfer is given in metres and held constant along the
 * span the way a real extrusion holds it, rather than as a fraction that
 * would open out as the section grows.
 *
 * Faces are emitted flat, one normal per triangle: an averaged chamfer is not
 * a chamfer, it is a fillet with no edge in it, and the whole point of the
 * chamfer is the hard bright line. (The hull merges and recomputes anyway,
 * which on de-indexed geometry gives the same answer.)
 */
export function loftBox(stations, cham = 0.18, capA = true, capB = true) {
  const N = 8;
  const rings = stations.map(([x, hz, hy, yo = 0, zo = 0]) => {
    const cz = Math.min(cham, hz * 0.62), cy = Math.min(cham, hy * 0.62);
    // Counter-clockwise in the (z, y) plane, so the swept normal points out.
    const S = [
      [hz, -hy + cy], [hz, hy - cy], [hz - cz, hy], [-hz + cz, hy],
      [-hz, hy - cy], [-hz, -hy + cy], [-hz + cz, -hy], [hz - cz, -hy],
    ];
    const p = new Float32Array(N * 3);
    for (let k = 0; k < N; k++) {
      p[k * 3] = x; p[k * 3 + 1] = S[k][1] + yo; p[k * 3 + 2] = S[k][0] + zo;
    }
    return p;
  });
  const m = rings.length;
  const tris = (m - 1) * N * 2 + (capA ? N - 2 : 0) + (capB ? N - 2 : 0);
  const pos = new Float32Array(tris * 9);
  const nrm = new Float32Array(tris * 9);
  const uvs = new Float32Array(tris * 6);
  let t = 0;
  const put = (r0, k0, r1, k1, r2, k2) => {
    const A = rings[r0], B = rings[r1], C = rings[r2];
    const ax = A[k0 * 3], ay = A[k0 * 3 + 1], az = A[k0 * 3 + 2];
    const bx = B[k1 * 3], by = B[k1 * 3 + 1], bz = B[k1 * 3 + 2];
    const cx = C[k2 * 3], cy2 = C[k2 * 3 + 1], cz2 = C[k2 * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy2 - ay, vz = cz2 - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const o = t * 9, q = t * 6;
    pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
    pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
    pos[o + 6] = cx; pos[o + 7] = cy2; pos[o + 8] = cz2;
    for (let i = 0; i < 3; i++) { nrm[o + i * 3] = nx; nrm[o + i * 3 + 1] = ny; nrm[o + i * 3 + 2] = nz; }
    uvs[q] = k0 / N; uvs[q + 1] = r0 / (m - 1);
    uvs[q + 2] = k1 / N; uvs[q + 3] = r1 / (m - 1);
    uvs[q + 4] = k2 / N; uvs[q + 5] = r2 / (m - 1);
    t++;
  };
  for (let j = 0; j < m - 1; j++) {
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      put(j, k, j + 1, k, j, k2);
      put(j, k2, j + 1, k, j + 1, k2);
    }
  }
  if (capA) for (let k = 1; k < N - 1; k++) put(0, 0, 0, k, 0, k + 1);
  if (capB) for (let k = 1; k < N - 1; k++) put(m - 1, 0, m - 1, k + 1, m - 1, k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return g;
}

/**
 * A tube between two points in space, with the end fittings that stop a strut
 * reading as a length of pipe someone left in the frame.
 *
 * Euler angles are the wrong tool for a brace: a jury strut runs from a lug on
 * a hull to a lug on a nacelle and the only thing that matters is those two
 * points. Returns a list ready for `mergeGeometries`.
 */
export function strut(a, b, r0, r1 = r0, seg = 12, collar = 0) {
  const A = new THREE.Vector3(a[0], a[1], a[2]);
  const d = new THREE.Vector3(b[0], b[1], b[2]).sub(A);
  const len = d.length();
  if (len < 1e-6) return [];
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), d.clone().multiplyScalar(1 / len));
  const mid = [A.x + d.x / 2, A.y + d.y / 2, A.z + d.z / 2];
  const out = [];
  const put = (geo, along) => {
    geo.applyQuaternion(q);
    geo.translate(A.x + d.x * along, A.y + d.y * along, A.z + d.z * along);
    out.push(place(geo));
  };
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  g.applyQuaternion(q);
  g.translate(mid[0], mid[1], mid[2]);
  out.push(place(g));
  if (collar > 0) {
    // A clevis at each end: the joint is what tells you the member is bolted
    // on rather than grown out of the thing it braces.
    const cl = Math.min(collar * 1.6, len * 0.14);
    put(new THREE.CylinderGeometry(r0 * 1.55, r0 * 1.15, cl, seg), 0.5 * cl / len);
    put(new THREE.CylinderGeometry(r1 * 1.15, r1 * 1.55, cl, seg), 1 - 0.5 * cl / len);
  }
  return out;
}

/* ------------------------------------------------------- crease smoothing
   `place()` de-indexes and every merge here ends in `computeVertexNormals()`,
   which on de-indexed geometry can only produce one normal per triangle. So
   everything in this game is flat shaded whatever it was authored as: a
   cylinder is not a tube, it is a prism with countable sides. That is why the
   only lever anyone has had against a polygonal barrel is *more segments* —
   and it is also why the anti-glare top coat, which keys off the surface
   normal, arrives on a drum as a set of hard vertical bands rather than as a
   gradient over its shoulder.

   Averaging everything is not the answer either. An averaged chamfer is a
   fillet with no edge in it, and the hard bright line along a chamfer is the
   entire reason the chamfer is there.

   So: average across a joint only where the two faces meet within `deg`.
   A 96-sided drum steps under four degrees and comes out genuinely round; a
   fourteen-sided handrail steps twenty-six and comes out round; a chamfer, a
   box corner and a bevel band all meet at forty-five or ninety and stay
   knife sharp. The weighting is by the unnormalised cross product, which is
   already twice the triangle's area — free, and it stops a sliver at the end
   of a taper outvoting the face it sits beside.

   Positions are welded on a 4 mm lattice. Parts are placed at exact
   coordinates so a genuinely shared corner lands in the same cell; anything
   that is merely close is caught by the crease test rather than by the
   tolerance. */
export function creaseNormals(geo, deg = 32) {
  const pos = geo.attributes.position;
  if (!pos || geo.index) return geo;
  const a = pos.array, nv = pos.count, nt = (nv / 3) | 0;
  const fn = new Float32Array(nt * 3);   // area-weighted
  const fu = new Float32Array(nt * 3);   // unit
  for (let t = 0; t < nt; t++) {
    const i = t * 9;
    const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2];
    const vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    fn[t * 3] = x; fn[t * 3 + 1] = y; fn[t * 3 + 2] = z;
    fu[t * 3] = x / l; fu[t * 3 + 1] = y / l; fu[t * 3 + 2] = z / l;
  }
  // 16 bits an axis, which is +-128 m at 4 mm and stays inside a double
  const key = (x, y, z) => (
    ((Math.round(x * 256) + 32768) * 65536 + (Math.round(y * 256) + 32768)) * 65536
    + (Math.round(z * 256) + 32768));
  const at = new Map();
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const i = (t * 3 + k) * 3;
      const kk = key(a[i], a[i + 1], a[i + 2]);
      const b = at.get(kk);
      if (b === undefined) at.set(kk, [t]); else b.push(t);
    }
  }
  const lim = Math.cos(deg * Math.PI / 180);
  const out = new Float32Array(nv * 3);
  for (let t = 0; t < nt; t++) {
    const ux = fu[t * 3], uy = fu[t * 3 + 1], uz = fu[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const i = (t * 3 + k) * 3;
      const b = at.get(key(a[i], a[i + 1], a[i + 2]));
      let x = 0, y = 0, z = 0;
      for (let m = 0; m < b.length; m++) {
        const o = b[m] * 3;
        if (fu[o] * ux + fu[o + 1] * uy + fu[o + 2] * uz < lim) continue;
        x += fn[o]; y += fn[o + 1]; z += fn[o + 2];
      }
      const l = Math.hypot(x, y, z);
      if (l > 1e-12) { out[i] = x / l; out[i + 1] = y / l; out[i + 2] = z / l; }
      else { out[i] = ux; out[i + 1] = uy; out[i + 2] = uz; }
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geo;
}

/** Merge a list of placed geometries into one mesh. Disposes the inputs. */
export function weld(list, mat, parent) {
  if (!list.length) return null;
  const g = mergeGeometries(list, false);
  /* Crease, do not flat-shade.

     `place()` de-indexes, and `computeVertexNormals()` on de-indexed geometry
     can only give one normal per *triangle* — so every barrel welded through
     here came out a prism no matter how many segments it was built with, and
     raising the segment count did nothing at all. Averaging across joints under
     the crease angle makes a gauged cylinder round while a chamfer or a corner
     still cuts. The player's hull already does this; everything the same kit
     builds — stations, freighters, derelicts, the Resonator — gets it here. */
  creaseNormals(g, 32);
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  if (parent) parent.add(m);
  list.forEach((x) => x.dispose());
  list.length = 0;
  return m;
}

/* -------------------------------------------------------------- materials */

/**
 * The standard palette. Everything built in vacuum uses these five, so a
 * freighter and the player's hull are unmistakably from the same yard.
 *
 * @param {object} o  hue — 0 bone, 1 oxide, 2 slate, 3 rust (paint tint);
 *                    wear — 0..1 how used the thing is
 */
export function palette(o = {}) {
  const wear = o.wear ?? 0.5;
  const paintCol = [0x8e8d86, 0x8a6a4c, 0x5f6a70, 0x6d5443][o.hue ?? 0];
  /* Roughness is the *only* channel that separates these once they are all
     lit by the same key, so they are spread deliberately across the whole
     range rather than huddled between 0.5 and 0.9 where nothing tells them
     apart. Bottom to top: mirror trim, worked alloy, dark composite, chalky
     paint, ceramic. Four steps a viewer can name, which is the difference
     between a material story and one white plastic with a stripe on it. */
  return {
    paint: dress(new THREE.MeshStandardMaterial({
      color: paintCol, metalness: 0.04, roughness: 0.70 + wear * 0.16, envMapIntensity: 0.85,
    }), {
      plate: o.plate ?? 2.4, bleach: 0.55 + wear * 0.4, soot: wear * 0.9,
      livery: o.livery ?? 0, brushed: 0.35,
    }),
    // Composite, not paint: it is smoother than the chalk around it, so under
    // a raking key it holds a long soft sheen where the paint holds none. That
    // contrast is what stops a dark panel reading as a hole.
    structure: dress(new THREE.MeshStandardMaterial({
      color: 0x1f2226, metalness: 0.55, roughness: 0.46, envMapIntensity: 1.1,
    }), { plate: 1.3, bleach: 0.20, soot: 0.85, brushed: 0.7 }),
    metal: dress(new THREE.MeshStandardMaterial({
      color: 0x6d665c, metalness: 0.92, roughness: 0.30 + wear * 0.20, envMapIntensity: 1.25,
    }), { plate: 0.9, bleach: 0.15, soot: 0.7, brushed: 1.0 }),
    accent: dress(new THREE.MeshStandardMaterial({
      color: 0x8c4418, metalness: 0.18, roughness: 0.66, envMapIntensity: 0.8,
    }), { plate: 1.1, bleach: 0.9, soot: 0.4, brushed: 0.3 }),
    // Ceramic radiator face. Nearly Lambertian and the roughest thing in the
    // kit, which is exactly why it must not share a number with the paint.
    panel: dress(new THREE.MeshStandardMaterial({
      color: 0xa8a9a4, metalness: 0.0, roughness: 0.94, envMapIntensity: 0.7, side: THREE.DoubleSide,
    }), { plate: 1.15, bleach: 0.5, soot: 0.15, brushed: 0.15 }),
    trim: polished(),
    /* Glass. It gets the lighting tail but not the plating law — a seam
       running across a window is nonsense — and without an environment to
       reflect it is a painted black hole, which is precisely what the station
       glazing looked like. */
    glass: skyLit(new THREE.MeshPhysicalMaterial({
      color: 0x05090c, metalness: 0.0, roughness: 0.055, envMapIntensity: 2.2,
      clearcoat: 1.0, clearcoatRoughness: 0.03,
      emissive: new THREE.Color(0x0a2230), emissiveIntensity: 0.35,
    })),
    lit: emitter(0x9ec8ff, 1.35),
  };
}

/**
 * Worked alloy — rings, rails, hinges, oleo struts, nozzle lips.
 *
 * This used to be a mirror: roughness 0.16 at metalness 0.92, on the argument
 * that a hull needs one hard specular somewhere or everything reads as painted
 * foam. The argument is right and the execution was wrong. A mirrored *band*
 * running the whole length of a nacelle is not a highlight, it is chrome, and
 * an art director reading this ship at 1:1 called it out as the loudest
 * violation of the game's own brief — which says roughness floors live around
 * 0.35 and bare metal appears only at wear edges.
 *
 * So the base is what a real fitting is: primed and painted alloy, matte, above
 * the floor. The hard highlight comes back through `edge`, which is masked to
 * the lips, rims and collars the bake found — the places a real hull is rubbed
 * through to metal. Same read, one to two per cent of the coverage.
 *
 * `matteMin` is the second half of that argument and the player's hull sets it.
 * Roughness 0.44 clears the brief's floor, but it lands exactly midway up
 * MATTE_HOOK's roll-off, so the grazing Fresnel stays five times the paint's and
 * wraps a soft neutral highlight round every ring, tank and boom tube on the
 * ship. See MATTE_HOOK. It is left off by default here because the station, the
 * derelict and the fleet all take this material through `palette()` and all
 * three are signed off as they stand.
 */
export function polished(o = {}) {
  return dress(new THREE.MeshStandardMaterial({
    color: o.color ?? 0xb4b7b6, metalness: o.metalness ?? 0.14,
    roughness: o.roughness ?? 0.44, envMapIntensity: o.env ?? 1.7,
  }), {
    plate: o.plate ?? 3.4, bleach: o.bleach ?? 0.12, soot: o.soot ?? 0.55,
    matteMin: o.matteMin ?? 0.0,
    frame: o.frame ?? 0, doors: o.doors ?? 0,
    // The whole point of this material: bare metal, but only where a hull
    // actually wears through to it.
    edge: o.edge ?? 0.55,
    // Turned and drawn stock keeps the marks of the lathe. On a rail this is
    // the whole reason the highlight travels along it as a broken line rather
    // than sliding down it as one clean bar.
    brushed: o.brushed ?? 1.0,
    rivet: o.rivet ?? 0.5,
    plume: o.plume ?? null,
  });
}

/**
 * An unlit emitter. `toneMapped: false` matters — these are meant to punch
 * through the AgX curve and bloom, which is what makes a running light read as
 * a *light* rather than as a bright dot of paint.
 */
export function emitter(hex, gain = 1) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(hex).multiplyScalar(gain), toneMapped: false,
  });
}

/* The one saturated emissive in the game, reserved for Choir artefacts. Using
   it anywhere else spends the only colour that carries meaning. */
export const CHOIR_HUE = 0xbfe07a;

/* ------------------------------------------------------------- structures */

/* ---------------------------------------------------------- minimum gauge
   A member thinner than about a pixel does not render as a thin member: it
   renders as a dotted, crawling ladder, because MSAA resolves a different
   subset of samples every frame as the camera moves. Static it is untidy; in
   motion it is the loudest defect in the frame.

   There is no depth-aware fade available here — everything is merged into one
   draw and has no idea how far away it is — so the fix is gauge. Nothing is
   allowed to be slenderer than about one part in three hundred of the
   structure it belongs to, which on a two hundred metre truss means seventy
   centimetres and on a sixteen metre one means five. Real structures get
   chunkier as they get longer anyway; this is the ratio doing the work rather
   than a number picked per call site. */
const GAUGE = 1 / 300;
const gauge = (r, of) => Math.max(r, of * GAUGE);

/** A square-section lattice truss along +Z. Reads as built, and it is cheap. */
export function truss(len, w, bays, r0 = 0.14) {
  const out = [];
  const h = w / 2;
  const r = gauge(r0, len);
  const corners = [[h, h], [h, -h], [-h, -h], [-h, h]];
  for (const [x, y] of corners) {
    out.push(place(new THREE.CylinderGeometry(r, r, len, 6), { pos: [x, y, 0], rot: [Math.PI / 2, 0, 0] }));
  }
  const bay = len / bays;
  // Cross members and diagonals are the parts that actually shimmer — they are
  // the thinnest and there are the most of them — so they hold a much larger
  // fraction of the longeron than a real truss would use.
  const rC = gauge(r * 0.82, len * 0.85), rD = gauge(r * 0.72, len * 0.85);
  for (let i = 0; i <= bays; i++) {
    const z = -len / 2 + i * bay;
    for (let c = 0; c < 4; c++) {
      const [x0, y0] = corners[c], [x1, y1] = corners[(c + 1) % 4];
      const dx = x1 - x0, dy = y1 - y0;
      out.push(place(new THREE.CylinderGeometry(rC, rC, Math.hypot(dx, dy), 5), {
        pos: [(x0 + x1) / 2, (y0 + y1) / 2, z], rot: [0, 0, Math.atan2(dy, dx) + Math.PI / 2],
      }));
      // one diagonal per bay face, alternating direction
      if (i < bays) {
        const d = Math.hypot(dx, dy, bay);
        out.push(place(new THREE.CylinderGeometry(rD, rD, d, 5), {
          pos: [(x0 + x1) / 2, (y0 + y1) / 2, z + bay / 2],
          rot: [(i % 2 ? 1 : -1) * Math.atan2(bay, Math.hypot(dx, dy)) * (c % 2 ? 1 : -1),
            0, Math.atan2(dy, dx) + Math.PI / 2],
        }));
      }
    }
  }
  return out;
}

/**
 * A deployed solar wing: leaves with gaps between them, on a boom.
 * The gaps are the point — starlight through the array is what tells you it is
 * a structure and not a painted wing.
 */
export function solarWing(span, chord, leaves = 4) {
  const out = [];
  const leafLen = span / leaves - 0.6;
  // A hundred and eighty metre array eight centimetres thick is a sheet of
  // paper: seen edge-on it is a sub-pixel line that flickers in and out. Gauge
  // it off the span, and give the frame rails enough section to hold the
  // silhouette when the array is edge-on to the camera.
  const th = gauge(0.16, span * 0.9);
  const rail = gauge(0.20, span * 0.9);
  for (let i = 0; i < leaves; i++) {
    const x = 2.0 + i * (leafLen + 0.6) + leafLen / 2;
    out.push(place(slab(leafLen, th, chord, th * 0.6), { pos: [x, 0, 0] }));
    out.push(place(slab(leafLen, th * 2.6, rail, rail * 0.3), { pos: [x, 0, chord / 2] }));
    out.push(place(slab(leafLen, th * 2.6, rail, rail * 0.3), { pos: [x, 0, -chord / 2] }));
  }
  const br = gauge(0.22, span);
  out.push(place(new THREE.CylinderGeometry(br, br, span, 8), { pos: [span / 2, 0, 0], rot: [0, 0, Math.PI / 2] }));
  return out;
}

/**
 * Scatter small hardware over a hull region. Boxes and cylinders at the scale
 * a person would install them: it is the *size* relative to a hatch that gives
 * a structure its sense of scale, not the count.
 */
export function greebles(rnd, n, bounds, sizeRange = [0.4, 2.2]) {
  const out = [];
  const [lo, hi] = sizeRange;
  for (let i = 0; i < n; i++) {
    const x = bounds[0] + rnd() * (bounds[3] - bounds[0]);
    const y = bounds[1] + rnd() * (bounds[4] - bounds[1]);
    const z = bounds[2] + rnd() * (bounds[5] - bounds[2]);
    const s = lo + rnd() * (hi - lo);
    if (rnd() < 0.62) {
      out.push(place(slab(s, s * (0.3 + rnd() * 0.5), s * (0.5 + rnd()), s * 0.12), {
        pos: [x, y, z], rot: [0, 0, rnd() * Math.PI],
      }));
    } else {
      out.push(place(new THREE.CylinderGeometry(s * 0.3, s * 0.3, s * (0.6 + rnd()), 8), {
        pos: [x, y, z], rot: [rnd() < 0.5 ? Math.PI / 2 : 0, 0, rnd() * Math.PI],
      }));
    }
  }
  return out;
}
