/**
 * Multi-repo refactor agent — UI + API.
 *
 * One file owns both surfaces because they share the same `planRefactor` /
 * `executeRefactor` / `getRefactor` helpers from `src/lib/multi-repo-refactor.ts`
 * and we don't want to fragment the auth / styling story across two route
 * files. The mount in `src/app.tsx` is a single `app.route("/", refactorRoutes)`.
 *
 * UI surface (`/refactors`):
 *   GET  /refactors          — list a user's refactors with status pills.
 *   POST /refactors          — accepts the textarea + repo-multi-select form,
 *                              kicks off planning, redirects to /refactors/:id.
 *   GET  /refactors/:id      — per-refactor detail page: PR table, status
 *                              pills, links into each repo's /pulls page.
 *   POST /refactors/:id/execute — kicks off the per-repo PR fan-out.
 *
 * API surface (`/api/v2/refactors`):
 *   POST /api/v2/refactors                — create refactor + plan
 *   POST /api/v2/refactors/:id/execute    — kick off per-repo PRs
 *   GET  /api/v2/refactors/:id            — current state
 *
 * Hard rules respected:
 *   - Shared layout + nav untouched (we only added the `/refactors` nav link
 *     in layout.tsx).
 *   - All CSS scoped under `.refac-*`.
 *   - Reuses helpers from `ai-patch-generator` and `spec-to-pr` via the
 *     shared `ai-client.ts` + `git/repository.ts` modules.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  executeRefactor,
  getRefactor,
  listRefactorsForUser,
  planRefactor,
} from "../lib/multi-repo-refactor";

const refactors = new Hono<AuthEnv>();

// All surfaces require an authenticated user.
refactors.use("/refactors", softAuth, requireAuth);
refactors.use("/refactors/*", softAuth, requireAuth);
refactors.use("/api/v2/refactors", softAuth, requireAuth);
refactors.use("/api/v2/refactors/*", softAuth, requireAuth);

// ---------------------------------------------------------------------------
// Scoped CSS — every class is `.refac-*`.
// ---------------------------------------------------------------------------
const refacStyles = `
  .refac-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  .refac-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .refac-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.78;
    pointer-events: none;
  }
  .refac-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.24), rgba(54,197,214,0.12) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.78;
    pointer-events: none;
    z-index: 0;
  }
  .refac-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .refac-eyebrow {
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
  .refac-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .refac-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .refac-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .refac-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  .refac-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    margin-bottom: var(--space-3);
  }
  .refac-card-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }
  .refac-card-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
  }
  .refac-card-title a { color: inherit; text-decoration: none; }
  .refac-card-title a:hover { color: #8c6dff; }
  .refac-card-meta {
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .refac-card-desc {
    color: var(--text);
    font-size: 14px;
    line-height: 1.55;
    margin: 0;
  }

  .refac-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text-muted);
  }
  .refac-pill.is-planning { color: #36c5d6; border-color: rgba(54,197,214,0.35); background: rgba(54,197,214,0.08); }
  .refac-pill.is-building { color: #a48bff; border-color: rgba(140,109,255,0.35); background: rgba(140,109,255,0.08); }
  .refac-pill.is-ready_for_review { color: #4ade80; border-color: rgba(74,222,128,0.35); background: rgba(74,222,128,0.08); }
  .refac-pill.is-merged { color: #4ade80; border-color: rgba(74,222,128,0.45); background: rgba(74,222,128,0.12); }
  .refac-pill.is-failed { color: #fca5a5; border-color: rgba(252,165,165,0.35); background: rgba(252,165,165,0.08); }
  .refac-pill.is-pending { color: var(--text-muted); }
  .refac-pill.is-opened { color: #4ade80; border-color: rgba(74,222,128,0.35); background: rgba(74,222,128,0.08); }

  /* New-refactor form */
  .refac-form {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5);
    margin-bottom: var(--space-5);
  }
  .refac-form label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .refac-form textarea {
    width: 100%;
    min-height: 90px;
    padding: 12px 14px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
  }
  .refac-form-row { margin-bottom: var(--space-3); }
  .refac-repos-list {
    max-height: 240px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 12px;
    background: var(--bg);
  }
  .refac-repos-list label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 13px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text);
  }
  .refac-actions { display: flex; gap: 10px; align-items: center; }
  .refac-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 8px;
    font-weight: 600;
    font-size: 13px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    text-decoration: none;
  }
  .refac-btn-primary {
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    border-color: transparent;
    color: #fff;
  }
  .refac-btn-primary:hover { filter: brightness(1.05); }

  /* Per-refactor detail table */
  .refac-pr-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .refac-pr-table th, .refac-pr-table td {
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .refac-pr-table th {
    background: var(--bg);
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .refac-pr-table tr:last-child td { border-bottom: none; }
  .refac-pr-error {
    margin-top: 4px;
    font-size: 11px;
    color: #fca5a5;
    font-family: var(--font-mono);
  }

  .refac-empty {
    text-align: center;
    padding: var(--space-5);
    background: var(--bg-elevated);
    border: 1px dashed var(--border);
    border-radius: 14px;
    color: var(--text-muted);
  }
`;

function statusLabel(status: string): string {
  // Render the underlying status string verbatim, but capitalise the
  // first letter so the UI looks tidy. Keep snake_case readable.
  if (!status) return "—";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function Pill({ status }: { status: string }) {
  return (
    <span class={`refac-pill is-${status}`}>
      {statusLabel(status)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// UI: GET /refactors — list + new-refactor form
// ---------------------------------------------------------------------------
refactors.get("/refactors", async (c) => {
  const user = c.get("user")!;
  const list = await listRefactorsForUser(user.id);

  // Load every repo the user owns to populate the multi-select.
  let userRepos: Array<{ id: string; name: string }> = [];
  try {
    userRepos = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(eq(repositories.ownerId, user.id))
      .orderBy(repositories.name);
  } catch {
    userRepos = [];
  }

  return c.html(
    <Layout title="Refactor across repos" user={user}>
      <div class="refac-wrap">
        <section class="refac-hero">
          <div class="refac-hero-orb" aria-hidden="true" />
          <div class="refac-hero-inner">
            <div class="refac-eyebrow">
              <span class="refac-eyebrow-dot" aria-hidden="true" />
              Multi-repo refactor agent
            </div>
            <h1 class="refac-title">
              <span class="refac-title-grad">Refactor across repos</span>
            </h1>
            <p class="refac-sub">
              One English request. Coordinated PRs across every affected
              repo. Click into a refactor to see the per-repo PR status and
              merge them as a single logical change.
            </p>
          </div>
        </section>

        <form class="refac-form" method="post" action="/refactors">
          <div class="refac-form-row">
            <label for="description">Describe the refactor</label>
            <textarea
              id="description"
              name="description"
              placeholder="e.g. rename `getUserById` to `findUser` across all my repos"
              required
            />
          </div>
          <div class="refac-form-row">
            <label>Repos to include</label>
            <div class="refac-repos-list">
              {userRepos.length === 0 ? (
                <span style="color: var(--text-muted); font-size: 13px;">
                  You don't own any repositories yet.
                </span>
              ) : (
                userRepos.map((r) => (
                  <label>
                    <input
                      type="checkbox"
                      name="repositoryIds"
                      value={r.id}
                      checked
                    />
                    {r.name}
                  </label>
                ))
              )}
            </div>
          </div>
          <div class="refac-actions">
            <button type="submit" class="refac-btn refac-btn-primary">
              Plan refactor
            </button>
          </div>
        </form>

        <h2 style="font-family: var(--font-display); font-size: 20px; margin: var(--space-4) 0 var(--space-3);">
          Your refactors
        </h2>

        {list.length === 0 ? (
          <div class="refac-empty">
            No refactors yet — kick one off above.
          </div>
        ) : (
          list.map((r) => (
            <article class="refac-card">
              <div class="refac-card-head">
                <h3 class="refac-card-title">
                  <a href={`/refactors/${r.id}`}>{r.title}</a>
                </h3>
                <Pill status={r.status} />
              </div>
              <p class="refac-card-desc">
                {r.description.length > 240
                  ? r.description.slice(0, 237) + "..."
                  : r.description}
              </p>
              <div class="refac-card-meta">
                {new Date(r.createdAt).toLocaleString()}
              </div>
            </article>
          ))
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: refacStyles }} />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// UI: POST /refactors — plan handler
// ---------------------------------------------------------------------------
refactors.post("/refactors", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const description = String(body.description || "").trim();
  const repoIdsRaw = body.repositoryIds;
  const repositoryIds = Array.isArray(repoIdsRaw)
    ? repoIdsRaw.map(String)
    : repoIdsRaw
    ? [String(repoIdsRaw)]
    : undefined;

  if (!description) {
    return c.redirect("/refactors");
  }

  const res = await planRefactor({
    userId: user.id,
    description,
    repositoryIds,
  });
  if (!res.ok) {
    return c.html(
      <Layout title="Refactor failed" user={user}>
        <div class="refac-wrap">
          <section class="refac-hero">
            <div class="refac-hero-orb" aria-hidden="true" />
            <div class="refac-hero-inner">
              <h1 class="refac-title">Could not plan refactor</h1>
              <p class="refac-sub">{res.error}</p>
              <p>
                <a href="/refactors" class="refac-btn">Back to refactors</a>
              </p>
            </div>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: refacStyles }} />
      </Layout>,
      400
    );
  }
  return c.redirect(`/refactors/${res.refactor.id}`);
});

// ---------------------------------------------------------------------------
// UI: GET /refactors/:id — detail page
// ---------------------------------------------------------------------------
refactors.get("/refactors/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const data = await getRefactor(id, { userId: user.id });
  if (!data) return c.notFound();

  return c.html(
    <Layout title={data.refactor.title} user={user}>
      <div class="refac-wrap">
        <section class="refac-hero">
          <div class="refac-hero-orb" aria-hidden="true" />
          <div class="refac-hero-inner">
            <div class="refac-eyebrow">
              <span class="refac-eyebrow-dot" aria-hidden="true" />
              Multi-repo refactor · <Pill status={data.refactor.status} />
            </div>
            <h1 class="refac-title">
              <span class="refac-title-grad">{data.refactor.title}</span>
            </h1>
            <p class="refac-sub">{data.refactor.description}</p>
          </div>
        </section>

        {data.refactor.status === "planning" && (
          <form method="post" action={`/refactors/${data.refactor.id}/execute`}>
            <div class="refac-actions" style="margin-bottom: var(--space-4);">
              <button type="submit" class="refac-btn refac-btn-primary">
                Execute — open PRs in every repo
              </button>
            </div>
          </form>
        )}

        <table class="refac-pr-table">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Status</th>
              <th>PR</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.children.map((c) => (
              <tr>
                <td>
                  {c.repoOwner && c.repoName ? (
                    <a href={`/${c.repoOwner}/${c.repoName}`}>
                      {c.repoOwner}/{c.repoName}
                    </a>
                  ) : (
                    <span style="color: var(--text-muted);">(repo deleted)</span>
                  )}
                </td>
                <td>
                  <Pill status={c.status} />
                  {c.errorMessage && (
                    <div class="refac-pr-error">{c.errorMessage}</div>
                  )}
                </td>
                <td>
                  {c.prNumber != null && c.repoOwner && c.repoName ? (
                    <a
                      href={`/${c.repoOwner}/${c.repoName}/pull/${c.prNumber}`}
                    >
                      #{c.prNumber}
                    </a>
                  ) : (
                    <span style="color: var(--text-muted);">—</span>
                  )}
                </td>
                <td style="color: var(--text-muted); font-size: 12px;">
                  {new Date(c.updatedAt).toLocaleString()}
                </td>
              </tr>
            ))}
            {data.children.length === 0 && (
              <tr>
                <td colspan={4} style="text-align: center; padding: var(--space-4); color: var(--text-muted);">
                  No repos in this refactor.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <style dangerouslySetInnerHTML={{ __html: refacStyles }} />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// UI: POST /refactors/:id/execute — execute handler
// ---------------------------------------------------------------------------
refactors.post("/refactors/:id/execute", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  // Defence-in-depth: only the owner can execute.
  const owned = await getRefactor(id, { userId: user.id });
  if (!owned) return c.notFound();

  await executeRefactor({ refactorId: id });
  return c.redirect(`/refactors/${id}`);
});

// ---------------------------------------------------------------------------
// API: POST /api/v2/refactors — create + plan
// ---------------------------------------------------------------------------
refactors.post("/api/v2/refactors", async (c) => {
  const user = c.get("user")!;
  let body: { description?: unknown; repositoryIds?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const repositoryIds = Array.isArray(body.repositoryIds)
    ? body.repositoryIds.filter((x): x is string => typeof x === "string")
    : undefined;
  if (!description) {
    return c.json({ error: "description required" }, 400);
  }

  const res = await planRefactor({
    userId: user.id,
    description,
    repositoryIds,
  });
  if (!res.ok) return c.json({ error: res.error }, 400);
  return c.json(
    {
      refactor: res.refactor,
      plan: res.plan,
    },
    201
  );
});

// ---------------------------------------------------------------------------
// API: POST /api/v2/refactors/:id/execute
// ---------------------------------------------------------------------------
refactors.post("/api/v2/refactors/:id/execute", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const owned = await getRefactor(id, { userId: user.id });
  if (!owned) return c.json({ error: "not found" }, 404);

  const res = await executeRefactor({ refactorId: id });
  if (!res.ok) return c.json({ error: res.error }, 400);
  return c.json({
    refactor: res.refactor,
    children: res.children,
  });
});

// ---------------------------------------------------------------------------
// API: GET /api/v2/refactors/:id
// ---------------------------------------------------------------------------
refactors.get("/api/v2/refactors/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const data = await getRefactor(id, { userId: user.id });
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json(data);
});

export default refactors;
