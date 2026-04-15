/**
 * Block J21 — CODEOWNERS validator. Pure lexer + validator + route smokes.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  lexCodeowners,
  classifyOwnerToken,
  isPlausiblePattern,
  validateCodeowners,
  __internal,
  type OwnerResolver,
} from "../lib/codeowners-lint";

const allKnownResolver: OwnerResolver = {
  isUser: () => true,
  isTeam: () => true,
};

const noneKnownResolver: OwnerResolver = {
  isUser: () => false,
  isTeam: () => false,
};

function resolver(known: {
  users?: string[];
  teams?: string[];
}): OwnerResolver {
  const u = new Set((known.users || []).map((s) => s.toLowerCase()));
  const t = new Set((known.teams || []).map((s) => s.toLowerCase()));
  return {
    isUser: (x) => u.has(x.toLowerCase()),
    isTeam: (o, team) => t.has(`${o}/${team}`.toLowerCase()),
  };
}

describe("codeowners-lint — lexCodeowners", () => {
  it("ignores blank + comment lines", () => {
    const { rules, totalLines } = lexCodeowners(
      "# comment\n\n# another\n* @alice\n"
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].line).toBe(4);
    expect(rules[0].pattern).toBe("*");
    expect(rules[0].owners).toEqual(["alice"]);
    expect(totalLines).toBeGreaterThan(0);
  });

  it("strips the leading @ from owner tokens", () => {
    const { rules } = lexCodeowners("* @alice @bob\n");
    expect(rules[0].owners).toEqual(["alice", "bob"]);
  });

  it("detects malformed lines with no owners", () => {
    const { malformedLines } = lexCodeowners("*\nfoo/*\n");
    expect(malformedLines.map((m) => m.line)).toEqual([1, 2]);
  });

  it("preserves line numbers with CRLF", () => {
    const { rules } = lexCodeowners("# comment\r\n\r\n* @a\r\n");
    expect(rules[0].line).toBe(3);
  });

  it("drops inline trailing comments", () => {
    const { rules } = lexCodeowners("src/api/** @bob # backend lead");
    expect(rules[0].owners).toEqual(["bob"]);
  });

  it("accepts team-style owner tokens", () => {
    const { rules } = lexCodeowners("docs/ @acme/docs-team");
    expect(rules[0].owners).toEqual(["acme/docs-team"]);
  });
});

describe("codeowners-lint — classifyOwnerToken", () => {
  it("classifies @user tokens as user", () => {
    expect(classifyOwnerToken("alice", true)).toBe("user");
    expect(classifyOwnerToken("a", true)).toBe("user");
    expect(classifyOwnerToken("alice-bob", true)).toBe("user");
  });

  it("classifies @org/team tokens as team", () => {
    expect(classifyOwnerToken("acme/backend", true)).toBe("team");
    expect(classifyOwnerToken("acme/docs-team_2", true)).toBe("team");
  });

  it("classifies plain emails as email", () => {
    expect(classifyOwnerToken("a@b.com", false)).toBe("email");
    expect(classifyOwnerToken("a.b+c@mail.example.io", false)).toBe("email");
  });

  it("rejects bogus tokens", () => {
    expect(classifyOwnerToken("", true)).toBe("invalid");
    expect(classifyOwnerToken("-alice", true)).toBe("invalid"); // leading dash
    expect(classifyOwnerToken("alice/bob/carol", true)).toBe("invalid"); // two slashes
    expect(classifyOwnerToken("alice!", true)).toBe("invalid");
    expect(classifyOwnerToken("plain", false)).toBe("invalid"); // missing @
  });
});

describe("codeowners-lint — isPlausiblePattern", () => {
  it("accepts normal glob patterns", () => {
    expect(isPlausiblePattern("*")).toBe(true);
    expect(isPlausiblePattern("/docs/**")).toBe(true);
    expect(isPlausiblePattern("src/**/*.ts")).toBe(true);
    expect(isPlausiblePattern("[abc].md")).toBe(true);
  });

  it("rejects empty, whitespace, unbalanced brackets", () => {
    expect(isPlausiblePattern("")).toBe(false);
    expect(isPlausiblePattern("foo bar")).toBe(false);
    expect(isPlausiblePattern("[abc")).toBe(false);
    expect(isPlausiblePattern("abc]")).toBe(false);
  });
});

describe("codeowners-lint — validateCodeowners", () => {
  it("flags empty files as a warning", async () => {
    const r = await validateCodeowners("", allKnownResolver);
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].code).toBe("empty_file");
  });

  it("returns ok + a single info for a valid-but-missing-catchall file", async () => {
    const r = await validateCodeowners(
      "/docs/ @alice\n",
      resolver({ users: ["alice"] })
    );
    expect(r.errors).toHaveLength(0);
    expect(r.infos.some((f) => f.code === "missing_catchall")).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("clean file with catchall yields zero findings", async () => {
    const r = await validateCodeowners(
      "* @alice\n",
      resolver({ users: ["alice"] })
    );
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("catches pattern-with-no-owners", async () => {
    const r = await validateCodeowners(
      "* @alice\n/docs/\n",
      resolver({ users: ["alice"] })
    );
    const noOwners = r.findings.find((f) => f.code === "no_owners");
    expect(noOwners).toBeTruthy();
    expect(noOwners!.line).toBe(2);
    expect(r.ok).toBe(false);
  });

  it("reports unknown users", async () => {
    const r = await validateCodeowners(
      "* @ghost\n",
      noneKnownResolver
    );
    const unknown = r.findings.find((f) => f.code === "unknown_user");
    expect(unknown).toBeTruthy();
    expect(unknown!.token).toBe("ghost");
    expect(r.ok).toBe(false);
  });

  it("reports unknown teams", async () => {
    const r = await validateCodeowners(
      "* @acme/missing\n",
      resolver({})
    );
    const unknown = r.findings.find((f) => f.code === "unknown_team");
    expect(unknown).toBeTruthy();
    expect(unknown!.token).toBe("acme/missing");
  });

  it("accepts plain email owners without DB lookup", async () => {
    const r = await validateCodeowners(
      "* ops@example.com\n",
      noneKnownResolver
    );
    const errors = r.errors.filter(
      (f) =>
        f.code === "unknown_user" ||
        f.code === "unknown_team" ||
        f.code === "bad_owner_format"
    );
    expect(errors).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it("flags bad owner formats", async () => {
    const r = await validateCodeowners(
      "* @-bad-user\n",
      allKnownResolver
    );
    const bad = r.findings.find((f) => f.code === "bad_owner_format");
    expect(bad).toBeTruthy();
  });

  it("flags duplicate patterns as warnings", async () => {
    const r = await validateCodeowners(
      "* @alice\n* @bob\n",
      resolver({ users: ["alice", "bob"] })
    );
    const dup = r.findings.find((f) => f.code === "duplicate_pattern");
    expect(dup).toBeTruthy();
    expect(dup!.severity).toBe("warning");
  });

  it("flags duplicate owners on the same rule as warnings", async () => {
    const r = await validateCodeowners(
      "* @alice @alice\n",
      resolver({ users: ["alice"] })
    );
    const dup = r.findings.find((f) => f.code === "duplicate_owner");
    expect(dup).toBeTruthy();
    expect(dup!.severity).toBe("warning");
  });

  it("orders findings by line number", async () => {
    const r = await validateCodeowners(
      "* @alice @alice\n/bad\n/docs/ @ghost\n",
      resolver({ users: ["alice"] })
    );
    const lines = r.findings.map((f) => f.line);
    const sorted = [...lines].sort((a, b) => a - b);
    expect(lines).toEqual(sorted);
  });

  it("returns ok=false when any error is present", async () => {
    const r = await validateCodeowners("/docs/\n", resolver({}));
    expect(r.ok).toBe(false);
  });

  it("returns ok=true when only warnings/infos exist", async () => {
    const r = await validateCodeowners(
      "/docs/ @alice\n",
      resolver({ users: ["alice"] })
    );
    expect(r.warnings.length + r.infos.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });

  it("flags bad pattern syntax with unbalanced brackets", async () => {
    const r = await validateCodeowners(
      "[abc @alice\n",
      resolver({ users: ["alice"] })
    );
    const bad = r.findings.find((f) => f.code === "bad_pattern_syntax");
    expect(bad).toBeTruthy();
  });
});

describe("codeowners-lint — __internal parity", () => {
  it("re-exports the helpers", () => {
    expect(__internal.lexCodeowners).toBe(lexCodeowners);
    expect(__internal.classifyOwnerToken).toBe(classifyOwnerToken);
    expect(__internal.isPlausiblePattern).toBe(isPlausiblePattern);
    expect(__internal.validateCodeowners).toBe(validateCodeowners);
  });
});

describe("codeowners-lint — routes", () => {
  it("GET /:o/:r/codeowners returns 404 for unknown repos", async () => {
    const res = await app.request("/alice/nope/codeowners");
    expect(res.status).toBe(404);
  });
});
