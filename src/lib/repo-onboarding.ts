/**
 * Smart empty states — repo onboarding generation.
 *
 * generateRepoOnboarding()  — analyse a repo's file tree + detect language/
 *                             framework, then call Claude Sonnet to produce a
 *                             README draft, suggested labels, a gates.yml
 *                             starter, and first-commit suggestions.
 *
 * ensureRepoOnboarding()    — idempotent wrapper called on first push;
 *                             skips if onboarding_shown is already set OR if
 *                             the repo_onboarding_data row already exists.
 *
 * All external calls are swallowed — a missing AI key or DB error must never
 * break the push path.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, repoOnboardingData } from "../db/schema";
import { getAnthropic, isAiAvailable, MODEL_SONNET, extractText, parseJsonResponse } from "./ai-client";
import { getRepoPath } from "../git/repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoOnboarding {
  detectedLanguage: string;
  detectedFramework?: string;
  suggestedReadme: string;
  suggestedLabels: Array<{ name: string; color: string; description: string }>;
  suggestedGatesConfig: string;
  firstCommitSuggestions: string[];
}

// ---------------------------------------------------------------------------
// Language + framework detection helpers
// ---------------------------------------------------------------------------

function detectLanguage(files: string[]): string {
  const counts: Record<string, number> = {};
  for (const f of files) {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "ts" || ext === "tsx") counts.TypeScript = (counts.TypeScript ?? 0) + 1;
    else if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") counts.JavaScript = (counts.JavaScript ?? 0) + 1;
    else if (ext === "py") counts.Python = (counts.Python ?? 0) + 1;
    else if (ext === "go") counts.Go = (counts.Go ?? 0) + 1;
    else if (ext === "rs") counts.Rust = (counts.Rust ?? 0) + 1;
    else if (ext === "java") counts.Java = (counts.Java ?? 0) + 1;
    else if (ext === "rb") counts.Ruby = (counts.Ruby ?? 0) + 1;
    else if (ext === "php") counts.PHP = (counts.PHP ?? 0) + 1;
    else if (ext === "cs") counts["C#"] = (counts["C#"] ?? 0) + 1;
    else if (ext === "cpp" || ext === "cc" || ext === "cxx") counts["C++"] = (counts["C++"] ?? 0) + 1;
    else if (ext === "c" || ext === "h") counts.C = (counts.C ?? 0) + 1;
    else if (ext === "swift") counts.Swift = (counts.Swift ?? 0) + 1;
    else if (ext === "kt") counts.Kotlin = (counts.Kotlin ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? "Unknown";
}

async function detectFramework(
  ownerName: string,
  repoName: string,
  files: string[]
): Promise<string | undefined> {
  const fileSet = new Set(files.map((f) => f.toLowerCase()));

  // Check next.config.* — Next.js
  if (files.some((f) => /next\.config\.(js|ts|mjs|cjs)/.test(f))) return "Next.js";

  // Check Cargo.toml for Actix / Axum / Warp
  if (fileSet.has("cargo.toml")) {
    const content = await readFileFromGit(ownerName, repoName, "Cargo.toml");
    if (content) {
      if (/actix-web/.test(content)) return "Actix";
      if (/axum/.test(content)) return "Axum";
      if (/warp/.test(content)) return "Warp";
    }
  }

  // Check requirements.txt for FastAPI / Django / Flask
  if (fileSet.has("requirements.txt")) {
    const content = await readFileFromGit(ownerName, repoName, "requirements.txt");
    if (content) {
      if (/fastapi/i.test(content)) return "FastAPI";
      if (/django/i.test(content)) return "Django";
      if (/flask/i.test(content)) return "Flask";
    }
  }

  // Check package.json for various JS frameworks
  if (fileSet.has("package.json")) {
    const content = await readFileFromGit(ownerName, repoName, "package.json");
    if (content) {
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        const deps = {
          ...((pkg.dependencies as Record<string, string>) ?? {}),
          ...((pkg.devDependencies as Record<string, string>) ?? {}),
        };
        if ("hono" in deps) return "Hono";
        if ("next" in deps) return "Next.js";
        if ("express" in deps) return "Express";
        if ("fastify" in deps) return "Fastify";
        if ("@nestjs/core" in deps) return "NestJS";
        if ("nuxt" in deps) return "Nuxt";
        if ("svelte" in deps) return "SvelteKit";
        if ("remix" in deps || "@remix-run/node" in deps) return "Remix";
        if ("react" in deps) return "React";
        if ("vue" in deps) return "Vue";
      } catch {
        /* ignore parse error */
      }
    }
  }

  // go.mod check
  if (fileSet.has("go.mod")) {
    const content = await readFileFromGit(ownerName, repoName, "go.mod");
    if (content) {
      if (/gin-gonic\/gin/.test(content)) return "Gin";
      if (/labstack\/echo/.test(content)) return "Echo";
      if (/gofiber\/fiber/.test(content)) return "Fiber";
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function listAllFiles(ownerName: string, repoName: string): Promise<string[]> {
  const cwd = getRepoPath(ownerName, repoName);
  try {
    const proc = Bun.spawn(
      ["git", "ls-tree", "-r", "--name-only", "HEAD"],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function readFileFromGit(
  ownerName: string,
  repoName: string,
  path: string
): Promise<string | null> {
  const cwd = getRepoPath(ownerName, repoName);
  try {
    const proc = Bun.spawn(
      ["git", "show", `HEAD:${path}`],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    return exit === 0 ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default labels by language (no AI required)
// ---------------------------------------------------------------------------

const DEFAULT_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "feature", color: "0075ca", description: "New feature or request" },
  { name: "docs", color: "0052cc", description: "Improvements or additions to documentation" },
  { name: "performance", color: "e4e669", description: "Performance improvement" },
  { name: "security", color: "e11d48", description: "Security vulnerability or fix" },
  { name: "breaking-change", color: "b60205", description: "Breaking change that requires version bump" },
];

const LANGUAGE_LABELS: Record<string, Array<{ name: string; color: string; description: string }>> = {
  TypeScript: [
    { name: "types", color: "3178c6", description: "TypeScript type definitions or fixes" },
    { name: "deps", color: "0366d6", description: "Dependency update" },
  ],
  Python: [
    { name: "pep8", color: "ffd43b", description: "Code style: PEP 8 compliance" },
    { name: "deps", color: "0366d6", description: "Dependency update" },
  ],
  Go: [
    { name: "goroutine", color: "00add8", description: "Concurrency / goroutine related" },
    { name: "deps", color: "0366d6", description: "Go module dependency" },
  ],
  Rust: [
    { name: "unsafe", color: "e83e8c", description: "Involves unsafe Rust code" },
    { name: "deps", color: "0366d6", description: "Cargo dependency" },
  ],
};

function buildDefaultLabels(
  language: string
): Array<{ name: string; color: string; description: string }> {
  const extras = LANGUAGE_LABELS[language] ?? [];
  return [...DEFAULT_LABELS, ...extras];
}

// ---------------------------------------------------------------------------
// gates.yml starters
// ---------------------------------------------------------------------------

function buildDefaultGatesConfig(language: string, framework?: string): string {
  const lang = language.toLowerCase();
  if (lang === "typescript" || lang === "javascript") {
    return `version: 1
gates:
  - id: type-check
    run: npx tsc --noEmit
    on: push
  - id: lint
    run: npx eslint . --ext .ts,.tsx,.js,.jsx
    on: push
  - id: test
    run: ${framework === "Hono" || lang === "typescript" ? "bun test" : "npm test"}
    on: push
`;
  }
  if (lang === "python") {
    return `version: 1
gates:
  - id: lint
    run: ruff check .
    on: push
  - id: type-check
    run: mypy .
    on: push
  - id: test
    run: pytest
    on: push
`;
  }
  if (lang === "go") {
    return `version: 1
gates:
  - id: vet
    run: go vet ./...
    on: push
  - id: test
    run: go test ./...
    on: push
`;
  }
  if (lang === "rust") {
    return `version: 1
gates:
  - id: check
    run: cargo check
    on: push
  - id: clippy
    run: cargo clippy -- -D warnings
    on: push
  - id: test
    run: cargo test
    on: push
`;
  }
  return `version: 1
gates:
  - id: test
    run: echo "Add your test command here"
    on: push
`;
}

// ---------------------------------------------------------------------------
// First-commit suggestions
// ---------------------------------------------------------------------------

function buildFirstCommitSuggestions(language: string): string[] {
  const lang = language.toLowerCase();
  const suggestions = [`Add a .gitignore for ${language}`];
  if (lang === "typescript" || lang === "javascript") {
    suggestions.push("Add a tsconfig.json");
    suggestions.push("Add ESLint + Prettier config");
    suggestions.push("Add a README.md");
    suggestions.push("Add tests/ directory with a sample test");
  } else if (lang === "python") {
    suggestions.push("Add requirements.txt or pyproject.toml");
    suggestions.push("Add a README.md");
    suggestions.push("Add tests/ directory with pytest");
  } else if (lang === "go") {
    suggestions.push("Initialize go.mod (go mod init)");
    suggestions.push("Add a README.md");
    suggestions.push("Add *_test.go files");
  } else if (lang === "rust") {
    suggestions.push("Cargo.toml is auto-generated — add a README.md");
    suggestions.push("Add integration tests in tests/");
  } else {
    suggestions.push("Add a README.md");
    suggestions.push("Add tests/");
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// Main generation function
// ---------------------------------------------------------------------------

export async function generateRepoOnboarding(
  repoId: string,
  ownerName: string,
  repoName: string
): Promise<RepoOnboarding> {
  const files = await listAllFiles(ownerName, repoName);
  const language = detectLanguage(files);
  const framework = await detectFramework(ownerName, repoName, files);

  const existingReadme =
    (await readFileFromGit(ownerName, repoName, "README.md")) ||
    (await readFileFromGit(ownerName, repoName, "readme.md")) ||
    (await readFileFromGit(ownerName, repoName, "README.txt")) ||
    null;

  const defaultLabels = buildDefaultLabels(language);
  const defaultGatesConfig = buildDefaultGatesConfig(language, framework);
  const defaultSuggestions = buildFirstCommitSuggestions(language);

  // Without AI: return sensible defaults immediately
  if (!isAiAvailable()) {
    const readmeDraft = existingReadme ?? buildFallbackReadme(repoName, language, framework);
    return {
      detectedLanguage: language,
      detectedFramework: framework,
      suggestedReadme: readmeDraft,
      suggestedLabels: defaultLabels,
      suggestedGatesConfig: defaultGatesConfig,
      firstCommitSuggestions: defaultSuggestions,
    };
  }

  // With AI: call Claude Sonnet 4.6 for richer content
  try {
    const fileTree = files.slice(0, 120).join("\n");
    const readmeContext = existingReadme
      ? existingReadme.slice(0, 2000)
      : "(none)";

    const prompt = `Generate onboarding content for a new ${language}${framework ? ` ${framework}` : ""} repository named "${repoName}".

File tree (if any):
${fileTree || "(empty — no commits yet)"}

Existing README (if any):
${readmeContext}

Return ONLY valid JSON (no prose, no fenced block) with this exact shape:
{
  "suggestedReadme": "# ${repoName}\\n\\n...",
  "suggestedLabels": [{"name": "bug", "color": "d73a4a", "description": "Something isn't working"}, ...],
  "suggestedGatesConfig": "version: 1\\ngates:\\n  ...",
  "firstCommitSuggestions": ["Add a .gitignore for ${language}", ...]
}

Rules:
- suggestedReadme must include ## About, ## Installation, ## Usage, ## Contributing sections. Use placeholder content where specifics are unknown.
- suggestedLabels: 6-8 labels appropriate for this type of project. Include bug, feature, docs, security, breaking-change and 1-3 language-specific ones.
- suggestedGatesConfig: a real gates.yml starter for ${language}${framework ? ` / ${framework}` : ""} with lint + test gates.
- firstCommitSuggestions: 3-5 practical next steps for this language/framework.`;

    const anthropic = getAnthropic();
    const message = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = extractText(message);
    const parsed = parseJsonResponse<{
      suggestedReadme?: string;
      suggestedLabels?: Array<{ name: string; color: string; description: string }>;
      suggestedGatesConfig?: string;
      firstCommitSuggestions?: string[];
    }>(text);

    if (parsed) {
      return {
        detectedLanguage: language,
        detectedFramework: framework,
        suggestedReadme: parsed.suggestedReadme ?? buildFallbackReadme(repoName, language, framework),
        suggestedLabels: parsed.suggestedLabels ?? defaultLabels,
        suggestedGatesConfig: parsed.suggestedGatesConfig ?? defaultGatesConfig,
        firstCommitSuggestions: parsed.firstCommitSuggestions ?? defaultSuggestions,
      };
    }
  } catch (err) {
    console.warn("[repo-onboarding] AI generation failed:", err instanceof Error ? err.message : err);
  }

  // AI failed — fall back to defaults
  return {
    detectedLanguage: language,
    detectedFramework: framework,
    suggestedReadme: existingReadme ?? buildFallbackReadme(repoName, language, framework),
    suggestedLabels: defaultLabels,
    suggestedGatesConfig: defaultGatesConfig,
    firstCommitSuggestions: defaultSuggestions,
  };
}

function buildFallbackReadme(repoName: string, language: string, framework?: string): string {
  const stack = framework ? `${language} / ${framework}` : language;
  return `# ${repoName}

> A ${stack} project.

## About

TODO: Describe what this project does and why it exists.

## Installation

\`\`\`bash
# TODO: Add installation steps
\`\`\`

## Usage

\`\`\`bash
# TODO: Add usage examples
\`\`\`

## Contributing

1. Fork the repository
2. Create a feature branch (\`git checkout -b feat/my-feature\`)
3. Commit your changes
4. Push and open a pull request

## License

TODO: Add license
`;
}

// ---------------------------------------------------------------------------
// Idempotent store / retrieve
// ---------------------------------------------------------------------------

/**
 * ensureRepoOnboarding — called fire-and-forget on first push.
 * Generates onboarding data and stores it if not already present.
 * Never throws.
 */
export async function ensureRepoOnboarding(
  repoId: string,
  ownerName: string,
  repoName: string
): Promise<void> {
  try {
    // Check if already generated
    const [existing] = await db
      .select({ repositoryId: repoOnboardingData.repositoryId })
      .from(repoOnboardingData)
      .where(eq(repoOnboardingData.repositoryId, repoId))
      .limit(1);
    if (existing) return; // already generated

    const onboarding = await generateRepoOnboarding(repoId, ownerName, repoName);

    await db
      .insert(repoOnboardingData)
      .values({
        repositoryId: repoId,
        detectedLanguage: onboarding.detectedLanguage,
        detectedFramework: onboarding.detectedFramework ?? null,
        suggestedReadme: onboarding.suggestedReadme,
        suggestedLabels: onboarding.suggestedLabels,
        suggestedGatesConfig: onboarding.suggestedGatesConfig,
        firstCommitSuggestions: onboarding.firstCommitSuggestions,
      })
      .onConflictDoNothing();

    console.log(
      `[repo-onboarding] generated for ${ownerName}/${repoName}: ${onboarding.detectedLanguage}${onboarding.detectedFramework ? ` / ${onboarding.detectedFramework}` : ""}`
    );
  } catch (err) {
    console.warn(
      `[repo-onboarding] ensureRepoOnboarding failed for ${ownerName}/${repoName}:`,
      err instanceof Error ? err.message : err
    );
  }
}
