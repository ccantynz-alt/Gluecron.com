/**
 * Tests for the dual-driver detection in src/db/index.ts.
 * Verifies which DATABASE_URL hosts route to Neon vs postgres.js.
 */
import { describe, expect, it } from "bun:test";
import { isNeonUrl } from "../db";

describe("isNeonUrl", () => {
  it("true for Neon US-East endpoint", () => {
    expect(
      isNeonUrl(
        "postgresql://user:pw@ep-cool-name-123.us-east-2.aws.neon.tech/db"
      )
    ).toBe(true);
  });

  it("true for Neon EU endpoint with sslmode", () => {
    expect(
      isNeonUrl(
        "postgres://u:p@ep-x.eu-central-1.aws.neon.tech/d?sslmode=require"
      )
    ).toBe(true);
  });

  it("true for bare neon.tech root", () => {
    expect(isNeonUrl("postgresql://u:p@neon.tech/db")).toBe(true);
  });

  it("false for localhost", () => {
    expect(isNeonUrl("postgresql://u:p@127.0.0.1:5432/db")).toBe(false);
    expect(isNeonUrl("postgresql://u:p@localhost:5432/db")).toBe(false);
  });

  it("false for RDS", () => {
    expect(
      isNeonUrl(
        "postgres://u:p@db.example.us-east-1.rds.amazonaws.com:5432/d"
      )
    ).toBe(false);
  });

  it("false for Supabase", () => {
    expect(
      isNeonUrl("postgres://u:p@db.abcd.supabase.co:5432/postgres")
    ).toBe(false);
  });

  it("false for malformed URL (graceful fallback to TCP driver)", () => {
    expect(isNeonUrl("not-a-url")).toBe(false);
    expect(isNeonUrl("")).toBe(false);
  });

  it("does not match domains that merely contain 'neon.tech' as a substring", () => {
    expect(isNeonUrl("postgres://u:p@evil-neon.tech.example.com/db")).toBe(
      false
    );
  });
});
