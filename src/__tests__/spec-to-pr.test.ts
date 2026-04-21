import { describe, it, expect, afterEach } from "bun:test";
import { createSpecPR } from "../lib/spec-to-pr";

describe("createSpecPR", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns ok:false when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await createSpecPR({ repoId: 1, spec: "test", userId: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ANTHROPIC_API_KEY");
  });

  it("returns ok:false with a clear experimental notice when key is set", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key-for-testing";
    const result = await createSpecPR({ repoId: -999, spec: "test", userId: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
