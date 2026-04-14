/**
 * Post-receive hook logic.
 * Called after a successful git push to trigger GateTest scans
 * and Crontech deploys.
 */

import { config } from "../lib/config";
import { runGateTestScan } from "../lib/gate";

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
  const promises: Promise<void>[] = [];

  // GateTest scan on every push (non-blocking, results stored for merge gating)
  for (const ref of refs) {
    if (!ref.newSha.startsWith("0000")) {
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
  }

  // Crontech deploy on push to main (only if GateTest passes)
  const mainPush = refs.find(
    (r) => r.refName === "refs/heads/main" && !r.newSha.startsWith("0000")
  );
  if (mainPush) {
    promises.push(triggerCrontechDeploy(owner, repo, mainPush.newSha));
  }

  await Promise.allSettled(promises);
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
