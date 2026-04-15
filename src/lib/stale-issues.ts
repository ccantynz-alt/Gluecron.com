/**
 * Block J20 — Stale issue detector.
 *
 * Pure filtering/bucketing helper. Given a list of open issues and a
 * threshold in days, it surfaces issues whose `updatedAt` is older than
 * the threshold (i.e. "no activity in N days"). Route in
 * `src/routes/stale-issues.tsx` does the DB + rendering; this module is
 * IO-free so it can be exhaustively unit-tested.
 *
 * GitHub's "stale bot" uses a two-stage marking → closing flow — we only
 * implement the *detection* half (non-destructive) because automatic
 * closing demands per-repo opt-in + dry-run tooling we don't want to
 * ship silently.
 */
export const STALE_PERIODS = ["30d", "60d", "90d", "180d"] as const;
export type StalePeriod = (typeof STALE_PERIODS)[number];
export const DEFAULT_STALE_PERIOD: StalePeriod = "60d";

export function periodDays(p: StalePeriod): number {
  switch (p) {
    case "30d":
      return 30;
    case "60d":
      return 60;
    case "90d":
      return 90;
    case "180d":
      return 180;
  }
}

export function parsePeriod(raw: unknown): StalePeriod {
  if (typeof raw !== "string") return DEFAULT_STALE_PERIOD;
  const match = (STALE_PERIODS as readonly string[]).includes(raw);
  return match ? (raw as StalePeriod) : DEFAULT_STALE_PERIOD;
}

export interface StaleInputIssue {
  number: number;
  title: string;
  state: string;
  authorName: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  commentCount?: number;
}

export interface StaleIssue {
  number: number;
  title: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  daysSinceUpdate: number;
  commentCount: number;
}

export interface StaleBuckets {
  "30-60": StaleIssue[];
  "60-90": StaleIssue[];
  "90-180": StaleIssue[];
  "180+": StaleIssue[];
}

export interface StaleReport {
  period: StalePeriod;
  thresholdDays: number;
  now: string;
  total: number;
  issues: StaleIssue[];
  buckets: StaleBuckets;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? v : null;
  }
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t);
  }
  return null;
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Select only *open* issues whose most recent activity is older than
 * `thresholdDays` relative to `now`. Output is sorted oldest-first.
 */
export function filterStale(
  issues: StaleInputIssue[],
  now: Date,
  thresholdDays: number
): StaleIssue[] {
  const out: StaleIssue[] = [];
  for (const i of issues) {
    if (i.state !== "open") continue;
    const updated = toDate(i.updatedAt);
    const created = toDate(i.createdAt);
    if (!updated) continue;
    const days = daysBetween(now, updated);
    if (days < thresholdDays) continue;
    out.push({
      number: i.number,
      title: i.title,
      authorName: i.authorName,
      createdAt: (created ?? updated).toISOString(),
      updatedAt: updated.toISOString(),
      daysSinceUpdate: days,
      commentCount: i.commentCount ?? 0,
    });
  }
  // Oldest activity first (highest daysSinceUpdate first).
  out.sort((a, b) => {
    if (a.daysSinceUpdate !== b.daysSinceUpdate)
      return b.daysSinceUpdate - a.daysSinceUpdate;
    return a.number - b.number;
  });
  return out;
}

/**
 * Put already-staleness-filtered issues into age buckets so the UI can
 * surface a quick "how bad is it" breakdown.
 */
export function bucketByStaleness(issues: StaleIssue[]): StaleBuckets {
  const out: StaleBuckets = {
    "30-60": [],
    "60-90": [],
    "90-180": [],
    "180+": [],
  };
  for (const i of issues) {
    const d = i.daysSinceUpdate;
    if (d >= 180) out["180+"].push(i);
    else if (d >= 90) out["90-180"].push(i);
    else if (d >= 60) out["60-90"].push(i);
    else if (d >= 30) out["30-60"].push(i);
    // Issues with d < 30 are dropped — they aren't "stale" by any bucket.
  }
  return out;
}

export function buildStaleReport(opts: {
  period: StalePeriod;
  now: Date;
  issues: StaleInputIssue[];
}): StaleReport {
  const threshold = periodDays(opts.period);
  const filtered = filterStale(opts.issues, opts.now, threshold);
  return {
    period: opts.period,
    thresholdDays: threshold,
    now: opts.now.toISOString(),
    total: filtered.length,
    issues: filtered,
    buckets: bucketByStaleness(filtered),
  };
}

export const __internal = {
  STALE_PERIODS,
  DEFAULT_STALE_PERIOD,
  periodDays,
  parsePeriod,
  filterStale,
  bucketByStaleness,
  buildStaleReport,
  toDate,
  daysBetween,
};
