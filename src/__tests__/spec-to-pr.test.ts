import { describe, it, expect, afterEach } from "bun:test";
import { createSpecPR } from "../lib/spec-to-pr";

/**
 * The real pipeline (context → AI → git → PR insert) lives in
 * `spec-context`, `spec-ai`, and `spec-git` tests. Here we only cover the
 * fail-fast guards that don't require DB/disk/AI.
 */
describe("createSpecPR", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns ok:false when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await createSpecPR({
      repoId: "00000000-0000-0000-0000-000000000000",
      spec: "test",
      userId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("returns ok:false when spec is empty", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key-for-testing";
    const result = await createSpecPR({
      repoId: "00000000-0000-0000-0000-000000000000",
      spec: "   ",
      userId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty");
    }
  });
});
