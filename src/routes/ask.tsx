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
 *
 * Visual recipe (2026 polish — mirrors admin-integrations / error-page):
 *   - Gradient hairline strip across the top of the hero (purple→cyan)
 *   - Soft radial orb in the corner
 *   - Display headline with gradient-text on the title
 *   - Chat-style bubbles: user right-aligned with subtle background,
 *     AI left-aligned with gradient avatar
 *   - Composer with gradient submit button + focus ring
 *   - Scoped CSS — every class prefixed `.ask-*`
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
      <style dangerouslySetInnerHTML={{ __html: askCss }} />
      <div class="ask-page">
        {/* Hero (2026 polish: hairline + orb + grad headline) */}
        <header class="ask-hero">
          <div class="ask-hero-orb" aria-hidden="true" />
          <div class="ask-hero-inner">
            <div class="ask-eyebrow">
              <span class="ask-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              AI chat {"·"} Claude Sonnet 4 {"·"} <span class="ask-eyebrow-who">{user.username}</span>
              {!isAiAvailable() && (
                <span class="ask-pill-warn">AI unavailable {"—"} set ANTHROPIC_API_KEY</span>
              )}
            </div>
            <h1 class="ask-title">
              <span class="ask-title-grad">{title}</span>
            </h1>
            {subtitle && <p class="ask-sub">{subtitle}</p>}
          </div>
        </header>

        {/* Chat log: user right-aligned, AI left-aligned with gradient avatar */}
        <div class="ask-log" aria-live="polite">
          {messages.length === 0 ? (
            <div class="ask-empty">
              <div class="ask-empty-avatar" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <div>
                <h2 class="ask-empty-title">Ask anything.</h2>
                <p class="ask-empty-sub">
                  Reference files with{" "}
                  <code class="ask-cited">@path/to/file.ext</code>. Drop a
                  diff to review. Ask about GlueCron, your repos, anything.
                </p>
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div class={`ask-msg ask-msg-${m.role}`}>
                {m.role === "assistant" && (
                  <div class="ask-msg-avatar ask-msg-avatar-ai" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2l1.8 5.5L19 9l-4.5 3.5L16 18l-4-3-4 3 1.5-5.5L5 9l5.2-1.5z" />
                    </svg>
                  </div>
                )}
                <div class="ask-msg-bubble-wrap">
                  <div class="ask-msg-role">
                    {m.role === "user" ? "You" : "GlueCron AI"}
                  </div>
                  <div class="ask-msg-bubble">{m.content}</div>
                </div>
                {m.role === "user" && (
                  <div class="ask-msg-avatar ask-msg-avatar-user" aria-hidden="true">
                    {(user?.username || "?").slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Composer: elevated input with gradient submit button */}
        <form method="post" action={postUrl} class="ask-composer">
          <div class="ask-composer-shell">
            <textarea
              class="ask-composer-input"
              name="message"
              placeholder={placeholder}
              required
              autofocus
              rows={3}
            ></textarea>
            <div class="ask-composer-foot">
              <div class="ask-hint">
                <span class="ask-kbd">{"↵"}</span>
                Enter + Ctrl/Cmd to send {"·"} mention files with{" "}
                <code class="ask-cited">@src/file.ts</code>
              </div>
              <button type="submit" class="ask-submit">
                <span>Send</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
          </div>
        </form>

        {recentChats && recentChats.length > 0 && (
          <section class="ask-recent">
            <div class="ask-recent-head">
              <span class="ask-recent-dot" aria-hidden="true" />
              Recent chats
            </div>
            <ul class="ask-recent-list">
              {recentChats.map((ch) => (
                <li class="ask-recent-item">
                  <a class="ask-recent-link" href={`/ask/${ch.id}`}>
                    <span class="ask-recent-title">
                      {ch.title || "(untitled)"}
                    </span>
                    <span class="ask-recent-when">
                      {new Date(ch.updatedAt).toLocaleString()}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Layout>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.ask-*` so it can't bleed into other
 * pages. Mirrors the gradient-hairline + orb hero pattern from
 * admin-integrations / error-page / build-agent-spec.
 * ───────────────────────────────────────────────────────────────────── */
const askCss = `
  .ask-page {
    max-width: 880px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }

  /* Hero */
  .ask-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(24px, 3.5vw, 40px) clamp(24px, 4vw, 40px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .ask-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.78;
    pointer-events: none;
    z-index: 2;
  }
  .ask-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .ask-hero-inner { position: relative; z-index: 1; }

  .ask-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .ask-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .ask-eyebrow-who { color: var(--accent); font-weight: 700; text-transform: none; letter-spacing: 0; font-size: 12.5px; }
  .ask-pill-warn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.10em;
  }

  .ask-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 4vw, 38px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.06;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .ask-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ask-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  /* Chat log */
  .ask-log {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-bottom: var(--space-5);
    min-height: 120px;
  }
  .ask-empty {
    display: flex;
    gap: 14px;
    padding: clamp(24px, 4vw, 36px);
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    align-items: flex-start;
  }
  .ask-empty-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px; height: 36px;
    border-radius: 10px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.10));
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
    flex-shrink: 0;
  }
  .ask-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 4px;
    letter-spacing: -0.012em;
  }
  .ask-empty-sub {
    margin: 0;
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.55;
  }

  /* Message rows: AI on left, user on right */
  .ask-msg {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    max-width: 100%;
  }
  .ask-msg-assistant { justify-content: flex-start; }
  .ask-msg-user { justify-content: flex-end; }
  .ask-msg-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px; height: 32px;
    border-radius: 9999px;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
  }
  .ask-msg-avatar-ai {
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    color: #fff;
    box-shadow: 0 0 0 1px rgba(140,109,255,0.18), 0 6px 18px -6px rgba(140,109,255,0.45);
  }
  .ask-msg-avatar-user {
    background: rgba(255,255,255,0.05);
    color: var(--text-strong);
    box-shadow: inset 0 0 0 1px var(--border-strong, var(--border));
  }
  .ask-msg-bubble-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: min(640px, calc(100% - 48px));
    min-width: 0;
  }
  .ask-msg-user .ask-msg-bubble-wrap { align-items: flex-end; }
  .ask-msg-role {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    padding: 0 2px;
  }
  .ask-msg-bubble {
    padding: 11px 14px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  .ask-msg-assistant .ask-msg-bubble {
    border-top-left-radius: 4px;
    background:
      linear-gradient(180deg, rgba(140,109,255,0.04), transparent 60%),
      var(--bg-elevated);
    border-color: rgba(140,109,255,0.22);
  }
  .ask-msg-user .ask-msg-bubble {
    border-top-right-radius: 4px;
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.20);
    color: var(--text-strong);
  }

  /* Composer */
  .ask-composer { margin-bottom: var(--space-5); }
  .ask-composer-shell {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 16px;
    overflow: hidden;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .ask-composer-shell:focus-within {
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.16);
  }
  .ask-composer-shell::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 30%, rgba(54,197,214,0.45) 70%, transparent 100%);
    opacity: 0.6;
    pointer-events: none;
  }
  .ask-composer-input {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 14px 16px 10px;
    background: transparent;
    border: 0;
    outline: 0;
    resize: vertical;
    min-height: 84px;
    color: var(--text);
    font-family: inherit;
    font-size: 14.5px;
    line-height: 1.55;
  }
  .ask-composer-input::placeholder { color: var(--text-faint, var(--text-muted)); }
  .ask-composer-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    flex-wrap: wrap;
  }
  .ask-hint {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .ask-kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    padding: 1px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .ask-cited {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent);
    background: rgba(140,109,255,0.10);
    border: 1px solid rgba(140,109,255,0.28);
    padding: 1px 6px;
    border-radius: 5px;
  }
  .ask-submit {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    font-size: 13.5px;
    font-weight: 600;
    color: #fff;
    border: 1px solid transparent;
    border-radius: 10px;
    cursor: pointer;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease, box-shadow 120ms ease;
    font-family: inherit;
    line-height: 1;
  }
  .ask-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .ask-submit:active { transform: translateY(0); }

  /* Recent chats */
  .ask-recent {
    margin-top: var(--space-6);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
  }
  .ask-recent-head {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 12px;
  }
  .ask-recent-dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.16);
  }
  .ask-recent-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ask-recent-link {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 9px 10px;
    border-radius: 8px;
    color: var(--text);
    text-decoration: none;
    transition: background 120ms ease, padding-left 120ms ease;
  }
  .ask-recent-link:hover {
    background: rgba(140,109,255,0.06);
    padding-left: 14px;
    text-decoration: none;
  }
  .ask-recent-title {
    flex: 1;
    color: var(--text-strong);
    font-size: 13.5px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ask-recent-when {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .ask-msg-bubble-wrap { max-width: calc(100% - 44px); }
    .ask-composer-foot { gap: 8px; }
    .ask-submit { padding: 8px 14px; font-size: 13px; }
  }
`;

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
