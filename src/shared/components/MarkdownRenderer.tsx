import { createMemo, createSignal, createEffect, Show, onCleanup } from "solid-js";
import { marked } from "marked";
import DOMPurify, { Config as DOMPurifyConfig } from "dompurify";
import { highlightCode, detectLanguage } from "../utils/highlighter";

interface MarkdownRendererProps {
  content: string;
  class?: string;
}

// Configure DOMPurify to allow safe tags and attributes
const DOMPURIFY_CONFIG: DOMPurifyConfig = {
  ALLOWED_TAGS: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "a", "strong", "em", "b", "i", "u", "s", "del",
    "img", "table", "thead", "tbody", "tr", "th", "td",
    "div", "span", "details", "summary",
  ],
  ALLOWED_ATTR: [
    "href", "title", "alt", "src", "class", "id",
    "target", "rel", "width", "height", "style",
  ],
  // Force all links to open in new tab
  ADD_ATTR: ["target", "rel"],
};

// Hook to add security attributes to links
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  // Validate image src URLs
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") || "";
    if (!isValidImageUrl(src)) {
      node.removeAttribute("src");
      node.setAttribute("alt", "[Invalid image URL]");
    }
  }
});

/**
 * Validates that an image URL is safe to load.
 * Blocks javascript:, data:, and other dangerous protocols.
 */
function isValidImageUrl(url: string): boolean {
  if (!url) return false;

  try {
    const parsed = new URL(url, window.location.origin);
    const allowedProtocols = ["https:", "http:"];
    return allowedProtocols.includes(parsed.protocol);
  } catch {
    // Relative URLs are okay
    return url.startsWith("/") || url.startsWith("./");
  }
}

/**
 * Extract language from code block class (e.g., "language-typescript" -> "typescript")
 */
function extractLanguage(className: string | null): string | null {
  if (!className) return null;
  const match = className.match(/language-(\S+)/);
  return match ? match[1] : null;
}

/**
 * Find and highlight code blocks in HTML
 */
async function highlightCodeBlocks(html: string): Promise<string> {
  // Match <pre><code class="language-xxx">...</code></pre> patterns
  const codeBlockRegex = /<pre><code(?:\s+class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;
  const matches: { full: string; className: string | null; code: string; index: number }[] = [];

  let match;
  while ((match = codeBlockRegex.exec(html)) !== null) {
    matches.push({
      full: match[0],
      className: match[1] || null,
      code: match[2],
      index: match.index,
    });
  }

  if (matches.length === 0) return html;

  // Highlight all code blocks in parallel
  const highlighted = await Promise.all(
    matches.map(async (m) => {
      const langHint = extractLanguage(m.className);
      const lang = detectLanguage(undefined, langHint || undefined);
      // Decode HTML entities in code
      const decodedCode = decodeHtmlEntities(m.code);
      const highlightedHtml = await highlightCode(decodedCode, lang);
      return { ...m, highlighted: highlightedHtml };
    })
  );

  // Replace code blocks with highlighted versions (from end to start to preserve indices)
  let result = html;
  for (let i = highlighted.length - 1; i >= 0; i--) {
    const h = highlighted[i];
    result = result.slice(0, h.index) + h.highlighted + result.slice(h.index + h.full.length);
  }

  return result;
}

/**
 * Decode HTML entities (marked encodes special chars)
 */
function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

/**
 * Renders markdown content as HTML using the marked library.
 * All content is sanitized with DOMPurify to prevent XSS attacks.
 * Code blocks are highlighted with Shiki.
 */
export function MarkdownRenderer(props: MarkdownRendererProps) {
  const [highlightedHtml, setHighlightedHtml] = createSignal<string | null>(null);
  let cancelled = false;

  // Configure marked options
  marked.setOptions({
    gfm: true, // GitHub Flavored Markdown
    breaks: true, // Convert \n to <br>
  });

  // Initial HTML without syntax highlighting
  const initialHtml = createMemo(() => {
    if (!props.content) return "";

    try {
      // Parse markdown to HTML
      const rawHtml = marked.parse(props.content) as string;

      // Sanitize HTML to prevent XSS
      return DOMPurify.sanitize(rawHtml, DOMPURIFY_CONFIG) as string;
    } catch (error) {
      console.error("[MarkdownRenderer] Failed to parse markdown:", error);
      // Escape content for safety in fallback
      return DOMPurify.sanitize(`<pre>${props.content}</pre>`, DOMPURIFY_CONFIG) as string;
    }
  });

  // Highlight code blocks asynchronously
  createEffect(() => {
    const html = initialHtml();
    if (!html) {
      setHighlightedHtml(null);
      return;
    }

    cancelled = false;

    // Check if there are code blocks to highlight
    if (!html.includes("<pre><code")) {
      setHighlightedHtml(html);
      return;
    }

    // Highlight asynchronously
    highlightCodeBlocks(html).then((highlighted) => {
      if (!cancelled) {
        // Sanitize the highlighted HTML (Shiki output uses inline styles)
        const sanitized = DOMPurify.sanitize(highlighted, {
          ...DOMPURIFY_CONFIG,
          ALLOWED_TAGS: [...DOMPURIFY_CONFIG.ALLOWED_TAGS!, "pre", "code", "span"],
        }) as string;
        setHighlightedHtml(sanitized);
      }
    });
  });

  onCleanup(() => {
    cancelled = true;
  });

  const displayHtml = () => highlightedHtml() ?? initialHtml();

  return (
    <Show when={props.content} fallback={<div class="text-gray-500 italic">No content</div>}>
      <div
        class={`markdown-content ${props.class || ""}`}
        innerHTML={displayHtml()}
      />
    </Show>
  );
}

/**
 * Renders HTML content directly (for CurseForge which returns HTML).
 * All content is sanitized with DOMPurify to prevent XSS attacks.
 */
export function HtmlRenderer(props: { content: string; class?: string }) {
  const sanitizedHtml = createMemo(() => {
    if (!props.content) return "";

    // Sanitize HTML to prevent XSS
    return DOMPurify.sanitize(props.content, DOMPURIFY_CONFIG) as string;
  });

  return (
    <Show when={props.content} fallback={<div class="text-gray-500 italic">No content</div>}>
      <div
        class={`markdown-content ${props.class || ""}`}
        innerHTML={sanitizedHtml()}
      />
    </Show>
  );
}
