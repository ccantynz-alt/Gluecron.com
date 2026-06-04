/**
 * Webhooks management — register, list, delete, test.
 *
 * 2026 polish:
 *   - Page-level eyebrow + display headline + subtitle (the settings layout
 *     already supplies the polished sidebar, so we don't render a hero block).
 *   - Each webhook is a card showing URL (mono), event chips, created
 *     timestamp (tabular-nums, relative), status pill, last-delivery dot.
 *   - Add-new form is its own card with focus rings + primary gradient submit.
 *   - Empty state is a dashed card with an orb + helpful CTA copy.
 *   - All CSS scoped under `.wh-*` to avoid bleed into other surfaces.
 *
 * Hard rules preserved:
 *   - Every route, form action, POST/DELETE handler, and DB query is
 *     unchanged. Only the rendered HTML/CSS changes.
 *   - The shared Layout / settings sidebar / ui.tsx components are not
 *     modified — the polish happens inside the page body only.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { webhooks, repositories, users } from "../db/schema";
import {
  enqueueWebhookDelivery,
  drainPendingDeliveries,
} from "../lib/webhook-delivery";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";

const webhookRoutes = new Hono<AuthEnv>();

webhookRoutes.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.wh-` so this page can't bleed into
 * other settings surfaces. Mirrors the section-card + traffic-light
 * patterns from admin-integrations.tsx and admin-ops.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const webhookStyles = `
  .wh-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Page heading (no hero — settings sidebar already supplies it) ─── */
  .wh-head { margin-bottom: var(--space-5); }
  .wh-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
  }
  .wh-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .wh-title {
    font-size: clamp(24px, 3.2vw, 32px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.024em;
    line-height: 1.08;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .wh-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .wh-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .wh-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }

  /* ─── Banners ─── */
  .wh-banner {
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
  .wh-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .wh-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .wh-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── List of hooks (cards) ─── */
  .wh-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .wh-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .wh-card:hover {
    border-color: var(--border-strong);
  }
  .wh-card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .wh-card-id { flex: 1; min-width: 200px; }
  .wh-card-url {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    word-break: break-all;
    overflow-wrap: anywhere;
    font-weight: 600;
    line-height: 1.45;
    display: block;
  }
  .wh-card-meta {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .wh-time {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* ─── Status pill (active / inactive) ─── */
  .wh-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .wh-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }
  .wh-pill.is-active {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .wh-pill.is-disabled {
    background: rgba(107,114,128,0.16);
    color: #d1d5db;
    box-shadow: inset 0 0 0 1px rgba(107,114,128,0.32);
  }

  /* ─── Event chips ─── */
  .wh-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .wh-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.10);
    border: 1px solid rgba(140,109,255,0.30);
    color: #c4b5fd;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font-mono);
    letter-spacing: -0.005em;
  }

  /* ─── Last-delivery dot + status row ─── */
  .wh-delivery {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 11.5px;
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .wh-delivery .dot {
    width: 7px; height: 7px;
    border-radius: 9999px;
    background: #6b7280;
    box-shadow: 0 0 0 2px rgba(107,114,128,0.16);
  }
  .wh-delivery.is-ok { color: #6ee7b7; border-color: rgba(52,211,153,0.35); }
  .wh-delivery.is-ok .dot {
    background: #34d399;
    box-shadow: 0 0 0 2px rgba(52,211,153,0.22), 0 0 6px rgba(52,211,153,0.40);
  }
  .wh-delivery.is-bad { color: #fca5a5; border-color: rgba(248,113,113,0.35); }
  .wh-delivery.is-bad .dot {
    background: #f87171;
    box-shadow: 0 0 0 2px rgba(248,113,113,0.22), 0 0 6px rgba(248,113,113,0.40);
  }
  .wh-delivery.is-pending { color: var(--text-muted); }

  /* ─── Card actions ─── */
  .wh-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .wh-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    font-size: 12.5px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    text-decoration: none;
    border: 1px solid transparent;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
  }
  .wh-btn-ghost {
    background: rgba(255,255,255,0.03);
    border-color: var(--border);
    color: var(--text);
  }
  .wh-btn-ghost:hover {
    background: rgba(255,255,255,0.06);
    border-color: var(--border-strong);
    color: var(--text-strong);
  }
  .wh-btn-danger {
    background: rgba(248,113,113,0.08);
    border-color: rgba(248,113,113,0.30);
    color: #fca5a5;
  }
  .wh-btn-danger:hover {
    background: rgba(248,113,113,0.14);
    border-color: rgba(248,113,113,0.50);
    color: #fecaca;
  }
  .wh-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #6d4ee0 100%);
    color: #ffffff;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45);
  }
  .wh-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.55);
  }
  .wh-card-foot-form { margin: 0; }

  /* ─── Empty state (dashed) ─── */
  .wh-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    margin-bottom: var(--space-5);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
    background: rgba(255,255,255,0.02);
    text-align: center;
    overflow: hidden;
  }
  .wh-empty-orb {
    position: absolute;
    inset: -40% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.6;
    pointer-events: none;
    z-index: 0;
  }
  .wh-empty-inner { position: relative; z-index: 1; }
  .wh-empty-title {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    letter-spacing: -0.018em;
  }
  .wh-empty-sub {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0 auto;
    max-width: 460px;
    line-height: 1.5;
  }

  /* ─── Add-new form (its own card) ─── */
  .wh-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .wh-form-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .wh-form-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .wh-form-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .wh-form-body { padding: var(--space-4) var(--space-5); }
  .wh-field { margin-bottom: var(--space-4); }
  .wh-field:last-of-type { margin-bottom: 0; }
  .wh-label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.005em;
  }
  .wh-input {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .wh-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .wh-events {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .wh-evt-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border-strong);
    font-size: 12.5px;
    color: var(--text);
    cursor: pointer;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, background 120ms ease;
  }
  .wh-evt-label:hover { border-color: rgba(140,109,255,0.45); }
  .wh-evt-label input { accent-color: #8c6dff; cursor: pointer; }
  .wh-form-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
`;

/** Render a relative time like "12s ago", "3m ago", "2h ago", "3d ago". */
function whRelativeTime(from: Date | null, now: Date = new Date()): string {
  if (!from) return "—";
  const ms = now.getTime() - new Date(from).getTime();
  if (ms < 5_000) return "just now";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// List webhooks
webhookRoutes.get(
  "/:owner/:repo/settings/webhooks",
  requireAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const success = c.req.query("success");
    const error = c.req.query("error");

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.text("Unauthorized", 403);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.notFound();

    // Exclude `chat-bridge` shadow rows — those are created lazily by
    // src/lib/chat-notifier.ts to pipe events through the existing
    // webhook_deliveries retry queue, and showing them here would let
    // users accidentally delete a Slack/Discord install from the wrong
    // surface (the source of truth lives at /settings/integrations).
    const allHooks = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.repositoryId, repo.id));
    const hooks = allHooks.filter((h) => h.events !== "chat-bridge");

    return c.html(
      <Layout title={`Webhooks — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <div class="wh-wrap">
          <header class="wh-head">
            <div class="wh-eyebrow">
              <span class="wh-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </span>
              Webhooks · {ownerName}/{repoName}
            </div>
            <h2 class="wh-title">
              <span class="wh-title-grad">Pipe events</span> out of the repo.
            </h2>
            <p class="wh-sub">
              Webhooks POST to your URL on push, issue, PR, and star events.
              Every delivery is signed with HMAC-SHA256 using your shared
              secret — verify with the <code>X-Gluecron-Signature</code>{" "}
              header.
            </p>
          </header>

          {success && (
            <div class="wh-banner is-ok" role="status">
              <span class="wh-banner-dot" aria-hidden="true" />
              {decodeURIComponent(success)}
            </div>
          )}
          {error && (
            <div class="wh-banner is-error" role="status">
              <span class="wh-banner-dot" aria-hidden="true" />
              {decodeURIComponent(error)}
            </div>
          )}

          {hooks.length > 0 ? (
            <div class="wh-list">
              {hooks.map((hook) => {
                const events = hook.events
                  .split(",")
                  .map((e) => e.trim())
                  .filter(Boolean);
                const last = hook.lastStatus ?? null;
                const deliveryClass =
                  last == null
                    ? "is-pending"
                    : last >= 200 && last < 300
                    ? "is-ok"
                    : "is-bad";
                const deliveryText =
                  last == null
                    ? "no deliveries yet"
                    : `${last} · ${whRelativeTime(hook.lastDeliveredAt)}`;
                return (
                  <article class="wh-card">
                    <div class="wh-card-top">
                      <div class="wh-card-id">
                        <span class="wh-card-url">{hook.url}</span>
                        <div class="wh-card-meta">
                          <span class="wh-time">
                            Created {whRelativeTime(hook.createdAt)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span
                            class={"wh-delivery " + deliveryClass}
                            title={
                              last == null
                                ? "No deliveries yet"
                                : `Last HTTP status ${last}`
                            }
                          >
                            <span class="dot" aria-hidden="true" />
                            {deliveryText}
                          </span>
                        </div>
                      </div>
                      <span
                        class={
                          "wh-pill " +
                          (hook.isActive ? "is-active" : "is-disabled")
                        }
                      >
                        <span class="dot" aria-hidden="true" />
                        {hook.isActive ? "active" : "disabled"}
                      </span>
                    </div>

                    {events.length > 0 && (
                      <div class="wh-chips" aria-label="Subscribed events">
                        {events.map((evt) => (
                          <span class="wh-chip">{evt}</span>
                        ))}
                      </div>
                    )}

                    <div class="wh-actions">
                      <form
                        class="wh-card-foot-form"
                        method="post"
                        action={`/${ownerName}/${repoName}/settings/webhooks/${hook.id}/delete`}
                      >
                        <button type="submit" class="wh-btn wh-btn-danger">
                          Revoke
                        </button>
                      </form>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div class="wh-empty">
              <div class="wh-empty-orb" aria-hidden="true" />
              <div class="wh-empty-inner">
                <p class="wh-empty-title">No webhooks yet</p>
                <p class="wh-empty-sub">
                  Webhooks fire on push, issue, PR, and star events. Point
                  one at your CI, your Slack relay, or your own service to
                  react in real time.
                </p>
              </div>
            </div>
          )}

          <section class="wh-form-card" aria-labelledby="wh-add-title">
            <header class="wh-form-head">
              <h3 class="wh-form-title" id="wh-add-title">
                <span class="wh-form-title-icon" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </span>
                Add webhook
              </h3>
            </header>
            <form
              method="post"
              action={`/${ownerName}/${repoName}/settings/webhooks`}
            >
              <div class="wh-form-body">
                <div class="wh-field">
                  <label class="wh-label" for="wh-url">
                    Payload URL
                  </label>
                  <input
                    id="wh-url"
                    class="wh-input"
                    type="url"
                    name="url"
                    required
                    placeholder="https://example.com/hooks/gluecron"
                    autocomplete="off"
                    spellcheck={false}
                  />
                </div>
                <div class="wh-field">
                  <label class="wh-label" for="wh-secret">
                    Secret (optional)
                  </label>
                  <input
                    id="wh-secret"
                    class="wh-input"
                    type="text"
                    name="secret"
                    placeholder="Shared secret for HMAC verification"
                    autocomplete="off"
                    spellcheck={false}
                  />
                </div>
                <div class="wh-field">
                  <span class="wh-label">Events</span>
                  <div class="wh-events">
                    {["push", "issue", "pr", "star"].map((evt) => (
                      <label class="wh-evt-label">
                        <input
                          type="checkbox"
                          name="events"
                          value={evt}
                          checked={evt === "push"}
                        />
                        {evt}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div class="wh-form-foot">
                <button type="submit" class="wh-btn wh-btn-primary">
                  Add webhook
                </button>
              </div>
            </form>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: webhookStyles }} />
      </Layout>
    );
  }
);

// Create webhook
webhookRoutes.post(
  "/:owner/:repo/settings/webhooks",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const url = String(body.url || "").trim();
    const secret = String(body.secret || "").trim() || null;

    // Events can be a string or array
    let events: string;
    const rawEvents = body.events;
    if (Array.isArray(rawEvents)) {
      events = rawEvents.join(",");
    } else {
      events = String(rawEvents || "push");
    }

    if (!url) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/webhooks?error=URL+is+required`
      );
    }

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.redirect(`/${ownerName}/${repoName}`);

    await db.insert(webhooks).values({
      repositoryId: repo.id,
      url,
      secret,
      events,
    });

    return c.redirect(
      `/${ownerName}/${repoName}/settings/webhooks?success=Webhook+added`
    );
  }
);

// Delete webhook
webhookRoutes.post(
  "/:owner/:repo/settings/webhooks/:id/delete",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName, id } = c.req.param();

    await db.delete(webhooks).where(eq(webhooks.id, id));

    return c.redirect(
      `/${ownerName}/${repoName}/settings/webhooks?success=Webhook+deleted`
    );
  }
);

export default webhookRoutes;

/**
 * Fire webhooks for a repository event.
 *
 * Instead of POSTing inline, this enqueues one `webhook_deliveries` row per
 * matching hook. The background worker in `src/lib/webhook-delivery.ts`
 * picks them up immediately (and retries with exponential backoff on
 * failure, eventually transitioning to status='dead' after MAX_ATTEMPTS).
 *
 * This is fire-and-forget: enqueue failures are logged but never propagate.
 */
export async function fireWebhooks(
  repositoryId: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const hooks = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.repositoryId, repositoryId));

    let enqueued = 0;
    for (const hook of hooks) {
      if (!hook.isActive) continue;
      const hookEvents = hook.events.split(",");
      if (!hookEvents.includes(event)) continue;

      const id = await enqueueWebhookDelivery({
        webhookId: hook.id,
        secret: hook.secret,
        event,
        payload,
      });
      if (id) enqueued++;
    }

    // Kick the worker for fresh enqueues so we don't wait up to the poll
    // interval. Best-effort and never awaited from the caller's perspective.
    if (enqueued > 0) {
      void drainPendingDeliveries().catch((err) => {
        console.error("[webhook] kick drain failed:", err);
      });
    }
  } catch (err) {
    console.error("[webhook] failed to query webhooks:", err);
  }
}
