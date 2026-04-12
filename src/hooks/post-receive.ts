/**
 * Post-receive hook logic.
 * Called after a successful git push to trigger GateTest scans
 * and Crontech deploys.
 */

import { config } from "../lib/config";

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

  // GateTest scan on every push
  promises.push(triggerGateTest(owner, repo, refs));

  // Crontech deploy on push to main
  const mainPush = refs.find(
    (r) => r.refName === "refs/heads/main" && !r.newSha.startsWith("0000")
  );
  if (mainPush) {
    promises.push(triggerCrontechDeploy(owner, repo, mainPush.newSha));
  }

  await Promise.allSettled(promises);
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
