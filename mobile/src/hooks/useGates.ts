import { useCallback, useEffect, useState } from 'react';
import { listGateRuns, triggerGateRun } from '../api/gates';
import type { GateRun } from '../api/gates';

export interface UseGatesReturn {
  runs: GateRun[];
  isLoading: boolean;
  error: string | null;
  isTriggering: boolean;
  triggerRun: () => Promise<void>;
  loadMore: () => void;
  hasMore: boolean;
  refresh: () => void;
}

/**
 * Fetches gate runs for a repository with pagination and a manual trigger action.
 */
export function useGates(owner: string, repoName: string): UseGatesReturn {
  const [runs, setRuns] = useState<GateRun[]>([]);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isTriggering, setIsTriggering] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!owner || !repoName) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);

    listGateRuns(owner, repoName, page)
      .then((data) => {
        if (!cancelled) {
          if (page === 1) {
            setRuns(data);
          } else {
            setRuns((prev) => [...prev, ...data]);
          }
          // Assume pages of 30
          setHasMore(data.length === 30);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load gate runs');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repoName, page, tick]);

  const loadMore = useCallback(() => {
    if (!isLoading && hasMore) {
      setPage((p) => p + 1);
    }
  }, [isLoading, hasMore]);

  const refresh = useCallback(() => {
    setPage(1);
    setTick((t) => t + 1);
  }, []);

  const triggerRun = useCallback(async () => {
    if (isTriggering) return;
    setIsTriggering(true);
    setError(null);
    try {
      const newRun = await triggerGateRun(owner, repoName);
      setRuns((prev) => [newRun, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger gate run');
    } finally {
      setIsTriggering(false);
    }
  }, [owner, repoName, isTriggering]);

  return { runs, isLoading, error, isTriggering, triggerRun, loadMore, hasMore, refresh };
}
