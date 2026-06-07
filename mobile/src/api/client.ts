export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface Repository {
  id: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  starCount: number;
  forkCount: number;
  issueCount: number;
  defaultBranch: string;
  language: string | null;
  updatedAt: string;
  createdAt: string;
  ownerId: string;
}

export interface Commit {
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
    date: string;
  };
  committer: {
    name: string;
    email: string;
    date: string;
  };
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  mode: string;
}

export interface FileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
  encoding: string;
  type: string;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  authorId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  commentCount?: number;
  labels?: Label[];
}

export interface IssueComment {
  id: string;
  body: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  author?: { username: string; displayName: string | null };
}

export interface Label {
  id: string;
  name: string;
  color: string;
  description: string | null;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  baseBranch: string;
  headBranch: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

export interface PullComment {
  id: string;
  body: string;
  authorId: string;
  filePath: string | null;
  line: number | null;
  createdAt: string;
  isAiReview: boolean;
  author?: { username: string; displayName: string | null };
}

export interface ActivityEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  repositoryId: string;
}

export interface Branch {
  name: string;
  sha: string;
  isDefault: boolean;
}

export interface LoginResponse {
  user: { id: string; username: string; email: string };
  token: string;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: unknown,
  ) {
    super(`${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

let _baseUrl = 'https://gluecron.com';

export function setBaseUrl(url: string) {
  _baseUrl = url.replace(/\/$/, '');
}

export function getBaseUrl() {
  return _baseUrl;
}

class GluecronClient {
  private token: string | null = null;

  setToken(token: string) {
    this.token = token;
  }

  clearToken() {
    this.token = null;
  }

  getToken() {
    return this.token;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${_baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (options?.headers) {
      Object.assign(headers, options.headers);
    }

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      throw new ApiError(res.status, res.statusText, body);
    }

    return res.json() as Promise<T>;
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  async login(username: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  async getMe(): Promise<User> {
    return this.request<User>('/api/v2/user');
  }

  // ── Repos ───────────────────────────────────────────────────────────────────

  async listUserRepos(username: string, sort = 'updated'): Promise<Repository[]> {
    return this.request<Repository[]>(`/api/v2/users/${encodeURIComponent(username)}/repos?sort=${sort}`);
  }

  async getRepo(owner: string, repo: string): Promise<Repository> {
    return this.request<Repository>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  async listBranches(owner: string, repo: string): Promise<Branch[]> {
    return this.request<Branch[]>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
  }

  async listCommits(owner: string, repo: string, branch?: string, page = 1, limit = 30): Promise<Commit[]> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (branch) params.set('branch', branch);
    return this.request<Commit[]>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${params}`);
  }

  async getFileTree(owner: string, repo: string, ref = 'HEAD', path?: string): Promise<TreeEntry[]> {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    return this.request<TreeEntry[]>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(ref)}?${params}`);
  }

  async getFileContent(owner: string, repo: string, filePath: string, ref = 'HEAD'): Promise<FileContent> {
    return this.request<FileContent>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}?ref=${encodeURIComponent(ref)}`);
  }

  async getRepoActivity(owner: string, repo: string, limit = 30): Promise<ActivityEvent[]> {
    return this.request<ActivityEvent[]>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/activity?limit=${limit}`);
  }

  // ── Issues ──────────────────────────────────────────────────────────────────

  async listIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', page = 1, limit = 30): Promise<Issue[]> {
    const params = new URLSearchParams({ state, page: String(page), limit: String(limit) });
    return this.request<Issue[]>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`);
  }

  async getIssue(owner: string, repo: string, number: number): Promise<{ issue: Issue; comments: IssueComment[] }> {
    return this.request<{ issue: Issue; comments: IssueComment[] }>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`);
  }

  async createIssue(owner: string, repo: string, title: string, body: string): Promise<Issue> {
    return this.request<Issue>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, body }),
    });
  }

  async createIssueComment(owner: string, repo: string, number: number, body: string): Promise<IssueComment> {
    return this.request<IssueComment>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async updateIssueState(owner: string, repo: string, number: number, state: 'open' | 'closed'): Promise<Issue> {
    return this.request<Issue>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    });
  }

  // ── Pull Requests ────────────────────────────────────────────────────────────

  async listPulls(owner: string, repo: string, state: 'open' | 'closed' | 'merged' | 'all' = 'open', page = 1, limit = 30): Promise<PullRequest[]> {
    const params = new URLSearchParams({ state, page: String(page), limit: String(limit) });
    return this.request<PullRequest[]>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params}`);
  }

  async getPull(owner: string, repo: string, number: number): Promise<{ pull: PullRequest; comments: PullComment[] }> {
    return this.request<{ pull: PullRequest; comments: PullComment[] }>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`);
  }

  async createPull(owner: string, repo: string, title: string, body: string, head: string, base: string): Promise<PullRequest> {
    return this.request<PullRequest>(`/api/v2/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, body, head, base }),
    });
  }

  // ── User repos shorthand ────────────────────────────────────────────────────

  async listMyRepos(username: string): Promise<Repository[]> {
    return this.listUserRepos(username, 'updated');
  }
}

export const api = new GluecronClient();
export { ApiError };
