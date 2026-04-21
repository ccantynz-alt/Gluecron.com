/**
 * Invite token helpers + /invites/:token smoke.
 *
 * We exercise the pure-crypto helpers exhaustively (cheap, deterministic)
 * and hit the route with a bogus token to prove the not-found branch works
 * without needing a DB seeded invite. A DB-seeded happy-path test would
 * require fixture plumbing that the existing collaborators.test.ts also
 * avoids, so we stay consistent.
 */

import { describe, it, expect } from "bun:test";
import {
  generateInviteToken,
  hashInviteToken,
} from "../lib/invite-tokens";
import app from "../app";

describe("invite-tokens lib", () => {
  it("generateInviteToken emits 32 hex chars and is unique across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const t = generateInviteToken();
      expect(t).toMatch(/^[0-9a-f]{32}$/);
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
  });

  it("hashInviteToken is deterministic and differs per input", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(hashInviteToken(a)).toBe(hashInviteToken(a));
    expect(hashInviteToken(a)).not.toBe(hashInviteToken(b));
    // sha256 hex is 64 chars.
    expect(hashInviteToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("GET /invites/:token", () => {
  it("returns 404 for a bogus token", async () => {
    const res = await app.request("/invites/not-a-real-token-xxxxxxxxxxxxxxxx");
    // 404 is the expected path. If the DB is unreachable in the test env the
    // route's try/catch still maps that to not-found, so 404 is the single
    // acceptable status.
    expect(res.status).toBe(404);
  });
});
