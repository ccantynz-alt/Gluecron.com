/**
 * Post-receive hook logic.
 *
 * Called after every successful git push. This is gluecron's intelligence layer:
 * 1. Auto-repair — fix common issues and commit automatically
 * 2. Push analysis — detect breaking changes, security issues
 * 3. Health score — recompute repo health
 * 4. GateTest scan — external security scanning
 * 5. Crontech deploy — auto-deploy on push to main
 * 6. Webhooks — fire registered webhook URLs
 */

import { createHmac } from "crypto";
import { and, eq } from "drizzle-orm";
import { config } from "../lib/config";
import { autoRepair } from "../lib/autorepair";
import { notifyGateTestOfPush } from "../lib/gate";
import { analyzePush, computeHealthScore } from "../lib/intelligence";
import { db } from "../db";
import { deployments, repositories, users } from "../db/schema";
import { onDeployFailure } from "../lib/ai-incident";
import {
  commitsBetween,
  getDefaultBranch,
  getRepoPath,
} from "../git/repository";
import { indexChangedFiles } from "../lib/semantic-index";
import { scanDiffForIssues } from "../lib/ai-auto-issues";
import { enqueuePreviewBuild } from "../lib/branch-previews";
import { scanDependencies } from "../lib/dependency-scanner";
import { runDocDriftCheckForRepo } from "../lib/ai-doc-updater";
import {
  findTargetsForPush,
  finishDeployRow,
  resolveEnv,
  startDeployRow,
} from "../lib/server-target-store";
import { deployToTarget } from "../lib/server-targets";
import { fireCloudDeploys } from "../lib/cloud-deploy";
import { ensureRepoOnboarding } from "../lib/repo-onboarding";

interface PushRef {
  oldSha: string;
  newSha: string;
  refName: string;
}

export async function onPostReceive(
  owner: string,
  repo: string,
  refs: PushRef[],
  pusherUserId: string = ""
): Promise<void> {
  for (const ref of refs) {
    if (ref.newSha.startsWith("0000")) continue; // Branch deletion
    const branchName = ref.refName.replace("refs/heads/", "");

    // 1. Auto-repair (runs first, may create a new commit)
    try {
      const repair = await autoRepair(owner, repo, branchName);
      if (repair.repaired) {
        console.log(
          `[autorepair] ${owner}/${repo}@${branchName}: ${repair.repairs.length} repairs committed`
        );
      }
    } catch (err) {
      console.error(`[autorepair] error:`, err);
    }

    // 2. Push analysis
    try {
      const analysis = await analyzePush(owner, repo, ref.oldSha, ref.newSha);
      console.log(
        `[push-analysis] ${owner}/${repo}: ${analysis.summary}`
      );
      if (analysis.riskScore > 50) {
        console.warn(
          `[push-analysis] HIGH RISK push detected (score: ${analysis.riskScore})`
        );
      }
      if (analysis.breakingChangeSignals.length > 0) {
        console.warn(
          `[push-analysis] Breaking changes: ${analysis.breakingChangeSignals.join("; ")}`
        );
      }
    } catch (err) {
      console.error(`[push-analysis] error:`, err);
    }

    // 3. Health score (async, don't block)
    computeHealthScore(owner, repo).then((report) => {
      console.log(
        `[health] ${owner}/${repo}: ${report.grade} (${report.score}/100)`
      );
    }).catch((err) => {
      console.error(`[health] error:`, err);
    });
  }

  // 4. GateTest scan — fire-and-forget notification on every push. The
  //    helper short-circuits if `GATETEST_URL` is unset, so non-GateTest
  //    deployments pay no overhead. Results flow back via the inbound
  //    webhook at POST /api/hooks/gatetest.
  for (const ref of refs) {
    if (ref.newSha.startsWith("0000")) continue;
    notifyGateTestOfPush(owner, repo, ref.refName, ref.newSha).catch((err) =>
      console.warn("[gatetest] notify error:", err)
    );
  }

  // 4b. Continuous semantic index — embed changed files on every push so
  //     /api/v2/.../semantic-search has fresh vectors. Fire-and-forget;
  //     all failures are swallowed inside semantic-index.ts so a missing
  //     pgvector extension or absent embeddings API key never breaks the
  //     push path. Capped to MAX_FILES_PER_PUSH inside the lib.
  for (const ref of refs) {
    if (ref.newSha.startsWith("0000")) continue;
    void fireSemanticIndex(owner, repo, ref.oldSha, ref.newSha).catch((err) =>
      console.warn("[semantic-index] dispatch error:", err)
    );
  }

  // 4c. Per-branch preview URLs (migration 0062). Every push to a
  //     non-default branch enqueues a preview-build row. Gated on
  //     repositories.preview_builds_enabled (default on) so owners can
  //     opt out per-repo via repo-settings. Fire-and-forget; failures
  //     never break the push path.
  void firePreviewBuilds(owner, repo, refs).catch((err) =>
    console.warn("[branch-previews] dispatch error:", err)
  );

  // 4e. AI Auto-Issue Opener. Scans the diff for each pushed ref for
  //     TODO/FIXME/HACK comments, hardcoded secrets, SQL injection patterns,
  //     and debug console.log calls. Opens one issue per finding type per
  //     file (capped at MAX_ISSUES_PER_PUSH). Gated on AI_AUTO_ISSUES=1.
  //     Fire-and-forget; never blocks the push path.
  for (const ref of refs) {
    if (ref.newSha.startsWith("0000")) continue;
    scanDiffForIssues(owner, repo, ref.oldSha, ref.newSha, pusherUserId).catch(
      (err) => console.warn("[ai-auto-issues] dispatch error:", err)
    );
  }

  // 4f. Dependency CVE scanner — when DEPENDENCY_SCAN_ENABLED=1, scan
  //     every push that touches a recognized manifest file (package.json,
  //     requirements.txt, Cargo.toml, go.mod, Gemfile). Auto-opens issues
  //     for critical/high findings and updates a weekly digest for
  //     medium/low. Fire-and-forget; never blocks the push path.
  if (config.dependencyScanEnabled) {
    void fireDependencyScan(owner, repo, refs).catch((err) =>
      console.warn("[dependency-scanner] dispatch error:", err)
    );
  }

  // 4d. AI-tracked documentation drift check (migration 0068). Walks the
  //     repo's markdown files for `<!-- gluecron:doc-track ... -->`
  //     regions, hashes the referenced source, and opens a PR labelled
  //     `ai:doc-update` when the prose drifts. Fire-and-forget; failures
  //     are swallowed inside ai-doc-updater.ts so a missing anthropic key
  //     or empty doc_tracking table never breaks the push.
  void fireDocDriftCheck(owner, repo).catch((err) =>
    console.warn("[ai-doc-updater] dispatch error:", err)
  );

  // 4g. Smart empty states — repo onboarding. On the very first push to a
  //     repo's default branch (oldSha all-zeros), generate a README draft,
  //     suggested labels, and gates.yml starter using Claude Sonnet.
  //     Idempotent: ensureRepoOnboarding skips if a row already exists.
  //     Fire-and-forget; never blocks the push path.
  void fireRepoOnboarding(owner, repo, refs).catch((err) =>
    console.warn("[repo-onboarding] dispatch error:", err)
  );

  // 5. Crontech deploy (BLK-016) — only fires for the configured Crontech repo
  //    (CRONTECH_REPO, default `ccantynz-alt/crontech`) on a push to its
  //    default branch. The branch case (`Main` vs `main`) is determined by
  //    the bare repo's HEAD, not hardcoded.
  if (`${owner}/${repo}` === config.crontechRepo) {
    let defaultBranch =
      (await getDefaultBranch(owner, repo).catch((err) => {
        console.warn(
          `[post-receive] getDefaultBranch failed for ${owner}/${repo}, defaulting to "main":`,
          err instanceof Error ? err.message : err
        );
        return null;
      })) || "main";
    const targetRef = `refs/heads/${defaultBranch}`;
    const deployPush = refs.find(
      (r) => r.refName === targetRef && !r.newSha.startsWith("0000")
    );
    if (deployPush) {
      let repositoryId = "";
      try {
        const [row] = await db
          .select({ id: repositories.id })
          .from(repositories)
          .innerJoin(users, eq(repositories.ownerId, users.id))
          .where(and(eq(users.username, owner), eq(repositories.name, repo)))
          .limit(1);
        repositoryId = row?.id || "";
      } catch {
        /* ignore */
      }
      if (repositoryId) {
        triggerCrontechDeploy({
          owner,
          repo,
          before: deployPush.oldSha,
          after: deployPush.newSha,
          ref: targetRef,
          branch: defaultBranch,
          repositoryId,
        }).catch((err: unknown) => console.error(`[crontech] error:`, err));
      }
    }
  }

  // 5b. Block ST — Server targets. After core post-receive work, fire
  //     deploys against any `server_targets` row whose
  //     (watched_repository_id, watched_branch) matches a pushed ref.
  //     Fire-and-forget; deploy results land in `server_target_deployments`
  //     and the UI at /admin/servers/:id surfaces them.
  void fireServerTargetDeploys(owner, repo, refs).catch((err) =>
    console.warn("[server-targets] dispatch error:", err)
  );

  // 5c. Cloud deploy integrations (migration 0077). Fire push-triggered
  //     deploys to Fly.io, Railway, Render, Vercel, Netlify, or a generic
  //     webhook for any cloud_deploy_configs rows matching the pushed branch.
  //     Fire-and-forget; all failures are swallowed so the push path is
  //     never blocked.
  void fireCloudDeploys(owner, repo, refs).catch((err) =>
    console.warn("[cloud-deploy] dispatch error:", err)
  );

  // 6. BLOCK W — Self-host. When Gluecron.com itself receives a push to
  // main, fire the local deploy via scripts/self-deploy.sh. The script
  // forks into the background, so this call returns immediately (git
  // push doesn't block). Gated on env SELF_HOST_REPO (set on the box) to
  // avoid firing on customer repos that happen to be named "Gluecron.com".
  const selfHostRepo = process.env.SELF_HOST_REPO;
  if (selfHostRepo && `${owner}/${repo}` === selfHostRepo) {
    const mainRef = refs.find(
      (r) => r.refName === "refs/heads/main" && !r.newSha.startsWith("0000")
    );
    if (mainRef) {
      const scriptPath =
        process.env.GLUECRON_SELF_DEPLOY_SCRIPT ||
        "/opt/gluecron/scripts/self-deploy.sh";
      try {
        const child = __selfHostSpawn(
          [scriptPath, mainRef.oldSha, mainRef.newSha],
          { stdout: "ignore", stderr: "ignore", stdin: "ignore" }
        );
        try {
          (child as any)?.unref?.();
        } catch {
          /* unref optional */
        }
        console.log(
          `[self-host] dispatched self-deploy for ${owner}/${repo}@${mainRef.newSha.slice(0, 7)}`
        );
      } catch (err) {
        console.error(`[self-host] failed to spawn:`, err);
      }
    }
  }
}

// BLOCK W — DI seam so the test suite can capture the spawn call without
// actually shelling out to /opt/gluecron/scripts/self-deploy.sh. Production
// callers go straight to Bun.spawn.
const __defaultSelfHostSpawn: (cmd: string[], opts: any) => any = (cmd, opts) =>
  Bun.spawn(cmd, opts);
let __selfHostSpawn: (cmd: string[], opts: any) => any = __defaultSelfHostSpawn;
/**
 * Test-only: replace the spawn impl. Pass `null` to reset to Bun.spawn.
 */
export function __setSelfHostSpawnForTests(
  fn: typeof __selfHostSpawn | null
): void {
  __selfHostSpawn = fn ?? __defaultSelfHostSpawn;
}

/**
 * BLK-016 — outbound deploy webhook for Crontech's deploy-agent.
 *
 * Wire contract (matches Crontech's `apps/api/src/webhooks/gluecron-push.ts`):
 *
 *   POST  https://crontech.ai/api/webhooks/gluecron-push
 *   Content-Type: application/json
 *   X-Gluecron-Signature: sha256=<hex(hmac-sha256(body, GLUECRON_WEBHOOK_SECRET))>
 *
 *   {
 *     "event": "push",
 *     "repository": { "full_name": "ccantynz-alt/crontech" },
 *     "ref": "refs/heads/Main",
 *     "after":  "<40-hex commit SHA>",
 *     "before": "<40-hex previous SHA>",
 *     "pusher": { "name": "<author>", "email": "<email>" },
 *     "commits": [ { "id": "<sha>", "message": "<msg>", "timestamp": "<iso8601>" } ]
 *   }
 *
 * The `after` SHA is the dedupe key on the receiver side (idempotent).
 *
 * Delivery: at-least-once via exponential-backoff retry. Up to 5 attempts at
 * delays 1s / 4s / 16s / 64s / 256s; first 2xx wins. If `GLUECRON_WEBHOOK_SECRET`
 * is unset the signature header is omitted and Crontech is expected to reject —
 * we still record the deploy row as failed.
 */
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000, 64_000, 256_000];

interface TriggerArgs {
  owner: string;
  repo: string;
  before: string;
  after: string;
  ref: string;
  branch: string;
  repositoryId: string;
}

interface TriggerOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
  now?: () => Date;
}

function signBody(body: string, secret: string): string | null {
  if (!secret) return null;
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

async function buildPayload(args: TriggerArgs, now: Date): Promise<{
  payload: Record<string, unknown>;
  pusherName: string;
  pusherEmail: string;
}> {
  // Walk commits new since the last push. Cap at 50 like GitHub's webhook.
  // `before` may be all-zeros for a first push to the branch — commitsBetween
  // handles that by treating null `from` as "everything reachable from `to`".
  const fromSha = /^0+$/.test(args.before) ? null : args.before;
  let commits: Array<{ id: string; message: string; timestamp: string }> = [];
  let pusherName = "gluecron";
  let pusherEmail = "noreply@gluecron.local";
  try {
    const list = await commitsBetween(args.owner, args.repo, fromSha, args.after);
    commits = list.slice(0, 50).map((c) => ({
      id: c.sha,
      message: c.message,
      timestamp: c.date,
    }));
    if (list[0]) {
      pusherName = list[0].author || pusherName;
      pusherEmail = list[0].authorEmail || pusherEmail;
    }
  } catch {
    /* ignore — payload still valid with empty commits[] */
  }
  return {
    payload: {
      event: "push",
      repository: { full_name: `${args.owner}/${args.repo}` },
      ref: args.ref,
      after: args.after,
      before: args.before,
      pusher: { name: pusherName, email: pusherEmail },
      commits,
      // Ancillary fields — receiver may ignore but they're useful for logs:
      sent_at: now.toISOString(),
      source: "gluecron",
    },
    pusherName,
    pusherEmail,
  };
}

async function triggerCrontechDeploy(
  args: TriggerArgs,
  opts: TriggerOptions = {}
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const now = opts.now ?? (() => new Date());

  let deployId = "";
  try {
    const [row] = await db
      .insert(deployments)
      .values({
        repositoryId: args.repositoryId,
        environment: "production",
        commitSha: args.after,
        ref: args.ref,
        status: "pending",
        target: "crontech",
      })
      .returning();
    deployId = row?.id || "";
  } catch {
    /* ignore */
  }

  const { payload } = await buildPayload(args, now());
  const body = JSON.stringify(payload);
  const signature = signBody(body, config.gluecronWebhookSecret);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "gluecron-webhook/1",
    "X-Gluecron-Event": "push",
    "X-Gluecron-Delivery": cryptoRandomId(),
  };
  if (signature) headers["X-Gluecron-Signature"] = signature;

  let lastStatus = 0;
  let lastError = "";
  let success = false;

  // Up to delays.length + 1 attempts (initial try + each delay).
  const totalAttempts = delays.length + 1;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      const response = await fetchImpl(config.crontechDeployUrl, {
        method: "POST",
        headers,
        body,
      });
      lastStatus = response.status;
      console.log(
        `[crontech] attempt ${attempt + 1}/${totalAttempts} → ${lastStatus} for ${args.owner}/${args.repo}@${args.after.slice(0, 7)}`
      );
      if (response.ok) {
        success = true;
        break;
      }
      // 4xx (except 408/429) is unrecoverable — stop retrying.
      if (response.status >= 400 && response.status < 500 &&
          response.status !== 408 && response.status !== 429) {
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `[crontech] attempt ${attempt + 1}/${totalAttempts} failed: ${lastError}`
      );
    }
    const nextDelay = delays[attempt];
    if (nextDelay !== undefined && attempt < totalAttempts - 1) {
      await sleep(nextDelay);
    }
  }

  if (deployId) {
    try {
      await db
        .update(deployments)
        .set({
          status: success ? "success" : "failed",
          blockedReason: success
            ? null
            : (lastError ? lastError : `HTTP ${lastStatus}`),
          completedAt: new Date(),
        })
        .where(eq(deployments.id, deployId));
    } catch {
      /* ignore */
    }
  }

  if (!success && deployId) {
    void onDeployFailure({
      repositoryId: args.repositoryId,
      deploymentId: deployId,
      ref: args.ref,
      commitSha: args.after,
      target: "crontech",
      errorMessage: lastError || `HTTP ${lastStatus}`,
    }).catch((e) => console.error("[ai-incident]", e));
  }
}

function cryptoRandomId(): string {
  // Short opaque delivery ID for log correlation. Not security-sensitive.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve `owner/repo` to its DB repository.id and dispatch the
 * semantic-index update. Pulls the list of changed paths via
 * `git diff --name-only`, dropping any deletions (handled implicitly
 * because deleted blobs simply don't resolve in `indexChangedFiles`).
 *
 * Never throws — exhaust every external call inside a try/catch so the
 * push completes even if Postgres or the embedding API is down.
 */
async function fireSemanticIndex(
  owner: string,
  repo: string,
  oldSha: string,
  newSha: string
): Promise<void> {
  let repositoryId = "";
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repositoryId = row?.id || "";
  } catch {
    return;
  }
  if (!repositoryId) return;

  let changedPaths: string[] = [];
  try {
    changedPaths = await listChangedPaths(owner, repo, oldSha, newSha);
  } catch {
    return;
  }
  if (!changedPaths.length) return;

  try {
    const out = await indexChangedFiles({
      repositoryId,
      ownerName: owner,
      repoName: repo,
      commitSha: newSha,
      changedPaths,
    });
    if (out.indexed > 0) {
      console.log(
        `[semantic-index] ${owner}/${repo}@${newSha.slice(0, 7)}: indexed ${out.indexed} file(s) via ${out.model}`
      );
    }
  } catch (err) {
    console.warn("[semantic-index] indexChangedFiles error:", err);
  }
}

/**
 * Returns the list of files touched between `oldSha` and `newSha`. For
 * the initial push on a branch (oldSha all-zero) we walk every file in
 * the new tree via `git ls-tree -r`. Returns [] on any subprocess error.
 */
async function listChangedPaths(
  owner: string,
  repo: string,
  oldSha: string,
  newSha: string
): Promise<string[]> {
  const cwd = getRepoPath(owner, repo);
  const allZero = /^0+$/.test(oldSha);
  const cmd = allZero
    ? ["git", "ls-tree", "-r", "--name-only", newSha]
    : ["git", "diff", "--name-only", oldSha, newSha];
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Migration 0062 — fan out push refs to enqueuePreviewBuild for every
 * non-default branch on a `preview_builds_enabled` repo.
 *
 * Resolves the repo row once, fetches the default branch + opt-out flag,
 * then upserts one preview row per pushed ref that isn't the default.
 * Branch deletions (oldSha all-zero or newSha all-zero with oldSha set)
 * are skipped — they shouldn't create preview rows. Never throws.
 */
async function firePreviewBuilds(
  owner: string,
  repo: string,
  refs: PushRef[]
): Promise<void> {
  // Filter to live branch pushes only.
  const branchRefs = refs.filter(
    (r) =>
      r.refName.startsWith("refs/heads/") && !r.newSha.startsWith("0000")
  );
  if (branchRefs.length === 0) return;

  let repoRow: { id: string; previewBuildsEnabled: boolean; defaultBranch: string } | null = null;
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        previewBuildsEnabled: repositories.previewBuildsEnabled,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repoRow = row || null;
  } catch {
    return;
  }
  if (!repoRow) return;
  if (!repoRow.previewBuildsEnabled) return;

  for (const ref of branchRefs) {
    const branchName = ref.refName.replace("refs/heads/", "");
    if (branchName === repoRow.defaultBranch) continue;
    try {
      await enqueuePreviewBuild({
        repositoryId: repoRow.id,
        ownerName: owner,
        repoName: repo,
        branchName,
        commitSha: ref.newSha,
      });
    } catch (err) {
      console.warn(
        `[branch-previews] enqueue failed for ${owner}/${repo}@${branchName}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

/**
 * Migration 0068 — resolve `owner/repo` to its DB id and kick off the
 * doc-drift sweep (findTrackedDocs + proposeDocUpdate). Returns immediately
 * on missing repo or DB error — pushes never block. Never throws.
 */
async function fireDocDriftCheck(owner: string, repo: string): Promise<void> {
  let repositoryId = "";
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repositoryId = row?.id || "";
  } catch {
    return;
  }
  if (!repositoryId) return;
  try {
    const out = await runDocDriftCheckForRepo(repositoryId);
    if (out.docs > 0 || out.proposed > 0) {
      console.log(
        `[ai-doc-updater] ${owner}/${repo}: docs=${out.docs} proposed=${out.proposed}`
      );
    }
  } catch (err) {
    console.warn("[ai-doc-updater] runDocDriftCheckForRepo error:", err);
  }
}

/**
 * Block ST — fan out the push to any server targets that watch this
 * (repo, branch). One sequential deploy per target so a slow box can't
 * stall the next push, but multiple matching targets run in parallel.
 * Every failure is contained to its own deploy row + console warn —
 * nothing here can break the push path.
 */
async function fireServerTargetDeploys(
  owner: string,
  repo: string,
  refs: PushRef[]
): Promise<void> {
  const liveRefs = refs.filter(
    (r) => r.refName.startsWith("refs/heads/") && !r.newSha.startsWith("0000")
  );
  if (liveRefs.length === 0) return;

  let repositoryId = "";
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repositoryId = row?.id || "";
  } catch {
    return;
  }
  if (!repositoryId) return;

  await Promise.all(
    liveRefs.map(async (ref) => {
      const branch = ref.refName.replace("refs/heads/", "");
      let targets;
      try {
        targets = await findTargetsForPush({ repositoryId, branch });
      } catch {
        return;
      }
      if (!targets.length) return;

      await Promise.all(
        targets.map(async (target) => {
          try {
            const env = await resolveEnv(target.id);
            const deployId = await startDeployRow({
              targetId: target.id,
              commitSha: ref.newSha,
              ref: ref.refName,
              triggerSource: "push",
            });
            const result = await deployToTarget(target, {
              commitSha: ref.newSha,
              ref: ref.refName,
              env,
            });
            if (deployId) {
              await finishDeployRow({
                id: deployId,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
              });
            }
            console.log(
              `[server-targets] ${target.name} @ ${ref.newSha.slice(0, 7)}: exit ${result.exitCode}`
            );
          } catch (err) {
            console.warn(
              `[server-targets] ${target.name}: deploy threw — ${err instanceof Error ? err.message : err}`
            );
          }
        })
      );
    })
  );
}

/**
 * Fire-and-forget wrapper around scanDependencies for each pushed ref.
 * Resolves the repo DB row once, then runs the scanner on each live push.
 * Swallows all errors so a scanner failure never affects the push path.
 */
async function fireDependencyScan(
  owner: string,
  repo: string,
  refs: PushRef[]
): Promise<void> {
  const liveRefs = refs.filter(
    (r) => r.refName.startsWith("refs/heads/") && !r.newSha.startsWith("0000")
  );
  if (liveRefs.length === 0) return;

  let repoRow: { id: string; ownerId: string } | null = null;
  try {
    const [row] = await db
      .select({ id: repositories.id, ownerId: repositories.ownerId })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repoRow = row || null;
  } catch {
    return;
  }
  if (!repoRow) return;

  for (const ref of liveRefs) {
    try {
      const findings = await scanDependencies(
        repoRow.id,
        owner,
        repo,
        ref.newSha,
        ref.oldSha,
        repoRow.ownerId
      );
      if (findings.length > 0) {
        console.log(
          `[dependency-scanner] ${owner}/${repo}@${ref.newSha.slice(0, 7)}: ${findings.length} finding(s)`
        );
      }
    } catch (err) {
      console.warn(
        `[dependency-scanner] scan threw for ${owner}/${repo}@${ref.newSha.slice(0, 7)}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

/**
 * Migration 0088 — trigger repo onboarding on first push to the default branch.
 * Detects "first push" by checking whether oldSha is all-zeros on a push to
 * the repo's default branch (or any branch for a repo with no prior history).
 * Resolves the repo DB id, then calls ensureRepoOnboarding which is idempotent.
 * Never throws.
 */
async function fireRepoOnboarding(
  owner: string,
  repo: string,
  refs: PushRef[]
): Promise<void> {
  // Only fire on first push — oldSha all-zeros means the branch is brand-new.
  const firstPushRefs = refs.filter(
    (r) => r.refName.startsWith("refs/heads/") && /^0+$/.test(r.oldSha) && !r.newSha.startsWith("0000")
  );
  if (firstPushRefs.length === 0) return;

  let repositoryId = "";
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repositoryId = row?.id || "";
  } catch {
    return;
  }
  if (!repositoryId) return;

  await ensureRepoOnboarding(repositoryId, owner, repo);
}

/** Test-only access to internal helpers. */
export const __test = {
  triggerCrontechDeploy,
  signBody,
  buildPayload,
  RETRY_DELAYS_MS,
  listChangedPaths,
  fireSemanticIndex,
  firePreviewBuilds,
  fireDocDriftCheck,
  fireServerTargetDeploys,
  fireDependencyScan,
  fireCloudDeploys,
  fireRepoOnboarding,
};
