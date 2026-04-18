/**
 * Block J7 — Closing-keyword parser tests. Pure function so the whole spec
 * lives here.
 */

import { describe, it, expect } from "bun:test";
import {
  extractClosingRefs,
  extractClosingRefsMulti,
} from "../lib/close-keywords";

describe("close-keywords — extractClosingRefs", () => {
  it("returns [] for null / empty / undefined", () => {
    expect(extractClosingRefs(null)).toEqual([]);
    expect(extractClosingRefs(undefined)).toEqual([]);
    expect(extractClosingRefs("")).toEqual([]);
  });

  it("matches all close/fix/resolve forms", () => {
    expect(extractClosingRefs("closes #1")).toEqual([1]);
    expect(extractClosingRefs("Close #2")).toEqual([2]);
    expect(extractClosingRefs("closed #3")).toEqual([3]);
    expect(extractClosingRefs("fix #4")).toEqual([4]);
    expect(extractClosingRefs("Fixes #5")).toEqual([5]);
    expect(extractClosingRefs("fixed #6")).toEqual([6]);
    expect(extractClosingRefs("resolve #7")).toEqual([7]);
    expect(extractClosingRefs("Resolves #8")).toEqual([8]);
    expect(extractClosingRefs("resolved #9")).toEqual([9]);
  });

  it("handles colon / hyphen / punctuation between verb and ref", () => {
    expect(extractClosingRefs("Fixes: #12")).toEqual([12]);
    expect(extractClosingRefs("Closes:#13")).toEqual([13]);
    expect(extractClosingRefs("Fixes - #14")).toEqual([14]);
    expect(extractClosingRefs("Closes #15.")).toEqual([15]);
    expect(extractClosingRefs("Closes #16, thanks")).toEqual([16]);
  });

  it("de-dupes and sorts", () => {
    expect(extractClosingRefs("closes #2 fixes #1 resolves #2")).toEqual([1, 2]);
  });

  it("picks up multiple refs in a body", () => {
    const body =
      "This PR tidies up the UI.\n\nFixes #10\nCloses #11\nNot related: #99\nResolves #12";
    expect(extractClosingRefs(body)).toEqual([10, 11, 12]);
  });

  it("ignores bare #N without a closing verb", () => {
    expect(extractClosingRefs("See #5 for context")).toEqual([]);
    expect(extractClosingRefs("#123 is the root cause")).toEqual([]);
  });

  it("ignores cross-repo refs (owner/repo#N)", () => {
    expect(extractClosingRefs("Closes alice/widgets#42")).toEqual([]);
    expect(extractClosingRefs("Fixes foo/bar#99 and fixes #7")).toEqual([7]);
  });

  it("does not match verbs embedded in larger words", () => {
    expect(extractClosingRefs("disclose #1")).toEqual([]);
    expect(extractClosingRefs("prefix #2")).toEqual([]);
    expect(extractClosingRefs("unresolved #3")).toEqual([]);
  });

  it("does not match when # is spaced away from the number", () => {
    expect(extractClosingRefs("Closes # 1")).toEqual([]);
  });

  it("is case insensitive on the verb", () => {
    expect(extractClosingRefs("CLOSES #1 FIXES #2 Resolves #3")).toEqual([
      1, 2, 3,
    ]);
  });

  it("tolerates whitespace runs", () => {
    expect(extractClosingRefs("Closes    #1")).toEqual([1]);
    expect(extractClosingRefs("fixes\t#2")).toEqual([2]);
  });

  it("rejects non-positive numbers", () => {
    expect(extractClosingRefs("Closes #0")).toEqual([]);
    // "#-1" is not a valid match under the parser either.
    expect(extractClosingRefs("Closes #-1")).toEqual([]);
  });
});

describe("close-keywords — extractClosingRefsMulti", () => {
  it("merges + de-dupes across sources", () => {
    const body = "Fixes #1\nCloses #2";
    const title = "Resolves #2: cleanup";
    expect(extractClosingRefsMulti([title, body])).toEqual([1, 2]);
  });

  it("skips nullish sources gracefully", () => {
    expect(extractClosingRefsMulti([null, undefined, "Closes #7"])).toEqual([
      7,
    ]);
    expect(extractClosingRefsMulti([])).toEqual([]);
  });
});
