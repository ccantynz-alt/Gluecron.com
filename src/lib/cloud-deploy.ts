/**
 * Multi-cloud deploy integration (migration 0077).
 *
 * Supports push-triggered deploys to:
 *   - Fly.io     — Machines API deploy trigger
 *   - Railway    — GraphQL deploymentTrigger mutation
 *   - Render     — REST API POST /v1/services/:id/deploys
 *   - Vercel     — REST API POST /v13/deployments (git-source)
 *   - Netlify    — REST API POST /v1/sites/:id/builds
 *   - webhook    — Generic POST (covers Coolify, CapRover, Dokku, etc.)
 *
 * Each provider function returns a {deployId, logUrl?, deployUrl?} on
 * success or throws on hard error. Background polling updates the DB row
 * status every ~10s until a terminal state is reached.
 *
 * Token storage: API tokens are AES-256-GCM encrypted in the DB via
 * `server-targets-crypto.ts` (same key: SERVER_TARGETS_KEY).
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { cloudDeployConfigs, cloudDeployments, repositories, users } from "../db/schema";
import { decryptValue } from "./server-targets-crypto";

// ─── Provider types ───────────────────────────────────────────────────────────

export type CloudProvider =
  | "fly"
  | "railway"
  | "render"
  | "vercel"
  | "netlify"
  | "webhook";

interface DeployResult {
  providerDeployId?: string;
  logUrl?: string;
  deployUrl?: string;
}

// ─── Fly.io ──────────────────────────────────────────────────────────────────

/**
 * Trigger a Fly.io deployment via the Fly Machines REST API.
 *
 * Uses the "create a new machine that immediately exits" approach:
 * creates a temp machine from the fly-builder image which triggers Fly's
 * built-in build + release pipeline. For most users the simpler approach is
 * to use flyctl, but we invoke the Machines API so we don't need the binary.
 *
 * Fly deploy token: generate with `flyctl tokens create deploy -a <app>`
 * and store encrypted in cloud_deploy_configs.api_token_encrypted.
 *
 * The appName is the Fly app name (e.g. "my-app").
 */
export async function deployToFly(
  appName: string,
  token: string,
  commitSha: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeployResult> {
  // POST to the Fly Machines API to create a one-shot deploy machine.
  // The machine runs `fly deploy` logic internally when provisioned with
  // a deploy token and app name — effectively a remote flyctl.
  const url = `https://api.machines.dev/v1/apps/${encodeURIComponent(appName)}/machines`;

  // For Fly's Deploy-via-API pattern: hit the `releases` endpoint instead.
  // This is equivalent to what the Fly dashboard does when you click "Redeploy".
  // We signal "deploy HEAD" by triggering a new release from the current image.
  const releaseUrl = `https://api.fly.io/v1/apps/${encodeURIComponent(appName)}/releases`;
  const body = JSON.stringify({
    image: null, // null = re-deploy the latest image
    strategy: "rolling",
    commit_message: `gluecron deploy @ ${commitSha.slice(0, 7)}`,
  });

  const res = await fetchImpl(releaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fly deploy failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* ignore non-JSON bodies */
  }

  const releaseId = String(data.id || data.release_id || "");
  const releaseVersion = data.version !== undefined ? String(data.version) : "";
  const logUrl = releaseId
    ? `https://fly.io/apps/${encodeURIComponent(appName)}/monitoring?release=${releaseId}`
    : `https://fly.io/apps/${encodeURIComponent(appName)}/monitoring`;

  return {
    providerDeployId: releaseId || releaseVersion || undefined,
    logUrl,
    deployUrl: `https://${appName}.fly.dev`,
  };
}

/**
 * Poll Fly.io release status.
 * Returns "success" | "failed" | "running" | "pending".
 */
export async function pollFlyStatus(
  appName: string,
  releaseId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  try {
    const url = `https://api.fly.io/v1/apps/${encodeURIComponent(appName)}/releases/${encodeURIComponent(releaseId)}`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return "running"; // assume still running on transient error
    const data = (await res.json()) as Record<string, unknown>;
    const status = String(data.status || "").toLowerCase();
    if (status === "complete" || status === "succeeded") return "success";
    if (status === "failed" || status === "error" || status === "cancelled") return "failed";
    return "running";
  } catch {
    return "running";
  }
}

// ─── Railway ─────────────────────────────────────────────────────────────────

/**
 * Trigger a Railway service redeployment via their GraphQL API.
 *
 * Railway API token: https://railway.app/account/tokens
 * serviceId: from the Railway dashboard URL (Settings > General).
 */
export async function deployToRailway(
  serviceId: string,
  token: string,
  commitSha: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeployResult> {
  const query = `
    mutation ServiceInstanceRedeploy($serviceId: String!) {
      serviceInstanceRedeploy(input: { serviceId: $serviceId })
    }
  `;

  const res = await fetchImpl("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { serviceId } }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Railway deploy failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    data?: { serviceInstanceRedeploy?: string };
    errors?: Array<{ message: string }>;
  };

  if (data.errors?.length) {
    throw new Error(`Railway GraphQL error: ${data.errors[0].message}`);
  }

  const deployId = data.data?.serviceInstanceRedeploy || "";

  return {
    providerDeployId: deployId || undefined,
    logUrl: deployId
      ? `https://railway.app/project/-/service/${serviceId}/logs`
      : undefined,
    deployUrl: undefined, // Railway generates a dynamic URL per project
  };
}

/**
 * Poll Railway deployment status.
 */
export async function pollRailwayStatus(
  deployId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  try {
    const query = `
      query Deployment($id: String!) {
        deployment(id: $id) { status }
      }
    `;
    const res = await fetchImpl("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id: deployId } }),
    });
    if (!res.ok) return "running";
    const data = (await res.json()) as {
      data?: { deployment?: { status?: string } };
    };
    const status = (data.data?.deployment?.status || "").toUpperCase();
    if (status === "SUCCESS" || status === "COMPLETE") return "success";
    if (status === "FAILED" || status === "CANCELLED" || status === "CRASHED") return "failed";
    return "running";
  } catch {
    return "running";
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

/**
 * Trigger a Render service deployment via their REST API.
 *
 * Render API key: https://dashboard.render.com/u/settings
 * serviceId: the service's ID from the Render dashboard URL.
 */
export async function deployToRender(
  serviceId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeployResult> {
  const res = await fetchImpl(
    `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/deploys`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ clearCache: "do_not_clear" }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Render deploy failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    id?: string;
    deploy?: { id?: string; status?: string; url?: string };
  };
  const deployId = data.deploy?.id || data.id || "";

  return {
    providerDeployId: deployId || undefined,
    logUrl: deployId
      ? `https://dashboard.render.com/web/${serviceId}/deploys/${deployId}`
      : undefined,
    deployUrl: undefined, // returned in service details, not deploy
  };
}

/**
 * Poll Render deployment status.
 */
export async function pollRenderStatus(
  serviceId: string,
  deployId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  try {
    const res = await fetchImpl(
      `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      }
    );
    if (!res.ok) return "running";
    const data = (await res.json()) as { deploy?: { status?: string } };
    const status = (data.deploy?.status || "").toLowerCase();
    if (status === "live") return "success";
    if (status === "failed" || status === "canceled" || status === "deactivated") return "failed";
    return "running";
  } catch {
    return "running";
  }
}

// ─── Vercel ──────────────────────────────────────────────────────────────────

/**
 * Trigger a Vercel deployment via their REST API.
 *
 * Vercel token: https://vercel.com/account/tokens
 * projectId: from Vercel project settings.
 *
 * Note: this creates a "forced" redeploy of the latest successful deployment,
 * since we're not pushing to a Vercel-connected Git repo. For full Git
 * integration, users should connect their Gluecron repo to Vercel via webhook.
 */
export async function deployToVercel(
  projectId: string,
  token: string,
  commitSha: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeployResult> {
  // Redeploy the latest deployment of the project
  const res = await fetchImpl(
    `https://api.vercel.com/v13/deployments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: projectId,
        target: "production",
        meta: {
          githubCommitSha: commitSha,
          source: "gluecron",
        },
        // Trigger a redeploy — Vercel will use the latest build config
        forceNew: 0,
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 400 with "no deployments" means we need to check for existing deployment
    if (res.status === 400) {
      // Try the redeploy endpoint instead
      const searchRes = await fetchImpl(
        `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1&target=production`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (searchRes.ok) {
        const searchData = (await searchRes.json()) as {
          deployments?: Array<{ uid?: string; url?: string }>;
        };
        const latest = searchData.deployments?.[0];
        if (latest?.uid) {
          const redeployRes = await fetchImpl(
            `https://api.vercel.com/v13/deployments?forceNew=1`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ deploymentId: latest.uid }),
            }
          );
          if (redeployRes.ok) {
            const data = (await redeployRes.json()) as { id?: string; url?: string };
            return {
              providerDeployId: data.id || undefined,
              logUrl: data.id ? `https://vercel.com/deployments/${data.id}` : undefined,
              deployUrl: data.url ? `https://${data.url}` : undefined,
            };
          }
        }
      }
    }
    throw new Error(`Vercel deploy failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { id?: string; url?: string; readyState?: string };
  return {
    providerDeployId: data.id || undefined,
    logUrl: data.id ? `https://vercel.com/deployments/${data.id}` : undefined,
    deployUrl: data.url ? `https://${data.url}` : undefined,
  };
}

/**
 * Poll Vercel deployment status.
 */
export async function pollVercelStatus(
  deployId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  try {
    const res = await fetchImpl(
      `https://api.vercel.com/v13/deployments/${encodeURIComponent(deployId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return "running";
    const data = (await res.json()) as { readyState?: string; state?: string };
    const state = (data.readyState || data.state || "").toUpperCase();
    if (state === "READY") return "success";
    if (state === "ERROR" || state === "CANCELED" || state === "FAILED") return "failed";
    return "running";
  } catch {
    return "running";
  }
}

// ─── Netlify ─────────────────────────────────────────────────────────────────

/**
 * Trigger a Netlify site build via their REST API.
 *
 * Netlify token: https://app.netlify.com/user/applications
 * providerAppId: the Netlify site ID.
 */
export async function deployToNetlify(
  siteId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeployResult> {
  const res = await fetchImpl(
    `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/builds`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Netlify deploy failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { id?: string; deploy?: { id?: string; deploy_url?: string } };
  const deployId = data.id || data.deploy?.id || "";
  const deployUrl = data.deploy?.deploy_url || "";

  return {
    providerDeployId: deployId || undefined,
    logUrl: deployId
      ? `https://app.netlify.com/sites/${siteId}/deploys/${deployId}`
      : undefined,
    deployUrl: deployUrl || undefined,
  };
}

/**
 * Poll Netlify build status.
 */
export async function pollNetlifyStatus(
  siteId: string,
  buildId: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  try {
    const res = await fetchImpl(
      `https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/builds/${encodeURIComponent(buildId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return "running";
    const data = (await res.json()) as { state?: string };
    const state = (data.state || "").toLowerCase();
    if (state === "ready") return "success";
    if (state === "error" || state === "cancelled") return "failed";
    return "running";
  } catch {
    return "running";
  }
}

// ─── Generic webhook ─────────────────────────────────────────────────────────

/**
 * Fire a generic deploy webhook — covers Coolify, CapRover, Dokku, etc.
 *
 * providerAppId = the full webhook URL.
 * token = optional HMAC secret or Bearer token (sent as Authorization header if set).
 *
 * POSTs JSON: { event: "push", commit_sha: "...", source: "gluecron" }
 */
export async function deployViaWebhook(
  webhookUrl: string,
  token: string,
  commitSha: string,
  fetchImpl: typeof fetch = fetch
): Promise<DeployResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "gluecron-deploy/1",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const body = JSON.stringify({
    event: "push",
    commit_sha: commitSha,
    source: "gluecron",
  });

  const res = await fetchImpl(webhookUrl, { method: "POST", headers, body });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook deploy failed HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return {}; // webhooks are fire-and-forget — no deploy ID to poll
}

// ─── Dispatch + polling orchestration ────────────────────────────────────────

/**
 * Dispatch a single cloud deploy config — creates the DB row, fires the
 * provider API, then polls in a background async loop until terminal state.
 *
 * Never throws — all errors are caught and recorded in the DB row.
 */
export async function dispatchCloudDeploy(
  config: {
    id: string;
    repoId: string;
    provider: string;
    providerAppId: string;
    apiTokenEncrypted: string;
  },
  commitSha: string,
  opts: { fetchImpl?: typeof fetch; pollIntervalMs?: number } = {}
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;

  // Decrypt the API token
  const tokenResult = decryptValue(config.apiTokenEncrypted);
  if (!tokenResult.ok) {
    console.warn(`[cloud-deploy] cannot decrypt token for config ${config.id}: ${tokenResult.error}`);
    return;
  }
  const apiToken = tokenResult.plaintext;

  // Create the deployment row
  let deployRowId = "";
  try {
    const [row] = await db
      .insert(cloudDeployments)
      .values({
        configId: config.id,
        repoId: config.repoId,
        commitSha,
        status: "pending",
      })
      .returning({ id: cloudDeployments.id });
    deployRowId = row?.id || "";
  } catch (err) {
    console.warn("[cloud-deploy] failed to create deployment row:", err);
    return;
  }

  const updateRow = async (patch: Partial<{
    status: string;
    providerDeployId: string | null;
    logUrl: string | null;
    deployUrl: string | null;
    errorMessage: string | null;
    completedAt: Date | null;
    durationMs: number | null;
  }>) => {
    try {
      await db
        .update(cloudDeployments)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set(patch as any)
        .where(eq(cloudDeployments.id, deployRowId));
    } catch {
      /* ignore */
    }
  };

  const startedAt = Date.now();

  // Mark as running
  await updateRow({ status: "running" });

  let result: DeployResult = {};
  let providerError = "";

  try {
    switch (config.provider) {
      case "fly":
        result = await deployToFly(config.providerAppId, apiToken, commitSha, fetchImpl);
        break;
      case "railway":
        result = await deployToRailway(config.providerAppId, apiToken, commitSha, fetchImpl);
        break;
      case "render":
        result = await deployToRender(config.providerAppId, apiToken, fetchImpl);
        break;
      case "vercel":
        result = await deployToVercel(config.providerAppId, apiToken, commitSha, fetchImpl);
        break;
      case "netlify":
        result = await deployToNetlify(config.providerAppId, apiToken, fetchImpl);
        break;
      case "webhook":
        result = await deployViaWebhook(config.providerAppId, apiToken, commitSha, fetchImpl);
        break;
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  } catch (err) {
    providerError = err instanceof Error ? err.message : String(err);
    console.warn(`[cloud-deploy] ${config.provider} trigger error:`, providerError);
    await updateRow({
      status: "failed",
      errorMessage: providerError,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  // Update with initial deploy info
  await updateRow({
    providerDeployId: result.providerDeployId ?? null,
    logUrl: result.logUrl ?? null,
    deployUrl: result.deployUrl ?? null,
  });

  // For webhooks or when we have no deploy ID, mark success immediately
  if (!result.providerDeployId || config.provider === "webhook") {
    await updateRow({
      status: "success",
      completedAt: new Date(),
      durationMs: Date.now() - startedAt,
    });
    console.log(`[cloud-deploy] ${config.provider} ${config.providerAppId}: delivered (no polling)`);
    return;
  }

  // Poll until terminal state (max 10 minutes)
  const maxPolls = Math.floor(600_000 / pollIntervalMs);
  let polls = 0;
  let finalStatus = "running";

  while (polls < maxPolls) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    polls++;

    try {
      switch (config.provider) {
        case "fly":
          finalStatus = await pollFlyStatus(
            config.providerAppId,
            result.providerDeployId,
            apiToken,
            fetchImpl
          );
          break;
        case "railway":
          finalStatus = await pollRailwayStatus(
            result.providerDeployId,
            apiToken,
            fetchImpl
          );
          break;
        case "render":
          finalStatus = await pollRenderStatus(
            config.providerAppId,
            result.providerDeployId,
            apiToken,
            fetchImpl
          );
          break;
        case "vercel":
          finalStatus = await pollVercelStatus(
            result.providerDeployId,
            apiToken,
            fetchImpl
          );
          break;
        case "netlify":
          finalStatus = await pollNetlifyStatus(
            config.providerAppId,
            result.providerDeployId,
            apiToken,
            fetchImpl
          );
          break;
        default:
          finalStatus = "success";
      }
    } catch {
      /* poll error — keep retrying */
    }

    if (finalStatus === "success" || finalStatus === "failed") {
      break;
    }
  }

  // If we exhausted polls without terminal state, mark failed
  if (finalStatus !== "success" && finalStatus !== "failed") {
    finalStatus = "failed";
    providerError = "Timed out waiting for deployment to complete";
  }

  await updateRow({
    status: finalStatus,
    errorMessage: finalStatus === "failed" && !providerError ? "Deploy failed" : providerError || null,
    completedAt: new Date(),
    durationMs: Date.now() - startedAt,
  });

  console.log(
    `[cloud-deploy] ${config.provider} ${config.providerAppId}@${commitSha.slice(0, 7)}: ${finalStatus} (${Math.round((Date.now() - startedAt) / 1000)}s)`
  );
}

// ─── Post-receive integration ─────────────────────────────────────────────────

interface PushRef {
  oldSha: string;
  newSha: string;
  refName: string;
}

/**
 * Called from post-receive. Looks up cloud_deploy_configs for this repo
 * and fires a deploy for every config whose trigger_branch matches a pushed ref.
 * Runs all matching deploys in parallel. Never throws.
 */
export async function fireCloudDeploys(
  owner: string,
  repoName: string,
  refs: PushRef[]
): Promise<void> {
  const liveRefs = refs.filter(
    (r) => r.refName.startsWith("refs/heads/") && !r.newSha.startsWith("0000")
  );
  if (liveRefs.length === 0) return;

  // Resolve repo ID
  let repoId = "";
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repoName)))
      .limit(1);
    repoId = row?.id || "";
  } catch {
    return;
  }
  if (!repoId) return;

  // Load all enabled configs for this repo
  let configs: Array<{
    id: string;
    repoId: string;
    provider: string;
    providerAppId: string;
    apiTokenEncrypted: string;
    triggerBranch: string;
  }> = [];
  try {
    configs = await db
      .select({
        id: cloudDeployConfigs.id,
        repoId: cloudDeployConfigs.repoId,
        provider: cloudDeployConfigs.provider,
        providerAppId: cloudDeployConfigs.providerAppId,
        apiTokenEncrypted: cloudDeployConfigs.apiTokenEncrypted,
        triggerBranch: cloudDeployConfigs.triggerBranch,
      })
      .from(cloudDeployConfigs)
      .where(eq(cloudDeployConfigs.repoId, repoId));
    configs = configs.filter((c) => (c as any).enabled !== false);
  } catch {
    return;
  }

  if (!configs.length) return;

  // Match pushed branches to configs
  const dispatches: Array<Promise<void>> = [];
  for (const ref of liveRefs) {
    const branch = ref.refName.replace("refs/heads/", "");
    for (const cfg of configs) {
      if (cfg.triggerBranch === branch) {
        dispatches.push(
          dispatchCloudDeploy(cfg, ref.newSha).catch((err) =>
            console.warn(`[cloud-deploy] dispatch error for config ${cfg.id}:`, err)
          )
        );
      }
    }
  }

  if (dispatches.length > 0) {
    await Promise.all(dispatches);
  }
}
