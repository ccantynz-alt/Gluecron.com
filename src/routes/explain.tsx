/**
 * "Explain This Repo" — AI-powered codebase analysis dashboard.
 *
 * Routes:
 *   GET  /:owner/:repo/explain              — landing / cached result
 *   POST /:owner/:repo/explain              — trigger analysis, redirect to job page
 *   GET  /:owner/:repo/explain/:jobId       — progress polling / result page
 *   GET  /:owner/:repo/explain/:jobId/raw   — JSON result
 *
 * Analysis runs asynchronously in the background. The result page
 * polls with a meta-refresh every 3 seconds while status=running.
 * Completed results are cached in `repo_explain_cache` (DB) and served
 * directly on subsequent visits.
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { renderMarkdown } from "../lib/markdown";
import {
  explainJobs,
  startExplainJob,
  getCachedExplainResult,
  resolveRepoForExplain,
} from "../lib/repo-explainer";
import type { ExplainJobResult, ExplainJob } from "../lib/repo-explainer";

const explainRoutes = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Scoped CSS
// ---------------------------------------------------------------------------

const STYLES = `
  .explain-wrap { max-width: 1040px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ── Hero ── */
  .explain-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .explain-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .explain-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(90px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .explain-hero-inner { position: relative; z-index: 1; }
  .explain-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .explain-eyebrow .pill {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .explain-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .explain-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .explain-sub {
    font-size: 15px; color: var(--text-muted);
    margin: 0 0 var(--space-4);
    line-height: 1.55; max-width: 620px;
  }
  .explain-trigger-btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 11px 22px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    border: 1px solid transparent;
    border-radius: 10px;
    font-size: 14px; font-weight: 600;
    text-decoration: none; cursor: pointer;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    font-family: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .explain-trigger-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .explain-trigger-btn svg { display: block; }

  /* ── Progress / running state ── */
  .explain-progress {
    display: flex; align-items: flex-start; gap: var(--space-4);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
  }
  .explain-spinner {
    width: 36px; height: 36px; flex-shrink: 0;
    border: 3px solid rgba(140,109,255,0.18);
    border-top-color: #8c6dff;
    border-radius: 50%;
    animation: explain-spin 0.8s linear infinite;
  }
  @keyframes explain-spin {
    to { transform: rotate(360deg); }
  }
  .explain-progress-text h3 {
    margin: 0 0 4px;
    font-size: 15px; font-weight: 700; color: var(--text-strong);
  }
  .explain-progress-text p {
    margin: 0; font-size: 13px; color: var(--text-muted); line-height: 1.5;
  }

  /* ── Error state ── */
  .explain-error {
    padding: var(--space-5);
    background: rgba(239,68,68,0.07);
    border: 1px solid rgba(239,68,68,0.25);
    border-radius: 14px;
    color: #ef4444;
    margin-bottom: var(--space-5);
  }
  .explain-error h3 { margin: 0 0 6px; font-size: 15px; }
  .explain-error p { margin: 0; font-size: 13px; opacity: 0.9; }

  /* ── Result dashboard ── */
  .explain-dashboard {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  @media (max-width: 680px) {
    .explain-dashboard { grid-template-columns: 1fr; }
  }

  .explain-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .explain-card-full { grid-column: 1 / -1; }
  .explain-card-head {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border);
  }
  .explain-card-icon {
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 6px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    flex-shrink: 0;
  }
  .explain-card-title {
    font-size: 13px; font-weight: 700;
    color: var(--text-strong);
    margin: 0;
    letter-spacing: -0.01em;
  }
  .explain-card-body { padding: 16px; }

  /* Summary */
  .explain-summary-text {
    font-size: 14.5px; line-height: 1.65; color: var(--text);
    margin: 0;
  }

  /* Health score */
  .explain-health-score {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 14px;
    border-radius: 10px;
    font-size: 15px; font-weight: 700;
    margin-bottom: 10px;
  }
  .explain-health-score.elite    { background: rgba(52,211,153,0.12); color: #10b981; border: 1px solid rgba(52,211,153,0.28); }
  .explain-health-score.strong   { background: rgba(96,165,250,0.12); color: #3b82f6; border: 1px solid rgba(96,165,250,0.28); }
  .explain-health-score.improving { background: rgba(251,191,36,0.12); color: #f59e0b; border: 1px solid rgba(251,191,36,0.28); }
  .explain-health-score.needs-attention { background: rgba(239,68,68,0.12); color: #ef4444; border: 1px solid rgba(239,68,68,0.28); }
  .explain-health-dot {
    width: 8px; height: 8px; border-radius: 50%; background: currentColor;
  }
  .explain-health-desc { font-size: 12.5px; color: var(--text-muted); line-height: 1.5; margin: 0; }

  /* Tech stack chips */
  .explain-chips {
    display: flex; flex-wrap: wrap; gap: 8px;
  }
  .explain-chip {
    display: inline-flex; align-items: center;
    padding: 4px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 12px; font-weight: 600;
    color: var(--text);
  }

  /* Architecture — rendered markdown inside dark card */
  .explain-arch-body {
    font-size: 13.5px; line-height: 1.65; color: var(--text);
  }
  .explain-arch-body .markdown-body {
    color: var(--text);
    background: transparent;
    font-size: 13.5px;
  }
  .explain-arch-body .markdown-body h1,
  .explain-arch-body .markdown-body h2,
  .explain-arch-body .markdown-body h3 {
    color: var(--text-strong);
    border-bottom-color: var(--border);
  }
  .explain-arch-body .markdown-body a { color: var(--link); }
  .explain-arch-body .markdown-body code {
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 1px 5px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .explain-arch-body .markdown-body pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
  }
  .explain-arch-body .markdown-body pre code {
    background: transparent; color: inherit; padding: 0;
  }

  /* Entry points table */
  .explain-ep-table {
    width: 100%; border-collapse: collapse;
    font-size: 13px;
  }
  .explain-ep-table th {
    text-align: left; padding: 6px 10px;
    font-size: 11px; font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border);
  }
  .explain-ep-table td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    color: var(--text);
  }
  .explain-ep-table tr:last-child td { border-bottom: none; }
  .explain-ep-table td:first-child {
    font-family: var(--font-mono); font-size: 12px;
    color: var(--text-strong);
    white-space: nowrap;
  }
  .explain-ep-table a { color: var(--link); text-decoration: none; }
  .explain-ep-table a:hover { text-decoration: underline; }

  /* Getting started — rendered markdown */
  .explain-gs-body .markdown-body {
    color: var(--text);
    background: transparent;
    font-size: 13.5px;
    line-height: 1.65;
  }
  .explain-gs-body .markdown-body code {
    background: var(--bg-tertiary);
    color: var(--text);
    padding: 1px 5px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .explain-gs-body .markdown-body pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
  }
  .explain-gs-body .markdown-body pre code {
    background: transparent; color: inherit; padding: 0;
  }

  /* Suggested issues cards */
  .explain-issues { display: flex; flex-direction: column; gap: 10px; }
  .explain-issue-card {
    padding: 12px 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .explain-issue-card h4 {
    margin: 0 0 4px;
    font-size: 13.5px; font-weight: 700; color: var(--text-strong);
  }
  .explain-issue-card p {
    margin: 0 0 10px;
    font-size: 12.5px; color: var(--text-muted); line-height: 1.55;
  }
  .explain-issue-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px; font-weight: 600;
    color: var(--text);
    text-decoration: none;
    cursor: pointer; font-family: inherit;
    transition: background 100ms ease, border-color 100ms ease;
  }
  .explain-issue-btn:hover {
    background: var(--bg-tertiary);
    border-color: var(--border-strong, var(--border));
  }

  /* Share + actions bar */
  .explain-actions-bar {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .explain-share-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 13px; font-weight: 600;
    color: var(--text); text-decoration: none;
    cursor: pointer; font-family: inherit;
    transition: background 100ms ease;
  }
  .explain-share-btn:hover { background: var(--bg-tertiary); }

  /* Powered-by */
  .explain-poweredby {
    margin-top: var(--space-5);
    text-align: center;
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .explain-poweredby-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.08);
    border: 1px solid rgba(140,109,255,0.22);
    color: var(--text-muted);
    font-size: 11px; letter-spacing: 0.04em;
    text-transform: uppercase; font-weight: 600;
  }
  .explain-poweredby-pill .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
  }

  /* Cached badge */
  .explain-cached-pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 8px; border-radius: 9999px;
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase;
    background: rgba(52,211,153,0.12); color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .explain-cached-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
`;

// ---------------------------------------------------------------------------
// Shared repo resolution
// ---------------------------------------------------------------------------

async function resolveRepo(owner: string, repo: string) {
  const [ownerRow] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.username, owner))
    .limit(1);
  if (!ownerRow) return null;

  const [repoRow] = await db
    .select({ id: repositories.id, ownerId: repositories.ownerId })
    .from(repositories)
    .where(and(eq(repositories.ownerId, ownerRow.id), eq(repositories.name, repo)))
    .limit(1);
  if (!repoRow) return null;

  return { repoId: repoRow.id, ownerId: repoRow.ownerId, ownerUsername: ownerRow.username };
}

// ---------------------------------------------------------------------------
// Shared page scaffolding helpers
// ---------------------------------------------------------------------------

function HealthBadge({ score }: { score: string }) {
  const cls = {
    "Elite": "elite",
    "Strong": "strong",
    "Improving": "improving",
    "Needs Attention": "needs-attention",
  }[score] ?? "improving";
  const emoji = {
    "Elite": "★",
    "Strong": "●",
    "Improving": "◐",
    "Needs Attention": "○",
  }[score] ?? "●";
  return (
    <span class={`explain-health-score ${cls}`}>
      <span class="explain-health-dot" aria-hidden="true" />
      {emoji} {score}
    </span>
  );
}

function TechChips({ stack }: { stack: string[] }) {
  return (
    <div class="explain-chips">
      {stack.map((t) => <span class="explain-chip">{t}</span>)}
    </div>
  );
}

function ResultDashboard({
  result,
  owner,
  repo,
  cached,
}: {
  result: ExplainJobResult;
  owner: string;
  repo: string;
  cached?: boolean;
}) {
  const issueNewBase = `/${owner}/${repo}/issues/new`;
  return (
    <>
      <div class="explain-actions-bar">
        {cached && (
          <span class="explain-cached-pill">
            <span class="dot" />
            cached
          </span>
        )}
        <a
          href={`/share/${owner}`}
          class="explain-share-btn"
          title="Share this analysis"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          Share analysis
        </a>
      </div>

      <div class="explain-dashboard">
        {/* Summary */}
        <div class="explain-card explain-card-full">
          <div class="explain-card-head">
            <span class="explain-card-icon" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </span>
            <p class="explain-card-title">Summary</p>
          </div>
          <div class="explain-card-body">
            <p class="explain-summary-text">{result.summary}</p>
          </div>
        </div>

        {/* Health Score */}
        <div class="explain-card">
          <div class="explain-card-head">
            <span class="explain-card-icon" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </span>
            <p class="explain-card-title">Health Score</p>
          </div>
          <div class="explain-card-body">
            <HealthBadge score={result.healthScore} />
            <p class="explain-health-desc">
              Based on code quality signals visible in the repository — tests, documentation, type coverage, and CI configuration.
            </p>
          </div>
        </div>

        {/* Tech Stack */}
        <div class="explain-card">
          <div class="explain-card-head">
            <span class="explain-card-icon" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
            </span>
            <p class="explain-card-title">Tech Stack</p>
          </div>
          <div class="explain-card-body">
            {result.techStack.length > 0
              ? <TechChips stack={result.techStack} />
              : <p style="color:var(--text-muted);font-size:13px;margin:0">No tech stack detected.</p>
            }
          </div>
        </div>

        {/* Architecture */}
        <div class="explain-card explain-card-full">
          <div class="explain-card-head">
            <span class="explain-card-icon" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
              </svg>
            </span>
            <p class="explain-card-title">Architecture</p>
          </div>
          <div class="explain-card-body">
            <div class="explain-arch-body">
              <div class="markdown-body">
                {html([renderMarkdown(result.architecture)] as unknown as TemplateStringsArray)}
              </div>
            </div>
          </div>
        </div>

        {/* Entry Points */}
        <div class="explain-card explain-card-full">
          <div class="explain-card-head">
            <span class="explain-card-icon" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </span>
            <p class="explain-card-title">Key Entry Points</p>
          </div>
          <div class="explain-card-body">
            {result.entryPoints.length > 0 ? (
              <table class="explain-ep-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {result.entryPoints.map((ep) => (
                    <tr>
                      <td>
                        <a href={`/${owner}/${repo}/blob/main/${ep.file}`}>
                          {ep.file}
                        </a>
                      </td>
                      <td>{ep.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style="color:var(--text-muted);font-size:13px;margin:0">No entry points detected.</p>
            )}
          </div>
        </div>

        {/* Getting Started */}
        <div class="explain-card explain-card-full">
          <div class="explain-card-head">
            <span class="explain-card-icon" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </span>
            <p class="explain-card-title">Getting Started</p>
          </div>
          <div class="explain-card-body">
            <div class="explain-gs-body">
              <div class="markdown-body">
                {html([renderMarkdown(result.gettingStarted)] as unknown as TemplateStringsArray)}
              </div>
            </div>
          </div>
        </div>

        {/* Suggested Issues */}
        <div class="explain-card explain-card-full">
          <div class="explain-card-head">
            <span class="explain-card-icon" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </span>
            <p class="explain-card-title">Suggested First Tasks</p>
          </div>
          <div class="explain-card-body">
            {result.suggestedIssues.length > 0 ? (
              <div class="explain-issues">
                {result.suggestedIssues.map((issue) => {
                  const params = new URLSearchParams({
                    title: issue.title,
                    body: issue.description,
                  });
                  return (
                    <div class="explain-issue-card">
                      <h4>{issue.title}</h4>
                      <p>{issue.description}</p>
                      <a
                        href={`${issueNewBase}?${params.toString()}`}
                        class="explain-issue-btn"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="12" y1="8" x2="12" y2="16" />
                          <line x1="8" y1="12" x2="16" y2="12" />
                        </svg>
                        Open Issue
                      </a>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style="color:var(--text-muted);font-size:13px;margin:0">No suggestions generated.</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Route: GET /:owner/:repo/explain — landing page or cached result
// ---------------------------------------------------------------------------

explainRoutes.get("/:owner/:repo/explain", softAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="container" style="padding: var(--space-6);">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const cached = await getCachedExplainResult(resolved.repoId);
  const canTrigger = !!user;

  return c.html(
    <Layout title={`Explain — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <div class="explain-wrap">
        <section class="explain-hero">
          <div class="explain-hero-orb" aria-hidden="true" />
          <div class="explain-hero-inner">
            <div class="explain-eyebrow">
              <span class="pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </span>
              AI · gluecron · explain
            </div>
            <h1 class="explain-title">
              <span class="explain-title-grad">Explain</span>{" "}
              <span style="color:var(--text-strong)">{owner}/{repo}</span>
            </h1>
            <p class="explain-sub">
              One click — AI reads the entire codebase and generates an architecture overview,
              tech stack analysis, key entry points, onboarding guide, and suggested first tasks.
            </p>

            {!cached && (
              canTrigger ? (
                <form method="post" action={`/${owner}/${repo}/explain`} style="display:inline">
                  <button type="submit" class="explain-trigger-btn">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    Explain This Repo
                  </button>
                </form>
              ) : (
                <a href="/login" class="explain-trigger-btn">
                  Sign in to explain this repo
                </a>
              )
            )}

            {cached && (
              <form method="post" action={`/${owner}/${repo}/explain`} style="display:inline">
                <button type="submit" class="explain-trigger-btn" style="background:var(--bg-elevated);color:var(--text);border:1px solid var(--border);box-shadow:none">
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
        </section>

        {cached ? (
          <ResultDashboard result={cached} owner={owner} repo={repo} cached />
        ) : (
          <div style="padding:var(--space-6);text-align:center;color:var(--text-muted);font-size:14px;">
            No analysis yet. Click "Explain This Repo" to generate one.
          </div>
        )}

        <div class="explain-poweredby">
          <span class="explain-poweredby-pill">
            <span class="dot" aria-hidden="true" />
            Powered by Claude
          </span>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// Route: POST /:owner/:repo/explain — trigger analysis
// ---------------------------------------------------------------------------

explainRoutes.post("/:owner/:repo/explain", softAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!user) {
    return c.redirect(`/login`);
  }

  const resolved = await resolveRepo(owner, repo);
  if (!resolved) return c.notFound();

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  startExplainJob(jobId, owner, repo, resolved.repoId);

  return c.redirect(`/${owner}/${repo}/explain/${jobId}`);
});

// ---------------------------------------------------------------------------
// Route: GET /:owner/:repo/explain/:jobId/raw — JSON result
// ---------------------------------------------------------------------------

explainRoutes.get("/:owner/:repo/explain/:jobId/raw", async (c) => {
  const { jobId } = c.req.param();
  const job = explainJobs.get(jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// ---------------------------------------------------------------------------
// Route: GET /:owner/:repo/explain/:jobId — progress / result page
// ---------------------------------------------------------------------------

explainRoutes.get("/:owner/:repo/explain/:jobId", softAuth, async (c) => {
  const { owner, repo, jobId } = c.req.param();
  const user = c.get("user");

  const job = explainJobs.get(jobId);
  if (!job) {
    return c.html(
      <Layout title="Job not found" user={user}>
        <div class="container" style="padding:var(--space-6)">
          <h2>Analysis job not found</h2>
          <p>
            The job may have expired. <a href={`/${owner}/${repo}/explain`}>Start a new analysis</a>.
          </p>
        </div>
      </Layout>,
      404
    );
  }

  const isRunning = job.status === "running";
  const isFailed = job.status === "failed";
  const isDone = job.status === "done";

  return c.html(
    <Layout title={`Explain — ${owner}/${repo}`} user={user}>
      {/* Auto-refresh while running */}
      {isRunning && (
        <meta http-equiv="refresh" content={`3;url=/${owner}/${repo}/explain/${jobId}`} />
      )}
      <RepoHeader owner={owner} repo={repo} />
      <div class="explain-wrap">
        <section class="explain-hero">
          <div class="explain-hero-orb" aria-hidden="true" />
          <div class="explain-hero-inner">
            <div class="explain-eyebrow">
              <span class="pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </span>
              AI · gluecron · explain
            </div>
            <h1 class="explain-title">
              <span class="explain-title-grad">Explain</span>{" "}
              <span style="color:var(--text-strong)">{owner}/{repo}</span>
            </h1>
          </div>
        </section>

        {isRunning && (
          <div class="explain-progress">
            <div class="explain-spinner" aria-label="Analyzing…" />
            <div class="explain-progress-text">
              <h3>Analyzing codebase…</h3>
              <p>
                Claude is reading the file tree and key source files.
                This usually takes 10–30 seconds. This page refreshes automatically.
              </p>
            </div>
          </div>
        )}

        {isFailed && (
          <div class="explain-error">
            <h3>Analysis failed</h3>
            <p>{job.error ?? "An unexpected error occurred. Please try again."}</p>
          </div>
        )}

        {isDone && job.result && (
          <ResultDashboard result={job.result} owner={owner} repo={repo} />
        )}

        <div style="margin-top:var(--space-4);font-size:13px;color:var(--text-muted);">
          <a href={`/${owner}/${repo}/explain`} style="color:var(--link)">
            ← Back to explain page
          </a>
          {" · "}
          <a
            href={`/${owner}/${repo}/explain/${jobId}/raw`}
            style="color:var(--link)"
            target="_blank"
            rel="noopener noreferrer"
          >
            View raw JSON
          </a>
        </div>

        <div class="explain-poweredby">
          <span class="explain-poweredby-pill">
            <span class="dot" aria-hidden="true" />
            Powered by Claude
          </span>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    </Layout>
  );
});

export default explainRoutes;
