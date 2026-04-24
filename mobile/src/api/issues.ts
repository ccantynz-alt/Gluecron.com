import { fetchJSON, postJSON } from './client';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  authorUsername: string;
  authorAvatarUrl: string | null;
  labels: Label[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  authorUsername: string;
  authorAvatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labelIds?: number[];
}

export interface CreateCommentInput {
  body: string;
}

/** List issues for a repository. */
export async function listIssues(
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
  page = 1,
): Promise<Issue[]> {
  return fetchJSON<Issue[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&page=${page}&json=1`,
  );
}

/** Get a single issue with comments. */
export async function getIssue(
  owner: string,
  repo: string,
  number: number,
): Promise<Issue> {
  return fetchJSON<Issue>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}?json=1`,
  );
}

/** Get comments for an issue. */
export async function getIssueComments(
  owner: string,
  repo: string,
  number: number,
): Promise<IssueComment[]> {
  return fetchJSON<IssueComment[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?json=1`,
  );
}

/** Create a new issue. */
export async function createIssue(
  owner: string,
  repo: string,
  input: CreateIssueInput,
): Promise<Issue> {
  return postJSON<Issue>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    input,
  );
}

/** Post a comment on an issue. */
export async function createIssueComment(
  owner: string,
  repo: string,
  number: number,
  input: CreateCommentInput,
): Promise<IssueComment> {
  return postJSON<IssueComment>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
    input,
  );
}

/** Close an issue. */
export async function closeIssue(
  owner: string,
  repo: string,
  number: number,
): Promise<Issue> {
  return postJSON<Issue>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/close`,
    {},
  );
}

/** Reopen a closed issue. */
export async function reopenIssue(
  owner: string,
  repo: string,
  number: number,
): Promise<Issue> {
  return postJSON<Issue>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/reopen`,
    {},
  );
}

/** List labels for a repository. */
export async function listLabels(owner: string, repo: string): Promise<Label[]> {
  return fetchJSON<Label[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels?json=1`,
  );
}
