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

import { and, eq } from "drizzle-orm";
import { config } from "../lib/config";
import { autoRepair } from "../lib/autorepair";
import { analyzePush, computeHealthScore } from "../lib/intelligence";
import { db } from "../db";
import { deployments, repositories, users } from "../db/schema";
import { onDeployFailure } from "../lib/ai-incident";
import { logAiEvent } from "../lib/ai-flywheel";

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
  // Resolve repo id once so flywheel events can anchor to the repo topic.
  let repositoryId: string | null = null;
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repositoryId = row?.id ?? null;
  } catch {
    /* ignore — flywheel events still publish, just without repo anchor */
  }

  for (const ref of refs) {
    if (ref.newSha.startsWith("0000")) continue; // Branch deletion
    const branchName = ref.refName.replace("refs/heads/", "");

    // 1. Auto-repair (runs first, may create a new commit). Always emit a
    //    flywheel event so the live dashboard shows the heal attempt — even
    //    when nothing needed fixing (always-green visibility).
    const t0 = Date.now();
    try {
      const repair = await autoRepair(owner, repo, branchName);
      if (repair.repaired) {
        console.log(
          `[autorepair] ${owner}/${repo}@${branchName}: ${repair.repairs.length} repairs committed`
        );
      }
      logAiEvent({
        actionType: "repair",
        model: "auto-repair",
        summary: repair.repaired
          ? `auto-repaired ${repair.repairs.length} issue(s) on ${owner}/${repo}@${branchName}`
          : `clean push on ${owner}/${repo}@${branchName}`,
        repositoryId,
        commitSha: repair.commitSha ?? ref.newSha.slice(0, 12),
        latencyMs: Date.now() - t0,
        success: true,
        metadata: {
          branch: branchName,
          repaired: repair.repaired,
          repairs: repair.repairs.map((r) => ({
            file: r.file,
            type: r.type,
          })),
        },
      });
    } catch (err) {
      console.error(`[autorepair] error:`, err);
      logAiEvent({
        actionType: "repair",
        model: "auto-repair",
        summary: `auto-repair failed on ${owner}/${repo}@${branchName}`,
        repositoryId,
        commitSha: ref.newSha.slice(0, 12),
        latencyMs: Date.now() - t0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
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

  // 4b. Third-party integrations fanout (Slack/Linear/Vercel/Discord/...)
  //     Every configured integration that subscribes to "push" gets delivered.
  if (repositoryId) {
    void import("../lib/integrations")
      .then((m) =>
        m.deliverEvent(repositoryId!, "push", {
          repository: `${owner}/${repo}`,
          refs: refs.map((r) => ({
            ref: r.refName,
            before: r.oldSha,
            after: r.newSha,
          })),
        })
      )
      .catch((e) => console.error("[integrations] push fanout failed:", e));
  }

  // 5. Crontech deploy on push to main
  const mainPush = refs.find(
    (r) => r.refName === "refs/heads/main" && !r.newSha.startsWith("0000")
  );
  if (mainPush && repositoryId) {
    triggerCrontechDeploy(owner, repo, mainPush.newSha, repositoryId).catch(
      (err: unknown) => console.error(`[crontech] error:`, err)
    );
  }
}

/**
 * Trigger Crontech auto-deploy via the outbound webhook.
 *
 * Wire contract (Gluecron's copy — do not import from Crontech):
 *
 *   POST  https://crontech.ai/api/hooks/gluecron/push
 *   Authorization: Bearer ${GLUECRON_WEBHOOK_SECRET}
 *   Content-Type: application/json
 *
 *   {
 *     "repository": "owner/name",
 *     "sha": "<40-hex>",
 *     "branch": "main",
 *     "ref": "refs/heads/main",
 *     "source": "gluecron",
 *     "timestamp": "<ISO-8601>"
 *   }
 *
 *   → 200 { ok: true, deploymentId, status: "queued" | "skipped" }
 *   → 401 invalid bearer token
 *   → 400 malformed payload
 *   → 404 repository not configured for auto-deploy on Crontech
 *
 * If `GLUECRON_WEBHOOK_SECRET` is unset we silently omit the Authorization
 * header — Crontech will then respond 401, which we treat as a failed deploy
 * row exactly like any other non-ok HTTP response.
 */
async function triggerCrontechDeploy(
  owner: string,
  repo: string,
  sha: string,
  repositoryId: string
): Promise<void> {
  let deployId = "";
  try {
    const [row] = await db
      .insert(deployments)
      .values({
        repositoryId,
        environment: "production",
        commitSha: sha,
        ref: "refs/heads/main",
        status: "pending",
        target: "crontech",
      })
      .returning();
    deployId = row?.id || "";
  } catch {
    /* ignore */
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.gluecronWebhookSecret) {
      headers["Authorization"] = `Bearer ${config.gluecronWebhookSecret}`;
    }
    const response = await fetch(config.crontechDeployUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repository: `${owner}/${repo}`,
        sha,
        branch: "main",
        ref: "refs/heads/main",
        source: "gluecron",
        timestamp: new Date().toISOString(),
      }),
    });
    console.log(
      `[crontech] deploy triggered for ${owner}/${repo}@${sha.slice(0, 7)}: ${response.status}`
    );
    if (deployId) {
      await db
        .update(deployments)
        .set({
          status: response.ok ? "success" : "failed",
          completedAt: new Date(),
        })
        .where(eq(deployments.id, deployId));
    }
    // D4: when Crontech returns a non-ok HTTP status, kick off the AI
    // incident responder AFTER the deployment row is flipped to "failed".
    if (!response.ok && deployId) {
      void onDeployFailure({
        repositoryId,
        deploymentId: deployId,
        ref: "refs/heads/main",
        commitSha: sha,
        target: "crontech",
        errorMessage: `HTTP ${response.status}`,
      }).catch((e) => console.error("[ai-incident]", e));
    }
  } catch (err) {
    console.error(`[crontech] failed to trigger deploy:`, err);
    if (deployId) {
      await db
        .update(deployments)
        .set({
          status: "failed",
          blockedReason: (err as Error).message,
          completedAt: new Date(),
        })
        .where(eq(deployments.id, deployId));
      // D4: fire-and-forget incident analysis AFTER marking the row failed.
      void onDeployFailure({
        repositoryId,
        deploymentId: deployId,
        ref: "refs/heads/main",
        commitSha: sha,
        target: "crontech",
        errorMessage: (err as Error).message,
      }).catch((e) => console.error("[ai-incident]", e));
    }
  }
}

async function fanoutWebhooks(
  repositoryId: string,
  owner: string,
  repo: string,
  refs: PushRef[]
): Promise<void> {
  try {
    const { fireWebhooks } = await import("../routes/webhooks");
    await fireWebhooks(repositoryId, "push", {
      repository: `${owner}/${repo}`,
      refs: refs.map((r) => ({
        ref: r.refName,
        before: r.oldSha,
        after: r.newSha,
      })),
    });
  } catch {
    // best-effort
  }
}

/** Test-only access to internal helpers. */
export const __test = { triggerCrontechDeploy };
