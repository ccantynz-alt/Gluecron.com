/**
 * Personal cross-repo Claude chat — `/chat` (user-scoped, no repo
 * segment in the URL).
 *
 * Sibling of `src/routes/repo-chat.tsx`. The crucial difference: this
 * route never resolves a single repo — the user just opens `/chat` and
 * Claude can pull context from any repo the user owns OR is an accepted
 * collaborator on. Retrieval is gated on
 * `users.personal_semantic_index_enabled`; when off, the page shows an
 * opt-in banner instead of a composer.
 *
 *   GET  /chat                    — chat home (new chat shell)
 *   GET  /chat/:chatId            — resume an existing thread
 *   POST /chat                    — no-JS fallback form submit
 *   POST /settings/personal-semantic-toggle — flip the opt-in flag
 *
 * The streaming endpoint lives at `POST /api/v2/me/chat/messages` in
 * `src/routes/api-v2.ts`.
 *
 * Visual recipe (mirrors `rchat-*` but namespaced `pchat-*`):
 *   - Gradient hairline strip on the hero
 *   - Soft radial orb in the corner
 *   - Opt-in banner with a polished toggle if disabled
 *   - History sidebar + threaded log + composer with focus ring
 *   - Citations show `owner/repo · path` so the user knows which repo
 *     the snippet came from
 *   - "Cross-repo citation" caution banner on each assistant bubble whose
 *     citations span multiple repos — small reminder to be mindful when
 *     screen-sharing.
 *   - Scoped CSS — every class prefixed `.pchat-*`.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import type { PersonalChat, PersonalChatMessage } from "../db/schema";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";
import { getUnreadCount } from "../lib/unread";
import { isAiAvailable } from "../lib/ai-client";
import { audit } from "../lib/notify";
import {
  appendPersonalUserMessage,
  createPersonalChat,
  getPersonalChatForUser,
  listPersonalChatsForUser,
  listPersonalMessages,
  streamPersonalAssistantReply,
} from "../lib/personal-chat";
import {
  isPersonalSemanticEnabled,
  setPersonalSemanticEnabled,
} from "../lib/personal-semantic";

const personalChatRoutes = new Hono<AuthEnv>();
personalChatRoutes.use("*", softAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CitationShape {
  file_path: string;
  blob_sha: string;
  repo_name: string;
}

function asPersonalCitations(raw: unknown): CitationShape[] {
  if (!Array.isArray(raw)) return [];
  const out: CitationShape[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    if (
      typeof i.file_path === "string" &&
      typeof i.blob_sha === "string" &&
      typeof i.repo_name === "string"
    ) {
      out.push({
        file_path: i.file_path,
        blob_sha: i.blob_sha,
        repo_name: i.repo_name,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

personalChatRoutes.get("/chat", requireAuth, async (c) => {
  const user = c.get("user")!;
  const [chats, unread, enabled] = await Promise.all([
    listPersonalChatsForUser(user.id),
    getUnreadCount(user.id),
    isPersonalSemanticEnabled(user.id),
  ]);
  return renderPersonalChatPage(c, {
    user,
    unread,
    chats,
    activeChat: null,
    messages: [],
    enabled,
  });
});

personalChatRoutes.get("/chat/:chatId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { chatId } = c.req.param();
  const chat = await getPersonalChatForUser(chatId, user.id);
  if (!chat) {
    return c.redirect("/chat");
  }
  const [chats, messages, unread, enabled] = await Promise.all([
    listPersonalChatsForUser(user.id),
    listPersonalMessages(chatId),
    getUnreadCount(user.id),
    isPersonalSemanticEnabled(user.id),
  ]);
  return renderPersonalChatPage(c, {
    user,
    unread,
    chats,
    activeChat: chat,
    messages,
    enabled,
  });
});

/**
 * No-JS POST fallback. Creates a chat if needed, appends the user
 * message, drains the assistant stream synchronously, and redirects.
 */
personalChatRoutes.post("/chat", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const userMessage = String(body.message || "").trim();
  let chatId = String(body.chat_id || "").trim();
  if (!userMessage) return c.redirect("/chat");

  // Hard refusal when the opt-in flag is off — we don't even create a
  // chat row in this state. The page already shows a banner explaining
  // why; this is the no-JS equivalent.
  const enabled = await isPersonalSemanticEnabled(user.id);
  if (!enabled) {
    return c.redirect("/chat?error=opt-in-required");
  }

  if (!chatId) {
    const created = await createPersonalChat({
      ownerUserId: user.id,
      title: userMessage.slice(0, 80),
    });
    if (!created) return c.redirect("/chat");
    chatId = created.id;
  } else {
    const existing = await getPersonalChatForUser(chatId, user.id);
    if (!existing) return c.redirect("/chat");
  }

  await appendPersonalUserMessage(chatId, userMessage);
  await streamPersonalAssistantReply({
    chatId,
    userId: user.id,
    userMessage,
  });

  // Per-message audit log — privacy requirement.
  void audit({
    userId: user.id,
    action: "ai.personal.chat",
    targetType: "personal_chat",
    targetId: chatId,
    ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip"),
    userAgent: c.req.header("user-agent"),
    metadata: { surface: "no-js" },
  });

  return c.redirect(`/chat/${chatId}`);
});

/**
 * Flip the opt-in flag. Audited under `ai.personal.toggle`.
 */
personalChatRoutes.post(
  "/settings/personal-semantic-toggle",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const requested = String(body.enabled || "").toLowerCase();
    const enable = requested === "true" || requested === "1" || requested === "on";

    const newValue = await setPersonalSemanticEnabled(user.id, enable);

    void audit({
      userId: user.id,
      action: "ai.personal.toggle",
      targetType: "user",
      targetId: user.id,
      ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip"),
      userAgent: c.req.header("user-agent"),
      metadata: { enabled: !!newValue, requested },
    });

    const redirectTo = String(body.redirect || "/chat");
    return c.redirect(
      redirectTo +
        (redirectTo.includes("?") ? "&" : "?") +
        (newValue ? "success=personal-semantic-enabled" : "success=personal-semantic-disabled")
    );
  }
);

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderPersonalChatPage(
  c: any,
  args: {
    user: any;
    unread: number;
    chats: PersonalChat[];
    activeChat: PersonalChat | null;
    messages: PersonalChatMessage[];
    enabled: boolean;
  }
) {
  const { user, unread, chats, activeChat, messages, enabled } = args;
  const title = "Personal chat";
  const postUrl = "/chat";
  const streamUrl = "/api/v2/me/chat/messages";
  const showError = c.req.query("error") === "opt-in-required";

  return c.html(
    <Layout title={title} user={user} notificationCount={unread}>
      <style dangerouslySetInnerHTML={{ __html: pchatCss }} />

      <div class="pchat-page">
        <header class="pchat-hero">
          <div class="pchat-hero-orb" aria-hidden="true" />
          <div class="pchat-hero-inner">
            <div class="pchat-eyebrow">
              <span class="pchat-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              Personal chat {"·"} Claude Sonnet 4 {"·"}{" "}
              <a class="pchat-eyebrow-who" href={`/${user.username}`}>
                {user.username}
              </a>
              {!isAiAvailable() && (
                <span class="pchat-pill-warn">
                  AI unavailable {"—"} set ANTHROPIC_API_KEY
                </span>
              )}
            </div>
            <h1 class="pchat-title">
              <span class="pchat-title-grad">Chat across all your code</span>
            </h1>
            <p class="pchat-sub">
              Ask Claude anything. Answers are grounded in the continuous
              semantic index across every repo you own or collaborate on,
              and citations name the source repo alongside the file path.
            </p>
          </div>
        </header>

        {/* Opt-in banner — only when the flag is OFF */}
        {!enabled && (
          <section class="pchat-optin" role="region" aria-label="Opt-in required">
            <div class="pchat-optin-head">
              <span class="pchat-optin-dot" aria-hidden="true" />
              <h2 class="pchat-optin-title">Enable personal semantic index</h2>
            </div>
            <p class="pchat-optin-body">
              Personal chat is <strong>off by default</strong>. When you
              enable it, Claude can search the continuous semantic index
              across every repo you own and every repo you've been accepted
              as a collaborator on. You can turn it off at any time and we
              stop touching your data from this surface immediately.
            </p>
            <form
              method="post"
              action="/settings/personal-semantic-toggle"
              class="pchat-optin-form"
            >
              <input type="hidden" name="enabled" value="true" />
              <input type="hidden" name="redirect" value="/chat" />
              <button type="submit" class="pchat-optin-btn">
                Enable personal cross-repo chat
              </button>
              <a class="pchat-optin-learn" href="/settings">
                Manage in settings
              </a>
            </form>
          </section>
        )}

        {showError && (
          <div class="pchat-toast" role="alert">
            Enable personal cross-repo chat below before sending messages.
          </div>
        )}

        <div class="pchat-layout">
          <aside class="pchat-aside">
            <a class="pchat-new" href="/chat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New chat
            </a>
            <div class="pchat-aside-head">
              <span class="pchat-aside-dot" aria-hidden="true" />
              History
            </div>
            <ul class="pchat-aside-list">
              {chats.length === 0 ? (
                <li class="pchat-aside-empty">No chats yet.</li>
              ) : (
                chats.map((ch) => (
                  <li>
                    <a
                      class={`pchat-aside-link${activeChat && activeChat.id === ch.id ? " is-active" : ""}`}
                      href={`/chat/${ch.id}`}
                    >
                      <span class="pchat-aside-link-title">
                        {ch.title || "(untitled)"}
                      </span>
                      <span class="pchat-aside-link-when">
                        {new Date(ch.updatedAt).toLocaleDateString()}
                      </span>
                    </a>
                  </li>
                ))
              )}
            </ul>

            {enabled && (
              <form
                method="post"
                action="/settings/personal-semantic-toggle"
                class="pchat-aside-toggle"
              >
                <input type="hidden" name="enabled" value="false" />
                <input type="hidden" name="redirect" value="/chat" />
                <button type="submit" class="pchat-aside-toggle-btn">
                  Disable personal index
                </button>
              </form>
            )}
          </aside>

          <main class="pchat-main">
            <div
              class="pchat-log"
              aria-live="polite"
              id="pchat-log"
              data-stream-url={streamUrl}
              data-chat-id={activeChat ? activeChat.id : ""}
            >
              {messages.length === 0 ? (
                <div class="pchat-empty">
                  <div class="pchat-empty-avatar" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
                  <div>
                    <h2 class="pchat-empty-title">
                      {enabled
                        ? "Ask anything across all your repos."
                        : "Enable personal chat to ask anything across all your repos."}
                    </h2>
                    <p class="pchat-empty-sub">
                      {enabled
                        ? `Try "where do we handle webhook retries?", "what's the audit-log shape across these projects?", or paste a stack trace.`
                        : "When enabled, Claude can search every repo you own or collaborate on. Off until you say so."}
                    </p>
                  </div>
                </div>
              ) : (
                messages.map((m) => (
                  <PersonalMessageRow message={m} username={user.username} />
                ))
              )}
            </div>

            <form method="post" action={postUrl} class="pchat-composer">
              <input
                type="hidden"
                name="chat_id"
                value={activeChat ? activeChat.id : ""}
              />
              <div class="pchat-composer-shell">
                <textarea
                  class="pchat-composer-input"
                  name="message"
                  placeholder={
                    enabled
                      ? activeChat
                        ? "Continue the conversation..."
                        : "Ask across all your code..."
                      : "Enable personal chat above to start asking."
                  }
                  required
                  autofocus
                  rows={3}
                  disabled={!enabled}
                ></textarea>
                <div class="pchat-composer-foot">
                  <div class="pchat-hint">
                    <span class="pchat-kbd">{"⏎"}</span>
                    Enter + Ctrl/Cmd to send {"·"}
                    <span
                      class="pchat-tokens"
                      id="pchat-tokens"
                      data-token-cost="0"
                    >
                      ~0 tokens
                    </span>
                  </div>
                  <button type="submit" class="pchat-submit" disabled={!enabled}>
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
          __html: pchatClientJs,
        }}
      />
    </Layout>
  );
}

function PersonalMessageRow({
  message,
  username,
}: {
  message: PersonalChatMessage;
  username: string;
}) {
  const citations = asPersonalCitations(message.citations);
  const isUser = message.role === "user";
  const distinctRepos = new Set(citations.map((c) => c.repo_name));
  const crossRepo = distinctRepos.size > 1;

  return (
    <div class={`pchat-msg pchat-msg-${isUser ? "user" : "assistant"}`}>
      {!isUser && (
        <div class="pchat-msg-avatar pchat-msg-avatar-ai" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l1.8 5.5L19 9l-4.5 3.5L16 18l-4-3-4 3 1.5-5.5L5 9l5.2-1.5z" />
          </svg>
        </div>
      )}
      <div class="pchat-msg-bubble-wrap">
        <div class="pchat-msg-role">
          {isUser ? "You" : "Gluecron AI"}
        </div>
        <div class="pchat-msg-bubble">{message.content}</div>
        {!isUser && crossRepo && (
          <div class="pchat-caution" role="note">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Citations span {distinctRepos.size} repos — redact when
            screen-sharing.
          </div>
        )}
        {!isUser && citations.length > 0 && (
          <details class="pchat-sources">
            <summary class="pchat-sources-head">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              Sources ({citations.length})
            </summary>
            <ul class="pchat-sources-list">
              {citations.map((cit) => (
                <li>
                  <a
                    class="pchat-sources-link"
                    href={`/${cit.repo_name}/blob/HEAD/${cit.file_path}`}
                  >
                    <span class="pchat-sources-repo">{cit.repo_name}</span>
                    <span class="pchat-sources-sep">{" · "}</span>
                    <span class="pchat-sources-path">{cit.file_path}</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        {message.tokenCost > 0 && !isUser && (
          <div class="pchat-msg-cost">~{message.tokenCost} tokens</div>
        )}
      </div>
      {isUser && (
        <div class="pchat-msg-avatar pchat-msg-avatar-user" aria-hidden="true">
          {(username || "?").slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Touch: expose `isPersonalSemanticEnabled` via a tiny inline helper so
// the user menu can decide whether to badge the "Personal chat" link.
// We keep this lib-export here (not in a separate util) so the route file
// + the layout's user-menu snippet (locked) don't have to import a new
// module just to read a single bool.
// ---------------------------------------------------------------------------
export async function readPersonalSemanticFlag(userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ enabled: users.personalSemanticIndexEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return !!row?.enabled;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scoped CSS — every class prefixed `.pchat-*`.
// ---------------------------------------------------------------------------
const pchatCss = `
  .pchat-page {
    max-width: 1180px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }

  .pchat-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(24px, 3.5vw, 40px) clamp(24px, 4vw, 40px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .pchat-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.78;
    pointer-events: none;
    z-index: 2;
  }
  .pchat-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .pchat-hero-inner { position: relative; z-index: 1; }

  .pchat-eyebrow {
    display: inline-flex; align-items: center; gap: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .pchat-eyebrow-pill {
    display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .pchat-eyebrow-who {
    color: var(--accent);
    font-weight: 700;
    text-transform: none;
    letter-spacing: 0;
    font-size: 12.5px;
    text-decoration: none;
  }
  .pchat-eyebrow-who:hover { text-decoration: underline; }
  .pchat-pill-warn {
    display: inline-flex; align-items: center; gap: 6px;
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
  .pchat-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 4vw, 38px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.06;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .pchat-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .pchat-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 720px;
  }

  /* Opt-in banner */
  .pchat-optin {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: linear-gradient(180deg, rgba(140,109,255,0.06), rgba(54,197,214,0.02));
    border: 1px solid rgba(140,109,255,0.30);
    border-radius: 14px;
  }
  .pchat-optin-head {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 8px;
  }
  .pchat-optin-dot {
    width: 9px; height: 9px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.20);
  }
  .pchat-optin-title {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
    letter-spacing: -0.012em;
  }
  .pchat-optin-body {
    margin: 0 0 14px;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
    max-width: 720px;
  }
  .pchat-optin-form {
    display: inline-flex; align-items: center; gap: 14px;
    flex-wrap: wrap;
  }
  .pchat-optin-btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 9px 16px;
    font-size: 13.5px;
    font-weight: 600;
    color: #fff;
    border: 1px solid transparent;
    border-radius: 10px;
    cursor: pointer;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    font-family: inherit;
    line-height: 1;
  }
  .pchat-optin-btn:hover { transform: translateY(-1px); }
  .pchat-optin-learn {
    font-size: 12.5px;
    color: var(--text-muted);
    text-decoration: none;
  }
  .pchat-optin-learn:hover { color: var(--accent); }

  .pchat-toast {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    border: 1px solid rgba(251,191,36,0.30);
    font-size: 13px;
  }

  .pchat-layout {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: var(--space-5);
    align-items: start;
  }
  @media (max-width: 880px) {
    .pchat-layout { grid-template-columns: 1fr; }
  }

  .pchat-aside {
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
  .pchat-new {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 9px 12px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    border-radius: 10px;
    text-decoration: none;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .pchat-new:hover { text-decoration: none; transform: translateY(-1px); }
  .pchat-aside-head {
    display: inline-flex; align-items: center; gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    margin-top: 8px;
  }
  .pchat-aside-dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.16);
  }
  .pchat-aside-list {
    list-style: none; padding: 0; margin: 0;
    display: flex; flex-direction: column; gap: 2px;
    max-height: 50vh; overflow-y: auto;
  }
  .pchat-aside-empty {
    font-size: 12.5px;
    color: var(--text-muted);
    padding: 8px 10px;
    font-style: italic;
  }
  .pchat-aside-link {
    display: flex; flex-direction: column; gap: 2px;
    padding: 7px 10px;
    border-radius: 8px;
    color: var(--text);
    text-decoration: none;
    transition: background 120ms ease;
  }
  .pchat-aside-link:hover {
    background: rgba(140,109,255,0.06);
    text-decoration: none;
  }
  .pchat-aside-link.is-active {
    background: rgba(140,109,255,0.10);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.22);
  }
  .pchat-aside-link-title {
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  .pchat-aside-link-when {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .pchat-aside-toggle {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed var(--border);
  }
  .pchat-aside-toggle-btn {
    width: 100%;
    padding: 7px 10px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  .pchat-aside-toggle-btn:hover {
    color: var(--text);
    border-color: var(--border-strong, var(--border));
  }

  .pchat-main { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .pchat-log { display: flex; flex-direction: column; gap: 14px; min-height: 240px; }
  .pchat-empty {
    display: flex; gap: 14px;
    padding: clamp(24px, 4vw, 36px);
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    align-items: flex-start;
  }
  .pchat-empty-avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px;
    border-radius: 10px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.10));
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
    flex-shrink: 0;
  }
  .pchat-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 4px;
    letter-spacing: -0.012em;
  }
  .pchat-empty-sub {
    margin: 0;
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.55;
  }

  .pchat-msg { display: flex; gap: 10px; align-items: flex-start; max-width: 100%; }
  .pchat-msg-assistant { justify-content: flex-start; }
  .pchat-msg-user { justify-content: flex-end; }
  .pchat-msg-avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px;
    border-radius: 9999px;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
  }
  .pchat-msg-avatar-ai {
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    color: #fff;
    box-shadow: 0 0 0 1px rgba(140,109,255,0.18), 0 6px 18px -6px rgba(140,109,255,0.45);
  }
  .pchat-msg-avatar-user {
    background: rgba(255,255,255,0.05);
    color: var(--text-strong);
    box-shadow: inset 0 0 0 1px var(--border-strong, var(--border));
  }
  .pchat-msg-bubble-wrap {
    display: flex; flex-direction: column; gap: 4px;
    max-width: min(700px, calc(100% - 48px));
    min-width: 0;
  }
  .pchat-msg-user .pchat-msg-bubble-wrap { align-items: flex-end; }
  .pchat-msg-role {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    padding: 0 2px;
  }
  .pchat-msg-bubble {
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
  .pchat-msg-assistant .pchat-msg-bubble {
    border-top-left-radius: 4px;
    background:
      linear-gradient(180deg, rgba(140,109,255,0.04), transparent 60%),
      var(--bg-elevated);
    border-color: rgba(140,109,255,0.22);
  }
  .pchat-msg-user .pchat-msg-bubble {
    border-top-right-radius: 4px;
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.20);
    color: var(--text-strong);
  }
  .pchat-msg-cost {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    padding: 0 2px;
  }

  .pchat-caution {
    display: inline-flex; align-items: center; gap: 6px;
    margin-top: 2px;
    padding: 4px 10px;
    border-radius: 8px;
    background: rgba(251,191,36,0.08);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.22);
    font-size: 11.5px;
    line-height: 1.4;
  }

  .pchat-sources { margin-top: 4px; }
  .pchat-sources-head {
    cursor: pointer;
    list-style: none;
    display: inline-flex; align-items: center; gap: 6px;
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
  .pchat-sources-head::-webkit-details-marker { display: none; }
  .pchat-sources-head:hover { background: rgba(140,109,255,0.08); }
  .pchat-sources-list {
    list-style: none; margin: 6px 0 0; padding: 0;
    display: flex; flex-direction: column; gap: 2px;
  }
  .pchat-sources-link {
    display: inline-flex; align-items: baseline; gap: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 6px;
    color: var(--accent);
    text-decoration: none;
  }
  .pchat-sources-link:hover {
    background: rgba(140,109,255,0.08);
    text-decoration: none;
  }
  .pchat-sources-repo {
    color: #b69dff;
    font-weight: 700;
  }
  .pchat-sources-sep { color: var(--text-muted); }
  .pchat-sources-path { color: var(--accent); }

  .pchat-composer-shell {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 16px;
    overflow: hidden;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .pchat-composer-shell:focus-within {
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.16);
  }
  .pchat-composer-shell::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 30%, rgba(54,197,214,0.45) 70%, transparent 100%);
    opacity: 0.6;
    pointer-events: none;
  }
  .pchat-composer-input {
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
  .pchat-composer-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .pchat-composer-input::placeholder { color: var(--text-faint, var(--text-muted)); }
  .pchat-composer-foot {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    flex-wrap: wrap;
  }
  .pchat-hint {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .pchat-kbd {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 22px;
    padding: 1px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .pchat-tokens {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .pchat-submit {
    display: inline-flex; align-items: center; gap: 8px;
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
  .pchat-submit:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .pchat-submit:disabled { opacity: 0.55; cursor: not-allowed; }
  .pchat-submit:active { transform: translateY(0); }

  /* Floating "Personal chat" link — surfaced because the global nav user
   * menu is a locked component (src/views/layout.tsx) we can't modify in
   * this block. The link is fixed bottom-right; visible only on / and
   * dashboard-style pages to keep it discoverable without ever overlapping
   * the chat surface itself.
   */
  .pchat-floating-link {
    position: fixed;
    bottom: 24px; right: 24px;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 600;
    color: #fff;
    border-radius: 9999px;
    text-decoration: none;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    box-shadow: 0 10px 28px -8px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.16);
    z-index: 90;
  }

  @media (max-width: 640px) {
    .pchat-msg-bubble-wrap { max-width: calc(100% - 44px); }
    .pchat-composer-foot { gap: 8px; }
    .pchat-submit { padding: 8px 14px; font-size: 13px; }
  }
`;

const pchatClientJs = `
(function(){
  var input = document.querySelector('.pchat-composer-input');
  var tokensEl = document.getElementById('pchat-tokens');
  if (input && tokensEl) {
    var update = function(){
      var n = Math.ceil((input.value || '').length / 4);
      tokensEl.textContent = '~' + n + ' tokens';
      tokensEl.setAttribute('data-token-cost', String(n));
    };
    input.addEventListener('input', update);
    update();
  }
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

export default personalChatRoutes;
