/**
 * Block D8 — AI-generated test suite helper.
 *
 * Given a source file from a repo, produces a *failing* test stub that
 * exercises the public surface of the file using whatever test framework
 * the repository appears to be using (bun:test, vitest, jest, pytest,
 * go test, etc.).
 *
 * The HTTP glue lives in `routes/ai-tests.tsx`; this module only exposes
 * pure helpers and an AI wrapper that NEVER throws. When Claude isn't
 * available (no API key, transport error, etc.) `generateTestStub` returns
 * an empty body and `framework: "fallback"` so the route can render a
 * "couldn't generate" message without crashing.
 */

import {
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
} from "./ai-client";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

export type TestLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "other";

/**
 * Detect a coarse language bucket from a file path's extension.
 * Unknown / non-code paths return "other".
 */
export function detectLanguage(path: string): TestLanguage {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "other";
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "java":
    case "kt":
      return "java";
    case "rb":
      return "ruby";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

/**
 * Given a language bucket and a flat list of repository files (paths, not
 * contents), return a short framework identifier that matches the
 * conventions the repo already appears to be using.
 *
 * The returned string is what gets plumbed into Claude prompts and is used
 * to compute the suggested test file path.
 */
export function detectTestFramework(
  language: TestLanguage,
  repoFiles: string[]
): string {
  const files = repoFiles.map((f) => f.toLowerCase());
  const has = (needle: string | RegExp): boolean => {
    if (typeof needle === "string") return files.some((f) => f === needle);
    return files.some((f) => needle.test(f));
  };

  // Python always uses pytest (most widely adopted test runner).
  if (language === "python") return "pytest";

  if (language === "go") return "go test";
  if (language === "rust") return "cargo test";
  if (language === "java") return "junit";
  if (language === "ruby") return has("gemfile") ? "rspec" : "minitest";

  // JavaScript / TypeScript — multiple competing frameworks.
  if (language === "typescript" || language === "javascript" || language === "other") {
    if (has(/vitest\.config\.(ts|js|mjs|cjs)$/) || has("vitest.config.ts"))
      return "vitest";
    if (has(/jest\.config(\..+)?$/)) return "jest";
    if (has(/\.mocharc(\..+)?$/) || has("mocha.opts")) return "mocha";
    if (has("playwright.config.ts") || has("playwright.config.js"))
      return "playwright";

    const usesBun =
      has("bun.lockb") ||
      has("bunfig.toml") ||
      files.some((f) => f.endsWith("package.json"));
    if (usesBun) return "bun:test";
  }

  return "bun:test";
}

// ---------------------------------------------------------------------------
// Suggested test path
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic path for the generated test file. The rules are
 * conventional rather than exhaustive — reviewers can always move the file
 * after generation.
 */
export function suggestedTestPath(
  sourcePath: string,
  language: TestLanguage,
  framework: string
): string {
  const parts = sourcePath.split("/");
  const file = parts[parts.length - 1] || sourcePath;
  const dir = parts.slice(0, -1).join("/");
  const dotIdx = file.lastIndexOf(".");
  const base = dotIdx > 0 ? file.slice(0, dotIdx) : file;
  const ext = dotIdx > 0 ? file.slice(dotIdx) : "";

  // Python: siblings `test_foo.py` is near-universal.
  if (language === "python" || framework === "pytest") {
    return dir ? `${dir}/test_${base}.py` : `test_${base}.py`;
  }

  // Go: `foo_test.go` adjacent to source.
  if (language === "go" || framework === "go test") {
    return dir ? `${dir}/${base}_test.go` : `${base}_test.go`;
  }

  // Rust: convention is `#[cfg(test)] mod tests` inline, but for a standalone
  // stub we drop a file into `tests/`.
  if (language === "rust" || framework === "cargo test") {
    return `tests/${base}_test.rs`;
  }

  // Java / Kotlin
  if (language === "java" || framework === "junit") {
    const klass = base.charAt(0).toUpperCase() + base.slice(1);
    return dir
      ? `${dir.replace(/\/main\//, "/test/")}/${klass}Test${ext || ".java"}`
      : `${klass}Test${ext || ".java"}`;
  }

  // Ruby
  if (language === "ruby") {
    if (framework === "rspec") {
      return dir ? `spec/${dir}/${base}_spec.rb` : `spec/${base}_spec.rb`;
    }
    return dir ? `test/${dir}/${base}_test.rb` : `test/${base}_test.rb`;
  }

  // JS/TS with bun / jest / vitest — prefer `__tests__/<name>.test.<ext>`.
  const testExt = ext === ".tsx" ? ".test.ts" : ext.replace(/^\./, ".test.");
  const safeExt = testExt || ".test.ts";

  if (framework === "bun:test") {
    // If the source is already under src/, put tests under src/__tests__/.
    if (dir.startsWith("src/")) {
      return `src/__tests__/${base}${safeExt}`;
    }
    if (dir === "src") {
      return `src/__tests__/${base}${safeExt}`;
    }
    if (dir) return `${dir}/__tests__/${base}${safeExt}`;
    return `__tests__/${base}${safeExt}`;
  }

  // vitest / jest default to sibling `.test.` file.
  if (dir) return `${dir}/${base}${safeExt}`;
  return `${base}${safeExt}`;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface TestGenOpts {
  path: string;
  language: string;
  framework: string;
  sourceCode: string;
  apiHints?: string;
}

/**
 * Build the user prompt that instructs Claude to emit a failing test stub.
 * Returning the prompt as a pure function keeps it easy to test.
 */
export function buildTestsPrompt(opts: TestGenOpts): string {
  const { path, language, framework, sourceCode, apiHints } = opts;
  const trimmed = sourceCode.length > 40_000
    ? sourceCode.slice(0, 40_000) + "\n// ... (truncated)"
    : sourceCode;

  return `You are writing an initial failing test suite for an open-source project.

Source file path: \`${path}\`
Detected language: ${language}
Detected test framework: ${framework}

Write a *failing* test stub — the tests should compile / import cleanly where possible, but assertions MUST fail (or use explicit \`fail()\` / \`todo\` / \`skip\` markers where the framework supports them) so a developer is forced to review, fill in expected values, and confirm the intended behaviour. Prefer realistic \`expect(...)\` calls with placeholder expected values that are obviously wrong (like \`TODO\`) rather than empty bodies.

Rules:
- Exercise every exported / public symbol you can see in the source.
- Use only idioms native to "${framework}".
- No explanations, no Markdown, no surrounding prose — return ONLY the test file body.
- If imports are needed, compute paths relative to the source file at \`${path}\`.
- Leave a top-of-file comment that this stub was generated by gluecron's AI test helper and MUST be reviewed before being committed.
${apiHints ? `\nAdditional hints about the public API:\n${apiHints}\n` : ""}
Source file contents:
\`\`\`
${trimmed}
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Claude wrapper
// ---------------------------------------------------------------------------

export interface TestStubResult {
  code: string;
  suggestedPath: string;
  framework: string;
  language: string;
}

/**
 * Strip a leading/trailing Markdown fence (```lang ... ```) that Claude will
 * sometimes add around the returned body, even when told not to.
 */
function stripCodeFences(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z0-9_+-]*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) return fence[1].trim();
  // Partial fences (just the opener) — drop them.
  if (text.startsWith("```")) {
    const nl = text.indexOf("\n");
    if (nl > -1) text = text.slice(nl + 1);
  }
  if (text.endsWith("```")) text = text.slice(0, -3);
  return text.trim();
}

/**
 * Ask Claude Sonnet to produce a failing test stub for the given source.
 * Never throws. On any error (AI unavailable, network failure, empty
 * response) returns `{ code: "", framework: "fallback", ... }`.
 */
export async function generateTestStub(
  opts: TestGenOpts
): Promise<TestStubResult> {
  const lang = (opts.language as TestLanguage) || "other";
  const suggestedPath = suggestedTestPath(opts.path, lang, opts.framework);

  if (!isAiAvailable()) {
    return {
      code: "",
      suggestedPath,
      framework: "fallback",
      language: opts.language,
    };
  }

  try {
    const client = getAnthropic();
    const prompt = buildTestsPrompt(opts);
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = extractText(message);
    const code = stripCodeFences(raw);
    if (!code) {
      return {
        code: "",
        suggestedPath,
        framework: "fallback",
        language: opts.language,
      };
    }
    return {
      code,
      suggestedPath,
      framework: opts.framework,
      language: opts.language,
    };
  } catch {
    return {
      code: "",
      suggestedPath,
      framework: "fallback",
      language: opts.language,
    };
  }
}

// ---------------------------------------------------------------------------
// Content types for ?format=raw
// ---------------------------------------------------------------------------

/**
 * Return a suitable `Content-Type` header for a generated test file, based
 * on the language bucket. Defaults to `text/plain; charset=utf-8`.
 */
export function contentTypeFor(language: string): string {
  switch (language) {
    case "typescript":
      return "application/typescript; charset=utf-8";
    case "javascript":
      return "application/javascript; charset=utf-8";
    case "python":
      return "text/x-python; charset=utf-8";
    case "go":
      return "text/x-go; charset=utf-8";
    case "rust":
      return "text/x-rust; charset=utf-8";
    case "java":
      return "text/x-java-source; charset=utf-8";
    case "ruby":
      return "text/x-ruby; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}
