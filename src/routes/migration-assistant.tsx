/**
 * Major-version migration assistant UI.
 *
 *   GET  /:owner/:repo/migrations/propose           — picker form
 *   POST /:owner/:repo/migrations/propose           — drives proposeMajorMigration
 *
 * Owner-only. Renders the result inline (Claude's explanation + diff
 * preview + "Open PR" deep-link). Lives behind its own scoped `.migprop-*`
 * class system — does NOT touch layout/components/ui.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, pullRequests } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  proposeMajorMigration,
  findManifest,
  type ProposeMigrationResult,
} from "../lib/migration-assistant";
import { parseManifest } from "../lib/dep-updater";
import { resolveRef } from "../git/repository";

const migrationAssistant = new Hono<AuthEnv>();

migrationAssistant.use("*", softAuth);

/* ──────────────────────────────────────────────────────────────────────
 * Scoped CSS — `.migprop-*`. Gradient hairline + orb hero, polished
 * form, result panel. Never overrides layout primitives.
 * ────────────────────────────────────────────────────────────────── */
const migpropStyles = `
  .migprop-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .migprop-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .migprop-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .migprop-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .migprop-hero-inner { position: relative; z-index: 1; }
  .migprop-eyebrow {
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
  .migprop-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .migprop-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .migprop-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .migprop-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 640px;
  }
  .migprop-sub code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }

  /* ── Form card ── */
  .migprop-card {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .migprop-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.45;
    pointer-events: none;
  }
  .migprop-card-body { padding: var(--space-5) var(--space-5) var(--space-4); }
  .migprop-card-title {
    margin: 0 0 var(--space-2);
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .migprop-card-sub {
    margin: 0 0 var(--space-4);
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.45;
  }

  .migprop-fields {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: var(--space-3);
    align-items: end;
  }
  @media (max-width: 720px) {
    .migprop-fields { grid-template-columns: 1fr; }
  }
  .migprop-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .migprop-label {
    font-size: 12px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .migprop-input {
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 9px 11px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-strong);
    line-height: 1.3;
    outline: none;
    transition: border-color 100ms ease, background 100ms ease;
  }
  .migprop-input:focus {
    border-color: rgba(140,109,255,0.55);
    background: var(--bg-secondary);
  }

  .migprop-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: var(--space-4);
    flex-wrap: wrap;
  }
  .migprop-cta {
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
  .migprop-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .migprop-hint {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  /* ── Result panel ── */
  .migprop-result {
    margin-top: var(--space-5);
    padding: var(--space-5);
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--bg-elevated);
    position: relative;
    overflow: hidden;
  }
  .migprop-result::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #6ee7b7 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
  }
  .migprop-result-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 10px 0 6px;
  }
  .migprop-result-sub {
    margin: 0 0 var(--space-4);
    font-size: 13px;
    color: var(--text-muted);
  }
  .migprop-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: rgba(110,231,183,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(110,231,183,0.32);
  }
  .migprop-pill.is-error {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .migprop-explanation {
    margin: 0 0 var(--space-4);
    padding: var(--space-3);
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text);
    white-space: pre-wrap;
  }
  .migprop-meta {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-muted);
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .migprop-meta code {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    padding: 2px 7px;
    border-radius: 5px;
    border: 1px solid var(--border);
  }

  .migprop-notice {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .migprop-notice h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .migprop-notice p { color: var(--text-muted); margin: 0; font-size: 14px; }
`;

/**
 * Resolve repo row + enforce owner-only access. Mirrors the helper in
 * dep-updater.tsx so the two routes have identical permission semantics.
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
            <div class="migprop-wrap">
              <div class="migprop-notice">
                <h2>Unauthorized</h2>
                <p>Only the repository owner can request a migration plan.</p>
              </div>
            </div>
            <style dangerouslySetInnerHTML={{ __html: migpropStyles }} />
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
  } catch {
    return {
      kind: "response",
      res: c.html(
        <Layout title="Error" user={user}>
          <div class="migprop-wrap">
            <div class="migprop-notice">
              <h2>Service unavailable</h2>
              <p>The migration assistant is temporarily offline.</p>
            </div>
          </div>
          <style dangerouslySetInnerHTML={{ __html: migpropStyles }} />
        </Layout>,
        503
      ),
    };
  }
}

/**
 * Pull the manifest off the default branch + return a flat list of
 * declared deps for the autocomplete datalist. Failure is non-fatal —
 * the form still renders, just with an empty datalist.
 */
async function listDeclaredDeps(
  owner: string,
  name: string,
  branch: string
): Promise<Array<{ name: string; range: string; kind: "dep" | "dev" }>> {
  try {
    const baseSha = await resolveRef(owner, name, branch);
    if (!baseSha) return [];
    const manifest = await findManifest(owner, name, baseSha);
    if (!manifest || manifest.path !== "package.json") return [];
    const parsed = parseManifest(manifest.content);
    const all: Array<{ name: string; range: string; kind: "dep" | "dev" }> = [];
    for (const [n, r] of Object.entries(parsed.dependencies || {})) {
      all.push({ name: n, range: r, kind: "dep" });
    }
    for (const [n, r] of Object.entries(parsed.devDependencies || {})) {
      all.push({ name: n, range: r, kind: "dev" });
    }
    return all;
  } catch {
    return [];
  }
}

function HeroBlock({
  ownerName,
  repoName,
  dep,
}: {
  ownerName: string;
  repoName: string;
  dep?: string;
}) {
  return (
    <section class="migprop-hero">
      <div class="migprop-hero-orb" aria-hidden="true" />
      <div class="migprop-hero-inner">
        <div class="migprop-eyebrow">
          <span class="migprop-eyebrow-dot" aria-hidden="true" />
          {ownerName}/{repoName} · Migration assistant
        </div>
        <h1 class="migprop-title">
          <span class="migprop-title-grad">
            {dep ? `Migrate ${dep}` : "Migrate a dependency"}
          </span>
        </h1>
        <p class="migprop-sub">
          Tell us which package to upgrade and to which major. Claude reads
          your manifest + call-sites, drafts the upgrade as a PR, and
          updates tests along with the source.
        </p>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// GET — form
// ─────────────────────────────────────────────────────────────────────────

migrationAssistant.get(
  "/:owner/:repo/migrations/propose",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if (resolved.kind === "response") return resolved.res;
    const { repo } = resolved;
    const user = c.get("user")!;

    const branch = repo.defaultBranch || "main";
    const declared = await listDeclaredDeps(ownerName, repoName, branch);
    const prefill = c.req.query("dep") || "";

    return c.html(
      <Layout title={`Migrate dep — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <IssueNav owner={ownerName} repo={repoName} active="code" />
        <div class="migprop-wrap">
          <HeroBlock ownerName={ownerName} repoName={repoName} dep={prefill} />
          <section class="migprop-card">
            <div class="migprop-card-body">
              <h2 class="migprop-card-title">Get a migration plan</h2>
              <p class="migprop-card-sub">
                We'll detect uses in your tree, ask Claude for a patch set,
                and (if it returns one) open a PR labeled{" "}
                <code>ai:major-migration</code>. Server must have an{" "}
                <code>ANTHROPIC_API_KEY</code> configured.
              </p>
              <form
                method="post"
                action={`/${ownerName}/${repoName}/migrations/propose`}
              >
                <div class="migprop-fields">
                  <div class="migprop-field">
                    <label class="migprop-label" for="migprop-dep">
                      Dependency
                    </label>
                    <input
                      id="migprop-dep"
                      class="migprop-input"
                      type="text"
                      name="dependency"
                      list="migprop-deplist"
                      placeholder="hono"
                      value={prefill}
                      required
                      autocomplete="off"
                    />
                    <datalist id="migprop-deplist">
                      {declared.map((d) => (
                        <option value={d.name}>
                          {d.range} ({d.kind})
                        </option>
                      ))}
                    </datalist>
                  </div>
                  <div class="migprop-field">
                    <label class="migprop-label" for="migprop-from">
                      From
                    </label>
                    <input
                      id="migprop-from"
                      class="migprop-input"
                      type="text"
                      name="fromVersion"
                      placeholder="^3.0.0"
                      required
                    />
                  </div>
                  <div class="migprop-field">
                    <label class="migprop-label" for="migprop-to">
                      To
                    </label>
                    <input
                      id="migprop-to"
                      class="migprop-input"
                      type="text"
                      name="toVersion"
                      placeholder="4.0.0"
                      required
                    />
                  </div>
                </div>
                <div class="migprop-actions">
                  <button type="submit" class="migprop-cta">
                    Get migration plan
                  </button>
                  <span class="migprop-hint">
                    Opens a PR on success. Bypasses the 7-day throttle.
                  </span>
                </div>
              </form>
            </div>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: migpropStyles }} />
      </Layout>
    );
  }
);

// ─────────────────────────────────────────────────────────────────────────
// POST — run the assistant + render the result inline
// ─────────────────────────────────────────────────────────────────────────

migrationAssistant.post(
  "/:owner/:repo/migrations/propose",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if (resolved.kind === "response") return resolved.res;
    const { repo } = resolved;
    const user = c.get("user")!;

    const form = await c.req.parseBody();
    const dependency = String(form.dependency ?? "").trim();
    const fromVersion = String(form.fromVersion ?? "").trim();
    const toVersion = String(form.toVersion ?? "").trim();

    const renderError = (msg: string) =>
      c.html(
        <Layout title={`Migrate dep — ${ownerName}/${repoName}`} user={user}>
          <RepoHeader owner={ownerName} repo={repoName} />
          <IssueNav owner={ownerName} repo={repoName} active="code" />
          <div class="migprop-wrap">
            <HeroBlock
              ownerName={ownerName}
              repoName={repoName}
              dep={dependency}
            />
            <section class="migprop-result">
              <span class="migprop-pill is-error">Failed</span>
              <h2 class="migprop-result-title">
                Could not generate a migration plan
              </h2>
              <p class="migprop-result-sub">{msg}</p>
              <a
                class="migprop-cta"
                href={`/${ownerName}/${repoName}/migrations/propose`}
              >
                Try again
              </a>
            </section>
          </div>
          <style dangerouslySetInnerHTML={{ __html: migpropStyles }} />
        </Layout>
      );

    if (!dependency || !fromVersion || !toVersion) {
      return renderError("All three fields are required.");
    }

    const branch = repo.defaultBranch || "main";
    const baseSha = await resolveRef(ownerName, repoName, branch);
    if (!baseSha) {
      return renderError(
        `Could not resolve the default branch (\`${branch}\`).`
      );
    }

    let result: ProposeMigrationResult | null = null;
    try {
      result = await proposeMajorMigration({
        repositoryId: repo.id,
        dependency,
        fromVersion,
        toVersion,
        baseSha,
        // UI users explicitly want the migration; bypass the watcher's
        // 7-day cool-down.
        skipThrottle: true,
      });
    } catch (err) {
      console.error("[migrations] propose threw:", err);
      return renderError(
        "The migration assistant encountered an unexpected error."
      );
    }

    if (!result) {
      return renderError(
        "Claude did not return a usable patch. This usually means the model couldn't find safe, mechanical changes — try narrowing the scope or set ANTHROPIC_API_KEY if the server is missing it."
      );
    }

    // Look up the PR body so we can preview the explanation inline.
    let explanation = "";
    try {
      const [pr] = await db
        .select({ body: pullRequests.body })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repo.id),
            eq(pullRequests.number, result.prNumber)
          )
        )
        .limit(1);
      if (pr?.body) {
        // Extract the "### Summary" block. Best-effort — fall back to the
        // entire body when the marker isn't found.
        const match = pr.body.match(/### Summary\n([\s\S]*?)\n\n###/);
        explanation = match ? match[1].trim() : pr.body;
      }
    } catch {
      // ignore — we can still render the success page.
    }

    return c.html(
      <Layout title={`Migrate dep — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <IssueNav owner={ownerName} repo={repoName} active="code" />
        <div class="migprop-wrap">
          <HeroBlock
            ownerName={ownerName}
            repoName={repoName}
            dep={dependency}
          />
          <section class="migprop-result">
            <span class="migprop-pill">PR opened</span>
            <h2 class="migprop-result-title">Migration plan ready</h2>
            <p class="migprop-result-sub">
              Claude proposed a patch set for <code>{dependency}</code>{" "}
              {fromVersion} → {toVersion}. Review the diff and merge if the
              call-sites look right.
            </p>
            <div class="migprop-meta">
              <span>
                Branch: <code>{result.branch}</code>
              </span>
              <span>
                Base: <code>{branch}</code>
              </span>
              <span>
                PR: <code>#{result.prNumber}</code>
              </span>
            </div>
            {explanation ? (
              <div class="migprop-explanation">{explanation}</div>
            ) : null}
            <a
              class="migprop-cta"
              href={`/${ownerName}/${repoName}/pulls/${result.prNumber}`}
            >
              Open PR #{result.prNumber}
            </a>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: migpropStyles }} />
      </Layout>
    );
  }
);

export default migrationAssistant;
