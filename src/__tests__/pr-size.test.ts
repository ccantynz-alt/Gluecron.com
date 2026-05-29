/**
 * Tests for src/lib/pr-size.ts — computeSizeLabel and size constants.
 */

import { describe, test, expect } from "bun:test";
import { computeSizeLabel, type PrSizeLabel } from "../lib/pr-size";

describe("computeSizeLabel", () => {
  const cases: Array<[number, PrSizeLabel]> = [
    [0,   "XS"],
    [9,   "XS"],
    [10,  "S"],
    [49,  "S"],
    [50,  "M"],
    [199, "M"],
    [200, "L"],
    [499, "L"],
    [500, "XL"],
    [9999, "XL"],
  ];

  for (const [lines, expected] of cases) {
    test(`${lines} lines → ${expected}`, () => {
      expect(computeSizeLabel(lines)).toBe(expected);
    });
  }
});

describe("size label boundaries", () => {
  test("XS threshold is < 10", () => {
    expect(computeSizeLabel(9)).toBe("XS");
    expect(computeSizeLabel(10)).toBe("S");
  });
  test("S threshold is < 50", () => {
    expect(computeSizeLabel(49)).toBe("S");
    expect(computeSizeLabel(50)).toBe("M");
  });
  test("M threshold is < 200", () => {
    expect(computeSizeLabel(199)).toBe("M");
    expect(computeSizeLabel(200)).toBe("L");
  });
  test("L threshold is < 500", () => {
    expect(computeSizeLabel(499)).toBe("L");
    expect(computeSizeLabel(500)).toBe("XL");
  });
});
