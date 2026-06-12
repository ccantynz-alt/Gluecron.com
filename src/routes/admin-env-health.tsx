/**
 * /admin/env-health — environment / feature health panel.
 *
 *   GET /admin/env-health — table of every env-gated feature, grouped by
 *   severity (critical / recommended / optional), with green "Configured"
 *   / red "Missing" pills, the controlling env var names, and a one-line
 *   impact description.
 *
 * Makes silently-disabled features visible: today a dozen major features
 * quietly turn off when their env vars are unset and the operator has no
 * single place to see what's live. Data comes from
 * `collectEnvHealthWithDb()` in `src/lib/env-health.ts` — set/unset
 * booleans only, never the values.
 *
 * Gated by `isSiteAdmin` using the same `gate()` pattern as
 * `src/routes/admin.tsx`. Scoped CSS prefixed `.admin-envh-` to avoid
 * collisions with the parent admin polish.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import {
  collectEnvHealthWithDb,
  groupBySeverity,
  type EnvHealthSeverity,
} from "../lib/env-health";

const envHealth = new Hono<AuthEnv>();
envHealth.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.admin-envh-` so this surface can't
 * bleed into the wider admin panel. Mirrors the gradient-hairline hero +
 * table patterns from /admin and /admin/integrations.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .admin-envh-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .admin-envh-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .admin-envh-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .admin-envh-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .admin-envh-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .admin-envh-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .admin-envh-eyebrow .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .admin-envh-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .admin-envh-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .admin-envh-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }

  /* ─── Severity section headers ─── */
  .admin-envh-h3 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin: var(--space-5) 0 var(--space-3);
  }
  .admin-envh-h3 h3 {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.014em;
    margin: 0;
    color: var(--text-strong);
  }
  .admin-envh-h3-meta {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* ─── Table (mirrors .admin-ap-table from /admin) ─── */
  .admin-envh-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .admin-envh-table thead th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 10px 14px;
    background: rgba(255,255,255,0.015);
    border-bottom: 1px solid var(--border);
  }
  .admin-envh-table tbody td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 13px;
    color: var(--text);
    vertical-align: top;
  }
  .admin-envh-table tbody tr:last-child td { border-bottom: none; }
  .admin-envh-table code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .admin-envh-feature {
    font-weight: 600;
    color: var(--text-strong);
  }
  .admin-envh-impact { color: var(--text-muted); line-height: 1.45; }

  /* ─── Status pills ─── */
  .admin-envh-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .admin-envh-status.is-set {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .admin-envh-status.is-missing {
    background: rgba(248,113,113,0.10);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .admin-envh-status .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }

  .admin-envh-foot {
    margin-top: var(--space-5);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border-subtle);
    background: rgba(255,255,255,0.015);
    border-radius: 10px;
    color: var(--text-muted);
    font-size: 12.5px;
  }
  .admin-envh-foot a { color: var(--accent); text-decoration: none; }
  .admin-envh-foot a:hover { text-decoration: underline; }

  .admin-envh-403 {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .admin-envh-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .admin-envh-403 p { color: var(--text-muted); margin: 0; font-size: 14px; }

  @media (max-width: 720px) {
    .admin-envh-wrap { padding: var(--space-4) var(--space-3); }
    .admin-envh-hero { padding: var(--space-4); }
    .admin-envh-table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  }
`;

/** Human labels for the three severity buckets. */
const SEVERITY_LABELS: Record<EnvHealthSeverity, { title: string; blurb: string }> = {
  critical: {
    title: "Critical",
    blurb: "Core product surface degrades without these.",
  },
  recommended: {
    title: "Recommended",
    blurb: "Feature works, but in a degraded mode.",
  },
  optional: {
    title: "Optional",
    blurb: "Opt-ins and scale-out knobs.",
  },
};

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/env-health");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="admin-envh-403">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </Layout>,
      403
    );
  }
  return { user };
}

envHealth.get("/admin/env-health", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const items = await collectEnvHealthWithDb();
  const groups = groupBySeverity(items);
  const configured = items.filter((i) => i.configured).length;

  return c.html(
    <Layout title="Environment health — admin" user={user}>
      <div class="admin-envh-wrap">
        <section class="admin-envh-hero">
          <div class="admin-envh-hero-orb" aria-hidden="true" />
          <div class="admin-envh-hero-inner">
            <div class="admin-envh-eyebrow">
              <span class="pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
              </span>
              Environment health · Site admin · <span style="color:var(--accent);font-weight:600">{user.username}</span>
            </div>
            <h2 class="admin-envh-title">
              <span class="admin-envh-title-grad">What's actually on.</span>
            </h2>
            <p class="admin-envh-sub">
              Every feature that silently turns off when its env vars are
              unset — in one place. {configured} of {items.length} live.
              Only set/unset is shown; values never leave the server.
            </p>
          </div>
        </section>

        {groups.map(({ severity, items: rows }) => {
          const label = SEVERITY_LABELS[severity];
          const live = rows.filter((r) => r.configured).length;
          return (
            <>
              <div class="admin-envh-h3">
                <h3>{label.title}</h3>
                <span class="admin-envh-h3-meta">
                  {label.blurb} · {live}/{rows.length} configured
                </span>
              </div>
              <table class="admin-envh-table">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>Status</th>
                    <th>Env vars</th>
                    <th>When missing</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr>
                      <td class="admin-envh-feature">{item.feature}</td>
                      <td>
                        <span
                          class={
                            "admin-envh-status " +
                            (item.configured ? "is-set" : "is-missing")
                          }
                        >
                          <span class="dot" aria-hidden="true" />
                          {item.configured ? "Configured" : "Missing"}
                        </span>
                      </td>
                      <td>
                        {item.envVars.map((v, i) => (
                          <>
                            {i > 0 && " "}
                            <code>{v}</code>
                          </>
                        ))}
                      </td>
                      <td class="admin-envh-impact">{item.impact}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          );
        })}

        <div class="admin-envh-foot">
          Most keys can be set without a restart on{" "}
          <a href="/admin/integrations">/admin/integrations</a> · Google
          OAuth credentials saved at{" "}
          <a href="/admin/google-oauth">/admin/google-oauth</a> also satisfy
          the Google login check · runtime checks live on{" "}
          <a href="/admin/health">/admin/health</a>.
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </Layout>
  );
});

export default envHealth;
