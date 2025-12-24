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
uniform vec3 pixelColor;
uniform float pixelSize;
uniform float edgeWidth;

in vec2 vUv;

// Простой hash
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Hash для vec3
float hash3(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

void main() {
  // Координаты в пикселях экрана
  vec2 screenPos = vUv * iResolution;

  // Индекс пикселя в сетке
  vec2 pixelIndex = floor(screenPos / pixelSize);

  // Позиция внутри пикселя (0-1)
  vec2 inPixel = fract(screenPos / pixelSize);

  // Квадратный пиксель с отступом
  float pixelMask = step(0.15, inPixel.x) * step(inPixel.x, 0.85) *
                    step(0.15, inPixel.y) * step(inPixel.y, 0.85);

  // Расстояние от краёв экрана
  float distLeft = screenPos.x;
  float distRight = iResolution.x - screenPos.x;
  float distTop = iResolution.y - screenPos.y;
  float distBottom = screenPos.y;
  float minDistPx = min(min(distLeft, distRight), min(distTop, distBottom));

  // Ширина зоны краёв
  float edgeZone = edgeWidth * min(iResolution.x, iResolution.y);

  // Затухание от края к центру
  float edgeFade = 1.0 - smoothstep(0.0, edgeZone, minDistPx);

  // Стабильный hash для пикселя
  float pixelHash = hash(pixelIndex);

  // Плотность пикселей зависит от расстояния до края
  float density = edgeFade * 0.75;
  float visible = step(1.0 - density, pixelHash);

  // === ВОЛНОВЫЕ ЭФФЕКТЫ ===

  // Нормализованное расстояние от края (0 = край, 1 = граница зоны)
  float normDist = minDistPx / edgeZone;

  // Волна 1: бегущая от края внутрь (быстрая)
  float wave1 = sin(normDist * 12.0 - iTime * 3.0) * 0.5 + 0.5;
  wave1 = pow(wave1, 3.0); // Делаем пики острее

  // Волна 2: медленная пульсация
  float wave2 = sin(normDist * 6.0 - iTime * 1.2 + pixelHash * 3.14) * 0.5 + 0.5;

  // Волна 3: случайные вспышки (sparkle)
  float sparkleTime = floor(iTime * 2.0 + pixelHash * 10.0);
  float sparkle = hash3(vec3(pixelIndex, sparkleTime));
  sparkle = step(0.92, sparkle); // Редкие вспышки

  // Комбинируем волны
  float waveEffect = wave1 * 0.4 + wave2 * 0.3 + sparkle * 0.8;

  // Базовая яркость + волновой эффект
  float brightness = 0.3 + waveEffect * 0.7;

  // Подсветка ближе к краю ярче
  brightness *= (0.5 + edgeFade * 0.5);

  // Итоговая альфа
  float alpha = pixelMask * visible * edgeFade * brightness;

  // Цвет с лёгким оттенком от волны (холоднее на пиках)
  vec3 finalColor = pixelColor * (0.9 + wave1 * 0.2);

  fragColor = vec4(finalColor, alpha);
}`;

interface EdgePixelsProps {
  pixelColor?: string;
  pixelSize?: number;
  edgeWidth?: number;
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
 * EdgePixels - Простые цветные пиксели по краям экрана
 * Pure WebGL2
 */
const EdgePixels = (props: EdgePixelsProps) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let frameId: number;

  onMount(() => {
    if (!canvasRef) return;

    const gl = canvasRef.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false
    });
    if (!gl) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vertexSource);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fragmentSource);
    gl.compileShader(fs);

    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error("Fragment shader error:", gl.getShaderInfoLog(fs));
      return;
    }

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    const positions = new Float32Array([-1, -1, 3, -1, -1, 3]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, "iTime");
    const uResolution = gl.getUniformLocation(program, "iResolution");
    const uPixelColor = gl.getUniformLocation(program, "pixelColor");
    const uPixelSize = gl.getUniformLocation(program, "pixelSize");
    const uEdgeWidth = gl.getUniformLocation(program, "edgeWidth");

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
    if (parent) resizeObserver.observe(parent);

    let unlistenResize: (() => void) | null = null;
    getCurrentWindow().onResized(() => resize()).then(u => { unlistenResize = u; });

    const handleVisibility = () => { if (!document.hidden) resize(); };
    document.addEventListener("visibilitychange", handleVisibility);

    resize();

    const start = performance.now();

    const render = () => {
      const time = (performance.now() - start) / 1000;
      const [r, g, b] = hexToRgb(props.pixelColor ?? "#3b82f6");

      gl.uniform1f(uTime, time);
      gl.uniform2f(uResolution, canvasRef!.width, canvasRef!.height);
      gl.uniform3f(uPixelColor, r, g, b);
      gl.uniform1f(uPixelSize, props.pixelSize ?? 4.0);
      gl.uniform1f(uEdgeWidth, props.edgeWidth ?? 0.12);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frameId = requestAnimationFrame(render);
    };

    render();

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

export default EdgePixels;
