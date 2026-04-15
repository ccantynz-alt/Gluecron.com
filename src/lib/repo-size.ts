/**
 * Block J31 — Repository size audit.
 *
 * Pure helpers that answer "where are the bytes?" for a working-tree
 * snapshot at a given ref: total size, largest files, distribution by
 * top-level directory, and a size-class histogram.
 *
 * Consumes the same `{path, size}` shape produced by
 * `git ls-tree -r -l -z` (via `listTreeRecursive`), so the route stays
 * a thin shell over `buildSizeReport`.
 */
export interface RepoSizeEntry {
  path: string;
  size: number;
}

export const DEFAULT_TOP_N = 25;

/** Five size classes, ranked tiny → xlarge. Boundaries are inclusive-below. */
export const SIZE_CLASSES = [
  { key: "tiny", label: "< 1 KB", max: 1024 },
  { key: "small", label: "1 KB – 100 KB", max: 100 * 1024 },
  { key: "medium", label: "100 KB – 1 MB", max: 1024 * 1024 },
  { key: "large", label: "1 MB – 10 MB", max: 10 * 1024 * 1024 },
  { key: "xlarge", label: "≥ 10 MB", max: Number.POSITIVE_INFINITY },
] as const;

export type SizeClassKey = (typeof SIZE_CLASSES)[number]["key"];

export interface SizeSummary {
  totalFiles: number;
  countedFiles: number;
  totalBytes: number;
  averageBytes: number;
  medianBytes: number;
  largestBytes: number;
  smallestBytes: number;
}

export interface SizeBucket {
  key: SizeClassKey;
  label: string;
  fileCount: number;
  bytes: number;
}

export interface DirectoryBucket {
  /** Top-level segment. Root files live under the "." pseudo-bucket. */
  name: string;
  fileCount: number;
  bytes: number;
  percent: number;
}

export interface LargestFile {
  path: string;
  size: number;
  percent: number;
  /** First path segment (or "." for root files). */
  topDir: string;
}

export interface RepoSizeReport {
  summary: SizeSummary;
  buckets: SizeBucket[];
  directories: DirectoryBucket[];
  largest: LargestFile[];
}

/** Path → top-level segment (`src/foo/bar.ts` → `src`, `README.md` → `.`). */
export function topLevelDir(path: string): string {
  if (typeof path !== "string" || path.length === 0) return ".";
  const normal = path.startsWith("/") ? path.slice(1) : path;
  const i = normal.indexOf("/");
  return i === -1 ? "." : normal.slice(0, i);
}

/** Keep only sane, finite, non-negative-sized string paths. */
function validEntries(
  entries: readonly RepoSizeEntry[]
): RepoSizeEntry[] {
  const out: RepoSizeEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e.path !== "string" || e.path.length === 0) continue;
    const sz = Number(e.size);
    if (!Number.isFinite(sz) || sz < 0) continue;
    out.push({ path: e.path, size: sz });
  }
  return out;
}

function median(sortedAsc: readonly number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sortedAsc[(n - 1) / 2]!;
  const a = sortedAsc[n / 2 - 1]!;
  const b = sortedAsc[n / 2]!;
  return Math.round((a + b) / 2);
}

export function summariseSize(entries: readonly RepoSizeEntry[]): SizeSummary {
  const valid = validEntries(entries);
  const sizes = valid.map((e) => e.size).sort((a, b) => a - b);
  const total = sizes.reduce((acc, n) => acc + n, 0);
  const n = sizes.length;
  return {
    totalFiles: entries.length,
    countedFiles: n,
    totalBytes: total,
    averageBytes: n === 0 ? 0 : Math.round(total / n),
    medianBytes: median(sizes),
    largestBytes: n === 0 ? 0 : sizes[n - 1]!,
    smallestBytes: n === 0 ? 0 : sizes[0]!,
  };
}

export function classifyFileSize(size: number): SizeClassKey {
  if (!Number.isFinite(size) || size < 0) return "tiny";
  for (const c of SIZE_CLASSES) {
    if (size < c.max) return c.key;
  }
  // Math says we can't get here (last class max = Infinity), but be defensive.
  return "xlarge";
}

export function bucketBySize(
  entries: readonly RepoSizeEntry[]
): SizeBucket[] {
  const valid = validEntries(entries);
  const out: SizeBucket[] = SIZE_CLASSES.map((c) => ({
    key: c.key,
    label: c.label,
    fileCount: 0,
    bytes: 0,
  }));
  for (const e of valid) {
    const key = classifyFileSize(e.size);
    const b = out.find((x) => x.key === key)!;
    b.fileCount++;
    b.bytes += e.size;
  }
  return out;
}

export interface TopLargestOptions {
  /** Max files to return. Default `DEFAULT_TOP_N`. */
  limit?: number;
  /** Minimum bytes for inclusion. Default 0 (= no floor). */
  minBytes?: number;
}

export function topLargestFiles(
  entries: readonly RepoSizeEntry[],
  opts: TopLargestOptions = {}
): LargestFile[] {
  const limit =
    opts.limit !== undefined && opts.limit > 0
      ? Math.floor(opts.limit)
      : DEFAULT_TOP_N;
  const minBytes = opts.minBytes ?? 0;

  const valid = validEntries(entries).filter((e) => e.size >= minBytes);
  const total = valid.reduce((acc, e) => acc + e.size, 0);

  const sorted = valid.slice().sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    return a.path.localeCompare(b.path);
  });

  return sorted.slice(0, limit).map((e) => ({
    path: e.path,
    size: e.size,
    percent: total === 0 ? 0 : (e.size / total) * 100,
    topDir: topLevelDir(e.path),
  }));
}

export function summariseByTopDir(
  entries: readonly RepoSizeEntry[]
): DirectoryBucket[] {
  const valid = validEntries(entries);
  const total = valid.reduce((acc, e) => acc + e.size, 0);
  const byDir = new Map<string, { fileCount: number; bytes: number }>();

  for (const e of valid) {
    const key = topLevelDir(e.path);
    const agg = byDir.get(key) ?? { fileCount: 0, bytes: 0 };
    agg.fileCount++;
    agg.bytes += e.size;
    byDir.set(key, agg);
  }

  const out: DirectoryBucket[] = [];
  for (const [name, { fileCount, bytes }] of byDir) {
    out.push({
      name,
      fileCount,
      bytes,
      percent: total === 0 ? 0 : (bytes / total) * 100,
    });
  }

  out.sort((a, b) => {
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;
    // Root bucket sorts last on ties so real directories surface first.
    if (a.name === "." && b.name !== ".") return 1;
    if (b.name === "." && a.name !== ".") return -1;
    return a.name.localeCompare(b.name);
  });

  return out;
}

export interface BuildSizeReportOptions {
  entries: readonly RepoSizeEntry[];
  topN?: number;
  minBytesForLargest?: number;
}

export function buildSizeReport(
  opts: BuildSizeReportOptions
): RepoSizeReport {
  return {
    summary: summariseSize(opts.entries),
    buckets: bucketBySize(opts.entries),
    directories: summariseByTopDir(opts.entries),
    largest: topLargestFiles(opts.entries, {
      limit: opts.topN,
      minBytes: opts.minBytesForLargest,
    }),
  };
}

export const __internal = {
  SIZE_CLASSES,
  DEFAULT_TOP_N,
  topLevelDir,
  classifyFileSize,
  summariseSize,
  bucketBySize,
  topLargestFiles,
  summariseByTopDir,
  buildSizeReport,
  median,
  validEntries,
};
