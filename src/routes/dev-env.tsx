/**
 * Cloud dev environment routes (migration 0072).
 *
 *   GET  /:owner/:repo/dev                  — UI; full-screen iframe when ready
 *   POST /api/v2/repos/:owner/:repo/dev/start
 *   POST /api/v2/repos/:owner/:repo/dev/stop
 *   GET  /api/v2/repos/:owner/:repo/dev/status
 *
 * The UI page is server-rendered through the shared Layout. All custom CSS
 * is scoped under `.dev-env-*` so we don't accidentally bleed into the
 * locked layout / components / ui sheets.
 *
 * For non-ready statuses (cold / warming / failed) the page polls the
 * status JSON every 2s and re-renders on transition. Ready collapses the
 * page chrome and renders a single full-screen iframe pointing at the
 * VS Code Server URL.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  resolveRepoAccess,
  satisfiesAccess,
} from "../middleware/repo-access";
import { Layout } from "../views/layout";
import {
  buildDevEnvUrl,
  devEnvStatusLabel,
  getDevEnv,
  getDevEnvForOwner,
  normalizeMachineSize,
  recordActivity,
  startDevEnv,
  stopDevEnv,
  type DevEnvStatus,
} from "../lib/dev-env";
import type { DevEnv } from "../db/schema";

const devEnvRoutes = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Scoped CSS — every class prefixed `.dev-env-*`
// ---------------------------------------------------------------------------

const devEnvStyles = `
  .dev-env-wrap {
    max-width: 880px;
    margin: 0 auto;
    padding: var(--space-6, 32px) var(--space-4, 24px);
  }

  .dev-env-card {
    position: relative;
    padding: clamp(28px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .dev-env-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .dev-env-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 12px;
  }
  .dev-env-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .dev-env-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 4vw, 32px);
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1.1;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .dev-env-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0 0 var(--space-4);
    line-height: 1.55;
  }
  .dev-env-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 6px;
    color: var(--text-strong);
  }

  .dev-env-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text);
    margin-bottom: var(--space-4);
  }
  .dev-env-pill .dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: var(--text-muted);
  }
  .dev-env-pill.is-cold .dot { background: #64748b; }
  .dev-env-pill.is-warming .dot {
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    animation: devEnvPulse 1.4s ease-in-out infinite;
  }
  .dev-env-pill.is-ready .dot { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.6); }
  .dev-env-pill.is-failed .dot { background: #f85149; box-shadow: 0 0 8px rgba(248,81,73,0.6); }
  .dev-env-pill.is-stopped .dot { background: #94a3b8; }
  @keyframes devEnvPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50%      { transform: scale(1.35); opacity: 0.6; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dev-env-pill.is-warming .dot { animation: none; }
  }

  .dev-env-progress {
    position: relative;
    width: 100%;
    height: 6px;
    background: var(--bg-secondary);
    border-radius: 9999px;
    overflow: hidden;
    margin: var(--space-3) 0 var(--space-4);
  }
  .dev-env-progress-bar {
    position: absolute;
    inset: 0;
    width: 35%;
    background: linear-gradient(90deg, #8c6dff 0%, #36c5d6 100%);
    border-radius: inherit;
    animation: devEnvSlide 1.6s ease-in-out infinite;
  }
  @keyframes devEnvSlide {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(286%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dev-env-progress-bar { animation: none; width: 60%; }
  }

  .dev-env-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-top: var(--space-4);
  }
  .dev-env-cta {
    appearance: none;
    border: 1px solid rgba(140,109,255,0.45);
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    padding: 11px 20px;
    border-radius: 11px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    letter-spacing: -0.005em;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease;
  }
  .dev-env-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 24px -10px rgba(140,109,255,0.55);
    filter: brightness(1.06);
  }
  .dev-env-cta-secondary {
    appearance: none;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    padding: 10px 16px;
    border-radius: 11px;
    font-size: 14px;
    font-family: inherit;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center;
  }
  .dev-env-cta-secondary:hover {
    border-color: var(--accent);
    color: var(--text-strong);
  }

  .dev-env-error {
    position: relative;
    padding: 14px 16px 14px 44px;
    margin: var(--space-3) 0 var(--space-4);
    border-radius: 12px;
    border: 1px solid rgba(248, 81, 73, 0.32);
    background: linear-gradient(180deg, rgba(248,81,73,0.06) 0%, var(--bg-elevated) 100%);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
    word-break: break-word;
  }
  .dev-env-error::before {
    content: '';
    position: absolute;
    left: 14px; top: 18px;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: radial-gradient(circle, #f85149 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(248,81,73,0.5);
  }

  .dev-env-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3);
    margin-top: var(--space-4);
    font-size: 13px;
  }
  .dev-env-meta-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .dev-env-meta-label {
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    font-family: var(--font-mono);
  }
  .dev-env-meta-value {
    color: var(--text-strong);
    font-weight: 600;
    word-break: break-all;
  }

  /* Full-screen iframe shell for the ready state. */
  .dev-env-shell {
    position: fixed;
    inset: 0;
    background: var(--bg);
    z-index: 9999;
    display: flex;
    flex-direction: column;
  }
  .dev-env-shell-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 8px 16px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
  }
  .dev-env-shell-bar .dev-env-shell-title {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--text-strong);
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .dev-env-shell-iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: var(--bg);
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRepoForUser(
  ownerName: string,
  repoName: string
): Promise<{
  ownerId: string;
  ownerName: string;
  repoId: string;
  repoName: string;
  devEnabled: boolean;
  isPrivate: boolean;
} | null> {
  try {
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
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return null;
    return {
      ownerId: owner.id,
      ownerName: owner.username,
      repoId: repo.id,
      repoName: repo.name,
      devEnabled: !!(repo as { devEnvsEnabled?: boolean }).devEnvsEnabled,
      isPrivate: !!(repo as { isPrivate?: boolean }).isPrivate,
    };
  } catch {
    return null;
  }
}

function jsonShape(row: DevEnv | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    statusLabel: devEnvStatusLabel(row.status),
    previewUrl: row.previewUrl || buildDevEnvUrl(row.id),
    machineSize: row.machineSize,
    idleMinutes: row.idleMinutes,
    lastActiveAt: row.lastActiveAt?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null,
    errorMessage: row.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// Cold / warming / failed UI pieces (server-rendered JSX) — broken out so
// the GET route stays readable.
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: string }) {
  const cls = `dev-env-pill is-${status}`;
  return (
    <span class={cls}>
      <span class="dot" aria-hidden="true" />
      {devEnvStatusLabel(status)}
    </span>
  );
}

function MetaGrid({ env }: { env: DevEnv }) {
  return (
    <div class="dev-env-meta" aria-label="Environment metadata">
      <div class="dev-env-meta-row">
        <span class="dev-env-meta-label">Machine</span>
        <span class="dev-env-meta-value">{env.machineSize}</span>
      </div>
      <div class="dev-env-meta-row">
        <span class="dev-env-meta-label">Idle timeout</span>
        <span class="dev-env-meta-value">{env.idleMinutes}m</span>
      </div>
      <div class="dev-env-meta-row">
        <span class="dev-env-meta-label">URL</span>
        <span class="dev-env-meta-value">
          {(env.previewUrl || buildDevEnvUrl(env.id)).replace(
            /^https?:\/\//,
            ""
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GET /:owner/:repo/dev
// ---------------------------------------------------------------------------

devEnvRoutes.get("/:owner/:repo/dev", softAuth, async (c) => {
  const ownerName = c.req.param("owner");
  const repoName = c.req.param("repo");
  const user = c.get("user");
  const csrf = c.get("csrfToken") as string | undefined;

  const resolved = await resolveRepoForUser(ownerName, repoName);
  if (!resolved) return c.notFound();

  // Gate: resolve the viewer's access level.
  const access = await resolveRepoAccess({
    repoId: resolved.repoId,
    userId: user?.id ?? null,
    isPublic: !resolved.isPrivate,
  });

  // Private repo with no access → 404 (don't leak the repo exists).
  if (!satisfiesAccess(access, "read")) {
    return c.notFound();
  }

  // Unauthenticated visitor on a public repo: redirect to login so they can
  // get their own dev env session.
  if (!user) {
    return c.redirect(
      `/login?next=${encodeURIComponent(`/${resolved.ownerName}/${resolved.repoName}/dev`)}`
    );
  }

  // Render a "disabled" notice if the repo hasn't opted in. Owners get a
  // direct link to flip the toggle.
  if (!resolved.devEnabled) {
    const isOwner = user && user.id === resolved.ownerId;
    return c.html(
      <Layout
        title={`Dev env — ${resolved.ownerName}/${resolved.repoName}`}
        user={user ?? null}
      >
        <style dangerouslySetInnerHTML={{ __html: devEnvStyles }} />
        <div class="dev-env-wrap">
          <div class="dev-env-card">
            <div class="dev-env-eyebrow">
              <span class="dev-env-eyebrow-dot" aria-hidden="true" />
              Cloud dev env · disabled
            </div>
            <h1 class="dev-env-title">Dev environments are off for this repo</h1>
            <p class="dev-env-sub">
              {isOwner ? (
                <>
                  Flip <code>dev_envs_enabled</code> on in repository
                  settings to get a hosted VS Code IDE in the browser for
                  this repo. Default is off because each environment burns
                  a container.
                </>
              ) : (
                <>
                  The owner of <code>{resolved.ownerName}/{resolved.repoName}</code>{" "}
                  hasn&apos;t enabled cloud dev environments yet.
                </>
              )}
            </p>
            <div class="dev-env-actions">
              {isOwner && (
                <a
                  href={`/${resolved.ownerName}/${resolved.repoName}/settings#dev-envs`}
                  class="dev-env-cta"
                >
                  Open repo settings &rarr;
                </a>
              )}
              <a
                href={`/${resolved.ownerName}/${resolved.repoName}`}
                class="dev-env-cta-secondary"
              >
                Back to repo
              </a>
            </div>
          </div>
        </div>
      </Layout>
    );
  }

  const env = await getDevEnvForOwner(resolved.repoId, user.id);

  // Record activity if there's a live row — every page hit counts.
  if (env) {
    void recordActivity(env.id);
  }

  // No env yet — render a start button.
  if (!env) {
    return c.html(
      <Layout
        title={`Dev env — ${resolved.ownerName}/${resolved.repoName}`}
        user={user}
      >
        <style dangerouslySetInnerHTML={{ __html: devEnvStyles }} />
        <div class="dev-env-wrap">
          <div class="dev-env-card">
            <div class="dev-env-eyebrow">
              <span class="dev-env-eyebrow-dot" aria-hidden="true" />
              Cloud dev env
            </div>
            <h1 class="dev-env-title">
              Spin up a hosted VS Code for{" "}
              {resolved.ownerName}/{resolved.repoName}
            </h1>
            <p class="dev-env-sub">
              Get a full VS Code IDE in your browser, backed by a cold-start
              container. We read <code>.gluecron/dev.yml</code> from your
              repo for the image, install steps, and recommended
              extensions. Idle envs stop themselves after{" "}
              <strong>30 minutes</strong>.
            </p>
            <form
              method="post"
              action={`/api/v2/repos/${resolved.ownerName}/${resolved.repoName}/dev/start`}
            >
              {csrf && <input type="hidden" name="_csrf" value={csrf} />}
              <div class="dev-env-actions">
                <button type="submit" class="dev-env-cta">
                  Start dev env &rarr;
                </button>
                <a
                  href={`/${resolved.ownerName}/${resolved.repoName}`}
                  class="dev-env-cta-secondary"
                >
                  Cancel
                </a>
              </div>
            </form>
          </div>
        </div>
      </Layout>
    );
  }

  // Ready — render full-screen iframe.
  if (env.status === "ready" && env.previewUrl) {
    return c.html(
      <Layout
        title={`Dev — ${resolved.ownerName}/${resolved.repoName}`}
        user={user}
      >
        <style dangerouslySetInnerHTML={{ __html: devEnvStyles }} />
        <div class="dev-env-shell" role="region" aria-label="Cloud dev environment">
          <div class="dev-env-shell-bar">
            <span class="dev-env-shell-title">
              <StatusPill status="ready" />
              {resolved.ownerName}/{resolved.repoName}
            </span>
            <form
              method="post"
              action={`/api/v2/repos/${resolved.ownerName}/${resolved.repoName}/dev/stop`}
              style="margin:0"
            >
              {csrf && <input type="hidden" name="_csrf" value={csrf} />}
              <button type="submit" class="dev-env-cta-secondary">
                Stop env
              </button>
            </form>
          </div>
          <iframe
            class="dev-env-shell-iframe"
            src={env.previewUrl}
            title={`VS Code Server — ${resolved.ownerName}/${resolved.repoName}`}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        </div>
      </Layout>
    );
  }

  // Warming / cold / failed / stopped — render status page with poll script.
  const statusBody =
    env.status === "failed" ? (
      <>
        <p class="dev-env-sub">
          Something went wrong while spinning up the container. Hit{" "}
          <strong>Retry</strong> below to start fresh.
        </p>
        {env.errorMessage && (
          <div class="dev-env-error" role="alert">
            {env.errorMessage}
          </div>
        )}
        <form
          method="post"
          action={`/api/v2/repos/${resolved.ownerName}/${resolved.repoName}/dev/start`}
          style="margin:0"
        >
          {csrf && <input type="hidden" name="_csrf" value={csrf} />}
          <div class="dev-env-actions">
            <button type="submit" class="dev-env-cta">
              Retry &rarr;
            </button>
            <a
              href={`/${resolved.ownerName}/${resolved.repoName}`}
              class="dev-env-cta-secondary"
            >
              Back to repo
            </a>
          </div>
        </form>
      </>
    ) : env.status === "stopped" ? (
      <>
        <p class="dev-env-sub">
          Your environment is stopped. Click below to warm it back up — the
          URL stays the same and your files persist.
        </p>
        <form
          method="post"
          action={`/api/v2/repos/${resolved.ownerName}/${resolved.repoName}/dev/start`}
          style="margin:0"
        >
          {csrf && <input type="hidden" name="_csrf" value={csrf} />}
          <div class="dev-env-actions">
            <button type="submit" class="dev-env-cta">
              Warm up &rarr;
            </button>
          </div>
        </form>
      </>
    ) : (
      <>
        <p class="dev-env-sub">
          Starting your dev env... we&apos;re pulling the image, installing
          deps, and bringing VS Code Server online. Usually under a minute.
        </p>
        <div
          class="dev-env-progress"
          role="progressbar"
          aria-label="Warming dev environment"
          aria-valuetext="In progress"
        >
          <div class="dev-env-progress-bar" />
        </div>
        <noscript>
          <p class="dev-env-sub">
            Enable JavaScript for live updates, or refresh manually.
          </p>
        </noscript>
      </>
    );

  const pollScript = `
    (function(){
      var url = "/api/v2/repos/${resolved.ownerName}/${resolved.repoName}/dev/status";
      function tick(){
        fetch(url, { credentials: "same-origin" })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if(j && j.env && (j.env.status === "ready" || j.env.status === "failed")){
              window.location.reload();
            }
          })
          .catch(function(){ /* ignore */ });
      }
      setInterval(tick, 2000);
    })();
  `;

  return c.html(
    <Layout
      title={`Dev env — ${resolved.ownerName}/${resolved.repoName}`}
      user={user}
    >
      <style dangerouslySetInnerHTML={{ __html: devEnvStyles }} />
      <div class="dev-env-wrap">
        <div class="dev-env-card">
          <div class="dev-env-eyebrow">
            <span class="dev-env-eyebrow-dot" aria-hidden="true" />
            Cloud dev env
          </div>
          <h1 class="dev-env-title">
            {resolved.ownerName}/{resolved.repoName}
          </h1>
          <StatusPill status={env.status} />
          {statusBody}
          <MetaGrid env={env} />
        </div>
      </div>
      {env.status === "warming" || env.status === "cold" ? (
        <script dangerouslySetInnerHTML={{ __html: pollScript }} />
      ) : null}
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// API: POST /api/v2/repos/:owner/:repo/dev/start
// ---------------------------------------------------------------------------

devEnvRoutes.post(
  "/api/v2/repos/:owner/:repo/dev/start",
  softAuth,
  requireAuth,
  async (c) => {
    const ownerName = c.req.param("owner");
    const repoName = c.req.param("repo");
    const user = c.get("user")!;
    const resolved = await resolveRepoForUser(ownerName, repoName);
    if (!resolved) return c.json({ ok: false, error: "Repo not found" }, 404);

    // Require at least write access to start a dev env.
    const access = await resolveRepoAccess({
      repoId: resolved.repoId,
      userId: user.id,
      isPublic: !resolved.isPrivate,
    });
    if (!satisfiesAccess(access, "write")) {
      return c.json({ ok: false, error: "Insufficient access" }, 403);
    }

    // Parse machine_size from either form body or JSON body, leniently.
    let machineSize: string | undefined;
    try {
      const ct = c.req.header("content-type") || "";
      if (ct.includes("application/json")) {
        const body = (await c.req.json().catch(() => null)) as
          | { machineSize?: string; machine_size?: string }
          | null;
        machineSize = body?.machineSize ?? body?.machine_size;
      } else {
        const body = await c.req.parseBody().catch(() => ({}) as any);
        machineSize = (body.machine_size || body.machineSize) as
          | string
          | undefined;
      }
    } catch {
      /* ignore */
    }

    const result = await startDevEnv({
      repositoryId: resolved.repoId,
      ownerUserId: user.id,
      machineSize: normalizeMachineSize(machineSize),
    });

    if (!result.ok) {
      // For browser form posts, redirect back with an error in the URL;
      // for API clients (Accept: application/json), return JSON.
      const wantsJson =
        (c.req.header("accept") || "").includes("application/json") ||
        (c.req.header("content-type") || "").includes("application/json");
      const status =
        result.reason === "repo_not_found"
          ? 404
          : result.reason === "not_opted_in"
          ? 403
          : result.reason === "invalid_input"
          ? 400
          : 500;
      if (wantsJson) {
        return c.json({ ok: false, error: result.reason }, status);
      }
      return c.redirect(
        `/${resolved.ownerName}/${resolved.repoName}/dev?error=${result.reason}`
      );
    }

    const wantsJson =
      (c.req.header("accept") || "").includes("application/json") ||
      (c.req.header("content-type") || "").includes("application/json");
    if (wantsJson) {
      return c.json({ ok: true, env: jsonShape(result.env) });
    }
    return c.redirect(`/${resolved.ownerName}/${resolved.repoName}/dev`);
  }
);

// ---------------------------------------------------------------------------
// API: POST /api/v2/repos/:owner/:repo/dev/stop
// ---------------------------------------------------------------------------

devEnvRoutes.post(
  "/api/v2/repos/:owner/:repo/dev/stop",
  softAuth,
  requireAuth,
  async (c) => {
    const ownerName = c.req.param("owner");
    const repoName = c.req.param("repo");
    const user = c.get("user")!;
    const resolved = await resolveRepoForUser(ownerName, repoName);
    if (!resolved) return c.json({ ok: false, error: "Repo not found" }, 404);

    // Require at least write access to stop a dev env.
    const access = await resolveRepoAccess({
      repoId: resolved.repoId,
      userId: user.id,
      isPublic: !resolved.isPrivate,
    });
    if (!satisfiesAccess(access, "write")) {
      return c.json({ ok: false, error: "Insufficient access" }, 403);
    }

    const env = await getDevEnvForOwner(resolved.repoId, user.id);
    if (!env) {
      const wantsJson =
        (c.req.header("accept") || "").includes("application/json");
      if (wantsJson) return c.json({ ok: true, env: null });
      return c.redirect(`/${resolved.ownerName}/${resolved.repoName}/dev`);
    }
    await stopDevEnv(env.id);
    const after = await getDevEnv(env.id);
    const wantsJson = (c.req.header("accept") || "").includes(
      "application/json"
    );
    if (wantsJson) return c.json({ ok: true, env: jsonShape(after) });
    return c.redirect(`/${resolved.ownerName}/${resolved.repoName}/dev`);
  }
);

// ---------------------------------------------------------------------------
// API: GET /api/v2/repos/:owner/:repo/dev/status
// ---------------------------------------------------------------------------

devEnvRoutes.get(
  "/api/v2/repos/:owner/:repo/dev/status",
  softAuth,
  requireAuth,
  async (c) => {
    const ownerName = c.req.param("owner");
    const repoName = c.req.param("repo");
    const user = c.get("user")!;
    const resolved = await resolveRepoForUser(ownerName, repoName);
    if (!resolved) return c.json({ ok: false, error: "Repo not found" }, 404);
    const env = await getDevEnvForOwner(resolved.repoId, user.id);
    if (env) {
      void recordActivity(env.id);
    }
    return c.json({ ok: true, env: jsonShape(env) });
  }
);

export default devEnvRoutes;

// Re-export so tests can stub without the path string lottery.
export type { DevEnvStatus };
