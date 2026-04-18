/**
 * Block J7 — Closing keywords.
 *
 * Parses PR body + commit messages for GitHub-style "closes #N" phrases and
 * returns the de-duplicated set of issue numbers that should auto-close when
 * the PR merges. Pure; zero IO.
 *
 * Accepted verbs (case-insensitive):
 *   close(s|d), fix(es|ed), resolve(s|d)
 *
 * Optional punctuation between the verb and the issue ref ("Fixes: #12",
 * "Closes #12.") is tolerated. Refs must be bare `#<number>` — cross-repo
 * refs like `owner/repo#12` are intentionally ignored for v1 because
 * cross-repo auto-close requires authorisation we don't track yet.
 */

const VERB = "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved";

// Word boundary on the verb, optional colon / hyphen / whitespace, then a
// bare `#<number>`. Ignore matches preceded by `/` (owner/repo#N cross-repo).
const CLOSE_RE = new RegExp(
  `(^|[^a-z0-9/])(${VERB})\\s*[:\\-]?\\s*#(\\d+)`,
  "gi"
);

/**
 * Extract the sorted de-duplicated list of issue numbers referenced with a
 * closing verb in the supplied text. Returns [] on empty / no match.
 */
export function extractClosingRefs(text: string | null | undefined): number[] {
  if (!text) return [];
  const out = new Set<number>();
  for (const m of text.matchAll(CLOSE_RE)) {
    const n = parseInt(m[3], 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Extract closing refs from N source strings (e.g. PR body + commit messages)
 * and return the merged de-duped list.
 */
export function extractClosingRefsMulti(
  sources: Array<string | null | undefined>
): number[] {
  const all = new Set<number>();
  for (const s of sources) {
    for (const n of extractClosingRefs(s)) all.add(n);
  }
  return [...all].sort((a, b) => a - b);
}

export const __internal = { CLOSE_RE };
