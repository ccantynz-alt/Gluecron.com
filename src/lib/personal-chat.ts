/**
 * Personal chat — user-scoped sibling of `src/lib/repo-chat.ts`.
 *
 * Same contract: create chats, append user messages, stream assistant
 * replies grounded in semantic retrieval. The retrieval difference: we
 * call `searchPersonalSemantic` (cross-repo, opt-in) instead of
 * `searchSemantic` (per-repo). Citations carry `repo_name` alongside the
 * file path so the UI can render "owner/repo · path".
 *
 * Hard rules (mirrors repo-chat):
 *   - Never throw at the boundary.
 *   - Streamer is the same Anthropic streaming wrapper as repo-chat;
 *     we reuse its module-level helpers via a shared internal API
 *     (`__personalChatStreamer`) so test-seam injection is consistent.
 *   - If the user has not opted in (or has no accessible repos), the
 *     assistant reply is a short advisory message — we never silently
 *     succeed with an empty context and pretend to know things.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  personalChats,
  personalChatMessages,
  type PersonalChat,
  type PersonalChatMessage,
} from "../db/schema";
import {
  isPersonalSemanticEnabled,
  searchPersonalSemantic,
  type PersonalSemanticHit,
} from "./personal-semantic";
import { getAnthropic, isAiAvailable, MODEL_SONNET } from "./ai-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOP_K = 8;
const MAX_SNIPPET_CHARS = 1500;
const TITLE_LIMIT = 80;
const ASSISTANT_REPLY_CAP = 32_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonalCitation {
  file_path: string;
  blob_sha: string;
  repo_name: string;
}

export interface CreatePersonalChatOpts {
  ownerUserId: string;
  title?: string | null;
}

export interface PersonalStreamReplyOpts {
  chatId: string;
  userId: string;
  userMessage: string;
  onChunk?: (chunk: string) => void;
  topK?: number;
}

// ---------------------------------------------------------------------------
// Streamer test seam — kept separate from the repo-chat seam so tests can
// drive the two surfaces independently.
// ---------------------------------------------------------------------------

export type PersonalStreamerFn = (args: {
  systemPrompt: string;
  userMessage: string;
}) => AsyncIterable<string>;

let _streamerOverride: PersonalStreamerFn | null = null;

export function __setPersonalStreamerForTests(
  fn: PersonalStreamerFn | null
): void {
  _streamerOverride = fn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createPersonalChat(
  opts: CreatePersonalChatOpts
): Promise<PersonalChat | null> {
  if (!opts.ownerUserId) return null;
  try {
    const [row] = await db
      .insert(personalChats)
      .values({
        ownerUserId: opts.ownerUserId,
        title: (opts.title || "").slice(0, TITLE_LIMIT) || null,
      })
      .returning();
    return row || null;
  } catch (err) {
    if (process.env.DEBUG_PERSONAL_CHAT === "1") {
      console.error("[personal-chat] createPersonalChat failed:", err);
    }
    return null;
  }
}

export async function appendPersonalUserMessage(
  chatId: string,
  content: string
): Promise<PersonalChatMessage | null> {
  if (!chatId || !content) return null;
  try {
    const [row] = await db
      .insert(personalChatMessages)
      .values({
        chatId,
        role: "user",
        content,
        citations: [],
        tokenCost: 0,
      })
      .returning();
    try {
      await db
        .update(personalChats)
        .set({ updatedAt: new Date() })
        .where(eq(personalChats.id, chatId));
    } catch {
      /* tolerate */
    }
    return row || null;
  } catch (err) {
    if (process.env.DEBUG_PERSONAL_CHAT === "1") {
      console.error("[personal-chat] appendPersonalUserMessage failed:", err);
    }
    return null;
  }
}

/**
 * Full pipeline. Resolves cross-repo semantic context (gated on the
 * user's opt-in flag), streams Claude's reply, persists the assistant
 * row with citations carrying repo_name annotations.
 */
export async function streamPersonalAssistantReply(
  opts: PersonalStreamReplyOpts
): Promise<PersonalChatMessage | null> {
  const { chatId, userId, userMessage } = opts;
  const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, 20));

  // 1. Opt-in gate (the personal-semantic layer also checks this, but
  //    we short-circuit here so the assistant gives a clear advisory
  //    rather than blandly hallucinating off zero context).
  const enabled = await isPersonalSemanticEnabled(userId);

  // 2. Resolve grounding (empty array when disabled).
  const { citations, contextBlock } = await buildPersonalContext({
    userId,
    userMessage,
    topK,
    enabled,
  });

  // 3. Build the system prompt.
  const systemPrompt = buildPersonalSystemPrompt({
    enabled,
    contextBlock,
    citationCount: citations.length,
  });

  // 4. Stream.
  let reply = "";
  try {
    const stream = _streamerOverride
      ? _streamerOverride({ systemPrompt, userMessage })
      : claudeStreamPersonal({ systemPrompt, userMessage });

    for await (const chunk of stream) {
      if (!chunk) continue;
      reply += chunk;
      if (opts.onChunk) {
        try {
          opts.onChunk(chunk);
        } catch {
          /* ignore caller errors */
        }
      }
      if (reply.length >= ASSISTANT_REPLY_CAP) break;
    }
  } catch (err) {
    if (process.env.DEBUG_PERSONAL_CHAT === "1") {
      console.error("[personal-chat] stream failed:", err);
    }
    if (!reply) {
      reply =
        "Sorry — I couldn't reach the AI service to answer that. Please retry in a moment.";
    }
  }

  if (reply.length > ASSISTANT_REPLY_CAP) {
    reply = reply.slice(0, ASSISTANT_REPLY_CAP);
  }

  const tokenCost = Math.ceil(
    (systemPrompt.length + userMessage.length + reply.length) / 4
  );

  // 5. Persist.
  try {
    const [row] = await db
      .insert(personalChatMessages)
      .values({
        chatId,
        role: "assistant",
        content: reply,
        citations,
        tokenCost,
      })
      .returning();
    try {
      await db
        .update(personalChats)
        .set({ updatedAt: new Date() })
        .where(eq(personalChats.id, chatId));
    } catch {
      /* tolerate */
    }
    return row || null;
  } catch (err) {
    if (process.env.DEBUG_PERSONAL_CHAT === "1") {
      console.error("[personal-chat] persist assistant failed:", err);
    }
    return null;
  }
}

export async function listPersonalChatsForUser(
  ownerUserId: string,
  limit = 30
): Promise<PersonalChat[]> {
  if (!ownerUserId) return [];
  try {
    return await db
      .select()
      .from(personalChats)
      .where(eq(personalChats.ownerUserId, ownerUserId))
      .orderBy(desc(personalChats.updatedAt))
      .limit(Math.max(1, Math.min(limit, 100)));
  } catch {
    return [];
  }
}

export async function listPersonalMessages(
  chatId: string
): Promise<PersonalChatMessage[]> {
  if (!chatId) return [];
  try {
    return await db
      .select()
      .from(personalChatMessages)
      .where(eq(personalChatMessages.chatId, chatId))
      .orderBy(asc(personalChatMessages.createdAt));
  } catch {
    return [];
  }
}

export async function getPersonalChatForUser(
  chatId: string,
  ownerUserId: string
): Promise<PersonalChat | null> {
  if (!chatId || !ownerUserId) return null;
  try {
    const [row] = await db
      .select()
      .from(personalChats)
      .where(
        and(
          eq(personalChats.id, chatId),
          eq(personalChats.ownerUserId, ownerUserId)
        )
      )
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Grounding context
// ---------------------------------------------------------------------------

async function buildPersonalContext(args: {
  userId: string;
  userMessage: string;
  topK: number;
  enabled: boolean;
}): Promise<{ citations: PersonalCitation[]; contextBlock: string }> {
  if (!args.enabled) {
    return { citations: [], contextBlock: "" };
  }

  let hits: PersonalSemanticHit[] = [];
  try {
    hits = await searchPersonalSemantic({
      userId: args.userId,
      query: args.userMessage,
      limit: args.topK,
    });
  } catch {
    hits = [];
  }

  if (!hits.length) {
    return { citations: [], contextBlock: "" };
  }

  const citations: PersonalCitation[] = [];
  const sections: string[] = [];
  for (const hit of hits) {
    const snippet = (hit.snippet || "").slice(0, MAX_SNIPPET_CHARS);
    if (!snippet) continue;
    citations.push({
      file_path: hit.filePath,
      blob_sha: hit.blobSha,
      repo_name: hit.repoName,
    });
    sections.push(
      `### ${hit.repoName} · ${hit.filePath}\n\`\`\`\n${snippet}\n\`\`\``
    );
  }

  return { citations, contextBlock: sections.join("\n\n") };
}

function buildPersonalSystemPrompt(args: {
  enabled: boolean;
  contextBlock: string;
  citationCount: number;
}): string {
  if (!args.enabled) {
    return [
      "You are Gluecron's personal cross-repo chat assistant.",
      "",
      "The user has NOT enabled personal cross-repo semantic search.",
      "Tell them clearly that you can't see their code until they enable",
      "the toggle at /settings (Personal cross-repo semantic index). Do",
      "not attempt to answer code-specific questions in this mode.",
    ].join("\n");
  }

  const lines = [
    "You are Gluecron's personal cross-repo chat assistant.",
    "",
    "You have access to semantic-index snippets across every repository",
    "the user owns or is an accepted collaborator on. Citations name the",
    "source repo as `owner/repo`; always include the repo name when you",
    "reference a file, e.g. `owner/repo:src/lib/foo.ts`.",
    "",
    "Most relevant context:",
    "",
    args.contextBlock || "(no semantic hits — say so plainly)",
    "",
    "Answer concisely. Prefer code snippets over prose when explaining",
    "concrete behaviour. If the grounding context doesn't cover the",
    "question, say so rather than guessing.",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Claude streaming
// ---------------------------------------------------------------------------

async function* claudeStreamPersonal(args: {
  systemPrompt: string;
  userMessage: string;
}): AsyncGenerator<string, void, unknown> {
  if (!isAiAvailable()) {
    yield "AI is not configured on this Gluecron instance — set ANTHROPIC_API_KEY to enable personal chat.";
    return;
  }
  const client = getAnthropic();
  const stream = client.messages.stream({
    model: MODEL_SONNET,
    max_tokens: 2048,
    system: args.systemPrompt,
    messages: [{ role: "user", content: args.userMessage }],
  });

  let inputTokens = 0;
  let outputTokens = 0;
  for await (const event of stream as AsyncIterable<unknown>) {
    const ev = event as Record<string, unknown> | null;
    if (ev && typeof ev === "object") {
      const msg = (ev as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }).message;
      if (msg && msg.usage) {
        if (typeof msg.usage.input_tokens === "number")
          inputTokens = msg.usage.input_tokens;
        if (typeof msg.usage.output_tokens === "number")
          outputTokens = msg.usage.output_tokens;
      }
      const usage = (ev as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      if (usage) {
        if (typeof usage.input_tokens === "number")
          inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number")
          outputTokens = usage.output_tokens;
      }
    }
    const delta = extractTextDelta(event);
    if (delta) yield delta;
  }

  try {
    const { recordAiCost } = await import("./ai-cost-tracker");
    await recordAiCost({
      model: MODEL_SONNET,
      inputTokens,
      outputTokens,
      category: "chat",
      sourceKind: "personal_chat",
    });
  } catch {
    /* best-effort */
  }
}

function extractTextDelta(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as Record<string, unknown>;
  if (e.type !== "content_block_delta") return "";
  const delta = e.delta as Record<string, unknown> | undefined;
  if (!delta) return "";
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return delta.text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __test = {
  buildPersonalContext,
  buildPersonalSystemPrompt,
  extractTextDelta,
  ASSISTANT_REPLY_CAP,
  MAX_SNIPPET_CHARS,
};
