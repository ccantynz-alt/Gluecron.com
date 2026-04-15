/**
 * Block J18 — Repository pulse / activity summary.
 *
 * Pure rollups for the `/:owner/:repo/pulse` page. Takes already-fetched
 * commits + PR + issue rows and buckets them into a time window. No I/O —
 * the route handler is responsible for querying git + Drizzle.
 *
 * A "pulse" is a recent-activity snapshot over a rolling window (1d / 7d /
 * 30d / 90d). It answers: "who's been pushing, what's moving, what's new
 * and what's closing?"
 */

export const PULSE_WINDOWS = ["1d", "7d", "30d", "90d"] as const;
export type PulseWindow = (typeof PULSE_WINDOWS)[number];
export const DEFAULT_WINDOW: PulseWindow = "7d";

const WINDOW_DAYS: Record<PulseWindow, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** Pure: validate a raw string as a supported pulse window, else fall back. */
export function parseWindow(raw: unknown): PulseWindow {
  if (typeof raw === "string" && (PULSE_WINDOWS as readonly string[]).includes(raw)) {
    return raw as PulseWindow;
  }
  return DEFAULT_WINDOW;
}

/** Pure: return the Date at the start of the window relative to `now`. */
export function windowStart(now: Date, w: PulseWindow): Date {
  const days = WINDOW_DAYS[w];
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/** Pure: number of days represented by a given pulse window. */
export function windowDays(w: PulseWindow): number {
  return WINDOW_DAYS[w];
}

function toMs(d: string | Date | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  if (d instanceof Date) {
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

function inWindow(t: number | null, start: Date, end: Date): boolean {
  if (t === null) return false;
  return t >= start.getTime() && t <= end.getTime();
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface PulseCommit {
  sha: string;
  author: string;
  authorEmail: string;
  date: string;
  message?: string;
}

export interface ContributorCount {
  author: string;
  email: string;
  count: number;
}

export interface CommitPulse {
  total: number;
  byAuthor: ContributorCount[];
  firstSha: string | null;
  lastSha: string | null;
}

/**
 * Pure: count commits inside [start, end] and group by author email.
 * `commits` is the newest-first list returned by `listCommits`.
 */
export function summariseCommits(
  commits: PulseCommit[],
  start: Date,
  end: Date
): CommitPulse {
  const inRange = commits.filter((c) => inWindow(toMs(c.date), start, end));
  const counts = new Map<string, ContributorCount>();
  for (const c of inRange) {
    const emailKey = (c.authorEmail || "").toLowerCase().trim();
    const nameKey = (c.author || "").toLowerCase().trim();
    const key = emailKey || nameKey || "(unknown)";
    const prev = counts.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      counts.set(key, {
        author: c.author || "(unknown)",
        email: c.authorEmail || "",
        count: 1,
      });
    }
  }
  const byAuthor = Array.from(counts.values()).sort(
    (a, b) => b.count - a.count || a.author.localeCompare(b.author)
  );
  return {
    total: inRange.length,
    byAuthor,
    firstSha: inRange.length ? inRange[inRange.length - 1].sha : null,
    lastSha: inRange.length ? inRange[0].sha : null,
  };
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export interface PulsePr {
  id?: string;
  number: number;
  title: string;
  state: string; // "open" | "closed" | "merged"
  isDraft?: boolean;
  authorName?: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  closedAt: string | Date | null;
  mergedAt: string | Date | null;
}

export interface PrPulse {
  opened: number;
  mergedCount: number;
  closed: number;
  active: number;
  openedList: PulsePr[];
  mergedList: PulsePr[];
}

/**
 * Pure: bucket PRs by what changed in-window.
 * - `opened`: createdAt in window
 * - `mergedCount`: mergedAt in window (mutually exclusive with closed)
 * - `closed`: closedAt in window AND not merged in window
 * - `active`: state='open' and updatedAt in window
 */
export function summarisePrs(prs: PulsePr[], start: Date, end: Date): PrPulse {
  let opened = 0,
    mergedCount = 0,
    closed = 0,
    active = 0;
  const openedList: PulsePr[] = [];
  const mergedList: PulsePr[] = [];
  for (const p of prs) {
    const created = toMs(p.createdAt);
    const closedMs = toMs(p.closedAt);
    const mergedMs = toMs(p.mergedAt);
    const updated = toMs(p.updatedAt);
    const createdIn = inWindow(created, start, end);
    const mergedIn = inWindow(mergedMs, start, end);
    const closedIn = inWindow(closedMs, start, end);
    if (createdIn) {
      opened++;
      openedList.push(p);
    }
    if (mergedIn) {
      mergedCount++;
      mergedList.push(p);
    } else if (closedIn) {
      closed++;
    }
    if (p.state === "open" && inWindow(updated, start, end)) active++;
  }
  return { opened, mergedCount, closed, active, openedList, mergedList };
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface PulseIssue {
  id?: string;
  number: number;
  title: string;
  state: string; // "open" | "closed"
  authorName?: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  closedAt: string | Date | null;
}

export interface IssuePulse {
  opened: number;
  closed: number;
  active: number;
  openedList: PulseIssue[];
  closedList: PulseIssue[];
}

/**
 * Pure: bucket issues into opened/closed/active counts over the window.
 * - `opened`: createdAt in window
 * - `closed`: closedAt in window
 * - `active`: state='open' AND updatedAt in window
 */
export function summariseIssues(
  issues: PulseIssue[],
  start: Date,
  end: Date
): IssuePulse {
  let opened = 0,
    closed = 0,
    active = 0;
  const openedList: PulseIssue[] = [];
  const closedList: PulseIssue[] = [];
  for (const i of issues) {
    const created = toMs(i.createdAt);
    const closedMs = toMs(i.closedAt);
    const updated = toMs(i.updatedAt);
    if (inWindow(created, start, end)) {
      opened++;
      openedList.push(i);
    }
    if (inWindow(closedMs, start, end)) {
      closed++;
      closedList.push(i);
    }
    if (i.state === "open" && inWindow(updated, start, end)) active++;
  }
  return { opened, closed, active, openedList, closedList };
}

// ---------------------------------------------------------------------------
// One-shot builder
// ---------------------------------------------------------------------------

export interface PulseReport {
  window: PulseWindow;
  days: number;
  start: string;
  end: string;
  commits: CommitPulse;
  prs: PrPulse;
  issues: IssuePulse;
}

export function buildPulseReport(opts: {
  window: PulseWindow;
  now: Date;
  commits: PulseCommit[];
  prs: PulsePr[];
  issues: PulseIssue[];
}): PulseReport {
  const start = windowStart(opts.now, opts.window);
  const end = opts.now;
  return {
    window: opts.window,
    days: windowDays(opts.window),
    start: start.toISOString(),
    end: end.toISOString(),
    commits: summariseCommits(opts.commits, start, end),
    prs: summarisePrs(opts.prs, start, end),
    issues: summariseIssues(opts.issues, start, end),
  };
}

export const __internal = {
  PULSE_WINDOWS,
  DEFAULT_WINDOW,
  WINDOW_DAYS,
  parseWindow,
  windowStart,
  windowDays,
  summariseCommits,
  summarisePrs,
  summariseIssues,
  buildPulseReport,
};
