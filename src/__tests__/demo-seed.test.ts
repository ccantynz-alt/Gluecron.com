/**
 * Pure-helper tests for src/lib/demo-seed.ts. We never touch the DB here —
 * the content builders and DEMO_USERNAME constant are fully deterministic
 * and are the only bits exercised.
 */

import { describe, it, expect } from "bun:test";
import {
  DEMO_USERNAME,
  buildHelloPythonFiles,
  buildTodoApiFiles,
  buildDesignDocsFiles,
  __test,
} from "../lib/demo-seed";

describe("DEMO_USERNAME", () => {
  it('equals "demo"', () => {
    expect(DEMO_USERNAME).toBe("demo");
  });
});

describe("buildHelloPythonFiles", () => {
  const files = buildHelloPythonFiles();

  it("returns a non-empty record with the expected filenames", () => {
    const keys = Object.keys(files);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain("README.md");
    expect(keys).toContain("main.py");
    expect(keys).toContain("requirements.txt");
  });

  it("README.md mentions the repo name", () => {
    expect(files["README.md"]).toContain("hello-python");
  });

  it("main.py is non-empty", () => {
    expect(files["main.py"].length).toBeGreaterThan(0);
    expect(files["main.py"]).toContain("def ");
  });
});

describe("buildTodoApiFiles", () => {
  const files = buildTodoApiFiles();

  it("returns a non-empty record with the expected filenames", () => {
    const keys = Object.keys(files);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain("README.md");
    expect(keys).toContain("package.json");
    expect(keys).toContain("src/index.ts");
  });

  it("README.md mentions the repo name", () => {
    expect(files["README.md"]).toContain("todo-api");
  });

  it("package.json is valid JSON", () => {
    expect(() => JSON.parse(files["package.json"])).not.toThrow();
    const parsed = JSON.parse(files["package.json"]);
    expect(parsed.name).toBe("todo-api");
  });
});

describe("buildDesignDocsFiles", () => {
  const files = buildDesignDocsFiles();

  it("returns a non-empty record with the expected filenames", () => {
    const keys = Object.keys(files);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain("README.md");
    expect(keys).toContain("docs/architecture.md");
    expect(keys).toContain("docs/adr-001.md");
  });

  it("README.md mentions the repo name", () => {
    expect(files["README.md"]).toContain("design-docs");
  });
});

describe("__test bundle", () => {
  it("re-exports the three content builders", () => {
    expect(typeof __test.buildHelloPythonFiles).toBe("function");
    expect(typeof __test.buildTodoApiFiles).toBe("function");
    expect(typeof __test.buildDesignDocsFiles).toBe("function");
  });
});
