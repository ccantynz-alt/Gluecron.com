/**
 * AI chat assistant — global + per-repo.
 *
 *   GET  /ask                         — global assistant (platform Q&A)
 *   GET  /ask/:chatId                 — resume a saved chat
 *   POST /ask                         — send a message (global)
 *   GET  /:owner/:repo/ask            — repo-grounded chat
 *   POST /:owner/:repo/ask            — send a repo-grounded message
 *   POST /:owner/:repo/explain        — "Explain this file" helper
 *
 * Chats are persisted to `ai_chats` so users can return to them.
 * Form-based — works even with JS disabled.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { aiChats, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { chat, explainFile } from "../lib/ai-chat";
import type { ChatMessage } from "../lib/ai-chat";
import { getUnreadCount } from "../lib/unread";
import { isAiAvailable } from "../lib/ai-client";

const ask = new Hono<AuthEnv>();
ask.use("*", softAuth);

function loadMessages(raw: string | null | undefined): ChatMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (m): m is ChatMessage =>
          m && typeof m === "object" && typeof m.content === "string" &&
          (m.role === "user" || m.role === "assistant")
      );
    }
  } catch {
    /* ignore */
  }
  return [];
}

function renderChatView(
  c: any,
  {
    messages,
    postUrl,
    title,
    subtitle,
    placeholder,
    recentChats,
    user,
    unreadCount,
  }: {
    messages: ChatMessage[];
    postUrl: string;
    title: string;
    subtitle?: string;
    placeholder: string;
    recentChats?: Array<{ id: string; title: string | null; updatedAt: Date }>;
    user: any;
    unreadCount: number;
  }
) {
  return c.html(
    <Layout title={title} user={user} notificationCount={unreadCount}>
      <div class="ask-container">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px">
          <h2>{title}</h2>
          {!isAiAvailable() && (
            <span class="badge" style="color: var(--yellow); border-color: var(--yellow)">
              AI unavailable — set ANTHROPIC_API_KEY
            </span>
          )}
        </div>
        {subtitle && (
          <p style="color: var(--text-muted); margin-bottom: 16px">{subtitle}</p>
        )}

        <div class="chat-log">
          {messages.length === 0 ? (
            <div class="panel-empty">
              Ask anything. Reference files with @path/to/file.ext.
            </div>
          ) : (
            messages.map((m) => (
              <div class={`chat-message ${m.role}`}>
                <div class="role">{m.role === "user" ? "You" : "GlueCron AI"}</div>
                {m.content}
              </div>
            ))
          )}
        </div>

        <form method="POST" action={postUrl} class="chat-form">
          <textarea
            name="message"
            placeholder={placeholder}
            required
            autofocus
          ></textarea>
          <div
            style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px"
          >
            <div class="chat-hint">
              {"\u21B5"} Enter + Ctrl/Cmd to send. Mention files with
              <span class="chat-cited" style="margin-left: 4px">@src/file.ts</span>
            </div>
            <button type="submit" class="btn btn-primary">
              Send
            </button>
          </div>
        </form>

        {recentChats && recentChats.length > 0 && (
          <div style="margin-top: 32px">
            <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 12px">
              Recent chats
            </h3>
            <div class="panel">
              {recentChats.map((ch) => (
                <div class="panel-item">
                  <div class="dot blue"></div>
                  <div style="flex: 1">
                    <a href={`/ask/${ch.id}`}>
                      {ch.title || "(untitled)"}
                    </a>
                    <div class="meta">
                      {new Date(ch.updatedAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

// Backwards-compat alias retained so external imports keep working.
const ChatView = renderChatView;

async function resumeChat(
  userId: string,
  chatId: string
): Promise<{
  messages: ChatMessage[];
  repoOwner: string | null;
  repoName: string | null;
} | null> {
  try {
    const [row] = await db
      .select({
        messages: aiChats.messages,
        userId: aiChats.userId,
        repositoryId: aiChats.repositoryId,
      })
      .from(aiChats)
      .where(eq(aiChats.id, chatId))
      .limit(1);
    if (!row || row.userId !== userId) return null;

    let repoOwner: string | null = null;
    let repoName: string | null = null;
    if (row.repositoryId) {
      const [repo] = await db
        .select({ name: repositories.name, username: users.username })
        .from(repositories)
        .innerJoin(users, eq(repositories.ownerId, users.id))
        .where(eq(repositories.id, row.repositoryId))
        .limit(1);
      if (repo) {
        repoOwner = repo.username;
        repoName = repo.name;
      }
    }

    return {
      messages: loadMessages(row.messages),
      repoOwner,
      repoName,
    };
  } catch {
    return null;
  }
}

async function appendMessage(opts: {
  userId: string;
  chatId: string | null;
  repositoryId: string | null;
  userMessage: string;
  aiReply: string;
  history: ChatMessage[];
  title: string;
}): Promise<string> {
  const newHistory: ChatMessage[] = [
    ...opts.history,
    { role: "user", content: opts.userMessage },
    { role: "assistant", content: opts.aiReply },
  ];
  try {
    if (opts.chatId) {
      await db
        .update(aiChats)
        .set({ messages: JSON.stringify(newHistory), updatedAt: new Date() })
        .where(eq(aiChats.id, opts.chatId));
      return opts.chatId;
    }
    const [row] = await db
      .insert(aiChats)
      .values({
        userId: opts.userId,
        repositoryId: opts.repositoryId ?? undefined,
        title: opts.title.slice(0, 80),
        messages: JSON.stringify(newHistory),
      })
      .returning();
    return row?.id || "";
  } catch (err) {
    console.error("[ask] persist failed:", err);
    return opts.chatId || "";
  }
}

// ---------- Global assistant ----------

ask.get("/ask", requireAuth, async (c) => {
  const user = c.get("user")!;
  const unread = await getUnreadCount(user.id);
  let recent: Array<{ id: string; title: string | null; updatedAt: Date }> = [];
  try {
    recent = await db
      .select({
        id: aiChats.id,
        title: aiChats.title,
        updatedAt: aiChats.updatedAt,
      })
      .from(aiChats)
      .where(eq(aiChats.userId, user.id))
      .orderBy(desc(aiChats.updatedAt))
      .limit(10);
  } catch {
    /* ignore */
  }

  return renderChatView(c, {
    messages: [],
    postUrl: "/ask",
    title: "Ask AI",
    subtitle:
      "Ask about GlueCron, your repos, or paste a diff to review. Claude is grounded in your repo when visiting /:owner/:repo/ask.",
    placeholder: "Ask anything...",
    recentChats: recent,
    user,
    unreadCount: unread,
  });
});

ask.get("/ask/:chatId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const chatId = c.req.param("chatId");
  const resumed = await resumeChat(user.id, chatId);
  if (!resumed) return c.redirect("/ask");
  const unread = await getUnreadCount(user.id);
  return renderChatView(c, {
    messages: resumed.messages,
    postUrl:
      resumed.repoOwner && resumed.repoName
        ? `/${resumed.repoOwner}/${resumed.repoName}/ask?chatId=${chatId}`
        : `/ask?chatId=${chatId}`,
    title:
      resumed.repoOwner && resumed.repoName
        ? `${resumed.repoOwner}/${resumed.repoName} — AI chat`
        : "Ask AI",
    placeholder: "Continue the conversation...",
    user,
    unreadCount: unread,
  });
});

ask.post("/ask", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const userMessage = String(body.message || "").trim();
  const chatId = (c.req.query("chatId") || "").trim();
  if (!userMessage) return c.redirect("/ask");

  let history: ChatMessage[] = [];
  if (chatId) {
    const existing = await resumeChat(user.id, chatId);
    if (existing) history = existing.messages;
  }

  const response = await chat(user.username, null, history, userMessage);
  const nextId = await appendMessage({
    userId: user.id,
    chatId: chatId || null,
    repositoryId: null,
    userMessage,
    aiReply: response.reply,
    history,
    title: userMessage,
  });

  return c.redirect(nextId ? `/ask/${nextId}` : "/ask");
});

// ---------- Repo-grounded assistant ----------

ask.get("/:owner/:repo/ask", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();

  // Verify repo exists
  const [repoRow] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  if (!repoRow) return c.notFound();

  const unread = await getUnreadCount(user.id);

  let recent: Array<{ id: string; title: string | null; updatedAt: Date }> = [];
  try {
    recent = await db
      .select({
        id: aiChats.id,
        title: aiChats.title,
        updatedAt: aiChats.updatedAt,
      })
      .from(aiChats)
      .where(
        and(
          eq(aiChats.userId, user.id),
          eq(aiChats.repositoryId, repoRow.id)
        )
      )
      .orderBy(desc(aiChats.updatedAt))
      .limit(10);
  } catch {
    /* ignore */
  }

  return renderChatView(c, {
    messages: [],
    postUrl: `/${owner}/${repo}/ask`,
    title: `Ask about ${owner}/${repo}`,
    subtitle:
      "Claude has access to this repository's README, tree, and recent commits. Reference files with @path/to/file.",
    placeholder: `Ask about ${repo}...`,
    recentChats: recent,
    user,
    unreadCount: unread,
  });
});

ask.post("/:owner/:repo/ask", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const body = await c.req.parseBody();
  const userMessage = String(body.message || "").trim();
  const chatId = (c.req.query("chatId") || "").trim();
  if (!userMessage) return c.redirect(`/${owner}/${repo}/ask`);

  const [repoRow] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  if (!repoRow) return c.notFound();

  let history: ChatMessage[] = [];
  if (chatId) {
    const existing = await resumeChat(user.id, chatId);
    if (existing) history = existing.messages;
  }

  const response = await chat(owner, repo, history, userMessage);
  const nextId = await appendMessage({
    userId: user.id,
    chatId: chatId || null,
    repositoryId: repoRow.id,
    userMessage,
    aiReply: response.reply,
    history,
    title: userMessage,
  });

  return c.redirect(
    nextId ? `/ask/${nextId}` : `/${owner}/${repo}/ask`
  );
});

// ---------- Explain-this-file helper ----------

ask.post("/:owner/:repo/explain", requireAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const body = await c.req.parseBody().catch(() => ({}));
  const filePath = String((body as any).file || c.req.query("file") || "");
  const ref = String((body as any).ref || c.req.query("ref") || "");
  if (!filePath || !ref) {
    return c.json({ error: "file and ref required" }, 400);
  }

  const { getBlob } = await import("../git/repository");
  const blob = await getBlob(owner, repo, ref, filePath);
  if (!blob || blob.isBinary) {
    return c.json({ error: "file not found or binary" }, 404);
  }

  const explanation = await explainFile(owner, repo, filePath, blob.content);
  return c.json({ explanation });
});

export default ask;
