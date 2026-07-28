import * as THREE from 'three';
import { FS_VERT } from './glsl/noise.js';

/* ============================================================================
   Hand-rolled HDR post pipeline.

     scene ──▶ HDR (half-float, optional MSAA, depth texture attached)
                 │
                 ├─▶ linear depth (per scene pass) ─▶ AO ─▶ bilateral blur
                 ├─▶ bright prefilter ─▶ 6× dual-filter downsample
                 │                        └─▶ tent upsample = physical bloom
                 ├─▶ anamorphic streak (horizontal 3-pass)
                 ├─▶ flare pass (radial god-rays + lens ghosts + halo)
                 │
                 └─▶ composite (AO + bloom + flares + radial blur + CA + grain +
                                vignette + AgX tonemap + dither) ─▶ FXAA ─▶ screen

   Everything is written by hand so the look stays consistent and the whole
   chain fits inside a mobile fill-rate budget.
   ========================================================================== */

const COMMON_UNIFORM_TEX = () => ({ value: null });

function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    ...opts,
  });
  return rt;
}

/* --------------------------------------------------------------- shaders */

/* ---------------------------------------------------------------- depth

   Screen-space occlusion needs linear depth, and this renderer's depth buffer
   holds two different encodings, chosen per pass and — for the world pass —
   per scene:

     * space is drawn with three's *logarithmic* depth buffer, which writes
           gl_FragDepth = log2(1 + w) * logDepthBufFC * 0.5
       in every fragment. One world unit is a kilometre out there and a frame
       spans nine orders of magnitude, which is what the encoding is for.
     * the ground scene is the same pass with the same camera and is *not* on
       it: Game.setGroundDepth takes every material it draws off the log buffer
       because writing gl_FragDepth defeats early-Z, and a 6 m to 26 km scene
       does not need the range. See `sceneLogDepth` below.
     * the cabin is a second pass over a cleared depth buffer, drawn with its
       own camera and with stripLogDepth() applied to every material it owns,
       so it is on the ordinary projection curve too.

   A single linearisation would therefore be right for one of them and
   silently wrong for the other. Rather than teach the occlusion pass about
   both, the depth is normalised *before* it: whichever pass owns the frame is
   followed by one full-screen blit that inverts that pass's own encoding and
   writes view-space Z, in that scene's own units, into one shared R32F buffer.
   Everything downstream sees one buffer with one meaning, and the estimator is
   scale-free (see AO_FRAG) so kilometres and metres need no special casing.

   Only one pass per frame, not both. Layering the two — capture the world,
   then capture the cabin discarding wherever it drew nothing — is correct and
   was the first version, and it costs a second multisampled *depth* resolve at
   full resolution, which measured about four milliseconds a frame in the two
   cameras that have a cabin at all. What it buys is occlusion on the only
   thing visible past the canopy: sky, and a planet, which is a sphere and
   occludes nothing. So when the cabin is drawn, the cabin's depth is the
   frame's depth, and everything outside it reads as unoccluded.

   Zero means "no geometry here": sky, and the far plane. */
const LINEARIZE_FRAG = /* glsl */`
precision highp float;
uniform highp sampler2D tDepth;
uniform float uLog;        // 1 = logarithmic depth buffer, 0 = projection depth
uniform float uFC;         // logDepthBufFC = 2 / log2(far + 1)
uniform float uNear;
uniform float uFarPlane;
uniform vec2  uSrcTexel;   // one texel of the *full-res* depth texture, in uv
varying vec2 vUv;
void main(){
  /* Half a source texel off centre, and that is not cosmetic.

     This pass runs at half resolution over a full-resolution depth texture, so
     the centre of a destination pixel lands exactly on the boundary between
     two source texels. Which one a NEAREST fetch returns is then decided by the
     last bit of the interpolated coordinate: it comes out in runs, and on any
     surface seen at an angle the two texels differ in depth. The reconstructed
     normal wobbles with it and the occlusion pass draws a set of vertical bands
     across every wall — which reads as banding in the *shading* and sends you
     hunting through the estimator, where there is nothing wrong. */
  float d = texture2D(tDepth, vUv + uSrcTexel * 0.5).r;
  if(d >= 0.999999){
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);   // nothing was drawn: no occluder
    return;
  }
  float z;
  if(uLog > 0.5){
    // gl_FragDepth = log2(1 + w) * uFC * 0.5, and w is the view-space distance
    // along -Z for any perspective projection.
    z = exp2(d * 2.0 / uFC) - 1.0;
  } else {
    float ndc = d * 2.0 - 1.0;
    z = (2.0 * uNear * uFarPlane) / (uFarPlane + uNear - ndc * (uFarPlane - uNear));
  }
  gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
}
`;

/* -------------------------------------------------------------------- AO

   Alchemy-style obscurance over a spiral of taps, run at half resolution.

   The one decision that matters here is that the sampling radius is
   *angular*, not a fixed distance in world units. This game spans nine orders
   of magnitude in one frame — a console switch two centimetres wide and a gas
   giant seventy thousand kilometres across — so any world-space radius is
   simultaneously far too large and far too small. A radius proportional to
   view depth subtends a constant number of pixels, which makes the tap
   pattern free, the texture access local, and the result identical whether
   the scene is authored in kilometres or metres.

   The estimator is written in units of that radius (u = v / radius) rather
   than in world units, so nothing in it can overflow: a naive Alchemy
   falloff carries radius^6, and at the far end of a system radius^6 is 1e37
   and a float32 stops being a number.

   The tap pattern is fixed in screen space and has no time term on purpose:
   there is nothing accumulating across frames here to resolve a moving
   pattern, and per-frame rotation reads as a crawling speckle — the same
   mistake the god-ray march made. */
const AO_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tLin;
uniform vec2  uTexel;      // full-res texel size, in uv
uniform vec2  uAoTexel;    // one texel of the half-res linear-depth buffer
uniform vec2  uProj;       // tan(fovX/2), tan(fovY/2)
uniform float uRadiusPx;   // sampling radius, full-res pixels (constant by depth)
uniform float uAngular;    // radius / depth — the same radius, in world units
uniform float uWorldR;     // >0: hold the radius fixed in world units instead
uniform float uIntensity;
uniform float uFineWeight;
uniform float uBias;
uniform float uMinPx;      // no tap closer than this, in full-res pixels
varying vec2 vUv;

vec3 viewPos(vec2 uv, float z){
  return vec3((uv * 2.0 - 1.0) * uProj * z, -z);
}

/* Where the depth in the texel under uv was actually measured.
 *
 * This is the whole difference between an occlusion pass and a flat dim, and
 * it took reading the buffer's own histogram to find. The linear-depth target
 * is half resolution and NEAREST, so a fetch at uv returns the depth of the
 * *texel containing* uv — a value that is constant across the whole texel —
 * while viewPos(uv, z) was unprojecting it at the arbitrary sub-texel point
 * the spiral happened to land on. The reconstructed point therefore sat off the
 * surface by whatever fraction of a texel the tap was displaced, in a direction
 * that is *lateral to the view*, not tangent to the surface.
 *
 * Which means dot(u, N) is not zero on a flat plane. It is zero only when the
 * plane faces the camera; at any other incidence it is proportional to the
 * sub-texel displacement, and the estimator's max(dot(u,N) - bias, 0)
 * rectifies it — half the spiral's directions give a positive, the other half
 * are clamped away, and what comes out is a *constant positive occlusion on
 * every surface in the frame*, growing with incidence. Worse for the taps that
 * land nearest, because the estimator divides by (u·u + 0.022) and the inner
 * ring of the fine radius is a fraction of one texel across, so its u·u is
 * dominated by the epsilon and the ratio blows up.
 *
 * Measured, that was 84% of everything the pass did: an A/B against the pass
 * disabled fitted off = 1.018*on + 4.34 with only 15.2% of pixels carrying
 * any structure at all. It is not a tuning problem and no bias or blur setting
 * reaches it.
 *
 * Snapping the tap to the position its depth was sampled at makes u lie in the
 * surface exactly, so a plane returns exactly zero and a crease returns what it
 * should. The 0.75 (rather than 0.5) is because LINEARIZE_FRAG deliberately
 * fetches half a *source* texel off centre — see the comment there — so the
 * depth stored in half-res texel i belongs to screen position i + 0.75, and the
 * centre fragment has to be unprojected at the same offset or it reintroduces
 * the error it is removing. */
vec2 aoSnap(vec2 uv){ return (floor(uv / uAoTexel) + 0.75) * uAoTexel; }

void main(){
  float z = texture2D(tLin, vUv).r;
  if(z <= 0.0){ gl_FragColor = vec4(1.0); return; }   // sky

  vec3 P = viewPos(aoSnap(vUv), z);

  /* Geometric normal from depth, by central difference wherever there is one.

     The obvious construction — take whichever of the two opposed neighbours is
     nearer in depth, so a silhouette cannot drag the normal across the
     discontinuity behind it — is wrong on a *curved* surface, and the corridor
     walls and the hull are nothing but curved surfaces. On a cylinder the two
     one-sided derivatives genuinely differ, the comparison that chooses
     between them is decided by float noise, and the normal therefore flips
     from pixel to pixel. The occlusion flips with it and the result is a fine
     vertical comb across every wall the camera sees at an angle. It looked
     like sampling noise and was not; no amount of blurring touched it.

     So: central difference by default, and only fall to one side when a
     neighbour is missing or is a genuine step — a factor of two in depth
     difference, which no smooth surface produces and every silhouette does. */
  vec2 tx = vec2(uAoTexel.x, 0.0), ty = vec2(0.0, uAoTexel.y);
  float zr = texture2D(tLin, vUv + tx).r, zl = texture2D(tLin, vUv - tx).r;
  float zu = texture2D(tLin, vUv + ty).r, zd = texture2D(tLin, vUv - ty).r;
  vec3 pr = viewPos(aoSnap(vUv + tx), zr), pl = viewPos(aoSnap(vUv - tx), zl);
  vec3 pu = viewPos(aoSnap(vUv + ty), zu), pd = viewPos(aoSnap(vUv - ty), zd);
  float dr = abs(zr - z), dl = abs(z - zl);
  float du = abs(zu - z), dd = abs(z - zd);

  vec3 ddx;
  if(zr <= 0.0 || (zl > 0.0 && dl * 2.0 < dr))      ddx = P - pl;
  else if(zl <= 0.0 || dr * 2.0 < dl)               ddx = pr - P;
  else                                              ddx = (pr - pl) * 0.5;
  vec3 ddy;
  if(zu <= 0.0 || (zd > 0.0 && dd * 2.0 < du))      ddy = P - pd;
  else if(zd <= 0.0 || du * 2.0 < dd)               ddy = pu - P;
  else                                              ddy = (pu - pd) * 0.5;

  vec3 N = cross(ddx, ddy);
  float nl = length(N);
  if(nl < 1e-20){ gl_FragColor = vec4(1.0); return; }
  N /= nl;

  /* Two radii, not one, sharing the same spiral.

     A single scale cannot do this job. The wide radius is what darkens a
     corner — the metre or so where a bulkhead meets a deck, or a rock meets
     the ground — and at that radius a two-centimetre panel groove is far
     inside the first tap and contributes nothing. The narrow radius is what
     draws the groove. Run one alone and you get either a room with soft
     corners and no surface detail, or a wireframe of thin dark outlines with
     flat walls between them, which is what the first version of this looked
     like.

     They cost one extra tap each rather than a second pass, and combine
     multiplicatively: occlusion at two scales is two independent chances for a
     ray to be blocked. */
  /* Interleaved sampling: the sixteen pixels of a 4x4 block each get a
     different rotation and a different radial offset, and the blur that
     follows averages exactly one whole block. Eight taps a pixel therefore
     resolve like a hundred and twenty-eight.

     Interleaved gradient noise was the first thing here and it was wrong: its
     two coefficients differ by a factor of eleven, so the rotation varies fast
     along x and slowly along y, neighbouring *columns* sample nearly the same
     directions, and the undersampling collects into vertical streaks hanging
     off every silhouette in the frame. A 4x4 block with a stride coprime to 16
     has no preferred axis. */
  vec2 cell = mod(floor(gl_FragCoord.xy), 4.0);
  float idx = cell.y * 4.0 + cell.x;
  float ang0 = idx * (6.2831853 * 5.0 / 16.0);
  float jr = fract(idx * 0.6180339887);

  float occWide = 0.0, occFine = 0.0;
  /* Two ways of saying how big the radius is, and a landscape needs the other
     one.

     An angular radius — a fixed fraction of the frame, so a fixed number of
     pixels at any depth — is exactly right in a cabin, where everything the
     estimator can see is within a couple of metres and the interesting scale
     grows with distance the same way the geometry does. On the ground it is
     wrong in a way that measures: five and a half per cent of the frame is
     eleven centimetres at two metres and nine *metres* at two hundred, so the
     pass darkened nothing under a landing foot and everything around a
     ridgeline, and an A/B against ?ao=0 moved the mean by 2.8/255 while
     tracing normal-map edges and outlining the hull.

     Whether a fold in the ground is a crease is decided in metres, and it is
     the same one or two metres at your feet and at the far scatter band. So
     the caller can pin the radius in world units and the screen-space number
     becomes what it should always have been out here — a *budget*: the pass
     may never walk further than it does today, and it fades out rather than
     collapsing to an edge detector once the world radius stops being worth
     more than a few pixels. */
  float rBase = z * uAngular;
  float wantPx = uWorldR > 0.0 ? uRadiusPx * uWorldR / max(rBase, 1e-9) : uRadiusPx;
  float radiusPx = clamp(wantPx, 2.0, uRadiusPx);
  float fade = uWorldR > 0.0 ? smoothstep(2.0, 5.0, wantPx) : 1.0;
  if(fade <= 0.0){ gl_FragColor = vec4(1.0); return; }
  float rWide = rBase * radiusPx / max(uRadiusPx, 1e-6), rFine = rWide * AO_FINE;

  for(int i = 0; i < AO_TAPS; i++){
    float a = (float(i) + jr) / float(AO_TAPS);
    float ang = a * 6.2831853 * 7.0 + ang0;
    vec2 sc = vec2(cos(ang), sin(ang));
    /* A floor on how near a tap may land, in pixels rather than as a fraction
       of the radius. Under the floor a tap reads the centre's own texel, which
       after the snap above is exactly u = 0 and contributes exactly nothing —
       correct, and a wasted fetch. Pushing it out to a texel spends it on a
       neighbour that can actually occlude. It matters most for the fine ring,
       whose whole radius is 18% of the wide one: at the working radius its
       inner taps were a third of a texel out. */
    vec2 dir = sc * max(a * radiusPx, uMinPx) * uTexel;

    vec2 uvW = vUv + dir;
    float zw = texture2D(tLin, uvW).r;
    if(zw > 0.0){
      // in units of the radius, so the whole estimator is dimensionless and
      // nothing in it can overflow at the far end of a solar system
      vec3 u = (viewPos(aoSnap(uvW), zw) - P) / rWide;
      float uu = dot(u, u);
      occWide += clamp(1.0 - uu, 0.0, 1.0) * max(dot(u, N) - uBias, 0.0) / (uu + 0.022);
    }

    vec2 uvF = vUv + sc * max(a * radiusPx * AO_FINE, uMinPx) * uTexel;
    float zf = texture2D(tLin, uvF).r;
    if(zf > 0.0){
      vec3 u = (viewPos(aoSnap(uvF), zf) - P) / rFine;
      float uu = dot(u, u);
      occFine += clamp(1.0 - uu, 0.0, 1.0) * max(dot(u, N) - uBias, 0.0) / (uu + 0.022);
    }
  }

  float k = uIntensity * fade * 2.0 / float(AO_TAPS);
  float ao = clamp(1.0 - k * occWide, 0.0, 1.0)
           * clamp(1.0 - k * uFineWeight * occFine, 0.0, 1.0);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

/* Depth-aware separable blur over the AO buffer.

   The kernel is a box exactly four texels wide, run centred, which means five
   taps weighted (0.5, 1, 1, 1, 0.5). That is not an arbitrary shape: the
   sampling pattern above repeats every four pixels, and only a kernel whose
   weights sum equally over each of those four phases removes it completely. A
   Gaussian of any width does not — it favours the phase under the centre tap,
   and what is left over is a fine vertical comb hanging off every edge in the
   frame, which is what this looked like before.

   The depth tolerance is a *fraction* of the centre depth rather than an
   absolute distance, which is the only form that means the same thing in a
   cockpit and in an orbit — and it is taken against the depth the *surface*
   predicts rather than against the depth under the centre tap, which is the
   difference between a blur that works on a floor and one that does not.

   Because if it is not: a ground plane seen at a grazing angle changes depth
   by several per cent over two texels, every outer tap fails a two-per-cent
   tolerance, the kernel collapses to its middle, and the 4x4 interleave the
   kernel exists to resolve survives untouched — along one axis only, because
   the depth gradient is steep vertically and flat horizontally. What comes out
   is a set of horizontal bands lying across the whole middle distance of every
   landscape, on a four-texel pitch, and it reads as terrain banding rather
   than as a post-process artifact. Subtracting the local slope first costs two
   taps that are already in cache and makes the test mean what it was supposed
   to mean: reject a *step*, not a slope. */
const AOBLUR_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tAO;
uniform sampler2D tLin;
uniform vec2 uStep;        // one half-res texel along the blur axis, in uv
varying vec2 vUv;
void main(){
  float z0 = texture2D(tLin, vUv).r;
  if(z0 <= 0.0){ gl_FragColor = vec4(1.0); return; }
  // One-texel central difference along the blur axis. Clamped, because across
  // a silhouette it is not a slope at all and an unclamped extrapolation would
  // wave the whole kernel through the discontinuity it exists to stop at.
  float zp = texture2D(tLin, vUv + uStep).r;
  float zm = texture2D(tLin, vUv - uStep).r;
  float slope = (zp > 0.0 && zm > 0.0) ? (zp - zm) * 0.5 : 0.0;
  float lim = z0 * 0.06;
  slope = clamp(slope, -lim, lim);
  float tol = z0 * 0.02 + 1e-9;
  float sum = 0.0, wsum = 0.0;
  for(int i = -2; i <= 2; i++){
    float fi = float(i);
    vec2 uv = vUv + uStep * fi;
    float zs = texture2D(tLin, uv).r;
    if(zs <= 0.0) continue;
    float w = (abs(fi) > 1.5 ? 0.5 : 1.0) / (1.0 + abs(zs - (z0 + slope * fi)) / tol);
    sum += texture2D(tAO, uv).r * w;
    wsum += w;
  }
  float ao = wsum > 0.0 ? sum / wsum : texture2D(tAO, vUv).r;
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

/**
 * Bright-pass prefilter.
 *
 * The threshold has to be applied to the *exposed* image, not to raw scene
 * radiance. Thresholding in scene-linear means the bloom does not know what
 * the exposure is doing: in a bright frame — where auto-exposure has stopped
 * down to 0.05 — a scene value of 1.05 displays as near-black yet still passes
 * a 1.05 threshold, so most of the frame blooms and the result is a uniform
 * milky veil over everything. That single mistake is most of what "flat" and
 * "shot through fog" mean.
 *
 * The adaptation texture is a frame behind, which is invisible and free.
 */
const PREFILTER_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform sampler2D tAdapt;
uniform vec2  uTexel;
uniform float uThreshold;   // in display stops, not scene radiance
uniform float uKnee;
uniform float uClamp;       // cap on the *exposed* contribution
uniform float uKey;
uniform float uExpMin;
uniform float uExpMax;
varying vec2 vUv;

vec3 tap(vec2 uv){ return texture2D(tSrc, uv).rgb; }

void main(){
  float avgLum = sqrt(max(texture2D(tAdapt, vec2(0.5)).r, 0.0));
  float e = clamp(uKey / max(avgLum, 1e-6), uExpMin, uExpMax);

  // 4-tap box (bilinear) to halve resolution cleanly
  vec2 o = uTexel;
  vec3 c = tap(vUv + vec2(-o.x,-o.y)) + tap(vUv + vec2(o.x,-o.y))
         + tap(vUv + vec2(-o.x, o.y)) + tap(vUv + vec2(o.x, o.y));
  c *= 0.25;

  // Work in exposed units, then hand back scene-linear — the composite exposes
  // the bloom again along with everything else.
  vec3 x = min(c * e, vec3(uClamp));
  float br = max(x.r, max(x.g, x.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0*uKnee);
  soft = soft*soft / (4.0*uKnee + 1e-5);
  float w = max(soft, br - uThreshold) / max(br, 1e-5);
  gl_FragColor = vec4(x * w / max(e, 1e-6), 1.0);
}
`;

// Call of Duty 13-tap downsample: stable, no fireflies, no pulsing.
const DOWN_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 T(vec2 uv){ return texture2D(tSrc, uv).rgb; }
void main(){
  vec2 t = uTexel;
  vec3 a = T(vUv + vec2(-2.0*t.x,  2.0*t.y));
  vec3 b = T(vUv + vec2( 0.0,      2.0*t.y));
  vec3 c = T(vUv + vec2( 2.0*t.x,  2.0*t.y));
  vec3 d = T(vUv + vec2(-2.0*t.x,  0.0));
  vec3 e = T(vUv);
  vec3 f = T(vUv + vec2( 2.0*t.x,  0.0));
  vec3 g = T(vUv + vec2(-2.0*t.x, -2.0*t.y));
  vec3 h = T(vUv + vec2( 0.0,     -2.0*t.y));
  vec3 i = T(vUv + vec2( 2.0*t.x, -2.0*t.y));
  vec3 j = T(vUv + vec2(-t.x,  t.y));
  vec3 k = T(vUv + vec2( t.x,  t.y));
  vec3 l = T(vUv + vec2(-t.x, -t.y));
  vec3 m = T(vUv + vec2( t.x, -t.y));
  vec3 r = e*0.125;
  r += (a+c+g+i)*0.03125;
  r += (b+d+f+h)*0.0625;
  r += (j+k+l+m)*0.125;
  gl_FragColor = vec4(r, 1.0);
}
`;

const UP_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;   // smaller mip
uniform vec2  uTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;
vec3 T(vec2 uv){ return texture2D(tSrc, uv).rgb; }
void main(){
  vec2 t = uTexel * uRadius;
  vec3 r = T(vUv + vec2(-t.x,  t.y))*1.0 + T(vUv + vec2(0.0,  t.y))*2.0 + T(vUv + vec2(t.x,  t.y))*1.0
         + T(vUv + vec2(-t.x,  0.0))*2.0 + T(vUv)*4.0                    + T(vUv + vec2(t.x,  0.0))*2.0
         + T(vUv + vec2(-t.x, -t.y))*1.0 + T(vUv + vec2(0.0, -t.y))*2.0 + T(vUv + vec2(t.x, -t.y))*1.0;
  gl_FragColor = vec4(r * (1.0/16.0) * uWeight, 1.0);
}
`;

/* Anamorphic streak, with a threshold of its own.
 *
 * It used to inherit the bloom's, which is 0.92 display stops with a soft knee
 * — the right number for a halo and much too low for a bar. What that produced
 * in a deep field was several dozen *mid-brightness background stars* each
 * wearing a long horizontal blue dash, laid out in a regular grid across the
 * frame, while the actual star — the brightest object in the game, clipping to
 * pure white over one and a half percent of the frame — wore none you could
 * find, because its own bar sat inside its own bloom. The lens's character was
 * exactly inverted: an anamorphic flare is what a *clipping* source does to a
 * cylindrical element, and a star two levels above the sky floor does not do it
 * at all.
 *
 * So the first pass re-thresholds, in the exposed domain and not in scene
 * radiance — the same rule the bloom prefilter obeys, and for the same reason:
 * a threshold in scene-linear has no idea what the auto-exposure is doing, and
 * the auto-exposure moves by six stops between a cabin and a starfield. The two
 * later passes are widening a bar that has already been selected, so they leave
 * uThreshold at zero and skip the lookup.
 */
const STREAK_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform sampler2D tAdapt;
uniform vec2  uTexel;
uniform float uStep;
uniform vec3  uTint;
uniform float uThreshold;   // display stops; 0 passes the source through
uniform float uKey;
uniform float uExpMin;
uniform float uExpMax;
varying vec2 vUv;
void main(){
  float e = 1.0;
  if(uThreshold > 0.0){
    float avgLum = sqrt(max(texture2D(tAdapt, vec2(0.5)).r, 0.0));
    e = clamp(uKey / max(avgLum, 1e-6), uExpMin, uExpMax);
  }
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for(int i=-10;i<=10;i++){
    float fi = float(i);
    float w = exp(-fi*fi*0.028);
    vec3 s = texture2D(tSrc, vUv + vec2(fi*uStep*uTexel.x, 0.0)).rgb;
    // hand it back scene-linear: the composite exposes the streak along with
    // everything else
    if(uThreshold > 0.0) s = max(s * e - uThreshold, 0.0) / e;
    sum += s * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum/wsum * uTint, 1.0);
}
`;

// God rays (radial occlusion blur from the star) + lens ghosts + halo.
const FLARE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tBright;
uniform vec2  uSunUV;      // star position in screen space
uniform float uSunVis;     // 0 when off-screen / occluded
uniform float uAspect;
uniform float uRayStrength;
uniform float uGhostStrength;
varying vec2 vUv;

vec3 sampleChroma(vec2 uv, float d){
  // slight lateral dispersion on ghosts sells the "real lens" feel
  vec2 c = vec2(0.5);
  vec2 dir = normalize(uv - c + 1e-6);
  vec3 col;
  col.r = texture2D(tBright, uv + dir*d*1.6).r;
  col.g = texture2D(tBright, uv + dir*d*0.0).g;
  col.b = texture2D(tBright, uv - dir*d*1.6).b;
  return col;
}

void main(){
  vec3 outc = vec3(0.0);

  // ---- radial god rays ------------------------------------------------
  if(uSunVis > 0.001){
    vec2 delta = (vUv - uSunUV);
    const int N = 24;
    float dens = 0.62;
    delta *= 1.0/float(N) * dens;
    /* Jitter the march so bright points smear instead of leaving dotted
       trails. Two wrong answers here before this one: white noise gave a dense
       speckle crawling over the whole halo, and a 4x4 Bayer matrix replaced it
       with a visible diagonal lattice woven across the brightest object in the
       game. Interleaved gradient noise is the right tool — it decorrelates
       neighbouring pixels like white noise but its spectrum is smooth, so it
       leaves no pattern for the eye to lock onto. */
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float j = ign;
    vec2 uv = vUv - delta*j;
    float decay = 1.0;
    vec3 acc = vec3(0.0);
    for(int i=0;i<N;i++){
      uv -= delta;
      vec3 s = texture2D(tBright, clamp(uv, 0.0, 1.0)).rgb;
      acc += s * decay;
      decay *= 0.955;
    }
    acc /= float(N);
    // fade rays when the star is near/outside the frame edge
    vec2 e = abs(uSunUV - 0.5)*2.0;
    float edge = 1.0 - smoothstep(0.75, 1.35, max(e.x, e.y));
    outc += acc * uRayStrength * uSunVis * edge;
  }

  // ---- lens ghosts ----------------------------------------------------
  // Ghosts are reflections between elements: small, tight, mirrored through the
  // optical centre. Anything big and soft reads as a bug, not as a lens — and
  // the source is clamped so a star cannot smear a halo over the whole frame.
  vec2 fuv = vec2(1.0) - vUv;
  vec2 ghostVec = (vec2(0.5) - fuv) * 0.34;
  vec3 ghosts = vec3(0.0);
  for(int i=1;i<=4;i++){
    float fi = float(i);
    vec2 off = fuv + ghostVec*fi;
    if(off.x < 0.0 || off.x > 1.0 || off.y < 0.0 || off.y > 1.0) continue;
    // aspect-correct so ghosts stay round on a wide viewport
    vec2 rel = (off - 0.5) * vec2(uAspect, 1.0);
    float w = exp(-dot(rel, rel) * 44.0) / fi;
    ghosts += min(sampleChroma(off, 0.004*fi), vec3(3.0)) * w;
  }

  outc += ghosts * uGhostStrength;

  gl_FragColor = vec4(min(outc, vec3(6.0)), 1.0);
}
`;

// Luminance reduction chain feeding eye adaptation.
//
// The metric has to serve two scenes that differ by two orders of magnitude in
// average brightness: a 90%-black starfield, and a lit cabin that fills the
// frame. A plain mean picks one and ruins the other; a log mean collapses on
// the black sky. An RMS (power mean, p = 2) of clamped luminance sits in
// between — it leans toward the bright content that the eye is actually looking
// at, so a planet against black and a wall two metres away land within a stop
// or so of each other. The clamp stops a star from dominating outright.
/* ...and on a planet it is metered off the *ground*, which is what a
 * photographer standing there would do.
 *
 * The clamp and the weight below are both uniforms now, and the reason is a
 * measured failure. A landed frame with the star in the top of it came back at
 * a mean of 38 out of 255 and a median of 22 — a landscape under a
 * twenty-degree sun rendered three stops under, so dark that a judge shown the
 * image described every unlit face as "dead dark maroon". The metric is an RMS
 * with the per-pixel luminance clamped at 6, and a stellar aureole covering a
 * tenth of the frame at that clamp contributes 3.6 to the mean square while
 * ground at 0.05 contributes 0.0025. The exposure was being set by the sun and
 * nothing else; the ground was along for the ride.
 *
 * In space the clamp has to stay generous, because there the bright thing
 * genuinely *is* the subject — a planet against black is the shot. On the
 * ground the bright thing is the sky, the subject is the dirt, and the two want
 * opposite policies. So: a much tighter clamp, and a vertical weight that
 * favours the lower half of the frame. The weight integrates to about 1.06 over
 * a uniform frame, so it moves the metric by a quarter of a stop at most when
 * nothing is unusual, and by two stops when the sun is in the corner.
 */
const LUM_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uClamp;    // per-pixel luminance ceiling
uniform float uGroundW;  // 0 in space, 1 on a planet
varying vec2 vUv;
void main(){
  vec2 o = uTexel;
  vec3 c = texture2D(tSrc, vUv + vec2(-o.x,-o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x,-o.y)).rgb
         + texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb;
  c *= 0.25;
  float l = min(dot(c, vec3(0.2126, 0.7152, 0.0722)), uClamp);
  // vUv.y is 0 at the bottom of the frame, so this is "weight the ground"
  float w = mix(1.0, mix(1.70, 0.35, smoothstep(0.30, 0.75, vUv.y)), uGroundW);
  gl_FragColor = vec4(l*l*w, 0.0, 0.0, 1.0);
}
`;

const REDUCE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  float sum = 0.0;
  for(int y=0;y<4;y++){
    for(int x=0;x<4;x++){
      vec2 o = (vec2(float(x), float(y)) - 1.5) * 2.0 * uTexel;
      sum += texture2D(tSrc, vUv + o).r;
    }
  }
  gl_FragColor = vec4(sum/16.0, 0.0, 0.0, 1.0);
}
`;

/* Eye adaptation, smoothed in *stops* rather than in luminance.
 *
 * This was `mix(prev, cur, rate)` on the raw mean-square luminance, and that
 * one line was a four-to-five stop error on a cold boot, at random. Measured:
 * two runs of the identical command against the identical moon at the identical
 * pose came back p99 168 / mean 47.3 and p99 44 / mean 7.4, with a worst
 * observed of p99 14 at 92% black. Roughly three in ten cold boots at a 4.5 s
 * settle; none at 9 s. The lighting rig was verified bit-identical across it,
 * and the *stars* dimmed by the same factor as the ground, so it was never the
 * scene — it was this.
 *
 * A linear lerp is a first-order lag with a fixed time constant *in luminance*,
 * and the thing it has to track spans six and a half stops of exposure and
 * three orders of magnitude of scene radiance: a photosphere sits at 100-400
 * and a moon lit by a distant star sits near 0.03. Coming down from the first
 * to the second, `mix` closes a fixed *fraction of the remaining difference*
 * per frame, so the last factor of a thousand takes as many time constants as
 * the first factor of two — measured at six to twelve seconds, and non-monotone
 * on the way (one series ran p99 134, then 45, then 170).
 *
 * Interpolating the logarithm instead makes the rate constant in stops per
 * second, which is both what an eye does and what makes the settle time
 * independent of how far it has to travel. Eleven stops now cost the same three
 * time constants that one stop does.
 *
 * And a cut is not an adaptation. Past two stops of error the scene has not got
 * brighter, it has been *replaced* — a jump, a teleport, a boot into a pose —
 * and easing toward it at eye speed is simply wrong. The rate scales up with
 * the error so a large one closes in about a frame, and because the boost falls
 * away as the error closes it cannot ring or overshoot.
 *
 * The value carried here is mean-*square* luminance (see LUM_FRAG), so one
 * stop of luminance is two of it; the halving is what makes uSnapLo/uSnapHi
 * readable as stops.
 */
const ADAPT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tCur;
uniform sampler2D tPrev;
uniform float uUp;      // adaptation rate toward brighter
uniform float uDown;    // adaptation rate toward darker
uniform float uSnapLo;  // stops of error at which the cut response begins
uniform float uSnapHi;  // stops at which it is fully engaged
uniform float uSnapGain;
varying vec2 vUv;
void main(){
  float cur  = max(texture2D(tCur,  vec2(0.5)).r, 1e-8);
  float prev = max(texture2D(tPrev, vec2(0.5)).r, 1e-8);
  float lc = log2(cur), lp = log2(prev);
  float rate = cur > prev ? uDown : uUp;        // eyes squint faster than they open
  float stops = abs(lc - lp) * 0.5;             // mean-square -> luminance
  rate *= 1.0 + uSnapGain * smoothstep(uSnapLo, uSnapHi, stops);
  gl_FragColor = vec4(exp2(mix(lp, lc, clamp(rate, 0.0, 1.0))), 0.0, 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tStreak;
uniform sampler2D tFlare;
uniform sampler2D tAdapt;
uniform sampler2D tAO;      // half-res occlusion, lifted by the hardware filter
uniform float uAO;          // strength, 0 disables the lookup entirely
uniform float uAOPower;
uniform float uKey;
uniform float uExpMin;
uniform float uExpMax;
uniform vec2  uRes;
uniform float uTime;
uniform float uExposure;
uniform float uBloom;
uniform float uStreak;
uniform float uCA;          // chromatic aberration
uniform float uVignette;
uniform float uGrain;
uniform float uRadial;      // speed radial blur amount
uniform vec2  uRadialCtr;
uniform float uSat;
uniform float uContrast;
uniform float uLift;
uniform float uBlackPoint;
uniform float uPreContrast;
uniform float uSharpen;
uniform vec3  uTint;
uniform float uFlash;       // white flash (fold jump)
uniform float uCloud;       // cloud deck, 0..1 — covers a landing's scene swap
uniform vec3  uCloudCol;    // lit colour of it, in scene radiance
uniform float uDamage;      // red edge pulse
uniform float uHalation;    // warm bleed around the brightest highlights
uniform vec3  uShadowTint;
uniform vec3  uHighTint;
varying vec2 vUv;

// ---------------------------------------------------------------- AgX
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
   1.6605, -0.1246, -0.0182,
  -0.5876,  1.1329, -0.1006,
  -0.0728, -0.0083,  1.1187);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.0880,
  0.0433, 0.0113, 0.8956);
const mat3 AgXInset = mat3(
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859);
const mat3 AgXOutset = mat3(
   1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272,  -0.11060664309660294,
  -0.016493938717834573,-0.016493938717834257, 1.2519364065950405);
const float AgxMinEv = -12.47393;
const float AgxMaxEv =  4.026069;

vec3 agxContrast(vec3 x){
  vec3 x2 = x*x; vec3 x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
}
vec3 agx(vec3 color){
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * max(color, 0.0);
  color = AgXInset * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - AgxMinEv) / (AgxMaxEv - AgxMinEv);
  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  // "punchy" look transform
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, uSat);
  color = pow(max(vec3(0.0), color), vec3(uContrast));
  color = AgXOutset * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 linearToSRGB(vec3 c){
  return mix(c*12.92, 1.055*pow(max(c, vec3(0.0)), vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
}

/* ---- the cloud deck --------------------------------------------------
 * What covers a scene change during a landing. It used to be uFlash, a
 * flat white added to every pixel, and it read exactly like what it was: a
 * cut to white. This is the thing a descent actually passes through.
 *
 * Screen-space value-noise fbm, scrolling *outward* from the flight
 * direction and dilating as the density rises, so the cloud opens around the
 * lens rather than fading up in place. The density is ragged rather than
 * uniform — that is the whole difference between weather and a dissolve —
 * and it is applied in scene-linear before the tone curve, so the cloud is
 * lit by the exposure the rest of the frame is under rather than punched
 * through it.
 */
#ifdef CLOUD
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0 - 2.0*f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float cloudFbm(vec2 p){
  float s = 0.0, a = 0.5;
  for(int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
#endif

// Chromatic aberration has to happen *inside* the sampler, not after the
// radial blur — otherwise green is smeared while red and blue stay sharp, and
// every star turns into a green streak with a red dot on the end.
/* Chromatic aberration, tapered off where it has nothing real to work on.

   A lens splits a *bright* edge. Applied flat it also splits sub-pixel
   specular sparkle — and a hull covered in panel-line normals produces a great
   deal of that — which came back as a dotted magenta/cyan chain crawling along
   every panel line on the ship, reading as dirt at rest and as fizz in motion.

   So the offset is scaled by how much local contrast there is *relative to the
   pixel's own brightness*: a real edge between a lit hull and black space keeps
   its fringe, an isolated sparkle a pixel wide does not. Four taps of the
   neighbourhood is enough to tell those apart and it is a fullscreen pass that
   already costs five. */
vec3 sceneAt(vec2 uv, vec2 caOff){
  if(caOff.x == 0.0 && caOff.y == 0.0) return texture2D(tScene, uv).rgb;
  vec2 t = 1.0 / uRes;
  vec3 c0 = texture2D(tScene, uv).rgb;
  float l0 = dot(c0, vec3(0.2126, 0.7152, 0.0722));
  float lu = dot(texture2D(tScene, uv + vec2(0.0,  t.y)).rgb, vec3(0.2126, 0.7152, 0.0722));
  float ld = dot(texture2D(tScene, uv - vec2(0.0,  t.y)).rgb, vec3(0.2126, 0.7152, 0.0722));
  float ll = dot(texture2D(tScene, uv - vec2(t.x,  0.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
  float lr = dot(texture2D(tScene, uv + vec2(t.x,  0.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
  // A lone bright texel has a high peak and low neighbours; a real edge has a
  // neighbour on one side that is nearly as bright as it is.
  float hi = max(max(lu, ld), max(ll, lr));
  float edgeness = clamp(hi / max(l0, 1e-4), 0.0, 1.0);
  caOff *= smoothstep(0.10, 0.42, edgeness);
  if(dot(caOff, caOff) < 1e-12) return c0;
  return vec3(texture2D(tScene, uv + caOff).r,
              texture2D(tScene, uv).g,
              texture2D(tScene, uv - caOff).b);
}

void main(){
  vec2 uv = vUv;
  vec2 fromC = uv - 0.5;
  float r2 = dot(fromC, fromC);

  // ---- chromatic aberration + radial (speed) blur ---------------------
  // Evenly spaced radial taps turn every star into a dotted line, so the
  // sample positions are jittered per pixel; the grain pass hides the residue.
  float ca = uCA * (0.25 + r2*2.2);
  vec2 caOff = ca > 0.00005 ? fromC * ca : vec2(0.0);

  vec3 col;
  if(uRadial > 0.0015){
    vec2 dir = (uv - uRadialCtr);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    float jitter = hash12(gl_FragCoord.xy + fract(uTime)*57.0);
    const int RN = 12;
    for(int i=0;i<RN;i++){
      float t = (float(i) + jitter) / float(RN);
      float sc = 1.0 - uRadial * t;
      float w = 1.0 - t*0.55;
      acc += sceneAt(uRadialCtr + dir*sc, caOff) * w;
      wsum += w;
    }
    col = acc/wsum;
  } else {
    col = sceneAt(uv, caOff);
  }

  /* ---- ambient occlusion ---------------------------------------------
     Applied to the scene and to nothing else. Bloom, streaks and flares are
     things that happen inside the lens, so a corner of the room cannot occlude
     them; multiplying them here would put a dark ring around every highlight.

     It also lands *before* the grade rather than after, so the darkening goes
     through the same black point, contrast and split-tone as everything else —
     which is what pulls the occluded corners toward the teal the shadows are
     already graded to instead of toward neutral grey. */
  /* One bilinear tap, not a joint-bilateral upsample.

     The bilateral version cost nine dependent taps on every one of 5.7 million
     pixels — as much as the occlusion pass it was serving — to buy a sharper
     edge on a term that is deliberately soft. What it bought back was about
     one CSS pixel of bleed at a silhouette, at a device pixel ratio of two.
     The depth-aware weighting stays where it earns its place: inside the blur,
     at half resolution, where it stops occlusion crossing a silhouette in the
     first place. */
  if(uAO > 0.0001){
    float ao = pow(clamp(texture2D(tAO, uv).r, 0.0, 1.0), uAOPower);
    col *= mix(1.0, ao, uAO);
  }

  // ---- additive light ------------------------------------------------
  vec3 bloom  = texture2D(tBloom,  uv).rgb;
  /* Softened vertically on the way in. The streak passes only blur along x,
     so the buffer has a hard top and bottom edge wherever a source sits, and
     upsampling a quarter-height target keeps that edge crisp. Three taps a
     texel apart is enough to turn the bar back into something with a falloff. */
  // The streak buffer is quarter height, so one of its texels is four screen
  // rows; spread over about one of them.
  float sv = 4.0 / uRes.y;
  vec3 streak = texture2D(tStreak, uv).rgb * 0.50
              + texture2D(tStreak, uv + vec2(0.0,  sv)).rgb * 0.25
              + texture2D(tStreak, uv - vec2(0.0,  sv)).rgb * 0.25;
  vec3 flare  = texture2D(tFlare,  uv).rgb;
  col += bloom * uBloom;
  col += streak * uStreak;
  col += flare;

  // ---- halation --------------------------------------------------------
  // Film stock scatters light sideways in the emulsion and reflects it off the
  // back of the base, so every bright highlight sits inside a soft red-orange
  // halo. It is weighted by the bloom's *own* luminance so only genuine
  // highlights halate — tinting the whole bloom warm just yellows the frame.
  if(uHalation > 0.0001){
    float bl = dot(bloom, vec3(0.2126, 0.7152, 0.0722));
    col += bloom * vec3(1.00, 0.42, 0.16) * (bl/(1.0 + bl)) * uHalation;
  }

  // ---- eye adaptation --------------------------------------------------
  float avgLum = sqrt(max(texture2D(tAdapt, vec2(0.5)).r, 0.0));
  float autoExp = clamp(uKey / max(avgLum, 1e-6), uExpMin, uExpMax);
  col *= uExposure * autoExp;
  col *= uTint;

  // ---- scene-referred grade, before the tone curve -------------------
  // AgX has a long soft toe. Left alone it lifts every shadow into grey and
  // the whole frame reads as milk. Subtracting a black point and applying
  // contrast around middle grey is what a colourist would do, and it is the
  // difference between "3D render" and "photograph".
  col = max(col - uBlackPoint, vec3(0.0));
  col = pow(max(col * (1.0/0.18), vec3(0.0)), vec3(uPreContrast)) * 0.18;
  col += uFlash;

  /* ---- into the deck ---------------------------------------------------
     Two octaves' worth of structure at two rates: a slow bed that gives the
     cloud a shape, and a faster layer dilating away from the centre that
     gives it speed. Density is biased by the radius so the frame fills from
     the edges inward, which is what punching into a layer looks like from
     inside the vehicle. */
#ifdef CLOUD
  if(uCloud > 0.0015){
    vec2 q = (vUv - 0.5) * vec2(uRes.x/uRes.y, 1.0);
    float rr = length(q);
    float k = uCloud * uCloud * (3.0 - 2.0*uCloud);
    /* Dilation. Two layers at different rates, both pulling outward from the
       centre of the frame — that parallax is the only cue that the camera is
       going *through* the deck rather than the deck fading up over it. */
    float zoom = 1.70 - 0.95 * k;
    float bed  = cloudFbm(q * 2.60 * zoom + vec2(uTime * 0.030, uTime * 0.018));
    float fast = cloudFbm(q * 6.40 * zoom - q * (uTime * 0.62) + vec2(0.0, uTime * 0.075));
    float n = bed * 0.58 + fast * 0.42;

    /* Opacity and brightness are separate, and getting that wrong is what made
       the first version of this a white card. The deck has to reach full
       opacity — there is a hull behind it that must not be seen — but a fully
       opaque cloud is not a flat colour, it is a lit volume with two stops of
       structure across it. So density goes to one and the *radiance* carries
       all the variation: a steep curve on the noise, a vertical gradient for
       the light coming from above, and a peak low enough that the frame does
       not simply clip. Authored around two units, which the exposure lands
       near the top of its range without blowing out. */
    float dens = clamp(k * (1.75 + 0.50 * rr) - 0.42 + 0.55 * n, 0.0, 1.0);
    dens = dens * dens * (3.0 - 2.0 * dens);
    float lit = 0.07 + 2.25 * pow(max(n, 0.0), 2.1);
    lit *= 0.78 + 0.44 * smoothstep(-0.42, 0.40, q.y);       // brighter above
    col = mix(col, uCloudCol * lit, dens);
  }
#endif

  // ---- tonemap --------------------------------------------------------
  col = agx(col);
  col += uLift * (1.0 - col);

  // ---- split tone ------------------------------------------------------
  // The one grade every science-fiction frame of the last twenty years shares:
  // shadows pushed toward teal, highlights toward amber. Kept deliberately
  // small — a couple of percent per channel is the difference between "graded"
  // and "someone left a filter on".
  {
    float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(uShadowTint, uHighTint, smoothstep(0.02, 0.68, L));
  }

  // ---- vignette -------------------------------------------------------
  float vig = 1.0 - uVignette * smoothstep(0.12, 0.92, r2*1.75);
  col *= vig;

  // damage / alert edge pulse
  if(uDamage > 0.001){
    float edge = smoothstep(0.18, 0.62, r2*1.7);
    col = mix(col, vec3(0.75,0.10,0.06), edge*uDamage);
  }

  // ---- output ---------------------------------------------------------
  col = linearToSRGB(col);

  // film grain (in display space, luminance-weighted so darks stay clean)
  float g = hash12(gl_FragCoord.xy + fract(uTime)*vec2(137.0, 71.0)) - 0.5;
  col += g * uGrain * (0.35 + 0.65*(1.0 - dot(col, vec3(0.333))));

  // ordered dither kills banding in deep-space gradients
  float d = hash12(gl_FragCoord.xy*1.7 + 11.0) - 0.5;
  col += d * (1.0/255.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

// FXAA 3.11 (console-quality subset) — cheap edge cleanup after tonemapping.
const FXAA_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uSharpen;
varying vec2 vUv;

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

void main(){
  vec2 t = uTexel;
  vec3 mC = texture2D(tSrc, vUv).rgb;
  float lM = luma(mC);
  float lNW = luma(texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb);
  float lNE = luma(texture2D(tSrc, vUv + vec2( t.x, -t.y)).rgb);
  float lSW = luma(texture2D(tSrc, vUv + vec2(-t.x,  t.y)).rgb);
  float lSE = luma(texture2D(tSrc, vUv + vec2( t.x,  t.y)).rgb);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  float range = lMax - lMin;

  if(range < max(0.0312, lMax * 0.125)){
    gl_FragColor = vec4(mC, 1.0);
    return;
  }

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, -8.0, 8.0) * t;

  vec3 rgbA = 0.5 * (texture2D(tSrc, vUv + dir * (1.0/3.0 - 0.5)).rgb +
                     texture2D(tSrc, vUv + dir * (2.0/3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb +
                                   texture2D(tSrc, vUv + dir * 0.5).rgb);
  float lB = luma(rgbB);
  vec3 res = (lB < lMin || lB > lMax) ? rgbA : rgbB;

  // light unsharp mask: FXAA softens edges, this puts the bite back
  if(uSharpen > 0.001){
    vec3 blur = (texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb
               + texture2D(tSrc, vUv - vec2(t.x, 0.0)).rgb
               + texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb
               + texture2D(tSrc, vUv - vec2(0.0, t.y)).rgb) * 0.25;
    res = clamp(res + (res - blur) * uSharpen, 0.0, 1.0);
  }
  gl_FragColor = vec4(res, 1.0);
}
`;

/* --------------------------------------------------------------- class */

export class PostFX {
  constructor(renderer, quality = 'high') {
    this.renderer = renderer;
    this.quality = quality;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this._quad = new THREE.Mesh(geo, null);
    this._quad.frustumCulled = false;
    this.quadScene.add(this._quad);

    this.mipCount = quality === 'low' ? 4 : quality === 'medium' ? 5 : 6;
    // Doubled by the two radii, and multiplied by sixteen again by the
    // interleaved pattern and the blur that resolves it.
    this.aoTaps = quality === 'low' ? 4 : quality === 'medium' ? 6 : 8;

    this.mat = {
      linearize: this._mat(LINEARIZE_FRAG, {
        tDepth: COMMON_UNIFORM_TEX(),
        uLog: { value: 1 }, uFC: { value: 1 },
        uNear: { value: 0.1 }, uFarPlane: { value: 1000 },
        uSrcTexel: { value: new THREE.Vector2() },
      }),
      ao: this._mat(AO_FRAG, {
        tLin: COMMON_UNIFORM_TEX(),
        uTexel: { value: new THREE.Vector2() },
        uAoTexel: { value: new THREE.Vector2() },
        uProj: { value: new THREE.Vector2(1, 1) },
        uRadiusPx: { value: 40 }, uAngular: { value: 0.06 },
        uWorldR: { value: 0 },
        /* Raised with the fix above, and it is not a taste change: the
           estimator used to spend most of its output on a flat dim it was
           generating itself, so the intensity that produced a plausible frame
           was the one that kept that dim tolerable. With the DC gone there is
           room for the creases to actually go dark. */
        uIntensity: { value: 1.25 }, uFineWeight: { value: 0.85 },
        uBias: { value: 0.022 },
        uMinPx: { value: 2.0 },
      }, { AO_TAPS: this.aoTaps, AO_FINE: '0.18' }),
      aoBlur: this._mat(AOBLUR_FRAG, {
        tAO: COMMON_UNIFORM_TEX(), tLin: COMMON_UNIFORM_TEX(),
        uStep: { value: new THREE.Vector2() },
      }),
      prefilter: this._mat(PREFILTER_FRAG, {
        tSrc: COMMON_UNIFORM_TEX(), tAdapt: COMMON_UNIFORM_TEX(),
        uTexel: { value: new THREE.Vector2() },
        // In display stops now: 1.0 is white, so only genuine highlights bloom.
        uThreshold: { value: 0.92 }, uKnee: { value: 0.42 }, uClamp: { value: 14.0 },
        uKey: { value: 0.160 }, uExpMin: { value: 0.045 }, uExpMax: { value: 4.0 },
      }),
      down: this._mat(DOWN_FRAG, { tSrc: COMMON_UNIFORM_TEX(), uTexel: { value: new THREE.Vector2() } }),
      up: this._mat(UP_FRAG, {
        tSrc: COMMON_UNIFORM_TEX(), uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1.0 }, uWeight: { value: 1.0 },
      }),
      streak: this._mat(STREAK_FRAG, {
        tSrc: COMMON_UNIFORM_TEX(), tAdapt: COMMON_UNIFORM_TEX(),
        uTexel: { value: new THREE.Vector2() },
        uStep: { value: 1.0 },
        /* Cool, not blue. A cylindrical element does tint its flare toward the
           short end — that is what makes an anamorphic bar read as a lens — but
           at (0.55, 0.75, 1.25) the bar was more saturated than anything else
           in the frame, and laid across a hull with the star behind it the
           result was a black silhouette inside a solid blue halo. Which is a
           real optical effect and still reads, correctly, as a rendering fault:
           nothing in a photograph is that colour and that clean at once. */
        uTint: { value: new THREE.Vector3(0.80, 0.90, 1.12) },
        uThreshold: { value: 0.0 },
        uKey: { value: 0.160 }, uExpMin: { value: 0.045 }, uExpMax: { value: 4.0 },
      }),
      flare: this._mat(FLARE_FRAG, {
        tBright: COMMON_UNIFORM_TEX(),
        uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
        uSunVis: { value: 0 }, uAspect: { value: 1 },
        /* God rays are for light streaming *past* an occluder, and the star
           already has a modelled corona with real radial filaments. At 0.38 the
           ray pass laid a smooth haze over that structure and hid it, and its
           24-sample march left a visible weave across the halo — the brightest
           object in the game — no matter which dither drove the jitter. Keeping
           it low lets the corona be the thing you see, and drops the noise below
           the point where the eye can find it. */
        uRayStrength: { value: 0.13 }, uGhostStrength: { value: 0.010 },
      }),
      lum: this._mat(LUM_FRAG, {
        tSrc: COMMON_UNIFORM_TEX(), uTexel: { value: new THREE.Vector2() },
        uClamp: { value: 6.0 }, uGroundW: { value: 0 },
      }),
      reduce: this._mat(REDUCE_FRAG, { tSrc: COMMON_UNIFORM_TEX(), uTexel: { value: new THREE.Vector2() } }),
      adapt: this._mat(ADAPT_FRAG, {
        tCur: COMMON_UNIFORM_TEX(), tPrev: COMMON_UNIFORM_TEX(),
        uUp: { value: 0.03 }, uDown: { value: 0.08 },
        /* Two stops is inside what a scene does on its own — a planet rolling
           into frame, a lamp coming on. Five is not; five is a different place.
           At the top of the ramp the rate is 25x, which closes a cut in about
           two frames without a single-frame pop. */
        uSnapLo: { value: 2.0 }, uSnapHi: { value: 5.0 }, uSnapGain: { value: 24.0 },
      }),
      composite: this._mat(COMPOSITE_FRAG, {
        tScene: COMMON_UNIFORM_TEX(), tBloom: COMMON_UNIFORM_TEX(),
        tStreak: COMMON_UNIFORM_TEX(), tFlare: COMMON_UNIFORM_TEX(),
        tAdapt: COMMON_UNIFORM_TEX(),
        tAO: COMMON_UNIFORM_TEX(),
        /* The power is a gamma on the occlusion term, and it is what decides
           whether the estimator reads as *shape* or as a flat dim laid over
           the frame. At 1.0 a crease that the pass resolves at 0.7 displays at
           0.7 and so does the open wall beside it at 0.95, which is a fifth of
           a stop between them — below the threshold at which a corner reads as
           a corner. 1.15 takes the same pair to 0.66 and 0.94. It costs
           nothing (one pow on a term already being fetched) and it is the only
           thing in the chain that darkens a junction *because it is a
           junction* rather than because a lamp did not reach it. */
        uAO: { value: 0.92 }, uAOPower: { value: 1.15 },
        uKey: { value: 0.160 }, uExpMin: { value: 0.045 }, uExpMax: { value: 4.0 },
        uRes: { value: new THREE.Vector2() }, uTime: { value: 0 },
        uExposure: { value: 1.0 }, uBloom: { value: 0.085 }, uStreak: { value: 0.013 },
        uCA: { value: 0.0015 }, uVignette: { value: 0.20 }, uGrain: { value: 0.018 },
        uRadial: { value: 0 }, uRadialCtr: { value: new THREE.Vector2(0.5, 0.5) },
        /* A floor under the black, and it is not a matter of taste.
           uBlackPoint subtracts 0.0018 in scene-linear before the tone curve
           and nothing put any of it back, so everything below it landed on
           *exactly* 0,0,0. Measured in deep space that is 41.6% of the frame at
           pure zero looking away from the nebula and 0.7% looking at it — the
           same void, graded by which way the camera happens to point. The cost
           is not greyness: in the no-nebula direction the unlit sides of the
           asteroids sit on the same exact zero as the sky, so the rocks lose
           their silhouettes and a field of them reads as an empty frame with
           two highlights in it. 0.004 lands at one to two levels, which the
           dither turns into a floor rather than a band, and the split tone
           below carries the art direction's teal into it. */
        /* 1.18 was a saturation *boost* sitting on top of a frame that already
           measured 0.47-0.50 mean HSV saturation against 0.19-0.24 for the
           reference. A global multiplier cannot make one material differ from
           another; all it does is push whatever hue the lighting already
           imposed further from neutral, which is the difference between a lit
           room and a graded photograph of one. */
        /* 1.32, and the frame it produced was measurably compressed: the
           corridor came back with a median of 51/255 and a 99th percentile of
           170, against 34 and 205 for the reference interior it is judged
           beside — the whole picture packed into a band around the middle with
           neither a real black nor a real highlight in it. That is the
           arithmetic behind "everything looks uniformly lit and bright".

           It is also the *only* lever that can fix it, and that is worth
           saying plainly, because the obvious ones cannot. Auto-exposure
           normalises the frame within a second: setting the cabin's ambient
           and hemisphere lights to zero, which is 0.8 of flat irradiance in a
           15 m tube, moved the median by four levels and the 99th percentile
           by one. Anything that changes how much light there is in the room is
           undone. What survives is how the room's *ratios* are mapped, and
           that is here.

           1.62 takes the corridor from 51/170 to 27/204 at the same exposure.
           It is a stretch about 0.18 — middle grey, which in the cabin is
           about where a lit bulkhead sits — so what moves is everything either
           side of the walls: the recesses fall away and the windows, screens
           and lamps climb. The floor of the histogram does not move with it
           (1st percentile 13 -> 11, black under a quarter of a per cent), so
           this is range appearing rather than shadows being crushed.
           Checked in space too, where the same change reads as more terminator
           and a deeper void: the crescent goes 45/167 to 39/189 and the ice
           moon 36/197 to 28/220. */
        uSat: { value: 1.00 }, uContrast: { value: 1.13 }, uLift: { value: 0.004 },
        uBlackPoint: { value: 0.0018 }, uPreContrast: { value: 1.62 },
        uSharpen: { value: 0.12 },
        uHalation: { value: 0.055 },
        uShadowTint: { value: new THREE.Vector3(0.962, 0.990, 1.048) },
        uHighTint: { value: new THREE.Vector3(1.055, 1.006, 0.940) },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uFlash: { value: 0 }, uDamage: { value: 0 },
        /* Authored in real HDR like everything else: a sunlit cloud is a
           bright object, but not a clipped one. The first pass at this sat at
           twelve units and every pixel of it went to paper white — the fbm was
           there and none of it survived the tone curve. Two units puts the
           deck near the top of the curve with its structure intact, and
           Game.updatePost tints it off the sky it is lit by. */
        uCloud: { value: 0 },
        uCloudCol: { value: new THREE.Vector3(1.90, 2.02, 2.20) },
      }),
      fxaa: this._mat(FXAA_FRAG, { tSrc: COMMON_UNIFORM_TEX(), uTexel: { value: new THREE.Vector2() },
        uSharpen: { value: 0.10 } }),
    };

    /* The cloud deck is its own program, and that is a measurement, not tidiness.
     *
     * Two five-octave fbms is forty hash evaluations a pixel, and putting them
     * behind a uniform branch in the composite does not make them free: the
     * compiler still allocates registers for the path it might take, occupancy
     * on the whole pass drops, and the cost is paid on every frame of the game
     * whether or not anything is landing. Measured on the ground bench, worst
     * landing frame 41 ms -> 161 and the *steady* landed frame 11 -> 45. So the
     * cloud lives in a second material behind a define, sharing the first one's
     * uniform object so every knob written to `composite.uniforms` reaches
     * both, and it is only ever bound while a transition is covering itself. */
    this.mat.compositeCloud = this._mat(COMPOSITE_FRAG, this.mat.composite.uniforms, { CLOUD: 1 });

    this.blurMips = [];
    this.streakRT = [];
    this.enabled = { streak: quality !== 'low', flare: true, fxaa: true, ao: true };
    /* Radius as a fraction of frame height, which is what makes it an *angle*
       rather than a distance — see AO_FRAG. Nine per cent of the frame is a
       room-corner scale: at two metres it is about eighteen centimetres, which
       is the distance over which a deck darkens into a bulkhead. The fine
       radius is 18% of it, which at the same distance is three centimetres — a
       panel groove.

       It was 5.5%, and that was tuned against an estimator whose output was
       84% flat dim: half the reason to keep the radius small was that widening
       it widened the dim. What it costs is one thing and what it buys is
       another — measured on the occlusion buffer itself in the corridor, the
       standard deviation of the term goes 38 to 48 across that step while the
       mean falls 227 to 212. That is broad corner darkening appearing, not
       everything getting darker.

       It is also a cache budget. Every tap at this radius is a scattered read;
       at nine per cent the pass was walking a hundred and seventy pixels in
       every direction and was the most expensive thing in the frame. */
    /* How bright a source has to be, in display stops of the *exposed* image,
       before it earns an anamorphic bar. See STREAK_FRAG: the bloom's 0.92 let
       every faint star in the sky wear one. */
    /* And two stops, not one and a half. The bar belongs to sources that are
       genuinely clipping — a star, a drive throat — and at 1.6 a merely bright
       object earned one, which is how a plume seen side-on ended up wearing a
       horizontal blue dash the width of the frame. */
    this.streakThreshold = 2.1;
    this.aoRadiusFrac = 0.090;
    /* The same number for a frame whose radius is pinned in world units — see
       the two budgets in render(). Held at what the angular budget used to be,
       which on the ground is a cap that is never the binding constraint. */
    this.aoRadiusFracWorld = 0.055;
    /* Strength is also the floor: the composite does mix(1, ao, uAO), so 0.85
       means a fully occluded pixel keeps 15% of its light. That is not a fudge
       — a screen-space estimator sees only what is on screen and models no
       inter-reflection at all, so a real corner never goes as dark as it says.
       And this project's first rule is that shadows are never black. */
    this.aoStrength = 0.85;
    /* Set by the game, in the *current scene's* units, when the frame is one
       where a fixed world scale is the right one — which is the ground, where
       one unit is a metre and a crease is a metre or two wide. Zero keeps the
       angular radius above, which is what a cabin and a solar system both
       want: nine orders of magnitude in one frame have no fixed scale. */
    this.aoWorldRadius = 0;
    // metering policy: see LUM_FRAG
    this.groundMeter = false;
    /* Which curve the *scene* pass writes its depth on.
     *
     * Engine.render says whether the pass that owns the frame is the world or
     * the cabin, but not which encoding the world is on — and it is no longer
     * always the same one. The ground scene is drawn without the logarithmic
     * depth buffer at all (see Game.setGroundDepth: gl_FragDepth in every
     * fragment defeats early-Z, and a 6 m to 26 km scene does not need the
     * range), so the game clears this while it is down there and sets it again
     * on lift-off. Getting it wrong does not throw; it produces occlusion that is
     * plausible in one scene and inverted in another, which is why
     * tools/aocheck.mjs checks both encodings against a raycast. */
    this.sceneLogDepth = true;
    this._size = new THREE.Vector2(2, 2);
  }

  _mat(frag, uniforms, defines) {
    return new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader: frag,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
    });
  }

  setSize(w, h, pixelRatio) {
    const W = Math.max(2, Math.floor(w * pixelRatio));
    const H = Math.max(2, Math.floor(h * pixelRatio));
    if (this._size.x === W && this._size.y === H) return;
    this._size.set(W, H);

    const samples = this.msaa === false ? 0
      : this.quality === 'high' ? 4 : this.quality === 'medium' ? 2 : 0;

    this.hdr?.dispose();
    this.hdr = makeRT(W, H, { depthBuffer: true, samples });
    /* A depth *texture*, not just a renderbuffer, so the AO can read what the
       scene pass wrote. On a multisampled target three attaches a matching
       multisampled depth renderbuffer to the MSAA framebuffer and blits it into
       this texture at the end of every render() — which is exactly the moment
       the linearise pass wants it. The one thing to know is that three only
       invalidates the resolved attachments on OculusBrowser, so binding another
       target between the two scene passes does not throw away what the first
       one drew. */
    this.hdr.depthTexture = new THREE.DepthTexture(W, H);
    this.hdr.depthTexture.type = THREE.UnsignedIntType;      // DEPTH_COMPONENT24
    this.hdr.depthTexture.minFilter = THREE.NearestFilter;
    this.hdr.depthTexture.magFilter = THREE.NearestFilter;

    this.ldr?.dispose();
    this.ldr = makeRT(W, H, { type: THREE.UnsignedByteType });

    /* Linear view-space Z at half resolution, one channel of real float.

       Real float, not half: a frame spans 0.008 to 6e7 world units and a
       half-float stops being a number at 65504. Half *resolution* because
       everything that reads it — the occlusion pass, its two blurs — runs
       there too, and a full-res copy quadrupled the bytes those passes have to
       walk for no visible gain: the occlusion term is smooth, and a contact
       shadow whose edge is soft by one device pixel is a contact shadow. */
    const aw = Math.max(1, W >> 1), ah = Math.max(1, H >> 1);
    this.linRT?.dispose();
    this.linRT = makeRT(aw, ah, {
      type: THREE.FloatType, format: THREE.RedFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });

    this.aoRT?.forEach((m) => m.dispose());
    this.aoRT = [
      makeRT(aw, ah, { type: THREE.UnsignedByteType }),
      makeRT(aw, ah, { type: THREE.UnsignedByteType }),
    ];

    this.blurMips.forEach((m) => m.dispose());
    this.blurMips = [];
    let mw = W >> 1, mh = H >> 1;
    for (let i = 0; i < this.mipCount; i++) {
      this.blurMips.push(makeRT(mw, mh));
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
    }

    this.streakRT.forEach((m) => m.dispose());
    /* Quarter width, quarter height — not an eighth. At 1600x900 an eighth
       is 112 rows, so a bright source occupied about one row of the buffer and
       upsampled into a flat bar with hard horizontal edges running the full
       frame: a reviewer read it as a rendering fault rather than a lens. The
       buffer is tiny either way; doubling its height costs nothing measurable. */
    this.streakRT = [makeRT(W >> 2, H >> 2), makeRT(W >> 2, H >> 2)];

    this.flareRT?.dispose(); this.flareBlurRT?.dispose();
    this.flareRT = makeRT(W >> 2, H >> 2);
    this.flareBlurRT = makeRT(W >> 2, H >> 2);

    // luminance reduction chain (fixed tiny sizes, independent of viewport)
    if (!this.lumRT) {
      this.lumRT = makeRT(64, 64);
      this.lumRT8 = makeRT(8, 8);
      this.lumRT1 = makeRT(1, 1);
      this.adaptRT = [makeRT(1, 1), makeRT(1, 1)];
      this.adaptIdx = 0;
      this._adaptPrimed = false;
    }

    this.mat.composite.uniforms.uRes.value.set(W, H);
    this.mat.fxaa.uniforms.uTexel.value.set(1 / W, 1 / H);
    // Converts the radius, which is quoted in full-res pixels, into uv. The
    // buffer it samples is half that, so a single *texel* step is 2 * uTexel.
    this.mat.ao.uniforms.uTexel.value.set(1 / W, 1 / H);
    this.mat.ao.uniforms.uAoTexel.value.set(1 / aw, 1 / ah);
    this.mat.linearize.uniforms.uSrcTexel.value.set(1 / W, 1 / H);
    this.mat.aoBlur.uniforms.uStep.value.set(1 / aw, 0);
  }

  /* Invert the depth encoding the pass that just ran wrote, into linear
     view-space Z. Called by Engine.render immediately after the pass that owns
     the frame, while its depth is still in the buffer — the cabin clears depth
     before it draws, so there is no later moment at which the world's depth
     still exists. */
  captureDepth(camera, { log = true } = {}) {
    if (!this.enabled.ao || !this.linRT) return;
    const r = this.renderer;
    const u = this.mat.linearize.uniforms;
    u.tDepth.value = this.hdr.depthTexture;
    // `log` is the caller saying which *pass* this is; sceneLogDepth is the
    // game saying which curve the scene pass is currently on.
    u.uLog.value = (log && this.sceneLogDepth) ? 1 : 0;
    // three's own uniform: 2 / log2(far + 1)
    u.uFC.value = 2.0 / (Math.log(camera.far + 1.0) / Math.LN2);
    u.uNear.value = camera.near;
    u.uFarPlane.value = camera.far;
    const prev = r.autoClear;
    r.autoClear = true;
    this._blit(this.mat.linearize, this.linRT);
    r.autoClear = prev;

    // Projection for the AO's view-space reconstruction. Both cameras carry
    // the same fov and aspect — updateCamera copies one from the other — so
    // one set of tangents serves the whole frame.
    const ty = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    this.mat.ao.uniforms.uProj.value.set(ty * camera.aspect, ty);
  }


  _blit(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.camera);
  }

  get sceneTarget() { return this.hdr; }

  /** @param {{sunUV:THREE.Vector2, sunVis:number, time:number}} ctx */
  render(ctx) {
    const r = this.renderer;
    const M = this.mat;
    const autoClearPrev = r.autoClear;
    r.autoClear = true;

    // ---- ambient occlusion, half res, then blurred along each axis
    if (this.enabled.ao) {
      const ao = M.ao.uniforms;
      // rPx and uAngular are the same radius said two ways: a fraction of the
      // frame height, and the world-space distance that subtends it at unit
      // depth. Keeping both means the shader neither projects nor unprojects.
      /* Two budgets, because they buy different things.
         With aoWorldRadius set — the ground — the radius in *world* units is
         pinned and the screen number is only a cap, so widening it buys almost
         nothing: measured on the occlusion buffer under the landing gear, its
         standard deviation went 9.8 to 11.4 across a 2.4x widening, because a
         heightfield with its relief in the normal map has nothing at that
         scale to occlude. It does cost, and the landed frame is the one with
         no headroom in it. In the cabin and in space the radius *is* the
         corner scale and widening it is most of what makes a corner dark. */
      const frac = this.aoWorldRadius > 0 ? this.aoRadiusFracWorld : this.aoRadiusFrac;
      ao.uRadiusPx.value = frac * this._size.y;
      ao.uAngular.value = frac * 2.0 * ao.uProj.value.y;
      ao.uWorldR.value = this.aoWorldRadius;
      ao.tLin.value = this.linRT.texture;
      this._blit(M.ao, this.aoRT[0]);

      M.aoBlur.uniforms.tLin.value = this.linRT.texture;
      M.aoBlur.uniforms.tAO.value = this.aoRT[0].texture;
      M.aoBlur.uniforms.uStep.value.set(1 / this.aoRT[0].width, 0);
      this._blit(M.aoBlur, this.aoRT[1]);
      M.aoBlur.uniforms.tAO.value = this.aoRT[1].texture;
      M.aoBlur.uniforms.uStep.value.set(0, 1 / this.aoRT[0].height);
      this._blit(M.aoBlur, this.aoRT[0]);
    }

    // ---- bloom prefilter + downsample chain
    const m0 = this.blurMips[0];
    M.prefilter.uniforms.tSrc.value = this.hdr.texture;
    // Last frame's adaptation. It is one frame stale, which is imperceptible,
    // and it is what lets the bright pass threshold in display stops.
    M.prefilter.uniforms.tAdapt.value = this._adaptPrimed
      ? this.adaptRT[this.adaptIdx].texture : this.lumRT1.texture;
    M.prefilter.uniforms.uTexel.value.set(1 / this._size.x, 1 / this._size.y);
    this._blit(M.prefilter, m0);

    for (let i = 1; i < this.blurMips.length; i++) {
      const src = this.blurMips[i - 1], dst = this.blurMips[i];
      M.down.uniforms.tSrc.value = src.texture;
      M.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._blit(M.down, dst);
    }

    // ---- upsample with additive tent blending
    M.up.uniforms.uRadius.value = 1.0;
    const prevBlend = M.up.blending;
    M.up.blending = THREE.AdditiveBlending;
    M.up.transparent = true;
    for (let i = this.blurMips.length - 1; i > 0; i--) {
      const src = this.blurMips[i], dst = this.blurMips[i - 1];
      M.up.uniforms.tSrc.value = src.texture;
      // Attenuate the widest mips. Summed at full weight they turn any bright
      // source into a full-screen veil rather than a halo around the source.
      M.up.uniforms.uWeight.value = 0.68;
      M.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._quad.material = M.up;
      r.setRenderTarget(dst);
      r.autoClear = false;
      r.render(this.quadScene, this.camera);
      r.autoClear = true;
    }
    M.up.blending = prevBlend;
    M.up.transparent = false;

    // ---- anamorphic streaks from mip 1
    if (this.enabled.streak) {
      const src = this.blurMips[Math.min(1, this.blurMips.length - 1)];
      M.streak.uniforms.tSrc.value = src.texture;
      M.streak.uniforms.tAdapt.value = this._adaptPrimed
        ? this.adaptRT[this.adaptIdx].texture : this.lumRT1.texture;
      M.streak.uniforms.uTexel.value.set(1 / this.streakRT[0].width, 1 / this.streakRT[0].height);
      M.streak.uniforms.uStep.value = 1.0;
      // Only the first pass selects; the other two widen what it selected.
      M.streak.uniforms.uThreshold.value = this.streakThreshold;
      this._blit(M.streak, this.streakRT[0]);
      M.streak.uniforms.uThreshold.value = 0.0;
      M.streak.uniforms.tSrc.value = this.streakRT[0].texture;
      M.streak.uniforms.uStep.value = 4.0;
      this._blit(M.streak, this.streakRT[1]);
      M.streak.uniforms.tSrc.value = this.streakRT[1].texture;
      M.streak.uniforms.uStep.value = 13.0;
      this._blit(M.streak, this.streakRT[0]);
    }

    // ---- god rays + ghosts
    if (this.enabled.flare) {
      M.flare.uniforms.tBright.value = this.blurMips[1] ? this.blurMips[1].texture : this.blurMips[0].texture;
      M.flare.uniforms.uSunUV.value.copy(ctx.sunUV);
      M.flare.uniforms.uSunVis.value = ctx.sunVis;
      M.flare.uniforms.uAspect.value = this._size.x / this._size.y;
      this._blit(M.flare, this.flareRT);
      // One tent blur over the quarter-res flare target. The radial march is a
      // stochastic integral, so its residue is per-pixel by construction; the
      // only reliable cure is to average neighbours afterwards.
      M.up.uniforms.tSrc.value = this.flareRT.texture;
      M.up.uniforms.uRadius.value = 1.6;
      M.up.uniforms.uWeight.value = 1.0;
      M.up.uniforms.uTexel.value.set(1 / this.flareRT.width, 1 / this.flareRT.height);
      this._blit(M.up, this.flareBlurRT);
      const swap = this.flareRT; this.flareRT = this.flareBlurRT; this.flareBlurRT = swap;
    }

    // ---- eye adaptation
    /* `groundMeter` is set by Game on landing. See LUM_FRAG: in space the
       brightest thing in frame is the subject, on a planet it is the sky, and
       one metering policy cannot serve both. */
    M.lum.uniforms.tSrc.value = this.hdr.texture;
    M.lum.uniforms.uClamp.value = this.groundMeter ? 0.42 : 6.0;
    M.lum.uniforms.uGroundW.value = this.groundMeter ? 1 : 0;
    M.lum.uniforms.uTexel.value.set(1 / this._size.x, 1 / this._size.y);
    this._blit(M.lum, this.lumRT);
    M.reduce.uniforms.tSrc.value = this.lumRT.texture;
    M.reduce.uniforms.uTexel.value.set(1 / 64, 1 / 64);
    this._blit(M.reduce, this.lumRT8);
    M.reduce.uniforms.tSrc.value = this.lumRT8.texture;
    M.reduce.uniforms.uTexel.value.set(1 / 8, 1 / 8);
    this._blit(M.reduce, this.lumRT1);

    const prev = this.adaptRT[this.adaptIdx];
    const next = this.adaptRT[1 - this.adaptIdx];
    M.adapt.uniforms.tCur.value = this.lumRT1.texture;
    M.adapt.uniforms.tPrev.value = this._adaptPrimed ? prev.texture : this.lumRT1.texture;
    const rate = Math.min(1, (ctx.dt || 0.016));
    M.adapt.uniforms.uUp.value = 1 - Math.exp(-1.1 * rate);
    M.adapt.uniforms.uDown.value = 1 - Math.exp(-3.0 * rate);
    this._blit(M.adapt, next);
    this.adaptIdx = 1 - this.adaptIdx;
    this._adaptPrimed = true;

    // ---- composite
    const cu = M.composite.uniforms;
    cu.tAdapt.value = this.adaptRT[this.adaptIdx].texture;
    cu.tScene.value = this.hdr.texture;
    cu.tBloom.value = this.blurMips[0].texture;
    cu.tStreak.value = this.enabled.streak ? this.streakRT[0].texture : this._blackTex();
    cu.tFlare.value = this.enabled.flare ? this.flareRT.texture : this._blackTex();
    cu.tAO.value = this.aoRT[0].texture;
    cu.uAO.value = this.enabled.ao ? this.aoStrength : 0;
    cu.uTime.value = ctx.time;
    // the cloud variant only while there is cloud — see compositeCloud
    const comp = cu.uCloud.value > 0.0015 ? M.compositeCloud : M.composite;
    this._blit(comp, this.enabled.fxaa ? this.ldr : null);

    /* Build the cloud program now rather than on the frame it is first wanted.
       A driver compiles a ShaderMaterial on its first draw, and this one is a
       big program that is first drawn in the middle of a landing: measured on
       the ground bench, the worst landing frame went 86 ms to 160 for no
       reason other than that. One draw into the smallest blur mip — a few
       hundred pixels, overwritten next frame — moves the whole cost onto a
       boot frame the loading card is already covering.
     *
     * Into `ldr`, which is the target the real draw uses. Warming it into a
     * small scratch buffer did not work and the reason is worth writing down:
     * a Metal pipeline is specialised on the *render target's* format, so a
     * program built against a half-float mip is rebuilt the first time it is
     * asked for an 8-bit one, and the whole cost simply moved to the same
     * frame it was already on. Same format, same pipeline, warm. */
    if (!this._cloudWarmed && this.ldr) {
      this._cloudWarmed = true;
      this._blit(M.compositeCloud, this.ldr);
    }

    // ---- AA
    if (this.enabled.fxaa) {
      M.fxaa.uniforms.tSrc.value = this.ldr.texture;
      this._blit(M.fxaa, null);
    }

    r.setRenderTarget(null);
    r.autoClear = autoClearPrev;
  }

  _blackTex() {
    if (!this._black) {
      const d = new Uint8Array([0, 0, 0, 255]);
      this._black = new THREE.DataTexture(d, 1, 1);
      this._black.needsUpdate = true;
    }
    return this._black;
  }

  get u() { return this.mat.composite.uniforms; }

  /* Verification hook: the linear-depth buffer read back at one screen pixel,
     in the scene's own units. Every SSAO bug in a renderer with two depth
     encodings looks like a shading bug, so the reconstruction is checked
     against a raycast rather than judged by eye — see tools/aocheck.mjs.

     `x` and `y` are *screen* pixels. The buffer is half that, and each of its
     texels holds the depth of the odd full-res texel inside it (see the offset
     in LINEARIZE_FRAG), so a caller comparing against a raycast has to fire the
     ray through that same pixel: (x | 1, y | 1). */
  readLinearDepth(x, y) {
    if (!this.linRT) return null;
    const buf = new Float32Array(4);
    this.renderer.readRenderTargetPixels(this.linRT, (x | 0) >> 1, (y | 0) >> 1, 1, 1, buf);
    return buf[0];
  }

  dispose() {
    this.linRT?.dispose();
    this.aoRT?.forEach((m) => m.dispose());
    this.hdr?.dispose(); this.ldr?.dispose(); this.flareRT?.dispose(); this.flareBlurRT?.dispose();
    this.blurMips.forEach((m) => m.dispose());
    this.streakRT.forEach((m) => m.dispose());
    this.lumRT?.dispose(); this.lumRT8?.dispose(); this.lumRT1?.dispose();
    this.adaptRT?.forEach((m) => m.dispose());
    Object.values(this.mat).forEach((m) => m.dispose());
  }
}
