/**
 * `gluecron/upload-artifact@v1` — persists files from the workspace as a
 * named artifact attached to the current run.
 *
 * Wraps Agent 6's `uploadArtifact` helper. `with:` inputs:
 *   name: string   (required) — artifact name, stored on the run
 *   path: string   (required) — file or directory inside `ctx.workspace`
 *
 * Behaviour:
 *   - If `path` resolves to a single file, the file is uploaded as-is with
 *     contentType inferred from the extension.
 *   - If `path` resolves to a directory, the directory is tar-gz'd first and
 *     uploaded as `application/gzip`.
 *   - If the artifact helper module can't be imported (e.g. out-of-tree
 *     deployment) the step degrades gracefully to exitCode 0 with a stderr
 *     note — a missing upload must never fail the pipeline unrelated to it.
 *   - Other errors (missing file, oversize, DB failure) return exitCode 1.
 */

import { stat } from "fs/promises";
import { basename, join } from "path";
import { tmpdir } from "os";
import type { ActionHandler, ActionContext } from "../action-registry";

function parseInputs(
  ctx: ActionContext
): { name: string; path: string } | { error: string } {
  const w = ctx.with || {};
  const name = typeof w.name === "string" ? w.name.trim() : "";
  const path = typeof w.path === "string" ? w.path.trim() : "";
  if (!name) return { error: "upload-artifact: `name` is required" };
  if (!path) return { error: "upload-artifact: `path` is required" };
  return { name, path };
}

function guessContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "application/gzip";
  if (lower.endsWith(".gz")) return "application/gzip";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".tar")) return "application/x-tar";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

/**
 * Tar-gz a directory into a tmp file and return the buffered bytes. Cleans
 * up the tmp file regardless of success.
 */
async function tarGzDirectory(dir: string): Promise<Buffer> {
  const tmpPath = join(
    tmpdir(),
    `gluecron-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`
  );
  try {
    const proc = Bun.spawn(
      ["tar", "-czf", tmpPath, "-C", dir, "."],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exit = await proc.exited;
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text().catch(() => "");
      throw new Error(`tar failed (exit ${exit}): ${err.slice(0, 200)}`);
    }
    const bytes = await Bun.file(tmpPath).arrayBuffer();
    return Buffer.from(bytes);
  } finally {
    try {
      const fs = await import("fs/promises");
      await fs.unlink(tmpPath).catch(() => {});
    } catch {
      /* noop */
    }
  }
}

export const uploadArtifactAction: ActionHandler = {
  name: "gluecron/upload-artifact",
  version: "v1",
  async run(ctx) {
    try {
      const parsed = parseInputs(ctx);
      if ("error" in parsed) {
        return { exitCode: 1, stderr: parsed.error };
      }

      // Dynamic import so a missing helper module degrades gracefully
      // rather than crashing the registry at load time.
      let uploadArtifact: typeof import("../workflow-artifacts").uploadArtifact;
      try {
        ({ uploadArtifact } = await import("../workflow-artifacts"));
      } catch (err) {
        return {
          exitCode: 0,
          stderr:
            "upload-artifact unavailable; skipping (" +
            (err instanceof Error ? err.message : String(err)) +
            ")",
        };
      }

      const abs = join(ctx.workspace, parsed.path);
      let info;
      try {
        info = await stat(abs);
      } catch (err) {
        return {
          exitCode: 1,
          stderr:
            `upload-artifact: path not found: ${parsed.path} (${err instanceof Error ? err.message : String(err)})`,
        };
      }

      let content: Buffer;
      let contentType: string;
      if (info.isDirectory()) {
        content = await tarGzDirectory(abs);
        contentType = "application/gzip";
      } else if (info.isFile()) {
        const bytes = await Bun.file(abs).arrayBuffer();
        content = Buffer.from(bytes);
        contentType = guessContentType(basename(abs));
      } else {
        return {
          exitCode: 1,
          stderr: `upload-artifact: unsupported path type for ${parsed.path}`,
        };
      }

      const result = await uploadArtifact({
        runId: ctx.runId,
        jobId: ctx.jobId,
        name: parsed.name,
        content,
        contentType,
      });

      if (!result.ok) {
        return {
          exitCode: 1,
          stderr: `upload-artifact: ${result.error}`,
        };
      }

      return {
        exitCode: 0,
        stdout: `Uploaded artifact "${parsed.name}" (${content.byteLength} bytes, ${contentType})`,
        outputs: {
          "artifact-id": result.artifactId,
          name: parsed.name,
          size: String(content.byteLength),
        },
      };
    } catch (err) {
      return {
        exitCode: 1,
        stderr:
          "upload-artifact error: " +
          (err instanceof Error ? err.message : String(err)),
      };
    }
  },
};
