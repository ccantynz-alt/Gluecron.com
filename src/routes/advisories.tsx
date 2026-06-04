/**
 * Block J2 — Security advisory / dependabot-style alert routes.
 *
 *   GET  /:owner/:repo/security/advisories        — list open alerts
 *   GET  /:owner/:repo/security/advisories/all    — dismissed + fixed too
 *   POST /:owner/:repo/security/advisories/scan   — owner-only; re-scan
 *   POST /:owner/:repo/security/advisories/:id/dismiss
 *   POST /:owner/:repo/security/advisories/:id/reopen
 *
 * 2026 polish: gradient-hairline hero + radial orb + severity-pill cards.
 * Every class prefixed `.adv-` so this surface doesn't bleed. All data
 * fetches, queries, and actions preserved exactly.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { audit } from "../lib/notify";
import {
  dismissAlert,
  listAlertsForRepo,
  reopenAlert,
  scanRepositoryForAlerts,
  seedAdvisories,
} from "../lib/advisories";

const advisories = new Hono<AuthEnv>();
advisories.use("*", softAuth);

async function loadRepo(ownerName: string, repoName: string) {
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

/** Map advisory severity to a stable class key. */
function severityClass(sev: string): string {
  switch (sev) {
    case "critical":
      return "is-critical";
    case "high":
      return "is-high";
    case "moderate":
    case "medium":
      return "is-medium";
    case "low":
      return "is-low";
    default:
      return "is-low";
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.adv-`. Mirrors the gradient-hairline
 * hero + radial orb + per-card pattern from `admin-integrations` and
 * `admin-diagnose`. Severity colors:
 *   critical → red,  high → amber,  medium/moderate → yellow,  low → blue
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .adv-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  .adv-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adv-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .adv-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .adv-hero-inner { position: relative; z-index: 1; }
  .adv-hero-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .adv-hero-text { max-width: 720px; }
  .adv-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .adv-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .adv-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .adv-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .adv-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }
  .adv-sub a { color: var(--accent); text-decoration: none; }
  .adv-sub a:hover { text-decoration: underline; }

  .adv-rescan {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    border: none;
    border-radius: 10px;
    cursor: pointer;
    text-decoration: none;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .adv-rescan:hover { transform: translateY(-1px); box-shadow: 0 8px 22px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.18); }

  .adv-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .adv-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .adv-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  /* Healthy banner — green gradient checkmark. Shown when zero open alerts. */
  .adv-healthy {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: var(--space-4);
    padding: 14px 18px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(52,211,153,0.10), rgba(54,197,214,0.06));
    border: 1px solid rgba(52,211,153,0.32);
    color: #bbf7d0;
  }
  .adv-healthy-icon {
    flex: 0 0 auto;
    width: 36px; height: 36px;
    border-radius: 9999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #34d399 0%, #36c5d6 100%);
    color: #04231a;
    box-shadow: 0 0 0 4px rgba(52,211,153,0.16);
  }
  .adv-healthy-text { font-size: 14px; line-height: 1.45; }
  .adv-healthy-text strong { display: block; color: #d1fae5; font-weight: 700; font-size: 14.5px; margin-bottom: 2px; }
  .adv-healthy-text span { color: rgba(187,247,208,0.85); font-size: 12.5px; }

  /* Tab pills */
  .adv-tabs {
    display: inline-flex;
    gap: 4px;
    padding: 4px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-bottom: var(--space-4);
  }
  .adv-tab {
    padding: 7px 14px;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease;
  }
  .adv-tab:hover { color: var(--text); text-decoration: none; }
  .adv-tab.is-active {
    background: rgba(140,109,255,0.14);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }

  /* Card list */
  .adv-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .adv-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
  }
  .adv-card:hover {
    border-color: var(--border-strong, var(--border));
    transform: translateY(-1px);
    box-shadow: 0 6px 18px -10px rgba(0,0,0,0.45);
  }
  .adv-card.is-critical { border-color: rgba(248,113,113,0.40); }
  .adv-card.is-high { border-color: rgba(251,146,60,0.34); }
  .adv-card.is-medium { border-color: rgba(251,191,36,0.30); }
  .adv-card.is-low { border-color: rgba(96,165,250,0.30); }

  .adv-card-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .adv-card-id {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .adv-card-cve {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 5px;
    letter-spacing: 0.01em;
  }
  .adv-card-title {
    font-family: var(--font-display);
    font-size: 15.5px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.01em;
    line-height: 1.35;
    margin: 0 0 4px;
    word-break: break-word;
  }
  .adv-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px 18px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 12.5px;
  }
  .adv-card-meta-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .adv-card-meta-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    font-weight: 700;
  }
  .adv-card-meta-value {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
    word-break: break-word;
  }
  .adv-card-meta-value a {
    color: var(--accent);
    text-decoration: none;
  }
  .adv-card-meta-value a:hover { text-decoration: underline; }

  .adv-card-fixed {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #6ee7b7;
    background: rgba(52,211,153,0.10);
    border: 1px solid rgba(52,211,153,0.28);
  }

  .adv-card-dismissed {
    margin-top: 10px;
    padding: 8px 12px;
    font-size: 12.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-style: italic;
  }

  .adv-card-actions {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .adv-card-actions form {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
    flex-wrap: wrap;
  }
  .adv-card-actions input[type="text"] {
    padding: 6px 10px;
    font-size: 12.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 8px;
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    min-width: 200px;
  }
  .adv-card-actions input[type="text"]:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.45));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .adv-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 8px;
    cursor: pointer;
    text-decoration: none;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .adv-btn:hover {
    color: var(--text-strong);
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.08);
    text-decoration: none;
  }

  /* Severity pill — strong color signal at first glance. */
  .adv-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .adv-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .adv-pill.is-critical { background: rgba(248,113,113,0.16); color: #fca5a5; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.42); }
  .adv-pill.is-high { background: rgba(251,146,60,0.14); color: #fdba74; box-shadow: inset 0 0 0 1px rgba(251,146,60,0.36); }
  .adv-pill.is-medium { background: rgba(251,191,36,0.12); color: #fde68a; box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32); }
  .adv-pill.is-low { background: rgba(96,165,250,0.12); color: #93c5fd; box-shadow: inset 0 0 0 1px rgba(96,165,250,0.32); }

  /* Status pill (open / dismissed / fixed) */
  .adv-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .adv-status.is-dismissed { color: #cbd5e1; }
  .adv-status.is-fixed { color: #6ee7b7; border-color: rgba(52,211,153,0.32); background: rgba(52,211,153,0.10); }

  /* Empty state — dashed orb card */
  .adv-empty {
    position: relative;
    overflow: hidden;
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 16px;
    background: rgba(255,255,255,0.012);
    color: var(--text-muted);
  }
  .adv-empty::before {
    content: '';
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.14), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .adv-empty-inner { position: relative; z-index: 1; }
  .adv-empty strong {
    display: block;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin-bottom: 4px;
  }
  .adv-empty span { font-size: 13px; }
`;

// ---------- List ----------

async function renderList(
  c: any,
  ownerName: string,
  repoName: string,
  status: "open" | "all"
) {
  const ctx = await loadRepo(ownerName, repoName);
  if (!ctx) return c.notFound();
  const { repo } = ctx;
  const user = c.get("user");
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.notFound();
  }

  const isOwner = !!user && user.id === repo.ownerId;
  const alerts = await listAlertsForRepo(repo.id, status);
  const message = c.req.query("message");
  const error = c.req.query("error");

  return c.html(
    <Layout
      title={`Security advisories — ${ownerName}/${repoName}`}
      user={user}
    >
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="code" />

      <div class="adv-wrap">
        <section class="adv-hero">
          <div class="adv-hero-orb" aria-hidden="true" />
          <div class="adv-hero-inner">
            <div class="adv-hero-top">
              <div class="adv-hero-text">
                <div class="adv-eyebrow">
                  <span class="adv-eyebrow-dot" aria-hidden="true" />
                  Security advisories · {ownerName}/{repoName}
                </div>
                <h2 class="adv-title">
                  <span class="adv-title-grad">Known vulnerabilities.</span>
                </h2>
                <p class="adv-sub">
                  Cross-references this repo's parsed dependency graph against a
                  curated advisory database. Run <em>Reindex</em> on{" "}
                  <a href={`/${ownerName}/${repoName}/dependencies`}>
                    Dependencies
                  </a>{" "}
                  first if no alerts show up.
                </p>
              </div>
              {isOwner && (
                <form
                  method="post"
                  action={`/${ownerName}/${repoName}/security/advisories/scan`}
                  style="margin:0"
                >
                  <button type="submit" class="adv-rescan">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    Re-scan
                  </button>
                </form>
              )}
            </div>
          </div>
        </section>

        {message && (
          <div class="adv-banner is-ok">{decodeURIComponent(message)}</div>
        )}
        {error && (
          <div class="adv-banner is-error">{decodeURIComponent(error)}</div>
        )}

        {status === "open" && alerts.length === 0 && (
          <div class="adv-healthy" role="status">
            <span class="adv-healthy-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <div class="adv-healthy-text">
              <strong>Healthy</strong>
              <span>
                No open advisories.
                {isOwner && " Click Re-scan to check against the latest database."}
              </span>
            </div>
          </div>
        )}

        <nav class="adv-tabs" aria-label="Filter advisories">
          <a
            href={`/${ownerName}/${repoName}/security/advisories`}
            class={"adv-tab" + (status === "open" ? " is-active" : "")}
          >
            Open
          </a>
          <a
            href={`/${ownerName}/${repoName}/security/advisories/all`}
            class={"adv-tab" + (status === "all" ? " is-active" : "")}
          >
            All
          </a>
        </nav>

        {alerts.length === 0 ? (
          <div class="adv-empty">
            <div class="adv-empty-inner">
              <strong>No advisories</strong>
              <span>
                {status === "open"
                  ? "No open vulnerabilities right now."
                  : "Nothing in the advisory history."}
                {isOwner &&
                  status === "open" &&
                  " Click Re-scan to check against the advisory database."}
              </span>
            </div>
          </div>
        ) : (
          <div class="adv-list">
            {alerts.map((a) => {
              const sevClass = severityClass(a.advisory.severity);
              const idText =
                a.advisory.ghsaId || a.advisory.cveId || a.advisory.id || "ref";
              return (
                <article class={"adv-card " + sevClass}>
                  <div class="adv-card-head">
                    <div class="adv-card-id">
                      <span class={"adv-pill " + sevClass}>
                        <span class="dot" aria-hidden="true" />
                        {a.advisory.severity}
                      </span>
                      <span class="adv-card-cve">{idText}</span>
                    </div>
                    <span class={"adv-status is-" + a.status}>{a.status}</span>
                  </div>
                  <h3 class="adv-card-title">{a.advisory.summary}</h3>
                  <div class="adv-card-meta">
                    <div class="adv-card-meta-item">
                      <span class="adv-card-meta-label">Component</span>
                      <span class="adv-card-meta-value">
                        {a.advisory.ecosystem} · {a.dependencyName}
                        {a.dependencyVersion ? ` ${a.dependencyVersion}` : ""}
                      </span>
                    </div>
                    <div class="adv-card-meta-item">
                      <span class="adv-card-meta-label">Affected</span>
                      <span class="adv-card-meta-value">
                        {a.advisory.affectedRange}
                      </span>
                    </div>
                    {a.advisory.fixedVersion && (
                      <div class="adv-card-meta-item">
                        <span class="adv-card-meta-label">Fixed in</span>
                        <span class="adv-card-fixed">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          ≥ {a.advisory.fixedVersion}
                        </span>
                      </div>
                    )}
                    <div class="adv-card-meta-item">
                      <span class="adv-card-meta-label">Manifest</span>
                      <span class="adv-card-meta-value">
                        <a
                          href={`/${ownerName}/${repoName}/blob/HEAD/${a.manifestPath}`}
                        >
                          {a.manifestPath}
                        </a>
                      </span>
                    </div>
                    {a.advisory.referenceUrl && (
                      <div class="adv-card-meta-item">
                        <span class="adv-card-meta-label">Reference</span>
                        <span class="adv-card-meta-value">
                          <a
                            href={a.advisory.referenceUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            View details ↗
                          </a>
                        </span>
                      </div>
                    )}
                  </div>
                  {a.status === "dismissed" && a.dismissedReason && (
                    <div class="adv-card-dismissed">
                      Dismissed: {a.dismissedReason}
                    </div>
                  )}
                  {isOwner && (a.status === "open" || a.status === "dismissed") && (
                    <div class="adv-card-actions">
                      {a.status === "open" && (
                        <form
                          method="post"
                          action={`/${ownerName}/${repoName}/security/advisories/${a.id}/dismiss`}
                        >
                          <input
                            type="text"
                            name="reason"
                            placeholder="Reason (optional)"
                            maxLength={280}
                            aria-label="Dismiss reason"
                          />
                          <button type="submit" class="adv-btn">
                            Dismiss
                          </button>
                        </form>
                      )}
                      {a.status === "dismissed" && (
                        <form
                          method="post"
                          action={`/${ownerName}/${repoName}/security/advisories/${a.id}/reopen`}
                        >
                          <button type="submit" class="adv-btn">
                            Reopen
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
}

advisories.get("/:owner/:repo/security/advisories", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  return renderList(c, ownerName, repoName, "open");
});

advisories.get("/:owner/:repo/security/advisories/all", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  return renderList(c, ownerName, repoName, "all");
});

// ---------- Re-scan (owner-only) ----------

advisories.post(
  "/:owner/:repo/security/advisories/scan",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner: ownerName, repo: repoName } = c.req.param();
    const ctx = await loadRepo(ownerName, repoName);
    if (!ctx) return c.notFound();
    const { repo } = ctx;
    if (user.id !== repo.ownerId) {
      return c.redirect(
        `/${ownerName}/${repoName}/security/advisories?error=${encodeURIComponent(
          "Only the repo owner can scan"
        )}`
      );
    }
    await seedAdvisories().catch((err) => {
      console.warn(
        "[advisories] seedAdvisories failed:",
        err instanceof Error ? err.message : err
      );
    });
    const result = await scanRepositoryForAlerts(repo.id);
    await audit({
      userId: user.id,
      repositoryId: repo.id,
      action: "advisories.scan",
      metadata: result || {},
    });
    const to = `/${ownerName}/${repoName}/security/advisories`;
    if (!result) {
      return c.redirect(
        `${to}?error=${encodeURIComponent("Scan failed")}`
      );
    }
    const msg = `Scan complete — ${result.opened} new, ${result.closed} closed, ${result.matched} total matches.`;
    return c.redirect(`${to}?message=${encodeURIComponent(msg)}`);
  }
);

// ---------- Dismiss / reopen (owner-only) ----------

advisories.post(
  "/:owner/:repo/security/advisories/:id/dismiss",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner: ownerName, repo: repoName, id } = c.req.param();
    const ctx = await loadRepo(ownerName, repoName);
    if (!ctx) return c.notFound();
    const { repo } = ctx;
    if (user.id !== repo.ownerId) {
      return c.redirect(
        `/${ownerName}/${repoName}/security/advisories?error=${encodeURIComponent(
          "Only the repo owner can dismiss"
        )}`
      );
    }
    const body = await c.req.parseBody();
    const reason = String(body.reason || "").trim();
    const ok = await dismissAlert(id, repo.id, reason);
    await audit({
      userId: user.id,
      repositoryId: repo.id,
      action: "advisories.dismiss",
      targetId: id,
      metadata: { reason: reason || null },
    });
    const to = `/${ownerName}/${repoName}/security/advisories`;
    return c.redirect(
      `${to}?${ok ? "message" : "error"}=${encodeURIComponent(
        ok ? "Alert dismissed." : "Dismiss failed"
      )}`
    );
  }
);

advisories.post(
  "/:owner/:repo/security/advisories/:id/reopen",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner: ownerName, repo: repoName, id } = c.req.param();
    const ctx = await loadRepo(ownerName, repoName);
    if (!ctx) return c.notFound();
    const { repo } = ctx;
    if (user.id !== repo.ownerId) {
      return c.redirect(
        `/${ownerName}/${repoName}/security/advisories?error=${encodeURIComponent(
          "Only the repo owner can reopen"
        )}`
      );
    }
    const ok = await reopenAlert(id, repo.id);
    await audit({
      userId: user.id,
      repositoryId: repo.id,
      action: "advisories.reopen",
      targetId: id,
    });
    const to = `/${ownerName}/${repoName}/security/advisories`;
    return c.redirect(
      `${to}?${ok ? "message" : "error"}=${encodeURIComponent(
        ok ? "Alert reopened." : "Reopen failed"
      )}`
    );
  }
);

export default advisories;
