/**
 * Block J9 — GitHub-style contribution heatmap.
 *
 * Takes a list of timestamped activity entries and produces a 53-week grid
 * (Sunday-aligned) of daily counts + level buckets 0-4, plus rollup stats.
 * Pure. Zero IO. The rendering of the grid lives in the caller (web.tsx)
 * so we can keep this file server/client agnostic.
 */

export interface ActivityTs {
  createdAt: Date | string | number;
}

export interface HeatmapDay {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  dow: number; // 0 (Sun) – 6 (Sat)
}

export interface HeatmapWeek {
  /** Seven days, index 0 = Sunday. Entries before window start / after today
   *  are null so callers can render empty cells at the edges. */
  days: Array<HeatmapDay | null>;
}

export interface Heatmap {
  weeks: HeatmapWeek[];
  totalContributions: number;
  maxDayCount: number;
  /** Longest uninterrupted streak inside the window. */
  longestStreak: number;
  /** Streak counting back from `today`. Zero if today is empty. */
  currentStreak: number;
  /** Inclusive start / end (UTC, YYYY-MM-DD). */
  startDate: string;
  endDate: string;
}

/** Strip time, coerce to UTC midnight. */
export function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function formatDateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysBetween(a: Date, b: Date): number {
  const ms = startOfUtcDay(b).getTime() - startOfUtcDay(a).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Map a raw day-count to one of 5 levels. GitHub's thresholds are non-linear;
 * we mirror with quartiles of the max count (fast, good enough for v1).
 */
export function levelFor(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (max <= 0) return 0;
  const q = count / max;
  if (q > 0.75) return 4;
  if (q > 0.5) return 3;
  if (q > 0.25) return 2;
  return 1;
}

/**
 * Build a 53-week Sunday-aligned grid ending on `today` and covering
 * `windowDays` days. Activities outside the window are ignored.
 */
export function buildHeatmap(
  activities: ActivityTs[],
  windowDays: number = 365,
  today: Date = new Date()
): Heatmap {
  const endDay = startOfUtcDay(today);
  const startDay = new Date(endDay);
  startDay.setUTCDate(startDay.getUTCDate() - (windowDays - 1));

  const byDay = new Map<string, number>();
  for (const a of activities) {
    const d = new Date(a.createdAt);
    if (isNaN(d.getTime())) continue;
    const k = startOfUtcDay(d).getTime();
    if (k < startDay.getTime() || k > endDay.getTime()) continue;
    const key = formatDateKey(new Date(k));
    byDay.set(key, (byDay.get(key) || 0) + 1);
  }

  // Pad the grid to start on a Sunday. If startDay is not Sunday, prepend
  // nulls back to the previous Sunday so the columns align by week.
  const firstDow = startDay.getUTCDay(); // 0 = Sun
  const gridStart = new Date(startDay);
  gridStart.setUTCDate(gridStart.getUTCDate() - firstDow);

  // End on Saturday of the endDay's week.
  const endDow = endDay.getUTCDay();
  const gridEnd = new Date(endDay);
  gridEnd.setUTCDate(gridEnd.getUTCDate() + (6 - endDow));

  // Compute max for level buckets first.
  let maxDayCount = 0;
  for (const v of byDay.values()) if (v > maxDayCount) maxDayCount = v;

  const weeks: HeatmapWeek[] = [];
  let cursor = new Date(gridStart);
  let totalContributions = 0;
  let longestStreak = 0;
  let currentStreakAtEnd = 0;
  let runningStreak = 0;

  while (cursor.getTime() <= gridEnd.getTime()) {
    const days: Array<HeatmapDay | null> = [];
    for (let i = 0; i < 7; i++) {
      const isBeforeStart = cursor.getTime() < startDay.getTime();
      const isAfterEnd = cursor.getTime() > endDay.getTime();
      if (isBeforeStart || isAfterEnd) {
        days.push(null);
      } else {
        const key = formatDateKey(cursor);
        const count = byDay.get(key) || 0;
        totalContributions += count;
        if (count > 0) {
          runningStreak += 1;
          if (runningStreak > longestStreak) longestStreak = runningStreak;
        } else {
          runningStreak = 0;
        }
        // Capture the streak value AT the endDay so we can report
        // currentStreak (trailing streak), which may or may not be == longest.
        if (cursor.getTime() === endDay.getTime()) {
          currentStreakAtEnd = runningStreak;
        }
        days.push({
          date: key,
          count,
          level: levelFor(count, maxDayCount),
          dow: cursor.getUTCDay(),
        });
      }
      cursor = new Date(cursor);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push({ days });
  }

  return {
    weeks,
    totalContributions,
    maxDayCount,
    longestStreak,
    currentStreak: currentStreakAtEnd,
    startDate: formatDateKey(startDay),
    endDate: formatDateKey(endDay),
  };
}

export const __internal = { formatDateKey, startOfUtcDay, daysBetween };
