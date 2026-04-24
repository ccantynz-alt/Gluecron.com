import { fetchJSON, postJSON } from './client';
import { useSettingsStore } from '../store/settingsStore';

export interface Repository {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  defaultBranch: string;
  language: string | null;
  starCount: number;
  forkCount: number;
  openIssueCount: number;
  ownerUsername: string;
  updatedAt: string;
  createdAt: string;
}

export interface TreeEntry {
  name: string;
  type: 'blob' | 'tree';
  mode: string;
  sha: string;
  path: string;
}

export interface FileContent {
  name: string;
  path: string;
  sha: string;
  content: string;
  encoding: string;
  size: number;
}

export interface CommitEntry {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerDate: string;
  parentShas: string[];
}

export interface BranchInfo {
  name: string;
  sha: string;
  isDefault: boolean;
  isProtected: boolean;
}

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  sha: string;
}

export interface RepoStats {
  commits: number;
  branches: number;
  tags: number;
  contributors: number;
}

/** List repositories for a user. */
export async function listUserRepos(username: string): Promise<Repository[]> {
  return fetchJSON<Repository[]>(`/api/users/${encodeURIComponent(username)}/repos`);
}

/** List all public repos (explore). */
export async function listPublicRepos(page = 1): Promise<Repository[]> {
  return fetchJSON<Repository[]>(`/api/repos?page=${page}`);
}

/** Get a single repository. */
export async function getRepo(owner: string, repo: string): Promise<Repository> {
  return fetchJSON<Repository>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

/** List the file tree for a repo at a given ref and path. */
export async function getTree(
  owner: string,
  repo: string,
  ref = 'HEAD',
  path = '',
): Promise<TreeEntry[]> {
  const encodedPath = path ? `/${encodeURIComponent(path)}` : '';
  return fetchJSON<TreeEntry[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(ref)}${encodedPath}?json=1`,
  );
}

/** Get raw file content. */
export async function getFileContent(
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string> {
  const host = useSettingsStore.getState().host;
  const response = await fetch(
    `${host}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${encodeURIComponent(ref)}/${path}`,
    {
      headers: { Accept: 'text/plain' },
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** List commits on a branch. */
export async function listCommits(
  owner: string,
  repo: string,
  branch = 'HEAD',
  page = 1,
): Promise<CommitEntry[]> {
  return fetchJSON<CommitEntry[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?branch=${encodeURIComponent(branch)}&page=${page}&json=1`,
  );
}

/** List branches. */
export async function listBranches(owner: string, repo: string): Promise<BranchInfo[]> {
  return fetchJSON<BranchInfo[]>(
    `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
  );
}

/** Star a repo. */
export async function starRepo(owner: string, repo: string): Promise<void> {
  await postJSON(`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/star`, {});
}

/** Search code in a repo. */
export async function searchCode(
  owner: string,
  repo: string,
  query: string,
): Promise<SearchResult[]> {
  return fetchJSON<SearchResult[]>(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/search?q=${encodeURIComponent(query)}&json=1`,
  );
}
