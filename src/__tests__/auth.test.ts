import { describe, it, expect } from "bun:test";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  sessionExpiry,
} from "../lib/auth";

describe("auth utilities", () => {
  it("should hash and verify passwords", async () => {
    const password = `test${Math.random().toString(36).slice(2)}`;
    const hash = await hashPassword(password);

    expect(hash).toBeTruthy();
    expect(hash).not.toBe(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("wrongpassword", hash)).toBe(false);
  });

  it("should generate unique session tokens", () => {
    const token1 = generateSessionToken();
    const token2 = generateSessionToken();

    expect(token1).toBeTruthy();
    expect(token1.length).toBe(64); // 32 bytes hex
    expect(token1).not.toBe(token2);
  });

  it("should create future session expiry", () => {
    const expiry = sessionExpiry();
    const now = new Date();

    expect(expiry.getTime()).toBeGreaterThan(now.getTime());
    // Should be ~30 days from now
    const diffDays =
      (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });
});