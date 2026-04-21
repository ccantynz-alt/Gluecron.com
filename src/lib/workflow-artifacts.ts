/**
 * Workflow artifact helpers (Block C1 / Sprint 1 — Agent 6).
 *
 * Pure functions for uploading, listing, downloading and deleting workflow
 * run artifacts. Shared between the REST API (`src/routes/workflow-artifacts.ts`)
 * and in-process action handlers (e.g. `gluecron/upload-artifact@v1`,
 * `gluecron/download-artifact@v1` — built by Agent 8).
 *
 * Storage contract: `workflow_artifacts.content` is declared as `text` in
 * drizzle (base64-encoded bytes), even though the underlying column type is
 * `bytea`. This mismatch is intentional for v1 — see the `bytea` customType
 * comment in `src/db/schema.ts`. We therefore base64-encode on write and
 * base64-decode on read.
 *
 * These functions never throw. DB/validation failures return
 * `{ ok: false, error }`.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { workflowArtifacts } from "../db/schema";

/** 100 MiB — matches the REST API cap. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

const NAME_RE = /^[A-Za-z0-9._-]+$/;

function toBuffer(input: Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(input)) return input;
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export async function uploadArtifact(args: {
  runId: string;
  jobId: string;
  name: string;
  content: Uint8Array | Buffer;
  contentType?: string;
}): Promise<{ ok: true; artifactId: string } | { ok: false; error: string }> {
  const { runId, jobId, name, content } = args;
  const contentType = args.contentType || "application/octet-stream";

  if (!runId || typeof runId !== "string") {
    return { ok: false, error: "runId is required" };
  }
  if (!jobId || typeof jobId !== "string") {
    return { ok: false, error: "jobId is required" };
  }
  if (!name || typeof name !== "string") {
    return { ok: false, error: "name is required" };
  }
  if (name.length > 255) {
    return { ok: false, error: "name too long (max 255 chars)" };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: "name must match /^[A-Za-z0-9._-]+$/",
    };
  }

  const buf = toBuffer(content);
  if (buf.byteLength > MAX_ARTIFACT_BYTES) {
    return { ok: false, error: "artifact exceeds 100MB limit" };
  }

  try {
    const [row] = await db
      .insert(workflowArtifacts)
      .values({
        runId,
        jobId,
        name,
        sizeBytes: buf.byteLength,
        contentType,
        // Stored as base64 text for v1 (see schema comment).
        content: buf.toString("base64"),
      })
      .returning({ id: workflowArtifacts.id });

    if (!row) {
      return { ok: false, error: "insert returned no row" };
    }
    return { ok: true, artifactId: row.id };
  } catch (err) {
    console.error("[workflow-artifacts] uploadArtifact:", err);
    return { ok: false, error: "database error" };
  }
}

export async function listArtifacts(
  runId: string
): Promise<
  | {
      ok: true;
      artifacts: {
        id: string;
        name: string;
        size: number;
        contentType: string;
        createdAt: Date;
      }[];
    }
  | { ok: false; error: string }
> {
  if (!runId || typeof runId !== "string") {
    return { ok: false, error: "runId is required" };
  }
  try {
    const rows = await db
      .select({
        id: workflowArtifacts.id,
        name: workflowArtifacts.name,
        size: workflowArtifacts.sizeBytes,
        contentType: workflowArtifacts.contentType,
        createdAt: workflowArtifacts.createdAt,
      })
      .from(workflowArtifacts)
      .where(eq(workflowArtifacts.runId, runId));

    return { ok: true, artifacts: rows };
  } catch (err) {
    console.error("[workflow-artifacts] listArtifacts:", err);
    return { ok: false, error: "database error" };
  }
}

export async function downloadArtifact(
  artifactId: string
): Promise<
  | { ok: true; name: string; contentType: string; content: Buffer }
  | { ok: false; error: string }
> {
  if (!artifactId || typeof artifactId !== "string") {
    return { ok: false, error: "artifactId is required" };
  }
  try {
    const [row] = await db
      .select()
      .from(workflowArtifacts)
      .where(eq(workflowArtifacts.id, artifactId))
      .limit(1);

    if (!row) {
      return { ok: false, error: "not found" };
    }

    const raw = row.content;
    const buf = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
    return {
      ok: true,
      name: row.name,
      contentType: row.contentType,
      content: buf,
    };
  } catch (err) {
    console.error("[workflow-artifacts] downloadArtifact:", err);
    return { ok: false, error: "database error" };
  }
}

export async function deleteArtifact(
  artifactId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!artifactId || typeof artifactId !== "string") {
    return { ok: false, error: "artifactId is required" };
  }
  try {
    const res = await db
      .delete(workflowArtifacts)
      .where(eq(workflowArtifacts.id, artifactId))
      .returning({ id: workflowArtifacts.id });

    if (res.length === 0) {
      return { ok: false, error: "not found" };
    }
    return { ok: true };
  } catch (err) {
    console.error("[workflow-artifacts] deleteArtifact:", err);
    return { ok: false, error: "database error" };
  }
}

/**
 * Internal helper for the REST layer: returns just the owning repositoryId
 * for a run. Kept here so both the API route and any future helpers share
 * the same lookup without reaching into `workflowRuns` directly from N places.
 */
export async function getRunRepositoryId(
  runId: string
): Promise<string | null> {
  try {
    const { workflowRuns } = await import("../db/schema");
    const [row] = await db
      .select({ repositoryId: workflowRuns.repositoryId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    return row ? row.repositoryId : null;
  } catch (err) {
    console.error("[workflow-artifacts] getRunRepositoryId:", err);
    return null;
  }
}

/**
 * Internal helper: look up a single artifact's runId (used by GET/DELETE
 * endpoints that only receive `:artifactId`).
 */
export async function getArtifactRunId(
  artifactId: string
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ runId: workflowArtifacts.runId })
      .from(workflowArtifacts)
      .where(eq(workflowArtifacts.id, artifactId))
      .limit(1);
    return row ? row.runId : null;
  } catch (err) {
    console.error("[workflow-artifacts] getArtifactRunId:", err);
    return null;
  }
}
