/**
 * Unit tests for src/lib/workflow-conditionals.ts (Agent 4, Sprint 1).
 *
 * Pure evaluator — no external state, no eval(), no DB. We exercise the
 * grammar corners: precedence, literals, context lookups, the small set of
 * built-in helper functions (success/failure/always/contains/startsWith),
 * and the `${{ ... }}` wrapper strip.
 */

import { describe, it, expect } from "bun:test";
import { evaluateIf } from "../lib/workflow-conditionals";

describe("workflow-conditionals — evaluateIf", () => {
  it("undefined / null / empty expression evaluates to true", () => {
    expect(evaluateIf(undefined, {})).toEqual({ ok: true, value: true });
    expect(evaluateIf(null, {})).toEqual({ ok: true, value: true });
    expect(evaluateIf("", {})).toEqual({ ok: true, value: true });
    expect(evaluateIf("   ", {})).toEqual({ ok: true, value: true });
  });

  it("literal 'true' and 'false' evaluate correctly", () => {
    expect(evaluateIf("true", {})).toEqual({ ok: true, value: true });
    expect(evaluateIf("false", {})).toEqual({ ok: true, value: false });
  });

  it("context lookup with env.FOO == 'bar' returns true when matched", () => {
    const r = evaluateIf("env.FOO == 'bar'", { env: { FOO: "bar" } });
    expect(r).toEqual({ ok: true, value: true });
  });

  it("missing context key resolves to null and is falsy", () => {
    const r = evaluateIf("env.DOES_NOT_EXIST", { env: {} });
    expect(r).toEqual({ ok: true, value: false });
  });

  it("negation `!success()` is true when job status is 'failure'", () => {
    const r = evaluateIf("!success()", { job: { status: "failure" } });
    expect(r).toEqual({ ok: true, value: true });
  });

  it("&& binds tighter than ||  (precedence check)", () => {
    // true && false || true  -> (true && false) || true -> true
    const r1 = evaluateIf("true && false || true", {});
    expect(r1).toEqual({ ok: true, value: true });
    // false || true && false -> false || (true && false) -> false
    const r2 = evaluateIf("false || true && false", {});
    expect(r2).toEqual({ ok: true, value: false });
    // Mixed with equality: env.a == 'x' && env.b == 'y' || env.c == 'z'
    const r3 = evaluateIf(
      "env.a == 'x' && env.b == 'y' || env.c == 'z'",
      { env: { a: "x", b: "y", c: "no" } }
    );
    expect(r3).toEqual({ ok: true, value: true });
  });

  it("contains('abcdef', 'cd') returns true", () => {
    const r = evaluateIf("contains('abcdef', 'cd')", {});
    expect(r).toEqual({ ok: true, value: true });
    const miss = evaluateIf("contains('abcdef', 'zz')", {});
    expect(miss).toEqual({ ok: true, value: false });
  });

  it("startsWith('refs/heads/main', 'refs/heads/') returns true", () => {
    const r = evaluateIf("startsWith('refs/heads/main', 'refs/heads/')", {});
    expect(r).toEqual({ ok: true, value: true });
  });

  it("always() returns true even when job.status == 'failure'", () => {
    const r = evaluateIf("always()", { job: { status: "failure" } });
    expect(r).toEqual({ ok: true, value: true });
  });

  it("success() is true when job.status is unset (default running/ok)", () => {
    const r = evaluateIf("success()", {});
    expect(r).toEqual({ ok: true, value: true });
  });

  it("failure() is true only when job.status == 'failure'", () => {
    expect(evaluateIf("failure()", { job: { status: "failure" } })).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateIf("failure()", { job: { status: "success" } })).toEqual({
      ok: true,
      value: false,
    });
    expect(evaluateIf("failure()", {})).toEqual({ ok: true, value: false });
  });

  it("strips a surrounding ${{ ... }} wrapper before evaluating", () => {
    const r = evaluateIf("${{ env.FOO == 'bar' }}", { env: { FOO: "bar" } });
    expect(r).toEqual({ ok: true, value: true });
  });

  it("malformed expressions return {ok:false, error}", () => {
    const r = evaluateIf("== == ==", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
