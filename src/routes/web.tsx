/**
 * Web UI routes — browse repositories, code, commits, diffs.
 * Now auth-aware with user profiles, repo creation, stars, and syntax highlighting.
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { config } from "../lib/config";
import {
  users,
  repositories,
  stars,
  commitVerifications,
} from "../db/schema";
import { Layout } from "../views/layout";
import { PendingCommentsBanner as RepoHomePendingBanner } from "../views/pending-comments-banner";
import {
  RepoHeader,
  RepoNav,
  Breadcrumb,
  FileTable,
  RepoCard,
  BranchSwitcher,
  HighlightedCode,
  PlainCode,
} from "../views/components";
import { DiffView } from "../views/diff-view";
import {
  getTree,
  getBlob,
  listCommits,
  getCommit,
  getCommitFullMessage,
  getDiff,
  getReadme,
  getDefaultBranch,
  listBranches,
  listTags,
  repoExists,
  initBareRepo,
  getBlame,
  getRawBlob,
  searchCode,
  getRepoPath,
} from "../git/repository";
import { renderMarkdown, markdownCss } from "../lib/markdown";
import { highlightCode } from "../lib/highlight";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { trackByName } from "../lib/traffic";
import { LandingPage, type LandingLiveFeed } from "../views/landing";
import { Landing2030Page } from "../views/landing-2030";
import { computePublicStats, type PublicStats } from "../lib/public-stats";
import {
  listQueuedAiBuildIssues,
  listRecentAutoMerges,
  listRecentAiReviews,
  countAiReviewsSince,
  listDemoActivityFeed,
} from "../lib/demo-activity";

const web = new Hono<AuthEnv>();

// Soft auth on all web routes — c.get("user") available but may be null
web.use("*", softAuth);

/**
 * Shared CSS for the polished code-browse surfaces (parallel session 3.E).
 *
 * Inlined here rather than in `src/views/layout.tsx` because session 3.E's
 * scope is route-local and `layout.tsx` is locked. Each polished handler
 * injects this via a `<style>` tag; the rules are namespaced by surface
 * prefix (`.new-repo-*`, `.profile-*`, `.tree-*`, `.blob-*`, `.commits-*`,
 * `.commit-detail-*`, `.blame-*`, `.search-*`) so nothing bleeds into the
 * `.repo-home-*` styling Agent A already shipped.
 */
const codeBrowseCss = `
  /* ───────── shared primitives ───────── */
  .cb-hairline::before,
  .new-repo-hero::before,
  .profile-hero::before,
  .commits-hero::before,
  .commit-detail-card::before,
  .search-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  @keyframes cbHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.8; }
  }
  @media (prefers-reduced-motion: reduce) {
    .new-repo-hero-orb,
    .profile-hero-orb,
    .commits-hero-orb { animation: none; }
  }

  /* ───────── new-repo ───────── */
  .new-repo-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .new-repo-hero-orb-wrap {
    position: absolute;
    inset: -25% -10% auto auto;
    width: 360px;
    height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .new-repo-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: cbHeroOrb 14s ease-in-out infinite;
  }
  .new-repo-hero-inner { position: relative; z-index: 1; }
  .new-repo-eyebrow {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: var(--space-2);
  }
  .new-repo-eyebrow strong { color: var(--accent); font-weight: 600; }
  .new-repo-title {
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .new-repo-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .new-repo-form {
    max-width: 680px;
  }
  .new-repo-error {
    background: rgba(218, 54, 51, 0.12);
    border: 1px solid rgba(218, 54, 51, 0.35);
    color: #ffb3b3;
    padding: 10px 14px;
    border-radius: 10px;
    margin-bottom: var(--space-4);
    font-size: 14px;
  }
  .new-repo-form-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .new-repo-row { display: flex; flex-direction: column; gap: 6px; }
  .new-repo-label {
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 600;
  }
  .new-repo-label-optional {
    color: var(--text-muted);
    font-weight: 400;
    font-size: 12px;
  }
  .new-repo-input {
    appearance: none;
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text-strong);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 14px;
    font-family: inherit;
    transition: border-color var(--t-fast, 0.15s) ease, box-shadow var(--t-fast, 0.15s) ease;
  }
  .new-repo-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .new-repo-input-disabled {
    color: var(--text-muted);
    background: var(--bg-secondary);
    cursor: not-allowed;
  }
  .new-repo-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: 4px 0 0;
  }
  .new-repo-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 5px;
    color: var(--text-strong);
  }
  .new-repo-visibility {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }
  @media (max-width: 600px) {
    .new-repo-visibility { grid-template-columns: 1fr; }
  }
  .new-repo-vis-card {
    display: flex;
    gap: 10px;
    padding: 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    cursor: pointer;
    transition: border-color var(--t-fast, 0.15s) ease, background var(--t-fast, 0.15s) ease;
  }
  .new-repo-vis-card:hover { border-color: var(--border-strong, var(--border)); }
  .new-repo-vis-card:has(input:checked) {
    border-color: rgba(140,109,255,0.55);
    background: rgba(140,109,255,0.06);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.25);
  }
  .new-repo-vis-radio {
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .new-repo-vis-body { display: flex; flex-direction: column; gap: 4px; }
  .new-repo-vis-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .new-repo-vis-desc {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .new-repo-callout {
    margin-top: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--accent-gradient-faint, rgba(140,109,255,0.06));
    border: 1px solid rgba(140,109,255,0.2);
    border-radius: 12px;
  }
  .new-repo-callout-eyebrow {
    font-size: 11px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
    font-weight: 700;
    margin-bottom: 4px;
  }
  .new-repo-callout-body {
    font-size: 13px;
    color: var(--text);
    line-height: 1.5;
    margin: 0;
  }
  .new-repo-callout-body code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent);
    background: rgba(140,109,255,0.1);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .new-repo-templates {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }
  .new-repo-template-chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    transition: border-color 140ms ease, background 140ms ease, color 140ms ease;
  }
  .new-repo-template-chip input { position: absolute; opacity: 0; pointer-events: none; }
  .new-repo-template-chip:hover {
    border-color: var(--border-strong, var(--border));
    color: var(--text-strong);
  }
  .new-repo-template-chip:has(input:checked) {
    border-color: rgba(140,109,255,0.55);
    background: rgba(140,109,255,0.10);
    color: var(--text-strong);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.25);
  }
  .new-repo-template-chip-dot {
    width: 8px; height: 8px;
    border-radius: 999px;
    background: var(--text-faint, var(--text-muted));
    transition: background 140ms ease, box-shadow 140ms ease;
  }
  .new-repo-template-chip:has(input:checked) .new-repo-template-chip-dot {
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 8px rgba(140,109,255,0.6);
  }
  .new-repo-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
    align-items: center;
  }
  .new-repo-submit {
    min-width: 180px;
    border: 1px solid rgba(140,109,255,0.45);
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    font-weight: 700;
    box-shadow: 0 8px 20px -8px rgba(140,109,255,0.55);
    transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease;
  }
  .new-repo-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 24px -8px rgba(140,109,255,0.7);
    filter: brightness(1.06);
  }
  .new-repo-submit:focus-visible {
    outline: 3px solid rgba(140,109,255,0.45);
    outline-offset: 2px;
  }

  /* ───────── profile ───────── */
  .profile-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .profile-hero-orb-wrap {
    position: absolute;
    inset: -25% -10% auto auto;
    width: 360px;
    height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .profile-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: cbHeroOrb 14s ease-in-out infinite;
  }
  .profile-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    gap: var(--space-5);
  }
  .profile-hero-avatar {
    flex: 0 0 auto;
    width: 88px;
    height: 88px;
    border-radius: 50%;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 38px;
    font-weight: 700;
    font-family: var(--font-display);
    box-shadow: 0 8px 24px -8px rgba(140,109,255,0.55);
  }
  .profile-hero-text { flex: 1; min-width: 0; }
  .profile-eyebrow {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: var(--space-2);
  }
  .profile-eyebrow strong { color: var(--accent); font-weight: 600; }
  .profile-name {
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    font-size: clamp(28px, 3.6vw, 36px);
    line-height: 1.05;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .profile-handle {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }
  .profile-bio {
    font-size: 14.5px;
    color: var(--text);
    line-height: 1.55;
    margin: 0 0 var(--space-3);
    max-width: 640px;
  }
  .profile-meta {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    font-size: 13px;
  }
  .profile-meta-link {
    color: var(--text-muted);
    transition: color var(--t-fast, 0.15s) ease;
  }
  .profile-meta-link:hover { color: var(--accent); text-decoration: none; }
  .profile-meta-link strong {
    color: var(--text-strong);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .profile-follow-form { margin: 0; }
  @media (max-width: 600px) {
    .profile-hero-inner { flex-direction: column; align-items: flex-start; gap: var(--space-3); }
    .profile-hero-avatar { width: 64px; height: 64px; font-size: 28px; }
  }
  .profile-readme {
    margin-bottom: var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .profile-readme-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-muted);
  }
  .profile-readme-icon { color: var(--accent); font-size: 14px; }
  .profile-readme-body { padding: var(--space-5) var(--space-6); }
  .profile-section-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .profile-section-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 20px;
    letter-spacing: -0.015em;
    margin: 0;
    color: var(--text-strong);
  }
  .profile-section-count {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 10px;
    font-variant-numeric: tabular-nums;
  }
  .profile-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .profile-empty-text { color: var(--text-muted); font-size: 14px; margin: 0; }

  /* ───────── tree (file browser) ───────── */
  .tree-header {
    margin-bottom: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .tree-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .tree-header-stats {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: 12px;
    color: var(--text-muted);
  }
  .tree-stat strong {
    color: var(--text-strong);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .tree-stat-link {
    color: var(--text-muted);
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    transition: color var(--t-fast, 0.15s) ease, border-color var(--t-fast, 0.15s) ease;
  }
  .tree-stat-link:hover {
    color: var(--accent);
    border-color: rgba(140,109,255,0.45);
    text-decoration: none;
  }
  .tree-breadcrumb-row {
    font-size: 13px;
  }

  /* ───────── blob (file viewer) ───────── */
  .blob-toolbar {
    margin-bottom: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .blob-breadcrumb { font-size: 13px; }
  .blob-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .blob-header-polished {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 10px 14px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }
  .blob-header-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    flex: 1;
  }
  .blob-header-icon { font-size: 14px; opacity: 0.85; }
  .blob-header-name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .blob-header-size {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    border-left: 1px solid var(--border);
    padding-left: var(--space-2);
    margin-left: 2px;
  }
  .blob-header-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .blob-pill {
    display: inline-flex;
    align-items: center;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 999px;
    transition: color var(--t-fast, 0.15s) ease, border-color var(--t-fast, 0.15s) ease, background var(--t-fast, 0.15s) ease;
  }
  .blob-pill:hover {
    color: var(--accent);
    border-color: rgba(140,109,255,0.45);
    text-decoration: none;
    background: rgba(140,109,255,0.06);
  }
  .blob-pill-accent {
    color: var(--accent);
    border-color: rgba(140,109,255,0.35);
    background: rgba(140,109,255,0.08);
  }
  .blob-pill-accent:hover {
    background: rgba(140,109,255,0.14);
  }
  .blob-binary {
    padding: var(--space-5);
    color: var(--text-muted);
    text-align: center;
    font-size: 13px;
    background: var(--bg);
  }

  /* ───────── commits list ───────── */
  .commits-hero {
    position: relative;
    margin-bottom: var(--space-4);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .commits-hero-orb-wrap {
    position: absolute;
    inset: -25% -10% auto auto;
    width: 320px;
    height: 320px;
    pointer-events: none;
    z-index: 0;
  }
  .commits-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.16), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: cbHeroOrb 14s ease-in-out infinite;
  }
  .commits-hero-inner { position: relative; z-index: 1; }
  .commits-eyebrow {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: var(--space-2);
  }
  .commits-eyebrow strong { color: var(--accent); font-weight: 600; }
  .commits-title {
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.025em;
    font-size: clamp(22px, 3vw, 30px);
    line-height: 1.15;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .commits-branch {
    font-family: var(--font-mono);
    font-size: 0.7em;
    color: var(--text);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 8px;
    font-weight: 500;
    vertical-align: middle;
  }
  .commits-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 640px;
  }
  .commits-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .commits-toolbar-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .commits-toolbar-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text-muted);
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    text-decoration: none;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .commits-toolbar-link:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }
  .commits-list-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .commits-list-wrap::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .commits-day-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 18px;
    font-size: 11.5px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }
  .commits-day-head:not(:first-child) { border-top: 1px solid var(--border); }
  .commits-day-head-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
  }
  .commits-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background 120ms ease;
  }
  .commits-row:last-child { border-bottom: none; }
  .commits-row:hover { background: rgba(255,255,255,0.022); }
  .commits-avatar {
    width: 34px; height: 34px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.30), rgba(54,197,214,0.25));
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13.5px;
    flex-shrink: 0;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
  }
  .commits-row-body { flex: 1; min-width: 0; }
  .commits-row-msg {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .commits-row-msg a {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 14px;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
  }
  .commits-row-msg a:hover { color: var(--accent); text-decoration: none; }
  .commits-row-verified {
    font-size: 9.5px;
    padding: 1px 7px;
    border-radius: 9999px;
    background: rgba(52,211,153,0.16);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }
  .commits-row-meta {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .commits-row-meta strong { color: var(--text); font-weight: 600; }
  .commits-row-meta .sep { opacity: 0.4; }
  .commits-row-time {
    font-variant-numeric: tabular-nums;
  }
  .commits-row-side {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .commits-row-sha {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    text-decoration: none;
    letter-spacing: 0.04em;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }
  .commits-row-sha:hover {
    border-color: rgba(140,109,255,0.55);
    color: var(--accent);
    background: rgba(140,109,255,0.08);
    text-decoration: none;
  }
  .commits-row-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px; height: 28px;
    padding: 0;
    border-radius: 8px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: pointer;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .commits-row-copy:hover {
    border-color: var(--border-strong);
    color: var(--text);
    background: rgba(255,255,255,0.04);
  }
  .commits-row-copy.is-copied { color: #6ee7b7; border-color: rgba(52,211,153,0.35); }
  .commits-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 48px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .commits-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .commits-empty-inner { position: relative; z-index: 1; }
  .commits-empty-icon {
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
    margin: 0 auto 14px;
  }
  .commits-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .commits-empty-sub {
    margin: 0 auto 0;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 420px;
    line-height: 1.5;
  }

  /* ───────── branches list ───────── */
  .branches-list {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .branches-list::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .branches-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background 120ms ease;
    flex-wrap: wrap;
  }
  .branches-row:last-child { border-bottom: none; }
  .branches-row:hover { background: rgba(255,255,255,0.022); }
  .branches-row-icon {
    width: 32px; height: 32px;
    border-radius: 8px;
    background: rgba(140,109,255,0.10);
    color: #c4b5fd;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.22);
  }
  .branches-row-main { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 4px; }
  .branches-row-name {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .branches-row-name a {
    font-family: var(--font-mono);
    font-size: 13.5px;
    color: var(--text-strong);
    font-weight: 600;
    text-decoration: none;
  }
  .branches-row-name a:hover { color: var(--accent); text-decoration: none; }
  .branches-row-default {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.14);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    font-family: var(--font-mono);
  }
  .branches-row-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .branches-row-meta .sep { opacity: 0.4; }
  .branches-row-meta strong { color: var(--text); font-weight: 600; }
  .branches-row-side {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .branches-row-divergence {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    padding: 4px 10px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.035);
    border: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }
  .branches-row-divergence .ahead { color: #6ee7b7; }
  .branches-row-divergence .behind { color: #fca5a5; }
  .branches-row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .branches-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 12px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .branches-btn:hover {
    border-color: var(--border-strong);
    color: var(--text);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }
  .branches-btn-danger {
    color: #fca5a5;
    border-color: rgba(248,113,113,0.30);
  }
  .branches-btn-danger:hover {
    border-style: dashed;
    border-color: rgba(248,113,113,0.65);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
  }

  /* ───────── tags list ───────── */
  .tags-list {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .tags-list::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .tags-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background 120ms ease;
    flex-wrap: wrap;
  }
  .tags-row:last-child { border-bottom: none; }
  .tags-row:hover { background: rgba(255,255,255,0.022); }
  .tags-row-icon {
    width: 32px; height: 32px;
    border-radius: 8px;
    background: rgba(54,197,214,0.10);
    color: #67e8f9;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.22);
  }
  .tags-row-main { flex: 1; min-width: 240px; }
  .tags-row-name {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .tags-row-version {
    display: inline-flex;
    align-items: center;
    padding: 3px 11px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 700;
    color: #67e8f9;
    background: rgba(54,197,214,0.12);
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.30);
    letter-spacing: 0.01em;
  }
  .tags-row-meta {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .tags-row-meta .sep { opacity: 0.4; }
  .tags-row-sha {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-strong);
    padding: 2px 8px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    text-decoration: none;
    letter-spacing: 0.04em;
  }
  .tags-row-sha:hover { border-color: var(--border-strong); color: var(--accent); text-decoration: none; }
  .tags-row-side {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .tags-row-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 12px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    color: var(--text-muted);
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .tags-row-link:hover {
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    background: rgba(140,109,255,0.06);
    text-decoration: none;
  }

  /* ───────── commit detail ───────── */
  .commit-detail-card {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .commit-detail-eyebrow {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 12px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }
  .commit-detail-eyebrow strong { color: var(--accent); font-weight: 600; }
  .commit-detail-sha-pill {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-strong);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 10px;
    letter-spacing: 0.04em;
  }
  .commit-detail-verify {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
    color: #fff;
  }
  .commit-detail-verify-ok {
    background: linear-gradient(135deg, #2ea043, #34d399);
  }
  .commit-detail-verify-warn {
    background: linear-gradient(135deg, #d29922, #f59e0b);
  }
  .commit-detail-title {
    font-family: var(--font-display);
    font-weight: 700;
    letter-spacing: -0.018em;
    font-size: clamp(20px, 2.5vw, 26px);
    line-height: 1.25;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .commit-detail-body {
    white-space: pre-wrap;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.55;
    margin: 0 0 var(--space-3);
    font-family: var(--font-mono);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: var(--space-3) var(--space-4);
    max-height: 280px;
    overflow: auto;
  }
  .commit-detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .commit-detail-author strong { color: var(--text-strong); font-weight: 600; }
  .commit-detail-parents { font-size: 13px; color: var(--text-muted); }
  .commit-detail-sha-link {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--accent);
    background: rgba(140,109,255,0.08);
    border-radius: 6px;
    padding: 1px 6px;
    margin-left: 2px;
  }
  .commit-detail-sha-link:hover { background: rgba(140,109,255,0.16); text-decoration: none; }
  .commit-detail-stats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-muted);
  }
  .commit-detail-stat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
  }
  .commit-detail-stat strong { color: var(--text-strong); font-weight: 600; }
  .commit-detail-stat-add strong { color: #34d399; }
  .commit-detail-stat-del strong { color: #f87171; }
  .commit-detail-stat-mark {
    font-family: var(--font-mono);
    font-weight: 700;
    font-size: 14px;
  }
  .commit-detail-stat-add .commit-detail-stat-mark { color: #34d399; }
  .commit-detail-stat-del .commit-detail-stat-mark { color: #f87171; }
  .commit-detail-sha-full {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-faint);
    letter-spacing: 0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .commit-detail-checks {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .commit-detail-checks-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .commit-detail-checks-head strong { color: var(--text-strong); font-weight: 600; }
  .commit-detail-check-state-success { color: #34d399; font-weight: 600; }
  .commit-detail-check-state-failure { color: #f87171; font-weight: 600; }
  .commit-detail-check-state-pending { color: #d29922; font-weight: 600; }
  .commit-detail-check-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .commit-detail-check {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    color: #fff;
    font-weight: 500;
  }
  .commit-detail-check a { color: inherit; text-decoration: none; }
  .commit-detail-check-success { background: #2ea043; }
  .commit-detail-check-pending { background: #d29922; }
  .commit-detail-check-failure { background: #da3633; }

  /* ───────── blame ───────── */
  .blame-head { margin-bottom: var(--space-5); }
  .blame-eyebrow {
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
  .blame-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .blame-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.15;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .blame-title code {
    font-family: var(--font-mono);
    font-size: 0.78em;
    color: var(--text-strong);
    font-weight: 700;
  }
  .blame-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 700px;
  }
  .blame-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
    font-size: 13px;
  }
  .blame-toolbar-actions { display: flex; gap: 6px; }
  .blame-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .blame-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .blame-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 10px 14px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }
  .blame-header-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    flex-wrap: wrap;
  }
  .blame-header-icon { color: var(--accent); font-size: 14px; }
  .blame-header-name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 600;
  }
  .blame-header-tag {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-family: var(--font-mono);
    background: rgba(140,109,255,0.12);
    color: var(--accent);
    border-radius: 999px;
    padding: 2px 8px;
    font-weight: 600;
  }
  .blame-header-stats {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    border-left: 1px solid var(--border);
    padding-left: var(--space-2);
  }
  .blame-header-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .blame-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.6;
  }
  .blame-table tr { border-bottom: 1px solid transparent; }
  .blame-table tr.blame-row-first { border-top: 1px solid var(--border); }
  .blame-table tr:first-child.blame-row-first { border-top: 0; }
  .blame-table tr:hover .blame-line-content { background: rgba(255,255,255,0.025); }
  .blame-gutter {
    width: 220px;
    min-width: 220px;
    padding: 0 12px;
    vertical-align: top;
    background: rgba(255,255,255,0.012);
    border-right: 1px solid var(--border-subtle);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-top: 2px;
    padding-bottom: 2px;
  }
  .blame-gutter-inner {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    overflow: hidden;
  }
  .blame-gutter-sha {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 600;
    color: #c4b5fd;
    background: rgba(140,109,255,0.10);
    padding: 1px 7px;
    border-radius: 9999px;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.22);
    text-decoration: none;
    letter-spacing: 0.04em;
    flex-shrink: 0;
    transition: background 120ms ease, box-shadow 120ms ease, color 120ms ease;
  }
  .blame-gutter-sha:hover {
    background: rgba(140,109,255,0.22);
    color: #ddd6fe;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.50);
    text-decoration: none;
  }
  .blame-gutter-author {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    font-family: var(--font-sans, inherit);
  }
  .blame-line-num {
    width: 1%;
    min-width: 50px;
    padding: 0 12px;
    text-align: right;
    color: var(--text-faint);
    user-select: none;
    border-right: 1px solid var(--border-subtle);
    font-variant-numeric: tabular-nums;
  }
  .blame-line-content {
    padding: 0 14px;
    white-space: pre;
    color: var(--text);
    transition: background 120ms ease;
  }

  /* ───────── search ───────── */
  .search-hero {
    position: relative;
    margin-bottom: var(--space-4);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .search-eyebrow {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: var(--space-2);
  }
  .search-eyebrow strong { color: var(--accent); font-weight: 600; }
  .search-title {
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.025em;
    font-size: clamp(22px, 3vw, 30px);
    line-height: 1.15;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .search-form {
    display: flex;
    gap: var(--space-2);
    align-items: stretch;
  }
  .search-input-wrap {
    position: relative;
    flex: 1;
    display: flex;
    align-items: center;
  }
  .search-input-icon {
    position: absolute;
    left: 12px;
    color: var(--text-muted);
    font-size: 15px;
    pointer-events: none;
  }
  .search-input {
    appearance: none;
    width: 100%;
    padding: 10px 12px 10px 34px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-strong);
    font-size: 14px;
    font-family: inherit;
    transition: border-color var(--t-fast, 0.15s) ease, box-shadow var(--t-fast, 0.15s) ease;
  }
  .search-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .search-submit { min-width: 96px; }
  .search-results-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    font-size: 13px;
    color: var(--text-muted);
  }
  .search-results-count strong {
    color: var(--text-strong);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .search-results-q { color: var(--text-strong); font-weight: 600; }
  .search-results-head code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 6px;
    color: var(--text);
  }
  .search-empty {
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
    border-radius: 12px;
    color: var(--text-muted);
    font-size: 14px;
  }
  .search-empty strong { color: var(--text-strong); }
  .search-results {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .search-file-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .search-file-link {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 600;
  }
  .search-file-link:hover { color: var(--accent); text-decoration: none; }
  .search-file-count {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
`;

// Home page
web.get("/", async (c) => {
  const user = c.get("user");

  if (user) {
    return c.redirect("/dashboard");
  }

  let stats: { publicRepos?: number; users?: number } | undefined;
  let publicStats: PublicStats | null = null;
  try {
    const [repoRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(repositories)
      .where(eq(repositories.isPrivate, false));
    const [userRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users);
    stats = {
      publicRepos: Number(repoRow?.n ?? 0),
      users: Number(userRow?.n ?? 0),
    };
  } catch {
    stats = undefined;
  }

  // Block L4 — public stats counters (5-min in-memory cache; never throws).
  try {
    publicStats = await computePublicStats();
  } catch {
    publicStats = null;
  }

  // Block M1 — initial SSR snapshot for the live-now demo feed.
  // The helpers in lib/demo-activity.ts never throw, but we still wrap
  // in try/catch so a freak module-level explosion can't take down /.
  let liveFeed: LandingLiveFeed | null = null;
  try {
    const [queued, merges, reviewList, reviewCount, feed] = await Promise.all([
      listQueuedAiBuildIssues(3),
      listRecentAutoMerges(3, 24),
      listRecentAiReviews(3, 24),
      countAiReviewsSince(24),
      listDemoActivityFeed(10),
    ]);
    liveFeed = {
      queued: queued.map((i) => ({
        repo: i.repo,
        number: i.number,
        title: i.title,
        createdAt: i.createdAt,
      })),
      merges: merges.map((m) => ({
        repo: m.repo,
        number: m.number,
        title: m.title,
        mergedAt: m.mergedAt,
      })),
      reviews: reviewList.map((r) => ({
        repo: r.repo,
        prNumber: r.prNumber,
        commentSnippet: r.commentSnippet,
        createdAt: r.createdAt,
      })),
      reviewCount,
      feed: feed.map((e) => ({
        kind: e.kind,
        repo: e.repo,
        ref: e.ref,
        at: e.at,
      })),
    };
  } catch {
    liveFeed = null;
  }

  // 2030 reboot — the public landing is a self-contained light marketing
  // document (its own shell + design system), rendered directly so it never
  // inherits the dark app Layout. `publicStats` / `liveFeed` remain computed
  // above for the legacy LandingPage and other surfaces; the new page uses the
  // headline counters from `stats`.
  void publicStats;
  void liveFeed;
  void LandingPage;
  return c.html("<!DOCTYPE html>" + String(<Landing2030Page stats={stats} />));
});

// New repository form
web.get("/new", requireAuth, (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");

  return c.html(
    <Layout title="New repository" user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <div class="new-repo-hero">
        <div class="new-repo-hero-orb-wrap" aria-hidden="true">
          <div class="new-repo-hero-orb" />
        </div>
        <div class="new-repo-hero-inner">
          <div class="new-repo-eyebrow">
            <strong>Create</strong> · {user.username}
          </div>
          <h1 class="new-repo-title">
            Spin up a <span class="gradient-text">repository</span>.
          </h1>
          <p class="new-repo-sub">
            Push your first commit, and Gluecron wires up gate checks, AI review,
            and auto-merge from the moment your branch lands.
          </p>
        </div>
      </div>
      <div class="new-repo-form">
        {error && (
          <div class="new-repo-error" role="alert">
            {decodeURIComponent(error)}
          </div>
        )}
        <form method="post" action="/new" class="new-repo-form-grid">
          <div class="new-repo-row">
            <label class="new-repo-label">Owner</label>
            <input
              type="text"
              value={user.username}
              disabled
              aria-label="Owner"
              class="new-repo-input new-repo-input-disabled"
            />
          </div>
          <div class="new-repo-row">
            <label class="new-repo-label" for="name">
              Repository name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              pattern="^[a-zA-Z0-9._-]+$"
              placeholder="my-project"
              autocomplete="off"
              class="new-repo-input"
            />
            <p class="new-repo-hint">
              Lowercase, numbers, dots, dashes, and underscores. The URL will be{" "}
              <code>{user.username}/&lt;name&gt;</code>.
            </p>
          </div>
          <div class="new-repo-row">
            <label class="new-repo-label" for="description">
              Description{" "}
              <span class="new-repo-label-optional">(optional)</span>
            </label>
            <input
              type="text"
              id="description"
              name="description"
              placeholder="A short description of your repository"
              class="new-repo-input"
            />
          </div>
          <div class="new-repo-row">
            <span class="new-repo-label">Visibility</span>
            <div class="new-repo-visibility">
              <label class="new-repo-vis-card">
                <input
                  type="radio"
                  name="visibility"
                  value="public"
                  checked
                  class="new-repo-vis-radio"
                />
                <span class="new-repo-vis-body">
                  <span class="new-repo-vis-label">Public</span>
                  <span class="new-repo-vis-desc">
                    Anyone can see this repository. You choose who can commit.
                  </span>
                </span>
              </label>
              <label class="new-repo-vis-card">
                <input
                  type="radio"
                  name="visibility"
                  value="private"
                  class="new-repo-vis-radio"
                />
                <span class="new-repo-vis-body">
                  <span class="new-repo-vis-label">Private</span>
                  <span class="new-repo-vis-desc">
                    Only you (and collaborators you invite) can see this
                    repository.
                  </span>
                </span>
              </label>
            </div>
          </div>
          <div class="new-repo-row">
            <span class="new-repo-label">
              Starter content{" "}
              <span class="new-repo-label-optional">(cosmetic — your first push wins)</span>
            </span>
            <div class="new-repo-templates" role="radiogroup" aria-label="Starter content">
              <label class="new-repo-template-chip">
                <input type="radio" name="starter" value="empty" checked />
                <span class="new-repo-template-chip-dot" aria-hidden="true" />
                Empty
              </label>
              <label class="new-repo-template-chip">
                <input type="radio" name="starter" value="readme" />
                <span class="new-repo-template-chip-dot" aria-hidden="true" />
                README
              </label>
              <label class="new-repo-template-chip">
                <input type="radio" name="starter" value="readme-mit" />
                <span class="new-repo-template-chip-dot" aria-hidden="true" />
                README + MIT
              </label>
              <label class="new-repo-template-chip">
                <input type="radio" name="starter" value="node" />
                <span class="new-repo-template-chip-dot" aria-hidden="true" />
                Node + .gitignore
              </label>
            </div>
            <p class="new-repo-hint">
              Just a UI hint — push your own commits to fill the repo.
            </p>
          </div>
          <div class="new-repo-callout">
            <div class="new-repo-callout-eyebrow">AI-native by default</div>
            <p class="new-repo-callout-body">
              Every push is gate-checked and reviewed by Claude automatically.
              Label an issue <code>ai-build</code> and Gluecron will open the PR
              for you.
            </p>
          </div>
          <div class="new-repo-actions">
            <button type="submit" class="btn new-repo-submit">
              Create repository
            </button>
            <a href="/dashboard" class="btn new-repo-cancel">
              Cancel
            </a>
          </div>
        </form>
      </div>
    </Layout>
  );
});

web.post("/new", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const isPrivate = body.visibility === "private";

  if (!name) {
    return c.redirect("/new?error=Repository+name+is+required");
  }

  // P4 — plan-quota gate. Fail-open inside the helper so a billing
  // outage never blocks repo creation.
  const { checkRepoCreateAllowed } = await import("../lib/repo-create-gate");
  const gate = await checkRepoCreateAllowed(user.id);
  if (!gate.ok) {
    return c.redirect(`/new?error=${encodeURIComponent(gate.reason)}`);
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return c.redirect("/new?error=Invalid+repository+name");
  }

  if (await repoExists(user.username, name)) {
    return c.redirect("/new?error=Repository+already+exists");
  }

  const diskPath = await initBareRepo(user.username, name);

  const [newRepo] = await db
    .insert(repositories)
    .values({
      name,
      ownerId: user.id,
      description: description || null,
      isPrivate,
      diskPath,
    })
    .returning();

  if (newRepo) {
    const { bootstrapRepository } = await import("../lib/repo-bootstrap");
    await bootstrapRepository({
      repositoryId: newRepo.id,
      ownerUserId: user.id,
      defaultBranch: "main",
    });
  }

  return c.redirect(`/${user.username}/${name}`);
});

// User profile
web.get("/:owner", async (c) => {
  const { owner: ownerName } = c.req.param();
  const user = c.get("user");

  // Avoid clashing with fixed routes
  if (
    ["login", "register", "logout", "new", "settings", "api"].includes(
      ownerName
    )
  ) {
    return c.notFound();
  }

  let ownerUser;
  try {
    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    ownerUser = found;
  } catch {
    // DB not available — check if repos exist on disk
    ownerUser = null;
  }

  // Even without DB, show repos if they exist on disk
  let repos: any[] = [];
  if (ownerUser) {
    const allRepos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.ownerId, ownerUser.id))
      .orderBy(desc(repositories.updatedAt));

    // Show public repos to everyone, private only to owner
    repos =
      user?.id === ownerUser.id
        ? allRepos
        : allRepos.filter((r) => !r.isPrivate);
  }

  // Block J4 — follow counts + viewer's follow state
  let followState = {
    followers: 0,
    following: 0,
    viewerFollows: false,
  };
  if (ownerUser) {
    try {
      const { followCounts, isFollowing } = await import("../lib/follows");
      const counts = await followCounts(ownerUser.id);
      followState.followers = counts.followers;
      followState.following = counts.following;
      if (user && user.id !== ownerUser.id) {
        followState.viewerFollows = await isFollowing(user.id, ownerUser.id);
      }
    } catch {
      // DB hiccup — fall back to zeros.
    }
  }
  const canFollow = !!user && !!ownerUser && user.id !== ownerUser.id;

  // Block J5 — profile README. Render owner/owner repo's README on the
  // profile page (GitHub convention). Tries "<user>/<user>" first, falling
  // back to "<user>/.github" for org-style profile repos.
  let profileReadmeHtml: string | null = null;
  try {
    const candidates = [ownerName, ".github"];
    for (const rname of candidates) {
      if (await repoExists(ownerName, rname)) {
        const ref = (await getDefaultBranch(ownerName, rname)) || "main";
        const md = await getReadme(ownerName, rname, ref);
        if (md) {
          profileReadmeHtml = renderMarkdown(md);
          break;
        }
      }
    }
  } catch {
    profileReadmeHtml = null;
  }

  const displayName = ownerUser?.displayName || ownerName;
  const memberSince = ownerUser?.createdAt
    ? new Date(ownerUser.createdAt as unknown as string | number | Date)
    : null;

  return c.html(
    <Layout title={ownerName} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <div class="profile-hero">
        <div class="profile-hero-orb-wrap" aria-hidden="true">
          <div class="profile-hero-orb" />
        </div>
        <div class="profile-hero-inner">
          <div class="profile-hero-avatar" aria-hidden="true">
            {displayName[0].toUpperCase()}
          </div>
          <div class="profile-hero-text">
            <div class="profile-eyebrow">
              <strong>Developer</strong>
              {memberSince && !Number.isNaN(memberSince.getTime()) && (
                <>
                  {" "}· Joined{" "}
                  {memberSince.toLocaleDateString("en-US", {
                    month: "short",
                    year: "numeric",
                  })}
                </>
              )}
            </div>
            <h1 class="profile-name">
              <span class="gradient-text">{displayName}</span>
            </h1>
            <div class="profile-handle">@{ownerName}</div>
            {ownerUser?.bio && <p class="profile-bio">{ownerUser.bio}</p>}
            <div class="profile-meta">
              <a href={`/${ownerName}/followers`} class="profile-meta-link">
                <strong>{followState.followers}</strong> follower
                {followState.followers === 1 ? "" : "s"}
              </a>
              <a href={`/${ownerName}/following`} class="profile-meta-link">
                <strong>{followState.following}</strong> following
              </a>
              <a href={`/${ownerName}`} class="profile-meta-link">
                <strong>{repos.length}</strong> repo
                {repos.length === 1 ? "" : "s"}
              </a>
              {canFollow && (
                <form
                  method="post"
                  action={`/${ownerName}/${
                    followState.viewerFollows ? "unfollow" : "follow"
                  }`}
                  class="profile-follow-form"
                >
                  <button
                    type="submit"
                    class={`btn ${
                      followState.viewerFollows ? "" : "btn-primary"
                    } btn-sm`}
                  >
                    {followState.viewerFollows ? "Unfollow" : "Follow"}
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
      {profileReadmeHtml && (
        <div class="profile-readme">
          <div class="profile-readme-head">
            <span class="profile-readme-icon">{"☰"}</span>
            <span>{ownerName}/{ownerName} README.md</span>
          </div>
          <div
            class="markdown-body profile-readme-body"
            dangerouslySetInnerHTML={{ __html: profileReadmeHtml }}
          />
        </div>
      )}
      <div class="profile-section-head">
        <h2 class="profile-section-title">Repositories</h2>
        <span class="profile-section-count">{repos.length}</span>
      </div>
      {repos.length === 0 ? (
        <div class="profile-empty">
          <p class="profile-empty-text">
            No repositories yet
            {user?.id === ownerUser?.id ? "." : ` — ${ownerName} is just getting started.`}
          </p>
          {user?.id === ownerUser?.id && (
            <a href="/new" class="btn btn-primary btn-sm">
              + Create your first
            </a>
          )}
        </div>
      ) : (
        <div class="card-grid">
          {repos.map((repo) => (
            <RepoCard repo={repo} ownerName={ownerName} />
          ))}
        </div>
      )}
    </Layout>
  );
});

// Star/unstar a repo
web.post("/:owner/:repo/star", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;

  try {
    const [ownerUser] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerUser) return c.redirect(`/${ownerName}/${repoName}`);

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerUser.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.redirect(`/${ownerName}/${repoName}`);

    // Toggle star
    const [existing] = await db
      .select()
      .from(stars)
      .where(
        and(eq(stars.userId, user.id), eq(stars.repositoryId, repo.id))
      )
      .limit(1);

    if (existing) {
      await db.delete(stars).where(eq(stars.id, existing.id));
      await db
        .update(repositories)
        .set({ starCount: Math.max(0, repo.starCount - 1) })
        .where(eq(repositories.id, repo.id));
    } else {
      await db.insert(stars).values({
        userId: user.id,
        repositoryId: repo.id,
      });
      await db
        .update(repositories)
        .set({ starCount: repo.starCount + 1 })
        .where(eq(repositories.id, repo.id));
    }
  } catch {
    // DB error — ignore
  }

  return c.redirect(`/${ownerName}/${repoName}`);
});

// Repository overview — file tree at HEAD
web.get("/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  // ── Loading skeleton (flag-gated) ──
  // Renders an SSR'd shell with file-tree + README placeholders when
  // `?skeleton=1` is set. Lets the user see the page structure before
  // git ops finish. Behind a flag for now so we never flash before the
  // real content lands.
  if (c.req.query("skeleton") === "1") {
    return c.html(
      <Layout title={`${owner}/${repo}`} user={user}>
        <style
          dangerouslySetInnerHTML={{
            __html: `
              .repo-skel { background: linear-gradient(90deg, var(--bg-secondary) 0%, var(--bg-elevated) 50%, var(--bg-secondary) 100%); background-size: 200% 100%; animation: repoSkelShimmer 1.4s infinite; border-radius: 6px; display: block; }
              @keyframes repoSkelShimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
              @media (prefers-reduced-motion: reduce) { .repo-skel { animation: none; } }
              .repo-skel-hero { height: 132px; border-radius: 16px; margin-bottom: var(--space-4); }
              .repo-skel-nav { height: 36px; border-radius: 8px; margin-bottom: var(--space-4); }
              .repo-skel-grid { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: var(--space-5); align-items: start; }
              @media (max-width: 960px) { .repo-skel-grid { grid-template-columns: minmax(0, 1fr); } }
              .repo-skel-branch { height: 32px; width: 200px; border-radius: 8px; margin-bottom: 12px; }
              .repo-skel-tree { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--space-5); }
              .repo-skel-tree-row { height: 36px; border-radius: 8px; }
              .repo-skel-readme { height: 320px; border-radius: 12px; }
              .repo-skel-side { display: flex; flex-direction: column; gap: var(--space-4); }
              .repo-skel-side-card { height: 180px; border-radius: 12px; }
            `,
          }}
        />
        <div class="repo-skel repo-skel-hero" aria-hidden="true" />
        <div class="repo-skel repo-skel-nav" aria-hidden="true" />
        <div class="repo-skel-grid" aria-hidden="true">
          <div>
            <div class="repo-skel repo-skel-branch" />
            <div class="repo-skel-tree">
              {Array.from({ length: 8 }).map(() => (
                <div class="repo-skel repo-skel-tree-row" />
              ))}
            </div>
            <div class="repo-skel repo-skel-readme" />
          </div>
          <aside class="repo-skel-side">
            <div class="repo-skel repo-skel-side-card" />
            <div class="repo-skel repo-skel-side-card" />
          </aside>
        </div>
        <span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0" role="status" aria-live="polite">
          Loading {owner}/{repo}…
        </span>
      </Layout>
    );
  }

  // F1 — fire-and-forget traffic tracking. Never awaits; never throws.
  trackByName(owner, repo, "view", {
    userId: user?.id || null,
    path: `/${owner}/${repo}`,
    ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
    userAgent: c.req.header("user-agent") || null,
    referer: c.req.header("referer") || null,
  }).catch((err) => {
    console.warn(
      `[web] view tracking failed for ${owner}/${repo}:`,
      err instanceof Error ? err.message : err
    );
  });

  if (!(await repoExists(owner, repo))) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
          <p>
            {owner}/{repo} does not exist.
          </p>
        </div>
      </Layout>,
      404
    );
  }

  // Parallelize all independent operations
  const [defaultBranch, branches] = await Promise.all([
    getDefaultBranch(owner, repo).then((b) => b || "main"),
    listBranches(owner, repo),
  ]);
  const [tree, starInfo] = await Promise.all([
    getTree(owner, repo, defaultBranch),
    // Star info fetched in parallel with tree
    (async () => {
      try {
        const [ownerUser] = await db
          .select()
          .from(users)
          .where(eq(users.username, owner))
          .limit(1);
        if (!ownerUser)
          return {
            starCount: 0,
            starred: false,
            archived: false,
            isTemplate: false,
            forkCount: 0,
            description: null as string | null,
            pushedAt: null as Date | null,
            createdAt: null as Date | null,
            repoId: null as string | null,
            repoOwnerId: null as string | null,
          };
        const [repoRow] = await db
          .select()
          .from(repositories)
          .where(
            and(
              eq(repositories.ownerId, ownerUser.id),
              eq(repositories.name, repo)
            )
          )
          .limit(1);
        if (!repoRow)
          return {
            starCount: 0,
            starred: false,
            archived: false,
            isTemplate: false,
            forkCount: 0,
            description: null as string | null,
            pushedAt: null as Date | null,
            createdAt: null as Date | null,
            repoId: null as string | null,
            repoOwnerId: null as string | null,
          };
        let starred = false;
        if (user) {
          const [star] = await db
            .select()
            .from(stars)
            .where(
              and(
                eq(stars.userId, user.id),
                eq(stars.repositoryId, repoRow.id)
              )
            )
            .limit(1);
          starred = !!star;
        }
        return {
          starCount: repoRow.starCount,
          starred,
          archived: repoRow.isArchived,
          isTemplate: repoRow.isTemplate,
          forkCount: repoRow.forkCount,
          description: repoRow.description as string | null,
          pushedAt: (repoRow.pushedAt as Date | null) ?? null,
          createdAt: (repoRow.createdAt as Date | null) ?? null,
          repoId: repoRow.id as string,
          repoOwnerId: repoRow.ownerId as string,
        };
      } catch {
        return {
          starCount: 0,
          starred: false,
          archived: false,
          isTemplate: false,
          forkCount: 0,
          description: null as string | null,
          pushedAt: null as Date | null,
          createdAt: null as Date | null,
          repoId: null as string | null,
          repoOwnerId: null as string | null,
        };
      }
    })(),
  ]);
  const {
    starCount,
    starred,
    archived,
    isTemplate,
    forkCount,
    description,
    pushedAt,
    createdAt,
    repoId,
    repoOwnerId,
  } = starInfo;

  // Pending-comments banner data (lazy + best-effort). Only the repo
  // owner sees the banner, so non-owner views skip the DB hit entirely.
  let repoHomePendingCount = 0;
  if (user && repoOwnerId && user.id === repoOwnerId && repoId) {
    try {
      const { countPendingForRepo } = await import(
        "../lib/comment-moderation"
      );
      repoHomePendingCount = await countPendingForRepo(repoId);
    } catch {
      /* swallow */
    }
  }

  // Repo-home polish — shared style block (Block 2.A — parallel session 2.A).
  // Scoped via .repo-home-* class prefix to prevent bleed into other surfaces.
  const repoHomeCss = `
    .repo-home-hero {
      position: relative;
      margin-bottom: var(--space-5);
      padding: var(--space-5) var(--space-6);
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
    }
    .repo-home-hero::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
      opacity: 0.7;
      pointer-events: none;
    }
    .repo-home-hero-orb-wrap {
      position: absolute;
      inset: -25% -10% auto auto;
      width: 360px;
      height: 360px;
      pointer-events: none;
      z-index: 0;
    }
    .repo-home-hero-orb {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
      filter: blur(80px);
      opacity: 0.7;
      animation: repoHomeOrb 14s ease-in-out infinite;
    }
    @keyframes repoHomeOrb {
      0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
      50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.8; }
    }
    @media (prefers-reduced-motion: reduce) {
      .repo-home-hero-orb { animation: none; }
    }
    .repo-home-hero-inner {
      position: relative;
      z-index: 1;
    }
    .repo-home-hero .repo-header { margin-bottom: var(--space-3); }
    .repo-home-eyebrow {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-muted);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: var(--space-2);
    }
    .repo-home-eyebrow strong { color: var(--accent); font-weight: 600; }
    .repo-home-description {
      font-size: 15px;
      line-height: 1.55;
      color: var(--text);
      margin: 0;
      max-width: 720px;
    }
    .repo-home-description-empty {
      font-size: 14px;
      color: var(--text-muted);
      font-style: italic;
      margin: 0;
    }
    .repo-home-stat-row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
      margin-top: var(--space-3);
      font-size: 13px;
      color: var(--text-muted);
    }
    .repo-home-stat {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .repo-home-stat strong {
      color: var(--text-strong);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .repo-home-stat .repo-home-stat-icon {
      color: var(--text-faint);
      font-size: 14px;
      line-height: 1;
    }
    .repo-home-stat a {
      color: var(--text-muted);
      transition: color var(--t-fast) var(--ease);
    }
    .repo-home-stat a:hover { color: var(--accent); text-decoration: none; }

    /* Two-column layout: file tree + sidebar */
    .repo-home-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: var(--space-5);
      align-items: start;
    }
    @media (max-width: 960px) {
      .repo-home-grid { grid-template-columns: minmax(0, 1fr); }
    }
    .repo-home-main { min-width: 0; }

    /* Sidebar card */
    .repo-home-side {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .repo-home-side-card {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: var(--space-4);
    }
    .repo-home-side-title {
      font-size: 11px;
      font-family: var(--font-mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin: 0 0 var(--space-3);
      font-weight: 600;
    }
    .repo-home-side-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-2);
      font-size: 13px;
      padding: 6px 0;
      border-top: 1px solid var(--border);
    }
    .repo-home-side-row:first-of-type { border-top: 0; padding-top: 0; }
    .repo-home-side-key {
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .repo-home-side-val {
      color: var(--text-strong);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      max-width: 60%;
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .repo-home-side-val a { color: var(--text-strong); }
    .repo-home-side-val a:hover { color: var(--accent); text-decoration: none; }

    /* Clone / Code tabs */
    .repo-home-clone {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .repo-home-clone-tabs {
      display: flex;
      gap: 0;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 0 var(--space-2);
    }
    .repo-home-clone-tab {
      appearance: none;
      background: transparent;
      border: 0;
      border-bottom: 2px solid transparent;
      padding: 9px 12px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
      font-family: inherit;
      margin-bottom: -1px;
    }
    .repo-home-clone-tab:hover { color: var(--text-strong); }
    .repo-home-clone-tab[aria-selected="true"] {
      color: var(--text-strong);
      border-bottom-color: var(--accent);
    }
    .repo-home-clone-body {
      padding: var(--space-3);
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .repo-home-clone-input {
      flex: 1;
      min-width: 0;
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--text-strong);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .repo-home-clone-copy {
      appearance: none;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-strong);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
      font-family: inherit;
    }
    .repo-home-clone-copy:hover { background: var(--bg-hover); border-color: var(--border-strong, var(--border)); }
    .repo-home-clone-pane { display: none; }
    .repo-home-clone-pane[data-active="true"] { display: flex; }

    /* README card */
    .repo-home-readme {
      margin-top: var(--space-5);
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .repo-home-readme-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      color: var(--text-muted);
    }
    .repo-home-readme-head .repo-home-readme-icon {
      color: var(--accent);
      font-size: 14px;
    }
    .repo-home-readme-body {
      padding: var(--space-5) var(--space-6);
    }

    /* Empty-state CTA */
    .repo-home-empty {
      position: relative;
      margin-top: var(--space-4);
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: var(--space-6);
      overflow: hidden;
    }
    .repo-home-empty::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
      opacity: 0.7;
      pointer-events: none;
    }
    .repo-home-empty-eyebrow {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--accent);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: var(--space-2);
      font-weight: 600;
    }
    .repo-home-empty-title {
      font-family: var(--font-display);
      font-weight: 800;
      letter-spacing: -0.025em;
      font-size: clamp(22px, 3vw, 30px);
      line-height: 1.1;
      margin: 0 0 var(--space-2);
      color: var(--text-strong);
    }
    .repo-home-empty-sub {
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.55;
      max-width: 640px;
      margin: 0 0 var(--space-4);
    }
    .repo-home-empty-snippet {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: var(--space-3) var(--space-4);
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.7;
      color: var(--text-strong);
      overflow-x: auto;
      white-space: pre;
      margin: 0;
    }
    .repo-home-empty-snippet .repo-home-cmt { color: var(--text-faint); }
    .repo-home-empty-snippet .repo-home-cmd { color: var(--accent); }

    @media (max-width: 720px) {
      .repo-home-hero { padding: var(--space-4) var(--space-4); }
      .repo-home-clone-body { flex-direction: column; align-items: stretch; }
      .repo-home-clone-copy { width: 100%; }
      .repo-home-stat-row { gap: var(--space-2) var(--space-3); font-size: 12.5px; }
      .repo-home-side-val { max-width: 55%; }
      .repo-home-clone-tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .repo-home-clone-tab { min-height: 44px; padding: 11px 14px; }
      .repo-home-side-card { padding: var(--space-3); }
    }
  `;
  const cloneHttpsUrl = `${config.appBaseUrl}/${owner}/${repo}.git`;
  // SSH URL — port-aware:
  //   Standard port 22  → git@host:owner/repo.git
  //   Non-standard port → ssh://git@host:PORT/owner/repo.git
  let cloneSshUrl = `git@gluecron.com:${owner}/${repo}.git`;
  try {
    const host = new URL(config.appBaseUrl).hostname;
    const sshHost = (host && host !== "localhost" && host !== "127.0.0.1")
      ? host
      : "localhost";
    const sshPort = config.sshPort;
    if (sshPort === 22) {
      cloneSshUrl = `git@${sshHost}:${owner}/${repo}.git`;
    } else {
      cloneSshUrl = `ssh://git@${sshHost}:${sshPort}/${owner}/${repo}.git`;
    }
  } catch {
    // Fall through to default.
  }
  const cloneCliCmd = `gluecron clone ${owner}/${repo}`;
  const formatRelative = (date: Date | null): string => {
    if (!date) return "never";
    const ms = Date.now() - date.getTime();
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.round(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    const y = Math.round(d / 365);
    return `${y}y ago`;
  };

  if (tree.length === 0) {
    return c.html(
      <Layout title={`${owner}/${repo}`} user={user}>
        <style dangerouslySetInnerHTML={{ __html: repoHomeCss }} />
        <div class="repo-home-hero">
          <div class="repo-home-hero-orb-wrap" aria-hidden="true">
            <div class="repo-home-hero-orb" />
          </div>
          <div class="repo-home-hero-inner">
            <div class="repo-home-eyebrow">
              <strong>Repository</strong> · {owner}
            </div>
            <RepoHeader
              owner={owner}
              repo={repo}
              starCount={starCount}
              starred={starred}
              forkCount={forkCount}
              currentUser={user?.username}
              archived={archived}
              isTemplate={isTemplate}
            />
            {description ? (
              <p class="repo-home-description">{description}</p>
            ) : (
              <p class="repo-home-description-empty">
                No description yet — push a README to tell the world what this
                ships.
              </p>
            )}
          </div>
        </div>
        <RepoNav owner={owner} repo={repo} active="code" />
        <div class="repo-home-empty">
          <div class="repo-home-empty-eyebrow">Getting started</div>
          <h2 class="repo-home-empty-title">
            Push your first commit to{" "}
            <span class="gradient-text">{repo}</span>.
          </h2>
          <p class="repo-home-empty-sub">
            This repository is empty. Paste the snippet below in an existing
            project directory to wire it up to Gluecron — your push triggers
            gate checks and AI review automatically.
          </p>
          <pre class="repo-home-empty-snippet">
            <span class="repo-home-cmt">
              # from an existing project directory
            </span>
            {"\n"}
            <span class="repo-home-cmd">git remote add</span>
            {` origin ${cloneHttpsUrl}`}
            {"\n"}
            <span class="repo-home-cmd">git branch</span>
            {` -M main`}
            {"\n"}
            <span class="repo-home-cmd">git push</span>
            {` -u origin main`}
          </pre>
        </div>
      </Layout>
    );
  }

  const readme = await getReadme(owner, repo, defaultBranch);

  // Sidebar facts — derived from data we already have.
  const fileCount = tree.filter((e: any) => e.type !== "tree").length;
  const dirCount = tree.filter((e: any) => e.type === "tree").length;

  return c.html(
    <Layout title={`${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: repoHomeCss }} />
      <div class="repo-home-hero">
        <div class="repo-home-hero-orb-wrap" aria-hidden="true">
          <div class="repo-home-hero-orb" />
        </div>
        <div class="repo-home-hero-inner">
          <div class="repo-home-eyebrow">
            <strong>Repository</strong> · {owner}
          </div>
          <RepoHeader
            owner={owner}
            repo={repo}
            starCount={starCount}
            starred={starred}
            forkCount={forkCount}
            currentUser={user?.username}
            archived={archived}
            isTemplate={isTemplate}
          />
          {description ? (
            <p class="repo-home-description">{description}</p>
          ) : (
            <p class="repo-home-description-empty">
              No description yet.
            </p>
          )}
          <div class="repo-home-stat-row" aria-label="Repository stats">
            <span class="repo-home-stat" title="Default branch">
              <span class="repo-home-stat-icon">{"⎇"}</span>
              <strong>{defaultBranch}</strong>
            </span>
            <a
              href={`/${owner}/${repo}/commits/${defaultBranch}`}
              class="repo-home-stat"
              title="Browse all branches"
            >
              <span class="repo-home-stat-icon">{"⊢"}</span>
              <strong>{branches.length}</strong>{" "}
              branch{branches.length === 1 ? "" : "es"}
            </a>
            <span class="repo-home-stat" title="Top-level entries">
              <span class="repo-home-stat-icon">{"■"}</span>
              <strong>{fileCount}</strong> file{fileCount === 1 ? "" : "s"}
              {dirCount > 0 && (
                <>
                  {" · "}
                  <strong>{dirCount}</strong> dir{dirCount === 1 ? "" : "s"}
                </>
              )}
            </span>
            {pushedAt && (
              <span class="repo-home-stat" title={`Last push: ${pushedAt.toISOString()}`}>
                <span class="repo-home-stat-icon">{"↻"}</span>
                Updated <strong>{formatRelative(pushedAt)}</strong>
              </span>
            )}
          </div>
        </div>
      </div>
      {isTemplate && user && user.username !== owner && (
        <div
          class="panel"
          style="margin-bottom:var(--space-4);padding:var(--space-3);display:flex;align-items:center;justify-content:space-between;gap:var(--space-3)"
        >
          <div style="font-size:13px">
            <strong>Template repository.</strong> Create a new repository from
            this template's files.
          </div>
          <form
            method="post"
            action={`/${owner}/${repo}/use-template`}
            style="display:flex;gap:var(--space-2);align-items:center"
          >
            <input
              type="text"
              name="name"
              placeholder="new-repo-name"
              required
              aria-label="New repository name"
              style="width:200px"
            />
            <button type="submit" class="btn btn-primary">
              Use this template
            </button>
          </form>
        </div>
      )}
      <RepoNav owner={owner} repo={repo} active="code" />
      <RepoHomePendingBanner
        owner={owner}
        repo={repo}
        count={repoHomePendingCount}
      />
      {/* ─── Per-repo AI surfaces — RepoNav is locked, so the discovery
          row sits just below the nav as a slim CTA strip. Scoped under
          `.repo-ai-cta-` so the styles can't bleed onto other pages. ─── */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .repo-ai-cta-row {
              display: flex;
              flex-wrap: wrap;
              gap: 8px;
              margin: 12px 0 18px;
              padding: 10px 14px;
              background: linear-gradient(135deg, rgba(140,109,255,0.06), rgba(54,197,214,0.04));
              border: 1px solid var(--border);
              border-radius: 10px;
              position: relative;
              overflow: hidden;
            }
            .repo-ai-cta-row::before {
              content: '';
              position: absolute;
              top: 0; left: 0; right: 0;
              height: 1px;
              background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 30%, rgba(54,197,214,0.45) 70%, transparent 100%);
              opacity: 0.7;
              pointer-events: none;
            }
            .repo-ai-cta-label {
              font-size: 11px;
              font-weight: 600;
              letter-spacing: 0.06em;
              text-transform: uppercase;
              color: var(--accent);
              align-self: center;
              padding-right: 8px;
              border-right: 1px solid var(--border);
              margin-right: 4px;
            }
            .repo-ai-cta {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              padding: 5px 10px;
              font-size: 12.5px;
              font-weight: 500;
              color: var(--text);
              background: var(--bg);
              border: 1px solid var(--border);
              border-radius: 7px;
              text-decoration: none;
              transition: border-color 140ms ease, background 140ms ease, color 140ms ease;
            }
            .repo-ai-cta:hover {
              border-color: rgba(140,109,255,0.45);
              color: var(--text-strong);
              background: rgba(140,109,255,0.06);
              text-decoration: none;
            }
            .repo-ai-cta-icon {
              opacity: 0.75;
              font-size: 12px;
            }
            @media (max-width: 640px) {
              .repo-ai-cta-row { flex-direction: column; align-items: stretch; }
              .repo-ai-cta-label { border-right: 0; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-right: 0; }
            }
          `,
        }}
      />
      <nav class="repo-ai-cta-row" aria-label="AI surfaces for this repository">
        <span class="repo-ai-cta-label">AI surfaces</span>
        <a class="repo-ai-cta" href={`/${owner}/${repo}/chat`} title="Rubber-duck chat grounded in this repo">
          <span class="repo-ai-cta-icon" aria-hidden="true">{"\u{1F4AC}"}</span>
          Chat
        </a>
        <a class="repo-ai-cta" href={`/${owner}/${repo}/previews`} title="Ephemeral preview URLs per branch">
          <span class="repo-ai-cta-icon" aria-hidden="true">{"\u{1F30D}"}</span>
          Previews
        </a>
        <a class="repo-ai-cta" href={`/${owner}/${repo}/migrations/propose`} title="AI proposes the Drizzle migration for a schema change">
          <span class="repo-ai-cta-icon" aria-hidden="true">{"⛁"}</span>
          Migrations
        </a>
        <a class="repo-ai-cta" href={`/${owner}/${repo}/semantic-search`} title="Embedding-backed code search">
          <span class="repo-ai-cta-icon" aria-hidden="true">{"✨"}</span>
          Semantic search
        </a>
        <a class="repo-ai-cta" href={`/${owner}/${repo}/releases/new`} title="Draft release notes with AI">
          <span class="repo-ai-cta-icon" aria-hidden="true">{"\u{1F3F7}"}</span>
          AI release notes
        </a>
        <a class="repo-ai-cta" href={`/${owner}/${repo}/dev`} title="Open a hosted VS Code dev environment in the browser">
          <span class="repo-ai-cta-icon" aria-hidden="true">{"💻"}</span>
          Dev environment
        </a>
      </nav>
      <div class="repo-home-grid">
        <div class="repo-home-main">
          <BranchSwitcher
            owner={owner}
            repo={repo}
            currentRef={defaultBranch}
            branches={branches}
            pathType="tree"
          />
          <FileTable
            entries={tree}
            owner={owner}
            repo={repo}
            ref={defaultBranch}
            path=""
          />
          {readme && (() => {
            const readmeHtml = renderMarkdown(readme);
            return (
              <div class="repo-home-readme">
                <div class="repo-home-readme-head">
                  <span class="repo-home-readme-icon">{"☰"}</span>
                  <span>README.md</span>
                </div>
                <style>{markdownCss}</style>
                <div class="markdown-body repo-home-readme-body">
                  {html([readmeHtml] as unknown as TemplateStringsArray)}
                </div>
              </div>
            );
          })()}
        </div>
        <aside class="repo-home-side" aria-label="Repository details">
          <div class="repo-home-clone">
            <div class="repo-home-clone-tabs" role="tablist" aria-label="Clone protocol">
              <button
                type="button"
                class="repo-home-clone-tab"
                role="tab"
                aria-selected="true"
                data-pane="https"
                data-repo-home-clone-tab
              >
                HTTPS
              </button>
              <button
                type="button"
                class="repo-home-clone-tab"
                role="tab"
                aria-selected="false"
                data-pane="ssh"
                data-repo-home-clone-tab
              >
                SSH
              </button>
              <button
                type="button"
                class="repo-home-clone-tab"
                role="tab"
                aria-selected="false"
                data-pane="cli"
                data-repo-home-clone-tab
              >
                CLI
              </button>
            </div>
            <div
              class="repo-home-clone-pane"
              data-pane="https"
              data-active="true"
              role="tabpanel"
            >
              <div class="repo-home-clone-body">
                <input
                  class="repo-home-clone-input"
                  type="text"
                  value={cloneHttpsUrl}
                  readonly
                  aria-label="HTTPS clone URL"
                  data-repo-home-clone-input
                />
                <button
                  type="button"
                  class="repo-home-clone-copy"
                  data-repo-home-copy={cloneHttpsUrl}
                >
                  Copy
                </button>
              </div>
            </div>
            <div
              class="repo-home-clone-pane"
              data-pane="ssh"
              data-active="false"
              role="tabpanel"
            >
              <div class="repo-home-clone-body">
                <input
                  class="repo-home-clone-input"
                  type="text"
                  value={cloneSshUrl}
                  readonly
                  aria-label="SSH clone URL"
                  data-repo-home-clone-input
                />
                <button
                  type="button"
                  class="repo-home-clone-copy"
                  data-repo-home-copy={cloneSshUrl}
                >
                  Copy
                </button>
              </div>
            </div>
            <div
              class="repo-home-clone-pane"
              data-pane="cli"
              data-active="false"
              role="tabpanel"
            >
              <div class="repo-home-clone-body">
                <input
                  class="repo-home-clone-input"
                  type="text"
                  value={cloneCliCmd}
                  readonly
                  aria-label="Gluecron CLI clone command"
                  data-repo-home-clone-input
                />
                <button
                  type="button"
                  class="repo-home-clone-copy"
                  data-repo-home-copy={cloneCliCmd}
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
          <div class="repo-home-side-card">
            <h3 class="repo-home-side-title">About</h3>
            <div class="repo-home-side-row">
              <span class="repo-home-side-key">Default branch</span>
              <span class="repo-home-side-val">{defaultBranch}</span>
            </div>
            <div class="repo-home-side-row">
              <span class="repo-home-side-key">Branches</span>
              <span class="repo-home-side-val">
                <a href={`/${owner}/${repo}/commits/${defaultBranch}`}>
                  {branches.length}
                </a>
              </span>
            </div>
            <div class="repo-home-side-row">
              <span class="repo-home-side-key">Stars</span>
              <span class="repo-home-side-val">{starCount}</span>
            </div>
            <div class="repo-home-side-row">
              <span class="repo-home-side-key">Forks</span>
              <span class="repo-home-side-val">{forkCount}</span>
            </div>
            {pushedAt && (
              <div class="repo-home-side-row">
                <span class="repo-home-side-key">Last push</span>
                <span class="repo-home-side-val">
                  {formatRelative(pushedAt)}
                </span>
              </div>
            )}
            {createdAt && (
              <div class="repo-home-side-row">
                <span class="repo-home-side-key">Created</span>
                <span class="repo-home-side-val">
                  {formatRelative(createdAt)}
                </span>
              </div>
            )}
            {(archived || isTemplate) && (
              <div class="repo-home-side-row">
                <span class="repo-home-side-key">State</span>
                <span class="repo-home-side-val">
                  {archived ? "Archived" : "Template"}
                </span>
              </div>
            )}
          </div>
        </aside>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function(){
              var tabs = document.querySelectorAll('[data-repo-home-clone-tab]');
              tabs.forEach(function(tab){
                tab.addEventListener('click', function(){
                  var target = tab.getAttribute('data-pane');
                  tabs.forEach(function(t){
                    t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
                  });
                  var panes = document.querySelectorAll('.repo-home-clone-pane');
                  panes.forEach(function(p){
                    p.setAttribute('data-active', p.getAttribute('data-pane') === target ? 'true' : 'false');
                  });
                });
              });
              var copyBtns = document.querySelectorAll('[data-repo-home-copy]');
              copyBtns.forEach(function(btn){
                btn.addEventListener('click', function(){
                  var text = btn.getAttribute('data-repo-home-copy') || '';
                  var done = function(){
                    var prev = btn.textContent;
                    btn.textContent = 'Copied';
                    setTimeout(function(){ btn.textContent = prev; }, 1200);
                  };
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done, done);
                  } else {
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand('copy'); } catch (e) {}
                    document.body.removeChild(ta);
                    done();
                  }
                });
              });
            })();
          `,
        }}
      />
    </Layout>
  );
});

// Browse tree at ref/path
web.get("/:owner/:repo/tree/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const refAndPath = c.req.param("ref");

  const branches = await listBranches(owner, repo);
  let ref = "";
  let treePath = "";

  for (const branch of branches) {
    if (refAndPath === branch || refAndPath.startsWith(branch + "/")) {
      ref = branch;
      treePath = refAndPath.slice(branch.length + 1);
      break;
    }
  }

  if (!ref) {
    const slashIdx = refAndPath.indexOf("/");
    if (slashIdx === -1) {
      ref = refAndPath;
    } else {
      ref = refAndPath.slice(0, slashIdx);
      treePath = refAndPath.slice(slashIdx + 1);
    }
  }

  const tree = await getTree(owner, repo, ref, treePath);
  const fileCount = tree.filter((e: any) => e.type !== "tree").length;
  const dirCount = tree.filter((e: any) => e.type === "tree").length;

  return c.html(
    <Layout title={`${treePath || "/"} — ${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="tree-header">
        <div class="tree-header-row">
          <BranchSwitcher
            owner={owner}
            repo={repo}
            currentRef={ref}
            branches={branches}
            pathType="tree"
            subPath={treePath}
          />
          <div class="tree-header-stats">
            <span class="tree-stat" title="Entries in this directory">
              <strong>{fileCount}</strong> file{fileCount === 1 ? "" : "s"}
              {dirCount > 0 && (
                <>
                  {" · "}
                  <strong>{dirCount}</strong> dir{dirCount === 1 ? "" : "s"}
                </>
              )}
            </span>
            <a
              href={`/${owner}/${repo}/search`}
              class="tree-stat tree-stat-link"
              title="Search code in this repository"
            >
              {"⌕"} Search
            </a>
          </div>
        </div>
        <div class="tree-breadcrumb-row">
          <Breadcrumb owner={owner} repo={repo} ref={ref} path={treePath} />
        </div>
      </div>
      <FileTable
        entries={tree}
        owner={owner}
        repo={repo}
        ref={ref}
        path={treePath}
      />
    </Layout>
  );
});

// View file blob with syntax highlighting
web.get("/:owner/:repo/blob/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const refAndPath = c.req.param("ref");

  const branches = await listBranches(owner, repo);
  let ref = "";
  let filePath = "";

  for (const branch of branches) {
    if (refAndPath.startsWith(branch + "/")) {
      ref = branch;
      filePath = refAndPath.slice(branch.length + 1);
      break;
    }
  }

  if (!ref) {
    const slashIdx = refAndPath.indexOf("/");
    if (slashIdx === -1) return c.text("Not found", 404);
    ref = refAndPath.slice(0, slashIdx);
    filePath = refAndPath.slice(slashIdx + 1);
  }

  const blob = await getBlob(owner, repo, ref, filePath);
  if (!blob) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>File not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const fileName = filePath.split("/").pop() || filePath;
  const lineCount = blob.isBinary
    ? 0
    : (blob.content.endsWith("\n")
        ? blob.content.split("\n").length - 1
        : blob.content.split("\n").length);
  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  return c.html(
    <Layout title={`${filePath} — ${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="blob-toolbar">
        <BranchSwitcher
          owner={owner}
          repo={repo}
          currentRef={ref}
          branches={branches}
          pathType="blob"
          subPath={filePath}
        />
        <div class="blob-breadcrumb">
          <Breadcrumb owner={owner} repo={repo} ref={ref} path={filePath} />
        </div>
      </div>
      <div class="blob-view blob-card">
        <div class="blob-header blob-header-polished">
          <div class="blob-header-meta">
            <span class="blob-header-icon" aria-hidden="true">
              {"📄"}
            </span>
            <span class="blob-header-name">{fileName}</span>
            <span class="blob-header-size">
              {formatBytes(blob.size)}
              {!blob.isBinary && (
                <>
                  {" · "}
                  {lineCount} line{lineCount === 1 ? "" : "s"}
                </>
              )}
            </span>
          </div>
          <div class="blob-header-actions">
            <a
              href={`/${owner}/${repo}/raw/${ref}/${filePath}`}
              class="blob-pill"
            >
              Raw
            </a>
            <a
              href={`/${owner}/${repo}/blame/${ref}/${filePath}`}
              class="blob-pill"
            >
              Blame
            </a>
            <a
              href={`/${owner}/${repo}/timeline/${ref}/${filePath}`}
              class="blob-pill"
            >
              History
            </a>
            {user && (
              <a
                href={`/${owner}/${repo}/edit/${ref}/${filePath}`}
                class="blob-pill blob-pill-accent"
              >
                Edit
              </a>
            )}
          </div>
        </div>
        {blob.isBinary ? (
          <div class="blob-binary">
            Binary file not shown.
          </div>
        ) : (() => {
          const { html: highlighted, language } = highlightCode(
            blob.content,
            fileName
          );
          if (language) {
            return (
              <HighlightedCode
                highlightedHtml={highlighted}
                lineCount={lineCount}
              />
            );
          }
          const lines = blob.content.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          return <PlainCode lines={lines} />;
        })()}
      </div>
    </Layout>
  );
});

// ─── Branches list ────────────────────────────────────────────────────────
// Lightweight `git for-each-ref` enrichment so each row shows last-commit
// author + relative time + ahead/behind vs the default branch. No DB. All
// data comes from git plumbing; failures degrade gracefully (counts omitted).
web.get("/:owner/:repo/branches", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();

  const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
  const branches = await listBranches(owner, repo);
  const repoDir = getRepoPath(owner, repo);

  type BranchRow = {
    name: string;
    isDefault: boolean;
    sha: string;
    subject: string;
    author: string;
    date: string;
    ahead: number;
    behind: number;
  };

  const runGit = async (args: string[]): Promise<string> => {
    try {
      const proc = Bun.spawn(["git", ...args], {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out;
    } catch {
      return "";
    }
  };

  const meta = await runGit([
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(committerdate:iso-strict)",
    "refs/heads/",
  ]);
  const metaByName: Record<
    string,
    { sha: string; subject: string; author: string; date: string }
  > = {};
  for (const line of meta.split("\n").filter(Boolean)) {
    const [name, sha, subject, author, date] = line.split("\0");
    metaByName[name] = { sha, subject, author, date };
  }

  const branchOrder = [...branches].sort((a, b) => {
    if (a === defaultBranch) return -1;
    if (b === defaultBranch) return 1;
    const aDate = metaByName[a]?.date || "";
    const bDate = metaByName[b]?.date || "";
    return bDate.localeCompare(aDate);
  });

  const rows: BranchRow[] = [];
  for (const name of branchOrder) {
    const m = metaByName[name] || { sha: "", subject: "", author: "", date: "" };
    let ahead = 0;
    let behind = 0;
    if (name !== defaultBranch && metaByName[defaultBranch]) {
      const out = await runGit([
        "rev-list",
        "--left-right",
        "--count",
        `${defaultBranch}...${name}`,
      ]);
      const parts = out.trim().split(/\s+/);
      if (parts.length === 2) {
        behind = parseInt(parts[0], 10) || 0;
        ahead = parseInt(parts[1], 10) || 0;
      }
    }
    rows.push({
      name,
      isDefault: name === defaultBranch,
      sha: m.sha,
      subject: m.subject,
      author: m.author,
      date: m.date,
      ahead,
      behind,
    });
  }

  const relative = (iso: string): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
    const dd = Math.floor(h / 24);
    if (dd < 30) return `${dd} day${dd === 1 ? "" : "s"} ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const success = c.req.query("success");
  const error = c.req.query("error");

  return c.html(
    <Layout title={`Branches — ${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div
        class="branches-wrap"
        style="max-width:1320px;margin:0 auto;padding:var(--space-5) var(--space-4) var(--space-8)"
      >
        <header class="branches-head" style="margin-bottom:var(--space-5)">
          <div
            class="branches-eyebrow"
            style="display:inline-flex;align-items:center;gap:8px;text-transform:uppercase;font-family:var(--font-mono);font-size:11px;letter-spacing:0.16em;color:var(--text-muted);font-weight:600;margin-bottom:10px"
          >
            <span
              class="branches-eyebrow-dot"
              aria-hidden="true"
              style="width:8px;height:8px;border-radius:9999px;background:linear-gradient(135deg,#8c6dff,#36c5d6);box-shadow:0 0 0 3px rgba(140,109,255,0.18)"
            />
            Repository · Branches
          </div>
          <h1
            class="branches-title"
            style="font-family:var(--font-display);font-size:clamp(24px,3.4vw,36px);font-weight:800;letter-spacing:-0.028em;line-height:1.1;margin:0 0 6px;color:var(--text-strong)"
          >
            <span class="gradient-text">{rows.length}</span>{" "}
            branch{rows.length === 1 ? "" : "es"}
          </h1>
          <p
            class="branches-sub"
            style="margin:0;font-size:14px;color:var(--text-muted);line-height:1.5;max-width:700px"
          >
            All work-in-progress lines for{" "}
            <code style="font-size:12.5px">{owner}/{repo}</code>. Ahead/behind
            counts are relative to{" "}
            <code style="font-size:12.5px">{defaultBranch}</code>.
          </p>
        </header>

        {success && (
          <div style="margin-bottom:var(--space-4);padding:10px 14px;border-radius:10px;font-size:13.5px;border:1px solid rgba(52,211,153,0.40);background:rgba(52,211,153,0.08);color:#bbf7d0">
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div style="margin-bottom:var(--space-4);padding:10px 14px;border-radius:10px;font-size:13.5px;border:1px solid rgba(248,113,113,0.40);background:rgba(248,113,113,0.08);color:#fecaca">
            {decodeURIComponent(error)}
          </div>
        )}

        {rows.length === 0 ? (
          <div class="commits-empty">
            <div class="commits-empty-orb" aria-hidden="true" />
            <div class="commits-empty-inner">
              <div class="commits-empty-icon" aria-hidden="true">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              </div>
              <h3 class="commits-empty-title">No branches yet</h3>
              <p class="commits-empty-sub">
                Push your first commit to create the default branch.
              </p>
            </div>
          </div>
        ) : (
          <div class="branches-list">
            {rows.map((r) => (
              <div class="branches-row">
                <div class="branches-row-icon" aria-hidden="true">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                </div>
                <div class="branches-row-main">
                  <div class="branches-row-name">
                    <a href={`/${owner}/${repo}/tree/${r.name}`}>{r.name}</a>
                    {r.isDefault && (
                      <span
                        class="branches-row-default"
                        title="Default branch"
                      >
                        Default
                      </span>
                    )}
                  </div>
                  <div class="branches-row-meta">
                    {r.subject ? (
                      <>
                        <strong>{r.author || "—"}</strong>
                        <span class="sep">·</span>
                        <span
                          title={r.date ? new Date(r.date).toISOString() : ""}
                        >
                          updated {relative(r.date)}
                        </span>
                        {r.sha && (
                          <>
                            <span class="sep">·</span>
                            <a
                              href={`/${owner}/${repo}/commit/${r.sha}`}
                              style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-muted);text-decoration:none"
                            >
                              {r.sha.slice(0, 7)}
                            </a>
                          </>
                        )}
                      </>
                    ) : (
                      <span>No commit metadata</span>
                    )}
                  </div>
                </div>
                <div class="branches-row-side">
                  {!r.isDefault && (r.ahead > 0 || r.behind > 0) && (
                    <span
                      class="branches-row-divergence"
                      title={`${r.ahead} ahead, ${r.behind} behind ${defaultBranch}`}
                    >
                      <span class="ahead">{r.ahead} ahead</span>
                      <span style="opacity:0.4">|</span>
                      <span class="behind">{r.behind} behind</span>
                    </span>
                  )}
                  <div class="branches-row-actions">
                    <a
                      href={`/${owner}/${repo}/commits/${r.name}`}
                      class="branches-btn"
                      title="View commits on this branch"
                    >
                      Commits
                    </a>
                    {!r.isDefault &&
                      user &&
                      user.username === owner && (
                        <form
                          method="post"
                          action={`/${owner}/${repo}/branches/${encodeURIComponent(r.name)}/delete`}
                          style="margin:0"
                          onsubmit={`return confirm('Delete branch \\'${r.name}\\'? This cannot be undone.')`}
                        >
                          <button
                            type="submit"
                            class="branches-btn branches-btn-danger"
                          >
                            Delete
                          </button>
                        </form>
                      )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
});

// Delete a branch (owner only). Uses `git branch -D` so we can drop refs
// that are not merged into the default branch — matches the explicit
// confirmation on the row's delete button.
web.post("/:owner/:repo/branches/:name/delete", requireAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const branchName = decodeURIComponent(c.req.param("name"));
  const user = c.get("user")!;

  // Owner-only check (mirrors collaborators.tsx pattern).
  const [ownerRow] = await db
    .select()
    .from(users)
    .where(eq(users.username, owner))
    .limit(1);
  if (!ownerRow || ownerRow.id !== user.id) {
    return c.redirect(
      `/${owner}/${repo}/branches?error=Only+the+owner+can+delete+branches`
    );
  }

  const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
  if (branchName === defaultBranch) {
    return c.redirect(
      `/${owner}/${repo}/branches?error=Cannot+delete+the+default+branch`
    );
  }

  const branches = await listBranches(owner, repo);
  if (!branches.includes(branchName)) {
    return c.redirect(
      `/${owner}/${repo}/branches?error=Branch+not+found`
    );
  }

  try {
    const repoDir = getRepoPath(owner, repo);
    const proc = Bun.spawn(["git", "branch", "-D", branchName], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      return c.redirect(
        `/${owner}/${repo}/branches?error=Delete+failed`
      );
    }
  } catch {
    return c.redirect(`/${owner}/${repo}/branches?error=Delete+failed`);
  }

  return c.redirect(`/${owner}/${repo}/branches?success=Branch+deleted`);
});

// ─── Tags list ────────────────────────────────────────────────────────────
// Pulls from `listTags` (sorted newest first). For each tag we look up an
// associated release row so the "View release" CTA can deep-link directly
// without making the user hunt for it.
web.get("/:owner/:repo/tags", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();

  const tags = await listTags(owner, repo);

  // Map tags -> releases. Best-effort; releases table may not exist in
  // every test setup, so any error falls through with an empty set.
  const tagsWithReleases = new Set<string>();
  try {
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, owner))
      .limit(1);
    if (ownerRow) {
      const [repoRow] = await db
        .select()
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, ownerRow.id),
            eq(repositories.name, repo)
          )
        )
        .limit(1);
      if (repoRow) {
        // Raw SQL so we don't need to import the releases schema here.
        const result = await db.execute(
          sql`SELECT tag FROM releases WHERE repository_id = ${repoRow.id}`
        );
        const rows: any[] = (result as any).rows || (result as any) || [];
        for (const row of rows) {
          const tag = row?.tag;
          if (typeof tag === "string") tagsWithReleases.add(tag);
        }
      }
    }
  } catch {
    // No releases table or DB error — leave set empty.
  }

  const relative = (iso: string): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
    const dd = Math.floor(h / 24);
    if (dd < 30) return `${dd} day${dd === 1 ? "" : "s"} ago`;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return c.html(
    <Layout title={`Tags — ${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div
        class="tags-wrap"
        style="max-width:1320px;margin:0 auto;padding:var(--space-5) var(--space-4) var(--space-8)"
      >
        <header class="tags-head" style="margin-bottom:var(--space-5)">
          <div
            class="tags-eyebrow"
            style="display:inline-flex;align-items:center;gap:8px;text-transform:uppercase;font-family:var(--font-mono);font-size:11px;letter-spacing:0.16em;color:var(--text-muted);font-weight:600;margin-bottom:10px"
          >
            <span
              class="tags-eyebrow-dot"
              aria-hidden="true"
              style="width:8px;height:8px;border-radius:9999px;background:linear-gradient(135deg,#8c6dff,#36c5d6);box-shadow:0 0 0 3px rgba(140,109,255,0.18)"
            />
            Repository · Tags
          </div>
          <h1
            class="tags-title"
            style="font-family:var(--font-display);font-size:clamp(24px,3.4vw,36px);font-weight:800;letter-spacing:-0.028em;line-height:1.1;margin:0 0 6px;color:var(--text-strong)"
          >
            <span class="gradient-text">{tags.length}</span>{" "}
            tag{tags.length === 1 ? "" : "s"}
          </h1>
          <p
            class="tags-sub"
            style="margin:0;font-size:14px;color:var(--text-muted);line-height:1.5;max-width:700px"
          >
            Named points in the history — typically releases, milestones,
            or shipped versions. Click a tag to browse the tree at that
            revision.
          </p>
        </header>

        {tags.length === 0 ? (
          <div class="commits-empty">
            <div class="commits-empty-orb" aria-hidden="true" />
            <div class="commits-empty-inner">
              <div class="commits-empty-icon" aria-hidden="true">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                  <line x1="7" y1="7" x2="7.01" y2="7" />
                </svg>
              </div>
              <h3 class="commits-empty-title">No tags yet</h3>
              <p class="commits-empty-sub">
                Tag a commit to mark a release or milestone. From the CLI:{" "}
                <code>git tag v0.1.0 &amp;&amp; git push --tags</code>.
              </p>
            </div>
          </div>
        ) : (
          <div class="tags-list">
            {tags.map((t) => {
              const hasRelease = tagsWithReleases.has(t.name);
              return (
                <div class="tags-row">
                  <div class="tags-row-icon" aria-hidden="true">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                      <line x1="7" y1="7" x2="7.01" y2="7" />
                    </svg>
                  </div>
                  <div class="tags-row-main">
                    <div class="tags-row-name">
                      <a
                        href={`/${owner}/${repo}/tree/${t.name}`}
                        style="text-decoration:none"
                      >
                        <span class="tags-row-version">{t.name}</span>
                      </a>
                    </div>
                    <div class="tags-row-meta">
                      <span
                        title={t.date ? new Date(t.date).toISOString() : ""}
                      >
                        Tagged {relative(t.date)}
                      </span>
                      <span class="sep">·</span>
                      <a
                        href={`/${owner}/${repo}/commit/${t.sha}`}
                        class="tags-row-sha"
                        title={t.sha}
                      >
                        {t.sha.slice(0, 7)}
                      </a>
                    </div>
                  </div>
                  <div class="tags-row-side">
                    <a
                      href={`/${owner}/${repo}/tree/${t.name}`}
                      class="tags-row-link"
                    >
                      Browse files
                    </a>
                    {hasRelease && (
                      <a
                        href={`/${owner}/${repo}/releases/tag/${t.name}`}
                        class="tags-row-link"
                        style="color:#67e8f9;border-color:rgba(54,197,214,0.35);background:rgba(54,197,214,0.06)"
                      >
                        View release
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
});

// Commit log
web.get("/:owner/:repo/commits/:ref?", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const ref =
    c.req.param("ref") || (await getDefaultBranch(owner, repo)) || "main";
  const branches = await listBranches(owner, repo);

  const commits = await listCommits(owner, repo, ref, 50);

  // Block J3 — batch-fetch cached verification results for the page.
  let verifications: Record<string, { verified: boolean; reason: string }> = {};
  try {
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, owner))
      .limit(1);
    if (ownerRow) {
      const [repoRow] = await db
        .select()
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, ownerRow.id),
            eq(repositories.name, repo)
          )
        )
        .limit(1);
      if (repoRow && commits.length > 0) {
        const rows = await db
          .select()
          .from(commitVerifications)
          .where(
            and(
              eq(commitVerifications.repositoryId, repoRow.id),
              inArray(
                commitVerifications.commitSha,
                commits.map((c) => c.sha)
              )
            )
          );
        for (const r of rows) {
          verifications[r.commitSha] = {
            verified: r.verified,
            reason: r.reason,
          };
        }
      }
    }
  } catch {
    // DB unavailable — skip the badges gracefully.
  }

  return c.html(
    <Layout title={`Commits — ${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="commits" />
      <div class="commits-hero">
        <div class="commits-hero-orb-wrap" aria-hidden="true">
          <div class="commits-hero-orb" />
        </div>
        <div class="commits-hero-inner">
          <div class="commits-eyebrow">
            <strong>History</strong> · {owner}/{repo}
          </div>
          <h1 class="commits-title">
            <span class="gradient-text">{commits.length}</span> recent commit
            {commits.length === 1 ? "" : "s"} on{" "}
            <span class="commits-branch">{ref}</span>
          </h1>
          <p class="commits-sub">
            Browse the project's history. Click any commit to see the full
            diff, AI review notes, and signature status.
          </p>
        </div>
      </div>
      <div class="commits-toolbar">
        <BranchSwitcher
          owner={owner}
          repo={repo}
          currentRef={ref}
          branches={branches}
          pathType="commits"
        />
        <div class="commits-toolbar-actions">
          <a href={`/${owner}/${repo}/branches`} class="commits-toolbar-link">
            {"⊢"} Branches
          </a>
          <a href={`/${owner}/${repo}/tags`} class="commits-toolbar-link">
            {"#"} Tags
          </a>
        </div>
      </div>
      {commits.length === 0 ? (
        <div class="commits-empty">
          <div class="commits-empty-orb" aria-hidden="true" />
          <div class="commits-empty-inner">
            <div class="commits-empty-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="4" />
                <line x1="1.05" y1="12" x2="7" y2="12" />
                <line x1="17.01" y1="12" x2="22.96" y2="12" />
              </svg>
            </div>
            <h3 class="commits-empty-title">No commits yet</h3>
            <p class="commits-empty-sub">
              This branch is empty. Push your first commit, or use the
              web editor to create a file.
            </p>
          </div>
        </div>
      ) : (
        <div class="commits-list-wrap">
          {(() => {
            // Group commits by day for the section headers.
            const dayLabel = (iso: string): string => {
              const d = new Date(iso);
              if (Number.isNaN(d.getTime())) return "Unknown";
              const today = new Date();
              const yesterday = new Date(today);
              yesterday.setDate(today.getDate() - 1);
              const sameDay = (a: Date, b: Date) =>
                a.getFullYear() === b.getFullYear() &&
                a.getMonth() === b.getMonth() &&
                a.getDate() === b.getDate();
              if (sameDay(d, today)) return "Today";
              if (sameDay(d, yesterday)) return "Yesterday";
              return d.toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: today.getFullYear() === d.getFullYear() ? undefined : "numeric",
              });
            };
            const relative = (iso: string): string => {
              const d = new Date(iso);
              if (Number.isNaN(d.getTime())) return "";
              const diff = Date.now() - d.getTime();
              const m = Math.floor(diff / 60000);
              if (m < 1) return "just now";
              if (m < 60) return `${m} min ago`;
              const h = Math.floor(m / 60);
              if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
              const dd = Math.floor(h / 24);
              if (dd < 30) return `${dd} day${dd === 1 ? "" : "s"} ago`;
              return d.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              });
            };
            const initial = (name: string): string =>
              (name || "?").trim().charAt(0).toUpperCase() || "?";
            // Build groups preserving order.
            const groups: Array<{ label: string; items: typeof commits }> = [];
            let lastLabel = "";
            for (const cm of commits) {
              const label = dayLabel(cm.date);
              if (label !== lastLabel) {
                groups.push({ label, items: [] });
                lastLabel = label;
              }
              groups[groups.length - 1].items.push(cm);
            }
            return groups.map((g) => (
              <>
                <div class="commits-day-head">
                  <span class="commits-day-head-dot" aria-hidden="true" />
                  Commits on {g.label}
                </div>
                {g.items.map((cm) => {
                  const v = verifications[cm.sha];
                  return (
                    <div class="commits-row">
                      <div class="commits-avatar" aria-hidden="true">
                        {initial(cm.author)}
                      </div>
                      <div class="commits-row-body">
                        <div class="commits-row-msg">
                          <a href={`/${owner}/${repo}/commit/${cm.sha}`}>
                            {cm.message}
                          </a>
                          {v?.verified && (
                            <span
                              class="commits-row-verified"
                              title="Signed with a registered key"
                            >
                              Verified
                            </span>
                          )}
                        </div>
                        <div class="commits-row-meta">
                          <strong>{cm.author}</strong>
                          <span class="sep">·</span>
                          <span
                            class="commits-row-time"
                            title={new Date(cm.date).toISOString()}
                          >
                            committed {relative(cm.date)}
                          </span>
                          {cm.parentShas.length > 1 && (
                            <>
                              <span class="sep">·</span>
                              <span>merge of {cm.parentShas.length} parents</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div class="commits-row-side">
                        <a
                          href={`/${owner}/${repo}/commit/${cm.sha}`}
                          class="commits-row-sha"
                          title={cm.sha}
                        >
                          {cm.sha.slice(0, 7)}
                        </a>
                        <button
                          type="button"
                          class="commits-row-copy"
                          data-copy-sha={cm.sha}
                          title="Copy full SHA"
                          aria-label={`Copy SHA ${cm.sha}`}
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path fill="currentColor" d="M4 1.5h6A1.5 1.5 0 0 1 11.5 3v1h-1V3a.5.5 0 0 0-.5-.5H4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h1v1H4A1.5 1.5 0 0 1 2.5 11V3A1.5 1.5 0 0 1 4 1.5Z" />
                            <path fill="currentColor" d="M6 5.5h6A1.5 1.5 0 0 1 13.5 7v6A1.5 1.5 0 0 1 12 14.5H6A1.5 1.5 0 0 1 4.5 13V7A1.5 1.5 0 0 1 6 5.5Zm0 1A.5.5 0 0 0 5.5 7v6a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V7a.5.5 0 0 0-.5-.5H6Z" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            ));
          })()}
        </div>
      )}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function(){
              document.addEventListener('click', function(e){
                var t = e.target; if (!t) return;
                var btn = t.closest && t.closest('[data-copy-sha]');
                if (!btn) return;
                e.preventDefault();
                var sha = btn.getAttribute('data-copy-sha') || '';
                if (!navigator.clipboard) return;
                navigator.clipboard.writeText(sha).then(function(){
                  btn.classList.add('is-copied');
                  setTimeout(function(){ btn.classList.remove('is-copied'); }, 1200);
                }).catch(function(){});
              });
            })();
          `,
        }}
      />
    </Layout>
  );
});

// Single commit with diff
web.get("/:owner/:repo/commit/:sha", async (c) => {
  const { owner, repo, sha } = c.req.param();
  const user = c.get("user");

  // Fetch commit, full message, and diff in parallel
  const [commit, fullMessage, diffResult] = await Promise.all([
    getCommit(owner, repo, sha),
    getCommitFullMessage(owner, repo, sha),
    getDiff(owner, repo, sha),
  ]);
  if (!commit) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Commit not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  // Block J3 — try to verify this commit's signature.
  let verification:
    | { verified: boolean; reason: string; signatureType: string | null }
    | null = null;
  // Block J8 — external CI commit statuses rollup.
  let statusCombined:
    | {
        state: "pending" | "success" | "failure";
        total: number;
        contexts: Array<{
          context: string;
          state: string;
          description: string | null;
          targetUrl: string | null;
        }>;
      }
    | null = null;
  try {
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, owner))
      .limit(1);
    if (ownerRow) {
      const [repoRow] = await db
        .select()
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, ownerRow.id),
            eq(repositories.name, repo)
          )
        )
        .limit(1);
      if (repoRow) {
        const { verifyCommit } = await import("../lib/signatures");
        const v = await verifyCommit(repoRow.id, owner, repo, commit.sha);
        verification = {
          verified: v.verified,
          reason: v.reason,
          signatureType: v.signatureType,
        };
        try {
          const { combinedStatus } = await import("../lib/commit-statuses");
          const combined = await combinedStatus(repoRow.id, commit.sha);
          if (combined.total > 0) {
            statusCombined = {
              state: combined.state as any,
              total: combined.total,
              contexts: combined.contexts.map((c) => ({
                context: c.context,
                state: c.state,
                description: c.description,
                targetUrl: c.targetUrl,
              })),
            };
          }
        } catch {
          statusCombined = null;
        }
      }
    }
  } catch {
    verification = null;
  }

  const { files, raw } = diffResult;

  // Diff stats: count additions / deletions across all files for the
  // header summary bar. Computed here from the parsed diff so we don't
  // touch the DiffView component.
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    const hunks = (f as any).hunks as Array<any> | undefined;
    if (Array.isArray(hunks)) {
      for (const h of hunks) {
        const lines = (h?.lines || []) as Array<any>;
        for (const ln of lines) {
          const t = ln?.type || ln?.kind;
          if (t === "add" || t === "added" || t === "+") additions += 1;
          else if (t === "del" || t === "deleted" || t === "delete" || t === "-")
            deletions += 1;
        }
      }
    }
  }
  // Fall back: scan raw if file-level counting yielded zero (it's just a
  // header polish — never let a parsing miss break the page).
  if (additions === 0 && deletions === 0 && typeof raw === "string") {
    for (const line of raw.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  const fileCount = files.length;

  return c.html(
    <Layout title={`${commit.message} — ${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <RepoHeader owner={owner} repo={repo} />
      <div class="commit-detail-card">
        <div class="commit-detail-eyebrow">
          <strong>Commit</strong>
          <span class="commit-detail-sha-pill" title={commit.sha}>
            {commit.sha.slice(0, 7)}
          </span>
          {verification && verification.reason !== "unsigned" && (
            <span
              class={`commit-detail-verify ${
                verification.verified
                  ? "commit-detail-verify-ok"
                  : "commit-detail-verify-warn"
              }`}
              title={`${verification.signatureType?.toUpperCase() || ""} · ${verification.reason}`}
            >
              {verification.verified ? "Verified" : verification.reason}
            </span>
          )}
        </div>
        <h1 class="commit-detail-title">{commit.message}</h1>
        {fullMessage !== commit.message && (
          <pre class="commit-detail-body">{fullMessage}</pre>
        )}
        <div class="commit-detail-meta">
          <span class="commit-detail-author">
            <strong>{commit.author}</strong> committed on{" "}
            {new Date(commit.date).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </span>
          {commit.parentShas.length > 0 && (
            <span class="commit-detail-parents">
              {commit.parentShas.length === 1 ? "Parent" : "Parents"}:{" "}
              {commit.parentShas.map((p, idx) => (
                <>
                  {idx > 0 && " "}
                  <a
                    href={`/${owner}/${repo}/commit/${p}`}
                    class="commit-detail-sha-link"
                  >
                    {p.slice(0, 7)}
                  </a>
                </>
              ))}
            </span>
          )}
        </div>
        <div class="commit-detail-stats">
          <span class="commit-detail-stat">
            <strong>{fileCount}</strong>{" "}
            file{fileCount === 1 ? "" : "s"} changed
          </span>
          <span class="commit-detail-stat commit-detail-stat-add">
            <span class="commit-detail-stat-mark">+</span>
            <strong>{additions}</strong>
          </span>
          <span class="commit-detail-stat commit-detail-stat-del">
            <span class="commit-detail-stat-mark">−</span>
            <strong>{deletions}</strong>
          </span>
          <span class="commit-detail-sha-full" title="Full SHA">
            {commit.sha}
          </span>
        </div>
        {statusCombined && (
          <div class="commit-detail-checks">
            <div class="commit-detail-checks-head">
              <strong>Checks</strong>
              <span class="commit-detail-checks-summary">
                {statusCombined.total} total ·{" "}
                <span
                  class={`commit-detail-check-state commit-detail-check-state-${statusCombined.state}`}
                >
                  {statusCombined.state}
                </span>
              </span>
            </div>
            <div class="commit-detail-check-row">
              {statusCombined.contexts.map((cx) => (
                <span
                  class={`commit-detail-check commit-detail-check-${cx.state}`}
                  title={cx.description || cx.context}
                >
                  {cx.targetUrl ? (
                    <a href={cx.targetUrl} rel="noopener">
                      {cx.context}: {cx.state}
                    </a>
                  ) : (
                    <>
                      {cx.context}: {cx.state}
                    </>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <DiffView
        raw={raw}
        files={files}
        viewFileBase={`/${owner}/${repo}/blob/${commit.sha}`}
      />
    </Layout>
  );
});

// Raw file download
web.get("/:owner/:repo/raw/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const refAndPath = c.req.param("ref");

  const branches = await listBranches(owner, repo);
  let ref = "";
  let filePath = "";

  for (const branch of branches) {
    if (refAndPath.startsWith(branch + "/")) {
      ref = branch;
      filePath = refAndPath.slice(branch.length + 1);
      break;
    }
  }

  if (!ref) {
    const slashIdx = refAndPath.indexOf("/");
    if (slashIdx === -1) return c.text("Not found", 404);
    ref = refAndPath.slice(0, slashIdx);
    filePath = refAndPath.slice(slashIdx + 1);
  }

  const data = await getRawBlob(owner, repo, ref, filePath);
  if (!data) return c.text("Not found", 404);

  const fileName = filePath.split("/").pop() || "file";
  return new Response(data as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
    },
  });
});

// Blame view
web.get("/:owner/:repo/blame/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const refAndPath = c.req.param("ref");

  const branches = await listBranches(owner, repo);
  let ref = "";
  let filePath = "";

  for (const branch of branches) {
    if (refAndPath.startsWith(branch + "/")) {
      ref = branch;
      filePath = refAndPath.slice(branch.length + 1);
      break;
    }
  }

  if (!ref) {
    const slashIdx = refAndPath.indexOf("/");
    if (slashIdx === -1) return c.text("Not found", 404);
    ref = refAndPath.slice(0, slashIdx);
    filePath = refAndPath.slice(slashIdx + 1);
  }

  const blameLines = await getBlame(owner, repo, ref, filePath);
  if (blameLines.length === 0) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>File not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const fileName = filePath.split("/").pop() || filePath;
  // Unique contributors (by author) tracked once for the header chip.
  const blameAuthors = new Set<string>();
  for (const ln of blameLines) blameAuthors.add(ln.author);

  return c.html(
    <Layout title={`Blame: ${filePath} — ${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <header class="blame-head">
        <div class="blame-eyebrow">
          <span class="blame-eyebrow-dot" aria-hidden="true" />
          Blame · Line-by-line history
        </div>
        <h1 class="blame-title">
          <code>{fileName}</code>
        </h1>
        <p class="blame-sub">
          Each line is annotated with the commit that last touched it.
          Click any SHA to jump to that commit and see the surrounding
          change.
        </p>
      </header>
      <div class="blame-toolbar">
        <Breadcrumb owner={owner} repo={repo} ref={ref} path={filePath} />
      </div>
      <div class="blame-card">
        <div class="blame-header">
          <div class="blame-header-meta">
            <span class="blame-header-icon" aria-hidden="true">{"⎙"}</span>
            <span class="blame-header-name">{fileName}</span>
            <span class="blame-header-tag">Blame</span>
            <span class="blame-header-stats">
              {blameLines.length} line{blameLines.length === 1 ? "" : "s"} ·{" "}
              {blameAuthors.size} contributor
              {blameAuthors.size === 1 ? "" : "s"}
            </span>
          </div>
          <div class="blame-header-actions">
            <a
              href={`/${owner}/${repo}/blob/${ref}/${filePath}`}
              class="blob-pill"
            >
              Normal view
            </a>
            <a
              href={`/${owner}/${repo}/raw/${ref}/${filePath}`}
              class="blob-pill"
            >
              Raw
            </a>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="blame-table">
            <tbody>
              {blameLines.map((line, i) => {
                const showInfo =
                  i === 0 || blameLines[i - 1].sha !== line.sha;
                return (
                  <tr class={showInfo ? "blame-row-first" : ""}>
                    <td class="blame-gutter">
                      {showInfo && (
                        <span class="blame-gutter-inner">
                          <a
                            href={`/${owner}/${repo}/commit/${line.sha}`}
                            class="blame-gutter-sha"
                            title={`Commit ${line.sha}`}
                          >
                            {line.sha.slice(0, 7)}
                          </a>
                          <span class="blame-gutter-author" title={line.author}>
                            {line.author}
                          </span>
                        </span>
                      )}
                    </td>
                    <td class="blame-line-num">{line.lineNum}</td>
                    <td class="blame-line-content">{line.content}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
});

// Search
web.get("/:owner/:repo/search", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const q = c.req.query("q") || "";

  if (!(await repoExists(owner, repo))) return c.notFound();

  const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
  let results: Array<{ file: string; lineNum: number; line: string }> = [];

  if (q.trim()) {
    results = await searchCode(owner, repo, defaultBranch, q.trim());
  }

  return c.html(
    <Layout title={`Search — ${owner}/${repo}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: codeBrowseCss }} />
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="search-hero">
        <div class="search-eyebrow">
          <strong>Search</strong> · {owner}/{repo}
        </div>
        <h1 class="search-title">
          Find any line in <span class="gradient-text">{repo}</span>
        </h1>
        <form
          method="get"
          action={`/${owner}/${repo}/search`}
          class="search-form"
          role="search"
        >
          <div class="search-input-wrap">
            <span class="search-input-icon" aria-hidden="true">{"⌕"}</span>
            <input
              type="text"
              name="q"
              value={q}
              placeholder="Search code on the default branch…"
              aria-label="Search code"
              class="search-input"
              autocomplete="off"
              autofocus
            />
          </div>
          <button type="submit" class="btn btn-primary search-submit">
            Search
          </button>
        </form>
      </div>
      {q && (
        <div class="search-results-head">
          <span class="search-results-count">
            <strong>{results.length}</strong> result
            {results.length !== 1 ? "s" : ""}
          </span>
          <span class="search-results-query">
            for <span class="search-results-q">"{q}"</span> on{" "}
            <code>{defaultBranch}</code>
          </span>
        </div>
      )}
      {q && results.length === 0 ? (
        <div class="search-empty">
          <p>
            No matches for <strong>"{q}"</strong>. Try a shorter query or check
            you're on the right branch.
          </p>
        </div>
      ) : results.length > 0 ? (
        <div class="search-results">
          {(() => {
            // Group by file
            const grouped: Record<
              string,
              Array<{ lineNum: number; line: string }>
            > = {};
            for (const r of results) {
              if (!grouped[r.file]) grouped[r.file] = [];
              grouped[r.file].push({ lineNum: r.lineNum, line: r.line });
            }
            return Object.entries(grouped).map(([file, matches]) => (
              <div class="search-file diff-file">
                <div class="search-file-head diff-file-header">
                  <a
                    href={`/${owner}/${repo}/blob/${defaultBranch}/${file}`}
                    class="search-file-link"
                  >
                    {file}
                  </a>
                  <span class="search-file-count">
                    {matches.length} match{matches.length === 1 ? "" : "es"}
                  </span>
                </div>
                <div class="blob-code">
                  <table>
                    <tbody>
                      {matches.map((m) => (
                        <tr>
                          <td class="line-num">{m.lineNum}</td>
                          <td class="line-content">{m.line}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ));
          })()}
        </div>
      ) : null}
    </Layout>
  );
});

export default web;
