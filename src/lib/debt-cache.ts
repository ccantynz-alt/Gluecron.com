/**
 * In-memory cache for DebtReport objects.
 * Reports are invalidated after 1 hour.
 */

import type { DebtReport } from "./debt-analyzer";

interface CacheEntry {
  report: DebtReport;
  cachedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new Map<string, CacheEntry>();

/** Returns the cached DebtReport if it's less than 1 hour old, else null. */
export function getDebtReport(repoId: string): DebtReport | null {
  const entry = cache.get(repoId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(repoId);
    return null;
  }
  return entry.report;
}

/** Store a DebtReport in the cache. */
export function setDebtReport(repoId: string, report: DebtReport): void {
  cache.set(repoId, { report, cachedAt: Date.now() });
}

/** Evict the cached report for a repository. */
export function invalidateDebtReport(repoId: string): void {
  cache.delete(repoId);
}

// ─── In-memory job status ─────────────────────────────────────────────────────

export type JobStatus = "pending" | "running" | "done" | "error";

interface JobEntry {
  status: JobStatus;
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, JobEntry>();

export function getJobStatus(repoId: string): JobEntry | null {
  return jobs.get(repoId) ?? null;
}

export function setJobStatus(repoId: string, status: JobStatus, error?: string): void {
  jobs.set(repoId, { status, error, startedAt: Date.now() });
}
