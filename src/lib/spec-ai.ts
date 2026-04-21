/**
 * spec-to-PR v2, part 2 — Claude API call + response parser.
 *
 * Given a user spec plus a compact view of the repository (file list +
 * relevant file contents), asks Claude for a minimal set of file edits that
 * implement the spec. The response is parsed, validated, and returned as a
 * discriminated union so the caller (spec-to-PR pipeline) can decide what
 * to do next.
 *
 * Contract:
 *   - Never throws. Every failure path returns `{ok:false, error:string}`.
 *   - Never invents or installs dependencies. Never edits forbidden paths.
 *   - "no edits" is a valid successful result — caller decides policy.
 *
 * Client pattern cribbed from `src/lib/ai-review.ts` (direct `@anthropic-ai/sdk`
 * + per-call `client.messages.create`), kept intentionally consistent with the
 * rest of the `ai-*` modules.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FileEdit =
  | { action: "create"; path: string; content: string }
  | { action: "edit"; path: string; content: string }
  | { action: "delete"; path: string };

export type SpecAIResult =
  | { ok: true; edits: FileEdit[]; summary: string }
  | { ok: false; error: string };

export interface GenerateSpecEditsArgs {
  spec: string;
  fileList: string[];
  relevantFiles: Array<{ path: string; content: string }>;
  defaultBranch: string;
  /** Model override. Default: `claude-sonnet-4-6` as specified by the caller. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Total prompt size cap, in bytes. Matches the v2 spec. */
const MAX_PROMPT_BYTES = 50_000;
/** Hard cap on file list lines. */
const MAX_FILE_LIST_LINES = 500;
/** Default model — spec says `claude-sonnet-4-6`. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Paths we will never let Claude edit, regardless of what it returns.
 * Matches substrings/prefixes — see `isForbiddenPath`.
 */
const FORBIDDEN_PATTERNS: Array<string | RegExp> = [
  "BUILD_BIBLE.md",
  "src/views/layout.tsx",
  /^drizzle\//,
  /^legal\//,
  "LICENSE",
  /^\.github\//,
];

// ---------------------------------------------------------------------------
// Public helpers (exported so tests can poke at the pure bits)
// ---------------------------------------------------------------------------

/**
 * True if `path` targets a protected area of the tree that Claude must not
 * touch. Rejects edits as a defence-in-depth check in addition to the
 * instruction in the system prompt.
 */
export function isForbiddenPath(path: string): boolean {
  if (!path) return true;
  for (const pat of FORBIDDEN_PATTERNS) {
    if (typeof pat === "string") {
      if (path === pat) return true;
    } else if (pat.test(path)) {
      return true;
    }
  }
  return false;
}

/**
 * True if `path` is a safe, relative, non-traversing filesystem path.
 * Rejects absolute paths, `..` traversal, backslashes, and empty strings.
 */
export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== "string") return false;
  if (!path) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return false;
  }
  return true;
}

/**
 * Structural + policy validation for a single edit. Returns true only if:
 *   - `action` is one of create / edit / delete
 *   - `path` is a safe relative path and not forbidden
 *   - `content` is a string for create / edit
 */
export function validateEdit(edit: unknown): edit is FileEdit {
  if (!edit || typeof edit !== "object") return false;
  const e = edit as Record<string, unknown>;
  const action = e.action;
  const path = e.path;
  if (typeof path !== "string") return false;
  if (!isSafeRelativePath(path)) return false;
  if (isForbiddenPath(path)) return false;
  if (action === "create" || action === "edit") {
    return typeof e.content === "string";
  }
  if (action === "delete") {
    return true;
  }
  return false;
}

/**
 * Parse a Claude response body (which may be wrapped in ```json / ``` fences or
 * contain surrounding prose) into a JSON object.
 *
 * Returns `null` on any parse failure.
 */
export function parseAiJsonResponse(text: string): unknown | null {
  if (typeof text !== "string" || !text) return null;
  let trimmed = text.trim();

  // Strip leading / trailing triple-backtick fences, optionally tagged "json".
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to first balanced {...} block if any.
    const braceMatch = trimmed.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Build the system prompt. Kept as an exported helper so it can be inspected
 * from tests without calling Claude.
 */
export function buildSystemPrompt(): string {
  return [
    "You are an AI coding assistant working inside a repo.",
    "Given a user spec and the repo's file tree + relevant files, produce file edits that implement the spec.",
    "",
    "Rules:",
    "- Minimal scope — implement one feature at a time.",
    "- Never edit tests, CI configs, BUILD_BIBLE.md, locked files, or license files.",
    "- Never invent new dependencies.",
    "- Keep edits surgical and focused on the spec.",
    "",
    "Respond with ONLY a JSON object matching this TypeScript type, with no prose, no markdown fences, no commentary:",
    "",
    "{",
    '  summary: string,',
    "  edits: Array<{ action: 'create' | 'edit' | 'delete', path: string, content?: string }>",
    "}",
    "",
    "For create and edit actions, `content` is required and must be the full file contents.",
    "For delete actions, omit `content`.",
    "Paths must be relative (no leading /, no ..).",
  ].join("\n");
}

/**
 * Build the user prompt, fitting inside `MAX_PROMPT_BYTES`.
 *
 * Truncation strategy, in order:
 *   1. Cap file list at `MAX_FILE_LIST_LINES`.
 *   2. If still over budget, drop trailing file-list entries.
 *   3. If still over, drop lowest-ranked (last) relevant files.
 *
 * `relevantFiles` is assumed to be pre-sorted by the caller in descending
 * score order (most relevant first). We only ever drop from the tail.
 */
export function buildUserPrompt(args: GenerateSpecEditsArgs): string {
  const { spec, defaultBranch } = args;
  let fileList = args.fileList.slice(0, MAX_FILE_LIST_LINES);
  const relevant = args.relevantFiles.slice();

  const header = () =>
    [
      `Default branch: ${defaultBranch}`,
      "",
      "User spec:",
      spec,
      "",
    ].join("\n");

  const render = (): string => {
    const parts: string[] = [header()];
    parts.push("Repository file list:");
    parts.push("```");
    parts.push(fileList.join("\n"));
    parts.push("```");
    parts.push("");
    if (relevant.length > 0) {
      parts.push("Relevant files:");
      parts.push("");
      for (const f of relevant) {
        parts.push("```" + (f.path || ""));
        parts.push(f.content || "");
        parts.push("```");
        parts.push("");
      }
    }
    return parts.join("\n");
  };

  let out = render();
  if (byteLen(out) <= MAX_PROMPT_BYTES) return out;

  // 1. Trim file list.
  while (fileList.length > 0 && byteLen(render()) > MAX_PROMPT_BYTES) {
    fileList = fileList.slice(0, Math.max(0, fileList.length - 10));
  }
  out = render();
  if (byteLen(out) <= MAX_PROMPT_BYTES) return out;

  // 2. Drop lowest-scoring (tail) relevant files one at a time.
  while (relevant.length > 0 && byteLen(render()) > MAX_PROMPT_BYTES) {
    relevant.pop();
  }

  return render();
}

function byteLen(s: string): number {
  // Bun / Node both expose Buffer; fall back to a UTF-8 estimate otherwise.
  try {
    return Buffer.byteLength(s, "utf8");
  } catch {
    return s.length;
  }
}

// ---------------------------------------------------------------------------
// Anthropic client (local to this module — matches ai-review.ts pattern)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return _client;
}

/**
 * Drop the cached Anthropic client. Only intended for tests that need to
 * swap `globalThis.fetch` between calls — the SDK captures `fetch` at
 * client construction time, so reusing a client would pin the stubbed
 * fetch from an earlier test.
 *
 * @internal
 */
export function _resetClientForTests(): void {
  _client = null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Ask Claude to propose file edits that implement `spec`.
 *
 * Never throws — returns a discriminated union. On validation failure a
 * proposed edit is silently dropped; if *every* proposed edit is rejected
 * the result is still `{ok:true, edits:[], summary:"..."}` so the caller
 * can distinguish "AI produced nothing usable" from "AI / transport error".
 */
export async function generateSpecEdits(
  args: GenerateSpecEditsArgs
): Promise<SpecAIResult> {
  if (!config.anthropicApiKey) {
    return { ok: false, error: "ANTHROPIC_API_KEY required" };
  }

  const model = args.model || DEFAULT_MODEL;

  let systemPrompt: string;
  let userPrompt: string;
  try {
    systemPrompt = buildSystemPrompt();
    userPrompt = buildUserPrompt(args);
  } catch (err) {
    return {
      ok: false,
      error: `prompt construction failed: ${errMessage(err)}`,
    };
  }

  let rawText: string;
  try {
    const client = getClient();
    const message = await client.messages.create({
      model,
      max_tokens: 4096,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    rawText = "";
    for (const block of message.content) {
      if (block.type === "text") {
        rawText += block.text;
      }
    }
  } catch (err) {
    return { ok: false, error: `AI call failed: ${errMessage(err)}` };
  }

  const parsed = parseAiJsonResponse(rawText);
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "AI returned invalid JSON" };
  }

  const obj = parsed as Record<string, unknown>;
  const summaryRaw = obj.summary;
  const editsRaw = obj.edits;
  const summary =
    typeof summaryRaw === "string" && summaryRaw.trim()
      ? summaryRaw.trim()
      : "";

  if (!Array.isArray(editsRaw)) {
    return { ok: false, error: "AI returned invalid JSON" };
  }

  const edits: FileEdit[] = [];
  for (const candidate of editsRaw) {
    if (validateEdit(candidate)) {
      edits.push(candidate);
    }
    // Forbidden / malformed edits are silently dropped. The caller can look
    // at `edits.length` vs the original `editsRaw.length` if it cares.
  }

  if (edits.length === 0) {
    return {
      ok: true,
      edits: [],
      summary: summary || "AI proposed no changes",
    };
  }

  return {
    ok: true,
    edits,
    summary: summary || "AI proposed changes",
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}
