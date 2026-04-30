/**
 * Block J2 — Security advisory / dependabot-style alert routes.
 *
 *   GET  /:owner/:repo/security/advisories        — list open alerts
 *   GET  /:owner/:repo/security/advisories/all    — dismissed + fixed too
 *   POST /:owner/:repo/security/advisories/scan   — owner-only; re-scan
 *   POST /:owner/:repo/security/advisories/:id/dismiss
 *   POST /:owner/:repo/security/advisories/:id/reopen
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

function severityColor(sev: string): string {
  switch (sev) {
    case "critical":
      return "var(--red)";
    case "high":
      return "var(--red)";
    case "moderate":
      return "var(--yellow)";
    default:
      return "var(--text-muted)";
  }
}

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
      <div class="settings-container">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2 style="margin:0">Security advisories</h2>
          {isOwner && (
            <form
              method="post"
              action={`/${ownerName}/${repoName}/security/advisories/scan`}
            >
              <button type="submit" class="btn btn-primary btn-sm">
                Re-scan
              </button>
            </form>
          )}
        </div>
        <p style="color:var(--text-muted);margin-top:8px">
          Cross-references this repo's parsed dependency graph against a
          curated advisory database. Run <em>Reindex</em> on{" "}
          <a href={`/${ownerName}/${repoName}/dependencies`}>Dependencies</a>{" "}
          first if no alerts show up.
        </p>
        {message && (
          <div class="auth-success" style="margin-top:12px">
            {decodeURIComponent(message)}
          </div>
        )}
        {error && (
          <div class="auth-error" style="margin-top:12px">
            {decodeURIComponent(error)}
          </div>
        )}

        <div style="display:flex;gap:8px;margin:16px 0">
          <a
            href={`/${ownerName}/${repoName}/security/advisories`}
            class={`btn ${status === "open" ? "btn-primary" : ""}`}
          >
            Open
          </a>
          <a
            href={`/${ownerName}/${repoName}/security/advisories/all`}
            class={`btn ${status === "all" ? "btn-primary" : ""}`}
          >
            All
          </a>
        </div>

        {alerts.length === 0 ? (
          <div class="panel-empty" style="padding:24px">
            No {status === "open" ? "open " : ""}advisories.
            {isOwner &&
              status === "open" &&
              " Click Re-scan to check against the advisory database."}
          </div>
        ) : (
          <div class="panel">
            {alerts.map((a) => (
              <div
                class="panel-item"
                style="flex-direction:column;align-items:stretch;gap:6px"
              >
                <div
                  style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"
                >
                  <div style="min-width:0">
                    <span
                      style={`font-size:10px;padding:2px 6px;border-radius:3px;background:${severityColor(
                        a.advisory.severity
                      )};color:#fff;text-transform:uppercase;margin-right:6px`}
                    >
                      {a.advisory.severity}
                    </span>
                    <span style="font-weight:600">
                      {a.advisory.summary}
                    </span>
                  </div>
                  <div
                    style="font-size:10px;padding:2px 6px;border-radius:3px;background:var(--bg-subtle);text-transform:uppercase"
                  >
                    {a.status}
                  </div>
                </div>
                <div
                  style="font-size:12px;color:var(--text-muted);display:flex;gap:12px;flex-wrap:wrap"
                >
                  <span style="font-family:var(--font-mono)">
                    {a.advisory.ecosystem} · {a.dependencyName}
                    {a.dependencyVersion
                      ? ` ${a.dependencyVersion}`
                      : ""}
                  </span>
                  <span>affected: {a.advisory.affectedRange}</span>
                  {a.advisory.fixedVersion && (
                    <span>fixed in ≥ {a.advisory.fixedVersion}</span>
                  )}
                  <a
                    href={`/${ownerName}/${repoName}/blob/HEAD/${a.manifestPath}`}
                  >
                    {a.manifestPath}
                  </a>
                  {a.advisory.referenceUrl && (
                    <a
                      href={a.advisory.referenceUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {a.advisory.ghsaId || a.advisory.cveId || "ref"}
                    </a>
                  )}
                </div>
                {a.status === "dismissed" && a.dismissedReason && (
                  <div
                    style="font-size:12px;color:var(--text-muted);font-style:italic"
                  >
                    Dismissed: {a.dismissedReason}
                  </div>
                )}
                {isOwner && (
                  <div style="display:flex;gap:6px">
                    {a.status === "open" && (
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/security/advisories/${a.id}/dismiss`}
                        style="display:flex;gap:4px;align-items:center"
                      >
                        <input
                          type="text"
                          name="reason"
                          placeholder="reason (optional)"
                          maxLength={280}
                          aria-label="Dismiss reason"
                          style="font-size:12px;padding:4px 6px"
                        />
                        <button
                          type="submit"
                          class="btn btn-sm"
                          style="font-size:11px"
                        >
                          Dismiss
                        </button>
                      </form>
                    )}
                    {a.status === "dismissed" && (
                      <form
                        method="post"
                        action={`/${ownerName}/${repoName}/security/advisories/${a.id}/reopen`}
                      >
                        <button
                          type="submit"
                          class="btn btn-sm"
                          style="font-size:11px"
                        >
                          Reopen
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
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
    await seedAdvisories().catch(() => {});
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
