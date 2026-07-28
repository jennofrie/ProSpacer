import * as THREE from 'three';
import { NOISE, LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';

/* ============================================================================
   A star: photosphere + corona/chromosphere shell + camera-facing glare disc.

   Two numbers govern everything here.

   The first is the tonemap's clip point. After auto-exposure bottoms out at
   0.045 and the pre-contrast curve, AgX returns pure white at roughly 130
   units of scene radiance, 241 at 50, 185 at 12 and 116 at 4. So the *whole*
   readable range of a star's surface lives between about 2 and 130, and a
   photosphere authored flat at 120 is a disc of white paper by construction —
   which is exactly what this used to be. The surface is therefore authored so
   that only the hottest granules near disc centre clip; the mean sits near 60
   and the limb falls to single digits. That is also what a correctly exposed
   photograph of the Sun looks like.

   The second is the projected silhouette. A camera at d radii sees the disc
   edge at d/sqrt(d*d-1) radii measured on the plane through the star's centre,
   not at 1.0 — at three radii that is 1.061 — and if the star is off the
   optical axis it is not even a circle. Every billboard feature that is
   supposed to hug the limb (the chromosphere, the prominences, the hole punched
   in the glare) is therefore placed against `limbParam` below, which
   intersects the real ray with the real sphere. Placed at 1.0 they sit inside
   the disc, are killed by the depth test, and the star has no visible
   chromosphere at any close range at all.
   ========================================================================== */

const CORE_VERT = /* glsl */`${LOGD_V_PARS}

varying vec3 vObj;
varying vec3 vWPos;
varying vec3 vCentre;
void main(){
  vObj = normalize(position);
  vec4 wp = modelMatrix*vec4(position,1.0);
  vWPos = wp.xyz;
  // The sphere's centre, so the fragment shader can build an exact normal.
  // Interpolated vertex normals are a chord approximation and the limb is the
  // one place where that shows.
  vCentre = (modelMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
  gl_Position = projectionMatrix*viewMatrix*wp;
  ${LOGD_V}
}
`;

const CORE_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
varying vec3 vObj;
varying vec3 vWPos;
varying vec3 vCentre;
uniform float uTime;
uniform float uTemp;
uniform float uIntensity;
uniform float uSeed;
uniform vec3  uCamPos;
uniform vec3  uAxis;       // spin axis, object space
uniform float uDetail;     // 1 when granules are several pixels wide, 0 when sub-pixel
uniform float uGranScale;  // convection cells across the unit sphere
uniform float uGranAmt;    // 0 for degenerate surfaces (white dwarf, neutron star)
uniform float uSpotAmt;
uniform float uLevel;      // per-class exposure: how much of the disc is allowed to clip
uniform float uChromo;     // chromospheric rim glow, matched to the corona's shell
uniform vec3  uChromoCol;

void main(){
  ${LOGD_F}

  vec3 N = normalize(vWPos - vCentre);
  vec3 V = normalize(uCamPos - vWPos);
  float mu = clamp(dot(N, V), 0.0, 1.0);

  // ---- rotation --------------------------------------------------------
  // The star turns. Rotating the sample direction is free and it means the
  // pattern moves as a rigid body instead of sliding through itself, which is
  // the difference between granulation and boiling static.
  float sp = uTime*0.010;
  float cs = cos(sp), sn = sin(sp);
  vec3 d = vObj;
  d = vec3(d.x*cs + d.z*sn, d.y, -d.x*sn + d.z*cs);

  // ---- convection ------------------------------------------------------
  // Granulation is cellular, not fractal: bright upwelling cells separated by
  // narrow dark intergranular lanes. A Worley F2-F1 ridge gives that directly.
  // Below a couple of pixels per cell the whole thing is fed back to flat —
  // sub-pixel granulation is not detail, it is shimmer.
  float surf = 1.0;
  float shade = 0.0;          // spot darkening, 0..1
  if(uDetail > 0.003 && uGranAmt > 0.001){
    // A Worley diagram sampled straight is a crackle glaze: dead-straight cell
    // walls of uniform width, which reads as stained glass, not as boiling
    // plasma. Warping the domain first bends every wall into an irregular
    // curve, and it is the single change that turns this from a texture into a
    // surface. Two noise lookups is the whole cost.
    float wa = snoise(d*uGranScale*0.55 + uSeed + 11.0);
    float wb = snoise(d*uGranScale*0.55 + uSeed + 31.0);
    vec3 gp = d*uGranScale + vec3(wa, wb, wa*0.7 - wb*0.5)*0.62
            + vec3(0.0, uTime*0.004, 0.0) + uSeed;
    vec2 cw = cellular(gp, 1.0);
    // cell-scale variation: neighbouring granules differ in brightness, and it
    // also jitters the lane width so they are not all drawn with one pen
    float cell = snoise(d*uGranScale*0.95 + uSeed*9.0)*0.5 + 0.5;
    // The lane transition has to be *wide*. A narrow one draws the Worley
    // diagram itself — a web of hairlines — and the floor has to stay well up,
    // because real intergranular lanes are a fifth darker than the granules,
    // not four fifths.
    float lane = smoothstep(0.04, 0.30 + cell*0.30, cw.y - cw.x);
    // supergranulation: a much larger, softer envelope over the whole thing
    float sup  = fbm(d*uGranScale*0.22 + uSeed*5.0, 3)*0.5 + 0.5;
    float gran = mix(0.46, 1.06, lane) * mix(0.78, 1.22, sup) * mix(0.82, 1.18, cell);
    surf = mix(1.0, gran, uDetail*uGranAmt);
  }

  // ---- starspots -------------------------------------------------------
  // Spots are not scattered uniformly: they emerge in two activity belts either
  // side of the equator and march toward it over a cycle. A latitude window on
  // the threshold does that without a second noise field.
  if(uDetail > 0.003 && uSpotAmt > 0.001){
    float latAbs = abs(dot(d, uAxis));                      // |sin(latitude)|
    // Squared by hand rather than pow(x, 2.0): the base is negative over most
    // of the disc and pow() of a negative base is undefined in GLSL. Metal
    // happens to return the IEEE answer for an integral exponent; a driver that
    // routes pow through exp2(y*log2(x)) returns NaN and lichens the star. Same
    // failure that put a dashed scratch through the corona — see below.
    float dLat = latAbs - 0.34;
    float belt = exp(-8.0*dLat*dLat);
    float s = (fbm(d*3.2 + uSeed*3.0, 3)*0.5 + 0.5) * (0.52 + belt*0.80);
    // Thresholds high enough that spots are an event. Set them where the mean
    // of the field lands and half the disc turns into lichen.
    float penum = smoothstep(0.76, 0.90, s);
    float umbra = smoothstep(0.87, 1.00, s);
    // penumbral filaments stream radially out of the umbra
    float fil = ridged(d*uGranScale*0.9 + uSeed*7.0, 2);
    shade = clamp((penum*0.42*(0.70 + fil*0.55) + umbra*0.54)*uSpotAmt, 0.0, 0.90)*uDetail;
    surf = max(surf*(1.0 - shade), 0.012);
  }

  // ---- limb darkening --------------------------------------------------
  // The one thing that stops a disc reading as a circle of white paint. It has
  // to be far stronger than the physical law (I(mu) ~ 0.3 + 0.93mu - 0.23mu^2),
  // because the physical law spans half a stop and the top half-stop of AgX is
  // fourteen code values wide. Here the edge of the disc lands two orders of
  // magnitude under the centre, which is what puts the surface into the part
  // of the curve that still has contrast in it.
  // Exponent 2.4, not the physical half-stop. mu stays above 0.5 across the
  // inner 87% of the radius, so anything gentler leaves almost the whole disc
  // inside one stop of the clip point and it reads as a cut-out circle again.
  // Measured on a scanline: this takes the disc from 254 at centre to 226 at
  // 0.7R and 116 at 0.95R, which is a sphere. At exponent 1.5 it was 254 to
  // 251 to 214, which is a coin.
  // The floor matters too — taken all the way to zero the last two pixels go
  // black and, with a bright chromosphere immediately outside them, the star
  // gets a drawn outline.
  float ld = pow(mu, 2.4)*0.955 + 0.045;
  // the limb also looks into a cooler, higher layer, so it reddens as it darkens
  float lcool = smoothstep(0.0, 0.62, mu);

  // A near-flat, brighter disc once the star is small enough that none of the
  // above resolves; a twenty-pixel star should read as a hot point, not as a
  // shaded ball. uLevel then decides how much of each class is allowed to sit
  // over the clip point: a G dwarf keeps a blown core, an A star less of one,
  // and a white dwarf would be a featureless white hole at its raw radiance.
  float lvl = mix(2.20, 1.0, uDetail)*uLevel;

  float temp = uTemp*(0.93 + surf*0.11);
  temp *= (1.0 - shade*0.34);
  vec3 col = mix(blackbody(uTemp*0.72), blackbody(temp), lcool);
  vec3 rgb = col*(uIntensity*lvl*ld*surf);

  // The last few percent of the disc is the chromosphere seen edge-on. Without
  // it the limb falls to black and the corona's shell starts on the far side of
  // a one-pixel gap, which draws a hard ring instead of a soft edge.
  float rim = pow(1.0 - mu, 5.0);
  rgb += uChromoCol*(uIntensity*uLevel*uChromo*0.34*rim);

  gl_FragColor = vec4(rgb, 1.0);
}
`;

/* The corona used to be a back-faced shell, but the brightest part of a fresnel
   term sits exactly at the shell's silhouette, so it always ended on a hard
   bright circle. A camera-facing billboard with a real radial profile has no
   silhouette to end on, and lets the streamers run outward properly.

   What it must not do is band. The old version sampled noise on a ring of fixed
   radius with only the noise's z advancing with distance, so every radius saw
   the same angular pattern and the result was two dozen hard wedges rotating
   with the camera. Three things fix that: the ring's radius grows with height
   (so the angular frequency changes as you go out), the angle is sheared with
   height (so a streamer leans instead of pointing at the centre), and the
   pattern flows outward in time. */
const BILLBOARD_VERT = /* glsl */`${LOGD_V_PARS}

uniform float uSize;
uniform vec3  uAxisW;       // spin axis in world space
uniform vec3  uCamRel;      // camera minus star centre, in stellar radii
varying vec2 vUv;
varying vec2 vAxis;         // that axis projected into the billboard
varying vec3 vCam;          // the camera in the billboard's own basis
void main(){
  vUv = uv;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 back  = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec2 ax = vec2(dot(uAxisW, right), dot(uAxisW, up));
  float al = length(ax);
  vAxis = al > 1e-3 ? ax/al : vec2(0.0, 1.0);
  vCam = vec3(dot(uCamRel, right), dot(uCamRel, up), dot(uCamRel, back));
  vec3 wp = (modelMatrix*vec4(0.0,0.0,0.0,1.0)).xyz
          + right*position.x*uSize + up*position.y*uSize;
  gl_Position = projectionMatrix*viewMatrix*vec4(wp,1.0);
  ${LOGD_V}
}
`;

/* Where the photosphere's edge actually is, for a billboard fragment.

   Every "hug the limb" feature used to be placed against a circle of fixed
   radius in billboard space. That is wrong twice over: the projected disc is
   1.061 radii across at three radii rather than 1.0, and — because a sphere
   away from the optical axis projects to an *ellipse* — it is not even the same
   radius all the way round. A circular cutoff therefore leaves a crescent gap
   on the side of the disc nearer the frame centre, and that gap renders as a
   hard navy line several pixels wide between the star and its own corona.
   Intersecting the real ray with the real sphere is a dozen instructions and is
   right at every distance and every screen position; the impact parameter it
   returns is exactly 1.0 at the visible limb and doubles as the height
   coordinate everything else is authored against. */
const LIMB_FN = /* glsl */`
float limbParam(vec3 camB, vec2 p){
  vec3 rd = normalize(vec3(p, 0.0) - camB);
  float td = -dot(camB, rd);
  return sqrt(max(dot(camB, camB) - td*td, 0.0));
}
`;

const CORONA_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
${LIMB_FN}
varying vec2 vUv;
varying vec2 vAxis;
varying vec3 vCam;
uniform float uTime;
uniform vec3  uColor;
uniform vec3  uChromoCol;
uniform float uIntensity;
uniform float uSurf;      // photosphere radiance — the limb layers are authored against it
uniform float uSeed;
uniform float uSpan;      // billboard half-width in stellar radii
uniform float uRadPx;     // the disc's screen radius in pixels
uniform float uChromo;    // chromosphere amount
uniform float uProm;      // prominence amount
uniform float uPolar;     // 0 equatorial helmet streamers, 1 polar plumes

void main(){
  ${LOGD_F}
  vec2 p = (vUv - 0.5) * 2.0 * uSpan;      // in stellar radii, on the centre plane
  float r = length(p);
  if(r > uSpan){ gl_FragColor = vec4(0.0); return; }

  float rn = limbParam(vCam, p);           // 1.0 exactly at the visible limb
  // A hair of overlap onto the disc, which the depth test eats: the mesh is an
  // inscribed icosphere and so sits a fraction of a pixel inside the analytic
  // sphere, and a fraction of a pixel of black is still a drawn outline.
  if(rn < 0.996){ gl_FragColor = vec4(0.0); return; }

  vec2 dir = p / max(r, 1e-5);
  float h  = log(max(rn, 1.0));            // height; stretches features outward

  // Angle measured from the star's own pole rather than from screen up, so the
  // streamer belt stays attached to the star as the camera moves around it.
  //
  // The clamp is not defensive tidying, it is the whole reason this shader ever
  // drew a dashed white scratch corner-to-corner through the frame. dir and
  // vAxis are both normalised, so their dot is mathematically in [-1,1] — but
  // both normalisations round, so on the handful of pixels that land exactly on
  // the projected spin axis the product comes back as 1.0000001. That makes
  // 1.0 - lat negative, pow() of a negative base is undefined in GLSL and
  // returns NaN under ANGLE/Metal, the NaN runs through belt -> halo -> col,
  // and additive blending writes it into the HDR target. The post chain renders
  // a NaN as a black pixel with the chromatic-aberration tap either side of it
  // pulled to full — a dark core with a bright rim, one per pixel that happened
  // to round over, straight up the axis and out of both edges of the frame.
  // Clamp the cosine, and guard the pow base as well: a NaN costs a whole pixel
  // and this costs nothing.
  float cosLat = clamp(dot(dir, vAxis), -1.0, 1.0);
  float ang = atan(dot(dir, vec2(-vAxis.y, vAxis.x)), cosLat);
  float lat = abs(cosLat);                 // 1 at the poles

  // ---- K-corona --------------------------------------------------------
  // Streamers are radial. The fix for banding is not to stop them being radial
  // — it is to stop them being *identical at every radius*: a slight shear with
  // height, a base angular frequency high enough that no single lobe reads as a
  // wedge, and the whole field flowing outward. Overdo the shear and the corona
  // stops being a corona and becomes a whirlpool.
  float twist = h*0.42;
  float a2 = ang + twist + uTime*0.004;
  float ringR = 4.2 + h*0.8 + lat*1.7;     // finer angular detail toward the poles: plumes
  vec3 q = vec3(cos(a2), sin(a2), 0.0)*ringR;
  q.z = h*1.25 - uTime*0.013 + uSeed;      // and the whole field streams out

  float st = fbm(q, rn < 2.2 ? 4 : 3)*0.5 + 0.5;
  st = pow(max(st, 0.0), 1.7);             // sharper than linear, softer than a smoothstep
  float fil = 1.0 - abs(snoise(q*2.1 + 3.0));    // thin bright filaments inside the streamers

  // Helmet streamers concentrate at the magnetic equator; a pulsar does the
  // opposite and throws everything out along the axis.
  float eq = 0.72 + 0.52*pow(max(1.0 - lat, 0.0), 1.3);
  float po = 0.55 + 0.90*pow(max(lat, 0.0), 2.2);
  float belt = mix(eq, po, uPolar);

  float fall = pow(1.0/max(rn, 1.0), 3.6);              // K-corona radial profile
  float edge = 1.0 - smoothstep(uSpan*0.35, uSpan, rn); // fade to nothing by the rim
  // The inner K-corona is bright and smooth; only further out does it break
  // into streamers. Without that base the disc sits in a black moat wherever a
  // streamer happens not to start, and the limb reads as an outline.
  float sheath = exp(-(rn - 1.0)*3.2);
  float halo = fall*edge*belt*(0.26 + sheath*0.65 + st*1.15)*(0.70 + fil*0.48);

  vec3 col = uColor*(halo*uIntensity*2.0);

  // ---- chromosphere and prominences ------------------------------------
  // A thin, much hotter, much redder shell hugging the limb with loops of
  // plasma standing off it. This is the detail that separates "a star" from "a
  // bright ball": it gives the edge of the disc a physical thickness and stops
  // the silhouette being a clean circle. Authored against the photosphere's own
  // radiance so it survives the same tonemap the disc does.
  if(rn < 1.34 && (uChromo + uProm) > 0.001){
    float hh = max(rn - 1.0, 0.0);                     // height above the limb
    // e-fold thickness follows the disc's screen size so the shell always holds
    // a couple of pixels instead of vanishing at range
    float k = clamp(uRadPx*0.34, 14.0, 95.0);
    // Spicules. Three octaves on a ring so the fringe has both coarse gaps —
    // whole quiet sectors where the shell thins to nothing — and a fine hairy
    // edge inside the active ones. An unmodulated shell is a drawn ring, and a
    // drawn ring is worse than no chromosphere at all.
    float spic = fbm(vec3(cos(ang), sin(ang), 0.0)*13.0 + uSeed*11.0, 3)*0.5 + 0.5;
    float shell = exp(-hh*k)*pow(max(spic, 0.0), 2.2)*2.1*uChromo;

    // prominences: isolated arched loops, clustered into active longitudes
    vec3 pq = vec3(cos(ang + hh*2.4), sin(ang + hh*2.4), 0.0)*8.0;
    pq.z = hh*8.0 - uTime*0.004 + uSeed*3.0;
    float act = smoothstep(0.50, 0.80, fbm(pq, 3)*0.5 + 0.5);
    float loop = 1.0 - abs(snoise(pq*1.7 + 5.0));
    loop = loop*loop*loop;
    float prom = act*loop*exp(-hh*15.0)*uProm;

    float lim = shell*0.22 + prom*1.45;
    col += mix(uChromoCol, vec3(1.0, 0.62, 0.42), clamp(prom*1.4, 0.0, 0.7))
         * (lim*uSurf*0.52);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

const GLARE_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${LIMB_FN}
varying vec2 vUv;
varying vec3 vCam;
uniform vec3  uColor;
uniform float uIntensity;
uniform float uSpan;      // billboard half-width in stellar radii
uniform float uHole;      // 0 glare covers the disc, 1 glare is punched out
void main(){
  ${LOGD_F}
  vec2 p = (vUv - 0.5)*2.0;
  float r = length(p);
  if(r > 1.0){ gl_FragColor = vec4(0.0); return; }
  // inverse-square-ish falloff plus a tight core
  float a = pow(max(0.0, 1.0-r), 2.6)*0.55 + exp(-r*r*22.0)*1.3;

  // Once the disc is big enough on screen to show limb darkening, granulation
  // and spots, laying a bright core over it throws all of that away and leaves
  // a flat white ball. So the glare's centre is punched out in proportion to
  // how resolved the star is; far away, where the disc is three pixels and the
  // glare *is* the star, the hole closes again. The hole is cut against the
  // real silhouette — filling the outer tenth of the disc with glare is the
  // same as having no limb darkening.
  float rn = limbParam(vCam, p*uSpan);
  a *= mix(1.0, smoothstep(1.0, 2.1, rn), uHole);
  gl_FragColor = vec4(uColor*a*uIntensity, 1.0);
}
`;

/* Per-class surface character. A white dwarf and a red dwarf sharing one ball
   of noise was half the reason the star roster read as one asset. Convection
   cell size scales with the pressure scale height, so it runs from a few dozen
   granules across a main-sequence disc to a handful of enormous cells on a
   carbon giant; degenerate surfaces have no convective granulation to show and
   no chromosphere to stand prominences on. */
function classProfile(cls) {
  switch (cls) {
    // gran is cells per unit direction; the disc spans two of those, so a value
    // of 17 is about 34 granules across the diameter. Far coarser than the real
    // thousand, and that is the point — at 260 pixels of disc radius, a
    // thousand granules is fifteen pixels of grey noise.
    // Carbon giant: a few vast, sluggish cells and heavy sooty patches.
    case 'C':  return { gran: 5,  granAmt: 1.00, spot: 1.25, level: 0.95, chromo: 0.80, prom: 1.15, polar: 0 };
    // Red dwarf: heavily spotted, small cells, an oversized active chromosphere.
    case 'M':  return { gran: 12, granAmt: 0.95, spot: 1.45, level: 0.90, chromo: 1.25, prom: 1.35, polar: 0 };
    case 'K':  return { gran: 15, granAmt: 0.95, spot: 1.10, level: 0.86, chromo: 1.05, prom: 1.10, polar: 0 };
    case 'G':  return { gran: 17, granAmt: 0.90, spot: 0.90, level: 0.82, chromo: 1.00, prom: 1.00, polar: 0 };
    case 'F':  return { gran: 21, granAmt: 0.80, spot: 0.55, level: 0.75, chromo: 0.85, prom: 0.75, polar: 0 };
    case 'A':  return { gran: 26, granAmt: 0.55, spot: 0.25, level: 0.54, chromo: 0.55, prom: 0.40, polar: 0 };
    // Blue giant: a radiative envelope. Almost no granulation, no spots, and a
    // hot structureless wind instead of helmet streamers.
    case 'B':  return { gran: 22, granAmt: 0.34, spot: 0.08, level: 0.26, chromo: 0.30, prom: 0.20, polar: 0 };
    // Degenerate: a smooth, ferociously hot surface with nothing standing on
    // it. Limb darkening is all there is, and that is correct — the difference
    // between these and a main-sequence star should be that they are *clean*.
    case 'WD': return { gran: 9,  granAmt: 0.18, spot: 0.00, level: 0.22, chromo: 0.16, prom: 0.0, polar: 0.35 };
    case 'PSR':return { gran: 9,  granAmt: 0.12, spot: 0.00, level: 0.20, chromo: 0.10, prom: 0.0, polar: 1.00 };
    default:   return { gran: 17, granAmt: 0.90, spot: 0.85, level: 0.92, chromo: 1.00, prom: 1.00, polar: 0 };
  }
}

export class Star {
  constructor(spec, ctx) {
    this.spec = spec;
    this.name = spec.name;
    this.radius = spec.radius;
    this.absPos = new THREE.Vector3(0, 0, 0);
    this.color = spec.color.clone();
    this.temp = spec.temp;

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;

    const prof = classProfile(spec.cls);
    this.prof = prof;

    /* H-alpha, which is what makes a cool star's limb that unmistakable
       oxide orange. Above about 7000 K the chromosphere is thin, hot and
       largely continuum, so the fringe pulls back toward the star's own
       colour — a blue giant with a red rim looks like a compositing mistake. */
    const hot = THREE.MathUtils.smoothstep(spec.temp, 7000, 17000);
    this.chromoCol = new THREE.Color(1.0, 0.21, 0.12)
      .lerp(new THREE.Color(spec.color.r, spec.color.g, spec.color.b), hot * 0.85);

    // A spin axis, tilted per seed. The corona's streamer belt and the spot
    // latitudes both hang off it, so two stars in different systems do not
    // present the same bowtie at the same screen angle.
    const tilt = 0.10 + (spec.seed % 1) * 0.42;
    const phi = spec.seed * 2.1;
    this.axis = new THREE.Vector3(
      Math.sin(tilt) * Math.cos(phi), Math.cos(tilt), Math.sin(tilt) * Math.sin(phi),
    ).normalize();

    /* three's PolyhedronGeometry splits each face into (detail+1)^2, not
       4^detail — which is the trap. The old detail of 4 was therefore 500
       triangles, a 28-gon whose chords stood two to three pixels proud of the
       circle at three radii and were plainly visible against black. This is
       20*(n+1)^2 triangles for a sub-tenth-pixel silhouette at any range the
       ship can reach, and it costs nothing: the star is one draw call and the
       whole cost of this object is per-fragment. */
    const detail = ctx.quality === 'low' ? 12 : 24;
    const geo = new THREE.IcosahedronGeometry(1, detail);

    this.coreMat = new THREE.ShaderMaterial({
      vertexShader: CORE_VERT, fragmentShader: CORE_FRAG,
      uniforms: {
        uTime: { value: 0 }, uTemp: { value: spec.temp },
        uIntensity: { value: spec.surfaceIntensity }, uSeed: { value: spec.seed },
        uCamPos: { value: new THREE.Vector3() },
        uAxis: { value: this.axis.clone() },
        uDetail: { value: 1 },
        uGranScale: { value: prof.gran },
        uGranAmt: { value: prof.granAmt },
        uSpotAmt: { value: prof.spot },
        uLevel: { value: prof.level },
        uChromo: { value: prof.chromo },
        uChromoCol: { value: this.chromoCol.clone().lerp(new THREE.Color(1, 1, 1), 0.16) },
      },
    });
    this.core = new THREE.Mesh(geo, this.coreMat);
    this.core.scale.setScalar(this.radius);
    this.core.frustumCulled = false;
    this.group.add(this.core);

    const quad = new THREE.PlaneGeometry(2, 2);

    const CORONA_SPAN = 5.5;
    const GLARE_SPAN = 3.2;
    this.camRel = new THREE.Vector3(0, 0, 1);
    this.coronaMat = new THREE.ShaderMaterial({
      vertexShader: BILLBOARD_VERT, fragmentShader: CORONA_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 }, uColor: { value: spec.coronaColor },
        uChromoCol: { value: this.chromoCol },
        uIntensity: { value: spec.coronaIntensity }, uSeed: { value: spec.seed },
        uSurf: { value: spec.surfaceIntensity },
        uSpan: { value: CORONA_SPAN },
        uSize: { value: this.radius * CORONA_SPAN },
        uRadPx: { value: 60 },
        uChromo: { value: prof.chromo }, uProm: { value: prof.prom },
        uPolar: { value: prof.polar },
        uAxisW: { value: this.axis.clone() },
        uCamRel: { value: this.camRel },
      },
    });
    this.corona = new THREE.Mesh(quad, this.coronaMat);
    this.corona.renderOrder = 7;
    this.corona.frustumCulled = false;
    this.group.add(this.corona);
    this.glareMat = new THREE.ShaderMaterial({
      vertexShader: BILLBOARD_VERT, fragmentShader: GLARE_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: spec.coronaColor },
        uIntensity: { value: 1 },
        uSize: { value: this.radius * GLARE_SPAN },
        uSpan: { value: GLARE_SPAN },
        uHole: { value: 0 },
        uAxisW: { value: this.axis.clone() },
        uCamRel: { value: this.camRel },
      },
    });
    this.glare = new THREE.Mesh(quad, this.glareMat);
    this.glare.renderOrder = 8;
    this.glare.frustumCulled = false;
    this.group.add(this.glare);

    // light rig — one directional light stands in for the star at range
    this.light = new THREE.DirectionalLight(spec.color, 1);
    this.light.position.set(1, 0, 0);
  }

  update(dt, ctx) {
    this.group.position.copy(this.absPos).sub(ctx.origin);
    this.coreMat.uniforms.uTime.value = ctx.time;
    this.coreMat.uniforms.uCamPos.value.copy(ctx.camPos);
    this.coronaMat.uniforms.uTime.value = ctx.time;

    const d = this.group.position.distanceTo(ctx.camPos);
    // Glare grows with proximity but is capped hard — a star that fills the
    // frame with white is not dramatic, it is just a blown exposure.
    const near = THREE.MathUtils.clamp(this.radius * 26 / Math.max(d, 1), 0.03, 0.55);
    this.glareMat.uniforms.uIntensity.value = this.spec.glareIntensity * (0.16 + near * 0.65);

    // The camera relative to the star, in stellar radii. Both billboards
    // reconstruct the true silhouette from this rather than assuming the disc
    // projects to a circle of radius 1.
    this.camRel.copy(ctx.camPos).sub(this.group.position)
      .multiplyScalar(1 / Math.max(this.radius, 1e-6));

    // Disc radius on screen, in pixels. Drives three things: how much glare is
    // punched out, how thick the chromosphere is drawn, and whether granulation
    // is resolved at all.
    const pa = Math.max(ctx.pixelAngle, 1e-9);
    const discPx = (this.radius / Math.max(Math.sqrt(Math.max(d * d - this.radius * this.radius, 1)), 1)) / pa;
    this.coronaMat.uniforms.uRadPx.value = discPx;
    this.glareMat.uniforms.uHole.value = THREE.MathUtils.smoothstep(discPx, 12, 46);

    // Sub-pixel granulation is not detail, it is a crawling speckle. Fade the
    // whole convection layer out as the cells approach the sampling limit; it
    // also takes the cellular noise off the bill for every distant star.
    const cellPx = discPx / this.prof.gran;
    this.coreMat.uniforms.uDetail.value = THREE.MathUtils.smoothstep(cellPx, 2.0, 6.0);

    this.glare.visible = d > this.radius * 1.2;
    this.corona.visible = d > this.radius * 1.1;
  }

  dispose() {
    this.coreMat.dispose(); this.coronaMat.dispose(); this.glareMat.dispose();
    // The photosphere's geometry is per-star and considerably larger than it
    // used to be; hyperjumping through a dozen systems without releasing it
    // would be a real leak.
    this.core.geometry.dispose();
    this.corona.geometry.dispose();
  }
}
