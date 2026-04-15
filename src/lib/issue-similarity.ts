/**
 * Block J28 — Issue title similarity / duplicate suggestions.
 *
 * Pure token-based Jaccard similarity for issue titles (+ optional bodies).
 * The idea: when a user is about to open a new issue, we can show the top-N
 * most similar existing issues so they can check if it's a duplicate before
 * posting. Also usable on an existing issue to surface related ones.
 *
 * The algorithm is deliberately simple and IO-free:
 *   1. Lowercase → strip punctuation → whitespace-split.
 *   2. Remove English stopwords.
 *   3. Drop tokens shorter than `MIN_TOKEN_LENGTH`.
 *   4. Score = |A ∩ B| / |A ∪ B| (Jaccard index).
 *
 * Scores are in [0, 1]; `rankCandidates` returns candidates sorted score-desc
 * (tie-break newest-first) and filters by `minScore` + `limit`.
 */

export const MIN_TOKEN_LENGTH = 2;

// Small, deliberately short English stopword list. Keeping it conservative
// so titles like "add auth to api" don't collapse to nothing.
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "so",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "is",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "be",
  "been",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "done",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "may",
  "might",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "their",
]);

/**
 * Lowercase, strip non-alphanumeric (Unicode-aware), split on whitespace,
 * drop stopwords + short tokens. Returns a `Set<string>` (dedup implicit).
 */
export function tokeniseTitle(input: unknown): Set<string> {
  if (typeof input !== "string") return new Set();
  const lower = input.toLowerCase();
  // Replace anything that isn't a Unicode letter, digit, or dash with space.
  // Using \p{L} + \p{N} to stay multilingual.
  const cleaned = lower.replace(/[^\p{L}\p{N}_-]+/gu, " ");
  const out = new Set<string>();
  for (const tok of cleaned.split(/\s+/)) {
    if (tok.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** Classic Jaccard: |A ∩ B| / |A ∪ B|. Returns 0 when both sets are empty. */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  // Iterate the smaller set for efficiency.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface SimilarityCandidate {
  id: string;
  number: number;
  title: string;
  state?: string;
  createdAt?: Date | string | null;
}

export interface SimilarityResult {
  id: string;
  number: number;
  title: string;
  state?: string;
  score: number;
}

export interface RankOptions {
  /** Discard candidates with score strictly below this. Default 0.15. */
  minScore?: number;
  /** Return at most this many results. Default 5. */
  limit?: number;
  /** Optional id of the source issue — never ranked against itself. */
  excludeId?: string;
  /** Optional number of the source issue — never ranked against itself. */
  excludeNumber?: number;
  /** If set, restrict candidates to this state. */
  state?: string;
}

export const DEFAULT_MIN_SCORE = 0.15;
export const DEFAULT_LIMIT = 5;

function toTime(v: Date | string | null | undefined): number {
  if (!v) return 0;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  if (typeof v === "string") {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

export function rankCandidates(
  targetTitle: string,
  candidates: readonly SimilarityCandidate[],
  opts: RankOptions = {}
): SimilarityResult[] {
  const min = opts.minScore ?? DEFAULT_MIN_SCORE;
  const limit = Math.max(0, opts.limit ?? DEFAULT_LIMIT);
  const stateFilter = opts.state;
  const tTokens = tokeniseTitle(targetTitle);
  if (tTokens.size === 0 || limit === 0) return [];

  const results: (SimilarityResult & { __t: number })[] = [];
  for (const c of candidates) {
    if (opts.excludeId && c.id === opts.excludeId) continue;
    if (
      opts.excludeNumber !== undefined &&
      c.number === opts.excludeNumber
    ) {
      continue;
    }
    if (stateFilter && c.state !== stateFilter) continue;
    const cTokens = tokeniseTitle(c.title);
    if (cTokens.size === 0) continue;
    const score = jaccard(tTokens, cTokens);
    if (score < min) continue;
    results.push({
      id: c.id,
      number: c.number,
      title: c.title,
      state: c.state,
      score,
      __t: toTime(c.createdAt),
    });
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // Tie-break: newer candidates first (more likely relevant).
    if (a.__t !== b.__t) return b.__t - a.__t;
    // Stable final tie-break on number-desc.
    return b.number - a.number;
  });

  return results.slice(0, limit).map(({ __t, ...rest }) => rest);
}

/** "47%" style — useful for UI rendering. */
export function formatSimilarityPercent(score: number): string {
  if (!Number.isFinite(score)) return "0%";
  const clamped = Math.max(0, Math.min(1, score));
  return `${Math.round(clamped * 100)}%`;
}

/** One-shot convenience: tokenise + rank. */
export function findSimilar(
  targetTitle: string,
  candidates: readonly SimilarityCandidate[],
  opts?: RankOptions
): SimilarityResult[] {
  return rankCandidates(targetTitle, candidates, opts);
}

export const __internal = {
  MIN_TOKEN_LENGTH,
  STOPWORDS,
  DEFAULT_MIN_SCORE,
  DEFAULT_LIMIT,
  tokeniseTitle,
  jaccard,
  rankCandidates,
  findSimilar,
  formatSimilarityPercent,
  toTime,
};
