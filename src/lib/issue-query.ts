/**
 * Block J23 — Issue/PR search query DSL.
 *
 * A pure parser + matcher for GitHub-style query strings like:
 *
 *     is:open label:bug author:alice "race condition"
 *     is:closed no:label sort:updated-desc
 *     milestone:"v1.0" label:frontend label:regression
 *
 * Supported qualifiers:
 *   is:open | is:closed              → `state` filter
 *   author:<username>                → PR/issue author
 *   label:<name>                     → repeatable; AND across labels
 *   -label:<name>                    → repeatable; excludes label
 *   no:label                         → zero labels
 *   milestone:<title>                → milestone title
 *   sort:<field>                     → `created-desc`, `created-asc`,
 *                                      `updated-desc`, `updated-asc`,
 *                                      `comments-desc`
 *
 * Anything that doesn't look like a `key:value` qualifier (including
 * quoted strings) is joined into `text` for substring matching against
 * the issue title + body. The DSL is strictly local — the route maps it
 * to a Drizzle WHERE where possible and applies the rest in JS.
 *
 * Input sanitisation:
 *   - Unknown qualifiers are silently dropped (never throw).
 *   - `label:` / `milestone:` values with spaces must be quoted.
 *   - `sort:` values not in the allow-list fall back to default.
 */

export type IssueState = "open" | "closed";

export type IssueSort =
  | "created-desc"
  | "created-asc"
  | "updated-desc"
  | "updated-asc"
  | "comments-desc";

export const DEFAULT_SORT: IssueSort = "created-desc";

const VALID_SORTS = new Set<IssueSort>([
  "created-desc",
  "created-asc",
  "updated-desc",
  "updated-asc",
  "comments-desc",
]);

export interface IssueQuery {
  /** Raw free-text remaining after qualifiers are stripped. */
  text: string;
  is?: IssueState;
  author?: string;
  /** AND-matched. */
  labels: string[];
  /** Labels to exclude. */
  excludeLabels: string[];
  /** `no:label` requested zero-label issues. */
  noLabel: boolean;
  milestone?: string;
  sort: IssueSort;
}

/**
 * Token a query string, respecting `"double"`-quoted spans. Returns
 * tokens preserving their original text (minus the surrounding quotes).
 */
export function tokenise(raw: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (/\s/.test(ch) && !inQuote) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Parse a raw query string into a structured `IssueQuery`. Never throws.
 */
export function parseIssueQuery(raw: string | null | undefined): IssueQuery {
  const q: IssueQuery = {
    text: "",
    labels: [],
    excludeLabels: [],
    noLabel: false,
    sort: DEFAULT_SORT,
  };
  if (!raw || typeof raw !== "string") return q;
  const tokens = tokenise(raw.trim());
  const textParts: string[] = [];
  for (const tok of tokens) {
    // Negative label: -label:name
    const negLabel = tok.match(/^-label:(.+)$/);
    if (negLabel) {
      q.excludeLabels.push(negLabel[1]);
      continue;
    }
    const colonIdx = tok.indexOf(":");
    if (colonIdx <= 0 || colonIdx === tok.length - 1) {
      textParts.push(tok);
      continue;
    }
    const key = tok.slice(0, colonIdx).toLowerCase();
    const value = tok.slice(colonIdx + 1);
    switch (key) {
      case "is":
        if (value === "open" || value === "closed") q.is = value;
        break;
      case "author":
        if (value) q.author = value;
        break;
      case "label":
        if (value) q.labels.push(value);
        break;
      case "milestone":
        if (value) q.milestone = value;
        break;
      case "no":
        if (value === "label") q.noLabel = true;
        break;
      case "sort":
        if (VALID_SORTS.has(value as IssueSort)) {
          q.sort = value as IssueSort;
        }
        break;
      default:
        textParts.push(tok);
        break;
    }
  }
  q.text = textParts.join(" ").trim();
  return q;
}

/** An issue shape (subset) the matcher can evaluate. */
export interface QueryableIssue {
  title: string;
  body: string | null;
  state: string;
  authorName: string;
  labelNames: string[];
  milestoneTitle?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  commentCount?: number;
}

/**
 * Does `issue` match `query`? Text substring match is case-insensitive
 * and whole-query (not per-term): match if the collapsed text appears in
 * `${title} ${body}`. Label/author/milestone matching is case-insensitive.
 */
export function matchIssue(issue: QueryableIssue, q: IssueQuery): boolean {
  if (q.is && issue.state !== q.is) return false;
  if (q.author && issue.authorName.toLowerCase() !== q.author.toLowerCase())
    return false;
  if (q.milestone) {
    const m = (issue.milestoneTitle || "").toLowerCase();
    if (m !== q.milestone.toLowerCase()) return false;
  }
  if (q.noLabel && issue.labelNames.length > 0) return false;
  if (q.labels.length > 0) {
    const have = new Set(issue.labelNames.map((l) => l.toLowerCase()));
    for (const want of q.labels) {
      if (!have.has(want.toLowerCase())) return false;
    }
  }
  if (q.excludeLabels.length > 0) {
    const have = new Set(issue.labelNames.map((l) => l.toLowerCase()));
    for (const bad of q.excludeLabels) {
      if (have.has(bad.toLowerCase())) return false;
    }
  }
  if (q.text) {
    const hay = `${issue.title}\n${issue.body || ""}`.toLowerCase();
    if (!hay.includes(q.text.toLowerCase())) return false;
  }
  return true;
}

function toMs(v: Date | string): number {
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** Pure sort. Returns a new array; does not mutate input. */
export function sortIssues<T extends QueryableIssue>(
  list: T[],
  sort: IssueSort
): T[] {
  const out = [...list];
  switch (sort) {
    case "created-desc":
      out.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
      break;
    case "created-asc":
      out.sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
      break;
    case "updated-desc":
      out.sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
      break;
    case "updated-asc":
      out.sort((a, b) => toMs(a.updatedAt) - toMs(b.updatedAt));
      break;
    case "comments-desc":
      out.sort((a, b) => (b.commentCount || 0) - (a.commentCount || 0));
      break;
  }
  return out;
}

/** One-shot: parse + filter + sort. */
export function applyQuery<T extends QueryableIssue>(
  raw: string | null | undefined,
  issues: T[]
): { query: IssueQuery; matches: T[] } {
  const q = parseIssueQuery(raw);
  const filtered = issues.filter((i) => matchIssue(i, q));
  const sorted = sortIssues(filtered, q.sort);
  return { query: q, matches: sorted };
}

/**
 * Turn a structured query back into a canonical query string. Useful for
 * rebuilding the input field after server-side filtering.
 */
export function formatIssueQuery(q: IssueQuery): string {
  const parts: string[] = [];
  if (q.is) parts.push(`is:${q.is}`);
  if (q.author) parts.push(`author:${q.author}`);
  for (const l of q.labels) parts.push(formatValuePair("label", l));
  for (const l of q.excludeLabels) parts.push(`-label:${quoteIfNeeded(l)}`);
  if (q.noLabel) parts.push("no:label");
  if (q.milestone) parts.push(formatValuePair("milestone", q.milestone));
  if (q.sort !== DEFAULT_SORT) parts.push(`sort:${q.sort}`);
  if (q.text) parts.push(quoteIfNeeded(q.text));
  return parts.join(" ");
}

function formatValuePair(key: string, value: string): string {
  return `${key}:${quoteIfNeeded(value)}`;
}

function quoteIfNeeded(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

export const __internal = {
  VALID_SORTS,
  DEFAULT_SORT,
  tokenise,
  parseIssueQuery,
  matchIssue,
  sortIssues,
  applyQuery,
  formatIssueQuery,
};
