/**
 * Syntax highlighting via highlight.js — server-side.
 * Returns pre-highlighted HTML strings for code display.
 */

import hljs from "highlight.js";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  lua: "lua",
  r: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  clj: "clojure",
  vim: "vim",
  tf: "hcl",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
};

export function highlightCode(
  code: string,
  filename: string
): { html: string; language: string | null } {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const lang = EXT_TO_LANG[ext];

  if (lang) {
    try {
      const result = hljs.highlight(code, { language: lang });
      return { html: result.value, language: lang };
    } catch {
      // fallback to auto-detect
    }
  }

  // Try auto-detection for unknown extensions
  try {
    const result = hljs.highlightAuto(code);
    if (result.language && result.relevance > 5) {
      return { html: result.value, language: result.language };
    }
  } catch {
    // fallback to plain
  }

  return { html: escapeHtml(code), language: null };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const hljsThemeCss = `
  .hljs-keyword { color: #ff7b72; }
  .hljs-built_in { color: #ffa657; }
  .hljs-type { color: #ffa657; }
  .hljs-literal { color: #79c0ff; }
  .hljs-number { color: #79c0ff; }
  .hljs-string { color: #a5d6ff; }
  .hljs-regexp { color: #a5d6ff; }
  .hljs-symbol { color: #79c0ff; }
  .hljs-title { color: #d2a8ff; }
  .hljs-title.function_ { color: #d2a8ff; }
  .hljs-title.class_ { color: #ffa657; }
  .hljs-params { color: #e6edf3; }
  .hljs-comment { color: #8b949e; font-style: italic; }
  .hljs-doctag { color: #8b949e; }
  .hljs-meta { color: #79c0ff; }
  .hljs-attr { color: #79c0ff; }
  .hljs-attribute { color: #79c0ff; }
  .hljs-selector-tag { color: #ff7b72; }
  .hljs-selector-class { color: #d2a8ff; }
  .hljs-selector-id { color: #79c0ff; }
  .hljs-variable { color: #ffa657; }
  .hljs-template-variable { color: #ffa657; }
  .hljs-tag { color: #7ee787; }
  .hljs-name { color: #7ee787; }
  .hljs-section { color: #d2a8ff; font-weight: bold; }
  .hljs-addition { color: #aff5b4; background: rgba(63, 185, 80, 0.15); }
  .hljs-deletion { color: #ffdcd7; background: rgba(248, 81, 73, 0.1); }
  .hljs-property { color: #79c0ff; }
  .hljs-subst { color: #e6edf3; }
  .hljs-punctuation { color: #8b949e; }
`;
