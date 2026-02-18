import { createSignal, createMemo, onMount, onCleanup, Show } from "solid-js";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getActiveTheme, resolveTheme } from "../stores/uiPreferences";
import FloatingLines from "./FloatingLines";
import Aurora from "./Aurora";
import DotGrid from "./DotGrid";
import RippleGrid from "./RippleGrid";
import EdgePixels from "./EdgePixels";

export type BackgroundType = "static" | "floatingLines" | "aurora" | "dotGrid" | "rippleGrid" | "edgePixels" | "image";

// Get/Set background type from localStorage
export const getBackgroundType = (): BackgroundType => {
  const stored = localStorage.getItem("backgroundType");
  const validTypes: BackgroundType[] = ["static", "floatingLines", "aurora", "dotGrid", "rippleGrid", "edgePixels", "image"];
  if (stored && validTypes.includes(stored as BackgroundType)) {
    return stored as BackgroundType;
  }
  return "dotGrid"; // default
};

export const setBackgroundType = (type: BackgroundType) => {
  localStorage.setItem("backgroundType", type);
};

// Get/Set dimming from localStorage (0-100)
export const getBackgroundDimming = (): number => {
  const stored = localStorage.getItem("backgroundDimming");
  if (stored) {
    const val = parseInt(stored, 10);
    if (!isNaN(val) && val >= 0 && val <= 100) return val;
  }
  return 0; // default - no dimming
};

export const setBackgroundDimming = (value: number) => {
  localStorage.setItem("backgroundDimming", String(Math.max(0, Math.min(100, value))));
};

interface AppBackgroundProps {
  type?: BackgroundType;
}

/**
 * Фон приложения
 * Поддерживает: static, floatingLines, aurora, dotGrid, rippleGrid, edgePixels, image
 */
const AppBackground = (props: AppBackgroundProps) => {
  const [bgType, setBgType] = createSignal<BackgroundType>(props.type ?? "dotGrid");
  const [bgImage, setBgImage] = createSignal<string | null>(null);
  const [imageLoaded, setImageLoaded] = createSignal(false);
  const [dimming, setDimming] = createSignal(getBackgroundDimming());
  const [ready, setReady] = createSignal(false);

  // Theme-aware colors for backgrounds
  const isLight = createMemo(() => {
    const theme = resolveTheme(getActiveTheme());
    return theme?.colorScheme === "light";
  });

  // Cache key for session storage
  const BG_CACHE_KEY = "stuzhik_bg_cache";

  onMount(async () => {
    const currentType = props.type ?? getBackgroundType();
    setBgType(currentType);

    // Mark as ready immediately
    requestAnimationFrame(() => {
      setReady(true);
    });

    // Try to load from cache first for instant display
    const cached = sessionStorage.getItem(BG_CACHE_KEY);
    if (cached && currentType === "image") {
      setBgImage(cached);
      setImageLoaded(true);
    }

    // Загружаем фоновое изображение (если есть)
    // Пробуем asset:// (быстрее), если не работает - fallback на base64
    try {
      const path = await invoke<string | null>("get_background_image_path");
      if (path) {
        // Нормализуем путь: заменяем обратные слэши на прямые для Windows
        const normalizedPath = path.replace(/\\/g, "/");
        const assetUrl = convertFileSrc(normalizedPath);

        // Preload image in background
        const img = new Image();
        img.onload = () => {
          setBgImage(assetUrl);
          setImageLoaded(true);
          // Cache for next time
          sessionStorage.setItem(BG_CACHE_KEY, assetUrl);
        };
        img.onerror = async () => {
          // Fallback на base64 если asset:// не работает (release mode)
          try {
            const dataUrl = await invoke<string | null>("get_background_image_base64");
            if (dataUrl) {
              setBgImage(dataUrl);
              setImageLoaded(true);
              // Cache the base64 for faster subsequent loads
              try {
                sessionStorage.setItem(BG_CACHE_KEY, dataUrl);
              } catch {
                // Ignore quota errors for large images
              }
            }
          } catch (e2) {
            if (import.meta.env.DEV) console.error("[BG] Failed to load background:", e2);
          }
        };
        img.src = assetUrl;
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error("[BG] Failed to load background image:", e);
    }

    // Listen for background type changes
    const handler = (e: StorageEvent) => {
      if (e.key === "backgroundType" && e.newValue) {
        setBgType(e.newValue as BackgroundType);
      }
      if (e.key === "backgroundDimming" && e.newValue) {
        setDimming(parseInt(e.newValue, 10) || 0);
      }
    };
    window.addEventListener("storage", handler);

    // Custom event for same-tab updates
    const typeHandler = (e: CustomEvent) => {
      setBgType(e.detail as BackgroundType);
    };
    const imageHandler = (e: CustomEvent) => {
      const newImage = e.detail as string | null;
      setBgImage(newImage);
      setImageLoaded(!!newImage);
      // Clear cache when image changes
      if (newImage) {
        try {
          sessionStorage.setItem(BG_CACHE_KEY, newImage);
        } catch {
          // Ignore quota errors
        }
      } else {
        sessionStorage.removeItem(BG_CACHE_KEY);
      }
    };
    const dimmingHandler = (e: CustomEvent) => {
      setDimming(e.detail as number);
    };
    window.addEventListener("backgroundTypeChange", typeHandler as EventListener);
    window.addEventListener("backgroundImageChange", imageHandler as EventListener);
    window.addEventListener("backgroundDimmingChange", dimmingHandler as EventListener);

    // Cleanup event listeners on unmount
    onCleanup(() => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("backgroundTypeChange", typeHandler as EventListener);
      window.removeEventListener("backgroundImageChange", imageHandler as EventListener);
      window.removeEventListener("backgroundDimmingChange", dimmingHandler as EventListener);
    });
  });

  return (
    <div class="fixed inset-0 -z-10 overflow-hidden bg-[var(--color-bg)]">
      {/* Static background */}
      <Show when={bgType() === "static"}>
        <div
          class="absolute inset-0"
          style={{
            background: isLight()
              ? "linear-gradient(to bottom, #f0f1f3, #e8e9ec, #e0e1e4)"
              : "linear-gradient(to bottom, #0f1012, #0a0b0d, #060708)",
          }}
        />
      </Show>

      {/* Image background with fade-in */}
      <Show when={bgType() === "image" && bgImage()}>
        <div
          class="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-300"
          style={{
            "background-image": `url(${bgImage()})`,
            "opacity": imageLoaded() ? 1 : 0
          }}
        />
      </Show>

      {/* Animated backgrounds - only render when ready */}
      <Show when={ready()}>
        {/* Волны (FloatingLines) */}
        <Show when={bgType() === "floatingLines"}>
          <div class="absolute inset-0">
            <FloatingLines
              linesGradient={isLight()
                ? ["#93b4d4", "#a98bc4", "#8ab4cc", "#b490c4"]
                : ["#1e3a5f", "#2d1b4e", "#1a3d5c", "#3d1f5c"]
              }
              lineCount={6}
              lineDistance={5}
              animationSpeed={0.5}
              mixBlendMode="normal"
              opacity={isLight() ? 0.6 : 1}
            />
          </div>
        </Show>

        {/* Северное сияние (Aurora) */}
        <Show when={bgType() === "aurora"}>
          <div class="absolute inset-0">
            <Aurora
              colorStops={isLight()
                ? ["#8dc8d8", "#8dc0a5", "#a590c0"]
                : ["#0d3d4d", "#0d4035", "#2d1b4e"]
              }
              amplitude={1.2}
              blend={isLight() ? 0.3 : 0.4}
              speed={0.6}
            />
          </div>
        </Show>

        {/* Точечная сетка (DotGrid) */}
        <Show when={bgType() === "dotGrid"}>
          <div class="absolute inset-0">
            <DotGrid
              dotSize={3}
              gap={24}
              baseColor={isLight() ? "#c8c9d4" : "#1a1a2e"}
              activeColor={isLight() ? "#2563eb" : "#3b82f6"}
              proximity={100}
              waveIntensity={0.2}
              waveSpeed={0.3}
            />
          </div>
        </Show>

        {/* Волновая сетка (RippleGrid) */}
        <Show when={bgType() === "rippleGrid"}>
          <div class="absolute inset-0">
            <RippleGrid
              gridColor={isLight() ? "#b0b8c8" : "#2d3748"}
              rippleIntensity={0.04}
              gridSize={12.0}
              gridThickness={18.0}
              fadeDistance={1.3}
              vignetteStrength={isLight() ? 1.5 : 2.5}
              glowIntensity={isLight() ? 0.04 : 0.08}
            />
          </div>
        </Show>

        {/* Пиксели по краям (EdgePixels) */}
        <Show when={bgType() === "edgePixels"}>
          <div class="absolute inset-0">
            <EdgePixels
              pixelColor={isLight() ? "#2563eb" : "#3b82f6"}
              pixelSize={4}
              edgeWidth={0.12}
            />
          </div>
        </Show>
      </Show>

      {/* Dimming overlay - applies to all backgrounds */}
      <Show when={dimming() > 0}>
        <div
          class="absolute inset-0 bg-black pointer-events-none"
          style={{ opacity: dimming() / 100 }}
        />
      </Show>
    </div>
  );
};

export default AppBackground;
