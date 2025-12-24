/**
 * Lightweight syntax highlighter for config files
 * Supports TOML, JSON, Properties, YAML
 */

export type Language = "toml" | "json" | "properties" | "yaml" | "txt";

interface HighlightToken {
  type: "keyword" | "string" | "number" | "boolean" | "comment" | "property" | "operator" | "bracket" | "text";
  value: string;
}

/**
 * Tokenize and highlight syntax for a given language
 */
export function highlightSyntax(code: string, language: Language): string {
  const tokens = tokenize(code, language);
  return tokens.map((token) => {
    const className = getTokenClass(token.type);
    return `<span class="${className}">${escapeHtml(token.value)}</span>`;
  }).join("");
}

function tokenize(code: string, language: Language): HighlightToken[] {
  switch (language) {
    case "json":
      return tokenizeJson(code);
    case "toml":
      return tokenizeToml(code);
    case "properties":
      return tokenizeProperties(code);
    case "yaml":
      return tokenizeYaml(code);
    default:
      return [{ type: "text", value: code }];
  }
}

function tokenizeJson(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const regex = /"(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\]:,]|\/\/.*|\/\*[\s\S]*?\*\//g;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(code)) !== null) {
    // Add whitespace before match
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: code.slice(lastIndex, match.index) });
    }

    const value = match[0];

    if (value.startsWith("//") || value.startsWith("/*")) {
      tokens.push({ type: "comment", value });
    } else if (value.startsWith('"')) {
      tokens.push({ type: "string", value });
    } else if (value === "true" || value === "false") {
      tokens.push({ type: "boolean", value });
    } else if (value === "null") {
      tokens.push({ type: "keyword", value });
    } else if (!isNaN(Number(value))) {
      tokens.push({ type: "number", value });
    } else if (/[{}[\]:,]/.test(value)) {
      tokens.push({ type: "bracket", value });
    } else {
      tokens.push({ type: "text", value });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < code.length) {
    tokens.push({ type: "text", value: code.slice(lastIndex) });
  }

  return tokens;
}

function tokenizeToml(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Comment
    if (line.trim().startsWith("#")) {
      tokens.push({ type: "comment", value: line });
    }
    // Section header
    else if (line.trim().match(/^\[.*\]$/)) {
      tokens.push({ type: "keyword", value: line });
    }
    // Key-value pair
    else if (line.includes("=")) {
      const [key, ...valueParts] = line.split("=");
      tokens.push({ type: "property", value: key });
      tokens.push({ type: "operator", value: "=" });

      const value = valueParts.join("=").trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        tokens.push({ type: "string", value });
      } else if (value === "true" || value === "false") {
        tokens.push({ type: "boolean", value });
      } else if (!isNaN(Number(value))) {
        tokens.push({ type: "number", value });
      } else {
        tokens.push({ type: "text", value });
      }
    } else {
      tokens.push({ type: "text", value: line });
    }

    if (i < lines.length - 1) {
      tokens.push({ type: "text", value: "\n" });
    }
  }

  return tokens;
}

function tokenizeProperties(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Comment
    if (line.trim().startsWith("#") || line.trim().startsWith("!")) {
      tokens.push({ type: "comment", value: line });
    }
    // Key-value pair
    else if (line.includes("=") || line.includes(":")) {
      const separator = line.includes("=") ? "=" : ":";
      const [key, ...valueParts] = line.split(separator);
      tokens.push({ type: "property", value: key });
      tokens.push({ type: "operator", value: separator });
      tokens.push({ type: "text", value: valueParts.join(separator) });
    } else {
      tokens.push({ type: "text", value: line });
    }

    if (i < lines.length - 1) {
      tokens.push({ type: "text", value: "\n" });
    }
  }

  return tokens;
}

function tokenizeYaml(code: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Comment
    if (line.trim().startsWith("#")) {
      tokens.push({ type: "comment", value: line });
    }
    // Key-value pair
    else if (line.includes(":")) {
      const [key, ...valueParts] = line.split(":");
      tokens.push({ type: "property", value: key });
      tokens.push({ type: "operator", value: ":" });

      const value = valueParts.join(":").trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        tokens.push({ type: "string", value });
      } else if (value === "true" || value === "false" || value === "yes" || value === "no") {
        tokens.push({ type: "boolean", value });
      } else if (!isNaN(Number(value))) {
        tokens.push({ type: "number", value });
      } else {
        tokens.push({ type: "text", value });
      }
    } else {
      tokens.push({ type: "text", value: line });
    }

    if (i < lines.length - 1) {
      tokens.push({ type: "text", value: "\n" });
    }
  }

  return tokens;
}

function getTokenClass(type: HighlightToken["type"]): string {
  switch (type) {
    case "keyword":
      return "text-blue-400";
    case "string":
      return "text-green-400";
    case "number":
      return "text-orange-400";
    case "boolean":
      return "text-purple-400";
    case "comment":
      return "text-gray-500 italic";
    case "property":
      return "text-cyan-400";
    case "operator":
      return "text-gray-400";
    case "bracket":
      return "text-yellow-400";
    default:
      return "text-gray-300";
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
