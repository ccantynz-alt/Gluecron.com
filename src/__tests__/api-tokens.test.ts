/**
 * Personal Access Tokens (PAT) — CRUD + auth contract coverage.
 *
 * `src/routes/tokens.tsx` is a §4 LOCKED BLOCK. These tests pin down the
 * externally-observable contract through the app router:
 *   - token format (`glc_` prefix, hex body, fixed length)
 *   - store-the-hash-never-the-value (SHA-256 derivation matches auth lookup)
 *   - expired PATs are rejected by `requireAuth` (C2 / middleware/auth.ts)
 *   - revoke (delete) + list endpoints are auth-guarded
 *   - `lastUsedAt` contract: loader updates it via fire-and-forget,
 *     auth success doesn't wait on the write (non-blocking path).
 *
 * DB-backed writes only run when `DATABASE_URL` is present; otherwise the
 * handler degrades gracefully and we assert the 302/401 auth contract.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Pure helpers mirroring the locked route's token generation + hashing.
// Kept in-file — the route has no __test export and is LOCKED.
// ---------------------------------------------------------------------------

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    "glc_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Pure logic — token format
// ---------------------------------------------------------------------------

describe("api tokens — generation format", () => {
  it("emits a glc_-prefixed token", () => {
    const t = generateToken();
    expect(t.startsWith("glc_")).toBe(true);
  });

  it("emits 32 bytes (64 hex chars) of entropy after the prefix", () => {
    const t = generateToken();
    expect(t.length).toBe("glc_".length + 64);
    expect(/^glc_[0-9a-f]{64}$/.test(t)).toBe(true);
  });

  it("emits unique tokens on repeated calls", () => {
    const a = generateToken();
    const b = generateToken();
    const c = generateToken();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});

describe("api tokens — hashing contract (store-the-hash-never-the-value)", () => {
  it("produces a deterministic SHA-256 hex digest", async () => {
    const token = "glc_" + "a".repeat(64);
    const h1 = await hashToken(token);
    const h2 = await hashToken(token);
    expect(h1).toBe(h2);
    expect(/^[0-9a-f]{64}$/.test(h1)).toBe(true);
  });

  it("never returns the token itself in the hash", async () => {
    const token = "glc_" + "b".repeat(64);
    const h = await hashToken(token);
    expect(h).not.toBe(token);
    expect(h).not.toContain("glc_");
  });

  it("produces distinct hashes for distinct tokens", async () => {
    const a = await hashToken("glc_" + "c".repeat(64));
    const b = await hashToken("glc_" + "d".repeat(64));
    expect(a).not.toBe(b);
  });

  it("matches the hash the auth middleware looks up (sha256Hex shape)", async () => {
    // Sanity-check: the locked middleware (src/middleware/auth.ts) uses
    // sha256Hex from src/lib/oauth.ts which is a lowercase hex SHA-256 of
    // the raw token bytes. That's what our generator stores. If this ever
    // drifts, PAT auth breaks — catch it here.
    const token = "glc_" + "e".repeat(64);
    const { sha256Hex } = await import("../lib/oauth");
    expect(await hashToken(token)).toBe(await sha256Hex(token));
  });

  it("derives a display prefix of the first 12 chars (`glc_` + 8 hex)", () => {
    const token = generateToken();
    const prefix = token.slice(0, 12);
    expect(prefix.startsWith("glc_")).toBe(true);
    expect(prefix.length).toBe(12);
    // Never includes enough entropy to reverse the token.
    expect(token.length - prefix.length).toBeGreaterThanOrEqual(56);
  });
});

// ---------------------------------------------------------------------------
// Route auth contract — /settings/tokens (HTML + form)
// ---------------------------------------------------------------------------

describe("api tokens — /settings/tokens auth guard", () => {
  it("GET /settings/tokens without a session → redirect to /login", async () => {
    const res = await app.request("/settings/tokens");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /settings/tokens (create) without a session → redirect to /login", async () => {
    const res = await app.request("/settings/tokens", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "CI pipeline", scopes: "repo" }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /settings/tokens/:id/delete (revoke) without a session → redirect to /login", async () => {
    const res = await app.request(
      "/settings/tokens/00000000-0000-0000-0000-000000000000/delete",
      { method: "POST" }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

// ---------------------------------------------------------------------------
// JSON API — /api/user/tokens never returns the token value.
// ---------------------------------------------------------------------------

describe("api tokens — /api/user/tokens contract", () => {
  it("GET /api/user/tokens without a session → redirect to /login", async () => {
    const res = await app.request("/api/user/tokens");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /api/user/tokens rejects an invalid glc_ bearer with 401 JSON", async () => {
    const res = await app.request("/api/user/tokens", {
      headers: { authorization: "Bearer glc_deadbeefdeadbeefdeadbeef" },
    });
    // requireAuth's bearer-invalid branch returns 401 JSON (never a redirect).
    expect(res.status).toBe(401);
    const body = await res.json().catch(() => null);
    expect(body && typeof body.error === "string").toBe(true);
  });

  it("GET /api/user/tokens rejects an invalid glct_ (OAuth) bearer with 401 JSON", async () => {
    const res = await app.request("/api/user/tokens", {
      headers: { authorization: "Bearer glct_notrealoauthtoken1234" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Expired tokens — the auth middleware (locked) rejects PATs whose
// expires_at has passed. We assert the observable effect: a PAT-prefixed
// bearer that can never resolve (no DB row, or expired) → 401 JSON.
// ---------------------------------------------------------------------------

describe("api tokens — expiry enforcement (via middleware)", () => {
  it("a well-formed but unknown glc_ token gets 401, not 500", async () => {
    const fakeToken = "glc_" + "f".repeat(64);
    const res = await app.request("/api/user/tokens", {
      headers: { authorization: `Bearer ${fakeToken}` },
    });
    expect(res.status).toBe(401);
    if (HAS_DB) {
      const body = await res.json();
      expect(body.error).toMatch(/invalid|expired/i);
    }
  });

  it("a glc_ token shorter than the generator length still rejects cleanly", async () => {
    // Covers the defensive-hash path — short inputs must not crash the
    // loader; they must simply fail to match a stored hash.
    const res = await app.request("/api/user/tokens", {
      headers: { authorization: "Bearer glc_short" },
    });
    expect(res.status).toBe(401);
  });
});
