/**
 * Shared Anthropic client + helpers for all AI-powered features.
 * Centralised here so model choice, caching, and key handling live in one place.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!_client) {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return _client;
}

export function isAiAvailable(): boolean {
  return !!config.anthropicApiKey;
}

/** Primary model for all AI features — code understanding, review, generation */
export const MODEL_SONNET = "claude-sonnet-4-6";
/** Light-task model — never reference directly; route through modelForTask() */
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";

/**
 * Task → model routing.
 *
 * Every AI feature names its task here and asks `modelForTask()` which model
 * to run. Routing policy is deliberately conservative:
 *
 *   - Haiku is allowed ONLY for short, low-stakes outputs that a human
 *     always reviews and can trivially override (commit-message drafts,
 *     issue/PR triage suggestions, label suggestions). Worst-case failure
 *     is a bad suggestion someone ignores.
 *   - EVERYTHING else — anything that writes code, judges code, or produces
 *     user-facing documents — stays on Sonnet. Unknown tasks default to
 *     Sonnet too, so a typo can never silently downgrade quality.
 *
 * Kill-switch: set AI_FORCE_SONNET=1 to route every task to Sonnet. The env
 * var is read at call time, so flipping it takes effect on the next request
 * without a restart.
 */
export type AiTask =
  // Haiku-eligible (short, human-reviewed, low-stakes suggestions)
  | "commit-message"
  | "issue-triage"
  | "pr-triage"
  | "label-suggest"
  // Sonnet-only (writes or judges code, or produces user-facing docs)
  | "code-review"
  | "code-completion"
  | "spec-to-pr"
  | "ci-heal"
  | "pr-summary"
  | "changelog";

/** Tasks allowed to run on Haiku. Additions require explicit owner sign-off. */
const HAIKU_ALLOWLIST: ReadonlySet<AiTask> = new Set<AiTask>([
  "commit-message",
  "issue-triage",
  "pr-triage",
  "label-suggest",
]);

/**
 * Resolve the model for a task. Allowlisted light tasks get Haiku; everything
 * else (including unknown task strings) gets Sonnet. `AI_FORCE_SONNET=1`
 * forces Sonnet for all tasks.
 */
export function modelForTask(task: AiTask): string {
  // Read at call time so the kill-switch works without a restart.
  if (process.env.AI_FORCE_SONNET === "1") return MODEL_SONNET;
  return HAIKU_ALLOWLIST.has(task) ? MODEL_HAIKU : MODEL_SONNET;
}

/**
 * Extract text content from an Anthropic message response.
 */
export function extractText(
  message: Anthropic.Messages.Message
): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/**
 * Safely parse JSON from a Claude response that may include surrounding prose
 * or a ```json code block.
 */
export function parseJsonResponse<T = unknown>(text: string): T | null {
  // Prefer ```json blocks
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/);
  const candidate = fenced ? fenced[1] : null;
  if (candidate) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // fall through
    }
  }
  // Fall back to first top-level {...} or [...]
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as T;
    } catch {
      // fall through
    }
  }
  const bracketMatch = text.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      return JSON.parse(bracketMatch[0]) as T;
    } catch {
      return null;
    }
  }
  return null;
}
