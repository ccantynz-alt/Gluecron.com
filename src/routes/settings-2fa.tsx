/**
 * 2FA settings (Block B4).
 *
 * Routes:
 *   GET  /settings/2fa                   status + recovery code management
 *   POST /settings/2fa/enroll            generate a pending secret, show QR
 *   GET  /settings/2fa/enroll            same as POST (for bookmarks)
 *   POST /settings/2fa/confirm           verify first code, flip enabled
 *   POST /settings/2fa/disable           require password + disable + wipe
 *   POST /settings/2fa/recovery/regen    regenerate recovery codes
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, userTotp, userRecoveryCodes } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import { verifyPassword } from "../lib/auth";
import {
  generateTotpSecret,
  otpauthUrl,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "../lib/totp";
import { audit } from "../lib/notify";
import { config } from "../lib/config";

const settings2fa = new Hono<AuthEnv>();

settings2fa.use("/settings/2fa", requireAuth);
settings2fa.use("/settings/2fa/*", requireAuth);

function errorRedirect(path: string, msg: string) {
  return `${path}?error=${encodeURIComponent(msg)}`;
}

/** Status page: either "off" (offer enroll), "pending" (finish enrol), "on" (disable + manage codes). */
settings2fa.get("/settings/2fa", async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");
  const success = c.req.query("success");

  let state: "off" | "pending" | "on" = "off";
  try {
    const [row] = await db
      .select({ enabledAt: userTotp.enabledAt })
      .from(userTotp)
      .where(eq(userTotp.userId, user.id))
      .limit(1);
    if (row) state = row.enabledAt ? "on" : "pending";
  } catch (err) {
    console.error("[2fa] status:", err);
  }

  let unusedRecovery = 0;
  try {
    const rows = await db
      .select({ usedAt: userRecoveryCodes.usedAt })
      .from(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, user.id));
    unusedRecovery = rows.filter((r) => !r.usedAt).length;
  } catch {
    /* ignore */
  }

  return c.html(
    <Layout title="Two-factor authentication" user={user}>
      <div class="settings-container">
        <div class="breadcrumb">
          <a href="/settings">settings</a>
          <span>/</span>
          <span>2fa</span>
        </div>
        <h2>Two-factor authentication</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        <p style="color: var(--text-muted); font-size: 13px">
          Require a 6-digit code from your authenticator app on every sign-in.
          Works with Google Authenticator, 1Password, Bitwarden, Authy, and any
          other TOTP-compatible app.
        </p>

        {state === "off" && (
          <form method="post" action="/settings/2fa/enroll">
            <button type="submit" class="btn btn-primary">
              Enable two-factor authentication
            </button>
          </form>
        )}

        {state === "pending" && (
          <>
            <p
              style="background: rgba(210, 153, 34, 0.1); border: 1px solid var(--yellow, #d29922); padding: 8px 12px; border-radius: var(--radius); color: var(--yellow, #d29922); font-size: 13px"
            >
              Enrolment started but not confirmed. Finish by entering a code
              from your authenticator below.
            </p>
            <a href="/settings/2fa/enroll" class="btn btn-primary">
              Continue enrolment
            </a>
          </>
        )}

        {state === "on" && (
          <>
            <div
              style="background: rgba(63, 185, 80, 0.1); border: 1px solid var(--green); padding: 8px 12px; border-radius: var(--radius); color: var(--green); font-size: 13px; margin-bottom: 16px"
            >
              Two-factor authentication is enabled.
            </div>
            <h3 style="font-size: 15px; margin-top: 16px">Recovery codes</h3>
            <p style="color: var(--text-muted); font-size: 13px">
              {unusedRecovery} unused recovery code
              {unusedRecovery === 1 ? "" : "s"} remaining. Each code can be
              used once if you lose access to your authenticator.
            </p>
            <form
              method="post"
              action="/settings/2fa/recovery/regen"
              style="display: inline-block; margin-right: 8px"
              onsubmit="return confirm('Regenerate recovery codes? Your existing codes will stop working.')"
            >
              <button type="submit" class="btn">
                Regenerate recovery codes
              </button>
            </form>

            <h3 style="font-size: 15px; margin-top: 24px">Disable</h3>
            <p style="color: var(--text-muted); font-size: 13px">
              Confirm your password to turn off 2FA.
            </p>
            <form method="post" action="/settings/2fa/disable">
              <div class="form-group" style="max-width: 320px">
                <label for="password">Password</label>
                <input
                  type="password"
                  name="password"
                  required
                  autocomplete="current-password"
                />
              </div>
              <button type="submit" class="btn btn-danger">
                Disable two-factor authentication
              </button>
            </form>
          </>
        )}
      </div>
    </Layout>
  );
});

/** Generate (or re-use pending) secret + show the QR enrolment page. */
async function showEnrolPage(c: any, user: any, error?: string) {
  let secret: string;
  try {
    const [existing] = await db
      .select()
      .from(userTotp)
      .where(eq(userTotp.userId, user.id))
      .limit(1);
    if (existing && !existing.enabledAt) {
      secret = existing.secret;
    } else if (existing && existing.enabledAt) {
      return c.redirect(
        errorRedirect("/settings/2fa", "2FA is already enabled")
      );
    } else {
      secret = generateTotpSecret();
      await db.insert(userTotp).values({ userId: user.id, secret });
    }
  } catch (err) {
    console.error("[2fa] enroll:", err);
    return c.redirect(errorRedirect("/settings/2fa", "Service unavailable"));
  }

  const url = otpauthUrl({
    secret,
    accountName: user.email || user.username,
    issuer: "gluecron",
  });
  // Render a simple data URL QR via a public chart service fallback —
  // but we avoid external deps and instead show the secret + URL so any
  // authenticator can be set up manually. Apps scan otpauth:// directly.
  return c.html(
    <Layout title="Enable 2FA" user={user}>
      <div class="settings-container">
        <div class="breadcrumb">
          <a href="/settings">settings</a>
          <span>/</span>
          <a href="/settings/2fa">2fa</a>
          <span>/</span>
          <span>enrol</span>
        </div>
        <h2>Set up your authenticator</h2>
        {error && <div class="auth-error">{error}</div>}
        <ol
          style="color: var(--text-muted); font-size: 14px; line-height: 1.6; padding-left: 20px"
        >
          <li>
            Open your authenticator app (Google Authenticator, 1Password,
            Bitwarden, Authy, etc).
          </li>
          <li>
            Add a new entry. Either scan the otpauth link below with a QR
            reader, or type in the secret key manually.
          </li>
          <li>Enter the 6-digit code the app shows to confirm.</li>
        </ol>
        <div
          style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; margin: 16px 0"
        >
          <div style="font-size: 12px; color: var(--text-muted)">Secret key</div>
          <code
            style="font-size: 14px; font-family: monospace; word-break: break-all"
          >
            {secret}
          </code>
          <div
            style="font-size: 12px; color: var(--text-muted); margin-top: 12px"
          >
            otpauth URL (for QR apps)
          </div>
          <code
            style="font-size: 12px; font-family: monospace; word-break: break-all; color: var(--text)"
          >
            {url}
          </code>
        </div>
        <form method="post" action="/settings/2fa/confirm">
          <div class="form-group" style="max-width: 280px">
            <label for="code">6-digit code</label>
            <input
              type="text"
              name="code"
              required
              pattern="[0-9]{6}"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxLength={6}
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Confirm + enable
          </button>
        </form>
      </div>
    </Layout>
  );
}

settings2fa.get("/settings/2fa/enroll", async (c) => {
  const user = c.get("user")!;
  return showEnrolPage(c, user);
});

settings2fa.post("/settings/2fa/enroll", async (c) => {
  const user = c.get("user")!;
  return showEnrolPage(c, user);
});

/** Verify the first code + flip enabled. Also mint recovery codes. */
settings2fa.post("/settings/2fa/confirm", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const code = String(body.code || "").trim();

  if (!/^\d{6}$/.test(code)) {
    return c.redirect(
      errorRedirect("/settings/2fa/enroll", "Enter the 6-digit code")
    );
  }

  try {
    const [row] = await db
      .select()
      .from(userTotp)
      .where(eq(userTotp.userId, user.id))
      .limit(1);
    if (!row || row.enabledAt) {
      return c.redirect("/settings/2fa");
    }
    const ok = await verifyTotpCode(row.secret, code);
    if (!ok) {
      return c.redirect(
        errorRedirect(
          "/settings/2fa/enroll",
          "Code did not verify — try again"
        )
      );
    }
    await db
      .update(userTotp)
      .set({ enabledAt: new Date(), lastUsedAt: new Date() })
      .where(eq(userTotp.userId, user.id));

    // Mint + store recovery codes
    const codes = generateRecoveryCodes(10);
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, user.id));
    await db.insert(userRecoveryCodes).values(
      hashes.map((h) => ({ userId: user.id, codeHash: h }))
    );

    await audit({
      userId: user.id,
      action: "2fa.enable",
      targetType: "user",
      targetId: user.id,
    });

    return c.html(
      <Layout title="Save your recovery codes" user={user}>
        <div class="settings-container">
          <div class="breadcrumb">
            <a href="/settings">settings</a>
            <span>/</span>
            <a href="/settings/2fa">2fa</a>
            <span>/</span>
            <span>recovery codes</span>
          </div>
          <h2>Save your recovery codes</h2>
          <div
            style="background: rgba(248, 81, 73, 0.1); border: 1px solid var(--red); color: var(--red); padding: 8px 12px; border-radius: var(--radius); margin-bottom: 16px; font-size: 13px"
          >
            These codes are shown only once. Store them somewhere safe — a
            password manager, a printed copy. Each code works once.
          </div>
          <pre
            style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; font-family: monospace; font-size: 14px; line-height: 1.6"
          >
{codes.join("\n")}
          </pre>
          <a href="/settings/2fa" class="btn btn-primary">
            I've saved them
          </a>
        </div>
      </Layout>
    );
  } catch (err) {
    console.error("[2fa] confirm:", err);
    return c.redirect(
      errorRedirect("/settings/2fa/enroll", "Service unavailable")
    );
  }
});

settings2fa.post("/settings/2fa/disable", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const password = String(body.password || "");
  if (!password) {
    return c.redirect(
      errorRedirect("/settings/2fa", "Password is required")
    );
  }
  try {
    const [u] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (!u || !(await verifyPassword(password, u.passwordHash))) {
      return c.redirect(errorRedirect("/settings/2fa", "Invalid password"));
    }
    await db.delete(userTotp).where(eq(userTotp.userId, user.id));
    await db
      .delete(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, user.id));
    await audit({
      userId: user.id,
      action: "2fa.disable",
      targetType: "user",
      targetId: user.id,
    });
    return c.redirect("/settings/2fa?success=Two-factor+disabled");
  } catch (err) {
    console.error("[2fa] disable:", err);
    return c.redirect(errorRedirect("/settings/2fa", "Service unavailable"));
  }
});

settings2fa.post("/settings/2fa/recovery/regen", async (c) => {
  const user = c.get("user")!;
  try {
    const [row] = await db
      .select({ enabledAt: userTotp.enabledAt })
      .from(userTotp)
      .where(eq(userTotp.userId, user.id))
      .limit(1);
    if (!row || !row.enabledAt) {
      return c.redirect(
        errorRedirect("/settings/2fa", "Enable 2FA first")
      );
    }
    const codes = generateRecoveryCodes(10);
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    await db
      .delete(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, user.id));
    await db.insert(userRecoveryCodes).values(
      hashes.map((h) => ({ userId: user.id, codeHash: h }))
    );
    await audit({
      userId: user.id,
      action: "2fa.recovery.regenerate",
      targetType: "user",
      targetId: user.id,
    });
    return c.html(
      <Layout title="New recovery codes" user={user}>
        <div class="settings-container">
          <h2>New recovery codes</h2>
          <div
            style="background: rgba(248, 81, 73, 0.1); border: 1px solid var(--red); color: var(--red); padding: 8px 12px; border-radius: var(--radius); margin-bottom: 16px; font-size: 13px"
          >
            Store these somewhere safe — the previous codes no longer work.
          </div>
          <pre
            style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; font-family: monospace; font-size: 14px; line-height: 1.6"
          >
{codes.join("\n")}
          </pre>
          <a href="/settings/2fa" class="btn btn-primary">
            Done
          </a>
        </div>
      </Layout>
    );
  } catch (err) {
    console.error("[2fa] regen:", err);
    return c.redirect(errorRedirect("/settings/2fa", "Service unavailable"));
  }
});

// Keep the import-check happy — config is intentionally available for
// future issuer customisation.
void config;

export default settings2fa;
