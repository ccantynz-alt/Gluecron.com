/**
 * Markdown rendering — server-side, sanitized.
 */

import { Marked } from "marked";
import { highlightCode } from "./highlight";

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      if (lang) {
        const { html } = highlightCode(text, `code.${lang}`);
        return `<pre><code class="language-${escapeAttr(lang)}">${html}</code></pre>`;
      }
      return `<pre><code>${escapeHtml(text)}</code></pre>`;
    },
    link({ href, title, text }) {
      // Sanitize: only allow http(s) and relative links
      const safeHref =
        href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("/") ||
        href.startsWith("#") ||
        href.startsWith(".")
          ? href
          : "#";
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${escapeAttr(safeHref)}"${titleAttr}>${text}</a>`;
    },
    image({ href, title, text }) {
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<img src="${escapeAttr(href)}" alt="${escapeAttr(text)}"${titleAttr} style="max-width: 100%;" loading="lazy" />`;
    },
  },
});

export function renderMarkdown(source: string): string {
  const html = marked.parse(source);
  if (typeof html !== "string") return "";
  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const markdownCss = `
  .markdown-body {
    font-size: 15px;
    line-height: 1.7;
    word-wrap: break-word;
    padding: 20px;
  }
  .markdown-body h1, .markdown-body h2, .markdown-body h3,
  .markdown-body h4, .markdown-body h5, .markdown-body h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .markdown-body h1 { font-size: 2em; }
  .markdown-body h2 { font-size: 1.5em; }
  .markdown-body h3 { font-size: 1.25em; border-bottom: none; }
  .markdown-body h4 { font-size: 1em; border-bottom: none; }
  .markdown-body p { margin-bottom: 16px; }
  .markdown-body ul, .markdown-body ol { padding-left: 2em; margin-bottom: 16px; }
  .markdown-body li { margin-bottom: 4px; }
  .markdown-body code {
    font-family: var(--font-mono);
    font-size: 85%;
    padding: 2px 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
  }
  .markdown-body pre {
    padding: 16px;
    overflow-x: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
    line-height: 1.5;
  }
  .markdown-body pre code {
    padding: 0;
    background: transparent;
    font-size: 13px;
  }
  .markdown-body blockquote {
    padding: 0 1em;
    color: var(--text-muted);
    border-left: 3px solid var(--border);
    margin-bottom: 16px;
  }
  .markdown-body table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
  }
  .markdown-body table th, .markdown-body table td {
    padding: 8px 16px;
    border: 1px solid var(--border);
    text-align: left;
  }
  .markdown-body table th { background: var(--bg-secondary); font-weight: 600; }
  .markdown-body hr {
    height: 2px;
    background: var(--border);
    border: none;
    margin: 24px 0;
  }
  .markdown-body a { color: var(--text-link); }
  .markdown-body img { max-width: 100%; border-radius: var(--radius); }
  .markdown-body .task-list-item { list-style: none; }
  .markdown-body .task-list-item input { margin-right: 8px; }
`;
