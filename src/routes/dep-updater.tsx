/**
 * Block D2 — AI dependency updater UI.
 *
 *   GET  /:owner/:repo/settings/dep-updater       — run history + "Run now"
 *   POST /:owner/:repo/settings/dep-updater/run   — kicks off a run (fire & forget)
 *
 * Owner-only. See `src/lib/dep-updater.ts` for the orchestrator.
 *
 * 2026 polish: scoped `.dep-*` class system mirrors the gradient hero and
 * card patterns from admin-integrations.tsx and admin-ops.tsx. Bump tables
 * use tabular-nums + mono for versions; PR refs + branch names are mono.
 * RepoHeader + IssueNav above are untouched — only the content beneath
 * the nav is restyled.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { depUpdateRuns, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { formatRelative } from "../views/ui";
import { IssueNav } from "./issues";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { runDepUpdateRun, type Bump } from "../lib/dep-updater";

const depUpdater = new Hono<AuthEnv>();

depUpdater.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.dep-*`. Hero with gradient hairline +
 * orb, run cards with status pill / tabular-nums timing, mono version cells.
 * ───────────────────────────────────────────────────────────────────── */
const depStyles = `
  .dep-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Hero ─── */
  .dep-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .dep-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .dep-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .dep-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .dep-hero-text { max-width: 720px; flex: 1; min-width: 240px; }
  .dep-eyebrow {
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
  .dep-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .dep-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .dep-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .dep-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }
  .dep-sub code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .dep-hero-cta {
    display: inline-flex;
    align-items: center;
    gap: 7px;
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
  .dep-hero-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }

  /* ─── Section cards ─── */
  .dep-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .dep-section::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.45;
    pointer-events: none;
  }
  .dep-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .dep-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dep-section-title-icon {
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
  .dep-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .dep-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Run card list ─── */
  .dep-run-list { display: flex; flex-direction: column; gap: 10px; }
  .dep-run-card {
    padding: 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .dep-run-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .dep-run-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .dep-run-stamp {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .dep-run-pr {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--accent);
    text-decoration: none;
    padding: 2px 8px;
    border-radius: 6px;
    background: rgba(140,109,255,0.10);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    font-variant-numeric: tabular-nums;
  }
  .dep-run-pr:hover { text-decoration: none; background: rgba(140,109,255,0.18); }
  .dep-run-branch {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    background: var(--bg-tertiary);
    padding: 2px 7px;
    border-radius: 5px;
    border: 1px solid var(--border);
  }
  .dep-run-err {
    margin-top: 10px;
    padding: 8px 10px;
    background: rgba(248,113,113,0.06);
    border: 1px solid rgba(248,113,113,0.28);
    border-radius: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #fecaca;
    line-height: 1.45;
  }
  .dep-bumps { margin-top: 10px; }
  .dep-bumps > summary {
    cursor: pointer;
    font-size: 12.5px;
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    user-select: none;
    list-style: none;
  }
  .dep-bumps > summary::-webkit-details-marker { display: none; }
  .dep-bumps > summary::before {
    content: '▸';
    font-size: 10px;
    color: var(--text-muted);
    transition: transform 120ms ease;
    display: inline-block;
  }
  .dep-bumps[open] > summary::before { transform: rotate(90deg); }
  .dep-bumps[open] > summary {
    color: var(--text-strong);
    border-color: var(--border-strong);
  }

  /* ─── Bump table ─── */
  .dep-table {
    width: 100%;
    margin-top: 12px;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12.5px;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .dep-table thead th {
    text-align: left;
    padding: 9px 12px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    font-weight: 600;
    background: rgba(255,255,255,0.025);
    border-bottom: 1px solid var(--border);
  }
  .dep-table tbody td {
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .dep-table tbody tr:last-child td { border-bottom: none; }
  .dep-table tbody tr:hover td { background: rgba(255,255,255,0.02); }
  .dep-pkg {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
  }
  .dep-ver {
    font-family: var(--font-mono);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .dep-ver.is-from { color: var(--text-muted); }
  .dep-kind-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .dep-major {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .dep-major.is-yes {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .dep-major.is-no {
    background: rgba(148,163,184,0.14);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.28);
  }

  /* ─── Status pills ─── */
  .dep-pill {
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
  .dep-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .dep-pill.is-success {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .dep-pill.is-no-updates {
    background: rgba(148,163,184,0.16);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }
  .dep-pill.is-failed {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .dep-pill.is-running {
    background: rgba(54,197,214,0.14);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
  }
  .dep-pill.is-pending {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }

  /* ─── Empty state ─── */
  .dep-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 48px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .dep-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .dep-empty-inner { position: relative; z-index: 1; }
  .dep-empty-icon {
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
  .dep-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .dep-empty-sub {
    margin: 0 auto 0;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 460px;
    line-height: 1.5;
  }

  /* ─── 4xx-style card ─── */
  .dep-notice {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .dep-notice h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .dep-notice p { color: var(--text-muted); margin: 0; font-size: 14px; }
`;

function IconPackage() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}
function IconHistory() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

function statusPill(status: string) {
  const cls =
    status === "success"
      ? "is-success"
      : status === "no_updates"
      ? "is-no-updates"
      : status === "failed"
      ? "is-failed"
      : status === "running"
      ? "is-running"
      : "is-pending";
  const label =
    status === "no_updates" ? "No updates" : status;
  return (
    <span class={`dep-pill ${cls}`}>
      <span class="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Resolve repo row + enforce owner-only access. Returns either a
 * rendered Response (when unauthorised / missing) or `{ repo }`.
 */
async function resolveOwnerRepo(
  c: any,
  ownerName: string,
  repoName: string
): Promise<
  | { kind: "ok"; repo: typeof repositories.$inferSelect }
  | { kind: "response"; res: Response }
> {
  const user = c.get("user");
  if (!user) {
    return {
      kind: "response",
      res: c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`),
    };
  }

  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) return { kind: "response", res: c.notFound() };
    if (owner.id !== user.id) {
      return {
        kind: "response",
        res: c.html(
          <Layout title="Unauthorized" user={user}>
            <div class="dep-wrap">
              <div class="dep-notice">
                <h2>Unauthorized</h2>
                <p>Only the repository owner can configure the dependency updater.</p>
              </div>
            </div>
            <style dangerouslySetInnerHTML={{ __html: depStyles }} />
          </Layout>,
          403
        ),
      };
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return { kind: "response", res: c.notFound() };
    return { kind: "ok", repo };
  } catch (err) {
    // DB unreachable — let the global 503 / 500 handler cope.
    return {
      kind: "response",
      res: c.html(
        <Layout title="Error" user={user}>
          <div class="dep-wrap">
            <div class="dep-notice">
              <h2>Service unavailable</h2>
              <p>The dependency updater is temporarily offline.</p>
            </div>
          </div>
          <style dangerouslySetInnerHTML={{ __html: depStyles }} />
        </Layout>,
        503
      ),
    };
  }
}

function safeParseBumps(raw: string): Bump[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// GET — run history + "Run now"
depUpdater.get(
  "/:owner/:repo/settings/dep-updater",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if (resolved.kind === "response") return resolved.res;
    const { repo } = resolved;
    const user = c.get("user")!;

    let runs: Array<typeof depUpdateRuns.$inferSelect> = [];
    try {
      runs = await db
        .select()
        .from(depUpdateRuns)
        .where(eq(depUpdateRuns.repositoryId, repo.id))
        .orderBy(desc(depUpdateRuns.createdAt))
        .limit(20);
    } catch {
      runs = [];
    }

    return c.html(
      <Layout title={`Dep Updater — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <IssueNav owner={ownerName} repo={repoName} active="code" />
        <div class="dep-wrap">
          <section class="dep-hero">
            <div class="dep-hero-orb" aria-hidden="true" />
            <div class="dep-hero-inner">
              <div class="dep-hero-text">
                <div class="dep-eyebrow">
                  <span class="dep-eyebrow-dot" aria-hidden="true" />
                  Repository · Dependency updater
                </div>
                <h1 class="dep-title">
                  <span class="dep-title-grad">Keep deps fresh.</span>
                </h1>
                <p class="dep-sub">
                  Reads <code>package.json</code> on the default branch, queries
                  the npm registry, and opens a PR with the bumps. On-demand
                  for now — background scheduling lands later.
                </p>
              </div>
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/dep-updater/run`}
              >
                <button type="submit" class="dep-hero-cta">
                  <IconPlay />
                  Run now
                </button>
              </form>
            </div>
          </section>

          <section class="dep-section">
            <header class="dep-section-head">
              <div>
                <h2 class="dep-section-title">
                  <span class="dep-section-title-icon" aria-hidden="true">
                    <IconHistory />
                  </span>
                  Recent runs
                  <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);font-weight:500;font-variant-numeric:tabular-nums">
                    {" "}({runs.length})
                  </span>
                </h2>
                <p class="dep-section-sub">
                  Latest 20 runs, newest first. Expand a run to inspect the
                  exact bumps it applied or attempted.
                </p>
              </div>
            </header>
            <div class="dep-section-body">
              {runs.length === 0 ? (
                <div class="dep-empty">
                  <div class="dep-empty-orb" aria-hidden="true" />
                  <div class="dep-empty-inner">
                    <div class="dep-empty-icon" aria-hidden="true">
                      <IconPackage />
                    </div>
                    <h3 class="dep-empty-title">No runs yet</h3>
                    <p class="dep-empty-sub">
                      Hit <em>Run now</em> above to start your first scan.
                      Results land here as soon as the orchestrator finishes.
                    </p>
                  </div>
                </div>
              ) : (
                <div class="dep-run-list">
                  {runs.map((r) => {
                    const applied = safeParseBumps(r.appliedBumps);
                    const attempted = safeParseBumps(r.attemptedBumps);
                    const bumps = applied.length > 0 ? applied : attempted;
                    const when = formatRelative(r.createdAt as unknown as string);
                    return (
                      <div class="dep-run-card">
                        <div class="dep-run-head">
                          {statusPill(r.status)}
                          <span class="dep-run-stamp">{when}</span>
                          {r.prNumber != null && (
                            <a
                              href={`/${ownerName}/${repoName}/pulls/${r.prNumber}`}
                              class="dep-run-pr"
                            >
                              PR #{r.prNumber}
                            </a>
                          )}
                          {r.branchName && (
                            <code class="dep-run-branch">{r.branchName}</code>
                          )}
                        </div>
                        {r.errorMessage && (
                          <div class="dep-run-err">{r.errorMessage}</div>
                        )}
                        {bumps.length > 0 && (
                          <details class="dep-bumps">
                            <summary>
                              {bumps.length} bump{bumps.length === 1 ? "" : "s"}
                            </summary>
                            <table class="dep-table">
                              <thead>
                                <tr>
                                  <th>Package</th>
                                  <th>From</th>
                                  <th>To</th>
                                  <th>Kind</th>
                                  <th>Major</th>
                                </tr>
                              </thead>
                              <tbody>
                                {bumps.map((b) => (
                                  <tr>
                                    <td>
                                      <span class="dep-pkg">{b.name}</span>
                                    </td>
                                    <td>
                                      <span class="dep-ver is-from">{b.from}</span>
                                    </td>
                                    <td>
                                      <span class="dep-ver">{b.to}</span>
                                    </td>
                                    <td>
                                      <span class="dep-kind-chip">{b.kind}</span>
                                    </td>
                                    <td>
                                      <span
                                        class={
                                          "dep-major " +
                                          (b.major ? "is-yes" : "is-no")
                                        }
                                      >
                                        {b.major ? "yes" : "no"}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: depStyles }} />
      </Layout>
    );
  }
);

// POST — fire and forget
depUpdater.post(
  "/:owner/:repo/settings/dep-updater/run",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if (resolved.kind === "response") return resolved.res;
    const { repo } = resolved;
    const user = c.get("user")!;

    // Fire-and-forget. The run records its own failures to `dep_update_runs`.
    runDepUpdateRun({
      repositoryId: repo.id,
      owner: ownerName,
      repo: repoName,
      userId: user.id,
    }).catch((err) => {
      console.error("[dep-updater] run failed:", err);
    });

    return c.redirect(`/${ownerName}/${repoName}/settings/dep-updater`);
  }
);

export default depUpdater;
