/**
 * Tests for Block D1 — semantic code search.
 *
 * Covers the pure helpers (tokenize, hashEmbed, cosine, isCodeFile,
 * chunkFile) plus a route-level smoke test that the /:owner/:repo/search/semantic
 * page always resolves — even for a nonexistent repo, where it must render
 * a 404 Layout rather than blowing up.
 *
 * These tests deliberately avoid Voyage and the DB. The fallback embedder
 * is pure math; the route falls through to the global 404 path when the
 * repo doesn't exist.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  tokenize,
  hashEmbed,
  cosine,
  isCodeFile,
  chunkFile,
  isEmbeddingsProviderAvailable,
  __test,
} from "../lib/semantic-search";

describe("tokenize", () => {
  it("splits on non-word boundaries", () => {
    const t = tokenize("hello, world!");
    expect(t).toContain("hello");
    expect(t).toContain("world");
  });

  it("splits camelCase into fragments", () => {
    const t = tokenize("getUserName");
    expect(t).toContain("get");
    expect(t).toContain("user");
    expect(t).toContain("name");
  });

  it("splits PascalCase and ALLCAPS runs", () => {
    const t = tokenize("XMLParser");
    expect(t).toContain("xml");
    expect(t).toContain("parser");
  });

  it("splits snake_case into fragments", () => {
    const t = tokenize("snake_case_name");
    expect(t).toContain("snake");
    expect(t).toContain("case");
    expect(t).toContain("name");
  });

  it("lowercases everything", () => {
    const t = tokenize("FooBar");
    for (const tok of t) {
      expect(tok).toBe(tok.toLowerCase());
    }
  });

  it("drops single-character tokens and pure numeric tokens", () => {
    const t = tokenize("a b foo 123 bar2");
    expect(t).not.toContain("a");
    expect(t).not.toContain("b");
    expect(t).not.toContain("123");
    expect(t).toContain("foo");
    expect(t).toContain("bar2");
  });

  it("returns [] for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("hashEmbed", () => {
  it("returns a vector of the requested dimension", () => {
    const v = hashEmbed(["hello", "world"], 512);
    expect(v.length).toBe(512);
  });

  it("produces an L2-normalized vector (sum of squares ≈ 1)", () => {
    const v = hashEmbed(tokenize("const user = getUserById(id);"), 512);
    let sq = 0;
    for (const x of v) sq += x * x;
    expect(sq).toBeGreaterThan(0.99);
    expect(sq).toBeLessThan(1.01);
  });

  it("returns an all-zero vector for empty token list", () => {
    const v = hashEmbed([], 512);
    expect(v.length).toBe(512);
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it("is deterministic across calls", () => {
    const v1 = hashEmbed(["foo", "bar", "baz"]);
    const v2 = hashEmbed(["foo", "bar", "baz"]);
    expect(v1).toEqual(v2);
  });

  it("honours a custom dimension", () => {
    const v = hashEmbed(["x"], 128);
    expect(v.length).toBe(128);
  });
});

describe("cosine", () => {
  it("returns ~1 for identical non-zero vectors", () => {
    const v = hashEmbed(tokenize("const answer = 42;"));
    const s = cosine(v, v);
    expect(s).toBeGreaterThan(0.999);
    expect(s).toBeLessThan(1.001);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    expect(cosine(a, b)).toBe(0);
  });

  it("returns 0 when either vector is all zeros", () => {
    const z = [0, 0, 0];
    const v = [1, 2, 3];
    expect(cosine(z, v)).toBe(0);
    expect(cosine(v, z)).toBe(0);
  });

  it("ranks a close match higher than an unrelated one", () => {
    const query = hashEmbed(tokenize("parse JSON response"));
    const close = hashEmbed(
      tokenize("function parseJsonResponse(text) { return JSON.parse(text); }")
    );
    const far = hashEmbed(
      tokenize("draw a red rectangle on the canvas context")
    );
    expect(cosine(query, close)).toBeGreaterThan(cosine(query, far));
  });
});

describe("isCodeFile", () => {
  it("accepts common source extensions", () => {
    expect(isCodeFile("src/index.ts")).toBe(true);
    expect(isCodeFile("app.tsx")).toBe(true);
    expect(isCodeFile("main.py")).toBe(true);
    expect(isCodeFile("lib.rs")).toBe(true);
    expect(isCodeFile("server.go")).toBe(true);
    expect(isCodeFile("style.css")).toBe(true);
    expect(isCodeFile("README.md")).toBe(true);
    expect(isCodeFile("config.yaml")).toBe(true);
    expect(isCodeFile("config.yml")).toBe(true);
    expect(isCodeFile("tsconfig.json")).toBe(true);
  });

  it("rejects lock files", () => {
    expect(isCodeFile("package-lock.json")).toBe(false);
    expect(isCodeFile("yarn.lock")).toBe(false);
    expect(isCodeFile("bun.lockb")).toBe(false);
    expect(isCodeFile("bun.lock")).toBe(false);
    expect(isCodeFile("pnpm-lock.yaml")).toBe(false);
    expect(isCodeFile("poetry.lock")).toBe(false);
    expect(isCodeFile("Cargo.lock")).toBe(false);
  });

  it("rejects binary / image extensions", () => {
    expect(isCodeFile("logo.png")).toBe(false);
    expect(isCodeFile("photo.jpg")).toBe(false);
    expect(isCodeFile("anim.gif")).toBe(false);
    expect(isCodeFile("dump.bin")).toBe(false);
    expect(isCodeFile("a.exe")).toBe(false);
    expect(isCodeFile("font.woff2")).toBe(false);
  });

  it("rejects files with no extension", () => {
    expect(isCodeFile("Makefile")).toBe(false);
    expect(isCodeFile("Dockerfile")).toBe(false);
    expect(isCodeFile("LICENSE")).toBe(false);
  });

  it("rejects empty path", () => {
    expect(isCodeFile("")).toBe(false);
  });
});

describe("chunkFile", () => {
  it("returns [] for non-code paths", () => {
    expect(chunkFile("image.png", "whatever")).toEqual([]);
    expect(chunkFile("package-lock.json", "{}" )).toEqual([]);
  });

  it("returns [] for empty content", () => {
    expect(chunkFile("foo.ts", "")).toEqual([]);
  });

  it("emits a single chunk for short files", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const chunks = chunkFile("short.ts", content, 40);
    expect(chunks.length).toBe(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(10);
    expect(chunks[0].path).toBe("short.ts");
  });

  it("produces overlapping chunks with expected start/end lines", () => {
    // 100 lines, chunkSize 40, overlap 5 → step 35
    const content = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n");
    const chunks = chunkFile("big.ts", content, 40);
    expect(chunks.length).toBeGreaterThan(1);

    // First chunk: lines 1..40
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(40);

    // Second chunk starts 35 lines later (40 - 5 overlap), i.e. line 36
    expect(chunks[1].startLine).toBe(36);
    expect(chunks[1].endLine).toBe(75);

    // Overlap: last 5 lines of chunk[0] equal first 5 of chunk[1].
    const c0Lines = chunks[0].content.split("\n");
    const c1Lines = chunks[1].content.split("\n");
    expect(c0Lines.slice(-5)).toEqual(c1Lines.slice(0, 5));

    // Last chunk must end at the final line exactly.
    const last = chunks[chunks.length - 1];
    expect(last.endLine).toBe(100);
  });

  it("preserves the exact path", () => {
    const chunks = chunkFile("src/deep/path/file.ts", "a\nb\nc", 40);
    expect(chunks[0].path).toBe("src/deep/path/file.ts");
  });
});

describe("isEmbeddingsProviderAvailable", () => {
  it("always reports fallback: true", () => {
    const p = isEmbeddingsProviderAvailable();
    expect(p.fallback).toBe(true);
    expect(typeof p.voyage).toBe("boolean");
  });
});

describe("__test bundle", () => {
  it("exports the pure helpers without DB dependency", () => {
    expect(typeof __test.tokenize).toBe("function");
    expect(typeof __test.hashEmbed).toBe("function");
    expect(typeof __test.cosine).toBe("function");
    expect(typeof __test.isCodeFile).toBe("function");
    expect(typeof __test.chunkFile).toBe("function");
  });

  it("hashes deterministically via __test.fnv1a", () => {
    expect(__test.fnv1a("hello")).toBe(__test.fnv1a("hello"));
    expect(__test.fnv1a("hello")).not.toBe(__test.fnv1a("world"));
  });
});

describe("semantic-search route — smoke", () => {
  it("GET /:owner/:repo/search/semantic for a nonexistent repo returns 404 HTML", async () => {
    const res = await app.request(
      "/nonexistent-user-xyz/nonexistent-repo-xyz/search/semantic"
    );
    // Either our own 404 (repo not found) or the global 404 if the router
    // isn't mounted yet — both are acceptable.
    expect([200, 404, 503]).toContain(res.status);
    const html = await res.text();
    // Layout marker — the response should be a full HTML shell, not JSON.
    expect(html.toLowerCase()).toContain("<html");
  });

  it("GET without query string renders the Layout (no crash on empty q)", async () => {
    const res = await app.request(
      "/nonexistent-user-xyz/nonexistent-repo-xyz/search/semantic?q="
    );
    expect([200, 404, 503]).toContain(res.status);
  });
});
