/**
 * Issue tracker routes — list, create, view, comment, close/reopen.
 */

import { Hono } from "hono";
import { eq, and, desc, asc, sql, ilike, inArray, or } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  issueComments,
  repositories,
  users,
  labels,
  issueLabels,
  pullRequests,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { PendingCommentsBanner } from "../views/pending-comments-banner";
import { ReactionsBar } from "../views/reactions";
import { summariseReactions } from "../lib/reactions";
import { loadIssueTemplate } from "../lib/templates";
import { renderMarkdown } from "../lib/markdown";
import { liveCommentBannerScript } from "../lib/sse-client";
import { triggerIssueTriage, ISSUE_TRIAGE_MARKER } from "../lib/issue-triage";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  decideInitialStatus,
  notifyOwnerOfPendingComment,
  countPendingForRepo,
} from "../lib/comment-moderation";
import {
  Flex,
  Container,
  PageHeader,
  Form,
  FormGroup,
  Input,
  TextArea,
  Button,
  LinkButton,
  Badge,
  EmptyState,
  TabNav,
  FilterTabs,
  List,
  ListItem,
  Alert,
  CommentBox,
  CommentForm,
  formatRelative,
} from "../views/ui";

const issueRoutes = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Visual polish: inline CSS scoped to `.issues-*` so it never collides with
// other routes/shared views. All design tokens come from :root in layout.tsx.
// ---------------------------------------------------------------------------
const issuesStyles = `
  /* Hero card — list page */
  .issues-hero {
    position: relative;
    margin: 4px 0 24px;
    padding: 28px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .issues-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .issues-hero-bg {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 360px;
    height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .issues-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: issuesHeroOrb 14s ease-in-out infinite;
  }
  @keyframes issuesHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-12px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .issues-hero-orb { animation: none; }
  }
  .issues-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 24px;
    flex-wrap: wrap;
  }
  .issues-hero-text { flex: 1; min-width: 280px; }
  .issues-hero-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .issues-hero-eyebrow .issues-hero-repo {
    color: var(--accent);
    text-transform: none;
    letter-spacing: -0.005em;
    font-weight: 600;
  }
  .issues-hero-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .issues-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 580px;
  }
  .issues-hero-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  @media (max-width: 720px) {
    .issues-hero { padding: 24px 20px; }
    .issues-hero-inner { flex-direction: column; align-items: flex-start; }
    .issues-hero-actions { width: 100%; }
    .issues-hero-actions .btn { flex: 1; min-width: 0; }
  }

  /* Mobile rules — added in the 720px sweep. Kept additive only. */
  @media (max-width: 720px) {
    .issues-toolbar { flex-direction: column; align-items: stretch; }
    .issues-filters { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .issues-filter { min-height: 40px; padding: 10px 14px; }
    .issues-row { padding: 12px 14px; gap: 10px; }
    .issues-row-side { flex-wrap: wrap; gap: 8px; }
    .issues-detail-hero { padding: 18px; }
    .issues-detail-attr { font-size: 13px; }
    .issues-composer-actions { gap: 8px; }
    .issues-composer-actions .btn { flex: 1; min-width: 0; min-height: 44px; }
    .issues-empty { padding: 40px 20px; }
  }

  /* Count chip + filter pills */
  .issues-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin: 0 0 16px;
  }
  .issues-filters {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
  }
  .issues-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease;
    line-height: 1.4;
  }
  .issues-filter:hover { color: var(--text-strong); text-decoration: none; }
  .issues-filter.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
  }
  .issues-filter-count {
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    padding: 1px 7px;
    border-radius: 9999px;
  }
  .issues-filter.is-active .issues-filter-count {
    background: rgba(140,109,255,0.18);
    color: var(--text);
  }

  /* Issue search form */
  .issues-search-form {
    display: flex;
    align-items: center;
    gap: 0;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    overflow: hidden;
    flex: 1;
    max-width: 280px;
    transition: border-color 120ms ease;
  }
  .issues-search-form:focus-within { border-color: rgba(140,109,255,0.55); }
  .issues-search-input {
    flex: 1;
    background: transparent;
    color: var(--text);
    border: none;
    outline: none;
    padding: 6px 14px;
    font-size: 13px;
    font-family: var(--font-sans, inherit);
    min-width: 0;
  }
  .issues-search-input::placeholder { color: var(--text-muted); }
  .issues-search-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 6px 12px 6px 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
  }
  .issues-search-btn:hover { color: var(--text); }
  .issues-filter-banner {
    margin-bottom: 12px;
    padding: 8px 14px;
    background: rgba(140,109,255,0.06);
    border: 1px solid rgba(140,109,255,0.2);
    border-radius: 8px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .issues-filter-clear {
    color: var(--accent, #8c6dff);
    text-decoration: underline;
    cursor: pointer;
  }
  .issues-label-badge {
    display: inline-block;
    background: rgba(140,109,255,0.15);
    color: #a78bfa;
    border-radius: 9999px;
    padding: 1px 8px;
    font-size: 11.5px;
    font-weight: 600;
  }

  /* Issue list — modernised rows */
  .issues-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .issues-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    transition: background 120ms ease, transform 120ms ease;
  }
  .issues-row:last-child { border-bottom: none; }
  .issues-row:hover { background: rgba(140,109,255,0.04); }
  .issues-row-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    margin-top: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .issues-row-icon.is-open  { color: #34d399; }
  .issues-row-icon.is-closed { color: #b69dff; }
  .issues-row-main { flex: 1; min-width: 0; }
  .issues-row-title {
    font-family: var(--font-display);
    font-size: 15.5px;
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.012em;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .issues-row-title a {
    color: var(--text-strong);
    text-decoration: none;
    transition: color 120ms ease;
  }
  .issues-row-title a:hover { color: var(--accent); }
  .issues-row-meta {
    margin-top: 5px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .issues-row-meta strong { color: var(--text); font-weight: 600; }
  .issues-row-side {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    font-size: 12.5px;
    flex-shrink: 0;
  }
  .issues-row-comments {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-muted);
    text-decoration: none;
  }
  .issues-row-comments:hover { color: var(--accent); text-decoration: none; }

  /* Label pills (rendered inline on titles) */
  .issues-label {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.4;
    background: rgba(140,109,255,0.10);
    color: var(--text-strong);
    border: 1px solid rgba(140,109,255,0.28);
    letter-spacing: 0.005em;
  }

  /* Polished empty state */
  .issues-empty {
    margin: 0;
    padding: 56px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .issues-empty::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .issues-empty-art {
    width: 96px;
    height: 96px;
    margin: 0 auto 18px;
    display: block;
    opacity: 0.85;
  }
  .issues-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .issues-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 auto 22px;
    max-width: 460px;
  }
  .issues-empty-cta { display: inline-flex; gap: 10px; flex-wrap: wrap; justify-content: center; }

  /* ─── Detail page ─── */
  .issues-detail-hero {
    position: relative;
    margin: 4px 0 20px;
    padding: 22px 26px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .issues-detail-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .issues-detail-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 700;
    letter-spacing: -0.022em;
    line-height: 1.18;
    color: var(--text-strong);
    margin: 0 0 12px;
  }
  .issues-detail-title .issues-detail-number {
    color: var(--text-muted);
    font-weight: 500;
    margin-left: 8px;
  }
  .issues-detail-attr {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 14px;
    color: var(--text-muted);
  }
  .issues-detail-attr strong { color: var(--text); font-weight: 600; }
  .issues-state-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 9999px;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: 0.005em;
  }
  .issues-state-pill.is-open {
    background: rgba(52,211,153,0.12);
    color: #34d399;
    border: 1px solid rgba(52,211,153,0.35);
  }
  .issues-state-pill.is-closed {
    background: rgba(182,157,255,0.12);
    color: #b69dff;
    border: 1px solid rgba(182,157,255,0.35);
  }
  .issues-detail-spacer { flex: 1; }
  .issues-detail-labels {
    margin-top: 12px;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* Comment thread */
  .issues-thread { margin-top: 18px; }
  .issues-comment {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
    margin-bottom: 14px;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  .issues-comment:hover {
    border-color: var(--border-strong, rgba(255,255,255,0.13));
  }
  .issues-comment-header {
    background: var(--bg-secondary);
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .issues-comment-header strong { color: var(--text-strong); font-weight: 600; }
  .issues-comment-body { padding: 14px 18px; }
  .issues-comment-author-pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 8px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.10);
    color: var(--accent);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  /* AI Review comment — distinct purple-accent treatment */
  .issues-comment.is-ai {
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.18), 0 12px 32px -16px rgba(140,109,255,0.25);
  }
  .issues-comment.is-ai::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, #8c6dff 0%, #36c5d6 100%);
    pointer-events: none;
  }
  .issues-comment.is-ai .issues-comment-header {
    background: linear-gradient(180deg, rgba(140,109,255,0.08), rgba(140,109,255,0.02));
    border-bottom-color: rgba(140,109,255,0.22);
  }
  .issues-ai-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .issues-ai-badge::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: #fff;
    opacity: 0.92;
    box-shadow: 0 0 6px rgba(255,255,255,0.7);
  }

  /* Composer */
  .issues-composer {
    margin-top: 22px;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  .issues-composer:focus-within {
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.16);
  }
  .issues-composer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .issues-composer-tag {
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.005em;
  }
  .issues-composer-hint a {
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 1px dashed currentColor;
  }
  .issues-composer-hint a:hover { color: var(--accent); }
  .issues-composer textarea {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--text);
    padding: 14px 16px;
    font-family: var(--font-mono);
    font-size: 13.5px;
    line-height: 1.55;
    resize: vertical;
    outline: none;
    min-height: 140px;
  }
  .issues-composer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-wrap: wrap;
  }

  /* Info banner inside detail */
  .issues-info-banner {
    margin: 0 0 14px;
    padding: 10px 14px;
    border-radius: 12px;
    background: rgba(140,109,255,0.08);
    border: 1px solid rgba(140,109,255,0.28);
    color: var(--text);
    font-size: 13.5px;
  }

  /* ─── Linked PRs ─── */
  .iss-linked-prs { margin-top: 16px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .iss-linked-prs-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; background: var(--bg-elevated); border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 600; }
  .iss-linked-pr-row { display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-bottom: 1px solid var(--border); font-size: 13px; text-decoration: none; color: inherit; }
  .iss-linked-pr-row:last-child { border-bottom: none; }
  .iss-linked-pr-row:hover { background: var(--bg-hover); }
  .iss-linked-pr-icon.is-open { color: #34d399; }
  .iss-linked-pr-icon.is-merged { color: #a78bfa; }
  .iss-linked-pr-icon.is-closed { color: #8b949e; }
  .iss-linked-pr-icon.is-draft { color: #8b949e; }
  .iss-linked-pr-title { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .iss-linked-pr-num { color: var(--text-muted); font-size: 12px; }
  .iss-linked-pr-state { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 9999px; }
  .iss-linked-pr-state.is-open { color: #34d399; background: rgba(52,211,153,0.10); }
  .iss-linked-pr-state.is-merged { color: #a78bfa; background: rgba(167,139,250,0.10); }
  .iss-linked-pr-state.is-closed { color: #8b949e; background: var(--bg-tertiary); }
  .iss-linked-pr-state.is-draft { color: #8b949e; background: var(--bg-tertiary); }
`;

// Pre-rendered <style> tag (constant, reused per request).
const IssuesStyle = () => (
  <style dangerouslySetInnerHTML={{ __html: issuesStyles }} />
);

// Inline empty-state SVG — a softly-tinted speech-bubble icon. No external assets.
const IssuesEmptySvg = () => (
  <svg
    class="issues-empty-art"
    viewBox="0 0 96 96"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="issuesEmptyG" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#8c6dff" stop-opacity="0.55" />
        <stop offset="100%" stop-color="#36c5d6" stop-opacity="0.55" />
      </linearGradient>
    </defs>
    <circle cx="48" cy="48" r="42" stroke="url(#issuesEmptyG)" stroke-width="1.5" fill="rgba(140,109,255,0.04)" />
    <circle cx="48" cy="48" r="14" stroke="url(#issuesEmptyG)" stroke-width="2" fill="none" />
    <path d="M48 30v8M48 58v8M30 48h8M58 48h8" stroke="url(#issuesEmptyG)" stroke-width="2" stroke-linecap="round" />
  </svg>
);

// Detect AI Triage comments by the marker the triage helper writes.
function isAiTriageComment(body: string | null | undefined): boolean {
  if (!body) return false;
  return body.includes(ISSUE_TRIAGE_MARKER) || body.trimStart().startsWith("## AI Triage");
}

// Helper to resolve repo from :owner/:repo params
async function resolveRepo(ownerName: string, repoName: string) {
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner) return null;

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return null;

  return { owner, repo };
}

// Issue list
issueRoutes.get("/:owner/:repo/issues", softAuth, requireRepoAccess("read"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const state = c.req.query("state") || "open";
  const searchQ = (c.req.query("q") || "").trim();
  const labelFilter = (c.req.query("label") || "").trim();
  // Bounded pagination — unbounded selects ran a full table scan + O(n)
  // sort on every page load; with 10k+ issues the request would hang.
  const perPage = Math.min(100, Math.max(1, Number(c.req.query("per_page")) || 50));
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const offset = (page - 1) * perPage;

  // ── Loading skeleton (flag-gated) ──
  // Renders an SSR'd row skeleton when `?skeleton=1` is set. Lets the
  // user see the shape of the issue list before the DB count + select
  // resolve. Behind a flag — we don't ship flashes.
  if (c.req.query("skeleton") === "1") {
    return c.html(
      <Layout title={`Issues — ${ownerName}/${repoName}`} user={user}>
        <IssuesStyle />
        <RepoHeader owner={ownerName} repo={repoName} />
        <IssueNav owner={ownerName} repo={repoName} active="issues" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              .issues-skel { background: linear-gradient(90deg, var(--bg-secondary) 0%, var(--bg-elevated) 50%, var(--bg-secondary) 100%); background-size: 200% 100%; animation: issuesSkelShimmer 1.4s infinite; border-radius: 6px; display: block; }
              @keyframes issuesSkelShimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
              @media (prefers-reduced-motion: reduce) { .issues-skel { animation: none; } }
              .issues-skel-hero { height: 168px; border-radius: 16px; margin: 4px 0 24px; }
              .issues-skel-toolbar { height: 44px; width: 240px; border-radius: 9999px; margin-bottom: 16px; }
              .issues-skel-list { display: flex; flex-direction: column; gap: 8px; }
              .issues-skel-row { height: 62px; border-radius: 10px; }
            `,
          }}
        />
        <div class="issues-skel issues-skel-hero" aria-hidden="true" />
        <div class="issues-skel issues-skel-toolbar" aria-hidden="true" />
        <div class="issues-skel-list" aria-hidden="true">
          {Array.from({ length: 8 }).map(() => (
            <div class="issues-skel issues-skel-row" />
          ))}
        </div>
        <span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0" role="status" aria-live="polite">
          Loading issues for {ownerName}/{repoName}…
        </span>
      </Layout>
    );
  }

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <EmptyState title="Repository not found" />
      </Layout>,
      404
    );
  }

  const { repo } = resolved;

  // If label filter is set, find issue IDs that have that label
  let labelFilteredIds: string[] | null = null;
  if (labelFilter) {
    const [matchedLabel] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.repositoryId, repo.id), ilike(labels.name, labelFilter)))
      .limit(1);
    if (matchedLabel) {
      const rows = await db
        .select({ issueId: issueLabels.issueId })
        .from(issueLabels)
        .where(eq(issueLabels.labelId, matchedLabel.id));
      labelFilteredIds = rows.map((r) => r.issueId);
    } else {
      labelFilteredIds = []; // no matches
    }
  }

  const baseWhere = and(
    eq(issues.repositoryId, repo.id),
    state === "open" || state === "closed" ? eq(issues.state, state) : undefined,
    searchQ ? ilike(issues.title, `%${searchQ}%`) : undefined,
    labelFilteredIds !== null && labelFilteredIds.length > 0
      ? inArray(issues.id, labelFilteredIds)
      : labelFilteredIds !== null && labelFilteredIds.length === 0
        ? sql`false`
        : undefined
  );

  const issueList = await db
    .select({
      issue: issues,
      author: { username: users.username },
    })
    .from(issues)
    .innerJoin(users, eq(issues.authorId, users.id))
    .where(baseWhere)
    .orderBy(desc(issues.createdAt))
    .limit(perPage)
    .offset(offset);

  // Count open/closed
  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${issues.state} = 'open')`,
      closed: sql<number>`count(*) filter (where ${issues.state} = 'closed')`,
    })
    .from(issues)
    .where(eq(issues.repositoryId, repo.id));

  const viewerIsOwnerOnList = !!(user && user.id === resolved.owner.id);
  const pendingCountList = viewerIsOwnerOnList
    ? await countPendingForRepo(repo.id)
    : 0;

  return c.html(
    <Layout title={`Issues — ${ownerName}/${repoName}`} user={user}>
      <IssuesStyle />
      <RepoHeader owner={ownerName} repo={repoName} />
      <IssueNav owner={ownerName} repo={repoName} active="issues" />
      <PendingCommentsBanner
        owner={ownerName}
        repo={repoName}
        count={pendingCountList}
      />
      <section class="issues-hero">
        <div class="issues-hero-bg" aria-hidden="true">
          <div class="issues-hero-orb" />
        </div>
        <div class="issues-hero-inner">
          <div class="issues-hero-text">
            <div class="issues-hero-eyebrow">
              Issue tracker \u00B7{" "}
              <span class="issues-hero-repo">
                {ownerName}/{repoName}
              </span>
            </div>
            <h1 class="issues-hero-title">
              Track <span class="gradient-text">what matters</span>.
            </h1>
            <p class="issues-hero-sub">
              {(Number(counts?.open ?? 0) + Number(counts?.closed ?? 0)) === 0
                ? "Bugs, ideas, and roadmap items live here. Open the first one and AI Triage will draft a starter classification within seconds."
                : `${Number(counts?.open ?? 0)} open \u00B7 ${Number(counts?.closed ?? 0)} closed. AI Triage suggests labels, priority, and possible duplicates the moment an issue is filed.`}
            </p>
          </div>
          <div class="issues-hero-actions">
            {user && (
              <a
                href={`/${ownerName}/${repoName}/issues/new`}
                class="btn btn-primary"
              >
                + New issue
              </a>
            )}
            <a href={`/${ownerName}/${repoName}`} class="btn">
              Back to code
            </a>
          </div>
        </div>
      </section>

      <div class="issues-toolbar">
        <div class="issues-filters" role="tablist" aria-label="Issue state filter">
          <a
            class={`issues-filter${state === "open" ? " is-active" : ""}`}
            href={`/${ownerName}/${repoName}/issues?state=open`}
            role="tab"
            aria-selected={state === "open" ? "true" : "false"}
          >
            <span aria-hidden="true">{"\u25CB"}</span>
            <span>Open</span>
            <span class="issues-filter-count">{Number(counts?.open ?? 0)}</span>
          </a>
          <a
            class={`issues-filter${state === "closed" ? " is-active" : ""}`}
            href={`/${ownerName}/${repoName}/issues?state=closed`}
            role="tab"
            aria-selected={state === "closed" ? "true" : "false"}
          >
            <span aria-hidden="true">{"\u2713"}</span>
            <span>Closed</span>
            <span class="issues-filter-count">{Number(counts?.closed ?? 0)}</span>
          </a>
        </div>
        <form method="get" action={`/${ownerName}/${repoName}/issues`} class="issues-search-form">
          <input type="hidden" name="state" value={state} />
          <input
            type="search"
            name="q"
            value={searchQ}
            placeholder="Search issues\u2026"
            class="issues-search-input"
            aria-label="Search issues by title"
          />
          {labelFilter && <input type="hidden" name="label" value={labelFilter} />}
          <button type="submit" class="issues-search-btn" aria-label="Search">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
            </svg>
          </button>
        </form>
      </div>
      {(searchQ || labelFilter) && (
        <div class="issues-filter-banner">
          Filtering{searchQ ? <> by "<strong>{searchQ}</strong>"</> : null}
          {labelFilter ? <> label: <span class="issues-label-badge">{labelFilter}</span></> : null}
          {" \u00B7 "}
          <a href={`/${ownerName}/${repoName}/issues?state=${state}`} class="issues-filter-clear">Clear filters</a>
        </div>
      )}

      {issueList.length === 0 ? (
        <div class="issues-empty">
          <IssuesEmptySvg />
          <h2 class="issues-empty-title">
            {state === "closed"
              ? "No closed issues yet"
              : (Number(counts?.open ?? 0) + Number(counts?.closed ?? 0)) === 0
                ? "No issues \u2014 yet"
                : "Nothing open right now"}
          </h2>
          <p class="issues-empty-sub">
            {state === "closed"
              ? "Closed issues will show up here once the team starts shipping fixes."
              : (Number(counts?.open ?? 0) + Number(counts?.closed ?? 0)) === 0
                ? "File the first one and AI Triage will draft a starter classification \u2014 labels, priority, and a duplicate sweep \u2014 within seconds."
                : "All caught up. New filings will appear here, with AI Triage suggestions auto-posted to every thread."}
          </p>
          <div class="issues-empty-cta">
            {user && state !== "closed" && (
              <a
                href={`/${ownerName}/${repoName}/issues/new`}
                class="btn btn-primary"
              >
                + Open the first issue
              </a>
            )}
            {state === "closed" && (
              <a
                href={`/${ownerName}/${repoName}/issues?state=open`}
                class="btn"
              >
                View open issues
              </a>
            )}
          </div>
        </div>
      ) : (
        <ul class="issues-list">
          {issueList.map(({ issue, author }) => (
            <li class="issues-row">
              <div
                class={`issues-row-icon ${issue.state === "open" ? "is-open" : "is-closed"}`}
                aria-hidden="true"
                title={issue.state === "open" ? "Open" : "Closed"}
              >
                {issue.state === "open" ? "\u25CB" : "\u2713"}
              </div>
              <div class="issues-row-main">
                <h3 class="issues-row-title">
                  <a href={`/${ownerName}/${repoName}/issues/${issue.number}`}>
                    {issue.title}
                  </a>
                </h3>
                <div class="issues-row-meta">
                  #{issue.number} opened by{" "}
                  <strong>{author.username}</strong>{" "}
                  {formatRelative(issue.createdAt)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
});

// New issue form
issueRoutes.get(
  "/:owner/:repo/issues/new",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const error = c.req.query("error");
    const template = await loadIssueTemplate(ownerName, repoName);

    return c.html(
      <Layout title={`New issue — ${ownerName}/${repoName}`} user={user}>
        <IssuesStyle />
        <RepoHeader owner={ownerName} repo={repoName} />
        <IssueNav owner={ownerName} repo={repoName} active="issues" />
        <Container maxWidth={800}>
          <section class="issues-hero" style="margin-top:4px">
            <div class="issues-hero-bg" aria-hidden="true">
              <div class="issues-hero-orb" />
            </div>
            <div class="issues-hero-inner">
              <div class="issues-hero-text">
                <div class="issues-hero-eyebrow">
                  New issue ·{" "}
                  <span class="issues-hero-repo">
                    {ownerName}/{repoName}
                  </span>
                </div>
                <h1 class="issues-hero-title">
                  File <span class="gradient-text">it cleanly</span>.
                </h1>
                <p class="issues-hero-sub">
                  AI Triage will read the body the moment you submit and post
                  suggested labels, priority, and possible duplicates within
                  seconds. You stay in control — nothing is applied.
                </p>
              </div>
            </div>
          </section>
          {error && (
            <Alert variant="error">{decodeURIComponent(error)}</Alert>
          )}
          <Form method="post" action={`/${ownerName}/${repoName}/issues/new`}>
            <FormGroup>
              <Input
                type="text"
                name="title"
                required
                placeholder="Title"
                style="font-size:16px;padding:10px 14px"
                aria-label="Issue title"
              />
            </FormGroup>
            <FormGroup>
              <TextArea
                name="body"
                rows={12}
                placeholder="Leave a comment... (Markdown supported)"
                mono
              />
            </FormGroup>
            <Button type="submit" variant="primary">
              Submit new issue
            </Button>
          </Form>
        </Container>
      </Layout>
    );
  }
);

// Create issue
issueRoutes.post(
  "/:owner/:repo/issues/new",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const title = String(body.title || "").trim();
    const issueBody = String(body.body || "").trim();

    if (!title) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/new?error=Title+is+required`
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [issue] = await db
      .insert(issues)
      .values({
        repositoryId: resolved.repo.id,
        authorId: user.id,
        title,
        body: issueBody || null,
      })
      .returning();

    // Update issue count
    await db
      .update(repositories)
      .set({ issueCount: resolved.repo.issueCount + 1 })
      .where(eq(repositories.id, resolved.repo.id));

    // Fire-and-forget AI triage. Posts a "## AI Triage" comment with
    // suggested labels, priority, summary, and a possible-duplicate
    // callout. Suggestions only — nothing applied automatically.
    triggerIssueTriage({
      ownerName,
      repoName,
      repositoryId: resolved.repo.id,
      issueId: issue.id,
      issueNumber: issue.number,
      authorId: user.id,
      title,
      body: issueBody,
    }).catch((err) => {
      console.warn(
        `[issue-triage] triage trigger failed for issue ${issue.id}:`,
        err instanceof Error ? err.message : err
      );
    });

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issue.number}`
    );
  }
);

// View single issue
issueRoutes.get("/:owner/:repo/issues/:number", softAuth, requireRepoAccess("read"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const issueNum = parseInt(c.req.param("number"), 10);
  const user = c.get("user");

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <EmptyState title="Not found" />
      </Layout>,
      404
    );
  }

  const [issue] = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.repositoryId, resolved.repo.id),
        eq(issues.number, issueNum)
      )
    )
    .limit(1);

  if (!issue) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <EmptyState title="Issue not found" />
      </Layout>,
      404
    );
  }

  const [author] = await db
    .select()
    .from(users)
    .where(eq(users.id, issue.authorId))
    .limit(1);

  // Get comments. We pull every row and filter by moderation_status +
  // viewer identity client-side (in the JSX below) so a moderator/owner
  // sees them all while non-author viewers only ever see 'approved'.
  const allComments = await db
    .select({
      comment: issueComments,
      author: { id: users.id, username: users.username },
    })
    .from(issueComments)
    .innerJoin(users, eq(issueComments.authorId, users.id))
    .where(eq(issueComments.issueId, issue.id))
    .orderBy(asc(issueComments.createdAt));

  const viewerIsOwner = !!(user && user.id === resolved.owner.id);
  const comments = allComments.filter(({ comment, author: cAuthor }) => {
    // Owner always sees everything (so they can spot conversations going
    // sideways even before they hit the queue page).
    if (viewerIsOwner) return true;
    if (comment.moderationStatus === "approved") return true;
    // The comment's own author sees their pending comment so they know
    // it landed (with an "Awaiting approval" badge in the render below).
    if (user && cAuthor.id === user.id && comment.moderationStatus === "pending") {
      return true;
    }
    return false;
  });

  // Pending banner — when the viewer is the repo owner, show a strip at
  // the top of the page nudging them to the moderation queue. Inline on
  // this page because RepoNav is locked (see CLAUDE.md / build bible).
  const pendingCount = viewerIsOwner
    ? await countPendingForRepo(resolved.repo.id)
    : 0;

  // Load reactions for the issue + each comment in parallel.
  const [issueReactions, ...commentReactions] = await Promise.all([
    summariseReactions("issue", issue.id, user?.id),
    ...comments.map((row) =>
      summariseReactions("issue_comment", row.comment.id, user?.id)
    ),
  ]);

  const canManage =
    user &&
    (user.id === resolved.owner.id || user.id === issue.authorId);
  const info = c.req.query("info");

  // Linked PRs — find PRs in this repo whose title or body reference this issue number.
  const issueRefPattern = `%#${issue.number}%`;
  const linkedPrs = await db
    .select({
      number: pullRequests.number,
      title: pullRequests.title,
      state: pullRequests.state,
      isDraft: pullRequests.isDraft,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        or(
          ilike(pullRequests.title, issueRefPattern),
          ilike(pullRequests.body, issueRefPattern),
        )
      )
    )
    .orderBy(desc(pullRequests.createdAt))
    .limit(8);

  return c.html(
    <Layout
      title={`${issue.title} #${issue.number} — ${ownerName}/${repoName}`}
      user={user}
    >
      <IssuesStyle />
      <RepoHeader owner={ownerName} repo={repoName} />
      <IssueNav owner={ownerName} repo={repoName} active="issues" />
      <PendingCommentsBanner
        owner={ownerName}
        repo={repoName}
        count={pendingCount}
      />
      <div
        id="live-comment-banner"
        class="alert"
        style="display:none;margin:12px 0;padding:10px 14px;border-radius:6px;background:var(--accent);color:var(--bg);font-size:14px"
      >
        <strong class="js-live-count">0</strong> new comment(s) —{" "}
        <a class="js-live-link" href="#" style="color:inherit;text-decoration:underline">
          reload to view
        </a>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: liveCommentBannerScript({
            topic: `repo:${resolved.repo.id}:issue:${issue.number}`,
            bannerElementId: "live-comment-banner",
          }),
        }}
      />
      <div class="issue-detail">
        {info && (
          <div class="issues-info-banner">
            {decodeURIComponent(info)}
          </div>
        )}

        <section class="issues-detail-hero">
          <h1 class="issues-detail-title">
            {issue.title}
            <span class="issues-detail-number">#{issue.number}</span>
          </h1>
          <div class="issues-detail-attr">
            <span
              class={`issues-state-pill ${issue.state === "open" ? "is-open" : "is-closed"}`}
              title={issue.state === "open" ? "Open" : "Closed"}
            >
              <span aria-hidden="true">
                {issue.state === "open" ? "\u25CB" : "\u2713"}
              </span>
              {issue.state === "open" ? "Open" : "Closed"}
            </span>
            <span>
              <strong>{author?.username || "unknown"}</strong> opened this
              issue {formatRelative(issue.createdAt)}
            </span>
            <span class="issues-detail-spacer" />
            {issue.state === "open" && user && user.id === resolved.owner.id && (
              <a
                href={`/${ownerName}/${repoName}/spec?fromIssue=${issue.number}`}
                class="btn btn-primary"
                style="font-size:13px;padding:6px 12px"
                title="Generate a draft pull request from this issue using Claude"
              >
                Build with AI
              </a>
            )}
          </div>
        </section>

        <div class="issues-thread">
          {issue.body && (
            <article class="issues-comment">
              <header class="issues-comment-header">
                <strong>{author?.username || "unknown"}</strong>
                <span class="issues-comment-author-pill">Author</span>
                <span>commented {formatRelative(issue.createdAt)}</span>
              </header>
              <div class="issues-comment-body">
                <div
                  class="markdown-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(issue.body) }}
                />
              </div>
            </article>
          )}

          {comments.map(({ comment, author: commentAuthor }) => {
            const isAi = isAiTriageComment(comment.body);
            const isPending = comment.moderationStatus === "pending";
            return (
              <article class={`issues-comment${isAi ? " is-ai" : ""}${isPending ? " modq-comment-pending" : ""}`}>
                <header class="issues-comment-header">
                  <strong>{commentAuthor.username}</strong>
                  {isAi ? (
                    <span class="issues-ai-badge" title="Generated by Gluecron AI Triage">
                      AI Review
                    </span>
                  ) : null}
                  {isPending ? (
                    <span class="modq-pending-badge" title="This comment is awaiting the repository owner's approval — only you and the owner can see it.">
                      Awaiting approval
                    </span>
                  ) : null}
                  <span>commented {formatRelative(comment.createdAt)}</span>
                </header>
                <div class="issues-comment-body">
                  <div
                    class="markdown-body"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(comment.body),
                    }}
                  />
                </div>
              </article>
            );
          })}
        </div>

        {linkedPrs.length > 0 && (
          <div class="iss-linked-prs">
            <div class="iss-linked-prs-head">
              <span>Linked pull requests</span>
              <span>{linkedPrs.length}</span>
            </div>
            {linkedPrs.map((lpr) => {
              const prState = lpr.isDraft ? "draft" : lpr.state;
              const prIcon = prState === "merged" ? "⮬" : prState === "closed" ? "✕" : prState === "draft" ? "◌" : "○";
              return (
                <a
                  href={`/${ownerName}/${repoName}/pulls/${lpr.number}`}
                  class="iss-linked-pr-row"
                >
                  <span class={`iss-linked-pr-icon is-${prState}`} aria-hidden="true">{prIcon}</span>
                  <span class="iss-linked-pr-title">{lpr.title}</span>
                  <span class="iss-linked-pr-num">#{lpr.number}</span>
                  <span class={`iss-linked-pr-state is-${prState}`}>{prState}</span>
                </a>
              );
            })}
          </div>
        )}

        {user && (
          <form
            class="issues-composer"
            method="post"
            action={`/${ownerName}/${repoName}/issues/${issue.number}/comment`}
          >
            <div class="issues-composer-header">
              <span class="issues-composer-tag">Add a comment</span>
              <span class="issues-composer-hint">
                <a
                  href="https://docs.github.com/en/get-started/writing-on-github"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Markdown supported: **bold**, _italic_, `code`, links, lists, > quotes"
                >
                  Markdown supported
                </a>
              </span>
            </div>
            <textarea
              name="body"
              rows={6}
              required
              placeholder="Leave a comment... fenced code blocks, lists, links, and quotes all supported."
            />
            <div class="issues-composer-actions">
              <button type="submit" class="btn btn-primary">
                Comment
              </button>
              {canManage && (
                <button
                  type="submit"
                  formaction={`/${ownerName}/${repoName}/issues/${issue.number}/${issue.state === "open" ? "close" : "reopen"}`}
                  class={`btn ${issue.state === "open" ? "btn-danger" : ""}`}
                >
                  {issue.state === "open" ? "Close issue" : "Reopen issue"}
                </button>
              )}
              {canManage && issue.state === "open" && (
                <button
                  type="submit"
                  formaction={`/${ownerName}/${repoName}/issues/${issue.number}/ai-retriage`}
                  formnovalidate
                  class="btn"
                  title="Re-run AI triage. Posts a fresh suggestions comment (use after editing the issue body)."
                >
                  Re-run AI triage
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </Layout>
  );
});

// Add comment.
//
// Permission model: we accept comments from ANY authenticated user (read
// access required — public repos satisfy that, private repos still need a
// collaborator row). The moderation gate in `decideInitialStatus`
// determines whether the comment is published immediately or queued for
// the repo owner's approval. See `src/lib/comment-moderation.ts` for the
// "anti-impersonation" rationale.
issueRoutes.post(
  "/:owner/:repo/issues/:number/comment",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const commentBody = String(body.body || "").trim();

    if (!commentBody) {
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}`
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      )
      .limit(1);

    if (!issue) return c.redirect(`/${ownerName}/${repoName}/issues`);

    // Decide moderation status BEFORE insert so the row lands in the right
    // initial state. Collaborators, the issue author, and trusted users
    // get 'approved'; banned users get 'rejected' (silent drop); everyone
    // else gets 'pending'.
    const decision = await decideInitialStatus({
      commenterUserId: user.id,
      repositoryId: resolved.repo.id,
      kind: "issue",
      threadId: issue.id,
    });

    const [inserted] = await db
      .insert(issueComments)
      .values({
        issueId: issue.id,
        authorId: user.id,
        body: commentBody,
        moderationStatus: decision.status,
      })
      .returning();

    // Live update only when visible. Don't leak pending/rejected via SSE.
    if (inserted && decision.status === "approved") {
      try {
        const { publish } = await import("../lib/sse");
        publish(`repo:${resolved.repo.id}:issue:${issueNum}`, {
          event: "issue-comment",
          data: {
            issueId: issue.id,
            commentId: inserted.id,
            authorId: user.id,
            authorUsername: user.username,
          },
        });
      } catch {
        /* SSE is best-effort */
      }
    }

    if (decision.status === "pending") {
      // Notify repo owner that a comment is awaiting review.
      void notifyOwnerOfPendingComment({
        repositoryId: resolved.repo.id,
        commenterUsername: user.username,
        kind: "issue",
        threadNumber: issueNum,
        ownerUsername: ownerName,
        repoName,
      });
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}?info=${encodeURIComponent("Comment awaiting author approval")}`
      );
    }
    if (decision.status === "rejected") {
      // Silent ban — the commenter is on the banned list. Don't reveal
      // the gate; just send them back to the page as if it posted.
      return c.redirect(
        `/${ownerName}/${repoName}/issues/${issueNum}?info=${encodeURIComponent("Comment awaiting author approval")}`
      );
    }

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issueNum}`
    );
  }
);

// Close issue
issueRoutes.post(
  "/:owner/:repo/issues/:number/close",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db
      .update(issues)
      .set({ state: "closed", closedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      );

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issueNum}`
    );
  }
);

// Reopen issue
issueRoutes.post(
  "/:owner/:repo/issues/:number/reopen",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db
      .update(issues)
      .set({ state: "open", closedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      );

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issueNum}`
    );
  }
);

// Shared nav component with issues tab
const IssueNav = ({
  owner,
  repo,
  active,
}: {
  owner: string;
  repo: string;
  active: "code" | "commits" | "issues";
}) => (
  <TabNav
    tabs={[
      { label: "Code", href: `/${owner}/${repo}`, active: active === "code" },
      { label: "Issues", href: `/${owner}/${repo}/issues`, active: active === "issues" },
      { label: "Commits", href: `/${owner}/${repo}/commits`, active: active === "commits" },
    ]}
  />
);

// Re-run AI triage on demand (e.g. after the issue body has been edited).
// Bypasses ISSUE_TRIAGE_MARKER via { force: true }. Write-access only.
issueRoutes.post(
  "/:owner/:repo/issues/:number/ai-retriage",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const issueNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.number, issueNum)
        )
      )
      .limit(1);
    if (!issue) {
      return c.redirect(`/${ownerName}/${repoName}/issues`);
    }

    triggerIssueTriage(
      {
        ownerName,
        repoName,
        repositoryId: resolved.repo.id,
        issueId: issue.id,
        issueNumber: issue.number,
        authorId: user.id,
        title: issue.title,
        body: issue.body || "",
      },
      { force: true }
    ).catch((err) => {
      console.warn(
        `[issue-triage] re-triage failed for issue ${issue.id}:`,
        err instanceof Error ? err.message : err
      );
    });

    return c.redirect(
      `/${ownerName}/${repoName}/issues/${issueNum}?info=${encodeURIComponent(
        "AI re-triage queued. The new comment will appear in 10-30s; reload to see it."
      )}`
    );
  }
);

export default issueRoutes;
export { IssueNav };
