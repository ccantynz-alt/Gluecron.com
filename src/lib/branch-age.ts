/**
 * Block J27 — Branch staleness / age report. Pure rollup helpers.
 *
 * Given a set of branches with tip-commit metadata + ahead/behind counts
 * vs the default branch, produces a per-branch view with age classification,
 * bucket counts, and summary statistics. IO-free so the route can
 * orchestrate git subprocess calls and feed the pre-fetched rows here.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Canonical thresholds (in days) exposed to the UI select. */
export const VALID_THRESHOLDS = [0, 30, 60, 90, 180] as const;
export type Threshold = (typeof VALID_THRESHOLDS)[number];

export const DEFAULT_THRESHOLD: Threshold = 0;

export type BranchSort =
  | "age-desc"
  | "age-asc"
  | "name"
  | "ahead-desc"
  | "behind-desc";

export const VALID_SORTS: readonly BranchSort[] = [
  "age-desc",
  "age-asc",
  "name",
  "ahead-desc",
  "behind-desc",
];

export const DEFAULT_SORT: BranchSort = "age-desc";

/** Raw input row: tip commit + ahead/behind relative to default. */
export interface BranchInputRow {
  name: string;
  tipSha: string;
  tipDate: Date | string | null;
  tipAuthor: string | null;
  tipMessage: string | null;
  /** Commits on this branch not on default. */
  ahead: number;
  /** Commits on default not on this branch. */
  behind: number;
  /** True when this branch is the repo default. */
  isDefault: boolean;
}

export type BranchAgeCategory = "fresh" | "aging" | "stale" | "abandoned";

export interface BranchReportRow {
  name: string;
  tipSha: string;
  tipDate: Date | null;
  tipAuthor: string | null;
  tipMessage: string | null;
  ahead: number;
  behind: number;
  isDefault: boolean;
  daysOld: number | null;
  category: BranchAgeCategory;
  merged: boolean;
}

export interface BranchBuckets {
  fresh: number;
  aging: number;
  stale: number;
  abandoned: number;
}

export interface BranchSummary {
  total: number;
  /** Excludes the default branch from the count. */
  nonDefault: number;
  merged: number;
  unmerged: number;
  withoutTip: number;
  oldestName: string | null;
  oldestDaysOld: number | null;
  averageAgeDays: number | null;
  medianAgeDays: number | null;
}

export interface BranchReport {
  now: number;
  threshold: Threshold;
  sort: BranchSort;
  defaultBranch: string | null;
  rows: BranchReportRow[];
  filtered: BranchReportRow[];
  buckets: BranchBuckets;
  summary: BranchSummary;
}

/** Accept `number | string | null | undefined` on the query; coerce to allow-listed Threshold. */
export function parseThreshold(raw: unknown): Threshold {
  if (raw === undefined || raw === null) return DEFAULT_THRESHOLD;
  const s = String(raw).trim();
  if (s === "") return DEFAULT_THRESHOLD;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  if ((VALID_THRESHOLDS as readonly number[]).includes(n)) return n as Threshold;
  return DEFAULT_THRESHOLD;
}

export function parseSort(raw: unknown): BranchSort {
  if (typeof raw !== "string") return DEFAULT_SORT;
  const t = raw.trim() as BranchSort;
  return VALID_SORTS.includes(t) ? t : DEFAULT_SORT;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** How old in whole days. `null` when `tipDate` is missing/unparseable. */
export function computeDaysOld(
  tipDate: Date | string | null | undefined,
  now: number
): number | null {
  const d = toDate(tipDate);
  if (!d) return null;
  const ms = now - d.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / DAY_MS);
}

/**
 * Four categories:
 *   <30 days   → fresh
 *   30–59     → aging
 *   60–89     → stale
 *   ≥90       → abandoned
 *
 * Branches with no tipDate → `abandoned` (we can't verify they're alive).
 */
export function classifyBranchAge(
  daysOld: number | null
): BranchAgeCategory {
  if (daysOld === null) return "abandoned";
  if (daysOld < 30) return "fresh";
  if (daysOld < 60) return "aging";
  if (daysOld < 90) return "stale";
  return "abandoned";
}

export function computeBranchRow(
  input: BranchInputRow,
  now: number
): BranchReportRow {
  const daysOld = computeDaysOld(input.tipDate, now);
  return {
    name: input.name,
    tipSha: input.tipSha,
    tipDate: toDate(input.tipDate),
    tipAuthor: input.tipAuthor,
    tipMessage: input.tipMessage,
    ahead: Math.max(0, input.ahead | 0),
    behind: Math.max(0, input.behind | 0),
    isDefault: input.isDefault,
    daysOld,
    category: classifyBranchAge(daysOld),
    // "merged" means no commits ahead of default AND not the default itself.
    merged: !input.isDefault && (input.ahead | 0) === 0,
  };
}

export function bucketBranches(rows: readonly BranchReportRow[]): BranchBuckets {
  const out: BranchBuckets = { fresh: 0, aging: 0, stale: 0, abandoned: 0 };
  for (const r of rows) {
    if (r.isDefault) continue; // default branch never enters the buckets
    out[r.category]++;
  }
  return out;
}

export function filterByThreshold(
  rows: readonly BranchReportRow[],
  threshold: Threshold
): BranchReportRow[] {
  if (threshold === 0) return rows.slice();
  return rows.filter(
    (r) => !r.isDefault && r.daysOld !== null && r.daysOld >= threshold
  );
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const w = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * w;
}

export function summariseBranches(
  rows: readonly BranchReportRow[]
): BranchSummary {
  const nonDefault = rows.filter((r) => !r.isDefault);
  const withAge = nonDefault
    .filter((r): r is BranchReportRow & { daysOld: number } => r.daysOld !== null);
  const sortedAges = withAge.map((r) => r.daysOld).sort((a, b) => a - b);
  const sum = sortedAges.reduce((a, b) => a + b, 0);
  const avg = sortedAges.length > 0 ? Math.round(sum / sortedAges.length) : null;
  const med = percentile(sortedAges, 50);
  let oldestName: string | null = null;
  let oldestDays: number | null = null;
  for (const r of withAge) {
    if (oldestDays === null || r.daysOld > oldestDays) {
      oldestDays = r.daysOld;
      oldestName = r.name;
    }
  }
  return {
    total: rows.length,
    nonDefault: nonDefault.length,
    merged: nonDefault.filter((r) => r.merged).length,
    unmerged: nonDefault.filter((r) => !r.merged).length,
    withoutTip: nonDefault.filter((r) => r.daysOld === null).length,
    oldestName,
    oldestDaysOld: oldestDays,
    averageAgeDays: avg,
    medianAgeDays: med === null ? null : Math.round(med),
  };
}

function cmpString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sortBranchRows(
  rows: readonly BranchReportRow[],
  sort: BranchSort
): BranchReportRow[] {
  const out = rows.slice();
  switch (sort) {
    case "name":
      out.sort((a, b) => cmpString(a.name, b.name));
      break;
    case "age-asc":
      out.sort((a, b) => {
        // null daysOld sinks to the bottom
        const av = a.daysOld ?? Number.POSITIVE_INFINITY;
        const bv = b.daysOld ?? Number.POSITIVE_INFINITY;
        if (av !== bv) return av - bv;
        return cmpString(a.name, b.name);
      });
      break;
    case "age-desc":
      out.sort((a, b) => {
        const av = a.daysOld ?? -1;
        const bv = b.daysOld ?? -1;
        if (av !== bv) return bv - av;
        return cmpString(a.name, b.name);
      });
      break;
    case "ahead-desc":
      out.sort((a, b) => {
        if (a.ahead !== b.ahead) return b.ahead - a.ahead;
        return cmpString(a.name, b.name);
      });
      break;
    case "behind-desc":
      out.sort((a, b) => {
        if (a.behind !== b.behind) return b.behind - a.behind;
        return cmpString(a.name, b.name);
      });
      break;
  }
  return out;
}

export interface BuildReportOptions {
  branches: readonly BranchInputRow[];
  defaultBranch: string | null;
  threshold?: Threshold;
  sort?: BranchSort;
  now?: number;
}

/** One-shot report builder used by the route. */
export function buildBranchReport(opts: BuildReportOptions): BranchReport {
  const now = opts.now ?? Date.now();
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const sort = opts.sort ?? DEFAULT_SORT;
  const rows = opts.branches.map((b) => computeBranchRow(b, now));
  const sorted = sortBranchRows(rows, sort);
  const filtered = filterByThreshold(sorted, threshold);
  return {
    now,
    threshold,
    sort,
    defaultBranch: opts.defaultBranch,
    rows: sorted,
    filtered,
    buckets: bucketBranches(rows),
    summary: summariseBranches(rows),
  };
}

/** Short human label for category pills. */
export function categoryLabel(c: BranchAgeCategory): string {
  switch (c) {
    case "fresh":
      return "Fresh";
    case "aging":
      return "Aging";
    case "stale":
      return "Stale";
    case "abandoned":
      return "Abandoned";
  }
}

export function thresholdLabel(t: Threshold): string {
  return t === 0 ? "All branches" : `≥ ${t} days old`;
}

export function sortLabel(s: BranchSort): string {
  switch (s) {
    case "age-desc":
      return "Oldest first";
    case "age-asc":
      return "Newest first";
    case "name":
      return "Name A–Z";
    case "ahead-desc":
      return "Most ahead";
    case "behind-desc":
      return "Most behind";
  }
}

export const __internal = {
  DAY_MS,
  VALID_THRESHOLDS,
  VALID_SORTS,
  DEFAULT_THRESHOLD,
  DEFAULT_SORT,
  parseThreshold,
  parseSort,
  computeDaysOld,
  classifyBranchAge,
  computeBranchRow,
  bucketBranches,
  filterByThreshold,
  summariseBranches,
  sortBranchRows,
  buildBranchReport,
  categoryLabel,
  thresholdLabel,
  sortLabel,
};
