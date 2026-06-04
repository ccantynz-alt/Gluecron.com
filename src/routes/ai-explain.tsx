/**
 * Block D6 — "Explain this codebase" route.
 *
 *   GET  /:owner/:repo/explain                 — render cached (or freshly
 *                                                 generated on first visit)
 *                                                 Markdown explanation
 *   POST /:owner/:repo/explain/regenerate      — owner-only; force-regenerate
 *                                                 and redirect back
 *
 * Heavy lifting lives in `lib/ai-explain.ts`; this file is just HTTP glue.
 *
 * 2026 polish (visual only — every form action / POST target / AI prompt
 * call is preserved verbatim):
 *   - .ai-explain-wrap max-width 980px + gradient-hairline hero w/ orb
 *   - Display headline ends in a gradient "Explain." verb
 *   - White result panel (mirrors admin-integrations spec block) with
 *     monospace and an inline copy-to-clipboard button
 *   - Loading shimmer skeleton (kept available for future async modes) +
 *     dashed empty-state cards
 *   - "Powered by Claude" subtle pill at the bottom
 * CSS is scoped under `.ai-explain-*` so it can't bleed into ai-changelog
 * or ai-tests if they're rendered on the same Layout in another surface.
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getDefaultBranch, resolveRef } from "../git/repository";
import {
  explainCodebase,
  getCachedExplanation,
} from "../lib/ai-explain";

const aiExplainRoutes = new Hono<AuthEnv>();

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.ai-explain-` so this surface can't
 * bleed into the wider `.ai-changelog-*` or `.ai-tests-*` polish. Mirrors
 * the gradient-hairline hero + white-spec-block patterns from
 * admin-integrations.tsx / build-agent-spec.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .ai-explain-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .ai-explain-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ai-explain-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ai-explain-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .ai-explain-hero-inner { position: relative; z-index: 1; max-width: 720px; }

  .ai-explain-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .ai-explain-eyebrow .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }

  .ai-explain-title {
    font-size: clamp(28px, 4vw, 42px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .ai-explain-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ai-explain-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  .ai-explain-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .ai-explain-meta code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11.5px;
    color: var(--text);
  }
  .ai-explain-meta .ai-explain-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: rgba(52,211,153,0.12);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .ai-explain-meta .ai-explain-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }

  .ai-explain-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-4) 0 var(--space-3);
    flex-wrap: wrap;
  }
  .ai-explain-actions h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .ai-explain-regen {
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
    text-decoration: none;
    cursor: pointer;
    box-shadow: 0 6px 16px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    font-family: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .ai-explain-regen:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .ai-explain-regen svg { display: block; }

  /* Solid white panel — the codebase explanation reads like a printed
     report on the dark theme. */
  .ai-explain-panel {
    position: relative;
    margin-bottom: var(--space-5);
    background: #ffffff;
    color: #0a0a0a;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.18);
  }
  .ai-explain-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .ai-explain-panel-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display, system-ui, sans-serif);
    font-size: 14px;
    font-weight: 700;
    color: #111827;
    letter-spacing: -0.005em;
    margin: 0;
  }
  .ai-explain-panel-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .ai-explain-copy {
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
  .ai-explain-copy:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
  .ai-explain-copy.is-copied {
    background: #ecfdf5;
    border-color: #6ee7b7;
    color: #047857;
  }
  .ai-explain-copy svg { display: block; }

  .ai-explain-panel-body {
    padding: 22px 24px;
    background: #ffffff;
    color: #0a0a0a;
  }
  /* Tame the .markdown-body inside the white panel — its dark-theme
     defaults (light text on dark bg) would be invisible here. */
  .ai-explain-panel-body .markdown-body {
    color: #0a0a0a;
    background: #ffffff;
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
    font-size: 14.5px;
    line-height: 1.65;
  }
  .ai-explain-panel-body .markdown-body h1,
  .ai-explain-panel-body .markdown-body h2,
  .ai-explain-panel-body .markdown-body h3,
  .ai-explain-panel-body .markdown-body h4 {
    color: #0a0a0a;
    border-bottom-color: #e5e7eb;
  }
  .ai-explain-panel-body .markdown-body a { color: #4338ca; }
  .ai-explain-panel-body .markdown-body code {
    background: #eef2ff;
    color: #4338ca;
    padding: 1px 5px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .ai-explain-panel-body .markdown-body pre {
    background: #0f111a;
    color: #e6edf3;
    border: 1px solid #1f2330;
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
  }
  .ai-explain-panel-body .markdown-body pre code {
    background: transparent;
    color: inherit;
    padding: 0;
  }
  .ai-explain-panel-body .markdown-body blockquote {
    border-left: 3px solid #c7d2fe;
    background: #f5f3ff;
    color: #4b5563;
    padding: 8px 14px;
    margin: 12px 0;
    border-radius: 6px;
  }

  /* Empty-state — dashed card w/ orb + "try" suggestions. */
  .ai-explain-empty {
    position: relative;
    margin: var(--space-4) 0;
    padding: var(--space-6);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    background: var(--bg-elevated);
    text-align: center;
    overflow: hidden;
  }
  .ai-explain-empty-orb {
    position: absolute;
    inset: -40% 35% auto 35%;
    width: 280px; height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
    z-index: 0;
  }
  .ai-explain-empty > * { position: relative; z-index: 1; }
  .ai-explain-empty h2 {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 19px;
    color: var(--text-strong);
  }
  .ai-explain-empty p {
    margin: 0 auto 12px;
    color: var(--text-muted);
    font-size: 14px;
    max-width: 480px;
    line-height: 1.55;
  }
  .ai-explain-empty .ai-explain-suggest {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin-top: 12px;
    text-align: left;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .ai-explain-empty .ai-explain-suggest code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    padding: 2px 7px;
    border-radius: 4px;
    color: var(--text);
  }

  /* Powered-by-Claude pill at the bottom. */
  .ai-explain-poweredby {
    margin-top: var(--space-5);
    text-align: center;
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .ai-explain-poweredby-pill {
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
  .ai-explain-poweredby-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
  }

  /* Loading shimmer skeleton — kept available for future async modes. */
  @keyframes ai-explain-shimmer {
    0% { background-position: -300px 0; }
    100% { background-position: 300px 0; }
  }
  .ai-explain-skeleton {
    height: 14px;
    border-radius: 4px;
    background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(140,109,255,0.08) 50%, rgba(255,255,255,0.04) 100%);
    background-size: 600px 100%;
    animation: ai-explain-shimmer 1.4s linear infinite;
    margin-bottom: 10px;
  }

  /* Light-theme: the white panel already pops; just soften the shadow. */
  :root[data-theme='light'] .ai-explain-panel {
    box-shadow: 0 1px 0 rgba(0,0,0,0.02), 0 8px 28px rgba(15,16,28,0.08);
  }
`;

// Inline copy-to-clipboard handler — reuses the data-attr pattern from
// admin-integrations.tsx. Safe to embed because listeners are attached by
// data-attr selector.
const COPY_SCRIPT = `
  (function(){
    var btn = document.querySelector('[data-ai-explain-copy]');
    var src = document.querySelector('[data-ai-explain-text]');
    var label = document.querySelector('[data-ai-explain-copy-label]');
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

async function resolveHeadSha(
  owner: string,
  repo: string
): Promise<string | null> {
  const branch = await getDefaultBranch(owner, repo);
  if (!branch) return null;
  return resolveRef(owner, repo, branch);
}

aiExplainRoutes.get(
  "/:owner/:repo/explain",
  softAuth,
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user");

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

    const sha = await resolveHeadSha(owner, repo);
    if (!sha) {
      return c.html(
        <Layout title={`Explain — ${owner}/${repo}`} user={user}>
          <RepoHeader owner={owner} repo={repo} />
          <IssueNav owner={owner} repo={repo} active="code" />
          <div class="ai-explain-wrap">
            <section class="ai-explain-hero">
              <div class="ai-explain-hero-orb" aria-hidden="true" />
              <div class="ai-explain-hero-inner">
                <div class="ai-explain-eyebrow">
                  <span class="pill" aria-hidden="true">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </span>
                  AI · gluecron · explain
                </div>
                <h1 class="ai-explain-title">
                  <span class="ai-explain-title-grad">Explain.</span>
                </h1>
                <p class="ai-explain-sub">
                  Once you push code to <code style="font-family:var(--font-mono);font-size:13px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">{repo}</code>,
                  Claude will read the default branch and write a plain-English
                  tour of the architecture, key modules, and how to get started.
                </p>
              </div>
            </section>
            <div class="ai-explain-empty">
              <div class="ai-explain-empty-orb" aria-hidden="true" />
              <h2>No commits yet</h2>
              <p>
                Push some code to <code>{repo}</code> and check back — the
                explanation is generated from the default branch.
              </p>
              <div class="ai-explain-suggest">
                <span>Try:</span>
                <code>git push origin main</code>
              </div>
            </div>
            <div class="ai-explain-poweredby">
              <span class="ai-explain-poweredby-pill">
                <span class="dot" aria-hidden="true" />
                Powered by Claude
              </span>
            </div>
          </div>
          <style dangerouslySetInnerHTML={{ __html: styles }} />
        </Layout>
      );
    }

    // Prefer cache first to avoid calling the AI on every page load.
    let result = await getCachedExplanation(resolved.repoId, sha);
    if (!result) {
      result = await explainCodebase({
        owner,
        repo,
        repositoryId: resolved.repoId,
        commitSha: sha,
      });
    }

    const canRegenerate = !!user && user.id === resolved.ownerId;

    return c.html(
      <Layout title={`Explain — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <IssueNav owner={owner} repo={repo} active="code" />
        <div class="ai-explain-wrap">
          <section class="ai-explain-hero">
            <div class="ai-explain-hero-orb" aria-hidden="true" />
            <div class="ai-explain-hero-inner">
              <div class="ai-explain-eyebrow">
                <span class="pill" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </span>
                AI · gluecron · explain
              </div>
              <h1 class="ai-explain-title">
                <span class="ai-explain-title-grad">Explain.</span>{" "}
                <span style="color:var(--text-strong)">
                  {owner}/{repo}
                </span>
              </h1>
              <p class="ai-explain-sub">
                A plain-English tour of this codebase — architecture, key
                modules, and how to get started. Generated by Claude from the
                default branch.
              </p>
            </div>
          </section>

          <div class="ai-explain-meta">
            <span>
              Commit <code>{sha.slice(0, 7)}</code>
            </span>
            <span>·</span>
            <span>
              Model <code>{result.model}</code>
            </span>
            {result.cached && (
              <span class="ai-explain-pill">
                <span class="dot" aria-hidden="true" />
                cached
              </span>
            )}
          </div>

          <div class="ai-explain-actions">
            <h2>Codebase explanation</h2>
            {canRegenerate && (
              <form
                method="post"
                action={`/${owner}/${repo}/explain/regenerate`}
                style="display: inline"
              >
                <button type="submit" class="ai-explain-regen">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  Regenerate
                </button>
              </form>
            )}
          </div>

          <section class="ai-explain-panel" aria-labelledby="ai-explain-panel-title">
            <header class="ai-explain-panel-head">
              <p class="ai-explain-panel-title" id="ai-explain-panel-title">
                <span class="ai-explain-panel-dot" aria-hidden="true" />
                Explanation · {owner}/{repo}
              </p>
              <button
                type="button"
                class="ai-explain-copy"
                data-ai-explain-copy
                aria-label="Copy explanation to clipboard"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span data-ai-explain-copy-label>Copy</span>
              </button>
            </header>
            <div class="ai-explain-panel-body" data-ai-explain-text>
              <div class="markdown-body">
                {html(
                  [renderMarkdown(result.markdown)] as unknown as TemplateStringsArray
                )}
              </div>
            </div>
          </section>

          <div class="ai-explain-poweredby">
            <span class="ai-explain-poweredby-pill">
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

aiExplainRoutes.post(
  "/:owner/:repo/explain/regenerate",
  requireAuth,
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.notFound();

    if (resolved.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/explain`);
    }

    const sha = await resolveHeadSha(owner, repo);
    if (!sha) {
      return c.redirect(`/${owner}/${repo}/explain`);
    }

    // Run synchronously so the redirect lands on a fresh result. The helper
    // itself never throws; worst case the user sees the fallback copy.
    await explainCodebase({
      owner,
      repo,
      repositoryId: resolved.repoId,
      commitSha: sha,
      force: true,
    });

    return c.redirect(`/${owner}/${repo}/explain`);
  }
);

export default aiExplainRoutes;
