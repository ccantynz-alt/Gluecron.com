/**
 * Block J30 — Repository language breakdown. Pure helper tests.
 *
 * Exercises:
 *   - detectLanguage (extension map, filename map, case-insensitivity, null paths)
 *   - isVendoredOrGenerated (prefixes, nested prefixes, lockfile basenames)
 *   - computeLanguageStats (vendoring, size caps, min-bytes fold, unclassified)
 *   - foldIntoOther (idempotency, threshold, sort stability)
 *   - formatBytes / formatPercent (boundaries + NaN / negative handling)
 *   - buildLanguageReport (one-shot equivalence)
 *   - Route smoke test
 *   - __internal parity
 */

import { describe, it, expect } from "bun:test";
import {
  EXTENSION_MAP,
  FILENAME_MAP,
  LANGUAGE_COLORS,
  DEFAULT_LANGUAGE_COLOR,
  VENDORED_PREFIXES,
  GENERATED_SUFFIXES,
  detectLanguage,
  isVendoredOrGenerated,
  computeLanguageStats,
  foldIntoOther,
  formatBytes,
  formatPercent,
  buildLanguageReport,
  __internal,
  type LanguageFileEntry,
  type LanguageReport,
} from "../lib/language-stats";

describe("language-stats — detectLanguage", () => {
  it("resolves common extensions", () => {
    expect(detectLanguage("src/app.ts")).toBe("TypeScript");
    expect(detectLanguage("src/app.tsx")).toBe("TypeScript");
    expect(detectLanguage("lib/foo.js")).toBe("JavaScript");
    expect(detectLanguage("lib/foo.mjs")).toBe("JavaScript");
    expect(detectLanguage("lib/foo.cjs")).toBe("JavaScript");
    expect(detectLanguage("scripts/build.py")).toBe("Python");
    expect(detectLanguage("pkg/main.go")).toBe("Go");
    expect(detectLanguage("src/lib.rs")).toBe("Rust");
    expect(detectLanguage("App.java")).toBe("Java");
    expect(detectLanguage("App.kt")).toBe("Kotlin");
    expect(detectLanguage("README.md")).toBe("Markdown");
    expect(detectLanguage("docs/index.mdx")).toBe("MDX");
    expect(detectLanguage("config.yaml")).toBe("YAML");
    expect(detectLanguage("config.yml")).toBe("YAML");
    expect(detectLanguage("package.json")).toBe("JSON");
    expect(detectLanguage("query.gql")).toBe("GraphQL");
    expect(detectLanguage("schema.graphql")).toBe("GraphQL");
    expect(detectLanguage("style.scss")).toBe("SCSS");
    expect(detectLanguage("index.html")).toBe("HTML");
    expect(detectLanguage("hello.zig")).toBe("Zig");
    expect(detectLanguage("hello.dart")).toBe("Dart");
  });

  it("resolves filename-only languages", () => {
    expect(detectLanguage("Dockerfile")).toBe("Dockerfile");
    expect(detectLanguage("docker/Dockerfile")).toBe("Dockerfile");
    expect(detectLanguage("Makefile")).toBe("Makefile");
    expect(detectLanguage("GNUmakefile")).toBe("Makefile");
    expect(detectLanguage("Rakefile")).toBe("Ruby");
    expect(detectLanguage("Gemfile")).toBe("Ruby");
    expect(detectLanguage("Jenkinsfile")).toBe("Groovy");
    expect(detectLanguage("CMakeLists.txt")).toBe("CMake");
    expect(detectLanguage("meson.build")).toBe("Meson");
  });

  it("is case-insensitive for both maps", () => {
    expect(detectLanguage("src/FOO.TS")).toBe("TypeScript");
    expect(detectLanguage("DOCKERFILE")).toBe("Dockerfile");
    expect(detectLanguage("makefile")).toBe("Makefile");
  });

  it("returns null for unrecognised files", () => {
    expect(detectLanguage("unknown.xyz")).toBeNull();
    expect(detectLanguage("no-extension")).toBeNull();
    expect(detectLanguage("")).toBeNull();
  });

  it("guards non-string input", () => {
    // @ts-expect-error — intentionally wrong
    expect(detectLanguage(null)).toBeNull();
    // @ts-expect-error
    expect(detectLanguage(undefined)).toBeNull();
    // @ts-expect-error
    expect(detectLanguage(42)).toBeNull();
  });

  it("treats dotfiles (leading-dot basenames) as extensionless when not in filename map", () => {
    // `.env`, `.gitignore` etc. have no extension by our rule.
    expect(detectLanguage(".gitignore")).toBeNull();
    expect(detectLanguage(".env")).toBeNull();
  });

  it("picks the last extension only", () => {
    expect(detectLanguage("archive.tar.gz")).toBeNull();
    expect(detectLanguage("index.d.ts")).toBe("TypeScript");
    expect(detectLanguage("component.test.tsx")).toBe("TypeScript");
  });
});

describe("language-stats — isVendoredOrGenerated", () => {
  it("flags top-level vendored prefixes", () => {
    for (const pref of VENDORED_PREFIXES) {
      expect(isVendoredOrGenerated(pref + "any/file.ts")).toBe(true);
    }
  });
  it("flags nested vendored prefixes", () => {
    expect(isVendoredOrGenerated("pkg/node_modules/foo/bar.js")).toBe(true);
    expect(isVendoredOrGenerated("apps/web/dist/main.js")).toBe(true);
  });
  it("flags lockfile basenames anywhere", () => {
    for (const sfx of GENERATED_SUFFIXES) {
      expect(isVendoredOrGenerated(sfx)).toBe(true);
      expect(isVendoredOrGenerated(`some/nested/${sfx}`)).toBe(true);
    }
  });
  it("does not flag ordinary source files", () => {
    expect(isVendoredOrGenerated("src/app.ts")).toBe(false);
    expect(isVendoredOrGenerated("lib/package.json")).toBe(false);
    expect(isVendoredOrGenerated("README.md")).toBe(false);
  });
  it("tolerates a leading slash", () => {
    expect(isVendoredOrGenerated("/node_modules/foo.js")).toBe(true);
  });
  it("guards non-string input", () => {
    // @ts-expect-error
    expect(isVendoredOrGenerated(null)).toBe(false);
    // @ts-expect-error
    expect(isVendoredOrGenerated(undefined)).toBe(false);
  });
});

describe("language-stats — computeLanguageStats (basic rollup)", () => {
  const entries: LanguageFileEntry[] = [
    { path: "src/a.ts", size: 100 },
    { path: "src/b.ts", size: 300 },
    { path: "src/c.py", size: 200 },
    { path: "README.md", size: 50 },
    { path: "unknown.xyz", size: 9999 }, // dropped
  ];

  it("aggregates bytes per language and computes percentages", () => {
    const r = computeLanguageStats(entries);
    expect(r.totalFiles).toBe(5);
    expect(r.countedFiles).toBe(4); // unknown dropped
    expect(r.totalBytes).toBe(100 + 300 + 200 + 50);

    const ts = r.buckets.find((b) => b.language === "TypeScript")!;
    const py = r.buckets.find((b) => b.language === "Python")!;
    const md = r.buckets.find((b) => b.language === "Markdown")!;
    expect(ts.bytes).toBe(400);
    expect(ts.fileCount).toBe(2);
    expect(py.bytes).toBe(200);
    expect(md.bytes).toBe(50);

    const totalPct = r.buckets.reduce((acc, b) => acc + b.percent, 0);
    expect(Math.round(totalPct)).toBe(100);

    // Sorted by bytes desc — TS comes first.
    expect(r.buckets[0]!.language).toBe("TypeScript");
    expect(r.primary?.language).toBe("TypeScript");
  });

  it("assigns colours from the map", () => {
    const r = computeLanguageStats(entries);
    const ts = r.buckets.find((b) => b.language === "TypeScript")!;
    expect(ts.color).toBe(LANGUAGE_COLORS.get("TypeScript"));
  });

  it("falls back to the default colour for unmapped languages", () => {
    const out = computeLanguageStats([
      { path: "hi.pl", size: 100 }, // Perl — not in LANGUAGE_COLORS
    ]);
    const perl = out.buckets.find((b) => b.language === "Perl")!;
    expect(perl.color).toBe(DEFAULT_LANGUAGE_COLOR);
  });

  it("ignores vendored paths by default", () => {
    const r = computeLanguageStats([
      { path: "src/a.ts", size: 100 },
      { path: "node_modules/foo/bar.js", size: 10_000 },
      { path: "dist/main.js", size: 20_000 },
      { path: "package-lock.json", size: 5_000 },
    ]);
    expect(r.totalBytes).toBe(100);
    expect(r.buckets).toHaveLength(1);
    expect(r.buckets[0]!.language).toBe("TypeScript");
  });

  it("counts vendored paths when ignoreVendored=false", () => {
    const r = computeLanguageStats(
      [
        { path: "src/a.ts", size: 100 },
        { path: "node_modules/foo/bar.js", size: 10_000 },
      ],
      { ignoreVendored: false }
    );
    expect(r.totalBytes).toBe(10_100);
    const js = r.buckets.find((b) => b.language === "JavaScript")!;
    expect(js.bytes).toBe(10_000);
  });

  it("caps per-file size via maxFileSize", () => {
    const r = computeLanguageStats(
      [
        { path: "src/small.ts", size: 100 },
        { path: "src/huge.ts", size: 50_000 },
      ],
      { maxFileSize: 1_000 }
    );
    const ts = r.buckets.find((b) => b.language === "TypeScript")!;
    // small=100 + huge capped at 1_000 = 1_100
    expect(ts.bytes).toBe(1_100);
  });

  it("skips zero-size files and negative sizes", () => {
    const r = computeLanguageStats([
      { path: "src/a.ts", size: 0 },
      { path: "src/b.ts", size: -5 },
      { path: "src/c.ts", size: 10 },
    ]);
    expect(r.countedFiles).toBe(1);
    expect(r.totalBytes).toBe(10);
  });

  it("skips entries with non-string path or bogus size", () => {
    const r = computeLanguageStats([
      // @ts-expect-error
      { path: 42, size: 1 },
      { path: "src/a.ts", size: Number.NaN },
      { path: "src/b.ts", size: 10 },
    ]);
    expect(r.totalBytes).toBe(10);
  });

  it("folds languages below minLanguageBytes into Other", () => {
    const r = computeLanguageStats(
      [
        { path: "src/big.ts", size: 10_000 },
        { path: "tiny.py", size: 50 },
        { path: "small.go", size: 100 },
      ],
      { minLanguageBytes: 200 }
    );
    const other = r.buckets.find((b) => b.language === "Other")!;
    expect(other.bytes).toBe(150);
    expect(other.fileCount).toBe(2);
    expect(other.color).toBe(LANGUAGE_COLORS.get("Other"));
    // Other must sort last.
    expect(r.buckets.at(-1)!.language).toBe("Other");
    // primary must skip Other.
    expect(r.primary?.language).toBe("TypeScript");
  });

  it("returns empty report when nothing classifies", () => {
    const r = computeLanguageStats([
      { path: "unknown.xyz", size: 10 },
    ]);
    expect(r.totalBytes).toBe(0);
    expect(r.buckets).toHaveLength(0);
    expect(r.primary).toBeNull();
  });

  it("handles an empty input", () => {
    const r = computeLanguageStats([]);
    expect(r.totalFiles).toBe(0);
    expect(r.countedFiles).toBe(0);
    expect(r.totalBytes).toBe(0);
    expect(r.buckets).toEqual([]);
    expect(r.primary).toBeNull();
  });

  it("breaks bucket ties by language name", () => {
    const r = computeLanguageStats([
      { path: "a.py", size: 100 },
      { path: "a.rb", size: 100 },
      { path: "a.go", size: 100 },
    ]);
    // All equal — alphabetical.
    expect(r.buckets.map((b) => b.language)).toEqual([
      "Go",
      "Python",
      "Ruby",
    ]);
  });
});

describe("language-stats — foldIntoOther", () => {
  function mkReport(pairs: Array<[string, number]>): LanguageReport {
    const total = pairs.reduce((acc, [, n]) => acc + n, 0);
    return {
      totalBytes: total,
      totalFiles: pairs.length,
      countedFiles: pairs.length,
      buckets: pairs.map(([language, bytes]) => ({
        language,
        bytes,
        fileCount: 1,
        percent: total === 0 ? 0 : (bytes / total) * 100,
        color: LANGUAGE_COLORS.get(language) ?? DEFAULT_LANGUAGE_COLOR,
      })),
      primary: null,
    };
  }

  it("folds buckets below the threshold into Other", () => {
    const r = mkReport([
      ["TypeScript", 900],
      ["Python", 80],
      ["Ruby", 20],
    ]);
    const out = foldIntoOther(r, 10); // 10%
    // Only TS survives (Python=8%, Ruby=2%).
    expect(out.buckets.map((b) => b.language)).toEqual(["TypeScript", "Other"]);
    const other = out.buckets.find((b) => b.language === "Other")!;
    expect(other.bytes).toBe(100);
    expect(other.fileCount).toBe(2);
    expect(out.primary?.language).toBe("TypeScript");
  });

  it("is idempotent when called twice", () => {
    const r = mkReport([
      ["TypeScript", 900],
      ["Python", 80],
      ["Ruby", 20],
    ]);
    const once = foldIntoOther(r, 10);
    const twice = foldIntoOther(once, 10);
    expect(twice.buckets.map((b) => `${b.language}:${b.bytes}`)).toEqual(
      once.buckets.map((b) => `${b.language}:${b.bytes}`)
    );
  });

  it("threshold <=0 is a no-op", () => {
    const r = mkReport([
      ["TypeScript", 900],
      ["Python", 100],
    ]);
    expect(foldIntoOther(r, 0)).toBe(r);
    expect(foldIntoOther(r, -5)).toBe(r);
  });

  it("Other always sorts last after folding", () => {
    const r = mkReport([
      ["TypeScript", 500],
      ["Python", 500],
      ["Ruby", 1],
    ]);
    const out = foldIntoOther(r, 1);
    expect(out.buckets.at(-1)!.language).toBe("Other");
  });
});

describe("language-stats — formatBytes", () => {
  it("formats bytes, KB, MB, GB, TB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });
  it("drops decimals past 10 in a unit", () => {
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(1024 * 1024 * 15)).toBe("15 MB");
  });
  it("handles negative and non-finite input", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("language-stats — formatPercent", () => {
  it("formats to given digits and clamps to [0,100]", () => {
    expect(formatPercent(50)).toBe("50.0%");
    expect(formatPercent(50, 0)).toBe("50%");
    expect(formatPercent(50, 2)).toBe("50.00%");
    expect(formatPercent(-5)).toBe("0.0%");
    expect(formatPercent(200)).toBe("100.0%");
  });
  it("handles NaN", () => {
    expect(formatPercent(Number.NaN)).toBe("0%");
  });
});

describe("language-stats — buildLanguageReport", () => {
  const entries: LanguageFileEntry[] = [
    { path: "src/a.ts", size: 1_000 },
    { path: "main.py", size: 100 },
    { path: "tiny.rb", size: 5 },
  ];

  it("matches computeLanguageStats when foldUnderPercent is 0", () => {
    const a = computeLanguageStats(entries);
    const b = buildLanguageReport({ entries });
    expect(a.buckets.map((x) => x.language)).toEqual(
      b.buckets.map((x) => x.language)
    );
    expect(a.totalBytes).toBe(b.totalBytes);
  });

  it("applies foldUnderPercent after rollup", () => {
    const r = buildLanguageReport({ entries, foldUnderPercent: 2 });
    // Ruby=5B out of 1105 ≈ 0.45% < 2% → folds into Other
    expect(r.buckets.some((b) => b.language === "Ruby")).toBe(false);
    expect(r.buckets.some((b) => b.language === "Other")).toBe(true);
  });

  it("respects ignoreVendored=false", () => {
    const r = buildLanguageReport({
      entries: [
        { path: "src/a.ts", size: 100 },
        { path: "node_modules/foo/bar.js", size: 10_000 },
      ],
      ignoreVendored: false,
    });
    expect(r.buckets.some((b) => b.language === "JavaScript")).toBe(true);
  });
});

describe("language-stats — routes", () => {
  it("GET /:o/:r/languages returns 200 or 404 (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/languages");
    expect([200, 404]).toContain(res.status);
  });
  it("ignores bogus query params", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/languages?include_vendored=yes&fold=abc"
    );
    expect([200, 404]).toContain(res.status);
  });
});

describe("language-stats — __internal parity", () => {
  it("re-exports every helper", () => {
    expect(__internal.EXTENSION_MAP).toBe(EXTENSION_MAP);
    expect(__internal.FILENAME_MAP).toBe(FILENAME_MAP);
    expect(__internal.LANGUAGE_COLORS).toBe(LANGUAGE_COLORS);
    expect(__internal.DEFAULT_LANGUAGE_COLOR).toBe(DEFAULT_LANGUAGE_COLOR);
    expect(__internal.VENDORED_PREFIXES).toBe(VENDORED_PREFIXES);
    expect(__internal.GENERATED_SUFFIXES).toBe(GENERATED_SUFFIXES);
    expect(__internal.detectLanguage).toBe(detectLanguage);
    expect(__internal.isVendoredOrGenerated).toBe(isVendoredOrGenerated);
    expect(__internal.computeLanguageStats).toBe(computeLanguageStats);
    expect(__internal.foldIntoOther).toBe(foldIntoOther);
    expect(__internal.formatBytes).toBe(formatBytes);
    expect(__internal.formatPercent).toBe(formatPercent);
    expect(__internal.buildLanguageReport).toBe(buildLanguageReport);
    expect(typeof __internal.colorFor).toBe("function");
  });
});
