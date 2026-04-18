/**
 * Block J6 — Ruleset evaluator + route-auth tests.
 *
 * Evaluator is pure, so most of the coverage is in this file. DB-backed CRUD
 * relies on a live DB so it's covered in integration.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  RULE_TYPES,
  __internal,
  evaluatePush,
  globToRegex,
  parseParams,
} from "../lib/rulesets";

describe("rulesets — globToRegex", () => {
  it("handles literal paths", () => {
    expect(globToRegex("README.md").test("README.md")).toBe(true);
    expect(globToRegex("README.md").test("other.md")).toBe(false);
  });

  it("* matches one segment", () => {
    expect(globToRegex("src/*.ts").test("src/app.ts")).toBe(true);
    expect(globToRegex("src/*.ts").test("src/a/b.ts")).toBe(false);
  });

  it("** matches anything including slashes", () => {
    expect(globToRegex("docs/**").test("docs/a/b/c.md")).toBe(true);
    expect(globToRegex("**/secret.txt").test("a/b/secret.txt")).toBe(true);
  });

  it("escapes regex specials", () => {
    expect(globToRegex("a+b.txt").test("a+b.txt")).toBe(true);
    expect(globToRegex("a+b.txt").test("axb.txt")).toBe(false);
  });
});

describe("rulesets — parseParams", () => {
  it("round-trips JSON", () => {
    expect(parseParams('{"pattern":"^feat:"}')).toEqual({
      pattern: "^feat:",
    });
  });

  it("returns {} on garbage", () => {
    expect(parseParams("not json")).toEqual({});
    expect(parseParams("")).toEqual({});
  });
});

function rs(
  enforcement: "active" | "evaluate" | "disabled",
  rules: Array<{ ruleType: string; params: any }>
) {
  return {
    id: "rs-1",
    repositoryId: "r",
    name: "n",
    enforcement,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    rules: rules.map((r, i) => ({
      id: `rule-${i}`,
      rulesetId: "rs-1",
      ruleType: r.ruleType,
      params: JSON.stringify(r.params),
      createdAt: new Date(),
    })),
  } as any;
}

describe("rulesets — evaluatePush commit_message_pattern", () => {
  it("require=true blocks non-matching messages under active", () => {
    const result = evaluatePush(
      [
        rs("active", [
          {
            ruleType: "commit_message_pattern",
            params: { pattern: "^(feat|fix|chore):" },
          },
        ]),
      ],
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [{ sha: "abc123", message: "random junk" }],
      }
    );
    expect(result.allowed).toBe(false);
    expect(result.violations[0].ruleType).toBe("commit_message_pattern");
  });

  it("evaluate mode warns but allows", () => {
    const result = evaluatePush(
      [
        rs("evaluate", [
          {
            ruleType: "commit_message_pattern",
            params: { pattern: "^(feat|fix|chore):" },
          },
        ]),
      ],
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [{ sha: "abc123", message: "random" }],
      }
    );
    expect(result.allowed).toBe(true);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].enforcement).toBe("evaluate");
  });

  it("disabled mode produces zero violations", () => {
    const result = evaluatePush(
      [
        rs("disabled", [
          {
            ruleType: "commit_message_pattern",
            params: { pattern: "^feat:" },
          },
        ]),
      ],
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [{ sha: "abc", message: "anything" }],
      }
    );
    expect(result.allowed).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it("require=false blocks when pattern matches (forbidden)", () => {
    const result = evaluatePush(
      [
        rs("active", [
          {
            ruleType: "commit_message_pattern",
            params: { pattern: "wip", flags: "i", require: false },
          },
        ]),
      ],
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [{ sha: "abc", message: "WIP push" }],
      }
    );
    expect(result.allowed).toBe(false);
  });
});

describe("rulesets — evaluatePush branch / tag patterns", () => {
  it("branch must match required pattern", () => {
    const r = evaluatePush(
      [
        rs("active", [
          {
            ruleType: "branch_name_pattern",
            params: { pattern: "^release/" },
          },
        ]),
      ],
      {
        kind: "push",
        refType: "branch",
        refName: "feature/x",
        commits: [],
      }
    );
    expect(r.allowed).toBe(false);
  });

  it("branch rule is a no-op for tag pushes", () => {
    const r = evaluatePush(
      [
        rs("active", [
          {
            ruleType: "branch_name_pattern",
            params: { pattern: "^release/" },
          },
        ]),
      ],
      { kind: "push", refType: "tag", refName: "v1.0", commits: [] }
    );
    expect(r.allowed).toBe(true);
  });

  it("tag must match semver-ish", () => {
    const r = evaluatePush(
      [
        rs("active", [
          {
            ruleType: "tag_name_pattern",
            params: { pattern: "^v\\d+\\.\\d+\\.\\d+$" },
          },
        ]),
      ],
      { kind: "push", refType: "tag", refName: "v1.0", commits: [] }
    );
    expect(r.allowed).toBe(false);
  });
});

describe("rulesets — evaluatePush blocked_file_paths", () => {
  it("blocks changes to matching paths", () => {
    const r = evaluatePush(
      [
        rs("active", [
          {
            ruleType: "blocked_file_paths",
            params: { paths: ["secrets/**", "*.pem"] },
          },
        ]),
      ],
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [
          { sha: "a", message: "x", changedPaths: ["secrets/db.env"] },
        ],
      }
    );
    expect(r.allowed).toBe(false);
  });

  it("allows unrelated path changes", () => {
    const r = evaluatePush(
      [
        rs("active", [
          {
            ruleType: "blocked_file_paths",
            params: { paths: ["secrets/**"] },
          },
        ]),
      ],
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [{ sha: "a", message: "x", changedPaths: ["src/app.ts"] }],
      }
    );
    expect(r.allowed).toBe(true);
  });
});

describe("rulesets — evaluatePush max_file_size + force push", () => {
  it("blocks oversize blobs", () => {
    const r = evaluatePush(
      [
        rs("active", [
          {
            ruleType: "max_file_size",
            params: { bytes: 1024 },
          },
        ]),
      ],
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [{ sha: "a", message: "x", maxBlobSize: 2048 }],
      }
    );
    expect(r.allowed).toBe(false);
  });

  it("blocks force push when configured", () => {
    const r = evaluatePush(
      [rs("active", [{ ruleType: "forbid_force_push", params: {} }])],
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [],
        forcePush: true,
      }
    );
    expect(r.allowed).toBe(false);
  });
});

describe("rulesets — RULE_TYPES surface", () => {
  it("exports all rule types", () => {
    expect(RULE_TYPES).toContain("commit_message_pattern");
    expect(RULE_TYPES).toContain("branch_name_pattern");
    expect(RULE_TYPES).toContain("tag_name_pattern");
    expect(RULE_TYPES).toContain("blocked_file_paths");
    expect(RULE_TYPES).toContain("max_file_size");
    expect(RULE_TYPES).toContain("forbid_force_push");
    expect(RULE_TYPES.length).toBe(6);
  });
});

describe("rulesets — __internal evalRule edge cases", () => {
  it("empty pattern is a no-op", () => {
    const msgs = __internal.evalRule(
      {
        id: "r1",
        rulesetId: "s",
        ruleType: "commit_message_pattern",
        params: JSON.stringify({ pattern: "" }),
        createdAt: new Date(),
      } as any,
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [{ sha: "a", message: "nothing" }],
      }
    );
    expect(msgs.length).toBe(0);
  });

  it("invalid regex is a no-op", () => {
    const msgs = __internal.evalRule(
      {
        id: "r1",
        rulesetId: "s",
        ruleType: "commit_message_pattern",
        params: JSON.stringify({ pattern: "(" }),
        createdAt: new Date(),
      } as any,
      {
        kind: "push",
        refType: "branch",
        refName: "main",
        commits: [{ sha: "a", message: "x" }],
      }
    );
    expect(msgs.length).toBe(0);
  });
});

describe("rulesets — route auth", () => {
  it("GET /:o/:r/settings/rulesets without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/rulesets");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST create without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/rulesets", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST delete without auth → 302 /login", async () => {
    const res = await app.request(
      "/alice/repo/settings/rulesets/00000000-0000-0000-0000-000000000000/delete",
      { method: "POST" }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});
