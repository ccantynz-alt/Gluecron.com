/**
 * WebAuthn passkey routes (Block B5).
 *
 * Registration (authed):
 *   POST /api/passkeys/register/options    → challenge + pubkey-cred-params
 *   POST /api/passkeys/register/verify     → save credential
 *   GET  /settings/passkeys                → list + add + rename + delete
 *   POST /settings/passkeys/:id/delete
 *   POST /settings/passkeys/:id/rename
 *
 * Authentication (unauthed):
 *   POST /api/passkeys/auth/options        → challenge (username optional)
 *   POST /api/passkeys/auth/verify         → issues full session on success
 *
 * The browser-side glue lives in `/views/components.tsx`
 * (`PasskeyScript`) — vanilla JS using the native `navigator.credentials` API.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { users, userPasskeys, sessions } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import {
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
} from "../lib/webauthn";
import {
  generateSessionToken,
  sessionCookieOptions,
  sessionExpiry,
} from "../lib/auth";
import { audit } from "../lib/notify";

const passkeys = new Hono<AuthEnv>();

passkeys.use("/settings/passkeys", requireAuth);
passkeys.use("/settings/passkeys/*", requireAuth);
passkeys.use("/api/passkeys/register/*", requireAuth);

// --- Settings UI ------------------------------------------------------------

passkeys.get("/settings/passkeys", async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");
  const success = c.req.query("success");

  let keys: (typeof userPasskeys.$inferSelect)[] = [];
  try {
    keys = await db
      .select()
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, user.id));
  } catch (err) {
    console.error("[passkeys] list:", err);
  }

  return c.html(
    <Layout title="Passkeys" user={user}>
      <div class="settings-container">
        <div class="breadcrumb">
          <a href="/settings">settings</a>
          <span>/</span>
          <span>passkeys</span>
        </div>
        <h2>Passkeys</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        <p style="color: var(--text-muted); font-size: 13px">
          Passkeys are a phishing-resistant replacement for passwords. Your
          device stores the private key and never shares it — sign-in is a
          single Touch ID / Face ID / security-key tap.
        </p>

        <div style="margin: 16px 0">
          <button
            type="button"
            id="pk-add-btn"
            class="btn btn-primary"
          >
            Add a passkey
          </button>
          <span
            id="pk-add-status"
            style="color: var(--text-muted); font-size: 13px; margin-left: 8px"
          />
        </div>

        <div
          style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden"
        >
          {keys.length === 0 ? (
            <div
              style="padding: 16px; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary)"
            >
              No passkeys registered yet.
            </div>
          ) : (
            keys.map((k) => (
              <div
                style="padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary)"
              >
                <div>
                  <strong>{k.name}</strong>
                  <div
                    style="color: var(--text-muted); font-size: 12px; margin-top: 2px"
                  >
                    added {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt &&
                      ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}`}
                  </div>
                </div>
                <div style="display: flex; gap: 6px">
                  <form
                    method="post"
                    action={`/settings/passkeys/${k.id}/rename`}
                    style="display: flex; gap: 4px"
                  >
                    <input
                      type="text"
                      name="name"
                      defaultValue={k.name}
                      maxLength={60}
                      aria-label="Passkey name"
                      style="width: 160px"
                    />
                    <button type="submit" class="btn btn-sm">
                      save
                    </button>
                  </form>
                  <form
                    method="post"
                    action={`/settings/passkeys/${k.id}/delete`}
                    onsubmit="return confirm('Remove this passkey?')"
                  >
                    <button type="submit" class="btn btn-sm btn-danger">
                      remove
                    </button>
                  </form>
                </div>
              </div>
            ))
          )}
        </div>

        <script
          dangerouslySetInnerHTML={{
            __html: /* js */ `
              (function () {
                const btn = document.getElementById('pk-add-btn');
                const status = document.getElementById('pk-add-status');
                if (!btn) return;
                function b64uToBuf(s) {
                  s = s.replace(/-/g,'+').replace(/_/g,'/');
                  while (s.length % 4) s += '=';
                  const bin = atob(s);
                  const buf = new Uint8Array(bin.length);
                  for (let i=0;i<bin.length;i++) buf[i] = bin.charCodeAt(i);
                  return buf.buffer;
                }
                function bufToB64u(buf) {
                  const bytes = new Uint8Array(buf);
                  let bin = '';
                  for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
                  return btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
                }
                btn.addEventListener('click', async function () {
                  if (!window.PublicKeyCredential) {
                    status.textContent = 'Passkeys not supported in this browser.';
                    return;
                  }
                  status.textContent = 'Preparing…';
                  try {
                    const optsRes = await fetch('/api/passkeys/register/options', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: '{}'
                    });
                    if (!optsRes.ok) throw new Error('options failed');
                    const { options, sessionKey } = await optsRes.json();
                    options.challenge = b64uToBuf(options.challenge);
                    options.user.id = b64uToBuf(options.user.id);
                    if (options.excludeCredentials) {
                      options.excludeCredentials = options.excludeCredentials.map(function (c) {
                        return Object.assign({}, c, { id: b64uToBuf(c.id) });
                      });
                    }
                    status.textContent = 'Touch your authenticator…';
                    const cred = await navigator.credentials.create({ publicKey: options });
                    const resp = {
                      id: cred.id,
                      rawId: bufToB64u(cred.rawId),
                      type: cred.type,
                      response: {
                        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
                        attestationObject: bufToB64u(cred.response.attestationObject),
                        transports: cred.response.getTransports ? cred.response.getTransports() : []
                      },
                      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
                    };
                    const verifyRes = await fetch('/api/passkeys/register/verify', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ sessionKey: sessionKey, response: resp })
                    });
                    if (!verifyRes.ok) {
                      const j = await verifyRes.json().catch(() => ({}));
                      throw new Error(j.error || 'verify failed');
                    }
                    status.textContent = 'Saved. Reloading…';
                    window.location.reload();
                  } catch (e) {
                    status.textContent = 'Error: ' + (e && e.message ? e.message : e);
                  }
                });
              })();
            `,
          }}
        />
      </div>
    </Layout>
  );
});

passkeys.post("/settings/passkeys/:id/delete", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    const [row] = await db
      .select({ id: userPasskeys.id, userId: userPasskeys.userId })
      .from(userPasskeys)
      .where(eq(userPasskeys.id, id))
      .limit(1);
    if (!row || row.userId !== user.id) {
      return c.redirect("/settings/passkeys?error=Not+found");
    }
    await db.delete(userPasskeys).where(eq(userPasskeys.id, id));
    await audit({
      userId: user.id,
      action: "passkey.delete",
      targetType: "passkey",
      targetId: id,
    });
    return c.redirect("/settings/passkeys?success=Passkey+removed");
  } catch (err) {
    console.error("[passkeys] delete:", err);
    return c.redirect("/settings/passkeys?error=Service+unavailable");
  }
});

passkeys.post("/settings/passkeys/:id/rename", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim().slice(0, 60);
  if (!name) {
    return c.redirect("/settings/passkeys?error=Name+required");
  }
  try {
    const [row] = await db
      .select({ id: userPasskeys.id, userId: userPasskeys.userId })
      .from(userPasskeys)
      .where(eq(userPasskeys.id, id))
      .limit(1);
    if (!row || row.userId !== user.id) {
      return c.redirect("/settings/passkeys?error=Not+found");
    }
    await db
      .update(userPasskeys)
      .set({ name })
      .where(eq(userPasskeys.id, id));
    return c.redirect("/settings/passkeys?success=Renamed");
  } catch (err) {
    console.error("[passkeys] rename:", err);
    return c.redirect("/settings/passkeys?error=Service+unavailable");
  }
});

// --- Registration JSON endpoints (authed) -----------------------------------

passkeys.post("/api/passkeys/register/options", async (c) => {
  const user = c.get("user")!;
  try {
    const existing = await db
      .select({ credentialId: userPasskeys.credentialId })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, user.id));
    const { options, sessionKey } = await startRegistration({
      userId: user.id,
      userName: user.username,
      userDisplayName: user.displayName || user.username,
      excludeCredentialIds: existing.map((e) => e.credentialId),
    });
    return c.json({ options, sessionKey });
  } catch (err) {
    console.error("[passkeys] register/options:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

passkeys.post("/api/passkeys/register/verify", async (c) => {
  const user = c.get("user")!;
  let body: { sessionKey: string; response: any };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.sessionKey || !body.response) {
    return c.json({ error: "sessionKey and response required" }, 400);
  }
  const result = await finishRegistration({
    sessionKey: body.sessionKey,
    response: body.response,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  try {
    const transports = Array.isArray(body.response?.response?.transports)
      ? JSON.stringify(body.response.response.transports)
      : null;
    await db.insert(userPasskeys).values({
      userId: user.id,
      credentialId: result.credentialId,
      publicKey: result.publicKey,
      counter: result.counter,
      transports,
    });
    await audit({
      userId: user.id,
      action: "passkey.create",
      targetType: "passkey",
      metadata: { credentialId: result.credentialId },
    });
    return c.json({ ok: true });
  } catch (err: any) {
    if (String(err?.message || err).includes("user_passkeys")) {
      return c.json({ error: "Credential already registered" }, 409);
    }
    console.error("[passkeys] register save:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

// --- Authentication JSON endpoints (unauthed) -------------------------------

passkeys.post("/api/passkeys/auth/options", async (c) => {
  let body: { username?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    let userId: string | undefined;
    let allowCreds: string[] = [];
    if (body.username) {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, body.username.trim().toLowerCase()))
        .limit(1);
      if (u) {
        userId = u.id;
        const rows = await db
          .select({ credentialId: userPasskeys.credentialId })
          .from(userPasskeys)
          .where(eq(userPasskeys.userId, u.id));
        allowCreds = rows.map((r) => r.credentialId);
      }
    }
    const { options, sessionKey } = await startAuthentication({
      userId,
      allowCredentialIds: allowCreds,
    });
    return c.json({ options, sessionKey });
  } catch (err) {
    console.error("[passkeys] auth/options:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

passkeys.post("/api/passkeys/auth/verify", async (c) => {
  let body: { sessionKey: string; response: any };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body.sessionKey || !body.response) {
    return c.json({ error: "sessionKey and response required" }, 400);
  }
  const result = await finishAuthentication({
    sessionKey: body.sessionKey,
    response: body.response,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);

  try {
    // Passkey is phishing-resistant + user-verifying; skip TOTP prompt.
    const token = generateSessionToken();
    await db.insert(sessions).values({
      userId: result.userId,
      token,
      expiresAt: sessionExpiry(),
      requires2fa: false,
    });
    setCookie(c, "session", token, sessionCookieOptions());
    await audit({
      userId: result.userId,
      action: "passkey.login",
      targetType: "passkey",
      metadata: { credentialId: result.credentialId },
    });
    return c.json({ ok: true });
  } catch (err) {
    console.error("[passkeys] auth/verify:", err);
    return c.json({ error: "Service unavailable" }, 503);
  }
});

export default passkeys;
