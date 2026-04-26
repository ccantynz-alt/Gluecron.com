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
import { analyzePush, computeHealthScore } from "../lib/intelligence";
import { db } from "../db";
import { deployments, repositories, users } from "../db/schema";
import { onDeployFailure } from "../lib/ai-incident";
import { commitsBetween, getDefaultBranch } from "../git/repository";

interface PushRef {
  oldSha: string;
  newSha: string;
  refName: string;
}

export async function onPostReceive(
  owner: string,
  repo: string,
  refs: PushRef[]
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

  // 4. GateTest scan — fire-and-forget via generic webhook; the standalone
  //    triggerGateTest helper is slated for the intelligence rework.

  // 5. Crontech deploy (BLK-016) — only fires for the configured Crontech repo
  //    (CRONTECH_REPO, default `ccantynz-alt/crontech`) on a push to its
  //    default branch. The branch case (`Main` vs `main`) is determined by
  //    the bare repo's HEAD, not hardcoded.
  if (`${owner}/${repo}` === config.crontechRepo) {
    let defaultBranch = (await getDefaultBranch(owner, repo).catch(() => null)) || "main";
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

/** Test-only access to internal helpers. */
export const __test = { triggerCrontechDeploy, signBody, buildPayload, RETRY_DELAYS_MS };
