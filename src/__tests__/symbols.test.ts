/**
 * Block I8 — Symbol / xref navigation tests.
 *
 * Pure tests for the regex-based extractor per language + auth smoke on
 * the reindex endpoint.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { detectLanguage, extractSymbols } from "../lib/symbols";

describe("symbols — detectLanguage", () => {
  it("maps common extensions", () => {
    expect(detectLanguage("src/foo.ts")).toBe("ts");
    expect(detectLanguage("src/Foo.tsx")).toBe("ts");
    expect(detectLanguage("script.js")).toBe("ts");
    expect(detectLanguage("app.py")).toBe("py");
    expect(detectLanguage("main.rs")).toBe("rs");
    expect(detectLanguage("main.go")).toBe("go");
    expect(detectLanguage("App.java")).toBe("java");
    expect(detectLanguage("Main.kt")).toBe("kt");
    expect(detectLanguage("App.swift")).toBe("swift");
    expect(detectLanguage("helper.rb")).toBe("rb");
  });

  it("returns null for unknown extensions", () => {
    expect(detectLanguage("README.md")).toBe(null);
    expect(detectLanguage("styles.css")).toBe(null);
    expect(detectLanguage("noext")).toBe(null);
  });
});

describe("symbols — extractSymbols (ts)", () => {
  it("finds exported functions", () => {
    const src = `export function foo() {}\nexport async function bar() {}`;
    const syms = extractSymbols(src, "ts");
    expect(syms.find((s) => s.name === "foo")?.kind).toBe("function");
    expect(syms.find((s) => s.name === "bar")?.kind).toBe("function");
  });

  it("finds classes + interfaces + types", () => {
    const src = [
      "export class Widget {}",
      "export interface Opts {}",
      "export type ID = string;",
    ].join("\n");
    const syms = extractSymbols(src, "ts");
    expect(syms.find((s) => s.name === "Widget")?.kind).toBe("class");
    expect(syms.find((s) => s.name === "Opts")?.kind).toBe("interface");
    expect(syms.find((s) => s.name === "ID")?.kind).toBe("type");
  });

  it("finds arrow-function consts as functions", () => {
    const src = `export const handler = async (req) => {};`;
    const syms = extractSymbols(src, "ts");
    expect(syms.find((s) => s.name === "handler")?.kind).toBe("function");
  });

  it("records 1-based line numbers", () => {
    const src = `// comment\nexport function foo() {}`;
    const [sym] = extractSymbols(src, "ts");
    expect(sym.line).toBe(2);
  });

  it("skips minified / overly long lines", () => {
    const long = "x".repeat(600);
    const src = `${long}\nexport function real() {}`;
    const syms = extractSymbols(src, "ts");
    expect(syms.length).toBe(1);
    expect(syms[0].name).toBe("real");
  });

  it("truncates signature to 240 chars", () => {
    // keep the line under 500 chars (extractor skips minified lines)
    const src = `export function foo(${"x: string, ".repeat(30)}) {}`;
    const [sym] = extractSymbols(src, "ts");
    expect(sym.signature.length).toBeLessThanOrEqual(240);
  });
});

describe("symbols — extractSymbols (python)", () => {
  it("finds def and class", () => {
    const src = `def load():\n    pass\n\nclass Widget:\n    pass`;
    const syms = extractSymbols(src, "py");
    expect(syms.find((s) => s.name === "load")?.kind).toBe("function");
    expect(syms.find((s) => s.name === "Widget")?.kind).toBe("class");
  });

  it("finds SCREAMING_CASE constants", () => {
    const src = `MAX_ITEMS = 100\nfoo = 1`;
    const syms = extractSymbols(src, "py");
    expect(syms.find((s) => s.name === "MAX_ITEMS")?.kind).toBe("const");
    // lowercase should not match const rule
    expect(syms.find((s) => s.name === "foo")).toBeUndefined();
  });
});

describe("symbols — extractSymbols (rust + go)", () => {
  it("finds rust fn/struct/trait", () => {
    const src = [
      "pub fn run() {}",
      "pub struct Config {}",
      "pub trait Loader {}",
    ].join("\n");
    const syms = extractSymbols(src, "rs");
    expect(syms.find((s) => s.name === "run")?.kind).toBe("function");
    expect(syms.find((s) => s.name === "Config")?.kind).toBe("class");
    expect(syms.find((s) => s.name === "Loader")?.kind).toBe("interface");
  });

  it("finds go func + type struct + type interface", () => {
    const src = [
      "func Handle() {}",
      "type Config struct {",
      "type Loader interface {",
    ].join("\n");
    const syms = extractSymbols(src, "go");
    expect(syms.find((s) => s.name === "Handle")?.kind).toBe("function");
    expect(syms.find((s) => s.name === "Config")?.kind).toBe("class");
    expect(syms.find((s) => s.name === "Loader")?.kind).toBe("interface");
  });
});

describe("symbols — extractSymbols (unknown language)", () => {
  it("returns empty for unknown language", () => {
    expect(extractSymbols("blah", "unknown")).toEqual([]);
  });
});

describe("symbols — route auth", () => {
  it("POST /:owner/:repo/symbols/reindex without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/symbols/reindex", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});
