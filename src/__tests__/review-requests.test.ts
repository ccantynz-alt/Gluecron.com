/**
 * Block J11 — PR review requests. Pure helpers + route-auth smokes.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  REVIEW_SOURCES,
  REVIEW_STATES,
  isValidSource,
  isValidState,
  nextState,
  __internal,
} from "../lib/review-requests";

describe("review-requests — isValidSource", () => {
  it("accepts the three canonical sources", () => {
    for (const s of REVIEW_SOURCES) expect(isValidSource(s)).toBe(true);
  });

  it("rejects unknown sources", () => {
    expect(isValidSource("auto")).toBe(false);
    expect(isValidSource("")).toBe(false);
    expect(isValidSource("CODEOWNERS")).toBe(false); // case-sensitive
  });
});

describe("review-requests — isValidState", () => {
  it("accepts the four canonical states", () => {
    for (const s of REVIEW_STATES) expect(isValidState(s)).toBe(true);
  });

  it("rejects unknown states", () => {
    expect(isValidState("open")).toBe(false);
    expect(isValidState("approved!")).toBe(false);
    expect(isValidState("")).toBe(false);
  });
});

describe("review-requests — nextState", () => {
  it("dismissed is terminal — nothing moves it", () => {
    expect(nextState("dismissed", "approved")).toBe("dismissed");
    expect(nextState("dismissed", "changes_requested")).toBe("dismissed");
    expect(nextState("dismissed", "commented")).toBe("dismissed");
    expect(nextState("dismissed", "dismissed")).toBe("dismissed");
  });

  it("commented leaves state unchanged", () => {
    expect(nextState("pending", "commented")).toBe("pending");
    expect(nextState("approved", "commented")).toBe("approved");
    expect(nextState("changes_requested", "commented")).toBe("changes_requested");
  });

  it("approved / changes_requested overwrite pending + each other", () => {
    expect(nextState("pending", "approved")).toBe("approved");
    expect(nextState("pending", "changes_requested")).toBe("changes_requested");
    expect(nextState("approved", "changes_requested")).toBe("changes_requested");
    expect(nextState("changes_requested", "approved")).toBe("approved");
  });

  it("dismissed outcome transitions non-dismissed to dismissed", () => {
    expect(nextState("pending", "dismissed")).toBe("dismissed");
    expect(nextState("approved", "dismissed")).toBe("dismissed");
    expect(nextState("changes_requested", "dismissed")).toBe("dismissed");
  });
});

describe("review-requests — sanitiseCandidates", () => {
  const { sanitiseCandidates } = __internal;

  it("drops nulls, undefineds, and empty strings", () => {
    expect(sanitiseCandidates([null, undefined, "", "u1"], null)).toEqual([
      "u1",
    ]);
  });

  it("de-dupes preserving first-seen order", () => {
    expect(sanitiseCandidates(["u1", "u2", "u1", "u3", "u2"], null)).toEqual([
      "u1",
      "u2",
      "u3",
    ]);
  });

  it("excludes the PR author from the result", () => {
    expect(
      sanitiseCandidates(["author", "u1", "author", "u2"], "author")
    ).toEqual(["u1", "u2"]);
  });

  it("handles no-author case", () => {
    expect(sanitiseCandidates(["u1"], null)).toEqual(["u1"]);
    expect(sanitiseCandidates(["u1"], undefined)).toEqual(["u1"]);
  });

  it("returns [] for all-invalid input", () => {
    expect(sanitiseCandidates([null, undefined, ""], null)).toEqual([]);
  });

  it("preserves the author if explicitly included with a different-string ID", () => {
    // sanitiseCandidates only filters by exact ID equality
    expect(sanitiseCandidates(["author-x"], "author")).toEqual(["author-x"]);
  });
});

describe("review-requests — routes", () => {
  it("POST /:o/:r/pulls/:n/reviewers requires auth (redirects unauthed)", async () => {
    const res = await app.request(
      "/alice/nope/pulls/1/reviewers",
      { method: "POST", body: "username=bob" }
    );
    // requireAuth middleware redirects browsers to /login
    expect([302, 401].includes(res.status)).toBe(true);
  });

  it("POST dismiss route requires auth", async () => {
    const res = await app.request(
      "/alice/nope/pulls/1/reviewers/x/dismiss",
      { method: "POST" }
    );
    expect([302, 401].includes(res.status)).toBe(true);
  });

  it("POST with invalid bearer token → 401 JSON", async () => {
    const res = await app.request(
      "/alice/nope/pulls/1/reviewers",
      {
        method: "POST",
        headers: { authorization: "Bearer glc_garbage" },
        body: "username=bob",
      }
    );
    expect(res.status).toBe(401);
  });
});
