import { onMount, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

const vertexSource = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// Aurora shader with smooth simplex noise and color ramping
// More gradual and smooth than original react-bits version
const fragmentSource = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

out vec4 fragColor;

// Simplex noise permutation
vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

// 2D Simplex noise
float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439
  );
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
    permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
    0.5 - vec3(
      dot(x0, x0),
      dot(x12.xy, x12.xy),
      dot(x12.zw, x12.zw)
    ),
    0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);

  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Color ramp interpolation
vec3 colorRamp(vec3 c0, vec3 c1, vec3 c2, float t) {
  if (t < 0.5) {
    return mix(c0, c1, t * 2.0);
  }
  return mix(c1, c2, (t - 0.5) * 2.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float time = uTime;

  // Vertical rays - characteristic aurora streaks
  float rays = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float scale = 4.0 + fi * 3.0;
    float speed = 0.03 + fi * 0.015;
    float rayNoise = snoise(vec2(uv.x * scale + time * speed, fi * 8.0 + time * 0.04));
    rays += rayNoise * (0.25 - fi * 0.03);
  }

  // Subtle horizontal wave motion
  float wave = snoise(vec2(uv.x * 2.0 + time * 0.06, time * 0.1)) * 0.15;

  // Aurora positioned at top - compact band
  float auroraY = 0.88 + wave * 0.08 * uAmplitude;

  // Distance from aurora center
  float dist = uv.y - auroraY;

  // Compact aurora shape - tight band at top
  float upperFade = smoothstep(0.12, 0.0, dist);
  float lowerFade = smoothstep(-0.25, 0.0, dist);
  float auroraBase = upperFade * lowerFade;

  // Sharp ray structure
  float rayIntensity = (rays * 0.5 + 0.5);
  rayIntensity = pow(rayIntensity, 2.0);

  // Combine - rays more visible
  float aurora = auroraBase * (0.3 + rayIntensity * 1.0);

  // Subtle flicker
  float flicker = snoise(vec2(uv.x * 12.0 + time * 0.4, uv.y * 6.0 + time * 0.25));
  flicker = max(0.0, flicker) * 0.2;
  aurora += flicker * auroraBase * 0.5;

  // Color gradient with ray variation
  float colorPos = uv.x + rays * 0.15;
  vec3 auroraColor = colorRamp(uColorStops[0], uColorStops[1], uColorStops[2], colorPos);

  // Brighter at peak, dimmer at edges
  auroraColor *= 0.9 + rayIntensity * 0.5;

  // Alpha with soft blend
  float alpha = aurora * smoothstep(0.0, uBlend, aurora);

  // Premultiplied alpha
  fragColor = vec4(auroraColor * alpha, alpha);
}`;

interface AuroraProps {
  colorStops?: string[];
  amplitude?: number;
  blend?: number;
  speed?: number;
  /** Preview mode - reduces framerate to ~24fps for better performance in settings */
  previewMode?: boolean;
}

function hexToRgb(hex: string): [number, number, number] {
  let value = hex.trim();
  if (value.startsWith("#")) value = value.slice(1);
  if (value.length === 3) {
    value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
  }
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * Aurora - Pure WebGL2 aurora borealis background
 * Ported from react-bits with smoother animation
 */
const Aurora = (props: AuroraProps) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let frameId: number;

  onMount(() => {
    if (!canvasRef) return;

    const gl = canvasRef.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true
    });
    if (!gl) {
      console.error("WebGL2 not supported");
      return;
    }

    // Enable transparency with premultiplied alpha
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    // Create shaders
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vertexSource);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fragmentSource);
    gl.compileShader(fs);

    // Check for errors
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error("Vertex shader error:", gl.getShaderInfoLog(vs));
      return;
    }
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error("Fragment shader error:", gl.getShaderInfoLog(fs));
      return;
    }

    // Create program
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Program link error:", gl.getProgramInfoLog(program));
      return;
    }

    gl.useProgram(program);

    // Create fullscreen triangle
    const positions = new Float32Array([-1, -1, 3, -1, -1, 3]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Get uniform locations
    const uTime = gl.getUniformLocation(program, "uTime");
    const uResolution = gl.getUniformLocation(program, "uResolution");
    const uAmplitude = gl.getUniformLocation(program, "uAmplitude");
    const uBlend = gl.getUniformLocation(program, "uBlend");

    // Color stops uniforms
    const colorStopLocs: WebGLUniformLocation[] = [];
    for (let i = 0; i < 3; i++) {
      colorStopLocs.push(gl.getUniformLocation(program, `uColorStops[${i}]`)!);
    }

    // Set initial color stops
    const defaultColors = props.colorStops ?? ["#3b82f6", "#22d3ee", "#8b5cf6"];
    defaultColors.slice(0, 3).forEach((hex, i) => {
      const [r, g, b] = hexToRgb(hex);
      gl.uniform3f(colorStopLocs[i], r, g, b);
    });

    const resize = () => {
      const parent = canvasRef!.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio, 2);
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w <= 0 || h <= 0) return;
      canvasRef!.width = w * dpr;
      canvasRef!.height = h * dpr;
      canvasRef!.style.width = w + "px";
      canvasRef!.style.height = h + "px";
      gl.viewport(0, 0, canvasRef!.width, canvasRef!.height);
    };

    // ResizeObserver - reliable container size detection
    const resizeObserver = new ResizeObserver(() => resize());
    const parent = canvasRef.parentElement;
    if (parent) {
      resizeObserver.observe(parent);
    }

    // Tauri window resize event
    let unlistenResize: (() => void) | null = null;
    getCurrentWindow().onResized(() => resize()).then(unlisten => {
      unlistenResize = unlisten;
    });

    // Visibility change - resize when tab becomes visible
    const handleVisibility = () => {
      if (!document.hidden) resize();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // Initial resize after layout
    resize();

    const start = performance.now();
    const speed = props.speed ?? 1.0;
    // Preview mode: throttle to ~24fps (42ms interval) for better performance
    const frameInterval = props.previewMode ? 42 : 0;
    let lastFrameTime = 0;

    const render = (currentTime: number) => {
      // Throttle frames in preview mode
      if (frameInterval > 0 && currentTime - lastFrameTime < frameInterval) {
        frameId = requestAnimationFrame(render);
        return;
      }
      lastFrameTime = currentTime;

      const time = ((performance.now() - start) / 1000) * speed * 0.1;

      gl.uniform1f(uTime, time);
      gl.uniform2f(uResolution, canvasRef!.width, canvasRef!.height);
      gl.uniform1f(uAmplitude, props.amplitude ?? 1.0);
      gl.uniform1f(uBlend, props.blend ?? 0.5);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frameId = requestAnimationFrame(render);
    };

    frameId = requestAnimationFrame(render);

    onCleanup(() => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      unlistenResize?.();
      document.removeEventListener("visibilitychange", handleVisibility);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buffer);
    });
  });

  return (
    <canvas
      ref={canvasRef}
      class="w-full h-full block"
      style={{ background: "transparent" }}
    />
  );
};

export default Aurora;
