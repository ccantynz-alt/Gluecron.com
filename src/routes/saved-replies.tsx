/**
 * Saved replies — per-user canned comment templates.
 *
 * Routes:
 *   GET  /settings/replies                    list + create form
 *   POST /settings/replies                    create
 *   POST /settings/replies/:id/delete         delete
 *   POST /settings/replies/:id                update
 *   GET  /api/user/replies                    JSON list for the insertion picker
 *
 * 2026 polish: scoped `.sr-*` styles, gradient-hairline hero + orb, card list
 * with shortcut chip + preview + copy/delete actions, "new reply" form in its
 * own card with focus rings + gradient submit. Empty state with orb + helpful
 * CTA. Every form action, POST handler, and validation rule is preserved
 * exactly — this is a pure visual refresh.
 */

import { Hono } from "hono";
import { and, eq, asc } from "drizzle-orm";
import { db } from "../db";
import { savedReplies } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";

const replies = new Hono<AuthEnv>();

replies.use("/settings/replies", requireAuth);
replies.use("/settings/replies/*", requireAuth);
replies.use("/api/user/replies", requireAuth);

function trimBounded(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

async function listForUser(userId: string) {
  try {
    return await db
      .select()
      .from(savedReplies)
      .where(eq(savedReplies.userId, userId))
      .orderBy(asc(savedReplies.shortcut));
  } catch (err) {
    console.error("[saved-replies] list:", err);
    return [];
  }
}

// ─── Scoped CSS (.sr-*) ─────────────────────────────────────────────────────
// Every selector prefixed `.sr-*` so this surface cannot bleed into any
// other page. Mirrors the gradient-hairline hero + card patterns from
// admin-integrations.tsx and settings-2fa.tsx.
const srStyles = `
  .sr-wrap { max-width: 920px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .sr-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .sr-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .sr-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .sr-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .sr-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .sr-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .sr-crumb { color: var(--text-muted); text-decoration: none; }
  .sr-crumb:hover { color: var(--text); }
  .sr-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .sr-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .sr-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  /* ─── Banner ─── */
  .sr-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sr-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .sr-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .sr-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Section card ─── */
  .sr-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .sr-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .sr-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sr-section-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    flex-shrink: 0;
  }
  .sr-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .sr-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Form fields ─── */
  .sr-field { margin-bottom: var(--space-4); }
  .sr-field:last-child { margin-bottom: 0; }
  .sr-field label {
    display: block;
    margin-bottom: 6px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-muted);
  }
  .sr-input,
  .sr-textarea {
    width: 100%;
    padding: 10px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
    font-family: inherit;
  }
  .sr-input {
    font-family: var(--font-mono);
    font-size: 13.5px;
  }
  .sr-textarea {
    font-family: var(--font-mono);
    font-size: 13px;
    resize: vertical;
    min-height: 96px;
  }
  .sr-input:focus,
  .sr-textarea:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .sr-hint {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }

  /* ─── Reply card list ─── */
  .sr-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .sr-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .sr-card[open] {
    border-color: rgba(140,109,255,0.32);
    box-shadow: 0 8px 24px -10px rgba(0,0,0,0.32);
  }
  .sr-card-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .sr-card-summary::-webkit-details-marker { display: none; }
  .sr-shortcut {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.14));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    color: #e9d5ff;
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: -0.005em;
    white-space: nowrap;
  }
  .sr-shortcut::before {
    content: '/';
    color: rgba(255,255,255,0.45);
    margin-right: -2px;
  }
  .sr-preview {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sr-chev {
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform 160ms ease;
  }
  .sr-card[open] .sr-chev { transform: rotate(90deg); }
  .sr-card-body {
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
  }

  /* ─── Buttons ─── */
  .sr-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .sr-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .sr-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .sr-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .sr-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .sr-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .sr-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
  }
  .sr-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: var(--space-3); }

  /* ─── Empty state ─── */
  .sr-empty {
    position: relative;
    padding: 56px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
    overflow: hidden;
  }
  .sr-empty::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .sr-empty-orb {
    width: 96px;
    height: 96px;
    margin: 0 auto 18px;
    border-radius: 9999px;
    background:
      radial-gradient(circle at 35% 35%, rgba(140,109,255,0.55), rgba(54,197,214,0.25) 55%, transparent 75%);
    box-shadow:
      0 0 32px rgba(140,109,255,0.35),
      inset 0 0 0 1px rgba(140,109,255,0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .sr-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .sr-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 auto 18px;
    max-width: 460px;
  }
  .sr-count-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    font-size: 11.5px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    margin-left: 8px;
    vertical-align: middle;
  }
`;

const ReplyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="9 17 4 12 9 7" />
    <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
  </svg>
);

const ChevIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="sr-chev" aria-hidden="true">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const EmptyIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

replies.get("/settings/replies", async (c) => {
  const user = c.get("user")!;
  const rows = await listForUser(user.id);
  const error = c.req.query("error");
  const success = c.req.query("success");

  return c.html(
    <Layout title="Saved replies" user={user}>
      <div class="sr-wrap">
        <section class="sr-hero">
          <div class="sr-hero-orb" aria-hidden="true" />
          <div class="sr-hero-inner">
            <div class="sr-eyebrow">
              <span class="sr-eyebrow-pill" aria-hidden="true">
                <ReplyIcon />
              </span>
              <a href="/settings" class="sr-crumb">Settings</a>
              <span>/</span>
              <span>Saved replies</span>
            </div>
            <h2 class="sr-title">
              <span class="sr-title-grad">Saved replies.</span>
            </h2>
            <p class="sr-sub">
              Canned responses you can drop into any issue or PR comment with a
              shortcut. The shortcut is a nickname only you ever see — pick
              something fast to type.
            </p>
          </div>
        </section>

        {error && (
          <div class="sr-banner is-error" role="alert">
            <span class="sr-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}
        {success && (
          <div class="sr-banner is-ok" role="status">
            <span class="sr-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}

        {/* ─── Create form card ─── */}
        <section class="sr-section">
          <header class="sr-section-head">
            <h3 class="sr-section-title">
              <span class="sr-section-title-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              New saved reply
            </h3>
            <p class="sr-section-sub">
              Pick a shortcut (a-z, 0-9, dashes work great) and write the body
              once — reuse it everywhere.
            </p>
          </header>
          <div class="sr-section-body">
            <form method="post" action="/settings/replies">
              <div class="sr-field">
                <label for="shortcut">Shortcut</label>
                <input
                  type="text"
                  id="shortcut"
                  name="shortcut"
                  required
                  maxLength={64}
                  placeholder="lgtm"
                  class="sr-input"
                />
                <div class="sr-hint">
                  Lowercase, dashes encouraged. Must be unique per account.
                </div>
              </div>
              <div class="sr-field">
                <label for="body">Reply body</label>
                <textarea
                  id="body"
                  name="body"
                  rows={5}
                  required
                  maxLength={4096}
                  placeholder="LGTM! Thanks for the PR."
                  class="sr-textarea"
                />
                <div class="sr-hint">Markdown supported. Up to 4 096 characters.</div>
              </div>
              <button type="submit" class="sr-btn sr-btn-primary">
                Add saved reply
              </button>
            </form>
          </div>
        </section>

        {/* ─── List / empty state ─── */}
        {rows.length === 0 ? (
          <div class="sr-empty">
            <div class="sr-empty-orb" aria-hidden="true">
              <EmptyIcon />
            </div>
            <h2 class="sr-empty-title">No saved replies yet</h2>
            <p class="sr-empty-sub">
              Add a canned response above and it will show up here, ready to
              insert into any issue or PR comment via the reply picker.
            </p>
          </div>
        ) : (
          <section class="sr-section">
            <header class="sr-section-head">
              <h3 class="sr-section-title">
                <span class="sr-section-title-icon" aria-hidden="true">
                  <ReplyIcon />
                </span>
                Your replies
                <span class="sr-count-pill">{rows.length}</span>
              </h3>
              <p class="sr-section-sub">
                Click any reply to edit, copy the body, or delete it.
              </p>
            </header>
            <div class="sr-section-body">
              <ul class="sr-list">
                {rows.map((r) => {
                  const preview = r.body.slice(0, 100).replace(/\n/g, " ");
                  const truncated = r.body.length > 100;
                  return (
                    <li>
                      <details class="sr-card">
                        <summary class="sr-card-summary">
                          <span class="sr-shortcut">{r.shortcut}</span>
                          <span class="sr-preview">
                            {preview}
                            {truncated ? "…" : ""}
                          </span>
                          <ChevIcon />
                        </summary>
                        <div class="sr-card-body">
                          <form method="post" action={`/settings/replies/${r.id}`}>
                            <div class="sr-field">
                              <label>Shortcut</label>
                              <input
                                type="text"
                                name="shortcut"
                                required
                                value={r.shortcut}
                                maxLength={64}
                                aria-label="Shortcut"
                                class="sr-input"
                              />
                            </div>
                            <div class="sr-field">
                              <label>Body</label>
                              <textarea
                                name="body"
                                rows={5}
                                required
                                maxLength={4096}
                                class="sr-textarea"
                              >
                                {r.body}
                              </textarea>
                            </div>
                            <div class="sr-actions">
                              <button type="submit" class="sr-btn sr-btn-primary">
                                Save changes
                              </button>
                              <button
                                type="button"
                                class="sr-btn sr-btn-ghost"
                                data-sr-copy={r.body}
                                title="Copy body to clipboard"
                              >
                                Copy body
                              </button>
                              <button
                                type="submit"
                                formaction={`/settings/replies/${r.id}/delete`}
                                class="sr-btn sr-btn-danger"
                                onclick="return confirm('Delete this saved reply?')"
                              >
                                Delete
                              </button>
                            </div>
                          </form>
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: srStyles }} />
      <script
        dangerouslySetInnerHTML={{
          __html: `
            document.addEventListener('click', function (ev) {
              var t = ev.target;
              if (!(t instanceof HTMLElement)) return;
              var btn = t.closest('[data-sr-copy]');
              if (!btn) return;
              ev.preventDefault();
              var body = btn.getAttribute('data-sr-copy') || '';
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(body).then(function () {
                  var prev = btn.textContent;
                  btn.textContent = 'Copied!';
                  setTimeout(function () { btn.textContent = prev; }, 1400);
                });
              }
            });
          `,
        }}
      />
    </Layout>
  );
});

replies.post("/settings/replies", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const shortcut = trimBounded(String(body.shortcut || ""), 64);
  const text = trimBounded(String(body.body || ""), 4096);
  if (!shortcut || !text) {
    return c.redirect(
      "/settings/replies?error=" + encodeURIComponent("Shortcut and body are required")
    );
  }
  try {
    await db.insert(savedReplies).values({
      userId: user.id,
      shortcut,
      body: text,
    });
  } catch (err: any) {
    if (String(err?.message || err).includes("saved_replies_user_shortcut")) {
      return c.redirect(
        "/settings/replies?error=" +
          encodeURIComponent("You already have a reply with that shortcut")
      );
    }
    console.error("[saved-replies] create:", err);
    return c.redirect(
      "/settings/replies?error=" + encodeURIComponent("Failed to save")
    );
  }
  return c.redirect(
    "/settings/replies?success=" + encodeURIComponent("Reply saved")
  );
});

replies.post("/settings/replies/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const shortcut = trimBounded(String(body.shortcut || ""), 64);
  const text = trimBounded(String(body.body || ""), 4096);
  if (!shortcut || !text) {
    return c.redirect(
      "/settings/replies?error=" + encodeURIComponent("Shortcut and body are required")
    );
  }
  try {
    await db
      .update(savedReplies)
      .set({ shortcut, body: text, updatedAt: new Date() })
      .where(and(eq(savedReplies.id, id), eq(savedReplies.userId, user.id)));
  } catch (err) {
    console.error("[saved-replies] update:", err);
  }
  return c.redirect(
    "/settings/replies?success=" + encodeURIComponent("Reply updated")
  );
});

replies.post("/settings/replies/:id/delete", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    await db
      .delete(savedReplies)
      .where(and(eq(savedReplies.id, id), eq(savedReplies.userId, user.id)));
  } catch (err) {
    console.error("[saved-replies] delete:", err);
  }
  return c.redirect(
    "/settings/replies?success=" + encodeURIComponent("Reply deleted")
  );
});

replies.get("/api/user/replies", async (c) => {
  const user = c.get("user")!;
  const rows = await listForUser(user.id);
  return c.json({
    ok: true,
    replies: rows.map((r) => ({
      id: r.id,
      shortcut: r.shortcut,
      body: r.body,
    })),
  });
});

export default replies;
