import { useState, useEffect, useCallback } from 'react';
import { api, type Repository, type Commit, type TreeEntry, type FileContent, type Branch } from '../api/client';

export function useUserRepos(username: string | null) {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!username) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listUserRepos(username);
      setRepos(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repos');
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { repos, loading, error, refresh: fetch };
}

export function useRepo(owner: string | null, repo: string | null) {
  const [data, setData] = useState<Repository | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!owner || !repo) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getRepo(owner, repo);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repo');
    } finally {
      setLoading(false);
    }
  }, [owner, repo]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { repo: data, loading, error, refresh: fetch };
}

export function useCommits(owner: string | null, repoName: string | null, branch?: string) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!owner || !repoName) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listCommits(owner, repoName, branch);
      setCommits(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load commits');
    } finally {
      setLoading(false);
    }
  }, [owner, repoName, branch]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { commits, loading, error, refresh: fetch };
}

export function useFileTree(owner: string | null, repoName: string | null, ref: string, path?: string) {
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!owner || !repoName) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFileTree(owner, repoName, ref, path);
      setTree(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file tree');
    } finally {
      setLoading(false);
    }
  }, [owner, repoName, ref, path]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { tree, loading, error, refresh: fetch };
}

export function useFileContent(owner: string, repoName: string, filePath: string, ref = 'HEAD') {
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.getFileContent(owner, repoName, filePath, ref)
      .then(setFile)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load file'))
      .finally(() => setLoading(false));
  }, [owner, repoName, filePath, ref]);

  return { file, loading, error };
}

export function useBranches(owner: string | null, repoName: string | null) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!owner || !repoName) return;
    setLoading(true);
    api.listBranches(owner, repoName)
      .then(setBranches)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load branches'))
      .finally(() => setLoading(false));
  }, [owner, repoName]);

  return { branches, loading, error };
}
