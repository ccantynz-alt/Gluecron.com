/**
 * AI rubber-duck chat — repo-grounded conversation backed by the
 * continuous semantic index (src/lib/semantic-index.ts) and Claude
 * streaming.
 *
 * Why a new module instead of extending `ai-chat.ts`?
 *
 *   - `ai-chat.ts` is built around a single-blob JSON history in
 *     `ai_chats.messages`. Streaming partials, per-message citations,
 *     and token-cost accounting would require rewriting the whole
 *     blob on each turn. The 0060 migration introduces dedicated
 *     `repo_chats` + `repo_chat_messages` tables, one row per
 *     message, which makes streaming and citations first-class.
 *   - Repo chat retrieves grounding context via the per-push semantic
 *     index, which is fundamentally different from the static
 *     README+tree summarisation in `ai-chat.ts`. Keeping the two
 *     codepaths separate avoids muddling the abstraction.
 *
 * Public surface:
 *
 *   - `createChat({ repositoryId, ownerUserId, title? })` →
 *     creates a row in `repo_chats` and returns it.
 *   - `appendUserMessage(chatId, content)` → stores a `role:'user'`
 *     row in `repo_chat_messages` and returns it.
 *   - `streamAssistantReply({ chatId, repoId, userMessage, onChunk })`
 *     → resolves grounding context, streams Claude tokens via the
 *     `onChunk` callback, persists the final assistant message with
 *     citations, returns the stored row.
 *   - `__setStreamerForTests` → test seam so unit tests can replace
 *     the Claude streaming call with a deterministic generator.
 *
 * Hard rules:
 *   - Never throw at the boundary. Every external dependency
 *     (semantic index, git blob fetch, Claude API, DB) is wrapped;
 *     on failure we fall back to a safe default and continue.
 *   - Graceful when the semantic index is empty: fall back to a
 *     truncated tree-of-paths summary so the assistant still has
 *     *some* signal about the repo's shape.
 *   - All DB writes are best-effort; a DB outage degrades the chat
 *     to ephemeral mode rather than throwing.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  repoChats,
  repoChatMessages,
  repositories,
  users,
  type RepoChat,
  type RepoChatMessage,
} from "../db/schema";
import { searchSemantic, type SemanticHit } from "./semantic-index";
import {
  getBlob,
  getDefaultBranch,
  getTreeRecursive,
} from "../git/repository";
import { getAnthropic, isAiAvailable, MODEL_SONNET } from "./ai-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max semantic hits we feed the assistant. */
const DEFAULT_TOP_K = 8;

/** Max chars of file content per snippet (after path + heading). */
const MAX_SNIPPET_CHARS = 1500;

/** Max paths in the empty-index fallback tree summary. */
const FALLBACK_TREE_CAP = 120;

/** Hard cap on stored title length. */
const TITLE_LIMIT = 80;

/** Hard cap on the assistant reply we'll persist. */
const ASSISTANT_REPLY_CAP = 32_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Citation {
  file_path: string;
  blob_sha: string;
}

export interface CreateChatOpts {
  repositoryId: string;
  ownerUserId: string;
  title?: string | null;
}

export interface StreamReplyOpts {
  chatId: string;
  repoId: string;
  userMessage: string;
  /**
   * Called for each token / text delta emitted by the assistant.
   * Implementations may ignore the chunk (e.g. tests that only care
   * about the final reply) — the helper still accumulates and stores
   * the full reply regardless.
   */
  onChunk?: (chunk: string) => void;
  /**
   * Optional override of the top-K semantic hits. Useful for tests
   * + the SSE endpoint where the caller wants to thin the context
   * for cost reasons.
   */
  topK?: number;
}

/**
 * Test seam — replace the streaming call with a deterministic generator.
 * Pass `null` to reset. Each chunk yielded becomes one token in the
 * persisted reply (and one `onChunk` invocation).
 */
export type StreamerFn = (args: {
  systemPrompt: string;
  userMessage: string;
}) => AsyncIterable<string>;

let _streamerOverride: StreamerFn | null = null;

export function __setStreamerForTests(fn: StreamerFn | null): void {
  _streamerOverride = fn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new chat row scoped to (repository, owner_user). The title
 * is optional; if absent we leave it null and the route layer can fill
 * it in from the first user message.
 */
export async function createChat(opts: CreateChatOpts): Promise<RepoChat | null> {
  if (!opts.repositoryId || !opts.ownerUserId) return null;
  try {
    const [row] = await db
      .insert(repoChats)
      .values({
        repositoryId: opts.repositoryId,
        ownerUserId: opts.ownerUserId,
        title: (opts.title || "").slice(0, TITLE_LIMIT) || null,
      })
      .returning();
    return row || null;
  } catch (err) {
    if (process.env.DEBUG_REPO_CHAT === "1") {
      console.error("[repo-chat] createChat failed:", err);
    }
    return null;
  }
}

/**
 * Append a `role:'user'` row to the chat and bump `repo_chats.updated_at`
 * so the chat list ordering stays fresh.
 */
export async function appendUserMessage(
  chatId: string,
  content: string
): Promise<RepoChatMessage | null> {
  if (!chatId || !content) return null;
  try {
    const [row] = await db
      .insert(repoChatMessages)
      .values({
        chatId,
        role: "user",
        content,
        citations: [],
        tokenCost: 0,
      })
      .returning();
    // Best-effort: keep the parent chat's `updated_at` warm.
    try {
      await db
        .update(repoChats)
        .set({ updatedAt: new Date() })
        .where(eq(repoChats.id, chatId));
    } catch {
      /* tolerate */
    }
    return row || null;
  } catch (err) {
    if (process.env.DEBUG_REPO_CHAT === "1") {
      console.error("[repo-chat] appendUserMessage failed:", err);
    }
    return null;
  }
}

/**
 * The full pipeline: resolve repo context (semantic hits → snippets →
 * system prompt), stream Claude's reply token-by-token via `onChunk`,
 * persist the final assistant row with citations + a coarse token
 * cost estimate, and return it.
 *
 * Never throws. On any failure inside grounding/streaming we still
 * try to persist a short advisory assistant message so the UI never
 * shows a "phantom" user message with no reply.
 */
export async function streamAssistantReply(
  opts: StreamReplyOpts
): Promise<RepoChatMessage | null> {
  const { chatId, repoId, userMessage } = opts;
  const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, 20));

  // 1. Resolve grounding context.
  const { citations, contextBlock } = await buildGroundingContext({
    repoId,
    userMessage,
    topK,
  });

  // 2. Build the system prompt.
  const systemPrompt = await buildSystemPrompt({
    repoId,
    contextBlock,
  });

  // 3. Stream Claude's reply (or canned tokens in tests).
  let reply = "";
  try {
    const stream = _streamerOverride
      ? _streamerOverride({ systemPrompt, userMessage })
      : claudeStream({ systemPrompt, userMessage });

    for await (const chunk of stream) {
      if (!chunk) continue;
      reply += chunk;
      if (opts.onChunk) {
        try {
          opts.onChunk(chunk);
        } catch {
          // Caller-supplied callback errors mustn't kill the stream.
        }
      }
      // Safety cap — Claude can produce very long outputs; we don't
      // want a runaway response to blow up our row.
      if (reply.length >= ASSISTANT_REPLY_CAP) break;
    }
  } catch (err) {
    if (process.env.DEBUG_REPO_CHAT === "1") {
      console.error("[repo-chat] stream failed:", err);
    }
    if (!reply) {
      reply =
        "Sorry — I couldn't reach the AI service to answer that. Please retry in a moment.";
    }
  }

  // Cap the persisted reply.
  if (reply.length > ASSISTANT_REPLY_CAP) {
    reply = reply.slice(0, ASSISTANT_REPLY_CAP);
  }

  // 4. Coarse token-cost estimate: ~4 chars/token. Stored as integer.
  const tokenCost = Math.ceil(
    (systemPrompt.length + userMessage.length + reply.length) / 4
  );

  // 5. Persist.
  try {
    const [row] = await db
      .insert(repoChatMessages)
      .values({
        chatId,
        role: "assistant",
        content: reply,
        citations,
        tokenCost,
      })
      .returning();
    // Bump parent chat freshness so list ordering reflects the answer.
    try {
      await db
        .update(repoChats)
        .set({ updatedAt: new Date() })
        .where(eq(repoChats.id, chatId));
    } catch {
      /* tolerate */
    }
    return row || null;
  } catch (err) {
    if (process.env.DEBUG_REPO_CHAT === "1") {
      console.error("[repo-chat] persist assistant failed:", err);
    }
    return null;
  }
}

/**
 * List all chats for a (user, repo) pair, ordered by most-recently
 * updated. Returns [] on any DB failure.
 */
export async function listChatsForRepo(
  ownerUserId: string,
  repositoryId: string,
  limit = 30
): Promise<RepoChat[]> {
  if (!ownerUserId || !repositoryId) return [];
  try {
    return await db
      .select()
      .from(repoChats)
      .where(
        and(
          eq(repoChats.ownerUserId, ownerUserId),
          eq(repoChats.repositoryId, repositoryId)
        )
      )
      .orderBy(desc(repoChats.updatedAt))
      .limit(Math.max(1, Math.min(limit, 100)));
  } catch {
    return [];
  }
}

/**
 * Fetch all messages in a chat, oldest first. Empty array on DB error.
 */
export async function listMessages(
  chatId: string
): Promise<RepoChatMessage[]> {
  if (!chatId) return [];
  try {
    return await db
      .select()
      .from(repoChatMessages)
      .where(eq(repoChatMessages.chatId, chatId))
      .orderBy(asc(repoChatMessages.createdAt));
  } catch {
    return [];
  }
}

/**
 * Verify the chat belongs to the user. Returns the chat row or null.
 * Used by the route handlers + the SSE endpoint to authorise access.
 */
export async function getChatForUser(
  chatId: string,
  ownerUserId: string
): Promise<RepoChat | null> {
  if (!chatId || !ownerUserId) return null;
  try {
    const [row] = await db
      .select()
      .from(repoChats)
      .where(
        and(eq(repoChats.id, chatId), eq(repoChats.ownerUserId, ownerUserId))
      )
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Grounding context — semantic hits + snippet fetch, with tree fallback.
// ---------------------------------------------------------------------------

async function buildGroundingContext(args: {
  repoId: string;
  userMessage: string;
  topK: number;
}): Promise<{ citations: Citation[]; contextBlock: string }> {
  const { repoId, userMessage, topK } = args;

  let hits: SemanticHit[] = [];
  try {
    hits = await searchSemantic({
      repositoryId: repoId,
      query: userMessage,
      limit: topK,
    });
  } catch {
    hits = [];
  }

  if (!hits.length) {
    // Fallback: tree-of-paths summary so Claude still has *some*
    // sense of repo shape. Best-effort — empty string on failure.
    const treeSummary = await buildTreeFallback(repoId);
    return {
      citations: [],
      contextBlock: treeSummary
        ? `No semantic index is available for this repo (yet). Repo layout:\n\n${treeSummary}`
        : "",
    };
  }

  // Resolve owner/name for getBlob lookups.
  const repoMeta = await loadRepoMeta(repoId);

  const citations: Citation[] = [];
  const sections: string[] = [];

  for (const hit of hits) {
    // The semantic-index already stores a snippet; prefer that for
    // cost, but fetch a slightly larger window via getBlob when meta
    // is available so the model sees real code, not a 500-char preview.
    let snippet = hit.snippet || "";
    if (repoMeta) {
      try {
        const blob = await getBlob(
          repoMeta.owner,
          repoMeta.name,
          repoMeta.defaultBranch,
          hit.filePath
        );
        if (blob && !blob.isBinary && blob.content) {
          snippet = blob.content.slice(0, MAX_SNIPPET_CHARS);
        }
      } catch {
        // tolerate; fall back to whatever snippet we already have
      }
    }
    if (!snippet) continue;

    citations.push({
      file_path: hit.filePath,
      blob_sha: hit.blobSha,
    });
    sections.push(`### ${hit.filePath}\n\`\`\`\n${snippet}\n\`\`\``);
  }

  return {
    citations,
    contextBlock: sections.join("\n\n"),
  };
}

async function buildTreeFallback(repoId: string): Promise<string> {
  const meta = await loadRepoMeta(repoId);
  if (!meta) return "";
  try {
    const tree = await getTreeRecursive(
      meta.owner,
      meta.name,
      meta.defaultBranch,
      FALLBACK_TREE_CAP * 2
    );
    if (!tree) return "";
    const blobs = tree.tree
      .filter((e) => e.type === "blob")
      .slice(0, FALLBACK_TREE_CAP)
      .map((e) => `- ${e.path}`);
    return blobs.join("\n");
  } catch {
    return "";
  }
}

async function buildSystemPrompt(args: {
  repoId: string;
  contextBlock: string;
}): Promise<string> {
  const meta = await loadRepoMeta(args.repoId);
  const owner = meta?.owner || "unknown";
  const name = meta?.name || "repo";

  const header = [
    `You are Gluecron's repo chat for ${owner}/${name}.`,
    `Here are the most relevant files based on the user's question:`,
    "",
    args.contextBlock || "(no grounding context available)",
    "",
    `Answer concisely. Cite files as [path](/${owner}/${name}/blob/HEAD/path).`,
    `Prefer code snippets over prose when explaining concrete behaviour.`,
    `If the grounding context doesn't cover the question, say so plainly rather than guessing.`,
  ];
  return header.join("\n");
}

// ---------------------------------------------------------------------------
// Repo metadata helper — owner/name/defaultBranch for git lookups.
// ---------------------------------------------------------------------------

interface RepoMeta {
  owner: string;
  name: string;
  defaultBranch: string;
}

async function loadRepoMeta(repoId: string): Promise<RepoMeta | null> {
  if (!repoId) return null;
  try {
    const [row] = await db
      .select({
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        owner: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.id, repoId))
      .limit(1);
    if (!row) return null;
    let defaultBranch = row.defaultBranch || "main";
    // If the configured default branch isn't actually resolvable on
    // disk, fall back to whatever HEAD points at.
    try {
      const real = await getDefaultBranch(row.owner, row.name);
      if (real) defaultBranch = real;
    } catch {
      /* tolerate */
    }
    return { owner: row.owner, name: row.name, defaultBranch };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude streaming — thin wrapper that yields text deltas.
// ---------------------------------------------------------------------------

async function* claudeStream(args: {
  systemPrompt: string;
  userMessage: string;
}): AsyncGenerator<string, void, unknown> {
  if (!isAiAvailable()) {
    yield "AI is not configured on this Gluecron instance — set ANTHROPIC_API_KEY to enable rubber-duck chat.";
    return;
  }

  const client = getAnthropic();
  // Anthropic SDK exposes `.stream(...)` returning an event emitter
  // with an async iterator over RawMessageStreamEvent chunks. We
  // extract `content_block_delta` text deltas.
  const stream = client.messages.stream({
    model: MODEL_SONNET,
    max_tokens: 2048,
    system: args.systemPrompt,
    messages: [{ role: "user", content: args.userMessage }],
  });

  // The SDK's stream object is itself async-iterable over events.
  for await (const event of stream as AsyncIterable<unknown>) {
    const delta = extractTextDelta(event);
    if (delta) yield delta;
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
// Test-only exports.
// ---------------------------------------------------------------------------

export const __test = {
  buildGroundingContext,
  buildSystemPrompt,
  buildTreeFallback,
  extractTextDelta,
  ASSISTANT_REPLY_CAP,
  MAX_SNIPPET_CHARS,
  FALLBACK_TREE_CAP,
};
