/**
 * Git Smart HTTP routes.
 *
 * Mounted at /:owner/:repo.git/ — handles clone, fetch, push.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { getInfoRefs, serviceRpc } from "../git/protocol";
import { repoExists } from "../git/repository";
import { onPostReceive } from "../hooks/post-receive";
import { invalidateRepoCache } from "../lib/cache";
import { trackByName } from "../lib/traffic";
import {
  evaluatePushPolicy,
  formatPolicyError,
  installPackInspectionHookForRepo,
} from "../lib/push-policy";
import { resolvePusher } from "../lib/git-push-auth";
import { audit } from "../lib/notify";

const git = new Hono();

/** Extract repo name from the ":repo.git" param Hono generates. */
function gitParams(c: any): { owner: string; repo: string } {
  const params = c.req.param();
  const owner: string = params.owner;
  const raw: string = params["repo.git"] ?? params.repo ?? "";
  const repo = raw.replace(/\.git$/, "");
  return { owner, repo };
}

// Discovery: GET /:owner/:repo.git/info/refs?service=...
git.get("/:owner/:repo.git/info/refs", async (c) => {
  const { owner, "repo.git": repo } = c.req.param();
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
  const { owner, "repo.git": repo } = c.req.param();
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
  const { owner, "repo.git": repo } = c.req.param();
  if (!(await repoExists(owner, repo))) {
    return c.text("Repository not found", 404);
  }
  // F1 — fire-and-forget clone tracking. Log on failure so traffic-stats
  // gaps are diagnosable (was a silent .catch(() => {}).)
  trackByName(owner, repo, "clone", {
    ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || null,
    userAgent: c.req.header("user-agent") || null,
  }).catch((err) => {
    console.warn(
      `[git] clone tracking failed for ${owner}/${repo}:`,
      err instanceof Error ? err.message : err
    );
  });
  return serviceRpc(owner, repo, "git-upload-pack", c.req.raw.body);
});

// Receive pack (push)
git.post("/:owner/:repo.git/git-receive-pack", async (c) => {
  const { owner, "repo.git": repoRaw } = c.req.param();
  const repo = (repoRaw || "").replace(/\.git$/, "");
  if (!(await repoExists(owner, repoRaw))) {
    return c.text("Repository not found", 404);
  }

  // Read the body once; we parse refs from it for both pre-receive policy
  // checks and the existing post-receive hook.
  const bodyBuffer = await c.req.arrayBuffer();
  const refs = parseReceivePackRefs(new Uint8Array(bodyBuffer));

  // Resolve the pusher early so we can pass it to both the policy gate and
  // the post-receive hook (e.g. for AI auto-issue attribution).
  let pusherUserId = "";
  try {
    const pusher = await resolvePusher(c.req.header("authorization"));
    pusherUserId = pusher?.userId || "";
  } catch {
    // Fail open — policy gate and post-receive handle missing pushers fine.
  }

  // Pre-receive policy: protected tags + ruleset name patterns. Fail-open
  // on any DB hiccup (the helper returns {allowed:true} in that case).
  // We also retain the repoRow so the pack-inspection hook below can reuse it.
  let cachedRepoId: string | null = null;
  if (refs.length > 0) {
    try {
      const repoRow = await loadRepoRow(owner, repo);
      if (repoRow) {
        cachedRepoId = repoRow.id;
        const decision = await evaluatePushPolicy({
          repositoryId: repoRow.id,
          refs,
          pusherUserId: pusherUserId || null,
        });
        if (!decision.allowed) {
          // Audit the rejection so owners can see blocked-push attempts
          // even though the request never reached the post-receive hook.
          // Fire-and-forget — never block the 403.
          audit({
            userId: pusherUserId || null,
            repositoryId: repoRow.id,
            action: "push.rejected",
            targetType: "repository",
            targetId: repoRow.id,
            ip:
              c.req.header("x-forwarded-for") ||
              c.req.header("x-real-ip") ||
              undefined,
            userAgent: c.req.header("user-agent") || undefined,
            metadata: {
              violations: decision.violations,
              refs: refs.map((r) => r.refName),
              pusherSource: pusherUserId ? "user" : "anonymous",
            },
          }).catch((err) => {
            console.warn(
              `[git] push.rejected audit write failed for ${owner}/${repo}:`,
              err instanceof Error ? err.message : err
            );
          });
          // Returning 403 with a plain-text body — git smart-HTTP clients
          // surface the body to the user (`remote: ` prefix). Existing
          // behaviour for repos with no policy is unchanged.
          return c.text(formatPolicyError(decision.violations), 403);
        }
      }
    } catch {
      // Never wedge a legitimate push on enforcer failure.
    }
  }

  // Pack-content inspection: install a pre-receive hook that enforces
  // commit_message_pattern, blocked_file_paths, and max_file_size rules.
  // git-receive-pack runs the hook before promoting quarantined objects, so
  // a hook exit-1 leaves the repo unchanged.  We clean up the temp dir
  // unconditionally after serviceRpc returns.
  let hookEnv: Record<string, string> | undefined;
  let hookCleanup: (() => Promise<void>) | undefined;
  if (refs.length > 0 && cachedRepoId) {
    try {
      const hook = await installPackInspectionHookForRepo(cachedRepoId);
      if (hook) {
        hookEnv = hook.env;
        hookCleanup = hook.cleanup;
      }
    } catch {
      // fail-open
    }
  }

  let response: Response;
  try {
    response = await serviceRpc(
      owner,
      repoRaw,
      "git-receive-pack",
      bodyBuffer,
      hookEnv
    );
  } finally {
    hookCleanup?.().catch(() => {});
  }

  // Invalidate cached git data for this repo immediately
  invalidateRepoCache(owner, repo);

  // Fire post-receive hooks asynchronously (don't block response).
  if (refs.length > 0) {
    onPostReceive(owner, repo, refs, pusherUserId).catch((err) =>
      console.error("[post-receive] hook error:", err)
    );
  }

  return response;
});

/**
 * Look up the repositories row keyed by owner username + repo name.
 * Pure DB helper kept local to this file because it's only used by the
 * push-policy gate; returns null on miss/error so the caller fails open.
 */
async function loadRepoRow(
  ownerName: string,
  repoName: string
): Promise<{ id: string } | null> {
  try {
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerRow) return null;
    const [repoRow] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    return repoRow || null;
  } catch {
    return null;
  }
}

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
