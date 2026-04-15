/**
 * Block J28 — Issue title similarity suggestions.
 *
 *   GET /:owner/:repo/issues/similar.json?q=<title>[&limit=5][&state=open]
 *      → JSON {ok, matches: [{number, title, score, state}]}
 *      Designed for fetch-driven inline suggestions on the new-issue form.
 *
 *   GET /:owner/:repo/issues/:number/similar
 *      → Full HTML page showing the source issue + ranked related issues.
 *
 * softAuth; private repos 404 for non-owner viewers. IO is limited to a
 * bounded issue list (last `CANDIDATE_LIMIT` issues) so the in-memory ranker
 * stays O(n*m) on a capped n.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { issues, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  findSimilar,
  formatSimilarityPercent,
  type SimilarityCandidate,
} from "../lib/issue-similarity";

const issueSimilarityRoutes = new Hono<AuthEnv>();

issueSimilarityRoutes.use("*", softAuth);

const CANDIDATE_LIMIT = 500;
const MAX_RESULT_LIMIT = 20;

async function resolveRepo(ownerName: string, repoName: string) {
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
    return { owner, repo };
  } catch {
    return null;
  }
}

async function fetchCandidates(
  repoId: string
): Promise<SimilarityCandidate[]> {
  try {
    const rows = await db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        state: issues.state,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(eq(issues.repositoryId, repoId))
      .orderBy(desc(issues.createdAt))
      .limit(CANDIDATE_LIMIT);
    return rows as SimilarityCandidate[];
  } catch {
    return [];
  }
}

// JSON endpoint — suitable for inline suggestions on the new-issue form.
issueSimilarityRoutes.get(
  "/:owner/:repo/issues/similar.json",
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const q = (c.req.query("q") ?? "").trim();
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(MAX_RESULT_LIMIT, limitRaw)
        : 5;
    const stateParam = c.req.query("state");
    const state =
      stateParam === "open" || stateParam === "closed" ? stateParam : undefined;

    if (q.length === 0) {
      return c.json({ ok: true, matches: [] });
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    // Private-repo visibility: only the owner sees suggestions.
    if (resolved.repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const candidates = await fetchCandidates(resolved.repo.id);
    const matches = findSimilar(q, candidates, { limit, state }).map((m) => ({
      number: m.number,
      title: m.title,
      state: m.state,
      score: m.score,
      percent: formatSimilarityPercent(m.score),
    }));
    return c.json({ ok: true, matches });
  }
);

// HTML page — "Related issues" view anchored to a specific issue.
issueSimilarityRoutes.get(
  "/:owner/:repo/issues/:number/similar",
  async (c) => {
    const { owner: ownerName, repo: repoName, number: numParam } = c.req.param();
    const user = c.get("user");
    const num = Number.parseInt(numParam, 10);

    if (!Number.isFinite(num) || num <= 0) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Issue not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
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

    if (resolved.repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Repository not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    let source:
      | { id: string; number: number; title: string; state: string }
      | null = null;
    try {
      const [row] = await db
        .select({
          id: issues.id,
          number: issues.number,
          title: issues.title,
          state: issues.state,
        })
        .from(issues)
        .where(
          and(
            eq(issues.repositoryId, resolved.repo.id),
            eq(issues.number, num)
          )
        )
        .limit(1);
      source = (row as any) || null;
    } catch {
      source = null;
    }

    if (!source) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Issue not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    const candidates = await fetchCandidates(resolved.repo.id);
    const matches = findSimilar(source.title, candidates, {
      excludeId: source.id,
      excludeNumber: source.number,
      limit: 10,
    });

    return c.html(
      <Layout
        title={`Similar issues — #${source.number}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <div style="max-width: 920px">
          <div class="breadcrumb">
            <a href={`/${ownerName}/${repoName}/issues`}>issues</a>
            <span>/</span>
            <a href={`/${ownerName}/${repoName}/issues/${source.number}`}>
              #{source.number}
            </a>
            <span>/</span>
            <span>similar</span>
          </div>
          <h2 style="margin-top: 12px">
            Issues similar to{" "}
            <a href={`/${ownerName}/${repoName}/issues/${source.number}`}>
              #{source.number}
            </a>
          </h2>
          <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px">
            Ranked by token-Jaccard similarity on the title. Useful for spotting
            duplicates; not a replacement for reading the thread.
          </p>

          <div style="padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-secondary); margin-bottom: 20px">
            <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px">
              Source
            </div>
            <div>
              <span style="color: var(--text-muted)">#{source.number}</span>{" "}
              <strong>{source.title}</strong>{" "}
              <span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg); color: var(--text-muted)">
                {source.state}
              </span>
            </div>
          </div>

          {matches.length === 0 ? (
            <div class="empty-state">
              <p>No similar issues found. This one looks unique.</p>
            </div>
          ) : (
            <table style="width: 100%; border-collapse: collapse">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted)">
                    Issue
                  </th>
                  <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 80px">
                    State
                  </th>
                  <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 90px">
                    Similarity
                  </th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border)">
                      <a
                        href={`/${ownerName}/${repoName}/issues/${m.number}`}
                      >
                        <span style="color: var(--text-muted)">
                          #{m.number}
                        </span>{" "}
                        {m.title}
                      </a>
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-size: 11px; color: var(--text-muted)">
                      {m.state ?? "\u2014"}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                      {formatSimilarityPercent(m.score)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Layout>
    );
  }
);

export default issueSimilarityRoutes;
