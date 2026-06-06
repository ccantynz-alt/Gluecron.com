/**
 * Three-Claude parallel PR review — security / correctness / style.
 *
 * Where `ai-review.ts` runs a single Claude pass with a generalist
 * prompt, this module fans out three concurrent calls — each with a
 * narrow persona and a stricter remit. The three verdicts are inserted
 * as separate PR comments (one per reviewer) plus a top-level summary
 * comment that highlights disagreements.
 *
 * When the personas disagree on the same file/line (one says fail, one
 * says pass), that's a SIGNAL for a human reviewer — surfaced both in
 * the summary comment and as a yellow callout strip in `pulls.tsx`.
 *
 * Hard rules (mirrors `ai-review.ts`):
 *   - Never throws at the boundary. Anthropic, JSON parse, and DB
 *     failures all fail-closed: the reviewer in question lands a
 *     verdict of `fail` with an empty findings list so a human still
 *     sees the attempt.
 *   - All DB writes are best-effort with breadcrumb logging.
 *   - Uses the shared Anthropic client (`getAnthropic` from `ai-client`)
 *     and the shared `audit()` helper from `notify`.
 *
 * Wiring: `ai-review.ts`'s `triggerAiReview()` consults
 * `isTrioReviewEnabled()` (env `AI_TRIO_REVIEW_ENABLED=1`). When on,
 * it delegates the whole AI review to `runTrioReview()` instead of the
 * single-Claude path.
 */

import { eq, and, like } from "drizzle-orm";
import { db } from "../db";
import { pullRequests, prComments } from "../db/schema";
import { getAnthropic, MODEL_SONNET, parseJsonResponse } from "./ai-client";
import { audit } from "./notify";
import { recordAiCost, extractUsage } from "./ai-cost-tracker";
import { assertAiQuota, AiQuotaExceededError } from "./billing";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TrioPersona = "security" | "correctness" | "style";

export type Verdict = "pass" | "fail";

export interface TrioFinding {
  severity: "low" | "medium" | "high" | "critical" | string;
  file: string | null;
  line: number | null;
  issue: string;
  fix: string;
}

export interface TrioVerdict {
  persona: TrioPersona;
  verdict: Verdict;
  findings: TrioFinding[];
  /** Raw text from Claude — kept for the comment body + debugging. */
  rawText: string;
  /** Anthropic latency in ms, observational only. */
  latencyMs: number;
  /**
   * True when the call/parse failed and we synthesised a fail-closed
   * verdict. The summary comment marks these so humans aren't misled.
   */
  failed: boolean;
}

export interface TrioDisagreement {
  file: string;
  line: number | null;
  /** Personas that returned `fail` for this file/line. */
  failingPersonas: TrioPersona[];
  /** Personas that returned `pass` (i.e. had no finding here). */
  passingPersonas: TrioPersona[];
}

export interface TrioReviewResult {
  securityVerdict: TrioVerdict;
  correctnessVerdict: TrioVerdict;
  styleVerdict: TrioVerdict;
  disagreements: TrioDisagreement[];
}

export interface RunTrioReviewOpts {
  pullRequestId: string;
  /** Resolved SHA of the PR head — recorded in the audit metadata. */
  headSha: string;
  /** Unified diff text. Will be truncated to `DIFF_BYTE_CAP`. */
  diff: string;
  /** Optional repository id for audit attribution. */
  repositoryId?: string | null;
  /** Optional override of the model id (tests may want haiku). */
  model?: string;
}

// ---------------------------------------------------------------------------
// Marker constants
// ---------------------------------------------------------------------------

/**
 * Per-reviewer marker embedded in each persona's PR comment body.
 * Used by `pulls.tsx` to render the three cards as a single grid.
 */
export const TRIO_COMMENT_MARKER: Record<TrioPersona, string> = {
  security: "<!-- ai-trio:security -->",
  correctness: "<!-- ai-trio:correctness -->",
  style: "<!-- ai-trio:style -->",
};

/** Marker embedded in the trio summary comment. */
export const TRIO_SUMMARY_MARKER = "<!-- ai-trio:summary -->";

/** Cap on diff size we feed each reviewer — matches `ai-review.ts`. */
const DIFF_BYTE_CAP = 100_000;

/** Per-call max tokens. Findings are short JSON — 3k is plenty. */
const MAX_TOKENS = 3072;

// ---------------------------------------------------------------------------
// Persona prompts — kept terse so each Claude stays in lane.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_BASE = `You are a focused code reviewer on a pull request. Respond with ONLY valid JSON matching this exact shape:

{
  "verdict": "pass" | "fail",
  "findings": [
    {
      "severity": "low" | "medium" | "high" | "critical",
      "file": "path/to/file.ts",
      "line": 42,
      "issue": "short description of the problem",
      "fix": "concrete suggested fix"
    }
  ]
}

Rules:
- Return "verdict": "fail" if you found ANY finding worth flagging at your remit. Otherwise "pass" with an empty findings array.
- "line" is the line number in the NEW file (right side of the diff), or null when you can't pin it.
- Stay strictly inside your remit — do not flag issues that belong to another reviewer.
- No prose outside the JSON. No code fences.`;

const PERSONA_PROMPT: Record<TrioPersona, string> = {
  security: `You are the SECURITY reviewer. Be paranoid. Find security issues:
- SQL/NoSQL injection, command injection, path traversal
- XSS (reflected, stored, DOM-based) and HTML-escaping gaps
- Broken auth: missing session/token checks, IDOR, privilege escalation
- Secret leaks (API keys, tokens, passwords committed to source)
- Unsafe deserialization (eval, Function, untrusted JSON.parse into prototypes)
- Crypto misuse (weak hashes, missing HMAC verification, IV reuse)
- CSRF / SSRF / open redirects

Do NOT flag style, naming, or non-security bugs.

${SYSTEM_PROMPT_BASE}`,

  correctness: `You are the CORRECTNESS reviewer. Find logic bugs:
- Null/undefined dereference risks where input may not be guaranteed
- Race conditions, missing await, unhandled promise rejection
- Off-by-one errors in loops, slices, range checks
- Missing error handling at system boundaries (fs, network, DB)
- Wrong operator (== vs ===, & vs &&), inverted conditions
- Resource leaks (unclosed handles, missing cleanup on error)
- Type coercion bugs, NaN propagation, integer overflow

Do NOT flag style, naming, security, or readability.

${SYSTEM_PROMPT_BASE}`,

  style: `You are the STYLE reviewer. Find readability + maintainability issues:
- Inconsistent or unclear naming (vars, functions, types)
- Missing JSDoc / docstring on newly-added public APIs
- Functions over ~80 lines or cyclomatic complexity hotspots
- Magic numbers without named constants
- Duplicated code blocks that should be extracted
- Deeply nested conditionals that hurt readability

Do NOT flag security, correctness bugs, or trivial formatting (let the linter do that).

${SYSTEM_PROMPT_BASE}`,
};

// ---------------------------------------------------------------------------
// Test seam — let tests inject canned persona outputs instead of calling
// the real Anthropic API. Pass `null` to reset.
// ---------------------------------------------------------------------------

export type PersonaRunner = (args: {
  persona: TrioPersona;
  diff: string;
  model: string;
}) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

let _runnerOverride: PersonaRunner | null = null;

export function __setPersonaRunnerForTests(fn: PersonaRunner | null): void {
  _runnerOverride = fn;
}

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

/**
 * Whether the trio review path is on. Off by default; flip with
 * `AI_TRIO_REVIEW_ENABLED=1`. Independent from `ANTHROPIC_API_KEY` —
 * callers still need a key for the actual API calls, but tests can
 * toggle the flag without a real key via the runner override.
 */
export function isTrioReviewEnabled(): boolean {
  return process.env.AI_TRIO_REVIEW_ENABLED === "1";
}

/**
 * Has trio already run on this PR? Detected by a prior summary marker.
 */
export async function alreadyTrioReviewed(prId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: prComments.id })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, prId),
          eq(prComments.isAiReview, true),
          like(prComments.body, `%${TRIO_SUMMARY_MARKER}%`)
        )
      )
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run all three personas in parallel against the same diff, compute
 * disagreements, persist four prComments (3 verdicts + 1 summary), and
 * audit the outcome.
 *
 * Returns the structured trio result. Never throws.
 */
export async function runTrioReview(
  opts: RunTrioReviewOpts
): Promise<TrioReviewResult> {
  const model = opts.model || MODEL_SONNET;
  const diff =
    opts.diff.length > DIFF_BYTE_CAP
      ? opts.diff.slice(0, DIFF_BYTE_CAP)
      : opts.diff;

  // 0. Hard quota gate — bail before any API calls if the PR author is over
  //    budget. Resolve the author from the DB (needed for the comment insert
  //    in persistTrioComments anyway).
  let prAuthorId: string | null = null;
  try {
    const [pr] = await db
      .select({ authorId: pullRequests.authorId })
      .from(pullRequests)
      .where(eq(pullRequests.id, opts.pullRequestId))
      .limit(1);
    if (pr) prAuthorId = pr.authorId;
  } catch {
    /* tolerate — quota check will fail open */
  }
  if (prAuthorId) {
    try {
      await assertAiQuota(prAuthorId);
    } catch (err) {
      if (err instanceof AiQuotaExceededError) {
        // Post a single summary comment so the PR author sees the skip reason.
        try {
          await db.insert(prComments).values({
            pullRequestId: opts.pullRequestId,
            authorId: prAuthorId,
            isAiReview: true,
            body: [
              TRIO_SUMMARY_MARKER,
              "## AI Trio Review skipped",
              "",
              "Your monthly AI token budget has been reached. Upgrade at [/settings/billing](/settings/billing) to re-enable AI code review.",
            ].join("\n"),
          });
        } catch {
          /* best-effort */
        }
        // Return a neutral fail-closed result so the caller doesn't crash.
        const skippedVerdict = (persona: TrioPersona): TrioVerdict => ({
          persona,
          verdict: "fail",
          findings: [],
          rawText: "",
          latencyMs: 0,
          failed: true,
        });
        return {
          securityVerdict: skippedVerdict("security"),
          correctnessVerdict: skippedVerdict("correctness"),
          styleVerdict: skippedVerdict("style"),
          disagreements: [],
        };
      }
      // Unexpected error — log and proceed (fail open).
      console.warn("[ai-review-trio] assertAiQuota failed unexpectedly:", err);
    }
  }

  // 1. Fan out the three persona calls.
  const personas: TrioPersona[] = ["security", "correctness", "style"];
  const [securityVerdict, correctnessVerdict, styleVerdict] = await Promise.all(
    personas.map((p) => runOnePersona({ persona: p, diff, model }))
  );

  // 2. Compute disagreements.
  const disagreements = computeDisagreements({
    securityVerdict,
    correctnessVerdict,
    styleVerdict,
  });

  const result: TrioReviewResult = {
    securityVerdict,
    correctnessVerdict,
    styleVerdict,
    disagreements,
  };

  // 3. Persist comments (best-effort).
  await persistTrioComments({
    pullRequestId: opts.pullRequestId,
    result,
  });

  // 4. Audit.
  try {
    await audit({
      action: "ai.review.trio",
      targetType: "pull_request",
      targetId: opts.pullRequestId,
      repositoryId: opts.repositoryId ?? null,
      metadata: {
        headSha: opts.headSha,
        security: securityVerdict.verdict,
        correctness: correctnessVerdict.verdict,
        style: styleVerdict.verdict,
        disagreements: disagreements.length,
        failed: [
          securityVerdict.failed ? "security" : null,
          correctnessVerdict.failed ? "correctness" : null,
          styleVerdict.failed ? "style" : null,
        ].filter(Boolean),
      },
    });
  } catch {
    /* audit is observational only */
  }

  return result;
}

// ---------------------------------------------------------------------------
// One persona — single Anthropic call + fail-closed JSON parse.
// ---------------------------------------------------------------------------

async function runOnePersona(args: {
  persona: TrioPersona;
  diff: string;
  model: string;
}): Promise<TrioVerdict> {
  const t0 = Date.now();
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let failed = false;

  try {
    if (_runnerOverride) {
      const out = await _runnerOverride({
        persona: args.persona,
        diff: args.diff,
        model: args.model,
      });
      text = out.text || "";
      inputTokens = out.inputTokens || 0;
      outputTokens = out.outputTokens || 0;
    } else {
      const client = getAnthropic();
      const message = await client.messages.create({
        model: args.model,
        max_tokens: MAX_TOKENS,
        system: PERSONA_PROMPT[args.persona],
        messages: [
          {
            role: "user",
            content: `Review this diff at your remit (${args.persona}). Return JSON only.\n\n\`\`\`diff\n${args.diff}\n\`\`\``,
          },
        ],
      });
      text =
        message.content[0]?.type === "text" ? message.content[0].text : "";
      const usage = extractUsage(message);
      inputTokens = usage.input;
      outputTokens = usage.output;
    }
  } catch (err) {
    failed = true;
    text = `__error__:${err instanceof Error ? err.message : String(err)}`;
  }

  // Best-effort cost capture (skipped when call failed and we have no usage).
  if (!failed && (inputTokens || outputTokens)) {
    try {
      await recordAiCost({
        model: args.model,
        inputTokens,
        outputTokens,
        category: "ai_review",
        sourceKind: "pull_request",
      });
    } catch {
      /* observational */
    }
  }

  const parsed = parseJsonResponse<{
    verdict?: unknown;
    findings?: unknown;
  }>(text);

  let verdict: Verdict = "fail"; // fail-closed default
  let findings: TrioFinding[] = [];

  if (parsed && typeof parsed === "object") {
    if (parsed.verdict === "pass") verdict = "pass";
    else if (parsed.verdict === "fail") verdict = "fail";
    if (Array.isArray(parsed.findings)) {
      findings = parsed.findings
        .map((f) => normaliseFinding(f))
        .filter((f): f is TrioFinding => !!f);
    }
  } else if (!failed) {
    // Call succeeded but JSON parse failed → fail-closed.
    failed = true;
  }

  return {
    persona: args.persona,
    verdict,
    findings,
    rawText: text,
    latencyMs: Date.now() - t0,
    failed,
  };
}

function normaliseFinding(raw: unknown): TrioFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const issue =
    typeof r.issue === "string"
      ? r.issue
      : typeof r.description === "string"
        ? r.description
        : "";
  if (!issue) return null;
  return {
    severity:
      typeof r.severity === "string" && r.severity.length > 0
        ? r.severity
        : "medium",
    file: typeof r.file === "string" && r.file.length > 0 ? r.file : null,
    line:
      typeof r.line === "number" && Number.isInteger(r.line) && r.line > 0
        ? r.line
        : null,
    issue,
    fix: typeof r.fix === "string" ? r.fix : "",
  };
}

// ---------------------------------------------------------------------------
// Disagreement detection — file/line pairs where one persona flags `fail`
// and another would have said `pass` (i.e. no finding at that location).
// ---------------------------------------------------------------------------

export function computeDisagreements(args: {
  securityVerdict: TrioVerdict;
  correctnessVerdict: TrioVerdict;
  styleVerdict: TrioVerdict;
}): TrioDisagreement[] {
  const verdicts: TrioVerdict[] = [
    args.securityVerdict,
    args.correctnessVerdict,
    args.styleVerdict,
  ];

  // Group findings by file (+ optional line) and record which personas
  // hit each location.
  const byKey = new Map<
    string,
    {
      file: string;
      line: number | null;
      failingPersonas: Set<TrioPersona>;
    }
  >();

  for (const v of verdicts) {
    for (const f of v.findings) {
      const file = f.file;
      if (!file) continue; // can't disagree about an unattributable finding
      const key = `${file}::${f.line ?? ""}`;
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = { file, line: f.line, failingPersonas: new Set() };
        byKey.set(key, bucket);
      }
      bucket.failingPersonas.add(v.persona);
    }
  }

  const allPersonas: TrioPersona[] = ["security", "correctness", "style"];
  const disagreements: TrioDisagreement[] = [];

  for (const bucket of byKey.values()) {
    // Disagreement = at least one persona flagged AND at least one
    // persona did not. (All three flagging the same location is
    // unanimous agreement, not a disagreement.)
    if (
      bucket.failingPersonas.size === 0 ||
      bucket.failingPersonas.size === allPersonas.length
    ) {
      continue;
    }
    disagreements.push({
      file: bucket.file,
      line: bucket.line,
      failingPersonas: Array.from(bucket.failingPersonas).sort() as TrioPersona[],
      passingPersonas: allPersonas.filter(
        (p) => !bucket.failingPersonas.has(p)
      ),
    });
  }

  // Stable sort: file then line then severity.
  disagreements.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  return disagreements;
}

// ---------------------------------------------------------------------------
// Comment persistence — 3 per-reviewer + 1 summary.
// ---------------------------------------------------------------------------

async function persistTrioComments(args: {
  pullRequestId: string;
  result: TrioReviewResult;
}): Promise<void> {
  // Need the PR's author id to satisfy `prComments.authorId NOT NULL`.
  // (`ai-review.ts` uses the same pattern.)
  let authorId: string | null = null;
  try {
    const [pr] = await db
      .select({ authorId: pullRequests.authorId })
      .from(pullRequests)
      .where(eq(pullRequests.id, args.pullRequestId))
      .limit(1);
    if (pr) authorId = pr.authorId;
  } catch {
    /* tolerate */
  }
  if (!authorId) return; // can't post comments without an author id

  const verdicts: TrioVerdict[] = [
    args.result.securityVerdict,
    args.result.correctnessVerdict,
    args.result.styleVerdict,
  ];

  for (const v of verdicts) {
    const body = renderPersonaCommentBody(v);
    try {
      await db.insert(prComments).values({
        pullRequestId: args.pullRequestId,
        authorId,
        isAiReview: true,
        body,
      });
    } catch (err) {
      console.error(
        `[ai-review-trio] persona ${v.persona} comment insert failed for PR ${args.pullRequestId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Top-level summary.
  try {
    await db.insert(prComments).values({
      pullRequestId: args.pullRequestId,
      authorId,
      isAiReview: true,
      body: renderSummaryCommentBody(args.result),
    });
  } catch (err) {
    console.error(
      `[ai-review-trio] summary insert failed for PR ${args.pullRequestId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ---------------------------------------------------------------------------
// Comment body rendering — markdown that's also re-parseable.
// ---------------------------------------------------------------------------

function renderPersonaCommentBody(v: TrioVerdict): string {
  const marker = TRIO_COMMENT_MARKER[v.persona];
  const heading = `${marker}\n## AI ${v.persona[0].toUpperCase() + v.persona.slice(1)} Review — ${v.verdict === "pass" ? "Pass" : "Fail"}`;
  if (v.failed) {
    return `${heading}\n\n_AI review call failed; treating as fail-closed. A human reviewer should look at this PR._`;
  }
  if (v.findings.length === 0) {
    return `${heading}\n\nNo ${v.persona} issues detected.`;
  }
  const lines = v.findings.map((f) => {
    const loc = f.file
      ? `\`${f.file}${f.line ? `:${f.line}` : ""}\``
      : "_(unattributed)_";
    return `- **${f.severity}** ${loc} — ${f.issue}${f.fix ? ` _Fix: ${f.fix}_` : ""}`;
  });
  return `${heading}\n\n${lines.join("\n")}`;
}

function renderSummaryCommentBody(r: TrioReviewResult): string {
  const verdictLine = (v: TrioVerdict): string =>
    `- **${v.persona}**: ${v.verdict === "pass" ? "✓ pass" : "✗ fail"}${v.failed ? " _(call failed)_" : ""} — ${v.findings.length} finding(s)`;

  const disagreementLines =
    r.disagreements.length === 0
      ? "_All three reviewers agree on every flagged location._"
      : r.disagreements
          .map((d) => {
            const loc = `\`${d.file}${d.line ? `:${d.line}` : ""}\``;
            return `- ${loc} — ${d.failingPersonas.join(", ")} say ✗, ${d.passingPersonas.join(", ")} say ✓`;
          })
          .join("\n");

  return [
    TRIO_SUMMARY_MARKER,
    "## AI Trio Review",
    "",
    "Three independent reviewers ran in parallel — security, correctness, style.",
    "",
    "### Verdicts",
    verdictLine(r.securityVerdict),
    verdictLine(r.correctnessVerdict),
    verdictLine(r.styleVerdict),
    "",
    "### Disagreements",
    disagreementLines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Test-only exports.
// ---------------------------------------------------------------------------

export const __test = {
  PERSONA_PROMPT,
  normaliseFinding,
  renderPersonaCommentBody,
  renderSummaryCommentBody,
  DIFF_BYTE_CAP,
};
