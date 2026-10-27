import{n as ko,i as _o}from"./RoadmapPage.D1hJjCdm.js";import{webgl2Supported as Vo,linear as z,deleteMesh as No,project as Ee,startProgram as Oo,createMesh as q,programReady as Io,finishProgram as Do,mat4 as ge,drawMesh as Q,lookAt as Ro,perspective as Wo,multiply as jo,invert as Bo}from"./gl.6Z7s-pT5.js";import{c as $o,p as Ko,m as Uo,V as Ho,a as Yo,C as co,h as E,s as fo,b as Fe,d as Xo,e as Go,g as Zo}from"./world.lP_-KEAJ.js";import"./framework.CnT1yzXN.js";import"./releaseKind.EczTz7I-.js";import"./theme.D5pebRRj.js";import"./roadmap-text.3NznEjs1.js";import"./date-formatter.ChLD7W9f.js";import"./arrow-left-01.CgRlM3YQ.js";const xe=`
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
`,J=16,qo=`${w}
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
}`,Qo=`${w}
${xe}
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
}`,Jo=`${w}
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
}`,et=`${w}
${xe}
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
}`,ot=`${w}
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
}`,tt=`${w}
${xe}
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
}`,at=`${w}
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vNdc;
void main() {
  vNdc = P[gl_VertexID];
  // z = w: the depth is 1.0, so only pixels nothing else covered get sky.
  gl_Position = vec4(vNdc, 1.0, 1.0);
}`,nt=`${w}
${xe}
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
}`,rt=`${w}
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
}`,it=`${w}
in float vAlpha;
out vec4 frag;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * vAlpha * 0.8;
  frag = vec4(vec3(0.9, 0.95, 1.0) * a, a);
}`,st=`${w}
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
}`,lt=`${w}
in float vAlpha;
uniform vec3 uColor;
out vec4 frag;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vAlpha;
  frag = vec4(pow(uColor * a, vec3(1.0 / 2.2)), 1.0);
}`,ct=`${w}
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
}`,ft=`${w}
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
}`,ut=858160,B={done:{core:3127278,rim:14219007,power:.8,halo:2282478,haloSize:6,beam:.22,light:2282478,lightPower:.45},now:{core:7336186,rim:15793919,power:1,halo:6220500,haloSize:8,beam:.35,light:6220500,lightPower:1.1},next:{core:7307248,rim:14673407,power:.6,halo:6514417,haloSize:5,beam:0,light:6514417,lightPower:.25},later:{core:2042432,rim:10465484,power:.75,halo:0,haloSize:0,beam:0,light:0,lightPower:0}},mt=["done","now","next","later"],vt=f=>f<.5?4*f*f*f:1-Math.pow(-2*f+2,3)/2,we=(f,s)=>[f[0]*s,f[1]*s,f[2]*s],dt=(f,s,d)=>[f[0]+(s[0]-f[0])*d,f[1]+(s[1]-f[1])*d,f[2]+(s[2]-f[2])*d],ht=`
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
`;function pt(){if(document.getElementById("rmx-style"))return;const f=document.createElement("style");f.id="rmx-style",f.textContent=ht,document.head.appendChild(f)}const Mt=Vo;function Tt(f,s){var io,so;const d=s.items,$=d.length;if($===0)throw new Error("roadmap: no items");const F=s.quality==="low",K=s.reducedMotion===!0,ee=ko(d);let ke=s.lang;pt();const c=document.createElement("div");c.className="rmx-root",c.tabIndex=0,f.appendChild(c);const P=document.createElement("canvas");c.appendChild(P);const _e=P.getContext("webgl2",{antialias:!F,alpha:!1,powerPreference:F?"low-power":"high-performance",preserveDrawingBuffer:!1});if(!_e)throw c.remove(),new Error("roadmap: WebGL2 is not available");const e=_e,U=d.map((o,t)=>$o(t)),Ve=((io=d[ee])==null?void 0:io.status)==="now",ne=Ve?90:0,re=F?90:160,ye={added:z(2282478),improved:z(4906624),fixed:z(16486972)};let oe=0,ie=0;const Ne=new Float32Array(J*3),be=new Float32Array(J*3),Oe=[];let te=0;d.forEach((o,t)=>{const n=B[o.status];if(!n.light||te>=J)return;const i=U[t];Ne.set([i[0],1.6,i[2]],te*3);const l=we(z(n.light),n.lightPower);Oe.push(l),be.set(l,te*3),te++});const Ce=Ve?d.slice(0,ee).filter(o=>B[o.status].light).length:-1,Se=z(ut),uo=(()=>{const o=[-.45,.75,.35],t=Math.hypot(...o);return[o[0]/t,o[1]/t,o[2]/t]})(),Ie=F?.03:.025,De=[],Re=[],H=o=>(Re.push(o),o);let I=!1;const x=4;let u=null;const se=()=>new Promise(o=>setTimeout(o,0));async function mo(){const o=!!e.getExtension("KHR_parallel_shader_compile"),n=[[qo,Qo],[Jo,et],[ot,tt],[at,nt],[rt,it],[st,lt],[ct,ft]].map(([r,j])=>Oo(e,r,j));for(const r of n)De.push(r.program);await se();const i=Ko($,ee,F);if(I)throw new Error("disposed");await se();const l=Uo(i),C=H(q(e,l.data,Ho,[{location:0,size:3,type:e.FLOAT,offset:0},{location:1,size:3,type:e.BYTE,normalized:!0,offset:12},{location:3,size:1,type:e.BYTE,offset:15},{location:2,size:4,type:e.UNSIGNED_BYTE,normalized:!0,offset:16}],l.count,l.indices));if(I)throw new Error("disposed");await se();const m=Yo(i,d.map(r=>r.status)),g=H(q(e,m,co*x,[{location:0,size:3,type:e.FLOAT,offset:0},{location:1,size:3,type:e.FLOAT,offset:3*x},{location:2,size:3,type:e.FLOAT,offset:6*x},{location:3,size:3,type:e.FLOAT,offset:9*x}],m.length/co)),v=[],a=[[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]],b=(r,j,N,Z,pe,Lo,zo)=>{for(const[Eo,Fo]of a)v.push(...r,Eo,Fo,j,N,...Z,pe,Lo,zo)};d.forEach((r,j)=>{const N=B[r.status],Z=U[j];if(N.halo){const pe=r.status==="now"?.32:r.status==="next"?.16:.2;b([Z[0],2.4,Z[2]],N.haloSize,N.haloSize,we(z(N.halo),pe),0,r.status==="now"?1:0,j)}N.beam&&b([Z[0],3.6+46/2,Z[2]],.9,46,we(z(N.halo),N.beam),1,0,j)});const p=H(q(e,new Float32Array(v),13*x,[{location:0,size:3,type:e.FLOAT,offset:0},{location:1,size:2,type:e.FLOAT,offset:3*x},{location:2,size:2,type:e.FLOAT,offset:5*x},{location:3,size:3,type:e.FLOAT,offset:7*x},{location:4,size:3,type:e.FLOAT,offset:10*x}],v.length/13)),S=F?600:1400,W=new Float32Array(S*4);for(let r=0;r<S;r++)W.set([E(r,21)*60,E(r,22)*34,E(r,23)*60,.6+E(r,24)*.9],r*4);const V=H(q(e,W,4*x,[{location:0,size:3,type:e.FLOAT,offset:0},{location:1,size:1,type:e.FLOAT,offset:3*x}],S)),O=new Float32Array(Math.max(1,ne)*3);for(let r=0;r<ne;r++)O.set([E(r,1)*Math.PI*2,1.4+E(r,2)*1.6,E(r,3)*5],r*3);const de=H(q(e,O,3*x,[{location:0,size:3,type:e.FLOAT,offset:0}],ne)),G=new Float32Array(re*4);for(let r=0;r<re;r++)G.set([E(r,31)*Math.PI*2,E(r,32)*1.8,E(r,33),r],r*4);const ze=H(q(e,G,4*x,[{location:0,size:4,type:e.FLOAT,offset:0}],re)),xo=e.createVertexArray(),he=e.fenceSync(e.SYNC_GPU_COMMANDS_COMPLETE,0);e.flush();const yo=()=>!he||e.getSyncParameter(he,e.SYNC_STATUS)===e.SIGNALED;for(;(!yo()||!n.every(r=>Io(e,r,o)))&&!I;)await new Promise(r=>setTimeout(r,16));he&&e.deleteSync(he);const lo=[];for(const r of n){if(I)throw new Error("disposed");lo.push(Do(e,r)),o||await se()}const[bo,Co,So,Po,Ao,Mo,To]=lo;return{plan:i,voxel:bo,crystal:Co,glow:So,sky:Po,snow:Ao,spark:Mo,burst:To,voxelMesh:C,crystalMesh:g,glowMesh:p,snowMesh:V,sparkMesh:de,burstMesh:ze,skyVao:xo}}const Pe=document.createElement("div");Pe.className="rmx-labels",c.appendChild(Pe);const Y=d.map((o,t)=>{const n=document.createElement("button");return n.type="button",n.className="rmx-label",n.dataset.status=o.status,n.tabIndex=-1,n.addEventListener("click",i=>{i.stopPropagation(),_(t)}),Pe.appendChild(n),n}),le=[],We=()=>{le.length=0,d.forEach((o,t)=>{const n=_o(o);if(Y[t].replaceChildren(),n){const l=document.createElement("span");l.className="rmx-label-meta",l.textContent=n,Y[t].appendChild(l)}const i=document.createElement("span");i.textContent=o.title[ke],Y[t].appendChild(i)})};We();let k=Math.min($-1,Math.max(0,s.initial??ee)),h=k,y=null;const ce={x:0,y:0},X={x:0,y:0};let D=[0,5,10];const A=ge(),je=ge(),M=ge(),Be=ge();let T=1,L=1,$e=52;function vo(){const o=Go(k),t=Zo(k),n=Fe(o)+t*Xo,i=fo(1,1.6,L/T),l=[n,2.2-i*1.6,o],C=[Fe(o-14),1,o-14],m=dt(l,C,.38*(1-i)+.08*i),g=10.5+i*3,v=Fe(o+g)-t*1.5;D=[v+(n-v)*.55*i+X.x*.9,4.8+i*1.2+X.y*.5,o+g],Ro(A,D,m),Wo(je,$e*Math.PI/180,T/L,.1,400),jo(M,je,A),Bo(Be,M)}let R=!0;function _(o){var n;const t=Math.min($-1,Math.max(0,Math.round(o)));if(!(t===h&&!y)){if(h=t,Y.forEach((i,l)=>i.classList.toggle("is-current",l===t)),(n=s.onSelect)==null||n.call(s,t),oe=-1,K)k=t,y=null,oe=ie;else{const i=Math.abs(t-k);y={from:k,to:t,start:performance.now(),duration:700+260*Math.sqrt(i)}}R=!0}}Y.forEach((o,t)=>o.classList.toggle("is-current",t===h));let fe=0,Ae=0;const Ke=o=>{const t=Math.abs(o.deltaY)>Math.abs(o.deltaX)?o.deltaY:o.deltaX,n=performance.now();n>=Ae&&!y&&(t<0&&h===0||t>0&&h===$-1)||(o.preventDefault(),!(n<Ae)&&(fe+=t,Math.abs(fe)>50&&(_(h+Math.sign(fe)),fe=0,Ae=n+450)))},Ue=o=>{const t={ArrowRight:1,ArrowDown:1,PageDown:1,ArrowLeft:-1,ArrowUp:-1,PageUp:-1};if(o.key in t)_(h+t[o.key]);else if(o.key==="Home")_(0);else if(o.key==="End")_($-1);else return;o.preventDefault()};let ae=null,Me=!1;const He=o=>{Me=!1,ae=o.pointerType==="mouse"?null:{x:o.clientX,y:o.clientY}},Ye=o=>{if(!ae)return;const t=o.clientX-ae.x,n=o.clientY-ae.y;ae=null,Math.abs(t)>40&&Math.abs(t)>Math.abs(n)&&(Me=!0,_(h+(t<0?1:-1)))},Xe=o=>{if(Me)return;const t=c.getBoundingClientRect(),n=o.clientX-t.left,i=o.clientY-t.top;let l=-1,C=1/0;U.forEach((m,g)=>{const v=Ee(M,[m[0],m[1],m[2]]),a=Ee(M,[m[0],m[1]+4.4,m[2]]);if(v[3]<=0||a[3]<=0)return;const b=(v[0]/v[3]*.5+.5)*T,p=(-v[1]/v[3]*.5+.5)*L,S=(a[0]/a[3]*.5+.5)*T,W=(-a[1]/a[3]*.5+.5)*L,V=S-b,O=W-p,de=Math.min(1,Math.max(0,((n-b)*V+(i-p)*O)/(V*V+O*O||1))),G=Math.hypot(n-(b+V*de),i-(p+O*de)),ze=Math.max(28,Math.hypot(V,O)*.3);G<ze&&G<C&&(l=g,C=G)}),l>=0&&_(l)},Ge=o=>{if(K||o.pointerType!=="mouse")return;const t=c.getBoundingClientRect();ce.x=(o.clientX-t.left)/t.width*2-1,ce.y=-((o.clientY-t.top)/t.height)*2+1};let Ze=!1;const qe=o=>{var t;o.preventDefault(),Ze=!0,(t=s.onLost)==null||t.call(s)};c.addEventListener("wheel",Ke,{passive:!1}),c.addEventListener("keydown",Ue),c.addEventListener("pointerdown",He),c.addEventListener("pointerup",Ye),c.addEventListener("click",Xe),c.addEventListener("pointermove",Ge),P.addEventListener("webglcontextlost",qe);const ho=Math.min(window.devicePixelRatio||1,F?1.5:2);let ue=1;const Te=()=>{T=Math.max(1,c.clientWidth),L=Math.max(1,c.clientHeight);const o=ho*ue;P.width=Math.max(1,Math.round(T*o)),P.height=Math.max(1,Math.round(L*o)),$e=T<L?64:52,R=!0},Qe=new ResizeObserver(Te);Qe.observe(c);let Je=!0;const eo=new IntersectionObserver(o=>{Je=o.some(t=>t.isIntersecting)});eo.observe(c);const me=[],po=o=>{if(me.push(o),me.length<45)return;const t=[...me].sort((i,l)=>i-l),n=t[t.length>>1];me.length=0,n>24&&ue>.55&&(ue=Math.max(.55,ue*.8),Te())};function go(){d.forEach((o,t)=>{const n=Y[t],i=Math.abs(t-k),l=T<L?.7:2.4,C=i>l?0:1-fo(l*.45,l,i),m=U[t],g=Ee(M,[m[0],m[1]+5.6,m[2]]),v=g[0]/g[3];if(!(C>.02&&g[3]>0&&Math.abs(v)<1.2)){n.style.opacity="0",n.style.pointerEvents="none";return}const b=(le[t]||(le[t]=n.offsetWidth))/2,p=Math.min(T-b-8,Math.max(b+8,(v*.5+.5)*T)),S=(-(g[1]/g[3])*.5+.5)*L;n.style.opacity=String(C),n.style.pointerEvents=C>.4?"auto":"none",n.style.transform=`translate(${p.toFixed(1)}px, ${S.toFixed(1)}px) translate(-50%, -100%)`})}const oo=new Float32Array(12),to=new Float32Array(12),ao=new Float32Array(4);mt.forEach((o,t)=>{oo.set(z(B[o].core),t*3),to.set(z(B[o].rim),t*3),ao[t]=B[o].power});function wo(o){var W;if(vo(),!u)return;const{plan:t,voxelMesh:n,crystalMesh:i,glowMesh:l,snowMesh:C,sparkMesh:m,burstMesh:g,skyVao:v}=u;if(e.viewport(0,0,P.width,P.height),e.clearColor(0,0,0,1),e.clearDepth(1),e.clear(e.COLOR_BUFFER_BIT|e.DEPTH_BUFFER_BIT),e.enable(e.DEPTH_TEST),e.depthFunc(e.LEQUAL),e.depthMask(!0),e.disable(e.BLEND),e.enable(e.CULL_FACE),Ce>=0){const V=1+.3*Math.sin(o*2.4);be.set(we(Oe[Ce],V),Ce*3)}let a=u.voxel.u;e.useProgram(u.voxel.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniform3fv(a.uLightPos,Ne),e.uniform3fv(a.uLightCol,be),e.uniform1i(a.uLights,te),e.uniform3fv(a.uCam,D),e.uniform1f(a.uTime,o),e.uniform1f(a.uNowZ,t.nowZ),e.uniform3fv(a.uFog,Se),e.uniform1f(a.uFogDensity,Ie),e.uniform3fv(a.uMoonDir,uo),e.uniform1f(a.uEdge,t.reach),e.uniform1f(a.uZMin,t.zMin),Q(e,n),a=u.crystal.u,e.useProgram(u.crystal.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniform1f(a.uSelected,h),e.uniform1f(a.uTime,o),e.uniform3fv(a.uCam,D),e.uniform3fv(a.uFog,Se),e.uniform1f(a.uFogDensity,Ie),e.uniform3fv(a.uCore,oo),e.uniform3fv(a.uRim,to),e.uniform1fv(a.uPower,ao),Q(e,i),e.disable(e.CULL_FACE),a=u.sky.u,e.useProgram(u.sky.program),e.depthMask(!1),e.uniformMatrix4fv(a.uInvViewProj,!1,Be),e.uniform3fv(a.uCam,D),e.uniform3fv(a.uFog,Se),e.uniform1f(a.uTime,o),e.uniform1i(a.uAuroraSteps,F?4:7),e.bindVertexArray(v),e.drawArrays(e.TRIANGLES,0,3),e.enable(e.BLEND),e.blendFunc(e.ONE,e.ONE),a=u.glow.u,e.useProgram(u.glow.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniform3fv(a.uCam,D),e.uniform3f(a.uCamRight,A[0],A[4],A[8]),e.uniform3f(a.uCamUp,A[1],A[5],A[9]),e.uniform1f(a.uTime,o),e.uniform1f(a.uSelected,h),Q(e,l);const b=P.height/L;ne>0&&(a=u.spark.u,e.useProgram(u.spark.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniformMatrix4fv(a.uView,!1,A),e.uniform3fv(a.uCenter,U[ee]),e.uniform1f(a.uTime,o),e.uniform1f(a.uPixel,b),e.uniform3fv(a.uColor,z(B.now.rim)),Q(e,m,e.POINTS));const p=(W=s.stats)==null?void 0:W[h],S=p?p.added+p.improved+p.fixed:0;S>0&&oe>=0&&(a=u.burst.u,e.useProgram(u.burst.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniformMatrix4fv(a.uView,!1,A),e.uniform3fv(a.uCenter,U[h]),e.uniform1f(a.uTime,o),e.uniform1f(a.uAge,K?10:o-oe),e.uniform1f(a.uPixel,b),e.uniform1f(a.uCount,Math.min(re,S)),e.uniform2f(a.uShare,p.added/S,(p.added+p.improved)/S),e.uniform3fv(a.uAdded,ye.added),e.uniform3fv(a.uImproved,ye.improved),e.uniform3fv(a.uFixed,ye.fixed),Q(e,g,e.POINTS)),K||(e.blendFunc(e.ONE,e.ONE_MINUS_SRC_ALPHA),a=u.snow.u,e.useProgram(u.snow.program),e.uniformMatrix4fv(a.uViewProj,!1,M),e.uniformMatrix4fv(a.uView,!1,A),e.uniform3fv(a.uCam,D),e.uniform1f(a.uTime,o),e.uniform1f(a.uPixel,b),Q(e,C,e.POINTS)),e.depthMask(!0),e.bindVertexArray(null)}let Le=0,no=performance.now(),ve=0;const ro=o=>{Le=requestAnimationFrame(ro);const t=Math.min(.05,(o-no)/1e3);if(no=o,!(!Je||document.hidden||Ze)){if(y){const n=Math.min(1,(o-y.start)/y.duration);k=y.from+(y.to-y.from)*vt(n),n>=1&&(k=y.to,y=null,oe=ie),R=!0}if(!K){ie+=t;const n=1-Math.pow(.001,t);X.x+=(ce.x-X.x)*n,X.y+=(ce.y-X.y)*n,F&&!y&&o-ve<30||(R=!0)}R&&(R=!1,ve&&!K&&po(o-ve),ve=o,wo(ie),go())}};return Te(),(so=s.onSelect)==null||so.call(s,h),Le=requestAnimationFrame(ro),P.style.opacity="0",mo().then(o=>{I||(u=o,P.style.opacity="1",R=!0)},o=>{var t;I||(console.error("[roadmap] scene build failed:",o),(t=s.onLost)==null||t.call(s))}),{get index(){return h},select:_,step:o=>_(h+o),setLang(o){ke=o,We()},dispose(){var o;cancelAnimationFrame(Le),Qe.disconnect(),eo.disconnect(),c.removeEventListener("wheel",Ke),c.removeEventListener("keydown",Ue),c.removeEventListener("pointerdown",He),c.removeEventListener("pointerup",Ye),c.removeEventListener("click",Xe),c.removeEventListener("pointermove",Ge),P.removeEventListener("webglcontextlost",qe),I=!0;for(const t of Re)No(e,t);for(const t of De)e.deleteProgram(t);u&&e.deleteVertexArray(u.skyVao),u=null,(o=e.getExtension("WEBGL_lose_context"))==null||o.loseContext(),c.remove()}}}export{Tt as createRoadmapScene,Mt as roadmapSceneSupported};
