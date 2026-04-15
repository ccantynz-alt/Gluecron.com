/**
 * Git Smart HTTP routes.
 *
 * Mounted at /:owner/:repo.git/ — handles clone, fetch, push.
 */

import { Hono } from "hono";
import { getInfoRefs, serviceRpc } from "../git/protocol";
import { repoExists } from "../git/repository";
import { onPostReceive } from "../hooks/post-receive";
import { invalidateRepoCache } from "../lib/cache";
import { trackByName } from "../lib/traffic";

const git = new Hono();

// Discovery: GET /:owner/:repo.git/info/refs?service=...
git.get("/:owner/:repo.git/info/refs", async (c) => {
  const { owner, repo } = c.req.param();
  const service = c.req.query("service");

  if (!service || !["git-upload-pack", "git-receive-pack"].includes(service)) {
    return c.text("Invalid service", 400);
  }

  if (!(await repoExists(owner, repo))) {
    return c.text("Repository not found", 404);
  }

  return getInfoRefs(owner, repo, service);
});

// GET /:owner/:repo.git/HEAD
git.get("/:owner/:repo.git/HEAD", async (c) => {
  const { owner, repo } = c.req.param();
  if (!(await repoExists(owner, repo))) {
    return c.text("Repository not found", 404);
  }
  const path = `repos/${owner}/${repo}.git/HEAD`;
  const file = Bun.file(path);
  if (!(await file.exists())) return c.text("Not found", 404);
  return c.text(await file.text());
});

// Upload pack (clone/fetch)
git.post("/:owner/:repo.git/git-upload-pack", async (c) => {
  const { owner, repo } = c.req.param();
  if (!(await repoExists(owner, repo))) {
    return c.text("Repository not found", 404);
  }
  // F1 — fire-and-forget clone tracking.
  trackByName(owner, repo, "clone", {
    ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
    userAgent: c.req.header("user-agent") || null,
  }).catch(() => {});
  return serviceRpc(owner, repo, "git-upload-pack", c.req.raw.body);
});

// Receive pack (push)
git.post("/:owner/:repo.git/git-receive-pack", async (c) => {
  const { owner, repo } = c.req.param();
  if (!(await repoExists(owner, repo))) {
    return c.text("Repository not found", 404);
  }

  // Parse the incoming refs from the request body before passing to git
  const bodyBuffer = await c.req.arrayBuffer();
  const response = await serviceRpc(
    owner,
    repo,
    "git-receive-pack",
    bodyBuffer
  );

  // Invalidate cached git data for this repo immediately
  invalidateRepoCache(owner, repo);

  // Fire post-receive hooks asynchronously (don't block response)
  // We parse updated refs from the pkt-line protocol in the request
  const refs = parseReceivePackRefs(new Uint8Array(bodyBuffer));
  if (refs.length > 0) {
    onPostReceive(owner, repo, refs).catch((err) =>
      console.error("[post-receive] hook error:", err)
    );
  }

  return response;
});

/**
 * Parse ref updates from git-receive-pack request body.
 * Format: <old-sha> <new-sha> <ref-name>
 */
function parseReceivePackRefs(
  data: Uint8Array
): Array<{ oldSha: string; newSha: string; refName: string }> {
  const text = new TextDecoder().decode(data);
  const refs: Array<{ oldSha: string; newSha: string; refName: string }> = [];
  // Pkt-line format: 4-hex-length followed by data
  let offset = 0;
  while (offset < text.length) {
    const lenHex = text.slice(offset, offset + 4);
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      offset += 4;
      break; // flush packet
    }
    if (len < 4) break;
    const line = text.slice(offset + 4, offset + len);
    offset += len;

    // Match: <old-sha> <new-sha> <ref-name>\0<capabilities>
    // or:    <old-sha> <new-sha> <ref-name>
    const match = line.match(
      /^([0-9a-f]{40}) ([0-9a-f]{40}) ([^\0\n]+)/
    );
    if (match) {
      refs.push({
        oldSha: match[1],
        newSha: match[2],
        refName: match[3].trim(),
      });
    }
  }
  return refs;
}

export default git;
