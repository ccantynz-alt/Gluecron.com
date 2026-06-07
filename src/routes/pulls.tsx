/**
 * Pull request routes — create, list, view, merge, close, comment.
 *
 * The list view (`GET /:owner/:repo/pulls`) and detail view
 * (`GET /:owner/:repo/pulls/:number`) carry the 2026 polish: hero with
 * gradient title + hairline strip, pill-style state tabs, soft-lift
 * row cards, conversation thread with AI-review accent border, distinct
 * gate-check rows, and a gradient-bordered "Merge pull request" button.
 *
 * All visual styling is scoped via `.prs-*` class prefixes inside inline
 * <style> blocks so other surfaces are untouched. No business logic was
 * changed in this polish pass — AI review triggers, auto-merge wiring,
 * gate evaluation, and the merge handler are preserved exactly.
 */

import { Hono } from "hono";
import { eq, and, desc, asc, sql, inArray, ilike, ne, isNotNull } from "drizzle-orm";
import { db } from "../db";
import {
  pullRequests,
  prComments,
  prReviews,
  prReviewRequests,
  repositories,
  users,
  issues,
  issueComments,
  repoCollaborators,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { PendingCommentsBanner } from "../views/pending-comments-banner";
import { DiffView, type InlineDiffComment } from "../views/diff-view";
import { ReactionsBar } from "../views/reactions";
import { summariseReactions } from "../lib/reactions";
import { loadPrTemplate } from "../lib/templates";
import { renderMarkdown } from "../lib/markdown";
import {
  parseSlashCommand,
  executeSlashCommand,
  detectSlashCmdComment,
  stripSlashCmdMarker,
} from "../lib/pr-slash-commands";
import { liveCommentBannerScript } from "../lib/sse-client";
import { mentionAutocompleteScript } from "../lib/mention-autocomplete";
import { markdownPreviewScript } from "../lib/markdown-preview";
import { ctrlEnterSubmitScript, codeBlockCopyScript } from "../lib/keyboard-ux";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  decideInitialStatus,
  notifyOwnerOfPendingComment,
  countPendingForRepo,
} from "../lib/comment-moderation";
import { isAiReviewEnabled, triggerAiReview } from "../lib/ai-review";
import {
  TRIO_COMMENT_MARKER,
  TRIO_SUMMARY_MARKER,
  isTrioReviewEnabled,
  type TrioPersona,
} from "../lib/ai-review-trio";
import {
  generateTestsForPr,
  AI_TESTS_MARKER,
} from "../lib/ai-test-generator";
import { triggerPrTriage } from "../lib/pr-triage";
import { generatePrSummary } from "../lib/ai-generators";
import { isAiAvailable } from "../lib/ai-client";
import { getPatternWarning, type Pattern } from "../lib/pattern-detector";
import {
  computePrRiskForPullRequest,
  getCachedPrRisk,
  type PrRiskScore,
} from "../lib/pr-risk";
import { runAllGateChecks } from "../lib/gate";
import type { GateCheckResult } from "../lib/gate";
import {
  matchProtection,
  countHumanApprovals,
  listRequiredChecks,
  passingCheckNames,
  evaluateProtection,
} from "../lib/branch-protection";
import { mergeWithAutoResolve } from "../lib/merge-resolver";
import {
  listBranches,
  getRepoPath,
  resolveRef,
  getBlob,
  createOrUpdateFileOnBranch,
  commitsBetween,
} from "../git/repository";
import type { GitDiffFile, GitCommit } from "../git/repository";
import { listStatuses } from "../lib/commit-statuses";
import type { CommitStatus } from "../db/schema";
import { html } from "hono/html";
import {
  getPreviewForBranch,
  previewStatusLabel,
} from "../lib/branch-previews";
import {
  Flex,
  Container,
  Badge,
  Button,
  LinkButton,
  Form,
  FormGroup,
  Input,
  TextArea,
  Select,
  EmptyState,
  FilterTabs,
  TabNav,
  List,
  ListItem,
  Text,
  Alert,
  MarkdownContent,
  CommentBox,
  formatRelative,
} from "../views/ui";

import { suggestReviewers, type ReviewerCandidate } from "../lib/reviewer-suggest";
import { computePrSize, type PrSizeInfo } from "../lib/pr-size";
import { BOT_USERNAME } from "../lib/bot-user";
import {
  getCodeownersForRepo,
  reviewersForChangedFiles,
} from "../lib/codeowners";
import { checkMergeEligible } from "../lib/branch-rules";
import {
  joinRoom,
  leaveRoom,
  updatePresence,
  pingSession,
  getRoomUsers,
  broadcastToRoom,
  registerSocket,
  unregisterSocket,
} from "../lib/pr-presence";
import { upgradeWebSocket, websocket as presenceWebsocket } from "hono/bun";

export { presenceWebsocket };
import { getBusFactorWarning, type BusFactorFile } from "../lib/bus-factor";
import { suggestPrSplit, type SplitSuggestion } from "../lib/pr-splitter";

const pulls = new Hono<AuthEnv>();

/* ──────────────────────────────────────────────────────────────────────
 * Inline CSS for the list page. Scoped with `.prs-*` so we do not bleed
 * into the issue tracker or any other route. Tokens come from layout.tsx
 * `:root` so light/dark stays consistent if/when light mode lands.
 * ──────────────────────────────────────────────────────────────────── */
const PRS_LIST_STYLES = `
  .prs-hero {
    position: relative;
    margin: 0 0 var(--space-5);
    padding: 22px 26px 24px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .prs-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .prs-hero-inner {
    position: relative;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 20px;
    flex-wrap: wrap;
  }
  .prs-hero-text { flex: 1; min-width: 280px; }
  .prs-hero-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .prs-hero-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 3.4vw, 34px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.06;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .prs-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .prs-hero-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .prs-hero-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .prs-cta {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 10px 16px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #6f5be8 60%, #36c5d6 140%);
    border: 1px solid rgba(140,109,255,0.55);
    box-shadow: 0 6px 18px -8px rgba(140,109,255,0.55);
    text-decoration: none;
    transition: transform 120ms ease, box-shadow 160ms ease;
  }
  .prs-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -6px rgba(140,109,255,0.6);
    color: #fff;
  }

  .prs-tabs {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin: 0 0 18px;
    padding: 6px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .prs-tab {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 13px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    border-radius: 8px;
    text-decoration: none;
    transition: background 120ms ease, color 120ms ease;
  }
  .prs-tab:hover { background: var(--bg-hover); color: var(--text); }
  .prs-tab.is-active {
    background: var(--bg-elevated);
    color: var(--text-strong);
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 4px 14px -8px rgba(0,0,0,0.4);
  }
  .prs-tab-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 22px; padding: 2px 7px;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 9999px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
  }
  .prs-tab.is-active .prs-tab-count {
    background: rgba(140,109,255,0.18);
    color: var(--text-link);
  }

  .prs-list { display: flex; flex-direction: column; gap: 10px; }
  .prs-row {
    position: relative;
    display: flex; align-items: flex-start; gap: 14px;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: transform 140ms ease, border-color 140ms ease, box-shadow 160ms ease;
  }
  .prs-row:hover {
    transform: translateY(-1px);
    border-color: var(--border-strong);
    box-shadow: 0 10px 22px -14px rgba(0,0,0,0.5);
  }
  .prs-row-icon {
    flex: 0 0 auto;
    width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 9999px;
    font-size: 13px;
    margin-top: 2px;
  }
  .prs-row-icon.state-open    { color: var(--green);  background: rgba(52,211,153,0.12); }
  .prs-row-icon.state-merged  { color: #b69dff;       background: rgba(140,109,255,0.16); }
  .prs-row-icon.state-closed  { color: var(--red);    background: rgba(248,113,113,0.12); }
  .prs-row-icon.state-draft   { color: var(--text-muted); background: rgba(255,255,255,0.05); }
  .prs-row-body { flex: 1; min-width: 0; }
  .prs-row-title {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    font-size: 15px; font-weight: 600;
    color: var(--text-strong);
    line-height: 1.35;
    margin: 0 0 6px;
  }
  .prs-row-number {
    color: var(--text-muted);
    font-weight: 400;
    font-size: 14px;
  }
  .prs-row-meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .prs-branch-chips {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .prs-branch-chip {
    padding: 2px 8px;
    border-radius: 9999px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .prs-branch-arrow {
    color: var(--text-faint);
    font-size: 11px;
  }
  .prs-row-tags {
    display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px;
    margin-left: auto;
  }
  .prs-tag {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-muted);
    line-height: 1.6;
  }
  .prs-tag.is-draft {
    color: var(--text-muted);
    border-color: var(--border-strong);
  }
  .prs-tag.is-merged {
    color: var(--text-link);
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.10);
  }
  .prs-tag.is-approved {
    color: #34d399;
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
  }
  .prs-tag.is-changes {
    color: #f87171;
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
  }

  .prs-empty {
    position: relative;
    padding: 56px 32px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: 16px;
    background: var(--bg-elevated);
    color: var(--text-muted);
    overflow: hidden;
  }
  .prs-empty::before {
    content: '';
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 50%, transparent 75%);
    filter: blur(70px);
    opacity: 0.55;
    pointer-events: none;
    animation: prsEmptyOrb 16s ease-in-out infinite;
  }
  @keyframes prsEmptyOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.5; }
    50%      { transform: scale(1.12) translate(-12px, 10px); opacity: 0.8; }
  }
  @media (prefers-reduced-motion: reduce) {
    .prs-empty::before { animation: none; }
  }
  .prs-empty-inner { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .prs-empty strong {
    display: block;
    color: var(--text-strong);
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin-bottom: 2px;
  }
  .prs-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    max-width: 460px;
    margin: 0 0 18px;
  }
  .prs-empty-cta { display: inline-flex; gap: 10px; flex-wrap: wrap; justify-content: center; }

  @media (max-width: 720px) {
    .prs-hero-inner { flex-direction: column; align-items: flex-start; }
    .prs-hero-actions { width: 100%; }
    .prs-row-tags { margin-left: 0; }
  }

  /* Additional mobile rules. Additive only. */
  @media (max-width: 720px) {
    .prs-hero { padding: 18px 18px 20px; }
    .prs-hero-actions .prs-cta { flex: 1; min-width: 0; justify-content: center; min-height: 44px; }
    .prs-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; flex-wrap: nowrap; }
    .prs-tab { min-height: 40px; padding: 9px 14px; white-space: nowrap; }
    .prs-row { padding: 12px 14px; gap: 10px; }
    .prs-row-icon { width: 24px; height: 24px; }
  }

  /* ─── Sort controls (PR list) ─── */
  .prs-sort-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 12px;
    flex-wrap: wrap;
  }
  .prs-sort-label {
    font-size: 12.5px;
    color: var(--text-muted);
    font-weight: 600;
    margin-right: 2px;
  }
  .prs-sort-opt {
    font-size: 12.5px;
    color: var(--text-muted);
    text-decoration: none;
    padding: 3px 10px;
    border-radius: 9999px;
    border: 1px solid transparent;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .prs-sort-opt:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .prs-sort-opt.is-active {
    background: rgba(140,109,255,0.12);
    color: var(--text-link);
    border-color: rgba(140,109,255,0.35);
    font-weight: 600;
  }
`;

/* ──────────────────────────────────────────────────────────────────────
 * Inline CSS for the detail page. Same `.prs-*` namespace.
 * ──────────────────────────────────────────────────────────────────── */
const PRS_DETAIL_STYLES = `
  .prs-detail-hero {
    position: relative;
    margin: 0 0 var(--space-4);
    padding: 24px 26px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .prs-detail-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .prs-detail-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 2.6vw, 28px);
    font-weight: 700;
    letter-spacing: -0.022em;
    line-height: 1.2;
    color: var(--text-strong);
    margin: 0 0 12px;
  }
  .prs-detail-num {
    color: var(--text-muted);
    font-weight: 400;
  }
  .prs-state-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    border-radius: 9999px;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1;
    border: 1px solid transparent;
  }
  .prs-state-pill.state-open    { color: var(--green);  background: rgba(52,211,153,0.12);  border-color: rgba(52,211,153,0.35); }
  .prs-state-pill.state-merged  { color: #b69dff;       background: rgba(140,109,255,0.16); border-color: rgba(140,109,255,0.45); }
  .prs-state-pill.state-closed  { color: var(--red);    background: rgba(248,113,113,0.12); border-color: rgba(248,113,113,0.35); }
  .prs-state-pill.state-draft   { color: var(--text-muted); background: rgba(255,255,255,0.05); border-color: var(--border-strong); }

  .prs-size-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    border: 1px solid currentColor;
    opacity: 0.85;
  }

  .prs-detail-meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .prs-detail-meta strong { color: var(--text); }
  .prs-detail-branches {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .prs-branch-pill {
    padding: 3px 9px;
    border-radius: 9999px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .prs-branch-pill.is-head { color: var(--text-strong); }
  .prs-branch-arrow-lg {
    color: var(--accent);
    font-size: 14px;
    font-weight: 700;
  }
  .prs-branch-sync {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11.5px; font-weight: 600;
    padding: 2px 8px;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-muted);
    cursor: default;
  }
  .prs-branch-sync.is-behind {
    color: #f87171;
    border-color: rgba(248,113,113,0.35);
    background: rgba(248,113,113,0.07);
  }
  .prs-branch-sync.is-synced {
    color: #34d399;
    border-color: rgba(52,211,153,0.35);
    background: rgba(52,211,153,0.07);
  }

  .prs-detail-actions {
    display: inline-flex; gap: 8px; margin-left: auto;
  }

  .prs-detail-tabs {
    display: flex; gap: 4px;
    margin: 0 0 16px;
    border-bottom: 1px solid var(--border);
  }
  .prs-detail-tab {
    padding: 10px 14px;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    transition: color 120ms ease, border-color 120ms ease;
    margin-bottom: -1px;
  }
  .prs-detail-tab:hover { color: var(--text); }
  .prs-detail-tab.is-active {
    color: var(--text-strong);
    border-bottom-color: var(--accent);
  }
  .prs-detail-tab-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; padding: 0 6px; margin-left: 6px;
    height: 18px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 9999px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
  }

  /* Gate / check status section */
  .prs-gate-card {
    margin-top: 20px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .prs-gate-head {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }
  .prs-gate-head h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .prs-gate-summary {
    margin-left: auto;
    font-size: 12px;
    color: var(--text-muted);
  }
  .prs-gate-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .prs-gate-row:last-child { border-bottom: 0; }
  .prs-gate-icon {
    flex: 0 0 auto;
    width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 700;
  }
  .prs-gate-icon.is-pass { color: var(--green); background: rgba(52,211,153,0.14); }
  .prs-gate-icon.is-fail { color: var(--red);   background: rgba(248,113,113,0.14); }
  .prs-gate-icon.is-skip { color: var(--text-muted); background: rgba(255,255,255,0.05); }
  .prs-gate-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    min-width: 140px;
  }
  .prs-gate-details {
    flex: 1; min-width: 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .prs-gate-pill {
    flex: 0 0 auto;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.5;
    border: 1px solid transparent;
  }
  .prs-gate-pill.is-pass { color: var(--green); background: rgba(52,211,153,0.10); border-color: rgba(52,211,153,0.30); }
  .prs-gate-pill.is-fail { color: var(--red);   background: rgba(248,113,113,0.10); border-color: rgba(248,113,113,0.30); }
  .prs-gate-pill.is-skip { color: var(--text-muted); background: rgba(255,255,255,0.04); border-color: var(--border-strong); }
  .prs-gate-footer {
    padding: 12px 18px;
    background: var(--bg-secondary);
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Comment cards */
  .prs-comment {
    margin-top: 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .prs-comment-head {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    flex-wrap: wrap;
  }
  .prs-comment-head strong { color: var(--text-strong); }
  .prs-comment-time { color: var(--text-muted); font-size: 12.5px; }
  .prs-comment-loc {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 2px 8px;
    border-radius: 6px;
  }
  .prs-comment-body { padding: 14px 18px; }
  .prs-comment.is-ai {
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.10), 0 6px 24px -10px rgba(140,109,255,0.30);
  }
  .prs-comment.is-ai .prs-comment-head {
    background: linear-gradient(90deg, rgba(140,109,255,0.10), rgba(54,197,214,0.06));
    border-bottom-color: rgba(140,109,255,0.30);
  }
  .prs-ai-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 9px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 130%);
    border-radius: 9999px;
  }
  .prs-bot-badge {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 7px;
    font-size: 10px;
    font-weight: 600;
    color: var(--fg-muted);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
  }

  /* Files-changed link card on conversation tab. (Diff itself is in DiffView.) */
  .prs-files-card {
    margin-top: 18px;
    padding: 14px 18px;
    display: flex; align-items: center; gap: 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    text-decoration: none;
    color: inherit;
    transition: border-color 120ms ease, transform 140ms ease;
  }
  .prs-files-card:hover {
    border-color: rgba(140,109,255,0.45);
    transform: translateY(-1px);
  }
  .prs-files-card-icon {
    width: 36px; height: 36px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 10px;
    background: rgba(140,109,255,0.12);
    color: var(--text-link);
    font-size: 18px;
  }
  .prs-files-card-text { flex: 1; min-width: 0; }
  .prs-files-card-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 2px;
  }
  .prs-files-card-sub {
    font-size: 12.5px;
    color: var(--text-muted);
    margin: 0;
  }
  .prs-files-card-cta {
    font-size: 12.5px;
    color: var(--text-link);
    font-weight: 600;
  }

  /* Merge area */
  .prs-merge-card {
    position: relative;
    margin-top: 22px;
    padding: 18px;
    background: var(--bg-elevated);
    border-radius: 14px;
    overflow: hidden;
  }
  .prs-merge-card::before {
    content: '';
    position: absolute; inset: 0;
    padding: 1px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(140,109,255,0.55) 0%, rgba(54,197,214,0.40) 100%);
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
            mask-composite: exclude;
    pointer-events: none;
  }
  .prs-merge-card.is-closed::before { background: var(--border-strong); }
  .prs-merge-card.is-merged::before { background: linear-gradient(135deg, rgba(140,109,255,0.45), rgba(54,197,214,0.30)); }
  .prs-merge-head {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 12px;
  }
  .prs-merge-head strong {
    font-family: var(--font-display);
    font-size: 15px;
    color: var(--text-strong);
    font-weight: 700;
  }
  .prs-merge-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 12px;
  }
  .prs-merge-actions {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  }
  .prs-merge-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #34d399 0%, #2bb886 60%, #36c5d6 140%);
    border: 1px solid rgba(52,211,153,0.55);
    box-shadow: 0 6px 18px -8px rgba(52,211,153,0.55);
    cursor: pointer;
    transition: transform 120ms ease, box-shadow 160ms ease;
  }
  .prs-merge-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(52,211,153,0.55);
  }
  .prs-merge-btn[disabled],
  .prs-merge-btn.is-disabled {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }
  .prs-merge-ready-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #6f5be8 60%, #36c5d6 140%);
    border: 1px solid rgba(140,109,255,0.55);
    box-shadow: 0 6px 18px -8px rgba(140,109,255,0.55);
    cursor: pointer;
    transition: transform 120ms ease, box-shadow 160ms ease;
  }
  .prs-merge-ready-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.55);
  }
  .prs-merge-back-draft {
    background: none; border: 1px solid var(--border-strong);
    color: var(--text-muted);
    padding: 9px 14px; border-radius: 10px;
    font-size: 13px; cursor: pointer;
  }
  .prs-merge-back-draft:hover { color: var(--text); background: var(--bg-hover); }

  /* Merge strategy selector */
  .prs-merge-strategy-wrap {
    display: inline-flex; align-items: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .prs-merge-strategy-label {
    font-size: 11.5px; font-weight: 600;
    color: var(--text-muted);
    padding: 0 10px 0 12px;
    white-space: nowrap;
  }
  .prs-merge-strategy-select {
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 13px;
    padding: 7px 10px 7px 4px;
    cursor: pointer;
    outline: none;
    appearance: auto;
  }
  .prs-merge-strategy-select:focus { outline: 2px solid rgba(140,109,255,0.45); }

  /* Review summary banner */
  .prs-review-summary {
    display: flex; flex-direction: column; gap: 6px;
    padding: 12px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-md, 8px);
    margin-bottom: 12px;
  }
  .prs-review-row {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px;
  }
  .prs-review-icon { font-size: 15px; font-weight: 700; flex-shrink: 0; }
  .prs-review-approved .prs-review-icon { color: #34d399; }
  .prs-review-changes .prs-review-icon { color: #f87171; }
  .prs-reviewer-avatar {
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--accent); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; flex-shrink: 0;
  }

  /* Review action buttons */
  .prs-review-approve-btn {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 8px 14px; border-radius: 8px; font-size: 13px;
    font-weight: 600; cursor: pointer;
    background: rgba(52,211,153,0.12);
    color: #34d399;
    border: 1px solid rgba(52,211,153,0.35);
    transition: background 120ms;
  }
  .prs-review-approve-btn:hover { background: rgba(52,211,153,0.22); }
  .prs-review-changes-btn {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 8px 14px; border-radius: 8px; font-size: 13px;
    font-weight: 600; cursor: pointer;
    background: rgba(248,113,113,0.10);
    color: #f87171;
    border: 1px solid rgba(248,113,113,0.30);
    transition: background 120ms;
  }
  .prs-review-changes-btn:hover { background: rgba(248,113,113,0.20); }

  /* Inline form helpers */
  .prs-inline-form { display: inline-flex; }

  /* Comment composer */
  .prs-composer { margin-top: 22px; }
  .prs-composer textarea {
    border-radius: 12px;
  }

  @media (max-width: 720px) {
    .prs-detail-actions { margin-left: 0; }
    .prs-merge-actions { width: 100%; }
    .prs-merge-actions > * { flex: 1; min-width: 0; }
  }

  /* Additional mobile rules. Additive only. */
  @media (max-width: 720px) {
    .prs-detail-hero { padding: 18px; }
    .prs-detail-meta { gap: 8px 12px; font-size: 12.5px; }
    .prs-detail-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; flex-wrap: nowrap; }
    .prs-detail-tab { white-space: nowrap; min-height: 44px; padding: 12px 14px; }
    .prs-gate-row { flex-wrap: wrap; padding: 12px 14px; }
    .prs-gate-name { min-width: 0; }
    .prs-gate-head { padding: 12px 14px; flex-wrap: wrap; }
    .prs-gate-summary { margin-left: 0; }
    .prs-merge-btn,
    .prs-merge-ready-btn,
    .prs-merge-back-draft { min-height: 44px; }
    .prs-comment-body { padding: 12px 14px; }
    .prs-comment-head { padding: 10px 12px; }
    .prs-files-card { padding: 12px 14px; }
  }

  /* ─── Live co-editing — presence pill + cursor ribbons ─── */
  .live-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px 4px 8px;
    margin-left: 6px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1;
    vertical-align: middle;
  }
  .live-pill.is-busy { color: var(--text); }
  .live-pill-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: #34d399;
    box-shadow: 0 0 0 2px rgba(52,211,153,0.18);
    animation: live-pulse 1.6s ease-in-out infinite;
  }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  .live-avatars {
    display: inline-flex;
    margin-left: 2px;
  }
  .live-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px; height: 22px;
    border-radius: 9999px;
    font-size: 10px;
    font-weight: 700;
    color: #0b1020;
    margin-left: -6px;
    border: 2px solid var(--bg-elevated);
    box-shadow: 0 1px 2px rgba(0,0,0,0.25);
  }
  .live-avatar:first-child { margin-left: 0; }
  .live-avatar.is-idle { opacity: 0.55; filter: grayscale(0.4); }
  .live-cursor-host {
    position: relative;
  }
  .live-cursor-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    border-radius: inherit;
  }
  .live-cursor {
    position: absolute;
    width: 2px;
    height: 18px;
    border-radius: 2px;
    transform: translate(-1px, 0);
    transition: transform 80ms linear, opacity 200ms ease;
  }
  .live-cursor::after {
    content: attr(data-label);
    position: absolute;
    top: -16px;
    left: -2px;
    font-size: 10px;
    line-height: 1;
    color: #0b1020;
    background: inherit;
    padding: 2px 5px;
    border-radius: 4px 4px 4px 0;
    white-space: nowrap;
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0,0,0,0.25);
  }
  .live-cursor.is-idle { opacity: 0.4; }
  .live-edit-tag {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #0b1020;
    border-radius: 9999px;
  }

  /* ─── Slash-command pill + composer hint ─── */
  .slash-hint {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding: 3px 9px;
    font-size: 11.5px;
    color: var(--text-muted);
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
    border-radius: 9999px;
    width: fit-content;
  }
  .slash-hint code {
    background: rgba(110, 168, 255, 0.12);
    color: var(--text-strong);
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
  }
  .slash-pill {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    column-gap: 10px;
    row-gap: 6px;
    margin: 10px 0;
    padding: 10px 14px;
    background: linear-gradient(
      135deg,
      rgba(110, 168, 255, 0.08),
      rgba(163, 113, 247, 0.06)
    );
    border: 1px solid rgba(110, 168, 255, 0.32);
    border-left: 3px solid var(--accent, #6ea8ff);
    border-radius: var(--radius);
    font-size: 13px;
    color: var(--text);
  }
  .slash-pill-icon {
    font-size: 14px;
    line-height: 1;
    filter: drop-shadow(0 0 4px rgba(110, 168, 255, 0.45));
  }
  .slash-pill-actor { color: var(--text-muted); }
  .slash-pill-actor strong { color: var(--text-strong); }
  .slash-pill-cmd {
    background: rgba(110, 168, 255, 0.16);
    color: var(--text-strong);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12.5px;
  }
  .slash-pill-time {
    color: var(--text-muted);
    font-size: 12px;
    justify-self: end;
  }
  .slash-pill-body {
    grid-column: 1 / -1;
    color: var(--text);
    font-size: 13px;
    line-height: 1.55;
  }
  .slash-pill-body p:first-child { margin-top: 0; }
  .slash-pill-body p:last-child { margin-bottom: 0; }
  .slash-pill.slash-cmd-merge { border-left-color: #56d364; }
  .slash-pill.slash-cmd-rebase { border-left-color: #f0883e; }
  .slash-pill.slash-cmd-needs-work { border-left-color: #f85149; }
  .slash-pill.slash-cmd-lgtm { border-left-color: #56d364; }

  /* ─── Branch-preview pill (migration 0062). Scoped .preview-*. */
  .preview-prpill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    text-decoration: none;
    border: 1px solid var(--border);
  }
  .preview-prpill:hover { color: var(--text-strong); border-color: rgba(140,109,255,0.45); }
  .preview-prpill .preview-prpill-dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: currentColor;
  }
  .preview-prpill.is-building { color: #fde68a; border-color: rgba(251,191,36,0.30); }
  .preview-prpill.is-building .preview-prpill-dot {
    animation: previewPrPulse 1.4s ease-in-out infinite;
  }
  .preview-prpill.is-ready    { color: #6ee7b7; border-color: rgba(52,211,153,0.30); }
  .preview-prpill.is-failed   { color: #fecaca; border-color: rgba(248,113,113,0.35); }
  .preview-prpill.is-expired  { color: #cbd5e1; border-color: rgba(148,163,184,0.30); }
  @keyframes previewPrPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* ─── AI Trio Review — 3-column verdict cards ─── */
  .trio-wrap {
    margin-top: 18px;
    padding: 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
  }
  .trio-header {
    display: flex; align-items: center; gap: 10px;
    margin: 0 0 12px;
    font-size: 13.5px;
    color: var(--text);
  }
  .trio-header strong { color: var(--text-strong); }
  .trio-header-sub { color: var(--text-muted); font-size: 12.5px; }
  .trio-header-dot {
    width: 8px; height: 8px; border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .trio-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .trio-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    display: flex; flex-direction: column;
    transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
  }
  .trio-card-head {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    background: rgba(255,255,255,0.02);
    font-size: 13px;
  }
  .trio-card-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px;
    border-radius: 9999px;
    font-size: 12px;
    background: rgba(255,255,255,0.05);
  }
  .trio-card-title {
    color: var(--text-strong);
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .trio-card-verdict {
    margin-left: auto;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 9999px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
  }
  .trio-card-body {
    padding: 12px 14px;
    font-size: 13px;
    color: var(--text);
    flex: 1;
    min-height: 64px;
    line-height: 1.55;
  }
  .trio-card-body p { margin: 0 0 8px; }
  .trio-card-body p:last-child { margin-bottom: 0; }
  .trio-card-body ul { margin: 0; padding-left: 18px; }
  .trio-card-body code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 5px;
  }
  .trio-card-empty {
    color: var(--text-muted);
    font-style: italic;
    font-size: 12.5px;
  }

  /* Pass state — neutral, no accent. */
  .trio-card.is-pass .trio-card-verdict {
    color: var(--green);
    border-color: rgba(52,211,153,0.35);
    background: rgba(52,211,153,0.12);
  }

  /* Per-persona fail accents: security=red, correctness=amber, style=blue. */
  .trio-card.trio-security.is-fail {
    border-color: rgba(248,113,113,0.55);
    box-shadow: 0 0 0 1px rgba(248,113,113,0.18), 0 8px 24px -12px rgba(248,113,113,0.45);
  }
  .trio-card.trio-security.is-fail .trio-card-head {
    background: linear-gradient(90deg, rgba(248,113,113,0.16), rgba(248,113,113,0.04));
    border-bottom-color: rgba(248,113,113,0.30);
  }
  .trio-card.trio-security.is-fail .trio-card-verdict {
    color: #fecaca;
    border-color: rgba(248,113,113,0.55);
    background: rgba(248,113,113,0.20);
  }

  .trio-card.trio-correctness.is-fail {
    border-color: rgba(251,191,36,0.55);
    box-shadow: 0 0 0 1px rgba(251,191,36,0.18), 0 8px 24px -12px rgba(251,191,36,0.45);
  }
  .trio-card.trio-correctness.is-fail .trio-card-head {
    background: linear-gradient(90deg, rgba(251,191,36,0.16), rgba(251,191,36,0.04));
    border-bottom-color: rgba(251,191,36,0.30);
  }
  .trio-card.trio-correctness.is-fail .trio-card-verdict {
    color: #fde68a;
    border-color: rgba(251,191,36,0.55);
    background: rgba(251,191,36,0.20);
  }

  .trio-card.trio-style.is-fail {
    border-color: rgba(96,165,250,0.55);
    box-shadow: 0 0 0 1px rgba(96,165,250,0.18), 0 8px 24px -12px rgba(96,165,250,0.45);
  }
  .trio-card.trio-style.is-fail .trio-card-head {
    background: linear-gradient(90deg, rgba(96,165,250,0.16), rgba(96,165,250,0.04));
    border-bottom-color: rgba(96,165,250,0.30);
  }
  .trio-card.trio-style.is-fail .trio-card-verdict {
    color: #bfdbfe;
    border-color: rgba(96,165,250,0.55);
    background: rgba(96,165,250,0.20);
  }

  /* Disagreement callout strip — yellow, prominent. */
  .trio-disagreement-strip {
    display: flex;
    gap: 12px;
    margin-top: 14px;
    padding: 12px 14px;
    background: linear-gradient(90deg, rgba(251,191,36,0.14), rgba(251,191,36,0.04));
    border: 1px solid rgba(251,191,36,0.45);
    border-radius: 10px;
    color: var(--text);
    font-size: 13px;
  }
  .trio-disagreement-icon {
    flex: 0 0 auto;
    width: 26px; height: 26px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 9999px;
    background: rgba(251,191,36,0.25);
    color: #fde68a;
    font-size: 14px;
  }
  .trio-disagreement-body strong {
    display: block;
    color: #fde68a;
    margin: 0 0 4px;
    font-weight: 700;
  }
  .trio-disagreement-list {
    margin: 0;
    padding-left: 18px;
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .trio-disagreement-list code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }

  @media (max-width: 720px) {
    .trio-grid { grid-template-columns: 1fr; }
    .trio-wrap { padding: 12px; }
  }

  /* ─── Task list progress pill ─── */
  .prs-tasks-pill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11.5px; font-weight: 600;
    padding: 2px 9px; border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-muted);
  }
  .prs-tasks-pill.is-complete {
    color: #34d399;
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
  }
  .prs-tasks-progress { display: inline-block; width: 36px; height: 4px; border-radius: 9999px; background: var(--border); overflow: hidden; vertical-align: middle; }
  .prs-tasks-progress-bar { height: 100%; border-radius: 9999px; background: #34d399; }

  /* ─── Update branch button ─── */
  .prs-update-branch-btn {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 12px; border-radius: 8px; font-size: 12.5px;
    font-weight: 600; cursor: pointer;
    background: rgba(96,165,250,0.10);
    color: #60a5fa;
    border: 1px solid rgba(96,165,250,0.30);
    transition: background 120ms;
  }
  .prs-update-branch-btn:hover { background: rgba(96,165,250,0.20); }

  /* ─── Linked issues panel ─── */
  .prs-linked-issues {
    margin-top: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .prs-linked-issues-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    font-size: 13px; font-weight: 600; color: var(--text);
  }
  .prs-linked-issues-count {
    font-size: 11px; font-weight: 700;
    padding: 1px 7px; border-radius: 9999px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
  }
  .prs-linked-issue-row {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    text-decoration: none; color: inherit;
  }
  .prs-linked-issue-row:last-child { border-bottom: none; }
  .prs-linked-issue-row:hover { background: var(--bg-hover); }
  .prs-linked-issue-icon { flex: 0 0 auto; font-size: 14px; }
  .prs-linked-issue-icon.is-open { color: #34d399; }
  .prs-linked-issue-icon.is-closed { color: #8b949e; }
  .prs-linked-issue-title { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .prs-linked-issue-num { color: var(--text-muted); font-size: 12px; }
  .prs-linked-issue-state { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 9999px; }
  .prs-linked-issue-state.is-open { color: #34d399; background: rgba(52,211,153,0.10); }
  .prs-linked-issue-state.is-closed { color: #8b949e; background: var(--bg-tertiary); }

  /* ─── Commits tab ─── */
  .prs-commits-list { display: flex; flex-direction: column; gap: 0; margin-top: 14px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .prs-commit-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); text-decoration: none; color: inherit; }
  .prs-commit-row:last-child { border-bottom: none; }
  .prs-commit-row:hover { background: var(--bg-hover); }
  .prs-commit-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin-top: 6px; }
  .prs-commit-body { flex: 1 1 auto; min-width: 0; }
  .prs-commit-msg { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .prs-commit-meta { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .prs-commit-sha { flex: 0 0 auto; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); background: var(--bg-elevated); padding: 2px 7px; border-radius: 6px; border: 1px solid var(--border); text-decoration: none; white-space: nowrap; }
  .prs-commit-sha:hover { color: var(--accent); }
  .prs-commits-empty { padding: 32px; text-align: center; color: var(--text-muted); font-size: 13.5px; }

  /* ─── Edit PR title/body ─── */
  .prs-edit-title-wrap { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .prs-edit-btn { background: none; border: 1px solid var(--border); color: var(--text-muted); font-size: 12px; padding: 3px 10px; border-radius: 6px; cursor: pointer; transition: color 120ms, border-color 120ms; }
  .prs-edit-btn:hover { color: var(--text); border-color: var(--text-muted); }
  .prs-edit-form { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
  .prs-edit-form input[type=text] { font-size: 15px; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text); width: 100%; box-sizing: border-box; }
  .prs-edit-actions { display: flex; gap: 8px; }
  .prs-edit-save-btn { padding: 7px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; background: var(--accent); color: #fff; border: none; cursor: pointer; }
  .prs-edit-cancel-btn { padding: 7px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; background: var(--bg-elevated); color: var(--text); border: 1px solid var(--border); cursor: pointer; }

  /* ─── CI status checks ─── */
  .prs-ci-card { margin-top: 14px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .prs-ci-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--bg-elevated); border-bottom: 1px solid var(--border); }
  .prs-ci-head h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text); }
  .prs-ci-summary { font-size: 12px; color: var(--text-muted); }
  .prs-ci-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  .prs-ci-row:last-child { border-bottom: none; }
  .prs-ci-icon { flex: 0 0 auto; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 11px; font-weight: 700; }
  .prs-ci-icon.is-success { background: rgba(52,211,153,0.20); color: #34d399; }
  .prs-ci-icon.is-pending { background: rgba(251,191,36,0.20); color: #fbbf24; }
  .prs-ci-icon.is-failure, .prs-ci-icon.is-error { background: rgba(248,113,113,0.20); color: #f87171; }
  .prs-ci-context { flex: 1 1 auto; font-size: 13px; font-weight: 500; color: var(--text); }
  .prs-ci-desc { font-size: 12px; color: var(--text-muted); }
  .prs-ci-pill { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 9999px; }
  .prs-ci-pill.is-success { color: #34d399; background: rgba(52,211,153,0.10); }
  .prs-ci-pill.is-pending { color: #fbbf24; background: rgba(251,191,36,0.10); }
  .prs-ci-pill.is-failure, .prs-ci-pill.is-error { color: #f87171; background: rgba(248,113,113,0.10); }
  .prs-ci-link { font-size: 12px; color: var(--accent); text-decoration: none; }
  .prs-ci-link:hover { text-decoration: underline; }

  /* ─── AI Trio verdict pills (header summary) ─── */
  .trio-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 700;
    border-radius: 9999px;
    border: 1px solid transparent;
    text-decoration: none;
    line-height: 1.6;
    letter-spacing: 0.01em;
    cursor: pointer;
    transition: opacity 120ms ease;
  }
  .trio-pill:hover { opacity: 0.8; }
  .trio-pill.is-pass {
    color: #34d399;
    background: rgba(52,211,153,0.10);
    border-color: rgba(52,211,153,0.35);
  }
  .trio-pill.is-fail {
    color: #f87171;
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.35);
  }
  .trio-pill.is-pending {
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    border-color: var(--border-strong);
  }
  .trio-pills-wrap {
    display: inline-flex; align-items: center; gap: 4px;
  }

  /* ─── Bus Factor Warning Panel ─── */
  .busfactor-panel {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 14px 18px;
    margin-bottom: 16px;
    border-radius: 12px;
    border: 1px solid rgba(245,158,11,0.35);
    background: rgba(245,158,11,0.06);
  }
  .busfactor-critical {
    border-color: rgba(239,68,68,0.4);
    background: rgba(239,68,68,0.06);
  }
  .busfactor-high {
    border-color: rgba(249,115,22,0.4);
    background: rgba(249,115,22,0.06);
  }
  .busfactor-medium {
    border-color: rgba(245,158,11,0.35);
    background: rgba(245,158,11,0.06);
  }
  .busfactor-icon { font-size: 20px; flex-shrink: 0; margin-top: 2px; }
  .busfactor-body { flex: 1; min-width: 0; }
  .busfactor-body strong { font-size: 14px; font-weight: 700; color: var(--text-strong); display: block; margin-bottom: 4px; }
  .busfactor-body p { font-size: 13px; color: var(--text-muted); margin: 0 0 8px; }
  .busfactor-body ul { margin: 0; padding-left: 18px; }
  .busfactor-body li { font-size: 12.5px; color: var(--text-muted); margin-bottom: 3px; font-family: var(--font-mono); }
  .busfactor-body li strong { font-size: 12.5px; color: var(--text); display: inline; }

  /* ─── PR Split Suggestion Panel ─── */
  .split-suggestion {
    margin-bottom: 16px;
    border: 1px solid rgba(140,109,255,0.35);
    border-radius: 12px;
    overflow: hidden;
  }
  .split-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 18px;
    background: rgba(140,109,255,0.06);
    flex-wrap: wrap;
  }
  .split-icon { font-size: 18px; flex-shrink: 0; }
  .split-header strong { font-size: 14px; font-weight: 700; color: var(--text-strong); flex: 1; min-width: 200px; }
  .split-stat { font-size: 12px; color: var(--text-muted); background: var(--bg-elevated); padding: 2px 9px; border-radius: 9999px; border: 1px solid var(--border); white-space: nowrap; }
  .split-toggle {
    background: none;
    border: 1px solid rgba(140,109,255,0.45);
    color: rgba(140,109,255,0.9);
    font-size: 12.5px;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 8px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 120ms ease;
  }
  .split-toggle:hover { background: rgba(140,109,255,0.1); }
  .split-body {
    padding: 16px 18px;
    border-top: 1px solid rgba(140,109,255,0.2);
  }
  .split-intro { font-size: 13.5px; color: var(--text-muted); margin: 0 0 14px; }
  .split-pr {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .split-pr:last-of-type { border-bottom: none; }
  .split-pr-num {
    width: 26px; height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 130%);
    color: #fff;
    font-size: 12px;
    font-weight: 800;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .split-pr-body { flex: 1; min-width: 0; }
  .split-pr-body strong { font-size: 13.5px; font-weight: 700; color: var(--text-strong); display: block; margin-bottom: 4px; }
  .split-pr-body p { font-size: 12.5px; color: var(--text-muted); margin: 0 0 6px; }
  .split-pr-body code { font-size: 12px; color: var(--text-muted); font-family: var(--font-mono); word-break: break-all; }
  .split-lines { display: inline-block; margin-left: 10px; font-size: 11.5px; color: var(--text-muted); background: var(--bg-tertiary); padding: 1px 7px; border-radius: 9999px; }
  .split-order { font-size: 13px; color: var(--text-muted); margin: 14px 0 0; }
  .split-order strong { color: var(--text); }
`;

/* ──────────────────────────────────────────────────────────────────────
 * Figma-style collaborative PR presence — styles for the presence bar
 * above the diff and the per-line reviewer cursor pills. All scoped
 * with `.presence-*` prefix so they never bleed into other views.
 * ──────────────────────────────────────────────────────────────────── */
const PRESENCE_STYLES = `
  .presence-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    margin: 0 0 10px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 12.5px;
    color: var(--text-muted);
    min-height: 38px;
  }
  .presence-bar-label {
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .presence-avatars {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    flex-wrap: wrap;
  }
  .presence-avatar {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px 3px 4px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    opacity: 0.92;
    transition: opacity 200ms;
  }
  .presence-avatar-dot {
    width: 20px; height: 20px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.22);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .presence-count {
    font-size: 12px;
    color: var(--text-faint);
    flex-shrink: 0;
  }
  /* Per-line reviewer cursor pill — injected by JS into .diff-row */
  .presence-line-pill {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    color: #fff;
    pointer-events: none;
    white-space: nowrap;
    z-index: 10;
    opacity: 0.88;
    animation: presence-in 160ms ease;
  }
  @keyframes presence-in {
    from { opacity: 0; transform: translateY(-50%) scale(0.85); }
    to   { opacity: 0.88; transform: translateY(-50%) scale(1); }
  }
  .presence-line-pill.is-typing::after {
    content: '…';
    opacity: 0.7;
  }
  /* diff rows with a cursor pill need relative positioning */
  .diff-row { position: relative; }
  /* Toast for join/leave events */
  .presence-toast-wrap {
    position: fixed;
    bottom: 24px;
    right: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
    pointer-events: none;
  }
  .presence-toast {
    padding: 8px 14px;
    border-radius: 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: 0 6px 20px -8px rgba(0,0,0,0.55);
    font-size: 13px;
    color: var(--text);
    opacity: 1;
    transition: opacity 400ms;
  }
  .presence-toast.fading { opacity: 0; }
`;


/**
 * Tiny inline JS that drives the "Suggest description with AI" button.
 * On click, gathers form values, POSTs JSON to the given endpoint, and
 * pipes the response into the #pr-body textarea. All DOM lookups are
 * defensive — element absence is a silent no-op.
 *
 * Built as a string template so it lives next to its server-side caller
 * and there is no bundler dependency. The endpoint URL is JSON-escaped
 * to avoid </script> breakouts.
 */
function AI_PR_DESC_SCRIPT(endpointUrl: string): string {
  const url = JSON.stringify(endpointUrl)
    .split("<").join("\\u003C")
    .split(">").join("\\u003E")
    .split("&").join("\\u0026");
  return (
    "(function(){try{" +
    "var btn=document.getElementById('ai-suggest-desc');" +
    "var status=document.getElementById('ai-suggest-status');" +
    "var body=document.getElementById('pr-body');" +
    "var form=btn&&btn.closest&&btn.closest('form');" +
    "if(!btn||!body||!form)return;" +
    "btn.addEventListener('click',function(ev){ev.preventDefault();" +
    "var fd=new FormData(form);" +
    "var title=String(fd.get('title')||'').trim();" +
    "var base=String(fd.get('base')||'').trim();" +
    "var head=String(fd.get('head')||'').trim();" +
    "if(!base||!head){if(status)status.textContent='Pick base + head first.';return;}" +
    "btn.disabled=true;if(status)status.textContent='Drafting (10-30s)...';" +
    "fetch(" + url + ",{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'title='+encodeURIComponent(title)+'&base='+encodeURIComponent(base)+'&head='+encodeURIComponent(head),credentials:'same-origin'})" +
    ".then(function(r){return r.json().catch(function(){return {ok:false,error:'Server error.'};});})" +
    ".then(function(j){btn.disabled=false;" +
    "if(j&&j.ok&&typeof j.body==='string'){if(body.value&&body.value.trim().length>0){if(!confirm('Replace existing description?')){if(status)status.textContent='Cancelled.';return;}}" +
    "body.value=j.body;if(status)status.textContent='Filled from AI. Review before submitting.';" +
    "}else{if(status)status.textContent=(j&&j.error)||'AI unavailable.';}" +
    "}).catch(function(){btn.disabled=false;if(status)status.textContent='Network error.';});" +
    "});" +
    "}catch(e){}})();"
  );
}

/**
 * Live co-editing client. Connects to the per-PR SSE feed and:
 *   - Maintains a "Live: N editing" pill in the PR header (avatars +
 *     status colour per user).
 *   - Renders tinted cursor caret overlays inside #pr-body and every
 *     `[data-live-field]` element.
 *   - Broadcasts the local user's cursor position (selectionStart /
 *     selectionEnd) debounced at 100ms.
 *   - Broadcasts content patches (`replace` of the whole textarea —
 *     last-write-wins v1) debounced at 250ms.
 *   - Pings /heartbeat every 15s; on receiving a peer's edit applies it
 *     to the matching local field if untouched.
 *
 * All endpoint URLs are JSON-escaped via safe replacements so they
 * can't break out of the <script> tag.
 */

/**
 * Figma-style collaborative PR presence client (WebSocket).
 *
 * Connects to `GET /:owner/:repo/pulls/:number/presence` (WebSocket upgrade).
 * On connect the server sends `{type:"init", users:[...]}` so the bar renders
 * immediately. Subsequent messages from the server drive the presence bar and
 * per-line cursor pills in the diff.
 *
 * Outbound messages:
 *   {type:"cursor", line: N}   — user hovered a diff line
 *   {type:"typing", line: N, typing: bool}  — textarea focus/blur in diff
 *   {type:"ping"}              — keep-alive every 10s
 *
 * Inbound messages:
 *   {type:"init",   users:[{sessionId,username,colour,line,typing}]}
 *   {type:"join",   user:{sessionId,username,colour,line,typing}}
 *   {type:"leave",  sessionId}
 *   {type:"cursor", sessionId, username, colour, line}
 *   {type:"typing", sessionId, username, colour, line, typing}
 */
function PR_PRESENCE_SCRIPT(owner: string, repo: string, prNum: number): string {
  const wsPath = JSON.stringify(`/${owner}/${repo}/pulls/${prNum}/presence`)
    .split("<").join("\\u003C")
    .split(">").join("\\u003E")
    .split("&").join("\\u0026");
  return `(function(){
try{
var wsPath=${wsPath};
var proto=location.protocol==='https:'?'wss:':'ws:';
var url=proto+'//'+location.host+wsPath;
var mySessionId=null;
// sessionId -> {username, colour, line, typing}
var peers={};
var ws=null;
var pingTimer=null;
var reconnectDelay=1500;
var reconnectTimer=null;

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}

// ── Toast ──────────────────────────────────────────────────────────────
var toastWrap=document.getElementById('presence-toasts');
function toast(msg){
  if(!toastWrap)return;
  var t=document.createElement('div');
  t.className='presence-toast';
  t.textContent=msg;
  toastWrap.appendChild(t);
  setTimeout(function(){t.classList.add('fading');setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t);},420);},2500);
}

// ── Presence bar ───────────────────────────────────────────────────────
var avEl=document.getElementById('presence-avatars');
var countEl=document.getElementById('presence-count');
function renderBar(){
  if(!avEl)return;
  var ids=Object.keys(peers);
  var html='';
  for(var i=0;i<ids.length&&i<8;i++){
    var p=peers[ids[i]];
    var initials=(p.username||'?').slice(0,2).toUpperCase();
    html+='<span class="presence-avatar" style="background:'+esc(p.colour)+'" title="'+esc(p.username)+'">';
    html+='<span class="presence-avatar-dot">'+esc(initials)+'</span>';
    html+=esc(p.username);
    html+='</span>';
  }
  avEl.innerHTML=html;
  if(countEl){
    var n=ids.length;
    countEl.textContent=n===0?'No other reviewers':n===1?'1 reviewer online':n+' reviewers online';
  }
}

// ── Diff cursor pills ──────────────────────────────────────────────────
// data-line value is like "12:x:5" or "12:5:x" — pull numeric line only
function lineNumFromKey(key){var m=String(key).match(/(\d+)/);return m?parseInt(m[1],10):null;}
function findDiffRow(line){return document.querySelector('[data-line]') &&
  (function(){var rows=document.querySelectorAll('[data-line]');
    for(var i=0;i<rows.length;i++){var n=lineNumFromKey(rows[i].getAttribute('data-line')||'');if(n===line)return rows[i];}
    return null;
  })();}
function removePill(sessionId){var old=document.querySelector('[data-presence-sid="'+sessionId+'"]');if(old&&old.parentNode)old.parentNode.removeChild(old);}
function placePill(sessionId,username,colour,line,typing){
  removePill(sessionId);
  if(line==null)return;
  var row=findDiffRow(line);if(!row)return;
  var pill=document.createElement('span');
  pill.className='presence-line-pill'+(typing?' is-typing':'');
  pill.setAttribute('data-presence-sid',sessionId);
  pill.style.background=colour||'#8c6dff';
  pill.textContent=(username||'?').slice(0,12)+(typing?' typing':'');
  row.appendChild(pill);
}
function clearPeer(sessionId){removePill(sessionId);delete peers[sessionId];}

// ── Inbound message handler ────────────────────────────────────────────
function onMsg(raw){
  var d;try{d=JSON.parse(raw);}catch(e){return;}
  if(!d||!d.type)return;
  if(d.type==='init'){
    mySessionId=d.sessionId||null;
    peers={};
    (d.users||[]).forEach(function(u){
      if(u.sessionId===mySessionId)return;
      peers[u.sessionId]={username:u.username,colour:u.colour,line:u.line,typing:u.typing};
      placePill(u.sessionId,u.username,u.colour,u.line,u.typing);
    });
    renderBar();
  } else if(d.type==='join'){
    if(d.user&&d.user.sessionId!==mySessionId){
      peers[d.user.sessionId]={username:d.user.username,colour:d.user.colour,line:d.user.line,typing:d.user.typing};
      renderBar();
      toast(esc(d.user.username)+' joined the review');
    }
  } else if(d.type==='leave'){
    if(d.sessionId&&d.sessionId!==mySessionId){
      var name=peers[d.sessionId]&&peers[d.sessionId].username;
      clearPeer(d.sessionId);
      renderBar();
      if(name)toast(esc(name)+' left the review');
    }
  } else if(d.type==='cursor'){
    if(d.sessionId&&d.sessionId!==mySessionId){
      if(peers[d.sessionId]){peers[d.sessionId].line=d.line;peers[d.sessionId].typing=false;}
      placePill(d.sessionId,d.username,d.colour,d.line,false);
    }
  } else if(d.type==='typing'){
    if(d.sessionId&&d.sessionId!==mySessionId){
      if(peers[d.sessionId]){peers[d.sessionId].line=d.line;peers[d.sessionId].typing=d.typing;}
      placePill(d.sessionId,d.username,d.colour,d.line,d.typing);
    }
  }
}

// ── Outbound helpers ───────────────────────────────────────────────────
function send(obj){try{if(ws&&ws.readyState===1)ws.send(JSON.stringify(obj));}catch(e){}}

// ── Mouse hover on diff rows ───────────────────────────────────────────
var hoverTimer=null;
document.addEventListener('mouseover',function(ev){
  var row=ev.target&&ev.target.closest&&ev.target.closest('[data-line]');
  if(!row)return;
  if(hoverTimer)clearTimeout(hoverTimer);
  hoverTimer=setTimeout(function(){
    var key=row.getAttribute('data-line')||'';
    var line=lineNumFromKey(key);
    if(line!=null)send({type:'cursor',line:line});
  },80);
});

// ── Typing detection in diff comment textareas ─────────────────────────
document.addEventListener('focusin',function(ev){
  var ta=ev.target;
  if(!ta||ta.tagName!=='TEXTAREA')return;
  var row=ta.closest&&ta.closest('[data-line]');if(!row)return;
  var line=lineNumFromKey(row.getAttribute('data-line')||'');
  if(line!=null)send({type:'typing',line:line,typing:true});
});
document.addEventListener('focusout',function(ev){
  var ta=ev.target;
  if(!ta||ta.tagName!=='TEXTAREA')return;
  var row=ta.closest&&ta.closest('[data-line]');if(!row)return;
  var line=lineNumFromKey(row.getAttribute('data-line')||'');
  if(line!=null)send({type:'typing',line:line,typing:false});
});

// ── WebSocket lifecycle ────────────────────────────────────────────────
function connect(){
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
  try{ws=new WebSocket(url);}catch(e){scheduleReconnect();return;}
  ws.onopen=function(){
    reconnectDelay=1500;
    pingTimer=setInterval(function(){send({type:'ping'});},10000);
  };
  ws.onmessage=function(ev){onMsg(ev.data);};
  ws.onclose=function(){
    if(pingTimer){clearInterval(pingTimer);pingTimer=null;}
    scheduleReconnect();
  };
  ws.onerror=function(){try{ws.close();}catch(e){}};
}
function scheduleReconnect(){
  reconnectTimer=setTimeout(function(){connect();},reconnectDelay);
  reconnectDelay=Math.min(reconnectDelay*2,30000);
}

connect();
}catch(e){}})();`;
}

function LIVE_COEDIT_SCRIPT(prId: string): string {
  const idJson = JSON.stringify(prId)
    .split("<").join("\\u003C")
    .split(">").join("\\u003E")
    .split("&").join("\\u0026");
  return (
    "(function(){try{" +
    "if(typeof EventSource==='undefined')return;" +
    "var prId=" + idJson + ";" +
    "var base='/api/v2/pulls/'+encodeURIComponent(prId)+'/live';" +
    "var pill=document.getElementById('live-pill');" +
    "var avEl=document.getElementById('live-avatars');" +
    "var countEl=document.getElementById('live-count');" +
    "var sessionId=null;var myColor=null;" +
    "var presence={};" + // sessionId -> {color,status,userId,initials}
    "var lastApplied={};" + // field -> last server value (for echo suppression)
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}" +
    "function initials(id){if(!id)return '?';var s=String(id);return s.slice(0,2).toUpperCase();}" +
    "function renderPresence(){if(!pill)return;var ids=Object.keys(presence).filter(function(k){return presence[k].status!=='left'&&k!==sessionId;});" +
    "var n=ids.length;if(countEl)countEl.textContent=String(n);" +
    "if(pill.classList){if(n>0)pill.classList.add('is-busy');else pill.classList.remove('is-busy');}" +
    "if(avEl){var html='';for(var i=0;i<ids.length&&i<5;i++){var p=presence[ids[i]];" +
    "html+='<span class=\"live-avatar'+(p.status==='idle'?' is-idle':'')+'\" style=\"background:'+esc(p.color)+'\" title=\"'+esc(p.label||'editor')+'\">'+esc(p.initials)+'</span>';}" +
    "avEl.innerHTML=html;}}" +
    "function ensureOverlay(host){if(!host)return null;var ov=host.querySelector(':scope > .live-cursor-overlay');" +
    "if(!ov){ov=document.createElement('div');ov.className='live-cursor-overlay';host.classList.add('live-cursor-host');host.appendChild(ov);}return ov;}" +
    "function fieldEl(field){if(field==='description')return document.getElementById('pr-body');" +
    "return document.querySelector('[data-live-field=\"'+(field.replace(/\"/g,'\\\\\"'))+'\"]');}" +
    "function placeCursor(sid,position){var p=presence[sid];if(!p||sid===sessionId)return;" +
    "var ta=fieldEl(position.field);if(!ta||!ta.parentElement)return;" +
    "var host=ta.parentElement;var ov=ensureOverlay(host);if(!ov)return;" +
    "var c=ov.querySelector('[data-sid=\"'+sid+'\"]');" +
    "if(!c){c=document.createElement('div');c.className='live-cursor';c.setAttribute('data-sid',sid);c.style.background=p.color;c.setAttribute('data-label',p.label||'editor');ov.appendChild(c);}" +
    "var rect=ta.getBoundingClientRect();var hostRect=host.getBoundingClientRect();" +
    "var x=ta.offsetLeft+6;var y=ta.offsetTop+6;" +
    "try{var lineH=parseFloat(getComputedStyle(ta).lineHeight)||18;" +
    "var text=ta.value||'';var pos=Math.max(0,Math.min(text.length,position.range&&position.range.start||0));" +
    "var before=text.slice(0,pos);var nl=(before.match(/\\n/g)||[]).length;" +
    "var lastNl=before.lastIndexOf('\\n');var col=pos-lastNl-1;" +
    "x=ta.offsetLeft+6+Math.min(col*7,Math.max(0,rect.width-30));" +
    "y=ta.offsetTop+6+nl*lineH-ta.scrollTop;" +
    "}catch(e){}" +
    "c.style.transform='translate('+x+'px,'+y+'px)';" +
    "if(p.status==='idle')c.classList.add('is-idle');else c.classList.remove('is-idle');}" +
    "function removeCursor(sid){var nodes=document.querySelectorAll('[data-sid=\"'+sid+'\"]');" +
    "for(var i=0;i<nodes.length;i++){try{nodes[i].parentNode.removeChild(nodes[i]);}catch(e){}}}" +
    "var es;var delay=1000;" +
    "function connect(){try{es=new EventSource(base);}catch(e){setTimeout(connect,delay);return;}" +
    "es.addEventListener('hello',function(m){try{var d=JSON.parse(m.data);sessionId=d.sessionId||null;myColor=d.color||null;" +
    "(d.presence||[]).forEach(function(s){presence[s.id]={color:s.color,status:s.status,userId:s.userId,initials:initials(s.userId||s.agentSessionId),label:s.userId?'user':'agent'};});renderPresence();}catch(e){}});" +
    "es.addEventListener('presence-join',function(m){try{var d=JSON.parse(m.data);presence[d.sessionId]={color:d.color,status:d.status,userId:d.userId,initials:initials(d.userId||d.agentSessionId),label:d.userId?'user':'agent'};renderPresence();}catch(e){}});" +
    "es.addEventListener('presence-update',function(m){try{var d=JSON.parse(m.data);if(presence[d.sessionId]){presence[d.sessionId].status=d.status;renderPresence();}}catch(e){}});" +
    "es.addEventListener('presence-leave',function(m){try{var d=JSON.parse(m.data);delete presence[d.sessionId];removeCursor(d.sessionId);renderPresence();}catch(e){}});" +
    "es.addEventListener('cursor',function(m){try{var d=JSON.parse(m.data);placeCursor(d.sessionId,d.position);}catch(e){}});" +
    "es.addEventListener('edit',function(m){try{var d=JSON.parse(m.data);if(d.sessionId===sessionId)return;" +
    "var patch=d.patch;if(!patch||!patch.field)return;" +
    "var ta=fieldEl(patch.field);if(!ta)return;" +
    "if(document.activeElement===ta)return;" + // don't trample local typing
    "if(patch.op==='replace'&&typeof patch.value==='string'){ta.value=patch.value;lastApplied[patch.field]=patch.value;}" +
    "}catch(e){}});" +
    "es.onerror=function(){try{es.close();}catch(e){}setTimeout(connect,delay);};" +
    "}connect();" +
    "function post(suffix,body){try{return fetch(base+suffix,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(body)}).catch(function(){});}catch(e){}}" +
    "var cursorTimer=null;function sendCursor(field,start,end){if(!sessionId)return;if(cursorTimer)clearTimeout(cursorTimer);" +
    "cursorTimer=setTimeout(function(){post('/cursor',{sessionId:sessionId,position:{field:field,range:{start:start,end:end}}});},100);}" +
    "var editTimer=null;function sendEdit(field,value){if(!sessionId)return;if(editTimer)clearTimeout(editTimer);" +
    "editTimer=setTimeout(function(){post('/edit',{sessionId:sessionId,patch:{field:field,op:'replace',at:0,value:value}});lastApplied[field]=value;},250);}" +
    "function wire(el,field){if(!el||el.__liveWired)return;el.__liveWired=true;" +
    "el.addEventListener('input',function(){sendEdit(field,el.value);});" +
    "el.addEventListener('keyup',function(){sendCursor(field,el.selectionStart||0,el.selectionEnd||0);});" +
    "el.addEventListener('click',function(){sendCursor(field,el.selectionStart||0,el.selectionEnd||0);});" +
    "el.addEventListener('select',function(){sendCursor(field,el.selectionStart||0,el.selectionEnd||0);});" +
    "}" +
    "var body=document.getElementById('pr-body');if(body)wire(body,'description');" +
    "var live=document.querySelectorAll('[data-live-field]');" +
    "for(var i=0;i<live.length;i++){var f=live[i].getAttribute('data-live-field');if(f)wire(live[i],f);}" +
    "setInterval(function(){if(sessionId)post('/heartbeat',{sessionId:sessionId});},15000);" +
    "window.addEventListener('beforeunload',function(){if(!sessionId)return;try{var blob=new Blob([JSON.stringify({sessionId:sessionId})],{type:'application/json'});if(navigator.sendBeacon)navigator.sendBeacon(base+'/leave',blob);else post('/leave',{sessionId:sessionId});}catch(e){}});" +
    "}catch(e){}})();"
  );
}

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

// PR Nav helper
const PrNav = ({
  owner,
  repo,
  active,
}: {
  owner: string;
  repo: string;
  active: "code" | "issues" | "pulls" | "commits";
}) => (
  <TabNav
    tabs={[
      { label: "Code", href: `/${owner}/${repo}`, active: active === "code" },
      { label: "Issues", href: `/${owner}/${repo}/issues`, active: active === "issues" },
      { label: "Pull Requests", href: `/${owner}/${repo}/pulls`, active: active === "pulls" },
      { label: "Commits", href: `/${owner}/${repo}/commits`, active: active === "commits" },
    ]}
  />
);

/**
 * Block M3 — pre-merge risk score card. Pure presentational helper.
 * Rendered in the conversation tab above the gate checks block. Hidden
 * entirely when the PR is closed/merged or there is nothing cached and
 * nothing in-flight.
 */
function PrRiskCard({
  risk,
  calculating,
}: {
  risk: PrRiskScore | null;
  calculating: boolean;
}) {
  if (!risk) {
    return (
      <div
        style={`margin-top: 20px; padding: 14px 16px; background: var(--bg-secondary); border: 1px dashed var(--border); border-radius: var(--radius); color: var(--text-muted)`}
      >
        <strong style="font-size: 13px; color: var(--text)">
          Risk score: calculating…
        </strong>
        <div style="font-size: 12px; margin-top: 4px">
          Refresh in a moment to see the pre-merge risk score for this PR.
        </div>
      </div>
    );
  }

  const palette = riskBandPalette(risk.band);
  const label = riskBandLabel(risk.band);

  return (
    <div
      style={`margin-top: 20px; padding: 14px 16px; background: var(--bg-secondary); border: 2px solid ${palette.border}; border-radius: var(--radius)`}
    >
      <div style="display:flex;align-items:center;gap:8px;font-size:14px">
        <strong>Risk score:</strong>
        <span style={`color:${palette.border};font-weight:600`}>
          {palette.icon} {label} ({risk.score}/10)
        </span>
        <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">
          {risk.commitSha.slice(0, 7)}
        </span>
      </div>
      {risk.aiSummary && (
        <div style="font-size:13px;color:var(--text);margin-top:8px;line-height:1.5">
          {risk.aiSummary}
        </div>
      )}
      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-size:12px;color:var(--text-muted)">
          See full signal breakdown
        </summary>
        <ul style="font-size:12px;margin:8px 0 0 0;padding-left:18px;color:var(--text)">
          <li>files changed: {risk.signals.filesChanged}</li>
          <li>
            lines added/removed: {risk.signals.linesAdded} /{" "}
            {risk.signals.linesRemoved}
          </li>
          <li>distinct owners touched: {risk.signals.teamsAffected}</li>
          <li>
            schema migration touched:{" "}
            {risk.signals.schemaMigrationTouched ? "yes" : "no"}
          </li>
          <li>
            locked / sensitive path touched:{" "}
            {risk.signals.lockedPathTouched ? "yes" : "no"}
          </li>
          <li>
            adds new dependency:{" "}
            {risk.signals.addsNewDependency ? "yes" : "no"}
          </li>
          <li>
            bumps major dependency:{" "}
            {risk.signals.bumpsMajorDependency ? "yes" : "no"}
          </li>
          <li>
            tests added for new code:{" "}
            {risk.signals.testsAddedForNewCode ? "yes" : "no"}
          </li>
          <li>
            diff-minus-test ratio:{" "}
            {risk.signals.diffMinusTestRatio.toFixed(2)}
          </li>
        </ul>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
          How is this calculated? The score is a transparent sum of
          weighted signals — see <code>src/lib/pr-risk.ts</code>
          {" "}<code>computePrRiskScore</code>.
        </div>
      </details>
      {calculating && (
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
          (recomputing for the latest commit — refresh to update)
        </div>
      )}
    </div>
  );
}

function riskBandPalette(band: PrRiskScore["band"]): {
  border: string;
  icon: string;
} {
  switch (band) {
    case "low":
      return { border: "var(--green)", icon: "" };
    case "medium":
      return { border: "var(--yellow, #d29922)", icon: "ℹ" };
    case "high":
      return { border: "var(--orange, #db6d28)", icon: "⚠" };
    case "critical":
      return { border: "var(--red)", icon: "\u{1F6D1}" };
  }
}

function riskBandLabel(band: PrRiskScore["band"]): string {
  switch (band) {
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
      return "HIGH";
    case "critical":
      return "CRITICAL";
  }
}

// ---------------------------------------------------------------------------
// AI Trio Review — 3-column card grid + disagreement callout.
//
// The trio reviewer (src/lib/ai-review-trio.ts) writes four prComments
// per run: one per persona (security/correctness/style) plus a top-level
// summary. We surface them here as a single grid above the normal
// comment stream so reviewers see the verdicts at a glance.
// ---------------------------------------------------------------------------

const TRIO_PERSONAS: TrioPersona[] = ["security", "correctness", "style"];

interface TrioCommentLike {
  body: string;
}

function isTrioComment(body: string | null | undefined): boolean {
  if (!body) return false;
  return (
    body.includes(TRIO_SUMMARY_MARKER) ||
    body.includes(TRIO_COMMENT_MARKER.security) ||
    body.includes(TRIO_COMMENT_MARKER.correctness) ||
    body.includes(TRIO_COMMENT_MARKER.style)
  );
}

function trioPersonaOfComment(body: string): TrioPersona | null {
  for (const p of TRIO_PERSONAS) {
    if (body.includes(TRIO_COMMENT_MARKER[p])) return p;
  }
  return null;
}

/**
 * Best-effort verdict parse from a persona comment body. The body shape
 * is generated by `renderPersonaCommentBody` in `ai-review-trio.ts` —
 * we only need the "Pass" / "Fail" word from the H2 heading.
 */
function trioVerdictOfBody(body: string): "pass" | "fail" | null {
  const m = body.match(/##\s+AI\s+\w+\s+Review\s+—\s+(Pass|Fail)/i);
  if (!m) return null;
  return m[1].toLowerCase() === "pass" ? "pass" : "fail";
}

/**
 * Parse the disagreement bullet list out of the summary comment so we
 * can render it as a polished callout strip. Returns [] when nothing
 * matches — the comment author may have edited the marker out.
 */
function parseDisagreements(summaryBody: string): Array<{
  file: string;
  failing: string;
  passing: string;
}> {
  const out: Array<{ file: string; failing: string; passing: string }> = [];
  // Each disagreement line looks like:
  // - `path:42` — security, style say ✗, correctness say ✓
  const re = /-\s+`([^`]+)`\s+—\s+([^✗]+)say\s+✗,\s+([^✓]+)say\s+✓/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(summaryBody)) !== null) {
    out.push({
      file: m[1].trim(),
      failing: m[2].trim().replace(/[,\s]+$/g, ""),
      passing: m[3].trim().replace(/[,\s]+$/g, ""),
    });
  }
  return out;
}

function TrioReviewGrid({ comments }: { comments: TrioCommentLike[] }) {
  // Find the most recent persona comments + summary. We iterate from
  // the end so re-reviews (multiple runs on the same PR) display the
  // freshest verdict.
  const latest: Partial<Record<TrioPersona, string>> = {};
  let summaryBody: string | null = null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body || "";
    if (!isTrioComment(body)) continue;
    if (body.includes(TRIO_SUMMARY_MARKER) && !summaryBody) {
      summaryBody = body;
      continue;
    }
    const persona = trioPersonaOfComment(body);
    if (persona && !latest[persona]) latest[persona] = body;
  }
  const anyPersona = TRIO_PERSONAS.some((p) => !!latest[p]);
  if (!anyPersona && !summaryBody) return null;

  const disagreements = summaryBody ? parseDisagreements(summaryBody) : [];

  return (
    <div class="trio-wrap" id="trio-review-section">
      <div class="trio-header">
        <span class="trio-header-dot" aria-hidden="true"></span>
        <strong>AI Trio Review</strong>
        <span class="trio-header-sub">
          Three independent reviewers ran in parallel.
        </span>
      </div>
      <div class="trio-grid">
        {TRIO_PERSONAS.map((persona) => {
          const body = latest[persona];
          const verdict = body ? trioVerdictOfBody(body) : null;
          const stateClass =
            verdict === "fail"
              ? "is-fail"
              : verdict === "pass"
                ? "is-pass"
                : "is-pending";
          return (
            <div class={`trio-card trio-${persona} ${stateClass}`}>
              <div class="trio-card-head">
                <span class="trio-card-icon" aria-hidden="true">
                  {persona === "security"
                    ? "🛡"
                    : persona === "correctness"
                      ? "✓"
                      : "✎"}
                </span>
                <strong class="trio-card-title">
                  {persona[0].toUpperCase() + persona.slice(1)}
                </strong>
                <span class="trio-card-verdict">
                  {verdict === "pass"
                    ? "Pass"
                    : verdict === "fail"
                      ? "Fail"
                      : "Pending"}
                </span>
              </div>
              <div class="trio-card-body">
                {body ? (
                  <MarkdownContent
                    html={renderMarkdown(stripTrioHeading(body))}
                  />
                ) : (
                  <span class="trio-card-empty">
                    Awaiting reviewer output.
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {disagreements.length > 0 && (
        <div class="trio-disagreement-strip" role="note">
          <span class="trio-disagreement-icon" aria-hidden="true">
            ⚠
          </span>
          <div class="trio-disagreement-body">
            <strong>Reviewers disagree — review carefully.</strong>
            <ul class="trio-disagreement-list">
              {disagreements.map((d) => (
                <li>
                  <code>{d.file}</code> — {d.failing} says ✗,{" "}
                  {d.passing} says ✓
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Strip the marker comment + first H2 heading from a persona body so
 * the card body shows just the findings list (verdict is already in
 * the card head). Best-effort — malformed bodies render whole.
 */
function stripTrioHeading(body: string): string {
  return body
    .replace(/<!--\s*ai-trio:(?:security|correctness|style|summary)\s*-->\s*/g, "")
    .replace(/^##\s+AI\s+\w+\s+Review[^\n]*\n+/m, "")
    .trim();
}

/**
 * Three small verdict pills rendered inline in the PR header. Each pill
 * links to the `#trio-review-section` anchor so clicking scrolls to the
 * full card grid. Only shown when `AI_TRIO_REVIEW_ENABLED=1` and at
 * least one persona comment exists.
 */
function TrioVerdictPills({
  comments,
}: {
  comments: TrioCommentLike[];
}) {
  if (!isTrioReviewEnabled()) return null;

  // Find latest persona verdicts (same logic as TrioReviewGrid).
  const latest: Partial<Record<TrioPersona, string>> = {};
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body || "";
    if (!isTrioComment(body)) continue;
    if (body.includes(TRIO_SUMMARY_MARKER)) continue;
    const persona = trioPersonaOfComment(body);
    if (persona && !latest[persona]) latest[persona] = body;
  }

  const anyPersona = TRIO_PERSONAS.some((p) => !!latest[p]);
  if (!anyPersona) return null;

  const PERSONA_LABEL: Record<TrioPersona, string> = {
    security: "Security",
    correctness: "Correctness",
    style: "Style",
  };
  const PERSONA_ICON: Record<TrioPersona, string> = {
    security: "🛡",
    correctness: "✓",
    style: "✎",
  };

  return (
    <span class="trio-pills-wrap" aria-label="AI Trio Review verdicts">
      {TRIO_PERSONAS.map((persona) => {
        const body = latest[persona];
        const verdict = body ? trioVerdictOfBody(body) : null;
        const stateClass =
          verdict === "pass"
            ? "is-pass"
            : verdict === "fail"
              ? "is-fail"
              : "is-pending";
        const glyph =
          verdict === "pass" ? "✓" : verdict === "fail" ? "✗" : "⟳";
        return (
          <a
            href="#trio-review-section"
            class={`trio-pill ${stateClass}`}
            title={`AI ${PERSONA_LABEL[persona]} Review — ${verdict === "pass" ? "Pass" : verdict === "fail" ? "Fail" : "Pending"}`}
          >
            <span aria-hidden="true">{PERSONA_ICON[persona]}</span>
            {PERSONA_LABEL[persona]} {glyph}
          </a>
        );
      })}
    </span>
  );
}

// List PRs
pulls.get("/:owner/:repo/pulls", softAuth, requireRepoAccess("read"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const state = c.req.query("state") || "open";
  const searchQ = c.req.query("q")?.trim() || "";
  const authorFilter = c.req.query("author")?.trim() || "";
  const sortPr = (c.req.query("sort") || "newest").trim();

  // ── Loading skeleton (flag-gated) ──
  // Renders an SSR'd PR-row skeleton when `?skeleton=1` is set. Lets
  // the user see the page structure before counts + select resolve.
  // Behind a flag for now — we don't ship flashes.
  if (c.req.query("skeleton") === "1") {
    return c.html(
      <Layout title={`Pull Requests — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <PrNav owner={ownerName} repo={repoName} active="pulls" />
        <style dangerouslySetInnerHTML={{ __html: PRS_LIST_STYLES }} />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              .prs-skel { background: linear-gradient(90deg, var(--bg-secondary) 0%, var(--bg-elevated) 50%, var(--bg-secondary) 100%); background-size: 200% 100%; animation: prs-skel-shimmer 1.4s infinite; border-radius: 6px; display: block; }
              @keyframes prs-skel-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
              @media (prefers-reduced-motion: reduce) { .prs-skel { animation: none; } }
              .prs-skel-hero { height: 152px; border-radius: 16px; margin: 0 0 var(--space-5); }
              .prs-skel-tabs { height: 40px; width: 360px; border-radius: 9999px; margin: 0 0 16px; }
              .prs-skel-list { display: flex; flex-direction: column; gap: 8px; }
              .prs-skel-row { height: 76px; border-radius: 12px; }
            `,
          }}
        />
        <div class="prs-skel prs-skel-hero" aria-hidden="true" />
        <div class="prs-skel prs-skel-tabs" aria-hidden="true" />
        <div class="prs-skel-list" aria-hidden="true">
          {Array.from({ length: 6 }).map(() => (
            <div class="prs-skel prs-skel-row" />
          ))}
        </div>
        <span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0" role="status" aria-live="polite">
          Loading pull requests for {ownerName}/{repoName}…
        </span>
      </Layout>
    );
  }

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  // "draft" is a virtual filter — rows are state='open' + isDraft=true.
  const stateFilter =
    state === "draft"
      ? and(
          eq(pullRequests.state, "open"),
          eq(pullRequests.isDraft, true)
        )
      : eq(pullRequests.state, state);

  const prList = await db
    .select({
      pr: pullRequests,
      author: { username: users.username },
    })
    .from(pullRequests)
    .innerJoin(users, eq(pullRequests.authorId, users.id))
    .where(
      and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        stateFilter,
        searchQ ? ilike(pullRequests.title, `%${searchQ}%`) : undefined,
        authorFilter ? eq(users.username, authorFilter) : undefined,
      )
    )
    .orderBy(
      sortPr === "oldest" ? asc(pullRequests.createdAt)
        : sortPr === "updated" ? desc(pullRequests.updatedAt)
        : desc(pullRequests.createdAt) // newest (default)
    );

  // Batch-load review states + comment counts for all PRs in the list
  const reviewMap = new Map<string, { approved: boolean; changesRequested: boolean }>();
  const commentCountMap = new Map<string, number>();
  if (prList.length > 0) {
    const prIds = prList.map(({ pr }) => pr.id);
    const [reviewRows, commentRows] = await Promise.all([
      db
        .select({ prId: prReviews.pullRequestId, state: prReviews.state })
        .from(prReviews)
        .where(inArray(prReviews.pullRequestId, prIds)),
      db
        .select({
          prId: prComments.pullRequestId,
          cnt: sql<number>`count(*)::int`,
        })
        .from(prComments)
        .where(and(inArray(prComments.pullRequestId, prIds), eq(prComments.isAiReview, false)))
        .groupBy(prComments.pullRequestId),
    ]);
    for (const r of reviewRows) {
      const entry = reviewMap.get(r.prId) ?? { approved: false, changesRequested: false };
      if (r.state === "approved") entry.approved = true;
      if (r.state === "changes_requested") entry.changesRequested = true;
      reviewMap.set(r.prId, entry);
    }
    for (const r of commentRows) {
      commentCountMap.set(r.prId, Number(r.cnt));
    }
  }

  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${pullRequests.state} = 'open')`,
      draft: sql<number>`count(*) filter (where ${pullRequests.state} = 'open' and ${pullRequests.isDraft} = true)`,
      closed: sql<number>`count(*) filter (where ${pullRequests.state} = 'closed')`,
      merged: sql<number>`count(*) filter (where ${pullRequests.state} = 'merged')`,
    })
    .from(pullRequests)
    .where(eq(pullRequests.repositoryId, resolved.repo.id));

  const openCount = counts?.open ?? 0;
  const mergedCount = counts?.merged ?? 0;
  const closedCount = counts?.closed ?? 0;
  const draftCount = counts?.draft ?? 0;
  const allCount = openCount + mergedCount + closedCount;

  // "All" is presentational only — the DB query for state='all' matches
  // nothing, so we render a friendlier empty state when picked. We do NOT
  // change the query logic to keep this commit purely visual.
  const authorQs = authorFilter ? `&author=${encodeURIComponent(authorFilter)}` : "";
  const tabPills: Array<{ label: string; count: number; key: string; href: string }> = [
    { label: "Open", count: openCount, key: "open", href: `/${ownerName}/${repoName}/pulls?state=open${authorQs}` },
    { label: "Merged", count: mergedCount, key: "merged", href: `/${ownerName}/${repoName}/pulls?state=merged${authorQs}` },
    { label: "Closed", count: closedCount, key: "closed", href: `/${ownerName}/${repoName}/pulls?state=closed${authorQs}` },
    { label: "All", count: allCount, key: "all", href: `/${ownerName}/${repoName}/pulls?state=all${authorQs}` },
    { label: "Draft", count: draftCount, key: "draft", href: `/${ownerName}/${repoName}/pulls?state=draft${authorQs}` },
  ];
  const isAllState = state === "all";
  const viewerIsOwnerOnPrList = !!(user && user.id === resolved.owner.id);
  const prListPendingCount = viewerIsOwnerOnPrList
    ? await countPendingForRepo(resolved.repo.id)
    : 0;

  return c.html(
    <Layout title={`Pull Requests — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
      <PendingCommentsBanner
        owner={ownerName}
        repo={repoName}
        count={prListPendingCount}
      />
      <style dangerouslySetInnerHTML={{ __html: PRS_LIST_STYLES }} />

      <div class="prs-hero">
        <div class="prs-hero-inner">
          <div class="prs-hero-text">
            <div class="prs-hero-eyebrow">Pull requests</div>
            <h1 class="prs-hero-title">
              Review, <span class="gradient-text">merge with AI</span>.
            </h1>
            <p class="prs-hero-sub">
              {openCount === 0 && allCount === 0
                ? "No pull requests yet. Open the first one to start collaborating — AI review runs automatically on every PR."
                : `${openCount} open, ${mergedCount} merged, ${closedCount} closed${draftCount > 0 ? ` · ${draftCount} draft${draftCount === 1 ? "" : "s"}` : ""}. AI review, gate checks, and auto-resolve included.`}
            </p>
          </div>
          <div class="prs-hero-actions">
            <a
              href={`/${ownerName}/${repoName}/pulls/insights`}
              class="prs-cta"
              style="background:var(--bg-secondary);border-color:var(--border);color:var(--text);box-shadow:none"
            >
              Insights
            </a>
            {user && (
              <a href={`/${ownerName}/${repoName}/pulls/new`} class="prs-cta">
                + New pull request
              </a>
            )}
          </div>
        </div>
      </div>

      <nav class="prs-tabs" aria-label="Pull request filters">
        {tabPills.map((t) => {
          const isActive =
            state === t.key ||
            (t.key === "open" &&
              state !== "merged" &&
              state !== "closed" &&
              state !== "all" &&
              state !== "draft");
          return (
            <a class={`prs-tab${isActive ? " is-active" : ""}`} href={t.href}>
              <span>{t.label}</span>
              <span class="prs-tab-count">{t.count}</span>
            </a>
          );
        })}
      </nav>

      <form
        method="get"
        action={`/${ownerName}/${repoName}/pulls`}
        style="display:flex;gap:8px;align-items:center;margin-bottom:14px"
      >
        <input type="hidden" name="state" value={state} />
        <input
          type="search"
          name="q"
          value={searchQ}
          placeholder="Search pull requests…"
          class="issues-search-input"
          style="flex:1;max-width:380px"
        />
        <input
          type="text"
          name="author"
          value={authorFilter}
          placeholder="Filter by author…"
          class="issues-search-input"
          style="max-width:200px"
        />
        <button type="submit" class="issues-search-btn" aria-label="Search">{"🔍"}</button>
        {(searchQ || authorFilter) && (
          <a
            href={`/${ownerName}/${repoName}/pulls?state=${state}`}
            class="issues-filter-clear"
          >
            Clear
          </a>
        )}
      </form>

      <div class="prs-sort-row">
        <span class="prs-sort-label">Sort:</span>
        {(["newest", "oldest", "updated"] as const).map((s) => (
          <a
            href={`/${ownerName}/${repoName}/pulls?state=${state}&sort=${s}${searchQ ? `&q=${encodeURIComponent(searchQ)}` : ""}${authorFilter ? `&author=${encodeURIComponent(authorFilter)}` : ""}`}
            class={`prs-sort-opt${sortPr === s ? " is-active" : ""}`}
          >
            {s === "newest" ? "Newest" : s === "oldest" ? "Oldest" : "Recently updated"}
          </a>
        ))}
      </div>

      {prList.length === 0 ? (
        <div class="prs-empty">
          <div class="prs-empty-inner">
            <strong>
              {searchQ || authorFilter
                ? `No pull requests match${searchQ ? ` "${searchQ}"` : ""}${authorFilter ? ` by "${authorFilter}"` : ""}`
                : isAllState
                  ? "Pick a filter above to browse PRs."
                  : `No ${state} pull requests.`}
            </strong>
            <p class="prs-empty-sub">
              {searchQ || authorFilter
                ? `Try a different search term or author, or clear the filter.`
                : state === "open"
                  ? "Pull requests propose changes from a branch into the base. Open one to kick off AI review, gate checks, and (if eligible) auto-merge."
                  : isAllState
                    ? "The combined view is coming soon — Open, Merged, Closed, and Draft are all live above."
                    : `No ${state} pull requests on ${ownerName}/${repoName} right now. Try a different filter.`}
            </p>
            <div class="prs-empty-cta">
              {user && state === "open" && !searchQ && !authorFilter && (
                <a href={`/${ownerName}/${repoName}/pulls/new`} class="btn btn-primary">
                  + New pull request
                </a>
              )}
              {state !== "open" && !searchQ && !authorFilter && (
                <a href={`/${ownerName}/${repoName}/pulls?state=open`} class="btn">
                  View open PRs
                </a>
              )}
              <a href={`/${ownerName}/${repoName}`} class="btn">
                Back to code
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div class="prs-list">
          {prList.map(({ pr, author }) => {
            const stateClass =
              pr.state === "open"
                ? pr.isDraft
                  ? "state-draft"
                  : "state-open"
                : pr.state === "merged"
                  ? "state-merged"
                  : "state-closed";
            const icon =
              pr.state === "open"
                ? pr.isDraft
                  ? "◌"
                  : "○"
                : pr.state === "merged"
                  ? "⮌"
                  : "✓";
            const rv = reviewMap.get(pr.id);
            return (
              <a
                href={`/${ownerName}/${repoName}/pulls/${pr.number}`}
                class="prs-row"
                style="text-decoration:none;color:inherit"
              >
                <div class={`prs-row-icon ${stateClass}`} aria-hidden="true">
                  {icon}
                </div>
                <div class="prs-row-body">
                  <h3 class="prs-row-title">
                    <span>{pr.title}</span>
                    <span class="prs-row-number">#{pr.number}</span>
                  </h3>
                  <div class="prs-row-meta">
                    <span
                      class="prs-branch-chips"
                      title={`${pr.headBranch} into ${pr.baseBranch}`}
                    >
                      <span class="prs-branch-chip">{pr.headBranch}</span>
                      <span class="prs-branch-arrow">{"→"}</span>
                      <span class="prs-branch-chip">{pr.baseBranch}</span>
                    </span>
                    <span>
                      by{" "}
                      <strong style="color:var(--text)">
                        {author.username}
                      </strong>{" "}
                      {formatRelative(pr.createdAt)}
                    </span>
                    <span class="prs-row-tags">
                      {pr.isDraft && <span class="prs-tag is-draft">Draft</span>}
                      {pr.state === "merged" && (
                        <span class="prs-tag is-merged">Merged</span>
                      )}
                      {rv?.approved && !rv.changesRequested && (
                        <span class="prs-tag is-approved" title="Approved by reviewer">✓ Approved</span>
                      )}
                      {rv?.changesRequested && (
                        <span class="prs-tag is-changes" title="Changes requested">✗ Changes</span>
                      )}
                      {(commentCountMap.get(pr.id) ?? 0) > 0 && (
                        <span class="prs-tag" title={`${commentCountMap.get(pr.id)} comment${(commentCountMap.get(pr.id) ?? 0) === 1 ? "" : "s"}`}>
                          💬 {commentCountMap.get(pr.id)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </Layout>
  );
});

/* ─────────────────────────────────────────────────────────────────────────
 * PR Insights — 90-day analytics for the pull request activity of a repo.
 * Route: GET /:owner/:repo/pulls/insights
 * MUST be registered BEFORE the /:owner/:repo/pulls/:number detail route so
 * "insights" is not swallowed by the :number param.
 * ───────────────────────────────────────────────────────────────────────── */

/** Format a millisecond duration as human-readable string. */
function formatMsDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Format an ISO week string as "Jan 15". */
function formatWeekLabel(isoWeek: string): string {
  try {
    const d = new Date(isoWeek);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return isoWeek.slice(5, 10);
  }
}

const PR_INSIGHTS_STYLES = `
  .pri-page { padding-bottom: 48px; }
  .pri-hero {
    position: relative;
    margin: 0 0 var(--space-5);
    padding: 22px 26px 24px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .pri-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .pri-hero-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .pri-hero-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 3.4vw, 34px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.06;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .pri-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .pri-hero-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .pri-section { margin-bottom: 32px; }
  .pri-section-title {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin: 0 0 14px;
  }
  .pri-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
  .pri-card {
    padding: 16px 18px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .pri-card-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .pri-card-value {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.04em;
    color: var(--text-strong);
    line-height: 1;
  }
  .pri-card-sub {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .pri-chart {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 120px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 16px 0;
  }
  .pri-bar-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    gap: 4px;
  }
  .pri-bar {
    width: 100%;
    min-height: 4px;
    border-radius: 4px 4px 0 0;
    background: linear-gradient(180deg, #a48bff 0%, #8c6dff 100%);
    transition: opacity 140ms;
  }
  .pri-bar:hover { opacity: 0.8; }
  .pri-bar-label {
    font-size: 10px;
    color: var(--text-muted);
    text-align: center;
    padding-bottom: 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .pri-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  .pri-table th {
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .pri-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }
  .pri-table tr:last-child td { border-bottom: none; }
  .pri-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .pri-age-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13.5px;
  }
  .pri-age-row:last-child { border-bottom: none; }
  .pri-age-label {
    flex: 0 0 80px;
    color: var(--text-muted);
    font-size: 12.5px;
    font-weight: 600;
  }
  .pri-age-bar-wrap {
    flex: 1;
    height: 8px;
    background: var(--bg-secondary);
    border-radius: 9999px;
    overflow: hidden;
  }
  .pri-age-bar {
    height: 100%;
    border-radius: 9999px;
    background: linear-gradient(90deg, #8c6dff 0%, #36c5d6 100%);
    min-width: 4px;
  }
  .pri-age-count {
    flex: 0 0 32px;
    text-align: right;
    font-weight: 600;
    color: var(--text-strong);
    font-size: 13px;
  }
  .pri-sparkline {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 40px;
  }
  .pri-spark-bar {
    flex: 1;
    min-height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--accent, #8c6dff);
    opacity: 0.7;
  }
  .pri-empty {
    color: var(--text-muted);
    font-size: 14px;
    padding: 24px 0;
    text-align: center;
  }
  @media (max-width: 600px) {
    .pri-cards { grid-template-columns: repeat(2, 1fr); }
    .pri-hero { padding: 18px 18px 20px; }
  }
`;

pulls.get("/:owner/:repo/pulls/insights", softAuth, requireRepoAccess("read"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  const repoId = resolved.repo.id;
  const now = Date.now();

  // 1. Merged PRs in last 90 days (avg merge time)
  const mergedPRs = await db
    .select({ createdAt: pullRequests.createdAt, mergedAt: pullRequests.mergedAt })
    .from(pullRequests)
    .where(and(
      eq(pullRequests.repositoryId, repoId),
      eq(pullRequests.state, "merged"),
      sql`${pullRequests.mergedAt} > now() - interval '90 days'`
    ));

  const avgMergeMs = mergedPRs.length > 0
    ? mergedPRs.reduce((s, p) => s + (p.mergedAt!.getTime() - p.createdAt.getTime()), 0) / mergedPRs.length
    : null;

  // 2. PR throughput (last 8 weeks)
  const weeklyPRs = await db
    .select({
      week: sql<string>`date_trunc('week', ${pullRequests.createdAt})::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(pullRequests)
    .where(and(
      eq(pullRequests.repositoryId, repoId),
      sql`${pullRequests.createdAt} > now() - interval '56 days'`
    ))
    .groupBy(sql`date_trunc('week', ${pullRequests.createdAt})`)
    .orderBy(sql`date_trunc('week', ${pullRequests.createdAt})`);

  const maxWeekCount = weeklyPRs.length > 0 ? Math.max(...weeklyPRs.map((w) => w.count)) : 1;

  // 3. PR merge rate (last 90 days)
  const [rateCounts] = await db
    .select({
      merged: sql<number>`count(*) filter (where ${pullRequests.state} = 'merged')::int`,
      closed: sql<number>`count(*) filter (where ${pullRequests.state} = 'closed')::int`,
    })
    .from(pullRequests)
    .where(and(
      eq(pullRequests.repositoryId, repoId),
      sql`${pullRequests.createdAt} > now() - interval '90 days'`
    ));

  const totalResolved = (rateCounts?.merged ?? 0) + (rateCounts?.closed ?? 0);
  const mergeRate = totalResolved > 0
    ? Math.round(((rateCounts?.merged ?? 0) / totalResolved) * 100)
    : null;

  // 4. Top reviewers (last 90 days)
  const reviewerCounts = await db
    .select({
      userId: prReviews.reviewerId,
      username: users.username,
      count: sql<number>`count(*)::int`,
    })
    .from(prReviews)
    .innerJoin(users, eq(prReviews.reviewerId, users.id))
    .innerJoin(pullRequests, eq(prReviews.pullRequestId, pullRequests.id))
    .where(and(
      eq(pullRequests.repositoryId, repoId),
      sql`${prReviews.createdAt} > now() - interval '90 days'`
    ))
    .groupBy(prReviews.reviewerId, users.username)
    .orderBy(desc(sql`count(*)`))
    .limit(5);

  // 5. Average reviews per merged PR
  const [avgReviewRow] = await db
    .select({
      avgReviews: sql<number>`(count(${prReviews.id})::float / nullif(count(distinct ${pullRequests.id}), 0))`,
    })
    .from(pullRequests)
    .leftJoin(prReviews, eq(prReviews.pullRequestId, pullRequests.id))
    .where(and(
      eq(pullRequests.repositoryId, repoId),
      eq(pullRequests.state, "merged"),
      sql`${pullRequests.mergedAt} > now() - interval '90 days'`
    ));

  const avgReviewsPerPr = avgReviewRow?.avgReviews != null
    ? Math.round(avgReviewRow.avgReviews * 10) / 10
    : null;

  // 6. Review turnaround — avg time from PR open to first review
  const prsWithReviews = await db
    .select({
      createdAt: pullRequests.createdAt,
      firstReview: sql<string>`min(${prReviews.createdAt})::text`,
    })
    .from(pullRequests)
    .innerJoin(prReviews, eq(prReviews.pullRequestId, pullRequests.id))
    .where(and(
      eq(pullRequests.repositoryId, repoId),
      sql`${pullRequests.createdAt} > now() - interval '90 days'`
    ))
    .groupBy(pullRequests.id, pullRequests.createdAt);

  const avgReviewTurnaroundMs = prsWithReviews.length > 0
    ? prsWithReviews.reduce((s, row) => {
        const firstMs = new Date(row.firstReview).getTime();
        return s + Math.max(0, firstMs - row.createdAt.getTime());
      }, 0) / prsWithReviews.length
    : null;

  // 7. Open PRs by age bucket
  const openPRs = await db
    .select({ createdAt: pullRequests.createdAt })
    .from(pullRequests)
    .where(and(
      eq(pullRequests.repositoryId, repoId),
      eq(pullRequests.state, "open")
    ));

  const ageBuckets = { lt1d: 0, d1to3: 0, d3to7: 0, d7to30: 0, gt30d: 0 };
  for (const { createdAt } of openPRs) {
    const ageDays = (now - createdAt.getTime()) / 86_400_000;
    if (ageDays < 1)       ageBuckets.lt1d++;
    else if (ageDays < 3)  ageBuckets.d1to3++;
    else if (ageDays < 7)  ageBuckets.d3to7++;
    else if (ageDays < 30) ageBuckets.d7to30++;
    else                   ageBuckets.gt30d++;
  }
  const maxAgeBucket = Math.max(1, ...Object.values(ageBuckets));

  // 8. 7-day merge sparkline
  const sparklineRows = await db
    .select({
      day: sql<string>`date_trunc('day', ${pullRequests.mergedAt})::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(pullRequests)
    .where(and(
      eq(pullRequests.repositoryId, repoId),
      eq(pullRequests.state, "merged"),
      sql`${pullRequests.mergedAt} > now() - interval '7 days'`
    ))
    .groupBy(sql`date_trunc('day', ${pullRequests.mergedAt})`)
    .orderBy(sql`date_trunc('day', ${pullRequests.mergedAt})`);

  const sparkMap = new Map<string, number>();
  for (const row of sparklineRows) {
    sparkMap.set(row.day.slice(0, 10), row.count);
  }
  const sparkline: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    sparkline.push(sparkMap.get(d.toISOString().slice(0, 10)) ?? 0);
  }
  const maxSpark = Math.max(1, ...sparkline);

  const ageBucketDefs: Array<{ label: string; key: keyof typeof ageBuckets }> = [
    { label: "< 1 day",   key: "lt1d" },
    { label: "1–3 days",  key: "d1to3" },
    { label: "3–7 days",  key: "d3to7" },
    { label: "7–30 days", key: "d7to30" },
    { label: "> 30 days", key: "gt30d" },
  ];

  return c.html(
    <Layout title={`PR Insights — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
      <style dangerouslySetInnerHTML={{ __html: PR_INSIGHTS_STYLES }} />

      <div class="pri-page">
        {/* Hero */}
        <div class="pri-hero">
          <div class="pri-hero-eyebrow">Pull requests</div>
          <h1 class="pri-hero-title">
            PR <span class="gradient-text">Insights</span>
          </h1>
          <p class="pri-hero-sub">90-day analytics for {ownerName}/{repoName}</p>
        </div>

        {/* Stat cards */}
        <div class="pri-section">
          <div class="pri-section-title">At a glance</div>
          <div class="pri-cards">
            <div class="pri-card">
              <div class="pri-card-label">Avg merge time</div>
              <div class="pri-card-value">
                {avgMergeMs != null ? formatMsDuration(avgMergeMs) : "—"}
              </div>
              <div class="pri-card-sub">last 90 days</div>
            </div>
            <div class="pri-card">
              <div class="pri-card-label">Total merged</div>
              <div class="pri-card-value">{mergedPRs.length}</div>
              <div class="pri-card-sub">last 90 days</div>
            </div>
            <div class="pri-card">
              <div class="pri-card-label">Open PRs</div>
              <div class="pri-card-value">{openPRs.length}</div>
              <div class="pri-card-sub">right now</div>
            </div>
            <div class="pri-card">
              <div class="pri-card-label">Merge rate</div>
              <div class="pri-card-value">
                {mergeRate != null ? `${mergeRate}%` : "—"}
              </div>
              <div class="pri-card-sub">merged vs closed</div>
            </div>
            <div class="pri-card">
              <div class="pri-card-label">Avg reviews / PR</div>
              <div class="pri-card-value">
                {avgReviewsPerPr != null ? String(avgReviewsPerPr) : "—"}
              </div>
              <div class="pri-card-sub">merged PRs, 90d</div>
            </div>
            <div class="pri-card">
              <div class="pri-card-label">Top reviewer</div>
              <div class="pri-card-value" style="font-size:18px;word-break:break-all">
                {reviewerCounts.length > 0 ? reviewerCounts[0].username : "—"}
              </div>
              <div class="pri-card-sub">
                {reviewerCounts.length > 0
                  ? `${reviewerCounts[0].count} review${reviewerCounts[0].count === 1 ? "" : "s"}`
                  : "no reviews yet"}
              </div>
            </div>
          </div>
        </div>

        {/* Review turnaround */}
        <div class="pri-section">
          <div class="pri-section-title">Review turnaround</div>
          <div class="pri-cards" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
            <div class="pri-card">
              <div class="pri-card-label">Avg time to first review</div>
              <div class="pri-card-value">
                {avgReviewTurnaroundMs != null ? formatMsDuration(avgReviewTurnaroundMs) : "—"}
              </div>
              <div class="pri-card-sub">
                {prsWithReviews.length > 0
                  ? `across ${prsWithReviews.length} PR${prsWithReviews.length === 1 ? "" : "s"} with reviews`
                  : "no reviewed PRs in 90d"}
              </div>
            </div>
          </div>
        </div>

        {/* Weekly throughput bar chart */}
        <div class="pri-section">
          <div class="pri-section-title">Weekly throughput (last 8 weeks)</div>
          {weeklyPRs.length === 0 ? (
            <div class="pri-empty">No PR activity in the last 8 weeks.</div>
          ) : (
            <div class="pri-chart">
              {weeklyPRs.map((w) => (
                <div class="pri-bar-col">
                  <div
                    class="pri-bar"
                    style={`height: ${Math.max(4, Math.round((w.count / maxWeekCount) * 88))}px`}
                    title={`${w.count} PR${w.count === 1 ? "" : "s"} week of ${formatWeekLabel(w.week)}`}
                  />
                  <span class="pri-bar-label">{formatWeekLabel(w.week)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 7-day merge sparkline */}
        <div class="pri-section">
          <div class="pri-section-title">Merges this week (daily)</div>
          <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:16px">
            <div class="pri-sparkline">
              {sparkline.map((v) => (
                <div
                  class="pri-spark-bar"
                  style={`height: ${Math.max(2, Math.round((v / maxSpark) * 36))}px`}
                  title={`${v} merge${v === 1 ? "" : "s"}`}
                />
              ))}
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:6px;display:flex;justify-content:space-between">
              <span>7 days ago</span>
              <span>Today</span>
            </div>
          </div>
        </div>

        {/* Top reviewers table */}
        <div class="pri-section">
          <div class="pri-section-title">Top reviewers (last 90 days)</div>
          {reviewerCounts.length === 0 ? (
            <div class="pri-empty">No reviews posted in the last 90 days.</div>
          ) : (
            <div class="pri-table-wrap">
              <table class="pri-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Reviewer</th>
                    <th>Reviews</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewerCounts.map((r, i) => (
                    <tr>
                      <td style="color:var(--text-muted)">{i + 1}</td>
                      <td>
                        <a href={`/${r.username}`} style="color:var(--text-link);text-decoration:none">
                          {r.username}
                        </a>
                      </td>
                      <td style="font-weight:600">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Open PRs by age */}
        <div class="pri-section">
          <div class="pri-section-title">Open PRs by age</div>
          {openPRs.length === 0 ? (
            <div class="pri-empty">No open pull requests.</div>
          ) : (
            <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:16px 20px">
              {ageBucketDefs.map(({ label, key }) => (
                <div class="pri-age-row">
                  <span class="pri-age-label">{label}</span>
                  <div class="pri-age-bar-wrap">
                    <div
                      class="pri-age-bar"
                      style={`width: ${ageBuckets[key] > 0 ? Math.max(4, Math.round((ageBuckets[key] / maxAgeBucket) * 100)) : 0}%`}
                    />
                  </div>
                  <span class="pri-age-count">{ageBuckets[key]}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Back link */}
        <div>
          <a href={`/${ownerName}/${repoName}/pulls`} style="color:var(--text-muted);font-size:13px;text-decoration:none">
            {"←"} Back to pull requests
          </a>
        </div>
      </div>
    </Layout>
  );
});

// New PR form
pulls.get(
  "/:owner/:repo/pulls/new",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const branches = await listBranches(ownerName, repoName);
    const error = c.req.query("error");
    const defaultBase = branches.includes("main") ? "main" : branches[0] || "";
    const template = await loadPrTemplate(ownerName, repoName);

    return c.html(
      <Layout title={`New PR — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <PrNav owner={ownerName} repo={repoName} active="pulls" />
        <Container maxWidth={800}>
          <h2 style="margin-bottom:16px">Open a pull request</h2>
          {error && (
            <Alert variant="error">{decodeURIComponent(error)}</Alert>
          )}
          <Form method="post" action={`/${ownerName}/${repoName}/pulls/new`}>
            <Flex gap={12} align="center" style="margin-bottom: 16px">
              <Select name="base">
                {branches.map((b) => (
                  <option value={b} selected={b === defaultBase}>
                    {b}
                  </option>
                ))}
              </Select>
              <Text muted>&larr;</Text>
              <Select name="head">
                {branches
                  .filter((b) => b !== defaultBase)
                  .concat(defaultBase === branches[0] ? [] : [branches[0]])
                  .map((b) => (
                    <option value={b}>{b}</option>
                  ))}
              </Select>
            </Flex>
            <FormGroup>
              <Input
                name="title"
                required
                placeholder="Title"
                style="font-size:16px;padding:10px 14px"
                aria-label="Pull request title"
              />
            </FormGroup>
            <FormGroup>
              <TextArea
                name="body"
                id="pr-body"
                rows={8}
                placeholder="Description (Markdown supported)"
                mono
              />
            </FormGroup>
            <Flex gap={8} align="center">
              <Button type="submit" variant="primary">
                Create pull request
              </Button>
              <button
                type="button"
                id="ai-suggest-desc"
                class="btn"
                style="font-weight:500"
                title="Generate a Markdown PR description using Claude based on the diff between the selected branches"
              >
                Suggest description with AI
              </button>
              <span
                id="ai-suggest-status"
                style="color:var(--text-muted);font-size:13px"
              />
            </Flex>
          </Form>
          <script
            dangerouslySetInnerHTML={{
              __html: AI_PR_DESC_SCRIPT(`/${ownerName}/${repoName}/ai/pr-description`),
            }}
          />
        </Container>
      </Layout>
    );
  }
);

// AI-suggested PR description — JSON endpoint driven by the form button.
// Returns {ok:true, body} on success, {ok:false, error} otherwise. Always
// 200; the inline script reads `ok` to decide what to do.
pulls.post(
  "/:owner/:repo/ai/pr-description",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    if (!isAiAvailable()) {
      return c.json({
        ok: false,
        error: "AI is not available — set ANTHROPIC_API_KEY.",
      });
    }
    const body = await c.req.parseBody();
    const title = String(body.title || "").trim();
    const baseBranch = String(body.base || "").trim();
    const headBranch = String(body.head || "").trim();
    if (!baseBranch || !headBranch) {
      return c.json({ ok: false, error: "Pick base + head branches first." });
    }
    if (baseBranch === headBranch) {
      return c.json({ ok: false, error: "Base and head must differ." });
    }

    let diff = "";
    try {
      const cwd = getRepoPath(ownerName, repoName);
      const proc = Bun.spawn(
        [
          "git",
          "diff",
          `${baseBranch}...${headBranch}`,
          "--",
        ],
        { cwd, stdout: "pipe", stderr: "pipe" }
      );
      // 30s ceiling — without this a pathological diff (huge binary or
      // a corrupt ref) hangs the request indefinitely.
      const killer = setTimeout(() => proc.kill(), 30_000);
      try {
        diff = await new Response(proc.stdout).text();
        await proc.exited;
      } finally {
        clearTimeout(killer);
      }
    } catch {
      diff = "";
    }
    if (!diff.trim()) {
      return c.json({
        ok: false,
        error: "No diff between branches — nothing to summarise.",
      });
    }

    let summary = "";
    try {
      summary = await generatePrSummary(title || "(untitled)", diff);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI request failed.";
      return c.json({ ok: false, error: msg });
    }
    if (!summary.trim()) {
      return c.json({ ok: false, error: "AI returned an empty draft." });
    }
    return c.json({ ok: true, body: summary });
  }
);

// Create PR
pulls.post(
  "/:owner/:repo/pulls/new",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const title = String(body.title || "").trim();
    const prBody = String(body.body || "").trim();
    const baseBranch = String(body.base || "main");
    const headBranch = String(body.head || "");

    if (!title || !headBranch) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/new?error=Title+and+branches+are+required`
      );
    }

    if (baseBranch === headBranch) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/new?error=Base+and+head+branches+must+be+different`
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const isDraft = String(body.draft || "") === "1";

    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: resolved.repo.id,
        authorId: user.id,
        title,
        body: prBody || null,
        baseBranch,
        headBranch,
        isDraft,
      })
      .returning();

    // CODEOWNERS — auto-request reviewers based on changed files.
    // Fire-and-forget; errors never block PR creation.
    (async () => {
      try {
        const repoDir = getRepoPath(ownerName, repoName);
        // Get list of changed files between base and head
        const diffProc = Bun.spawn(
          ["git", "diff", "--name-only", `${baseBranch}...${headBranch}`],
          { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
        );
        const rawDiff = await new Response(diffProc.stdout).text();
        await diffProc.exited;
        const changedFiles = rawDiff.trim().split("\n").filter(Boolean);

        if (changedFiles.length > 0) {
          // Get CODEOWNERS from the default branch of the repo
          const rules = await getCodeownersForRepo(
            ownerName,
            repoName,
            resolved.repo.defaultBranch
          );
          if (rules.length > 0) {
            const ownerUsernames = await reviewersForChangedFiles(
              resolved.repo.id,
              changedFiles
            );
            // Filter out the PR author
            const filteredOwners = ownerUsernames.filter(
              (u) => u !== resolved.owner.username
            );

            if (filteredOwners.length > 0) {
              // Look up user IDs for the owner usernames
              const reviewerUsers = await db
                .select({ id: users.id, username: users.username })
                .from(users)
                .where(
                  inArray(
                    users.username,
                    filteredOwners
                  )
                );

              // Create review request rows (UNIQUE constraint prevents dupes)
              if (reviewerUsers.length > 0) {
                await db
                  .insert(prReviewRequests)
                  .values(
                    reviewerUsers.map((u) => ({
                      prId: pr.id,
                      reviewerId: u.id,
                      requestedBy: null as string | null,
                    }))
                  )
                  .onConflictDoNothing();

                // Add a PR comment announcing the auto-assigned reviewers
                const mentionList = reviewerUsers
                  .map((u) => `@${u.username}`)
                  .join(", ");
                await db.insert(prComments).values({
                  pullRequestId: pr.id,
                  authorId: user.id,
                  body: `AI: Requested review from ${mentionList} based on CODEOWNERS`,
                  isAiReview: true,
                });
              }
            }
          }
        }
      } catch (err) {
        console.warn("[codeowners] auto-assign failed:", err instanceof Error ? err.message : err);
      }
    })();

    // Skip AI review on drafts — it runs again when the PR is marked ready.
    if (!isDraft && isAiReviewEnabled()) {
      triggerAiReview(ownerName, repoName, pr.id, title, prBody, baseBranch, headBranch).catch(
        (err) => console.error("[ai-review] Failed:", err)
      );
    }

    // D3 — fire-and-forget AI triage: suggest labels/reviewers on the PR.
    triggerPrTriage({
      ownerName,
      repoName,
      repositoryId: resolved.repo.id,
      prId: pr.id,
      prAuthorId: user.id,
      title,
      body: prBody,
      baseBranch,
      headBranch,
    }).catch((err) => console.error("[pr-triage] Failed:", err));

    // Chat notifier — fan out to Slack/Discord/Teams.
    import("../lib/chat-notifier")
      .then((m) =>
        m.notifyChatChannels({
          ownerUserId: resolved.repo.ownerId,
          repositoryId: resolved.repo.id,
          event: {
            event: "pr.opened",
            repo: `${ownerName}/${repoName}`,
            title: `#${pr.number} ${title}`,
            url: `/${ownerName}/${repoName}/pulls/${pr.number}`,
            body: prBody || undefined,
            actor: user.username,
          },
        })
      )
      .catch((err) =>
        console.warn(`[chat-notifier] PR opened notify failed:`, err)
      );

    // R3 — fast-lane auto-merge evaluation. Fires after AI review lands.
    import("../lib/auto-merge")
      .then((m) => m.tryAutoMergeNow(pr.id))
      .catch((err) => {
        console.warn(
          `[auto-merge] tryAutoMergeNow failed for PR ${pr.id}:`,
          err instanceof Error ? err.message : err
        );
      });

    // Migration 0077 — PR preview build. Fire-and-forget; skips when
    // PREVIEW_DOMAIN is unset or the repo has no preview_build_command.
    // Resolve head SHA asynchronously so we don't block the redirect.
    resolveRef(ownerName, repoName, headBranch)
      .then((headSha) => {
        if (!headSha) return;
        return import("../lib/preview-builder").then((m) =>
          m.buildPreview(pr.id, resolved.repo.id, headSha)
        );
      })
      .catch(() => {});

    return c.redirect(`/${ownerName}/${repoName}/pulls/${pr.number}`);
  }
);

// View single PR
pulls.get("/:owner/:repo/pulls/:number", softAuth, requireRepoAccess("read"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const prNum = parseInt(c.req.param("number"), 10);
  const user = c.get("user");
  const tab = c.req.query("tab") || "conversation";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        eq(pullRequests.number, prNum)
      )
    )
    .limit(1);

  if (!pr) return c.notFound();

  const [author] = await db
    .select()
    .from(users)
    .where(eq(users.id, pr.authorId))
    .limit(1);

  const allCommentsRaw = await db
    .select({
      comment: prComments,
      author: { id: users.id, username: users.username },
    })
    .from(prComments)
    .innerJoin(users, eq(prComments.authorId, users.id))
    .where(eq(prComments.pullRequestId, pr.id))
    .orderBy(asc(prComments.createdAt));

  // Filter pending/rejected/spam for non-owner, non-author viewers.
  // Owner always sees everything; comment author sees their own pending
  // with an "Awaiting approval" badge in the render below.
  const viewerIsRepoOwner = !!(user && user.id === resolved.owner.id);
  const comments = allCommentsRaw.filter(({ comment, author: cAuthor }) => {
    if (viewerIsRepoOwner) return true;
    if (comment.moderationStatus === "approved") return true;
    if (
      user &&
      cAuthor.id === user.id &&
      comment.moderationStatus === "pending"
    ) {
      return true;
    }
    return false;
  });
  const prPendingCount = viewerIsRepoOwner
    ? await countPendingForRepo(resolved.repo.id)
    : 0;

  // Reactions for the PR body + each comment, in parallel.
  const [prReactions, ...prCommentReactions] = await Promise.all([
    summariseReactions("pr", pr.id, user?.id),
    ...comments.map((row) =>
      summariseReactions("pr_comment", row.comment.id, user?.id)
    ),
  ]);

  // Formal reviews (Approve / Request Changes)
  const reviewRows = await db
    .select({
      id: prReviews.id,
      state: prReviews.state,
      body: prReviews.body,
      isAi: prReviews.isAi,
      createdAt: prReviews.createdAt,
      reviewerUsername: users.username,
      reviewerId: prReviews.reviewerId,
    })
    .from(prReviews)
    .innerJoin(users, eq(prReviews.reviewerId, users.id))
    .where(eq(prReviews.pullRequestId, pr.id))
    .orderBy(asc(prReviews.createdAt));
  // Most recent review per reviewer determines the current state
  const latestReviewByReviewer = new Map<string, typeof reviewRows[0]>();
  for (const r of reviewRows) {
    if (r.state !== "commented") latestReviewByReviewer.set(r.reviewerId, r);
  }
  const approvals = [...latestReviewByReviewer.values()].filter(r => r.state === "approved");
  const changesRequested = [...latestReviewByReviewer.values()].filter(r => r.state === "changes_requested");
  const viewerHasReviewed = user ? latestReviewByReviewer.has(user.id) : false;

  // Requested reviewers from CODEOWNERS auto-assign (migration 0077).
  const requestedReviewerRows = await db
    .select({
      reviewerUsername: users.username,
      reviewerId: prReviewRequests.reviewerId,
      createdAt: prReviewRequests.createdAt,
    })
    .from(prReviewRequests)
    .innerJoin(users, eq(prReviewRequests.reviewerId, users.id))
    .where(eq(prReviewRequests.prId, pr.id))
    .orderBy(asc(prReviewRequests.createdAt))
    .catch(() => [] as { reviewerUsername: string; reviewerId: string; createdAt: Date }[]);

  // Suggested reviewers — best-effort, never throws
  let reviewerSuggestions: ReviewerCandidate[] = [];
  try {
    if (user) {
      reviewerSuggestions = await suggestReviewers(
        ownerName, repoName, pr.headBranch, pr.baseBranch,
        pr.authorId, resolved.repo.id
      );
    }
  } catch {
    // silent degradation
  }

  const canManage =
    user &&
    (user.id === resolved.owner.id || user.id === pr.authorId);

  // Has any previous AI-test-generator run already tagged this PR? Used
  // both to hide the "Generate tests with AI" button and to short-circuit
  // the explicit POST handler.
  const hasAiTestsMarker = comments.some(({ comment }) =>
    (comment.body || "").includes(AI_TESTS_MARKER)
  );

  const error = c.req.query("error");
  const info = c.req.query("info");

  // Get gate check status for open PRs
  let gateChecks: GateCheckResult[] = [];
  let ciStatuses: CommitStatus[] = [];
  if (pr.state === "open") {
    const headSha = await resolveRef(ownerName, repoName, pr.headBranch);
    if (headSha) {
      const aiComments = comments.filter(({ comment }) => comment.isAiReview);
      const aiApproved = aiComments.length === 0 || aiComments.some(
        ({ comment }) => comment.body.includes("**Approved**")
      );
      const [gateResult, fetchedCiStatuses] = await Promise.all([
        runAllGateChecks(
          ownerName, repoName, pr.baseBranch, pr.headBranch, headSha, aiApproved
        ),
        listStatuses(resolved.repo.id, headSha).catch(() => [] as CommitStatus[]),
      ]);
      gateChecks = gateResult.checks;
      ciStatuses = fetchedCiStatuses;
    }
  }

  // Block M3 — pre-merge risk score. Cache-only on the request path so
  // the page never waits on Haiku. On a cache miss for an open PR we
  // kick off the computation fire-and-forget; the next refresh shows it.
  let prRisk: PrRiskScore | null = null;
  let prRiskCalculating = false;
  if (pr.state === "open") {
    prRisk = await getCachedPrRisk(pr.id).catch(() => null);
    if (!prRisk) {
      prRiskCalculating = true;
      void computePrRiskForPullRequest(pr.id).catch((err) => {
        console.warn(
          `[pr-risk] computePrRiskForPullRequest failed for PR ${pr.id}:`,
          err instanceof Error ? err.message : err
        );
      });
    }
  }

  // Migration 0062 — per-branch preview URL. The head branch always
  // has a preview row (unless it's the default branch, which never
  // happens for an open PR) once it has been pushed at least once.
  const preview = await getPreviewForBranch(
    (resolved.repo as { id: string }).id,
    pr.headBranch
  );

  // Branch ahead/behind counts — how many commits head is ahead of base and
  // how many commits base has advanced since head branched off.
  let branchAhead = 0;
  let branchBehind = 0;
  if (pr.state === "open") {
    try {
      const repoDir = getRepoPath(ownerName, repoName);
      const [aheadProc, behindProc] = [
        Bun.spawn(
          ["git", "rev-list", "--count", `${pr.baseBranch}..${pr.headBranch}`],
          { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
        ),
        Bun.spawn(
          ["git", "rev-list", "--count", `${pr.headBranch}..${pr.baseBranch}`],
          { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
        ),
      ];
      const [aheadTxt, behindTxt] = await Promise.all([
        new Response(aheadProc.stdout).text(),
        new Response(behindProc.stdout).text(),
      ]);
      await Promise.all([aheadProc.exited, behindProc.exited]);
      branchAhead = parseInt(aheadTxt.trim(), 10) || 0;
      branchBehind = parseInt(behindTxt.trim(), 10) || 0;
    } catch { /* non-blocking */ }
  }

  // Linked issues — parse closing keywords from PR title+body, look up issues
  let linkedIssues: Array<{ number: number; title: string; state: string }> = [];
  try {
    const { extractClosingRefsMulti } = await import("../lib/close-keywords");
    const refs = extractClosingRefsMulti([pr.title, pr.body]);
    if (refs.length > 0) {
      linkedIssues = await db
        .select({ number: issues.number, title: issues.title, state: issues.state })
        .from(issues)
        .where(and(
          eq(issues.repositoryId, resolved.repo.id),
          inArray(issues.number, refs),
        ));
    }
  } catch { /* non-blocking */ }

  // Task list progress — count markdown checkboxes in PR body
  let taskTotal = 0;
  let taskChecked = 0;
  if (pr.body) {
    for (const m of pr.body.matchAll(/^[ \t]*[-*][ \t]+\[([ xX])\]/gm)) {
      taskTotal++;
      if (m[1].trim() !== "") taskChecked++;
    }
  }

  // M15 — PR size badge (best-effort, non-blocking)
  let prSizeInfo: PrSizeInfo | null = null;
  try {
    prSizeInfo = await computePrSize(ownerName, repoName, pr.baseBranch, pr.headBranch);
  } catch { /* swallow — purely cosmetic */ }

  // Bus factor warning — non-blocking. Get changed files list first.
  let busRiskFiles: BusFactorFile[] = [];
  let splitSuggestion: SplitSuggestion | null = null;
  try {
    // Get names of files changed in this PR
    const repoDir = getRepoPath(ownerName, repoName);
    const nameOnlyProc = Bun.spawn(
      ["git", "diff", "--name-only", `${pr.baseBranch}...${pr.headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const nameOnlyRaw = await new Response(nameOnlyProc.stdout).text();
    await nameOnlyProc.exited;
    const prChangedFiles = nameOnlyRaw.trim().split("\n").filter(Boolean);

    // Bus factor — check cache for at-risk files that overlap changed files
    [busRiskFiles] = await Promise.all([
      getBusFactorWarning(resolved.repo.id, ownerName, repoName, prChangedFiles),
    ]);

    // PR Split suggestion — only when PR is large (>400 lines)
    if (prSizeInfo && prSizeInfo.linesChanged > 400) {
      splitSuggestion = await suggestPrSplit(
        pr.id,
        pr.title,
        ownerName,
        repoName,
        pr.baseBranch,
        pr.headBranch
      );
    }
  } catch { /* always degrade gracefully */ }

  // Get diff for "Files changed" tab + load inline comments for that tab
  let diffRaw = "";
  let diffFiles: GitDiffFile[] = [];
  let diffInlineComments: InlineDiffComment[] = [];
  if (tab === "files") {
    const repoDir = getRepoPath(ownerName, repoName);
    // Run the two git diffs in parallel — they're independent reads of
    // the same range. Previously sequential, doubling the wall time on
    // big PRs (100+ files = 10-30s for no reason).
    const proc = Bun.spawn(
      ["git", "diff", `${pr.baseBranch}...${pr.headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const statProc = Bun.spawn(
      ["git", "diff", "--numstat", `${pr.baseBranch}...${pr.headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    // 30s ceiling per spawn — a corrupt ref / pathological binary diff
    // would otherwise hang the whole request.
    const killer = setTimeout(() => {
      proc.kill();
      statProc.kill();
    }, 30_000);
    let stat = "";
    try {
      [diffRaw, stat] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(statProc.stdout).text(),
      ]);
      await Promise.all([proc.exited, statProc.exited]);
    } finally {
      clearTimeout(killer);
    }

    diffFiles = stat
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [add, del, filePath] = line.split("\t");
        return {
          path: filePath,
          status: "modified",
          additions: add === "-" ? 0 : parseInt(add, 10),
          deletions: del === "-" ? 0 : parseInt(del, 10),
          patch: "",
        };
      });

    // Fetch inline comments (file+line anchored) for the files tab
    const inlineRows = await db
      .select({
        id: prComments.id,
        filePath: prComments.filePath,
        lineNumber: prComments.lineNumber,
        body: prComments.body,
        isAiReview: prComments.isAiReview,
        createdAt: prComments.createdAt,
        authorUsername: users.username,
      })
      .from(prComments)
      .innerJoin(users, eq(prComments.authorId, users.id))
      .where(
        and(
          eq(prComments.pullRequestId, pr.id),
          eq(prComments.moderationStatus, "approved"),
        )
      )
      .orderBy(asc(prComments.createdAt));

    diffInlineComments = inlineRows
      .filter(r => r.filePath != null && r.lineNumber != null)
      .map(r => ({
        id: r.id,
        filePath: r.filePath!,
        lineNumber: r.lineNumber!,
        authorUsername: r.authorUsername,
        body: renderMarkdown(r.body),
        isAiReview: r.isAiReview,
        createdAt: r.createdAt.toISOString(),
      }));
  }

  // Proactive pattern warning — get changed file paths and check for recurring
  // bug patterns. Fire-and-forget safe; returns null on any error or cache miss.
  let patternWarning: Pattern | null = null;
  try {
    const repoDir = getRepoPath(ownerName, repoName);
    const nameOnlyProc = Bun.spawn(
      ["git", "diff", "--name-only", `${pr.baseBranch}...${pr.headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const nameOnlyRaw = await new Response(nameOnlyProc.stdout).text();
    await nameOnlyProc.exited;
    const prChangedFiles = nameOnlyRaw.trim().split("\n").filter(Boolean);
    if (prChangedFiles.length > 0) {
      patternWarning = await getPatternWarning(resolved.repo.id, prChangedFiles);
    }
  } catch {
    // Non-blocking — swallow
  }

  // ─── Derived visual state ───
  const stateKey =
    pr.state === "open"
      ? pr.isDraft
        ? "draft"
        : "open"
      : pr.state;
  const stateLabel =
    stateKey === "open"
      ? "Open"
      : stateKey === "draft"
        ? "Draft"
        : stateKey === "merged"
          ? "Merged"
          : "Closed";
  const stateIcon =
    stateKey === "open"
      ? "○"
      : stateKey === "draft"
        ? "◌"
        : stateKey === "merged"
          ? "⮌"
          : "✓";
  const commentCount = comments.length;
  const aiReviewCount = comments.filter(({ comment }) => comment.isAiReview).length;
  const gatesAllPassed = gateChecks.length > 0 && gateChecks.every((c) => c.passed);
  const mergeBlocked =
    gateChecks.length > 0 &&
    gateChecks.some(
      (c) => !c.passed && c.name !== "Merge check"
    );

  // Commits tab — list commits included in this PR (base..head range)
  let prCommits: GitCommit[] = [];
  if (tab === "commits") {
    prCommits = await commitsBetween(ownerName, repoName, pr.baseBranch, pr.headBranch).catch(() => []);
  }

  return c.html(
    <Layout
      title={`${pr.title} #${pr.number} — ${ownerName}/${repoName}`}
      user={user}
    >
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
      <PendingCommentsBanner
        owner={ownerName}
        repo={repoName}
        count={prPendingCount}
      />
      <style dangerouslySetInnerHTML={{ __html: PRS_DETAIL_STYLES }} />
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
            topic: `repo:${resolved.repo.id}:pr:${pr.number}`,
            bannerElementId: "live-comment-banner",
          }),
        }}
      />

      <div class="prs-detail-hero">
        <div class="prs-edit-title-wrap">
          <h1 class="prs-detail-title" id="pr-title-display">
            {pr.title}{" "}
            <span class="prs-detail-num">#{pr.number}</span>
          </h1>
          {canManage && pr.state === "open" && (
            <button
              type="button"
              class="prs-edit-btn"
              id="pr-edit-toggle"
              onclick={`
                document.getElementById('pr-title-display').style.display='none';
                document.getElementById('pr-edit-toggle').style.display='none';
                document.getElementById('pr-edit-form').style.display='flex';
                document.getElementById('pr-title-input').focus();
              `}
            >
              Edit
            </button>
          )}
        </div>
        {canManage && pr.state === "open" && (
          <form
            id="pr-edit-form"
            method="post"
            action={`/${ownerName}/${repoName}/pulls/${pr.number}/edit`}
            class="prs-edit-form"
            style="display:none"
          >
            <input
              id="pr-title-input"
              type="text"
              name="title"
              value={pr.title}
              required
              maxlength={256}
              placeholder="Pull request title"
            />
            <div class="prs-edit-actions">
              <button type="submit" class="prs-edit-save-btn">Save</button>
              <button
                type="button"
                class="prs-edit-cancel-btn"
                onclick={`
                  document.getElementById('pr-edit-form').style.display='none';
                  document.getElementById('pr-title-display').style.display='';
                  document.getElementById('pr-edit-toggle').style.display='';
                `}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        <div class="prs-detail-meta">
          <span class={`prs-state-pill state-${stateKey}`}>
            <span aria-hidden="true">{stateIcon}</span>
            <span>{stateLabel}</span>
          </span>
          {prSizeInfo && (
            <span
              class="prs-size-badge"
              style={`color:${prSizeInfo.color};background:${prSizeInfo.bgColor}`}
              title={`${prSizeInfo.linesChanged} lines changed (+${prSizeInfo.added} −${prSizeInfo.deleted})`}
            >
              {prSizeInfo.label}
            </span>
          )}
          <TrioVerdictPills
            comments={comments.map(({ comment }) => comment)}
          />
          <span>
            <strong>{author?.username}</strong> wants to merge
          </span>
          <span class="prs-detail-branches" title={`${pr.headBranch} into ${pr.baseBranch}`}>
            <span class="prs-branch-pill is-head">{pr.headBranch}</span>
            <span class="prs-branch-arrow-lg">{"→"}</span>
            <span class="prs-branch-pill">{pr.baseBranch}</span>
          </span>
          {pr.state === "open" && (branchAhead > 0 || branchBehind > 0) && (
            <span
              class={`prs-branch-sync${branchBehind > 0 ? " is-behind" : " is-synced"}`}
              title={branchBehind > 0
                ? `This branch is ${branchBehind} commit${branchBehind === 1 ? "" : "s"} behind ${pr.baseBranch} — consider rebasing`
                : `This branch is ${branchAhead} commit${branchAhead === 1 ? "" : "s"} ahead of ${pr.baseBranch}`}
            >
              {branchAhead > 0 ? `↑${branchAhead}` : ""}
              {branchAhead > 0 && branchBehind > 0 ? " " : ""}
              {branchBehind > 0 ? `↓${branchBehind}` : ""}
            </span>
          )}
          <span>opened {formatRelative(pr.createdAt)}</span>
          {taskTotal > 0 && (
            <span
              class={`prs-tasks-pill${taskChecked === taskTotal ? " is-complete" : ""}`}
              title={`${taskChecked} of ${taskTotal} tasks completed`}
            >
              <span class="prs-tasks-progress" aria-hidden="true">
                <span
                  class="prs-tasks-progress-bar"
                  style={`width:${Math.round((taskChecked / taskTotal) * 100)}%`}
                ></span>
              </span>
              {taskChecked}/{taskTotal} tasks
            </span>
          )}
          {canManage && pr.state === "open" && branchBehind > 0 && (
            <form
              method="post"
              action={`/${ownerName}/${repoName}/pulls/${pr.number}/update-branch`}
              class="prs-inline-form"
            >
              <button
                type="submit"
                class="prs-update-branch-btn"
                title={`Merge ${pr.baseBranch} into ${pr.headBranch} to bring this branch up to date (${branchBehind} commit${branchBehind === 1 ? "" : "s"} behind)`}
              >
                ↑ Update branch
              </button>
            </form>
          )}
          <span
            id="live-pill"
            class="live-pill"
            title="People editing this PR right now"
          >
            <span class="live-pill-dot" aria-hidden="true"></span>
            <span>
              Live: <strong id="live-count">0</strong> editing
            </span>
            <span id="live-avatars" class="live-avatars" aria-hidden="true"></span>
          </span>
          {preview && (
            <a
              class={`preview-prpill is-${preview.status}`}
              href={
                preview.status === "ready"
                  ? preview.previewUrl
                  : `/${ownerName}/${repoName}/previews`
              }
              target={preview.status === "ready" ? "_blank" : undefined}
              rel={preview.status === "ready" ? "noopener noreferrer" : undefined}
              title={`Preview · ${previewStatusLabel(preview.status)}`}
            >
              <span class="preview-prpill-dot" aria-hidden="true"></span>
              <span>Preview: </span>
              <span>{previewStatusLabel(preview.status)}</span>
            </a>
          )}
          {canManage && pr.state === "open" && pr.isDraft && (
            <form
              method="post"
              action={`/${ownerName}/${repoName}/pulls/${pr.number}/ready`}
              class="prs-inline-form prs-detail-actions"
            >
              <button type="submit" class="prs-merge-ready-btn">
                Ready for review
              </button>
            </form>
          )}
        </div>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: LIVE_COEDIT_SCRIPT(pr.id),
        }}
      />
      <script dangerouslySetInnerHTML={{ __html: mentionAutocompleteScript() }} />
      <script dangerouslySetInnerHTML={{ __html: markdownPreviewScript() }} />
      <script dangerouslySetInnerHTML={{ __html: ctrlEnterSubmitScript() + codeBlockCopyScript() }} />

      {/* Presence styles + bar (shown only on the files tab so cursor pills work) */}
      <style dangerouslySetInnerHTML={{ __html: PRESENCE_STYLES }} />
      {/* Toast container — always present for join/leave toasts */}
      <div id="presence-toasts" class="presence-toast-wrap" aria-live="polite" />
      {user && (
        <>
          <div class="presence-bar" id="presence-bar">
            <span class="presence-bar-label">Live reviewers</span>
            <div class="presence-avatars" id="presence-avatars" />
            <span class="presence-count" id="presence-count">Loading…</span>
          </div>
          <script
            dangerouslySetInnerHTML={{
              __html: PR_PRESENCE_SCRIPT(ownerName, repoName, pr.number),
            }}
          />
        </>
      )}

      <nav class="prs-detail-tabs" aria-label="Pull request sections">
        <a
          class={`prs-detail-tab${tab === "conversation" ? " is-active" : ""}`}
          href={`/${ownerName}/${repoName}/pulls/${pr.number}`}
        >
          Conversation
          <span class="prs-detail-tab-count">{commentCount}</span>
        </a>
        <a
          class={`prs-detail-tab${tab === "commits" ? " is-active" : ""}`}
          href={`/${ownerName}/${repoName}/pulls/${pr.number}?tab=commits`}
        >
          Commits
          {branchAhead > 0 && (
            <span class="prs-detail-tab-count">{branchAhead}</span>
          )}
        </a>
        <a
          class={`prs-detail-tab${tab === "files" ? " is-active" : ""}`}
          href={`/${ownerName}/${repoName}/pulls/${pr.number}?tab=files`}
        >
          Files changed
          {diffFiles.length > 0 && (
            <span class="prs-detail-tab-count">{diffFiles.length}</span>
          )}
        </a>
      </nav>

      {/* Proactive pattern warning — shown when a known recurring bug pattern
          overlaps with the files changed in this PR. */}
      {patternWarning && (
        <div class="pattern-warning" style="margin:0 0 16px;padding:12px 16px;border-radius:8px;background:var(--bg-elevated);border:1px solid #f59e0b;border-left:4px solid #f59e0b;font-size:13px;line-height:1.5">
          <span style="font-size:15px;margin-right:6px" aria-hidden="true">⚠️</span>
          <strong>Recurring pattern detected: {patternWarning.title}</strong>
          <span style="color:var(--fg-muted)">
            {" — "}
            This area has had {patternWarning.occurrences} similar fix
            {patternWarning.occurrences === 1 ? "" : "es"}.
            {patternWarning.rootCauseHypothesis && (
              <> Root cause may be in <code style="font-size:12px">{patternWarning.suggestedFile}</code>.</>
            )}
          </span>
        </div>
      )}

      {tab === "commits" ? (
        <div class="prs-commits-list">
          {prCommits.length === 0 ? (
            <div class="prs-commits-empty">No commits between {pr.baseBranch} and {pr.headBranch}.</div>
          ) : (
            prCommits.map((commit) => (
              <div class="prs-commit-row">
                <span class="prs-commit-dot" aria-hidden="true"></span>
                <div class="prs-commit-body">
                  <div class="prs-commit-msg" title={commit.message}>{commit.message}</div>
                  <div class="prs-commit-meta">
                    <strong>{commit.author}</strong> committed{" "}
                    {formatRelative(new Date(commit.date))}
                  </div>
                </div>
                <a
                  href={`/${ownerName}/${repoName}/commit/${commit.sha}`}
                  class="prs-commit-sha"
                  title="View commit"
                >
                  {commit.sha.slice(0, 7)}
                </a>
              </div>
            ))
          )}
        </div>
      ) : tab === "files" ? (
        <>
          {/* PR Split Suggestion — shown when PR has >400 changed lines */}
          {splitSuggestion && (
            <div class="split-suggestion" id="pr-split-banner">
              <div class="split-header">
                <span class="split-icon" aria-hidden="true">✂️</span>
                <strong>This PR may be too large to review effectively</strong>
                <span class="split-stat">
                  {splitSuggestion.totalLines} lines · {splitSuggestion.totalFiles} files
                </span>
                <button
                  class="split-toggle"
                  type="button"
                  onclick="const b=document.getElementById('pr-split-body');const hidden=b.hasAttribute('hidden');b.toggleAttribute('hidden');this.textContent=hidden?'Hide split suggestion':'Show split suggestion';"
                >
                  Show split suggestion
                </button>
              </div>
              <div class="split-body" id="pr-split-body" hidden>
                <p class="split-intro">
                  AI suggests splitting into {splitSuggestion.suggestedPrs.length} PRs:
                </p>
                {splitSuggestion.suggestedPrs.map((sp, i) => (
                  <div class="split-pr">
                    <div class="split-pr-num">{i + 1}</div>
                    <div class="split-pr-body">
                      <strong>{sp.title}</strong>
                      <p>{sp.rationale}</p>
                      <code>{sp.files.join(", ")}</code>
                      <span class="split-lines">~{sp.estimatedLines} lines</span>
                    </div>
                  </div>
                ))}
                {splitSuggestion.mergeOrder.length > 0 && (
                  <p class="split-order">
                    Suggested merge order:{" "}
                    <strong>{splitSuggestion.mergeOrder.join(" → ")}</strong>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Bus Factor Warning — shown when changed files overlap at-risk files */}
          {busRiskFiles.length > 0 && (() => {
            const topRisk = busRiskFiles.some((f) => f.risk === "critical")
              ? "critical"
              : busRiskFiles.some((f) => f.risk === "high")
                ? "high"
                : "medium";
            return (
              <div class={`busfactor-panel busfactor-${topRisk}`}>
                <span class="busfactor-icon" aria-hidden="true">⚠️</span>
                <div class="busfactor-body">
                  <strong>Knowledge concentration warning</strong>
                  <p>
                    {busRiskFiles.length} file{busRiskFiles.length !== 1 ? "s" : ""} in
                    this PR {busRiskFiles.length !== 1 ? "are" : "is"} primarily
                    maintained by one person. Consider pairing on this review.
                  </p>
                  <ul>
                    {busRiskFiles.map((f) => (
                      <li>
                        <code>{f.path}</code> —{" "}
                        <strong>{f.primaryAuthorPct}%</strong> by {f.primaryAuthor}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })()}

          <DiffView
            raw={diffRaw}
            files={diffFiles}
            viewFileBase={`/${ownerName}/${repoName}/blob/${pr.headBranch}`}
            inlineComments={diffInlineComments}
            commentActionUrl={user ? `/${ownerName}/${repoName}/pulls/${pr.number}/comment` : undefined}
            applySuggestionUrl={user ? `/${ownerName}/${repoName}/pulls/${pr.number}/apply-suggestion` : undefined}
          />
        </>
      ) : (
        <>
          {pr.body && (
            <CommentBox
              author={author?.username ?? "unknown"}
              date={pr.createdAt}
              body={renderMarkdown(pr.body)}
            />
          )}

          {/* Block H — AI trio review (security/correctness/style). When
              `AI_TRIO_REVIEW_ENABLED=1` the three persona comments are
              hoisted into a 3-column card grid above the normal comment
              stream so reviewers see verdicts at a glance. Disagreements
              are surfaced as a yellow callout. */}
          <TrioReviewGrid
            comments={comments.map(({ comment }) => comment)}
          />

          {comments.map(({ comment, author: commentAuthor }) => {
            // Skip trio comments — already rendered in TrioReviewGrid above.
            if (isTrioComment(comment.body)) return null;
            const slashCmd = detectSlashCmdComment(comment.body);
            if (slashCmd) {
              const visible = stripSlashCmdMarker(comment.body);
              return (
                <div class={`slash-pill slash-cmd-${slashCmd}`}>
                  <span class="slash-pill-icon" aria-hidden="true">{"⚡"}</span>
                  <span class="slash-pill-actor">
                    <strong>{commentAuthor.username}</strong>
                    {" ran "}
                    <code class="slash-pill-cmd">/{slashCmd}</code>
                  </span>
                  <span class="slash-pill-time">
                    {formatRelative(comment.createdAt)}
                  </span>
                  <div class="slash-pill-body">
                    <MarkdownContent html={renderMarkdown(visible)} />
                  </div>
                </div>
              );
            }
            const isPending = comment.moderationStatus === "pending";
            return (
              <div
                class={`prs-comment${comment.isAiReview ? " is-ai" : ""}${isPending ? " modq-comment-pending" : ""}`}
              >
                <div class="prs-comment-head">
                  <strong>{commentAuthor.username}</strong>
                  {commentAuthor.username === BOT_USERNAME && (
                    <span class="prs-bot-badge">&#x1F916; bot</span>
                  )}
                  {comment.isAiReview && (
                    <span class="prs-ai-badge">AI Review</span>
                  )}
                  {isPending && (
                    <span
                      class="modq-pending-badge"
                      title="This comment is awaiting the repository owner's approval — only you and the owner can see it."
                    >
                      Awaiting approval
                    </span>
                  )}
                  <span class="prs-comment-time">
                    commented {formatRelative(comment.createdAt)}
                  </span>
                  {comment.filePath && (
                    <span class="prs-comment-loc">
                      {comment.filePath}
                      {comment.lineNumber ? `:${comment.lineNumber}` : ""}
                    </span>
                  )}
                </div>
                <div class="prs-comment-body">
                  <MarkdownContent html={renderMarkdown(comment.body)} />
                </div>
              </div>
            );
          })}

          {/* Quick link to the Files changed tab when there's a diff to look at. */}
          {pr.state !== "merged" && (
            <a
              href={`/${ownerName}/${repoName}/pulls/${pr.number}?tab=files`}
              class="prs-files-card"
            >
              <span class="prs-files-card-icon" aria-hidden="true">
                {"▤"}
              </span>
              <div class="prs-files-card-text">
                <p class="prs-files-card-title">Files changed</p>
                <p class="prs-files-card-sub">
                  Side-by-side diff for {pr.headBranch} {"→"} {pr.baseBranch}.
                </p>
              </div>
              <span class="prs-files-card-cta">View diff {"→"}</span>
            </a>
          )}

          {linkedIssues.length > 0 && (
            <div class="prs-linked-issues">
              <div class="prs-linked-issues-head">
                <span>Closing issues</span>
                <span class="prs-linked-issues-count">{linkedIssues.length}</span>
              </div>
              {linkedIssues.map((issue) => (
                <a
                  href={`/${ownerName}/${repoName}/issues/${issue.number}`}
                  class="prs-linked-issue-row"
                >
                  <span class={`prs-linked-issue-icon${issue.state === "open" ? " is-open" : " is-closed"}`} aria-hidden="true">
                    {issue.state === "open" ? "○" : "✓"}
                  </span>
                  <span class="prs-linked-issue-title">{issue.title}</span>
                  <span class="prs-linked-issue-num">#{issue.number}</span>
                  <span class={`prs-linked-issue-state${issue.state === "open" ? " is-open" : " is-closed"}`}>
                    {issue.state}
                  </span>
                </a>
              ))}
            </div>
          )}

          {error && (
            <div
              class="auth-error"
              style="margin-top: 16px; padding: 12px; background: rgba(248, 81, 73, 0.1); border: 1px solid var(--red); border-radius: var(--radius); color: var(--red)"
            >
              {decodeURIComponent(error)}
            </div>
          )}

          {info && (
            <div style="margin-top: 16px; padding: 12px; background: rgba(56, 139, 253, 0.1); border: 1px solid var(--accent); border-radius: var(--radius); color: var(--text)">
              {decodeURIComponent(info)}
            </div>
          )}

          {pr.state === "open" && (prRisk || prRiskCalculating) && (
            <PrRiskCard risk={prRisk} calculating={prRiskCalculating} />
          )}

          {/* ─── Requested reviewers (CODEOWNERS auto-assign, migration 0077) ─── */}
          {requestedReviewerRows.length > 0 && (
            <div class="prs-review-summary" style="margin-top:14px">
              <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);font-weight:700;margin-bottom:4px">
                Review requested
              </div>
              {requestedReviewerRows.map((rr) => {
                const hasReviewed = latestReviewByReviewer.has(rr.reviewerId);
                const review = latestReviewByReviewer.get(rr.reviewerId);
                const statusIcon = !hasReviewed ? "⏳" : review?.state === "approved" ? "✓" : "✗";
                const statusColor = !hasReviewed
                  ? "var(--text-muted)"
                  : review?.state === "approved"
                    ? "#34d399"
                    : "#f87171";
                return (
                  <div class="prs-review-row" style={`gap:8px`}>
                    <span class="prs-reviewer-avatar">
                      {rr.reviewerUsername.slice(0, 1).toUpperCase()}
                    </span>
                    <a href={`/${rr.reviewerUsername}`}
                       style="flex:1;font-size:13px;color:var(--text);font-weight:600;text-decoration:none">
                      {rr.reviewerUsername}
                    </a>
                    <span style={`font-size:12px;font-weight:600;color:${statusColor}`}>
                      {statusIcon} {!hasReviewed ? "Pending" : review?.state === "approved" ? "Approved" : "Changes requested"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* ─── Review summary ─────────────────────────────────── */}
          {(approvals.length > 0 || changesRequested.length > 0) && (
            <div class="prs-review-summary">
              {approvals.length > 0 && (
                <div class="prs-review-row prs-review-approved">
                  <span class="prs-review-icon">✓</span>
                  <span>
                    <strong>{approvals.map(r => r.reviewerUsername).join(", ")}</strong>{" "}
                    approved this pull request
                  </span>
                </div>
              )}
              {changesRequested.length > 0 && (
                <div class="prs-review-row prs-review-changes">
                  <span class="prs-review-icon">✗</span>
                  <span>
                    <strong>{changesRequested.map(r => r.reviewerUsername).join(", ")}</strong>{" "}
                    requested changes
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Suggested reviewers */}
          {reviewerSuggestions.length > 0 && user && user.id !== pr.authorId && (
            <div class="prs-review-summary" style="margin-top:12px">
              <div class="prs-review-row" style="flex-direction:column;align-items:flex-start;gap:8px">
                <span style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-muted);font-weight:700">
                  Suggested reviewers
                </span>
                {reviewerSuggestions.map((r) => (
                  <form method="post" action={`/${ownerName}/${repoName}/pulls/${pr.number}/request-review`}
                        style="display:flex;align-items:center;gap:8px;width:100%">
                    <input type="hidden" name="reviewerId" value={r.userId} />
                    <span class="prs-reviewer-avatar">
                      {r.username.slice(0, 1).toUpperCase()}
                    </span>
                    <a href={`/${r.username}`} style="flex:1;font-size:13px;color:var(--fg);font-weight:600;text-decoration:none">
                      {r.username}
                    </a>
                    <span style="font-size:11px;color:var(--fg-muted)">{r.commitCount}c</span>
                    <button type="submit" class="btn" style="font-size:12px;padding:3px 9px">
                      Request
                    </button>
                  </form>
                ))}
              </div>
            </div>
          )}

          {pr.state === "open" && gateChecks.length > 0 && (
            <div class="prs-gate-card">
              <div class="prs-gate-head">
                <h3>Gate checks</h3>
                <span class="prs-gate-summary">
                  {gatesAllPassed
                    ? `All ${gateChecks.length} checks passed`
                    : `${gateChecks.filter((c) => !c.passed).length} of ${gateChecks.length} failing`}
                </span>
              </div>
              {gateChecks.map((check) => {
                const isAi = /ai.*review/i.test(check.name);
                const isSkip = check.skipped === true;
                const statusClass = isSkip
                  ? "is-skip"
                  : check.passed
                    ? "is-pass"
                    : "is-fail";
                const statusGlyph = isSkip
                  ? "—"
                  : check.passed
                    ? "✓"
                    : "✗";
                const statusLabel = isSkip
                  ? "Skipped"
                  : check.passed
                    ? "Passed"
                    : "Failing";
                return (
                  <div
                    class="prs-gate-row"
                    style={
                      isAi
                        ? "border-left: 3px solid rgba(140,109,255,0.55); padding-left: 15px"
                        : ""
                    }
                  >
                    <span class={`prs-gate-icon ${statusClass}`} aria-hidden="true">
                      {statusGlyph}
                    </span>
                    <span class="prs-gate-name">
                      {check.name}
                      {isAi && (
                        <span
                          style="margin-left:8px;display:inline-flex;align-items:center;gap:4px;padding:1px 7px;font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#fff;background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 130%);border-radius:9999px;vertical-align:middle"
                        >
                          AI
                        </span>
                      )}
                    </span>
                    <span class="prs-gate-details">{check.details}</span>
                    <span class={`prs-gate-pill ${statusClass}`}>
                      {statusLabel}
                    </span>
                  </div>
                );
              })}
              <div class="prs-gate-footer">
                {gatesAllPassed
                  ? "All checks passed — ready to merge."
                  : gateChecks.some(
                      (c) => !c.passed && c.name === "Merge check"
                    )
                    ? "Conflicts detected — GlueCron AI will attempt auto-resolution on merge."
                    : "Some checks failed — resolve issues before merging."}
                {aiReviewCount > 0 && (
                  <>
                    {" "}· {aiReviewCount} AI review{aiReviewCount === 1 ? "" : "s"} on this PR.
                  </>
                )}
              </div>
            </div>
          )}

          {pr.state === "open" && ciStatuses.length > 0 && (
            <div class="prs-ci-card">
              <div class="prs-ci-head">
                <h3>CI checks</h3>
                <span class="prs-ci-summary">
                  {ciStatuses.filter(s => s.state === "success").length}/{ciStatuses.length} passing
                </span>
              </div>
              {ciStatuses.map((status) => {
                const iconGlyph = status.state === "success" ? "✓" : status.state === "pending" ? "…" : "✗";
                return (
                  <div class="prs-ci-row">
                    <span class={`prs-ci-icon is-${status.state}`} aria-hidden="true">{iconGlyph}</span>
                    <span class="prs-ci-context">{status.context}</span>
                    {status.description && (
                      <span class="prs-ci-desc">{status.description}</span>
                    )}
                    <span class={`prs-ci-pill is-${status.state}`}>
                      {status.state}
                    </span>
                    {status.targetUrl && (
                      <a href={status.targetUrl} class="prs-ci-link" target="_blank" rel="noopener noreferrer">Details</a>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ─── Merge area / state-aware action card ─────────────── */}
          {user && pr.state === "open" && (
            <div
              class={`prs-merge-card${pr.isDraft ? " is-draft" : ""}`}
            >
              <div class="prs-merge-head">
                <strong>
                  {pr.isDraft
                    ? "Draft — ready for review?"
                    : mergeBlocked
                      ? "Merge blocked"
                      : "Ready to merge"}
                </strong>
              </div>
              <p class="prs-merge-sub">
                {pr.isDraft
                  ? "This PR is in draft. Mark it ready to trigger AI review + gate checks."
                  : mergeBlocked
                    ? "Resolve the failing gate checks above before this PR can land."
                    : gateChecks.length > 0
                      ? gatesAllPassed
                        ? "All gates green. Merge will fast-forward into the base branch."
                        : "Conflicts will be auto-resolved by GlueCron AI on merge."
                      : "Run gate checks by refreshing once your branch has a recent commit."}
              </p>
              <Form
                method="post"
                action={`/${ownerName}/${repoName}/pulls/${pr.number}/comment`}
              >
                <FormGroup>
                  <div class="live-cursor-host" style="position:relative">
                    <textarea
                      name="body"
                      id="pr-comment-body"
                      data-live-field="comment_new"
                      data-md-preview=""
                      rows={5}
                      required
                      placeholder="Leave a comment... (Markdown supported)"
                      style="font-family:var(--font-mono);font-size:13px;width:100%"
                    ></textarea>
                  </div>
                  <span class="slash-hint" title="Type a slash-command as the first line">
                    Type <code>/</code> for commands —{" "}
                    <code>/help</code>, <code>/merge</code>, <code>/rebase</code>,{" "}
                    <code>/explain</code>, <code>/test</code>, <code>/lgtm</code>
                  </span>
                </FormGroup>
                <div class="prs-merge-actions">
                  <Button type="submit" variant="primary">
                    Comment
                  </Button>
                  {user && user.id !== pr.authorId && pr.state === "open" && (
                    <>
                      <button
                        type="submit"
                        formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/review`}
                        name="review_state"
                        value="approved"
                        class="prs-review-approve-btn"
                        title="Approve this pull request"
                      >
                        ✓ Approve
                      </button>
                      <button
                        type="submit"
                        formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/review`}
                        name="review_state"
                        value="changes_requested"
                        class="prs-review-changes-btn"
                        title="Request changes before merging"
                      >
                        ✗ Request changes
                      </button>
                    </>
                  )}
                  {canManage && (
                    <>
                      {pr.isDraft ? (
                        <button
                          type="submit"
                          formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/ready`}
                          formnovalidate
                          class="prs-merge-ready-btn"
                        >
                          Ready for review
                        </button>
                      ) : (
                        <>
                          <div class="prs-merge-strategy-wrap">
                            <span class="prs-merge-strategy-label">Strategy</span>
                            <select name="merge_strategy" class="prs-merge-strategy-select" title="Choose how commits are combined into the base branch">
                              <option value="merge">Merge commit</option>
                              <option value="squash">Squash and merge</option>
                              <option value="ff">Fast-forward</option>
                            </select>
                          </div>
                          <button
                            type="submit"
                            formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/merge`}
                            formnovalidate
                            class={`prs-merge-btn${mergeBlocked ? " is-disabled" : ""}`}
                            title={
                              mergeBlocked
                                ? "Failing gate checks must be resolved before this PR can merge."
                                : "Merge pull request"
                            }
                          >
                            {"✔"} Merge pull request
                          </button>
                        </>
                      )}
                      {!pr.isDraft && (
                        <button
                          type="submit"
                          formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/draft`}
                          formnovalidate
                          class="prs-merge-back-draft"
                          title="Convert back to draft"
                        >
                          Convert to draft
                        </button>
                      )}
                      {isAiReviewEnabled() && (
                        <button
                          type="submit"
                          formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/ai-rereview`}
                          formnovalidate
                          class="btn"
                          title="Re-run AI review (e.g. after a force-push). Posts a fresh summary + inline comments."
                        >
                          Re-run AI review
                        </button>
                      )}
                      {isAiReviewEnabled() && !hasAiTestsMarker && (
                        <button
                          type="submit"
                          formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/generate-tests`}
                          formnovalidate
                          class="btn"
                          title="Ask Claude to read this PR's diff and write tests for the new code. Tests land as a follow-up PR against this branch."
                        >
                          Generate tests with AI
                        </button>
                      )}
                      <Button
                        type="submit"
                        variant="danger"
                        formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/close`}
                      >
                        Close
                      </Button>
                    </>
                  )}
                </div>
              </Form>
            </div>
          )}

          {/* Read-only footers for non-open states. */}
          {pr.state === "merged" && (
            <div class="prs-merge-card is-merged">
              <div class="prs-merge-head">
                <strong>{"⮌"} Merged</strong>
              </div>
              <p class="prs-merge-sub">
                This pull request was merged into{" "}
                <code>{pr.baseBranch}</code>.
              </p>
            </div>
          )}
          {pr.state === "closed" && (
            <div class="prs-merge-card is-closed">
              <div class="prs-merge-head">
                <strong>{"✕"} Closed without merging</strong>
              </div>
              <p class="prs-merge-sub">
                This pull request was closed and not merged.
              </p>
            </div>
          )}
        </>
      )}
    </Layout>
  );
});

// Update branch — merge base into head so the PR branch is up to date.
// Uses a git worktree so the bare repo stays clean. Write access required.
pulls.post(
  "/:owner/:repo/pulls/:number/update-branch",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        eq(pullRequests.number, prNum),
      ))
      .limit(1);
    if (!pr || pr.state !== "open") {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    const repoDir = getRepoPath(ownerName, repoName);
    const wt = `${repoDir}/_update_wt_${Date.now()}`;
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: user.displayName || user.username,
      GIT_AUTHOR_EMAIL: user.email,
      GIT_COMMITTER_NAME: user.displayName || user.username,
      GIT_COMMITTER_EMAIL: user.email,
    };

    const addWt = Bun.spawn(
      ["git", "worktree", "add", wt, pr.headBranch],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    if (await addWt.exited !== 0) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Could not create working tree — branch may be locked")}`
      );
    }

    let ok = false;
    try {
      const mergeProc = Bun.spawn(
        ["git", "merge", "--no-edit", pr.baseBranch],
        { cwd: wt, env: gitEnv, stdout: "pipe", stderr: "pipe" }
      );
      if (await mergeProc.exited === 0) {
        ok = true;
      } else {
        await Bun.spawn(["git", "merge", "--abort"], { cwd: wt }).exited.catch(() => {});
      }
    } catch {
      await Bun.spawn(["git", "merge", "--abort"], { cwd: wt }).exited.catch(() => {});
    }

    await Bun.spawn(
      ["git", "worktree", "remove", "--force", wt],
      { cwd: repoDir }
    ).exited.catch(() => {});

    if (ok) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent("Branch updated — base merged in successfully")}`
      );
    }
    return c.redirect(
      `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Update failed — conflicts must be resolved manually")}`
    );
  }
);

// Edit PR title (and optionally body). Owner or author only.
pulls.post(
  "/:owner/:repo/pulls/:number/edit",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        eq(pullRequests.number, prNum),
      ))
      .limit(1);
    if (!pr || pr.state !== "open") {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }
    const canEdit = user.id === resolved.owner.id || user.id === pr.authorId;
    if (!canEdit) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    const body = await c.req.parseBody();
    const newTitle = String(body.title || "").trim().slice(0, 256);
    if (!newTitle) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Title cannot be empty")}`
      );
    }

    await db
      .update(pullRequests)
      .set({ title: newTitle, updatedAt: new Date() })
      .where(eq(pullRequests.id, pr.id));

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent("Title updated")}`);
  }
);

// Add comment to PR.
//
// Permission model mirrors `issues.tsx`: any logged-in user with read
// access can submit; `decideInitialStatus` routes non-collaborators
// through the moderation queue. Slash commands only fire when the
// comment is auto-approved — we don't want a banned/pending comment to
// silently trigger AI work on the PR.
pulls.post(
  "/:owner/:repo/pulls/:number/comment",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const commentBody = String(body.body || "").trim();
    const filePathRaw = String(body.file_path || "").trim();
    const lineNumberRaw = parseInt(String(body.line_number || ""), 10);
    const inlineFilePath = filePathRaw || undefined;
    const inlineLineNumber = Number.isFinite(lineNumberRaw) && lineNumberRaw > 0 ? lineNumberRaw : undefined;

    if (!commentBody) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);

    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    const decision = await decideInitialStatus({
      commenterUserId: user.id,
      repositoryId: resolved.repo.id,
      kind: "pr",
      threadId: pr.id,
    });

    const [inserted] = await db
      .insert(prComments)
      .values({
        pullRequestId: pr.id,
        authorId: user.id,
        body: commentBody,
        moderationStatus: decision.status,
        filePath: inlineFilePath,
        lineNumber: inlineLineNumber,
      })
      .returning();

    // Live update: only when the comment is actually visible.
    if (inserted && decision.status === "approved") {
      try {
        const { publish } = await import("../lib/sse");
        publish(`repo:${resolved.repo.id}:pr:${prNum}`, {
          event: "pr-comment",
          data: {
            pullRequestId: pr.id,
            commentId: inserted.id,
            authorId: user.id,
            authorUsername: user.username,
          },
        });
      } catch {
        /* SSE is best-effort */
      }
      // Notify the PR author — fire-and-forget, never blocks the response.
      if (pr.authorId && pr.authorId !== user.id) {
        void import("../lib/notify").then(({ createNotification }) =>
          createNotification({
            userId: pr.authorId,
            type: "pr_comment",
            title: `New comment on "${pr.title}"`,
            body: commentBody.length > 200 ? commentBody.slice(0, 200) + "…" : commentBody,
            url: `/${ownerName}/${repoName}/pulls/${prNum}`,
            repoId: resolved.repo.id,
          })
        ).catch(() => { /* never block the response */ });
      }
    }

    if (decision.status === "pending") {
      void notifyOwnerOfPendingComment({
        repositoryId: resolved.repo.id,
        commenterUsername: user.username,
        kind: "pr",
        threadNumber: prNum,
        ownerUsername: ownerName,
        repoName,
      });
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent("Comment awaiting author approval")}`
      );
    }
    if (decision.status === "rejected") {
      // Silent ban path — same UX as 'pending' so we don't leak the gate.
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent("Comment awaiting author approval")}`
      );
    }

    // Slash-command handoff. We always store the original comment above
    // first so free-form text that happens to start with `/` is preserved
    // verbatim; only recognised commands trigger a follow-up bot comment.
    // (Only reachable when decision.status === 'approved'.)
    const parsed = parseSlashCommand(commentBody);
    if (parsed) {
      try {
        const result = await executeSlashCommand({
          command: parsed.command,
          args: parsed.args,
          prId: pr.id,
          userId: user.id,
          repositoryId: resolved.repo.id,
        });
        await db.insert(prComments).values({
          pullRequestId: pr.id,
          authorId: user.id,
          body: result.body,
        });
      } catch (err) {
        // Defence-in-depth — executeSlashCommand promises not to throw,
        // but if it ever does we want the PR thread to know.
        await db
          .insert(prComments)
          .values({
            pullRequestId: pr.id,
            authorId: user.id,
            body: `<!-- cmd:${parsed.command} -->\n\nSlash-command \`/${parsed.command}\` crashed: ${err instanceof Error ? err.message : String(err)}`,
          })
          .catch(() => {});
      }
    }

    // Inline comments go back to the files tab; conversation comments to the conversation tab
    const redirectTab = inlineFilePath ? "?tab=files" : "";
    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}${redirectTab}`);
  }
);

// Apply a suggestion from a PR comment — commits the suggested code to the
// head branch on behalf of the logged-in user.
pulls.post(
  "/:owner/:repo/pulls/:number/apply-suggestion/:commentId",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const commentId = c.req.param("commentId"); // UUID
    const user = c.get("user")!;

    const backUrl = `/${ownerName}/${repoName}/pulls/${prNum}?tab=files`;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);

    if (!pr || pr.state !== "open") {
      return c.redirect(`${backUrl}&error=pr_not_open`);
    }

    // Only PR author or repo owner may apply suggestions.
    if (user.id !== pr.authorId && user.id !== resolved.repo.ownerId) {
      return c.redirect(`${backUrl}&error=forbidden`);
    }

    // Load the comment.
    const [comment] = await db
      .select()
      .from(prComments)
      .where(
        and(
          eq(prComments.id, commentId),
          eq(prComments.pullRequestId, pr.id)
        )
      )
      .limit(1);

    if (!comment) {
      return c.redirect(`${backUrl}&error=comment_not_found`);
    }

    // Parse suggestion block from comment body.
    const m = comment.body.match(/```suggestion\n([\s\S]*?)\n```/);
    if (!m) {
      return c.redirect(`${backUrl}&error=no_suggestion`);
    }
    const suggestionCode = m[1];

    // Get the commenter's details for the commit message co-author line.
    const [commenter] = await db
      .select()
      .from(users)
      .where(eq(users.id, comment.authorId))
      .limit(1);

    // Fetch current file content from head branch.
    if (!comment.filePath) {
      return c.redirect(`${backUrl}&error=file_not_found`);
    }
    const blob = await getBlob(ownerName, repoName, pr.headBranch, comment.filePath);
    if (!blob) {
      return c.redirect(`${backUrl}&error=file_not_found`);
    }

    // Apply the patch — replace the target line(s) with suggestion lines.
    const lines = blob.content.split('\n');
    const lineIdx = (comment.lineNumber ?? 1) - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) {
      return c.redirect(`${backUrl}&error=line_out_of_range`);
    }
    const suggestionLines = suggestionCode.split('\n');
    lines.splice(lineIdx, 1, ...suggestionLines);
    const newContent = lines.join('\n');

    // Commit the change.
    const coAuthorLine = commenter
      ? `Co-authored-by: ${commenter.username} <${commenter.username}@users.noreply.gluecron.com>`
      : "";
    const commitMessage = `Apply suggestion from PR #${pr.number}${coAuthorLine ? `\n\n${coAuthorLine}` : ""}`;

    const result = await createOrUpdateFileOnBranch({
      owner: ownerName,
      name: repoName,
      branch: pr.headBranch,
      filePath: comment.filePath,
      bytes: new TextEncoder().encode(newContent),
      message: commitMessage,
      authorName: user.username,
      authorEmail: `${user.username}@users.noreply.gluecron.com`,
    });

    if ("error" in result) {
      return c.redirect(`${backUrl}&error=apply_failed`);
    }

    // Post a follow-up comment noting the suggestion was applied.
    await db.insert(prComments).values({
      pullRequestId: pr.id,
      authorId: user.id,
      body: `✅ Suggestion applied in commit ${result.commitSha.slice(0, 7)}.`,
    });

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}?tab=files`);
  }
);

// Formal review — Approve / Request Changes / Comment
pulls.post(
  "/:owner/:repo/pulls/:number/review",
  softAuth,
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const reviewBody = String(body.body || "").trim();
    const reviewState = String(body.review_state || "commented");

    const validStates = ["approved", "changes_requested", "commented"];
    if (!validStates.includes(reviewState)) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);
    if (!pr || pr.state !== "open") {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }
    // Authors can't review their own PR
    if (pr.authorId === user.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("You cannot review your own pull request")}`
      );
    }

    await db.insert(prReviews).values({
      pullRequestId: pr.id,
      reviewerId: user.id,
      state: reviewState,
      body: reviewBody || null,
    });

    const stateLabel =
      reviewState === "approved" ? "Approved"
      : reviewState === "changes_requested" ? "Changes requested"
      : "Commented";
    return c.redirect(
      `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent(stateLabel)}`
    );
  }
);

// Merge PR — with green gate enforcement and auto conflict resolution
// NOTE: Merging is a high-impact action that arguably warrants "admin" access,
// but we keep it at "write" for v1 so trusted collaborators can ship.
// Revisit when we introduce a distinct "maintain" / "admin" collaborator role
// surface. Branch-protection rules (evaluated below) are the current mechanism
// for locking down merges further on specific branches.
pulls.post(
  "/:owner/:repo/pulls/:number/merge",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;

    // Read merge strategy from form (default: merge commit)
    let mergeStrategy = "merge";
    try {
      const body = await c.req.parseBody();
      const s = body.merge_strategy;
      if (s === "squash" || s === "ff" || s === "merge") mergeStrategy = s as string;
    } catch { /* ignore parse errors — default to merge commit */ }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);

    if (!pr || pr.state !== "open") {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    // Draft PRs cannot be merged — must be marked ready first.
    if (pr.isDraft) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(
          "This PR is a draft. Mark it as ready for review before merging."
        )}`
      );
    }

    // Required reviews check — branch-protection `required_approvals` gate.
    // Evaluated before running expensive gate checks so the feedback is fast.
    {
      const eligibility = await checkMergeEligible(pr.id, resolved.repo.id, pr.baseBranch);
      if (!eligibility.eligible && eligibility.reason) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(eligibility.reason)}`
        );
      }
    }

    // Resolve head SHA
    const headSha = await resolveRef(ownerName, repoName, pr.headBranch);
    if (!headSha) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Head branch not found")}`
      );
    }

    // Check if AI review approved this PR
    const aiComments = await db
      .select()
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, pr.id),
          eq(prComments.isAiReview, true)
        )
      );
    const aiApproved = aiComments.length === 0 || aiComments.some(
      (c) => c.body.includes("**Approved**") || c.body.includes("approved: true") || c.body.toLowerCase().includes("lgtm")
    );

    // Run all green gate checks (GateTest + mergeability + AI review)
    const gateResult = await runAllGateChecks(
      ownerName,
      repoName,
      pr.baseBranch,
      pr.headBranch,
      headSha,
      aiApproved
    );

    // If GateTest or AI review failed (hard blocks), reject the merge
    const hardFailures = gateResult.checks.filter(
      (check) => !check.passed && check.name !== "Merge check"
    );
    if (hardFailures.length > 0) {
      const errorMsg = hardFailures
        .map((f) => `${f.name}: ${f.details}`)
        .join("; ");
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(errorMsg)}`
      );
    }

    // D5 — Branch-protection enforcement. Looks up the matching rule for the
    // base branch and blocks the merge if requireAiApproval / requireGreenGates
    // / requireHumanReview / requiredApprovals are not satisfied. Independent
    // of repo-global settings, so owners can lock specific branches down
    // further than the repo default.
    const protectionRule = await matchProtection(
      resolved.repo.id,
      pr.baseBranch
    );
    if (protectionRule) {
      const humanApprovals = await countHumanApprovals(pr.id);
      const required = await listRequiredChecks(protectionRule.id);
      const passingNames = required.length > 0
        ? await passingCheckNames(resolved.repo.id, headSha)
        : [];
      const decision = evaluateProtection(
        protectionRule,
        {
          aiApproved,
          humanApprovalCount: humanApprovals,
          gateResultGreen: hardFailures.length === 0,
          hasFailedGates: hardFailures.length > 0,
          passingCheckNames: passingNames,
        },
        required.map((r) => r.checkName)
      );
      if (!decision.allowed) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(
            decision.reasons.join(" ")
          )}`
        );
      }
    }

    // Attempt the merge — with auto conflict resolution if needed
    const repoDir = getRepoPath(ownerName, repoName);
    const mergeCheck = gateResult.checks.find((c) => c.name === "Merge check");
    const hasConflicts = mergeCheck && !mergeCheck.passed;

    if (hasConflicts && isAiReviewEnabled()) {
      // Use Claude to auto-resolve conflicts
      const mergeResult = await mergeWithAutoResolve(
        ownerName,
        repoName,
        pr.baseBranch,
        pr.headBranch,
        `Merge pull request #${pr.number}: ${pr.title}`
      );

      if (!mergeResult.success) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(mergeResult.error || "Auto-merge failed")}`
        );
      }

      // Post a comment about the auto-resolution
      if (mergeResult.resolvedFiles.length > 0) {
        await db.insert(prComments).values({
          pullRequestId: pr.id,
          authorId: user.id,
          body: `**Auto-resolved merge conflicts** in:\n${mergeResult.resolvedFiles.map((f) => `- \`${f}\``).join("\n")}\n\nConflicts were automatically resolved by GlueCron AI.`,
          isAiReview: true,
        });
      }
    } else {
      // Worktree-based merge: supports merge-commit, squash, and fast-forward
      const wt = `${repoDir}/_merge_wt_${Date.now()}`;
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: user.displayName || user.username,
        GIT_AUTHOR_EMAIL: user.email,
        GIT_COMMITTER_NAME: user.displayName || user.username,
        GIT_COMMITTER_EMAIL: user.email,
      };

      // Create linked worktree on the base branch
      const addWt = Bun.spawn(
        ["git", "worktree", "add", wt, pr.baseBranch],
        { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
      );
      if (await addWt.exited !== 0) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Merge failed — could not create worktree")}`
        );
      }

      const commitMsg = `Merge pull request #${pr.number}: ${pr.title}`;
      let mergeOk = false;

      try {
        if (mergeStrategy === "squash") {
          // Squash: stage all changes without committing
          const squashProc = Bun.spawn(
            ["git", "merge", "--squash", headSha],
            { cwd: wt, stdout: "pipe", stderr: "pipe", env: gitEnv }
          );
          if (await squashProc.exited !== 0) {
            const errTxt = await new Response(squashProc.stderr).text();
            throw new Error(`Squash merge failed: ${errTxt.trim()}`);
          }
          // Commit the squashed changes
          const commitProc = Bun.spawn(
            ["git", "commit", "-m", commitMsg],
            { cwd: wt, stdout: "pipe", stderr: "pipe", env: gitEnv }
          );
          if (await commitProc.exited !== 0) {
            const errTxt = await new Response(commitProc.stderr).text();
            throw new Error(`Squash commit failed: ${errTxt.trim()}`);
          }
          mergeOk = true;
        } else if (mergeStrategy === "ff") {
          // Fast-forward only — fail if FF is not possible
          const ffProc = Bun.spawn(
            ["git", "merge", "--ff-only", headSha],
            { cwd: wt, stdout: "pipe", stderr: "pipe", env: gitEnv }
          );
          if (await ffProc.exited !== 0) {
            const errTxt = await new Response(ffProc.stderr).text();
            throw new Error(`Fast-forward not possible: ${errTxt.trim()}`);
          }
          mergeOk = true;
        } else {
          // Default: merge commit (--no-ff always creates a merge commit)
          const mergeProc = Bun.spawn(
            ["git", "merge", "--no-ff", "-m", commitMsg, headSha],
            { cwd: wt, stdout: "pipe", stderr: "pipe", env: gitEnv }
          );
          if (await mergeProc.exited !== 0) {
            const errTxt = await new Response(mergeProc.stderr).text();
            throw new Error(`Merge commit failed: ${errTxt.trim()}`);
          }
          mergeOk = true;
        }
      } catch (err) {
        // Always clean up the worktree before redirecting
        Bun.spawn(["git", "worktree", "remove", "--force", wt], { cwd: repoDir }).exited.catch(() => {});
        const msg = err instanceof Error ? err.message : "Merge failed";
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(msg)}`
        );
      }

      // Clean up worktree (changes are now in the bare repo via linked worktree)
      await Bun.spawn(
        ["git", "worktree", "remove", "--force", wt],
        { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
      ).exited.catch(() => {});

      if (!mergeOk) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Merge failed")}`
        );
      }
    }

    await db
      .update(pullRequests)
      .set({
        state: "merged",
        mergedAt: new Date(),
        mergedBy: user.id,
        updatedAt: new Date(),
      })
      .where(eq(pullRequests.id, pr.id));

    // Chat notifier — fan out merge event to Slack/Discord/Teams.
    import("../lib/chat-notifier")
      .then((m) =>
        m.notifyChatChannels({
          ownerUserId: resolved.repo.ownerId,
          repositoryId: resolved.repo.id,
          event: {
            event: "pr.merged",
            repo: `${ownerName}/${repoName}`,
            title: `#${pr.number} ${pr.title}`,
            url: `/${ownerName}/${repoName}/pulls/${pr.number}`,
            actor: user.username,
          },
        })
      )
      .catch((err) =>
        console.warn(`[chat-notifier] PR merge notify failed:`, err)
      );

    // J7 — closing keywords. Scan PR title + body for "closes #N" style refs
    // and auto-close each matching open issue with a back-link comment. Bounded
    // to the same repo for v1 (cross-repo refs ignored). Failures never block
    // the merge redirect.
    try {
      const { extractClosingRefsMulti } = await import("../lib/close-keywords");
      const refs = extractClosingRefsMulti([pr.title, pr.body]);
      for (const n of refs) {
        const [issue] = await db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.repositoryId, resolved.repo.id),
              eq(issues.number, n)
            )
          )
          .limit(1);
        if (!issue || issue.state !== "open") continue;
        await db
          .update(issues)
          .set({ state: "closed", closedAt: new Date(), updatedAt: new Date() })
          .where(eq(issues.id, issue.id));
        await db.insert(issueComments).values({
          issueId: issue.id,
          authorId: user.id,
          body: `Closed by pull request #${pr.number}.`,
        });
      }
    } catch {
      // Never block the merge on close-keyword failures.
    }

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Toggle draft state — mark a PR as "ready for review". Triggers AI review if it
// hasn't run yet on this PR.
pulls.post(
  "/:owner/:repo/pulls/:number/ready",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);
    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    // Only the author or repo owner can toggle draft state.
    if (pr.authorId !== user.id && resolved.owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    if (pr.state === "open" && pr.isDraft) {
      await db
        .update(pullRequests)
        .set({ isDraft: false, updatedAt: new Date() })
        .where(eq(pullRequests.id, pr.id));

      if (isAiReviewEnabled()) {
        triggerAiReview(
          ownerName,
          repoName,
          pr.id,
          pr.title,
          pr.body || "",
          pr.baseBranch,
          pr.headBranch
        ).catch((err) => console.error("[ai-review] ready trigger failed:", err));
      }
    }

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Convert a PR back to draft.
pulls.post(
  "/:owner/:repo/pulls/:number/draft",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);
    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    if (pr.authorId !== user.id && resolved.owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    if (pr.state === "open" && !pr.isDraft) {
      await db
        .update(pullRequests)
        .set({ isDraft: true, updatedAt: new Date() })
        .where(eq(pullRequests.id, pr.id));
    }

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Close PR
pulls.post(
  "/:owner/:repo/pulls/:number/close",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db
      .update(pullRequests)
      .set({
        state: "closed",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      );

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Re-run AI review on demand (e.g. after a force-push). Bypasses the
// idempotency marker via { force: true }. Write-access only.
pulls.post(
  "/:owner/:repo/pulls/:number/ai-rereview",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);
    if (!pr) {
      return c.redirect(`/${ownerName}/${repoName}/pulls`);
    }

    if (!isAiReviewEnabled()) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(
          "AI review is not configured (ANTHROPIC_API_KEY)."
        )}`
      );
    }

    // Fire-and-forget but with { force: true } to bypass the
    // already-reviewed marker. The function still never throws.
    triggerAiReview(
      ownerName,
      repoName,
      pr.id,
      pr.title || "",
      pr.body || "",
      pr.baseBranch,
      pr.headBranch,
      { force: true }
    ).catch((err) => {
      console.warn(
        `[ai-rereview] triggerAiReview failed for PR ${pr.id}:`,
        err instanceof Error ? err.message : err
      );
    });

    return c.redirect(
      `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent(
        "AI re-review queued. The new comment will appear in 10-30s; reload to see it."
      )}`
    );
  }
);

// Generate-tests-with-AI explicit trigger. Opens a follow-up PR against
// the PR's head branch carrying just the new test files. Write-access only.
// Idempotent — if `ai:added-tests` was previously applied we redirect with
// an `info` banner instead of re-firing.
pulls.post(
  "/:owner/:repo/pulls/:number/generate-tests",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);
    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    if (!isAiReviewEnabled()) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(
          "AI test generation is not configured (ANTHROPIC_API_KEY)."
        )}`
      );
    }

    // Fire-and-forget. The lib never throws.
    generateTestsForPr({ prId: pr.id, mode: "follow-up-pr" })
      .then((res) => {
        if (!res.ok) {
          console.warn(
            `[generate-tests] PR ${pr.id}: ${res.error || "no patches"}`
          );
        }
      })
      .catch((err) => {
        console.warn(
          `[generate-tests] generateTestsForPr threw for PR ${pr.id}:`,
          err instanceof Error ? err.message : err
        );
      });

    return c.redirect(
      `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent(
        "Generating tests with AI. The follow-up PR will appear in 20-60s; reload to see it."
      )}`
    );
  }
);

// ─── Request review ───────────────────────────────────────────────────────────
pulls.post(
  "/:owner/:repo/pulls/:number/request-review",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    const [pr] = await db
      .select({ id: pullRequests.id, number: pullRequests.number, authorId: pullRequests.authorId })
      .from(pullRequests)
      .where(and(eq(pullRequests.repositoryId, resolved.repo.id), eq(pullRequests.number, prNum)))
      .limit(1);

    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    const body = await c.req.formData().catch(() => null);
    const reviewerId = (body?.get("reviewerId") as string | null)?.trim();

    if (!reviewerId || reviewerId === pr.authorId || reviewerId === user.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent("Invalid reviewer selection.")}`
      );
    }

    // Verify the reviewer is the repo owner or an accepted collaborator — prevents
    // requesting reviews from arbitrary user IDs outside this repository.
    const isOwner = reviewerId === resolved.owner.id;
    if (!isOwner) {
      const [collab] = await db
        .select({ id: repoCollaborators.id })
        .from(repoCollaborators)
        .where(
          and(
            eq(repoCollaborators.repositoryId, resolved.repo.id),
            eq(repoCollaborators.userId, reviewerId),
            isNotNull(repoCollaborators.acceptedAt)
          )
        )
        .limit(1);
      if (!collab) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent("Reviewer must be a repository collaborator.")}`
        );
      }
    }

    const { requestReview } = await import("../lib/reviewer-suggest");
    const result = await requestReview(pr.id, resolved.repo.id, reviewerId, user.id);

    const msg = result.ok
      ? "Review requested successfully."
      : `Failed to request review: ${result.error ?? "unknown error"}`;

    return c.redirect(
      `/${ownerName}/${repoName}/pulls/${prNum}?info=${encodeURIComponent(msg)}`
    );
  }
);

// ─── WebSocket presence endpoint ─────────────────────────────────────────────
//
// GET /:owner/:repo/pulls/:number/presence  (WebSocket upgrade)
//
// Unauthenticated connections are rejected with 401. On connect:
//   → server sends {type:"init", sessionId, users:[...]}
//   → server broadcasts {type:"join", user} to all other sessions in the room
//
// Accepted client messages:
//   {type:"cursor",  line: number}             — user hovering a diff line
//   {type:"typing",  line: number, typing: bool} — textarea focus/blur
//   {type:"ping"}                              — keep-alive (updates lastSeen)
//
// The WS `data` payload we store on each socket carries everything needed in
// the event handlers so no closure tricks are required.

pulls.get(
  "/:owner/:repo/pulls/:number/presence",
  softAuth,
  upgradeWebSocket(async (c) => {
    const { owner: ownerName, repo: repoName, number: prNumStr } = c.req.param();
    const prNum = parseInt(prNumStr ?? "0", 10);
    const user = c.get("user");

    // Auth check — no anonymous presence
    if (!user) {
      // upgradeWebSocket doesn't support returning a non-101 directly;
      // we return a dummy handler that immediately closes with 4001.
      return {
        onOpen(_evt: Event, ws: import("hono/ws").WSContext) {
          ws.close(4001, "Unauthorized");
        },
        onMessage() {},
        onClose() {},
      };
    }

    // Resolve repo to get its numeric id for the room key
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved || isNaN(prNum)) {
      return {
        onOpen(_evt: Event, ws: import("hono/ws").WSContext) {
          ws.close(4004, "Not found");
        },
        onMessage() {},
        onClose() {},
      };
    }

    const prId = `${resolved.repo.id}:${prNum}`;
    const sessionId = `${user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return {
      onOpen(_evt: Event, ws: import("hono/ws").WSContext) {
        // Register and join room
        registerSocket(prId, sessionId, {
          send: (data: string) => ws.send(data),
          readyState: ws.readyState,
        });
        const presenceUser = joinRoom(prId, sessionId, {
          userId: user.id,
          username: user.username,
        });

        // Send init snapshot to the new joiner
        const currentUsers = getRoomUsers(prId);
        ws.send(
          JSON.stringify({
            type: "init",
            sessionId,
            users: currentUsers,
          })
        );

        // Broadcast join to all OTHER sessions
        broadcastToRoom(
          prId,
          {
            type: "join",
            user: { ...presenceUser, sessionId },
          },
          sessionId
        );
      },

      onMessage(evt: MessageEvent, _ws: import("hono/ws").WSContext) {
        let msg: { type: string; line?: number; typing?: boolean };
        try {
          msg = JSON.parse(typeof evt.data === "string" ? evt.data : String(evt.data));
        } catch {
          return;
        }

        if (msg.type === "ping") {
          pingSession(prId, sessionId);
          return;
        }

        if (msg.type === "cursor") {
          const line = typeof msg.line === "number" ? msg.line : null;
          const updated = updatePresence(prId, sessionId, line, false);
          if (updated) {
            broadcastToRoom(
              prId,
              {
                type: "cursor",
                sessionId,
                username: updated.username,
                colour: updated.colour,
                line,
              },
              sessionId
            );
          }
          return;
        }

        if (msg.type === "typing") {
          const line = typeof msg.line === "number" ? msg.line : null;
          const typing = !!msg.typing;
          const updated = updatePresence(prId, sessionId, line, typing);
          if (updated) {
            broadcastToRoom(
              prId,
              {
                type: "typing",
                sessionId,
                username: updated.username,
                colour: updated.colour,
                line,
                typing,
              },
              sessionId
            );
          }
          return;
        }
      },

      onClose() {
        leaveRoom(prId, sessionId);
        unregisterSocket(prId, sessionId);
        broadcastToRoom(prId, { type: "leave", sessionId });
      },
    };
  })
);

export default pulls;
