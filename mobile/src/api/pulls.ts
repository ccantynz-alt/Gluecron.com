import { fetchJSON, postJSON } from './client';

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  authorUsername: string;
  authorAvatarUrl: string | null;
  baseBranch: string;
  headBranch: string;
  baseRepo: string;
  headRepo: string;
  isDraft: boolean;
  commentCount: number;
  commitCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  mergedByUsername: string | null;
  gateStatus: 'pending' | 'passed' | 'failed' | 'none';
}

export interface PrComment {
  id: number;
  body: string;
  authorUsername: string;
  authorAvatarUrl: string | null;
  isAiReview: boolean;
  filePath: string | null;
  lineNumber: number | null;
  diffHunk: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiReviewSummary {
  summary: string;
  comments: PrComment[];
  severity: 'info' | 'warning' | 'error';
  createdAt: string;
}

export interface PrDiffFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface CreatePrInput {
  title: string;
  body?: string;
  baseBranch: string;
  headBranch: string;
  isDraft?: boolean;
}

export interface CreatePrCommentInput {
  body: string;
  filePath?: string;
  lineNumber?: number;
  diffHunk?: string;
}

/** List pull requests for a repository. */
export async function listPullRequests(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'merged' | 'all' = 'open',
  page = 1,
): Promise<PullRequest[]> {
  return fetchJSON<PullRequest[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&page=${page}&json=1`,
  );
}

/** Get a single pull request. */
export async function getPullRequest(
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  return fetchJSON<PullRequest>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}?json=1`,
  );
}

/** Get comments on a pull request (including AI review comments). */
export async function getPrComments(
  owner: string,
  repo: string,
  number: number,
): Promise<PrComment[]> {
  return fetchJSON<PrComment[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments?json=1`,
  );
}

/** Get the AI review summary for a pull request. */
export async function getAiReview(
  owner: string,
  repo: string,
  number: number,
): Promise<AiReviewSummary | null> {
  try {
    return await fetchJSON<AiReviewSummary>(
      `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/ai-review?json=1`,
    );
  } catch {
    return null;
  }
}

/** Get diff files for a pull request. */
export async function getPrDiff(
  owner: string,
  repo: string,
  number: number,
): Promise<PrDiffFile[]> {
  return fetchJSON<PrDiffFile[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/diff?json=1`,
  );
}

/** Create a new pull request. */
export async function createPullRequest(
  owner: string,
  repo: string,
  input: CreatePrInput,
): Promise<PullRequest> {
  return postJSON<PullRequest>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    input,
  );
}

/** Post a comment on a pull request. */
export async function createPrComment(
  owner: string,
  repo: string,
  number: number,
  input: CreatePrCommentInput,
): Promise<PrComment> {
  return postJSON<PrComment>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments`,
    input,
  );
}

/** Merge a pull request. */
export async function mergePullRequest(
  owner: string,
  repo: string,
  number: number,
  mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge',
): Promise<{ merged: boolean; sha: string }> {
  return postJSON<{ merged: boolean; sha: string }>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`,
    { mergeMethod },
  );
}

/** Close a pull request without merging. */
export async function closePullRequest(
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  return postJSON<PullRequest>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/close`,
    {},
  );
}

/** Trigger AI review on a pull request. */
export async function requestAiReview(
  owner: string,
  repo: string,
  number: number,
): Promise<{ queued: boolean }> {
  return postJSON<{ queued: boolean }>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/request-ai-review`,
    {},
  );
}
