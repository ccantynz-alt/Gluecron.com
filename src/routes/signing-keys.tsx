/**
 * Block J3 — Signing keys UI.
 *
 *   GET  /settings/signing-keys        — list + add form
 *   POST /settings/signing-keys        — add new key
 *   POST /settings/signing-keys/:id/delete
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

signingKeysRoutes.get("/settings/signing-keys", async (c) => {
  const user = c.get("user")!;
  const keys = await listSigningKeysForUser(user.id);
  const message = c.req.query("message");
  const error = c.req.query("error");
  return c.html(
    <Layout title="Signing keys" user={user}>
      <div class="settings-container">
        <h2>Signing keys</h2>
        <p style="color:var(--text-muted)">
          Register the GPG or SSH public key you use for{" "}
          <code>git commit -S</code>. Commits we can match to a registered key
          render with a <span style="color:var(--green);font-weight:600">Verified</span>{" "}
          badge. This is identity matching by fingerprint — cryptographic
          verification is future work.
        </p>
        {message && (
          <div class="auth-success" style="margin-top:12px">
            {decodeURIComponent(message)}
          </div>
        )}
        {error && (
          <div class="auth-error" style="margin-top:12px">
            {decodeURIComponent(error)}
          </div>
        )}

        <h3 style="margin-top:24px">Your keys</h3>
        {keys.length === 0 ? (
          <div class="panel-empty" style="padding:16px">
            No signing keys yet.
          </div>
        ) : (
          <div class="panel">
            {keys.map((k) => (
              <div
                class="panel-item"
                style="flex-direction:column;align-items:stretch;gap:4px"
              >
                <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
                  <div>
                    <span
                      style="font-size:10px;padding:2px 6px;border-radius:3px;background:var(--bg-subtle);text-transform:uppercase;margin-right:6px"
                    >
                      {k.keyType}
                    </span>
                    <span style="font-weight:600">{k.title}</span>
                    {k.email && (
                      <span
                        style="font-size:12px;color:var(--text-muted);margin-left:8px"
                      >
                        {k.email}
                      </span>
                    )}
                  </div>
                  <form
                    method="post"
                    action={`/settings/signing-keys/${k.id}/delete`}
                  >
                    <button
                      type="submit"
                      class="btn btn-sm"
                      style="font-size:11px"
                    >
                      Delete
                    </button>
                  </form>
                </div>
                <div
                  style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);word-break:break-all"
                >
                  {k.fingerprint}
                </div>
              </div>
            ))}
          </div>
        )}

        <h3 style="margin-top:24px">Add a key</h3>
        <form
          method="post"
          action="/settings/signing-keys"
          class="auth-form"
          style="max-width:720px"
        >
          <div class="form-group">
            <label for="sk-title">Title</label>
            <input
              type="text"
              id="sk-title"
              name="title"
              placeholder="e.g. Work laptop"
              required
              maxLength={120}
            />
          </div>
          <div class="form-group">
            <label for="sk-type">Key type</label>
            <select id="sk-type" name="key_type" required>
              <option value="gpg">GPG</option>
              <option value="ssh">SSH</option>
            </select>
          </div>
          <div class="form-group">
            <label for="sk-email">Email (optional)</label>
            <input
              type="email"
              id="sk-email"
              name="email"
              placeholder="commit-author@example.com"
              maxLength={200}
            />
          </div>
          <div class="form-group">
            <label for="sk-public">Public key</label>
            <textarea
              id="sk-public"
              name="public_key"
              rows={10}
              required
              placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----&#10;...&#10;-----END PGP PUBLIC KEY BLOCK-----&#10;&#10;or: ssh-ed25519 AAAA... you@laptop"
              style="font-family:var(--font-mono);font-size:12px"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Add key
          </button>
        </form>
      </div>
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
