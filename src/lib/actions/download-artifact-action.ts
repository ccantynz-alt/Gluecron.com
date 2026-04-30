/**
 * `gluecron/download-artifact@v1` — restores a previously uploaded artifact
 * into the workspace. Inverse of `upload-artifact@v1`.
 *
 * `with:` inputs:
 *   name: string         (required) — artifact name to fetch
 *   path?: string        (optional) — destination dir relative to workspace;
 *                                     defaults to '.'
 *   optional?: boolean   (optional) — when true, a missing artifact returns
 *                                     exitCode 0 (otherwise 1)
 *
 * If the stored artifact is a tar-gz (content-type `application/gzip` or
 * `application/x-tar`), it's extracted into the destination directory. Any
 * other content type is written as-is to `<dest>/<name>`.
 *
 * Like its sibling, gracefully degrades when the helper module can't be
 * imported (exitCode 0 with stderr note).
 */

import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import type { ActionHandler, ActionContext } from "../action-registry";

function parseInputs(
  ctx: ActionContext
): { name: string; path: string; optional: boolean } | { error: string } {
  const w = ctx.with || {};
  const name = typeof w.name === "string" ? w.name.trim() : "";
  const pathRaw = typeof w.path === "string" ? w.path.trim() : "";
  const path = pathRaw || ".";
  const optional = w.optional === true || w.optional === "true";
  if (!name) return { error: "download-artifact: `name` is required" };
  return { name, path, optional };
}

function isArchive(contentType: string): boolean {
  const ct = (contentType || "").toLowerCase();
  return (
    ct === "application/gzip" ||
    ct === "application/x-gzip" ||
    ct === "application/x-tar" ||
    ct === "application/tar+gzip"
  );
}

async function extractArchive(content: Buffer, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const tmpPath = join(
    tmpdir(),
    `gluecron-dl-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}.tar.gz`
  );
  await Bun.write(tmpPath, content);
  try {
    const proc = Bun.spawn(
      ["tar", "-xf", tmpPath, "-C", destDir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exit = await proc.exited;
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text().catch(() => "");
      throw new Error(`tar extract failed (exit ${exit}): ${err.slice(0, 200)}`);
    }
  } finally {
    try {
      const fs = await import("fs/promises");
      await fs.unlink(tmpPath).catch(() => {});
    } catch {
      /* noop */
    }
  }
}

export const downloadArtifactAction: ActionHandler = {
  name: "gluecron/download-artifact",
  version: "v1",
  async run(ctx): Promise<import("../action-registry").ActionResult> {
    try {
      const parsed = parseInputs(ctx);
      if ("error" in parsed) {
        return { exitCode: 1, stderr: parsed.error };
      }

      // Dynamic import so a missing helper module degrades gracefully.
      let listArtifacts: typeof import("../workflow-artifacts").listArtifacts;
      let downloadArtifact: typeof import("../workflow-artifacts").downloadArtifact;
      try {
        const mod = await import("../workflow-artifacts");
        listArtifacts = mod.listArtifacts;
        downloadArtifact = mod.downloadArtifact;
      } catch (err) {
        return {
          exitCode: 0,
          stderr:
            "download-artifact unavailable; skipping (" +
            (err instanceof Error ? err.message : String(err)) +
            ")",
        };
      }

      const listed = await listArtifacts(ctx.runId);
      if (!listed.ok) {
        return {
          exitCode: parsed.optional ? 0 : 1,
          stderr: `download-artifact: list failed: ${listed.error}`,
        };
      }

      const match = listed.artifacts.find((a) => a.name === parsed.name);
      if (!match) {
        const msg = `download-artifact: no artifact named "${parsed.name}" on run ${ctx.runId}`;
        return {
          exitCode: parsed.optional ? 0 : 1,
          stderr: msg,
          outputs: { found: "false" },
        };
      }

      const fetched = await downloadArtifact(match.id);
      if (!fetched.ok) {
        return {
          exitCode: parsed.optional ? 0 : 1,
          stderr: `download-artifact: fetch failed: ${fetched.error}`,
        };
      }

      const destDir = join(ctx.workspace, parsed.path);
      if (isArchive(fetched.contentType)) {
        await extractArchive(fetched.content, destDir);
      } else {
        const outPath = join(destDir, parsed.name);
        await mkdir(dirname(outPath), { recursive: true });
        await Bun.write(outPath, fetched.content);
      }

      return {
        exitCode: 0,
        stdout: `Downloaded artifact "${parsed.name}" (${fetched.content.byteLength} bytes) to ${parsed.path}`,
        outputs: {
          found: "true",
          "artifact-id": match.id,
          name: parsed.name,
          size: String(fetched.content.byteLength),
        },
      };
    } catch (err) {
      return {
        exitCode: 1,
        stderr:
          "download-artifact error: " +
          (err instanceof Error ? err.message : String(err)),
      };
    }
  },
};
