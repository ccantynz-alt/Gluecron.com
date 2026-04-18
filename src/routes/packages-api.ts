/**
 * npm-compatible package registry HTTP endpoints (Block C2).
 *
 * Two surfaces on one sub-app:
 *   1) /api/packages/... — JSON helpers the UI uses
 *   2) /npm/...          — the actual npm client protocol
 *
 * The npm client URL-encodes scoped names like `@acme/foo` as
 * `@acme%2Ffoo`, and also may send them un-encoded. Both work because we
 * parse the full tail of the path ourselves instead of relying on Hono's
 * parameter extraction (which struggles with `@` and `/` in names).
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  packages,
  packageVersions,
  packageTags,
  repositories,
  users,
} from "../db/schema";
import type { Package, PackageVersion } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { audit } from "../lib/notify";
import {
  parsePackageName,
  computeShasum,
  computeIntegrity,
  buildPackument,
  resolveRepoFromPackageJson,
  tarballFilename,
} from "../lib/packages";

const api = new Hono<AuthEnv>();
api.use("*", softAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type NpmPublishBody = {
  name?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, Record<string, unknown>>;
  _attachments?: Record<
    string,
    { content_type?: string; data: string; length?: number }
  >;
};

/**
 * Extract the package name and optional trailing segment from a path like
 *   /npm/@scope/foo
 *   /npm/@scope%2Ffoo
 *   /npm/foo
 *   /npm/@scope/foo/-/foo-1.0.0.tgz
 *   /npm/foo/-/foo-1.0.0.tgz
 *   /npm/foo/-rev/42
 */
function parseNpmPath(path: string): {
  nameRaw: string;
  tail: string | null;
  revTail: string | null;
} {
  const rest = path.replace(/^\/+/, "").replace(/^npm\/+/, "");

  // Split on "/-/" (tarball endpoint) first.
  const dashIdx = rest.indexOf("/-/");
  if (dashIdx !== -1) {
    return {
      nameRaw: rest.slice(0, dashIdx),
      tail: rest.slice(dashIdx + 3),
      revTail: null,
    };
  }
  // "-rev" style (npm unpublish).
  const revIdx = rest.indexOf("/-rev/");
  if (revIdx !== -1) {
    return {
      nameRaw: rest.slice(0, revIdx),
      tail: null,
      revTail: rest.slice(revIdx + 6),
    };
  }
  return { nameRaw: rest, tail: null, revTail: null };
}

function baseUrlFrom(req: Request): string {
  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

async function loadRepo(owner: string, repo: string) {
  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerId: repositories.ownerId,
      isPrivate: repositories.isPrivate,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  return row || null;
}

async function loadPackage(
  repoId: string,
  scope: string | null,
  name: string
): Promise<Package | null> {
  const conds = [
    eq(packages.repositoryId, repoId),
    eq(packages.ecosystem, "npm"),
    eq(packages.name, name),
  ];
  const rows = await db
    .select()
    .from(packages)
    .where(and(...conds))
    .limit(20);
  // Manual scope equality because drizzle's eq + null is awkward.
  const match = rows.find((p) => (p.scope ?? null) === (scope ?? null));
  return match || null;
}

async function loadPackageByName(
  scope: string | null,
  name: string
): Promise<Package | null> {
  const rows = await db
    .select()
    .from(packages)
    .where(and(eq(packages.ecosystem, "npm"), eq(packages.name, name)))
    .limit(50);
  const match = rows.find((p) => (p.scope ?? null) === (scope ?? null));
  return match || null;
}

// ---------------------------------------------------------------------------
// UI-facing JSON helpers
// ---------------------------------------------------------------------------

api.get("/api/packages/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();
  try {
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.json({ error: "repo not found" }, 404);
    const rows = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.repositoryId, repoRow.id),
          eq(packages.ecosystem, "npm")
        )
      )
      .orderBy(desc(packages.updatedAt));
    return c.json({ packages: rows });
  } catch (err) {
    console.error("[packages] list:", err);
    return c.json({ error: "service unavailable" }, 503);
  }
});

api.get("/api/packages/:owner/:repo/:pkgName{.+}", async (c) => {
  const { owner, repo, pkgName } = c.req.param();
  const parsed = parsePackageName(pkgName);
  if (!parsed) return c.json({ error: "invalid package name" }, 400);
  try {
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.json({ error: "repo not found" }, 404);
    const pkg = await loadPackage(repoRow.id, parsed.scope, parsed.name);
    if (!pkg) return c.json({ error: "package not found" }, 404);
    const versions = await db
      .select()
      .from(packageVersions)
      .where(eq(packageVersions.packageId, pkg.id))
      .orderBy(desc(packageVersions.publishedAt));
    const tags = await db
      .select()
      .from(packageTags)
      .where(eq(packageTags.packageId, pkg.id));
    return c.json({ package: pkg, versions, tags });
  } catch (err) {
    console.error("[packages] detail:", err);
    return c.json({ error: "service unavailable" }, 503);
  }
});

// Yank endpoint (owner-only; marks a version as yanked but leaves it
// downloadable so existing installs don't break — matches npm semantics).
api.post(
  "/api/packages/:owner/:repo/:pkgName/:version/yank",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, pkgName, version } = c.req.param();
    const parsed = parsePackageName(pkgName);
    if (!parsed) return c.json({ error: "invalid package name" }, 400);
    try {
      const repoRow = await loadRepo(owner, repo);
      if (!repoRow) return c.json({ error: "repo not found" }, 404);
      if (repoRow.ownerId !== user.id) {
        return c.json({ error: "forbidden" }, 403);
      }
      const pkg = await loadPackage(repoRow.id, parsed.scope, parsed.name);
      if (!pkg) return c.json({ error: "package not found" }, 404);

      await db
        .update(packageVersions)
        .set({ yanked: true, yankedReason: "yanked by owner" })
        .where(
          and(
            eq(packageVersions.packageId, pkg.id),
            eq(packageVersions.version, version)
          )
        );

      await audit({
        userId: user.id,
        repositoryId: repoRow.id,
        action: "package.yank",
        targetType: "package_version",
        targetId: pkg.id,
        metadata: { version, name: parsed.full },
      });

      return c.json({ ok: true });
    } catch (err) {
      console.error("[packages] yank:", err);
      return c.json({ error: "service unavailable" }, 503);
    }
  }
);

// ---------------------------------------------------------------------------
// npm protocol: packument + tarball
// ---------------------------------------------------------------------------

api.get("/npm/*", async (c) => {
  const { nameRaw, tail } = parseNpmPath(c.req.path);
  if (!nameRaw) return c.json({ error: "not found" }, 404);

  const parsed = parsePackageName(nameRaw);
  if (!parsed) return c.json({ error: "invalid package name" }, 400);

  try {
    const pkg = await loadPackageByName(parsed.scope, parsed.name);
    if (!pkg) return c.json({ error: "not found" }, 404);

    // Tarball request?
    if (tail) {
      const filename = decodeURIComponent(tail);
      const versions = await db
        .select()
        .from(packageVersions)
        .where(eq(packageVersions.packageId, pkg.id));

      // Match by filename → version. Filename is `<name>-<version>.tgz`.
      const match = versions.find(
        (v) => tarballFilename(parsed, v.version) === filename
      );
      if (!match || !match.tarball) {
        return c.json({ error: "tarball not found" }, 404);
      }
      const bytes = Buffer.from(match.tarball, "base64");
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    // Packument request.
    const versions = await db
      .select()
      .from(packageVersions)
      .where(eq(packageVersions.packageId, pkg.id))
      .orderBy(desc(packageVersions.publishedAt));
    const tags = await db
      .select()
      .from(packageTags)
      .where(eq(packageTags.packageId, pkg.id));

    const doc = buildPackument(pkg, versions, tags, baseUrlFrom(c.req.raw));
    return c.json(doc);
  } catch (err) {
    console.error("[packages] npm get:", err);
    return c.json({ error: "service unavailable" }, 503);
  }
});

// ---------------------------------------------------------------------------
// npm protocol: publish (`npm publish` → PUT /<name>)
// ---------------------------------------------------------------------------

api.put("/npm/*", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { nameRaw } = parseNpmPath(c.req.path);
  const parsed = parsePackageName(nameRaw);
  if (!parsed) {
    return c.json({ error: "invalid package name" }, 400);
  }

  let body: NpmPublishBody;
  try {
    body = await c.req.json<NpmPublishBody>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const versionsObj = body.versions || {};
  const versionKeys = Object.keys(versionsObj);
  if (versionKeys.length === 0) {
    return c.json({ error: "no version in payload" }, 400);
  }
  // npm always sends exactly one version per publish.
  const version = versionKeys[0];
  const versionMeta = versionsObj[version] || {};

  const attachments = body._attachments || {};
  const attachKeys = Object.keys(attachments);
  if (attachKeys.length === 0) {
    return c.json({ error: "no tarball attachment" }, 400);
  }
  const attachment = attachments[attachKeys[0]];
  if (!attachment || !attachment.data) {
    return c.json({ error: "empty tarball attachment" }, 400);
  }

  const tarballBytes = Buffer.from(attachment.data, "base64");
  if (tarballBytes.length === 0) {
    return c.json({ error: "tarball decoded to zero bytes" }, 400);
  }

  // Resolve owner+repo from the metadata's repository.url.
  const repoRef = resolveRepoFromPackageJson(versionMeta);
  if (!repoRef) {
    return c.json(
      {
        error:
          "repository.url must point to a gluecron repo you own (e.g. http://host/:owner/:repo.git)",
      },
      400
    );
  }

  try {
    const repoRow = await loadRepo(repoRef.owner, repoRef.repo);
    if (!repoRow) {
      return c.json(
        { error: `repo ${repoRef.owner}/${repoRef.repo} not found` },
        404
      );
    }
    if (repoRow.ownerId !== user.id) {
      return c.json(
        { error: "you do not own the repository named in repository.url" },
        403
      );
    }

    // Upsert the package row.
    let pkg = await loadPackage(repoRow.id, parsed.scope, parsed.name);
    if (!pkg) {
      const description =
        typeof versionMeta.description === "string"
          ? (versionMeta.description as string)
          : null;
      const homepage =
        typeof versionMeta.homepage === "string"
          ? (versionMeta.homepage as string)
          : null;
      const license =
        typeof versionMeta.license === "string"
          ? (versionMeta.license as string)
          : null;
      const readme =
        typeof (body as Record<string, unknown>).readme === "string"
          ? ((body as Record<string, unknown>).readme as string)
          : typeof versionMeta.readme === "string"
            ? (versionMeta.readme as string)
            : null;

      const [inserted] = await db
        .insert(packages)
        .values({
          repositoryId: repoRow.id,
          ecosystem: "npm",
          scope: parsed.scope,
          name: parsed.name,
          description,
          readme,
          homepage,
          license,
          visibility: repoRow.isPrivate ? "private" : "public",
        })
        .returning();
      pkg = inserted;
    }
    if (!pkg) {
      return c.json({ error: "failed to create package" }, 503);
    }

    // Reject duplicate version.
    const [existing] = await db
      .select()
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, pkg.id),
          eq(packageVersions.version, version)
        )
      )
      .limit(1);
    if (existing) {
      return c.json(
        {
          error: `You cannot publish over the previously published version ${version}.`,
        },
        409
      );
    }

    const shasum = computeShasum(tarballBytes);
    const integrity = computeIntegrity(tarballBytes);

    const [insertedVersion] = await db
      .insert(packageVersions)
      .values({
        packageId: pkg.id,
        version,
        shasum,
        integrity,
        sizeBytes: tarballBytes.length,
        metadata: JSON.stringify(versionMeta),
        tarball: tarballBytes.toString("base64"),
        publishedBy: user.id,
      })
      .returning();

    // Upsert "latest" dist-tag (and any other tags from the payload).
    const distTags = body["dist-tags"] || { latest: version };
    for (const [tag, tagVersion] of Object.entries(distTags)) {
      if (tagVersion !== version) continue; // Only set tags pointing at this publish.
      const [existingTag] = await db
        .select()
        .from(packageTags)
        .where(
          and(
            eq(packageTags.packageId, pkg.id),
            eq(packageTags.tag, tag)
          )
        )
        .limit(1);
      if (existingTag) {
        await db
          .update(packageTags)
          .set({ versionId: insertedVersion.id, updatedAt: new Date() })
          .where(eq(packageTags.id, existingTag.id));
      } else {
        await db.insert(packageTags).values({
          packageId: pkg.id,
          tag,
          versionId: insertedVersion.id,
        });
      }
    }

    // Update package bookkeeping fields on every publish (license/description
    // may evolve version-to-version; we keep the most recent).
    await db
      .update(packages)
      .set({
        updatedAt: new Date(),
        description:
          typeof versionMeta.description === "string"
            ? (versionMeta.description as string)
            : pkg.description,
        homepage:
          typeof versionMeta.homepage === "string"
            ? (versionMeta.homepage as string)
            : pkg.homepage,
        license:
          typeof versionMeta.license === "string"
            ? (versionMeta.license as string)
            : pkg.license,
      })
      .where(eq(packages.id, pkg.id));

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "package.publish",
      targetType: "package_version",
      targetId: insertedVersion.id,
      metadata: {
        name: parsed.full,
        version,
        size: tarballBytes.length,
      },
    });

    return c.json({ ok: true, id: parsed.full, version }, 201);
  } catch (err) {
    console.error("[packages] publish:", err);
    return c.json({ error: "service unavailable" }, 503);
  }
});

// npm unpublish: DELETE /npm/<name>/-rev/<rev> — we treat this as a yank.
api.delete("/npm/*", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { nameRaw, revTail } = parseNpmPath(c.req.path);
  const parsed = parsePackageName(nameRaw);
  if (!parsed) return c.json({ error: "invalid package name" }, 400);
  if (!revTail) {
    return c.json(
      { error: "unpublish without rev is not supported" },
      400
    );
  }

  try {
    const pkg = await loadPackageByName(parsed.scope, parsed.name);
    if (!pkg) return c.json({ error: "not found" }, 404);
    const [repoRow] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, pkg.repositoryId))
      .limit(1);
    if (!repoRow || repoRow.ownerId !== user.id) {
      return c.json({ error: "forbidden" }, 403);
    }

    // Yank the latest version.
    const [latest] = await db
      .select()
      .from(packageVersions)
      .where(eq(packageVersions.packageId, pkg.id))
      .orderBy(desc(packageVersions.publishedAt))
      .limit(1);
    if (latest) {
      await db
        .update(packageVersions)
        .set({ yanked: true, yankedReason: "unpublished" })
        .where(eq(packageVersions.id, latest.id));
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "package.unpublish",
      targetType: "package",
      targetId: pkg.id,
      metadata: { name: parsed.full },
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("[packages] unpublish:", err);
    return c.json({ error: "service unavailable" }, 503);
  }
});

export default api;

// Re-export helpers internally for the UI route.
export type { Package, PackageVersion };
