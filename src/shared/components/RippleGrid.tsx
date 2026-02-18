import { onMount, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

const vertexSource = `#version 300 es
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform float iTime;
uniform vec2 iResolution;
uniform vec3 gridColor;
uniform float rippleIntensity;
uniform float gridSize;
uniform float gridThickness;
uniform float fadeDistance;
uniform float vignetteStrength;
uniform float glowIntensity;

in vec2 vUv;

const float PI = 3.141592653589793;

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  uv.x *= iResolution.x / iResolution.y;

  float dist = length(uv);

  // Ripple distortion
  float ripple = sin(PI * (iTime - dist));
  vec2 rippleUv = uv + uv * ripple * rippleIntensity;

  // Grid pattern with smoothstep antialiasing
  vec2 a = sin(gridSize * 0.5 * PI * rippleUv - PI / 2.0);
  vec2 b = abs(a);

  float aaWidth = 0.5;
  vec2 smoothB = vec2(
    smoothstep(0.0, aaWidth, b.x),
    smoothstep(0.0, aaWidth, b.y)
  );

  // Grid lines with glow
  vec3 color = vec3(0.0);
  color += exp(-gridThickness * smoothB.x * (0.8 + 0.5 * sin(PI * iTime)));
  color += exp(-gridThickness * smoothB.y);
  color += 0.5 * exp(-(gridThickness / 4.0) * sin(smoothB.x));
  color += 0.5 * exp(-(gridThickness / 3.0) * smoothB.y);

  // Additional glow
  if (glowIntensity > 0.0) {
    color += glowIntensity * exp(-gridThickness * 0.5 * smoothB.x);
    color += glowIntensity * exp(-gridThickness * 0.5 * smoothB.y);
  }

  // Distance fade
  float ddd = exp(-2.0 * clamp(pow(dist, fadeDistance), 0.0, 1.0));

  // Vignette
  vec2 vignetteCoords = vUv - 0.5;
  float vignetteDistance = length(vignetteCoords);
  float vignette = 1.0 - pow(vignetteDistance * 2.0, vignetteStrength);
  vignette = clamp(vignette, 0.0, 1.0);

  float finalFade = ddd * vignette;
  float alpha = length(color) * finalFade;

  fragColor = vec4(color * gridColor * finalFade, alpha);
}`;

interface RippleGridProps {
  gridColor?: string;
  rippleIntensity?: number;
  gridSize?: number;
  gridThickness?: number;
  fadeDistance?: number;
  vignetteStrength?: number;
  glowIntensity?: number;
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
 * RippleGrid - Pure WebGL2 animated rippling grid
 * Ported from react-bits (without OGL)
 */
const RippleGrid = (props: RippleGridProps) => {
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

    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      if (import.meta.env.DEV) console.error("Vertex shader error:", gl.getShaderInfoLog(vs));
      return;
    }
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      if (import.meta.env.DEV) console.error("Fragment shader error:", gl.getShaderInfoLog(fs));
      return;
    }

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (import.meta.env.DEV) console.error("Program link error:", gl.getProgramInfoLog(program));
      return;
    }

    gl.useProgram(program);

    // Fullscreen triangle
    const positions = new Float32Array([-1, -1, 3, -1, -1, 3]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Uniforms
    const uTime = gl.getUniformLocation(program, "iTime");
    const uResolution = gl.getUniformLocation(program, "iResolution");
    const uGridColor = gl.getUniformLocation(program, "gridColor");
    const uRippleIntensity = gl.getUniformLocation(program, "rippleIntensity");
    const uGridSize = gl.getUniformLocation(program, "gridSize");
    const uGridThickness = gl.getUniformLocation(program, "gridThickness");
    const uFadeDistance = gl.getUniformLocation(program, "fadeDistance");
    const uVignetteStrength = gl.getUniformLocation(program, "vignetteStrength");
    const uGlowIntensity = gl.getUniformLocation(program, "glowIntensity");

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

    const resizeObserver = new ResizeObserver(() => resize());
    const parent = canvasRef.parentElement;
    if (parent) {
      resizeObserver.observe(parent);
    }

    let unlistenResize: (() => void) | null = null;
    getCurrentWindow().onResized(() => resize()).then(unlisten => {
      unlistenResize = unlisten;
    });

    const handleVisibility = () => {
      if (!document.hidden) resize();
    };
    document.addEventListener("visibilitychange", handleVisibility);

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

      const [r, g, b] = hexToRgb(props.gridColor ?? "#4f46e5");

      gl.uniform1f(uTime, time);
      gl.uniform2f(uResolution, canvasRef!.width, canvasRef!.height);
      gl.uniform3f(uGridColor, r, g, b);
      gl.uniform1f(uRippleIntensity, props.rippleIntensity ?? 0.05);
      gl.uniform1f(uGridSize, props.gridSize ?? 10.0);
      gl.uniform1f(uGridThickness, props.gridThickness ?? 15.0);
      gl.uniform1f(uFadeDistance, props.fadeDistance ?? 1.5);
      gl.uniform1f(uVignetteStrength, props.vignetteStrength ?? 2.0);
      gl.uniform1f(uGlowIntensity, props.glowIntensity ?? 0.1);

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

export default RippleGrid;
