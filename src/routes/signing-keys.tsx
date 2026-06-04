/**
 * Block J3 — Signing keys UI.
 *
 *   GET  /settings/signing-keys        — list + add form
 *   POST /settings/signing-keys        — add new key
 *   POST /settings/signing-keys/:id/delete
 *
 * 2026 polish:
 *   - Page-level eyebrow + display headline + subtitle (the settings layout
 *     already provides the sidebar — no hero block here).
 *   - Each key is a polished card showing title, key-type chip, optional
 *     email, mono fingerprint, created timestamp (relative, tabular-nums),
 *     and an "active" status pill.
 *   - Add-key form is its own card with focus rings + primary gradient
 *     submit button.
 *   - Empty state is a dashed card with an orb + helpful CTA copy.
 *   - All CSS scoped under `.sk-*`.
 *
 * Hard rules preserved:
 *   - Every route, form action, POST handler is unchanged.
 *   - Layout / ui.tsx / components.tsx are not modified.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import {
  addSigningKey,
  deleteSigningKey,
  listSigningKeysForUser,
} from "../lib/signatures";
import { audit } from "../lib/notify";

const signingKeysRoutes = new Hono<AuthEnv>();
signingKeysRoutes.use("/settings/signing-keys", requireAuth);
signingKeysRoutes.use("/settings/signing-keys/*", requireAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.sk-` so this page can't bleed into
 * other settings surfaces. Mirrors the section-card pattern from
 * admin-integrations.tsx and admin-ops.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const signingKeyStyles = `
  .sk-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Page heading (no hero block — settings sidebar supplies framing) ─── */
  .sk-head { margin-bottom: var(--space-5); }
  .sk-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
  }
  .sk-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .sk-title {
    font-size: clamp(24px, 3.2vw, 32px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.024em;
    line-height: 1.08;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .sk-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .sk-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .sk-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .sk-sub .sk-verified {
    color: #6ee7b7;
    font-weight: 600;
  }

  /* ─── Banners ─── */
  .sk-banner {
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
  .sk-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .sk-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .sk-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Key cards ─── */
  .sk-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .sk-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    transition: border-color 140ms ease;
  }
  .sk-card:hover { border-color: var(--border-strong); }
  .sk-card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .sk-card-id { flex: 1; min-width: 240px; }
  .sk-card-name {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sk-card-email {
    font-size: 12.5px;
    color: var(--text-muted);
    font-weight: 500;
    font-family: var(--font-mono);
  }
  .sk-card-fp {
    margin-top: 8px;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    word-break: break-all;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
  .sk-card-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
  }
  .sk-time {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    color: var(--text-muted);
  }

  /* ─── Chips + pills ─── */
  .sk-type-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.12);
    border: 1px solid rgba(140,109,255,0.30);
    color: #c4b5fd;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-family: var(--font-mono);
  }
  .sk-pill {
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
  .sk-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }
  .sk-pill.is-active {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .sk-pill.is-expired {
    background: rgba(248,113,113,0.12);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }

  /* ─── Actions ─── */
  .sk-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sk-btn {
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
  .sk-btn-danger {
    background: rgba(248,113,113,0.08);
    border-color: rgba(248,113,113,0.30);
    color: #fca5a5;
  }
  .sk-btn-danger:hover {
    background: rgba(248,113,113,0.14);
    border-color: rgba(248,113,113,0.50);
    color: #fecaca;
  }
  .sk-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #6d4ee0 100%);
    color: #ffffff;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.45);
  }
  .sk-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.55);
  }
  .sk-card-form { margin: 0; }

  /* ─── Empty state ─── */
  .sk-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    margin-bottom: var(--space-5);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
    background: rgba(255,255,255,0.02);
    text-align: center;
    overflow: hidden;
  }
  .sk-empty-orb {
    position: absolute;
    inset: -40% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.6;
    pointer-events: none;
    z-index: 0;
  }
  .sk-empty-inner { position: relative; z-index: 1; }
  .sk-empty-title {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    letter-spacing: -0.018em;
  }
  .sk-empty-sub {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0 auto;
    max-width: 460px;
    line-height: 1.5;
  }

  /* ─── Add-key form card ─── */
  .sk-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .sk-form-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sk-form-title {
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
  .sk-form-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
  }
  .sk-form-body { padding: var(--space-4) var(--space-5); }
  .sk-field { margin-bottom: var(--space-4); }
  .sk-field:last-of-type { margin-bottom: 0; }
  .sk-label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.005em;
  }
  .sk-input,
  .sk-select,
  .sk-textarea {
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
  .sk-input:focus,
  .sk-select:focus,
  .sk-textarea:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .sk-textarea {
    resize: vertical;
    min-height: 180px;
    line-height: 1.5;
  }
  .sk-hint {
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .sk-form-foot {
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
function skRelativeTime(from: Date | null, now: Date = new Date()): string {
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

signingKeysRoutes.get("/settings/signing-keys", async (c) => {
  const user = c.get("user")!;
  const keys = await listSigningKeysForUser(user.id);
  const message = c.req.query("message");
  const error = c.req.query("error");
  const now = new Date();
  return c.html(
    <Layout title="Signing keys" user={user}>
      <div class="sk-wrap">
        <header class="sk-head">
          <div class="sk-eyebrow">
            <span class="sk-eyebrow-pill" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
              </svg>
            </span>
            Signing keys · {user.username}
          </div>
          <h2 class="sk-title">
            <span class="sk-title-grad">Prove</span> it was you.
          </h2>
          <p class="sk-sub">
            Register the GPG or SSH public key you use for{" "}
            <code>git commit -S</code>. Commits we can match to a registered
            key render with a <span class="sk-verified">Verified</span>{" "}
            badge. This is identity matching by fingerprint —
            cryptographic verification is future work.
          </p>
        </header>

        {message && (
          <div class="sk-banner is-ok" role="status">
            <span class="sk-banner-dot" aria-hidden="true" />
            {decodeURIComponent(message)}
          </div>
        )}
        {error && (
          <div class="sk-banner is-error" role="status">
            <span class="sk-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        {keys.length > 0 ? (
          <div class="sk-list">
            {keys.map((k) => {
              const expired =
                k.expiresAt && new Date(k.expiresAt).getTime() < now.getTime();
              return (
                <article class="sk-card">
                  <div class="sk-card-top">
                    <div class="sk-card-id">
                      <h3 class="sk-card-name">
                        <span class="sk-type-chip">{k.keyType}</span>
                        <span>{k.title}</span>
                        {k.email && (
                          <span class="sk-card-email">{k.email}</span>
                        )}
                      </h3>
                      <div class="sk-card-fp" title={k.fingerprint}>
                        {k.fingerprint}
                      </div>
                      <div class="sk-card-meta" style="margin-top:10px">
                        <span class="sk-time">
                          Added {skRelativeTime(k.createdAt)}
                        </span>
                        {k.lastUsedAt && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span class="sk-time">
                              Last used {skRelativeTime(k.lastUsedAt)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <span
                      class={
                        "sk-pill " + (expired ? "is-expired" : "is-active")
                      }
                    >
                      <span class="dot" aria-hidden="true" />
                      {expired ? "expired" : "active"}
                    </span>
                  </div>

                  <div class="sk-actions">
                    <form
                      class="sk-card-form"
                      method="post"
                      action={`/settings/signing-keys/${k.id}/delete`}
                    >
                      <button type="submit" class="sk-btn sk-btn-danger">
                        Revoke
                      </button>
                    </form>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div class="sk-empty">
            <div class="sk-empty-orb" aria-hidden="true" />
            <div class="sk-empty-inner">
              <p class="sk-empty-title">No signing keys yet</p>
              <p class="sk-empty-sub">
                Sign commits to prove they're you — your verified pushes will
                render with a green badge once we match the signature to a
                key on file.
              </p>
            </div>
          </div>
        )}

        <section class="sk-form-card" aria-labelledby="sk-add-title">
          <header class="sk-form-head">
            <h3 class="sk-form-title" id="sk-add-title">
              <span class="sk-form-title-icon" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </span>
              Add a key
            </h3>
          </header>
          <form
            method="post"
            action="/settings/signing-keys"
            class="auth-form"
          >
            <div class="sk-form-body">
              <div class="sk-field">
                <label class="sk-label" for="sk-title">
                  Title
                </label>
                <input
                  type="text"
                  id="sk-title"
                  name="title"
                  class="sk-input"
                  placeholder="e.g. Work laptop"
                  required
                  maxLength={120}
                  autocomplete="off"
                  spellcheck={false}
                />
              </div>
              <div class="sk-field">
                <label class="sk-label" for="sk-type">
                  Key type
                </label>
                <select
                  id="sk-type"
                  name="key_type"
                  class="sk-select"
                  required
                >
                  <option value="gpg">GPG</option>
                  <option value="ssh">SSH</option>
                </select>
              </div>
              <div class="sk-field">
                <label class="sk-label" for="sk-email">
                  Email (optional)
                </label>
                <input
                  type="email"
                  id="sk-email"
                  name="email"
                  class="sk-input"
                  placeholder="commit-author@example.com"
                  maxLength={200}
                  autocomplete="off"
                  spellcheck={false}
                />
                <div class="sk-hint">
                  Helps match commits whose <code>Signed-off-by</code> uses a
                  different address than your account.
                </div>
              </div>
              <div class="sk-field">
                <label class="sk-label" for="sk-public">
                  Public key
                </label>
                <textarea
                  id="sk-public"
                  name="public_key"
                  rows={10}
                  required
                  class="sk-textarea"
                  placeholder={
                    "-----BEGIN PGP PUBLIC KEY BLOCK-----\n...\n-----END PGP PUBLIC KEY BLOCK-----\n\nor: ssh-ed25519 AAAA... you@laptop"
                  }
                />
              </div>
            </div>
            <div class="sk-form-foot">
              <button type="submit" class="sk-btn sk-btn-primary">
                Add key
              </button>
            </div>
          </form>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: signingKeyStyles }} />
    </Layout>
  );
});

signingKeysRoutes.post("/settings/signing-keys", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const keyType = String(body.key_type || "").toLowerCase() as "gpg" | "ssh";
  const title = String(body.title || "");
  const publicKey = String(body.public_key || "");
  const email = String(body.email || "");

  const result = await addSigningKey({
    userId: user.id,
    keyType,
    title,
    publicKey,
    email,
  });

  if (!result.ok) {
    return c.redirect(
      `/settings/signing-keys?error=${encodeURIComponent(result.error)}`
    );
  }
  await audit({
    userId: user.id,
    action: "signing_keys.add",
    targetId: result.id,
    metadata: { keyType, fingerprint: result.fingerprint },
  });
  return c.redirect(
    `/settings/signing-keys?message=${encodeURIComponent(
      `Added key ${result.fingerprint.slice(0, 24)}…`
    )}`
  );
});

signingKeysRoutes.post("/settings/signing-keys/:id/delete", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const ok = await deleteSigningKey(id, user.id);
  if (ok) {
    await audit({
      userId: user.id,
      action: "signing_keys.delete",
      targetId: id,
    });
  }
  return c.redirect(
    `/settings/signing-keys?${ok ? "message" : "error"}=${encodeURIComponent(
      ok ? "Key removed." : "Key not found"
    )}`
  );
});

export default signingKeysRoutes;
