import { onMount, onCleanup, createEffect, createSignal, Show } from "solid-js";
import loader from "@monaco-editor/loader";
import type * as Monaco from "monaco-editor";
import { registerEnhancedLanguages } from "../utils/enhanced-languages";
import { registerKubeJSTypes } from "../monaco/registerKubeJSTypes";

type SupportedLanguage =
  | "toml" | "json" | "jsonc" | "properties" | "yaml" | "txt"
  | "javascript" | "typescript" | "java" | "python"
  | "shell" | "bat" | "gradle" | "xml" | "html" | "css"
  | "markdown" | "dockerfile" | "rust" | "lua";

interface MonacoEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  language?: SupportedLanguage;
  fileName?: string;
  readOnly?: boolean;
  // Optional custom providers for IntelliSense
  completionProvider?: (monaco: typeof Monaco) => Monaco.languages.CompletionItemProvider;
  hoverProvider?: (monaco: typeof Monaco) => Monaco.languages.HoverProvider;
}

export function MonacoEditor(props: MonacoEditorProps) {
  let containerRef: HTMLDivElement | undefined;
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
  let suppressOnChange = false; // Флаг для подавления onChange при программной установке
  const [isReady, setIsReady] = createSignal(false);
  const [isFullscreen, setIsFullscreen] = createSignal(false);
  const [currentFileName, setCurrentFileName] = createSignal<string>("");
  const [isDirty, setIsDirty] = createSignal(false);
  const [initialValue, setInitialValue] = createSignal<string>("");

  onMount(async () => {
    if (!containerRef) return;

    // Suppress ResizeObserver errors from Monaco
    const originalError = window.onerror;
    window.onerror = (msg) => {
      if (typeof msg === "string" && msg.includes("ResizeObserver")) {
        return true; // Suppress
      }
      return originalError ? originalError.apply(window, arguments as any) : false;
    };

    // ESC handler for fullscreen
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen()) {
        setIsFullscreen(false);
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    try {
      // Load Monaco
      const monaco = await loader.init();

      // Register enhanced language tokenizers
      monaco.languages.register({ id: "toml" });
      monaco.languages.register({ id: "properties" });
      registerEnhancedLanguages(monaco);

      // Register KubeJS TypeScript definitions for IntelliSense
      registerKubeJSTypes(monaco);

      // Configure JSON to allow comments (for .json5 and .jsonc files)
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        validate: true,
        allowComments: true,
        schemas: [],
        enableSchemaRequest: false,
      });

      // Map language types to Monaco languages
      const languageMap: Record<string, string> = {
        // Config files - use custom languages
        toml: "toml",
        json: "json",
        jsonc: "json", // JSON with Comments (uses same Monaco lang)
        properties: "properties",
        yaml: "yaml",
        txt: "plaintext",
        // Programming languages
        javascript: "javascript",
        typescript: "typescript",
        java: "java",
        python: "python",
        rust: "rust",
        lua: "lua",
        // Scripts & Build
        shell: "shell",
        bat: "bat",
        gradle: "groovy",
        // Markup & Web
        xml: "xml",
        html: "html",
        css: "css",
        markdown: "markdown",
        // Other
        dockerfile: "dockerfile",
      };

      const monacoLanguage = languageMap[props.language || "txt"] || "plaintext";

      // Create editor
      editor = monaco.editor.create(containerRef, {
        value: props.value,
        language: monacoLanguage,
        theme: "vs-dark",
        automaticLayout: true,
        fontSize: 14,
        lineHeight: 21,
        fontFamily: "Cascadia Code, JetBrains Mono, Fira Code, Consolas, monospace",
        fontLigatures: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        readOnly: props.readOnly || false,
        tabSize: 2,
        insertSpaces: true,
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: true },
        guides: {
          bracketPairs: true,
          indentation: true,
        },
        find: {
          addExtraSpaceOnTop: false,
          autoFindInSelection: "never",
          seedSearchStringFromSelection: "single",
        },
        padding: { top: 0, bottom: 0 },
        fixedOverflowWidgets: false, // Allow widgets to overflow container
      });

      // Initialize current file name and initial value
      setCurrentFileName(props.fileName || "");
      setInitialValue(props.value);
      setIsDirty(false);

      // Listen for changes
      editor!.onDidChangeModelContent(() => {
        if (!editor || suppressOnChange) return;
        const newValue = editor.getValue();
        setIsDirty(newValue !== initialValue());
        props.onChange(newValue);
      });

      // Ctrl+S to save
      editor!.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (props.onSave && editor) {
          props.onSave();
          // After save, update initial value to mark as clean
          setInitialValue(editor.getValue());
          setIsDirty(false);
        }
      });

      // F11 or Ctrl+Shift+F for fullscreen
      editor!.addCommand(monaco.KeyCode.F11, () => {
        setIsFullscreen(!isFullscreen());
      });
      editor!.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, () => {
        setIsFullscreen(!isFullscreen());
      });

      // Register custom providers if provided
      if (props.completionProvider) {
        const provider = props.completionProvider(monaco);
        monaco.languages.registerCompletionItemProvider(
          monacoLanguage,
          provider
        );
      }

      if (props.hoverProvider) {
        const provider = props.hoverProvider(monaco);
        monaco.languages.registerHoverProvider(monacoLanguage, provider);
      }

      setIsReady(true);
    } catch (error) {
      console.error("Failed to initialize Monaco Editor:", error);
    }

    // Cleanup
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown);
      window.onerror = originalError; // Restore original error handler
      editor?.dispose();
    });
  });

  // Track fileName changes
  createEffect(() => {
    const newFileName = props.fileName || "";

    if (!editor || !isReady()) return;

    if (newFileName && newFileName !== currentFileName()) {
      setCurrentFileName(newFileName);
    }
  });

  // Update editor value when value changes
  createEffect(() => {
    const newValue = props.value;

    if (!editor || !isReady()) return;

    const currentValue = editor.getValue();

    if (newValue !== currentValue) {
      suppressOnChange = true;
      editor.setValue(newValue);
      suppressOnChange = false;

      setInitialValue(newValue);
      setIsDirty(false);

      // Reset cursor on content change
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.setScrollTop(0);
    }
  });

  // Update language when it changes
  createEffect(() => {
    const lang = props.language || "txt";

    if (!editor || !isReady()) return;

    const languageMap: Record<string, string> = {
      toml: "toml",
      json: "json",
      jsonc: "json", // JSON with Comments
      properties: "properties",
      yaml: "yaml",
      txt: "plaintext",
      javascript: "javascript",
      typescript: "typescript",
      java: "java",
      python: "python",
      rust: "rust",
      lua: "lua",
      shell: "shell",
      bat: "bat",
      gradle: "groovy",
      xml: "xml",
      html: "html",
      css: "css",
      markdown: "markdown",
      dockerfile: "dockerfile",
    };

    const monacoLanguage = languageMap[lang] || "plaintext";

    const model = editor.getModel();
    if (model) {
      loader.init().then((monaco: typeof Monaco) => {
        monaco.editor.setModelLanguage(model, monacoLanguage);
      });
    }
  });

  return (
    <div
      class="flex flex-col h-full"
      classList={{
        "fixed left-0 right-0 bottom-0 z-[99999] bg-gray-900": isFullscreen(),
      }}
      style={isFullscreen() ? {
        "top": "var(--titlebar-height)",
        "height": "calc(100vh - var(--titlebar-height))"
      } : {}}
    >
      {/* Toolbar */}
      <div
        class="flex items-center justify-between px-3 py-2 border-b border-gray-750 flex-shrink-0"
        classList={{
          "bg-gray-800/50": !isFullscreen(),
          "bg-gray-800 px-4 py-3": isFullscreen(),
        }}
      >
        <div class="flex items-center gap-2 text-sm text-muted">
          <Show when={props.fileName}>
            <i class="i-hugeicons-file-01 w-4 h-4" classList={{ "w-5 h-5 text-blue-400": isFullscreen() }} />
            <span classList={{ "font-medium": isFullscreen() }}>{props.fileName}</span>
            <Show when={isDirty()}>
              <span class="text-xs text-yellow-400" title="Не сохранено">●</span>
            </Show>
          </Show>
          <Show when={isFullscreen()}>
            <span class="text-muted">Полноэкранный режим</span>
          </Show>
        </div>
        <div class="flex gap-2">
          <Show when={isFullscreen() && props.onSave}>
            <button class="btn-primary btn-sm" onClick={() => props.onSave?.()}>
              <i class="i-hugeicons-floppy-disk w-4 h-4" />
              Сохранить (Ctrl+S)
            </button>
          </Show>
          <Show when={!isFullscreen()}>
            <button
              class="btn-ghost btn-sm"
              onClick={() => setIsFullscreen(true)}
              title="Полноэкранный режим (F11 или Ctrl+Shift+F)"
            >
              <i class="i-hugeicons-full-screen w-4 h-4" />
            </button>
          </Show>
          <Show when={isFullscreen()}>
            <button
              class="btn-secondary btn-sm"
              onClick={() => setIsFullscreen(false)}
              title="Выйти из полноэкранного режима (Esc)"
            >
              <i class="i-hugeicons-cancel-01 w-4 h-4" />
              Закрыть
            </button>
          </Show>
        </div>
      </div>

      {/* Editor */}
      <div class="flex-1 min-h-0 monaco-editor-container" style={{ "overflow": "visible" }}>
        <div
          ref={containerRef}
          class="h-full"
          style={{
            "border": isFullscreen() ? "none" : "1px solid #374151",
            "border-radius": isFullscreen() ? "0" : "0 0 0.5rem 0.5rem",
          }}
        />
      </div>
    </div>
  );
}
