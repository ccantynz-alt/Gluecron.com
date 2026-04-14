/**
 * Global search — across repos, users, issues, PRs.
 *
 *   GET /search?q=...&type=repos|users|issues|prs
 *
 * Text search uses Postgres ILIKE — good enough for the scale GlueCron is at
 * today. If traffic grows, swap in pgvector + AI embeddings.
 */

import { Hono } from "hono";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoCard } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getUnreadCount } from "../lib/unread";

const search = new Hono<AuthEnv>();
search.use("*", softAuth);

search.get("/search", async (c) => {
  const user = c.get("user");
  const q = (c.req.query("q") || "").trim();
  const type = c.req.query("type") || "repos";
  const unread = user ? await getUnreadCount(user.id) : 0;

  let repoHits: Array<{
    repo: typeof repositories.$inferSelect;
    ownerName: string;
  }> = [];
  let userHits: Array<typeof users.$inferSelect> = [];
  let issueHits: Array<{
    id: string;
    number: number;
    title: string;
    state: string;
    repoName: string;
    repoOwner: string;
  }> = [];
  let prHits: Array<{
    id: string;
    number: number;
    title: string;
    state: string;
    repoName: string;
    repoOwner: string;
  }> = [];

  if (q) {
    const pat = `%${q}%`;
    if (type === "repos") {
      const results = await db
        .select({ repo: repositories, ownerName: users.username })
        .from(repositories)
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(
          and(
            eq(repositories.isPrivate, false),
            sql`(${repositories.name} ILIKE ${pat} OR ${repositories.description} ILIKE ${pat})`
          )
        )
        .orderBy(desc(repositories.starCount))
        .limit(30);
      repoHits = results;
    } else if (type === "users") {
      userHits = await db
        .select()
        .from(users)
        .where(
          sql`(${users.username} ILIKE ${pat} OR ${users.displayName} ILIKE ${pat})`
        )
        .limit(30);
    } else if (type === "issues") {
      issueHits = await db
        .select({
          id: issues.id,
          number: issues.number,
          title: issues.title,
          state: issues.state,
          repoName: repositories.name,
          repoOwner: users.username,
        })
        .from(issues)
        .innerJoin(repositories, eq(issues.repositoryId, repositories.id))
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(
          and(
            eq(repositories.isPrivate, false),
            sql`(${issues.title} ILIKE ${pat} OR ${issues.body} ILIKE ${pat})`
          )
        )
        .orderBy(desc(issues.updatedAt))
        .limit(30);
    } else if (type === "prs") {
      prHits = await db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          state: pullRequests.state,
          repoName: repositories.name,
          repoOwner: users.username,
        })
        .from(pullRequests)
        .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(
          and(
            eq(repositories.isPrivate, false),
            sql`(${pullRequests.title} ILIKE ${pat} OR ${pullRequests.body} ILIKE ${pat})`
          )
        )
        .orderBy(desc(pullRequests.updatedAt))
        .limit(30);
    }
  }

  const tab = (id: string, label: string) => (
    <a
      href={`/search?q=${encodeURIComponent(q)}&type=${id}`}
      class={type === id ? "active" : ""}
    >
      {label}
    </a>
  );

  return c.html(
    <Layout
      title={q ? `Search — ${q}` : "Search"}
      user={user}
      notificationCount={unread}
    >
      <form method="GET" action="/search" style="margin-bottom: 16px">
        <input
          type="hidden"
          name="type"
          value={type}
        />
        <input
          type="search"
          name="q"
          value={q}
          placeholder="Search repositories, users, issues, PRs…"
          style="width: 100%; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px"
          autofocus
        />
      </form>

      <div class="issue-tabs" style="margin-bottom: 20px">
        {tab("repos", "Repositories")}
        {tab("users", "Users")}
        {tab("issues", "Issues")}
        {tab("prs", "Pull requests")}
      </div>

      {!q && (
        <div class="empty-state">
          <p>Type to search across GlueCron.</p>
        </div>
      )}

      {q && type === "repos" && (
        repoHits.length === 0 ? (
          <div class="empty-state"><p>No repositories match "{q}"</p></div>
        ) : (
          <div class="card-grid">
            {repoHits.map(({ repo, ownerName }) => (
              <RepoCard repo={repo} ownerName={ownerName} />
            ))}
          </div>
        )
      )}

      {q && type === "users" && (
        userHits.length === 0 ? (
          <div class="empty-state"><p>No users match "{q}"</p></div>
        ) : (
          <div class="panel">
            {userHits.map((u) => (
              <div class="panel-item">
                <div class="dot blue"></div>
                <div style="flex: 1">
                  <a href={`/${u.username}`} style="font-weight: 600">
                    {u.displayName || u.username}
                  </a>
                  <div class="meta">@{u.username}</div>
                  {u.bio && <div class="meta">{u.bio}</div>}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {q && type === "issues" && (
        issueHits.length === 0 ? (
          <div class="empty-state"><p>No issues match "{q}"</p></div>
        ) : (
          <div class="panel">
            {issueHits.map((i) => (
              <div class="panel-item">
                <div
                  class={`dot ${i.state === "open" ? "green" : "yellow"}`}
                ></div>
                <div style="flex: 1">
                  <a
                    href={`/${i.repoOwner}/${i.repoName}/issues/${i.number}`}
                  >
                    {i.title}
                  </a>
                  <div class="meta">
                    {i.repoOwner}/{i.repoName}#{i.number} · {i.state}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {q && type === "prs" && (
        prHits.length === 0 ? (
          <div class="empty-state"><p>No pull requests match "{q}"</p></div>
        ) : (
          <div class="panel">
            {prHits.map((pr) => (
              <div class="panel-item">
                <div
                  class={`dot ${pr.state === "open" ? "green" : pr.state === "merged" ? "blue" : "yellow"}`}
                ></div>
                <div style="flex: 1">
                  <a
                    href={`/${pr.repoOwner}/${pr.repoName}/pull/${pr.number}`}
                  >
                    {pr.title}
                  </a>
                  <div class="meta">
                    {pr.repoOwner}/{pr.repoName}#{pr.number} · {pr.state}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </Layout>
  );
});

// Keyboard shortcuts help page — linked from Cmd+? in nav
search.get("/shortcuts", async (c) => {
  const user = c.get("user");
  const unread = user ? await getUnreadCount(user.id) : 0;
  const shortcuts: Array<{ keys: string; desc: string }> = [
    { keys: "/", desc: "Focus global search" },
    { keys: "Cmd/Ctrl + K", desc: "Open AI assistant" },
    { keys: "g d", desc: "Go to dashboard" },
    { keys: "g n", desc: "Go to notifications" },
    { keys: "g e", desc: "Go to explore" },
    { keys: "n", desc: "New repository" },
    { keys: "?", desc: "Show this help" },
  ];

  return c.html(
    <Layout title="Keyboard shortcuts" user={user} notificationCount={unread}>
      <h2 style="margin-bottom: 16px">Keyboard shortcuts</h2>
      <div class="panel">
        {shortcuts.map((s) => (
          <div class="panel-item" style="justify-content: space-between">
            <span>{s.desc}</span>
            <kbd
              style="font-family: var(--font-mono); background: var(--bg-tertiary); padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 12px"
            >
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </Layout>
  );
});

export default search;
