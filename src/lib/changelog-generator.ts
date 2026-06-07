/**
 * changelog-generator.ts — AI-powered changelog generator for releases.
 *
 * Public entrypoint used by the release form and external automation.
 * Thin wrapper over `ai-release-notes.ts` that exposes the canonical
 * `generateChangelog(owner, repo, fromTag, toRef, repoId)` signature.
 *
 * Pipeline:
 *   1. Walk `git log fromTag..toRef --no-merges` for raw commits.
 *   2. Cross-reference commits with the `pull_requests` table to enrich
 *      each entry with PR metadata (labels, author, body excerpt).
 *   3. Bucket commits/PRs by conventional-commit prefix or label into
 *      categories: features, fixes, perf, docs, security, ai_changes, other.
 *   4. If `ANTHROPIC_API_KEY` is set, ask Claude (claude-sonnet-4-6) to write
 *      a polished, human-readable Markdown changelog from the grouped input.
 *   5. Fall back to a deterministic grouped list when the key is absent.
 *
 * Output format (AI path):
 *
 *   ## v1.3.0 (since v1.2.0)
 *   **Short release tagline**
 *
 *   One-to-three sentence summary of what changed and why it matters.
 *
 *   ### Features
 *   - Add PR preview environments (#42) — @alice
 *
 *   ### Bug fixes
 *   - Fix race condition in SSE reconnection (#37) — @bob
 *
 *   _Full changelog_: `v1.2.0...v1.3.0`
 */

import { generateReleaseNotes } from "./ai-release-notes";

/**
 * Generate a human-readable Markdown changelog for the commit range
 * `fromTag..toRef` on `owner/repo`.
 *
 * @param owner   — repository owner username
 * @param repo    — repository name
 * @param fromTag — previous tag/ref (e.g. "v1.2.0"); pass empty string for
 *                  "all commits reachable from toRef"
 * @param toRef   — target tag/ref (e.g. "HEAD" or "v1.3.0")
 * @param repoId  — database UUID of the repository (for PR cross-reference)
 * @returns       — Markdown string ready to store in `releases.body`
 */
export async function generateChangelog(
  owner: string,
  repo: string,
  fromTag: string,
  toRef: string,
  repoId: string
): Promise<string> {
  const result = await generateReleaseNotes({
    repositoryId: repoId,
    fromTag: fromTag.trim() || null,
    toTag: toRef.trim() || "HEAD",
  });
  return result.markdown;
}

// Re-export helpers that callers may want for testing / introspection.
export type { ReleaseNotesResult, ReleaseSections, ReleaseSectionKey } from "./ai-release-notes";
export { classifyPr, bucketPrs, renderSectionsToMarkdown, isSemverTag } from "./ai-release-notes";
