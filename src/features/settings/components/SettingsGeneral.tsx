import { Show, For, type JSX } from "solid-js";
import type { Accessor } from "solid-js";
import type { Settings } from "../../../shared/types";
import type { BackgroundType } from "../../../shared/components/AppBackground";
import type { Language } from "../../../shared/i18n";
import { isBundledLanguage } from "../../../shared/i18n";
import { resetAllTours, getRegisteredTours, getSubTours } from "../../../shared/hooks";
import type { TourInstance } from "../../../shared/hooks";
import { addToast } from "../../../shared/components/Toast";
import { BackgroundOption, RadioOption, LazyPreview, Toggle, RangeSlider } from "../../../shared/ui";
import FloatingLines from "../../../shared/components/FloatingLines";
import Aurora from "../../../shared/components/Aurora";
import DotGrid from "../../../shared/components/DotGrid";
import RippleGrid from "../../../shared/components/RippleGrid";
import EdgePixels from "../../../shared/components/EdgePixels";

export interface LanguageOption {
  code: string;
  name: string;
  flag?: string;
}

interface Props {
  settings: Accessor<Settings>;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  language: Accessor<Language>;
  onLanguageChange: (lang: Language) => void;
  languageOptions: Accessor<LanguageOption[]>;
  onImportLanguage: () => void;
  onDeleteLanguage: (code: string) => void;
  importingLanguage: Accessor<boolean>;
  backgroundType: Accessor<BackgroundType>;
  onBackgroundTypeChange: (type: BackgroundType) => void;
  backgroundImageUrl: Accessor<string | null>;
  loadingBackgroundImage: Accessor<boolean>;
  onPickBackgroundImage: () => void;
  onClearBackgroundImage: () => void;
  onSelectExistingImage: () => void;
  backgroundDimming: Accessor<number>;
  onDimmingChange: (value: number) => void;
  onDeveloperModeChange: (checked: boolean) => void;
  t: Accessor<Record<string, any>>;
}

function TourList(props: { t: () => Record<string, any> }) {
  const tours = () => getRegisteredTours();
  const rootTours = () => tours().filter((t) => !t.config.parentId);

  return (
    <Show when={rootTours().length > 0}>
      <div class="space-y-2">
        <label class="block text-sm font-medium">
          {props.t().settings?.tour?.selectTour || "Select a tour"}
        </label>
        <div class="space-y-2">
          <For each={rootTours()}>
            {(tour) => <TourCard tour={tour} t={props.t} />}
          </For>
        </div>
      </div>
    </Show>
  );
}

function TourCard(cardProps: { tour: TourInstance; t: () => Record<string, any> }) {
  const t = () => cardProps.t();
  const tour = () => cardProps.tour;
  const subTours = () => getSubTours(tour().config.id);
  const completed = () => tour().isCompleted();
  const updates = () => tour().hasUpdates();

  const handleStart = () => {
    if (updates()) {
      tour().startWhatsNew();
    } else {
      tour().resetTour();
      tour().start();
    }
  };

  return (
    <div class="p-3 bg-gray-alpha-50 rounded-2xl space-y-2">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl bg-gray-alpha-100 flex-col-center flex-shrink-0">
          <i class={`${tour().config.icon || "i-hugeicons-book-02"} w-4 h-4`} />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium truncate">
              {tour().config.label || tour().config.id}
            </span>
            <Show when={completed() && !updates()}>
              <span class="inline-flex items-center gap-1 text-xs text-green-400">
                <i class="i-hugeicons-checkmark-circle-02 w-3 h-3" />
                {t().settings?.tour?.completed || "Completed"}
              </span>
            </Show>
            <Show when={updates()}>
              <span class="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-blue-300 bg-blue-500/15 rounded-full">
                <i class="i-hugeicons-sparkles w-3 h-3" />
                {t().settings?.tour?.hasUpdates || "What's new"}
              </span>
            </Show>
          </div>
          <Show when={tour().config.description}>
            <p class="text-xs text-muted truncate">{tour().config.description}</p>
          </Show>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="text-xs text-muted">
            {tour().totalSteps()} {t().settings?.tour?.steps || "steps"}
          </span>
          <button
            class={`btn-sm flex items-center gap-1.5 ${updates() ? "btn-primary" : "btn-secondary"}`}
            onClick={handleStart}
          >
            <i class={`${updates() ? "i-hugeicons-sparkles" : "i-hugeicons-play"} w-3.5 h-3.5`} />
            {updates()
              ? (t().settings?.tour?.whatsNew || "What's new")
              : (t().settings?.tour?.startTour || "Start")}
          </button>
        </div>
      </div>

      {/* Под-туры */}
      <Show when={subTours().length > 0}>
        <div class="pl-8 space-y-1.5">
          <span class="text-xs text-muted">{t().settings?.tour?.subTours || "Additional tours"}</span>
          <For each={subTours()}>
            {(sub) => {
              const subCompleted = () => sub.isCompleted();
              const subUpdates = () => sub.hasUpdates();
              return (
                <div class="flex items-center gap-2 p-2 bg-gray-alpha-50 rounded-xl">
                  <i class={`${sub.config.icon || "i-hugeicons-book-02"} w-3.5 h-3.5 text-muted`} />
                  <span class="text-sm flex-1 truncate">{sub.config.label || sub.config.id}</span>
                  <Show when={subCompleted() && !subUpdates()}>
                    <i class="i-hugeicons-checkmark-circle-02 w-3.5 h-3.5 text-green-400" />
                  </Show>
                  <Show when={subUpdates()}>
                    <span class="w-2 h-2 rounded-full bg-blue-400" />
                  </Show>
                  <button
                    class="btn-ghost btn-sm text-xs"
                    onClick={() => {
                      if (subUpdates()) sub.startWhatsNew();
                      else { sub.resetTour(); sub.start(); }
                    }}
                  >
                    {subUpdates()
                      ? (t().settings?.tour?.whatsNew || "What's new")
                      : (t().settings?.tour?.startTour || "Start")}
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

export default function SettingsGeneral(props: Props) {
  const t = () => props.t();

  return (
    <>
      {/* Внешний вид */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-colors w-5 h-5" />
          {t().settings.appearance.title}
        </legend>
        <div class="space-y-4">
          <div class="flex flex-col gap-2">
            <label class="block text-sm font-medium">{t().settings.appearance.background}</label>
            <div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              <BackgroundOption
                type="floatingLines"
                label={t().settings.appearance.backgroundTypes.floatingLines}
                active={props.backgroundType() === "floatingLines"}
                onClick={() => props.onBackgroundTypeChange("floatingLines")}
                preview={
                  <LazyPreview keepAlive>
                    <FloatingLines
                      linesGradient={["#1e3a5f", "#2d1b4e", "#1a3d5c", "#3d1f5c"]}
                      lineCount={4}
                      lineDistance={4}
                      animationSpeed={0.3}
                      previewMode
                    />
                  </LazyPreview>
                }
              />
              <BackgroundOption
                type="aurora"
                label={t().settings.appearance.backgroundTypes.aurora}
                active={props.backgroundType() === "aurora"}
                onClick={() => props.onBackgroundTypeChange("aurora")}
                preview={
                  <LazyPreview keepAlive>
                    <Aurora
                      colorStops={["#0d3d4d", "#0d4035", "#2d1b4e"]}
                      amplitude={1.2}
                      blend={0.4}
                      speed={0.4}
                      previewMode
                    />
                  </LazyPreview>
                }
              />
              <BackgroundOption
                type="dotGrid"
                label={t().settings.appearance.backgroundTypes.dotGrid}
                active={props.backgroundType() === "dotGrid"}
                onClick={() => props.onBackgroundTypeChange("dotGrid")}
                preview={
                  <LazyPreview keepAlive>
                    <DotGrid
                      dotSize={2}
                      gap={16}
                      baseColor="#1a1a2e"
                      activeColor="#3b82f6"
                      waveIntensity={0.15}
                      waveSpeed={0.2}
                      previewMode
                    />
                  </LazyPreview>
                }
              />
              <BackgroundOption
                type="rippleGrid"
                label={t().settings.appearance.backgroundTypes.rippleGrid}
                active={props.backgroundType() === "rippleGrid"}
                onClick={() => props.onBackgroundTypeChange("rippleGrid")}
                preview={
                  <LazyPreview keepAlive>
                    <RippleGrid
                      gridColor="#2d3748"
                      rippleIntensity={0.04}
                      gridSize={10.0}
                      gridThickness={20.0}
                      vignetteStrength={3.0}
                      previewMode
                    />
                  </LazyPreview>
                }
              />
              <BackgroundOption
                type="edgePixels"
                label={t().settings.appearance.backgroundTypes.edgePixels}
                active={props.backgroundType() === "edgePixels"}
                onClick={() => props.onBackgroundTypeChange("edgePixels")}
                preview={
                  <LazyPreview keepAlive>
                    <EdgePixels
                      pixelColor="#3b82f6"
                      pixelSize={2}
                      edgeWidth={0.35}
                      previewMode
                    />
                  </LazyPreview>
                }
              />
              <BackgroundOption
                type="static"
                label={t().settings.appearance.backgroundTypes.static}
                active={props.backgroundType() === "static"}
                onClick={() => props.onBackgroundTypeChange("static")}
                preview={<div />}
              />
              <BackgroundOption
                type="image"
                label={t().settings.appearance.backgroundTypes.image}
                active={props.backgroundType() === "image"}
                onClick={() => props.backgroundImageUrl() ? props.onSelectExistingImage() : props.onPickBackgroundImage()}
                preview={
                  <Show
                    when={!props.loadingBackgroundImage()}
                    fallback={
                      <div class="absolute inset-0 bg-gray-alpha-50 flex-col-center gap-1">
                        <i class="i-svg-spinners-6-dots-scale w-5 h-5" />
                        <span class="text-xs text-gray-400">{t().settings.appearance.copying}</span>
                      </div>
                    }
                  >
                    {props.backgroundImageUrl() ? (
                      <div
                        class="absolute inset-0 bg-cover bg-center"
                        style={{ "background-image": `url(${props.backgroundImageUrl()})` }}
                      />
                    ) : (
                      <div class="absolute inset-0 bg-gray-alpha-50 flex-col-center gap-1">
                        <i class="i-hugeicons-image-01 w-6 h-6 text-gray-500" />
                        <span class="text-xs text-gray-500">{t().settings.appearance.selectImage}</span>
                      </div>
                    )}
                  </Show>
                }
              />
            </div>
          </div>

          {/* Управление картинкой если есть */}
          <Show when={props.backgroundImageUrl()}>
            <div class="flex items-center gap-3 p-3 bg-gray-alpha-50 rounded-2xl">
              <div
                class="w-16 h-10 rounded bg-cover bg-center border border-gray-600 flex-shrink-0"
                style={{ "background-image": `url(${props.backgroundImageUrl()})` }}
              />
              <div class="flex-1 min-w-0">
                <p class="text-xs text-muted truncate">{t().settings.appearance.backgroundImage}</p>
              </div>
              <button
                type="button"
                class="btn-ghost btn-sm text-gray-400 hover:text-white hover:bg-gray-700"
                onClick={props.onPickBackgroundImage}
                title={t().settings.appearance.change}
                disabled={props.loadingBackgroundImage()}
              >
                <i class="i-hugeicons-edit-02 w-4 h-4" />
              </button>
              <button
                type="button"
                class="btn-ghost btn-sm text-red-400 hover:bg-red-500/20"
                onClick={props.onClearBackgroundImage}
                title={t().common.delete}
              >
                <i class="i-hugeicons-delete-02 w-4 h-4" />
              </button>
            </div>
          </Show>

          {/* Затемнение */}
          <div class="flex flex-col gap-2">
            <label class="flex items-center justify-between text-sm font-medium">
              <span>{t().settings.appearance.dimming}</span>
              <span class="text-muted">{props.backgroundDimming()}%</span>
            </label>
            <RangeSlider
              value={props.backgroundDimming()}
              onChange={props.onDimmingChange}
              min={0}
              max={80}
              step={5}
              showTicks
              showLabels
              formatLabel={(val) => `${val}%`}
            />
            <p class="text-xs text-muted">{t().settings.appearance.dimmingHint}</p>
          </div>
        </div>
      </fieldset>

      {/* Язык / Language */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-translate w-5 h-5" />
          {t().settings.language.title}
        </legend>
        <div class="space-y-4">
          <div class="flex flex-col gap-3">
            <label class="block text-sm font-medium">{t().settings.language.select}</label>
            <div class="grid grid-cols-2 gap-3">
              <For each={props.languageOptions()}>
                {(lang) => {
                  const icon = (): string | JSX.Element =>
                    lang.flag
                      ? lang.flag
                      : (<i class="i-hugeicons-globe-02 w-6 h-6 text-muted" />) as JSX.Element;
                  const isCustom = !isBundledLanguage(lang.code);
                  return (
                    <RadioOption
                      icon={icon()}
                      title={lang.name}
                      subtitle={isCustom ? t().settings?.language?.custom ?? "Custom" : undefined}
                      active={props.language() === lang.code}
                      onClick={() => props.onLanguageChange(lang.code)}
                      action={isCustom ? (
                        <button
                          class="btn-ghost p-1 text-muted hover:text-red-400"
                          onClick={(e) => { e.stopPropagation(); props.onDeleteLanguage(lang.code); }}
                          title={t().common?.delete ?? "Delete"}
                        >
                          <i class="i-hugeicons-delete-02 w-3.5 h-3.5" />
                        </button>
                      ) : undefined}
                    />
                  );
                }}
              </For>
            </div>
            {/* Import language from file */}
            <button
              class="btn-ghost btn-sm flex items-center gap-1.5"
              onClick={props.onImportLanguage}
              disabled={props.importingLanguage()}
            >
              <Show
                when={!props.importingLanguage()}
                fallback={<i class="i-svg-spinners-ring-resize w-4 h-4" />}
              >
                <i class="i-hugeicons-download-02 w-4 h-4" />
              </Show>
              {t().settings?.language?.importLanguage ?? "Import language"}
            </button>

            <p class="text-xs text-muted">
              {t().settings.language.changesApply}
            </p>
          </div>
        </div>
      </fieldset>

      {/* Developer Mode */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-code-circle w-5 h-5" />
          {t().settings.developer?.title || "Developer Mode"}
        </legend>
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div class="flex-1 flex flex-col gap-1">
              <p class="text-sm font-medium">{t().settings.developer?.enable || "Enable Developer Mode"}</p>
              <p class="text-xs text-muted">
                {t().settings.developer?.description || "Shows Console and Source Code buttons in TitleBar. Keyboard shortcuts (Ctrl+Shift+D/U/T) work in both modes."}
              </p>
            </div>
            <Toggle
              checked={props.settings().developer_mode}
              onChange={props.onDeveloperModeChange}
            />
          </div>
        </div>
      </fieldset>

      {/* Обучение */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-book-02 w-5 h-5" />
          {t().settings?.tour?.title || "Onboarding"}
        </legend>
        <div class="space-y-4">
          <p class="text-sm text-muted">
            {t().settings?.tour?.description || "Interactive guide that highlights key features of the interface."}
          </p>

          {/* Список доступных туров */}
          <TourList t={t} />

          <div class="flex items-center gap-2">
            <button
              class="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={() => {
                resetAllTours();
                window.dispatchEvent(new CustomEvent("stuzhik:restart-tour"));
              }}
            >
              <i class="i-hugeicons-refresh w-4 h-4" />
              {t().settings?.tour?.restart || "Restart tour"}
            </button>
            <button
              class="btn-ghost btn-sm flex items-center gap-1.5"
              onClick={() => {
                resetAllTours();
                addToast({ type: "success", title: t().settings?.tour?.reset || "Tours reset", duration: 2000 });
              }}
            >
              <i class="i-hugeicons-delete-02 w-4 h-4" />
              {t().settings?.tour?.resetAll || "Reset progress"}
            </button>
          </div>
        </div>
      </fieldset>

      {/* Пользователь */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-user w-5 h-5" />
          {t().settings.user.title}
        </legend>
        <div class="flex flex-col gap-2">
          <label class="block text-sm font-medium">
            {t().settings.user.defaultUsername}
          </label>
          <input
            type="text"
            value={props.settings().default_username || ""}
            onInput={(e) => props.updateSetting("default_username", e.currentTarget.value || null)}
            placeholder={t().settings.user.usernamePlaceholder}
            class="input w-full"
          />
          <p class="text-xs text-muted">
            {t().settings.user.usernameHint}
          </p>
        </div>
      </fieldset>
    </>
  );
}
