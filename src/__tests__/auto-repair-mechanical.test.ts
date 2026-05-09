/**
 * Tests for the mechanical-repair classifier.
 * The actual repair handlers do real subprocess work + git ops; those
 * are covered by a separate integration test path. Here we lock down
 * the cheap-and-deterministic classifier that decides whether a failure
 * even has a mechanical handler.
 */
import { describe, expect, it } from "bun:test";
import { classifyFailure } from "../lib/auto-repair-mechanical";

describe("classifyFailure", () => {
  it("detects bun lockfile drift", () => {
    expect(classifyFailure("error: lockfile is out of sync")).toBe("lockfile");
    expect(
      classifyFailure(
        "bun install failed: bun.lock is outdated relative to package.json",
      ),
    ).toBe("lockfile");
    expect(
      classifyFailure("error: --frozen-lockfile failed: lockfile mismatch"),
    ).toBe("lockfile");
  });

  it("detects npm lockfile drift", () => {
    expect(
      classifyFailure(
        "npm error code EUSAGE: package-lock.json is not in sync with package.json",
      ),
    ).toBe("lockfile");
  });

  it("detects formatting failures across tools", () => {
    expect(
      classifyFailure("12 files would be reformatted with prettier"),
    ).toBe("formatting");
    expect(
      classifyFailure("style/formatting check failed: see ./biome-report"),
    ).toBe("formatting");
    expect(classifyFailure("biome ci . — format errors found")).toBe(
      "formatting",
    );
    expect(classifyFailure("bun fmt would change 4 files")).toBe(
      "formatting",
    );
  });

  it("detects import-order failures", () => {
    expect(classifyFailure("imports are not sorted: src/foo.ts:3")).toBe(
      "imports",
    );
    expect(
      classifyFailure(
        "lint/correctness/organize-imports: imports must be ordered",
      ),
    ).toBe("imports");
    expect(classifyFailure("import/order: groups out of order")).toBe(
      "imports",
    );
    expect(classifyFailure("unused-imports: 3 unused imports found")).toBe(
      "imports",
    );
  });

  it("returns null for everything that's not mechanically fixable", () => {
    expect(classifyFailure("expected 1 to equal 2")).toBeNull();
    expect(
      classifyFailure(
        "TypeError: Cannot read property 'foo' of undefined at index.ts:42",
      ),
    ).toBeNull();
    expect(classifyFailure("ECONNREFUSED 127.0.0.1:5432")).toBeNull();
    expect(classifyFailure("")).toBeNull();
    expect(classifyFailure("random unrelated noise from CI")).toBeNull();
  });

  it("is case-insensitive on the heuristic match", () => {
    expect(classifyFailure("LOCKFILE IS OUT OF SYNC")).toBe("lockfile");
    expect(classifyFailure("Prettier: 1 file would be reformatted")).toBe(
      "formatting",
    );
  });
});
