/**
 * Block J22 — Code review suggestion blocks.
 *
 * GitHub-style ```suggestion ... ``` fences in PR comments. The reviewer
 * proposes a replacement for the commented line(s); the reader can
 * one-click "Commit suggestion" to write it to the PR's head branch.
 *
 * This module is pure:
 *   - `extractSuggestions(body)` parses a comment body into suggestion
 *     blocks preserving their order + raw content + source offsets.
 *   - `applySuggestionToContent({content, startLine, endLine, suggestion})`
 *     returns the new file content with lines `startLine..endLine`
 *     (1-indexed, inclusive) replaced by `suggestion`, preserving the
 *     file's original line ending.
 *
 * We deliberately restrict ourselves to **single-suggestion commits**:
 * each POST applies one block, against the anchor line recorded on the
 * PR comment (a single line in our schema). Multi-line ranges — GitHub
 * supports `@@ ... @@`-style deltas — are a later extension.
 */

export interface SuggestionBlock {
  /** The suggestion's replacement text, verbatim between the fences. */
  content: string;
  /** Character offset of the opening fence in the comment body. */
  startOffset: number;
  /** Character offset immediately after the closing fence. */
  endOffset: number;
  /** Position in the body (0-indexed). */
  index: number;
}

/**
 * Detect the dominant line ending in the given content. Heuristic:
 * if any CRLF is present the whole file is treated as CRLF; otherwise LF.
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Split on `\r\n` or `\n` without consuming the last empty element. */
export function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/**
 * Parse a comment body into an array of suggestion blocks. Matches
 * fenced blocks where the info-string begins with `suggestion`. Handles:
 *   - Indented fences (up to 3 leading spaces) — CommonMark parity
 *   - Blocks using 3+ backticks (closing fence must be ≥ opener count)
 *   - The content is returned verbatim, with the trailing newline before
 *     the closing fence stripped (GitHub's renderer does this).
 * Blocks opened but never closed are skipped.
 */
export function extractSuggestions(body: string): SuggestionBlock[] {
  if (!body || typeof body !== "string") return [];
  const out: SuggestionBlock[] = [];
  const fenceRe = /^[ ]{0,3}(`{3,})[ \t]*suggestion[^\n]*\n/gm;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = fenceRe.exec(body)) !== null) {
    const fence = m[1];
    const openStart = m.index;
    const contentStart = openStart + m[0].length;
    // Find the matching closing fence: a line starting with ≥fence.length
    // backticks, up to 3 spaces of indent, at the start of a line.
    const closeRe = new RegExp(
      `(\\r?\\n)?[ ]{0,3}\`{${fence.length},}[ \\t]*(?:\\r?\\n|$)`,
      "g"
    );
    closeRe.lastIndex = contentStart;
    const close = closeRe.exec(body);
    if (!close) break; // unterminated — ignore
    // Ensure the close is at the start of a line (either body[close.index]
    // is a newline we captured, or close.index === contentStart).
    const rawContent = body.slice(contentStart, close.index);
    out.push({
      content: rawContent,
      startOffset: openStart,
      endOffset: close.index + close[0].length,
      index: idx++,
    });
    fenceRe.lastIndex = close.index + close[0].length;
  }
  return out;
}

export interface ApplyOpts {
  /** Original file content. */
  content: string;
  /** 1-indexed, inclusive. */
  startLine: number;
  /** 1-indexed, inclusive. */
  endLine: number;
  /** Replacement text. Trailing newline is stripped if present. */
  suggestion: string;
}

export interface ApplyResult {
  ok: boolean;
  /** New content (only set when ok). */
  content?: string;
  /** Reason for failure (only set when !ok). */
  reason?:
    | "bad_range"
    | "line_out_of_bounds"
    | "empty_content"
    | "no_change";
}

/**
 * Replace file lines `startLine..endLine` with the suggestion.
 * Preserves the dominant line ending in the original file. Returns the
 * new file content (ending with the same terminal newline presence as
 * the original).
 */
export function applySuggestionToContent(opts: ApplyOpts): ApplyResult {
  const { content, startLine, endLine, suggestion } = opts;
  if (typeof content !== "string") return { ok: false, reason: "empty_content" };
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return { ok: false, reason: "bad_range" };
  }
  const eol = detectLineEnding(content);
  const hadTrailingNewline = /\r?\n$/.test(content);
  const lines = splitLines(content);
  // splitLines yields a trailing "" element when the input ends in \n —
  // drop it to get true line count.
  const trimmedLines =
    hadTrailingNewline && lines[lines.length - 1] === ""
      ? lines.slice(0, -1)
      : lines;
  if (endLine > trimmedLines.length) {
    return { ok: false, reason: "line_out_of_bounds" };
  }
  // Normalise suggestion to LF then split — we'll rejoin with eol below.
  const replacement = suggestion.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const replacementLines = replacement.split("\n");
  const before = trimmedLines.slice(0, startLine - 1);
  const after = trimmedLines.slice(endLine);
  const next = [...before, ...replacementLines, ...after];
  let result = next.join(eol);
  if (hadTrailingNewline) result += eol;
  if (result === content) return { ok: false, reason: "no_change" };
  return { ok: true, content: result };
}

/**
 * Convenience: apply the Nth suggestion from a comment body to a file.
 * Returns `{ok:false, reason:'not_found'}` if the index is out of range.
 */
export function applyNthSuggestion(
  body: string,
  n: number,
  opts: Omit<ApplyOpts, "suggestion">
): ApplyResult | { ok: false; reason: "not_found" } {
  const blocks = extractSuggestions(body);
  if (n < 0 || n >= blocks.length) return { ok: false, reason: "not_found" };
  return applySuggestionToContent({ ...opts, suggestion: blocks[n].content });
}

export const __internal = {
  detectLineEnding,
  splitLines,
  extractSuggestions,
  applySuggestionToContent,
  applyNthSuggestion,
};
