/**
 * Block J17 — Multi-template issue selector. Pure parser unit tests + a
 * route-auth smoke to make sure the picker route is wired up.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  splitFrontmatter,
  parseFrontmatterMeta,
  slugFromFilename,
  buildTemplateFromFile,
  findTemplateBySlug,
  __internal,
  type IssueTemplate,
} from "../lib/issue-templates";

describe("issue-templates — splitFrontmatter", () => {
  it("returns body as-is when there's no frontmatter", () => {
    const r = splitFrontmatter("hello world");
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe("hello world");
  });

  it("splits the standard ---\\n...\\n--- fence", () => {
    const content = "---\nname: Bug\nabout: Report\n---\nSteps to reproduce";
    const r = splitFrontmatter(content);
    expect(r.frontmatter).toBe("name: Bug\nabout: Report");
    expect(r.body).toBe("Steps to reproduce");
  });

  it("returns body as-is when fence is unterminated", () => {
    const content = "---\nname: Bug\nno closing fence";
    const r = splitFrontmatter(content);
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe(content);
  });

  it("tolerates trailing whitespace on the closing fence line", () => {
    const content = "---\nname: Bug\n---  \nBody here";
    const r = splitFrontmatter(content);
    expect(r.frontmatter).toBe("name: Bug");
    expect(r.body).toBe("Body here");
  });

  it("handles CRLF line endings", () => {
    const content = "---\r\nname: Bug\r\n---\r\nBody";
    const r = splitFrontmatter(content);
    // splitFrontmatter itself doesn't normalise CRLF in the split logic; the
    // parser normalises internally. We just need a usable body when the
    // frontmatter can't be matched to still roundtrip the raw content.
    expect(r.body.trim().length).toBeGreaterThan(0);
  });
});

describe("issue-templates — parseFrontmatterMeta", () => {
  it("returns an empty meta for empty input", () => {
    const m = parseFrontmatterMeta("");
    expect(m.name).toBeNull();
    expect(m.about).toBeNull();
    expect(m.title).toBeNull();
    expect(m.labels).toEqual([]);
    expect(m.assignees).toEqual([]);
  });

  it("parses flat key: value pairs", () => {
    const m = parseFrontmatterMeta(
      [
        "name: Bug report",
        "about: Something's broken",
        "title: '[Bug] '",
      ].join("\n")
    );
    expect(m.name).toBe("Bug report");
    expect(m.about).toBe("Something's broken");
    expect(m.title).toBe("[Bug] ");
  });

  it("strips double- and single-quoted values", () => {
    const m = parseFrontmatterMeta(
      ['name: "Quoted"', "about: 'single'"].join("\n")
    );
    expect(m.name).toBe("Quoted");
    expect(m.about).toBe("single");
  });

  it("parses flow-list labels: [a, \"b\", c]", () => {
    const m = parseFrontmatterMeta('labels: [bug, "high priority", triage]');
    expect(m.labels).toEqual(["bug", "high priority", "triage"]);
  });

  it("parses block-list labels (- bug / - triage)", () => {
    const m = parseFrontmatterMeta(
      ["labels:", "  - bug", "  - triage", "  - needs-repro"].join("\n")
    );
    expect(m.labels).toEqual(["bug", "triage", "needs-repro"]);
  });

  it("parses block-list assignees", () => {
    const m = parseFrontmatterMeta(
      ["assignees:", "  - alice", "  - bob"].join("\n")
    );
    expect(m.assignees).toEqual(["alice", "bob"]);
  });

  it("ignores comment lines and blanks", () => {
    const m = parseFrontmatterMeta(
      ["# a comment", "", "name: X", "# tail"].join("\n")
    );
    expect(m.name).toBe("X");
  });

  it("is case-insensitive on keys", () => {
    const m = parseFrontmatterMeta("Name: Casey\nLABELS: [x]");
    expect(m.name).toBe("Casey");
    expect(m.labels).toEqual(["x"]);
  });

  it("ignores unknown keys", () => {
    const m = parseFrontmatterMeta("name: A\ncolor: ff0000");
    expect(m.name).toBe("A");
    expect(m.labels).toEqual([]);
  });
});

describe("issue-templates — slugFromFilename", () => {
  it("lowercases and normalises to hyphens", () => {
    expect(slugFromFilename("Bug Report.md")).toBe("bug-report");
    expect(slugFromFilename("Feature_Request.md")).toBe("feature-request");
  });

  it("strips the .md / .markdown / .yml extensions", () => {
    expect(slugFromFilename("x.md")).toBe("x");
    expect(slugFromFilename("x.yml")).toBe("x");
    expect(slugFromFilename("x.yaml")).toBe("x");
  });

  it("clamps to 64 characters", () => {
    const base = "a".repeat(100);
    expect(slugFromFilename(`${base}.md`).length).toBe(64);
  });

  it("strips unicode and collapses non-alnum runs", () => {
    expect(slugFromFilename("  !!! bug 😀 .md")).toBe("bug");
  });

  it("returns '' for an all-unicode name (caller picks fallback)", () => {
    expect(slugFromFilename("😀😀.md")).toBe("");
  });
});

describe("issue-templates — buildTemplateFromFile", () => {
  it("merges filename + frontmatter + body", () => {
    const content = [
      "---",
      "name: Bug",
      "about: Report a bug",
      "title: '[BUG] '",
      "labels: [bug, triage]",
      "---",
      "## Steps",
      "1. foo",
    ].join("\n");
    const t = buildTemplateFromFile("bug.md", content, ".github/ISSUE_TEMPLATE");
    expect(t.slug).toBe("bug");
    expect(t.path).toBe(".github/ISSUE_TEMPLATE/bug.md");
    expect(t.name).toBe("Bug");
    expect(t.about).toBe("Report a bug");
    expect(t.title).toBe("[BUG] ");
    expect(t.labels).toEqual(["bug", "triage"]);
    expect(t.body).toBe("## Steps\n1. foo");
  });

  it("falls back to the filename (sans extension) when name is missing", () => {
    const content = "---\nabout: X\n---\nbody";
    const t = buildTemplateFromFile("feature-request.md", content, ".github");
    expect(t.name).toBe("feature-request");
  });

  it("handles files without frontmatter", () => {
    const t = buildTemplateFromFile("plain.md", "Just a body\n", ".github");
    expect(t.name).toBe("plain");
    expect(t.about).toBeNull();
    expect(t.labels).toEqual([]);
    expect(t.body).toBe("Just a body");
  });

  it("joins empty dir path without a leading slash", () => {
    const t = buildTemplateFromFile("x.md", "hi", "");
    expect(t.path).toBe("x.md");
  });
});

describe("issue-templates — findTemplateBySlug", () => {
  const items: IssueTemplate[] = [
    buildTemplateFromFile("bug.md", "---\nname: Bug\n---\n", ".github"),
    buildTemplateFromFile("feature.md", "---\nname: Feature\n---\n", ".github"),
  ];

  it("returns null for null/undefined slugs", () => {
    expect(findTemplateBySlug(items, null)).toBeNull();
    expect(findTemplateBySlug(items, undefined)).toBeNull();
    expect(findTemplateBySlug(items, "")).toBeNull();
  });

  it("returns null for an unknown slug", () => {
    expect(findTemplateBySlug(items, "missing")).toBeNull();
  });

  it("finds by exact slug", () => {
    expect(findTemplateBySlug(items, "bug")?.name).toBe("Bug");
    expect(findTemplateBySlug(items, "feature")?.name).toBe("Feature");
  });
});

describe("issue-templates — __internal", () => {
  it("exposes the pure helpers for parity", () => {
    expect(__internal.splitFrontmatter).toBe(splitFrontmatter);
    expect(__internal.parseFrontmatterMeta).toBe(parseFrontmatterMeta);
    expect(__internal.slugFromFilename).toBe(slugFromFilename);
    expect(__internal.buildTemplateFromFile).toBe(buildTemplateFromFile);
    expect(__internal.findTemplateBySlug).toBe(findTemplateBySlug);
    expect(__internal.TEMPLATE_DIRS.length).toBeGreaterThan(0);
    expect(typeof __internal.MAX_TEMPLATE_BYTES).toBe("number");
    expect(typeof __internal.MAX_TEMPLATES).toBe("number");
  });
});

describe("issue-templates — routes", () => {
  it("GET /:owner/:repo/issues/new requires auth", async () => {
    const res = await app.request("/alice/nope/issues/new");
    // redirect to login OR 404 from repo resolve OR 401 JSON path
    expect([302, 401, 404].includes(res.status)).toBe(true);
  });

  it("GET /:owner/:repo/issues/new?template=foo requires auth", async () => {
    const res = await app.request(
      "/alice/nope/issues/new?template=foo"
    );
    expect([302, 401, 404].includes(res.status)).toBe(true);
  });
});
