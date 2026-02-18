import { createSignal, createMemo, createEffect, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useI18n, getBaseTranslations, flattenTranslations, unflattenTranslations, availableLanguages, getLanguageName, isBundledLanguage, type Language } from "../../../shared/i18n";
import { Toggle, Select, type SelectOption } from "../../../shared/ui";
import { addToast } from "../../../shared/components/Toast";
import { useSafeTimers } from "../../../shared/hooks";

interface Props {
  onClose?: () => void;
}

/** Module tree node: section → subsection → keys */
interface ModuleNode {
  /** Direct keys under this node (e.g., "settings.title" under section "settings") */
  directKeys: string[];
  /** Sub-modules (e.g., "interface", "developer" under "settings") */
  children: Record<string, string[]>;
}

export default function TranslationEditor(_props: Props) {
  const { t, language, loadCustomOverrides } = useI18n();
  const { setTimeout: safeTimeout } = useSafeTimers();

  // Editing language (independent of app language)
  const [editingLang, setEditingLang] = createSignal<Language>(language() as Language);

  // Base language for custom translations (which bundled language to use as template)
  const [baseLang, setBaseLang] = createSignal<string>("ru");

  // Whether the editing language is custom (not bundled)
  const isCustomLang = createMemo(() => !isBundledLanguage(editingLang()));

  // Base language options (only bundled languages)
  const baseLangOptions = createMemo<SelectOption[]>(() =>
    availableLanguages.map(lang => ({ value: lang, label: getLanguageName(lang) }))
  );

  // Custom language codes added by user (not in bundled locales)
  const [customLangCodes, setCustomLangCodes] = createSignal<string[]>([]);
  const [customLangNames, setCustomLangNames] = createSignal<Record<string, string>>({});
  const [showNewLang, setShowNewLang] = createSignal(false);
  const [newLangCode, setNewLangCode] = createSignal("");
  const [newLangName, setNewLangName] = createSignal("");

  // Language options for Select dropdown (bundled + custom)
  const langOptions = createMemo<SelectOption[]>(() => {
    const bundled = availableLanguages.map(lang => ({
      value: lang,
      label: getLanguageName(lang),
    }));
    const names = customLangNames();
    const custom = customLangCodes().map(code => ({
      value: code,
      label: names[code] ? `${names[code]} (${code})` : `${getLanguageName(code)} (${code})`,
    }));
    return [...bundled, ...custom];
  });

  const [search, setSearch] = createSignal("");
  const [showOnlyModified, setShowOnlyModified] = createSignal(false);
  const [expandedSections, setExpandedSections] = createSignal<Set<string>>(new Set());
  const [expandedSubsections, setExpandedSubsections] = createSignal<Set<string>>(new Set());
  const [editingKey, setEditingKey] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  // Pending edits before save
  const [pendingEdits, setPendingEdits] = createSignal<Record<string, string>>({});
  const [hasUnsaved, setHasUnsaved] = createSignal(false);

  // Load custom language codes from backend on mount
  onMount(async () => {
    try {
      const langs = await invoke<string[]>("list_custom_translation_langs");
      // Filter out bundled languages — only keep truly custom ones
      const custom = langs.filter(code => !availableLanguages.includes(code));
      if (custom.length > 0) {
        setCustomLangCodes(custom);
      }
    } catch {
      // Ignore — will just show bundled languages
    }
  });

  // Custom overrides loaded directly from backend for editing language
  const [editingOverrides, setEditingOverrides] = createSignal<Record<string, string>>({});

  // Load overrides when editing language changes
  createEffect(() => {
    const lang = editingLang();
    invoke<Record<string, any> | null>("get_custom_translations", { lang }).then(data => {
      if (data) {
        setEditingOverrides(flattenTranslations(data));
      } else {
        setEditingOverrides({});
      }
      // Reset pending edits when switching language
      setPendingEdits({});
      setHasUnsaved(false);
      setEditingKey(null);
    }).catch(() => {
      setEditingOverrides({});
      setPendingEdits({});
      setHasUnsaved(false);
    });
  });

  // Base translations for editing language (flattened)
  // For custom languages, uses the selected base language
  const baseFlat = createMemo(() => {
    const lang = editingLang();
    const base = isBundledLanguage(lang)
      ? getBaseTranslations(lang)
      : getBaseTranslations(baseLang());
    return flattenTranslations(base);
  });

  // Current custom overrides for editing language
  const overrides = createMemo(() => editingOverrides());

  // Merge pending edits with saved overrides for display
  const mergedOverrides = createMemo(() => {
    const saved = overrides();
    const pending = pendingEdits();
    return { ...saved, ...pending };
  });

  // All keys from base translations
  const allKeys = createMemo(() => Object.keys(baseFlat()).sort());

  // Filtered keys based on search and showOnlyModified
  const filteredKeys = createMemo(() => {
    const searchLower = search().toLowerCase();
    const onlyModified = showOnlyModified();
    const merged = mergedOverrides();
    const base = baseFlat();

    return allKeys().filter(key => {
      if (onlyModified && !merged[key]) return false;
      if (searchLower) {
        const baseValue = base[key] || "";
        const customValue = merged[key] || "";
        return (
          key.toLowerCase().includes(searchLower) ||
          baseValue.toLowerCase().includes(searchLower) ||
          customValue.toLowerCase().includes(searchLower)
        );
      }
      return true;
    });
  });

  // Build 2-level module tree from filtered keys
  const moduleTree = createMemo(() => {
    const tree: Record<string, ModuleNode> = {};

    for (const key of filteredKeys()) {
      const parts = key.split(".");
      const section = parts[0];

      if (!tree[section]) {
        tree[section] = { directKeys: [], children: {} };
      }

      if (parts.length <= 2) {
        // Direct key: "common.save" → section "common", direct key
        tree[section].directKeys.push(key);
      } else {
        // Nested key: "settings.interface.themeTitle" → section "settings", child "interface"
        const subsection = parts[1];
        if (!tree[section].children[subsection]) {
          tree[section].children[subsection] = [];
        }
        tree[section].children[subsection].push(key);
      }
    }

    return tree;
  });

  // Sorted section names
  const sections = createMemo(() => Object.keys(moduleTree()).sort());

  // Stats
  const stats = createMemo(() => {
    const total = allKeys().length;
    const merged = mergedOverrides();
    const modified = Object.keys(merged).filter(k => merged[k] && merged[k] !== "").length;
    return { total, modified };
  });

  // Start editing a key
  const startEditing = (key: string) => {
    const merged = mergedOverrides();
    const base = baseFlat();
    setEditingKey(key);
    setEditValue(merged[key] || base[key] || "");
  };

  // Confirm edit
  const confirmEdit = (key: string) => {
    const value = editValue().trim();
    const base = baseFlat();

    if (value === base[key]) {
      // Same as base — remove override
      const pending = { ...pendingEdits() };
      delete pending[key];
      const saved = overrides();
      if (saved[key]) {
        pending[key] = ""; // sentinel for "remove"
      }
      setPendingEdits(pending);
    } else if (value) {
      setPendingEdits(prev => ({ ...prev, [key]: value }));
    }
    setEditingKey(null);
    setHasUnsaved(true);
  };

  // Remove a single override
  const removeOverride = (key: string) => {
    const pending = { ...pendingEdits() };
    const saved = overrides();
    if (saved[key]) {
      pending[key] = ""; // sentinel
    } else {
      delete pending[key];
    }
    setPendingEdits(pending);
    setHasUnsaved(true);
  };

  // Save all changes
  const saveChanges = async () => {
    setSaving(true);
    try {
      const saved = { ...overrides() };
      const pending = pendingEdits();

      for (const [key, value] of Object.entries(pending)) {
        if (value === "") {
          delete saved[key];
        } else {
          saved[key] = value;
        }
      }

      const lang = editingLang();
      const nested = unflattenTranslations(saved);

      if (Object.keys(saved).length === 0) {
        await invoke("delete_custom_translations", { lang });
      } else {
        await invoke("save_custom_translations", { lang, data: nested });
      }

      setEditingOverrides(saved);
      setPendingEdits({});
      setHasUnsaved(false);

      if (lang === language()) {
        await loadCustomOverrides();
      }

      addToast({
        type: "success",
        title: t().settings?.translations?.saved ?? "Translations saved",
        duration: 2000,
      });
    } catch (e) {
      addToast({
        type: "error",
        title: t().settings?.translations?.saveError ?? "Failed to save",
        message: String(e),
        duration: 4000,
      });
    } finally {
      setSaving(false);
    }
  };

  // Reset all overrides
  const resetAll = async () => {
    try {
      const lang = editingLang();
      await invoke("delete_custom_translations", { lang });
      setEditingOverrides({});
      setPendingEdits({});
      setHasUnsaved(false);

      if (lang === language()) {
        await loadCustomOverrides();
      }

      addToast({
        type: "success",
        title: t().settings?.translations?.reset ?? "Translations reset to default",
        duration: 2000,
      });
    } catch (e) {
      addToast({
        type: "error",
        title: t().settings?.translations?.resetError ?? "Failed to reset",
        message: String(e),
        duration: 4000,
      });
    }
  };

  // Delete a custom language entirely
  const handleDeleteLanguage = async () => {
    const lang = editingLang();
    if (isBundledLanguage(lang)) return;

    try {
      await invoke("delete_custom_translations", { lang });
      setCustomLangCodes(prev => prev.filter(c => c !== lang));
      setEditingOverrides({});
      setPendingEdits({});
      setHasUnsaved(false);

      // Switch to first bundled language
      const fallback = availableLanguages[0] || "ru";
      setEditingLang(fallback as Language);

      if (lang === language()) {
        await loadCustomOverrides();
      }

      addToast({
        type: "success",
        title: t().settings?.language?.deleted ?? "Language deleted",
        duration: 2000,
      });
    } catch (e) {
      addToast({
        type: "error",
        title: t().settings?.language?.deleteError ?? "Failed to delete language",
        message: String(e),
        duration: 4000,
      });
    }
  };

  // Export translations
  const handleExport = async () => {
    try {
      const lang = editingLang();
      const filePath = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: `translations-${lang}.json`,
      });
      if (!filePath) return;

      await invoke("export_custom_translations", {
        lang,
        destPath: filePath,
      });

      addToast({
        type: "success",
        title: t().settings?.translations?.exported ?? "Translations exported",
        duration: 2000,
      });
    } catch (e) {
      addToast({
        type: "error",
        title: t().settings?.translations?.exportError ?? "Export failed",
        message: String(e),
        duration: 4000,
      });
    }
  };

  // Import translations
  const handleImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected || typeof selected !== "string") return;
      const filePath = selected;

      const lang = editingLang();
      const count = await invoke<number>("import_custom_translations", {
        lang,
        srcPath: filePath,
      });

      const data = await invoke<Record<string, any> | null>("get_custom_translations", { lang });
      setEditingOverrides(data ? flattenTranslations(data) : {});

      if (lang === language()) {
        await loadCustomOverrides();
      }
      setPendingEdits({});
      setHasUnsaved(false);

      addToast({
        type: "success",
        title: t().settings?.translations?.imported ?? "Translations imported",
        message: `${count} ${t().settings?.translations?.keysImported ?? "keys imported"}`,
        duration: 3000,
      });
    } catch (e) {
      addToast({
        type: "error",
        title: t().settings?.translations?.importError ?? "Import failed",
        message: String(e),
        duration: 4000,
      });
    }
  };

  // New language creation
  const handleCreateLanguage = () => {
    const code = newLangCode().trim().toLowerCase();
    // Strict validation: 2-5 ascii alphanumeric or '-' (matches backend validate_lang_code)
    if (!/^[a-z0-9-]{2,5}$/.test(code)) {
      addToast({ type: "error", title: "Invalid language code (2-5 latin chars)", duration: 3000 });
      return;
    }
    // Check if already exists
    const allCodes = [...availableLanguages, ...customLangCodes()];
    if (allCodes.includes(code as Language)) {
      addToast({ type: "error", title: "Language already exists", duration: 3000 });
      return;
    }

    const name = newLangName().trim();
    setCustomLangCodes(prev => [...prev, code]);
    if (name) {
      setCustomLangNames(prev => ({ ...prev, [code]: name }));
    }
    setEditingLang(code as Language);
    setShowNewLang(false);
    setNewLangCode("");
    setNewLangName("");
    addToast({
      type: "success",
      title: `Language "${code}" created`,
      message: "Base translations loaded as template. Edit and save to create your translation.",
      duration: 4000,
    });
  };

  // Toggle section expand/collapse
  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  // Toggle subsection expand/collapse
  const toggleSubsection = (id: string) => {
    setExpandedSubsections(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Expand all sections and subsections
  const expandAll = () => {
    const secs = new Set(sections());
    setExpandedSections(secs);
    const subs = new Set<string>();
    for (const sec of secs) {
      const node = moduleTree()[sec];
      if (node) {
        for (const sub of Object.keys(node.children)) {
          subs.add(`${sec}.${sub}`);
        }
      }
    }
    setExpandedSubsections(subs);
  };

  // Collapse all
  const collapseAll = () => {
    setExpandedSections(new Set<string>());
    setExpandedSubsections(new Set<string>());
  };

  // Get display value for a key
  const getDisplayValue = (key: string): { value: string; isModified: boolean } => {
    const merged = mergedOverrides();
    const base = baseFlat();
    if (merged[key] && merged[key] !== "") {
      return { value: merged[key], isModified: true };
    }
    return { value: base[key] || "", isModified: false };
  };

  // Count modified keys in a list
  const countModified = (keys: string[]): number => {
    const merged = mergedOverrides();
    return keys.filter(k => merged[k] && merged[k] !== "").length;
  };

  // Render a single translation key row
  const KeyRow = (props: { keyName: string; depth: number }) => {
    const key = props.keyName;
    const display = () => getDisplayValue(key);
    const isEditing = () => editingKey() === key;
    // Show the leaf part of the key (after the module prefix)
    const shortKey = () => {
      const parts = key.split(".");
      return parts.length <= 2 ? parts[parts.length - 1] : parts.slice(2).join(".");
    };

    return (
      <div
        class={`flex items-start gap-2 py-1.5 rounded hover:bg-gray-800/50 group ${
          display().isModified ? "bg-[var(--color-primary-bg)]" : ""
        }`}
        style={{ "padding-left": `${(props.depth + 1) * 0.75 + 0.75}rem`, "padding-right": "0.75rem" }}
      >
        {/* Key name */}
        <div class="flex-shrink-0 w-[35%] min-w-0">
          <span class="text-xs text-muted font-mono truncate block" title={key}>
            {shortKey()}
          </span>
        </div>

        {/* Value */}
        <div class="flex-1 min-w-0">
          <Show
            when={isEditing()}
            fallback={
              <div
                class="flex items-center gap-1 cursor-pointer"
                onClick={() => startEditing(key)}
              >
                <span
                  class={`text-xs truncate block ${
                    display().isModified ? "text-[var(--color-primary-light)]" : "text-gray-300"
                  }`}
                  title={display().value}
                >
                  {display().value}
                </span>
                <i class="i-hugeicons-edit-02 w-3 h-3 text-muted opacity-0 group-hover:opacity-100 flex-shrink-0" />
              </div>
            }
          >
            <div class="flex items-center gap-1">
              <input
                type="text"
                class="bg-gray-800 border border-[var(--color-primary-border)] rounded px-2 py-0.5 text-xs flex-1 outline-none focus:border-[var(--color-primary)]"
                value={editValue()}
                onInput={(e) => setEditValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmEdit(key);
                  if (e.key === "Escape") setEditingKey(null);
                }}
                ref={(el) => safeTimeout(() => el?.focus(), 50)}
              />
              <button
                class="text-green-400 hover:text-green-300 flex-shrink-0"
                onClick={() => confirmEdit(key)}
              >
                <i class="i-hugeicons-checkmark-circle-02 w-4 h-4" />
              </button>
              <button
                class="text-muted hover:text-white flex-shrink-0"
                onClick={() => setEditingKey(null)}
              >
                <i class="i-hugeicons-cancel-01 w-4 h-4" />
              </button>
            </div>
            {/* Show base value when editing */}
            <div class="text-[10px] text-muted mt-0.5 truncate" title={baseFlat()[key]}>
              {t().settings?.translations?.baseValue ?? "Base"}: {baseFlat()[key]}
            </div>
          </Show>
        </div>

        {/* Modified indicator + reset */}
        <div class="flex-shrink-0 w-6 flex items-center justify-center">
          <Show when={display().isModified}>
            <button
              class="text-[var(--color-primary)] hover:text-red-400"
              onClick={() => removeOverride(key)}
              title={t().settings?.translations?.resetKey ?? "Reset to default"}
            >
              <i class="i-hugeicons-refresh w-3.5 h-3.5" />
            </button>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <div class="flex flex-col h-full gap-3">
      {/* Header */}
      <div class="flex items-center justify-between flex-shrink-0">
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-2">
            <i class="i-hugeicons-translate w-5 h-5 text-[var(--color-primary)]" />
            <h3 class="text-sm font-medium">
              {t().settings?.translations?.title ?? "Translation Editor"}
            </h3>
          </div>
          <div class="flex items-center gap-2">
            <div class="w-40">
              <Select
                value={editingLang()}
                options={langOptions()}
                onChange={(val) => setEditingLang(val as Language)}
              />
            </div>
            <Show when={isCustomLang()}>
              <div class="flex items-center gap-1.5">
                <span class="text-xs text-muted whitespace-nowrap">
                  {t().settings?.translations?.baseLang ?? "Base"}:
                </span>
                <div class="w-32">
                  <Select
                    value={baseLang()}
                    options={baseLangOptions()}
                    onChange={(val) => setBaseLang(val)}
                  />
                </div>
              </div>
            </Show>
            <button
              class="btn-sm btn-ghost flex items-center gap-1"
              onClick={() => setShowNewLang(true)}
              title="Create new language"
            >
              <i class="i-hugeicons-add-01 w-4 h-4" />
            </button>
            <Show when={isCustomLang()}>
              <button
                class="btn-sm btn-ghost text-muted hover:text-red-400 flex items-center gap-1"
                onClick={handleDeleteLanguage}
                title={t().common?.delete ?? "Delete language"}
              >
                <i class="i-hugeicons-delete-02 w-4 h-4" />
              </button>
            </Show>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted">
            {stats().modified}/{stats().total} {t().settings?.translations?.modified ?? "modified"}
          </span>
        </div>
      </div>

      {/* New language inline form */}
      <Show when={showNewLang()}>
        <div class="flex items-center gap-2 p-3 bg-gray-800 rounded-xl flex-shrink-0">
          <input
            type="text"
            class="w-20 bg-gray-850 border border-gray-700 rounded-lg px-2 py-1.5 text-sm focus:border-[var(--color-primary)] outline-none font-mono"
            placeholder="en"
            value={newLangCode()}
            onInput={(e) => setNewLangCode(e.currentTarget.value)}
            maxLength={5}
          />
          <input
            type="text"
            class="w-40 bg-gray-850 border border-gray-700 rounded-lg px-2 py-1.5 text-sm focus:border-[var(--color-primary)] outline-none"
            placeholder={t().settings?.translations?.langNamePlaceholder ?? "Language name"}
            value={newLangName()}
            onInput={(e) => setNewLangName(e.currentTarget.value)}
          />
          <span class="text-xs text-muted">ISO 639-1</span>
          <div class="flex-1" />
          <button
            class="btn-primary btn-sm"
            disabled={!newLangCode().trim() || newLangCode().trim().length < 2}
            onClick={handleCreateLanguage}
          >
            {t().common?.create ?? "Create"}
          </button>
          <button
            class="btn-ghost btn-sm"
            onClick={() => { setShowNewLang(false); setNewLangCode(""); setNewLangName(""); }}
          >
            {t().common?.cancel ?? "Cancel"}
          </button>
        </div>
      </Show>

      {/* Toolbar */}
      <div class="flex items-center gap-2 flex-shrink-0">
        {/* Search */}
        <div class="flex-1 flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5">
          <i class="i-hugeicons-search-01 w-4 h-4 text-muted" />
          <input
            type="text"
            class="bg-transparent text-sm flex-1 outline-none placeholder-gray-500"
            placeholder={t().settings?.translations?.searchPlaceholder ?? "Search keys or values..."}
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
          <Show when={search()}>
            <button
              class="text-muted hover:text-white"
              onClick={() => setSearch("")}
            >
              <i class="i-hugeicons-cancel-01 w-3.5 h-3.5" />
            </button>
          </Show>
        </div>

        {/* Filter modified */}
        <div class="flex items-center gap-1.5">
          <Toggle
            checked={showOnlyModified()}
            onChange={setShowOnlyModified}
          />
          <span class="text-xs text-muted whitespace-nowrap">
            {t().settings?.translations?.onlyModified ?? "Modified only"}
          </span>
        </div>
      </div>

      {/* Action buttons */}
      <div class="flex items-center gap-2 flex-shrink-0">
        <button
          class="btn-sm btn-primary flex items-center gap-1.5"
          onClick={saveChanges}
          disabled={!hasUnsaved() || saving()}
        >
          <i class="i-hugeicons-floppy-disk w-3.5 h-3.5" />
          {saving()
            ? (t().settings?.translations?.saving ?? "Saving...")
            : (t().settings?.translations?.save ?? "Save")}
        </button>

        <button class="btn-sm btn-ghost flex items-center gap-1.5" onClick={expandAll}>
          <i class="i-hugeicons-arrow-down-01 w-3.5 h-3.5" />
          {t().settings?.translations?.expandAll ?? "Expand all"}
        </button>
        <button class="btn-sm btn-ghost flex items-center gap-1.5" onClick={collapseAll}>
          <i class="i-hugeicons-arrow-up-01 w-3.5 h-3.5" />
          {t().settings?.translations?.collapseAll ?? "Collapse all"}
        </button>

        <div class="flex-1" />

        <button class="btn-sm btn-ghost flex items-center gap-1.5" onClick={handleImport}>
          <i class="i-hugeicons-download-02 w-3.5 h-3.5" />
          {t().settings?.translations?.import ?? "Import"}
        </button>
        <button
          class="btn-sm btn-ghost flex items-center gap-1.5"
          onClick={handleExport}
          disabled={stats().modified === 0}
        >
          <i class="i-hugeicons-upload-02 w-3.5 h-3.5" />
          {t().settings?.translations?.export ?? "Export"}
        </button>
        <button
          class="btn-sm btn-ghost text-red-400 hover:text-red-300 flex items-center gap-1.5"
          onClick={resetAll}
          disabled={stats().modified === 0 && !hasUnsaved()}
        >
          <i class="i-hugeicons-refresh w-3.5 h-3.5" />
          {t().settings?.translations?.resetAll ?? "Reset all"}
        </button>
      </div>

      {/* Unsaved indicator */}
      <Show when={hasUnsaved()}>
        <div class="flex items-center gap-2 px-3 py-1.5 bg-amber-900/30 border border-amber-700/50 rounded-lg text-xs text-amber-300 flex-shrink-0">
          <i class="i-hugeicons-alert-02 w-3.5 h-3.5" />
          {t().settings?.translations?.unsavedChanges ?? "You have unsaved changes"}
        </div>
      </Show>

      {/* Translation tree */}
      <div class="flex-1 overflow-y-auto min-h-0 space-y-1">
        <Show
          when={filteredKeys().length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center py-12 text-muted">
              <i class="i-hugeicons-search-01 w-8 h-8 mb-2 opacity-50" />
              <p class="text-sm">
                {t().settings?.translations?.noResults ?? "No matching translation keys"}
              </p>
            </div>
          }
        >
          <For each={sections()}>
            {(section) => {
              const node = () => moduleTree()[section];
              const hasChildren = () => Object.keys(node()?.children ?? {}).length > 0;
              const allSectionKeys = () => {
                const n = node();
                if (!n) return [];
                const keys = [...n.directKeys];
                for (const sub of Object.values(n.children)) {
                  keys.push(...sub);
                }
                return keys;
              };
              const sectionModified = () => countModified(allSectionKeys());

              return (
                <Show when={node()}>
                  <div class="mb-1">
                    {/* Section header (level 1) */}
                    <button
                      class="w-full flex items-center gap-2 px-3 py-2 bg-gray-800/50 rounded-lg hover:bg-gray-800 transition-colors"
                      onClick={() => toggleSection(section)}
                    >
                      <i
                        class={`w-3.5 h-3.5 transition-transform ${
                          expandedSections().has(section) ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"
                        }`}
                      />
                      <span class="text-sm font-medium">{section}</span>
                      <span class="text-xs text-muted ml-1">
                        ({allSectionKeys().length})
                      </span>
                      <Show when={sectionModified() > 0}>
                        <span class="text-xs text-[var(--color-primary)] ml-auto">
                          {sectionModified()} {t().settings?.translations?.modified ?? "modified"}
                        </span>
                      </Show>
                    </button>

                    {/* Expanded section content */}
                    <Show when={expandedSections().has(section)}>
                      <div class="mt-1">
                        {/* Direct keys (no subsection) */}
                        <Show when={node().directKeys.length > 0}>
                          <For each={node().directKeys}>
                            {(key) => <KeyRow keyName={key} depth={1} />}
                          </For>
                        </Show>

                        {/* Subsections (level 2) */}
                        <Show when={hasChildren()}>
                          <For each={Object.keys(node().children).sort()}>
                            {(subsection) => {
                              const subId = () => `${section}.${subsection}`;
                              const subKeys = () => node().children[subsection] || [];
                              const subModified = () => countModified(subKeys());

                              return (
                                <div class="ml-3">
                                  {/* Subsection header */}
                                  <button
                                    class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-800/30 transition-colors"
                                    onClick={() => toggleSubsection(subId())}
                                  >
                                    <i
                                      class={`w-3 h-3 text-muted transition-transform ${
                                        expandedSubsections().has(subId()) ? "i-hugeicons-arrow-down-01" : "i-hugeicons-arrow-right-01"
                                      }`}
                                    />
                                    <span class="text-xs font-medium text-gray-400">{subsection}</span>
                                    <span class="text-[10px] text-muted">
                                      ({subKeys().length})
                                    </span>
                                    <Show when={subModified() > 0}>
                                      <span class="text-[10px] text-[var(--color-primary)] ml-auto">
                                        {subModified()}
                                      </span>
                                    </Show>
                                  </button>

                                  {/* Subsection keys */}
                                  <Show when={expandedSubsections().has(subId())}>
                                    <For each={subKeys()}>
                                      {(key) => <KeyRow keyName={key} depth={2} />}
                                    </For>
                                  </Show>
                                </div>
                              );
                            }}
                          </For>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </Show>
              );
            }}
          </For>
        </Show>
      </div>

      {/* Footer info */}
      <div class="flex items-center justify-between text-xs text-muted flex-shrink-0 pt-1 border-t border-gray-700/50">
        <span>
          {filteredKeys().length} {t().settings?.translations?.keysShown ?? "keys shown"}
        </span>
        <span>
          {t().settings?.translations?.hint ?? "Click any value to edit. Changes are applied after saving."}
        </span>
      </div>
    </div>
  );
}
