/**
 * Block J13 — Pinned repos management UI.
 *
 *   GET  /settings/pins  — pick up to 6 repos to feature on your profile
 *   POST /settings/pins  — save the selection (replaces prior set)
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  MAX_PINS,
  listPinCandidates,
  listPinnedForUser,
  setPinsForUser,
} from "../lib/pinned-repos";

const pins = new Hono<AuthEnv>();

pins.get("/settings/pins", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  const [pinned, candidates] = await Promise.all([
    listPinnedForUser(user.id),
    listPinCandidates(user.id),
  ]);
  const pinnedIds = new Set(pinned.map((p) => p.repositoryId));
  const error = c.req.query("error");
  const saved = c.req.query("saved") === "1";

  return c.html(
    <Layout title="Pinned repositories" user={user}>
      <h2>Pinned repositories</h2>
      <p style="color: var(--text-muted); max-width: 620px">
        Choose up to {MAX_PINS} repositories to feature at the top of your
        profile. They appear in the order you select them.
      </p>

      {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
      {saved && (
        <div
          style="padding: 10px 12px; background: rgba(63, 185, 80, 0.1); border: 1px solid var(--green); color: var(--green); border-radius: var(--radius); margin: 12px 0"
        >
          Saved.
        </div>
      )}

      <form method="POST" action="/settings/pins" style="margin-top: 16px">
        {candidates.length === 0 ? (
          <div class="empty-state">
            <p>You don't own any repositories yet.</p>
          </div>
        ) : (
          <ul
            style="list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px"
            data-testid="pin-candidates"
          >
            {candidates.map((c) => (
              <li
                style="border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; background: var(--bg-secondary)"
              >
                <label
                  style="display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 13px"
                >
                  <input
                    type="checkbox"
                    name="repoId"
                    value={c.id}
                    checked={pinnedIds.has(c.id)}
                  />
                  <span style="flex: 1">
                    <strong>{c.name}</strong>
                    {c.isPrivate && (
                      <span
                        style="margin-left: 6px; font-size: 10px; padding: 1px 6px; border-radius: 10px; background: rgba(139, 148, 158, 0.15); color: var(--text-muted); text-transform: uppercase"
                      >
                        Private
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div style="margin-top: 16px; display: flex; gap: 8px; align-items: center">
          <button type="submit" class="btn btn-primary">
            Save pinned repositories
          </button>
          <span style="color: var(--text-muted); font-size: 12px">
            The first {MAX_PINS} you tick are kept.
          </span>
        </div>
      </form>

      {pinned.length > 0 && (
        <div style="margin-top: 28px">
          <h3>Current pins (preview)</h3>
          <ul
            style="list-style: none; padding: 0; margin: 8px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px"
          >
            {pinned.map((p) => (
              <li
                style="border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px"
              >
                <div>
                  <a href={`/${p.ownerUsername}/${p.name}`}>
                    <strong>{p.ownerUsername}/{p.name}</strong>
                  </a>
                </div>
                {p.description && (
                  <div style="color: var(--text-muted); font-size: 12px; margin-top: 4px">
                    {p.description}
                  </div>
                )}
                <div style="color: var(--text-muted); font-size: 11px; margin-top: 6px">
                  {p.starCount} {"\u2605"} · {p.forkCount} forks
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Layout>
  );
});

pins.post("/settings/pins", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  const form = await c.req.parseBody({ all: true });
  const raw = form.repoId;
  const ids: string[] = Array.isArray(raw)
    ? raw.map((x) => String(x))
    : raw != null
      ? [String(raw)]
      : [];
  await setPinsForUser(user.id, ids);
  return c.redirect("/settings/pins?saved=1");
});

export default pins;
