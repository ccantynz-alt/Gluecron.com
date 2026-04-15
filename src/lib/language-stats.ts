/**
 * Block J30 — Repository language breakdown.
 *
 * Pure helpers that map file paths to a language (via extension + a handful
 * of filename-only special cases like `Dockerfile`, `Makefile`), compute
 * per-language byte totals + percentages, and can fold low-share languages
 * into an "Other" bucket.
 *
 * We also ship a compact `LANGUAGE_COLORS` map so the route can render a
 * stacked bar matching common colour conventions (GitHub-ish).
 *
 * This deliberately lives outside any linguist-style heuristic soup —
 * we don't auto-detect by content, we trust extensions + filenames. It's
 * lightweight and good enough for the breakdown UI.
 */

/**
 * Extension → language. Keys are without leading dot, lowercased.
 * A deliberately opinionated subset — no one-off exotic languages.
 */
export const EXTENSION_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    py: "Python",
    rb: "Ruby",
    go: "Go",
    rs: "Rust",
    java: "Java",
    kt: "Kotlin",
    kts: "Kotlin",
    swift: "Swift",
    c: "C",
    h: "C",
    cpp: "C++",
    cxx: "C++",
    cc: "C++",
    hpp: "C++",
    hh: "C++",
    cs: "C#",
    php: "PHP",
    pl: "Perl",
    pm: "Perl",
    r: "R",
    scala: "Scala",
    clj: "Clojure",
    ex: "Elixir",
    exs: "Elixir",
    erl: "Erlang",
    hs: "Haskell",
    lua: "Lua",
    ml: "OCaml",
    mli: "OCaml",
    dart: "Dart",
    sh: "Shell",
    bash: "Shell",
    zsh: "Shell",
    fish: "Shell",
    ps1: "PowerShell",
    sql: "SQL",
    html: "HTML",
    htm: "HTML",
    css: "CSS",
    scss: "SCSS",
    sass: "Sass",
    less: "Less",
    vue: "Vue",
    svelte: "Svelte",
    astro: "Astro",
    md: "Markdown",
    mdx: "MDX",
    rst: "reStructuredText",
    tex: "TeX",
    yaml: "YAML",
    yml: "YAML",
    json: "JSON",
    json5: "JSON",
    toml: "TOML",
    xml: "XML",
    ini: "INI",
    conf: "INI",
    proto: "Protocol Buffers",
    graphql: "GraphQL",
    gql: "GraphQL",
    zig: "Zig",
    nim: "Nim",
    vim: "Vim script",
    vb: "Visual Basic",
    asm: "Assembly",
    s: "Assembly",
    dockerfile: "Dockerfile",
  })
);

/** Filename → language for files that traditionally have no extension. */
export const FILENAME_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries({
    dockerfile: "Dockerfile",
    makefile: "Makefile",
    gnumakefile: "Makefile",
    rakefile: "Ruby",
    gemfile: "Ruby",
    procfile: "Procfile",
    jenkinsfile: "Groovy",
    "cmakelists.txt": "CMake",
    "meson.build": "Meson",
    "build.gradle": "Groovy",
    "build.gradle.kts": "Kotlin",
    "pom.xml": "XML",
    "package.json": "JSON",
    "tsconfig.json": "JSON",
  })
);

/**
 * GitHub-ish language colours. Omitted entries render with a neutral grey.
 * Only widely-used languages get a brand colour here.
 */
export const LANGUAGE_COLORS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    TypeScript: "#3178c6",
    JavaScript: "#f1e05a",
    Python: "#3572A5",
    Ruby: "#701516",
    Go: "#00ADD8",
    Rust: "#dea584",
    Java: "#b07219",
    Kotlin: "#A97BFF",
    Swift: "#F05138",
    C: "#555555",
    "C++": "#f34b7d",
    "C#": "#178600",
    PHP: "#4F5D95",
    Scala: "#c22d40",
    Clojure: "#db5855",
    Elixir: "#6e4a7e",
    Haskell: "#5e5086",
    Lua: "#000080",
    Shell: "#89e051",
    PowerShell: "#012456",
    HTML: "#e34c26",
    CSS: "#563d7c",
    SCSS: "#c6538c",
    Vue: "#41b883",
    Svelte: "#ff3e00",
    Astro: "#ff5d01",
    Markdown: "#083fa1",
    YAML: "#cb171e",
    JSON: "#292929",
    TOML: "#9c4221",
    GraphQL: "#e10098",
    Dockerfile: "#384d54",
    Makefile: "#427819",
    SQL: "#e38c00",
    Dart: "#00B4AB",
    Zig: "#ec915c",
    Other: "#888888",
  })
);

/** Fallback colour when a language has no LANGUAGE_COLORS entry. */
export const DEFAULT_LANGUAGE_COLOR = "#888888";

/**
 * Paths we never want in the breakdown: vendored + generated + lock files.
 * Callers can opt out by passing `ignoreVendored: false`.
 */
export const VENDORED_PREFIXES: readonly string[] = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "coverage/",
  ".git/",
  "target/",
  "bin/",
];

export const GENERATED_SUFFIXES: readonly string[] = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
];

export interface LanguageFileEntry {
  path: string;
  size: number;
}

export interface LanguageBucket {
  language: string;
  bytes: number;
  fileCount: number;
  percent: number;
  color: string;
}

export interface LanguageReport {
  totalBytes: number;
  totalFiles: number;
  countedFiles: number;
  /** Non-"Other" per-language rollup, sorted by bytes desc. */
  buckets: LanguageBucket[];
  primary: LanguageBucket | null;
}

function lastSegment(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function extensionOf(basename: string): string | null {
  const i = basename.lastIndexOf(".");
  if (i <= 0) return null;
  return basename.slice(i + 1).toLowerCase();
}

/**
 * Return the language for a path, or null if it can't be classified.
 * Tries `FILENAME_MAP` on the basename first (for extensionless files
 * like `Dockerfile`), then `EXTENSION_MAP`.
 */
export function detectLanguage(path: string): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  const base = lastSegment(path).toLowerCase();
  const byName = FILENAME_MAP.get(base);
  if (byName) return byName;
  const ext = extensionOf(base);
  if (!ext) return null;
  return EXTENSION_MAP.get(ext) ?? null;
}

export function isVendoredOrGenerated(path: string): boolean {
  if (typeof path !== "string") return false;
  const normal = path.startsWith("/") ? path.slice(1) : path;
  for (const pref of VENDORED_PREFIXES) {
    if (normal.startsWith(pref) || normal.includes("/" + pref)) return true;
  }
  const base = lastSegment(normal);
  for (const sfx of GENERATED_SUFFIXES) {
    if (base === sfx) return true;
  }
  return false;
}

export interface StatsOptions {
  /** Exclude `node_modules/`, `dist/`, lock files, etc. Default true. */
  ignoreVendored?: boolean;
  /** Cap the per-file size we'll count (prevents a 500MB blob biasing the pie). */
  maxFileSize?: number;
  /** Minimum bytes for a language to avoid being folded into "Other". Default 0 (= keep all). */
  minLanguageBytes?: number;
}

function colorFor(lang: string): string {
  return LANGUAGE_COLORS.get(lang) ?? DEFAULT_LANGUAGE_COLOR;
}

/**
 * Walk the entries, bucket by detected language, compute percentages.
 * Paths that can't be classified are ignored (they don't count against
 * the total). Returns a sorted `buckets` array.
 */
export function computeLanguageStats(
  entries: readonly LanguageFileEntry[],
  opts: StatsOptions = {}
): LanguageReport {
  const ignoreVendored = opts.ignoreVendored !== false;
  const maxFileSize =
    opts.maxFileSize !== undefined && opts.maxFileSize > 0
      ? opts.maxFileSize
      : Number.POSITIVE_INFINITY;
  const minLanguageBytes = opts.minLanguageBytes ?? 0;

  let totalFiles = 0;
  let countedFiles = 0;
  const byLang = new Map<string, { bytes: number; fileCount: number }>();

  for (const e of entries) {
    totalFiles++;
    if (!e || typeof e.path !== "string") continue;
    if (ignoreVendored && isVendoredOrGenerated(e.path)) continue;
    const lang = detectLanguage(e.path);
    if (!lang) continue;
    const sz = Math.min(
      Math.max(0, Number.isFinite(e.size) ? e.size : 0),
      maxFileSize
    );
    if (sz === 0) continue;
    countedFiles++;
    const agg = byLang.get(lang) ?? { bytes: 0, fileCount: 0 };
    agg.bytes += sz;
    agg.fileCount++;
    byLang.set(lang, agg);
  }

  const totalBytes = Array.from(byLang.values()).reduce(
    (acc, v) => acc + v.bytes,
    0
  );

  const buckets: LanguageBucket[] = [];
  let otherBytes = 0;
  let otherFiles = 0;
  for (const [language, { bytes, fileCount }] of byLang) {
    if (bytes < minLanguageBytes) {
      otherBytes += bytes;
      otherFiles += fileCount;
      continue;
    }
    buckets.push({
      language,
      bytes,
      fileCount,
      percent: totalBytes === 0 ? 0 : (bytes / totalBytes) * 100,
      color: colorFor(language),
    });
  }
  if (otherBytes > 0) {
    buckets.push({
      language: "Other",
      bytes: otherBytes,
      fileCount: otherFiles,
      percent: totalBytes === 0 ? 0 : (otherBytes / totalBytes) * 100,
      color: colorFor("Other"),
    });
  }

  buckets.sort((a, b) => {
    if (a.language === "Other" && b.language !== "Other") return 1;
    if (b.language === "Other" && a.language !== "Other") return -1;
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;
    return a.language.localeCompare(b.language);
  });

  const primary = buckets.find((b) => b.language !== "Other") ?? null;
  return {
    totalBytes,
    totalFiles,
    countedFiles,
    buckets,
    primary,
  };
}

/**
 * Fold languages under `thresholdPercent` into an "Other" bucket.
 * Only rebucketing — re-running on the output is idempotent.
 */
export function foldIntoOther(
  report: LanguageReport,
  thresholdPercent: number
): LanguageReport {
  if (thresholdPercent <= 0) return report;
  const keep: LanguageBucket[] = [];
  let otherBytes = 0;
  let otherFiles = 0;
  for (const b of report.buckets) {
    if (b.language === "Other" || b.percent < thresholdPercent) {
      otherBytes += b.bytes;
      otherFiles += b.fileCount;
    } else {
      keep.push(b);
    }
  }
  if (otherBytes > 0) {
    keep.push({
      language: "Other",
      bytes: otherBytes,
      fileCount: otherFiles,
      percent:
        report.totalBytes === 0 ? 0 : (otherBytes / report.totalBytes) * 100,
      color: colorFor("Other"),
    });
  }
  keep.sort((a, b) => {
    if (a.language === "Other" && b.language !== "Other") return 1;
    if (b.language === "Other" && a.language !== "Other") return -1;
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;
    return a.language.localeCompare(b.language);
  });
  return {
    ...report,
    buckets: keep,
    primary: keep.find((b) => b.language !== "Other") ?? null,
  };
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  let v = n;
  let u = 0;
  while (v >= 1024 && u < SIZE_UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${SIZE_UNITS[u]}`;
}

export function formatPercent(p: number, digits = 1): string {
  if (!Number.isFinite(p)) return "0%";
  const v = Math.max(0, Math.min(100, p));
  return `${v.toFixed(digits)}%`;
}

export interface BuildReportOptions extends StatsOptions {
  entries: readonly LanguageFileEntry[];
  /** After rollup, fold any language under this percentage into Other. */
  foldUnderPercent?: number;
}

export function buildLanguageReport(opts: BuildReportOptions): LanguageReport {
  const base = computeLanguageStats(opts.entries, opts);
  if (opts.foldUnderPercent && opts.foldUnderPercent > 0) {
    return foldIntoOther(base, opts.foldUnderPercent);
  }
  return base;
}

export const __internal = {
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
  colorFor,
};
