/**
 * InterfaceSettings — настройки кастомизации интерфейса.
 * Тема оформления (SurfaceTheme), акцентный цвет (AccentTheme),
 * режимы отображения, видимость элементов, плотность, профили, экспорт/импорт.
 */
import { createSignal, For, Show } from "solid-js";
import { useI18n } from "../../../shared/i18n";
import { Toggle, ViewModeSwitch } from "../../../shared/ui";
import { addToast } from "../../../shared/components/Toast";
import {
  getViewMode,
  setViewMode,
  isVisible,
  setVisible,
  getLayout,
  setLayoutField,
  // Surface themes (dark, light, custom...)
  getActiveTheme,
  setActiveTheme,
  getCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  BUILT_IN_THEMES,
  makeSurfaceTheme,
  // Accent colors (blue, purple, custom...)
  getActiveAccent,
  setActiveAccent,
  getCustomAccents,
  saveCustomAccent,
  deleteCustomAccent,
  generateAccentFromColor,
  BUILT_IN_ACCENTS,
  // Shape (border-radius, spacing, blur)
  getActiveShape,
  setActiveShape,
  SHAPE_PRESETS,
  // Profiles & data
  getProfiles,
  getActiveProfile,
  saveProfile,
  loadProfile,
  deleteProfile,
  exportPreferences,
  importPreferences,
  resetPreferences,
  type ViewMode,
  type CardDensity,
  type FontScale,
  getMenuAlign,
  setMenuAlign,
} from "../../../shared/stores/uiPreferences";

export default function InterfaceSettings() {
  const { t } = useI18n();
  const [customAccentColor, setCustomAccentColor] = createSignal("#3b82f6");
  const [customAccentName, setCustomAccentName] = createSignal("");
  const [showNewProfile, setShowNewProfile] = createSignal(false);
  const [newProfileName, setNewProfileName] = createSignal("");

  // Custom surface theme creator
  const [showThemeCreator, setShowThemeCreator] = createSignal(false);
  const [themeName, setThemeName] = createSignal("");
  const [themeBg, setThemeBg] = createSignal("#0d0e11");
  const [themeElevated, setThemeElevated] = createSignal("#1a1b1f");
  const [themeText, setThemeText] = createSignal("#e5e7eb");
  const [themeMuted, setThemeMuted] = createSignal("#9ca3af");
  const [themeBorder, setThemeBorder] = createSignal("#2a2b2f");
  const [themeScheme, setThemeScheme] = createSignal<"dark" | "light">("dark");

  // ==================== Accents ====================

  const allAccents = () => {
    const customs = getCustomAccents();
    return { ...BUILT_IN_ACCENTS, ...customs };
  };

  const allThemes = () => {
    const customs = getCustomThemes();
    return { ...BUILT_IN_THEMES, ...customs };
  };

  const handleSaveCustomTheme = () => {
    const name = themeName().trim();
    if (!name) return;
    const theme = makeSurfaceTheme(name, themeBg(), themeElevated(), themeText(), themeMuted(), themeBorder(), themeScheme());
    const id = `custom-theme-${Date.now()}`;
    saveCustomTheme(id, theme);
    setActiveTheme(id);
    setThemeName("");
    setShowThemeCreator(false);
    addToast({ type: "success", title: t().settings?.interface?.themeSaved ?? "Тема сохранена", duration: 2000 });
  };

  const handleSaveCustomAccent = () => {
    const name = customAccentName().trim();
    if (!name) return;
    const accent = generateAccentFromColor(name, customAccentColor());
    const id = `custom-accent-${Date.now()}`;
    saveCustomAccent(id, accent);
    setActiveAccent(id);
    setCustomAccentName("");
    addToast({ type: "success", title: t().settings?.interface?.themeSaved ?? "Цвет сохранён", duration: 2000 });
  };

  // ==================== Profile Section ====================

  const handleSaveProfile = () => {
    const name = newProfileName().trim();
    if (!name) return;
    const id = `profile-${Date.now()}`;
    saveProfile(id, name, "i-hugeicons-paint-board");
    setShowNewProfile(false);
    setNewProfileName("");
    addToast({ type: "success", title: t().settings?.interface?.profileSaved ?? "Профиль сохранён", duration: 2000 });
  };

  const handleExport = () => {
    const json = exportPreferences();
    navigator.clipboard.writeText(json);
    addToast({ type: "success", title: t().settings?.interface?.exportedToClipboard ?? "Скопировано в буфер", duration: 2000 });
  };

  const handleImport = async () => {
    try {
      const json = await navigator.clipboard.readText();
      if (importPreferences(json)) {
        addToast({ type: "success", title: t().settings?.interface?.importSuccess ?? "Настройки импортированы", duration: 2000 });
      } else {
        addToast({ type: "error", title: t().settings?.interface?.importError ?? "Ошибка импорта", duration: 3000 });
      }
    } catch {
      addToast({ type: "error", title: t().settings?.interface?.clipboardError ?? "Нет доступа к буферу", duration: 3000 });
    }
  };

  const handleReset = () => {
    resetPreferences();
    addToast({ type: "success", title: t().settings?.interface?.resetDone ?? "Настройки сброшены", duration: 2000 });
  };

  // ==================== Visibility Toggles ====================

  const visibilityItems = () => [
    { key: "instanceBadges", label: t().settings?.interface?.vis?.instanceBadges ?? "Бейджи экземпляров" },
    { key: "instancePlaytime", label: t().settings?.interface?.vis?.instancePlaytime ?? "Время игры" },
    { key: "instanceQuickPlay", label: t().settings?.interface?.vis?.instanceQuickPlay ?? "Быстрый запуск" },
    { key: "modDescriptions", label: t().settings?.interface?.vis?.modDescriptions ?? "Описания модов" },
    { key: "modThumbnails", label: t().settings?.interface?.vis?.modThumbnails ?? "Иконки модов" },
    { key: "modpackChangelogs", label: t().settings?.interface?.vis?.modpackChangelogs ?? "Ченжлоги модпаков" },
    { key: "toolsMenu", label: t().settings?.interface?.vis?.toolsMenu ?? "Меню инструментов" },
    { key: "connectButton", label: t().settings?.interface?.vis?.connectButton ?? "Кнопка Connect" },
    { key: "downloadNotifications", label: t().settings?.interface?.vis?.downloadNotifications ?? "Уведомления о загрузках" },
    { key: "searchBar", label: t().settings?.interface?.vis?.searchBar ?? "Поиск (Ctrl+F)" },
  ];

  // ==================== View Mode Sections ====================

  const viewModeSections = () => [
    { key: "instances", label: t().instances?.title ?? "Экземпляры", modes: ["grid", "list"] as ViewMode[] },
    { key: "mods", label: t().common?.mods ?? "Моды", modes: ["grid", "list", "compact"] as ViewMode[] },
    { key: "modpacks", label: t().modpacks?.title ?? "Модпаки", modes: ["grid", "list"] as ViewMode[] },
    { key: "backups", label: t().backup?.title ?? "Бэкапы", modes: ["grid", "list"] as ViewMode[] },
  ];

  // ==================== Density Options ====================

  const densityOptions = [
    { value: "compact" as CardDensity, label: t().settings?.interface?.density?.compact ?? "Компактный" },
    { value: "normal" as CardDensity, label: t().settings?.interface?.density?.normal ?? "Обычный" },
    { value: "comfortable" as CardDensity, label: t().settings?.interface?.density?.comfortable ?? "Свободный" },
  ];

  const fontOptions = [
    { value: "small" as FontScale, label: t().settings?.interface?.font?.small ?? "Мелкий" },
    { value: "default" as FontScale, label: t().settings?.interface?.font?.default ?? "Стандартный" },
    { value: "large" as FontScale, label: t().settings?.interface?.font?.large ?? "Крупный" },
  ];

  return (
    <div class="space-y-8">
      {/* === Surface Theme (Dark/Light/Custom) === */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-paint-board w-5 h-5" />
          {t().settings?.interface?.colorModeTitle ?? "Тема оформления"}
        </legend>
        <div class="flex gap-3 flex-wrap">
          <For each={Object.entries(allThemes())}>
            {([id, theme]) => (
              <button
                class={`flex items-center gap-2 px-5 py-3 rounded-xl transition-colors duration-100 ${
                  getActiveTheme() === id
                    ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)] border-2 border-[var(--color-primary-border)]"
                    : "bg-gray-800 text-gray-400 border-2 border-transparent hover:border-gray-600"
                }`}
                onClick={() => setActiveTheme(id)}
              >
                <i class={`${theme.colorScheme === "dark" ? "i-hugeicons-moon-02" : "i-hugeicons-sun-03"} w-5 h-5`} />
                <span class="text-sm font-medium">{theme.name}</span>
                {id === "light" && <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 leading-none">beta</span>}
              </button>
            )}
          </For>
        </div>
        {/* Delete custom surface theme */}
        <Show when={!BUILT_IN_THEMES[getActiveTheme()]}>
          <button
            class="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
            onClick={() => {
              deleteCustomTheme(getActiveTheme());
            }}
          >
            <i class="i-hugeicons-delete-02 w-3 h-3" />
            {t().settings?.interface?.deleteTheme ?? "Удалить эту тему"}
          </button>
        </Show>
        {/* Custom surface theme creator */}
        <Show
          when={showThemeCreator()}
          fallback={
            <button
              class="btn-secondary btn-sm"
              onClick={() => setShowThemeCreator(true)}
            >
              <i class="i-hugeicons-add-01 w-4 h-4" />
              {t().settings?.interface?.createTheme ?? "Создать тему"}
            </button>
          }
        >
          <div class="p-4 bg-gray-800 rounded-xl space-y-3">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium">{t().settings?.interface?.newTheme ?? "Новая тема"}</span>
            </div>

            {/* Name input */}
            <input
              type="text"
              value={themeName()}
              onInput={(e) => setThemeName(e.currentTarget.value)}
              placeholder={t().settings?.interface?.themeName ?? "Название темы..."}
              class="w-full bg-gray-850 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:border-[var(--color-primary)] outline-none"
            />

            {/* Color pickers grid */}
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {/* Background */}
              <div class="flex items-center gap-2">
                <div
                  class="w-8 h-8 rounded-lg cursor-pointer border border-gray-700 overflow-hidden flex-shrink-0"
                  style={{ "background-color": themeBg() }}
                  onClick={() => (document.getElementById("theme-bg-picker") as HTMLInputElement)?.click()}
                >
                  <input id="theme-bg-picker" type="color" value={themeBg()} onInput={(e) => setThemeBg(e.currentTarget.value)} class="opacity-0 w-full h-full cursor-pointer" />
                </div>
                <span class="text-xs text-gray-400">{t().settings?.interface?.themeColors?.bg ?? "Фон"}</span>
              </div>

              {/* Elevated */}
              <div class="flex items-center gap-2">
                <div
                  class="w-8 h-8 rounded-lg cursor-pointer border border-gray-700 overflow-hidden flex-shrink-0"
                  style={{ "background-color": themeElevated() }}
                  onClick={() => (document.getElementById("theme-elevated-picker") as HTMLInputElement)?.click()}
                >
                  <input id="theme-elevated-picker" type="color" value={themeElevated()} onInput={(e) => setThemeElevated(e.currentTarget.value)} class="opacity-0 w-full h-full cursor-pointer" />
                </div>
                <span class="text-xs text-gray-400">{t().settings?.interface?.themeColors?.elevated ?? "Карточки"}</span>
              </div>

              {/* Text */}
              <div class="flex items-center gap-2">
                <div
                  class="w-8 h-8 rounded-lg cursor-pointer border border-gray-700 overflow-hidden flex-shrink-0"
                  style={{ "background-color": themeText() }}
                  onClick={() => (document.getElementById("theme-text-picker") as HTMLInputElement)?.click()}
                >
                  <input id="theme-text-picker" type="color" value={themeText()} onInput={(e) => setThemeText(e.currentTarget.value)} class="opacity-0 w-full h-full cursor-pointer" />
                </div>
                <span class="text-xs text-gray-400">{t().settings?.interface?.themeColors?.text ?? "Текст"}</span>
              </div>

              {/* Muted */}
              <div class="flex items-center gap-2">
                <div
                  class="w-8 h-8 rounded-lg cursor-pointer border border-gray-700 overflow-hidden flex-shrink-0"
                  style={{ "background-color": themeMuted() }}
                  onClick={() => (document.getElementById("theme-muted-picker") as HTMLInputElement)?.click()}
                >
                  <input id="theme-muted-picker" type="color" value={themeMuted()} onInput={(e) => setThemeMuted(e.currentTarget.value)} class="opacity-0 w-full h-full cursor-pointer" />
                </div>
                <span class="text-xs text-gray-400">{t().settings?.interface?.themeColors?.muted ?? "Приглушённый"}</span>
              </div>

              {/* Border */}
              <div class="flex items-center gap-2">
                <div
                  class="w-8 h-8 rounded-lg cursor-pointer border border-gray-700 overflow-hidden flex-shrink-0"
                  style={{ "background-color": themeBorder() }}
                  onClick={() => (document.getElementById("theme-border-picker") as HTMLInputElement)?.click()}
                >
                  <input id="theme-border-picker" type="color" value={themeBorder()} onInput={(e) => setThemeBorder(e.currentTarget.value)} class="opacity-0 w-full h-full cursor-pointer" />
                </div>
                <span class="text-xs text-gray-400">{t().settings?.interface?.themeColors?.border ?? "Бордер"}</span>
              </div>

              {/* Scheme toggle */}
              <div class="flex items-center gap-2">
                <button
                  class={`w-8 h-8 rounded-lg border flex items-center justify-center transition-colors duration-100 ${
                    themeScheme() === "dark" ? "bg-gray-900 border-gray-600 text-gray-300" : "bg-gray-100 border-gray-300 text-gray-700"
                  }`}
                  onClick={() => setThemeScheme(s => s === "dark" ? "light" : "dark")}
                >
                  <i class={`${themeScheme() === "dark" ? "i-hugeicons-moon-02" : "i-hugeicons-sun-03"} w-4 h-4`} />
                </button>
                <span class="text-xs text-gray-400">{themeScheme() === "dark" ? "Dark" : "Light"}</span>
              </div>
            </div>

            {/* Preview */}
            <div
              class="rounded-xl p-3 border flex items-center gap-3"
              style={{
                "background-color": themeElevated(),
                "border-color": themeBorder(),
              }}
            >
              <div class="w-6 h-6 rounded-lg" style={{ "background-color": themeBg() }} />
              <span class="text-sm font-medium" style={{ color: themeText() }}>{themeName() || "Preview"}</span>
              <span class="text-xs" style={{ color: themeMuted() }}>muted text</span>
            </div>

            {/* Actions */}
            <div class="flex items-center gap-2">
              <button
                class="btn-primary btn-sm"
                disabled={!themeName().trim()}
                onClick={handleSaveCustomTheme}
              >
                {t().common.save}
              </button>
              <button
                class="btn-ghost btn-sm"
                onClick={() => setShowThemeCreator(false)}
              >
                {t().common.cancel}
              </button>
            </div>
          </div>
        </Show>

        <p class="text-xs text-muted">
          {t().settings?.interface?.colorModeHint ?? "Светлая тема — экспериментальная. Некоторые элементы могут отображаться некорректно."}
        </p>
      </fieldset>

      {/* === Accent Color === */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-colors w-5 h-5" />
          {t().settings?.interface?.themeTitle ?? "Акцентный цвет"}
        </legend>

        {/* Built-in + custom accent grid */}
        <div class="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
          <For each={Object.entries(allAccents())}>
            {([id, accent]) => (
              <button
                class={`flex flex-col items-center gap-1.5 p-2 rounded-xl transition-colors duration-100 ${
                  getActiveAccent() === id
                    ? "bg-gray-750 ring-2 ring-offset-2 ring-offset-gray-850"
                    : "hover:bg-gray-800"
                }`}
                style={{ "--un-ring-color": getActiveAccent() === id ? accent.accent : undefined } as Record<string, string | undefined>}
                onClick={() => setActiveAccent(id)}
              >
                <div
                  class="w-8 h-8 rounded-full border-2 border-gray-700"
                  style={{ "background-color": accent.accent }}
                />
                <span class="text-xs text-gray-400 truncate max-w-full">
                  {accent.name}
                </span>
              </button>
            )}
          </For>
        </div>

        {/* Custom accent creator */}
        <div class="flex items-center gap-3 p-3 bg-gray-800 rounded-xl">
          <div
            class="w-10 h-10 rounded-lg cursor-pointer border border-gray-700 overflow-hidden flex-shrink-0"
            style={{ "background-color": customAccentColor() }}
            onClick={() => {
              const input = document.getElementById("settings-accent-picker") as HTMLInputElement;
              input?.click();
            }}
          >
            <input
              id="settings-accent-picker"
              type="color"
              value={customAccentColor()}
              onInput={(e) => setCustomAccentColor(e.currentTarget.value)}
              class="opacity-0 w-full h-full cursor-pointer"
            />
          </div>
          <input
            type="text"
            value={customAccentName()}
            onInput={(e) => setCustomAccentName(e.currentTarget.value)}
            placeholder={t().settings?.interface?.customThemeName ?? "Название цвета..."}
            class="flex-1 bg-gray-850 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:border-[var(--color-primary)] outline-none"
          />
          <button
            class="btn-primary btn-sm"
            disabled={!customAccentName().trim()}
            onClick={handleSaveCustomAccent}
          >
            {t().common.save}
          </button>
        </div>

        {/* Delete custom accent */}
        <Show when={!BUILT_IN_ACCENTS[getActiveAccent()]}>
          <button
            class="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
            onClick={() => deleteCustomAccent(getActiveAccent())}
          >
            <i class="i-hugeicons-delete-02 w-3 h-3" />
            {t().settings?.interface?.deleteAccent ?? "Удалить этот цвет"}
          </button>
        </Show>
      </fieldset>

      {/* === Shape (Border Radius) === */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-paint-brush-01 w-5 h-5" />
          {t().settings?.interface?.shapeTitle ?? "Форма элементов"}
        </legend>
        <div class="flex gap-3 flex-wrap">
          <For each={Object.entries(SHAPE_PRESETS)}>
            {([id, preset]) => (
              <button
                class={`flex flex-col items-center gap-2 px-5 py-3 rounded-xl transition-colors duration-100 ${
                  getActiveShape() === id
                    ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)] border-2 border-[var(--color-primary-border)]"
                    : "bg-gray-800 text-gray-400 border-2 border-transparent hover:border-gray-600"
                }`}
                onClick={() => setActiveShape(id)}
              >
                {/* Preview shape */}
                <div
                  class="w-8 h-5 border-2 border-current"
                  style={{
                    "border-radius": id === "square" ? "0px"
                      : id === "sharp" ? "3px"
                      : id === "round" ? "10px"
                      : "6px",
                  }}
                />
                <span class="text-xs font-medium">{preset.name}</span>
              </button>
            )}
          </For>
        </div>
      </fieldset>

      {/* === View Modes === */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-grid w-5 h-5" />
          {t().settings?.interface?.viewModesTitle ?? "Режимы отображения"}
        </legend>
        <div class="space-y-3">
          <For each={viewModeSections()}>
            {(section) => (
              <div class="flex items-center justify-between py-2">
                <span class="text-sm text-gray-300">{section.label}</span>
                <ViewModeSwitch
                  value={getViewMode(section.key)}
                  onChange={(mode) => setViewMode(section.key, mode)}
                  modes={section.modes}
                />
              </div>
            )}
          </For>
        </div>
      </fieldset>

      {/* === Layout === */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-layout-bottom w-5 h-5" />
          {t().settings?.interface?.layoutTitle ?? "Компоновка"}
        </legend>
        <div class="space-y-4">
          {/* Card density */}
          <div>
            <label class="block text-sm font-medium mb-2">
              {t().settings?.interface?.cardDensity ?? "Плотность карточек"}
            </label>
            <div class="flex gap-2">
              <For each={densityOptions}>
                {(opt) => (
                  <button
                    class={`px-4 py-2 rounded-xl text-sm transition-colors duration-100 ${
                      getLayout().cardDensity === opt.value
                        ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)]"
                        : "bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-600"
                    }`}
                    onClick={() => setLayoutField("cardDensity", opt.value)}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </div>

          {/* Font scale */}
          <div>
            <label class="block text-sm font-medium mb-2">
              {t().settings?.interface?.fontSize ?? "Размер шрифта"}
            </label>
            <div class="flex gap-2">
              <For each={fontOptions}>
                {(opt) => (
                  <button
                    class={`px-4 py-2 rounded-xl text-sm transition-colors duration-100 ${
                      getLayout().fontSize === opt.value
                        ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)]"
                        : "bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-600"
                    }`}
                    onClick={() => setLayoutField("fontSize", opt.value)}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </div>

          {/* Instance columns */}
          <div>
            <label class="block text-sm font-medium mb-2">
              {t().settings?.interface?.instanceColumns ?? "Колонки экземпляров"}
            </label>
            <div class="flex gap-2">
              {[0, 1, 2, 3].map(cols => (
                <button
                  class={`px-4 py-2 rounded-xl text-sm transition-colors duration-100 ${
                    getLayout().instanceColumns === cols
                      ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)]"
                      : "bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-600"
                  }`}
                  onClick={() => setLayoutField("instanceColumns", cols)}
                >
                  {cols === 0 ? (t().settings?.interface?.columnsAuto ?? "Авто") : cols}
                </button>
              ))}
            </div>
          </div>

          {/* Menu text alignment */}
          <div>
            <label class="block text-sm font-medium mb-2">
              {t().settings?.interface?.menuAlign ?? "Выравнивание меню"}
            </label>
            <div class="flex gap-2">
              <button
                class={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors duration-100 ${
                  getMenuAlign() === "left"
                    ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)]"
                    : "bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-600"
                }`}
                onClick={() => setMenuAlign("left")}
              >
                <i class="i-hugeicons-text-align-justify-left w-4 h-4" />
                {t().settings?.interface?.menuAlignLeft ?? "По левому краю"}
              </button>
              <button
                class={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors duration-100 ${
                  getMenuAlign() === "center"
                    ? "bg-[var(--color-primary-bg)] text-[var(--color-primary)] border border-[var(--color-primary-border)]"
                    : "bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-600"
                }`}
                onClick={() => setMenuAlign("center")}
              >
                <i class="i-hugeicons-text-align-justify-center w-4 h-4" />
                {t().settings?.interface?.menuAlignCenter ?? "По центру"}
              </button>
            </div>
          </div>
        </div>
      </fieldset>

      {/* === Visibility === */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-view w-5 h-5" />
          {t().settings?.interface?.visibilityTitle ?? "Видимость элементов"}
        </legend>
        <div class="space-y-1">
          <For each={visibilityItems()}>
            {(item) => (
              <div class="flex items-center justify-between py-2 px-1">
                <span class="text-sm text-gray-300">{item.label}</span>
                <Toggle
                  checked={isVisible(item.key)}
                  onChange={(checked) => setVisible(item.key, checked)}
                />
              </div>
            )}
          </For>
        </div>
      </fieldset>

      {/* === Profiles === */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-user-settings-01 w-5 h-5" />
          {t().settings?.interface?.profilesTitle ?? "Профили настроек"}
        </legend>

        {/* Profile list */}
        <div class="space-y-2 mb-4">
          <For each={Object.entries(getProfiles())}>
            {([id, profile]) => (
              <div class={`flex items-center justify-between p-3 rounded-xl transition-colors duration-100 ${
                getActiveProfile() === id ? "bg-gray-750 border border-gray-700" : "bg-gray-800 border border-transparent"
              }`}>
                <div class="flex items-center gap-3">
                  <i class={`${profile.icon} w-4 h-4 text-gray-400`} />
                  <span class="text-sm">{profile.name}</span>
                </div>
                <div class="flex items-center gap-2">
                  <Show when={getActiveProfile() !== id}>
                    <button
                      class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                      onClick={() => loadProfile(id)}
                    >
                      {t().settings?.interface?.loadProfile ?? "Загрузить"}
                    </button>
                  </Show>
                  <button
                    class="text-xs text-red-400/70 hover:text-red-400 transition-colors"
                    onClick={() => deleteProfile(id)}
                  >
                    <i class="i-hugeicons-delete-02 w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </For>

          <Show when={Object.keys(getProfiles()).length === 0}>
            <p class="text-sm text-gray-600 py-2">
              {t().settings?.interface?.noProfiles ?? "Нет сохранённых профилей"}
            </p>
          </Show>
        </div>

        {/* New profile form */}
        <Show
          when={showNewProfile()}
          fallback={
            <button
              class="btn-secondary btn-sm"
              onClick={() => setShowNewProfile(true)}
            >
              <i class="i-hugeicons-add-01 w-4 h-4" />
              {t().settings?.interface?.createProfile ?? "Сохранить текущие настройки как профиль"}
            </button>
          }
        >
          <div class="flex items-center gap-2">
            <input
              type="text"
              value={newProfileName()}
              onInput={(e) => setNewProfileName(e.currentTarget.value)}
              placeholder={t().settings?.interface?.profileName ?? "Название профиля..."}
              class="flex-1 bg-gray-850 border border-gray-700 rounded-lg px-3 py-1.5 text-sm focus:border-[var(--color-primary)] outline-none"
              onKeyDown={(e) => e.key === "Enter" && handleSaveProfile()}
            />
            <button
              class="btn-primary btn-sm"
              disabled={!newProfileName().trim()}
              onClick={handleSaveProfile}
            >
              {t().common.save}
            </button>
            <button
              class="btn-ghost btn-sm"
              onClick={() => setShowNewProfile(false)}
            >
              {t().common.cancel}
            </button>
          </div>
        </Show>
      </fieldset>

      {/* === Export / Import / Reset === */}
      <fieldset class="flex flex-col gap-4">
        <legend class="text-base font-medium inline-flex items-center gap-2">
          <i class="i-hugeicons-file-export w-5 h-5" />
          {t().settings?.interface?.dataTitle ?? "Данные настроек"}
        </legend>
        <div class="flex items-center gap-3">
          <button class="btn-secondary btn-sm" onClick={handleExport}>
            <i class="i-hugeicons-copy-01 w-4 h-4" />
            {t().settings?.interface?.exportBtn ?? "Экспорт"}
          </button>
          <button class="btn-secondary btn-sm" onClick={handleImport}>
            <i class="i-hugeicons-file-import w-4 h-4" />
            {t().settings?.interface?.importBtn ?? "Импорт"}
          </button>
          <button class="btn-ghost btn-sm text-red-400" onClick={handleReset}>
            <i class="i-hugeicons-refresh w-4 h-4" />
            {t().settings?.interface?.resetBtn ?? "Сбросить всё"}
          </button>
        </div>
      </fieldset>
    </div>
  );
}
