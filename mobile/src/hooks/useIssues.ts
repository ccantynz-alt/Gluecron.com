import { useState, useEffect, useCallback } from 'react';
import { api, type Issue, type IssueComment } from '../api/client';

export function useIssues(owner: string | null, repo: string | null, state: 'open' | 'closed' | 'all' = 'open') {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!owner || !repo) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listIssues(owner, repo, state);
      setIssues(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issues');
    } finally {
      setLoading(false);
    }
  }, [owner, repo, state]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { issues, loading, error, refresh: fetch };
}

export function useIssue(owner: string | null, repo: string | null, number: number | null) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetch = useCallback(async () => {
    if (!owner || !repo || number === null) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getIssue(owner, repo, number);
      setIssue(data.issue);
      setComments(data.comments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issue');
    } finally {
      setLoading(false);
    }
  }, [owner, repo, number]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const addComment = useCallback(async (body: string) => {
    if (!owner || !repo || number === null) return;
    setSubmitting(true);
    try {
      const comment = await api.createIssueComment(owner, repo, number, body);
      setComments((prev) => [...prev, comment]);
    } finally {
      setSubmitting(false);
    }
  }, [owner, repo, number]);

  return { issue, comments, loading, error, submitting, refresh: fetch, addComment };
}
