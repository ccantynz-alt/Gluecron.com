/**
 * AI-generated commit messages.
 *
 * Powers the `gluecron commit` CLI and the `POST /api/v2/ai/commit-message`
 * endpoint. Given a unified diff (typically `git diff --cached`), returns a
 * { subject, body } pair.
 *
 *   - Conventional Commits style by default: `feat(scope): subject` etc.
 *   - The body explains WHY (not what — the diff already says what).
 *   - Falls back to a deterministic heuristic when ANTHROPIC_API_KEY is
 *     missing, the model errors out, or the diff is empty. The CLI must
 *     never block a developer on a Claude outage.
 *   - Diff is capped at ~50KB before being sent to the model — past that
 *     the signal-to-noise ratio drops and we'd just be burning tokens.
 *
 * Tests live in src/__tests__/ai-commit-message.test.ts. The module
 * exports a `__test` bag for the parser + truncation helpers so the
 * unit tests don't have to call the network path.
 */

import {
  getAnthropic,
  MODEL_HAIKU,
  extractText,
  parseJsonResponse,
  isAiAvailable,
} from "./ai-client";

export type CommitStyle = "conventional" | "plain";

export interface CommitMessage {
  subject: string;
  body: string;
}

export interface GenerateOptions {
  style?: CommitStyle;
}

/** Max bytes of diff we send to the model. Past this we truncate. */
export const DIFF_BYTE_CAP = 50_000;
const TRUNCATE_MARKER = "\n... (more)";

/** Conventional-commits types we accept in the subject. */
const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

/**
 * Truncate a diff to DIFF_BYTE_CAP bytes, appending a marker so the model
 * (and any human reader) knows the input was cut.
 */
export function truncateDiff(diff: string, cap = DIFF_BYTE_CAP): string {
  if (diff.length <= cap) return diff;
  return diff.slice(0, cap - TRUNCATE_MARKER.length) + TRUNCATE_MARKER;
}

/**
 * Deterministic fallback: scan filenames + counts and emit a plausible
 * conventional-commit. Never blocks on a network call, never throws.
 *
 * Heuristics:
 *   - "test" files → test
 *   - "doc"/"readme"/".md" only → docs
 *   - new files dominate → feat
 *   - otherwise → chore
 *
 * Subject ≤ 72 chars; body lists the top-3 touched paths so the human
 * still has signal even when Claude is unavailable.
 */
export function heuristicMessage(
  diff: string,
  style: CommitStyle = "conventional"
): CommitMessage {
  const trimmed = diff.trim();
  if (!trimmed) {
    return {
      subject: style === "conventional" ? "chore: update" : "Update",
      body: "",
    };
  }

  // Pull file paths out of standard unified-diff headers.
  // We look at `+++ b/<path>` to favour the *new* side of renames.
  const paths: string[] = [];
  let added = 0;
  let removed = 0;
  let newFiles = 0;
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const p = line.slice("+++ b/".length).trim();
      if (p && p !== "/dev/null") paths.push(p);
    } else if (line.startsWith("new file mode")) {
      newFiles++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }

  const onlyDocs =
    paths.length > 0 &&
    paths.every((p) => /\.(md|mdx|rst|txt)$/i.test(p) || /readme/i.test(p));
  const onlyTests =
    paths.length > 0 && paths.every((p) => /(^|\/)(__tests__|tests?)\//.test(p) || /\.test\.[tj]sx?$/.test(p));
  const allNew = newFiles > 0 && newFiles === paths.length;

  let type: ConventionalType = "chore";
  if (onlyDocs) type = "docs";
  else if (onlyTests) type = "test";
  else if (allNew) type = "feat";
  else if (removed > added * 2) type = "refactor";
  else type = "chore";

  // Scope = top-level directory if all paths share one.
  const tops = new Set(paths.map((p) => p.split("/")[0]).filter(Boolean));
  const scope = tops.size === 1 ? [...tops][0] : "";

  const fileWord = paths.length === 1 ? "file" : "files";
  const subjectRaw =
    paths.length === 0
      ? "update files"
      : `update ${paths.length} ${fileWord}`;

  const subject =
    style === "conventional"
      ? `${type}${scope ? `(${scope})` : ""}: ${subjectRaw}`
      : subjectRaw.charAt(0).toUpperCase() + subjectRaw.slice(1);

  const cappedSubject =
    subject.length > 72 ? subject.slice(0, 69) + "..." : subject;

  const topPaths = paths.slice(0, 3);
  const body =
    paths.length === 0
      ? ""
      : `Touched files:\n${topPaths.map((p) => `- ${p}`).join("\n")}` +
        (paths.length > topPaths.length
          ? `\n- ...and ${paths.length - topPaths.length} more`
          : "");

  return { subject: cappedSubject, body };
}

/**
 * Coerce arbitrary model output into a clean { subject, body } shape.
 *
 * Accepts (in order):
 *   1. A JSON object with `subject` / `body` fields.
 *   2. A code-fenced block whose first line looks like a commit subject.
 *   3. Raw text — first line as subject, the rest as body.
 *
 * Always strips backticks, trims, and caps the subject at 72 chars.
 * Exported for unit tests.
 */
export function parseModelOutput(
  text: string,
  style: CommitStyle = "conventional"
): CommitMessage {
  const cleaned = text.replace(/^```[a-zA-Z]*\n|\n```$/g, "").trim();

  // Try JSON first.
  const parsed = parseJsonResponse<{ subject?: string; body?: string }>(
    cleaned
  );
  let subject = "";
  let body = "";
  if (parsed && typeof parsed.subject === "string") {
    subject = parsed.subject.trim();
    body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  } else {
    // Fall back to "first line = subject, rest = body" parsing.
    const lines = cleaned.split("\n");
    subject = (lines[0] || "").trim();
    body = lines.slice(1).join("\n").trim();
    // Drop a single blank line between subject + body if present.
    if (body.startsWith("\n")) body = body.slice(1);
  }

  // Strip surrounding quotes / backticks the model sometimes adds.
  subject = subject.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (subject.length > 72) {
    subject = subject.slice(0, 69) + "...";
  }
  if (!subject) {
    return { subject: style === "conventional" ? "chore: update" : "Update", body: "" };
  }

  // If conventional style was requested but the model returned a bare
  // sentence, lightly normalise it. We do NOT try to re-classify — that
  // would be guessing — but we do prefix `chore:` so commitlint stays happy.
  if (style === "conventional" && !/^[a-z]+(\([^)]+\))?(!?):/.test(subject)) {
    subject = `chore: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`;
    if (subject.length > 72) subject = subject.slice(0, 69) + "...";
  }

  return { subject, body };
}

/**
 * Build the prompt sent to Claude. Pulled out so the test suite can
 * sanity-check it without spinning up the API client.
 */
export function buildPrompt(diff: string, style: CommitStyle): string {
  const styleInstruction =
    style === "conventional"
      ? `Use Conventional Commits style — the subject MUST start with one of: ${CONVENTIONAL_TYPES.join(", ")}, optionally followed by (scope), then ": ", then a lowercase imperative summary. Example: "feat(auth): add passkey login".`
      : `Write a plain-English subject in imperative mood (e.g. "Add passkey login"). No type prefix.`;

  return `You are writing a git commit message for the following staged diff.

${styleInstruction}

Rules:
- Subject MUST be 72 characters or fewer.
- Subject is one line. No trailing period.
- Body explains WHY the change was made when it is non-obvious. Skip the body for trivial changes.
- Body lines wrap at ~72 chars. Use blank lines between paragraphs.
- Do NOT describe what every file does — the diff already shows that. Focus on intent.
- Do NOT include code fences, markdown, or extra commentary.

Respond ONLY with JSON in this exact shape:
{"subject": "...", "body": "..."}

If the change is trivial enough that no body is needed, return body as "".

Diff:
\`\`\`diff
${diff}
\`\`\``;
}

/**
 * Generate a commit message for the given diff.
 *
 * Never throws — on any error (no API key, model timeout, parse failure)
 * we fall back to the deterministic heuristic so the caller can always
 * present a draft to the developer.
 */
export async function generateCommitMessage(
  diff: string,
  opts: GenerateOptions = {}
): Promise<CommitMessage> {
  const style: CommitStyle = opts.style === "plain" ? "plain" : "conventional";
  const trimmed = diff.trim();

  if (!trimmed) {
    return {
      subject: style === "conventional" ? "chore: empty commit" : "Empty commit",
      body: "",
    };
  }

  if (!isAiAvailable()) {
    return heuristicMessage(trimmed, style);
  }

  const truncated = truncateDiff(trimmed);

  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: buildPrompt(truncated, style),
        },
      ],
    });
    try {
      const { recordAiCost, extractUsage } = await import("./ai-cost-tracker");
      const usage = extractUsage(message);
      await recordAiCost({
        model: MODEL_SONNET,
        inputTokens: usage.input,
        outputTokens: usage.output,
        category: "other",
        sourceKind: "commit_message",
      });
    } catch {
      /* swallow — best-effort */
    }
    const text = extractText(message);
    if (!text.trim()) {
      return heuristicMessage(trimmed, style);
    }
    return parseModelOutput(text, style);
  } catch {
    // Network/API failure → never block the developer; degrade.
    return heuristicMessage(trimmed, style);
  }
}

/** Test-only exports — not part of the public API. */
export const __test = {
  truncateDiff,
  heuristicMessage,
  parseModelOutput,
  buildPrompt,
  CONVENTIONAL_TYPES,
};
