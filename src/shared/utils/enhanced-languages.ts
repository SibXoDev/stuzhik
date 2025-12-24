/**
 * Enhanced syntax highlighting for Monaco Editor
 * VSCode-quality highlighting without external dependencies
 */

import type * as Monaco from "monaco-editor";

/**
 * Register enhanced Monarch tokenizers for all supported languages
 * Based on official VSCode language extensions
 */
export function registerEnhancedLanguages(monaco: typeof Monaco): void {
  // Enhanced TOML tokenizer (from better-toml VSCode extension)
  monaco.languages.setMonarchTokensProvider("toml", {
    defaultToken: "",
    tokenPostfix: ".toml",

    keywords: ["true", "false"],

    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
      root: [
        // Whitespace
        { include: "@whitespace" },

        // Table headers [[array.of.tables]] or [table]
        [/^\s*\[\[.*\]\]/, "type.identifier"],
        [/^\s*\[.*\]/, "type"],

        // Keys
        [/[a-zA-Z_][\w-]*(?=\s*=)/, "variable.name"],
        [/"[^"]*"(?=\s*=)/, "variable.name"],
        [/'[^']*'(?=\s*=)/, "variable.name"],

        // Values
        [/=/, "operator"],

        // Dates and times
        [
          /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/,
          "number.float",
        ],
        [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, "number.float"],

        // Numbers
        [/[+-]?(?:inf|nan)\b/, "number.float"],
        [/[+-]?0x[0-9a-fA-F_]+/, "number.hex"],
        [/[+-]?0o[0-7_]+/, "number.oct"],
        [/[+-]?0b[01_]+/, "number.bin"],
        [/[+-]?(?:\d+_)*\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],

        // Booleans
        [/\b(?:true|false)\b/, "keyword"],

        // Strings
        [/"""/, "string", "@multiLineString"],
        [/'''/, "string", "@multiLineLiteralString"],
        [/"/, "string", "@string"],
        [/'/, "string", "@literalString"],
      ],

      whitespace: [[/[ \t\r\n]+/, ""], [/#.*$/, "comment"]],

      string: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],

      literalString: [
        [/[^']+/, "string"],
        [/'/, "string", "@pop"],
      ],

      multiLineString: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"""/, "string", "@pop"],
      ],

      multiLineLiteralString: [
        [/[^']+/, "string"],
        [/'''/, "string", "@pop"],
      ],
    },
  });

  // Enhanced Properties tokenizer
  monaco.languages.setMonarchTokensProvider("properties", {
    tokenizer: {
      root: [
        [/^\s*[#!].*$/, "comment"],
        [/^\s*$/, ""],
        [/[a-zA-Z_][\w.-]*(?=\s*[=:])/, "variable.name"],
        [/[=:]/, "operator"],
        [/\\[nrtf\\]/, "string.escape"],
        [/[^\r\n]+/, "string"],
      ],
    },
  });

  // Language configurations for better editing experience
  monaco.languages.setLanguageConfiguration("toml", {
    comments: { lineComment: "#" },
    brackets: [
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setLanguageConfiguration("properties", {
    comments: { lineComment: "#" },
    wordPattern: /[a-zA-Z_][\w.-]*/,
  });

  // Enhanced JavaScript tokenizer
  monaco.languages.setMonarchTokensProvider("javascript", {
    defaultToken: "",
    tokenPostfix: ".js",

    keywords: [
      "break", "case", "catch", "class", "continue", "const",
      "constructor", "debugger", "default", "delete", "do", "else",
      "export", "extends", "false", "finally", "for", "from", "function",
      "get", "if", "import", "in", "instanceof", "let", "new", "null",
      "return", "set", "static", "super", "switch", "this", "throw",
      "true", "try", "typeof", "var", "void", "while", "with", "yield",
      "async", "await", "of",
    ],

    typeKeywords: [
      "any", "boolean", "number", "object", "string", "undefined",
    ],

    operators: [
      "<=", ">=", "==", "!=", "===", "!==", "=>", "+", "-", "**",
      "*", "/", "%", "++", "--", "<<", "</", ">>", ">>>", "&",
      "|", "^", "!", "~", "&&", "||", "??", "?", ":", "=",
      "+=", "-=", "*=", "**=", "/=", "%=", "<<=", ">>=", ">>>=",
      "&=", "|=", "^=", "@",
    ],

    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    digits: /\d+(_+\d+)*/,
    octaldigits: /[0-7]+(_+[0-7]+)*/,
    binarydigits: /[0-1]+(_+[0-1]+)*/,
    hexdigits: /[[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,

    regexpctl: /[(){}\[\]\$\^|\-*+?\.]/,
    regexpesc: /\\(?:[bBdDfnrstvwWn0\\\/]|@regexpctl|c[A-Z]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/,

    tokenizer: {
      root: [[/[{}]/, "delimiter.bracket"], { include: "common" }],

      common: [
        // Identifiers and keywords
        [
          /[a-z_$][\w$]*/,
          {
            cases: {
              "@typeKeywords": "keyword.type",
              "@keywords": "keyword",
              "@default": "identifier",
            },
          },
        ],
        [/[A-Z][\w\$]*/, "type.identifier"],

        // Whitespace
        { include: "@whitespace" },

        // Regular expression
        [/\/(?=([^\\\/]|\\.)+\/([gimsuy]*)(\s*)(\.|;|,|\)|\]|\}|$))/, { token: "regexp", bracket: "@open", next: "@regexp" }],

        // Delimiters and operators
        [/[()\[\]]/, "@brackets"],
        [/[<>](?!@symbols)/, "@brackets"],
        [/!(?=([^=]|$))/, "delimiter"],
        [
          /@symbols/,
          {
            cases: {
              "@operators": "delimiter",
              "@default": "",
            },
          },
        ],

        // Numbers
        [/(@digits)[eE]([\-+]?(@digits))?/, "number.float"],
        [/(@digits)\.(@digits)([eE][\-+]?(@digits))?/, "number.float"],
        [/0[xX](@hexdigits)n?/, "number.hex"],
        [/0[oO]?(@octaldigits)n?/, "number.octal"],
        [/0[bB](@binarydigits)n?/, "number.binary"],
        [/(@digits)n?/, "number"],

        // Delimiter: after number because of .\d floats
        [/[;,.]/, "delimiter"],

        // Strings
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string_double"],
        [/'/, "string", "@string_single"],
        [/`/, "string", "@string_backtick"],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*\*(?!\/)/, "comment.doc", "@jsdoc"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],

      comment: [
        [/[^\/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[\/*]/, "comment"],
      ],

      jsdoc: [
        [/[^\/*]+/, "comment.doc"],
        [/\*\//, "comment.doc", "@pop"],
        [/[\/*]/, "comment.doc"],
      ],

      // String tokenizers
      string_double: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],

      string_single: [
        [/[^\\']+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/'/, "string", "@pop"],
      ],

      string_backtick: [
        [/\$\{/, { token: "delimiter.bracket", next: "@bracketCounting" }],
        [/[^\\`$]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/`/, "string", "@pop"],
      ],

      bracketCounting: [
        [/\{/, "delimiter.bracket", "@bracketCounting"],
        [/\}/, "delimiter.bracket", "@pop"],
        { include: "common" },
      ],

      regexp: [
        [/(\{)(\d+(?:,\d*)?)(\})/, ["regexp.escape.control", "regexp.escape.control", "regexp.escape.control"]],
        [/(\[)(\^?)(?=(?:[^\]\\\/]|\\.)+)/, ["regexp.escape.control", { token: "regexp.escape.control", next: "@regexrange" }]],
        [/(\()(\?:|\?=|\?!)/, ["regexp.escape.control", "regexp.escape.control"]],
        [/[()]/, "regexp.escape.control"],
        [/@regexpctl/, "regexp.escape.control"],
        [/[^\\\/]/, "regexp"],
        [/@regexpesc/, "regexp.escape"],
        [/\\\./, "regexp.invalid"],
        [/(\/)([gimsuy]*)/, [{ token: "regexp", bracket: "@close", next: "@pop" }, "keyword.other"]],
      ],

      regexrange: [
        [/-/, "regexp.escape.control"],
        [/\^/, "regexp.invalid"],
        [/@regexpesc/, "regexp.escape"],
        [/[^\]]/, "regexp"],
        [/\]/, { token: "regexp.escape.control", next: "@pop", bracket: "@close" }],
      ],
    },
  });

  // Enhanced TypeScript tokenizer (extends JavaScript)
  monaco.languages.setMonarchTokensProvider("typescript", {
    defaultToken: "",
    tokenPostfix: ".ts",

    keywords: [
      "abstract", "any", "as", "asserts", "bigint", "boolean", "break", "case",
      "catch", "class", "continue", "const", "constructor", "debugger",
      "declare", "default", "delete", "do", "else", "enum", "export",
      "extends", "false", "finally", "for", "from", "function", "get",
      "if", "implements", "import", "in", "infer", "instanceof", "interface",
      "is", "keyof", "let", "module", "namespace", "never", "new", "null",
      "number", "object", "package", "private", "protected", "public",
      "readonly", "require", "global", "return", "set", "static", "string",
      "super", "switch", "symbol", "this", "throw", "true", "try", "type",
      "typeof", "undefined", "unique", "unknown", "var", "void", "while",
      "with", "yield", "async", "await", "of",
    ],

    operators: [
      "<=", ">=", "==", "!=", "===", "!==", "=>", "+", "-", "**",
      "*", "/", "%", "++", "--", "<<", "</", ">>", ">>>", "&",
      "|", "^", "!", "~", "&&", "||", "??", "?", ":", "=",
      "+=", "-=", "*=", "**=", "/=", "%=", "<<=", ">>=", ">>>=",
      "&=", "|=", "^=", "@",
    ],

    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
      root: [[/[{}]/, "delimiter.bracket"], { include: "common" }],

      common: [
        [
          /[a-z_$][\w$]*/,
          {
            cases: {
              "@keywords": "keyword",
              "@default": "identifier",
            },
          },
        ],
        [/[A-Z][\w\$]*/, "type.identifier"],
        { include: "@whitespace" },
        [/\/(?=([^\\\/]|\\.)+\/([gimsuy]*)(\s*)(\.|;|,|\)|\]|\}|$))/, { token: "regexp", bracket: "@open", next: "@regexp" }],
        [/[()\[\]]/, "@brackets"],
        [/[<>](?!@symbols)/, "@brackets"],
        [
          /@symbols/,
          {
            cases: {
              "@operators": "delimiter",
              "@default": "",
            },
          },
        ],
        [/\d*\.\d+([eE][\-+]?\d+)?/, "number.float"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],
        [/\d+/, "number"],
        [/[;,.]/, "delimiter"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@string_double"],
        [/'/, "string", "@string_single"],
        [/`/, "string", "@string_backtick"],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*\*(?!\/)/, "comment.doc", "@jsdoc"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],

      comment: [[/[^\/*]+/, "comment"], [/\*\//, "comment", "@pop"], [/[\/*]/, "comment"]],
      jsdoc: [[/[^\/*]+/, "comment.doc"], [/\*\//, "comment.doc", "@pop"], [/[\/*]/, "comment.doc"]],

      string_double: [[/[^\\"]+/, "string"], [/@escapes/, "string.escape"], [/\\./, "string.escape.invalid"], [/"/, "string", "@pop"]],
      string_single: [[/[^\\']+/, "string"], [/@escapes/, "string.escape"], [/\\./, "string.escape.invalid"], [/'/, "string", "@pop"]],
      string_backtick: [
        [/\$\{/, { token: "delimiter.bracket", next: "@bracketCounting" }],
        [/[^\\`$]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/`/, "string", "@pop"],
      ],

      bracketCounting: [[/\{/, "delimiter.bracket", "@bracketCounting"], [/\}/, "delimiter.bracket", "@pop"], { include: "common" }],

      regexp: [
        [/(\{)(\d+(?:,\d*)?)(\})/, ["regexp.escape.control", "regexp.escape.control", "regexp.escape.control"]],
        [/(\[)(\^?)(?=(?:[^\]\\\/]|\\.)+)/, ["regexp.escape.control", { token: "regexp.escape.control", next: "@regexrange" }]],
        [/(\()(\?:|\?=|\?!)/, ["regexp.escape.control", "regexp.escape.control"]],
        [/[()]/, "regexp.escape.control"],
        [/[^\\\/]/, "regexp"],
        [/\\\./, "regexp.escape"],
        [/(\/)([gimsuy]*)/, [{ token: "regexp", bracket: "@close", next: "@pop" }, "keyword.other"]],
      ],

      regexrange: [
        [/-/, "regexp.escape.control"],
        [/\^/, "regexp.invalid"],
        [/[^\]]/, "regexp"],
        [/\]/, { token: "regexp.escape.control", next: "@pop", bracket: "@close" }],
      ],
    },
  });

  console.log("[Monaco] Enhanced Monarch tokenizers registered (TOML, Properties, JavaScript, TypeScript)");
}
