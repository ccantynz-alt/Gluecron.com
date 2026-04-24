import { useCallback, useEffect, useState } from 'react';
import { getRepo, getTree, listCommits, listBranches } from '../api/repos';
import type { Repository, TreeEntry, CommitEntry, BranchInfo } from '../api/repos';

export interface UseRepoReturn {
  repo: Repository | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Fetches and caches a single repository. */
export function useRepo(owner: string, repoName: string): UseRepoReturn {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!owner || !repoName) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);

    getRepo(owner, repoName)
      .then((data) => {
        if (!cancelled) {
          setRepo(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load repository');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repoName, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { repo, isLoading, error, refresh };
}

export interface UseTreeReturn {
  entries: TreeEntry[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Fetches the file tree for a repo at a given ref and path. */
export function useTree(
  owner: string,
  repoName: string,
  ref = 'HEAD',
  path = '',
): UseTreeReturn {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!owner || !repoName) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);

    getTree(owner, repoName, ref, path)
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load files');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repoName, ref, path, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { entries, isLoading, error, refresh };
}

export interface UseCommitsReturn {
  commits: CommitEntry[];
  isLoading: boolean;
  error: string | null;
  loadMore: () => void;
  hasMore: boolean;
}

/** Fetches commits for a repo with pagination. */
export function useCommits(
  owner: string,
  repoName: string,
  branch = 'HEAD',
): UseCommitsReturn {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    if (!owner || !repoName) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);

    listCommits(owner, repoName, branch, page)
      .then((data) => {
        if (!cancelled) {
          if (page === 1) {
            setCommits(data);
          } else {
            setCommits((prev) => [...prev, ...data]);
          }
          setHasMore(data.length === 30);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load commits');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repoName, branch, page]);

  const loadMore = useCallback(() => {
    if (!isLoading && hasMore) {
      setPage((p) => p + 1);
    }
  }, [isLoading, hasMore]);

  return { commits, isLoading, error, loadMore, hasMore };
}

export interface UseBranchesReturn {
  branches: BranchInfo[];
  isLoading: boolean;
  error: string | null;
}

/** Fetches branches for a repo. */
export function useBranches(owner: string, repoName: string): UseBranchesReturn {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!owner || !repoName) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);

    listBranches(owner, repoName)
      .then((data) => {
        if (!cancelled) setBranches(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load branches');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repoName]);

  return { branches, isLoading, error };
}
