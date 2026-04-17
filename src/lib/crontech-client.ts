/**
 * Block K — Crontech HTTP client.
 *
 * Typed tool primitives that K-agents call to drive Crontech (external
 * runtime / deploy platform). Each primitive hits the documented endpoint
 * when `CRONTECH_API_KEY` is set and falls back to a deterministic offline
 * mode otherwise. No method throws.
 *
 * Env vars (read lazily via getters so tests can flip them per-case):
 *   CRONTECH_API_KEY   — bearer token for the Crontech API (required)
 *   CRONTECH_BASE_URL  — override base URL (default `https://crontech.ai`)
 *
 * Endpoint shapes assumed (documented for the Crontech team):
 *   GET  {base}/api/v1/deployments?repo=<owner/name>&sha=<commitSha>
 *     200 -> Deployment | null
 *   POST {base}/api/v1/deployments
 *     body: { repo, commitSha, environment? }
 *     200 -> Deployment
 *   POST {base}/api/v1/deployments/:id/rollback
 *     body: { repo }
 *     200 -> { ok: true }
 *   GET  {base}/api/v1/deployments/:id/status
 *     200 -> { status: Deployment["status"], finishedAt?, url? }
 *   GET  {base}/api/v1/deployments/:id/errors
 *     200 -> { errors: [{ message, stackTrace?, count }] }
 */

// ---------------------------------------------------------------------------
// Env getters
// ---------------------------------------------------------------------------

export const crontechEnv = {
  get apiKey(): string {
    return process.env.CRONTECH_API_KEY || "";
  },
  get baseUrl(): string {
    return (process.env.CRONTECH_BASE_URL || "https://crontech.ai").replace(
      /\/+$/,
      ""
    );
  },
};

export function isConfigured(): boolean {
  return !!crontechEnv.apiKey;
}

export function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = crontechEnv.apiKey;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeploymentStatus =
  | "pending"
  | "deploying"
  | "live"
  | "failed"
  | "rolled_back";

export type Deployment = {
  deployId: string;
  commitSha: string;
  status: DeploymentStatus;
  environment: string;
  url?: string;
  startedAt: string;
  finishedAt?: string;
};

export type DeployError = {
  message: string;
  stackTrace?: string;
  count: number;
};

export type DeployWatchResult = {
  deployId: string;
  finalStatus: DeploymentStatus;
  errors: DeployError[];
  watchedForMs: number;
  offline: boolean;
};

const TERMINAL_STATUSES: DeploymentStatus[] = ["live", "failed", "rolled_back"];

function isTerminal(s: DeploymentStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

function coerceStatus(raw: unknown): DeploymentStatus {
  const s = String(raw || "").toLowerCase();
  if (
    s === "pending" ||
    s === "deploying" ||
    s === "live" ||
    s === "failed" ||
    s === "rolled_back"
  ) {
    return s;
  }
  return "pending";
}

function coerceDeployment(data: unknown): Deployment | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const deployId = typeof d.deployId === "string" ? d.deployId : "";
  if (!deployId) return null;
  return {
    deployId,
    commitSha: typeof d.commitSha === "string" ? d.commitSha : "",
    status: coerceStatus(d.status),
    environment:
      typeof d.environment === "string" ? d.environment : "production",
    url: typeof d.url === "string" ? d.url : undefined,
    startedAt:
      typeof d.startedAt === "string"
        ? d.startedAt
        : new Date().toISOString(),
    finishedAt: typeof d.finishedAt === "string" ? d.finishedAt : undefined,
  };
}

// ---------------------------------------------------------------------------
// Shared fetch-with-timeout helpers. Never throw — return null on any
// failure so callers flip to the offline branch.
// ---------------------------------------------------------------------------

async function request(
  url: string,
  method: "GET" | "POST",
  body: unknown,
  timeoutMs: number
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = {
      method,
      headers: buildAuthHeaders(),
      signal: controller.signal,
    };
    if (method !== "GET") init.body = JSON.stringify(body ?? {});
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public primitives
// ---------------------------------------------------------------------------

export async function getDeploymentForCommit(params: {
  repo: string;
  commitSha: string;
}): Promise<Deployment | null> {
  if (!isConfigured()) return null;
  const qs = new URLSearchParams({
    repo: params.repo,
    sha: params.commitSha,
  });
  const url = `${crontechEnv.baseUrl}/api/v1/deployments?${qs.toString()}`;
  const data = await request(url, "GET", undefined, 30_000);
  return coerceDeployment(data);
}

export async function triggerRedeploy(params: {
  repo: string;
  commitSha: string;
  environment?: string;
}): Promise<Deployment | null> {
  if (!isConfigured()) return null;
  const url = `${crontechEnv.baseUrl}/api/v1/deployments`;
  const data = await request(url, "POST", params, 60_000);
  return coerceDeployment(data);
}

export async function rollbackDeployment(params: {
  repo: string;
  deployId: string;
}): Promise<boolean> {
  if (!isConfigured()) return false;
  if (!params.deployId) return false;
  const url = `${crontechEnv.baseUrl}/api/v1/deployments/${encodeURIComponent(
    params.deployId
  )}/rollback`;
  const data = await request(url, "POST", { repo: params.repo }, 60_000);
  if (!data || typeof data !== "object") return false;
  // Accept either `{ok: true}` or any 200 JSON body as success.
  const ok = (data as Record<string, unknown>).ok;
  return ok === undefined ? true : !!ok;
}

export async function watchDeployment(params: {
  repo: string;
  deployId: string;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}): Promise<DeployWatchResult> {
  const maxWaitMs = params.maxWaitMs ?? 300_000;
  const pollIntervalMs = params.pollIntervalMs ?? 10_000;

  if (!isConfigured()) {
    return {
      deployId: params.deployId,
      finalStatus: "failed",
      errors: [],
      watchedForMs: 0,
      offline: true,
    };
  }
  if (!params.deployId) {
    return {
      deployId: "",
      finalStatus: "failed",
      errors: [],
      watchedForMs: 0,
      offline: true,
    };
  }

  const started = Date.now();
  const statusUrl = `${crontechEnv.baseUrl}/api/v1/deployments/${encodeURIComponent(
    params.deployId
  )}/status`;
  const errorsUrl = `${crontechEnv.baseUrl}/api/v1/deployments/${encodeURIComponent(
    params.deployId
  )}/errors`;

  let currentStatus: DeploymentStatus = "pending";
  let errors: DeployError[] = [];
  let pollsFailed = 0;
  const maxPollFailures = 3;

  while (Date.now() - started < maxWaitMs) {
    const statusRes = await request(statusUrl, "GET", undefined, 30_000);
    if (!statusRes || typeof statusRes !== "object") {
      pollsFailed++;
      if (pollsFailed >= maxPollFailures) {
        return {
          deployId: params.deployId,
          finalStatus: "failed",
          errors,
          watchedForMs: Date.now() - started,
          offline: true,
        };
      }
    } else {
      pollsFailed = 0;
      currentStatus = coerceStatus(
        (statusRes as Record<string, unknown>).status
      );
      if (isTerminal(currentStatus)) {
        // On terminal state, fetch latest errors so the caller has context.
        const errRes = await request(errorsUrl, "GET", undefined, 30_000);
        if (errRes && typeof errRes === "object") {
          const list = (errRes as Record<string, unknown>).errors;
          if (Array.isArray(list)) {
            errors = list
              .filter((e) => e && typeof e === "object")
              .map((e) => {
                const obj = e as Record<string, unknown>;
                return {
                  message:
                    typeof obj.message === "string" ? obj.message : "",
                  stackTrace:
                    typeof obj.stackTrace === "string"
                      ? obj.stackTrace
                      : undefined,
                  count: Number(obj.count || 1),
                };
              });
          }
        }
        return {
          deployId: params.deployId,
          finalStatus: currentStatus,
          errors,
          watchedForMs: Date.now() - started,
          offline: false,
        };
      }
    }

    // Sleep until next poll (bounded by remaining budget).
    const remaining = maxWaitMs - (Date.now() - started);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }

  return {
    deployId: params.deployId,
    finalStatus: isTerminal(currentStatus) ? currentStatus : "failed",
    errors,
    watchedForMs: Date.now() - started,
    offline: false,
  };
}

export const __internal = {
  isTerminal,
  coerceStatus,
  coerceDeployment,
  request,
  TERMINAL_STATUSES,
};
