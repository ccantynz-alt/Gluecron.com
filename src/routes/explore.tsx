/**
 * Explore page — discover public repositories, search, trending.
 */

import { Hono } from "hono";
import { eq, desc, sql, like, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, repoTopics } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoCard } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  Flex,
  Grid,
  Badge,
  Button,
  LinkButton,
  Input,
  EmptyState,
  PageHeader,
} from "../views/ui";

const explore = new Hono<AuthEnv>();

explore.use("*", softAuth);

explore.get("/explore", async (c) => {
  const user = c.get("user");
  const q = c.req.query("q") || "";
  const sort = c.req.query("sort") || "recent";
  const topic = c.req.query("topic") || "";

  let repoList: Array<{
    repo: typeof repositories.$inferSelect;
    ownerName: string;
  }> = [];

  if (q.trim()) {
    // Search repos
    const results = await db
      .select({
        repo: repositories,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(
          eq(repositories.isPrivate, false),
          sql`(${repositories.name} ILIKE ${'%' + q + '%'} OR ${repositories.description} ILIKE ${'%' + q + '%'})`
        )
      )
      .orderBy(desc(repositories.starCount))
      .limit(50);

    repoList = results.map((r) => ({
      repo: r.repo,
      ownerName: r.ownerName,
    }));
  } else if (topic) {
    // Filter by topic
    const results = await db
      .select({
        repo: repositories,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .innerJoin(repoTopics, eq(repoTopics.repositoryId, repositories.id))
      .where(
        and(
          eq(repositories.isPrivate, false),
          eq(repoTopics.topic, topic.toLowerCase())
        )
      )
      .orderBy(desc(repositories.starCount))
      .limit(50);

    repoList = results.map((r) => ({
      repo: r.repo,
      ownerName: r.ownerName,
    }));
  } else {
    // Default: recent or popular
    const orderBy =
      sort === "stars"
        ? desc(repositories.starCount)
        : sort === "forks"
          ? desc(repositories.forkCount)
          : desc(repositories.createdAt);

    const results = await db
      .select({
        repo: repositories,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.isPrivate, false))
      .orderBy(orderBy)
      .limit(50);

    repoList = results.map((r) => ({
      repo: r.repo,
      ownerName: r.ownerName,
    }));
  }

  return c.html(
    <Layout title="Explore" user={user}>
      <PageHeader title="Explore repositories" />
      <Flex gap={12} wrap align="center" style="margin-bottom:24px">
        <form
          method="get"
          action="/explore"
          style="display:flex;gap:8px;flex:1;min-width:250px"
        >
          <Input
            name="q"
            value={q}
            placeholder="Search repositories..."
            style="flex:1;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:14px"
          />
          <Button type="submit" variant="primary">
            Search
          </Button>
        </form>
        <Flex gap={8}>
          <LinkButton
            href="/explore?sort=recent"
            size="sm"
            variant={sort === "recent" && !q ? "primary" : "default"}
          >
            Recent
          </LinkButton>
          <LinkButton
            href="/explore?sort=stars"
            size="sm"
            variant={sort === "stars" ? "primary" : "default"}
          >
            Most stars
          </LinkButton>
          <LinkButton
            href="/explore?sort=forks"
            size="sm"
            variant={sort === "forks" ? "primary" : "default"}
          >
            Most forks
          </LinkButton>
        </Flex>
      </Flex>
      {topic && (
        <div style="margin-bottom:16px">
          <Badge style="font-size:14px;padding:4px 12px">
            Topic: {topic}
          </Badge>
          <a
            href="/explore"
            style="margin-left:8px;font-size:13px;color:var(--text-muted)"
          >
            Clear
          </a>
        </div>
      )}
      {repoList.length === 0 ? (
        <EmptyState>
          <p>
            {q
              ? `No repositories matching "${q}"`
              : "No public repositories yet."}
          </p>
        </EmptyState>
      ) : (
        <Grid>
          {repoList.map(({ repo, ownerName }) => (
            <RepoCard repo={repo} ownerName={ownerName} />
          ))}
        </Grid>
      )}
    </Layout>
  );
});

export default explore;
