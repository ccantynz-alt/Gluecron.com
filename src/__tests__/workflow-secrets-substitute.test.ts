/**
 * Pure-helper tests for src/lib/workflow-secrets.ts substituteSecrets.
 *
 * loadSecretsContext / upsert / delete are DB-coupled so they're not
 * exercised here — the crypto round-trip lives in
 * workflow-secrets-crypto.test.ts. This file pins the pure substitution
 * grammar so the runner's secret-injection contract can be relied on
 * without instantiating Postgres.
 */

import { describe, it, expect } from "bun:test";
import { substituteSecrets } from "../lib/workflow-secrets";

describe("substituteSecrets — happy path", () => {
  it("replaces a single token with the matching plaintext", () => {
    const out = substituteSecrets(
      'echo "$TOKEN_${{ secrets.TOKEN }}"',
      { TOKEN: "abc123" }
    );
    expect(out).toBe('echo "$TOKEN_abc123"');
  });

  it("replaces multiple tokens in one template", () => {
    const out = substituteSecrets(
      "DEPLOY_KEY=${{ secrets.DEPLOY_KEY }} REGION=${{ secrets.REGION }}",
      { DEPLOY_KEY: "k1", REGION: "us-east-1" }
    );
    expect(out).toBe("DEPLOY_KEY=k1 REGION=us-east-1");
  });

  it("tolerates whitespace variants inside the braces", () => {
    const map = { X: "v" };
    expect(substituteSecrets("${{secrets.X}}", map)).toBe("v");
    expect(substituteSecrets("${{ secrets.X }}", map)).toBe("v");
    expect(substituteSecrets("${{   secrets   .   X   }}", map)).toBe("v");
  });

  it("repeats substitution when a name appears multiple times", () => {
    const out = substituteSecrets(
      "${{ secrets.X }} and again ${{ secrets.X }}",
      { X: "yes" }
    );
    expect(out).toBe("yes and again yes");
  });
});

describe("substituteSecrets — leaves tokens intact when secret is missing", () => {
  it("missing name → token unchanged (loud failure signal)", () => {
    const tpl = "echo ${{ secrets.MISSING }}";
    expect(substituteSecrets(tpl, {})).toBe(tpl);
    expect(substituteSecrets(tpl, { OTHER: "x" })).toBe(tpl);
  });

  it("substitutes the matching tokens and leaves the missing ones", () => {
    const out = substituteSecrets(
      "${{ secrets.A }} / ${{ secrets.B }} / ${{ secrets.C }}",
      { A: "a", C: "c" }
    );
    expect(out).toBe("a / ${{ secrets.B }} / c");
  });
});

describe("substituteSecrets — strict name grammar", () => {
  it("rejects lowercase names (matches GitHub Actions grammar)", () => {
    const tpl = "echo ${{ secrets.lower }}";
    expect(substituteSecrets(tpl, { lower: "x" })).toBe(tpl);
  });

  it("rejects names starting with a digit", () => {
    const tpl = "echo ${{ secrets.1ABC }}";
    expect(substituteSecrets(tpl, { "1ABC": "x" })).toBe(tpl);
  });

  it("accepts underscore-only names + names with digits", () => {
    expect(
      substituteSecrets("${{ secrets.A_B_C }}", { A_B_C: "v" })
    ).toBe("v");
    expect(
      substituteSecrets("${{ secrets._UNDER }}", { _UNDER: "v" })
    ).toBe("v");
    expect(
      substituteSecrets("${{ secrets.X1Y2 }}", { X1Y2: "v" })
    ).toBe("v");
  });
});

describe("substituteSecrets — defensive on bad input", () => {
  it("returns '' for non-string template", () => {
    expect(substituteSecrets(undefined as any, {})).toBe("");
    expect(substituteSecrets(null as any, {})).toBe("");
    expect(substituteSecrets(42 as any, {})).toBe("");
  });

  it("returns the template untouched when secrets is null/undefined", () => {
    expect(substituteSecrets("hello", null as any)).toBe("hello");
    expect(substituteSecrets("hello", undefined as any)).toBe("hello");
  });

  it("returns '' when both inputs are empty", () => {
    expect(substituteSecrets("", {})).toBe("");
  });

  it("ignores prototype-pollution probes (uses hasOwnProperty)", () => {
    const tpl = "${{ secrets.TO_STRING }}";
    // {}.toString exists on the prototype; substitution must NOT pick it up.
    expect(substituteSecrets(tpl, {} as any)).toBe(tpl);
  });

  it("does not alter unrelated `${{ ... }}` syntax (env, vars)", () => {
    const tpl = "${{ env.FOO }} ${{ vars.BAR }}";
    expect(substituteSecrets(tpl, { FOO: "v" })).toBe(tpl);
  });
});
