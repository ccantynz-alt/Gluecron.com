/**
 * Block K2 — Agent identity wrapper tests.
 *
 * Pure helpers + graceful-null-return DB paths only. Style follows
 * commit-statuses.test.ts: tight `describe` groups, single-assertion-ish
 * `it` blocks, no live DB dependency.
 */

import { describe, it, expect } from "bun:test";
import {
  AGENT_PERMISSIONS,
  AGENT_SLUG_PREFIX,
  agentSlug,
  ensureAgentApp,
  installAgentForRepo,
  isAgentBotUsername,
  isAgentPermission,
  issueAgentToken,
  normaliseAgentPermissions,
  parseAgentPermissions,
  requireAgentPermission,
  revokeAgentToken,
  revokeAgentTokenByRaw,
  uninstallAgent,
  verifyAgentToken,
} from "../lib/agent-identity";
import { hasPermission } from "../lib/marketplace";

describe("agent-identity — AGENT_PERMISSIONS vocabulary", () => {
  it("includes the full marketplace read/write pairs", () => {
    for (const family of [
      "contents",
      "issues",
      "pulls",
      "checks",
      "deployments",
    ]) {
      expect(AGENT_PERMISSIONS).toContain(`${family}:read`);
      expect(AGENT_PERMISSIONS).toContain(`${family}:write`);
    }
    expect(AGENT_PERMISSIONS).toContain("metadata:read");
  });

  it("adds the new agent:invoke permission", () => {
    expect(AGENT_PERMISSIONS).toContain("agent:invoke");
  });

  it("has no duplicates", () => {
    const set = new Set(AGENT_PERMISSIONS);
    expect(set.size).toBe(AGENT_PERMISSIONS.length);
  });
});

describe("agent-identity — isAgentPermission", () => {
  it("accepts every declared permission", () => {
    for (const p of AGENT_PERMISSIONS) {
      expect(isAgentPermission(p)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isAgentPermission("bogus:thing")).toBe(false);
    expect(isAgentPermission("")).toBe(false);
    expect(isAgentPermission("CONTENTS:READ")).toBe(false);
  });
});

describe("agent-identity — normaliseAgentPermissions", () => {
  it("drops unknown values", () => {
    const out = normaliseAgentPermissions([
      "contents:read",
      "bogus",
      "agent:invoke",
    ]);
    expect(out).toEqual(["contents:read", "agent:invoke"]);
  });

  it("de-duplicates and preserves first-appearance order", () => {
    const out = normaliseAgentPermissions([
      "issues:write",
      "contents:read",
      "issues:write",
      "contents:read",
    ]);
    expect(out).toEqual(["issues:write", "contents:read"]);
  });

  it("returns [] for empty input", () => {
    expect(normaliseAgentPermissions([])).toEqual([]);
  });
});

describe("agent-identity — parseAgentPermissions", () => {
  it("reads JSON array out of DB column", () => {
    const raw = JSON.stringify(["contents:read", "agent:invoke", "bogus"]);
    expect(parseAgentPermissions(raw)).toEqual([
      "contents:read",
      "agent:invoke",
    ]);
  });

  it("handles null / undefined / empty / invalid JSON", () => {
    expect(parseAgentPermissions(null)).toEqual([]);
    expect(parseAgentPermissions(undefined)).toEqual([]);
    expect(parseAgentPermissions("")).toEqual([]);
    expect(parseAgentPermissions("not json")).toEqual([]);
    expect(parseAgentPermissions("{}")).toEqual([]);
  });
});

describe("agent-identity — agentSlug", () => {
  it("prefixes bare kinds with agent-", () => {
    expect(agentSlug("reviewer")).toBe("agent-reviewer");
  });

  it("leaves already-prefixed slugs alone", () => {
    expect(agentSlug("agent-reviewer")).toBe("agent-reviewer");
  });

  it("lowercases + collapses punctuation", () => {
    expect(agentSlug("AI Reviewer!")).toBe("agent-ai-reviewer");
  });

  it("falls back to agent-unknown on empty/whitespace input", () => {
    expect(agentSlug("")).toBe("agent-unknown");
    expect(agentSlug("   ")).toBe("agent-unknown");
  });

  it("exports the expected prefix constant", () => {
    expect(AGENT_SLUG_PREFIX).toBe("agent-");
  });
});

describe("agent-identity — isAgentBotUsername", () => {
  it("accepts agent-* bots", () => {
    expect(isAgentBotUsername("agent-reviewer[bot]")).toBe(true);
    expect(isAgentBotUsername("agent-merge-sentry[bot]")).toBe(true);
  });

  it("rejects non-agent bots and plain usernames", () => {
    expect(isAgentBotUsername("dependabot[bot]")).toBe(false);
    expect(isAgentBotUsername("agent-reviewer")).toBe(false);
    expect(isAgentBotUsername("alice")).toBe(false);
    expect(isAgentBotUsername("")).toBe(false);
    expect(isAgentBotUsername(null)).toBe(false);
    expect(isAgentBotUsername(undefined)).toBe(false);
  });
});

describe("agent-identity — hasPermission (through this layer)", () => {
  it("write implies read on every family", () => {
    expect(hasPermission(["contents:write"], "contents:read")).toBe(true);
    expect(hasPermission(["issues:write"], "issues:read")).toBe(true);
    expect(hasPermission(["pulls:write"], "pulls:read")).toBe(true);
    expect(hasPermission(["checks:write"], "checks:read")).toBe(true);
    expect(hasPermission(["deployments:write"], "deployments:read")).toBe(true);
  });

  it("read does NOT imply write", () => {
    expect(hasPermission(["contents:read"], "contents:write")).toBe(false);
    expect(hasPermission(["pulls:read"], "pulls:write")).toBe(false);
  });

  it("exact match still wins", () => {
    expect(hasPermission(["agent:invoke"], "agent:invoke")).toBe(true);
  });

  it("missing permission returns false", () => {
    expect(hasPermission([], "contents:read")).toBe(false);
    expect(hasPermission(["metadata:read"], "contents:read")).toBe(false);
  });
});

describe("agent-identity — verifyAgentToken", () => {
  it("rejects tokens without the ghi_ prefix", async () => {
    expect(await verifyAgentToken("")).toBeNull();
    expect(await verifyAgentToken("glc_not_an_install_token")).toBeNull();
    expect(await verifyAgentToken("ghp_personal_token")).toBeNull();
    expect(await verifyAgentToken("bearer whatever")).toBeNull();
  });

  it("rejects an obviously-bogus ghi_ token (no matching install)", async () => {
    // No DATABASE_URL in this test env → verifyInstallToken returns null.
    expect(await verifyAgentToken("ghi_deadbeef")).toBeNull();
  });
});

describe("agent-identity — requireAgentPermission", () => {
  it("throws on invalid/missing tokens", async () => {
    await expect(
      requireAgentPermission("", "contents:read")
    ).rejects.toThrow(/invalid|expired/);
    await expect(
      requireAgentPermission("ghi_deadbeef", "contents:read")
    ).rejects.toThrow(/invalid|expired/);
  });
});

describe("agent-identity — DB helpers fail gracefully", () => {
  it("ensureAgentApp returns null when DB is unreachable", async () => {
    const out = await ensureAgentApp("reviewer", "Reviewer", [
      "contents:read",
    ]);
    // Test env has no DATABASE_URL so this must degrade to null, not throw.
    expect(out).toBeNull();
  });

  it("installAgentForRepo returns null when app is missing / DB down", async () => {
    const out = await installAgentForRepo(
      "agent-nope",
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-0000-000000000000",
      ["contents:read"]
    );
    expect(out).toBeNull();
  });

  it("issueAgentToken returns null when no install exists", async () => {
    const out = await issueAgentToken(
      "agent-nope",
      "00000000-0000-0000-0000-000000000000"
    );
    expect(out).toBeNull();
  });

  it("revokeAgentToken returns false for empty hash / unknown token", async () => {
    expect(await revokeAgentToken("")).toBe(false);
    expect(await revokeAgentToken("not-a-real-hash")).toBe(false);
  });

  it("revokeAgentTokenByRaw returns false for empty / unknown tokens", async () => {
    expect(await revokeAgentTokenByRaw("")).toBe(false);
    expect(await revokeAgentTokenByRaw("ghi_never_issued")).toBe(false);
  });

  it("uninstallAgent returns false when app/install missing", async () => {
    expect(
      await uninstallAgent(
        "agent-nope",
        "00000000-0000-0000-0000-000000000000"
      )
    ).toBe(false);
  });
});
