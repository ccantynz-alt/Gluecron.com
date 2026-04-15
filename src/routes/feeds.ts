/**
 * Block J19 — Atom feeds for commits, releases, and issues.
 *
 *   GET /:owner/:repo/commits.atom   — newest-first 50 commits on default branch
 *   GET /:owner/:repo/releases.atom  — published releases
 *   GET /:owner/:repo/issues.atom    — newest 50 issues (open + closed)
 *
 * softAuth; private repos 404 for non-owner viewers. Rendering is done
 * via the pure `renderAtomFeed` builder in `src/lib/atom-feed.ts`.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  releases,
  repositories,
  users,
} from "../db/schema";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getDefaultBranch, listCommits } from "../git/repository";
import {
  ATOM_CONTENT_TYPE,
  renderAtomFeed,
  type AtomEntry,
} from "../lib/atom-feed";
import { config } from "../lib/config";

const feeds = new Hono<AuthEnv>();

const MAX_ENTRIES = 50;

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

function baseUrl(): string {
  try {
    return (config.appBaseUrl || "").replace(/\/$/, "") || "";
  } catch {
    return "";
  }
}

function respond(xml: string) {
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": ATOM_CONTENT_TYPE,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

function notFoundFeed(selfHref: string) {
  // Still return a valid Atom doc so feed readers don't choke; they just
  // see zero entries.
  return respond(
    renderAtomFeed({
      id: selfHref,
      title: "Unknown repository",
      selfHref,
      entries: [],
    })
  );
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------
feeds.get("/:owner/:repo/commits.atom", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const base = baseUrl();
  const selfHref = `${base}/${ownerName}/${repoName}/commits.atom`;

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return notFoundFeed(selfHref);
  if (
    resolved.repo.isPrivate &&
    (!user || user.id !== resolved.owner.id)
  ) {
    return notFoundFeed(selfHref);
  }

  let entries: AtomEntry[] = [];
  try {
    const ref = (await getDefaultBranch(ownerName, repoName)) || "HEAD";
    const commits = await listCommits(
      ownerName,
      repoName,
      ref,
      MAX_ENTRIES,
      0
    );
    entries = commits.map((cmt) => ({
      id: `tag:gluecron,2026:${ownerName}/${repoName}/commit/${cmt.sha}`,
      title: cmt.message.split("\n")[0] || "(no commit message)",
      href: `${base}/${ownerName}/${repoName}/commit/${cmt.sha}`,
      updatedAt: cmt.date,
      summary: cmt.message,
      author: { name: cmt.author, email: cmt.authorEmail },
    }));
  } catch {
    entries = [];
  }

  return respond(
    renderAtomFeed({
      id: `tag:gluecron,2026:${ownerName}/${repoName}/commits`,
      title: `${ownerName}/${repoName} — Recent commits`,
      subtitle: `Commits on the default branch of ${ownerName}/${repoName}`,
      selfHref,
      alternateHref: `${base}/${ownerName}/${repoName}/commits`,
      entries,
    })
  );
});

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------
feeds.get("/:owner/:repo/releases.atom", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const base = baseUrl();
  const selfHref = `${base}/${ownerName}/${repoName}/releases.atom`;

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return notFoundFeed(selfHref);
  if (
    resolved.repo.isPrivate &&
    (!user || user.id !== resolved.owner.id)
  ) {
    return notFoundFeed(selfHref);
  }

  let entries: AtomEntry[] = [];
  try {
    const rows = await db
      .select({
        release: releases,
        authorName: users.username,
      })
      .from(releases)
      .innerJoin(users, eq(releases.authorId, users.id))
      .where(eq(releases.repositoryId, resolved.repo.id))
      .orderBy(desc(releases.createdAt))
      .limit(MAX_ENTRIES);
    entries = rows
      .filter((r) => !r.release.isDraft)
      .map((r) => ({
        id: `tag:gluecron,2026:${ownerName}/${repoName}/release/${r.release.tag}`,
        title: r.release.name || r.release.tag,
        href: `${base}/${ownerName}/${repoName}/releases/tag/${encodeURIComponent(
          r.release.tag
        )}`,
        updatedAt: (r.release.publishedAt || r.release.createdAt).toISOString(),
        summary: r.release.body || `${r.release.tag} released`,
        author: { name: r.authorName },
      }));
  } catch {
    entries = [];
  }

  return respond(
    renderAtomFeed({
      id: `tag:gluecron,2026:${ownerName}/${repoName}/releases`,
      title: `${ownerName}/${repoName} — Releases`,
      subtitle: `Releases published by ${ownerName}/${repoName}`,
      selfHref,
      alternateHref: `${base}/${ownerName}/${repoName}/releases`,
      entries,
    })
  );
});

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------
feeds.get("/:owner/:repo/issues.atom", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const base = baseUrl();
  const selfHref = `${base}/${ownerName}/${repoName}/issues.atom`;

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return notFoundFeed(selfHref);
  if (
    resolved.repo.isPrivate &&
    (!user || user.id !== resolved.owner.id)
  ) {
    return notFoundFeed(selfHref);
  }

  let entries: AtomEntry[] = [];
  try {
    const rows = await db
      .select({
        issue: issues,
        authorName: users.username,
      })
      .from(issues)
      .innerJoin(users, eq(issues.authorId, users.id))
      .where(eq(issues.repositoryId, resolved.repo.id))
      .orderBy(desc(issues.createdAt))
      .limit(MAX_ENTRIES);
    entries = rows.map((r) => ({
      id: `tag:gluecron,2026:${ownerName}/${repoName}/issues/${r.issue.number}`,
      title: `#${r.issue.number} ${r.issue.title}`,
      href: `${base}/${ownerName}/${repoName}/issues/${r.issue.number}`,
      updatedAt: (r.issue.updatedAt || r.issue.createdAt).toISOString(),
      summary: r.issue.body
        ? r.issue.body.slice(0, 500)
        : `Issue #${r.issue.number}`,
      author: { name: r.authorName },
    }));
  } catch {
    entries = [];
  }

  return respond(
    renderAtomFeed({
      id: `tag:gluecron,2026:${ownerName}/${repoName}/issues`,
      title: `${ownerName}/${repoName} — Issues`,
      subtitle: `Issues tracked in ${ownerName}/${repoName}`,
      selfHref,
      alternateHref: `${base}/${ownerName}/${repoName}/issues`,
      entries,
    })
  );
});

export default feeds;
