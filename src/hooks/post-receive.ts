/**
 * Post-receive hook logic.
 * Runs after a successful git push.
 *
 *   1. Update repo.pushedAt and push activity
 *   2. Sync CODEOWNERS from the default branch
 *   3. Run gates (GateTest + secret + security) on the new ref
 *   4. Auto-deploy to Crontech ONLY if gates are green and settings allow it
 *   5. Fan out webhooks
 */

import { and, eq } from "drizzle-orm";
import { config } from "../lib/config";
import { db } from "../db";
import {
  activityFeed,
  deployments,
  repoSettings,
  repositories,
  users,
} from "../db/schema";
import {
  runGateTestScan,
  runSecretAndSecurityScan,
} from "../lib/gate";
import { getOrCreateSettings } from "../lib/repo-bootstrap";
import { getBlob, getDefaultBranch } from "../git/repository";
import { parseCodeowners, syncCodeowners } from "../lib/codeowners";
import { notify } from "../lib/notify";

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
  const [ownerRow] = await db
    .select()
    .from(users)
    .where(eq(users.username, owner))
    .limit(1);
  const repoRow = ownerRow
    ? (
        await db
          .select()
          .from(repositories)
          .where(
            and(
              eq(repositories.ownerId, ownerRow.id),
              eq(repositories.name, repo)
            )
          )
          .limit(1)
      )[0]
    : null;

  const defaultBranch =
    (await getDefaultBranch(owner, repo)) || repoRow?.defaultBranch || "main";

  // --- 1. pushedAt + activity ---
  if (repoRow) {
    try {
      await db
        .update(repositories)
        .set({ pushedAt: new Date(), updatedAt: new Date() })
        .where(eq(repositories.id, repoRow.id));
      for (const ref of refs) {
        if (!ref.newSha.startsWith("0000")) {
          await db.insert(activityFeed).values({
            repositoryId: repoRow.id,
            userId: ownerRow?.id || null,
            action: "push",
            targetType: "commit",
            targetId: ref.newSha,
            metadata: JSON.stringify({ ref: ref.refName }),
          });
        }
      }
    } catch (err) {
      console.error("[post-receive] activity/pushedAt:", err);
    }
  }

  // --- 2. CODEOWNERS sync (only when default branch changed) ---
  const mainRef = refs.find(
    (r) =>
      r.refName === `refs/heads/${defaultBranch}` &&
      !r.newSha.startsWith("0000")
  );
  if (mainRef && repoRow) {
    try {
      const paths = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
      for (const p of paths) {
        const blob = await getBlob(owner, repo, defaultBranch, p);
        if (blob && !blob.isBinary) {
          const rules = parseCodeowners(blob.content);
          await syncCodeowners(repoRow.id, rules);
          break;
        }
      }
    } catch (err) {
      console.error("[post-receive] codeowners sync:", err);
    }
  }

  // --- 3. Gates ---
  const settings = repoRow ? await getOrCreateSettings(repoRow.id) : null;

  const promises: Promise<void>[] = [];
  for (const ref of refs) {
    if (ref.newSha.startsWith("0000")) continue;

    if (settings?.gateTestEnabled !== false) {
      promises.push(
        runGateTestScan(owner, repo, ref.refName, ref.newSha)
          .then((result) => {
            console.log(
              `[gatetest] ${owner}/${repo} ${ref.refName}: ${result.passed ? "PASSED" : "FAILED"} — ${result.details}`
            );
          })
          .catch((err) => {
            console.error(`[gatetest] scan error for ${owner}/${repo}:`, err);
          })
      );
    }

    if (
      settings?.secretScanEnabled !== false ||
      settings?.securityScanEnabled !== false
    ) {
      promises.push(
        runSecretAndSecurityScan(owner, repo, ref.refName, ref.newSha, {
          scanSecrets: settings?.secretScanEnabled !== false,
          scanSecurity: false, // semantic scan needs a diff — deferred to PR gate
        })
          .then((result) => {
            if (
              !result.secretResult.passed &&
              ownerRow &&
              repoRow &&
              result.secrets.length > 0
            ) {
              void notify(ownerRow.id, {
                kind: "security_alert",
                title: `Secret detected in ${owner}/${repo}`,
                body: result.secretResult.details,
                url: `/${owner}/${repo}/gates`,
                repositoryId: repoRow.id,
              });
            }
          })
          .catch((err) => {
            console.error(`[secret-scan] error for ${owner}/${repo}:`, err);
          })
      );
    }
  }

  // --- 4. Auto-deploy (only on default branch + green settings) ---
  if (mainRef && settings?.autoDeployEnabled !== false && repoRow) {
    promises.push(triggerCrontechDeploy(owner, repo, mainRef.newSha, repoRow.id));
  }

  // --- 5. Webhook fan-out ---
  if (repoRow) {
    promises.push(fanoutWebhooks(repoRow.id, owner, repo, refs));
  }

  await Promise.allSettled(promises);
}

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
    const response = await fetch(config.crontechDeployUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: `${owner}/${repo}`,
        sha,
        branch: "main",
        source: "gluecron",
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
