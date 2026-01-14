import { onMount, onCleanup } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface DotGridProps {
  dotSize?: number;
  gap?: number;
  baseColor?: string;
  activeColor?: string;
  proximity?: number;
  waveIntensity?: number;
  waveSpeed?: number;
  /** Preview mode - reduces framerate to ~24fps for better performance in settings */
  previewMode?: boolean;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let value = hex.trim();
  if (value.startsWith("#")) value = value.slice(1);
  if (value.length === 3) {
    value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
  }
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

/**
 * DotGrid - Canvas2D animated dot grid background
 */
const DotGrid = (props: DotGridProps) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let frameId: number;

  onMount(() => {
    if (!canvasRef) return;

    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;

    const dotSize = props.dotSize ?? 3;
    const gap = props.gap ?? 24;
    const baseColor = props.baseColor ?? "#1a1a2e";
    const activeColor = props.activeColor ?? "#4f46e5";
    const proximity = props.proximity ?? 120;
    const waveIntensity = props.waveIntensity ?? 0.3;
    const waveSpeed = props.waveSpeed ?? 0.5;

    const baseRgb = hexToRgb(baseColor);
    const activeRgb = hexToRgb(activeColor);
    const proxSq = proximity * proximity;

    interface Dot {
      cx: number;
      cy: number;
      baseX: number;
      baseY: number;
    }

    let dots: Dot[] = [];
    const mouse = { x: -1000, y: -1000 };
    let width = 0;
    let height = 0;
    let dpr = 1;

    const buildGrid = () => {
      const parent = canvasRef!.parentElement;
      if (!parent) return;

      dpr = Math.min(window.devicePixelRatio, 2);
      width = parent.clientWidth;
      height = parent.clientHeight;

      if (width <= 0 || height <= 0) return;

      canvasRef!.width = width * dpr;
      canvasRef!.height = height * dpr;
      canvasRef!.style.width = width + "px";
      canvasRef!.style.height = height + "px";

      const cell = dotSize + gap;
      const cols = Math.floor((width + gap) / cell);
      const rows = Math.floor((height + gap) / cell);

      const gridW = cell * cols - gap;
      const gridH = cell * rows - gap;

      const startX = (width - gridW) / 2 + dotSize / 2;
      const startY = (height - gridH) / 2 + dotSize / 2;

      dots = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cx = startX + x * cell;
          const cy = startY + y * cell;
          dots.push({ cx, cy, baseX: cx, baseY: cy });
        }
      }
    };

    // Global mouse tracking - recalculate rect each time to handle scroll
    const handleMouseMove = (e: MouseEvent) => {
      if (!canvasRef) return;
      const rect = canvasRef.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };

    const handleMouseLeave = () => {
      mouse.x = -1000;
      mouse.y = -1000;
    };

    // ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      buildGrid();
    });
    const parent = canvasRef.parentElement;
    if (parent) {
      resizeObserver.observe(parent);
    }

    // Tauri window resize
    let unlistenResize: (() => void) | null = null;
    getCurrentWindow().onResized(() => buildGrid()).then(unlisten => {
      unlistenResize = unlisten;
    });

    // Visibility change
    const handleVisibility = () => {
      if (!document.hidden) buildGrid();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // Mouse events on window for better tracking
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);

    buildGrid();

    const startTime = performance.now();
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

      if (!ctx || width <= 0 || height <= 0) {
        frameId = requestAnimationFrame(render);
        return;
      }

      const time = (performance.now() - startTime) / 1000;

      // Clear with proper scaling
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      for (const dot of dots) {
        // Wave animation
        const waveX = Math.sin(time * waveSpeed + dot.baseX * 0.02) * waveIntensity * 3;
        const waveY = Math.cos(time * waveSpeed * 0.8 + dot.baseY * 0.02) * waveIntensity * 3;

        const cx = dot.baseX + waveX;
        const cy = dot.baseY + waveY;

        const dx = cx - mouse.x;
        const dy = cy - mouse.y;
        const dsq = dx * dx + dy * dy;

        let r = baseRgb.r;
        let g = baseRgb.g;
        let b = baseRgb.b;
        let size = dotSize;

        if (dsq <= proxSq) {
          const dist = Math.sqrt(dsq);
          const t = 1 - dist / proximity;
          r = Math.round(baseRgb.r + (activeRgb.r - baseRgb.r) * t);
          g = Math.round(baseRgb.g + (activeRgb.g - baseRgb.g) * t);
          b = Math.round(baseRgb.b + (activeRgb.b - baseRgb.b) * t);
          size = dotSize * (1 + t * 0.5);
        }

        ctx.beginPath();
        ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fill();
      }

      frameId = requestAnimationFrame(render);
    };

    frameId = requestAnimationFrame(render);

    onCleanup(() => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      unlistenResize?.();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
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

export default DotGrid;
