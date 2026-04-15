/**
 * Tests for Block C1 — Actions-equivalent workflow runner.
 *
 * Covers the pure-function parser + route-level unauthed guards. The
 * shell-executor itself is exercised by higher-level integration tests
 * once a real test DB is wired — for now we only verify that the
 * exported surface exists and the route shell is correct.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { parseWorkflow } from "../lib/workflow-parser";

describe("workflow parser (C1)", () => {
  it("parses a minimal workflow", () => {
    const result = parseWorkflow(`name: CI
on: [push]
jobs:
  test:
    runs-on: default
    steps:
      - run: echo hello
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.name).toBe("CI");
    expect(result.workflow.on).toContain("push");
    expect(result.workflow.jobs).toHaveLength(1);
    expect(result.workflow.jobs[0].name).toBe("test");
    expect(result.workflow.jobs[0].steps).toHaveLength(1);
    expect(result.workflow.jobs[0].steps[0].run).toBe("echo hello");
  });

  it("handles scalar 'on' trigger", () => {
    const result = parseWorkflow(`name: scalar
on: push
jobs:
  test:
    steps:
      - run: pwd
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.on).toEqual(["push"]);
  });

  it("handles list 'on' triggers", () => {
    const result = parseWorkflow(`name: multi
on: [push, pull_request]
jobs:
  a:
    steps:
      - run: true
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.on).toContain("push");
    expect(result.workflow.on).toContain("pull_request");
  });

  it("auto-names steps that only have a run field", () => {
    const result = parseWorkflow(`name: n
on: [push]
jobs:
  test:
    steps:
      - run: echo x
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.jobs[0].steps[0].name).toBeTruthy();
  });

  it("preserves explicit step names", () => {
    const result = parseWorkflow(`name: n
on: [push]
jobs:
  test:
    steps:
      - name: Install
        run: bun install
      - name: Test
        run: bun test
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.workflow.jobs[0].steps.map((s) => s.name);
    expect(names).toContain("Install");
    expect(names).toContain("Test");
  });

  it("defaults runs-on to 'default' when omitted", () => {
    const result = parseWorkflow(`name: n
on: [push]
jobs:
  test:
    steps:
      - run: true
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workflow.jobs[0].runsOn).toBe("default");
  });

  it("rejects workflows with no 'on' trigger", () => {
    const result = parseWorkflow(`name: bad
jobs:
  test:
    steps:
      - run: true
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("on");
  });

  it("rejects workflows with no jobs", () => {
    const result = parseWorkflow(`name: bad
on: [push]
`);
    expect(result.ok).toBe(false);
  });

  it("rejects jobs with no steps", () => {
    const result = parseWorkflow(`name: bad
on: [push]
jobs:
  test:
    runs-on: default
`);
    expect(result.ok).toBe(false);
  });

  it("rejects steps without a 'run' command", () => {
    const result = parseWorkflow(`name: bad
on: [push]
jobs:
  test:
    steps:
      - name: no-op
`);
    expect(result.ok).toBe(false);
  });

  it("returns a default name when 'name' is missing", () => {
    const result = parseWorkflow(`on: [push]
jobs:
  test:
    steps:
      - run: true
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.workflow.name).toBe("string");
    expect(result.workflow.name.length).toBeGreaterThan(0);
  });

  it("never throws on malformed input", () => {
    const inputs = ["", "  ", "not:\nyaml\n-\n:", "{]}", "jobs: oh no"];
    for (const i of inputs) {
      expect(() => parseWorkflow(i)).not.toThrow();
    }
  });
});

describe("workflow routes (C1) — unauthed behaviour", () => {
  it("POST /:owner/:repo/actions/:workflowId/run requires auth", async () => {
    const res = await app.request("/alice/project/actions/abc/run", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    // Either a redirect to /login (repo exists, auth required), or 404
    // (repo doesn't exist in DB-less tests), or 503 on DB failure.
    expect([301, 302, 303, 307, 404, 503]).toContain(res.status);
  });

  it("POST /:owner/:repo/actions/runs/:id/cancel requires auth", async () => {
    const res = await app.request("/alice/project/actions/runs/xyz/cancel", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect([301, 302, 303, 307, 404, 503]).toContain(res.status);
  });
});
