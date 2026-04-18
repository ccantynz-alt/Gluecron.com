/**
 * Block D6 — "Explain this codebase" route.
 *
 *   GET  /:owner/:repo/explain                 — render cached (or freshly
 *                                                 generated on first visit)
 *                                                 Markdown explanation
 *   POST /:owner/:repo/explain/regenerate      — owner-only; force-regenerate
 *                                                 and redirect back
 *
 * Heavy lifting lives in `lib/ai-explain.ts`; this file is just HTTP glue.
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getDefaultBranch, resolveRef } from "../git/repository";
import {
  explainCodebase,
  getCachedExplanation,
} from "../lib/ai-explain";

const aiExplainRoutes = new Hono<AuthEnv>();

interface ResolvedRepo {
  ownerId: string;
  ownerUsername: string;
  repoId: string;
  repoName: string;
}

async function resolveRepo(
  ownerName: string,
  repoName: string
): Promise<ResolvedRepo | null> {
  try {
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerRow) return null;
    const [repoRow] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repoRow) return null;
    return {
      ownerId: ownerRow.id,
      ownerUsername: ownerRow.username,
      repoId: repoRow.id,
      repoName: repoRow.name,
    };
  } catch {
    return null;
  }
}

async function resolveHeadSha(
  owner: string,
  repo: string
): Promise<string | null> {
  const branch = await getDefaultBranch(owner, repo);
  if (!branch) return null;
  return resolveRef(owner, repo, branch);
}

aiExplainRoutes.get(
  "/:owner/:repo/explain",
  softAuth,
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user");

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Repository not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    const sha = await resolveHeadSha(owner, repo);
    if (!sha) {
      return c.html(
        <Layout title={`Explain — ${owner}/${repo}`} user={user}>
          <RepoHeader owner={owner} repo={repo} />
          <IssueNav owner={owner} repo={repo} active="code" />
          <div class="empty-state">
            <h2>No commits yet</h2>
            <p>
              Push some code to <code>{repo}</code> and check back — the
              explanation is generated from the default branch.
            </p>
          </div>
        </Layout>
      );
    }

    // Prefer cache first to avoid calling the AI on every page load.
    let result = await getCachedExplanation(resolved.repoId, sha);
    if (!result) {
      result = await explainCodebase({
        owner,
        repo,
        repositoryId: resolved.repoId,
        commitSha: sha,
      });
    }

    const canRegenerate = !!user && user.id === resolved.ownerId;

    return c.html(
      <Layout title={`Explain — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <IssueNav owner={owner} repo={repo} active="code" />
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 16px 0;">
          <h2 style="margin: 0;">Codebase explanation</h2>
          {canRegenerate && (
            <form
              method="POST"
              action={`/${owner}/${repo}/explain/regenerate`}
              style="display: inline"
            >
              <button type="submit" class="star-btn">
                Regenerate
              </button>
            </form>
          )}
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          Generated from commit <code>{sha.slice(0, 7)}</code> · model{" "}
          <code>{result.model}</code>
          {result.cached ? " · cached" : ""}
        </div>
        <div class="markdown-body">
          {html(
            [renderMarkdown(result.markdown)] as unknown as TemplateStringsArray
          )}
        </div>
      </Layout>
    );
  }
);

aiExplainRoutes.post(
  "/:owner/:repo/explain/regenerate",
  requireAuth,
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.notFound();

    if (resolved.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/explain`);
    }

    const sha = await resolveHeadSha(owner, repo);
    if (!sha) {
      return c.redirect(`/${owner}/${repo}/explain`);
    }

    // Run synchronously so the redirect lands on a fresh result. The helper
    // itself never throws; worst case the user sees the fallback copy.
    await explainCodebase({
      owner,
      repo,
      repositoryId: resolved.repoId,
      commitSha: sha,
      force: true,
    });

    return c.redirect(`/${owner}/${repo}/explain`);
  }
);

export default aiExplainRoutes;
