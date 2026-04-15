/**
 * Block J12 — Community health scorecard tests.
 *
 * Pure helpers + route smoke.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  CHECKLIST,
  buildReport,
  checklistFromInputs,
  isCodeOfConduct,
  isContributing,
  isLicense,
  isPrTemplate,
  isReadme,
} from "../lib/community";

describe("community — name matchers", () => {
  it("isReadme matches all common spellings", () => {
    expect(isReadme("README")).toBe(true);
    expect(isReadme("readme.md")).toBe(true);
    expect(isReadme("Readme.MD")).toBe(true);
    expect(isReadme("README.txt")).toBe(true);
    expect(isReadme("README.rst")).toBe(true);
    expect(isReadme("readme.markdown")).toBe(true);
  });

  it("isReadme rejects look-alikes", () => {
    expect(isReadme("readme.html")).toBe(false);
    expect(isReadme("not-readme.md")).toBe(false);
    expect(isReadme("READMEFIRST.md")).toBe(false);
  });

  it("isLicense matches LICENSE / LICENCE / COPYING variants", () => {
    expect(isLicense("LICENSE")).toBe(true);
    expect(isLicense("License.md")).toBe(true);
    expect(isLicense("LICENCE.txt")).toBe(true);
    expect(isLicense("COPYING")).toBe(true);
  });

  it("isLicense rejects unrelated files", () => {
    expect(isLicense("licensing.md")).toBe(false);
    expect(isLicense("license-check.md")).toBe(false);
  });

  it("isCodeOfConduct matches common separators", () => {
    expect(isCodeOfConduct("CODE_OF_CONDUCT.md")).toBe(true);
    expect(isCodeOfConduct("code-of-conduct.md")).toBe(true);
    expect(isCodeOfConduct("CodeOfConduct")).toBe(true);
  });

  it("isContributing matches case-insensitively", () => {
    expect(isContributing("CONTRIBUTING.md")).toBe(true);
    expect(isContributing("contributing")).toBe(true);
    expect(isContributing("contributing.txt")).toBe(true);
    expect(isContributing("contributors.md")).toBe(false);
  });

  it("isPrTemplate matches expected spellings", () => {
    expect(isPrTemplate("pull_request_template.md")).toBe(true);
    expect(isPrTemplate("PULL_REQUEST_TEMPLATE")).toBe(true);
    expect(isPrTemplate("pull-request-template.md")).toBe(true);
    expect(isPrTemplate("PR_TEMPLATE.md")).toBe(false);
  });
});

describe("community — CHECKLIST table", () => {
  it("exposes eight items with unique keys", () => {
    expect(CHECKLIST.length).toBe(8);
    const keys = new Set(CHECKLIST.map((c) => c.key));
    expect(keys.size).toBe(8);
  });

  it("marks description/readme/license required; others recommended", () => {
    const required = new Set(
      CHECKLIST.filter((i) => i.required).map((i) => i.key)
    );
    expect(required.has("description")).toBe(true);
    expect(required.has("readme")).toBe(true);
    expect(required.has("license")).toBe(true);
    expect(required.has("code_of_conduct")).toBe(false);
    expect(required.has("pr_template")).toBe(false);
  });
});

describe("community — checklistFromInputs", () => {
  const empty = {
    rootEntries: [],
    githubEntries: [],
    issueTemplateDirExists: false,
    description: null,
    topics: [],
  };

  it("all-zero input → all checks false", () => {
    const r = checklistFromInputs(empty);
    for (const key of Object.keys(r) as Array<keyof typeof r>) {
      expect(r[key]).toBe(false);
    }
  });

  it("detects README at root + README in .github", () => {
    expect(
      checklistFromInputs({ ...empty, rootEntries: ["README.md"] }).readme
    ).toBe(true);
    expect(
      checklistFromInputs({ ...empty, githubEntries: ["README.md"] }).readme
    ).toBe(true);
  });

  it("LICENSE variants all count", () => {
    for (const n of ["LICENSE", "License.md", "LICENCE.txt", "COPYING"]) {
      expect(
        checklistFromInputs({ ...empty, rootEntries: [n] }).license
      ).toBe(true);
    }
  });

  it("description requires non-empty trimmed text", () => {
    expect(checklistFromInputs({ ...empty, description: "" }).description).toBe(false);
    expect(
      checklistFromInputs({ ...empty, description: "   " }).description
    ).toBe(false);
    expect(checklistFromInputs({ ...empty, description: "x" }).description).toBe(true);
  });

  it("topics requires at least one", () => {
    expect(checklistFromInputs({ ...empty, topics: [] }).topics).toBe(false);
    expect(checklistFromInputs({ ...empty, topics: ["ai"] }).topics).toBe(true);
  });

  it("issue_template is present if dir exists OR a single file", () => {
    expect(
      checklistFromInputs({ ...empty, issueTemplateDirExists: true })
        .issue_template
    ).toBe(true);
    expect(
      checklistFromInputs({
        ...empty,
        rootEntries: ["ISSUE_TEMPLATE.md"],
      }).issue_template
    ).toBe(true);
    expect(
      checklistFromInputs({
        ...empty,
        githubEntries: ["ISSUE_TEMPLATE.md"],
      }).issue_template
    ).toBe(true);
  });

  it("pr_template — accepts .github/ and root spellings", () => {
    expect(
      checklistFromInputs({
        ...empty,
        githubEntries: ["pull_request_template.md"],
      }).pr_template
    ).toBe(true);
    expect(
      checklistFromInputs({
        ...empty,
        rootEntries: ["PULL_REQUEST_TEMPLATE.md"],
      }).pr_template
    ).toBe(true);
  });
});

describe("community — buildReport", () => {
  it("all-false → 0% / meetsRequired false", () => {
    const r = buildReport({
      description: false,
      readme: false,
      license: false,
      code_of_conduct: false,
      contributing: false,
      issue_template: false,
      pr_template: false,
      topics: false,
    });
    expect(r.score).toBe(0);
    expect(r.passed).toBe(0);
    expect(r.total).toBe(8);
    expect(r.requiredPassed).toBe(0);
    expect(r.requiredTotal).toBe(3);
    expect(r.meetsRequired).toBe(false);
  });

  it("all-true → 100% / meetsRequired true", () => {
    const r = buildReport({
      description: true,
      readme: true,
      license: true,
      code_of_conduct: true,
      contributing: true,
      issue_template: true,
      pr_template: true,
      topics: true,
    });
    expect(r.score).toBe(100);
    expect(r.meetsRequired).toBe(true);
  });

  it("required-only → meetsRequired true, score partial", () => {
    const r = buildReport({
      description: true,
      readme: true,
      license: true,
      code_of_conduct: false,
      contributing: false,
      issue_template: false,
      pr_template: false,
      topics: false,
    });
    expect(r.meetsRequired).toBe(true);
    expect(r.score).toBe(Math.round((3 / 8) * 100));
  });

  it("preserves CHECKLIST ordering + annotates `present`", () => {
    const r = buildReport({
      description: true,
      readme: false,
      license: false,
      code_of_conduct: false,
      contributing: false,
      issue_template: false,
      pr_template: false,
      topics: false,
    });
    expect(r.items[0].key).toBe("description");
    expect(r.items[0].present).toBe(true);
    expect(r.items[1].key).toBe("readme");
    expect(r.items[1].present).toBe(false);
  });
});

describe("community — route", () => {
  it("GET /:o/:r/community on missing repo returns 404", async () => {
    const res = await app.request("/alice/nope/community");
    expect(res.status).toBe(404);
  });
});
