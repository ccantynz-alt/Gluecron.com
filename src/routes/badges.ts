/**
 * Block J10 — Repository status badges.
 *
 * Serves shields.io-style SVG badges repositories can embed in READMEs:
 *
 *   GET /:owner/:repo/badge/gates.svg     — latest gate_runs rollup
 *   GET /:owner/:repo/badge/issues.svg    — open issue count
 *   GET /:owner/:repo/badge/prs.svg       — open PR count
 *   GET /:owner/:repo/badge/status.svg          — combined commit status on HEAD
 *   GET /:owner/:repo/badge/status/:context.svg — single status context
 *
 * All responses: image/svg+xml, public short-cache, never 500s — badges fall
 * back to a grey "unknown" state on DB or git failure.
 */

import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  users,
  gateRuns,
  issues,
  pullRequests,
  commitStatuses,
} from "../db/schema";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { renderBadge, colorForState } from "../lib/badge";
import { getDefaultBranch } from "../git/repository";
import { resolveRef } from "../git/repository";

const badges = new Hono<AuthEnv>();

const CACHE = "public, max-age=60, stale-while-revalidate=300";

function svg(body: string) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": CACHE,
    },
  });
}

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

// ---------------------------------------------------------------------------
// /:owner/:repo/badge/gates.svg — latest gate_runs rollup
// ---------------------------------------------------------------------------
badges.get("/:owner/:repo/badge/gates.svg", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return svg(renderBadge({ label: "gates", value: "unknown", color: "grey" }));
  }

  try {
    const rows = await db
      .select()
      .from(gateRuns)
      .where(eq(gateRuns.repositoryId, resolved.repo.id))
      .orderBy(desc(gateRuns.createdAt))
      .limit(20);
    if (!rows.length) {
      return svg(
        renderBadge({ label: "gates", value: "no runs", color: "grey" })
      );
    }
    const anyFailed = rows.some((r) => r.status === "failed");
    const anyRunning = rows.some(
      (r) => r.status === "running" || r.status === "pending"
    );
    const state = anyFailed ? "failed" : anyRunning ? "pending" : "passed";
    const label = "gates";
    const value = anyFailed ? "failing" : anyRunning ? "running" : "passing";
    return svg(
      renderBadge({ label, value, color: colorForState(state as any) })
    );
  } catch {
    return svg(
      renderBadge({ label: "gates", value: "unknown", color: "grey" })
    );
  }
});

// ---------------------------------------------------------------------------
// /:owner/:repo/badge/issues.svg — open issue count
// ---------------------------------------------------------------------------
badges.get("/:owner/:repo/badge/issues.svg", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return svg(
      renderBadge({ label: "issues", value: "unknown", color: "grey" })
    );
  }
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, resolved.repo.id),
          eq(issues.state, "open")
        )
      );
    const n = Number(row?.n || 0);
    return svg(
      renderBadge({
        label: "issues",
        value: `${n} open`,
        color: n === 0 ? "green" : n < 10 ? "blue" : "yellow",
      })
    );
  } catch {
    return svg(
      renderBadge({ label: "issues", value: "unknown", color: "grey" })
    );
  }
});

// ---------------------------------------------------------------------------
// /:owner/:repo/badge/prs.svg — open PR count
// ---------------------------------------------------------------------------
badges.get("/:owner/:repo/badge/prs.svg", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return svg(renderBadge({ label: "PRs", value: "unknown", color: "grey" }));
  }
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.state, "open")
        )
      );
    const n = Number(row?.n || 0);
    return svg(
      renderBadge({
        label: "PRs",
        value: `${n} open`,
        color: n === 0 ? "green" : n < 10 ? "blue" : "yellow",
      })
    );
  } catch {
    return svg(renderBadge({ label: "PRs", value: "unknown", color: "grey" }));
  }
});

// ---------------------------------------------------------------------------
// /:owner/:repo/badge/status.svg — combined commit status on default HEAD
// /:owner/:repo/badge/status/:context.svg — single named status context
// ---------------------------------------------------------------------------
async function statusBadge(
  resolved: NonNullable<Awaited<ReturnType<typeof resolveRepo>>>,
  owner: string,
  repo: string,
  context: string | null
) {
  try {
    const branch = (await getDefaultBranch(owner, repo)) || "main";
    const sha = await resolveRef(owner, repo, branch);
    if (!sha) {
      return renderBadge({
        label: context || "status",
        value: "no commit",
        color: "grey",
      });
    }
    const rows = await db
      .select()
      .from(commitStatuses)
      .where(
        and(
          eq(commitStatuses.repositoryId, resolved.repo.id),
          eq(commitStatuses.commitSha, sha.toLowerCase())
        )
      );
    let latest = rows;
    if (context) {
      latest = rows.filter((r) => r.context === context);
    } else {
      // latest per context
      const m = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        const p = m.get(r.context);
        if (!p || p.updatedAt < r.updatedAt) m.set(r.context, r);
      }
      latest = [...m.values()];
    }
    if (!latest.length) {
      return renderBadge({
        label: context || "status",
        value: "none",
        color: "grey",
      });
    }
    const states = latest.map((r) => r.state);
    const combined = states.some((s) => s === "failure" || s === "error")
      ? "failure"
      : states.some((s) => s === "pending")
        ? "pending"
        : "success";
    return renderBadge({
      label: context || "status",
      value: combined,
      color: colorForState(combined as any),
    });
  } catch {
    return renderBadge({
      label: context || "status",
      value: "unknown",
      color: "grey",
    });
  }
}

badges.get("/:owner/:repo/badge/status.svg", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return svg(
      renderBadge({ label: "status", value: "unknown", color: "grey" })
    );
  }
  return svg(await statusBadge(resolved, ownerName, repoName, null));
});

badges.get("/:owner/:repo/badge/status/:context.svg", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName, context } = c.req.param();
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) {
    return svg(
      renderBadge({ label: context, value: "unknown", color: "grey" })
    );
  }
  return svg(await statusBadge(resolved, ownerName, repoName, context));
});

export default badges;
