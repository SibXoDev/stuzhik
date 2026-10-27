import{createMesh as gt,finishProgram as k,startProgram as tt,linear as D,deleteMesh as Dt,project as et,drawMesh as xt,mat4 as ot,lookAt as Vt,perspective as _t,multiply as Ft}from"./gl.6Z7s-pT5.js";import{h as u}from"./world.lP_-KEAJ.js";import{n as Nt}from"./RoadmapPage.D1hJjCdm.js";import{c as Ot,a as Rt,b as at,d as jt,e as qt,f as Ut,s as yt}from"./common.Ba6ndjCz.js";import"./framework.CnT1yzXN.js";import"./releaseKind.EczTz7I-.js";import"./theme.D5pebRRj.js";import"./roadmap-text.3NznEjs1.js";import"./date-formatter.ChLD7W9f.js";import"./arrow-left-01.CgRlM3YQ.js";const St=17,U=`#version 300 es
precision highp float;
`,wt={done:0,now:1,next:2,later:3};function st(v){return[v*St,4.2*Math.sin(v*1.1)+1.8*Math.cos(v*.43)]}function Bt(v,r){const[y,b]=st(v),P=r?r.added+r.improved+r.fixed:0,M=Math.min(7,3.2+1.7*Math.sqrt(P/30)),d=5+Math.floor(u(v,3.1)*3),c=[];let p=u(v,1.7)*Math.PI*2;for(let s=0;s<d;s++){const T=M*(.45+.55*u(v*7+s,2.3));c.push([y+Math.cos(p)*T,b+Math.sin(p)*T*.78]),p+=Math.PI*2/d*(.7+.6*u(v,s+5.5))}const t=[];for(let s=0;s<d-1;s++)t.push([s,s+1]);t.push([1,Math.floor(d/2)+1<d?Math.floor(d/2)+1:d-1]);const B=[];for(let s=0;s<P;s++){const T=r&&s<r.added?0:r&&s<r.added+r.improved?1:2,[E,V]=t[Math.floor(u(v*13+s,.37)*t.length)],I=u(s,v+.71),H=u(s*3.1,v*1.3)+u(s*1.7,v*2.9)-1,C=u(s*2.3,v*.7)+u(s*5.1,v*4.1)-1;B.push({x:c[E][0]+(c[V][0]-c[E][0])*I+H*.9,y:c[E][1]+(c[V][1]-c[E][1])*I+C*.9,kind:T})}return{center:[y,b],radius:M,anchors:c,edges:t,stars:B}}const $t=`${U}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aInfo;   // milestone, type (0 anchor, 1 change, 2 dust, 3 nebula, 4 forming), kind/status, seed
layout(location = 2) in float aSize;
uniform mat4 uViewProj;
uniform mat4 uView;
uniform float uS;
uniform float uTarget;
uniform float uAge;
uniform float uTime;
uniform float uPixel;
uniform vec3 uKind[3];
uniform vec3 uStatus[4];
uniform vec2 uCenter;
out vec3 vColor;
out float vAlpha;
out float vSoft;
out float vSpike;
void main() {
  float type = aInfo.y;
  vSpike = 0.0;
  float seed = aInfo.w;
  float focus = 1.0 - smoothstep(0.0, 1.2, abs(aInfo.x - uS));
  vec3 p = aPos;
  float size = aSize;
  float alpha = 1.0;
  vSoft = 0.0;
  if (type < 0.5) {
    int st = int(aInfo.z + 0.5);
    vColor = uStatus[st];
    float pulse = st == 1 ? 0.75 + 0.25 * sin(uTime * 2.4) : 1.0;
    alpha = (st >= 2 ? 0.55 : 1.0) * pulse * (0.55 + 0.45 * focus);
    size *= 1.4 + 0.5 * focus;
    // Bright stars get diffraction spikes, like through a telescope.
    vSpike = st < 2 ? focus : 0.0;
  } else if (type < 1.5) {
    vColor = uKind[int(aInfo.z + 0.5)];
    // The opened constellation blooms out from its centre on arrival.
    bool opened = abs(aInfo.x - uTarget) < 0.5;
    float bloom = opened ? 1.0 - exp(-uAge * 2.2) : 1.0;
    p.xy = mix(uCenter, p.xy, opened ? bloom : 1.0);
    float tw = 0.7 + 0.3 * sin(uTime * (1.3 + seed * 2.0) + seed * 40.0);
    alpha = tw * (0.28 + 0.72 * focus);
    size *= 0.8 + 0.5 * focus;
  } else if (type < 2.5) {
    vColor = vec3(0.78, 0.86, 1.0);
    alpha = 0.35 + 0.35 * sin(uTime * (0.6 + seed) + seed * 90.0);
  } else if (type < 3.5) {
    vColor = mix(vec3(0.10, 0.45, 0.55), vec3(0.32, 0.18, 0.55), seed);
    alpha = 0.10;
    vSoft = 1.0;
  } else {
    // The milestone in progress: dust still swirling into shape.
    float a = seed * 6.2831 + uTime * (0.25 + 0.35 * fract(seed * 7.0));
    float r = 0.6 + 3.6 * fract(seed * 13.0);
    p = vec3(aPos.x + cos(a) * r, aPos.y + sin(a) * r * 0.7, aPos.z);
    vColor = mix(vec3(0.37, 0.92, 0.83), vec3(0.6, 0.85, 1.0), fract(seed * 3.0));
    alpha = (0.35 + 0.35 * sin(uTime * 2.0 + seed * 20.0)) * (0.4 + 0.6 * focus);
  }
  vAlpha = alpha;
  vec4 mv = uView * vec4(p, 1.0);
  gl_PointSize = clamp(size * uPixel * 75.0 / max(-mv.z, 0.1), 1.0, 64.0);
  gl_Position = uViewProj * vec4(p, 1.0);
}`,Kt=`${U}
in vec3 vColor;
in float vAlpha;
in float vSoft;
in float vSpike;
out vec4 frag;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0;
  float d = length(q);
  float a;
  if (vSoft > 0.5) a = exp(-d * d * 3.0) * (1.0 - smoothstep(0.85, 1.0, d));
  else a = exp(-d * d * 5.0) * 0.6 + smoothstep(0.28, 0.0, d);
  if (vSpike > 0.0) {
    float spikes = exp(-abs(q.x) * 22.0) * (1.0 - abs(q.y)) + exp(-abs(q.y) * 22.0) * (1.0 - abs(q.x));
    a += spikes * 0.55 * vSpike;
  }
  vec3 c = vColor * a * vAlpha;
  frag = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`,Gt=`${U}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aInfo;   // milestone, along 0..1, status, distance
uniform mat4 uViewProj;
uniform float uS;
uniform float uTarget;
uniform float uDraw;
out float vAlpha;
out float vDist;
flat out int vStatus;
void main() {
  float focus = 1.0 - smoothstep(0.0, 1.2, abs(aInfo.x - uS));
  bool opened = abs(aInfo.x - uTarget) < 0.5;
  float drawn = opened ? smoothstep(aInfo.y - 0.04, aInfo.y, uDraw) : 1.0;
  vStatus = int(aInfo.z + 0.5);
  vAlpha = (0.16 + 0.5 * focus) * drawn;
  vDist = aInfo.w;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`,Wt=`${U}
in float vAlpha;
in float vDist;
flat in int vStatus;
uniform vec3 uStatus[4];
out vec4 frag;
void main() {
  // Plans are drawn dashed: the outline of something not there yet.
  float dash = vStatus >= 2 ? step(0.5, fract(vDist * 1.6)) : 1.0;
  vec3 c = uStatus[vStatus] * vAlpha * dash;
  frag = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`,Ht=`${U}
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() { vUv = P[gl_VertexID] * 0.5 + 0.5; gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`,Yt=`${U}
in vec2 vUv;
uniform float uShift;
uniform float uAspect;
out vec4 frag;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.55 + vnoise(p * 2.1) * 0.28 + vnoise(p * 4.3) * 0.17; }
void main() {
  vec3 top = vec3(0.0015, 0.002, 0.008);
  vec3 low = vec3(0.006, 0.01, 0.026);
  vec3 c = mix(low, top, smoothstep(0.0, 1.0, vUv.y));
  // The Milky Way: a slanted band of noise with darker dust lanes, sliding
  // slowly with the camera (it is far away).
  vec2 p = vec2(vUv.x * uAspect + uShift * 0.02, vUv.y);
  float band = vUv.y - (0.32 + 0.22 * sin(p.x * 0.9 + 0.6));
  float glow = exp(-band * band * 26.0);
  float cloud = fbm(p * vec2(3.0, 5.0));
  float lanes = smoothstep(0.45, 0.75, fbm(p * vec2(6.0, 11.0) + 3.0));
  float milky = glow * (0.35 + 0.65 * cloud) * (1.0 - 0.6 * lanes);
  c += mix(vec3(0.02, 0.05, 0.07), vec3(0.06, 0.035, 0.09), cloud) * milky * 0.9;
  c = pow(c, vec3(1.0 / 2.2)) + (h21(gl_FragCoord.xy) - 0.5) / 255.0;
  frag = vec4(c, 1.0);
}`;function ne(v,r){var dt;const y=r.items,b=y.length,P=r.quality==="low",M=r.reducedMotion===!0;let d=r.lang;const c=Ot(v);c.style.setProperty("--rmc-bg","rgba(4,6,16,.5)");const p=document.createElement("canvas");c.appendChild(p);const t=p.getContext("webgl2",{antialias:!P,alpha:!1,preserveDrawingBuffer:!1});if(!t)throw c.remove(),new Error("roadmap: WebGL2 is not available");let B=!1;p.addEventListener("webglcontextlost",e=>{var o;e.preventDefault(),B||(o=r.onLost)==null||o.call(r)});const s=y.map((e,o)=>{var f;return Bt(o,(f=r.stats)==null?void 0:f[o])}),T=Nt(y),E=8,V=[],I=(e,o,f,a,n,m,l,h)=>V.push(e,o,f,a,n,m,l,h);s.forEach((e,o)=>{const f=wt[y[o].status];if(e.anchors.forEach(([a,n],m)=>I(a,n,0,o,0,f,u(o,m),3.2+u(m,o)*1.8)),e.stars.forEach((a,n)=>I(a.x,a.y,0,o,1,a.kind,u(n,o*3.7),1.2+u(o,n*1.9)*1.1)),o===T&&y[o].status==="now")for(let a=0;a<(P?70:140);a++)I(e.center[0],e.center[1],0,o,4,0,u(a,91),.9)});const H=(b-1)*St;for(let e=0;e<(P?1600:3600);e++)I(-60+u(e,1)*(H+120),-40+u(e,2)*80,-90+u(e,3)*80,-10,2,0,u(e,4),.6+u(e,5)*1.2);const C=4,nt=gt(t,new Float32Array(V),E*C,[{location:0,size:3,type:t.FLOAT,offset:0},{location:1,size:4,type:t.FLOAT,offset:3*C},{location:2,size:1,type:t.FLOAT,offset:7*C}],V.length/E),Y=[];s.forEach((e,o)=>{const f=wt[y[o].status],a=e.edges.map(([l,h])=>Math.hypot(e.anchors[h][0]-e.anchors[l][0],e.anchors[h][1]-e.anchors[l][1])),n=a.reduce((l,h)=>l+h,0);let m=0;e.edges.forEach(([l,h],K)=>{const[L,O]=e.anchors[l],[A,W]=e.anchors[h],z=a[K],R=-(W-O)/z*.035,j=(A-L)/z*.035,Q=m/n,Z=(m+z)/n,q=(It,Ct,Lt,zt)=>Y.push(It,Ct,0,o,Lt,f,zt);q(L+R,O+j,Q,0),q(A+R,W+j,Z,z),q(A-R,W-j,Z,z),q(L+R,O+j,Q,0),q(A-R,W-j,Z,z),q(L-R,O-j,Q,0),m+=z})});const rt=gt(t,new Float32Array(Y),7*C,[{location:0,size:3,type:t.FLOAT,offset:0},{location:1,size:4,type:t.FLOAT,offset:3*C}],Y.length/7),it=[k(t,tt(t,$t,Kt)),k(t,tt(t,Gt,Wt)),k(t,tt(t,Ht,Yt))],[g,_,X]=it,ct=t.createVertexArray(),bt=[nt,rt],Pt=new Float32Array([...D(2282478),...D(4906624),...D(16486972)]),lt=new Float32Array([...D(12578815),...D(6220500),...D(9147384),...D(6583435)]),i=Rt(b,at(r.initial??T,0,b-1),M,r.onSelect),$=jt(c,y,e=>G(e));$.fill(d),$.current(i.target);const J=ot(),ft=ot(),F=ot();let x=1,w=1;const S={x:0,y:0,sx:0,sy:0};let N=!0;const G=e=>{i.select(e)&&($.current(i.target),N=!0)},At=e=>{const o=Math.floor(e),f=e-o,a=st(at(o,0,b-1)),n=st(at(o+1,0,b-1));return[a[0]+(n[0]-a[0])*f,a[1]+(n[1]-a[1])*f]};function Mt(){const[e,o]=At(i.s),f=yt(1,1.6,w/x),a=[e+S.sx*1.2,o*.55+1+S.sy*.8,23+f*14];Vt(J,a,[e,o*.6-f*2,0]),_t(ft,(x<w?62:50)*Math.PI/180,x/w,.1,400),Ft(F,ft,J)}const Tt=qt(c,{count:b,index:()=>i.target,busy:()=>i.flight!==null,select:G,pick:(e,o)=>{let f=-1,a=1/0;return s.forEach((n,m)=>{const l=et(F,[n.center[0],n.center[1],0]);if(l[3]<=0)return;const h=(l[0]/l[3]*.5+.5)*x,K=(-l[1]/l[3]*.5+.5)*w,L=et(F,[n.center[0]+n.radius,n.center[1],0]),O=Math.max(50,Math.abs((L[0]/L[3]*.5+.5)*x-h)),A=Math.hypot(h-e,K-o);A<O&&A<a&&(f=m,a=A)}),f}}),ut=e=>{if(M||e.pointerType!=="mouse")return;const o=c.getBoundingClientRect();S.x=(e.clientX-o.left)/o.width*2-1,S.y=-((e.clientY-o.top)/o.height)*2+1};c.addEventListener("pointermove",ut);const vt=()=>{x=Math.max(1,c.clientWidth),w=Math.max(1,c.clientHeight);const e=Math.min(window.devicePixelRatio||1,P?1.5:2);p.width=Math.round(x*e),p.height=Math.round(w*e),N=!0},ht=new ResizeObserver(vt);ht.observe(c),vt();let mt=0,pt=0;const Et=Ut(c,(e,o)=>{if(i.update(o)&&(N=!0),!M){mt+=e;const n=1-Math.pow(.002,e);S.sx+=(S.x-S.sx)*n,S.sy+=(S.y-S.sy)*n,P&&!i.flight&&o-pt<30||(N=!0)}if(!N)return;N=!1,pt=o,Mt();const f=i.arrivedAt<0?0:M?10:(o-i.arrivedAt)/1e3;t.viewport(0,0,p.width,p.height),t.disable(t.DEPTH_TEST),t.disable(t.BLEND),t.useProgram(X.program),t.uniform1f(X.u.uShift,i.s),t.uniform1f(X.u.uAspect,x/w),t.bindVertexArray(ct),t.drawArrays(t.TRIANGLES,0,3),t.enable(t.BLEND),t.blendFunc(t.ONE,t.ONE),t.useProgram(_.program),t.uniformMatrix4fv(_.u.uViewProj,!1,F),t.uniform1f(_.u.uS,i.s),t.uniform1f(_.u.uTarget,i.target),t.uniform1f(_.u.uDraw,i.arrivedAt<0?0:Math.min(1,f/.9)),t.uniform3fv(_.u.uStatus,lt),xt(t,rt),t.useProgram(g.program),t.uniformMatrix4fv(g.u.uViewProj,!1,F),t.uniformMatrix4fv(g.u.uView,!1,J),t.uniform1f(g.u.uS,i.s),t.uniform1f(g.u.uTarget,i.target),t.uniform1f(g.u.uAge,i.arrivedAt<0?0:f),t.uniform1f(g.u.uTime,mt),t.uniform1f(g.u.uPixel,p.height/w),t.uniform3fv(g.u.uKind,Pt),t.uniform3fv(g.u.uStatus,lt),t.uniform2f(g.u.uCenter,s[i.target].center[0],s[i.target].center[1]),xt(t,nt,t.POINTS),t.bindVertexArray(null);const a=x<w?.7:2.2;s.forEach((n,m)=>{const l=et(F,[n.center[0],n.center[1]+n.radius*.85+1,0]),h=Math.abs(m-i.s),K=l[3]>0&&Math.abs(l[0]/l[3])<1.2&&h<=a;$.place(m,(l[0]/l[3]*.5+.5)*x,(-l[1]/l[3]*.5+.5)*w,K?1-yt(a*.45,a,h):0,x)})});return(dt=r.onSelect)==null||dt.call(r,i.target),{get index(){return i.target},select:G,step:e=>G(i.target+e),setLang(e){d=e,$.fill(d)},dispose(){var e;B=!0,Et(),ht.disconnect(),Tt(),c.removeEventListener("pointermove",ut);for(const o of bt)Dt(t,o);for(const o of it)t.deleteProgram(o.program);t.deleteVertexArray(ct),(e=t.getExtension("WEBGL_lose_context"))==null||e.loseContext(),c.remove()}}}export{Bt as buildConstellation,st as constellationCenter,ne as createConstellationsScene};
