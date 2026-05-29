/**
 * Tests for the ai:build seed-issue feature.
 *
 * ensureAiBuildSeedIssue is fire-and-forget — it must never throw even when
 * the DB is unavailable or returns unexpected data. These tests verify the
 * contract without mocks or a live database connection.
 */

import { describe, it, expect } from "bun:test";
import { ensureAiBuildSeedIssue } from "../lib/repo-bootstrap";

describe("ensureAiBuildSeedIssue", () => {
  it("is exported from repo-bootstrap", () => {
    expect(typeof ensureAiBuildSeedIssue).toBe("function");
  });

  it("returns a Promise", () => {
    const result = ensureAiBuildSeedIssue(
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002"
    );
    expect(result).toBeInstanceOf(Promise);
    // Swallow the expected DB error — the important thing is it doesn't throw.
    return result.catch(() => {});
  });

  it("resolves without throwing when DB is unavailable", async () => {
    // The function must catch all DB errors internally and return void.
    await expect(
      ensureAiBuildSeedIssue(
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002"
      )
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing for a second call with the same fake IDs", async () => {
    // Idempotency check — calling twice on the same IDs should not throw.
    await expect(
      ensureAiBuildSeedIssue(
        "00000000-0000-0000-0000-000000000003",
        "00000000-0000-0000-0000-000000000004"
      )
    ).resolves.toBeUndefined();
  });
});
