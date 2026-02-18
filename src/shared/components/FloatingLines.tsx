import { onMount, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

const vertexSource = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// Exact port from react-bits FloatingLines
const fragmentSource = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform float iTime;
uniform vec2 iResolution;
uniform float animationSpeed;
uniform vec3 lineGradient[8];
uniform int lineGradientCount;
uniform int lineCount;
uniform float lineDistance;

mat2 rotate(float r) {
  return mat2(cos(r), sin(r), -sin(r), cos(r));
}

vec3 getLineColor(float t) {
  if (lineGradientCount <= 0) {
    return mix(vec3(0.18, 0.29, 0.64), vec3(0.91, 0.28, 0.96), t);
  }
  if (lineGradientCount == 1) {
    return lineGradient[0];
  }
  float clampedT = clamp(t, 0.0, 0.9999);
  float scaled = clampedT * float(lineGradientCount - 1);
  int idx = int(floor(scaled));
  float f = fract(scaled);
  int idx2 = min(idx + 1, lineGradientCount - 1);
  return mix(lineGradient[idx], lineGradient[idx2], f) * 0.5;
}

float wave(vec2 uv, float offset, float time) {
  float x_offset = offset;
  float x_movement = time * 0.1;
  float amp = sin(offset + time * 0.2) * 0.3;
  float y = sin(uv.x + x_offset + x_movement) * amp;
  float m = uv.y - y;
  return 0.0175 / max(abs(m) + 0.01, 1e-3) + 0.01;
}

void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - iResolution) / iResolution.y;
  uv.y *= -1.0;

  float time = iTime * animationSpeed;
  vec3 col = vec3(0.0);

  // Bottom layer
  for (int i = 0; i < lineCount; i++) {
    float fi = float(i);
    float t = fi / max(float(lineCount - 1), 1.0);
    vec3 lineCol = getLineColor(t);
    float angle = -0.35 * log(length(uv) + 1.0);
    vec2 ruv = uv * rotate(angle);
    col += lineCol * wave(ruv + vec2(lineDistance * 0.01 * fi + 2.0, -0.7), 1.5 + 0.2 * fi, time) * 0.2;
  }

  // Middle layer
  for (int i = 0; i < lineCount; i++) {
    float fi = float(i);
    float t = fi / max(float(lineCount - 1), 1.0);
    vec3 lineCol = getLineColor(t);
    float angle = 0.2 * log(length(uv) + 1.0);
    vec2 ruv = uv * rotate(angle);
    col += lineCol * wave(ruv + vec2(lineDistance * 0.01 * fi + 5.0, 0.0), 2.0 + 0.15 * fi, time);
  }

  // Top layer
  for (int i = 0; i < lineCount; i++) {
    float fi = float(i);
    float t = fi / max(float(lineCount - 1), 1.0);
    vec3 lineCol = getLineColor(t);
    float angle = -0.35 * log(length(uv) + 1.0);
    vec2 ruv = uv * rotate(angle);
    ruv.x *= -1.0;
    col += lineCol * wave(ruv + vec2(lineDistance * 0.01 * fi + 10.0, 0.5), 1.0 + 0.2 * fi, time) * 0.1;
  }

  fragColor = vec4(col, 1.0);
}`;

interface FloatingLinesProps {
  linesGradient?: string[];
  lineCount?: number;
  lineDistance?: number;
  animationSpeed?: number;
  mixBlendMode?: "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn" | "hard-light" | "soft-light" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";
  opacity?: number;
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
 * FloatingLines - Pure WebGL2 animated wave lines background
 * Ported from react-bits (no dependencies)
 */
const FloatingLines = (props: FloatingLinesProps) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let frameId: number;

  onMount(() => {
    if (!canvasRef) return;

    const gl = canvasRef.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false
    });
    if (!gl) {
      if (import.meta.env.DEV) console.error("WebGL2 not supported");
      return;
    }

    // Enable transparency
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
      if (import.meta.env.DEV) console.error("Vertex shader error:", gl.getShaderInfoLog(vs));
      return;
    }
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      if (import.meta.env.DEV) console.error("Fragment shader error:", gl.getShaderInfoLog(fs));
      return;
    }

    // Create program
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (import.meta.env.DEV) console.error("Program link error:", gl.getProgramInfoLog(program));
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
    const uTime = gl.getUniformLocation(program, "iTime");
    const uResolution = gl.getUniformLocation(program, "iResolution");
    const uSpeed = gl.getUniformLocation(program, "animationSpeed");
    const uLineCount = gl.getUniformLocation(program, "lineCount");
    const uLineDistance = gl.getUniformLocation(program, "lineDistance");
    const uGradientCount = gl.getUniformLocation(program, "lineGradientCount");

    // Set gradient colors
    const gradientLocs: WebGLUniformLocation[] = [];
    for (let i = 0; i < 8; i++) {
      gradientLocs.push(gl.getUniformLocation(program, `lineGradient[${i}]`)!);
    }

    const gradient = props.linesGradient ?? ["#e947f5", "#2f4ba2"];
    gradient.slice(0, 8).forEach((hex, i) => {
      const [r, g, b] = hexToRgb(hex);
      gl.uniform3f(gradientLocs[i], r, g, b);
    });
    gl.uniform1i(uGradientCount, Math.min(gradient.length, 8));

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

      const time = (performance.now() - start) / 1000;

      gl.uniform1f(uTime, time);
      gl.uniform2f(uResolution, canvasRef!.width, canvasRef!.height);
      gl.uniform1f(uSpeed, props.animationSpeed ?? 1);
      gl.uniform1i(uLineCount, props.lineCount ?? 6);
      gl.uniform1f(uLineDistance, props.lineDistance ?? 5);

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
      style={{
        "mix-blend-mode": props.mixBlendMode ?? "screen",
        background: "transparent",
        opacity: props.opacity ?? 1
      }}
    />
  );
};

export default FloatingLines;
