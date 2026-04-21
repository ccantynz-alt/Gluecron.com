/**
 * Unit tests for src/lib/workflow-matrix.ts (Agent 4, Sprint 1).
 *
 * Pure-function coverage: cartesian expansion, include/exclude semantics,
 * validator guardrails. No DB, no I/O — just data transformations.
 */

import { describe, it, expect } from "bun:test";
import { expandMatrix, validateMatrix } from "../lib/workflow-matrix";

describe("workflow-matrix — expandMatrix", () => {
  it("empty axes {} with no include returns []", () => {
    const combos = expandMatrix({ axes: {} });
    expect(combos).toEqual([]);
  });

  it("single axis expands to one combo per value in alpha-key order", () => {
    const combos = expandMatrix({ axes: { os: ["a", "b", "c"] } });
    expect(combos).toHaveLength(3);
    expect(combos[0]).toEqual({ os: "a" });
    expect(combos[1]).toEqual({ os: "b" });
    expect(combos[2]).toEqual({ os: "c" });
  });

  it("two axes produce the cartesian product with both keys", () => {
    const combos = expandMatrix({
      axes: { os: ["ubuntu", "mac"], node: [16, 18] },
    });
    expect(combos).toHaveLength(4);
    // Every combo must contain both keys.
    for (const c of combos) {
      expect(Object.keys(c).sort()).toEqual(["node", "os"]);
    }
    // Verify all four combinations are present.
    const serialized = combos.map((c) => JSON.stringify(c)).sort();
    expect(serialized).toEqual(
      [
        { node: 16, os: "ubuntu" },
        { node: 16, os: "mac" },
        { node: 18, os: "ubuntu" },
        { node: 18, os: "mac" },
      ]
        .map((c) => JSON.stringify(c))
        .sort()
    );
  });

  it("exclude removes matching combos", () => {
    const combos = expandMatrix({
      axes: { os: ["a", "b"], node: [16, 18] },
      exclude: [{ os: "a", node: 16 }],
    });
    expect(combos).toHaveLength(3);
    expect(combos.find((c) => c.os === "a" && c.node === 16)).toBeUndefined();
  });

  it("include adds a standalone combo when it does not match any cartesian entry", () => {
    const combos = expandMatrix({
      axes: { os: ["a"] },
      include: [{ os: "windows", extra: "bonus" }],
    });
    // One from the axes + one standalone include.
    expect(combos).toHaveLength(2);
    expect(combos.find((c) => c.os === "windows" && c.extra === "bonus")).toBeDefined();
  });

  it("include extends an existing combo with extra keys when axis keys match", () => {
    const combos = expandMatrix({
      axes: { os: ["a", "b"] },
      include: [{ os: "a", env: "prod" }],
    });
    expect(combos).toHaveLength(2);
    const aCombo = combos.find((c) => c.os === "a");
    const bCombo = combos.find((c) => c.os === "b");
    expect(aCombo).toEqual({ os: "a", env: "prod" });
    expect(bCombo).toEqual({ os: "b" });
  });

  it("empty axis value [] yields no combos", () => {
    const combos = expandMatrix({ axes: { os: [] } });
    expect(combos).toEqual([]);
  });

  it("validateMatrix rejects non-object input and non-array axis values", () => {
    expect(validateMatrix(null).ok).toBe(false);
    expect(validateMatrix(undefined).ok).toBe(false);
    expect(validateMatrix("not an object").ok).toBe(false);
    expect(validateMatrix([]).ok).toBe(false);
    const badAxis = validateMatrix({ axes: { os: "not-an-array" } });
    expect(badAxis.ok).toBe(false);
    if (!badAxis.ok) expect(badAxis.error).toMatch(/array/i);
  });

  it("validateMatrix accepts a well-formed spec", () => {
    const good = validateMatrix({
      axes: { os: ["a", "b"] },
      include: [{ os: "a", env: "x" }],
      exclude: [{ os: "b" }],
      failFast: true,
      maxParallel: 4,
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.spec.axes.os).toEqual(["a", "b"]);
      expect(good.spec.failFast).toBe(true);
      expect(good.spec.maxParallel).toBe(4);
    }
  });
});
