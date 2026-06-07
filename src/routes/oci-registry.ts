/**
 * OCI Distribution Spec v1.0 — Container Registry
 *
 * Implements the standard Docker / OCI image push-pull protocol so teams
 * can push and pull images directly against Gluecron without GitHub Packages
 * or an external registry.
 *
 * URL surface (all under /v2/):
 *   GET  /v2/                              — version check (requires auth)
 *   HEAD /v2/:name/blobs/:digest           — check blob existence
 *   GET  /v2/:name/blobs/:digest           — download blob
 *   POST /v2/:name/blobs/uploads/          — start chunked upload
 *   PATCH /v2/:name/blobs/uploads/:uuid    — stream blob chunk
 *   PUT  /v2/:name/blobs/uploads/:uuid     — complete upload
 *   DELETE /v2/:name/blobs/:digest         — delete blob
 *   GET  /v2/:name/manifests/:ref          — get manifest (tag or digest)
 *   PUT  /v2/:name/manifests/:ref          — push manifest (create tag)
 *   DELETE /v2/:name/manifests/:ref        — delete manifest/tag
 *   GET  /v2/:name/tags/list               — list tags for a repo
 *   GET  /v2/_catalog                      — list all repositories
 *
 * Auth: Docker clients send `Authorization: Basic base64(user:token)`.
 * We validate against the api_tokens table (SHA-256 of the raw token,
 * same as every other Gluecron API surface). 401 responses carry
 * `WWW-Authenticate: Basic realm="Gluecron Container Registry"` and
 * the OCI error JSON body format.
 *
 * Storage: blobs on disk at ${OCI_STORE_PATH}/blobs/sha256/<hex>,
 * manifests at ${OCI_STORE_PATH}/manifests/<name>/<ref>.
 * In-progress uploads accumulate in ${OCI_STORE_PATH}/uploads/<uuid>.
 */

import { Hono } from "hono";
import { createHash, randomUUID } from "crypto";
import { eq, and, desc } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../db";
import { apiTokens, users, ociRepositories, ociTags } from "../db/schema";
import { config } from "../lib/config";
import type { AuthEnv } from "../middleware/auth";

// ---------------------------------------------------------------------------
// OCI error helpers
// ---------------------------------------------------------------------------

type OciErrorCode =
  | "UNAUTHORIZED"
  | "DENIED"
  | "UNSUPPORTED"
  | "BLOB_UNKNOWN"
  | "BLOB_UPLOAD_INVALID"
  | "BLOB_UPLOAD_UNKNOWN"
  | "DIGEST_INVALID"
  | "MANIFEST_BLOB_UNKNOWN"
  | "MANIFEST_INVALID"
  | "MANIFEST_UNKNOWN"
  | "NAME_INVALID"
  | "NAME_UNKNOWN"
  | "SIZE_INVALID"
  | "TAG_INVALID";

function ociError(
  code: OciErrorCode,
  message: string,
  detail?: unknown
): { errors: Array<{ code: string; message: string; detail?: unknown }> } {
  const err: { code: string; message: string; detail?: unknown } = {
    code,
    message,
  };
  if (detail !== undefined) err.detail = detail;
  return { errors: [err] };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type AuthResult =
  | { ok: true; user: { id: string; username: string } }
  | { ok: false };

/**
 * Docker clients send `Authorization: Basic base64("user:token")`.
 * We ignore the username part and validate the token (password) against
 * the api_tokens table just like Bearer token auth elsewhere.
 */
async function authenticateBasic(authHeader: string | undefined): Promise<AuthResult> {
  if (!authHeader) return { ok: false };

  let encoded: string;
  if (authHeader.startsWith("Basic ")) {
    encoded = authHeader.slice(6).trim();
  } else if (authHeader.startsWith("Bearer ")) {
    // Docker Desktop sometimes sends Bearer after the initial 401 WWW-Auth exchange
    const raw = authHeader.slice(7).trim();
    if (!raw) return { ok: false };
    const tokenHash = sha256hex(raw);
    try {
      const [tokenRow] = await db
        .select({ userId: apiTokens.userId, expiresAt: apiTokens.expiresAt, id: apiTokens.id })
        .from(apiTokens)
        .where(eq(apiTokens.tokenHash, tokenHash))
        .limit(1);
      if (!tokenRow) return { ok: false };
      if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) return { ok: false };
      const [user] = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, tokenRow.userId))
        .limit(1);
      if (!user) return { ok: false };
      db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tokenRow.id)).catch(() => {});
      return { ok: true, user };
    } catch {
      return { ok: false };
    }
  } else {
    return { ok: false };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf-8");
  } catch {
    return { ok: false };
  }

  // "user:token" — Docker spec allows colons in password, split on first colon only
  const colonIdx = decoded.indexOf(":");
  if (colonIdx < 0) return { ok: false };
  const rawToken = decoded.slice(colonIdx + 1);
  if (!rawToken) return { ok: false };

  const tokenHash = sha256hex(rawToken);
  try {
    const [tokenRow] = await db
      .select({ userId: apiTokens.userId, expiresAt: apiTokens.expiresAt, id: apiTokens.id })
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, tokenHash))
      .limit(1);
    if (!tokenRow) return { ok: false };
    if (tokenRow.expiresAt && new Date(tokenRow.expiresAt) < new Date()) return { ok: false };
    const [user] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, tokenRow.userId))
      .limit(1);
    if (!user) return { ok: false };
    // Best-effort touch
    db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tokenRow.id)).catch(() => {});
    return { ok: true, user };
  } catch {
    return { ok: false };
  }
}

const UNAUTHORIZED_HEADERS = {
  "WWW-Authenticate": 'Basic realm="Gluecron Container Registry"',
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/** Resolve (and lazily create) storage directories. */
function storePath(...segments: string[]): string {
  return join(config.ociStorePath, ...segments);
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Absolute path to a finished blob file. */
function blobPath(digest: string): string {
  // digest = "sha256:<hex>" or just "<hex>"
  const hex = digest.startsWith("sha256:") ? digest.slice(7) : digest;
  return storePath("blobs", "sha256", hex);
}

/** Absolute path to a manifest file for a given image name + ref. */
function manifestPath(name: string, ref: string): string {
  return storePath("manifests", name, ref);
}

/** Absolute path to an in-progress upload chunk file. */
function uploadPath(uuid: string): string {
  return storePath("uploads", uuid);
}

/** Compute sha256 digest of a file on disk. */
async function digestOfFile(path: string): Promise<string> {
  const file = Bun.file(path);
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return `sha256:${h.digest("hex")}`;
}

/** Validate that a "sha256:<hex64>" digest string is well-formed. */
function isValidDigest(digest: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(digest);
}

// ---------------------------------------------------------------------------
// DB helpers — oci_repositories + oci_tags
// ---------------------------------------------------------------------------

/** Find or create an oci_repositories row for owner/image. */
async function findOrCreateOciRepo(
  ownerId: string,
  name: string,
  visibility: "public" | "private" = "private"
): Promise<string> {
  const [existing] = await db
    .select({ id: ociRepositories.id })
    .from(ociRepositories)
    .where(and(eq(ociRepositories.ownerId, ownerId), eq(ociRepositories.name, name)))
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(ociRepositories)
    .values({ ownerId, name, visibility })
    .returning({ id: ociRepositories.id });
  return inserted.id;
}

/** Upsert a tag → digest mapping. */
async function upsertTag(repositoryId: string, tag: string, manifestDigest: string): Promise<void> {
  const [existing] = await db
    .select({ id: ociTags.id })
    .from(ociTags)
    .where(and(eq(ociTags.repositoryId, repositoryId), eq(ociTags.tag, tag)))
    .limit(1);

  if (existing) {
    await db
      .update(ociTags)
      .set({ manifestDigest, updatedAt: new Date() })
      .where(eq(ociTags.id, existing.id));
  } else {
    await db.insert(ociTags).values({ repositoryId, tag, manifestDigest });
  }
}

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

const registry = new Hono<AuthEnv>();

// The OCI spec uses `:name` which can contain slashes (e.g. "owner/image").
// Hono's wildcard param ({name:*}) doesn't play well with path segments, so
// we parse the image name from c.req.path directly in each handler.

// ---------------------------------------------------------------------------
// GET /v2/ — Version check
// ---------------------------------------------------------------------------
registry.get("/v2/", async (c) => {
  const auth = await authenticateBasic(c.req.header("authorization"));
  if (!auth.ok) {
    return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
  }
  return c.json({}, 200, { "Docker-Distribution-API-Version": "registry/2.0" });
});

// ---------------------------------------------------------------------------
// GET /v2/_catalog — list all repositories the caller can see
// ---------------------------------------------------------------------------
registry.get("/v2/_catalog", async (c) => {
  const auth = await authenticateBasic(c.req.header("authorization"));
  if (!auth.ok) {
    return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
  }

  try {
    const rows = await db
      .select({ name: ociRepositories.name })
      .from(ociRepositories)
      .where(eq(ociRepositories.ownerId, auth.user.id))
      .orderBy(ociRepositories.name);

    return c.json({ repositories: rows.map((r) => r.name) });
  } catch (err) {
    console.error("[oci] catalog:", err);
    return c.json(ociError("UNSUPPORTED", "service error"), 500);
  }
});

// ---------------------------------------------------------------------------
// Blob endpoints — /v2/:name/blobs/...
// We parse :name as a wildcard from the URL manually.
// ---------------------------------------------------------------------------

/** Extract image name + remainder from path like /v2/<name>/blobs/... */
function parseV2Path(
  path: string,
  segment: string
): { name: string; rest: string } | null {
  // /v2/<name>/blobs/...  or  /v2/<name>/manifests/... etc.
  const prefix = "/v2/";
  if (!path.startsWith(prefix)) return null;
  const after = path.slice(prefix.length);
  const segIdx = after.indexOf(`/${segment}/`);
  if (segIdx < 0) {
    // check for exact match at end (e.g., /v2/<name>/tags/list)
    const segEnd = after.indexOf(`/${segment}`);
    if (segEnd < 0) return null;
    const name = after.slice(0, segEnd);
    const rest = after.slice(segEnd + segment.length + 1);
    return { name, rest };
  }
  const name = after.slice(0, segIdx);
  const rest = after.slice(segIdx + segment.length + 2);
  return { name, rest };
}

// HEAD /v2/:name/blobs/:digest
registry.on(["HEAD", "GET"], "/v2/*", async (c) => {
  const path = c.req.path;

  // ── HEAD/GET /v2/:name/blobs/:digest ──────────────────────────────────────
  if (/\/blobs\/sha256:[0-9a-f]{64}$/.test(path)) {
    const auth = await authenticateBasic(c.req.header("authorization"));
    if (!auth.ok) {
      return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
    }

    const digestMatch = path.match(/\/blobs\/(sha256:[0-9a-f]{64})$/);
    if (!digestMatch) {
      return c.json(ociError("DIGEST_INVALID", "invalid digest"), 400);
    }
    const digest = digestMatch[1];
    const bp = blobPath(digest);
    const file = Bun.file(bp);
    const exists = await file.exists();
    if (!exists) {
      return c.json(ociError("BLOB_UNKNOWN", "blob unknown to registry"), 404, {
        "Docker-Content-Digest": digest,
      });
    }

    const headers: Record<string, string> = {
      "Docker-Content-Digest": digest,
      "Content-Length": String(file.size),
      "Content-Type": "application/octet-stream",
    };

    if (c.req.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    // GET — stream the blob
    return new Response(file.stream(), { status: 200, headers });
  }

  // ── GET /v2/:name/tags/list ───────────────────────────────────────────────
  if (path.endsWith("/tags/list")) {
    const auth = await authenticateBasic(c.req.header("authorization"));
    if (!auth.ok) {
      return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
    }

    const parsed = parseV2Path(path, "tags");
    if (!parsed) return c.json(ociError("NAME_INVALID", "invalid name"), 400);
    const name = parsed.name;

    try {
      const [repo] = await db
        .select({ id: ociRepositories.id })
        .from(ociRepositories)
        .where(and(eq(ociRepositories.ownerId, auth.user.id), eq(ociRepositories.name, name)))
        .limit(1);

      if (!repo) {
        return c.json({ name, tags: [] });
      }

      const tagRows = await db
        .select({ tag: ociTags.tag })
        .from(ociTags)
        .where(eq(ociTags.repositoryId, repo.id))
        .orderBy(ociTags.tag);

      return c.json({ name, tags: tagRows.map((t) => t.tag) });
    } catch (err) {
      console.error("[oci] tags/list:", err);
      return c.json(ociError("UNSUPPORTED", "service error"), 500);
    }
  }

  // ── GET /v2/:name/manifests/:ref ──────────────────────────────────────────
  if (path.includes("/manifests/")) {
    const auth = await authenticateBasic(c.req.header("authorization"));
    if (!auth.ok) {
      return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
    }

    const parsed = parseV2Path(path, "manifests");
    if (!parsed) return c.json(ociError("NAME_INVALID", "invalid name"), 400);
    const name = parsed.name;
    const ref = parsed.rest;

    // ref may be a tag name or a digest (sha256:...)
    try {
      let resolvedPath: string | null = null;
      let resolvedDigest: string | null = null;

      if (isValidDigest(ref)) {
        // Direct digest reference — look up the blob path
        const bp = blobPath(ref);
        const file = Bun.file(bp);
        if (!(await file.exists())) {
          return c.json(ociError("MANIFEST_UNKNOWN", "manifest unknown"), 404);
        }
        resolvedPath = manifestPath(name, ref);
        // Fall back: the manifest might be stored by digest directly
        const mf = Bun.file(resolvedPath);
        if (!(await mf.exists())) {
          resolvedPath = bp; // manifests stored as blobs too
        }
        resolvedDigest = ref;
      } else {
        // Tag name — look up in DB
        const [repo] = await db
          .select({ id: ociRepositories.id })
          .from(ociRepositories)
          .where(and(eq(ociRepositories.ownerId, auth.user.id), eq(ociRepositories.name, name)))
          .limit(1);

        if (!repo) {
          return c.json(ociError("NAME_UNKNOWN", "repository name not known to registry"), 404);
        }

        const [tagRow] = await db
          .select({ manifestDigest: ociTags.manifestDigest })
          .from(ociTags)
          .where(and(eq(ociTags.repositoryId, repo.id), eq(ociTags.tag, ref)))
          .limit(1);

        if (!tagRow) {
          return c.json(ociError("MANIFEST_UNKNOWN", "manifest unknown"), 404);
        }

        resolvedDigest = tagRow.manifestDigest;
        resolvedPath = manifestPath(name, ref);
        const mf = Bun.file(resolvedPath);
        if (!(await mf.exists())) {
          // Fall back to digest path
          resolvedPath = blobPath(resolvedDigest);
        }
      }

      if (!resolvedPath || !resolvedDigest) {
        return c.json(ociError("MANIFEST_UNKNOWN", "manifest unknown"), 404);
      }

      const file = Bun.file(resolvedPath);
      if (!(await file.exists())) {
        return c.json(ociError("MANIFEST_UNKNOWN", "manifest unknown"), 404);
      }

      const content = await file.text();
      let contentType = "application/vnd.oci.image.manifest.v1+json";
      try {
        const parsed2 = JSON.parse(content);
        if (parsed2.mediaType) contentType = parsed2.mediaType;
        else if (parsed2.schemaVersion === 2 && parsed2.config) {
          contentType = "application/vnd.docker.distribution.manifest.v2+json";
        }
      } catch { /* leave default */ }

      if (c.req.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "Docker-Content-Digest": resolvedDigest,
            "Content-Length": String(Buffer.byteLength(content)),
            "Content-Type": contentType,
          },
        });
      }

      return new Response(content, {
        status: 200,
        headers: {
          "Docker-Content-Digest": resolvedDigest,
          "Content-Type": contentType,
        },
      });
    } catch (err) {
      console.error("[oci] get manifest:", err);
      return c.json(ociError("UNSUPPORTED", "service error"), 500);
    }
  }

  return c.json(ociError("UNSUPPORTED", "unsupported endpoint"), 404);
});

// ---------------------------------------------------------------------------
// POST /v2/:name/blobs/uploads/ — start a new upload session
// ---------------------------------------------------------------------------
registry.post("/v2/*", async (c) => {
  const path = c.req.path;

  if (!path.includes("/blobs/uploads")) {
    return c.json(ociError("UNSUPPORTED", "unsupported endpoint"), 404);
  }

  const auth = await authenticateBasic(c.req.header("authorization"));
  if (!auth.ok) {
    return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
  }

  // Parse image name
  const parsed = parseV2Path(path, "blobs");
  if (!parsed) return c.json(ociError("NAME_INVALID", "invalid image name"), 400);
  const name = parsed.name;

  // Check for single-request monolithic upload: POST with ?digest=sha256:...
  const digestParam = c.req.query("digest");
  if (digestParam) {
    if (!isValidDigest(digestParam)) {
      return c.json(ociError("DIGEST_INVALID", "invalid digest format"), 400);
    }
    // Single-step upload (used for small layers)
    try {
      const body = await c.req.arrayBuffer();
      const bytes = new Uint8Array(body);
      const h = new Bun.CryptoHasher("sha256");
      h.update(bytes);
      const computed = `sha256:${h.digest("hex")}`;
      if (computed !== digestParam) {
        return c.json(ociError("DIGEST_INVALID", "digest mismatch"), 400);
      }
      await ensureDir(storePath("blobs", "sha256"));
      const bp = blobPath(digestParam);
      const existing = Bun.file(bp);
      if (!(await existing.exists())) {
        await Bun.write(bp, bytes);
      }
      // Ensure OCI repo record exists
      await findOrCreateOciRepo(auth.user.id, name);
      const baseUrl = new URL(c.req.url).origin;
      return new Response(null, {
        status: 201,
        headers: {
          Location: `${baseUrl}/v2/${name}/blobs/${digestParam}`,
          "Docker-Content-Digest": digestParam,
          "Content-Length": "0",
        },
      });
    } catch (err) {
      console.error("[oci] monolithic upload:", err);
      return c.json(ociError("UNSUPPORTED", "upload failed"), 500);
    }
  }

  // Chunked upload — allocate a UUID
  const uuid = randomUUID();
  try {
    await ensureDir(storePath("uploads"));
    // Create an empty placeholder so PATCH has something to append to
    await Bun.write(uploadPath(uuid), new Uint8Array(0));
    await ensureDir(storePath("blobs", "sha256"));
    await findOrCreateOciRepo(auth.user.id, name);
    const baseUrl = new URL(c.req.url).origin;
    return new Response(null, {
      status: 202,
      headers: {
        Location: `${baseUrl}/v2/${name}/blobs/uploads/${uuid}`,
        "Docker-Upload-UUID": uuid,
        Range: "0-0",
        "Content-Length": "0",
      },
    });
  } catch (err) {
    console.error("[oci] start upload:", err);
    return c.json(ociError("UNSUPPORTED", "failed to start upload"), 500);
  }
});

// ---------------------------------------------------------------------------
// PATCH /v2/:name/blobs/uploads/:uuid — stream chunk data
// ---------------------------------------------------------------------------
registry.patch("/v2/*", async (c) => {
  const path = c.req.path;
  const auth = await authenticateBasic(c.req.header("authorization"));
  if (!auth.ok) {
    return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
  }

  // Extract uuid from path: /v2/<name>/blobs/uploads/<uuid>
  const uuidMatch = path.match(/\/blobs\/uploads\/([^/]+)$/);
  if (!uuidMatch) {
    return c.json(ociError("BLOB_UPLOAD_UNKNOWN", "upload not found"), 404);
  }
  const uuid = uuidMatch[1];

  const parsed = parseV2Path(path, "blobs");
  if (!parsed) return c.json(ociError("NAME_INVALID", "invalid name"), 400);
  const name = parsed.name;

  try {
    const uploadFile = Bun.file(uploadPath(uuid));
    if (!(await uploadFile.exists())) {
      return c.json(ociError("BLOB_UPLOAD_UNKNOWN", "upload session not found"), 404);
    }

    const chunk = await c.req.arrayBuffer();
    const chunkBytes = new Uint8Array(chunk);

    // Append the chunk to the upload accumulator using Bun's writer
    const existingBytes = new Uint8Array(await uploadFile.arrayBuffer());
    const combined = new Uint8Array(existingBytes.length + chunkBytes.length);
    combined.set(existingBytes, 0);
    combined.set(chunkBytes, existingBytes.length);
    await Bun.write(uploadPath(uuid), combined);

    const newSize = combined.length;
    const baseUrl = new URL(c.req.url).origin;
    return new Response(null, {
      status: 202,
      headers: {
        Location: `${baseUrl}/v2/${name}/blobs/uploads/${uuid}`,
        "Docker-Upload-UUID": uuid,
        Range: `0-${Math.max(0, newSize - 1)}`,
        "Content-Length": "0",
      },
    });
  } catch (err) {
    console.error("[oci] patch upload:", err);
    return c.json(ociError("BLOB_UPLOAD_INVALID", "chunk write failed"), 500);
  }
});

// ---------------------------------------------------------------------------
// PUT /v2/:name/blobs/uploads/:uuid?digest=sha256:... — complete upload
// PUT /v2/:name/manifests/:ref — push manifest
// ---------------------------------------------------------------------------
registry.put("/v2/*", async (c) => {
  const path = c.req.path;
  const auth = await authenticateBasic(c.req.header("authorization"));
  if (!auth.ok) {
    return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
  }

  // ── PUT manifest ──────────────────────────────────────────────────────────
  if (path.includes("/manifests/")) {
    const parsed = parseV2Path(path, "manifests");
    if (!parsed) return c.json(ociError("NAME_INVALID", "invalid name"), 400);
    const name = parsed.name;
    const ref = parsed.rest;

    try {
      const body = await c.req.text();
      const bytes = Buffer.from(body);

      // Compute the digest of the manifest
      const h = new Bun.CryptoHasher("sha256");
      h.update(bytes);
      const digest = `sha256:${h.digest("hex")}`;

      // Store manifest under both the ref (tag/digest) and the canonical digest path
      await ensureDir(storePath("manifests", name));
      await ensureDir(storePath("blobs", "sha256"));

      const mPath = manifestPath(name, ref);
      await Bun.write(mPath, bytes);

      // Also write under the digest ref so GET by digest works
      if (ref !== digest) {
        const mDigestPath = manifestPath(name, digest);
        await Bun.write(mDigestPath, bytes);
      }

      // Store the raw bytes in the blob store too (some clients fetch by digest)
      const bp = blobPath(digest);
      const existing = Bun.file(bp);
      if (!(await existing.exists())) {
        await Bun.write(bp, bytes);
      }

      // If ref is a tag (not a digest), record in DB
      const ociRepoId = await findOrCreateOciRepo(auth.user.id, name);
      if (!isValidDigest(ref)) {
        await upsertTag(ociRepoId, ref, digest);
      }

      const contentType =
        c.req.header("content-type") ||
        "application/vnd.oci.image.manifest.v1+json";

      return new Response(null, {
        status: 201,
        headers: {
          "Docker-Content-Digest": digest,
          Location: `/v2/${name}/manifests/${ref}`,
          "Content-Type": contentType,
          "Content-Length": "0",
        },
      });
    } catch (err) {
      console.error("[oci] put manifest:", err);
      return c.json(ociError("MANIFEST_INVALID", "failed to store manifest"), 500);
    }
  }

  // ── PUT /v2/:name/blobs/uploads/:uuid — complete chunked upload ───────────
  const uuidMatch = path.match(/\/blobs\/uploads\/([^/?]+)/);
  if (!uuidMatch) {
    return c.json(ociError("UNSUPPORTED", "unsupported endpoint"), 404);
  }
  const uuid = uuidMatch[1];
  const digestParam = c.req.query("digest");

  if (!digestParam || !isValidDigest(digestParam)) {
    return c.json(ociError("DIGEST_INVALID", "missing or invalid digest query param"), 400);
  }

  try {
    const uploadFile = Bun.file(uploadPath(uuid));
    if (!(await uploadFile.exists())) {
      return c.json(ociError("BLOB_UPLOAD_UNKNOWN", "upload session not found"), 404);
    }

    // There may be a final chunk in the PUT body
    const finalChunk = await c.req.arrayBuffer();
    let allBytes: Uint8Array;
    const existingBytes = new Uint8Array(await uploadFile.arrayBuffer());
    if (finalChunk.byteLength > 0) {
      const chunkBytes = new Uint8Array(finalChunk);
      allBytes = new Uint8Array(existingBytes.length + chunkBytes.length);
      allBytes.set(existingBytes, 0);
      allBytes.set(chunkBytes, existingBytes.length);
    } else {
      allBytes = existingBytes;
    }

    // Verify digest
    const h = new Bun.CryptoHasher("sha256");
    h.update(allBytes);
    const computed = `sha256:${h.digest("hex")}`;
    if (computed !== digestParam) {
      return c.json(ociError("DIGEST_INVALID", "digest mismatch"), 400);
    }

    // Move from uploads to blobs
    await ensureDir(storePath("blobs", "sha256"));
    const bp = blobPath(digestParam);
    const existingBlob = Bun.file(bp);
    if (!(await existingBlob.exists())) {
      await Bun.write(bp, allBytes);
    }

    // Clean up upload temp file
    const uploadFilePath = uploadPath(uuid);
    try {
      await Bun.file(uploadFilePath);
      // Overwrite with empty so it's not left hanging; true deletion needs fs.unlink
      const { unlink } = await import("node:fs/promises");
      await unlink(uploadFilePath).catch(() => {});
    } catch { /* ignore */ }

    const parsed = parseV2Path(path, "blobs");
    const name = parsed?.name ?? "unknown";

    return new Response(null, {
      status: 201,
      headers: {
        "Docker-Content-Digest": digestParam,
        Location: `/v2/${name}/blobs/${digestParam}`,
        "Content-Length": "0",
      },
    });
  } catch (err) {
    console.error("[oci] complete upload:", err);
    return c.json(ociError("BLOB_UPLOAD_INVALID", "failed to finalize upload"), 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /v2/:name/blobs/:digest
// DELETE /v2/:name/manifests/:ref
// ---------------------------------------------------------------------------
registry.delete("/v2/*", async (c) => {
  const path = c.req.path;
  const auth = await authenticateBasic(c.req.header("authorization"));
  if (!auth.ok) {
    return c.json(ociError("UNAUTHORIZED", "authentication required"), 401, UNAUTHORIZED_HEADERS);
  }

  const { unlink } = await import("node:fs/promises");

  // ── DELETE /v2/:name/manifests/:ref ───────────────────────────────────────
  if (path.includes("/manifests/")) {
    const parsed = parseV2Path(path, "manifests");
    if (!parsed) return c.json(ociError("NAME_INVALID", "invalid name"), 400);
    const name = parsed.name;
    const ref = parsed.rest;

    try {
      const mPath = manifestPath(name, ref);
      await unlink(mPath).catch(() => {});

      // Remove tag from DB if ref is a tag
      if (!isValidDigest(ref)) {
        const [repo] = await db
          .select({ id: ociRepositories.id })
          .from(ociRepositories)
          .where(and(eq(ociRepositories.ownerId, auth.user.id), eq(ociRepositories.name, name)))
          .limit(1);
        if (repo) {
          await db
            .delete(ociTags)
            .where(and(eq(ociTags.repositoryId, repo.id), eq(ociTags.tag, ref)));
        }
      }

      return new Response(null, { status: 202 });
    } catch (err) {
      console.error("[oci] delete manifest:", err);
      return c.json(ociError("MANIFEST_UNKNOWN", "manifest not found"), 404);
    }
  }

  // ── DELETE /v2/:name/blobs/:digest ────────────────────────────────────────
  if (path.includes("/blobs/")) {
    const digestMatch = path.match(/\/blobs\/(sha256:[0-9a-f]{64})$/);
    if (!digestMatch) {
      return c.json(ociError("DIGEST_INVALID", "invalid digest"), 400);
    }
    const digest = digestMatch[1];
    const bp = blobPath(digest);
    const file = Bun.file(bp);
    if (!(await file.exists())) {
      return c.json(ociError("BLOB_UNKNOWN", "blob not found"), 404);
    }
    await unlink(bp).catch(() => {});
    return new Response(null, { status: 202 });
  }

  return c.json(ociError("UNSUPPORTED", "unsupported endpoint"), 404);
});

export default registry;
