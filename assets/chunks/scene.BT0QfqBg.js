import{n as No,i as Oo}from"./RoadmapPage.X6EDk4qc.js";import{a as Io,p as Do,m as Ro,V as Wo,b as jo,C as mo,h as _,c as Bo,s as vo,d as _e,e as $o,g as Ko,i as Uo}from"./labels.8a2IQ0Qv.js";import{webgl2Supported as Ho,linear as k,deleteMesh as Yo,project as ke,startProgram as Xo,createMesh as q,programReady as Go,finishProgram as Zo,mat4 as xe,drawMesh as Q,lookAt as qo,perspective as Qo,multiply as Jo,invert as et}from"./gl.6Z7s-pT5.js";import"./framework.IehvnstE.js";import"./releaseKind.EczTz7I-.js";import"./theme.REI6JcOn.js";import"./roadmap-text.BaAZLBc8.js";import"./date-formatter.ChLD7W9f.js";const be=`
#define PATH_X(z) (5.5 * sin((z) * 0.07) + 2.0 * sin((z) * 0.021 + 1.3))
#define PATH_HALF 1.6
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Filmic curve (Narkowicz ACES fit), gamma, and a 1/255 dither against
// banding in the dark gradients.
vec3 finish(vec3 c) {
  c *= 1.15;
  c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
  return pow(c, vec3(1.0 / 2.2)) + (h21(gl_FragCoord.xy) - 0.5) / 255.0;
}
float fogAmount(float density, float dist) {
  float f = density * dist;
  return 1.0 - exp(-f * f);
}
`,w=`#version 300 es
precision highp float;
precision highp int;
`,J=16,ot=`${w}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aKind;
uniform mat4 uViewProj;
uniform vec3 uLightPos[${J}];
uniform vec3 uLightCol[${J}];
uniform int uLights;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
out float vAo;
out vec3 vGlow;
flat out int vKind;
void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vColor = pow(aColor.rgb, vec3(2.2));
  vAo = aColor.a;
  vKind = int(aKind + 0.5);
  // Crystal light on the snow around them. Per vertex: the grid is one block,
  // dense enough for a soft pool, and 16 lights per pixel would cost phones.
  vec3 glow = vec3(0.0);
  for (int i = 0; i < ${J}; i++) {
    if (i >= uLights) break;
    vec3 d = uLightPos[i] - aPos;
    float r2 = dot(d, d);
    float facing = max(dot(aNormal, d * inversesqrt(r2 + 1e-4)), 0.0) * 0.65 + 0.35;
    glow += uLightCol[i] * facing / (1.0 + r2 * 0.3);
  }
  vGlow = glow;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`,tt=`${w}
${be}
in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
in float vAo;
in vec3 vGlow;
flat in int vKind;
uniform vec3 uCam;
uniform float uTime;
uniform float uNowZ;
uniform vec3 uFog;
uniform float uFogDensity;
uniform vec3 uMoonDir;
uniform float uEdge;
uniform float uZMin;
out vec4 frag;
void main() {
  vec3 n = normalize(vNormal);
  vec3 toCam = uCam - vWorld;
  float dist = length(toCam);
  vec3 v = toCam / dist;
  float walked = smoothstep(uNowZ - 3.0, uNowZ + 3.0, vWorld.z);
  float lateral = abs(vWorld.x - PATH_X(vWorld.z));

  vec3 sky = vec3(0.045, 0.065, 0.125);
  vec3 earth = vec3(0.006, 0.008, 0.018);
  vec3 ambient = mix(earth, sky, n.y * 0.5 + 0.5);
  float moon = max(dot(n, uMoonDir), 0.0);
  vec3 col = vColor * (ambient + vec3(0.09, 0.115, 0.21) * moon) * vAo + vColor * vGlow * vAo;

  if (vKind == 1) {
    // The path: ice blocks. Walked — lit from inside, with light running on
    // towards "now"; ahead — dark frost with faint guide lights.
    vec2 cell = fract(vWorld.xz + 0.5) - 0.5;
    float run = pow(0.5 + 0.5 * sin((vWorld.z + uTime * 4.0) * 0.32), 8.0);
    float ripple = vnoise(vWorld.xz * 1.7 + vec2(0.0, uTime * 0.3));
    vec3 lit = vec3(0.02, 0.22, 0.46) * (0.75 + 0.4 * ripple) + vec3(0.2, 0.7, 1.0) * run * 0.55;
    vec3 dark = vec3(0.018, 0.026, 0.055) + vec3(0.01, 0.016, 0.035) * ripple;
    vec3 ice = mix(dark, lit, walked);
    float guide = (1.0 - walked) * smoothstep(0.17, 0.02, length(cell))
      * step(mod(floor(vWorld.z + 0.5), 3.0), 0.5) * step(lateral, 0.65);
    ice += vec3(0.42, 0.46, 1.0) * guide * (0.7 + 0.3 * sin(uTime * 2.0 + vWorld.z));
    vec3 h = normalize(uMoonDir + v);
    ice += vec3(0.6, 0.75, 1.0) * pow(max(dot(n, h), 0.0), 80.0) * 0.5;
    col = ice + vColor * ambient * 0.08 + vGlow * 0.15;
  } else if (vKind == 0 && n.y > 0.5) {
    // Drifts: the snow is never one flat colour.
    col *= 0.9 + 0.1 * vnoise(vWorld.xz * 0.9) + 0.05 * vnoise(vWorld.xz * 3.7);
    // Light spilling from the walked path onto the snow beside it.
    float spill = exp(-max(lateral - PATH_HALF, 0.0) * 1.15) * walked * step(vWorld.y, 0.5);
    col += vec3(0.03, 0.2, 0.36) * spill * 0.5;
  } else if (vKind == 0) {
    // Rock under the snow: faint strata, one per block.
    col *= 0.9 + 0.1 * smoothstep(0.0, 0.12, fract(vWorld.y));
  } else if (vKind == 3) {
    // Needles under the snow: a little light gets through, they are never black.
    col += vColor * vec3(0.04, 0.065, 0.055) * (1.0 - n.y);
  }

  if ((vKind == 0 || vKind == 3) && n.y > 0.5) {
    // Sparkles: a few snow grains per block catch the moon as the camera moves.
    vec2 g = vWorld.xz * 8.0;
    float pick = h21(floor(g));
    float twinkle = 0.5 + 0.5 * sin(uTime * 1.7 + pick * 50.0 + dot(v, vec3(19.0, 11.0, 7.0)));
    float grain = smoothstep(0.32, 0.0, length(fract(g) - 0.5));
    col += vec3(0.75, 0.88, 1.0) * step(0.982, pick) * smoothstep(0.7, 1.0, twinkle) * grain
      * 1.6 * (1.0 - smoothstep(8.0, 36.0, dist));
  }

  float fog = fogAmount(uFogDensity, dist);
  // The edges of the world dissolve into fog wherever the camera stands.
  fog = max(fog, smoothstep(uEdge - 10.0, uEdge - 1.0, lateral));
  fog = max(fog, smoothstep(uZMin + 30.0, uZMin + 6.0, vWorld.z));
  frag = vec4(finish(mix(col, uFog, fog)), 1.0);
}`,at=`${w}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aBase;
layout(location = 3) in vec3 aInfo;
uniform mat4 uViewProj;
uniform float uSelected;
uniform float uTime;
out vec3 vWorld;
out vec3 vNormal;
out float vHeight;
out float vSel;
flat out int vStatus;
out float vIndex;
void main() {
  float sel = 1.0 - step(0.5, abs(aInfo.x - uSelected));
  vec3 p = aBase + (aPos - aBase) * (1.0 + sel * (0.07 + 0.015 * sin(uTime * 2.0)));
  vWorld = p;
  vNormal = aNormal;
  vHeight = aInfo.z;
  vSel = sel;
  vStatus = int(aInfo.y + 0.5);
  vIndex = aInfo.x;
  gl_Position = uViewProj * vec4(p, 1.0);
}`,nt=`${w}
${be}
in vec3 vWorld;
in vec3 vNormal;
in float vHeight;
in float vSel;
flat in int vStatus;
in float vIndex;
uniform vec3 uCam;
uniform float uTime;
uniform vec3 uFog;
uniform float uFogDensity;
uniform vec3 uCore[4];
uniform vec3 uRim[4];
uniform float uPower[4];
out vec4 frag;
void main() {
  vec3 n = normalize(vNormal);
  vec3 toCam = uCam - vWorld;
  float dist = length(toCam);
  vec3 v = toCam / dist;
  vec3 core = uCore[vStatus];
  vec3 rim = uRim[vStatus];
  float power = uPower[vStatus];
  float ndv = max(dot(n, v), 0.0);
  float fres = pow(1.0 - ndv, 2.4);
  float facet = 0.55 + 0.45 * abs(dot(n, normalize(vec3(0.35, 0.8, 0.45))));
  // Lit from inside: dim at the foot, bright towards the tip.
  float inner = mix(0.3, 0.95, smoothstep(0.0, 1.0, vHeight));
  // A slow band of light climbs each crystal; finished ones are calmer.
  float band = smoothstep(0.1, 0.0, abs(fract(vHeight * 0.9 - uTime * 0.11 + vIndex * 0.37) - 0.5));
  float pulse = vStatus == 1 ? 1.0 + 0.18 * sin(uTime * 2.4) : 1.0;
  vec3 col = core * inner * facet * power * pulse + rim * fres * 0.9 * power + rim * band * 0.16 * power;
  // The sky in the facets: aurora green above, night below.
  vec3 r = reflect(-v, n);
  col += mix(vec3(0.01, 0.02, 0.05), vec3(0.05, 0.4, 0.3), smoothstep(0.1, 0.9, r.y)) * 0.25;
  col *= 1.0 + vSel * 0.18;
  // Crystals glow through the fog a little: they are the landmarks.
  float fog = fogAmount(uFogDensity, dist) * 0.78;
  frag = vec4(finish(mix(col, uFog, fog)), 1.0);
}`,rt=`${w}
layout(location = 0) in vec3 aCenter;
layout(location = 1) in vec2 aCorner;
layout(location = 2) in vec2 aSize;
layout(location = 3) in vec3 aColor;
layout(location = 4) in vec3 aParams;
uniform mat4 uViewProj;
uniform vec3 uCam;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTime;
uniform float uSelected;
out vec2 vCorner;
out vec3 vColor;
out float vKind;
out float vFade;
void main() {
  float beam = aParams.x;
  float breathe = 1.0 + aParams.y * 0.13 * sin(uTime * 2.4);
  float sel = 1.0 - step(0.5, abs(aParams.z - uSelected));
  vec3 right = uCamRight;
  vec3 up = uCamUp;
  if (beam > 0.5) {
    // A beam turns around its own axis to face the camera: never a flat edge.
    vec3 flat_ = uCam - aCenter;
    flat_.y = 0.0;
    right = normalize(vec3(flat_.z, 0.0, -flat_.x) + 1e-5);
    up = vec3(0.0, 1.0, 0.0);
    breathe = 1.0;
  }
  vec2 size = aSize * breathe * (1.0 + sel * 0.25);
  vec3 p = aCenter + right * aCorner.x * size.x * 0.5 + up * aCorner.y * size.y * 0.5;
  vCorner = aCorner;
  vColor = aColor * (1.0 + sel * 0.5);
  vKind = beam;
  float f = 0.022 * length(uCam - aCenter);
  vFade = 1.0 - (1.0 - exp(-f * f)) * 0.7;
  gl_Position = uViewProj * vec4(p, 1.0);
}`,it=`${w}
${be}
in vec2 vCorner;
in vec3 vColor;
in float vKind;
in float vFade;
uniform float uTime;
out vec4 frag;
void main() {
  float a;
  if (vKind > 0.5) {
    float y = vCorner.y * 0.5 + 0.5;
    a = exp(-vCorner.x * vCorner.x * 10.0) * pow(1.0 - y, 1.8) * smoothstep(0.0, 0.05, y)
      * (0.85 + 0.15 * sin(uTime * 2.6 + y * 26.0));
  } else {
    float r = length(vCorner);
    a = exp(-r * r * 4.5) * (1.0 - smoothstep(0.8, 1.0, r));
  }
  vec3 c = vColor * a * vFade;
  frag = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`,st=`${w}
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vNdc;
void main() {
  vNdc = P[gl_VertexID];
  // z = w: the depth is 1.0, so only pixels nothing else covered get sky.
  gl_Position = vec4(vNdc, 1.0, 1.0);
}`,lt=`${w}
${be}
in vec2 vNdc;
uniform mat4 uInvViewProj;
uniform vec3 uCam;
uniform vec3 uFog;
uniform float uTime;
uniform int uAuroraSteps;
out vec4 frag;
float ridge(float a, float scale, float seed) {
  return vnoise(vec2(a * scale + seed, seed)) * 0.6 + vnoise(vec2(a * scale * 2.3 + seed, seed * 1.7)) * 0.3
    + vnoise(vec2(a * scale * 5.1, seed)) * 0.1;
}
void main() {
  vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(w.xyz / w.w - uCam);
  float e = dir.y;
  vec3 zenith = vec3(0.004, 0.007, 0.02);
  vec3 col = mix(uFog, zenith, smoothstep(0.0, 0.5, e));

  // Stars: one candidate per cell of a sphere around the camera.
  if (e > 0.02) {
    vec3 p = dir * 140.0;
    vec3 c = floor(p);
    float pick = h31(c);
    if (pick > 0.992) {
      vec3 o = vec3(h31(c + 1.3), h31(c + 2.7), h31(c + 4.1)) * 0.6 + 0.2;
      float d = length(fract(p) - o);
      float aa = fwidth(p.x) + fwidth(p.y);
      float star = smoothstep(0.09 + aa, 0.0, d);
      float twinkle = 0.65 + 0.35 * sin(uTime * (1.0 + pick * 3.0) + pick * 90.0);
      col += vec3(0.8, 0.88, 1.0) * star * twinkle * smoothstep(0.02, 0.3, e) * (0.6 + 2.0 * (pick - 0.992) / 0.008);
    }
  }

  // Aurora: curtains as bands on a few stacked planes above the camera, so
  // each band rises into a curtain — green at the foot, violet on top.
  if (e > 0.015) {
    vec3 acc = vec3(0.0);
    float steps = float(uAuroraSteps);
    for (int i = 0; i < 8; i++) {
      if (i >= uAuroraSteps) break;
      float k = float(i) / steps;
      float plane = 1.0 + k * 0.55;
      vec2 q = dir.xz * (plane / e);
      float x = q.x * 0.32;
      float line = -8.5 + 2.2 * sin(x * 0.45 + uTime * 0.045) + 2.0 * (vnoise(vec2(x * 0.9 + uTime * 0.03, 3.0)) - 0.5);
      float d = q.y - line;
      float band = exp(-d * d * 0.35);
      float rays = 0.45 + 0.55 * vnoise(vec2(x * 16.0 + vnoise(vec2(x * 2.0, uTime * 0.1)) * 3.0, uTime * 0.15));
      vec3 tint = mix(vec3(0.08, 1.0, 0.55), vec3(0.5, 0.25, 1.0), smoothstep(0.15, 1.0, k));
      acc += tint * band * rays * (1.0 - k * 0.7);
    }
    col += acc / steps * 0.32 * smoothstep(0.015, 0.12, e) * (1.0 - smoothstep(0.45, 0.9, e));
  }

  // Far mountains: two silhouettes by azimuth make a horizon where the land ends.
  float az = atan(dir.x, -dir.z);
  float far = 0.03 + 0.07 * ridge(az, 2.4, 3.0);
  float near = 0.01 + 0.05 * ridge(az, 4.6, 9.0);
  col = mix(col, mix(uFog, zenith, 0.25) + vec3(0.004, 0.008, 0.02), smoothstep(far + 0.003, far - 0.003, e) * 0.85);
  col = mix(col, uFog * 0.92, smoothstep(near + 0.003, near - 0.003, e));
  if (e < 0.0) col = uFog;
  frag = vec4(finish(col), 1.0);
}`,ct=`${w}
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aSpeed;
uniform mat4 uViewProj;
uniform mat4 uView;
uniform vec3 uCam;
uniform float uTime;
uniform float uPixel;
out float vAlpha;
void main() {
  vec3 box = vec3(60.0, 34.0, 60.0);
  vec3 p = aPos + vec3(sin(uTime * 0.4 + aPos.y) * 1.2, -uTime * aSpeed, cos(uTime * 0.3 + aPos.x) * 0.8);
  p = mod(p - uCam + box * 0.5, box) - box * 0.5 + uCam;
  float depth = -(uView * vec4(p, 1.0)).z;
  vAlpha = smoothstep(55.0, 8.0, depth) * smoothstep(0.5, 2.0, depth);
  gl_PointSize = min(7.0, (1.1 + aSpeed) * 22.0 * uPixel / max(depth, 0.1));
  gl_Position = uViewProj * vec4(p, 1.0);
}`,ft=`${w}
in float vAlpha;
out vec4 frag;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * vAlpha * 0.8;
  frag = vec4(vec3(0.9, 0.95, 1.0) * a, a);
}`,ut=`${w}
layout(location = 0) in vec3 aSeed;
uniform mat4 uViewProj;
uniform mat4 uView;
uniform vec3 uCenter;
uniform float uTime;
uniform float uPixel;
out float vAlpha;
void main() {
  float a = aSeed.x + uTime * (0.35 + 0.25 * fract(aSeed.y));
  float y = mod(aSeed.z + uTime * 0.55, 5.0);
  vec3 p = uCenter + vec3(cos(a) * aSeed.y, y, sin(a) * aSeed.y);
  vAlpha = smoothstep(0.0, 0.8, y) * (1.0 - smoothstep(3.8, 5.0, y));
  float depth = -(uView * vec4(p, 1.0)).z;
  gl_PointSize = min(9.0, 48.0 * uPixel / max(depth, 0.1));
  gl_Position = uViewProj * vec4(p, 1.0);
}`,mt=`${w}
in float vAlpha;
uniform vec3 uColor;
out vec4 frag;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vAlpha;
  frag = vec4(pow(uColor * a, vec3(1.0 / 2.2)), 1.0);
}`,vt=`${w}
layout(location = 0) in vec4 aSeed;
uniform mat4 uViewProj;
uniform mat4 uView;
uniform vec3 uCenter;
uniform float uTime;
uniform float uAge;
uniform float uPixel;
uniform float uCount;
uniform vec2 uShare;
uniform vec3 uAdded;
uniform vec3 uImproved;
uniform vec3 uFixed;
out vec3 vColor;
out float vAlpha;
void main() {
  if (aSeed.w >= uCount) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vColor = vec3(0.0);
    return;
  }
  // Kinds take shares of the sparks in proportion to the changes.
  float f = (aSeed.w + 0.5) / uCount;
  vColor = f < uShare.x ? uAdded : (f < uShare.y ? uImproved : uFixed);
  // Out from the crystal when the camera arrives, then a slow spiral upwards.
  float burst = 1.0 - exp(-uAge * 2.6);
  float t = fract(uTime * 0.09 + aSeed.z);
  float a = aSeed.x + uTime * (0.22 + 0.18 * aSeed.z);
  float r = (0.9 + aSeed.y) * burst * (1.0 - 0.4 * t);
  vec3 p = uCenter + vec3(cos(a) * r, 0.3 + t * 6.5 * mix(0.25, 1.0, burst), sin(a) * r);
  vAlpha = smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.75, 1.0, t)) * min(1.0, uAge * 3.0);
  float depth = -(uView * vec4(p, 1.0)).z;
  gl_PointSize = min(16.0, 80.0 * uPixel / max(depth, 0.1));
  gl_Position = uViewProj * vec4(p, 1.0);
}`,dt=`${w}
in vec3 vColor;
in float vAlpha;
out vec4 frag;
void main() {
  float d = length(gl_PointCoord - 0.5);
  // A coloured halo with a small bright core: reads as its kind, not as snow.
  float halo = smoothstep(0.5, 0.05, d);
  float core = smoothstep(0.14, 0.0, d);
  vec3 c = (vColor * halo * halo * 1.4 + mix(vColor, vec3(1.0), 0.12) * core * 0.9) * vAlpha;
  frag = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`,ht=858160,$={done:{core:3127278,rim:14219007,power:.8,halo:2282478,haloSize:6,beam:.22,light:2282478,lightPower:.45},now:{core:7336186,rim:15793919,power:1,halo:6220500,haloSize:8,beam:.35,light:6220500,lightPower:1.1},next:{core:7307248,rim:14673407,power:.6,halo:6514417,haloSize:5,beam:0,light:6514417,lightPower:.25},later:{core:2042432,rim:10465484,power:.75,halo:0,haloSize:0,beam:0,light:0,lightPower:0}},pt=["done","now","next","later"],gt=f=>f<.5?4*f*f*f:1-Math.pow(-2*f+2,3)/2,ye=(f,l)=>[f[0]*l,f[1]*l,f[2]*l],wt=(f,l,h)=>[f[0]+(l[0]-f[0])*h,f[1]+(l[1]-f[1])*h,f[2]+(l[2]-f[2])*h],xt=`
.rmx-root{position:absolute;inset:0;overflow:hidden;outline:none;touch-action:pan-y;background:#0d1830}
.rmx-root canvas{display:block;width:100%;height:100%;transition:opacity .1s}
.rmx-labels{position:absolute;inset:0;pointer-events:none}
.rmx-label{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;border-radius:12px;border:1px solid rgba(165,243,252,.18);background:rgba(6,10,20,.55);color:#e2f6ff;font:600 14px/1.25 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;white-space:nowrap;pointer-events:auto;cursor:pointer;transition:opacity .1s,border-color .1s;will-change:transform,opacity}
.rmx-label:hover,.rmx-label.is-current{border-color:rgba(165,243,252,.6)}
.rmx-label-meta{font:500 11px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;color:#7dd3fc;opacity:.85}
.rmx-label[data-status=now] .rmx-label-meta{color:#5eead4}
.rmx-label[data-status=next] .rmx-label-meta{color:#a5b4fc}
.rmx-label[data-status=later]{color:#a8b5cc}
.rmx-label[data-status=later] .rmx-label-meta{color:#7c8aa5}
`;function yt(){if(document.getElementById("rmx-style"))return;const f=document.createElement("style");f.id="rmx-style",f.textContent=xt,document.head.appendChild(f)}const zt=Ho;function Et(f,l){var co,fo;const h=l.items,K=h.length;if(K===0)throw new Error("roadmap: no items");const V=l.quality==="low",U=l.reducedMotion===!0,ee=No(h);let Ve=l.lang;yt();const c=document.createElement("div");c.className="rmx-root",c.tabIndex=0,f.appendChild(c);const P=document.createElement("canvas");c.appendChild(P);const Ne=P.getContext("webgl2",{antialias:!V,alpha:!1,powerPreference:V?"low-power":"high-performance",preserveDrawingBuffer:!1});if(!Ne)throw c.remove(),new Error("roadmap: WebGL2 is not available");const e=Ne,H=h.map((o,t)=>Io(t)),Oe=((co=h[ee])==null?void 0:co.status)==="now",ne=Oe?90:0,re=V?90:160,Ce={added:k(2282478),improved:k(4906624),fixed:k(16486972)};let oe=0,ie=0;const Ie=new Float32Array(J*3),Se=new Float32Array(J*3),De=[];let te=0;h.forEach((o,t)=>{const n=$[o.status];if(!n.light||te>=J)return;const r=H[t];Ie.set([r[0],1.6,r[2]],te*3);const s=ye(k(n.light),n.lightPower);De.push(s),Se.set(s,te*3),te++});const Pe=Oe?h.slice(0,ee).filter(o=>$[o.status].light).length:-1,Ae=k(ht),ho=(()=>{const o=[-.45,.75,.35],t=Math.hypot(...o);return[o[0]/t,o[1]/t,o[2]/t]})(),Re=V?.03:.025,We=[],je=[],Y=o=>(je.push(o),o);let D=!1;const x=4;let u=null;const se=()=>new Promise(o=>setTimeout(o,0));async function po(){const o=!!e.getExtension("KHR_parallel_shader_compile"),n=[[ot,tt],[at,nt],[rt,it],[st,lt],[ct,ft],[ut,mt],[vt,dt]].map(([i,B])=>Xo(e,i,B));for(const i of n)We.push(i.program);await se();const r=Do(K,ee,V);if(D)throw new Error("disposed");await se();const s=Ro(r),g=Y(q(e,s.data,Wo,[{location:0,size:3,type:e.FLOAT,offset:0},{location:1,size:3,type:e.BYTE,normalized:!0,offset:12},{location:3,size:1,type:e.BYTE,offset:15},{location:2,size:4,type:e.UNSIGNED_BYTE,normalized:!0,offset:16}],s.count,s.indices));if(D)throw new Error("disposed");await se();const d=jo(r,h.map(i=>i.status)),C=Y(q(e,d,mo*x,[{location:0,size:3,type:e.FLOAT,offset:0},{location:1,size:3,type:e.FLOAT,offset:3*x},{location:2,size:3,type:e.FLOAT,offset:6*x},{location:3,size:3,type:e.FLOAT,offset:9*x}],d.length/mo)),m=[],a=[[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]],T=(i,B,O,Z,we,Fo,_o)=>{for(const[ko,Vo]of a)m.push(...i,ko,Vo,B,O,...Z,we,Fo,_o)};h.forEach((i,B)=>{const O=$[i.status],Z=H[B];if(O.halo){const we=i.status==="now"?.32:i.status==="next"?.16:.2;T([Z[0],2.4,Z[2]],O.haloSize,O.haloSize,ye(k(O.halo),we),0,i.status==="now"?1:0,B)}O.beam&&T([Z[0],3.6+46/2,Z[2]],.9,46,ye(k(O.halo),O.beam),1,0,B)});const v=Y(q(e,new Float32Array(m),13*x,[{location:0,size:3,type:e.FLOAT,offset:0},{location:1,size:2,type:e.FLOAT,offset:3*x},{location:2,size:2,type:e.FLOAT,offset:5*x},{location:3,size:3,type:e.FLOAT,offset:7*x},{location:4,size:3,type:e.FLOAT,offset:10*x}],m.length/13)),S=V?600:1400,L=new Float32Array(S*4);for(let i=0;i<S;i++)L.set([_(i,21)*60,_(i,22)*34,_(i,23)*60,.6+_(i,24)*.9],i*4);const b=Y(q(e,L,4*x,[{location:0,size:3,type:e.FLOAT,offset:0},{location:1,size:1,type:e.FLOAT,offset:3*x}],S)),I=new Float32Array(Math.max(1,ne)*3);for(let i=0;i<ne;i++)I.set([_(i,1)*Math.PI*2,1.4+_(i,2)*1.6,_(i,3)*5],i*3);const pe=Y(q(e,I,3*x,[{location:0,size:3,type:e.FLOAT,offset:0}],ne)),G=new Float32Array(re*4);for(let i=0;i<re;i++)G.set([_(i,31)*Math.PI*2,_(i,32)*1.8,_(i,33),i],i*4);const Fe=Y(q(e,G,4*x,[{location:0,size:4,type:e.FLOAT,offset:0}],re)),Co=e.createVertexArray(),ge=e.fenceSync(e.SYNC_GPU_COMMANDS_COMPLETE,0);e.flush();const So=()=>!ge||e.getSyncParameter(ge,e.SYNC_STATUS)===e.SIGNALED;for(;(!So()||!n.every(i=>Go(e,i,o)))&&!D;)await new Promise(i=>setTimeout(i,16));ge&&e.deleteSync(ge);const uo=[];for(const i of n){if(D)throw new Error("disposed");uo.push(Zo(e,i)),o||await se()}const[Po,Ao,Mo,To,Lo,zo,Eo]=uo;return{plan:r,voxel:Po,crystal:Ao,glow:Mo,sky:To,snow:Lo,spark:zo,burst:Eo,voxelMesh:g,crystalMesh:C,glowMesh:v,snowMesh:b,sparkMesh:pe,burstMesh:Fe,skyVao:Co}}const Me=document.createElement("div");Me.className="rmx-labels",c.appendChild(Me);const R=h.map((o,t)=>{const n=document.createElement("button");return n.type="button",n.className="rmx-label",n.dataset.status=o.status,n.tabIndex=-1,n.addEventListener("click",r=>{r.stopPropagation(),N(t)}),Me.appendChild(n),n}),le=[],ce=[],fe=[],Be=[],$e=()=>{le.length=0,ce.length=0,h.forEach((o,t)=>{var s;const n=Oo(o,(s=l.releases)==null?void 0:s[t]);if(R[t].replaceChildren(),n){const g=document.createElement("span");g.className="rmx-label-meta",g.textContent=n,R[t].appendChild(g)}const r=document.createElement("span");r.textContent=o.title[Ve],R[t].appendChild(r)})};$e();let z=Math.min(K-1,Math.max(0,l.initial??ee)),p=z,y=null;const ue={x:0,y:0},X={x:0,y:0};let W=[0,5,10];const A=xe(),Ke=xe(),M=xe(),Ue=xe();let E=1,F=1,He=52;function go(){const o=Ko(z),t=Uo(z),n=_e(o)+t*$o,r=vo(1,1.6,F/E),s=[n,2.2-r*1.6,o],g=[_e(o-14),1,o-14],d=wt(s,g,.38*(1-r)+.08*r),C=10.5+r*3,m=_e(o+C)-t*1.5;W=[m+(n-m)*.55*r+X.x*.9,4.8+r*1.2+X.y*.5,o+C],qo(A,W,d),Qo(Ke,He*Math.PI/180,E/F,.1,400),Jo(M,Ke,A),et(Ue,M)}let j=!0;function N(o){var n;const t=Math.min(K-1,Math.max(0,Math.round(o)));if(!(t===p&&!y)){if(p=t,R.forEach((r,s)=>r.classList.toggle("is-current",s===t)),(n=l.onSelect)==null||n.call(l,t),oe=-1,U)z=t,y=null,oe=ie;else{const r=Math.abs(t-z);y={from:z,to:t,start:performance.now(),duration:700+260*Math.sqrt(r)}}j=!0}}R.forEach((o,t)=>o.classList.toggle("is-current",t===p));let me=0,Te=0;const Ye=o=>{const t=Math.abs(o.deltaY)>Math.abs(o.deltaX)?o.deltaY:o.deltaX,n=performance.now();n>=Te&&!y&&(t<0&&p===0||t>0&&p===K-1)||(o.preventDefault(),!(n<Te)&&(me+=t,Math.abs(me)>50&&(N(p+Math.sign(me)),me=0,Te=n+450)))},Xe=o=>{const t={ArrowRight:1,ArrowDown:1,PageDown:1,ArrowLeft:-1,ArrowUp:-1,PageUp:-1};if(o.key in t)N(p+t[o.key]);else if(o.key==="Home")N(0);else if(o.key==="End")N(K-1);else return;o.preventDefault()};let ae=null,Le=!1;const Ge=o=>{Le=!1,ae=o.pointerType==="mouse"?null:{x:o.clientX,y:o.clientY}},Ze=o=>{if(!ae)return;const t=o.clientX-ae.x,n=o.clientY-ae.y;ae=null,Math.abs(t)>40&&Math.abs(t)>Math.abs(n)&&(Le=!0,N(p+(t<0?1:-1)))},qe=o=>{if(Le)return;const t=c.getBoundingClientRect(),n=o.clientX-t.left,r=o.clientY-t.top;let s=-1,g=1/0;H.forEach((d,C)=>{const m=ke(M,[d[0],d[1],d[2]]),a=ke(M,[d[0],d[1]+4.4,d[2]]);if(m[3]<=0||a[3]<=0)return;const T=(m[0]/m[3]*.5+.5)*E,v=(-m[1]/m[3]*.5+.5)*F,S=(a[0]/a[3]*.5+.5)*E,L=(-a[1]/a[3]*.5+.5)*F,b=S-T,I=L-v,pe=Math.min(1,Math.max(0,((n-T)*b+(r-v)*I)/(b*b+I*I||1))),G=Math.hypot(n-(T+b*pe),r-(v+I*pe)),Fe=Math.max(28,Math.hypot(b,I)*.3);G<Fe&&G<g&&(s=C,g=G)}),s>=0&&N(s)},Qe=o=>{if(U||o.pointerType!=="mouse")return;const t=c.getBoundingClientRect();ue.x=(o.clientX-t.left)/t.width*2-1,ue.y=-((o.clientY-t.top)/t.height)*2+1};let Je=!1;const eo=o=>{var t;o.preventDefault(),Je=!0,(t=l.onLost)==null||t.call(l)};c.addEventListener("wheel",Ye,{passive:!1}),c.addEventListener("keydown",Xe),c.addEventListener("pointerdown",Ge),c.addEventListener("pointerup",Ze),c.addEventListener("click",qe),c.addEventListener("pointermove",Qe),P.addEventListener("webglcontextlost",eo);const wo=Math.min(window.devicePixelRatio||1,V?1.5:2);let ve=1;const ze=()=>{E=Math.max(1,c.clientWidth),F=Math.max(1,c.clientHeight);const o=wo*ve;P.width=Math.max(1,Math.round(E*o)),P.height=Math.max(1,Math.round(F*o)),He=E<F?64:52,j=!0},oo=new ResizeObserver(ze);oo.observe(c);let to=!0;const ao=new IntersectionObserver(o=>{to=o.some(t=>t.isIntersecting)});ao.observe(c);const de=[],xo=o=>{if(de.push(o),de.length<45)return;const t=[...de].sort((r,s)=>r-s),n=t[t.length>>1];de.length=0,n>24&&ve>.55&&(ve=Math.max(.55,ve*.8),ze())};function yo(){const o=E<F?.7:2.4;h.forEach((n,r)=>{const s=R[r],g=Math.abs(r-z),d=g>o?0:1-vo(o*.45,o,g),C=H[r],m=ke(M,[C[0],C[1]+5.6,C[2]]),a=m[0]/m[3];if(!(d>.02&&m[3]>0&&Math.abs(a)<1.2)){fe[r]=null;return}const v=(le[r]||(le[r]=s.offsetWidth))/2,S=ce[r]||(ce[r]=s.offsetHeight),L=Math.min(E-v-8,Math.max(v+8,(a*.5+.5)*E)),b=(-(m[1]/m[3])*.5+.5)*F;fe[r]={left:L-v,top:b-S,right:L+v,bottom:b},Be[r]=d,s.style.transform=`translate(${L.toFixed(1)}px, ${b.toFixed(1)}px) translate(-50%, -100%)`});const t=Bo(fe,z);R.forEach((n,r)=>{const s=fe[r]&&!t.has(r)?Be[r]:0;n.style.opacity=String(s),n.style.pointerEvents=s>.4?"auto":"none"})}const no=new Float32Array(12),ro=new Float32Array(12),io=new Float32Array(4);pt.forEach((o,t)=>{no.set(k($[o].core),t*3),ro.set(k($[o].rim),t*3),io[t]=$[o].power});function bo(o){var L;if(go(),!u)return;const{plan:t,voxelMesh:n,crystalMesh:r,glowMesh:s,snowMesh:g,sparkMesh:d,burstMesh:C,skyVao:m}=u;if(e.viewport(0,0,P.width,P.height),e.clearColor(0,0,0,1),e.clearDepth(1),e.clear(e.COLOR_BUFFER_BIT|e.DEPTH_BUFFER_BIT),e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL),e.depthMask(!0),e.disable(e.BLEND),e.enable(e.CULL_FACE),Pe>=0){const b=1+.3*Math.sin(o*2.4);Se.set(ye(De[Pe],b),Pe*3)}let a=u.voxel.u;e.useProgram(u.voxel.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniform3fv(a.uLightPos,Ie),e.uniform3fv(a.uLightCol,Se),e.uniform1i(a.uLights,te),e.uniform3fv(a.uCam,W),e.uniform1f(a.uTime,o),e.uniform1f(a.uNowZ,t.nowZ),e.uniform3fv(a.uFog,Ae),e.uniform1f(a.uFogDensity,Re),e.uniform3fv(a.uMoonDir,ho),e.uniform1f(a.uEdge,t.reach),e.uniform1f(a.uZMin,t.zMin),Q(e,n),a=u.crystal.u,e.useProgram(u.crystal.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniform1f(a.uSelected,p),e.uniform1f(a.uTime,o),e.uniform3fv(a.uCam,W),e.uniform3fv(a.uFog,Ae),e.uniform1f(a.uFogDensity,Re),e.uniform3fv(a.uCore,no),e.uniform3fv(a.uRim,ro),e.uniform1fv(a.uPower,io),Q(e,r),e.disable(e.CULL_FACE),a=u.sky.u,e.useProgram(u.sky.program),e.depthMask(!1),e.uniformMatrix4fv(a.uInvViewProj,!1,Ue),e.uniform3fv(a.uCam,W),e.uniform3fv(a.uFog,Ae),e.uniform1f(a.uTime,o),e.uniform1i(a.uAuroraSteps,V?4:7),e.bindVertexArray(m),e.drawArrays(e.TRIANGLES,0,3),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),a=u.glow.u,e.useProgram(u.glow.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniform3fv(a.uCam,W),e.uniform3f(a.uCamRight,A[0],A[4],A[8]),e.uniform3f(a.uCamUp,A[1],A[5],A[9]),e.uniform1f(a.uTime,o),e.uniform1f(a.uSelected,p),Q(e,s);const T=P.height/F;ne>0&&(a=u.spark.u,e.useProgram(u.spark.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniformMatrix4fv(a.uView,!1,A),e.uniform3fv(a.uCenter,H[ee]),e.uniform1f(a.uTime,o),e.uniform1f(a.uPixel,T),e.uniform3fv(a.uColor,k($.now.rim)),Q(e,d,e.POINTS));const v=(L=l.stats)==null?void 0:L[p],S=v?v.added+v.improved+v.fixed:0;S>0&&oe>=0&&(a=u.burst.u,e.useProgram(u.burst.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniformMatrix4fv(a.uView,!1,A),e.uniform3fv(a.uCenter,H[p]),e.uniform1f(a.uTime,o),e.uniform1f(a.uAge,U?10:o-oe),e.uniform1f(a.uPixel,T),e.uniform1f(a.uCount,Math.min(re,S)),e.uniform2f(a.uShare,v.added/S,(v.added+v.improved)/S),e.uniform3fv(a.uAdded,Ce.added),e.uniform3fv(a.uImproved,Ce.improved),e.uniform3fv(a.uFixed,Ce.fixed),Q(e,C,e.POINTS)),U||(e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA),a=u.snow.u,e.useProgram(u.snow.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniformMatrix4fv(a.uView,!1,A),e.uniform3fv(a.uCam,W),e.uniform1f(a.uTime,o),e.uniform1f(a.uPixel,T),Q(e,g,e.POINTS)),e.depthMask(!0),e.bindVertexArray(null)}let Ee=0,so=performance.now(),he=0;const lo=o=>{Ee=requestAnimationFrame(lo);const t=Math.min(.05,(o-so)/1e3);if(so=o,!(!to||document.hidden||Je)){if(y){const n=Math.min(1,(o-y.start)/y.duration);z=y.from+(y.to-y.from)*gt(n),n>=1&&(z=y.to,y=null,oe=ie),j=!0}if(!U){ie+=t;const n=1-Math.pow(.001,t);X.x+=(ue.x-X.x)*n,X.y+=(ue.y-X.y)*n,V&&!y&&o-he<30||(j=!0)}j&&(j=!1,he&&!U&&xo(o-he),he=o,bo(ie),yo())}};return ze(),(fo=l.onSelect)==null||fo.call(l,p),Ee=requestAnimationFrame(lo),P.style.opacity="0",po().then(o=>{D||(u=o,P.style.opacity="1",j=!0)},o=>{var t;D||(console.error("[roadmap] scene build failed:",o),(t=l.onLost)==null||t.call(l))}),{get index(){return p},select:N,step:o=>N(p+o),setLang(o){Ve=o,$e()},dispose(){var o;cancelAnimationFrame(Ee),oo.disconnect(),ao.disconnect(),c.removeEventListener("wheel",Ye),c.removeEventListener("keydown",Xe),c.removeEventListener("pointerdown",Ge),c.removeEventListener("pointerup",Ze),c.removeEventListener("click",qe),c.removeEventListener("pointermove",Qe),P.removeEventListener("webglcontextlost",eo),D=!0;for(const t of je)Yo(e,t);for(const t of We)e.deleteProgram(t);u&&e.deleteVertexArray(u.skyVao),u=null,(o=e.getExtension("WEBGL_lose_context"))==null||o.loseContext(),c.remove()}}}export{Et as createRoadmapScene,zt as roadmapSceneSupported};
