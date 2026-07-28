// Shared GLSL: hashing, simplex noise, fbm variants, cellular noise, curl.
// Kept as a single injectable chunk so every procedural shader agrees on the
// same basis functions (important — planets, nebulae and rings must feel like
// they came out of the same universe).

export const NOISE = /* glsl */`
#ifndef LS_NOISE
#define LS_NOISE

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash13(vec3 p3){
  p3 = fract(p3*0.1031);
  p3 += dot(p3, p3.zyx+31.32);
  return fract((p3.x+p3.y)*p3.z);
}
vec3 hash33(vec3 p3){
  p3 = fract(p3*vec3(0.1031,0.1030,0.0973));
  p3 += dot(p3, p3.yxz+33.33);
  return fract((p3.xxy+p3.yxx)*p3.zyx);
}
vec2 hash23(vec3 p3){
  p3 = fract(p3*vec3(0.1031,0.1030,0.0973));
  p3 += dot(p3, p3.yzx+33.33);
  return fract((p3.xx+p3.yz)*p3.zy);
}

// ---------------------------------------------------------------- simplex 3D
vec3 mod289v3(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 mod289v4(vec4 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 permute289(vec4 x){ return mod289v4(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt4(vec4 r){ return 1.79284291400159 - 0.85373472095314*r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289v3(i);
  vec4 p = permute289(permute289(permute289(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_*D.wyz - D.xzx;
  vec4 j = p - 49.0*floor(p*ns.z*ns.z);
  vec4 x_ = floor(j*ns.z);
  vec4 y_ = floor(j - 7.0*x_);
  vec4 x = x_*ns.x + ns.yyyy;
  vec4 y = y_*ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt4(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m*m;
  return 42.0*dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// Decorrelating rotation between octaves — kills the axis-aligned grid look.
const mat3 OCT_ROT = mat3( 0.00, 0.80, 0.60,
                          -0.80, 0.36,-0.48,
                          -0.60,-0.48, 0.64);

float fbm(vec3 p, int oct, float lac, float gain){
  float a = 0.5, sum = 0.0, norm = 0.0;
  for(int i=0;i<10;i++){
    if(i>=oct) break;
    sum  += a*snoise(p);
    norm += a;
    a    *= gain;
    p     = OCT_ROT*p*lac;
  }
  return sum/max(norm,1e-5);
}
float fbm(vec3 p, int oct){ return fbm(p, oct, 2.02, 0.5); }

// Ridged multifractal — mountain chains, canyon walls, lightning-like veins.
float ridged(vec3 p, int oct, float lac, float gain){
  float a = 0.5, sum = 0.0, norm = 0.0, prev = 1.0;
  for(int i=0;i<10;i++){
    if(i>=oct) break;
    float n = 1.0 - abs(snoise(p));
    n = n*n*prev;
    prev = clamp(n, 0.0, 1.0);
    sum  += a*n;
    norm += a;
    a    *= gain;
    p     = OCT_ROT*p*lac;
  }
  return sum/max(norm,1e-5);
}
float ridged(vec3 p, int oct){ return ridged(p, oct, 2.07, 0.5); }

// Billowy / turbulent — clouds, gas giant curls, smoke.
float turbulence(vec3 p, int oct, float lac, float gain){
  float a = 0.5, sum = 0.0, norm = 0.0;
  for(int i=0;i<10;i++){
    if(i>=oct) break;
    sum  += a*abs(snoise(p));
    norm += a;
    a    *= gain;
    p     = OCT_ROT*p*lac;
  }
  return sum/max(norm,1e-5);
}

// Cellular (F1 / F2) — craters, cracked ice, basalt columns.
vec2 cellular(vec3 p, float jitter){
  vec3 ip = floor(p), fp = fract(p);
  float f1 = 9.0, f2 = 9.0;
  for(int z=-1;z<=1;z++)
  for(int y=-1;y<=1;y++)
  for(int x=-1;x<=1;x++){
    vec3 o = vec3(float(x),float(y),float(z));
    vec3 r = o + hash33(ip+o)*jitter - fp;
    float d = dot(r,r);
    if(d<f1){ f2=f1; f1=d; } else if(d<f2){ f2=d; }
  }
  return sqrt(vec2(f1,f2));
}

// Domain warp: two-level, gives the swirling organic feel of real terrain.
vec3 warp3(vec3 p, float amt, int oct){
  vec3 q = vec3(fbm(p+vec3(0.0,0.0,0.0), oct),
                fbm(p+vec3(5.2,1.3,2.7), oct),
                fbm(p+vec3(1.7,9.2,4.1), oct));
  return p + q*amt;
}

float remap(float v, float a, float b, float c, float d){
  return c + (clamp(v,a,b)-a)*(d-c)/max(b-a,1e-6);
}
float sstep(float a, float b, float x){ return smoothstep(a,b,x); }

// Rotation helpers
mat3 rotAxis(vec3 ax, float a){
  float s=sin(a), c=cos(a), t=1.0-c;
  return mat3(t*ax.x*ax.x+c,      t*ax.x*ax.y-s*ax.z, t*ax.x*ax.z+s*ax.y,
              t*ax.x*ax.y+s*ax.z, t*ax.y*ax.y+c,      t*ax.y*ax.z-s*ax.x,
              t*ax.x*ax.z-s*ax.y, t*ax.y*ax.z+s*ax.x, t*ax.z*ax.z+c);
}

// Analytic ray/sphere at origin. Returns (near,far); far<0 means miss.
vec2 raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r*r;
  float h = b*b - c;
  if(h < 0.0) return vec2(1e20, -1.0);
  h = sqrt(h);
  return vec2(-b-h, -b+h);
}

// Blackbody-ish colour from temperature in Kelvin (approximate, 1000-40000K).
vec3 blackbody(float t){
  t = clamp(t, 1000.0, 40000.0) / 100.0;
  vec3 c;
  if(t <= 66.0){
    c.r = 255.0;
    c.g = 99.4708025861*log(t) - 161.1195681661;
    c.b = t <= 19.0 ? 0.0 : 138.5177312231*log(t-10.0) - 305.0447927307;
  } else {
    c.r = 329.698727446*pow(t-60.0, -0.1332047592);
    c.g = 288.1221695283*pow(t-60.0, -0.0755148492);
    c.b = 255.0;
  }
  return clamp(c/255.0, 0.0, 1.0);
}

#endif
`;

/* ----------------------------------------------------------------------------
   Logarithmic depth support for custom ShaderMaterials.

   Scenes here span from a 100 m ship to orbits millions of km wide; a linear
   depth buffer cannot express that. three enables USE_LOGARITHMIC_DEPTH_BUFFER and feeds
   `logDepthBufFC` automatically, but custom shaders have to opt in by hand.
   -------------------------------------------------------------------------- */

export const LOGD_V_PARS = /* glsl */`
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  varying float vFragDepth;
  varying float vIsPerspective;
  bool lsIsPersp(mat4 m){ return m[2][3] == -1.0; }
#endif
`;

export const LOGD_V = /* glsl */`
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth = 1.0 + gl_Position.w;
  vIsPerspective = float(lsIsPersp(projectionMatrix));
#endif
`;

export const LOGD_F_PARS = /* glsl */`
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  uniform float logDepthBufFC;
  varying float vFragDepth;
  varying float vIsPerspective;
#endif
`;

export const LOGD_F = /* glsl */`
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(vFragDepth) * logDepthBufFC * 0.5;
#endif
`;

// Fullscreen triangle vertex shader used by every post / bake pass.
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
