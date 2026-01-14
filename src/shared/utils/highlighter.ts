/**
 * Syntax highlighting using highlight.js
 * Simple, reliable, no WASM/async issues
 */
import hljs from "highlight.js/lib/core";

// GitHub Dark theme
import "highlight.js/styles/github-dark.css";

// Import only the languages we need
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import php from "highlight.js/lib/languages/php";
import markdown from "highlight.js/lib/languages/markdown";

// Register languages
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("properties", ini);
hljs.registerLanguage("toml", ini); // TOML is similar enough to INI
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("zsh", bash);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("ps1", powershell);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("java", java);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("php", php);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);

// Language mapping from file extension to highlight.js language
export const LANG_MAP: Record<string, string> = {
  // Web
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  json: "json",
  json5: "json",
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
  xml: "xml",

  // Docs
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",

  // Shell
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  ps1: "powershell",
  powershell: "powershell",

  // Other
  sql: "sql",
  java: "java",
  py: "python",
  python: "python",
  php: "php",

  // Minecraft specific
  mcfunction: "bash",
  zs: "javascript", // ZenScript (CraftTweaker)
};

/**
 * Check if highlighter is ready (always true for highlight.js)
 */
export function isHighlighterReady(): boolean {
  return true;
}

/**
 * Get last initialization error (always null for highlight.js)
 */
export function getLastError(): Error | null {
  return null;
}

/**
 * Reset highlighter (no-op for highlight.js)
 */
export function resetHighlighter(): void {
  // No-op - highlight.js is synchronous and stateless
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
    // Check if it's a registered language
    if (hljs.getLanguage(normalized)) {
      return normalized;
    }
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
 * Highlight code synchronously (returns immediately, no async needed)
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  try {
    let result: string;

    if (lang === "text" || !hljs.getLanguage(lang)) {
      // Plain text - just escape HTML
      result = escapeHtml(code);
    } else {
      // Highlight with specified language
      result = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }

    // Wrap in pre/code with line formatting (hljs class for theme styling)
    // Each .line is display: block, so no need for \n separator
    const lines = result.split("\n").map((line) =>
      `<span class="line">${line || " "}</span>`
    ).join("");

    return `<pre class="hljs"><code>${lines}</code></pre>`;
  } catch {
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
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
