/**
 * Block K11 — Cross-product identity routes.
 *
 *   POST /api/v1/cross-product/token    — exchange any gluecron credential
 *                                         (session / PAT / OAuth) for a
 *                                         short-lived JWT bound to a sibling
 *                                         product audience.
 *   GET  /api/v1/cross-product/verify   — no-auth verifier used by siblings.
 *   POST /api/v1/cross-product/revoke   — owner revocation.
 *   GET  /settings/cross-product        — web UI listing active tokens.
 *
 * Every mint writes an `audit_log` row with action `cross_product.token_mint`.
 */

import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { auditLog } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  ALLOWED_AUDIENCES,
  ALLOWED_SCOPES,
  isAllowedAudience,
  validateScopes,
  signCrossProductToken,
  verifyCrossProductToken,
  revokeCrossProductToken,
  listActiveCrossProductTokens,
  type Audience,
} from "../lib/cross-product-auth";

const cp = new Hono<AuthEnv>();

// softAuth is enough for the exchange endpoint — it runs session/PAT/OAuth
// resolution. We then gate on `c.get("user")` so we can return JSON 401
// rather than the redirect requireAuth emits for HTML paths.
cp.use("/api/v1/cross-product/token", softAuth);
cp.use("/api/v1/cross-product/revoke", softAuth);
cp.use("/settings/cross-product", softAuth, requireAuth);
cp.use("/settings/cross-product/*", softAuth, requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBearer(c: {
  req: { header: (k: string) => string | undefined };
}): string | null {
  const h = c.req.header("authorization") || "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  const tok = h.slice(7).trim();
  return tok || null;
}

async function recordMintAudit(
  userId: string,
  audience: Audience,
  scopes: string[],
  jti: string,
  ip: string | undefined,
  userAgent: string | undefined
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId,
      repositoryId: null,
      action: "cross_product.token_mint",
      targetType: "cross_product_token",
      targetId: jti,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      metadata: JSON.stringify({ audience, scopes }),
    });
  } catch (err) {
    console.error("[cross-product] audit write failed:", err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/cross-product/token
// ---------------------------------------------------------------------------

cp.post("/api/v1/cross-product/token", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const audience = body.audience;
  if (!isAllowedAudience(audience)) {
    return c.json(
      {
        error: "unknown_audience",
        allowed: ALLOWED_AUDIENCES,
      },
      400
    );
  }

  let requestedScopes: string[] = [];
  if (Array.isArray(body.scope)) {
    requestedScopes = body.scope.filter(
      (s): s is string => typeof s === "string"
    );
  } else if (Array.isArray(body.scopes)) {
    requestedScopes = body.scopes.filter(
      (s): s is string => typeof s === "string"
    );
  }
  const scopes = validateScopes(requestedScopes);

  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined;
  const userAgent = c.req.header("user-agent") || undefined;

  try {
    const result = await signCrossProductToken({
      userId: user.id,
      email: user.email,
      audience,
      scopes,
    });
    await recordMintAudit(user.id, audience, scopes, result.jti, ip, userAgent);
    return c.json({
      token: result.token,
      expires_at: result.expiresAt.toISOString(),
      audience,
      scopes: result.scopes,
      jti: result.jti,
      issuer: "gluecron",
    });
  } catch (err) {
    console.error("[cross-product] mint failed:", err);
    return c.json({ error: "mint_failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/cross-product/verify   (no auth; sibling products call this)
// ---------------------------------------------------------------------------

async function handleVerify(c: {
  req: {
    header: (k: string) => string | undefined;
    json: () => Promise<unknown>;
  };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  let token = parseBearer(c);
  if (!token) {
    // Fall back to body token for clients that prefer POST.
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      if (body && typeof body.token === "string") token = body.token;
    } catch {
      // no body — that's fine
    }
  }
  if (!token) {
    return c.json({ valid: false, error: "missing_token" }, 401);
  }

  const result = await verifyCrossProductToken(token);
  if (!result.valid) {
    return c.json({ valid: false, error: result.reason }, 401);
  }
  return c.json({
    valid: true,
    sub: result.sub,
    email: result.email,
    audience: result.audience,
    scopes: result.scopes,
    jti: result.jti,
    expires_at: result.expiresAt.toISOString(),
    issuer: "gluecron",
  });
}

cp.get("/api/v1/cross-product/verify", (c) => handleVerify(c));
cp.post("/api/v1/cross-product/verify", (c) => handleVerify(c));

// ---------------------------------------------------------------------------
// POST /api/v1/cross-product/revoke
// ---------------------------------------------------------------------------

cp.post("/api/v1/cross-product/revoke", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const jti = typeof body.jti === "string" ? body.jti : "";
  if (!jti) return c.json({ error: "jti_required" }, 400);

  const ok = await revokeCrossProductToken(jti, user.id);
  if (!ok) return c.json({ error: "not_found_or_not_owner" }, 404);

  // Audit the revoke (separate action from mint).
  try {
    await db.insert(auditLog).values({
      userId: user.id,
      repositoryId: null,
      action: "cross_product.token_revoke",
      targetType: "cross_product_token",
      targetId: jti,
      metadata: null,
    });
  } catch (err) {
    console.error("[cross-product] revoke audit failed:", err);
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /settings/cross-product   (web UI)
// ---------------------------------------------------------------------------

cp.get("/settings/cross-product", async (c) => {
  const user = c.get("user")!;
  let active: Awaited<ReturnType<typeof listActiveCrossProductTokens>> = [];
  try {
    active = await listActiveCrossProductTokens(user.id);
  } catch {
    active = [];
  }

  return c.html(
    <Layout title="Cross-product identity" user={user}>
      <div class="settings-container">
        <h2>Cross-product identity</h2>
        <p style="color: var(--text-muted); max-width: 640px">
          One gluecron account signs into Crontech and Gatetest. Active
          short-lived tokens issued for those sibling products are listed
          below. Tokens expire in {String(15)} minutes; revoke anything
          suspicious.
        </p>

        <h3 style="margin-top: 24px">Active tokens</h3>
        {active.length === 0 ? (
          <p style="color: var(--text-muted)">
            No active cross-product tokens. They are minted on-demand by the
            sibling products when you sign in.
          </p>
        ) : (
          <div>
            {active.map((tok) => (
              <div class="ssh-key-item">
                <div>
                  <strong>{tok.audience}</strong>
                  <div class="ssh-key-meta">
                    <code>{tok.jti.slice(0, 8)}...</code>
                    <span style="margin-left: 8px">
                      Scopes:{" "}
                      {tok.scopes.length > 0 ? tok.scopes.join(", ") : "none"}
                    </span>
                    <span style="margin-left: 8px">
                      Expires{" "}
                      {new Date(tok.expiresAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
                <form
                  method="POST"
                  action={`/settings/cross-product/${tok.jti}/revoke`}
                >
                  <button type="submit" class="btn btn-danger btn-sm">
                    Revoke
                  </button>
                </form>
              </div>
            ))}
          </div>
        )}

        <h3 style="margin-top: 24px">Audiences</h3>
        <ul style="color: var(--text-muted)">
          {ALLOWED_AUDIENCES.map((a) => (
            <li>
              <code>{a}</code>
            </li>
          ))}
        </ul>

        <h3 style="margin-top: 24px">Supported scopes</h3>
        <ul style="color: var(--text-muted)">
          {ALLOWED_SCOPES.map((s) => (
            <li>
              <code>{s}</code>
            </li>
          ))}
        </ul>
      </div>
    </Layout>
  );
});

// Form POST for the web UI revoke button (keeps it cookie-based).
cp.post("/settings/cross-product/:jti/revoke", async (c) => {
  const user = c.get("user")!;
  const jti = c.req.param("jti");
  const ok = await revokeCrossProductToken(jti, user.id);
  if (ok) {
    try {
      await db.insert(auditLog).values({
        userId: user.id,
        repositoryId: null,
        action: "cross_product.token_revoke",
        targetType: "cross_product_token",
        targetId: jti,
        metadata: null,
      });
    } catch (err) {
      console.error("[cross-product] revoke audit failed:", err);
    }
  }
  return c.redirect("/settings/cross-product");
});

// Stub so TS narrows `sql` as imported (keeps the compiler happy if this
// file grows helpers later — stripped by the bundler).
void sql;

export default cp;
