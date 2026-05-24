/**
 * Block D8 — AI-generated test suite route.
 *
 *   GET  /:owner/:repo/ai/tests?path=...&ref=...
 *       Renders a form to pick a source file and generate a failing test
 *       stub for it. When `path` is provided the form is pre-filled with
 *       the currently-selected file so the user can "Generate" with one
 *       click.
 *
 *   GET  /:owner/:repo/ai/tests?path=...&format=raw
 *       Returns `c.text(result.code, 200, {"Content-Type": ...})` for CLI
 *       consumption (e.g. `curl | bat`). No HTML shell.
 *
 *   POST /:owner/:repo/ai/tests/generate
 *       Auth required. Actually runs the model and renders the result
 *       page with highlighted source, highlighted test, a copy-to-clipboard
 *       button, a review warning, and a regenerate button.
 *
 * 2026 polish — visual only. Every form action, POST target, raw-format
 * branch, `generateTestStub(...)` AI call, and the highlightCode pipeline
 * are preserved verbatim. CSS scoped under `.ai-tests-*` so it can't
 * collide with `.ai-explain-*` or `.ai-changelog-*` on a shared Layout.
 */

import { Hono } from "hono";
import { raw } from "hono/html";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  getBlob,
  getDefaultBranch,
  getTree,
  resolveRef,
} from "../git/repository";
import type { GitTreeEntry } from "../git/repository";
import { highlightCode } from "../lib/highlight";
import {
  contentTypeFor,
  detectLanguage,
  detectTestFramework,
  generateTestStub,
} from "../lib/ai-tests";

const aiTestsRoutes = new Hono<AuthEnv>();

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.ai-tests-` so this surface stays
 * isolated from `.ai-explain-*` and `.ai-changelog-*`. Mirrors the
 * gradient-hairline hero + white spec-block patterns from
 * admin-integrations.tsx / build-agent-spec.tsx, with focus-rings on
 * inputs via the :root --border-focus token.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .ai-tests-wrap { max-width: 980px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .ai-tests-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ai-tests-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ai-tests-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .ai-tests-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .ai-tests-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .ai-tests-eyebrow .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .ai-tests-title {
    font-size: clamp(28px, 4vw, 42px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .ai-tests-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ai-tests-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 640px;
  }
  .ai-tests-sub strong { color: var(--text-strong); font-weight: 700; }
  .ai-tests-sub code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12.5px;
  }

  /* Form card */
  .ai-tests-form-card {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
  }
  .ai-tests-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: var(--space-3);
  }
  .ai-tests-field-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .ai-tests-input,
  .ai-tests-select {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .ai-tests-input:focus,
  .ai-tests-select:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .ai-tests-submit {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 16px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    border: 1px solid transparent;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 6px 16px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    font-family: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease;
    line-height: 1;
  }
  .ai-tests-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .ai-tests-submit svg { display: block; }

  .ai-tests-detected {
    display: inline-flex;
    gap: 12px;
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .ai-tests-detected code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11.5px;
  }

  /* Header bar between hero + results */
  .ai-tests-resulthead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-4) 0 var(--space-3);
    flex-wrap: wrap;
  }
  .ai-tests-resulthead h2 {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .ai-tests-resulthead h2 code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 14px;
    font-weight: 600;
  }
  .ai-tests-regen {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    border: 1px solid transparent;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 6px 16px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    font-family: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .ai-tests-regen:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .ai-tests-regen svg { display: block; }

  /* Banner — review warning */
  .ai-tests-warning {
    margin-bottom: var(--space-4);
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(210, 153, 34, 0.10);
    border: 1px solid rgba(210, 153, 34, 0.40);
    color: #fde68a;
    font-size: 13.5px;
    line-height: 1.55;
  }
  .ai-tests-warning strong { color: #fef3c7; }
  .ai-tests-warning em { color: #fde68a; font-style: italic; }

  /* Source + test panels — white container, dark code inside (matches the
     existing .hljs styling on the dark theme). */
  .ai-tests-section { margin-bottom: var(--space-5); }
  .ai-tests-panel {
    position: relative;
    background: #ffffff;
    color: #0a0a0a;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.18);
  }
  .ai-tests-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .ai-tests-panel-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display, system-ui, sans-serif);
    font-size: 13.5px;
    font-weight: 700;
    color: #111827;
    letter-spacing: -0.005em;
    margin: 0;
  }
  .ai-tests-panel-title code {
    font-family: var(--font-mono);
    background: #eef2ff;
    color: #4338ca;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .ai-tests-panel-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .ai-tests-copy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12.5px;
    font-weight: 600;
    color: #111827;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .ai-tests-copy:hover { background: #f3f4f6; border-color: #9ca3af; }
  .ai-tests-copy.is-copied {
    background: #ecfdf5;
    border-color: #6ee7b7;
    color: #047857;
  }
  .ai-tests-copy svg { display: block; }

  .ai-tests-pre {
    margin: 0;
    padding: 14px 16px;
    background: #0f111a;
    color: #e6edf3;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.6;
    overflow: auto;
    white-space: pre;
    max-height: 70vh;
  }
  .ai-tests-pre code { background: transparent; color: inherit; padding: 0; }

  /* Empty-state — dashed card w/ orb + suggestion prompts. */
  .ai-tests-empty {
    position: relative;
    margin: var(--space-4) 0;
    padding: var(--space-5);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    background: var(--bg-elevated);
    overflow: hidden;
    text-align: center;
  }
  .ai-tests-empty-orb {
    position: absolute;
    inset: -50% 30% auto 30%;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(70px);
    pointer-events: none;
    z-index: 0;
  }
  .ai-tests-empty > * { position: relative; z-index: 1; }
  .ai-tests-empty h3 {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 16px;
    color: var(--text-strong);
  }
  .ai-tests-empty p {
    margin: 0 0 6px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .ai-tests-suggests {
    display: inline-flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
    font-size: 12px;
    color: var(--text-muted);
    text-align: left;
  }
  .ai-tests-suggests code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 11.5px;
  }

  /* Loading shimmer skeleton — kept for future async modes. */
  @keyframes ai-tests-shimmer {
    0% { background-position: -300px 0; }
    100% { background-position: 300px 0; }
  }
  .ai-tests-skeleton {
    height: 12px;
    border-radius: 4px;
    background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(140,109,255,0.08) 50%, rgba(255,255,255,0.04) 100%);
    background-size: 600px 100%;
    animation: ai-tests-shimmer 1.4s linear infinite;
    margin-bottom: 8px;
  }

  /* Powered by Claude pill */
  .ai-tests-poweredby {
    margin-top: var(--space-5);
    text-align: center;
  }
  .ai-tests-poweredby-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.08);
    border: 1px solid rgba(140,109,255,0.22);
    color: var(--text-muted);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .ai-tests-poweredby-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
  }

  :root[data-theme='light'] .ai-tests-panel {
    box-shadow: 0 1px 0 rgba(0,0,0,0.02), 0 8px 28px rgba(15,16,28,0.08);
  }
`;

const COPY_SCRIPT = `
  (function(){
    var btn = document.querySelector('[data-ai-tests-copy]');
    var src = document.querySelector('[data-ai-tests-code]');
    var label = document.querySelector('[data-ai-tests-copy-label]');
    if (!btn || !src || !label) return;
    btn.addEventListener('click', function(){
      var text = src.innerText || src.textContent || '';
      var done = function(){
        btn.classList.add('is-copied');
        label.textContent = 'Copied';
        setTimeout(function(){
          btn.classList.remove('is-copied');
          label.textContent = 'Copy';
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function(){
          var ta = document.createElement('textarea');
          ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
          document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done(); } catch(e){}
          document.body.removeChild(ta);
        });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch(e){}
        document.body.removeChild(ta);
      }
    });
  })();
`;

interface ResolvedRepo {
  ownerId: string;
  ownerUsername: string;
  repoId: string;
  repoName: string;
}

async function resolveRepo(
  ownerName: string,
  repoName: string
): Promise<ResolvedRepo | null> {
  try {
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerRow) return null;
    const [repoRow] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repoRow) return null;
    return {
      ownerId: ownerRow.id,
      ownerUsername: ownerRow.username,
      repoId: repoRow.id,
      repoName: repoRow.name,
    };
  } catch {
    return null;
  }
}

/**
 * Shallow listing of source blobs reachable from the tree root and a couple
 * of common top-level source directories. Kept intentionally small — the
 * picker in the form is just a convenience, users can also type a path
 * directly.
 */
async function listRepoFiles(
  owner: string,
  repo: string,
  ref: string
): Promise<string[]> {
  const out: string[] = [];
  let root: GitTreeEntry[] = [];
  try {
    root = await getTree(owner, repo, ref, "");
  } catch {
    root = [];
  }
  for (const entry of root) {
    if (entry.type === "blob") {
      out.push(entry.name);
    }
  }
  const candidates = ["src", "lib", "app", "server", "pkg", "tests"];
  for (const dir of candidates) {
    const hit = root.find((e) => e.type === "tree" && e.name === dir);
    if (!hit) continue;
    let children: GitTreeEntry[] = [];
    try {
      children = await getTree(owner, repo, ref, dir);
    } catch {
      children = [];
    }
    for (const child of children) {
      if (child.type === "blob") {
        out.push(`${dir}/${child.name}`);
      } else if (child.type === "tree") {
        let grand: GitTreeEntry[] = [];
        try {
          grand = await getTree(owner, repo, ref, `${dir}/${child.name}`);
        } catch {
          grand = [];
        }
        for (const g of grand) {
          if (g.type === "blob") {
            out.push(`${dir}/${child.name}/${g.name}`);
          }
        }
      }
    }
    if (out.length > 500) break;
  }
  return out;
}

function TestsHero(props: { eyebrowExtra?: string }) {
  return (
    <section class="ai-tests-hero">
      <div class="ai-tests-hero-orb" aria-hidden="true" />
      <div class="ai-tests-hero-inner">
        <div class="ai-tests-eyebrow">
          <span class="pill" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </span>
          AI · gluecron · tests{props.eyebrowExtra ? ` · ${props.eyebrowExtra}` : ""}
        </div>
        <h1 class="ai-tests-title">
          <span class="ai-tests-title-grad">Generate.</span>{" "}
          <span style="color:var(--text-strong)">AI tests</span>
        </h1>
        <p class="ai-tests-sub">
          Pick a source file and gluecron will ask Claude to draft a{" "}
          <strong>failing</strong> test stub that exercises its public surface.
          Treat the output as a starting-point — always review before
          committing.
        </p>
      </div>
    </section>
  );
}

function renderPicker(
  ownerName: string,
  repoName: string,
  allFiles: string[],
  currentPath: string,
  ref: string
) {
  const trimmed = allFiles.slice(0, 200);
  return (
    <div class="ai-tests-form-card">
      <form
        method="post"
        action={`/${ownerName}/${repoName}/ai/tests/generate`}
      >
        <input type="hidden" name="ref" value={ref} />
        <div class="ai-tests-field">
          <label class="ai-tests-field-label" for="ai-tests-path">
            Source file
          </label>
          <input
            id="ai-tests-path"
            type="text"
            name="path"
            value={currentPath}
            placeholder="src/lib/foo.ts"
            required
            aria-label="Source file"
            class="ai-tests-input"
          />
        </div>
        {trimmed.length > 0 && (
          <div class="ai-tests-field">
            <label class="ai-tests-field-label" for="ai-tests-pick">
              …or pick from the repo
            </label>
            <select
              id="ai-tests-pick"
              name="pickPath"
              onchange="this.form.path.value = this.value"
              class="ai-tests-select"
            >
              <option value="">— select a file —</option>
              {trimmed.map((f) => (
                <option value={f} selected={f === currentPath}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <button type="submit" class="ai-tests-submit">
            Generate tests
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

aiTestsRoutes.get("/:owner/:repo/ai/tests", softAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const path = (c.req.query("path") || "").trim();
  const reqRef = (c.req.query("ref") || "").trim();
  const format = (c.req.query("format") || "").trim().toLowerCase();

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
  const ref = reqRef || defaultBranch;
  const sha = (await resolveRef(owner, repo, ref)) || ref;

  // Raw format: just emit the generated code (for CLI use).
  if (format === "raw") {
    if (!path) {
      return c.text("missing ?path=", 400, {
        "Content-Type": "text/plain; charset=utf-8",
      });
    }
    const blob = await getBlob(owner, repo, sha, path).catch(() => null);
    if (!blob || blob.isBinary) {
      return c.text("file not found", 404, {
        "Content-Type": "text/plain; charset=utf-8",
      });
    }
    const language = detectLanguage(path);
    const repoFiles = await listRepoFiles(owner, repo, sha);
    const framework = detectTestFramework(language, repoFiles);
    const result = await generateTestStub({
      path,
      language,
      framework,
      sourceCode: blob.content,
    });
    return c.text(result.code, 200, {
      "Content-Type": contentTypeFor(result.language),
    });
  }

  // HTML form mode.
  const repoFiles = await listRepoFiles(owner, repo, sha);
  const detectedLang = path ? detectLanguage(path) : "other";
  const detectedFramework = detectTestFramework(detectedLang, repoFiles);

  return c.html(
    <Layout title={`AI tests — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <IssueNav owner={owner} repo={repo} active="code" />
      <div class="ai-tests-wrap">
        <TestsHero />

        {path && (
          <div class="ai-tests-detected">
            <span>
              Detected language: <code>{detectedLang}</code>
            </span>
            <span>
              Framework: <code>{detectedFramework}</code>
            </span>
          </div>
        )}

        {renderPicker(owner, repo, repoFiles, path, ref)}

        {!path && (
          <div class="ai-tests-empty">
            <div class="ai-tests-empty-orb" aria-hidden="true" />
            <h3>No file picked yet</h3>
            <p>
              Choose any source file in this repo — Claude will draft a failing
              test stub matching your detected framework.
            </p>
            <div class="ai-tests-suggests">
              <div>
                Try: <code>src/lib/auth.ts</code>
              </div>
              <div>
                Or:&nbsp; <code>src/git/repository.ts</code>
              </div>
            </div>
          </div>
        )}

        <div class="ai-tests-poweredby">
          <span class="ai-tests-poweredby-pill">
            <span class="dot" aria-hidden="true" />
            Powered by Claude
          </span>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

aiTestsRoutes.post(
  "/:owner/:repo/ai/tests/generate",
  requireAuth,
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const path = String(body.path || "").trim();
    const reqRef = String(body.ref || "").trim();

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Repository not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    if (!path) {
      return c.redirect(`/${owner}/${repo}/ai/tests`);
    }

    const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
    const ref = reqRef || defaultBranch;
    const sha = (await resolveRef(owner, repo, ref)) || ref;

    const blob = await getBlob(owner, repo, sha, path).catch(() => null);
    if (!blob || blob.isBinary) {
      return c.html(
        <Layout title={`AI tests — ${owner}/${repo}`} user={user}>
          <RepoHeader owner={owner} repo={repo} />
          <IssueNav owner={owner} repo={repo} active="code" />
          <div class="ai-tests-wrap">
            <TestsHero eyebrowExtra="error" />
            <div class="ai-tests-empty">
              <div class="ai-tests-empty-orb" aria-hidden="true" />
              <h3>Couldn't read that file</h3>
              <p>
                No such path at <code>{ref}</code>, or the file is binary.
              </p>
              <p>
                <a href={`/${owner}/${repo}/ai/tests`}>Back to the picker</a>
              </p>
            </div>
            <div class="ai-tests-poweredby">
              <span class="ai-tests-poweredby-pill">
                <span class="dot" aria-hidden="true" />
                Powered by Claude
              </span>
            </div>
          </div>
          <style dangerouslySetInnerHTML={{ __html: styles }} />
        </Layout>,
        404
      );
    }

    const language = detectLanguage(path);
    const repoFiles = await listRepoFiles(owner, repo, sha);
    const framework = detectTestFramework(language, repoFiles);

    const result = await generateTestStub({
      path,
      language,
      framework,
      sourceCode: blob.content,
    });

    const sourceHl = highlightCode(blob.content, path);
    const testHl = highlightCode(result.code || "", result.suggestedPath);

    const aiFailed = result.framework === "fallback" || !result.code;

    return c.html(
      <Layout title={`AI tests — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <IssueNav owner={owner} repo={repo} active="code" />
        <div class="ai-tests-wrap">
          <TestsHero eyebrowExtra={path} />

          <div class="ai-tests-resulthead">
            <div>
              <h2>
                Tests for <code>{path}</code>
              </h2>
              <div class="ai-tests-detected">
                <span>
                  Language: <code>{language}</code>
                </span>
                <span>
                  Framework: <code>{aiFailed ? "fallback" : framework}</code>
                </span>
                <span>
                  Ref: <code>{ref}</code>
                </span>
              </div>
            </div>
            <form
              method="post"
              action={`/${owner}/${repo}/ai/tests/generate`}
              style="display: inline;"
            >
              <input type="hidden" name="path" value={path} />
              <input type="hidden" name="ref" value={ref} />
              <button type="submit" class="ai-tests-regen">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Regenerate
              </button>
            </form>
          </div>

          <div class="ai-tests-warning flash-warning">
            <strong>Review before committing.</strong> These tests are a
            starting-point only — they are intentionally written to{" "}
            <em>fail</em> so you are forced to supply real expected values.
            Gluecron does not verify the behaviour is correct.
          </div>

          {aiFailed && (
            <div class="ai-tests-empty">
              <div class="ai-tests-empty-orb" aria-hidden="true" />
              <h3>AI backend unavailable</h3>
              <p>
                Couldn't generate a test stub. The AI backend may not be
                configured, or the model returned an empty response. A suggested
                path was still computed: <code>{result.suggestedPath}</code>.
              </p>
            </div>
          )}

          <section class="ai-tests-section">
            <div class="ai-tests-panel">
              <header class="ai-tests-panel-head">
                <p class="ai-tests-panel-title">
                  <span class="ai-tests-panel-dot" aria-hidden="true" />
                  Source · <code>{path}</code>
                </p>
              </header>
              <pre class="ai-tests-pre hljs">
                <code>{raw(sourceHl.html)}</code>
              </pre>
            </div>
          </section>

          <section class="ai-tests-section">
            <div class="ai-tests-panel">
              <header class="ai-tests-panel-head">
                <p class="ai-tests-panel-title">
                  <span class="ai-tests-panel-dot" aria-hidden="true" />
                  Suggested test · <code>{result.suggestedPath}</code>
                </p>
                <button
                  type="button"
                  class="ai-tests-copy"
                  id="copy-test-btn"
                  data-ai-tests-copy
                  data-test-code-id="ai-test-code"
                  aria-label="Copy test to clipboard"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span data-ai-tests-copy-label>Copy</span>
                </button>
              </header>
              <pre
                class="ai-tests-pre hljs"
                id="ai-test-code"
                data-ai-tests-code
              >
                <code>{result.code ? raw(testHl.html) : "// (no output)"}</code>
              </pre>
            </div>
          </section>

          <div class="ai-tests-poweredby">
            <span class="ai-tests-poweredby-pill">
              <span class="dot" aria-hidden="true" />
              Powered by Claude
            </span>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
      </Layout>
    );
  }
);

export default aiTestsRoutes;
