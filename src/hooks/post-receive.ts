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

import { config } from "../lib/config";
import { autoRepair } from "../lib/autorepair";
import { analyzePush, computeHealthScore } from "../lib/intelligence";

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

  // 4. GateTest scan
  triggerGateTest(owner, repo, refs).catch((err) =>
    console.error(`[gatetest] error:`, err)
  );

  // 5. Crontech deploy on push to main
  const mainPush = refs.find(
    (r) => r.refName === "refs/heads/main" && !r.newSha.startsWith("0000")
  );
  if (mainPush) {
    triggerCrontechDeploy(owner, repo, mainPush.newSha).catch((err) =>
      console.error(`[crontech] error:`, err)
    );
  }
}

async function triggerGateTest(
  owner: string,
  repo: string,
  refs: PushRef[]
): Promise<void> {
  try {
    const response = await fetch(config.gatetestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: `${owner}/${repo}`,
        refs: refs.map((r) => ({
          ref: r.refName,
          before: r.oldSha,
          after: r.newSha,
        })),
        source: "gluecron",
      }),
    });
    console.log(
      `[gatetest] scan triggered for ${owner}/${repo}: ${response.status}`
    );
  } catch (err) {
    console.error(`[gatetest] failed to trigger scan:`, err);
  }
}

async function triggerCrontechDeploy(
  owner: string,
  repo: string,
  sha: string
): Promise<void> {
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
  } catch (err) {
    console.error(`[crontech] failed to trigger deploy:`, err);
  }
}
