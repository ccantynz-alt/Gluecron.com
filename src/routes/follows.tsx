/**
 * Block J4 — User following routes.
 *
 *   POST /:user/follow                — auth required
 *   POST /:user/unfollow              — auth required
 *   GET  /:user/followers             — public list
 *   GET  /:user/following             — public list
 *   GET  /feed                        — auth required, personalised activity
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  describeAction,
  feedForUser,
  followCounts,
  followUser,
  isFollowing,
  listFollowers,
  listFollowing,
  resolveUserByName,
  unfollowUser,
} from "../lib/follows";
import { audit } from "../lib/notify";

const follows = new Hono<AuthEnv>();
follows.use("*", softAuth);

const RESERVED = new Set([
  "login",
  "register",
  "logout",
  "new",
  "settings",
  "api",
  "feed",
  "dashboard",
  "explore",
  "search",
  "notifications",
  "admin",
  "orgs",
  "gists",
  "marketplace",
  "sponsors",
  "developer",
  "ask",
  "help",
]);

function profileUrl(username: string): string {
  return `/${username}`;
}

// ---------- Follow / unfollow ----------

follows.post("/:user/follow", requireAuth, async (c) => {
  const me = c.get("user")!;
  const targetName = c.req.param("user");
  if (RESERVED.has(targetName)) return c.notFound();
  const target = await resolveUserByName(targetName);
  if (!target) return c.notFound();
  const res = await followUser(me.id, target.id);
  if (res === "ok") {
    await audit({
      userId: me.id,
      action: "user.follow",
      targetId: target.id,
      metadata: { username: target.username },
    });
  }
  return c.redirect(profileUrl(targetName));
});

follows.post("/:user/unfollow", requireAuth, async (c) => {
  const me = c.get("user")!;
  const targetName = c.req.param("user");
  if (RESERVED.has(targetName)) return c.notFound();
  const target = await resolveUserByName(targetName);
  if (!target) return c.notFound();
  const ok = await unfollowUser(me.id, target.id);
  if (ok) {
    await audit({
      userId: me.id,
      action: "user.unfollow",
      targetId: target.id,
      metadata: { username: target.username },
    });
  }
  return c.redirect(profileUrl(targetName));
});

// ---------- Lists ----------

async function renderUserList(
  c: any,
  ownerName: string,
  mode: "followers" | "following"
) {
  const user = c.get("user");
  if (RESERVED.has(ownerName)) return c.notFound();
  const target = await resolveUserByName(ownerName);
  if (!target) return c.notFound();
  const list =
    mode === "followers"
      ? await listFollowers(target.id)
      : await listFollowing(target.id);
  const counts = await followCounts(target.id);

  return c.html(
    <Layout
      title={`${mode === "followers" ? "Followers" : "Following"} — ${ownerName}`}
      user={user}
    >
      <div class="settings-container">
        <h2 style="margin:0">
          <a href={`/${ownerName}`} style="text-decoration:none">
            @{ownerName}
          </a>
        </h2>
        <div style="display:flex;gap:16px;margin:10px 0 20px">
          <a
            href={`/${ownerName}/followers`}
            class={mode === "followers" ? "btn btn-primary" : "btn"}
          >
            Followers <span style="opacity:.7">({counts.followers})</span>
          </a>
          <a
            href={`/${ownerName}/following`}
            class={mode === "following" ? "btn btn-primary" : "btn"}
          >
            Following <span style="opacity:.7">({counts.following})</span>
          </a>
        </div>
        {list.length === 0 ? (
          <div class="panel-empty" style="padding:24px">
            No {mode}.
          </div>
        ) : (
          <div class="panel">
            {list.map((u) => (
              <div class="panel-item">
                <a href={`/${u.username}`} style="font-weight:600">
                  @{u.username}
                </a>
                {u.displayName && (
                  <span style="color:var(--text-muted);margin-left:8px">
                    {u.displayName}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

follows.get("/:user/followers", async (c) =>
  renderUserList(c, c.req.param("user"), "followers")
);
follows.get("/:user/following", async (c) =>
  renderUserList(c, c.req.param("user"), "following")
);

// ---------- Personalised feed ----------

follows.get("/feed", requireAuth, async (c) => {
  const user = c.get("user")!;
  const entries = await feedForUser(user.id, 50);
  return c.html(
    <Layout title="Feed" user={user}>
      <div class="settings-container">
        <h2>Your feed</h2>
        <p style="color:var(--text-muted)">
          Recent activity from users you follow. Follow someone from their
          profile page to start filling this up.
        </p>
        {entries.length === 0 ? (
          <div class="panel-empty" style="padding:24px">
            Nothing here yet. Try the{" "}
            <a href="/explore">explore page</a> to find people to follow.
          </div>
        ) : (
          <div class="panel">
            {entries.map((e) => {
              const repoUrl = `/${e.ownerUsername}/${e.repository.name}`;
              return (
                <div class="panel-item" style="flex-direction:column;align-items:stretch;gap:2px">
                  <div>
                    <a href={`/${e.actor.username}`} style="font-weight:600">
                      @{e.actor.username}
                    </a>{" "}
                    <span style="color:var(--text-muted)">
                      {describeAction(e.activity.action)}
                    </span>{" "}
                    <a href={repoUrl} style="font-weight:600">
                      {e.ownerUsername}/{e.repository.name}
                    </a>
                  </div>
                  <div
                    style="font-size:12px;color:var(--text-muted)"
                  >
                    {new Date(e.activity.createdAt).toLocaleString()}
                    {e.activity.targetType === "issue" &&
                      e.activity.targetId && (
                        <>
                          {" "}
                          ·{" "}
                          <a
                            href={`${repoUrl}/issues/${e.activity.targetId}`}
                          >
                            #{e.activity.targetId}
                          </a>
                        </>
                      )}
                    {e.activity.targetType === "pr" &&
                      e.activity.targetId && (
                        <>
                          {" "}
                          ·{" "}
                          <a href={`${repoUrl}/pulls/${e.activity.targetId}`}>
                            #{e.activity.targetId}
                          </a>
                        </>
                      )}
                    {e.activity.targetType === "commit" &&
                      e.activity.targetId && (
                        <>
                          {" "}
                          ·{" "}
                          <a
                            href={`${repoUrl}/commit/${e.activity.targetId}`}
                            class="commit-sha"
                          >
                            {String(e.activity.targetId).slice(0, 7)}
                          </a>
                        </>
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

export default follows;

// Exported for profile page use (web.tsx).
export { isFollowing, followCounts, resolveUserByName };
