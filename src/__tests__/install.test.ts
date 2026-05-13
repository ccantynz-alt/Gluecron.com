/**
 * Block L2 — one-command install.
 *
 * Coverage:
 *   - GET /install returns 200 + the bash script + correct headers
 *   - POST /api/v2/auth/install-token refuses Bearer-token callers
 *   - POST /api/v2/auth/install-token refuses unauthenticated callers
 *   - POST /api/v2/auth/install-token mints a PAT + writes an audit row when
 *     called over a real session cookie (DB-backed)
 *
 * The DB-backed test is gated on `DATABASE_URL` so the suite still runs in
 * environments without Postgres — matching the convention used elsewhere
 * (see `api-tokens.test.ts`).
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { INSTALL_SCRIPT_SRC } from "../routes/install";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// 1. GET /install — the curl-able installer
// ---------------------------------------------------------------------------

describe("install — GET /install", () => {
  it("returns 200 with the bash script body", async () => {
    const res = await app.request("/install");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body.startsWith("#!")).toBe(true);
  });

  it("serves Content-Type: text/x-shellscript", async () => {
    const res = await app.request("/install");
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("text/x-shellscript");
  });

  it("serves a public Cache-Control so a CDN can absorb load", async () => {
    const res = await app.request("/install");
    const cc = res.headers.get("cache-control") || "";
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=300");
  });

  it("script body contains the key install-flow markers", async () => {
    const res = await app.request("/install");
    const body = await res.text();
    // Sanity-check the actual script (or fallback) loaded into memory.
    expect(body).toContain("#!/usr/bin/env bash");
    if (INSTALL_SCRIPT_SRC.includes("set -euo pipefail")) {
      // Real script path — assert the user-facing flow it promises.
      expect(body).toContain("set -euo pipefail");
      expect(body).toContain("/api/v2/auth/install-token");
      expect(body).toContain("claude_desktop_config.json");
      expect(body).toContain("mcpServers");
    }
  });

  it("INSTALL_SCRIPT_SRC exports a non-empty bash script", () => {
    expect(INSTALL_SCRIPT_SRC.length).toBeGreaterThan(0);
    expect(INSTALL_SCRIPT_SRC.startsWith("#!")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. POST /api/v2/auth/install-token — auth contract
// ---------------------------------------------------------------------------

describe("install-token — auth contract", () => {
  it("rejects Bearer tokens outright with 401 JSON", async () => {
    // Unknown / unresolvable bearer — the apiAuth middleware short-circuits
    // before our handler runs, but the contract for the caller is the same:
    // 401 JSON with an `error` string. The whole point is that a Bearer
    // caller *never* gets a 200 + a fresh PAT.
    const res = await app.request("/api/v2/auth/install-token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer glc_" + "a".repeat(64),
      },
      body: JSON.stringify({ name: "abuse", scope: "admin" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("rejects malformed Bearer (no token) the same way", async () => {
    const res = await app.request("/api/v2/auth/install-token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ",
      },
      body: JSON.stringify({}),
    });
    // Either the apiAuth middleware fails the bearer lookup (401) or we
    // hit our own bearer-reject branch (401). Either is acceptable; the
    // important invariant is "never 200".
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated callers with 401 JSON", async () => {
    const res = await app.request("/api/v2/auth/install-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(JSON.stringify(body).toLowerCase()).toContain("session");
  });

  it("rejects an empty body without a session", async () => {
    const res = await app.request("/api/v2/auth/install-token", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 3. POST /api/v2/auth/install-token — successful mint (DB-backed)
// ---------------------------------------------------------------------------

describe("install-token — successful mint", () => {
  it.skipIf(!HAS_DB)(
    "mints a glc_ PAT + writes auth.install_token.created audit row",
    async () => {
      const { db } = await import("../db");
      const { users, sessions, apiTokens, auditLog } = await import(
        "../db/schema"
      );
      const { eq, and, desc } = await import("drizzle-orm");

      // Set up a one-off user + session purely for this test.
      const uname = "install-test-" + Math.random().toString(36).slice(2, 10);
      const [user] = await db
        .insert(users)
        .values({
          username: uname,
          email: `${uname}@example.com`,
          passwordHash: "x",
        })
        .returning();

      const sessionToken =
        "sess_test_" + Math.random().toString(36).slice(2) + Date.now();
      const expiresAt = new Date(Date.now() + 60_000);
      await db.insert(sessions).values({
        userId: user.id,
        token: sessionToken,
        expiresAt,
      });

      try {
        const res = await app.request("/api/v2/auth/install-token", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `session=${sessionToken}`,
          },
          body: JSON.stringify({ name: "ci-install", scope: "admin" }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(typeof body.token).toBe("string");
        expect(body.token.startsWith("glc_")).toBe(true);
        expect(body.token.length).toBe("glc_".length + 64);
        expect(body.name).toBe("ci-install");
        expect(body.scope).toBe("admin");
        expect(body.id).toBeDefined();

        // PAT row exists with the right prefix + scopes.
        const [row] = await db
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.id, body.id))
          .limit(1);
        expect(row).toBeDefined();
        expect(row!.userId).toBe(user.id);
        expect(row!.name).toBe("ci-install");
        expect(row!.scopes).toContain("admin");
        expect(row!.tokenPrefix).toBe(body.token.slice(0, 12));

        // Audit row written under the expected action name.
        const [audit] = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.userId, user.id),
              eq(auditLog.action, "auth.install_token.created")
            )
          )
          .orderBy(desc(auditLog.createdAt))
          .limit(1);
        expect(audit).toBeDefined();
        expect(audit!.targetType).toBe("api_token");
        expect(audit!.targetId).toBe(body.id);
      } finally {
        // Best-effort cleanup. Cascade on users covers sessions + tokens.
        try {
          await db.delete(users).where(eq(users.id, user.id));
        } catch {
          /* ignore */
        }
      }
    }
  );

  it.skipIf(!HAS_DB)(
    "defaults name + scope when body is empty",
    async () => {
      const { db } = await import("../db");
      const { users, sessions, apiTokens } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");

      const uname = "install-test2-" + Math.random().toString(36).slice(2, 10);
      const [user] = await db
        .insert(users)
        .values({
          username: uname,
          email: `${uname}@example.com`,
          passwordHash: "x",
        })
        .returning();

      const sessionToken =
        "sess_test_" + Math.random().toString(36).slice(2) + Date.now();
      await db.insert(sessions).values({
        userId: user.id,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 60_000),
      });

      try {
        const res = await app.request("/api/v2/auth/install-token", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `session=${sessionToken}`,
          },
          body: "",
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.scope).toBe("admin");
        expect(typeof body.name).toBe("string");
        expect(body.name.startsWith("gluecron-install-")).toBe(true);

        const [row] = await db
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.id, body.id))
          .limit(1);
        expect(row).toBeDefined();
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
