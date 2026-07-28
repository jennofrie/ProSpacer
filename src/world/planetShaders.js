import { NOISE, LOGD_V_PARS, LOGD_V, LOGD_F_PARS, LOGD_F } from '../gfx/glsl/noise.js';

/* ============================================================================
   Runtime planet shading: surface, clouds, atmosphere, gas giants, rings.
   All maths happens in *object space with planet radius = 1*, which keeps
   float precision sane no matter how large the world actually is.
   ========================================================================== */

/* ------------------------------------------------------------------ WEATHER

   One shared cloud field, used by the cloud layer, by the surface for shadows,
   and by the night-lights mask, so all three agree about where the weather is.

   A cloud field seen from orbit has four separable things going on, and leaving
   any of them out is what makes procedural weather look like marble:

     coverage  where there is weather at all, at continental scale
     streets   the field sheared into latitude bands by the zonal jets
     cells     convective texture — thousands of individual tops
     wisp      the high, thin stuff drawn out into filaments

   The old field ran everything through a heavy `warp3`, which smeared all four
   into the same low-frequency soup: torn-paper sheets with no interior texture.
   The warp is gone; the structure now comes from sampling an *anisotropic*
   frame (squashed in latitude, so features stretch east-west the way real ones
   do) and from billowed turbulence rather than plain fbm, which gives rounded
   convective tops instead of fractal edges.
   ========================================================================== */

const CLOUD_COMMON = /* glsl */`
/* Warp the sampling frame: zonal shear plus a few drifting cyclonic centres.
   Returns the warped position in xyz and, in w, how near this point is to the
   centre of the strongest cyclone — which is what lets the density field punch
   an eye out of the middle of one and thicken the bands wrapping it.

   Stirring an *unstructured* field only stirs it: that is why three vortices
   were already in here and the deck still came back as undifferentiated noise.
   Wind the same swirl into a field that is banded in latitude and the bands
   come out as spiral arms, which is where a cyclone actually comes from. The
   centres are placed in the mid-latitudes rather than anywhere, because that
   is where they form and because a spiral sitting on the equator reads as an
   error. */
vec4 weatherFrame(vec3 d, float rot, float t, float seed){
  /* Latitude-dependent drift. Quadratic in latitude, so mid-latitudes run
     fastest and the equator and poles lag — that shear is what makes bands.
     It used to be a second rotAxis stacked on the spin, but both are rotations
     about Y and a rotation about Y cannot change latitude, so the second one's
     angle never depended on the first: they collapse into a single cheap
     two-trig spin. This function runs three times for the slabs, three more
     for their shadow taps and once for the cirrus on every pixel a cloudy
     world covers, and rotAxis builds a full general matrix each time. */
  float ang = rot + (0.62 - d.y*d.y*1.55)*0.55 + t*0.005;
  float sa = sin(ang), ca = cos(ang);
  vec3 p = vec3(ca*d.x + sa*d.z, d.y, -sa*d.x + ca*d.z);
  float vor = 0.0;
  /* Sized like weather, not like a galaxy. exp(-dd*dd*11) is still a tenth of
     full strength forty degrees from the centre, and 2.8 radians is a hundred
     and sixty degrees of twist — between them one system reached across most
     of a hemisphere and dragged the bands, the coastline behind them and every
     other cyclone into a single spiral. From orbit a planet then reads as a
     whirlpool: one enormous vortex and no second subject anywhere in frame.
     A real synoptic system is fifteen to twenty degrees across and turns the
     air through most of a half turn, not most of a half sphere. Tightening the
     falloff is what separates the three centres from each other, and the ITCZ
     and the storm track — which were always in the density field — are then
     the thing that organises the disc, with the cyclones as features on it. */
  for(int i=0;i<3;i++){
    float fi = float(i);
    float sy = (0.28 + 0.36*fract(seed*2.7 + fi*0.41))
             * (fract(seed*1.3 + fi*0.73) < 0.5 ? 1.0 : -1.0);
    float sl = seed*3.1 + fi*2.4;
    float cl = sqrt(max(1.0 - sy*sy, 0.0));
    vec3 c = vec3(cl*cos(sl), sy, cl*sin(sl));
    float dd = distance(p, c);
    float w = exp(-dd*dd*30.0);
    vor = max(vor, w);
    p = rotAxis(c, w*1.55*(fi < 1.5 ? 1.0 : -1.0)) * p;
  }
  return vec4(p, vor);
}

/**
 * @param p      already through weatherFrame
 * @param vor    cyclone proximity, weatherFrame's w
 * @param scale  feature frequency
 * @param cover  0..1 how much of the sphere has weather
 * @param det    0..1 how much fine convective detail to add (drop it for the
 *               shadow tap, where it is invisible and costs a third of the pass)
 */
float cloudDens(vec3 p, float vor, float scale, float cover, float det){
  /* Latitude structure, and it is not decoration — a cloud field without it is
     the loudest possible tell that the weather is noise. On any rotating world
     the Hadley circulation stacks a line of deep convection along the equator
     and drops clear subsiding air twenty-five degrees either side of it, then
     a second belt of storms where the mid-latitude jet runs. Three Gaussians
     in latitude buy all of it, they cost no noise at all, and they are what
     the swirls above then wind into spirals. */
  float alat = abs(p.y);
  float e0 = (alat - 0.05)/0.115, e1 = (alat - 0.42)/0.150, e2 = (alat - 0.74)/0.185;
  float itcz  = exp(-e0*e0);          // intertropical convergence
  float horse = exp(-e1*e1);          // subtropical high — the desert latitudes
  float track = exp(-e2*e2);          // mid-latitude storm track
  /* Rainbands, not a disc. Boosting coverage by the cyclone's own falloff put
     a perfectly circular edge across the cloud field wherever a system sat,
     which reads as a lens artefact rather than as weather. vor*(1-vor) peaks
     halfway out instead, which is an annulus — the bands wrapping the eye —
     and has no outer edge at all.

     The whole set is offset by its own mean so this redistributes cloud
     rather than adding it. Without that the deck simply went overcast: a
     world whose weather is everywhere is no more legible than one whose
     weather is nowhere. */
  float rain = vor*(1.0 - vor)*4.0;
  /* The zonal weights carry more now that the cyclones are the size of real
     ones: with the swirl reaching across a hemisphere the bands were there and
     unreadable, and a disc whose only organisation is one spiral has nothing
     in it that says which way is north. The trailing offset is the set's own
     area-weighted mean, so this redistributes cloud rather than adding it —
     and it had to come down with the rain term, whose mean fell along with the
     area each system covers. */
  cover = clamp(cover + itcz*0.27 + track*0.19 + rain*0.15 - horse*0.27 - 0.042, 0.0, 1.0);

  // squashed in latitude — structures stretch along the flow
  vec3 z = vec3(p.x, p.y*2.35, p.z) * scale;

  // Octave counts are load-bearing for frame rate, not just for looks: this
  // field runs once per slab plus once per shadow tap, over every pixel a
  // planet covers. At three octaves each the structure is indistinguishable
  // from four and the pass costs a third less.
  float base  = fbm(z*0.52, 3)*0.5 + 0.5;                    // synoptic systems
  float cells = 1.0 - turbulence(z*2.6 + 11.0, 3, 2.12, 0.56); // convective tops
  float field = base*0.66 + cells*0.34;

  if(det > 0.01){
    float fine = 1.0 - turbulence(z*8.5 + 27.0, 3, 2.2, 0.55);
    field = mix(field, field*0.80 + fine*0.20, det);
  }

  // Coverage is a threshold, not a multiply: raising cover should grow the
  // *area* of the systems, not fog the gaps between them.
  float thr = mix(0.72, 0.30, cover);
  float dens = smoothstep(thr, thr + 0.20, field);

  // Erode the edges with the fine field so nothing ends on a clean contour.
  if(det > 0.01){
    float ero = fbm(z*13.0 + 61.0, 3)*0.5 + 0.5;
    dens *= 0.62 + 0.38*smoothstep(0.20, 0.72, ero + dens*0.45);
  }
  // The eye. A cyclone is identified by the hole in the middle of it far more
  // than by the spiral, and the hole is the one part a warp cannot produce.
  // Perturbed by the field itself so its rim is ragged rather than a circle.
  dens *= 1.0 - smoothstep(0.84, 0.98, vor*(0.90 + 0.22*field))*0.94;
  return clamp(dens, 0.0, 1.0);
}

// Cirrus: a separate, much thinner deck drawn out into filaments.
//
// The stretch has to stay moderate. At 7x latitude squash the ridges came out
// as near-perfect straight lines running the whole way round the globe, which
// reads as scratches on the lens rather than as high cloud. And it has to be
// *gated* — cirrus occurs in patches ahead of fronts, not as a global veil.
float cirrus(vec3 p, float scale, float seed){
  vec3 z = vec3(p.x, p.y*3.0, p.z) * scale;
  // Not named "patch" — that is a reserved word in GLSL ES and compiles nowhere.
  float region = fbm(z*0.30 + seed*2.0, 3)*0.5 + 0.5;
  float f = ridged(z*0.85 + seed, 4);
  return smoothstep(0.56, 0.94, f) * smoothstep(0.46, 0.76, region);
}
`;

const LIGHTING = /* glsl */`
// GGX specular — used for oceans, ice and wet rock
float D_GGX(float NoH, float a){
  float a2 = a*a;
  float d = (NoH*a2 - NoH)*NoH + 1.0;
  return a2 / max(PI*d*d, 1e-7);
}
float V_Smith(float NoV, float NoL, float a){
  float a2 = a*a;
  float gv = NoL*sqrt(NoV*NoV*(1.0-a2)+a2);
  float gl = NoV*sqrt(NoL*NoL*(1.0-a2)+a2);
  return 0.5/max(gv+gl, 1e-6);
}
vec3 F_Schlick(vec3 f0, float u){
  float f = pow(1.0-u, 5.0);
  return f0 + (vec3(1.0)-f0)*f;
}
`;

/* ------------------------------------------------------------------- RINGS

   One definition of the ring's radial structure, shared by the ring itself and
   by everything that has to cast its shadow. They used to be written out twice
   with different gap positions, so the shadow bands on the planet lined up
   with nothing at all — which reads as dirt on the lens rather than as a ring.

   `ringDens` is the full thing; `ringDensLo` drops the two highest bands and is
   what the shadow taps use, because a shadow band narrower than the penumbra
   is invisible and the octaves are not free.
   ========================================================================== */

const RING_COMMON = /* glsl */`
float ringGaps(float u){
  /* Cassini-style divisions plus the edges. Both edges are *sharp*: the outer
     rim of the A ring is one of the hardest lines in the solar system, and
     fading it out over a tenth of the ring's width was most of why the shadow
     it casts read as a smudge of shading rather than as the edge of a solid
     object crossing the cloud tops. That one hard line is the whole tell. */
  float gapA = smoothstep(0.030, 0.055, abs(u - 0.46));
  float gapB = smoothstep(0.012, 0.028, abs(u - 0.71));
  // The inner edge is sharp too. Fading it in over three percent of the ring's
  // width is three percent of the ring but a *third* of the latitude band the
  // shadow covers, so the shadow's leading edge arrived as a gradient and read
  // as extra limb darkening rather than as the edge of something solid.
  return gapA*gapB*smoothstep(0.0, 0.012, u)*(1.0 - smoothstep(0.958, 1.0, u));
}
float ringDensLo(float u, float sd){
  if(u < 0.0 || u > 1.0) return 0.0;
  float band = fbm(vec3(u*34.0, 0.0, sd), 4)*0.5 + 0.5;
  float fine = fbm(vec3(u*190.0, 3.0, sd*2.0), 3)*0.5 + 0.5;
  return clamp((band*0.68 + fine*0.32)*ringGaps(u), 0.0, 1.0);
}
// The full thing. band and fine come back out because the ring shader wants
// them for its colour, and recomputing them there doubled the pass's noise.
float ringDens(float u, float sd, out float band, out float fine){
  band = fbm(vec3(u*34.0, 0.0, sd), 5)*0.5 + 0.5;
  fine = fbm(vec3(u*190.0, 3.0, sd*2.0), 4)*0.5 + 0.5;
  if(u < 0.0 || u > 1.0) return 0.0;
  float ringlets = fbm(vec3(u*640.0, 7.0, sd*3.0), 3)*0.5 + 0.5;
  return clamp((band*0.62 + fine*0.28 + ringlets*0.10)*ringGaps(u), 0.0, 1.0);
}

/**
 * Shadow cast by the ring plane onto a point on the unit sphere.
 * @param d     surface point, object space, |d| = 1
 * @param lObj  direction toward the star, object space
 */
float ringShadow(vec3 d, vec3 lObj, float inner, float outer, float opacity, float sd){
  if(opacity < 0.001 || abs(lObj.y) < 1e-4) return 1.0;
  float t = -d.y/lObj.y;
  if(t <= 0.0) return 1.0;
  vec3 hp = d + lObj*t;
  float rr = length(hp.xz);
  float u = (rr - inner)/max(outer - inner, 1e-4);
  /* The star is a disc, so the shadow of a sharp gap edge is blurred by a
     penumbra. Three taps across that width turn hard-edged stripes into the
     soft banding a real ring throws — but they have to be weighted as a tent.
     The old weights ran 0.34 / 0.32 / 0.34, which is a comb: it puts *more*
     weight on the two outer samples than on the centre one, so a band narrower
     than the tap spacing came back doubled and smeared, and the whole shadow
     lost the structure that identifies it as the shadow of a ring rather than
     as one more belt. */
  float w = 0.011;
  float dens = ringDensLo(u - w, sd)*0.25 + ringDensLo(u, sd)*0.50 + ringDensLo(u + w, sd)*0.25;
  // Optical depth, not coverage, and the *same* optical depth law the ring
  // shader uses for its own opacity — so a band that looks solid throws a
  // solid shadow. Subtracting density scaled by opacity, as this used to,
  // caps the darkest possible band at about eight percent of full shadow,
  // which is a smudge; a B-ring core stops nearly all of the light and the
  // gaps stop almost none, and it is that *ratio* that reads as a solid
  // object rather than as dirt on the lens. The slant term is the path length
  // through the sheet: a low sun cuts a longer chord and bites harder.
  float tau = (pow(dens, 2.1)*3.1 + dens*0.16) * opacity;
  return exp(-tau/max(abs(lObj.y), 0.12));
}
`;

/* --------------------------------------------------------------- SURFACE */

export const SURFACE_VERT = /* glsl */`${LOGD_V_PARS}
${NOISE}

/* The limb is displaced, and it is the one thing a bump map can never fake.
   ANGLE refuses cubemap fetches in an ESSL1 vertex shader, so the baked height
   is unavailable here — but the *low* octaves of that height are a handful of
   simplex evaluations and can simply be recomputed, in the same frame and at
   the same frequency the bake used, so the bumps land on the ground that
   carries them.

   On an Earth-sized world with air this genuinely does not matter: relief is
   a thousandth of the radius and the silhouette is smooth to well under a
   pixel, which is why it was left out. On a nine-hundred-kilometre moon with
   ten kilometres of relief it is a percent, the disc is six hundred pixels
   across at the range these are photographed from, and a perfectly circular
   edge is the single loudest tell that the craters are painted on. uDisp is
   scaled down hard for anything with an atmosphere, both because those worlds
   are large and smooth and because the shells above them are only a few
   percent up.

   vObj stays the *undisplaced* direction: it is what the cubemap, the sphere
   normal, the terminator and the limb darkening are all derived from, and all
   of them want the ideal sphere. Only the silhouette moves. */
// uSeed and uSpin are declared in the fragment stage too; a uniform of the
// same name and type in both stages is one uniform, which is what we want.
uniform float uDisp;
uniform float uSeed;
uniform float uSpin;

varying vec3 vObj;
varying vec3 vWNorm;
varying vec3 vWPos;

void main(){
  vec3 d = normalize(position);
  vObj = d;
  vWNorm = normalize(mat3(modelMatrix) * d);

  float rad = 1.0;
  if(uDisp > 0.0002){
    float s = sin(-uSpin), c = cos(-uSpin);
    vec3 dt = vec3(c*d.x + s*d.z, d.y, -s*d.x + c*d.z);
    vec3 tp = dt*1.7 + vec3(uSeed*13.1, uSeed*7.7, uSeed*3.3);
    // The first term is the bake's own continental octave set, so the swell of
    // the limb follows the swell of the shading. The second is at crater scale
    // and is what puts notches in the edge.
    float relief = fbm(tp*1.5, 5) + ridged(tp*6.2 + 13.0, 3)*0.42 - 0.19;
    rad += relief * uDisp;
  }

  vec4 wp = modelMatrix * vec4(d*rad, 1.0);
  vWPos  = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGD_V}
}
`;

export const PLAIN_VERT = /* glsl */`${LOGD_V_PARS}

varying vec3 vObj;
varying vec3 vWNorm;
varying vec3 vWPos;
void main(){
  vObj   = normalize(position);
  vWNorm = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos  = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGD_V}
}
`;

export const SURFACE_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
${CLOUD_COMMON}
${LIGHTING}
${RING_COMMON}

varying vec3 vObj;
varying vec3 vWNorm;
varying vec3 vWPos;

uniform samplerCube uSurf;
uniform samplerCube uEnv;
uniform vec3  uSunDir;        // world space, points *toward* the star
uniform vec3  uSunColor;
uniform vec3  uCamPos;        // world space
uniform vec3  uCamObj;        // object space (radius units)
uniform float uTexel;         // 1 / cubemap face size
uniform float uBump;
uniform float uSea;
uniform int   uType;
uniform float uTime;
uniform float uDetail;        // 0 far .. 1 close
uniform float uSharp;         // coastline re-synthesis, ramps with angular size
uniform float uLimb;          // Minnaert exponent on the view term
uniform float uSeed;
uniform vec3  uWaterCol;
uniform vec3  uSkyCol;        // this world's own sky, for water reflection
uniform float uHasAtmo;
uniform vec3  uAmbient;
uniform float uNight;         // city-light intensity
uniform float uLavaGlow;
uniform float uCloudShadow;
uniform float uCloudAlt;      // deck altitude in planet radii
uniform float uCloudRot;
uniform float uCloudScale;
uniform float uCloudCover;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingOpacity;
uniform mat3  uObjFromWorld;  // world dir -> object dir
uniform float uSpin;

vec4 surf(vec3 d){ return textureCube(uSurf, d); }

vec3 spinY(vec3 v, float a){
  float s = sin(a), c = cos(a);
  return vec3(c*v.x + s*v.z, v.y, -s*v.x + c*v.z);
}

// One cheap tap into the shared weather field, for shadows and the lights mask.
float cloudField(vec3 d, float rot, float scale, float t, float seed){
  vec4 wf = weatherFrame(d, rot, t, seed);
  return cloudDens(wf.xyz, wf.w, scale, uCloudCover, 0.0);
}

void main(){
  ${LOGD_F}
  vec3 d  = normalize(vObj);
  vec3 dt = spinY(d, -uSpin);     // texture-space direction (planet rotation)
  vec4 S  = surf(dt);
  vec3 alb = S.rgb;
  float h  = S.a;

  // ---- tangent frame on the sphere -----------------------------------
  vec3 up = abs(dt.y) < 0.98 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
  vec3 T = normalize(cross(up, dt));
  vec3 B = cross(dt, T);

  float e = uTexel*1.6;
  float hT = surf(normalize(dt + T*e)).a;
  float hB = surf(normalize(dt + B*e)).a;
  float dhx = (hT - h)/e;
  float dhy = (hB - h)/e;

  // How far the height moves across one bake texel. Everything that has to
  // survive magnification is sized against this rather than a constant, so the
  // same code behaves at 128 per face and at 1024.
  float relTex = max(abs(hT - h), abs(hB - h));

  // ---- close-range detail: re-synthesise what the bake can't hold -----
  if(uDetail > 0.001){
    vec3 dp = dt*260.0 + uSeed*17.0;
    // Three taps at three octaves rather than four: this runs over every pixel
    // of a planet that by definition fills the frame, and the last octave buys
    // three more noise evaluations of detail already below the pixel.
    float n0 = fbm(dp, 3);
    float nx = fbm(dp + T*0.35, 3);
    float ny = fbm(dp + B*0.35, 3);
    float k = uDetail*0.9;
    dhx += (nx-n0)*k*2.2;
    dhy += (ny-n0)*k*2.2;
    alb *= 1.0 + n0*0.18*uDetail;
  }

  // ---- coastline ------------------------------------------------------
  // A fixed +-0.004 threshold across a bilinearly magnified height field lands
  // on the interpolation grid, and what comes out is the two-pixel staircase
  // the coastlines used to show at close orbit. Two changes fix it: size the
  // ramp to the *local* relief so it always spans about one texel whatever the
  // bake resolution, and perturb the height with fractal detail the bake never
  // held, so the shoreline keeps breaking up below the texel.
  float hs = h;
  // Only near the shore. Deep ocean and continental interior cannot see this,
  // and it is seven octaves of noise over a disc that can fill the frame.
  if(uSharp > 0.001 && abs(h - uSea) < relTex*3.0 + 0.010){
    vec3 cq = dt*96.0 + uSeed*11.0;
    float wig = fbm(cq, 4)*1.20 + (ridged(cq*2.4 + 31.0, 3) - 0.42)*0.90;
    hs += wig * (relTex*1.7 + 0.0014) * uSharp;
  }
  float coastW = max(relTex*0.85, 0.0011);
  float land = smoothstep(uSea - coastW, uSea + coastW, hs);
  float isWater = (uType == 0 || uType == 5) ? (1.0 - land) : 0.0;

  vec3 nTex = normalize(dt - (T*dhx + B*dhy) * uBump * (1.0 - isWater*0.94));

  // ---- ocean ----------------------------------------------------------
  float rough = 0.94;
  vec3 f0 = vec3(0.035);
  if(isWater > 0.01){
    // Wave slopes at three scales. The broad set bends the whole glitter path,
    // the fine set is what turns one mirror blob into a field of sparkle. The
    // slope amplitude has to fall away with distance or the sub-pixel waves
    // alias into crawling speckle, so it rides on uDetail.
    vec3 wp = dt*78.0;
    float t = uTime*0.05;
    float r1 = fbm(wp + vec3(t, 0.0, t*0.7), 3);
    float r2 = fbm(wp*2.7 - vec3(t*1.4, t*0.3, 0.0), 3);
    float r3 = fbm(wp*9.5 + vec3(0.0, t*2.1, t), 2);
    float amp = 0.013 * (0.30 + uDetail*1.5);
    vec3 rn = normalize(dt + (T*(r1 + r3*0.5) + B*(r2 - r3*0.4))*amp);
    nTex = normalize(mix(nTex, rn, isWater));

    // Depth is what colours an ocean, not hue. Keep some of the bake's own
    // turbidity and sea ice rather than flooding the whole sea with one value,
    // which is what made it a flat fill.
    float dep = clamp((uSea - hs)/max(uSea*0.55, 0.02), 0.0, 1.0);
    vec3 wcol = mix(uWaterCol*1.55, uWaterCol*0.14, sqrt(dep));
    wcol = mix(wcol, alb*1.30, 0.34);
    alb = mix(alb, wcol, isWater);

    // Roughen with distance: fewer waves per pixel far away, which is a poor
    // man's slope-variance filter and stops the glint from crawling.
    rough = mix(rough, mix(0.215, 0.098, uDetail), isWater);
    f0 = mix(f0, vec3(0.021), isWater);
  }
  if(uType == 3) rough = mix(rough, 0.22, 0.7);   // ice is glossy

  vec3 nObj = spinY(nTex, uSpin);

  // uObjFromWorld is world->object; for a rotation its transpose maps back,
  // in GLSL, (v * M) is exactly transpose(M) * v.
  vec3 N = normalize(nObj * uObjFromWorld);
  vec3 Ng = normalize(d * uObjFromWorld);   // the sphere's own normal

  vec3 V = normalize(uCamPos - vWPos);
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(V + L);
  float NoL = dot(N, L);
  float NoV = max(dot(N, V), 1e-4);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float gNoV = clamp(dot(Ng, V), 0.0, 1.0);  // 1 at disc centre, 0 at the limb

  // Geometric terminator from the *sphere*, so mountains cannot light up on
  // the night side.
  float geoNoL = dot(Ng, L);
  float shadowMask = smoothstep(-0.055, 0.045, geoNoL);

  // ---- limb darkening --------------------------------------------------
  // A Lambertian sphere has no limb falloff whatsoever, and that is precisely
  // why a plain N.L planet reads as a flat disc pasted on black: at low phase
  // every pixel returns nearly the same number and the silhouette is a cut
  // line. Real worlds darken toward the limb because the line of sight leaves
  // at a grazing angle — through more air on anything that has some, through
  // more shadowed micro-relief on anything that does not. A Minnaert exponent
  // on the view term is the cheapest honest version, and the extra squeeze in
  // the last few percent of the disc is what gives the edge its roll.
  float limb = pow(max(gNoV, 1e-3), uLimb) * mix(1.0, smoothstep(0.0, 0.16, gNoV), 0.5);
  float diffTerm = max(NoL, 0.0) * shadowMask * limb;

  // Sunset colouring, from extinction rather than a tint ramp. Light reaching
  // the ground near the terminator has crossed a long slant path through the
  // atmosphere, so blue is scattered out of it first. The same coefficients
  // drive the cloud deck, which is what keeps the two agreeing at the seam.
  //
  // On a world with no air there is nothing to redden it, and running the term
  // anyway put a warm orange fringe all the way round the terminator of every
  // airless moon in the game — the single loudest way to make a cratered rock
  // read as having an atmosphere it does not have.
  float slant = clamp((0.13 - geoNoL)/0.16, 0.0, 1.0) * uHasAtmo;
  vec3 sunsetTint = exp(-vec3(0.55, 1.15, 2.10) * slant * 1.35);

  /* World -> object, and note that this one is *not* written the same way as
     the two above. A vector times a matrix is transpose(M)*v in GLSL, which is
     what turns an object normal into a world one — so writing the sun the same
     way rotated it by the tilt in the wrong direction, and every shadow that starts from a
     sun *direction* rather than a surface normal landed somewhere else. On a
     ringed giant at 24 degrees of tilt that is 48 degrees of error: the ring's
     shadow fell off the visible disc entirely, which is why it was reported
     missing while the geometry said a third of the lit hemisphere was inside
     it. Same for every cloud shadow on a tilted world. */
  vec3 lObj = normalize(uObjFromWorld * L);

  // ---- cloud shadow ---------------------------------------------------
  // The deck sits uCloudAlt above the ground, so its shadow lands where the
  // sunward ray from this point leaves the shell — which stretches out toward
  // the terminator exactly the way a real one does. The old fixed 0.045 offset
  // put the shadow under the cloud at noon and nowhere near it at dusk.
  //
  // The strength is not a taste knob either. The deck shader accumulates its
  // slabs to about 1.55x this single tap before deciding how opaque a cloud
  // is, so matching that gain here is what makes a footprint as dark as the
  // thing casting it — otherwise the shadow is systematically thinner than its
  // own cloud. The cap on the grazing term sets how far a shadow can stretch
  // at the terminator, which is where it reads best and where it was being
  // clipped shortest.
  float cs = 1.0;
  if(uCloudShadow > 0.001){
    float ct = uCloudAlt / max(dot(d, lObj), 0.07);
    vec3 sp = normalize(d + lObj*ct);
    float cd = clamp(cloudField(sp, uCloudRot, uCloudScale, uTime, uSeed)*1.55, 0.0, 1.0);
    cs = 1.0 - cd*uCloudShadow;
  }

  // ---- ring shadow ----------------------------------------------------
  float rs = ringShadow(d, lObj, uRingInner, uRingOuter, uRingOpacity, uSeed*1.7);

  /* ---- terrain casting its own shadow ---------------------------------
     N.L alone tells you which *face* of a ridge is turned away from the star.
     It does not tell you that the ridge throws a shadow across the valley
     behind it, and near the terminator — where the sun is a couple of degrees
     above the local horizon and every shadow is tens of kilometres long —
     that missing term is the whole difference between a relief map and a
     landscape. A real horizon search is a loop; one tap a few texels sunward
     buys most of it for a single fetch. If the ground over there stands higher
     than the beam does by the time it gets here, this point is behind it.

     Water is excluded (it has no relief to cast with) and so is the night
     side, where it would multiply into black anyway. */
  float terrShad = 1.0;
  if(uBump > 0.001 && shadowMask > 0.002 && isWater < 0.5){
    vec3 lTex = spinY(lObj, -uSpin);
    float sunT = dot(lTex, dt);                       // sin of the sun's elevation
    vec3 sdir = lTex - dt*sunT;
    float sl = length(sdir);
    /* And only near the terminator. Above about 25 degrees of solar elevation
       nothing the bake can hold is steep enough to shadow anything, so the tap
       would return 1.0 over most of the disc — and this is a texture fetch on
       every pixel of a world that by definition fills the frame. Solar
       elevation varies smoothly across the sphere, so the branch is spatially
       coherent and the warps that take it are the ones near the terminator. */
    if(sl > 1e-3 && sunT > 0.015 && sunT < 0.44){
      float stp = uTexel*6.0;
      float hS = surf(normalize(dt + (sdir/sl)*stp)).a;
      // Compare *slopes*, not heights. uBump is what turns a height difference
      // per radian into the tangent of a surface slope — it is the same factor
      // the normal map uses, so the shadow and the shading agree about how
      // steep the ground is. Anything steeper than the beam is in shadow.
      float gSlope = (hS - h)*uBump/stp;
      float bSlope = sunT/max(sl, 0.05);          // tan of the sun's elevation
      terrShad = 1.0 - smoothstep(0.0, 0.13, gSlope - bSlope)*0.80;
    }
  }

  // ---- direct + ambient ----------------------------------------------
  vec3 sun = uSunColor * sunsetTint * cs * rs * terrShad;
  vec3 diffuse = alb * sun * diffTerm;

  float a = max(rough*rough, 0.0015);
  // The glint cap has to be high enough that the specular point actually
  // clips: a sun reflection on water is thousands of times the diffuse, and
  // clamping it to 40 turned the one feature that proves an ocean is liquid
  // into a faint grey smudge. Specular is masked by the terminator and the
  // limb but not by N.L twice over.
  vec3 F = F_Schlick(f0, VoH);
  float spec = min(D_GGX(NoH, a) * V_Smith(NoV, max(NoL,0.0), a), 300.0);
  vec3 specular = sun * spec * F * max(NoL, 0.0) * shadowMask * limb;

  // Ambient in space comes almost entirely from the star, so the night side
  // has to fall away to near-nothing or the planet reads as studio-lit. Under
  // a cloud the sky is the cloud, so the fill goes with the direct term —
  // shadowing only the direct light left the sea beneath a cyclone lit by
  // everything else in the frame, which is a ten percent dip nobody can see.
  vec3 env = textureCube(uEnv, N).rgb;
  vec3 ambient = alb * (uAmbient + env*0.22) * (0.16 + 0.84*shadowMask)
               * mix(1.0, limb, 0.65) * mix(1.0, cs, 0.6);

  vec3 col = diffuse + specular + ambient;

  // ---- sky reflected in the water --------------------------------------
  // At a grazing view the sea is a mirror of its own sky, which is why every
  // photograph of an ocean world from orbit brightens toward the limb. Without
  // it the water goes flat and black at exactly the place the planet most
  // needs to read as a sphere.
  if(isWater > 0.01 && uHasAtmo > 0.001){
    float fr = 0.02 + 0.98*pow(1.0 - gNoV, 5.0);
    vec3 sky = uSkyCol * uSunColor * (0.10 + 0.90*smoothstep(-0.08, 0.40, geoNoL));
    col += sky * fr * isWater * uHasAtmo * cs * 0.85;
  }

  // ---- lava emissive --------------------------------------------------
  if(uType == 4){
    float m = smoothstep(uSea + 0.02, uSea - 0.15, h);
    float pulse = 0.75 + 0.25*sin(uTime*0.5 + h*40.0 + uSeed);
    vec3 glow = mix(vec3(1.6,0.30,0.04), vec3(2.6,1.25,0.35), pow(m, 2.5));
    col += glow * pow(m, 1.6) * uLavaGlow * pulse;
  }

  // ---- night side city lights ----------------------------------------
  if(uNight > 0.001){
    float night = smoothstep(0.10, -0.16, geoNoL);
    if(night > 0.001){
      /* A lit continent from orbit is not noise, and it is not evenly spread
         either. It is a few hundred *objects* of wildly unequal size, almost
         all of them within a day's walk of water — the coast, or the river
         behind it — over a great deal of black.

         Three things were missing and each is a separate cause. Every city was
         the same size, because a plain cellular field cannot say which cell it
         landed in and so has nothing to vary. The interior sat at a flat 0.30
         of the coastal density, which spreads settlement evenly over a
         continent. And a third of the light came from a ridged fractal
         standing in for arterial roads, which is precisely a branching lichen
         — that term is gone, and what replaces it is the shoreline itself. */
      vec3 cp = dt*12.5 + uSeed*3.0;
      vec2 cw = cellular(cp, 1.0);

      /* Conurbations. One scale of settlement is a Poisson scatter of isolated,
         equal dots; what a night pass actually shows is a dozen towns strung
         along one estuary reading as a single lit patch with two or three hot
         centres in it, and a great deal of black between one patch and the
         next. This is the coarse half — which stretch of coast is settled at
         all — and the cellular field below puts the towns inside it. Without
         it the light comes out evenly spread along every shoreline on the
         planet, which at this width is a pen line tracing the coast: thin
         enough that the chromatic-aberration taps split it into blue on one
         side and orange on the other, so it reads as a coloured scratch rather
         than as a country. Three octaves rather than a second cellular loop,
         because this runs over the whole night hemisphere and the crisp
         Voronoi disc it replaces was not buying anything at this scale. */
      float metro = smoothstep(0.32, 0.74, fbm(dt*5.2 + uSeed*23.0, 3)*0.5 + 0.5);

      /* Size hierarchy, roughly Zipf — most settlements small, about one in
         fifty enormous. That spread, not the count, is what separates a country
         from a scatter of identical dots.

         It has to come from a *smooth* field and not from the cell's own hash,
         and this is the whole of why the last pass drew a dead straight
         diagonal through the largest city on the planet. F1 is continuous
         across a Voronoi wall; every quantity keyed to the cell's identity is
         not, and they all step together. The usual defence is to fade the
         contribution out before the wall arrives — but a wall can be far nearer
         a centre than the mean spacing suggests, and the settlements that
         actually reach one are precisely the large ones anyone looks at. A
         low-frequency fractal cannot step anywhere, so nothing below this line
         needs to know which cell it landed in.

         The other floor is angular. A cell shrinks with range until a whole
         conurbation sits inside one pixel and disappears into the resampling,
         and a sub-pixel emissive is not dim, it is absent — so the size floor
         grows as the world shrinks in frame. Up close uSharp takes it back to
         the honest size, and it is the same exaggeration the station's windows
         already make. */
      /* Stretched, and that matters more than it looks. A fractal's values
         pile up around its mean, so mapping one straight onto 0..1 and raising
         it to the fourth leaves *no* large cities at all — the whole hierarchy
         collapses into a field of identical towns, which is the complaint this
         term exists to answer. Widening the distribution first restores the
         one-in-fifty that reads as a capital. */
      float sizeF = clamp(fbm(dt*6.2 + uSeed*41.0, 2)*1.35 + 0.52, 0.0, 1.0);
      float rank = pow(sizeF, 4.0);
      float sizeK = mix(2.0, 1.0, uSharp);
      float dcn  = cw.x / (mix(0.075, 0.30, rank)*sizeK);
      float core   = exp(-dcn*dcn*5.0);
      float sprawl = exp(-dcn*dcn*0.85);

      // and it still fades on F1 itself, which is continuous by construction,
      // so a cluster ends before the cell does rather than at a straight line
      float cellFade = smoothstep(0.46, 0.10, cw.x);
      core   *= cellFade;
      sprawl *= cellFade;

      // Which continents are settled at all. A third of them, not four fifths:
      // a country is a handful of lit places in a lot of dark, and lighting
      // nearly everywhere habitable is what turns that into an even carpet.
      float region = smoothstep(0.30, 0.68, fbm(dt*2.4 + uSeed*5.0, 4)*0.5 + 0.5);

      /* Settlement hugs the water. The height over sea level sets it: the
         shoreline band is narrow, and the valleys behind it come free out of
         the two height taps the normal map has already fetched — a point that
         sits lower than the ground on either side of it is a valley floor, and
         that is where the roads and the towns are. */
      /* Settlement hugs the water, but the *window* has to be a coastal plain
         and not a contour line. These were tight enough — a Gaussian of 0.042
         in height against an upper cutoff starting at 0.14 — that on any coast
         with real relief the habitable band was narrower than a bake texel,
         so the entire night side came out as a one-pixel line following the
         shore. It is a preference, not a mask: a broad falloff inland, and a
         floor under it so a river town two hundred kilometres from the sea can
         still exist. */
      float above = hs - uSea;
      float sh = above/0.088;
      float shore = exp(-sh*sh);
      float valley = clamp(((hT + hB)*0.5 - h)/(relTex + 0.0006), 0.0, 1.0);
      float inland = smoothstep(0.0, 0.010, above)
                   * (1.0 - smoothstep(0.26, 0.62, above));
      float polar = 1.0 - smoothstep(0.58, 0.82, abs(dt.y));
      float hab = inland * polar * (0.30 + 1.25*shore + 0.85*valley);

      // Ribbon development along the coast road: the one linear feature that
      // really is visible from orbit, and it comes out of the height field
      // rather than out of a fractal that happens to branch. It is a *hint* —
      // at the width and weight it used to carry it was the brightest term in
      // the sum and drew the whole night side on its own.
      float rb = (above - 0.014)/0.026;
      float ribbon = exp(-rb*rb) * smoothstep(0.28, 0.68, fbm(dt*8.0 + uSeed*9.0, 2)*0.5 + 0.5);

      /* A city is not a Gaussian, and at the level the last pass left these at
         it did not matter what shape they were: the core ran to a hundred
         units of radiance, which is the tone curve's white point, so every
         settlement above about a tenth of the largest rendered as a flat white
         lozenge tens of pixels across with a bloom skirt round it. A night
         side covered in those does not read as a continent, it reads as a
         field of lit boulders — which is exactly what it looked like.

         Two changes. The peak comes down by an order of magnitude, so only the
         very cores of the very largest clip and everything else sits on the
         steep part of the curve where the size hierarchy is actually visible.
         And the smooth falloff is broken up by a field sampled at the scale of
         a suburb, so a city is a ragged cluster of grains with arms running
         out of it rather than a solid disc. The grain fades out with distance
         along with the rest of the close-range detail, because a settlement
         smaller than a pixel is a twinkle, not a town. */
      float grain = 1.0;
      // Skipped outright at any range where a settlement is below a pixel:
      // four octaves of noise over the night half of a world is not worth
      // paying for to modulate something that is already one dot.
      if(uSharp > 0.05){
        float urbL = fbm(dt*62.0  + uSeed*7.0,  2)*0.5 + 0.5;   // districts
        float urbF = fbm(dt*230.0 + uSeed*11.0, 2)*0.5 + 0.5;   // suburbs
        grain = mix(1.0,
          (0.30 + 1.00*smoothstep(0.30, 0.78, urbL))
        * (0.55 + 0.65*smoothstep(0.30, 0.78, urbF)), uSharp);
      }

      /* The cores carry more of the total than they did and the ribbon far
         less, which is the whole difference between a coloured hairline and a
         cluster with a bright middle. The peak still has to stay well under
         the tone curve's white point — a hundred units made every settlement
         above a tenth of the largest render as a flat white lozenge — so the
         biggest core lands near twenty-five units of radiance and a typical
         town near three, which is a visible hierarchy on the steep part of the
         curve with only the very largest bleeding into the bloom. */
      float lights = region * (0.42 + 1.22*metro)
                   * (core*(1.75 + rank*3.80)*grain
                    + sprawl*(0.82 + rank*1.70)*(0.45 + 0.55*grain)
                    + ribbon*0.45);
      lights *= hab;
      lights *= (1.0 - cloudField(d, uCloudRot, uCloudScale, uTime, uSeed)*uCloudShadow*0.9);

      /* Sodium in the old cores, colder light in the new. From a field that
         varies well below the size of a city, so a city is still one colour the
         whole way across rather than carrying a gradient nothing on the ground
         could account for — but *not* from the cell's own hash, which multiplies
         the ribbon as well as the cluster and therefore reaches every Voronoi
         wall on the planet. A hard line with warm light on one side of it and
         cold on the other is the loudest possible way to say "Voronoi". */
      vec3 lampWarm = vec3(1.0, 0.62, 0.26);
      vec3 lampCold = vec3(0.68, 0.83, 1.0);
      float lampF = fbm(dt*5.5 + uSeed*29.0, 2)*0.5 + 0.5;
      vec3 lamp = mix(lampCold, lampWarm, smoothstep(0.36, 0.64, lampF));
      // The lights sit on the ground, so they dim toward the limb with
      // everything else rather than riding on top of the silhouette.
      col += lamp * lights * night * uNight * 1.7 * mix(0.35, 1.0, gNoV);
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ---------------------------------------------------------------- CLOUDS */

export const CLOUD_VERT = PLAIN_VERT;

/**
 * The cloud deck as a thin volume rather than a decal.
 *
 * The mesh is the *outer* surface of the shell. For each of three slabs
 * beneath it the view ray is intersected with that slab's sphere and the field
 * sampled at the hit, which produces genuine parallax between the decks: tops
 * slide over bases as the camera moves, the layer has visible thickness at the
 * limb, and towers cast onto the deck below. Three slabs cost about what the
 * old single-sample version did, because the field itself is far cheaper now.
 */
export const CLOUD_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
${CLOUD_COMMON}
${RING_COMMON}

varying vec3 vObj;
varying vec3 vWNorm;
varying vec3 vWPos;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uCamPos;
uniform vec3  uCamObj;
uniform float uTime;
uniform float uSeed;
uniform float uRot;
uniform float uScale;
uniform float uCover;
uniform float uShellR;      // outer radius of the deck, planet radii
uniform float uThick;       // deck thickness, planet radii
uniform vec3  uTint;
uniform vec3  uAmbient;
uniform mat3  uObjFromWorld;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingOpacity;

void main(){
  ${LOGD_F}
  vec3 outer = normalize(vObj) * uShellR;
  vec3 rd = normalize(outer - uCamObj);
  // world -> object is matrix-times-vector, in that order. The other order is
  // its transpose, and throws every shadow the tilt angle out the wrong way.
  vec3 lObj = normalize(uObjFromWorld * normalize(uSunDir));

  /* Night-side early-out. The deck mesh covers the whole disc, but past the
     terminator a cloud contributes essentially nothing — and the three slabs
     plus their shadow taps are about sixty noise evaluations per pixel. Half a
     planet's worth of that is pure waste. The lit ramp below uses the same
     threshold, so the cut is placed where it already multiplies by zero. */
  float geoNoLEarly = dot(normalize(vObj) * uObjFromWorld, normalize(uSunDir));
  if(geoNoLEarly < -0.19){ gl_FragColor = vec4(0.0); return; }

  const int SLABS = 3;

  /* The slabs exist to buy parallax between the top of the deck and its base.
     Looking straight down there *is* no parallax — the three samples land on
     top of each other and cost three times as much to say the same thing. So
     the count follows the obliquity of the view. This is most of the cost of a
     world that fills the frame, because that framing is almost all vertical.  */
  float oblique = 1.0 - abs(dot(rd, normalize(vObj)));
  float slabsF = clamp(1.0 + oblique*7.0, 1.0, float(SLABS));

  float acc = 0.0;          // accumulated density
  float lightAcc = 0.0;     // density-weighted illumination
  float used = 0.0;
  float topDens = 0.0;      // density of the highest slab that had any
  vec3  topDir = normalize(vObj);

  for(int i=0;i<SLABS;i++){
    if(float(i) >= slabsF) break;
    // once the column is opaque, nothing beneath it can be seen
    if(acc > 1.85) break;
    used += 1.0;
    float f = float(i)/float(SLABS-1);
    float r = uShellR - uThick*f;
    vec2 hit = raySphere(uCamObj, rd, r);
    // outside the shell we want the near hit; inside it, the far one
    float t = (hit.x > 0.0) ? hit.x : hit.y;
    if(t <= 0.0) continue;
    vec3 sp = normalize(uCamObj + rd*t);

    vec4 wf = weatherFrame(sp, uRot + f*0.06, uTime, uSeed);
    // lower slabs are the dense base, upper slabs the thinner tops
    float d = cloudDens(wf.xyz, wf.w, uScale*(1.0 + f*0.55), uCover*(1.0 - f*0.22), 1.0);
    d *= mix(1.0, 0.62, f);

    if(i == 0){ topDens = d; topDir = sp; }

    // Shadow the slab by whatever sits above it, toward the star. One tap per
    // slab, no fine detail — the shape of the shadow is what reads, not its
    // texture.
    float above = 0.0;
    if(d > 0.004){
      vec3 lp = normalize(sp + lObj*(0.020 + f*0.030));
      vec4 lw = weatherFrame(lp, uRot, uTime, uSeed);
      above = cloudDens(lw.xyz, lw.w, uScale, uCover, 0.0);
    }
    float shade = exp(-above*2.3 - acc*1.5);
    lightAcc += d*shade;
    acc += d;
  }
  // Mean over the slabs *actually taken*, then one gain for the deck's optical
  // thickness — summing them made every world permanently overcast, and
  // dividing by the nominal count would darken every vertical view.
  float invUsed = 1.0/max(used, 1.0);
  acc = clamp(acc*invUsed*1.55, 0.0, 1.0);
  lightAcc *= invUsed*1.55;

  /* High cirrus, sampled on the outer shell only — thin, bright, and the thing
     that keeps the limb from being a hard line. Which is also where it is worth
     paying for: looking straight down at the deck it is a seven-octave veil
     nobody can pick out from the cumulus under it, so it fades in with
     obliquity rather than being evaluated everywhere. */
  float cirGate = smoothstep(0.06, 0.22, oblique);
  if(cirGate > 0.01){
    vec4 cf = weatherFrame(normalize(vObj), uRot*0.62, uTime, uSeed*1.7);
    float cir = cirrus(cf.xyz, uScale*1.15, uSeed) * 0.20 * cirGate;
    acc = clamp(acc + cir*(1.0 - acc), 0.0, 1.0);
    lightAcc += cir*0.8;
  }

  if(acc <= 0.004){ gl_FragColor = vec4(0.0); return; }
  float lightFrac = clamp(lightAcc / max(acc*1.6, 1e-3), 0.0, 1.0);

  vec3 L = normalize(uSunDir);
  vec3 V = normalize(uCamPos - vWPos);
  vec3 N = normalize(vWNorm);

  // Geometric day/night from the sphere, with a wide soft terminator: cloud
  // tops are kilometres up, so they stay lit well past the ground's sunset.
  float geoNoL = dot(normalize(vObj) * uObjFromWorld, L);
  float lit = smoothstep(-0.15, 0.11, geoNoL);

  // Henyey-Greenstein forward lobe (the silver lining) plus an isotropic floor.
  float mu = dot(V, -L);
  float g = 0.66, g2 = g*g;
  float hg = (1.0-g2) / pow(max(1.0 + g2 - 2.0*g*mu, 1e-3), 1.5) * 0.0796;
  float phase = 0.85 + hg*4.2;

  // The powder effect: light entering a thick deck is scattered back out less
  // near the illuminated *edge* than in the middle, so dense tops darken
  // slightly where they meet the sun. Without it clouds look like cotton wool.
  float powder = 1.0 - exp(-acc*3.4);

  vec3 deep = uTint * vec3(0.34, 0.40, 0.52);
  vec3 body = mix(deep, uTint, lightFrac*powder + 0.12);

  // Sunlight through the terminator has crossed a long slant path, so it
  // arrives reddened. The band is *narrow* — sunset is a few degrees of arc,
  // not a third of the disc — and the ramp is in cos(zenith), so it hugs the
  // terminator instead of washing across the day side.
  float slant = clamp((0.13 - geoNoL)/0.16, 0.0, 1.0);
  vec3 warm = exp(-vec3(0.55, 1.15, 2.10) * slant * 1.35);

  /* A ringed world throws the ring's shadow onto its *cloud tops* as much as
     onto the ground, and the deck used to be the one surface in the game that
     ignored it: on a ringed terran the bands crossed the sea and stopped dead
     at the coastline of the nearest weather system. The branch is on a
     uniform, so the nine worlds in ten that have no ring never pay for it. */
  float rs = 1.0;
  if(uRingOpacity > 0.001){
    rs = ringShadow(normalize(vObj), lObj, uRingInner, uRingOuter, uRingOpacity, uSeed*1.7);
  }

  vec3 col = uSunColor * warm * body * lit * phase * (0.34 + lightFrac*0.92) * rs;
  col += uAmbient * uTint * 1.1 * (0.10 + 0.90*lit);
  // thin edges transmit
  col += uSunColor * warm * uTint * (1.0 - smoothstep(0.0, 0.5, acc)) * lit * 0.35 * rs;

  // Fade into the atmosphere at the limb, where we are looking along the deck
  // and the scattering shell in front of it dominates.
  // At high phase the *whole* lit crescent is near the limb, so a fade this
  // deep took the cloud tops out of exactly the framing that most needs them:
  // the crescent came back as bare ocean under haze. The shell in front is a
  // good deal thinner now, so the deck can afford to stay.
  float rim = 1.0 - abs(dot(N, V));
  float alpha = clamp(acc*1.20, 0.0, 1.0) * mix(1.0, 0.58, pow(rim, 2.0));

  gl_FragColor = vec4(col*alpha, alpha);
}
`;

/* ------------------------------------------------------------ ATMOSPHERE */

export const ATMO_VERT = /* glsl */`${LOGD_V_PARS}

uniform float uAtmoR;
varying vec3 vObj;
varying vec3 vWPos;
void main(){
  // object space here is measured in planet radii, and the mesh carries the
  // shell scale in its matrix — so the raw vertex has to be scaled to match.
  vObj = normalize(position) * uAtmoR;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGD_V}
}
`;

/**
 * Single-scattering Rayleigh + Mie raymarch through a spherical shell.
 * Planet radius is 1.0 in this space; the shell is uAtmoR.
 * Output is premultiplied: rgb = in-scattered light, a = 1 - transmittance.
 */
export const ATMO_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}

varying vec3 vObj;
varying vec3 vWPos;

uniform vec3  uCamObj;        // camera in object space (radius units)
uniform vec3  uSunObj;        // sun direction in object space
uniform vec3  uSunColor;
uniform float uAtmoR;
uniform vec3  uBetaR;
uniform float uBetaM;
uniform vec3  uBetaO;         // ozone: absorption only, no scattering
uniform float uHr;
uniform float uHm;
uniform float uG;             // Mie anisotropy
uniform float uIntensity;

// Step counts are compile-time (set via material defines per quality tier).
// Uniform-driven loop bounds forced ANGLE into a 24x8 unrolled monster that
// mis-compiled per triangle; constants keep the shader small and correct.
#ifndef ATMO_STEPS
  #define ATMO_STEPS 12
#endif
#ifndef ATMO_LSTEPS
  #define ATMO_LSTEPS 3
#endif

float densityR(float h){ return exp(-h/uHr); }

// Cornette-Shanks. Called twice with different g, so it is a function.
float phaseMie(float mu, float g){
  float g2 = g*g;
  return 3.0/(8.0*PI) * ((1.0-g2)*(1.0+mu*mu)) /
         ((2.0+g2)*pow(max(1.0 + g2 - 2.0*g*mu, 1e-4), 1.5));
}

void main(){
  ${LOGD_F}
  vec3 ro = uCamObj;
  vec3 rd = normalize(vObj - uCamObj);

  vec2 atm = raySphere(ro, rd, uAtmoR);
  float t0 = max(atm.x, 0.0);
  float t1 = atm.y;

  vec2 pl = raySphere(ro, rd, 1.0);
  bool hitGround = (pl.y > 0.0 && pl.x > 0.0);
  if(hitGround) t1 = min(t1, pl.x);

  if(atm.y < 0.0 || t1 <= t0){
    gl_FragColor = vec4(0.0);
    return;
  }

  float shell = max(uAtmoR - 1.0, 1e-4);

  /* Sample count scaled to the path actually being crossed.
     A ray looking straight down crosses only the shell thickness; one grazing
     the limb crosses twenty times that. Spending the full sixteen samples on
     both is why a world that fills the frame costs what it does, because
     almost every pixel in that framing is the cheap case. The bound stays a
     compile-time constant — a uniform loop bound makes ANGLE unroll into a
     mis-compiling monster — and the loop simply exits early. */
  float chord = t1 - t0;
  float maxChord = 2.0*sqrt(max(2.0*shell, 1e-6));
  float stepsF = clamp(float(ATMO_STEPS)*(chord/maxChord), 4.0, float(ATMO_STEPS));
  float segLen = chord/stepsF;

  // Ozone absorbs without scattering, so it can only ever appear in an
  // extinction term. Giving it its own Gaussian layer meant one more exp() at
  // every one of the sixteen view samples *and* all sixty-four light samples,
  // which measured as about a third of the pass; riding it on the Rayleigh
  // profile costs nothing and keeps the part that matters, which is that the
  // green and the orange are eaten before the blue along a long path.
  vec3 betaRO = uBetaR + uBetaO;

  /* Only Rayleigh is marched. The aerosol that draws the limb arc lives in a
     layer a thousandth of a radius deep and is handled in closed form below —
     see the block after the loop — which is both cheaper and, for a layer this
     thin, strictly more accurate than sampling it sixteen times. */
  vec3 sumR = vec3(0.0);
  float odR = 0.0;

  /* Early-out. The step count is a compile-time define because a uniform loop
     bound made ANGLE unroll into a mis-compiling monster — but breaking out of
     a fixed bound is fine, and it is where the cost actually is. Most of the
     screen, when a world fills the frame, is looking straight down through a
     short slant path that saturates after three or four samples; only the limb
     needs all sixteen. Measured at 39 -> 68 fps on a full-frame planet at
     3024x1890 with the whole pass off, so this is the single biggest fill cost
     in the game and it is almost entirely wasted work. */
  for(int i=0;i<ATMO_STEPS;i++){
    if(float(i) >= stepsF) break;
    // and once the view ray has gone optically dark, nothing further contributes
    if(odR*betaRO.g > 9.0) break;
    float t = t0 + segLen*(float(i)+0.5);
    vec3 p = ro + rd*t;
    float h = (length(p) - 1.0)/shell;
    h = clamp(h, 0.0, 1.0);
    float dR = densityR(h)*segLen;
    odR += dR;

    // optical depth toward the star
    vec2 ls = raySphere(p, uSunObj, uAtmoR);
    float lStepsF = clamp(float(ATMO_LSTEPS)*(max(ls.y,0.0)/maxChord), 2.0, float(ATMO_LSTEPS));
    float lSeg = max(ls.y, 0.0)/lStepsF;
    float lodR = 0.0;
    // Planetary shadow: how far the sunward ray clears the limb.
    float along = dot(p, uSunObj);
    float perp = length(p - uSunObj*along);
    // The penumbra used to run from 0.952 to 1.105 radii — a hundred-odd
    // kilometres of half-light on Earth's scale, and the reason the halo was
    // the same brightness the whole way round the disc: a point sitting on the
    // night limb still collected a third of the star. The star subtends about
    // half a degree, so the real penumbra is a fraction of a percent of a
    // radius. Keeping it narrow is what makes the ring die at the terminator;
    // the twilight wedge that remains comes from the *optical depth* of the
    // grazing sun ray below, which is also what reddens it.
    float shadow = (along > 0.0) ? 1.0 : smoothstep(0.9955, 1.0180, perp);

    if(shadow > 0.002){
      for(int j=0;j<ATMO_LSTEPS;j++){
        if(float(j) >= lStepsF) break;
        vec3 lp = p + uSunObj*(lSeg*(float(j)+0.5));
        float lh = clamp((length(lp) - 1.0)/shell, 0.0, 1.0);
        lodR += densityR(lh)*lSeg;
      }
      sumR += dR*exp(-betaRO*(odR + lodR))*shadow;
    }
  }

  float mu = dot(rd, uSunObj);
  float phaseR = 3.0/(16.0*PI) * (1.0 + mu*mu);
  /* Two lobes, not one. A single Henyey-Greenstein at g = 0.78 returns two
     percent of its head-on value at 45 degrees of scattering angle, which is
     the geometry of a 135-degree crescent — so the arc simply did not exist
     through the entire range of phase this game is actually framed at, and
     only switched on past about 150. Real aerosol has a narrow forward spike
     *and* a broad shoulder that is still an order of magnitude above isotropic
     out to 60 degrees, and it is the shoulder that draws the limb. Two HG
     terms is the standard cheap way to get both; the ratio between them is the
     only knob that decides how quickly the arc dies as the phase falls. */
  float phaseM = mix(phaseMie(mu, uG), phaseMie(mu, uG*0.40), 0.46);

  /* ---- the aerosol limb ------------------------------------------------

     Rayleigh cannot draw the arc, and the march above cannot draw aerosol.

     What makes the sunward limb of a world with air the brightest thing in a
     high-phase frame is haze: a layer a couple of kilometres deep — a
     thousandth of the shell the march covers — nearly transparent looking
     straight down, optically thick along any ray that grazes it, and
     throwing almost everything it scatters forward. Both halves are
     load-bearing. Thin is why it reads as a line rather than a wash; forward
     is why it only lights up at high phase, which is exactly when the disc
     beside it has gone dark and there is nothing else in the frame.

     It is not marched because it cannot be. Sixteen steps across a chord half
     a radius long cannot resolve a layer a thousandth of a radius deep: the
     samples miss it, or one lands inside it and the arc strobes as the camera
     moves. The column through an exponential layer has a closed form, and
     because the layer is thin the whole of it sits at one altitude under one
     solar zenith — so a single evaluation is not an approximation of the
     march, it is better than it, and costs two exponentials instead of
     eighty.                                                               */
  float hrR = uHr*shell;                      // scale heights, radius units
  /* Resolution matching, on the same grounds as the shell being 1.7x tall in
     the first place. A layer this thin is a fraction of a pixel at any
     distance where the planet is not filling the frame, and a sub-pixel
     bright line is not a thin arc — it is a shimmer. Widen it with distance
     and thin the coefficient by exactly the same factor, so the flux through
     the layer is conserved and only its distribution over pixels changes. */
  float hmP = uHm*shell;
  float hmR = clamp(length(ro)*0.00150, hmP, shell*0.6);
  float betaMs = uBetaM*hmP/hmR;

  // Where the layer is thickest along this ray, and the geometry there.
  float tMin = clamp(-dot(ro, rd), t0, t1);
  vec3  pMin = ro + rd*tMin;
  float bMin = max(length(pMin), 1e-4);
  vec3  nMin = pMin/bMin;
  float altM = max(bMin - 1.0, 0.0);
  // Slant: 1/cos toward the vertical, capped at the grazing value. That cap
  // is the whole of the Chapman function that matters here, without the erfc.
  float slantM = min(1.0/max(abs(dot(rd, nMin)), 1e-3), sqrt(0.5*PI*bMin/hmR));
  /* A ray that misses the ground crosses the layer twice; one stopped by the
     ground or by the camera crosses it once. The two agree in the limit — a
     grazing ray is exactly the two halves of a tangent chord — so the disc
     edge stays continuous instead of stepping by a factor of two. */
  float twoSided = 1.0 + step(t0 + 1e-5, tMin)*step(tMin, t1 - 1e-5);
  float colM = hmR*slantM*exp(-altM/hmR)*twoSided;

  /* The sun's path out of the layer. The Rayleigh part of it is what reddens
     the bottom of the arc while the top stays blue-white, which is the whole
     colour signature of the thing — and the same reason the ring is orange at
     the terminator and white where it is high and thin. */
  float czc = max(dot(nMin, uSunObj), 0.02);
  vec3 tauSun = betaRO*(hrR*min(1.0/czc, sqrt(0.5*PI*bMin/hrR))*exp(-altM/hrR))
              + vec3(betaMs*1.1)*(hmR*min(1.0/czc, sqrt(0.5*PI*bMin/hmR))*exp(-altM/hmR));
  // and whether the star can see it at all — the same narrow penumbra the
  // march uses, opened a little so the arc dies into a twilight band rather
  // than a cut line.
  //
  // Plus a tail *into* the umbra. Past the terminator a real limb does not
  // stop: light that has scattered twice, and light refracted round the limb,
  // carry the arc on as a dim band for another twenty or thirty degrees, and
  // that band is half of what a crescent looks like from orbit. Single
  // scattering cannot produce it — nothing in the umbra sees the star at all —
  // so it is a floor on the shadow term, decaying over about one shell height
  // of clearance below the terminator plane.
  float aAlong = dot(pMin, uSunObj);
  float aPerp  = length(pMin - uSunObj*aAlong);
  float aShadow = (aAlong > 0.0) ? 1.0
                : max(smoothstep(0.9880, 1.0300, aPerp),
                      0.085*exp(-max(1.0 - aPerp, 0.0)*26.0));
  // Whichever side of the layer we are looking through, the Rayleigh in front
  // of it is what remains of odR: half of it for a grazing chord, all of it
  // for a ray that ends on the ground. Those are equal at the silhouette.
  float frontFrac = (twoSided > 1.5) ? 0.5 : 1.0;

  float tauMe = betaMs*1.1*colM;              // extinction; scattering is 1/1.1 of it

  /* How near this ray is to grazing, as a fraction of the deepest path the
     layer can offer. 0 looking straight down at it, 1 along the limb — and it
     reaches 1 for *every* ray that misses the ground, because a ray that
     misses is tangent to some shell and crosses that shell edge-on by
     definition. So this is exactly the "on the disc / on the limb" split, and
     it is continuous across the silhouette rather than a step.               */
  float chapM = sqrt(0.5*PI*bMin/hmR);
  float graze = clamp(slantM/chapM, 0.0, 1.0);

  /* Two gains, and the difference between them is the whole of the arc.
     Single scattering is the wrong model for a layer this thick along a
     grazing ray: tau runs past one, so photons scatter several times before
     they leave and the emergent radiance climbs toward the source function,
     while the same layer viewed from above stays firmly single-scatter and
     nearly clear. One gain for both cases has to pick between a limb that
     reads and a disc that is not fogged — which is the trap the last pass
     fell into from the other side, running a single gain of five and washing
     tan haze over the whole crescent. Splitting them buys both: the wash is
     down by a factor of three and the arc is up by a factor of two. */
  float gain = mix(1.5, 8.0, graze*graze);

  /* Emergent radiance of a *mixture*, not of a layer sitting behind a filter.
     The aerosol and the air occupy the same column, so attenuating all of the
     aerosol's light by all of the Rayleigh in front of it is the worst case
     rather than the average — it is what turned the arc brown. The standard
     single-scattering solution for a homogeneous mixture divides the emission
     between the two species by their share of the extinction and saturates
     together, which keeps the blue alive: at the limb this is four times as
     much blue and a third more red, so the arc comes out white with a warm
     underside instead of uniformly orange.                                  */
  vec3 tauFront = betaRO*odR*frontFrac;
  vec3 tauMix   = tauFront + vec3(tauMe);
  vec3 slab     = (vec3(tauMe)/max(tauMix, 1e-4)) * (1.0 - exp(-tauMix));

  vec3 arc = uSunColor*uIntensity*gain*phaseM*0.909*slab*exp(-tauSun)*aShadow;

  vec3 inscatter = sumR*uBetaR*phaseR*uSunColor*uIntensity + arc;

  vec3 tauV = betaRO*odR + vec3(tauMe);
  vec3 transV = exp(-tauV);
  float alpha = clamp(1.0 - dot(transV, vec3(0.3333)), 0.0, 1.0);

  gl_FragColor = vec4(max(inscatter, 0.0), alpha);
}
`;

/* ------------------------------------------------------------ GAS GIANT */

export const GAS_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
${LIGHTING}
${RING_COMMON}

varying vec3 vObj;
varying vec3 vWNorm;
varying vec3 vWPos;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uCamPos;
uniform float uTime;
uniform float uSeed;
uniform vec3  uC0, uC1, uC2, uC3;
uniform vec3  uAmbient;
uniform float uStorm;
uniform float uBands;
uniform float uDetail;        // 0 far .. 1 close
uniform mat3  uObjFromWorld;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingOpacity;
uniform samplerCube uEnv;

vec3 spinY(vec3 v, float a){
  float s = sin(a), c = cos(a);
  return vec3(c*v.x + s*v.z, v.y, -s*v.x + c*v.z);
}

void main(){
  ${LOGD_F}
  vec3 d = normalize(vObj);

  // ---- differential rotation -----------------------------------------
  // Every latitude runs at its own rate. This single detail is what makes a
  // gas giant look alive rather than like a painted marble.
  float lat = d.y;
  float jetRate = 0.020 + 0.030*cos(lat*PI*2.0) - 0.012*lat*lat;
  vec3 p = spinY(d, uTime*jetRate + uSeed);

  /* ---- advected band flow ----------------------------------------------

     The band coordinate is not latitude. It is latitude *pushed around by the
     wind*, and that distinction is the whole difference between a photograph
     of Jupiter and a picture of a striped ball. sin(latitude) with a little
     wobble on it gives what this shader used to give: perfectly parallel
     stripes running the full circumference with no pinch, no tear and no
     differential shear anywhere.

     Three scales of displacement, all sampled in a frame squashed 7.5x in
     latitude so every eddy comes out stretched along the flow the way a real
     one is: the long synoptic undulation, the festoons that hang off a belt
     edge, and the fine curl inside it. The last two are gated on the edge
     term, which peaks where the zonal wind reverses — shear is at the interface
     between two jets, not evenly across the disc.                          */
  vec3 zs = vec3(p.x, p.y*7.5, p.z);
  /* Band *spacing* varies as well as band shape. A fixed period gives equal
     stripes all the way from pole to pole, which is the other half of the
     beach ball; on a real giant the belts crowd together at some latitudes
     and open right out at others. This warp is a function of latitude alone,
     so the bands stay strictly zonal while their widths stop matching. */
  float latW = lat + 0.20*fbm(vec3(uSeed*3.0, lat*2.4, 7.0), 3);
  float phase0 = latW*uBands*PI;
  float edge = 1.0 - abs(sin(phase0));            // 1 on a belt/zone boundary

  float w1 = fbm(zs*1.10 + uSeed*2.0, 4);
  float w2 = fbm(zs*3.20 + uSeed*5.0, 4);
  float w3 = fbm(zs*8.60 + uSeed*8.0, 3);
  float phaseA = phase0 + w1*1.55 + (w2*0.70 + w3*0.30)*(0.35 + edge);

  /* Each belt draws its own width, its own darkness and its own edge
     sharpness. Alternating two tones at a fixed period is the other half of
     why the old disc read as a beach ball; on a real giant no two belts are
     the same shade and several are barely there at all. */
  float bid  = floor(phaseA/PI);
  float jit  = hash11(bid*1.73 + uSeed*3.0);
  float jit2 = hash11(bid*3.11 + uSeed*5.0 + 11.0);

  float bandRaw = sin(phaseA)*0.5 + 0.5;
  float soft = mix(0.30, 0.06, jit2);             // some interfaces are sharp
  float band = smoothstep(soft, 1.0 - soft, bandRaw);
  /* Where two jets shear past one another — and it has to be measured on the
     raw sinusoid rather than on the band after its smoothstep. That smoothstep
     is exactly what makes a belt edge *sharp*: with soft down at 0.06 its
     output is 0 or 1 over all but a percent or two of the disc, so anything
     derived from it is zero nearly everywhere. Everything gated on it — the
     festoons, the billow train at the boundary, every oval on the planet —
     was therefore being multiplied by nothing. All of that machinery was in
     the shader and none of it was ever on screen, which is precisely the
     review: "no vortices, no white ovals, no festoons, no turbulence at band
     boundaries". */
  float iface = 1.0 - abs(bandRaw*2.0 - 1.0);     // 1 at the interface, 0 mid-band

  // ---- texture inside the bands ---------------------------------------
  /* Squashing the sampling frame eleven times in latitude does draw the
     texture out along the flow, but past about five it stops reading as cloud
     stretched by a jet and starts reading as wood grain: every filament runs
     the full width of the disc, dead straight, with no curl anywhere in it.
     Real belt texture is turbulent — it hooks, folds back and tears. So the
     squash comes down and the displacement fields the bands already use are
     spent on curling it instead. They cost nothing; they are computed above.
     The offsets are deliberately a fraction of a feature wavelength: a full
     wavelength of warp is not turbulence, it is scrambling, and it takes the
     zonal alignment with it. */
  vec3 zf = vec3(p.x, p.y*5.0, p.z)*(5.4 + jit*2.6)
          + vec3(w2*0.55, w3*0.20, w2*0.40 - w3*0.30) + uSeed*3.0;
  float fil  = turbulence(zf, 4, 2.15, 0.55);
  vec3 zh = vec3(p.x, p.y*5.4, p.z)*(4.6 + jit2*3.4)
          + vec3(w3*0.62, w2*0.18, w3*0.30) + uSeed*4.0;
  float hook = ridged(zh, 3);

  /* ---- curl inside the band ---------------------------------------------
     Everything above that could break a filament — the festoons, the billow
     train, the ovals — is gated on the interface, so it only ever fires at a band
     *boundary*. That left every belt and zone interior with nothing in it but
     one field squashed five times in latitude, which is a comb: long parallel
     filaments running the full width of the disc in one direction, one hue,
     value-only variation. Juno's belt interiors are as turbulent as its edges
     — dozens of eddies, folds and tears at every scale — so this is
     deliberately *not* gated on the interface, and it is sampled at a squash
     of two rather than five so it comes out rounded rather than drawn out.
     One extra turbulence tap, at three octaves; the whole point is that it
     runs at every distance, so it cannot go in the close-range block. */
  vec3 zc = vec3(p.x, p.y*2.1, p.z)*(7.2 + jit*3.4)
          + vec3(w1*0.62, w2*0.26, w2*0.50 - w1*0.34) + uSeed*29.0;
  float curl = turbulence(zc, 3, 2.12, 0.56);

  // ---- colour ----------------------------------------------------------
  vec3 belt = mix(uC0, uC1, smoothstep(0.10, 0.62, fil));
  vec3 zone = mix(uC2, uC3, smoothstep(0.28, 0.82, fil));
  /* Hue as well as value. Both tones were driven by fil alone, so every
     filament in a band came out the same colour at a different brightness,
     which is the other half of the wood-grain reading — a photograph of a
     belt runs cream to rust to blue-grey *across its own width*. This costs
     nothing: w1 and w2 are the band displacement fields, already computed
     above, and keying the hue to them is physical anyway — a jet that has
     pushed a band north has brought different material up with it. */
  float hueF = clamp(w1*0.60 + w2*0.40, -1.0, 1.0)*0.5 + 0.5;
  belt = mix(belt, mix(belt, uC2, 0.40), smoothstep(0.52, 0.88, hueF));
  belt = mix(belt, mix(belt, uC0, 0.42), smoothstep(0.48, 0.14, hueF));
  zone = mix(zone, mix(zone, uC1, 0.36), smoothstep(0.46, 0.12, hueF));
  zone = mix(zone, mix(zone, uC3, 0.30), smoothstep(0.58, 0.90, hueF));
  // a belt that draws a low jitter is a faint one, barely darker than the zone
  belt = mix(zone*0.72, belt, 0.34 + jit*0.66);
  vec3 col = mix(belt, zone, band);

  /* The interior itself: a dark eddy field with a bright crest on the folds,
     both weighted toward mid-band rather than away from it, so the texture is
     continuous across an interface instead of stopping dead at one. */
  float curlM = 0.44 + 0.56*(1.0 - iface);
  col = mix(col, mix(col, uC1, 0.62), smoothstep(0.40, 0.84, curl)*curlM*0.58);
  col = mix(col, mix(col, uC3, 0.62), smoothstep(0.72, 0.96, curl)*curlM*0.52);

  // Festoons: where a westward jet rubs against an eastward one the interface
  // tears into hooks and plumes that reach across into the neighbouring band.
  // Floored rather than gated: the plumes are strongest at the shear line but
  // torn cloud does not stop existing a degree of latitude away from it.
  col = mix(col, mix(col, uC3, 0.85),
            (0.22 + 0.78*pow(iface, 1.5))*smoothstep(0.30, 0.84, hook)*0.85);

  /* Roll vortices along the interface itself. Where two jets shear past one
     another the boundary does not stay a line — it curls into a regular train
     of billows, each one wrapping cloud out of one band into the other. That
     train is the most recognisable structure in any close photograph of a belt
     edge, and it is the one thing a band function of latitude alone can never
     produce, however much noise is thrown at it: the frequency has to run
     *along* the interface, which means a field squashed hard in latitude and
     gated on the interface rather than on the band. */
  float roll = ridged(vec3(p.x, p.y*20.0, p.z)*(8.5 + jit*4.0)
                    + vec3(w3*0.70, 0.0, w2*0.50) + uSeed*6.0, 2);
  /* pow(iface, 2.4) is essentially zero over all but a few percent of the
     disc, which put the whole billow train on a line and left the interiors
     laminar. Floored at a fifth: the train is unmistakably strongest at the
     shear line and there is still cloud being wound over between them. */
  float rollM = (0.20 + 0.80*pow(iface, 2.4))*smoothstep(0.44, 0.88, roll);
  col = mix(col, mix(col, uC0, 0.65), rollM*0.80);
  // and the bright crest each billow throws up on its leading edge, which is
  // what makes the train read as a row of curls rather than as dark mottle
  col = mix(col, uC3, rollM*smoothstep(0.72, 0.95, roll)*0.45);

  /* ---- ovals ------------------------------------------------------------
     Long-lived anticyclones sit *in* the shear between a belt and a zone, so
     they are placed on the interface rather than sprinkled over the disc, and
     they come out wider than they are tall because the jets stretch them. The
     interior is a set of concentric rings sheared tangentially — F1 gives the
     radius from the vortex centre and F2 varies around it, so the two together
     spiral without needing the centre's position or an atan.

     Some of them are white and most are dark, and that is not decoration: a
     white oval is a cold anticyclone whose tops have punched up *through* the
     haze, a dark one a warm hollow you are seeing down into. A disc of
     identically tinted lozenges reads as a texture. Three bright ovals against
     a dozen dark ones reads as weather.                                    */
  vec3 op = vec3(p.x, p.y*5.2, p.z)*(2.4 + jit*1.8) + vec3(w2*0.30, 0.0, w1*0.30) + uSeed*7.0;
  vec2 cw = cellular(op, 0.92);
  float ovGate = smoothstep(0.38, 0.74, fbm(op*0.42 + 31.0, 3)*0.5 + 0.5);
  float oval = smoothstep(0.44, 0.12, cw.x) * ovGate * smoothstep(0.06, 0.46, iface);
  if(oval > 0.002){
    float ovIn = ridged(vec3(cw.x*22.0 + cw.y*9.0, cw.y*13.0, uSeed*2.0), 3);
    // varies slowly against the cell size, so it is near enough constant
    // across any one oval — which is what makes a whole oval white, rather
    // than the white half of every oval
    float ovKind = smoothstep(0.50, 0.60, fbm(op*0.30 + 77.0, 2)*0.5 + 0.5);
    vec3 ovCol = mix(mix(mix(uC1, uC3, 0.72), uC0, ovIn*0.55),
                     mix(uC3, uC2, ovIn*0.30)*1.42, ovKind);
    col = mix(col, ovCol, oval*(0.72 + ovIn*0.28));
    // a bright collar where the vortex shoulders the jet aside
    col = mix(col, uC3, smoothstep(0.30, 0.46, cw.x)*smoothstep(0.60, 0.44, cw.x)*ovGate*0.70);
  }

  /* ---- the great spot ---------------------------------------------------
     One storm, placed rather than scattered, and far larger than anything
     else on the disc — because what makes Jupiter recognisable in every
     photograph ever taken of it is a single anticyclone you could drop the
     Earth into. A field of equal-sized eddies has no landmark in it and gives
     the disc no scale; one enormous oval with a torn wake streaming away
     downstream gives it both. It sits in a jet interface like the small ovals
     do, and it is sampled in a frame turning at *its own* latitude's rate, so
     the differential rotation that drives everything else slides past it
     instead of smearing it into a band over the first few minutes.         */
  if(uStorm > 0.02){
    float sy = (0.19 + 0.25*hash11(uSeed*5.7 + 3.0))*(hash11(uSeed*2.1) < 0.5 ? -1.0 : 1.0);
    float sLon = hash11(uSeed*9.3 + 7.0)*TAU;
    float cl = sqrt(max(1.0 - sy*sy, 0.0));
    vec3 sc = vec3(cl*cos(sLon), sy, cl*sin(sLon));
    vec3 ps = spinY(d, uTime*(0.020 + 0.030*cos(sy*PI*2.0) - 0.012*sy*sy) + uSeed);
    // measured in the same latitude-squashed frame the bands live in, so the
    // storm comes out three times wider than it is tall, as they all are
    vec3 sq = vec3(ps.x - sc.x, (ps.y - sc.y)*3.1, ps.z - sc.z);
    float sr = length(sq)/(0.20 + 0.20*uStorm);
    float sm = smoothstep(1.02, 0.52, sr);
    if(sm > 0.002 || sr < 2.6){
      float swirl = ridged(vec3(sr*6.5, sq.x*9.0 + uSeed, sq.z*9.0), 3);
      vec3 stormCol = mix(uC1, uC2, 0.28)*vec3(1.70, 0.62, 0.36);
      stormCol = mix(stormCol, uC3, swirl*0.26);
      col = mix(col, stormCol, sm*(0.80 + swirl*0.20));
      // the collar of clean gas it shoulders up around itself
      col = mix(col, uC3, smoothstep(1.34, 1.04, sr)*smoothstep(0.86, 1.04, sr)*0.80);
      // and the wake, torn cloud streaming away downstream
      float wake = smoothstep(2.6, 1.05, sr)*smoothstep(0.92, 1.35, sr)
                 * smoothstep(0.34, 0.86, turbulence(sq*7.0 + uSeed*2.0, 3, 2.1, 0.55));
      col = mix(col, mix(col, uC3, 0.72), wake*0.48);
    }
  }

  // polar hoods are darker and hazier
  col = mix(col, mix(col, uC0, 0.55), smoothstep(0.62, 0.96, abs(lat)));
  col *= 0.88 + fil*0.26;

  /* Sub-band detail, and only once the world is big enough in frame to resolve
     it. The band texture bottoms out around a thirtieth of a radius, which at
     a radius and a half away is thirty pixels across — so a close pass over a
     giant is smooth paint however good the large structure is. Three more
     octaves, faded in with angular size, put cloud back at the pixel; at any
     distance where they would alias they are not evaluated at all. */
  if(uDetail > 0.002){
    /* And at close range it has to be *structure*, not another octave.
       Everything above is sampled in a frame squashed four to seven times in
       latitude, which is right for the synoptic scale and completely wrong at
       a fifth of a radius: from there the squash is the only thing you can
       see and the disc reads as brushed wood grain — which is exactly the
       "1-D-smeared fBm" note, and it is at its worst on a close pass. Real
       cloud at this scale is billowed, convective cells a few hundred
       kilometres across only mildly drawn out by the jet, so the fine set
       runs at a squash of two rather than four. */
    vec3 zd = vec3(p.x, p.y*2.0, p.z)*(26.0 + jit*12.0)
            + vec3(w3*0.45, 0.0, w2*0.35) + uSeed*13.0;
    float fine = 1.0 - turbulence(zd, 3, 2.15, 0.55);
    col *= 1.0 + (fine - 0.50)*0.52*uDetail;

    /* Eddies, placed rather than smeared. The shear between two jets curls
       into a train of vortices all the way down to the resolution limit, and a
       vortex is the one shape a field stretched along a line can never
       produce however many octaves it is given. One cellular buys the whole
       train: the near field is the core, the shoulder is the bright collar it
       shoulders up around itself, and a ridged function of the cell distance
       spirals the interior. Gated on the jet interface, because that is where
       shear is, and on uDetail, so a giant at any distance where these would
       alias never evaluates them. */
    vec3 ep = vec3(p.x, p.y*3.0, p.z)*(19.0 + jit2*9.0)
            + vec3(w2*0.35, 0.0, w3*0.30) + uSeed*21.0;
    vec2 ec = cellular(ep, 0.95);
    /* Both the gate and the spiral are built out of things already computed.
       That is not tidiness: this block is the only part of the shader that
       runs exactly when a giant fills the frame, which is the most expensive
       moment in the game, and a fresh fbm here measured at about a millisecond
       and a half. The gate rides the band displacement fields, which vary at
       very nearly the right scale because they are what tore the belt edge in
       the first place. The spiral comes out of the two distances cellular has
       already returned — F2 - F1 falls to zero at the cell wall, so a sinusoid
       in it winds round the centre with no atan and no second noise tap. */
    /* A cellular field puts exactly one vortex in every cell at exactly one
       size, and once the detail ramp reaches full strength that regularity is
       the thing you see: a lattice of identically sized rings, which reads as
       bubble wrap rather than as weather. Three cheap corrections, all built
       from numbers already in hand. The population is thinned by the interior
       curl field, so eddies come in clusters where the shear is instead of
       carpeting the disc. The radius rides F2 - F1, which is large at the
       centre of a large cell and small in a crowded one, so the sizes spread.
       And the bright collar is broken up by the spiral phase, so it is an arc
       shouldered up on one flank rather than a closed circle round every core. */
    float ePop  = smoothstep(0.22, 0.66, curl);
    float eGate = smoothstep(-0.30, 0.28, w2 + w3*0.55)
                * (0.66 + 0.34*iface) * uDetail * ePop;
    float eSpin = sin(ec.x*15.0 + (ec.y - ec.x)*11.0 + uSeed*3.0 + w3*2.0)*0.5 + 0.5;
    float eRad  = 0.24 + 0.44*clamp((ec.y - ec.x)*1.6, 0.0, 1.0);
    float eddy  = smoothstep(eRad, eRad*0.26, ec.x) * eGate;
    col = mix(col, mix(col, uC0, 0.55 + eSpin*0.30), eddy*0.60);
    col = mix(col, uC3, smoothstep(eRad*0.78, eRad*1.10, ec.x)
                      * smoothstep(eRad*1.50, eRad*1.10, ec.x)
                      * eGate*(0.22 + 0.78*eSpin)*0.50);

    // wisps torn off the interfaces, where the shear actually is
    col = mix(col, mix(col, uC3, 0.60), pow(iface, 1.8)*smoothstep(0.52, 0.90, fine)*0.45*uDetail);
  }

  // ---- lighting ---------------------------------------------------------
  // The sphere's own normal, taken per fragment from the object-space
  // direction rather than from the interpolated vertex normal. Anything raised
  // to a high power against an interpolated normal shows the icosahedron
  // underneath it, which is where the stepping in the limb halo came from.
  vec3 N = normalize(d * uObjFromWorld);
  vec3 L = normalize(uSunDir);
  vec3 V = normalize(uCamPos - vWPos);
  float NoL = dot(N, L);
  float NoV = max(dot(N, V), 1e-3);

  /* Limb darkening. A gas giant is a *dome*, not a disc, and the reason the
     old one read as a circle cut out of marbled paper is that its only falloff
     was pow(1-NoV, 1.9) — which is still 0.94 of full brightness halfway to
     the limb and then collapses in the last few percent. Carrying the view
     cosine on the radiance the way a Minnaert surface does puts the gradient
     back where the eye reads curvature from, across the whole disc. */
  float limb = pow(NoV, 0.62) * mix(1.0, smoothstep(0.0, 0.17, NoV), 0.55);

  /* Terminator. Two lobes: the direct one, which dies at the geometric line,
     and a much softer and redder one for light that has scattered several
     times through the upper haze before it leaves. A deep atmosphere has no
     surface for the light to stop at, so that second term is what makes the
     terminator a gradient tens of degrees wide instead of a paper edge — and
     it is also nearly all of what you see of the night side at crescent
     phase, which is the framing these worlds are usually shot at. */
  float direct = smoothstep(-0.03, 0.62, NoL);
  float multi  = smoothstep(-0.40, 0.42, NoL);

  // The rings throw hard-edged bands across the cloud tops; they are one of
  // the few things in frame that prove the ring is a solid object and not a
  // painted halo. Shares its radial structure with the ring shader itself, so
  // the shadow gaps land exactly on the ring gaps.
  // world -> object is matrix-times-vector. The other order is its transpose,
  // and on a world tilted far enough to show its rings at all that error is tens of degrees — the
  // shadow bands were being thrown at a hemisphere nobody was looking at.
  vec3 lObj = normalize(uObjFromWorld * L);
  float rs = ringShadow(d, lObj, uRingInner, uRingOuter, uRingOpacity, uSeed*1.7);

  vec3 haze = mix(uC3, vec3(0.75, 0.85, 1.0), 0.45);
  // multi-scattered light has been through more air, so it arrives warmer and
  // washed toward the haze colour rather than the band colour
  vec3 msCol = mix(col, haze*0.55, 0.45) * vec3(1.12, 0.92, 0.80);

  vec3 outc  = col   * uSunColor * direct * rs * limb * 2.9;
  outc      += msCol * uSunColor * multi  * mix(1.0, rs, 0.75) * limb * 0.46;
  outc += col * uAmbient * 2.0;
  outc += col * textureCube(uEnv, N).rgb * 0.18;

  // ---- limb haze --------------------------------------------------------
  // Forward-scattered light in the upper atmosphere. One term, not two: the
  // old pow(rim, 14.0) spike put a hard bright ring exactly on the silhouette,
  // which is the halo with visible stepping in it. The soft halo outside the
  // disc is the atmosphere shell's job, and it already draws one.
  float rim = 1.0 - NoV;
  outc += uSunColor * haze * pow(rim, 3.0) * smoothstep(-0.22, 0.45, NoL)
        * mix(0.55, 1.0, rs) * 1.15;

  gl_FragColor = vec4(outc, 1.0);
}
`;

/* ---------------------------------------------------------------- RINGS */

export const RING_VERT = /* glsl */`${LOGD_V_PARS}

varying vec3 vObj;
varying vec3 vWPos;
void main(){
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGD_V}
}
`;

export const RING_FRAG = /* glsl */`
precision highp float;
${LOGD_F_PARS}
${NOISE}
${RING_COMMON}

varying vec3 vObj;
varying vec3 vWPos;

uniform vec3  uSunObj;      // object space, toward star
uniform vec3  uSunColor;
uniform vec3  uCamObj;
uniform float uInner;
uniform float uOuter;
uniform float uSeed;
uniform vec3  uColA;
uniform vec3  uColB;
uniform float uOpacity;
uniform vec3  uAmbient;
uniform float uAtmoR;       // 1.0 when the planet has no air

void main(){
  ${LOGD_F}
  float r = length(vObj.xz);
  float u = (r - uInner)/(uOuter - uInner);

  float band, fine;
  float dens = ringDens(u, uSeed, band, fine);
  // A transparent premultiplied fragment rather than discard: discard together
  // with a written gl_FragDepth mis-compiles under ANGLE/Metal.
  if(u < 0.0 || u > 1.0 || dens < 0.004){ gl_FragColor = vec4(0.0); return; }

  vec3 col = mix(uColA, uColB, clamp(fine*1.2 - 0.1, 0.0, 1.0));
  col *= 0.75 + band*0.5;

  // ---- planet shadow --------------------------------------------------
  /* The umbra is a cylinder of the planet's radius cast down the anti-sunward
     axis. The penumbra is wide, because the ring is a couple of radii out, and
     it is *slightly* warm, because the light still reaching it has grazed the
     limb — but only slightly, and this is worth being precise about because
     the obvious way to write it is wrong twice over.

     (1 - shadow)*shadow peaks at 0.25, so any gain on it above about one
     drives the mix to near unity at mid-penumbra: the band is then fully
     tinted rather than gently warmed, and at a gain of 3.4 it came out as a
     saturated rust strap laid across every ring on every giant — the most
     saturated thing in the frame, in a palette that reserves saturation.
     And a tint whose red channel is over 1.0 makes the penumbra *brighter*
     than the ring beside it: a reddening that adds energy, which no amount of
     grazing atmosphere can do. Cassini's version of this is a near-neutral
     dark wedge with a barely warm grey edge. Gain of one, and every channel
     of the tint at or below unity. */
  float dperp = length(vObj - uSunObj*dot(vObj, uSunObj));
  float behind = step(dot(vObj, uSunObj), 0.0);
  float shadow = mix(1.0, smoothstep(0.990, 1.075, dperp), behind);
  vec3 sunLit = uSunColor * mix(vec3(1.0), vec3(1.00, 0.86, 0.70),
                                behind*(1.0 - shadow)*shadow*1.0);

  // ---- scattering -----------------------------------------------------
  vec3 V = normalize(uCamObj - vObj);
  float mu = dot(normalize(-uSunObj), V);
  // ice particles are strongly forward scattering: back-lit rings glow
  float forward = pow(max(mu, 0.0), 2.5);
  float back    = pow(max(-mu, 0.0), 1.5);

  vec3 nrm = vec3(0.0, 1.0, 0.0);
  float lz = dot(uSunObj, nrm);           // sun elevation above the ring plane
  float vz = dot(V, nrm);                 // viewer elevation
  float sameSide = smoothstep(-0.05, 0.05, lz*vz);

  float grazing = abs(vz);
  // Optical depth, not opacity. Mapping density straight through an exponential
  // saturated everything above about half density to solid, which is what made
  // the ring a flat sheet wherever it crossed the planet — all of its banding
  // went to the same white. A power law keeps the mid bands translucent and
  // lets only the true B-ring cores go opaque.
  /* Opacity has to reach the optical depth, not only the final multiply. The
     shadow tap already scales tau by it, so a gauzy ring was throwing a shadow
     far darker than the ring that cast it — and, worse, uOpacity could swing
     from one end of its range to the other and change a mid band by well under
     a stop, which is why every ring system in a survey looked the same weight
     whatever it had drawn. Bounded well above zero: this multiplies a physical
     depth, and a ring with none is not a ring. */
  float tau = (pow(dens, 2.1)*3.1 + dens*0.16) * mix(0.30, 1.20, uOpacity);
  float slant = 1.0/max(grazing, 0.055);
  float alpha = clamp(1.0 - exp(-tau*slant), 0.0, 1.0) * mix(0.35 + uOpacity*0.65, 1.0, dens*dens);

  // Which face you are looking at decides everything. From the sunlit side you
  // see reflection and the dense bands are the bright ones. From the shadowed
  // side you see only what got through, so those same dense bands go *dark* and
  // the thin ones glow — Saturn photographed from behind is a negative of
  // Saturn photographed from in front. Drawing both the same way is what left
  // the rings a featureless wash.
  float sheet = 1.0/max(abs(lz), 0.10);
  vec3 refl  = sunLit * (2.10 + back*2.2);
  vec3 trans = sunLit * (0.42 + forward*4.0) * exp(-tau*sheet*0.85);
  vec3 lum = mix(trans, refl, sameSide) * shadow;

  vec3 outc = col*lum + col*uAmbient*1.6;

  // ---- seen through the planet's air ----------------------------------
  // The far half of the ring emerges from behind the limb through the whole
  // depth of the atmosphere. Without this it pops out at full brightness on
  // the silhouette line and the limb reads as a cut-out with a hard seam
  // running across the ring.
  if(uAtmoR > 1.001){
    vec3 seg = vObj - uCamObj;
    float segLen = length(seg);
    vec3 rd = seg/max(segLen, 1e-5);
    vec2 sh = raySphere(uCamObj, rd, uAtmoR);
    float tin = max(sh.x, 0.0);
    float tout = min(sh.y, segLen);
    if(sh.y > 0.0 && tout > tin){
      float tc = clamp(-dot(uCamObj, rd), tin, tout);
      float per = length(uCamObj + rd*tc);
      float hmin = clamp((per - 1.0)/max(uAtmoR - 1.0, 1e-4), 0.0, 1.0);
      float haze = clamp((tout - tin)*3.0*exp(-hmin*3.2), 0.0, 1.0);
      outc *= mix(vec3(1.0), vec3(0.62, 0.42, 0.30), haze*0.85);
      alpha *= 1.0 - haze*0.55;
    }
  }

  gl_FragColor = vec4(outc*alpha, alpha);
}
`;
