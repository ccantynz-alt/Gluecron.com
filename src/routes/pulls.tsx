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
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import {
  pullRequests,
  prComments,
  repositories,
  users,
  issues,
  issueComments,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { DiffView } from "../views/diff-view";
import { ReactionsBar } from "../views/reactions";
import { summariseReactions } from "../lib/reactions";
import { loadPrTemplate } from "../lib/templates";
import { renderMarkdown } from "../lib/markdown";
import { liveCommentBannerScript } from "../lib/sse-client";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { isAiReviewEnabled, triggerAiReview } from "../lib/ai-review";
import { triggerPrTriage } from "../lib/pr-triage";
import { generatePrSummary } from "../lib/ai-generators";
import { isAiAvailable } from "../lib/ai-client";
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
} from "../git/repository";
import type { GitDiffFile } from "../git/repository";
import { html } from "hono/html";
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

// List PRs
pulls.get("/:owner/:repo/pulls", softAuth, requireRepoAccess("read"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const state = c.req.query("state") || "open";

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
              .prs-skel { background: linear-gradient(90deg, var(--bg-secondary) 0%, var(--bg-elevated) 50%, var(--bg-secondary) 100%); background-size: 200% 100%; animation: prsSkelShimmer 1.4s infinite; border-radius: 6px; display: block; }
              @keyframes prsSkelShimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
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
      and(eq(pullRequests.repositoryId, resolved.repo.id), stateFilter)
    )
    .orderBy(desc(pullRequests.createdAt));

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
  const tabPills: Array<{ label: string; count: number; key: string; href: string }> = [
    { label: "Open", count: openCount, key: "open", href: `/${ownerName}/${repoName}/pulls?state=open` },
    { label: "Merged", count: mergedCount, key: "merged", href: `/${ownerName}/${repoName}/pulls?state=merged` },
    { label: "Closed", count: closedCount, key: "closed", href: `/${ownerName}/${repoName}/pulls?state=closed` },
    { label: "All", count: allCount, key: "all", href: `/${ownerName}/${repoName}/pulls?state=all` },
    { label: "Draft", count: draftCount, key: "draft", href: `/${ownerName}/${repoName}/pulls?state=draft` },
  ];
  const isAllState = state === "all";

  return c.html(
    <Layout title={`Pull Requests — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
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
          {user && (
            <div class="prs-hero-actions">
              <a href={`/${ownerName}/${repoName}/pulls/new`} class="prs-cta">
                + New pull request
              </a>
            </div>
          )}
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

      {prList.length === 0 ? (
        <div class="prs-empty">
          <div class="prs-empty-inner">
            <strong>
              {isAllState
                ? "Pick a filter above to browse PRs."
                : `No ${state} pull requests.`}
            </strong>
            <p class="prs-empty-sub">
              {state === "open"
                ? "Pull requests propose changes from a branch into the base. Open one to kick off AI review, gate checks, and (if eligible) auto-merge."
                : isAllState
                  ? "The combined view is coming soon — Open, Merged, Closed, and Draft are all live above."
                  : `No ${state} pull requests on ${ownerName}/${repoName} right now. Try a different filter.`}
            </p>
            <div class="prs-empty-cta">
              {user && state === "open" && (
                <a href={`/${ownerName}/${repoName}/pulls/new`} class="btn btn-primary">
                  + New pull request
                </a>
              )}
              {state !== "open" && (
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

    // R3 — fast-lane auto-merge evaluation. Fires after AI review lands.
    import("../lib/auto-merge")
      .then((m) => m.tryAutoMergeNow(pr.id))
      .catch((err) => {
        console.warn(
          `[auto-merge] tryAutoMergeNow failed for PR ${pr.id}:`,
          err instanceof Error ? err.message : err
        );
      });

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

  const comments = await db
    .select({
      comment: prComments,
      author: { username: users.username },
    })
    .from(prComments)
    .innerJoin(users, eq(prComments.authorId, users.id))
    .where(eq(prComments.pullRequestId, pr.id))
    .orderBy(asc(prComments.createdAt));

  // Reactions for the PR body + each comment, in parallel.
  const [prReactions, ...prCommentReactions] = await Promise.all([
    summariseReactions("pr", pr.id, user?.id),
    ...comments.map((row) =>
      summariseReactions("pr_comment", row.comment.id, user?.id)
    ),
  ]);

  const canManage =
    user &&
    (user.id === resolved.owner.id || user.id === pr.authorId);

  const error = c.req.query("error");
  const info = c.req.query("info");

  // Get gate check status for open PRs
  let gateChecks: GateCheckResult[] = [];
  if (pr.state === "open") {
    const headSha = await resolveRef(ownerName, repoName, pr.headBranch);
    if (headSha) {
      const aiComments = comments.filter(({ comment }) => comment.isAiReview);
      const aiApproved = aiComments.length === 0 || aiComments.some(
        ({ comment }) => comment.body.includes("**Approved**")
      );
      const gateResult = await runAllGateChecks(
        ownerName, repoName, pr.baseBranch, pr.headBranch, headSha, aiApproved
      );
      gateChecks = gateResult.checks;
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

  // Get diff for "Files changed" tab
  let diffRaw = "";
  let diffFiles: GitDiffFile[] = [];
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

  return c.html(
    <Layout
      title={`${pr.title} #${pr.number} — ${ownerName}/${repoName}`}
      user={user}
    >
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
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
        <h1 class="prs-detail-title">
          {pr.title}{" "}
          <span class="prs-detail-num">#{pr.number}</span>
        </h1>
        <div class="prs-detail-meta">
          <span class={`prs-state-pill state-${stateKey}`}>
            <span aria-hidden="true">{stateIcon}</span>
            <span>{stateLabel}</span>
          </span>
          <span>
            <strong>{author?.username}</strong> wants to merge
          </span>
          <span class="prs-detail-branches" title={`${pr.headBranch} into ${pr.baseBranch}`}>
            <span class="prs-branch-pill is-head">{pr.headBranch}</span>
            <span class="prs-branch-arrow-lg">{"→"}</span>
            <span class="prs-branch-pill">{pr.baseBranch}</span>
          </span>
          <span>opened {formatRelative(pr.createdAt)}</span>
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

      <nav class="prs-detail-tabs" aria-label="Pull request sections">
        <a
          class={`prs-detail-tab${tab === "conversation" ? " is-active" : ""}`}
          href={`/${ownerName}/${repoName}/pulls/${pr.number}`}
        >
          Conversation
          <span class="prs-detail-tab-count">{commentCount}</span>
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

      {tab === "files" ? (
        <DiffView
          raw={diffRaw}
          files={diffFiles}
          viewFileBase={`/${ownerName}/${repoName}/blob/${pr.headBranch}`}
        />
      ) : (
        <>
          {pr.body && (
            <CommentBox
              author={author?.username ?? "unknown"}
              date={pr.createdAt}
              body={renderMarkdown(pr.body)}
            />
          )}

          {comments.map(({ comment, author: commentAuthor }) => (
            <div class={`prs-comment${comment.isAiReview ? " is-ai" : ""}`}>
              <div class="prs-comment-head">
                <strong>{commentAuthor.username}</strong>
                {comment.isAiReview && (
                  <span class="prs-ai-badge">AI Review</span>
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
          ))}

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
                  <TextArea
                    name="body"
                    rows={5}
                    required
                    placeholder="Leave a comment... (Markdown supported)"
                    mono
                  />
                </FormGroup>
                <div class="prs-merge-actions">
                  <Button type="submit" variant="primary">
                    Comment
                  </Button>
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

// Add comment to PR
pulls.post(
  "/:owner/:repo/pulls/:number/comment",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const commentBody = String(body.body || "").trim();

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

    const [inserted] = await db
      .insert(prComments)
      .values({
        pullRequestId: pr.id,
        authorId: user.id,
        body: commentBody,
      })
      .returning();

    // Live update: nudge any browser tabs subscribed to this PR.
    if (inserted) {
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
    }

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
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
      // Standard merge — fast-forward or clean merge
      const ffProc = Bun.spawn(
        [
          "git",
          "update-ref",
          `refs/heads/${pr.baseBranch}`,
          `refs/heads/${pr.headBranch}`,
        ],
        { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
      );
      const ffExit = await ffProc.exited;

      if (ffExit !== 0) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Merge failed — unable to update branch ref")}`
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

export default pulls;
