/**
 * Block D6 — AI "Explain this codebase" tests.
 *
 * These run without a live database. The lib function is specified never
 * to throw; the route responds with 404 on unknown repos and gracefully
 * degrades when the DB proxy is unavailable (503).
 */

import { describe, it, expect } from "bun:test";
import {
  explainCodebase,
  getCachedExplanation,
} from "../lib/ai-explain";

describe("lib/ai-explain — module shape", () => {
  it("exports the expected functions", () => {
    expect(typeof explainCodebase).toBe("function");
    expect(typeof getCachedExplanation).toBe("function");
  });
});

describe("lib/ai-explain — explainCodebase", () => {
  it("returns the fallback shape for a bogus owner/repo without throwing", async () => {
    const result = await explainCodebase({
      owner: "does-not-exist",
      repo: "neither-does-this",
      repositoryId: "00000000-0000-0000-0000-000000000000",
      commitSha: "0".repeat(40),
    });
    expect(result).toBeDefined();
    expect(typeof result.markdown).toBe("string");
    expect(typeof result.summary).toBe("string");
    expect(typeof result.model).toBe("string");
    expect(result.cached).toBe(false);
    // When there is no bare git repo, no files can be sampled and the
    // helper falls through to the canonical "unable to generate" message.
    expect(result.markdown).toBe("_Unable to generate explanation._");
    expect(result.model).toBe("fallback");
  });

  it("never throws even when both the DB and git repo are missing", async () => {
    await expect(
      explainCodebase({
        owner: "alice",
        repo: "project",
        repositoryId: "00000000-0000-0000-0000-000000000000",
        commitSha: "deadbeef".repeat(5),
        force: true,
      })
    ).resolves.toBeDefined();
  });
});

describe("lib/ai-explain — getCachedExplanation", () => {
  it("returns null on cache miss / unavailable DB without throwing", async () => {
    const result = await getCachedExplanation(
      "00000000-0000-0000-0000-000000000000",
      "0".repeat(40)
    );
    expect(result).toBeNull();
  });
});

describe("routes/ai-explain — guards", () => {
  it("direct GET /:owner/:repo/explain 404s when repo does not exist", async () => {
    const { default: aiExplainRoutes } = await import("../routes/ai-explain");
    const res = await aiExplainRoutes.request("/alice/does-not-exist/explain");
    // 404 when the DB reports no such repo; 503 when the DB proxy is down.
    expect([404, 503]).toContain(res.status);
  });

  it("direct POST /:owner/:repo/explain/regenerate without auth redirects to /login or 404s", async () => {
    const { default: aiExplainRoutes } = await import("../routes/ai-explain");
    const res = await aiExplainRoutes.request(
      "/alice/does-not-exist/explain/regenerate",
      {
        method: "POST",
        redirect: "manual",
      }
    );
    expect([302, 303, 404, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });
});
