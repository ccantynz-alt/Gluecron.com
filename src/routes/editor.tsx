/**
 * Web file editor — create and edit files directly in the browser.
 *
 * 2026 polish: this surface uses a scoped `.editor-*` class system that
 * mirrors `admin-integrations.tsx` and `collaborators.tsx` — gradient
 * hairline, mono breadcrumb pill, commit-message input with focus ring,
 * primary commit + ghost cancel buttons, and an AI "Suggest" button that
 * sits inline. The git operations themselves are unchanged.
 *
 * CodeMirror 6 enhancement: The plain textarea is replaced with a
 * CodeMirror 6 editor loaded from CDN (esm.sh). The textarea is kept
 * hidden and synced on every change so the existing form POST works
 * without server changes. Language is auto-detected from the file extension.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { EmptyState } from "../views/ui";
import {
  getBlob,
  getRepoPath,
} from "../git/repository";
import { generateCommitMessage } from "../lib/ai-generators";
import { isAiAvailable } from "../lib/ai-client";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { audit } from "../lib/notify";
import { AI_AUDIT_ACTIONS } from "../lib/ai-hours-saved";

const editor = new Hono<AuthEnv>();

editor.use("*", softAuth);

/**
 * Inline JS for the editor's "Suggest with AI" commit-message button.
 * Picks up the textarea content + form-pinned ref/filePath, POSTs JSON
 * to the suggest endpoint, fills the message Input on success.
 *
 * Built as a string so we don't need a bundler. JSON-escapes against
 * </script> breakout. Defensive DOM lookups (silent no-op on absence).
 */
function AI_COMMIT_MSG_SCRIPT(args: {
  endpoint: string;
  ref: string;
  filePath: string;
}): string {
  const safe = (v: string) =>
    JSON.stringify(v)
      .split("<").join("\\u003C")
      .split(">").join("\\u003E")
      .split("&").join("\\u0026");
  const url = safe(args.endpoint);
  const ref = safe(args.ref);
  const filePath = safe(args.filePath);
  return (
    "(function(){try{" +
    "var btn=document.getElementById('ai-commit-msg-btn');" +
    "var status=document.getElementById('ai-commit-msg-status');" +
    "var input=document.getElementById('commit-message-input');" +
    "var ta=document.querySelector('textarea[name=\"content\"]');" +
    "if(!btn||!input||!ta)return;" +
    "btn.addEventListener('click',function(ev){ev.preventDefault();" +
    "btn.disabled=true;if(status)status.textContent='Drafting (10-30s)...';" +
    "var fd='ref='+encodeURIComponent(" + ref + ")+'&filePath='+encodeURIComponent(" + filePath + ")+'&content='+encodeURIComponent(ta.value||'');" +
    "fetch(" + url + ",{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:fd,credentials:'same-origin'})" +
    ".then(function(r){return r.json().catch(function(){return {ok:false,error:'Server error.'};});})" +
    ".then(function(j){btn.disabled=false;" +
    "if(j&&j.ok&&typeof j.message==='string'){" +
    "if(input.value&&input.value.trim().length>0){if(!confirm('Replace existing message?')){if(status)status.textContent='Cancelled.';return;}}" +
    "input.value=j.message;if(status)status.textContent='Filled from AI. Edit before committing.';" +
    "}else{if(status)status.textContent=(j&&j.error)||'AI unavailable.';}" +
    "}).catch(function(){btn.disabled=false;if(status)status.textContent='Network error.';});" +
    "});" +
    "}catch(e){}})();"
  );
}

/**
 * Detect a language identifier from a file path/name for CodeMirror.
 * Returns a string like "typescript", "python", "markdown", etc.
 * Used server-side to embed a data-lang attribute.
 */
function detectEditorLang(filePath: string): string {
  const lower = filePath.toLowerCase();
  const ext = lower.split(".").pop() || "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "md":
    case "mdx":
      return "markdown";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "sql":
      return "sql";
    case "xml":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hh":
    case "hpp":
      return "cpp";
    default:
      return "plaintext";
  }
}

/**
 * CodeMirror 6 initialization script — loaded from esm.sh CDN.
 * Mounts a CodeMirror editor in place of the hidden textarea.
 * Syncs on every change so the form POST continues to work.
 * The textareaId identifies the hidden textarea to sync to.
 * The lang attribute controls language detection + dynamic import.
 */
function CODEMIRROR_INIT_SCRIPT(args: {
  textareaId: string;
  wrapperId: string;
  lang: string;
}): string {
  const safe = (v: string) =>
    JSON.stringify(v)
      .split("<").join("\\u003C")
      .split(">").join("\\u003E")
      .split("&").join("\\u0026");
  const textareaId = safe(args.textareaId);
  const wrapperId = safe(args.wrapperId);
  const lang = safe(args.lang);

  return `
(async function() {
  try {
    var ta = document.getElementById(${textareaId});
    var wrapper = document.getElementById(${wrapperId});
    if (!ta || !wrapper) return;

    // Load CodeMirror 6 core from esm.sh
    var [cmView, cmState, cmCommands, cmLanguage, cmTheme] = await Promise.all([
      import('https://esm.sh/@codemirror/view@6'),
      import('https://esm.sh/@codemirror/state@6'),
      import('https://esm.sh/@codemirror/commands@6'),
      import('https://esm.sh/@codemirror/language@6'),
      import('https://esm.sh/@codemirror/theme-one-dark@6')
    ]);

    var { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } = cmView;
    var { EditorState, Compartment } = cmState;
    var { defaultKeymap, indentWithTab, historyKeymap, history } = cmCommands;
    var { indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter } = cmLanguage;
    var { oneDark } = cmTheme;

    // Dynamically load language support
    var langExtension = [];
    try {
      var langStr = ${lang};
      if (langStr === 'typescript' || langStr === 'javascript') {
        var jsLang = await import('https://esm.sh/@codemirror/lang-javascript@6');
        langExtension = [jsLang.javascript({ typescript: langStr === 'typescript', jsx: true })];
      } else if (langStr === 'python') {
        var pyLang = await import('https://esm.sh/@codemirror/lang-python@6');
        langExtension = [pyLang.python()];
      } else if (langStr === 'markdown') {
        var mdLang = await import('https://esm.sh/@codemirror/lang-markdown@6');
        langExtension = [mdLang.markdown()];
      } else if (langStr === 'json') {
        var jsonLang = await import('https://esm.sh/@codemirror/lang-json@6');
        langExtension = [jsonLang.json()];
      } else if (langStr === 'css') {
        var cssLang = await import('https://esm.sh/@codemirror/lang-css@6');
        langExtension = [cssLang.css()];
      } else if (langStr === 'html') {
        var htmlLang = await import('https://esm.sh/@codemirror/lang-html@6');
        langExtension = [htmlLang.html()];
      } else if (langStr === 'shell') {
        var { StreamLanguage } = cmLanguage;
        var shellLang = await import('https://esm.sh/@codemirror/legacy-modes@6/src/shell');
        langExtension = [StreamLanguage.define(shellLang.shell)];
      } else if (langStr === 'sql') {
        var sqlLang = await import('https://esm.sh/@codemirror/lang-sql@6');
        langExtension = [sqlLang.sql()];
      } else if (langStr === 'rust') {
        var rsLang = await import('https://esm.sh/@codemirror/lang-rust@6');
        langExtension = [rsLang.rust()];
      } else if (langStr === 'cpp' || langStr === 'c') {
        var cppLang = await import('https://esm.sh/@codemirror/lang-cpp@6');
        langExtension = [cppLang.cpp()];
      } else if (langStr === 'java') {
        var javaLang = await import('https://esm.sh/@codemirror/lang-java@6');
        langExtension = [javaLang.java()];
      } else if (langStr === 'xml') {
        var xmlLang = await import('https://esm.sh/@codemirror/lang-xml@6');
        langExtension = [xmlLang.xml()];
      } else if (langStr === 'yaml') {
        var { StreamLanguage } = cmLanguage;
        var yamlLang = await import('https://esm.sh/@codemirror/legacy-modes@6/src/yaml');
        langExtension = [StreamLanguage.define(yamlLang.yaml)];
      } else if (langStr === 'go') {
        var { StreamLanguage } = cmLanguage;
        var goLang = await import('https://esm.sh/@codemirror/legacy-modes@6/src/go');
        langExtension = [StreamLanguage.define(goLang.go)];
      } else if (langStr === 'ruby') {
        var { StreamLanguage } = cmLanguage;
        var rubyLang = await import('https://esm.sh/@codemirror/legacy-modes@6/src/ruby');
        langExtension = [StreamLanguage.define(rubyLang.ruby)];
      } else if (langStr === 'php') {
        var phpLang = await import('https://esm.sh/@codemirror/lang-php@6');
        langExtension = [phpLang.php()];
      }
    } catch(e) {
      // language load failure is non-fatal — continue without highlighting
      langExtension = [];
    }

    var initialContent = ta.value;

    var updateListener = EditorView.updateListener.of(function(update) {
      if (update.docChanged) {
        ta.value = update.state.doc.toString();
      }
    });

    var editorTheme = EditorView.theme({
      '&': {
        background: 'var(--bg)',
        color: 'var(--text)',
        border: '1px solid var(--border-strong)',
        borderRadius: '10px',
        minHeight: '280px',
        fontSize: '13px',
        lineHeight: '1.55',
        fontFamily: 'var(--font-mono)',
      },
      '.cm-content': {
        padding: '12px 14px',
        caretColor: '#a48bff',
      },
      '.cm-focused': {
        outline: 'none',
      },
      '&.cm-focused': {
        borderColor: 'rgba(140,109,255,0.55)',
        boxShadow: '0 0 0 3px rgba(140,109,255,0.18)',
      },
      '.cm-gutters': {
        background: 'rgba(255,255,255,0.02)',
        borderRight: '1px solid var(--border)',
        color: 'var(--text-faint)',
        paddingRight: '4px',
      },
      '.cm-activeLineGutter': {
        background: 'rgba(140,109,255,0.08)',
      },
      '.cm-activeLine': {
        background: 'rgba(140,109,255,0.06)',
      },
      '.cm-scroller': {
        overflow: 'auto',
        minHeight: '280px',
        maxHeight: '70vh',
      },
      '.cm-cursor': {
        borderLeftColor: '#a48bff',
      },
    });

    var state = EditorState.create({
      doc: initialContent,
      extensions: [
        history(),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSpecialChars(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        foldGutter(),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        oneDark,
        editorTheme,
        updateListener,
        ...langExtension,
        EditorView.lineWrapping,
      ],
    });

    var view = new EditorView({
      state: state,
      parent: wrapper,
    });

    // Hide the textarea now that CM is mounted
    ta.style.display = 'none';
    wrapper.style.display = 'block';

    // Sync on form submit (belt-and-suspenders)
    var form = ta.closest('form');
    if (form) {
      form.addEventListener('submit', function() {
        ta.value = view.state.doc.toString();
      });
    }

  } catch(e) {
    // If CodeMirror fails to load for any reason, fall back to the textarea
    var ta2 = document.getElementById(${textareaId});
    if (ta2) ta2.style.display = '';
    var w2 = document.getElementById(${wrapperId});
    if (w2) w2.style.display = 'none';
  }
})();
`;
}

// ─── Scoped CSS (.editor-*) ─────────────────────────────────────────────────
// Every selector is prefixed `.editor-*` so this surface can't bleed into
// the repo header / nav above. Tokens reused from layout (--bg-elevated,
// --border, --text-strong, --accent, --space-*, --font-*).

const editorStyles = `
  .editor-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Header strip (sits below RepoHeader + RepoNav) ─── */
  .editor-head { margin-bottom: var(--space-5); }
  .editor-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .editor-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .editor-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 32px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.15;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .editor-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .editor-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 700px;
  }

  /* ─── Toolbar (path breadcrumb + branch pill) ─── */
  .editor-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
    padding: 10px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .editor-path {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    flex-wrap: wrap;
    min-width: 0;
  }
  .editor-path-sep { color: var(--text-faint); }
  .editor-path-seg {
    color: var(--text-muted);
  }
  .editor-path-name {
    color: var(--text-strong);
    font-weight: 600;
  }
  .editor-branch-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #c4b5fd;
    background: rgba(140,109,255,0.12);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    white-space: nowrap;
    font-weight: 600;
  }
  .editor-branch-pill svg { opacity: 0.9; }

  /* ─── Form card ─── */
  .editor-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .editor-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .editor-body { padding: var(--space-4) var(--space-5); }

  .editor-field { display: block; margin-bottom: var(--space-4); }
  .editor-label {
    display: block;
    font-size: 11.5px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .editor-filename-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
  }
  .editor-filename-dir {
    font-size: 13px;
    color: var(--text-muted);
  }
  .editor-input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    font: inherit;
    font-size: 14px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .editor-input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .editor-input-mono { font-family: var(--font-mono); }

  .editor-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 12px 14px;
    font: inherit;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
    tab-size: 2;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    resize: vertical;
    min-height: 280px;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .editor-textarea:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* ─── Action row ─── */
  .editor-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
  }
  .editor-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .editor-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.5), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .editor-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.6), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #fff;
  }
  .editor-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .editor-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .editor-btn-ai {
    background: transparent;
    color: #c4b5fd;
    border-color: rgba(140,109,255,0.35);
  }
  .editor-btn-ai:hover {
    border-color: rgba(140,109,255,0.65);
    background: rgba(140,109,255,0.08);
    color: #ddd6fe;
    text-decoration: none;
  }
  .editor-btn-ai:disabled {
    opacity: 0.55;
    cursor: progress;
  }
  .editor-status {
    color: var(--text-muted);
    font-size: 12.5px;
    margin-left: auto;
  }

  /* ─── CodeMirror wrapper ─── */
  .editor-cm-wrapper {
    display: none; /* shown by JS after mount */
    border-radius: 10px;
    overflow: hidden;
  }
  /* Ensure CM fills the field column */
  .editor-field .cm-editor {
    width: 100%;
    box-sizing: border-box;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
    border-radius: 10px;
    min-height: 280px;
  }
  /* Override oneDark background to match the app's dark bg variable */
  .editor-field .cm-editor .cm-scroller {
    font-family: var(--font-mono);
  }
`;

function IconBranch() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

// New file form
editor.get("/:owner/:repo/new/:ref{.+$}", requireAuth, requireRepoAccess("write"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const refAndPath = c.req.param("ref");

  // Parse ref — use first segment
  const slashIdx = refAndPath.indexOf("/");
  const ref = slashIdx === -1 ? refAndPath : refAndPath.slice(0, slashIdx);
  const dirPath = slashIdx === -1 ? "" : refAndPath.slice(slashIdx + 1);

  return c.html(
    <Layout title={`New file — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="editor-wrap">
        <header class="editor-head">
          <div class="editor-eyebrow">
            <span class="editor-eyebrow-dot" aria-hidden="true" />
            Editor · New file
          </div>
          <h1 class="editor-title">
            <span class="editor-title-grad">Create a new file.</span>
          </h1>
          <p class="editor-sub">
            Pick a path, paste your content, and write a short commit
            message. The commit lands directly on{" "}
            <code style="font-size:12.5px">{ref}</code>.
          </p>
        </header>

        <div class="editor-toolbar">
          <div class="editor-path" title={dirPath ? `${dirPath}/…` : "Repository root"}>
            <span class="editor-path-seg">{owner}/{repo}</span>
            {dirPath && (
              <>
                <span class="editor-path-sep">/</span>
                <span class="editor-path-seg">{dirPath}</span>
              </>
            )}
            <span class="editor-path-sep">/</span>
            <span class="editor-path-name">new file…</span>
          </div>
          <span class="editor-branch-pill" title="Target branch">
            <IconBranch />
            {ref}
          </span>
        </div>

        <form
          method="post"
          action={`/${owner}/${repo}/new/${ref}`}
          class="editor-card"
        >
          <div class="editor-body">
            <input type="hidden" name="dir_path" value={dirPath} />
            <div class="editor-field">
              <label class="editor-label" for="editor-filename">File path</label>
              <div class="editor-filename-row">
                {dirPath && (
                  <span class="editor-filename-dir">{dirPath}/</span>
                )}
                <input
                  class="editor-input editor-input-mono"
                  id="editor-filename"
                  name="filename"
                  required
                  placeholder="filename.ts"
                  autocomplete="off"
                  aria-label="File path"
                />
              </div>
            </div>
            <div class="editor-field">
              <label class="editor-label" for="editor-content-new">Content</label>
              {/* CodeMirror mounts here; falls back to textarea if JS/CDN unavailable */}
              <div id="editor-cm-new" class="editor-cm-wrapper" />
              <textarea
                class="editor-textarea"
                id="editor-content-new"
                name="content"
                rows={20}
                placeholder="Enter file content…"
                spellcheck={false}
                data-lang="plaintext"
              />
            </div>
            <div class="editor-field" style="margin-bottom:0">
              <label class="editor-label" for="commit-message-input">Commit message</label>
              <input
                class="editor-input"
                id="commit-message-input"
                name="message"
                placeholder="Create new file"
                required
                aria-label="Commit message"
              />
            </div>
          </div>
          <div class="editor-actions">
            <button type="submit" class="editor-btn editor-btn-primary">
              Commit new file
            </button>
            <a href={`/${owner}/${repo}`} class="editor-btn editor-btn-ghost">
              Cancel
            </a>
          </div>
          <script
            type="module"
            dangerouslySetInnerHTML={{
              __html: CODEMIRROR_INIT_SCRIPT({
                textareaId: "editor-content-new",
                wrapperId: "editor-cm-new",
                lang: "plaintext",
              }),
            }}
          />
        </form>
      </div>
      <style dangerouslySetInnerHTML={{ __html: editorStyles }} />
    </Layout>
  );
});

// Create file via commit
editor.post("/:owner/:repo/new/:ref", requireAuth, requireRepoAccess("write"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const ref = c.req.param("ref");
  const body = await c.req.parseBody();
  const dirPath = String(body.dir_path || "").trim();
  const filename = String(body.filename || "").trim();
  const content = String(body.content || "");
  const message = String(body.message || `Create ${filename}`).trim();

  if (!filename) return c.redirect(`/${owner}/${repo}`);

  const fullPath = dirPath ? `${dirPath}/${filename}` : filename;

  // Use git hash-object + update-index + write-tree + commit-tree
  const repoDir = getRepoPath(owner, repo);

  const run = async (cmd: string[], cwd: string, stdin?: string) => {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : undefined,
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(new TextEncoder().encode(stdin));
      proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
  };

  // Hash the new file content
  const blobSha = await run(
    ["git", "hash-object", "-w", "--stdin"],
    repoDir,
    content
  );

  // Read current tree
  const currentTreeSha = await run(
    ["git", "rev-parse", `${ref}^{tree}`],
    repoDir
  );

  // Read current tree and add new entry
  const treeContent = await run(["git", "ls-tree", "-r", ref], repoDir);
  const entries = treeContent
    .split("\n")
    .filter(Boolean)
    .map((line) => line + "\n")
    .join("");
  const newEntry = `100644 blob ${blobSha}\t${fullPath}\n`;

  const newTreeSha = await run(
    ["git", "mktree"],
    repoDir,
    entries + newEntry
  );

  // Get parent commit
  const parentSha = await run(
    ["git", "rev-parse", ref],
    repoDir
  );

  // Create commit
  const env = {
    GIT_AUTHOR_NAME: user.displayName || user.username,
    GIT_AUTHOR_EMAIL: user.email,
    GIT_COMMITTER_NAME: user.displayName || user.username,
    GIT_COMMITTER_EMAIL: user.email,
  };

  const commitProc = Bun.spawn(
    ["git", "commit-tree", newTreeSha, "-p", parentSha, "-m", message],
    {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    }
  );
  const commitSha = (await new Response(commitProc.stdout).text()).trim();
  await commitProc.exited;

  // Update branch ref
  await run(
    ["git", "update-ref", `refs/heads/${ref}`, commitSha],
    repoDir
  );

  return c.redirect(`/${owner}/${repo}/blob/${ref}/${fullPath}`);
});

// Edit file form
editor.get("/:owner/:repo/edit/:ref{.+$}", requireAuth, requireRepoAccess("write"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const refAndPath = c.req.param("ref");

  // Parse ref/path
  const slashIdx = refAndPath.indexOf("/");
  if (slashIdx === -1) return c.text("Not found", 404);
  const ref = refAndPath.slice(0, slashIdx);
  const filePath = refAndPath.slice(slashIdx + 1);

  const blob = await getBlob(owner, repo, ref, filePath);
  if (!blob || blob.isBinary) {
    return c.html(
      <Layout title="Cannot edit" user={user}>
        <EmptyState title={blob?.isBinary ? "Cannot edit binary file" : "File not found"} />
      </Layout>,
      404
    );
  }

  const fileName = filePath.split("/").pop() || filePath;
  const dirParts = filePath.split("/").slice(0, -1);

  return c.html(
    <Layout title={`Editing ${filePath} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="editor-wrap">
        <header class="editor-head">
          <div class="editor-eyebrow">
            <span class="editor-eyebrow-dot" aria-hidden="true" />
            Editor · Edit file
          </div>
          <h1 class="editor-title">
            <span class="editor-title-grad">Edit{" "}</span>
            <code style="font-family:var(--font-mono);font-size:0.82em;color:var(--text-strong);font-weight:700">{fileName}</code>
          </h1>
          <p class="editor-sub">
            Save your changes as a commit on{" "}
            <code style="font-size:12.5px">{ref}</code>. Write a clear
            one-line message so reviewers can follow the history.
          </p>
        </header>

        <div class="editor-toolbar">
          <div class="editor-path" title={filePath}>
            <a
              href={`/${owner}/${repo}`}
              class="editor-path-seg"
              style="color:var(--text-muted);text-decoration:none"
            >
              {owner}/{repo}
            </a>
            {dirParts.map((seg, i) => {
              const subPath = dirParts.slice(0, i + 1).join("/");
              return (
                <>
                  <span class="editor-path-sep">/</span>
                  <a
                    href={`/${owner}/${repo}/tree/${ref}/${subPath}`}
                    class="editor-path-seg"
                    style="text-decoration:none"
                  >
                    {seg}
                  </a>
                </>
              );
            })}
            <span class="editor-path-sep">/</span>
            <span class="editor-path-name">{fileName}</span>
          </div>
          <span class="editor-branch-pill" title="Target branch">
            <IconBranch />
            {ref}
          </span>
        </div>

        <form
          method="post"
          action={`/${owner}/${repo}/edit/${ref}/${filePath}`}
          class="editor-card"
        >
          <div class="editor-body">
            <div class="editor-field">
              <label class="editor-label" for="editor-content-edit">Content</label>
              {/* CodeMirror mounts here; falls back to textarea if JS/CDN unavailable */}
              <div id="editor-cm-edit" class="editor-cm-wrapper" />
              <textarea
                class="editor-textarea"
                id="editor-content-edit"
                name="content"
                rows={25}
                spellcheck={false}
                data-lang={detectEditorLang(filePath)}
              >{blob.content}</textarea>
            </div>
            <div class="editor-field" style="margin-bottom:0">
              <label class="editor-label" for="commit-message-input">Commit message</label>
              <input
                class="editor-input"
                id="commit-message-input"
                name="message"
                placeholder={`Update ${fileName}`}
                required
                aria-label="Commit message"
              />
            </div>
          </div>
          <div class="editor-actions">
            <button type="submit" class="editor-btn editor-btn-primary">
              Commit changes
            </button>
            <button
              type="button"
              id="ai-commit-msg-btn"
              class="editor-btn editor-btn-ai"
              title="Generate a one-line commit message using Claude based on the diff"
            >
              {"✨"} Suggest with AI
            </button>
            <a
              href={`/${owner}/${repo}/blob/${ref}/${filePath}`}
              class="editor-btn editor-btn-ghost"
            >
              Cancel
            </a>
            <span id="ai-commit-msg-status" class="editor-status" />
          </div>
          <script
            dangerouslySetInnerHTML={{
              __html: AI_COMMIT_MSG_SCRIPT({
                endpoint: `/${owner}/${repo}/ai/commit-message`,
                ref,
                filePath,
              }),
            }}
          />
          <script
            type="module"
            dangerouslySetInnerHTML={{
              __html: CODEMIRROR_INIT_SCRIPT({
                textareaId: "editor-content-edit",
                wrapperId: "editor-cm-edit",
                lang: detectEditorLang(filePath),
              }),
            }}
          />
        </form>
      </div>
      <style dangerouslySetInnerHTML={{ __html: editorStyles }} />
    </Layout>
  );
});

// AI-suggested commit message — JSON endpoint driven by the editor button.
// Reads the on-disk blob at (ref, filePath), diffs against the submitted
// new content, and asks generateCommitMessage() for a one-liner. Returns
// {ok:true, message} on success, {ok:false, error} otherwise. Always 200.
editor.post(
  "/:owner/:repo/ai/commit-message",
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner, repo } = c.req.param();
    if (!isAiAvailable()) {
      return c.json({
        ok: false,
        error: "AI is not available — set ANTHROPIC_API_KEY.",
      });
    }
    const body = await c.req.parseBody();
    const ref = String(body.ref || "").trim();
    const filePath = String(body.filePath || "").trim();
    const newContent = String(body.content || "");
    if (!ref || !filePath) {
      return c.json({ ok: false, error: "ref + filePath required" });
    }

    let oldContent = "";
    try {
      const blob = await getBlob(owner, repo, ref, filePath);
      oldContent = blob?.content || "";
    } catch {
      oldContent = "";
    }

    if (oldContent === newContent) {
      return c.json({
        ok: false,
        error: "No changes to summarise.",
      });
    }

    // Build a minimal unified-diff-ish summary the AI helper can consume.
    // generateCommitMessage was written for git diff text; we feed a
    // header + truncated old/new sample so it has shape to summarise.
    const truncate = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n…(truncated)" : s);
    const diff =
      `--- a/${filePath}\n+++ b/${filePath}\n` +
      "## Old:\n" +
      truncate(oldContent) +
      "\n\n## New:\n" +
      truncate(newContent);

    let message = "";
    try {
      message = await generateCommitMessage(diff);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI request failed.";
      return c.json({ ok: false, error: msg });
    }
    if (!message.trim()) {
      return c.json({
        ok: false,
        error: "AI returned an empty draft.",
      });
    }
    // Cap to one line + 100 chars (commit-message convention).
    const oneLine = message.split("\n")[0]!.trim();
    const capped = oneLine.length > 100 ? oneLine.slice(0, 97) + "..." : oneLine;
    // Emit audit event so L9 ai-hours-saved counters stay accurate.
    const user = c.get("user");
    if (user) {
      void audit({
        userId: user.id,
        action: AI_AUDIT_ACTIONS.AI_COMMIT_MESSAGE,
        targetType: "repository",
        targetId: `${owner}/${repo}`,
        metadata: { filePath },
      }).catch(() => {});
    }
    return c.json({ ok: true, message: capped });
  }
);

// Save edited file
editor.post("/:owner/:repo/edit/:ref{.+$}", requireAuth, requireRepoAccess("write"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const refAndPath = c.req.param("ref");

  const slashIdx = refAndPath.indexOf("/");
  if (slashIdx === -1) return c.redirect(`/${owner}/${repo}`);
  const ref = refAndPath.slice(0, slashIdx);
  const filePath = refAndPath.slice(slashIdx + 1);

  const body = await c.req.parseBody();
  const content = String(body.content || "");
  const message = String(
    body.message || `Update ${filePath.split("/").pop()}`
  ).trim();

  const repoDir = getRepoPath(owner, repo);

  const run = async (cmd: string[], cwd: string, stdin?: string) => {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : undefined,
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(new TextEncoder().encode(stdin));
      proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
  };

  // Hash new content
  const blobSha = await run(
    ["git", "hash-object", "-w", "--stdin"],
    repoDir,
    content
  );

  // Read current tree, replace the file
  const treeContent = await run(["git", "ls-tree", "-r", ref], repoDir);
  const lines = treeContent.split("\n").filter(Boolean);
  const updated = lines
    .map((line) => {
      const parts = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
      if (parts && parts[4] === filePath) {
        return `${parts[1]} blob ${blobSha}\t${parts[4]}`;
      }
      return line;
    })
    .join("\n") + "\n";

  const newTreeSha = await run(["git", "mktree"], repoDir, updated);
  const parentSha = await run(["git", "rev-parse", ref], repoDir);

  const env = {
    GIT_AUTHOR_NAME: user.displayName || user.username,
    GIT_AUTHOR_EMAIL: user.email,
    GIT_COMMITTER_NAME: user.displayName || user.username,
    GIT_COMMITTER_EMAIL: user.email,
  };

  const commitProc = Bun.spawn(
    ["git", "commit-tree", newTreeSha, "-p", parentSha, "-m", message],
    {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    }
  );
  const commitSha = (await new Response(commitProc.stdout).text()).trim();
  await commitProc.exited;

  await run(
    ["git", "update-ref", `refs/heads/${ref}`, commitSha],
    repoDir
  );

  return c.redirect(`/${owner}/${repo}/blob/${ref}/${filePath}`);
});

export default editor;
