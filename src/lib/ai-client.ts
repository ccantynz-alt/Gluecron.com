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

/** Default model for code understanding + review */
export const MODEL_SONNET = "claude-sonnet-4-20250514";
/** Fast model for lightweight tasks (commit messages, titles) */
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";

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
