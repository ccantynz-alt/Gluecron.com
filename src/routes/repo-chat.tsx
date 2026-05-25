/**
 * AI rubber-duck chat — repo-grounded, streaming, with citations.
 *
 *   GET  /:owner/:repo/chat                    — chat home (new chat shell)
 *   GET  /:owner/:repo/chat/:chatId            — resume an existing thread
 *   POST /:owner/:repo/chat                    — non-streaming form submit
 *                                                 (works with JS disabled)
 *
 * The streaming endpoint lives in `src/routes/api-v2.ts` at
 * `POST /api/v2/repos/:owner/:repo/chat/messages` (SSE) — see that file
 * for the wire format. This route renders the UI shell + handles the
 * no-JS fallback path.
 *
 * RepoNav is locked (`src/views/components.tsx`), so the nav tab for
 * "Chat" isn't wired here — see CLAUDE.md / the locked-components list.
 * The page renders a self-contained header with breadcrumb context
 * back to the repo so users can navigate without the nav tab.
 *
 * Visual recipe (mirrors ask.tsx):
 *   - Gradient hairline strip across the top of the hero (purple→cyan)
 *   - Soft radial orb in the corner
 *   - Display headline with gradient-text on the title
 *   - Left column: previous chats + "new chat" button
 *   - Center column: message thread — user right-aligned, AI left-aligned
 *   - Bottom: composer with focus ring + gradient submit button
 *   - Citations rendered as an expandable "Sources" disclosure under each
 *     assistant bubble.
 *   - Scoped CSS — every class prefixed `.rchat-*`.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import type { RepoChat, RepoChatMessage } from "../db/schema";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";
import { getUnreadCount } from "../lib/unread";
import { isAiAvailable } from "../lib/ai-client";
import {
  appendUserMessage,
  createChat,
  getChatForUser,
  listChatsForRepo,
  listMessages,
  streamAssistantReply,
  type Citation,
} from "../lib/repo-chat";

const repoChatRoutes = new Hono<AuthEnv>();
repoChatRoutes.use("*", softAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRepoForUser(
  owner: string,
  repo: string
): Promise<{ id: string; isPrivate: boolean; ownerId: string } | null> {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        isPrivate: repositories.isPrivate,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

function asCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    if (typeof i.file_path === "string" && typeof i.blob_sha === "string") {
      out.push({ file_path: i.file_path, blob_sha: i.blob_sha });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

repoChatRoutes.get("/:owner/:repo/chat", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();

  const repoRow = await resolveRepoForUser(owner, repo);
  if (!repoRow) return c.notFound();

  const chats = await listChatsForRepo(user.id, repoRow.id);
  const unread = await getUnreadCount(user.id);

  return renderChatPage(c, {
    owner,
    repo,
    user,
    unread,
    chats,
    activeChat: null,
    messages: [],
  });
});

repoChatRoutes.get("/:owner/:repo/chat/:chatId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, chatId } = c.req.param();

  const repoRow = await resolveRepoForUser(owner, repo);
  if (!repoRow) return c.notFound();

  const chat = await getChatForUser(chatId, user.id);
  if (!chat || chat.repositoryId !== repoRow.id) {
    return c.redirect(`/${owner}/${repo}/chat`);
  }

  const [chats, messages, unread] = await Promise.all([
    listChatsForRepo(user.id, repoRow.id),
    listMessages(chatId),
    getUnreadCount(user.id),
  ]);

  return renderChatPage(c, {
    owner,
    repo,
    user,
    unread,
    chats,
    activeChat: chat,
    messages,
  });
});

/**
 * No-JS form submit path. Creates a chat if needed, appends the user
 * message, runs the full stream-and-persist pipeline (we just throw
 * away the chunks here), and redirects to the chat page.
 */
repoChatRoutes.post("/:owner/:repo/chat", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await resolveRepoForUser(owner, repo);
  if (!repoRow) return c.notFound();

  const body = await c.req.parseBody();
  const userMessage = String(body.message || "").trim();
  let chatId = String(body.chat_id || "").trim();

  if (!userMessage) return c.redirect(`/${owner}/${repo}/chat`);

  // Create-if-missing.
  if (!chatId) {
    const created = await createChat({
      repositoryId: repoRow.id,
      ownerUserId: user.id,
      title: userMessage.slice(0, 80),
    });
    if (!created) return c.redirect(`/${owner}/${repo}/chat`);
    chatId = created.id;
  } else {
    const existing = await getChatForUser(chatId, user.id);
    if (!existing || existing.repositoryId !== repoRow.id) {
      return c.redirect(`/${owner}/${repo}/chat`);
    }
  }

  await appendUserMessage(chatId, userMessage);
  // Drain the stream synchronously — UX is a full-page reload here.
  await streamAssistantReply({
    chatId,
    repoId: repoRow.id,
    userMessage,
  });

  return c.redirect(`/${owner}/${repo}/chat/${chatId}`);
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderChatPage(
  c: any,
  args: {
    owner: string;
    repo: string;
    user: any;
    unread: number;
    chats: RepoChat[];
    activeChat: RepoChat | null;
    messages: RepoChatMessage[];
  }
) {
  const { owner, repo, user, unread, chats, activeChat, messages } = args;
  const title = `Chat with ${owner}/${repo}`;
  const postUrl = `/${owner}/${repo}/chat`;
  const streamUrl = `/api/v2/repos/${owner}/${repo}/chat/messages`;

  return c.html(
    <Layout title={title} user={user} notificationCount={unread}>
      <style dangerouslySetInnerHTML={{ __html: rchatCss }} />

      <div class="rchat-page">
        <header class="rchat-hero">
          <div class="rchat-hero-orb" aria-hidden="true" />
          <div class="rchat-hero-inner">
            <div class="rchat-eyebrow">
              <span class="rchat-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              Repo chat {"·"} Claude Sonnet 4 {"·"}{" "}
              <a class="rchat-eyebrow-who" href={`/${owner}/${repo}`}>
                {owner}/{repo}
              </a>
              {!isAiAvailable() && (
                <span class="rchat-pill-warn">
                  AI unavailable {"—"} set ANTHROPIC_API_KEY
                </span>
              )}
            </div>
            <h1 class="rchat-title">
              <span class="rchat-title-grad">Chat with this repo</span>
            </h1>
            <p class="rchat-sub">
              Rubber-duck with Claude. Each answer is grounded in the most
              relevant files surfaced by Gluecron's continuous semantic
              index, and cites the sources it used.
            </p>
          </div>
        </header>

        <div class="rchat-layout">
          {/* Left: chat list + new-chat button */}
          <aside class="rchat-aside">
            <a class="rchat-new" href={`/${owner}/${repo}/chat`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New chat
            </a>
            <div class="rchat-aside-head">
              <span class="rchat-aside-dot" aria-hidden="true" />
              History
            </div>
            <ul class="rchat-aside-list">
              {chats.length === 0 ? (
                <li class="rchat-aside-empty">No chats yet.</li>
              ) : (
                chats.map((ch) => (
                  <li>
                    <a
                      class={`rchat-aside-link${activeChat && activeChat.id === ch.id ? " is-active" : ""}`}
                      href={`/${owner}/${repo}/chat/${ch.id}`}
                    >
                      <span class="rchat-aside-link-title">
                        {ch.title || "(untitled)"}
                      </span>
                      <span class="rchat-aside-link-when">
                        {new Date(ch.updatedAt).toLocaleDateString()}
                      </span>
                    </a>
                  </li>
                ))
              )}
            </ul>
          </aside>

          {/* Center: message thread */}
          <main class="rchat-main">
            <div
              class="rchat-log"
              aria-live="polite"
              id="rchat-log"
              data-stream-url={streamUrl}
              data-chat-id={activeChat ? activeChat.id : ""}
            >
              {messages.length === 0 ? (
                <div class="rchat-empty">
                  <div class="rchat-empty-avatar" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
                  <div>
                    <h2 class="rchat-empty-title">Ask anything about this repo.</h2>
                    <p class="rchat-empty-sub">
                      Try {"\""}where is auth handled?{"\""}, {"\""}why does the
                      post-receive hook fire scripts/self-deploy?{"\""}, or paste a
                      stack trace.
                    </p>
                  </div>
                </div>
              ) : (
                messages.map((m) => (
                  <MessageRow
                    message={m}
                    owner={owner}
                    repo={repo}
                    username={user.username}
                  />
                ))
              )}
            </div>

            {/* Composer */}
            <form method="post" action={postUrl} class="rchat-composer">
              <input
                type="hidden"
                name="chat_id"
                value={activeChat ? activeChat.id : ""}
              />
              <div class="rchat-composer-shell">
                <textarea
                  class="rchat-composer-input"
                  name="message"
                  placeholder={
                    activeChat
                      ? "Continue the conversation..."
                      : `Ask about ${repo}...`
                  }
                  required
                  autofocus
                  rows={3}
                ></textarea>
                <div class="rchat-composer-foot">
                  <div class="rchat-hint">
                    <span class="rchat-kbd">{"⏎"}</span>
                    Enter + Ctrl/Cmd to send {"·"}
                    <span
                      class="rchat-tokens"
                      id="rchat-tokens"
                      data-token-cost="0"
                    >
                      ~0 tokens
                    </span>
                  </div>
                  <button type="submit" class="rchat-submit">
                    <span>Send</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  </button>
                </div>
              </div>
            </form>
          </main>
        </div>
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: rchatClientJs,
        }}
      />
    </Layout>
  );
}

function MessageRow({
  message,
  owner,
  repo,
  username,
}: {
  message: RepoChatMessage;
  owner: string;
  repo: string;
  username: string;
}) {
  const citations = asCitations(message.citations);
  const isUser = message.role === "user";
  return (
    <div class={`rchat-msg rchat-msg-${isUser ? "user" : "assistant"}`}>
      {!isUser && (
        <div class="rchat-msg-avatar rchat-msg-avatar-ai" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l1.8 5.5L19 9l-4.5 3.5L16 18l-4-3-4 3 1.5-5.5L5 9l5.2-1.5z" />
          </svg>
        </div>
      )}
      <div class="rchat-msg-bubble-wrap">
        <div class="rchat-msg-role">
          {isUser ? "You" : "Gluecron AI"}
        </div>
        <div class="rchat-msg-bubble">{message.content}</div>
        {!isUser && citations.length > 0 && (
          <details class="rchat-sources">
            <summary class="rchat-sources-head">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              Sources ({citations.length})
            </summary>
            <ul class="rchat-sources-list">
              {citations.map((c) => (
                <li>
                  <a
                    class="rchat-sources-link"
                    href={`/${owner}/${repo}/blob/HEAD/${c.file_path}`}
                  >
                    {c.file_path}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        {message.tokenCost > 0 && !isUser && (
          <div class="rchat-msg-cost">~{message.tokenCost} tokens</div>
        )}
      </div>
      {isUser && (
        <div class="rchat-msg-avatar rchat-msg-avatar-user" aria-hidden="true">
          {(username || "?").slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scoped CSS — every class prefixed `.rchat-*`.
// ---------------------------------------------------------------------------
const rchatCss = `
  .rchat-page {
    max-width: 1180px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }

  /* Hero */
  .rchat-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(24px, 3.5vw, 40px) clamp(24px, 4vw, 40px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .rchat-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.78;
    pointer-events: none;
    z-index: 2;
  }
  .rchat-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .rchat-hero-inner { position: relative; z-index: 1; }

  .rchat-eyebrow {
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
  .rchat-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .rchat-eyebrow-who {
    color: var(--accent);
    font-weight: 700;
    text-transform: none;
    letter-spacing: 0;
    font-size: 12.5px;
    text-decoration: none;
  }
  .rchat-eyebrow-who:hover { text-decoration: underline; }
  .rchat-pill-warn {
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
  .rchat-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 4vw, 38px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.06;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .rchat-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .rchat-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 720px;
  }

  /* Two-column layout */
  .rchat-layout {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: var(--space-5);
    align-items: start;
  }
  @media (max-width: 880px) {
    .rchat-layout { grid-template-columns: 1fr; }
  }

  /* Aside */
  .rchat-aside {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-3) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 10px;
    position: sticky;
    top: var(--space-3);
  }
  .rchat-new {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    border-radius: 10px;
    text-decoration: none;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .rchat-new:hover { text-decoration: none; transform: translateY(-1px); }
  .rchat-aside-head {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    margin-top: 8px;
  }
  .rchat-aside-dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.16);
  }
  .rchat-aside-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 60vh;
    overflow-y: auto;
  }
  .rchat-aside-empty {
    font-size: 12.5px;
    color: var(--text-muted);
    padding: 8px 10px;
    font-style: italic;
  }
  .rchat-aside-link {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 7px 10px;
    border-radius: 8px;
    color: var(--text);
    text-decoration: none;
    transition: background 120ms ease;
  }
  .rchat-aside-link:hover {
    background: rgba(140,109,255,0.06);
    text-decoration: none;
  }
  .rchat-aside-link.is-active {
    background: rgba(140,109,255,0.10);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.22);
  }
  .rchat-aside-link-title {
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .rchat-aside-link-when {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* Main */
  .rchat-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  .rchat-log {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 240px;
  }
  .rchat-empty {
    display: flex;
    gap: 14px;
    padding: clamp(24px, 4vw, 36px);
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    align-items: flex-start;
  }
  .rchat-empty-avatar {
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
  .rchat-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 4px;
    letter-spacing: -0.012em;
  }
  .rchat-empty-sub {
    margin: 0;
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.55;
  }

  /* Messages */
  .rchat-msg {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    max-width: 100%;
  }
  .rchat-msg-assistant { justify-content: flex-start; }
  .rchat-msg-user { justify-content: flex-end; }
  .rchat-msg-avatar {
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
  .rchat-msg-avatar-ai {
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    color: #fff;
    box-shadow: 0 0 0 1px rgba(140,109,255,0.18), 0 6px 18px -6px rgba(140,109,255,0.45);
  }
  .rchat-msg-avatar-user {
    background: rgba(255,255,255,0.05);
    color: var(--text-strong);
    box-shadow: inset 0 0 0 1px var(--border-strong, var(--border));
  }
  .rchat-msg-bubble-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: min(700px, calc(100% - 48px));
    min-width: 0;
  }
  .rchat-msg-user .rchat-msg-bubble-wrap { align-items: flex-end; }
  .rchat-msg-role {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    padding: 0 2px;
  }
  .rchat-msg-bubble {
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
  .rchat-msg-assistant .rchat-msg-bubble {
    border-top-left-radius: 4px;
    background:
      linear-gradient(180deg, rgba(140,109,255,0.04), transparent 60%),
      var(--bg-elevated);
    border-color: rgba(140,109,255,0.22);
  }
  .rchat-msg-user .rchat-msg-bubble {
    border-top-right-radius: 4px;
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.20);
    color: var(--text-strong);
  }
  .rchat-msg-cost {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    padding: 0 2px;
  }

  /* Sources disclosure */
  .rchat-sources {
    margin-top: 4px;
  }
  .rchat-sources-head {
    cursor: pointer;
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
    font-weight: 700;
    padding: 4px 8px;
    border-radius: 8px;
    background: rgba(140,109,255,0.05);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.18);
  }
  .rchat-sources-head::-webkit-details-marker { display: none; }
  .rchat-sources-head:hover {
    background: rgba(140,109,255,0.08);
  }
  .rchat-sources-list {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rchat-sources-link {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 6px;
    color: var(--accent);
    text-decoration: none;
  }
  .rchat-sources-link:hover {
    background: rgba(140,109,255,0.08);
    text-decoration: none;
  }

  /* Composer */
  .rchat-composer {}
  .rchat-composer-shell {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 16px;
    overflow: hidden;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .rchat-composer-shell:focus-within {
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.16);
  }
  .rchat-composer-shell::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 30%, rgba(54,197,214,0.45) 70%, transparent 100%);
    opacity: 0.6;
    pointer-events: none;
  }
  .rchat-composer-input {
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
  .rchat-composer-input::placeholder { color: var(--text-faint, var(--text-muted)); }
  .rchat-composer-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    flex-wrap: wrap;
  }
  .rchat-hint {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .rchat-kbd {
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
  .rchat-tokens {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .rchat-submit {
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
  .rchat-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .rchat-submit:active { transform: translateY(0); }

  @media (max-width: 640px) {
    .rchat-msg-bubble-wrap { max-width: calc(100% - 44px); }
    .rchat-composer-foot { gap: 8px; }
    .rchat-submit { padding: 8px 14px; font-size: 13px; }
  }
`;

// ---------------------------------------------------------------------------
// Client-side enhancement — token estimator + Ctrl/Cmd+Enter submit.
// (Streaming UX is intentionally tiny here — the real-time bubble append
// can land in a follow-up that wires the SSE endpoint to a fetch reader.)
// ---------------------------------------------------------------------------
const rchatClientJs = `
(function(){
  var input = document.querySelector('.rchat-composer-input');
  var tokensEl = document.getElementById('rchat-tokens');
  if (input && tokensEl) {
    var update = function(){
      var n = Math.ceil((input.value || '').length / 4);
      tokensEl.textContent = '~' + n + ' tokens';
      tokensEl.setAttribute('data-token-cost', String(n));
    };
    input.addEventListener('input', update);
    update();
  }
  // Cmd/Ctrl+Enter submits the composer.
  if (input) {
    input.addEventListener('keydown', function(e){
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        var form = input.form;
        if (form) form.submit();
      }
    });
  }
})();
`;

export default repoChatRoutes;
