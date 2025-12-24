/**
 * Shared Shiki highlighter singleton for syntax highlighting
 */
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";

// Language mapping from file extension or language name to Shiki language
export const LANG_MAP: Record<string, BundledLanguage> = {
  // Web
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  json: "json",
  json5: "json5",
  css: "css",
  scss: "scss",
  html: "html",

  // Rust
  rs: "rust",
  rust: "rust",

  // Config
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  ini: "ini",
  properties: "ini",
  cfg: "ini",

  // Docs
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",

  // Shell
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  ps1: "powershell",
  powershell: "powershell",

  // Minecraft specific
  mcfunction: "bash",
  zs: "javascript", // ZenScript (CraftTweaker)
};

// Supported languages to preload
const PRELOAD_LANGUAGES: BundledLanguage[] = [
  "typescript",
  "tsx",
  "javascript",
  "rust",
  "json",
  "toml",
  "yaml",
  "markdown",
  "css",
  "bash",
  "html",
];

// Singleton highlighter instance
let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Get the shared Shiki highlighter instance
 */
export async function getHighlighter(): Promise<Highlighter> {
  if (highlighterInstance) return highlighterInstance;

  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark-default"],
      langs: PRELOAD_LANGUAGES,
    }).then((h) => {
      highlighterInstance = h;
      return h;
    });
  }

  return highlighterPromise;
}

/**
 * Detect language from filename or language hint
 */
export function detectLanguage(filename?: string, langHint?: string): string {
  // Try language hint first
  if (langHint) {
    const normalized = langHint.toLowerCase();
    if (normalized in LANG_MAP) {
      return LANG_MAP[normalized];
    }
    // Return as-is if it looks like a valid Shiki language
    return normalized;
  }

  // Try filename extension
  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext && ext in LANG_MAP) {
      return LANG_MAP[ext];
    }
  }

  return "text";
}

/**
 * Highlight code with Shiki
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  try {
    const highlighter = await getHighlighter();
    const loadedLangs = highlighter.getLoadedLanguages() as string[];

    // Load language if not already loaded
    if (!loadedLangs.includes(lang) && lang !== "text") {
      try {
        await highlighter.loadLanguage(lang as BundledLanguage);
      } catch {
        console.warn(`Language ${lang} not available, falling back to text`);
        lang = "text";
      }
    }

    return highlighter.codeToHtml(code, {
      lang: highlighter.getLoadedLanguages().includes(lang) ? lang : "text",
      theme: "github-dark-default",
    });
  } catch (e) {
    console.error("Failed to highlight code:", e);
    // Fallback to escaped plain text
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
