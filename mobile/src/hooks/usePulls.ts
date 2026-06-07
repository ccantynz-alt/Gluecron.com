import { useState, useEffect, useCallback } from 'react';
import { api, type PullRequest, type PullComment } from '../api/client';

export function usePulls(owner: string | null, repo: string | null, state: 'open' | 'closed' | 'merged' | 'all' = 'open') {
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!owner || !repo) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listPulls(owner, repo, state);
      setPulls(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pull requests');
    } finally {
      setLoading(false);
    }
  }, [owner, repo, state]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { pulls, loading, error, refresh: fetch };
}

export function usePull(owner: string | null, repo: string | null, number: number | null) {
  const [pull, setPull] = useState<PullRequest | null>(null);
  const [comments, setComments] = useState<PullComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!owner || !repo || number === null) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getPull(owner, repo, number);
      setPull(data.pull);
      setComments(data.comments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pull request');
    } finally {
      setLoading(false);
    }
  }, [owner, repo, number]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { pull, comments, loading, error, refresh: fetch };
}
