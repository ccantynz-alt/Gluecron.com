/**
 * AI Code Archaeology — /:owner/:repo/archaeology
 *
 * A developer can ask "why does this file exist?" and get a synthesized
 * answer from git history, PR discussions, and the issue tracker.
 *
 * GET  /:owner/:repo/archaeology              — search form
 * GET  /:owner/:repo/archaeology?file=&q=     — results page
 * GET  /:owner/:repo/archaeology?file=&q=&deep=1 — force-refresh results
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { renderMarkdown } from "../lib/markdown";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { excavate, invalidateCache } from "../lib/ai-archaeology";
import type { ArchaeologyFinding } from "../lib/ai-archaeology";

export const archaeologyRoutes = new Hono<AuthEnv>();

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS
 * ───────────────────────────────────────────────────────────────────────── */
const styles = `
  .arch-wrap { max-width: 1100px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* Hero */
  .arch-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .arch-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #c97b2e 30%, #e8a45a 70%, transparent 100%);
    opacity: 0.8;
    pointer-events: none;
  }
  .arch-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(201,123,46,0.18), rgba(232,164,90,0.08) 45%, transparent 70%);
    filter: blur(70px);
    pointer-events: none;
    z-index: 0;
  }
  .arch-hero-inner { position: relative; z-index: 1; max-width: 700px; }

  .arch-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .arch-eyebrow .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(201,123,46,0.14);
    color: #e8a45a;
    box-shadow: inset 0 0 0 1px rgba(201,123,46,0.35);
    font-size: 11px;
  }
  .arch-title {
    font-size: clamp(26px, 4vw, 38px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .arch-title-grad {
    background-image: linear-gradient(135deg, #e8a45a 0%, #c97b2e 50%, #e8a45a 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .arch-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 580px;
  }

  /* Search form */
  .arch-form {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
  }
  .arch-form-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 var(--space-3);
  }
  .arch-form-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: var(--space-2);
    align-items: end;
  }
  @media (max-width: 640px) {
    .arch-form-row { grid-template-columns: 1fr; }
  }
  .arch-form label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 4px;
    letter-spacing: 0.03em;
  }
  .arch-form input[type="text"] {
    width: 100%;
    padding: 9px 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 120ms ease;
  }
  .arch-form input[type="text"]:focus {
    border-color: #c97b2e;
    box-shadow: 0 0 0 3px rgba(201,123,46,0.12);
  }
  .arch-submit {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 18px;
    background: linear-gradient(135deg, #c97b2e 0%, #e8a45a 100%);
    color: #fff;
    border: 1px solid transparent;
    border-radius: 9px;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    box-shadow: 0 4px 12px -3px rgba(201,123,46,0.45);
    transition: transform 120ms ease, box-shadow 120ms ease;
    white-space: nowrap;
  }
  .arch-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 8px 18px -4px rgba(201,123,46,0.55);
  }

  /* Explanation panel */
  .arch-panel {
    position: relative;
    margin-bottom: var(--space-5);
    background: #ffffff;
    color: #0a0a0a;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.16);
  }
  .arch-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 18px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .arch-panel-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    font-weight: 700;
    color: #111827;
    margin: 0;
    font-family: var(--font-display, system-ui, sans-serif);
  }
  .arch-panel-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #c97b2e, #e8a45a);
    box-shadow: 0 0 0 3px rgba(201,123,46,0.18);
  }
  .arch-panel-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  /* Confidence pill */
  .arch-confidence {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .arch-confidence-high {
    background: rgba(52,211,153,0.12);
    color: #047857;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.4);
  }
  .arch-confidence-medium {
    background: rgba(251,191,36,0.12);
    color: #92400e;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.4);
  }
  .arch-confidence-low {
    background: rgba(248,113,113,0.12);
    color: #b91c1c;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.4);
  }
  .arch-confidence .dot {
    width: 5px; height: 5px;
    border-radius: 9999px;
    background: currentColor;
  }

  .arch-panel-body {
    padding: 22px 24px;
  }
  .arch-panel-body .markdown-body {
    color: #0a0a0a;
    background: #ffffff;
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
    font-size: 14.5px;
    line-height: 1.65;
  }
  .arch-panel-body .markdown-body h1,
  .arch-panel-body .markdown-body h2,
  .arch-panel-body .markdown-body h3 {
    color: #0a0a0a;
    border-bottom-color: #e5e7eb;
  }
  .arch-panel-body .markdown-body a { color: #92400e; }
  .arch-panel-body .markdown-body code {
    background: #fef3c7;
    color: #92400e;
    padding: 1px 5px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .arch-panel-body .markdown-body pre {
    background: #0f111a;
    color: #e6edf3;
    border: 1px solid #1f2330;
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
  }
  .arch-panel-body .markdown-body pre code {
    background: transparent;
    color: inherit;
    padding: 0;
  }
  .arch-panel-body .markdown-body blockquote {
    border-left: 3px solid #fcd34d;
    background: #fffbeb;
    color: #78350f;
    padding: 8px 14px;
    margin: 12px 0;
    border-radius: 6px;
  }

  /* Actions row below panel */
  .arch-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }
  .arch-dig-deeper {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    text-decoration: none;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .arch-dig-deeper:hover {
    background: var(--bg-tertiary);
    border-color: #c97b2e;
    color: #e8a45a;
  }
  .arch-file-link {
    font-size: 12.5px;
    color: var(--text-muted);
    text-decoration: none;
    font-family: var(--font-mono);
    padding: 4px 8px;
    background: var(--bg-tertiary);
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .arch-file-link:hover { color: var(--text); border-color: var(--border-strong, var(--border)); }
  .arch-analyzed-at {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-left: auto;
  }

  /* Findings timeline */
  .arch-timeline-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 var(--space-3);
    letter-spacing: -0.01em;
  }
  .arch-timeline {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .arch-finding {
    display: grid;
    grid-template-columns: 36px 1fr auto;
    align-items: start;
    gap: var(--space-3);
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    text-decoration: none;
    color: inherit;
    transition: background 100ms ease;
  }
  .arch-finding:last-child { border-bottom: none; }
  .arch-finding:hover { background: var(--bg-tertiary); }

  .arch-finding-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px; height: 28px;
    border-radius: 8px;
    font-size: 13px;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .arch-icon-commit {
    background: rgba(140,109,255,0.12);
    color: #a78bfa;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .arch-icon-pr {
    background: rgba(52,211,153,0.12);
    color: #10b981;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.28);
  }
  .arch-icon-issue {
    background: rgba(248,113,113,0.12);
    color: #f87171;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.28);
  }

  .arch-finding-body {}
  .arch-finding-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 3px;
    line-height: 1.35;
    word-break: break-word;
  }
  .arch-finding-summary {
    font-size: 12.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.45;
  }

  .arch-finding-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    font-size: 11.5px;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .arch-finding-type {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 4px;
  }
  .arch-type-commit { background: rgba(140,109,255,0.12); color: #a78bfa; }
  .arch-type-pr { background: rgba(52,211,153,0.12); color: #10b981; }
  .arch-type-issue { background: rgba(248,113,113,0.12); color: #f87171; }

  /* Empty states */
  .arch-empty {
    position: relative;
    margin: var(--space-4) 0;
    padding: var(--space-6);
    border: 1px dashed var(--border);
    border-radius: 14px;
    background: var(--bg-elevated);
    text-align: center;
    overflow: hidden;
  }
  .arch-empty-orb {
    position: absolute;
    inset: -40% 35% auto 35%;
    width: 260px; height: 260px;
    background: radial-gradient(circle, rgba(201,123,46,0.16), rgba(232,164,90,0.06) 45%, transparent 70%);
    filter: blur(55px);
    pointer-events: none;
    z-index: 0;
  }
  .arch-empty > * { position: relative; z-index: 1; }
  .arch-empty h2 {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 18px;
    color: var(--text-strong);
  }
  .arch-empty p {
    margin: 0 auto 12px;
    color: var(--text-muted);
    font-size: 14px;
    max-width: 440px;
    line-height: 1.55;
  }

  /* Powered-by pill */
  .arch-poweredby {
    margin-top: var(--space-5);
    text-align: center;
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .arch-poweredby-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    background: rgba(201,123,46,0.08);
    border: 1px solid rgba(201,123,46,0.22);
    color: var(--text-muted);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .arch-poweredby-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #c97b2e, #e8a45a);
  }

  :root[data-theme='light'] .arch-panel {
    box-shadow: 0 1px 0 rgba(0,0,0,0.02), 0 8px 28px rgba(15,16,28,0.08);
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedRepo {
  ownerId: string;
  repoId: string;
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

    return { ownerId: ownerRow.id, repoId: repoRow.id };
  } catch {
    return null;
  }
}

function findingIcon(type: ArchaeologyFinding["type"]): string {
  if (type === "commit") return "◆"; // diamond
  if (type === "pr") return "↪";    // right arrow hook
  return "!";                            // issue
}

function confidenceLabel(conf: "high" | "medium" | "low"): string {
  if (conf === "high") return "High confidence";
  if (conf === "medium") return "Medium confidence";
  return "Low confidence";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

archaeologyRoutes.get("/:owner/:repo/archaeology", softAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const filePath = c.req.query("file") ?? "";
  const query = c.req.query("q") ?? "Why does this code exist?";
  const deep = c.req.query("deep") === "1";

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

  // Search form view (no file param)
  if (!filePath) {
    return c.html(
      <Layout title={`Archaeology — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <RepoNav owner={owner} repo={repo} active="archaeology" />
        <div class="arch-wrap">
          <section class="arch-hero">
            <div class="arch-hero-orb" aria-hidden="true" />
            <div class="arch-hero-inner">
              <div class="arch-eyebrow">
                <span class="pill" aria-hidden="true">{"🏛"}</span>
                AI · gluecron · archaeology
              </div>
              <h1 class="arch-title">
                <span class="arch-title-grad">Archaeology.</span>
              </h1>
              <p class="arch-sub">
                Ask why any file exists. Claude searches git history, pull
                requests, and issues to reconstruct the original motivation
                and key decisions.
              </p>
            </div>
          </section>

          <div class="arch-form">
            <p class="arch-form-title">Excavate a file</p>
            <form method="get" action={`/${owner}/${repo}/archaeology`}>
              <div class="arch-form-row">
                <div>
                  <label for="arch-file">File path</label>
                  <input
                    id="arch-file"
                    type="text"
                    name="file"
                    placeholder="src/lib/auth.ts"
                    required
                    autocomplete="off"
                    spellcheck={false as any}
                  />
                </div>
                <div>
                  <label for="arch-q">Question (optional)</label>
                  <input
                    id="arch-q"
                    type="text"
                    name="q"
                    placeholder="Why does this exist?"
                    autocomplete="off"
                  />
                </div>
                <div>
                  <button type="submit" class="arch-submit">
                    {"🏛"} Dig
                  </button>
                </div>
              </div>
            </form>
          </div>

          <div class="arch-poweredby">
            <span class="arch-poweredby-pill">
              <span class="dot" aria-hidden="true" />
              Powered by Claude
            </span>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </Layout>
    );
  }

  // Results view — excavate
  if (deep) {
    invalidateCache(resolved.repoId, filePath);
  }

  const report = await excavate(owner, repo, resolved.repoId, filePath, query);

  const deepUrl = `/${owner}/${repo}/archaeology?file=${encodeURIComponent(filePath)}&q=${encodeURIComponent(query)}&deep=1`;
  const fileUrl = `/${owner}/${repo}/blob/HEAD/${filePath}`;
  const analyzedAt = report.analyzedAt.toUTCString().replace(" GMT", " UTC");

  return c.html(
    <Layout title={`Archaeology: ${filePath} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="archaeology" />
      <div class="arch-wrap">
        <section class="arch-hero">
          <div class="arch-hero-orb" aria-hidden="true" />
          <div class="arch-hero-inner">
            <div class="arch-eyebrow">
              <span class="pill" aria-hidden="true">{"🏛"}</span>
              AI · gluecron · archaeology
            </div>
            <h1 class="arch-title">
              <span class="arch-title-grad">Archaeology.</span>
            </h1>
            <p class="arch-sub">
              Why does <code style="font-family:var(--font-mono);font-size:13px;background:var(--bg-tertiary);padding:1px 6px;border-radius:4px;color:var(--text)">{filePath}</code> exist?
            </p>
          </div>
        </section>

        {/* Search form (pre-filled) */}
        <div class="arch-form">
          <p class="arch-form-title">Refine your question</p>
          <form method="get" action={`/${owner}/${repo}/archaeology`}>
            <div class="arch-form-row">
              <div>
                <label for="arch-file2">File path</label>
                <input
                  id="arch-file2"
                  type="text"
                  name="file"
                  value={filePath}
                  required
                  autocomplete="off"
                  spellcheck={false as any}
                />
              </div>
              <div>
                <label for="arch-q2">Question</label>
                <input
                  id="arch-q2"
                  type="text"
                  name="q"
                  value={query}
                  autocomplete="off"
                />
              </div>
              <div>
                <button type="submit" class="arch-submit">
                  {"🏛"} Dig
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Explanation panel */}
        <section class="arch-panel" aria-label="AI explanation">
          <header class="arch-panel-head">
            <p class="arch-panel-title">
              <span class="arch-panel-dot" aria-hidden="true" />
              Explanation
            </p>
            <div class="arch-panel-meta">
              <span
                class={`arch-confidence arch-confidence-${report.confidence}`}
              >
                <span class="dot" aria-hidden="true" />
                {confidenceLabel(report.confidence)}
              </span>
            </div>
          </header>
          <div class="arch-panel-body">
            <div class="markdown-body">
              {html(
                [renderMarkdown(report.explanation)] as unknown as TemplateStringsArray
              )}
            </div>
          </div>
        </section>

        {/* Actions */}
        <div class="arch-actions">
          <a href={deepUrl} class="arch-dig-deeper">
            {"🔍"} Dig deeper
          </a>
          <a href={fileUrl} class="arch-file-link">
            {filePath}
          </a>
          <span class="arch-analyzed-at">Analyzed {analyzedAt}</span>
        </div>

        {/* Findings timeline */}
        {report.findings.length > 0 ? (
          <>
            <h2 class="arch-timeline-title">Evidence timeline</h2>
            <div class="arch-timeline">
              {report.findings.map((f) => (
                <a
                  href={f.url}
                  class="arch-finding"
                  key={`${f.type}-${f.id}`}
                >
                  <span
                    class={`arch-finding-icon arch-icon-${f.type}`}
                    aria-label={f.type}
                  >
                    {findingIcon(f.type)}
                  </span>
                  <div class="arch-finding-body">
                    <p class="arch-finding-title">{f.title}</p>
                    <p class="arch-finding-summary">{f.summary}</p>
                  </div>
                  <div class="arch-finding-meta">
                    <span class={`arch-finding-type arch-type-${f.type}`}>
                      {f.type}
                    </span>
                    <span>{f.date ? f.date.slice(0, 10) : ""}</span>
                    {f.author ? <span>{f.author}</span> : null}
                  </div>
                </a>
              ))}
            </div>
          </>
        ) : (
          <div class="arch-empty">
            <div class="arch-empty-orb" aria-hidden="true" />
            <h2>No supporting evidence found</h2>
            <p>
              No commits, pull requests, or issues mentioning{" "}
              <strong>{filePath.split("/").pop()}</strong> were found in this
              repository. The explanation above was generated from file content
              alone.
            </p>
          </div>
        )}

        <div class="arch-poweredby">
          <span class="arch-poweredby-pill">
            <span class="dot" aria-hidden="true" />
            Powered by Claude
          </span>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

export default archaeologyRoutes;
