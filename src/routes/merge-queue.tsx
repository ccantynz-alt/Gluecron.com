/**
 * Block E5 — Merge queue UI + actions.
 *
 *   GET  /:owner/:repo/queue                  — queue history + current state
 *   POST /:owner/:repo/pulls/:n/enqueue       — enqueue a PR (requireAuth)
 *   POST /:owner/:repo/queue/:id/dequeue      — remove entry (owner OR enqueuer)
 *   POST /:owner/:repo/queue/process-next     — owner-only: run the head
 *
 * The "process-next" handler is v1 — it just re-runs gates against the base
 * and, if green, merges by updating the base branch ref. A full background
 * worker is future work; this keeps the feature usable without a daemon.
 *
 * 2026 polish: scoped `.mq-*` class system, gradient hero + section cards
 * mirror admin-integrations.tsx / admin-ops.tsx. State pills use the same
 * traffic-light dot pattern as collaborators.tsx. RepoHeader / RepoNav are
 * left untouched — we only own the content beneath them.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  mergeQueueEntries,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  enqueuePr,
  dequeueEntry,
  listQueueWithPrs,
  markHeadRunning,
  completeEntry,
  peekHead,
} from "../lib/merge-queue";
import { runAllGateChecks } from "../lib/gate";
import { resolveRef, getRepoPath } from "../git/repository";
import { audit } from "../lib/notify";

const queue = new Hono<AuthEnv>();
queue.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.mq-*`. Gradient hairline hero, card
 * sections, status pills + tabular-nums timing. Hard-pinned to the
 * 1100px content width spec.
 * ───────────────────────────────────────────────────────────────────── */
const mqStyles = `
  .mq-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Hero ─── */
  .mq-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .mq-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .mq-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .mq-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .mq-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .mq-eyebrow {
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
  .mq-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .mq-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .mq-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .mq-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .mq-hero-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 18px;
    font-size: 13.5px;
    font-weight: 600;
    border-radius: 10px;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    white-space: nowrap;
    text-decoration: none;
    color: #ffffff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .mq-hero-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }

  /* ─── Banners ─── */
  .mq-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mq-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .mq-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .mq-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Base-branch card ─── */
  .mq-group {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .mq-group::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.45;
    pointer-events: none;
  }
  .mq-group-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .mq-group-head-text { flex: 1; min-width: 200px; }
  .mq-group-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 15.5px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .mq-group-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    flex-shrink: 0;
  }
  .mq-base-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
  }
  .mq-group-count {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Entry rows ─── */
  .mq-list { display: flex; flex-direction: column; }
  .mq-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px var(--space-5);
    border-top: 1px solid var(--border);
  }
  .mq-row:first-child { border-top: none; }
  .mq-row-body { flex: 1; min-width: 0; }
  .mq-row-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .mq-row-link {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14.5px;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
  }
  .mq-row-link:hover { text-decoration: underline; }
  .mq-row-num {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    margin-right: 2px;
  }
  .mq-row-meta {
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .mq-row-meta .sep { opacity: 0.45; }
  .mq-row-meta code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .mq-row-err {
    margin-top: 8px;
    padding: 8px 10px;
    background: rgba(248,113,113,0.06);
    border: 1px solid rgba(248,113,113,0.28);
    border-radius: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #fecaca;
    line-height: 1.45;
  }
  .mq-row-action { flex-shrink: 0; }
  .mq-row-action form { margin: 0; }

  /* ─── State pills ─── */
  .mq-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .mq-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .mq-pill.is-queued {
    background: rgba(148,163,184,0.16);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }
  .mq-pill.is-running {
    background: rgba(54,197,214,0.14);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
  }
  .mq-pill.is-merged {
    background: rgba(140,109,255,0.16);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .mq-pill.is-failed {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .mq-pill.is-dequeued {
    background: rgba(107,114,128,0.18);
    color: #d1d5db;
    box-shadow: inset 0 0 0 1px rgba(107,114,128,0.32);
  }

  /* ─── Buttons ─── */
  .mq-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 9px;
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .mq-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .mq-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .mq-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .mq-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* ─── Crumb back link ─── */
  .mq-crumbs {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
    font-size: 12.5px;
  }
  .mq-crumbs a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 11px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 500;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .mq-crumbs a:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* ─── Empty state ─── */
  .mq-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 48px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .mq-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .mq-empty-inner { position: relative; z-index: 1; }
  .mq-empty-icon {
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
    margin-bottom: 14px;
  }
  .mq-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .mq-empty-sub {
    margin: 0 auto 16px;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 460px;
    line-height: 1.5;
  }
`;

function IconQueue() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}
function IconBranch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

async function loadRepo(ownerName: string, repoName: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        defaultBranch: repositories.defaultBranch,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

function relTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - t.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return t.toLocaleDateString();
}

function statePill(state: string) {
  const cls =
    state === "running"
      ? "is-running"
      : state === "merged"
      ? "is-merged"
      : state === "failed"
      ? "is-failed"
      : state === "dequeued"
      ? "is-dequeued"
      : "is-queued";
  return (
    <span class={`mq-pill ${cls}`}>
      <span class="dot" aria-hidden="true" />
      {state}
    </span>
  );
}

// ---------- Queue list ----------

queue.get("/:owner/:repo/queue", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) {
    return c.html(
      <Layout title="Not found" user={user}>
        <div class="mq-wrap">
          <div class="mq-empty">
            <div class="mq-empty-orb" aria-hidden="true" />
            <div class="mq-empty-inner">
              <div class="mq-empty-icon" aria-hidden="true">
                <IconQueue />
              </div>
              <h2 class="mq-empty-title">Repository not found</h2>
              <p class="mq-empty-sub">
                Check the owner and repo name in the URL.
              </p>
            </div>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: mqStyles }} />
      </Layout>,
      404
    );
  }

  const entries = await listQueueWithPrs(repoRow.id);
  const byBranch = new Map<string, typeof entries>();
  for (const e of entries) {
    const arr = byBranch.get(e.baseBranch) || [];
    arr.push(e);
    byBranch.set(e.baseBranch, arr);
  }

  const isOwner = !!user && user.id === repoRow.ownerId;
  const success = c.req.query("success");
  const error = c.req.query("error");

  return c.html(
    <Layout title={`Merge queue — ${owner}/${repo}`} user={user}>
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="pulls" />

      <div class="mq-wrap">
        <div class="mq-crumbs">
          <a href={`/${owner}/${repo}/pulls`}>
            <IconArrowLeft />
            Back to pull requests
          </a>
        </div>

        <section class="mq-hero">
          <div class="mq-hero-orb" aria-hidden="true" />
          <div class="mq-hero-inner">
            <div class="mq-hero-text">
              <div class="mq-eyebrow">
                <span class="mq-eyebrow-dot" aria-hidden="true" />
                Repository · Merge queue
              </div>
              <h1 class="mq-title">
                <span class="mq-title-grad">Serialised merges.</span>
              </h1>
              <p class="mq-sub">
                Queued PRs re-run gates against the latest base before merging.
                This prevents green-in-isolation, red-after-merge races.
              </p>
            </div>
            <a href={`/${owner}/${repo}/pulls`} class="mq-hero-cta">
              <IconQueue />
              Browse PRs
            </a>
          </div>
        </section>

        {success && (
          <div class="mq-banner is-ok" role="status">
            <span class="mq-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="mq-banner is-error" role="alert">
            <span class="mq-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        {entries.length === 0 ? (
          <div class="mq-empty">
            <div class="mq-empty-orb" aria-hidden="true" />
            <div class="mq-empty-inner">
              <div class="mq-empty-icon" aria-hidden="true">
                <IconQueue />
              </div>
              <h2 class="mq-empty-title">Queue is empty</h2>
              <p class="mq-empty-sub">
                Enqueue an open, non-draft PR from its pull-request page to
                start a serialised merge.
              </p>
              <a href={`/${owner}/${repo}/pulls`} class="mq-btn mq-btn-primary">
                Pick a PR to enqueue
              </a>
            </div>
          </div>
        ) : (
          Array.from(byBranch.entries()).map(([branch, items]) => {
            const active = items.filter(
              (i) => i.state === "queued" || i.state === "running"
            );
            return (
              <section class="mq-group">
                <header class="mq-group-head">
                  <div class="mq-group-head-text">
                    <h2 class="mq-group-title">
                      <span class="mq-group-title-icon" aria-hidden="true">
                        <IconBranch />
                      </span>
                      Base
                      <span class="mq-base-chip">{branch}</span>
                      <span class="mq-group-count">{active.length} active</span>
                    </h2>
                  </div>
                  {isOwner && active.length > 0 && (
                    <form
                      method="post"
                      action={`/${owner}/${repo}/queue/process-next?base=${encodeURIComponent(branch)}`}
                    >
                      <button type="submit" class="mq-btn mq-btn-primary">
                        Process next
                      </button>
                    </form>
                  )}
                </header>
                <div class="mq-list">
                  {items.map((it) => (
                    <div class="mq-row">
                      <div class="mq-row-body">
                        <div class="mq-row-head">
                          {statePill(it.state)}
                          {it.prNumber != null ? (
                            <a
                              href={`/${owner}/${repo}/pulls/${it.prNumber}`}
                              class="mq-row-link"
                            >
                              <span class="mq-row-num">#{it.prNumber}</span>
                              {it.prTitle}
                            </a>
                          ) : (
                            <span style="color:var(--text-muted)">(PR gone)</span>
                          )}
                        </div>
                        <div class="mq-row-meta">
                          <span>pos {it.position}</span>
                          {it.prHeadBranch && (
                            <>
                              <span class="sep">·</span>
                              <code>{it.prHeadBranch}</code>
                            </>
                          )}
                          <span class="sep">·</span>
                          <span>enqueued {relTime(it.enqueuedAt)}</span>
                          {it.startedAt && (
                            <>
                              <span class="sep">·</span>
                              <span>started {relTime(it.startedAt)}</span>
                            </>
                          )}
                          {it.finishedAt && (
                            <>
                              <span class="sep">·</span>
                              <span>finished {relTime(it.finishedAt)}</span>
                            </>
                          )}
                        </div>
                        {it.errorMessage && (
                          <div class="mq-row-err">{it.errorMessage}</div>
                        )}
                      </div>
                      {(it.state === "queued" || it.state === "running") &&
                        user &&
                        (isOwner || user.id === it.enqueuedBy) && (
                          <div class="mq-row-action">
                            <form
                              method="post"
                              action={`/${owner}/${repo}/queue/${it.id}/dequeue`}
                              onsubmit="return confirm('Remove from queue?')"
                            >
                              <button type="submit" class="mq-btn mq-btn-ghost">
                                Remove
                              </button>
                            </form>
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: mqStyles }} />
    </Layout>
  );
});

// ---------- Enqueue a PR ----------

queue.post("/:owner/:repo/pulls/:number/enqueue", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const prNum = parseInt(c.req.param("number"), 10);
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repoRow.id),
        eq(pullRequests.number, prNum)
      )
    )
    .limit(1);
  if (!pr || pr.state !== "open") {
    return c.redirect(
      `/${owner}/${repo}/pulls/${prNum}?error=${encodeURIComponent(
        "PR must be open to enqueue."
      )}`
    );
  }
  if (pr.isDraft) {
    return c.redirect(
      `/${owner}/${repo}/pulls/${prNum}?error=${encodeURIComponent(
        "Cannot enqueue a draft PR."
      )}`
    );
  }

  const result = await enqueuePr({
    repositoryId: repoRow.id,
    pullRequestId: pr.id,
    baseBranch: pr.baseBranch,
    enqueuedBy: user.id,
  });
  if (!result.ok) {
    return c.redirect(
      `/${owner}/${repo}/pulls/${prNum}?error=${encodeURIComponent(
        result.reason || "Enqueue failed"
      )}`
    );
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "merge_queue.enqueue",
    targetId: pr.id,
    metadata: { prNumber: pr.number, baseBranch: pr.baseBranch },
  });

  return c.redirect(
    `/${owner}/${repo}/queue?success=${encodeURIComponent(
      `PR #${pr.number} enqueued`
    )}`
  );
});

// ---------- Dequeue ----------

queue.post("/:owner/:repo/queue/:id/dequeue", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, id } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const [entry] = await db
    .select()
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.id, id),
        eq(mergeQueueEntries.repositoryId, repoRow.id)
      )
    )
    .limit(1);
  if (!entry) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("Entry not found")}`
    );
  }
  const isOwner = user.id === repoRow.ownerId;
  if (!isOwner && entry.enqueuedBy !== user.id) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        "Only the enqueuer or a repo owner can remove this entry."
      )}`
    );
  }

  const ok = await dequeueEntry(id);
  if (!ok) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("Could not remove entry")}`
    );
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "merge_queue.dequeue",
    targetId: entry.pullRequestId,
  });

  return c.redirect(
    `/${owner}/${repo}/queue?success=${encodeURIComponent("Entry removed")}`
  );
});

// ---------- Process next ----------

queue.post("/:owner/:repo/queue/process-next", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const base = c.req.query("base");
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        "Only repo owners can process the queue."
      )}`
    );
  }

  const targetBase = base || repoRow.defaultBranch || "main";
  const head = await peekHead(repoRow.id, targetBase);
  if (!head) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        `No queued entries for base ${targetBase}`
      )}`
    );
  }

  const started = await markHeadRunning(repoRow.id, targetBase);
  if (!started) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        "Could not transition head to running"
      )}`
    );
  }

  // Re-run gates against latest base.
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, started.pullRequestId))
    .limit(1);
  if (!pr) {
    await completeEntry(started.id, "failed", "Pull request no longer exists.");
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("PR vanished")}`
    );
  }
  if (pr.state !== "open") {
    await completeEntry(started.id, "failed", "Pull request is no longer open.");
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("PR is no longer open")}`
    );
  }

  const headSha = await resolveRef(owner, repo, pr.headBranch);
  if (!headSha) {
    await completeEntry(started.id, "failed", "Head branch not found.");
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("Head branch not found")}`
    );
  }

  const gateResult = await runAllGateChecks(
    owner,
    repo,
    pr.baseBranch,
    pr.headBranch,
    headSha,
    true
  );
  const hardFailures = gateResult.checks.filter(
    (check) => !check.passed && check.name !== "Merge check"
  );
  if (hardFailures.length > 0) {
    const msg = hardFailures
      .map((f) => `${f.name}: ${f.details}`)
      .join("; ");
    await completeEntry(started.id, "failed", msg);
    try {
      await db.insert(prComments).values({
        pullRequestId: pr.id,
        authorId: user.id,
        body: `**Merge queue:** gates failed on latest base — ${msg}`,
        isAiReview: false,
      });
    } catch {}
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(msg)}`
    );
  }

  // Gates passed — merge by updating base ref to head.
  const repoDir = getRepoPath(owner, repo);
  const proc = Bun.spawn(
    [
      "git",
      "update-ref",
      `refs/heads/${pr.baseBranch}`,
      `refs/heads/${pr.headBranch}`,
    ],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const exit = await proc.exited;
  if (exit !== 0) {
    await completeEntry(started.id, "failed", "update-ref failed");
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        "Merge failed — unable to update base ref"
      )}`
    );
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

  await completeEntry(started.id, "merged");

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "merge_queue.merged",
    targetId: pr.id,
    metadata: { prNumber: pr.number, baseBranch: pr.baseBranch },
  });

  return c.redirect(
    `/${owner}/${repo}/queue?success=${encodeURIComponent(
      `PR #${pr.number} merged via queue`
    )}`
  );
});

export default queue;
