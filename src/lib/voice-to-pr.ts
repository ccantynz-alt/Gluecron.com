/**
 * Voice-to-PR — phone-first dictation pipeline.
 *
 * The `/voice` route captures a browser Web Speech API transcript and posts
 * it here. This module turns that transcript into one of three outcomes:
 *
 *   1. `interpretVoiceTranscript` — sends the transcript to Claude with a
 *      tight classification prompt. Returns a discriminated union telling
 *      the route whether to treat the utterance as a *spec*, an *issue*,
 *      or "unclear" (ambiguous → user picks). The model also returns a
 *      polished title + body markdown so the eventual spec/issue isn't
 *      just raw dictation noise.
 *
 *   2. `shipAsSpec` — writes a `.gluecron/specs/voice-<slug>.md` file to
 *      the repo's default branch with `status: ready`. The autopilot loop
 *      (`autopilot-spec-to-pr.ts`) picks it up on the next tick and runs
 *      the full spec-to-PR pipeline against it. This is intentionally a
 *      thin wrapper around `createOrUpdateFileOnBranch` + the spec
 *      front-matter format — it reuses the existing flow rather than
 *      duplicating any of `runSpecToPr`.
 *
 *   3. `createIssueFromVoice` — inserts a row directly into the `issues`
 *      table mirroring `src/routes/issues.tsx`. Kept here so the route
 *      handler stays tiny and so the unit tests can exercise the flow
 *      without going through the HTTP layer.
 *
 * Hard contract:
 *   - No function throws. Every failure path returns
 *     `{ok:false, error:string}`.
 *   - When `ANTHROPIC_API_KEY` is missing, `interpretVoiceTranscript`
 *     returns a deterministic best-effort fallback so the demo still
 *     works on machines without an API key.
 *   - The shared layout / locked files are never touched here.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { issues, repositories, users } from "../db/schema";
import { createOrUpdateFileOnBranch } from "../git/repository";
import { config } from "./config";
import { serialiseSpec } from "./spec-to-pr";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VoiceIntent = "spec" | "issue" | "unclear";

export interface VoiceInterpretation {
  kind: VoiceIntent;
  title: string;
  body_markdown: string;
  /** Optional hint surfaced by the model (e.g. "the dashboard repo"). */
  target_repo_id_hint?: string;
}

export interface InterpretArgs {
  transcript: string;
  /** Optional list of the user's repos so the model can suggest one. */
  knownRepos?: Array<{ id: string; fullName: string }>;
  /** Test-only injection. */
  client?: { call: (prompt: string) => Promise<string> };
}

export type InterpretResult =
  | { ok: true; suggestion: VoiceInterpretation }
  | { ok: false; error: string };

export interface ShipSpecArgs {
  repositoryId: string;
  transcript: string;
  userId: string;
  /** Override the deterministic slug — only used in tests. */
  slugOverride?: string;
  /** Pre-computed interpretation; lets the route reuse a single Claude call. */
  interpretation?: VoiceInterpretation;
}

export type ShipSpecResult =
  | {
      ok: true;
      specPath: string;
      commitSha: string;
      branch: string;
    }
  | { ok: false; error: string };

export interface CreateIssueArgs {
  repositoryId: string;
  transcript: string;
  userId: string;
  interpretation?: VoiceInterpretation;
}

export type CreateIssueResult =
  | {
      ok: true;
      issueNumber: number;
      ownerName: string;
      repoName: string;
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable, URL-safe slug for the voice spec filename. Capped at 40
 * chars so the resulting path stays short.
 */
export function voiceSlug(text: string): string {
  const base = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "voice-note";
}

/** Heuristic fallback used when the Claude API key is missing. */
function classifyHeuristically(transcript: string): VoiceInterpretation {
  const t = transcript.trim();
  const lower = t.toLowerCase();
  const looksLikeBug =
    /(bug|broken|crash|error|doesn'?t work|not working|regression|fails?)/i.test(
      lower
    );
  const looksLikeFeature =
    /(add|build|implement|create|wire up|ship|introduce|support)/i.test(lower);
  const kind: VoiceIntent = looksLikeBug
    ? "issue"
    : looksLikeFeature
      ? "spec"
      : "unclear";
  // First clause becomes the title; cap at 80 chars.
  const firstClause =
    t.split(/[.!?\n]/)[0]?.trim() || t.slice(0, 80) || "Voice note";
  const title = firstClause.length > 80 ? `${firstClause.slice(0, 77)}...` : firstClause;
  return {
    kind,
    title: title.replace(/^[a-z]/, (c) => c.toUpperCase()),
    body_markdown: t,
  };
}

/**
 * Sanitise the model's response into a `VoiceInterpretation`. Anything that
 * doesn't conform falls back to "unclear" so the UI shows the picker.
 */
export function normaliseInterpretation(
  raw: unknown,
  fallbackBody: string
): VoiceInterpretation {
  if (!raw || typeof raw !== "object") {
    return classifyHeuristically(fallbackBody);
  }
  const r = raw as Record<string, unknown>;
  const kindRaw = typeof r.kind === "string" ? r.kind.toLowerCase() : "";
  const kind: VoiceIntent =
    kindRaw === "spec" || kindRaw === "issue" || kindRaw === "unclear"
      ? (kindRaw as VoiceIntent)
      : "unclear";
  const title =
    typeof r.title === "string" && r.title.trim()
      ? r.title.trim().slice(0, 120)
      : classifyHeuristically(fallbackBody).title;
  const body =
    typeof r.body_markdown === "string" && r.body_markdown.trim()
      ? r.body_markdown.trim()
      : fallbackBody.trim();
  const hint =
    typeof r.target_repo_id_hint === "string" && r.target_repo_id_hint.trim()
      ? r.target_repo_id_hint.trim().slice(0, 200)
      : undefined;
  return { kind, title, body_markdown: body, target_repo_id_hint: hint };
}

/**
 * Build the prompt sent to Claude. Kept in its own function so the test
 * harness can assert on its contents if needed.
 */
export function buildInterpretPrompt(
  transcript: string,
  knownRepos: Array<{ id: string; fullName: string }>
): string {
  const repoBlock =
    knownRepos.length > 0
      ? `\n\nThe user's available repositories (id — name):\n${knownRepos
          .slice(0, 25)
          .map((r) => `- ${r.id} — ${r.fullName}`)
          .join("\n")}`
      : "";
  return `You are classifying a phone-dictated note from a developer. They have just spoken into the Gluecron "voice-to-PR" feature and we need to decide what to do with their utterance.

The transcript:
"""
${transcript.trim().slice(0, 4000)}
"""${repoBlock}

Decide which of the following best fits:
  - "spec"   : the user is describing a feature or change they want built. The autopilot will turn this into a draft PR via spec-to-PR.
  - "issue"  : the user is reporting a bug, a question, or an observation that should be filed for discussion, not implemented immediately.
  - "unclear": you can't confidently decide — let the user pick.

Polish the transcript into:
  - A short imperative "title" (under 80 chars).
  - A "body_markdown" expanding the request as a proper feature spec or bug report. Keep it faithful to what was said; do NOT invent acceptance criteria the user didn't mention. Format with short paragraphs or bullet lists where helpful.

Respond ONLY with JSON in this exact shape:
{
  "kind": "spec" | "issue" | "unclear",
  "title": "...",
  "body_markdown": "...",
  "target_repo_id_hint": "<repo-id from the list above, or omit>"
}`;
}

// ---------------------------------------------------------------------------
// interpretVoiceTranscript
// ---------------------------------------------------------------------------

/**
 * Classify and polish a voice transcript. Never throws.
 *
 * Test injection: pass `client.call(prompt)` to swap out the real Claude
 * call with a stub returning a JSON string.
 */
export async function interpretVoiceTranscript(
  args: InterpretArgs
): Promise<InterpretResult> {
  const transcript =
    typeof args.transcript === "string" ? args.transcript.trim() : "";
  if (!transcript) return { ok: false, error: "transcript is empty" };

  // Graceful degrade — no key, no model, but still a usable response.
  if (!args.client && !config.anthropicApiKey) {
    return { ok: true, suggestion: classifyHeuristically(transcript) };
  }

  const prompt = buildInterpretPrompt(transcript, args.knownRepos || []);

  // Test injection path.
  if (args.client) {
    try {
      const text = await args.client.call(prompt);
      const parsed = safeParseJson(text);
      return {
        ok: true,
        suggestion: normaliseInterpretation(parsed, transcript),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "client.call threw",
      };
    }
  }

  // Real Claude call. Dynamic import keeps the SDK out of the test bundle
  // and means a missing dep never crashes the route.
  try {
    const { getAnthropic, MODEL_SONNET, extractText } = await import(
      "./ai-client"
    );
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    try {
      const { recordAiCost, extractUsage } = await import(
        "./ai-cost-tracker"
      );
      const usage = extractUsage(msg);
      await recordAiCost({
        model: MODEL_SONNET,
        inputTokens: usage.input,
        outputTokens: usage.output,
        category: "voice",
        sourceKind: "voice_transcript",
      });
    } catch {
      /* swallow — best-effort */
    }
    const text = extractText(msg);
    const parsed = safeParseJson(text);
    return {
      ok: true,
      suggestion: normaliseInterpretation(parsed, transcript),
    };
  } catch (err) {
    // Fall back to the heuristic so the demo doesn't dead-end on a 429.
    const fallback = classifyHeuristically(transcript);
    if (process.env.DEBUG_VOICE === "1") {
      console.warn(
        "[voice] Claude call failed, using heuristic:",
        err instanceof Error ? err.message : err
      );
    }
    return { ok: true, suggestion: fallback };
  }
}

function safeParseJson(text: string): unknown {
  if (!text) return null;
  // Try a fenced block first.
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fenced ? fenced[1] : null;
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
  }
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) {
    try {
      return JSON.parse(braced[0]);
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// shipAsSpec
// ---------------------------------------------------------------------------

/**
 * Resolve repo + owner + author rows for a given repository / user combo.
 * Returns null on any miss so callers can return a clean error.
 */
async function resolveRepoAndAuthor(
  repositoryId: string,
  userId: string
): Promise<
  | {
      ownerName: string;
      repoName: string;
      defaultBranch: string;
      authorName: string;
      authorEmail: string;
    }
  | null
> {
  try {
    const [row] = await db
      .select({
        repoName: repositories.name,
        defaultBranch: repositories.defaultBranch,
        ownerName: users.username,
      })
      .from(repositories)
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!row || !row.ownerName) return null;

    const [authorRow] = await db
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!authorRow) return null;

    return {
      ownerName: row.ownerName,
      repoName: row.repoName,
      defaultBranch: row.defaultBranch || "main",
      authorName: authorRow.username,
      authorEmail:
        authorRow.email || `${authorRow.username}@users.noreply.gluecron`,
    };
  } catch {
    return null;
  }
}

/**
 * Commit a `.gluecron/specs/voice-<slug>.md` spec to the repo's default
 * branch with `status: ready`. The autopilot picks it up on the next tick.
 */
export async function shipAsSpec(
  args: ShipSpecArgs
): Promise<ShipSpecResult> {
  const transcript =
    typeof args.transcript === "string" ? args.transcript.trim() : "";
  if (!transcript) return { ok: false, error: "transcript is empty" };
  if (!args.repositoryId) return { ok: false, error: "repository_id required" };
  if (!args.userId) return { ok: false, error: "userId required" };

  const resolved = await resolveRepoAndAuthor(args.repositoryId, args.userId);
  if (!resolved) return { ok: false, error: "repo or user not found" };

  // Use the supplied interpretation when present, otherwise fall back to
  // the heuristic so we always have a polished title.
  const interp =
    args.interpretation || classifyHeuristically(transcript);
  const slug =
    args.slugOverride && args.slugOverride.trim()
      ? voiceSlug(args.slugOverride)
      : voiceSlug(interp.title || transcript);
  // Stamp the filename with a short timestamp so back-to-back voice notes
  // with the same slug don't collide on the autopilot dedup.
  const specPath = `.gluecron/specs/voice-${slug}-${Date.now().toString(36)}.md`;

  const fm: Record<string, string> = {
    title: interp.title || "Voice spec",
    status: "ready",
    source: "voice-to-pr",
  };
  const body = `# ${interp.title || "Voice spec"}\n\n${interp.body_markdown || transcript}\n\n---\n\n_Captured via Gluecron voice-to-PR._\n`;
  const content = serialiseSpec(fm, body);
  const bytes = new TextEncoder().encode(content);

  const res = await createOrUpdateFileOnBranch({
    owner: resolved.ownerName,
    name: resolved.repoName,
    branch: resolved.defaultBranch,
    filePath: specPath,
    bytes,
    message: `voice: ${interp.title || "captured spec"}`,
    authorName: resolved.authorName,
    authorEmail: resolved.authorEmail,
  });
  if ("error" in res) {
    return { ok: false, error: `git write failed: ${res.error}` };
  }
  return {
    ok: true,
    specPath,
    commitSha: res.commitSha,
    branch: resolved.defaultBranch,
  };
}

// ---------------------------------------------------------------------------
// createIssueFromVoice
// ---------------------------------------------------------------------------

/**
 * Insert an issue row mirroring `src/routes/issues.tsx`. The route handler
 * wires up the AI triage trigger separately so this function stays
 * dependency-light + easy to test.
 */
export async function createIssueFromVoice(
  args: CreateIssueArgs
): Promise<CreateIssueResult> {
  const transcript =
    typeof args.transcript === "string" ? args.transcript.trim() : "";
  if (!transcript) return { ok: false, error: "transcript is empty" };
  if (!args.repositoryId) return { ok: false, error: "repository_id required" };
  if (!args.userId) return { ok: false, error: "userId required" };

  let repoRow:
    | {
        id: string;
        name: string;
        issueCount: number;
        ownerName: string | null;
      }
    | undefined;
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        issueCount: repositories.issueCount,
        ownerName: users.username,
      })
      .from(repositories)
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.id, args.repositoryId))
      .limit(1);
    repoRow = row;
  } catch {
    return { ok: false, error: "db lookup failed" };
  }
  if (!repoRow || !repoRow.ownerName) {
    return { ok: false, error: "repo not found" };
  }

  const interp = args.interpretation || classifyHeuristically(transcript);
  const title = (interp.title || transcript.slice(0, 80)).slice(0, 200);
  const body = `${interp.body_markdown || transcript}\n\n---\n\n_Captured via Gluecron voice-to-PR._`;

  try {
    const [issue] = await db
      .insert(issues)
      .values({
        repositoryId: repoRow.id,
        authorId: args.userId,
        title,
        body,
      })
      .returning();
    if (!issue) return { ok: false, error: "issue insert returned no row" };
    // Best-effort counter update; mirrors src/routes/issues.tsx.
    try {
      await db
        .update(repositories)
        .set({ issueCount: (repoRow.issueCount || 0) + 1 })
        .where(eq(repositories.id, repoRow.id));
    } catch {
      /* non-fatal */
    }
    return {
      ok: true,
      issueNumber: issue.number,
      ownerName: repoRow.ownerName,
      repoName: repoRow.name,
    };
  } catch (err) {
    return {
      ok: false,
      error: `issue insert failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __voiceTest = {
  classifyHeuristically,
  safeParseJson,
  resolveRepoAndAuthor,
};

/** True if access to the user's repo list should fan out (used by the route). */
export async function listUserRepos(
  userId: string
): Promise<Array<{ id: string; fullName: string }>> {
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerName: users.username,
      })
      .from(repositories)
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .where(
        and(
          eq(repositories.ownerId, userId),
          eq(repositories.isArchived, false)
        )
      )
      .limit(100);
    return rows
      .filter((r) => r.ownerName)
      .map((r) => ({ id: r.id, fullName: `${r.ownerName}/${r.name}` }));
  } catch {
    return [];
  }
}
