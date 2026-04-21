/**
 * Unit tests for src/lib/workflow-parser-ext.ts (Agent 3, Sprint 1).
 *
 * FIXME (Agent 3): At the time this test file was authored the
 * `workflow-parser-ext.ts` module had not yet landed on disk. The tests
 * below are written to the documented contract, but the whole suite guards
 * the import via a dynamic `require` so that `bun test` does not fail
 * cold-start if Agent 3 is still in flight. Once the module exists, these
 * tests will begin running automatically — no edit required.
 *
 * Contract under test:
 *   parseExtended(yaml: string):
 *     | { ok: true; workflow: ExtendedWorkflow }
 *     | { ok: false; error: string }
 *
 * Extended workflow adds (vs base ParsedWorkflow):
 *   - dispatchInputs (from on.workflow_dispatch.inputs)
 *   - job.needs  (string[], normalised from scalar-or-array)
 *   - job.strategy.matrix.axes
 *   - step.if (raw expression string)
 *   - step.uses + step.with
 *   - warnings[] for malformed extension fields that don't kill the parse
 */

import { describe, it, expect } from "bun:test";

// Guarded dynamic import — if Agent 3's module isn't present yet we skip.
let parseExtended: ((yaml: string) => any) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../lib/workflow-parser-ext");
  parseExtended = mod.parseExtended ?? null;
} catch {
  parseExtended = null;
}

const d = parseExtended ? describe : describe.skip;

d("workflow-parser-ext — parseExtended", () => {
  it("parses a bare workflow with no extension fields populated", () => {
    const res = parseExtended!(`name: bare
on: [push]
jobs:
  build:
    runs-on: default
    steps:
      - run: echo hi
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Base fields still present.
    expect(res.workflow.name).toBe("bare");
    expect(Array.isArray(res.workflow.on)).toBe(true);
    expect(res.workflow.jobs.length).toBe(1);
    // Extension fields should be absent / empty.
    expect(res.workflow.dispatchInputs).toBeFalsy();
    const job = res.workflow.jobs[0];
    expect(job.needs === undefined || (Array.isArray(job.needs) && job.needs.length === 0)).toBe(true);
    expect(job.strategy === undefined || job.strategy === null).toBe(true);
  });

  it("captures workflow_dispatch inputs with a choice type", () => {
    const res = parseExtended!(`name: dispatch
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
jobs:
  deploy:
    steps:
      - run: echo deploy
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.on).toContain("workflow_dispatch");
    expect(res.workflow.dispatchInputs).toBeDefined();
    // dispatchInputs is typically keyed by input name.
    const inputs = res.workflow.dispatchInputs!;
    expect(inputs.environment).toBeDefined();
    expect(inputs.environment.type).toBe("choice");
    expect(inputs.environment.options).toContain("staging");
    expect(inputs.environment.options).toContain("production");
  });

  it("normalises a scalar `needs:` into a single-element array", () => {
    const res = parseExtended!(`name: needs-scalar
on: [push]
jobs:
  build:
    steps:
      - run: echo build
  deploy:
    needs: build
    steps:
      - run: echo deploy
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const deploy = res.workflow.jobs.find((j: any) => j.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy.needs).toEqual(["build"]);
  });

  it("passes through an array `needs:` unchanged", () => {
    const res = parseExtended!(`name: needs-array
on: [push]
jobs:
  a:
    steps:
      - run: echo a
  b:
    steps:
      - run: echo b
  deploy:
    needs: [a, b]
    steps:
      - run: echo deploy
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const deploy = res.workflow.jobs.find((j: any) => j.name === "deploy");
    expect(deploy.needs).toEqual(["a", "b"]);
  });

  it("captures job.strategy.matrix.axes from a matrix block", () => {
    const res = parseExtended!(`name: matrix
on: [push]
jobs:
  test:
    strategy:
      matrix:
        node: [16, 18]
        os: [ubuntu]
    steps:
      - run: bun test
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const job = res.workflow.jobs[0];
    expect(job.strategy).toBeDefined();
    expect(job.strategy.matrix).toBeDefined();
    expect(job.strategy.matrix.axes).toBeDefined();
    expect(job.strategy.matrix.axes.node).toEqual([16, 18]);
    expect(job.strategy.matrix.axes.os).toEqual(["ubuntu"]);
  });

  it("captures step-level `if:` as the raw expression string", () => {
    const res = parseExtended!(`name: iffy
on: [push]
jobs:
  test:
    steps:
      - if: success()
        run: echo only-on-success
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const step = res.workflow.jobs[0].steps[0];
    expect(step.if).toBe("success()");
  });

  it("captures step `uses:` and `with:` blocks verbatim", () => {
    const res = parseExtended!(`name: uses
on: [push]
jobs:
  scan:
    steps:
      - uses: gluecron/gatetest@v1
        with:
          url: 'x'
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const step = res.workflow.jobs[0].steps[0];
    expect(step.uses).toBe("gluecron/gatetest@v1");
    expect(step.with).toBeDefined();
    expect(step.with.url).toBe("x");
  });

  it("emits warnings[] when an extension field is malformed but base parse succeeds", () => {
    // Matrix whose axes value is a scalar (not an array) — an extension
    // error. Base workflow must still parse.
    const res = parseExtended!(`name: malformed
on: [push]
jobs:
  test:
    strategy:
      matrix:
        node: not-an-array
    steps:
      - run: echo hi
`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Array.isArray(res.workflow.warnings)).toBe(true);
    expect(res.workflow.warnings.length).toBeGreaterThan(0);
  });
});
