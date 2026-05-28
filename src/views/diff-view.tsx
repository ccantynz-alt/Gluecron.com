/**
 * DiffView — polished file-diff renderer for PR detail, commit detail, and
 * compare pages.
 *
 * Visual goals (Vercel-quality):
 *   • file header with filename in mono, copy-path icon, expand/collapse,
 *     traffic-light +X/-Y stat pills, file-status pill
 *   • unified diff body with subtle row tints, tabular-numbers gutter,
 *     gradient hairlines between hunks
 *   • syntax highlighting via src/lib/highlight.ts (reuses the blob theme)
 *   • optional "View file at this revision" link
 *   • big-file fallback (skip render if a single file > BIG_FILE_LINES)
 *
 * IMPORTANT: this lives outside src/views/components.tsx on purpose — that
 * file is locked. The legacy DiffView export in components.tsx is no longer
 * imported by any route, but is left intact to avoid touching the locked file.
 */

import type { FC } from "hono/jsx";
import type { GitDiffFile } from "../git/repository";
import { highlightCode } from "../lib/highlight";

/**
 * Render a span whose inner HTML is a pre-rendered highlight.js string.
 * Falls back to plain escaped text when `html` is null.
 */
const CodeSpan: FC<{ html: string | null; text: string }> = ({ html: h, text }) => {
  if (h != null) {
    return (
      <span class="diff-code" dangerouslySetInnerHTML={{ __html: h }} />
    );
  }
  return <span class="diff-code">{text || "​"}</span>;
};

// ─── Types ──────────────────────────────────────────────────────────────

interface ParsedHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: Array<{
    kind: "ctx" | "add" | "del";
    text: string;
    oldNum: number | null;
    newNum: number | null;
  }>;
}

interface ParsedFile {
  /** path shown to the user (== new path for renames, else the only path) */
  path: string;
  /** original path on a rename, otherwise null */
  oldPath: string | null;
  status: "added" | "modified" | "renamed" | "deleted" | "binary";
  binary: boolean;
  /** raw line count across all hunks — for big-file fallback */
  lineCount: number;
  hunks: ParsedHunk[];
}

// Skip inline rendering for individual files larger than this. Mirrors the
// "huge diff" UX from GitHub — keeps the page responsive on monster PRs.
const BIG_FILE_LINES = 1000;

// ─── Parser ─────────────────────────────────────────────────────────────

/**
 * Parse `git diff` output into structured per-file hunks. Robust against
 * the various preamble lines (`index …`, `new file mode …`, rename
 * headers, binary markers).
 */
function parseUnifiedDiff(raw: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  if (!raw) return files;

  const diffStart = /^diff --git a\/(.+?) b\/(.+)$/;
  const hunkStart = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  let cur: ParsedFile | null = null;
  let curHunk: ParsedHunk | null = null;
  let oldNum = 0;
  let newNum = 0;

  const flushHunk = () => {
    if (cur && curHunk) {
      cur.hunks.push(curHunk);
      cur.lineCount += curHunk.lines.length;
    }
    curHunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  };

  for (const line of raw.split("\n")) {
    const dm = line.match(diffStart);
    if (dm) {
      flushFile();
      const [, oldP, newP] = dm;
      cur = {
        path: newP,
        oldPath: oldP !== newP ? oldP : null,
        status: oldP !== newP ? "renamed" : "modified",
        binary: false,
        lineCount: 0,
        hunks: [],
      };
      continue;
    }
    if (!cur) continue;

    // Preamble: status discovery.
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from")) cur.status = "renamed";
    else if (line.startsWith("Binary files")) {
      cur.binary = true;
      cur.status = cur.status === "modified" ? "binary" : cur.status;
      continue;
    }

    // Skip the headers we don't render.
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("copy from") ||
      line.startsWith("copy to") ||
      line.startsWith("Binary files") ||
      line.startsWith("GIT binary patch")
    ) {
      continue;
    }

    const hm = line.match(hunkStart);
    if (hm) {
      flushHunk();
      oldNum = parseInt(hm[1], 10);
      newNum = parseInt(hm[2], 10);
      curHunk = {
        header: line,
        oldStart: oldNum,
        newStart: newNum,
        lines: [],
      };
      continue;
    }
    if (!curHunk) continue;

    if (line.startsWith("+")) {
      curHunk.lines.push({
        kind: "add",
        text: line.slice(1),
        oldNum: null,
        newNum: newNum++,
      });
    } else if (line.startsWith("-")) {
      curHunk.lines.push({
        kind: "del",
        text: line.slice(1),
        oldNum: oldNum++,
        newNum: null,
      });
    } else if (line.startsWith("\\")) {
      // "\\ No newline at end of file" — keep as a context marker.
      curHunk.lines.push({
        kind: "ctx",
        text: line,
        oldNum: null,
        newNum: null,
      });
    } else {
      // Context line: leading space (or empty on a fully empty line).
      curHunk.lines.push({
        kind: "ctx",
        text: line.startsWith(" ") ? line.slice(1) : line,
        oldNum: oldNum++,
        newNum: newNum++,
      });
    }
  }
  flushFile();
  return files;
}

// ─── Stat aggregation ───────────────────────────────────────────────────

function countAddsDels(file: ParsedFile): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) {
    for (const ln of h.lines) {
      if (ln.kind === "add") add += 1;
      else if (ln.kind === "del") del += 1;
    }
  }
  return { add, del };
}

// ─── Per-line syntax highlighting ───────────────────────────────────────

/**
 * Run the existing highlight.js pipeline on the file's logical post-change
 * content, then split it by line so each diff row gets its colored span.
 * If hljs can't determine a language, we fall back to plain escaped text.
 */
function highlightFile(
  filename: string,
  hunks: ParsedHunk[]
): { perLine: Map<string, string>; language: string | null } {
  // Build a synthetic representation of "what the file might look like"
  // by joining every non-deleted line. This lets hljs see enough syntax
  // context that the highlight is meaningful.
  const segments: string[] = [];
  for (const h of hunks) {
    for (const ln of h.lines) {
      if (ln.kind === "del") continue;
      segments.push(ln.text);
    }
  }
  const joined = segments.join("\n");
  const { html: highlighted, language } = highlightCode(joined, filename);

  // Map each non-deleted line back to its highlighted variant by index.
  const splitLines = highlighted.split("\n");
  const perLine = new Map<string, string>();
  let idx = 0;
  for (const h of hunks) {
    for (const ln of h.lines) {
      if (ln.kind === "del") continue;
      // key uses both hunk identity + line number to disambiguate
      const key = `${h.newStart}:${ln.newNum ?? "x"}:${idx}`;
      perLine.set(key, splitLines[idx] ?? escapeHtml(ln.text));
      idx += 1;
    }
  }
  return { perLine, language };
}

function highlightDeletedLines(
  filename: string,
  hunks: ParsedHunk[]
): Map<string, string> {
  const segments: string[] = [];
  for (const h of hunks) {
    for (const ln of h.lines) {
      if (ln.kind !== "del") continue;
      segments.push(ln.text);
    }
  }
  const joined = segments.join("\n");
  if (!joined) return new Map();
  const { html: highlighted } = highlightCode(joined, filename);
  const splitLines = highlighted.split("\n");
  const perLine = new Map<string, string>();
  let idx = 0;
  for (const h of hunks) {
    for (const ln of h.lines) {
      if (ln.kind !== "del") continue;
      const key = `${h.oldStart}:${ln.oldNum ?? "x"}:${idx}`;
      perLine.set(key, splitLines[idx] ?? escapeHtml(ln.text));
      idx += 1;
    }
  }
  return perLine;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── File header pieces ─────────────────────────────────────────────────

const StatusPill: FC<{ status: ParsedFile["status"] }> = ({ status }) => {
  const label =
    status === "added"
      ? "Added"
      : status === "deleted"
        ? "Deleted"
        : status === "renamed"
          ? "Renamed"
          : status === "binary"
            ? "Binary"
            : "Modified";
  return <span class={`diff-status diff-status-${status}`}>{label}</span>;
};

const StatPills: FC<{ add: number; del: number }> = ({ add, del }) => (
  <span class="diff-stat-pills" aria-label={`+${add} additions, -${del} deletions`}>
    <span class="diff-stat-pill diff-stat-add">+{add}</span>
    <span class="diff-stat-pill diff-stat-del">−{del}</span>
  </span>
);

// ─── Public component ──────────────────────────────────────────────────

export interface InlineDiffComment {
  id: string;
  filePath: string;
  lineNumber: number;
  authorUsername: string;
  body: string;
  createdAt: string;
  isAiReview?: boolean;
}

export interface DiffViewProps {
  raw: string;
  files: GitDiffFile[];
  /** When set, file headers gain "View file" links to `${viewFileBase}/${path}`. */
  viewFileBase?: string;
  /** Existing inline comments to render anchored to their file+line */
  inlineComments?: InlineDiffComment[];
  /** URL to POST a new inline comment to (shows gutter "+" buttons when set) */
  commentActionUrl?: string;
  /** If set, shows "Apply suggestion" button on suggestion blocks; POSTs to `${applySuggestionUrl}/${commentId}` */
  applySuggestionUrl?: string;
}

export const DiffView: FC<DiffViewProps> = ({ raw, files, viewFileBase, inlineComments, commentActionUrl, applySuggestionUrl }) => {
  const parsed = parseUnifiedDiff(raw);

  // Build a lookup map: "filePath:lineNumber" → inline comments
  const commentsByLine = new Map<string, InlineDiffComment[]>();
  for (const c of inlineComments ?? []) {
    const key = `${c.filePath}:${c.lineNumber}`;
    const arr = commentsByLine.get(key) ?? [];
    arr.push(c);
    commentsByLine.set(key, arr);
  }

  // Stat fallback: if --numstat gave us per-file counts they trump our
  // hunk-based count (only --numstat sees binary deltas accurately).
  const statByPath = new Map<string, { add: number; del: number }>();
  for (const f of files) {
    statByPath.set(f.path, { add: f.additions, del: f.deletions });
  }
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  const fileCount = files.length || parsed.length;
  const showJumpNav = fileCount > 3;

  return (
    <div class="diff-view">
      <style dangerouslySetInnerHTML={{ __html: DIFF_VIEW_CSS }} />

      <div class="diff-summary">
        <span class="diff-summary-count">
          <strong>{fileCount}</strong>{" "}
          changed file{fileCount !== 1 ? "s" : ""}
        </span>
        <StatPills add={totalAdd} del={totalDel} />
        {showJumpNav && (
          <button
            type="button"
            class="diff-jump-toggle"
            aria-expanded="false"
            aria-controls="diff-jump-nav"
          >
            Jump to file ▾
          </button>
        )}
      </div>

      {showJumpNav && (
        <div id="diff-jump-nav" class="diff-jump-nav" hidden>
          {parsed.map((file, fIdx) => {
            const counts = statByPath.get(file.path) ?? statByPath.get(file.oldPath ?? "") ?? countAddsDels(file);
            return (
              <a href={`#diff-file-${fIdx}`} class="diff-jump-item" onclick="document.getElementById('diff-jump-nav').hidden=true;document.querySelector('.diff-jump-toggle').setAttribute('aria-expanded','false')">
                <span class="diff-jump-path">{file.path}</span>
                <span class="diff-jump-pills">
                  {counts.add > 0 && <span class="diff-jump-add">+{counts.add}</span>}
                  {counts.del > 0 && <span class="diff-jump-del">-{counts.del}</span>}
                </span>
              </a>
            );
          })}
        </div>
      )}

      {parsed.map((file, fIdx) => {
        const counts =
          statByPath.get(file.path) ??
          statByPath.get(file.oldPath ?? "") ??
          countAddsDels(file);
        const id = `diff-file-${fIdx}`;
        const tooBig = file.lineCount > BIG_FILE_LINES;
        const showDeletedOnly = file.status === "deleted";
        const blobHref = viewFileBase
          ? `${viewFileBase}/${file.path}`
          : null;

        // Highlight the post-change view + (separately) the pre-change view
        // for deletions, so syntax colors survive both sides of a diff.
        const { perLine: addedHighlights, language } = file.binary || tooBig
          ? { perLine: new Map<string, string>(), language: null }
          : highlightFile(file.path, file.hunks);
        const deletedHighlights = file.binary || tooBig
          ? new Map<string, string>()
          : highlightDeletedLines(file.path, file.hunks);

        return (
          <details class="diff-file" id={id} open>
            <summary class="diff-file-summary">
              <span class="diff-file-chevron" aria-hidden="true">{"▾"}</span>
              <StatusPill status={file.status} />
              <span class="diff-file-path" title={file.path}>
                {file.oldPath ? (
                  <>
                    <span class="diff-file-old">{file.oldPath}</span>
                    <span class="diff-file-arrow" aria-hidden="true">{" → "}</span>
                    <span class="diff-file-new">{file.path}</span>
                  </>
                ) : (
                  file.path
                )}
              </span>
              <button
                type="button"
                class="diff-file-copy"
                data-copy={file.path}
                title="Copy path"
                aria-label={`Copy path ${file.path}`}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M4 1.5h6A1.5 1.5 0 0 1 11.5 3v1h-1V3a.5.5 0 0 0-.5-.5H4a.5.5 0 0 0-.5.5v8a.5.5 0 0 0 .5.5h1v1H4A1.5 1.5 0 0 1 2.5 11V3A1.5 1.5 0 0 1 4 1.5Z"
                  />
                  <path
                    fill="currentColor"
                    d="M6 5.5h6A1.5 1.5 0 0 1 13.5 7v6A1.5 1.5 0 0 1 12 14.5H6A1.5 1.5 0 0 1 4.5 13V7A1.5 1.5 0 0 1 6 5.5Zm0 1A.5.5 0 0 0 5.5 7v6a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V7a.5.5 0 0 0-.5-.5H6Z"
                  />
                </svg>
              </button>
              <span class="diff-file-spacer" />
              <StatPills add={counts.add} del={counts.del} />
              {blobHref && (
                <a
                  href={blobHref}
                  class="diff-file-blob-link"
                  title="View file at this revision"
                >
                  View file
                </a>
              )}
            </summary>

            {file.binary ? (
              <div class="diff-empty">Binary file not shown.</div>
            ) : tooBig ? (
              <div class="diff-empty diff-empty-big">
                Large file ({file.lineCount.toLocaleString()} lines).{" "}
                {blobHref ? (
                  <a href={blobHref}>Load full file</a>
                ) : (
                  "Skipped inline render."
                )}
              </div>
            ) : file.hunks.length === 0 ? (
              <div class="diff-empty">No textual changes.</div>
            ) : (
              <div class={`diff-body${language ? " has-hljs" : ""}`}>
                {file.hunks.map((hunk, hIdx) => (
                  <>
                    {hIdx > 0 && <div class="diff-hunk-gap" aria-hidden="true" />}
                    <div class="diff-hunk-header" role="separator">
                      <span class="diff-hunk-header-text">{hunk.header}</span>
                    </div>
                    {hunk.lines.map((ln, lIdx) => {
                      const key =
                        ln.kind === "del"
                          ? `${hunk.oldStart}:${ln.oldNum ?? "x"}`
                          : `${hunk.newStart}:${ln.newNum ?? "x"}`;
                      // Lookup the highlight match. Our maps key with an
                      // index suffix, so iterate to find it (cheap — small).
                      let highlighted: string | null = null;
                      if (showDeletedOnly || ln.kind === "del") {
                        for (const [k, v] of deletedHighlights) {
                          if (k.startsWith(`${hunk.oldStart}:${ln.oldNum ?? "x"}:`)) {
                            highlighted = v;
                            deletedHighlights.delete(k);
                            break;
                          }
                        }
                      } else {
                        for (const [k, v] of addedHighlights) {
                          if (k.startsWith(`${hunk.newStart}:${ln.newNum ?? "x"}:`)) {
                            highlighted = v;
                            addedHighlights.delete(k);
                            break;
                          }
                        }
                      }
                      const marker =
                        ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : " ";
                      // Inline comments anchor to the new-file line number
                      const commentKey = ln.newNum != null ? `${file.path}:${ln.newNum}` : null;
                      const lineComments = commentKey ? (commentsByLine.get(commentKey) ?? []) : [];
                      const canComment = commentActionUrl && ln.kind !== "del" && ln.newNum != null;
                      return (
                        <>
                          <div
                            class={`diff-row diff-row-${ln.kind}`}
                            data-line={key}
                            data-file={canComment ? file.path : undefined}
                            data-newline={canComment ? ln.newNum : undefined}
                            data-linetext={canComment ? ln.text : undefined}
                          >
                            <span class="diff-gutter diff-gutter-old">
                              {ln.oldNum ?? ""}
                            </span>
                            <span class="diff-gutter diff-gutter-new">
                              {ln.newNum ?? ""}
                              {canComment && (
                                <button class="diff-comment-btn" title="Add comment" aria-label="Add inline comment">+</button>
                              )}
                            </span>
                            <span class="diff-marker" aria-hidden="true">
                              {marker}
                            </span>
                            <CodeSpan html={highlighted} text={ln.text} />
                          </div>
                          {lineComments.map(c => {
                            // Detect suggestion block: ```suggestion\n...\n```
                            const suggMatch = c.body.match(/^```suggestion\n([\s\S]*?)\n```/);
                            if (suggMatch) {
                              const suggCode = suggMatch[1];
                              // Any text after the closing ``` fence is treated as the comment prose
                              const afterFence = c.body.slice(suggMatch[0].length).trim();
                              return (
                                <div class={`diff-inline-comment${c.isAiReview ? " diff-inline-comment-ai" : ""}`} data-comment-id={c.id}>
                                  <div class="diff-inline-comment-head">
                                    <strong>{c.authorUsername}</strong>
                                    <span class="diff-inline-comment-meta">
                                      {c.isAiReview && <span class="diff-inline-ai-badge">AI</span>}
                                      {new Date(c.createdAt).toLocaleDateString()}
                                    </span>
                                  </div>
                                  <div class="diff-suggestion-block">
                                    <div class="diff-suggestion-header">
                                      <span>Suggested change</span>
                                      {applySuggestionUrl && (
                                        <form method="POST" action={`${applySuggestionUrl}/${c.id}`} style="margin:0;display:inline;">
                                          <button type="submit" class="diff-apply-btn">Apply suggestion</button>
                                        </form>
                                      )}
                                    </div>
                                    <pre class="diff-suggestion-code">{suggCode}</pre>
                                  </div>
                                  {afterFence && (
                                    <div class="diff-inline-comment-body" style="margin-top:6px;" dangerouslySetInnerHTML={{ __html: afterFence }} />
                                  )}
                                </div>
                              );
                            }
                            return (
                              <div class={`diff-inline-comment${c.isAiReview ? " diff-inline-comment-ai" : ""}`} data-comment-id={c.id}>
                                <div class="diff-inline-comment-head">
                                  <strong>{c.authorUsername}</strong>
                                  <span class="diff-inline-comment-meta">
                                    {c.isAiReview && <span class="diff-inline-ai-badge">AI</span>}
                                    {new Date(c.createdAt).toLocaleDateString()}
                                  </span>
                                </div>
                                <div class="diff-inline-comment-body" dangerouslySetInnerHTML={{ __html: c.body }} />
                              </div>
                            );
                          })}
                        </>
                      );
                    })}
                  </>
                ))}
              </div>
            )}
          </details>
        );
      })}

      {commentActionUrl && (
        <meta name="diff-comment-url" content={commentActionUrl} />
      )}
      {applySuggestionUrl && (
        <meta name="diff-apply-suggestion-url" content={applySuggestionUrl} />
      )}
      <script dangerouslySetInnerHTML={{ __html: DIFF_VIEW_JS }} />
    </div>
  );
};

// ─── Inline script: copy-path button ───────────────────────────────────

const DIFF_VIEW_JS = `
(function () {
  // Jump-to-file nav toggle
  var jumpToggle = document.querySelector('.diff-jump-toggle');
  if (jumpToggle) {
    jumpToggle.addEventListener('click', function () {
      var nav = document.getElementById('diff-jump-nav');
      if (!nav) return;
      var open = nav.hidden;
      nav.hidden = !open;
      jumpToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) jumpToggle.classList.add('is-open');
      else jumpToggle.classList.remove('is-open');
    });
    // Close on outside click
    document.addEventListener('click', function (ev) {
      var nav = document.getElementById('diff-jump-nav');
      if (!nav || nav.hidden) return;
      if (!jumpToggle.contains(ev.target) && !nav.contains(ev.target)) {
        nav.hidden = true;
        jumpToggle.setAttribute('aria-expanded', 'false');
        jumpToggle.classList.remove('is-open');
      }
    });
  }

  // Copy-path button
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t) return;
    // Copy path button
    var copyBtn = t.closest && t.closest('.diff-file-copy');
    if (copyBtn) {
      e.preventDefault();
      var path = copyBtn.getAttribute('data-copy') || '';
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(path).then(function () {
        copyBtn.classList.add('is-copied');
        setTimeout(function () { copyBtn.classList.remove('is-copied'); }, 1200);
      }).catch(function () {});
      return;
    }
    // Inline comment "+" button
    var commentBtn = t.closest && t.closest('.diff-comment-btn');
    if (commentBtn) {
      e.preventDefault();
      var row = commentBtn.closest('.diff-row');
      if (!row) return;
      var filePath = row.getAttribute('data-file');
      var lineNum = row.getAttribute('data-newline');
      var lineText = row.getAttribute('data-linetext') || '';
      var actionUrl = document.querySelector('meta[name="diff-comment-url"]');
      if (!filePath || !lineNum || !actionUrl) return;
      // Remove any existing open form
      var existing = document.querySelector('.diff-inline-form-row');
      if (existing) {
        if (existing.previousSibling === row) { existing.remove(); return; }
        existing.remove();
      }
      // Build a form row
      var form = document.createElement('form');
      form.method = 'POST';
      form.action = actionUrl.getAttribute('content') || '';
      form.className = 'diff-inline-form-row';
      form.innerHTML =
        '<input type="hidden" name="file_path" value="' + filePath.replace(/"/g,'&quot;') + '">' +
        '<input type="hidden" name="line_number" value="' + lineNum + '">' +
        '<textarea name="body" rows="3" placeholder="Leave a comment…" class="diff-inline-textarea" required></textarea>' +
        '<button type="button" class="diff-suggestion-toggle" title="Toggle suggestion mode">Suggest a change</button>' +
        '<textarea class="diff-suggestion-textarea" rows="3" placeholder="Enter suggested replacement…" aria-label="Suggested replacement code"></textarea>' +
        '<div class="diff-inline-form-actions">' +
          '<button type="submit" class="diff-inline-submit">Comment</button>' +
          '<button type="button" class="diff-inline-cancel">Cancel</button>' +
        '</div>';
      var toggleBtn = form.querySelector('.diff-suggestion-toggle');
      var suggTA = form.querySelector('.diff-suggestion-textarea');
      var submitBtn = form.querySelector('.diff-inline-submit');
      var bodyTA = form.querySelector('textarea[name="body"]');
      var suggestionActive = false;
      toggleBtn.addEventListener('click', function () {
        suggestionActive = !suggestionActive;
        if (suggestionActive) {
          toggleBtn.classList.add('is-active');
          suggTA.classList.add('is-visible');
          suggTA.value = lineText;
          submitBtn.textContent = 'Add suggestion & comment';
        } else {
          toggleBtn.classList.remove('is-active');
          suggTA.classList.remove('is-visible');
          submitBtn.textContent = 'Comment';
        }
      });
      form.addEventListener('submit', function (ev) {
        if (!suggestionActive) return;
        ev.preventDefault();
        var suggVal = suggTA.value;
        var commentText = bodyTA.value;
        var wrapped = "\`\`\`suggestion\n" + suggVal + "\n\`\`\`";
        var fullBody = commentText ? (wrapped + '\n' + commentText) : wrapped;
        // Replace the body textarea value with the combined body
        bodyTA.value = fullBody;
        bodyTA.removeAttribute('required');
        // Re-submit without the suggestion logic
        suggestionActive = false;
        form.submit();
      });
      form.querySelector('.diff-inline-cancel').addEventListener('click', function () { form.remove(); });
      row.insertAdjacentElement('afterend', form);
      bodyTA.focus();
    }
  });
})();
`;

// ─── Inline CSS ────────────────────────────────────────────────────────

const DIFF_VIEW_CSS = `
  .diff-view {
    margin-top: 16px;
    font-family: var(--font-mono);
  }
  .diff-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    padding: 10px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    font-family: var(--font-sans, inherit);
    font-size: 13px;
    color: var(--text-muted);
  }
  .diff-summary-count strong { color: var(--text); }

  .diff-stat-pills {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
  }
  .diff-stat-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--font-mono);
    line-height: 1.4;
  }
  .diff-stat-add {
    color: #6ee7b7;
    background: rgba(52,211,153,0.12);
    border: 1px solid rgba(52,211,153,0.22);
  }
  .diff-stat-del {
    color: #fca5a5;
    background: rgba(248,113,113,0.10);
    border: 1px solid rgba(248,113,113,0.22);
  }

  .diff-file {
    margin-bottom: 18px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    overflow: hidden;
    position: relative;
  }
  .diff-file::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.55) 30%, rgba(54,197,214,0.55) 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }

  .diff-file-summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
    font-family: var(--font-sans, inherit);
    font-size: 13px;
  }
  .diff-file-summary::-webkit-details-marker { display: none; }
  .diff-file[open] .diff-file-summary { border-bottom: 1px solid var(--border); }
  .diff-file:not([open]) .diff-file-summary { border-bottom: 0; }

  .diff-file-chevron {
    display: inline-flex;
    color: var(--text-muted);
    transition: transform 120ms ease;
    width: 12px;
    text-align: center;
  }
  .diff-file:not([open]) .diff-file-chevron { transform: rotate(-90deg); }

  .diff-file-path {
    font-family: var(--font-mono);
    color: var(--text);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .diff-file-old { color: var(--text-muted); text-decoration: line-through; }
  .diff-file-arrow { color: var(--text-muted); }
  .diff-file-new { color: var(--text); }

  .diff-file-copy {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--text-muted);
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: all 120ms ease;
  }
  .diff-file-copy:hover {
    color: var(--text);
    background: var(--bg-elevated);
    border-color: var(--border);
  }
  .diff-file-copy.is-copied {
    color: var(--green, #6ee7b7);
    background: rgba(52,211,153,0.12);
    border-color: rgba(52,211,153,0.30);
  }
  .diff-file-copy.is-copied::after {
    content: 'Copied';
    position: absolute;
    margin-left: 28px;
    font-size: 11px;
    color: var(--green, #6ee7b7);
    font-family: var(--font-sans, inherit);
  }

  .diff-file-spacer { flex: 1; }

  .diff-file-blob-link {
    font-family: var(--font-sans, inherit);
    font-size: 12px;
    color: var(--text-muted);
    padding: 3px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    text-decoration: none;
    transition: all 120ms ease;
  }
  .diff-file-blob-link:hover {
    color: var(--text);
    border-color: rgba(140,109,255,0.45);
    background: var(--accent-gradient-faint, var(--bg-elevated));
  }

  .diff-status {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font-sans, inherit);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1.5;
    border: 1px solid transparent;
  }
  .diff-status-added {
    color: #6ee7b7;
    background: rgba(52,211,153,0.10);
    border-color: rgba(52,211,153,0.22);
  }
  .diff-status-modified {
    color: #fcd34d;
    background: rgba(252,211,77,0.08);
    border-color: rgba(252,211,77,0.22);
  }
  .diff-status-renamed {
    color: #93c5fd;
    background: rgba(147,197,253,0.10);
    border-color: rgba(147,197,253,0.25);
  }
  .diff-status-deleted {
    color: #fca5a5;
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.22);
  }
  .diff-status-binary {
    color: var(--text-muted);
    background: var(--bg-elevated);
    border-color: var(--border);
  }

  /* ─── Diff body ─── */
  .diff-body {
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.55;
    overflow-x: auto;
  }
  .diff-empty {
    padding: 18px 16px;
    text-align: center;
    color: var(--text-muted);
    font-family: var(--font-sans, inherit);
    font-size: 13px;
  }
  .diff-empty-big { background: rgba(140,109,255,0.04); }

  .diff-hunk-gap {
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, var(--border) 25%, var(--border) 75%, transparent 100%);
    margin: 0;
    opacity: 0.7;
  }
  .diff-hunk-header {
    padding: 4px 16px 4px 86px;
    background: rgba(140,109,255,0.05);
    color: var(--text-muted);
    font-size: 11.5px;
    border-top: 1px solid rgba(140,109,255,0.18);
    border-bottom: 1px solid rgba(140,109,255,0.18);
  }
  .diff-hunk-header-text { font-family: var(--font-mono); }

  .diff-row {
    display: grid;
    grid-template-columns: 44px 44px 16px 1fr;
    align-items: stretch;
    min-height: 1.55em;
  }
  .diff-gutter {
    text-align: right;
    padding: 0 6px;
    color: var(--text-muted);
    background: var(--bg-elevated);
    border-right: 1px solid var(--border);
    user-select: none;
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    opacity: 0.75;
  }
  .diff-gutter-new { border-right: 1px solid var(--border); }

  .diff-marker {
    text-align: center;
    color: var(--text-muted);
    user-select: none;
    background: var(--bg-elevated);
    border-right: 1px solid var(--border);
  }
  .diff-code {
    padding: 0 12px;
    white-space: pre;
    color: var(--text);
    overflow-x: visible;
  }

  /* Row tints — additions / deletions / context */
  .diff-row-add {
    background: rgba(52,211,153,0.08);
  }
  .diff-row-add .diff-gutter,
  .diff-row-add .diff-marker {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    border-right-color: rgba(52,211,153,0.20);
  }
  .diff-row-add .diff-marker { color: #6ee7b7; font-weight: 600; }

  .diff-row-del {
    background: rgba(248,113,113,0.08);
  }
  .diff-row-del .diff-gutter,
  .diff-row-del .diff-marker {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    border-right-color: rgba(248,113,113,0.20);
  }
  .diff-row-del .diff-marker { color: #fca5a5; font-weight: 600; }

  .diff-row:hover .diff-gutter { opacity: 1; }

  /* ─── Inline comment "+" button ─── */
  .diff-comment-btn {
    display: none;
    position: absolute;
    right: 2px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px; height: 16px;
    padding: 0;
    background: var(--accent, #8c6dff);
    color: #fff;
    border: none;
    border-radius: 3px;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    z-index: 2;
  }
  .diff-gutter-new { position: relative; }
  .diff-row:hover .diff-comment-btn { display: flex; align-items: center; justify-content: center; }

  /* ─── Inline comments anchored to diff lines ─── */
  .diff-inline-comment {
    grid-column: 1 / -1;
    display: block;
    margin: 4px 0;
    padding: 10px 14px;
    background: var(--bg-elevated);
    border-left: 3px solid var(--border);
    border-radius: 0 4px 4px 0;
    font-family: var(--font-sans, inherit);
    font-size: 13px;
  }
  .diff-inline-comment-ai { border-left-color: #8c6dff; }
  .diff-inline-comment-head {
    display: flex; gap: 8px; align-items: center;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .diff-inline-comment-head strong { color: var(--text-strong); }
  .diff-inline-ai-badge {
    background: rgba(140,109,255,0.2);
    color: #a78bfa;
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 10px;
    font-weight: 600;
  }
  .diff-inline-comment-body { color: var(--text); line-height: 1.6; }

  /* ─── Inline comment form ─── */
  .diff-inline-form-row {
    grid-column: 1 / -1;
    display: block;
    padding: 10px 14px;
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .diff-inline-textarea {
    width: 100%;
    min-height: 72px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    font-size: 13px;
    font-family: var(--font-sans, inherit);
    resize: vertical;
    box-sizing: border-box;
  }
  .diff-inline-textarea:focus { outline: none; border-color: var(--accent, #8c6dff); }
  .diff-inline-form-actions {
    display: flex; gap: 8px; margin-top: 8px;
  }
  .diff-inline-submit {
    background: var(--accent, #8c6dff);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  .diff-inline-cancel {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
  }

  /* Highlight.js theme overrides so colors layer correctly on tints */
  .diff-body.has-hljs .hljs-keyword { color: #ff7b72; }
  .diff-body.has-hljs .hljs-built_in,
  .diff-body.has-hljs .hljs-type { color: #ffa657; }
  .diff-body.has-hljs .hljs-literal,
  .diff-body.has-hljs .hljs-number { color: #79c0ff; }
  .diff-body.has-hljs .hljs-string { color: #a5d6ff; }
  .diff-body.has-hljs .hljs-title,
  .diff-body.has-hljs .hljs-title.function_ { color: #d2a8ff; }
  .diff-body.has-hljs .hljs-comment { color: #8b949e; font-style: italic; }
  .diff-body.has-hljs .hljs-attr,
  .diff-body.has-hljs .hljs-attribute,
  .diff-body.has-hljs .hljs-meta { color: #79c0ff; }
  .diff-body.has-hljs .hljs-tag,
  .diff-body.has-hljs .hljs-name { color: #7ee787; }
  .diff-body.has-hljs .hljs-variable,
  .diff-body.has-hljs .hljs-template-variable { color: #ffa657; }

  /* ─── Suggestion blocks ─── */
  .diff-suggestion-block {
    margin: 8px 0;
    border: 1px solid rgba(52,211,153,0.3);
    border-radius: 6px;
    overflow: hidden;
  }
  .diff-suggestion-header {
    padding: 6px 12px;
    background: rgba(52,211,153,0.08);
    border-bottom: 1px solid rgba(52,211,153,0.2);
    font-size: 12px;
    color: #6ee7b7;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .diff-suggestion-code {
    padding: 8px 12px;
    background: rgba(52,211,153,0.05);
    font-family: var(--font-mono);
    font-size: 12.5px;
    white-space: pre;
    color: var(--text);
    margin: 0;
  }
  .diff-apply-btn {
    background: rgba(52,211,153,0.15);
    color: #6ee7b7;
    border: 1px solid rgba(52,211,153,0.35);
    border-radius: 5px;
    padding: 4px 12px;
    font-size: 12px;
    cursor: pointer;
    font-family: var(--font-sans, inherit);
  }
  .diff-apply-btn:hover {
    background: rgba(52,211,153,0.25);
  }
  .diff-suggestion-toggle {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    font-family: var(--font-sans, inherit);
    margin-top: 6px;
  }
  .diff-suggestion-toggle.is-active {
    background: rgba(52,211,153,0.1);
    color: #6ee7b7;
    border-color: rgba(52,211,153,0.35);
  }
  .diff-suggestion-textarea {
    width: 100%;
    background: rgba(52,211,153,0.04);
    color: var(--text);
    border: 1px solid rgba(52,211,153,0.25);
    border-radius: 4px;
    padding: 8px;
    font-size: 12.5px;
    font-family: var(--font-mono);
    resize: vertical;
    box-sizing: border-box;
    margin-top: 6px;
    display: none;
  }
  .diff-suggestion-textarea.is-visible { display: block; }

  /* ─── Split-view scaffolding (phase 2 placeholder) ───
     The .diff-body element is grid-friendly; a future toggle can swap to
     'diff-body diff-split' and the per-row grid expands to two code panes. */
  .diff-body.diff-split .diff-row {
    grid-template-columns: 44px 1fr 44px 1fr;
  }

  @media (max-width: 720px) {
    .diff-row {
      grid-template-columns: 32px 32px 14px 1fr;
    }
    .diff-hunk-header { padding-left: 64px; }
    .diff-file-blob-link { display: none; }
  }

  /* ─── Jump-to-file nav ─── */
  .diff-jump-toggle {
    margin-left: auto;
    background: var(--bg-elevated);
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 12px;
    font-size: 12px;
    cursor: pointer;
    font-family: var(--font-sans, inherit);
    white-space: nowrap;
    transition: all 120ms ease;
  }
  .diff-jump-toggle:hover,
  .diff-jump-toggle.is-open {
    color: var(--text);
    border-color: rgba(140,109,255,0.45);
    background: var(--accent-gradient-faint, var(--bg-elevated));
  }

  .diff-jump-nav {
    position: relative;
    margin-bottom: 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    z-index: 20;
    max-height: 320px;
    overflow-y: auto;
    padding: 6px 0;
  }
  .diff-jump-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 14px;
    text-decoration: none;
    color: var(--text);
    font-size: 12.5px;
    font-family: var(--font-mono);
    transition: background 80ms ease;
  }
  .diff-jump-item:hover { background: var(--bg-secondary); }
  .diff-jump-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .diff-jump-pills { display: flex; gap: 4px; flex-shrink: 0; }
  .diff-jump-add { color: #6ee7b7; font-size: 11px; }
  .diff-jump-del { color: #fca5a5; font-size: 11px; }
`;
