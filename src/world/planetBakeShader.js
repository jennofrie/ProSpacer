import { NOISE } from '../gfx/glsl/noise.js';

/* ============================================================================
   Planet surface baking.

   Evaluating 20+ octaves of simplex per pixel per frame is not survivable on a
   phone, so every solid world is baked once into a cubemap:

        RGB = linear albedo      A = terrain height (0..1)

   A cubemap (rather than equirect) means no pole pinching and no seam, and the
   runtime shader gets surface normals for free from three extra texture taps.
   Close-up detail beyond the baked resolution is re-synthesised at runtime.
   ========================================================================== */

export const PLANET_TYPES = {
  TERRAN: 0,
  DESERT: 1,
  BARREN: 2,
  ICE: 3,
  LAVA: 4,
  OCEAN: 5,
  TOXIC: 6,
  IRON: 7,
};

export const BAKE_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const BAKE_FRAG = /* glsl */`
precision highp float;
${NOISE}

varying vec3 vDir;

uniform float uSeed;
uniform int   uType;
uniform int   uVariant;    // which feature vocabulary this world draws from
uniform float uSea;        // sea level in height units
uniform float uIce;        // polar cap extent 0..1
uniform float uRelief;     // vertical exaggeration of features
uniform float uCraters;    // crater density
uniform float uVeg;        // vegetation coverage (terran)
uniform vec3  uC0;         // abyss / lowest
uniform vec3  uC1;         // lowland
uniform vec3  uC2;         // midland
uniform vec3  uC3;         // highland
uniform vec3  uC4;         // peak / accent
uniform vec3  uCPolar;
uniform vec3  uCWater;
uniform float uDetailFreq;

/* ------------------------------------------------------------- craters

   A *population*, not one identical bowl per cell.

   The shared cellular helper puts exactly one feature in every cell at exactly one size, so
   stacking four octaves of it gives four superimposed regular grids of equal
   craters — which is precisely the golf-ball dimpling the review called
   "crater size distribution is too uniform". Three things are missing from
   that and all three are cheap, because the 27-cell loop is already being
   walked: most ground has nothing on it, the diameters follow a steep power
   law so one crater in fifty is a landmark and the rest are pits, and old
   craters are half-buried while fresh ones have sharp rims. Sizing each
   crater from its own cell hash also lets a big one spill across the cell
   boundary and overlap its neighbours, so they nest and truncate each other
   the way a real cratered surface does. */
float craterField(vec3 p, float scale, float depth, float sd){
  vec3 q = p*scale + sd;
  vec3 ip = floor(q), fp = fract(q);
  // The *nearest crater in units of its own radius*, not the nearest centre.
  // Summing the neighbours instead was tried and is wrong: four octaves of
  // overlapping bowls drove the whole height field to its floor, and a world
  // whose height clamps at zero comes back as a black disc.
  float best = 9.0, bRad = 0.5, bAge = 0.5;
  for(int z=-1;z<=1;z++)
  for(int y=-1;y<=1;y++)
  for(int x=-1;x<=1;x++){
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 gc = ip + o;
    if(hash13(gc + 7.3) < 0.28) continue;          // empty ground
    // Cubed uniform: most small, a few large enough to be a landmark.
    float rad = 0.20 + 0.72*pow(hash13(gc + 19.1), 3.0);
    float dd = length(o + hash33(gc) - fp)/rad;
    if(dd < best){ best = dd; bRad = rad; bAge = hash13(gc + 31.7); }
  }
  if(best > 1.06) return 0.0;
  float bowl = 1.0 - smoothstep(0.0, 0.62, best);
  float rim  = smoothstep(0.62, 0.80, best)*(1.0 - smoothstep(0.80, 1.05, best));
  // Big craters have flat floors and terraced walls; small ones are sharp
  // bowls. That difference is visible from orbit and is half of what says one
  // of these is a basin and the other is a pit.
  //
  // Not named "flat". That is an interpolation qualifier in GLSL ES and it
  // fails the *whole* compile, which here means the bake renders black and
  // every airless world in the system comes back as an unlit disc with a
  // working specular highlight on it — a scene bug, to look at.
  float broad = smoothstep(0.34, 0.78, bRad);
  bowl = mix(bowl, bowl*0.60 + smoothstep(0.50, 0.16, best)*0.28, broad);
  // Old craters are half buried; fresh ones keep their rim. Squared, so most
  // of the population is degraded and a few are crisp.
  return (rim*0.55 - bowl*0.9) * mix(1.0, 0.42, bAge*bAge) * depth;
}

/* ------------------------------------------------------------------- lines

   The zero contour of a fractal is the cheapest connected *line* there is.
   Thresholding |f| gives a band whose width the caller sets, and unlike a
   thresholded ridged multifractal it never breaks into disconnected pieces.
   That distinction is the whole of the ice-shell problem: the old lineae were
   a smoothstep on a ridged field, which selects wherever several octaves
   happened to peak together — scattered, same-sized, comma-shaped blobs, all
   at random orientations, reading as hairs on a scanner rather than as
   fractures. Every crack, canyon, rille, scarp and fissure below is a zero
   contour instead, so it runs, branches, and crosses the others. */
float lineOf(vec3 p, int oct, float w){
  return smoothstep(w, 0.0, abs(fbm(p, oct)));
}

/* A Europan triple band: a narrow trench with raised flanks either side of it,
   and — the part that was missing — a broad diffuse *dark margin* outside
   those, tens of kilometres across.

   That margin is most of what you actually see of a linea from orbit. The
   ridge pair is a few kilometres wide and the stained apron beside it is ten
   times that, which is why real lineae read as broad dark straps with a
   bright thread down the middle rather than as pen strokes of uniform width.
   Giving each family its own margin width is also what puts a *scale* on
   them: without it every fracture on the moon is the same weight, which is
   the "uniform-width scribbled spaghetti" note exactly.
     .x  trench core   .y  raised flank   .z  dark margin                    */
vec3 bandOf(vec3 p, int oct, float w, float mw){
  float f = abs(fbm(p, oct));
  float core   = smoothstep(w*0.50, 0.0, f);
  float flank  = smoothstep(w*1.70, w*0.55, f)*(1.0 - core);
  /* The margin has to *decay*, not threshold. A second smoothstep at a wider
     cutoff looks right until you work out what fraction of a sphere it
     selects: the field is roughly Gaussian, so pushing the cutoff out to
     three or four times the ridge width takes ninety percent of the surface
     with it and the moon comes back a uniform stained blob. A Gaussian in the
     field value is unconditionally well behaved — it is 0.37 of full at one
     margin width and 0.02 at two, whatever the gradient of the field
     underneath happens to be. */
  float t = f/max(mw, 1e-4);
  float margin = exp(-t*t)*(1.0 - core)*(1.0 - flank*0.5);
  return vec3(core, flank, margin);
}

/* One *named* impact basin, with a raised rim and the concentric rings a
   multi-ring impact leaves behind. Placed rather than scattered: a world wants
   a landmark you could point at, not only a uniform sprinkle of craters. */
float basinAt(vec3 d, vec3 c, float r, float depth){
  float a = acos(clamp(dot(d, c), -1.0, 1.0))/max(r, 1e-3);
  if(a > 2.4) return 0.0;
  float bowl  = 1.0 - smoothstep(0.0, 1.05, a);
  float rim   = smoothstep(0.80, 1.02, a)*(1.0 - smoothstep(1.02, 1.42, a));
  float rings = (sin(a*9.0)*0.5 + 0.5)*smoothstep(2.3, 1.05, a)*smoothstep(0.92, 1.30, a);
  return (rim*0.80 + rings*0.26 - bowl)*depth;
}

// ---------------------------------------------------------------- height
/**
 * Three feature channels come back out for the albedo to colour. What they
 * mean depends on the world — the vocabulary is deliberately different for
 * every type, which is the point.
 *
 * @param mask   primary feature   (land / maria / trench / fissure / pan …)
 * @param mtnv   raised relief     (orogeny / ridge flank / dune / shield)
 * @param rivv   network or region (drainage / chaos / canyon / province)
 */
float heightOf(vec3 d, out float mask, out float mtnv, out float rivv){
  vec3 s = vec3(uSeed*13.1, uSeed*7.7, uSeed*3.3);
  vec3 p = d*1.7 + s;
  float h = 0.5;
  mask = 0.0;
  mtnv = 0.0;
  rivv = 0.0;

  if(uType == 0 || uType == 5){                    // TERRAN / OCEAN
    // Continents want to be few and large. A gentle warp at low octave count
    // gives organic coastlines; a heavy warp gives stringy noodles, which is
    // the classic tell of a procedural planet.
    vec3 w = warp3(p*0.50, 0.34, 2);
    float cont = fbm(w*0.62, 8)*0.5 + 0.5;

    // Cratonic bias: a second very low frequency field decides where crust is
    // thick at all, so oceans get genuinely empty stretches.
    float craton = fbm(p*0.30 + 61.0, 3)*0.5 + 0.5;
    cont = mix(cont*0.82, cont, smoothstep(0.30, 0.72, craton));
    cont += (craton - 0.5)*0.20;

    // shelf shaping — flatten abyssal plains and continental interiors, keep
    // the transition between them sharp (that is what makes a coastline read)
    cont = clamp(cont, 0.0, 1.0);
    cont = smoothstep(0.16, 0.86, cont);

    float land = smoothstep(uSea - 0.015, uSea + 0.045, cont);

    // Orogeny. The belts have to be *chains* — long, narrow, arcuate — which
    // means the field that selects them wants to be ridged rather than fbm.
    // An fbm belt mask gives round blobs of high ground, and a continent with
    // round blobs on it reads as noise; a continent with a cordillera down one
    // edge and foothills falling away from it reads as a place.
    // A cordillera is a *line*, and the zero contour of a warped fractal is the
    // cheapest connected line there is: thresholding |f| gives a band whose
    // width is set by the threshold rather than by however many octaves of a
    // ridged multifractal happened to peak together. That predictability is the
    // whole point — the old belt mask was an fbm threshold, which selects round
    // blobs of high ground, and a continent covered in round blobs reads as
    // noise however much relief you put on it.
    float beltF = fbm(w*0.95 + 21.0, 4);
    float belt = smoothstep(0.30, 0.92, 1.0 - abs(beltF)*2.3);
    float mtn = pow(max(ridged(w*2.6 + 4.0, 6), 0.0), 1.7);
    float hills = pow(max(ridged(w*7.2 + 13.0, 4), 0.0), 2.2);
    // Amplitude up by a quarter: at the old height a cordillera and the plain
    // beside it shaded the same, and a continent with no relief in it is the
    // flat brown paint blob the whole complaint was about.
    float orog = (mtn*0.58 + hills*0.19)*land*belt*uRelief;
    h = cont + orog;
    mtnv = clamp(mtn*belt*land*2.2, 0.0, 1.0);

    /* Rifts and plateaus — the two things that stop a continental interior
       being a wash. A continent with only mountains along one edge is a
       heightmap; one with a rift valley running down it and tablelands
       standing above the plain is a plate with a history. The plateau
       threshold is deliberately tight, so its edge is an escarpment rather
       than a gradient, and that hard edge is what catches raking light. */
    float rift = lineOf(w*1.30 + 205.0, 2, 0.062)*land*(1.0 - belt*0.55);
    float plat = smoothstep(0.503, 0.548, fbm(w*1.5 + 311.0, 5)*0.5 + 0.5)*land;
    h += plat*0.060*uRelief - rift*0.055*uRelief;

    // Drainage, the same way. Rivers are the one feature that says water has
    // been moving downhill here for a long time, and a continent without them
    // is a heightmap rather than a place. Trunks are wide and deep, the
    // tributary net around them is shallower.
    float rn = fbm(w*4.4 + 61.0, 5);
    float trunk  = smoothstep(0.90, 1.0, 1.0 - abs(rn)*3.6);
    float rn2 = fbm(w*11.0 + 133.0, 4);
    float tribs  = smoothstep(0.92, 1.0, 1.0 - abs(rn2)*4.4);
    float valley = smoothstep(0.42, 1.0, 1.0 - abs(rn)*1.5);
    float net = clamp(trunk + tribs*0.65, 0.0, 1.0);
    h -= land*(net*0.045 + valley*0.030)*uRelief;
    // Only where there is somewhere to run *to*: no rivers on the abyssal
    // plain, none on the very top of a range.
    rivv = clamp(net*land*smoothstep(uSea, uSea + 0.06, cont)*(1.0 - mtnv*0.6), 0.0, 1.0);
    mask = clamp(rift + plat*0.45, 0.0, 1.0);

  } else if(uType == 1){                            // DESERT
    /* Three landforms, and which one owns the world is the variant: an erg of
       transverse dunes, canyon-land cut by a connected drainage network that
       has not seen water in an age, and mesa country where a caprock has kept
       tablelands standing while everything around them eroded away. */
    float wErg  = uVariant == 0 ? 1.55 : (uVariant == 1 ? 0.40 : 0.85);
    float wCan  = uVariant == 1 ? 1.60 : (uVariant == 2 ? 0.60 : 0.90);
    float wMesa = uVariant == 2 ? 1.70 : (uVariant == 0 ? 0.45 : 0.85);

    vec3 w = warp3(p*0.85, 0.20, 2);
    h = (fbm(w*1.25, 6)*0.5 + 0.5)*0.82;

    // Erg. The dunes are transverse to a wind that turns slowly across the
    // world, so the crest lines curve instead of ruling the globe.
    float wind = fbm(p*0.55 + 7.0, 2)*2.6;
    vec3 wd = vec3(cos(wind), 0.22, sin(wind));
    float ergR = smoothstep(0.44, 0.70, fbm(p*0.9 + 55.0, 3)*0.5 + 0.5);
    float dune = pow(sin(dot(w*13.0, wd) + fbm(w*3.0, 3)*8.0)*0.5 + 0.5, 2.2)*ergR*wErg;
    h += dune*0.055*uRelief;

    // Mesas. A caprock either is or is not there, so the edge is a cliff.
    float mesa = smoothstep(0.540, 0.566, fbm(w*2.2 + 12.0, 5)*0.5 + 0.5)*wMesa;
    h += mesa*0.15*uRelief;

    // Canyons. Connected and branching, deepest along the trunk.
    float canR  = smoothstep(0.42, 0.72, fbm(p*0.75 + 173.0, 2)*0.5 + 0.5);
    float cTap  = 0.40 + 1.10*(fbm(p*2.3 + 233.0, 2)*0.5 + 0.5);
    float trunk = lineOf(w*1.55 + 88.0, 2, 0.048*cTap)*canR;
    float tribs = lineOf(w*4.20 + 141.0, 3, 0.026*cTap)*canR;
    float net = clamp((trunk + tribs*0.70)*wCan, 0.0, 1.0);
    h -= net*(0.15 + trunk*0.11)*uRelief;

    mask = clamp(mesa, 0.0, 1.0);
    mtnv = clamp(dune, 0.0, 1.0);
    rivv = net;

  } else if(uType == 2){                            // BARREN
    float wCra = uVariant == 0 ? 1.35 : (uVariant == 1 ? 0.75 : 1.0);
    float wMar = uVariant == 1 ? 1.50 : (uVariant == 2 ? 0.55 : 0.9);

    float base = fbm(p*1.5, 6)*0.5 + 0.5;
    // maria: big smooth low basins
    float maria = clamp(smoothstep(0.52, 0.70, fbm(p*0.75 + 31.0, 4)*0.5+0.5)*wMar, 0.0, 1.0);
    h = mix(base, base*0.35 + 0.30, maria);
    h += craterField(p, 2.2,  0.16*uCraters*wCra, uSeed*2.0);
    h += craterField(p, 5.7,  0.075*uCraters*wCra, uSeed*5.0);
    h += craterField(p, 14.0, 0.035*uCraters, uSeed*9.0);
    h += craterField(p, 33.0, 0.016*uCraters, uSeed*15.0);
    h += (fbm(p*22.0, 4))*0.02;

    // The landmark, and the graben that opened around it as the basin sagged.
    vec3 bc = normalize(vec3(sin(uSeed*2.3), sin(uSeed*5.1)*0.62, cos(uSeed*1.9)));
    h += basinAt(d, bc, 0.52 + float(uVariant)*0.16, 0.13*uCraters);
    float rille = lineOf(vec3(p.x, p.y*0.7, p.z)*2.2 + 53.0, 2, 0.058)
                * smoothstep(0.42, 0.72, fbm(p*0.8 + 197.0, 2)*0.5 + 0.5)
                * (uVariant == 2 ? 1.7 : 0.8);
    h -= rille*0.038*uRelief;

    mask = maria;
    rivv = clamp(rille, 0.0, 1.0);

  } else if(uType == 7){                            // IRON
    /* The stripped core of something larger. There is no regolith to speak of,
       so the structure is the metal itself: long lobate scarps thrown up where
       the body contracted as it froze, exposed ridges of nickel-iron, and
       smooth ponds of slag lying in the low ground. It shared the barren
       branch until now, which is exactly how two worlds in one system end up
       being the same asset with a hue shift. */
    float base = fbm(p*2.1, 6)*0.5 + 0.5;
    float pond = smoothstep(0.44, 0.62, fbm(p*0.95 + 29.0, 4)*0.5 + 0.5);
    h = mix(base*0.90 + 0.05, 0.30, pond);

    float ridgeM = pow(max(ridged(vec3(p.x, p.y*0.72, p.z)*3.0 + 5.0, 5), 0.0), 1.6)
                 * (uVariant == 0 ? 1.35 : 0.85);
    h += ridgeM*0.22*uRelief*(1.0 - pond);

    // Contraction scarps: one-sided cliffs, so they *rise* rather than carve.
    float scarp = lineOf(vec3(p.z*0.5, p.y, p.x)*1.7 + 77.0, 2, 0.046)
                * (uVariant == 2 ? 1.6 : 0.9);
    h += scarp*0.055*uRelief;

    h += craterField(p, 4.5, 0.050*uCraters, uSeed*2.0);
    h += craterField(p, 16.0, 0.022*uCraters, uSeed*6.0);

    mask = pond;
    mtnv = clamp(ridgeM, 0.0, 1.0);
    rivv = clamp(scarp, 0.0, 1.0);

  } else if(uType == 3){                            // ICE
    /* An ice shell is not noise. It is a bright, nearly featureless plain
       broken by *lines* — fracture systems that run for thousands of
       kilometres, cross one another at an angle and carry a raised double
       ridge along their length — plus, where the shell has foundered, chaos
       terrain: rafts of crust that have rotated out of alignment with
       everything around them. The vocabulary here is lines and blocks. There
       is nothing in it that should read as a smear. */
    /* Variant 0 used to run wLin at 1.15, and that one number produced both
       halves of the "cracked marble" reading. The trench is clamped after
       being multiplied by this, so at 1.15 the line core pins to 1.0 and 58%
       of the stained area comes out at flat maximum — which throws away the
       per-family width taper below and leaves every fracture the same width,
       at the darkest value the stain can reach. Under 0.85 the taper survives
       and the widths spread again.

       wCra matters as much and was easier to miss: craters are what fills the
       plain *between* the lines, and at 0.80 against variant 2's 2.60 the
       broad-line variant also had the emptiest plain, so there was nothing to
       look at except the veins. */
    float wLin = uVariant == 1 ? 0.72 : (uVariant == 2 ? 0.52 : 0.70);
    float wCha = uVariant == 1 ? 1.75 : (uVariant == 2 ? 0.35 : 0.55);
    float wCra = uVariant == 2 ? 2.60 : 1.30;

    h = 0.54 + (fbm(p*1.9, 5)*0.5 + 0.5 - 0.5)*0.16;

    /* Three fracture families, each squashed along a different axis so it runs
       in a preferred direction and crosses the other two at an angle.

       The octave counts are the whole design. The zero set of a five-octave
       fractal is spaghetti — it fills the sphere with crazing, like a dropped
       porcelain plate, which is a different wrong answer from the smears but
       still the wrong answer. Two and three octaves give a *few long smooth
       curves*, which is what a fracture system actually is, and leaves the
       broad clean plains between them that make the lines read at all. */
    /* And the width is modulated along the line rather than the result being
       masked: a fracture opens, narrows and dies out, and tapering the width
       gives that, where multiplying the output would only chop it into
       dashes. Each family draws its taper from its own frequency, so they do
       not all narrow in the same places.

       The domain is warped first, and that is not decoration either. The zero
       set of a smooth field is a closed curve, so an unwarped family comes out
       as loops with round ends — "closed loops and circular terminations",
       which was the other half of the complaint. A warp at a frequency well
       below the line spacing shears those loops into long irregular runs that
       cross and truncate without ever closing where you can see it. */
    /* 0.26 was not enough warp to do the job this line claims. The zero set of
       a smooth field is a closed curve, and at two octaves family A has too
       few crossings to avoid closing inside a hemisphere — the moons came out
       carrying visible lassos with rounded ends. A lower frequency and roughly
       twice the amplitude shears them into runs that leave the visible disc
       before they can close. */
    vec3 wq = warp3(p*0.55, 0.50, 3);
    float tapA = 0.30 + 1.35*(fbm(p*1.7 + 211.0, 2)*0.5 + 0.5);
    float tapB = 0.35 + 1.20*(fbm(p*3.4 + 173.0, 2)*0.5 + 0.5);
    float tapC = 0.40 + 1.05*(fbm(p*6.1 + 97.0,  2)*0.5 + 0.5);
    /* Three families at genuinely different weights — 7:1 across the set,
       where it used to be 2:1. One set of broad triple bands you could see
       from a great distance, one medium net, and a fine dense crazing that
       only resolves close up. A moon whose every fracture is the same width
       has no scale in it. */
    vec3 fa = bandOf(vec3(wq.x, wq.y*0.26, wq.z)*1.05 + 3.0,  3, 0.105*tapA, 0.105*tapA*2.4);
    vec3 fb = bandOf(vec3(wq.z*0.30, wq.y, wq.x)*1.55 + 17.0, 3, 0.048*tapB, 0.048*tapB*2.1);
    vec3 fc = bandOf(vec3(wq.x*0.9, wq.y*0.9, wq.z*0.20)*3.1 + 41.0, 3, 0.017*tapC, 0.017*tapC*1.8);
    // The third family is a *province*, not a global net: one hemisphere is
    // criss-crossed and the other is old smooth plain.
    float fcR = smoothstep(0.44, 0.74, fbm(p*0.72 + 151.0, 2)*0.5 + 0.5);
    fc *= fcR;

    // Cycloids. The youngest cracks scallop, because the tidal stress driving
    // the crack rotates while it propagates — the one fracture shape that is
    // unmistakably an ice moon and nothing else.
    float cyc = smoothstep(0.042, 0.0,
      abs(fbm(vec3(p.x, p.y*0.5, p.z)*1.9 + 61.0, 3) + sin(p.y*17.0 + p.x*5.0)*0.032));

    // Ceiling under 1.0 on purpose: a trench that plateaus has thrown away the
    // width taper that distinguishes one family from another.
    float trench = clamp(max(max(fa.x, fb.x), max(fc.x, cyc*0.9))*wLin, 0.0, 0.85);
    float flank  = clamp(max(max(fa.y, fb.y), fc.y)*wLin, 0.0, 1.0);
    // The margins stack rather than compete: a broad band crossed by a medium
    // one is stained by both. The fine family gets none — a crack a few
    // kilometres across has no visible apron.
    float margin = clamp((fa.z*0.90 + fb.z*0.50)*wLin, 0.0, 1.0);
    // A margin is a stain, not a trench — it carries almost no relief, which
    // is what keeps it reading as discolouration beside the ridge instead of
    // as a wider ridge.
    h += flank*0.028*uRelief - trench*0.062*uRelief - margin*0.006*uRelief;

    // Chaos terrain: the shell broken into rafts, walls standing between them.
    float chaosR = smoothstep(0.54, 0.80, fbm(p*1.15 + 91.0, 3)*0.5 + 0.5)*wCha;
    float chaos = 0.0;
    if(chaosR > 0.01){
      vec2 cc = cellular(p*8.0 + 23.0, 1.0);
      float wall = smoothstep(0.11, 0.0, cc.y - cc.x);
      float raft = fbm(p*8.0 + 137.0, 2);
      chaos = clamp(chaosR, 0.0, 1.0);
      h += chaos*(raft*0.048 + wall*0.030 - 0.014)*uRelief;
      /* The raft field has to reach the colour channel, not only the relief.
         Tinting the smooth *region* mask paints a large soft blob with no
         structure inside it, which reads as a wash or a smudge over the shell
         rather than as crust broken into blocks — it was being mistaken for a
         rendering artefact. Modulating by the same field that displaces the
         rafts makes the discolouration follow the blocks. */
      chaos *= (0.45 + 0.55*(raft*0.5 + 0.5)) * (1.0 - wall*0.5);
    }

    h += craterField(p, 5.0,  0.045*uCraters*wCra, uSeed*3.0);
    h += craterField(p, 13.0, 0.020*uCraters*wCra, uSeed*7.0);

    /* The margin rides in the same channel as the trench, at a level that
       lands on the albedo's *halo* step and clear of its dark-stain step —
       so one channel draws both the broad stained apron and the dark line
       down the middle of it, without spending a fourth output. */
    mask = clamp(trench + margin*0.36, 0.0, 1.0);
    mtnv = flank;
    rivv = chaos;

  } else if(uType == 4){                            // LAVA
    /* Volcanic provinces, not fractal soup. A young volcanic world is a small
       number of *centres* — shields with summit calderas, each in its own
       apron of flows — joined by fissure swarms that run straight for hundreds
       of kilometres across plains of flood basalt that are flat because they
       were liquid when they set. */
    float wShl = uVariant == 0 ? 1.45 : (uVariant == 2 ? 0.55 : 0.80);
    float wFis = uVariant == 1 ? 1.55 : 0.85;

    vec3 w = warp3(p*1.05, 0.55, 3);
    h = 0.40 + (fbm(w*1.7, 5)*0.5 + 0.5)*0.30;

    // Shields. A cellular field gives the centres; the cone is a falloff from
    // each one and the caldera is bitten straight out of its summit.
    vec2 vc = cellular(p*2.3 + uSeed*3.0, 0.95);
    float prov = smoothstep(0.40, 0.72, fbm(p*0.85 + 13.0, 3)*0.5 + 0.5);
    float cone = exp(-vc.x*vc.x*11.0)*prov*wShl;
    float caldera = smoothstep(0.085, 0.0, vc.x)*prov*wShl;
    h += cone*0.30*uRelief - caldera*0.16*uRelief;

    // Fissure swarms, and the channels that run downhill off the shields.
    float fis = max(lineOf(vec3(p.x, p.y*0.55, p.z)*1.9 + 9.0, 2, 0.060),
                    lineOf(vec3(p.z*0.6, p.y, p.x)*2.8 + 71.0, 3, 0.040))*wFis*prov;
    float chan = lineOf(p*5.0 + 133.0, 3, 0.028)*smoothstep(0.10, 0.55, vc.x)*prov;
    h -= (fis*0.13 + chan*0.05)*uRelief;

    mask = clamp(fis + chan*0.7 + caldera, 0.0, 1.0);   // what is molten
    mtnv = clamp(cone, 0.0, 1.0);
    rivv = prov;

  } else {                                          // TOXIC
    /* Fold belts and sulfur pans. The belts run in long parallel arcs because
       the crust has been shortened in one direction, and that alignment is
       what stops this reading as one more desert. */
    vec3 w = warp3(p*0.9, 0.42, 3);
    h = (fbm(w*1.4, 5)*0.5 + 0.5)*0.80;

    float fold = pow(max(ridged(vec3(p.x*0.32, p.y, p.z)*2.6 + 5.0, 6), 0.0), 1.5);
    float beltR = smoothstep(0.38, 0.74, fbm(p*0.8 + 43.0, 3)*0.5 + 0.5)
                * (uVariant == 0 ? 1.35 : 0.85);
    h += fold*beltR*0.22*uRelief;

    // Pans: dead flat, filling the low ground between the belts.
    float pan = smoothstep(0.42, 0.30, h)*(1.0 - clamp(beltR, 0.0, 1.0));
    h = mix(h, 0.32, pan*0.75);

    h += craterField(p, 3.4, 0.05*uCraters*(uVariant == 2 ? 2.0 : 0.8), uSeed*4.0);

    mask = clamp(pan, 0.0, 1.0);
    mtnv = clamp(fold*beltR, 0.0, 1.0);
    rivv = clamp(beltR, 0.0, 1.0);
  }

  // universal fine grain so the silhouette never looks like a beach ball
  h += fbm(p*uDetailFreq, 4)*0.012;
  return clamp(h, 0.0, 1.0);
}

// ---------------------------------------------------------------- albedo
vec3 albedoOf(vec3 d, float h, float mask, float mtnv, float rivv){
  vec3 s = vec3(uSeed*13.1, uSeed*7.7, uSeed*3.3);
  vec3 p = d*1.7 + s;
  float lat = abs(d.y);

  // biome jitter so equal-height regions aren't identical
  float biome = fbm(p*2.3 + 55.0, 4)*0.5 + 0.5;
  float grain = fbm(p*13.0, 3)*0.5 + 0.5;

  vec3 col;
  float dry = 1.0;   // 0 under water: rock grain has no business there

  if(uType == 0 || uType == 5){                     // TERRAN / OCEAN
    float land  = smoothstep(uSea, uSea + 0.010, h);
    dry = land;
    float above = clamp((h - uSea) / max(1.0 - uSea, 0.01), 0.0, 1.0);

    // ---- climate ------------------------------------------------------
    // Latitudinal banding is the single strongest cue that a world is real:
    // equatorial green, subtropical desert belts, temperate green, tundra,
    // ice cap. Altitude cools; a moisture field breaks up the stripes.
    // The banding was here but far too weak to survive the blotch layers at
    // the bottom of this function, so every continent came out one colour.
    float warmth = 1.0 - lat*lat*1.62;
    warmth -= above*0.70;
    warmth += (biome - 0.5)*0.22;
    warmth = clamp(warmth, 0.0, 1.0);

    float moist = fbm(p*1.15 + 70.0, 5)*0.5 + 0.5;
    moist = clamp(moist*1.15 - 0.08, 0.0, 1.0);
    // Hadley-cell dry belts around 25 degrees and rain at the equator
    moist -= exp(-pow((lat - 0.32)/0.15, 2.0))*0.55;
    moist += exp(-pow(lat/0.17, 2.0))*0.34;
    // and rain shadow: the lee of a cordillera is desert
    moist -= mtnv*0.30;
    // river valleys carry their own strip of green through anything
    moist += rivv*0.45;
    moist = clamp(moist*mix(0.55, 1.35, uVeg), 0.0, 1.0);

    // ---- biome palette -------------------------------------------------
    vec3 desertC = mix(uC2, uC4, 0.35);                    // sand / rock
    vec3 grassC  = mix(uC1, uC2, 0.55);                    // steppe
    vec3 forestC = uC1*0.74;                               // dense vegetation
    vec3 tundraC = mix(uC3, uC2, 0.45)*0.80;
    vec3 rockC   = uC3;

    vec3 warmBiome = mix(desertC, grassC, smoothstep(0.16, 0.50, moist));
    warmBiome = mix(warmBiome, forestC, smoothstep(0.46, 0.84, moist));

    col = mix(tundraC, warmBiome, smoothstep(0.14, 0.50, warmth));
    // barren rock above the treeline, and bare scree on the ranges themselves
    col = mix(col, rockC, smoothstep(0.40, 0.76, above));
    col = mix(col, mix(rockC, uC4, 0.30), smoothstep(0.12, 0.62, mtnv)*0.85);

    // Watercourses: a dark thread with a band of vegetation either side. This
    // is the single feature that most reads as "erosion happened here".
    col = mix(col, mix(uC1*0.62, uCWater*1.7, 0.42), smoothstep(0.08, 0.62, rivv)*0.72);

    /* The arid third of a continent needs its own texture or it is the one
       region that comes back as flat paint. Sand seas are *lineated* — long
       parallel dune trains — which is a completely different signature from
       the mottle everywhere else, and it is the difference between a desert
       and a brown smear. Only where it is genuinely dry, so a temperate
       continent never grows stripes. */
    float arid = smoothstep(0.30, 0.06, moist)*land;
    if(arid > 0.01){
      float erg = sin(dot(p*9.5, vec3(0.72, 0.18, 0.60)) + fbm(p*2.2 + 401.0, 3)*8.0)*0.5 + 0.5;
      erg = pow(erg, 2.0);
      col = mix(col, mix(desertC, uC4, 0.42), arid*erg*0.42);
      col *= 1.0 - arid*0.10*(1.0 - erg);
    }

    /* Provinces. Everything above this varies the *value* of one biome colour
       and nothing varies its hue, so a continent whose moisture happens to
       land in the arid third comes back as a single unmodulated fill — the
       paint-bucket landmass, with the drainage and the relief that are
       genuinely in the height field invisible under it because there is no
       tonal difference for them to sit against. Real crust is a patchwork of
       soil and bedrock provinces tens of degrees across, and this is the
       cheapest honest way to say so: swing the mix between palette entries on
       two low-frequency fields that owe nothing to the climate bands, so the
       boundaries cross the biome boundaries instead of agreeing with them.
       Baked, so it costs nothing at runtime. */
    float prov  = fbm(p*0.72 + 137.0, 4)*0.5 + 0.5;
    float prov2 = fbm(p*1.85 + 251.0, 3)*0.5 + 0.5;
    /* The thresholds sit close to the field's own mean on purpose. A fractal
       piles its values up there, so a cutoff out at 0.86 selects a few percent
       of the surface and the province reads as an occasional stain rather than
       as the patchwork it has to be. */
    col = mix(col, mix(col, uC3, 0.62), smoothstep(0.50, 0.74, prov)*land*0.70);
    col = mix(col, mix(col, uC0, 0.55), smoothstep(0.50, 0.26, prov)*land*0.55);
    col = mix(col, mix(col, uC4, 0.50), smoothstep(0.52, 0.78, prov2)*land*0.45);
    // and the relief has to read against them, or the province is just a stain
    col = mix(col, mix(col, uC4, 0.55), smoothstep(0.06, 0.48, mtnv)*land*0.30);

    // Rift floors are basalt and shadow, not the same tone as the plateau
    // standing over them.
    col = mix(col, mix(uC3*0.45, uC0, 0.40), smoothstep(0.15, 0.80, mask)*0.45*land);

    // coastal sediment: a narrow bright band, not a whole-continent wash
    col = mix(mix(uC2, vec3(0.185, 0.160, 0.115), 0.40), col, smoothstep(0.0, 0.010, above));

    // ---- snow and ice ---------------------------------------------------
    float snowLine = 0.74 - uIce*0.20 - lat*lat*0.42;
    float snow = smoothstep(snowLine, snowLine + 0.10, above + (grain-0.5)*0.09);
    // permanent cap where it is simply never warm
    snow = max(snow, smoothstep(0.16, 0.03, warmth));
    col = mix(col, uCPolar, clamp(snow, 0.0, 1.0)*land);

    // ---- water ----------------------------------------------------------
    float depth = clamp((uSea - h)/max(uSea, 0.01), 0.0, 1.0);
    // shelf → abyss. Real ocean colour is dominated by depth, not by hue.
    vec3 shelf = uCWater*0.95;
    vec3 abyss = uCWater*0.085;
    vec3 water = mix(shelf, abyss, pow(depth, 0.40));
    // turbidity plumes where rivers meet the shelf
    float silt = (1.0 - smoothstep(0.0, 0.09, depth)) * smoothstep(0.35, 0.75, moist);
    water = mix(water, mix(water, vec3(0.055, 0.068, 0.048), 0.55), silt*0.6);
    // sea ice
    float seaIce = smoothstep(0.14, 0.02, warmth + 0.10);
    water = mix(water, uCPolar*0.88, seaIce);
    col = mix(water, col, land);

  } else if(uType == 1){                            // DESERT
    col = mix(uC1, uC2, smoothstep(0.30, 0.62, h + (biome-0.5)*0.2));
    col = mix(col, uC3, smoothstep(0.60, 0.85, h));
    // Canyon floors are darker, and the walls show their strata: banding in
    // *height* rather than in position, so it follows the contour of the cut
    // the way real bedding does instead of running across it.
    col = mix(col, uC0, smoothstep(0.18, 0.80, rivv)*0.58);
    float strata = sin(h*110.0 + biome*5.0)*0.5 + 0.5;
    col *= 1.0 + smoothstep(0.10, 0.50, rivv)*(strata - 0.5)*0.18;
    // Dune crests are a different mineral from the flats between them.
    col = mix(col, mix(uC3, uC4, 0.5), mtnv*0.42);
    col = mix(col, uC4, mask*0.60);                       // mesa caps
    col *= 0.90 + grain*0.20;
    col = mix(col, uCPolar, smoothstep(0.90, 0.99, lat)*uIce);

  } else if(uType == 2){                            // BARREN
    col = mix(uC1, uC2, smoothstep(0.35, 0.70, h + (biome-0.5)*0.25));
    col = mix(col, uC0, mask*0.75);                       // dark maria
    col = mix(col, uC3, smoothstep(0.72, 0.92, h));       // bright ejecta
    /* Ejecta rays, and they have to be *radial*. The old term was a sixth
       power of an fbm — a field of bright blotches with no centre and no
       direction, which is exactly the "no ejecta rays" note. A ray system is
       a bearing function around one crater, running out for two or three of
       its own diameters and frayed along its length; nothing else in a
       photograph of an airless world says as loudly that the surface has no
       weather to erase anything. It is drawn from the same named basin the
       height field places, so the rays come out of the crater that made them. */
    vec3 bc = normalize(vec3(sin(uSeed*2.3), sin(uSeed*5.1)*0.62, cos(uSeed*1.9)));
    vec3 t1 = normalize(cross(bc, abs(bc.y) < 0.9 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));
    vec3 t2 = cross(bc, t1);
    float ad = acos(clamp(dot(d, bc), -1.0, 1.0));
    float bearing = atan(dot(d, t2), dot(d, t1));
    // Sampled on a circle so the field is periodic in bearing and there is no
    // seam where the angle wraps.
    float spoke = fbm(vec3(cos(bearing)*7.0, sin(bearing)*7.0, uSeed*3.0), 3)*0.5 + 0.5;
    spoke = pow(smoothstep(0.46, 0.86, spoke), 1.6);
    float br = 0.52 + float(uVariant)*0.16;
    float reach = (1.0 - smoothstep(br*1.15, br*2.9, ad))*smoothstep(br*0.92, br*1.15, ad);
    float rays = spoke*reach*(0.55 + 0.45*(fbm(p*11.0 + 71.0, 3)*0.5 + 0.5));
    col = mix(col, uC4, clamp(rays, 0.0, 1.0)*0.62);
    col = mix(col, uC0, smoothstep(0.25, 0.90, rivv)*0.30);  // rille floors
    col *= 0.88 + grain*0.24;

  } else if(uType == 7){                            // IRON
    // Bare metal, and it reads as metal because the value range is narrow and
    // the *edges* carry the contrast: bright on an exposed ridge or a scarp
    // face, near-black in a slag pond. Nothing here is dusty.
    col = mix(uC1, uC2, smoothstep(0.30, 0.66, h + (biome-0.5)*0.22));
    col = mix(col, uC0*0.85, smoothstep(0.20, 0.75, mask));     // slag ponds
    col = mix(col, uC3, smoothstep(0.22, 0.78, mtnv)*0.50);     // exposed ridges
    col = mix(col, mix(uC3, uC4, 0.5), smoothstep(0.40, 0.92, rivv)*0.30);  // scarp faces
    float sheen = pow(max(fbm(p*17.0 + 91.0, 3)*0.5 + 0.5, 0.0), 5.0);
    col = mix(col, uC4, sheen*0.22);
    col *= 0.90 + grain*0.18;

  } else if(uType == 3){                            // ICE
    /* The shell is bright and nearly uniform; everything that reads is the
       fractures. A trench carries the mineral stain that came up with the
       water, its flanks are *fresh* ice and brighter than the plain either
       side, and the chaos rafts are dirtier than either because they have been
       sitting there collecting whatever falls out of the sky. */
    col = mix(uC2, uC3, smoothstep(0.42, 0.68, h + (biome-0.5)*0.16));
    col = mix(col, uC4, smoothstep(0.60, 0.86, h));
    col = mix(col, mix(uC1, uC0, 0.38), rivv*0.30);            // chaos rafts
    col = mix(col, uC4, smoothstep(0.10, 0.58, mtnv)*0.72);    // fresh flanks
    // a halo of stained frost either side of the trench, then the stain itself
    col = mix(col, mix(uC0, uC1, 0.55), smoothstep(0.04, 0.28, mask)*0.50);
    /* Widened and weakened. Europa's darkest lineae sit at 0.12-0.26 of the
       plain's luminance; this mapping bottomed ours out at 0.00-0.01, which is
       what made them read as cracks in porcelain rather than as stain. The
       upper edge now sits above anything the mask can reach, so the stain is a
       gradient across the whole band instead of a plateau with an edge. */
    col = mix(col, uC0, smoothstep(0.30, 1.25, mask)*0.52);
    col = mix(col, uCPolar, smoothstep(0.58, 0.94, lat)*0.60);
    col *= 0.93 + grain*0.12;
    // Ice is clean. The blotch layers at the bottom of this function are what
    // geology looks like, and running them at full strength over a shell is
    // most of what made every ice moon look like it needed a wash.
    dry = 0.35;

  } else if(uType == 4){                            // LAVA
    // Cold crust is nearly black, and what is hot is *only* in the fissures
    // and the calderas. uC4 feeds the runtime emissive through the height
    // channel, so the molten mask has to sit on the low ground.
    col = mix(uC1, uC2, smoothstep(0.34, 0.70, h + (biome-0.5)*0.22));
    col = mix(col, uC3, smoothstep(0.68, 0.92, h));
    col = mix(col, uC0, smoothstep(0.48, 0.24, h)*0.70);       // old flood plains
    col = mix(col, mix(uC3, uC4, 0.22), smoothstep(0.15, 0.75, mtnv)*0.45);
    col = mix(col, uC4, pow(mask, 0.65));                      // molten
    col *= 0.9 + grain*0.2;

  } else {                                          // TOXIC
    col = mix(uC1, uC2, smoothstep(0.30, 0.65, h + (biome-0.5)*0.3));
    col = mix(col, uC3, smoothstep(0.62, 0.88, h));
    col = mix(col, uC4, smoothstep(0.20, 0.80, mtnv)*0.55);    // fold crests
    col = mix(col, mix(uC0, uC3, 0.30), mask*0.80);            // sulfur pans
    col *= 0.92 + grain*0.16;
  }

  // Blotchiness at every scale. A surface that is smooth between its major
  // features is the fastest way to look computer-generated; real geology has
  // texture from continental down to the resolution limit.
  //
  // But only *geology* does. The top octave used to run at 140 in p, which is
  // about two and a half texels at 1024 per face: near enough to Nyquist that
  // it aliased into long low-frequency beats, and those were the faint diagonal
  // streaks that crossed the oceans. It is pulled back below the sampling rate,
  // and the two fine octaves are masked off the water, which has no business
  // carrying rock grain in the first place.
  col *= 0.88 + 0.24*(fbm(p*0.9 + 101.0, 3)*0.5 + 0.5);
  col *= 0.90 + 0.20*(fbm(p*9.5 + 211.0, 4)*0.5 + 0.5);
  col *= mix(1.0, 0.93 + 0.14*(fbm(p*34.0 + 307.0, 4)*0.5 + 0.5), dry);
  col *= mix(1.0, 0.96 + 0.08*(fbm(p*78.0 + 419.0, 3)*0.5 + 0.5), dry);
  return max(col, vec3(0.0));
}

void main(){
  vec3 d = normalize(vDir);
  float mask, mtnv, rivv;
  float h = heightOf(d, mask, mtnv, rivv);
  vec3 alb = albedoOf(d, h, mask, mtnv, rivv);
  gl_FragColor = vec4(alb, h);
}
`;
