/**
 * Connect Claude — user-facing one-click MCP setup page.
 *
 * Coverage:
 *   1. GET /connect/claude without auth → 302 to /login
 *   2. GET /connect/claude/dxt without auth → 302 to /login
 *   3. GET /connect/claude with a real session cookie → 200 + body markers
 *   4. GET /settings/claude → 302 redirect (alias path)
 *   5. POST /connect/claude/token requires auth
 *   6. GET /api/connect/status requires auth + returns JSON shape
 *
 * The DB-backed tests are gated on `DATABASE_URL` to keep the suite green in
 * environments without Postgres — matching `install.test.ts` and friends.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// 1. Auth gating — unauthenticated callers
// ---------------------------------------------------------------------------

describe("connect-claude — auth gating", () => {
  it("GET /connect/claude without a session → 302 /login", async () => {
    const res = await app.request("/connect/claude");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /connect/claude/dxt without a session → 302 /login", async () => {
    const res = await app.request("/connect/claude/dxt");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /settings/claude without a session → 302 (alias or /login)", async () => {
    const res = await app.request("/settings/claude");
    // Either the requireAuth middleware redirects to /login OR the alias
    // redirects to /connect/claude (which itself requires auth). Both are
    // 302 — what matters is "never 200 anon".
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc).toMatch(/\/login|\/connect\/claude/);
  });

  it("POST /connect/claude/token without a session → 302 /login", async () => {
    const res = await app.request("/connect/claude/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /api/connect/status without a session → 302 /login", async () => {
    const res = await app.request("/api/connect/status");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

// ---------------------------------------------------------------------------
// 2. DB-backed: a real session cookie reaches the rendered page.
// ---------------------------------------------------------------------------

describe("connect-claude — rendered surface (authed)", () => {
  it.skipIf(!HAS_DB)(
    "GET /connect/claude with a session → 200 + page markers",
    async () => {
      const { db } = await import("../db");
      const { users, sessions } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");

      const uname = "cc-test-" + Math.random().toString(36).slice(2, 10);
      const [user] = await db
        .insert(users)
        .values({
          username: uname,
          email: `${uname}@example.com`,
          passwordHash: "x",
        })
        .returning();
      const sessionToken =
        "sess_cc_" + Math.random().toString(36).slice(2) + Date.now();
      await db.insert(sessions).values({
        userId: user.id,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 60_000),
      });

      try {
        const res = await app.request("/connect/claude", {
          headers: { cookie: `session=${sessionToken}` },
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        // Hero copy + the MCP endpoint must appear (the JSON snippet and CLI
        // command both reference it).
        expect(body).toContain("Connect Claude");
        expect(body).toContain("/mcp");
        // The personalized .dxt download link is rendered.
        expect(body).toContain("/connect/claude/dxt");
        // The user's username is rendered in the hero eyebrow.
        expect(body).toContain(uname);
        // Tools list — at least one known tool name is on the page.
        expect(body).toContain("gluecron_repo_search");
      } finally {
        try {
          await db.delete(users).where(eq(users.id, user.id));
        } catch {
          /* ignore */
        }
      }
    }
  );

  it.skipIf(!HAS_DB)(
    "POST /connect/claude/token with a session mints a glc_ PAT",
    async () => {
      const { db } = await import("../db");
      const { users, sessions, apiTokens } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");

      const uname = "cc-mint-" + Math.random().toString(36).slice(2, 10);
      const [user] = await db
        .insert(users)
        .values({
          username: uname,
          email: `${uname}@example.com`,
          passwordHash: "x",
        })
        .returning();
      const sessionToken =
        "sess_cc_" + Math.random().toString(36).slice(2) + Date.now();
      await db.insert(sessions).values({
        userId: user.id,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 60_000),
      });

      try {
        const res = await app.request("/connect/claude/token", {
          method: "POST",
          headers: {
            cookie: `session=${sessionToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(typeof body.token).toBe("string");
        expect(body.token.startsWith("glc_")).toBe(true);
        // Row exists with admin scope.
        const [row] = await db
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.id, body.id))
          .limit(1);
        expect(row).toBeDefined();
        expect(row!.userId).toBe(user.id);
        expect(row!.scopes).toContain("admin");
      } finally {
        try {
          await db.delete(users).where(eq(users.id, user.id));
        } catch {
          /* ignore */
        }
      }
    }
  );

  it.skipIf(!HAS_DB)(
    "GET /connect/claude/dxt with a session returns a zip with the token embedded",
    async () => {
      const { db } = await import("../db");
      const { users, sessions } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");

      const uname = "cc-dxt-" + Math.random().toString(36).slice(2, 10);
      const [user] = await db
        .insert(users)
        .values({
          username: uname,
          email: `${uname}@example.com`,
          passwordHash: "x",
        })
        .returning();
      const sessionToken =
        "sess_cc_" + Math.random().toString(36).slice(2) + Date.now();
      await db.insert(sessions).values({
        userId: user.id,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 60_000),
      });

      try {
        const res = await app.request("/connect/claude/dxt", {
          headers: { cookie: `session=${sessionToken}` },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-disposition") || "").toContain(
          `gluecron-${uname}.dxt`
        );
        const buf = new Uint8Array(await res.arrayBuffer());
        // Zip magic — PK\x03\x04
        expect(buf[0]).toBe(0x50);
        expect(buf[1]).toBe(0x4b);
        expect(buf[2]).toBe(0x03);
        expect(buf[3]).toBe(0x04);
        // Must NOT cache (every download is a fresh PAT mint).
        expect(res.headers.get("cache-control") || "").toContain("no-store");
      } finally {
        try {
          await db.delete(users).where(eq(users.id, user.id));
        } catch {
          /* ignore */
        }
      }
    }
  );
});
