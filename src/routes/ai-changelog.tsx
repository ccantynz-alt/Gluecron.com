/**
 * Block D7 — AI-generated changelog for an arbitrary commit range.
 *
 *   GET /:owner/:repo/ai/changelog
 *     - No query args: renders a form (from/to selects populated from
 *       branches + recent tags).
 *     - ?from=&to= (&format=markdown|html): runs `git log <from>..<to>`,
 *       feeds commits to `generateChangelog`, and renders the result.
 *     - ?format=markdown returns `text/markdown` for CLI/CI consumers.
 *
 * Public repos are readable without auth (softAuth) — matching the
 * behaviour of `src/routes/compare.tsx`.
 *
 * 2026 polish — every form action, POST target, ?format=markdown branch,
 * and the `generateChangelog(...)` AI prompt construction are preserved
 * verbatim. Visual treatment scoped under `.ai-changelog-*` so this
 * surface can't share CSS with ai-explain or ai-tests.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import {
  listBranches,
  listTags,
  resolveRef,
  repoExists,
  getRepoPath,
} from "../git/repository";
import { generateChangelog } from "../lib/ai-generators";
import { renderMarkdown } from "../lib/markdown";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const aiChangelog = new Hono<AuthEnv>();

aiChangelog.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.ai-changelog-` so this surface can't
 * bleed into ai-explain or ai-tests. Mirrors the gradient-hairline hero,
 * focus-rings on inputs (uses :root --border-focus token), white result
 * panel + copy-to-clipboard pattern from admin-integrations.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .ai-changelog-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .ai-changelog-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ai-changelog-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ai-changelog-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .ai-changelog-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .ai-changelog-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .ai-changelog-eyebrow .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .ai-changelog-title {
    font-size: clamp(28px, 4vw, 42px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .ai-changelog-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ai-changelog-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 640px;
  }

  /* Banners (error / notice). Keep the legacy .auth-error class on the
     error banner because the test asserts against it; just upgrade the
     visual via the new wrapping class. */
  .ai-changelog-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .ai-changelog-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .ai-changelog-banner.is-notice {
    border-color: rgba(140,109,255,0.30);
    background: rgba(140,109,255,0.06);
    color: var(--text);
  }

  /* Form card */
  .ai-changelog-form-card {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
  }
  .ai-changelog-form-row {
    display: flex;
    gap: 12px;
    align-items: end;
    flex-wrap: wrap;
  }
  .ai-changelog-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 180px;
    flex: 1 1 200px;
  }
  .ai-changelog-field-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .ai-changelog-input {
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
  .ai-changelog-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .ai-changelog-submit {
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
  .ai-changelog-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .ai-changelog-submit svg { display: block; }

  .ai-changelog-ghost {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 14px;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    font-family: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    line-height: 1;
  }
  .ai-changelog-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  .ai-changelog-knownrefs {
    margin-top: var(--space-3);
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .ai-changelog-knownrefs code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11px;
    margin: 0 2px;
  }

  /* Meta line under the title once a range is loaded. */
  .ai-changelog-rangeline {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--text-muted);
    font-size: 12.5px;
    margin: var(--space-2) 0 var(--space-4);
  }
  .ai-changelog-rangeline code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .ai-changelog-rangeline .arrow { opacity: 0.55; }
  .ai-changelog-rangeline .count {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.10);
    color: #c4b5fd;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }

  /* Result panels — split: rendered MD (left) + copyable raw (right) */
  .ai-changelog-results {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    align-items: start;
  }
  @media (max-width: 800px) {
    .ai-changelog-results { grid-template-columns: 1fr; }
  }

  .ai-changelog-panel {
    position: relative;
    background: #ffffff;
    color: #0a0a0a;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.18);
  }
  .ai-changelog-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .ai-changelog-panel-title {
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
  .ai-changelog-panel-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .ai-changelog-copy {
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
  .ai-changelog-copy:hover { background: #f3f4f6; border-color: #9ca3af; }
  .ai-changelog-copy.is-copied {
    background: #ecfdf5;
    border-color: #6ee7b7;
    color: #047857;
  }
  .ai-changelog-copy svg { display: block; }
  .ai-changelog-panel-body {
    padding: 18px 22px;
    background: #ffffff;
    color: #0a0a0a;
  }
  .ai-changelog-panel-body .markdown-body {
    color: #0a0a0a;
    background: #ffffff;
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
    font-size: 14.5px;
    line-height: 1.65;
  }
  .ai-changelog-panel-body .markdown-body h1,
  .ai-changelog-panel-body .markdown-body h2,
  .ai-changelog-panel-body .markdown-body h3 {
    color: #0a0a0a;
    border-bottom-color: #e5e7eb;
  }
  .ai-changelog-panel-body .markdown-body code {
    background: #eef2ff;
    color: #4338ca;
    padding: 1px 5px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .ai-changelog-panel-body .markdown-body a { color: #4338ca; }

  .ai-changelog-raw {
    width: 100%;
    box-sizing: border-box;
    min-height: 360px;
    padding: 14px 16px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.6;
    color: #0a0a0a;
    background: #ffffff;
    border: 0;
    outline: 0;
    resize: vertical;
    white-space: pre;
    overflow: auto;
  }

  /* Empty-state — dashed orb card with "try" prompts. */
  .ai-changelog-empty {
    position: relative;
    margin: var(--space-4) 0;
    padding: var(--space-5);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    background: var(--bg-elevated);
    text-align: center;
    overflow: hidden;
  }
  .ai-changelog-empty-orb {
    position: absolute;
    inset: -50% 30% auto 30%;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(70px);
    pointer-events: none;
    z-index: 0;
  }
  .ai-changelog-empty > * { position: relative; z-index: 1; }
  .ai-changelog-empty h3 {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 16px;
    color: var(--text-strong);
  }
  .ai-changelog-empty p {
    margin: 0 0 6px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .ai-changelog-empty .ai-changelog-suggests {
    display: inline-flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
    font-size: 12px;
    color: var(--text-muted);
    text-align: left;
  }
  .ai-changelog-empty code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11.5px;
  }

  /* Skeleton (kept for future async modes — the route currently runs
     synchronously, so the placeholder only shows when explicitly wired). */
  @keyframes ai-changelog-shimmer {
    0% { background-position: -300px 0; }
    100% { background-position: 300px 0; }
  }
  .ai-changelog-skeleton {
    height: 12px;
    border-radius: 4px;
    background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(140,109,255,0.08) 50%, rgba(255,255,255,0.04) 100%);
    background-size: 600px 100%;
    animation: ai-changelog-shimmer 1.4s linear infinite;
    margin-bottom: 8px;
  }

  /* Powered by Claude */
  .ai-changelog-poweredby {
    margin-top: var(--space-5);
    text-align: center;
  }
  .ai-changelog-poweredby-pill {
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
  .ai-changelog-poweredby-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
  }

  :root[data-theme='light'] .ai-changelog-panel {
    box-shadow: 0 1px 0 rgba(0,0,0,0.02), 0 8px 28px rgba(15,16,28,0.08);
  }
`;

const COPY_SCRIPT = `
  (function(){
    var btn = document.querySelector('[data-ai-changelog-copy]');
    var src = document.querySelector('[data-ai-changelog-raw]');
    var label = document.querySelector('[data-ai-changelog-copy-label]');
    if (!btn || !src || !label) return;
    btn.addEventListener('click', function(){
      var text = (src.value !== undefined) ? src.value : (src.innerText || src.textContent || '');
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
          try { src.focus && src.focus(); src.select && src.select(); document.execCommand('copy'); done(); } catch(e){}
        });
      } else {
        try { src.focus && src.focus(); src.select && src.select(); document.execCommand('copy'); done(); } catch(e){}
      }
    });
  })();
`;

function ChangelogHero() {
  return (
    <section class="ai-changelog-hero">
      <div class="ai-changelog-hero-orb" aria-hidden="true" />
      <div class="ai-changelog-hero-inner">
        <div class="ai-changelog-eyebrow">
          <span class="pill" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 8v4l3 3" />
              <circle cx="12" cy="12" r="9" />
            </svg>
          </span>
          AI · gluecron · changelog
        </div>
        <h1 class="ai-changelog-title">
          <span class="ai-changelog-title-grad">Track.</span>{" "}
          <span style="color:var(--text-strong)">AI Changelog</span>
        </h1>
        <p class="ai-changelog-sub">
          Generate release notes for any commit range. Pick a base (from) and
          a head (to) — Claude will group commits into Features / Fixes /
          Perf / Refactors / Docs / Other.
        </p>
      </div>
    </section>
  );
}

interface RangeCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

async function commitsInRange(
  owner: string,
  repo: string,
  from: string,
  to: string
): Promise<RangeCommit[]> {
  const repoDir = getRepoPath(owner, repo);
  const proc = Bun.spawn(
    [
      "git",
      "log",
      "--format=%H%x00%s%x00%an%x00%aI",
      `${from}..${to}`,
    ],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 500)
    .map((line) => {
      const [sha, message, author, date] = line.split("\0");
      return { sha, message, author, date };
    });
}

aiChangelog.get("/:owner/:repo/ai/changelog", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const from = (c.req.query("from") || "").trim();
  const to = (c.req.query("to") || "").trim();
  const format = (c.req.query("format") || "").trim().toLowerCase();

  if (!(await repoExists(owner, repo))) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const [branches, tags] = await Promise.all([
    listBranches(owner, repo).catch(() => [] as string[]),
    listTags(owner, repo).catch(
      () => [] as Array<{ name: string; sha: string; date: string }>
    ),
  ]);
  const refChoices = [
    ...branches,
    ...tags.slice(0, 25).map((t) => t.name),
  ];

  const renderForm = (opts: { error?: string; notice?: string } = {}) =>
    c.html(
      <Layout title={`AI Changelog — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <IssueNav owner={owner} repo={repo} active="code" />
        <div class="ai-changelog-wrap">
          <ChangelogHero />

          {opts.error && (
            <div class="ai-changelog-banner is-error auth-error">
              {opts.error}
            </div>
          )}
          {opts.notice && (
            <div class="ai-changelog-banner is-notice">{opts.notice}</div>
          )}

          <div class="ai-changelog-form-card">
            <form
              method="get"
              action={`/${owner}/${repo}/ai/changelog`}
              class="ai-changelog-form-row"
            >
              <div class="ai-changelog-field">
                <label class="ai-changelog-field-label" for="ai-changelog-from">
                  From
                </label>
                <input
                  id="ai-changelog-from"
                  type="text"
                  name="from"
                  list="ai-changelog-refs"
                  value={from}
                  placeholder="v1.0.0"
                  aria-label="From ref"
                  class="ai-changelog-input"
                />
              </div>
              <div class="ai-changelog-field">
                <label class="ai-changelog-field-label" for="ai-changelog-to">
                  To
                </label>
                <input
                  id="ai-changelog-to"
                  type="text"
                  name="to"
                  list="ai-changelog-refs"
                  value={to}
                  placeholder="main"
                  aria-label="To ref"
                  class="ai-changelog-input"
                />
              </div>
              <datalist id="ai-changelog-refs">
                {refChoices.map((r) => (
                  <option value={r}></option>
                ))}
              </datalist>
              <button type="submit" class="ai-changelog-submit">
                Generate
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </form>
            {refChoices.length > 0 && (
              <div class="ai-changelog-knownrefs">
                Known refs:{" "}
                {refChoices.slice(0, 20).map((r) => (
                  <code>{r}</code>
                ))}
                {refChoices.length > 20 ? " …" : ""}
              </div>
            )}
          </div>

          {!opts.error && !opts.notice && (
            <div class="ai-changelog-empty">
              <div class="ai-changelog-empty-orb" aria-hidden="true" />
              <h3>Pick a range to start</h3>
              <p>
                Two refs (branch / tag / sha) is all Claude needs to write the
                notes.
              </p>
              <div class="ai-changelog-suggests">
                <div>
                  Try: from <code>v1.0.0</code> to <code>main</code>
                </div>
                <div>
                  Or:&nbsp; from <code>HEAD~50</code> to <code>HEAD</code>
                </div>
              </div>
            </div>
          )}

          <div class="ai-changelog-poweredby">
            <span class="ai-changelog-poweredby-pill">
              <span class="dot" aria-hidden="true" />
              Powered by Claude
            </span>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </Layout>
    );

  // No range supplied — show picker.
  if (!from || !to) {
    return renderForm();
  }

  // Resolve both refs.
  const [fromSha, toSha] = await Promise.all([
    resolveRef(owner, repo, from),
    resolveRef(owner, repo, to),
  ]);
  if (!fromSha || !toSha) {
    const which =
      !fromSha && !toSha
        ? `Could not resolve refs "${from}" or "${to}".`
        : !fromSha
        ? `Could not resolve "from" ref "${from}".`
        : `Could not resolve "to" ref "${to}".`;
    return renderForm({ error: which });
  }

  // Collect commits in range.
  let commits: RangeCommit[] = [];
  try {
    commits = await commitsInRange(owner, repo, from, to);
  } catch (err) {
    return renderForm({
      error: `Failed to read commit range: ${String(
        (err as Error).message || err
      )}`,
    });
  }

  if (commits.length === 0) {
    return renderForm({
      notice: `No commits between ${from} and ${to}.`,
    });
  }

  // Hand off to Claude (or the deterministic fallback).
  let markdown = "";
  try {
    markdown = await generateChangelog(
      `${owner}/${repo}`,
      from,
      to,
      commits
    );
  } catch (err) {
    // generateChangelog has its own no-key fallback, but network/SDK
    // failures should still return a useful page rather than a 500.
    markdown =
      `## ${to} (since ${from})\n\n` +
      commits
        .map(
          (c2) =>
            `- ${c2.message.split("\n")[0]} (${c2.sha.slice(0, 7)}) — ${
              c2.author
            }`
        )
        .join("\n") +
      `\n\n_AI generation failed: ${String(
        (err as Error).message || err
      )}_`;
  }

  // CLI / CI consumers want raw Markdown.
  if (format === "markdown") {
    return c.text(markdown, 200, { "Content-Type": "text/markdown" });
  }

  const htmlBody = renderMarkdown(markdown);

  return c.html(
    <Layout title={`AI Changelog — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <IssueNav owner={owner} repo={repo} active="code" />
      <div class="ai-changelog-wrap">
        <ChangelogHero />

        <div class="ai-changelog-rangeline">
          <code>{from}</code>
          <span class="arrow">..</span>
          <code>{to}</code>
          <span class="count">
            {commits.length} commit{commits.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div class="ai-changelog-form-card">
          <form
            method="get"
            action={`/${owner}/${repo}/ai/changelog`}
            class="ai-changelog-form-row"
          >
            <div class="ai-changelog-field">
              <label class="ai-changelog-field-label" for="ai-changelog-from-2">
                From
              </label>
              <input
                id="ai-changelog-from-2"
                type="text"
                name="from"
                list="ai-changelog-refs"
                value={from}
                aria-label="From ref"
                class="ai-changelog-input"
              />
            </div>
            <div class="ai-changelog-field">
              <label class="ai-changelog-field-label" for="ai-changelog-to-2">
                To
              </label>
              <input
                id="ai-changelog-to-2"
                type="text"
                name="to"
                list="ai-changelog-refs"
                value={to}
                aria-label="To ref"
                class="ai-changelog-input"
              />
            </div>
            <datalist id="ai-changelog-refs">
              {refChoices.map((r) => (
                <option value={r}></option>
              ))}
            </datalist>
            <button type="submit" class="ai-changelog-submit">
              Regenerate
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <a
              href={`/${owner}/${repo}/ai/changelog?from=${encodeURIComponent(
                from
              )}&to=${encodeURIComponent(to)}&format=markdown`}
              class="ai-changelog-ghost"
            >
              Raw Markdown
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M15 3h6v6" />
                <path d="M10 14L21 3" />
                <path d="M19 14v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
              </svg>
            </a>
          </form>
        </div>

        <div class="ai-changelog-results">
          <section
            class="ai-changelog-panel"
            aria-labelledby="ai-changelog-rendered-title"
          >
            <header class="ai-changelog-panel-head">
              <p
                class="ai-changelog-panel-title"
                id="ai-changelog-rendered-title"
              >
                <span class="ai-changelog-panel-dot" aria-hidden="true" />
                Release notes · {from} → {to}
              </p>
            </header>
            <div class="ai-changelog-panel-body">
              <div
                class="markdown-body"
                dangerouslySetInnerHTML={{ __html: htmlBody }}
              ></div>
            </div>
          </section>

          <section
            class="ai-changelog-panel"
            aria-labelledby="ai-changelog-raw-title"
          >
            <header class="ai-changelog-panel-head">
              <p
                class="ai-changelog-panel-title"
                id="ai-changelog-raw-title"
              >
                <span class="ai-changelog-panel-dot" aria-hidden="true" />
                Copy Markdown
              </p>
              <button
                type="button"
                class="ai-changelog-copy"
                data-ai-changelog-copy
                aria-label="Copy markdown to clipboard"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span data-ai-changelog-copy-label>Copy</span>
              </button>
            </header>
            <textarea
              readonly
              rows={24}
              class="ai-changelog-raw"
              data-ai-changelog-raw
              onclick="this.select()"
            >
              {markdown}
            </textarea>
          </section>
        </div>

        <div class="ai-changelog-poweredby">
          <span class="ai-changelog-poweredby-pill">
            <span class="dot" aria-hidden="true" />
            Powered by Claude
          </span>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
    </Layout>
  );
});

export default aiChangelog;
