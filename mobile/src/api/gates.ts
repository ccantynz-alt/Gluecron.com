import { fetchJSON, postJSON } from './client';

export type GateRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error';

export interface GateRun {
  id: string;
  repositoryId: string;
  repoOwner: string;
  repoName: string;
  commitSha: string;
  branch: string;
  status: GateRunStatus;
  output: string | null;
  aiRepaired: boolean;
  repairedCommitSha: string | null;
  triggeredBy: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface GateRepoSummary {
  repoOwner: string;
  repoName: string;
  latestRun: GateRun | null;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
}

export interface GateSettings {
  gateTestEnabled: boolean;
  autoRepairEnabled: boolean;
  blockMergeOnFail: boolean;
}

/** List gate runs for a repository. */
export async function listGateRuns(
  owner: string,
  repo: string,
  page = 1,
): Promise<GateRun[]> {
  return fetchJSON<GateRun[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/gates?json=1&page=${page}`,
  );
}

/** Get a single gate run. */
export async function getGateRun(
  owner: string,
  repo: string,
  runId: string,
): Promise<GateRun> {
  return fetchJSON<GateRun>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/gates/${encodeURIComponent(runId)}?json=1`,
  );
}

/** Get gate summary for a repository. */
export async function getGateSummary(
  owner: string,
  repo: string,
): Promise<GateRepoSummary> {
  return fetchJSON<GateRepoSummary>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/gates/summary?json=1`,
  );
}

/** Manually trigger a gate run on the default branch. */
export async function triggerGateRun(
  owner: string,
  repo: string,
): Promise<GateRun> {
  return postJSON<GateRun>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/gates/run`,
    {},
  );
}

/** Get gate settings for a repository. */
export async function getGateSettings(
  owner: string,
  repo: string,
): Promise<GateSettings> {
  return fetchJSON<GateSettings>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/gates/settings?json=1`,
  );
}

/** Get the gate status for the current HEAD of a repository. */
export async function getLatestGateStatus(
  owner: string,
  repo: string,
): Promise<GateRun | null> {
  try {
    const runs = await listGateRuns(owner, repo, 1);
    return runs.length > 0 ? runs[0] : null;
  } catch {
    return null;
  }
}

/** List gate runs across all repos for the authenticated user (dashboard summary). */
export async function listAllGateRuns(username: string): Promise<GateRun[]> {
  return fetchJSON<GateRun[]>(
    `/api/users/${encodeURIComponent(username)}/gates?json=1`,
  );
}
