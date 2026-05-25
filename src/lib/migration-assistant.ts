/**
 * Major-version migration assistant.
 *
 * When a dependency is several majors behind, Dependabot-style patch bumps
 * aren't enough — the upgrade typically requires touching call-sites + test
 * fixtures. This module wraps Claude to:
 *
 *   1. Locate every file that imports / uses the dependency (via grep
 *      over the recursive tree).
 *   2. Pull each affected blob at `baseSha`.
 *   3. Ask Claude for `{ explanation, patches, test_updates }`.
 *   4. Apply the patches + test updates onto a fresh branch via
 *      `createOrUpdateFileOnBranch` — the same path `ai-patch-generator.ts`
 *      uses.
 *   5. Open a PR titled `[migration] {dep} {from} -> {to}` carrying the
 *      `ai:major-migration` label tag in its body.
 *
 * The Claude client is injectable so unit tests pin the response without
 * a network call. Production callers leave `client` undefined and we
 * lazily wire `ai-client.getAnthropic()`.
 *
 * SAFETY:
 *   - Short-circuits to `null` if ANTHROPIC_API_KEY is unset AND no client
 *     was injected. Safe to fire from background tasks.
 *   - Wrapped in try/catch end-to-end — never throws.
 *   - Empty patches array means we do NOT open an empty PR.
 *   - Every successful proposal is logged in `audit_log` under
 *     `ai.migration.proposed` with `{dep, fromVersion, toVersion}`. The
 *     watcher uses this same row to enforce the 7-day per-repo throttle.
 */

import { createHash } from "crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import {
  auditLog,
  labels,
  prComments,
  pullRequests,
  repositories,
  repoSettings,
  users,
} from "../db/schema";
import {
  createOrUpdateFileOnBranch,
  getBlob,
  getDefaultBranch,
  getTreeRecursive,
  refExists,
  updateRef,
  resolveRef,
} from "../git/repository";
import { config } from "./config";
import { audit } from "./notify";
import {
  getAnthropic,
  MODEL_SONNET,
  extractText,
  parseJsonResponse,
} from "./ai-client";
import { parseManifest } from "./dep-updater";

/** Body marker so other tooling can spot AI-authored migration PRs. */
export const MIGRATION_MARKER = "<!-- gluecron-ai-migration:proposed -->";

/** Label surfaced (and ensured on the repo) for these PRs. */
export const MIGRATION_LABEL = "ai:major-migration";

/** Audit action used by both the propose call AND the dedupe check. */
export const MIGRATION_AUDIT_ACTION = "ai.migration.proposed";

/** Default throttle window: 1 PR per repo per 7 days. */
export const MIGRATION_THROTTLE_HOURS = 24 * 7;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProposeMigrationOptions {
  repositoryId: string;
  /** Package / crate / module name as it appears in the manifest. */
  dependency: string;
  /** e.g. `^3.2.1` or `3.2.1`. Free-form — Claude only needs the text. */
  fromVersion: string;
  /** e.g. `4.0.0`. */
  toVersion: string;
  /** Commit sha the migration is anchored against. Branch is forked from it. */
  baseSha: string;
  /**
   * Optional changelog snippet to pass into the prompt. When the watcher
   * fetches one from npm we forward it here; manual UI invocations leave
   * it null.
   */
  changelog?: string | null;
  /**
   * Optional Anthropic client override — primarily for tests.
   */
  client?: Pick<Anthropic, "messages">;
  /**
   * Deterministic branch name for tests. Production code derives it from
   * `{dependency}-{toVersion}-{timestamp}`.
   */
  branchOverride?: string;
  /**
   * Skip the dedupe check. The watcher always leaves this false; manual
   * `/migrations/propose` form invocations can flip it on so a user can
   * override the throttle.
   */
  skipThrottle?: boolean;
}

export interface ProposeMigrationResult {
  branch: string;
  prNumber: number;
}

/** One file change Claude returned. */
interface ClaudePatch {
  path: string;
  new_content: string;
}

interface ClaudeMigrationResponse {
  explanation?: string;
  patches?: ClaudePatch[];
  test_updates?: ClaudePatch[];
}

// ---------------------------------------------------------------------------
// Manifest detection
// ---------------------------------------------------------------------------

/**
 * The supported package manifests we look for, in priority order. The
 * caller doesn't need to know which one a repo uses — we probe each at
 * the default tree root.
 */
export const SUPPORTED_MANIFESTS = [
  "package.json", // npm / bun / yarn
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

export type ManifestPath = (typeof SUPPORTED_MANIFESTS)[number];

/**
 * Find the first manifest that exists in `ref`'s tree root. Returns
 * `{ path, content }` or null. Pure-ish (one git call) — exposed for
 * tests of the watcher.
 */
export async function findManifest(
  owner: string,
  name: string,
  ref: string
): Promise<{ path: ManifestPath; content: string } | null> {
  for (const path of SUPPORTED_MANIFESTS) {
    try {
      const blob = await getBlob(owner, name, ref, path);
      if (blob && !blob.isBinary) {
        return { path, content: blob.content };
      }
    } catch {
      // Treat any error as "not present" and keep probing.
    }
  }
  return null;
}

/**
 * Substrings that strongly suggest a file references a given dependency.
 * We accept any of these matching. Exposed for tests.
 */
export function dependencyHints(dependency: string): string[] {
  const safe = dependency.trim();
  if (!safe) return [];
  const hints = new Set<string>();
  hints.add(`"${safe}"`); // string-literal import / require
  hints.add(`'${safe}'`);
  hints.add(` from "${safe}"`);
  hints.add(` from '${safe}'`);
  hints.add(`require("${safe}")`);
  hints.add(`require('${safe}')`);
  // Python `import X` / `from X import ...`. The name in pyproject often
  // differs from the importable module, but for a best-effort scan we
  // accept the same string.
  hints.add(`import ${safe}`);
  hints.add(`from ${safe} `);
  // Rust `use crate_name::` / `crate_name::`. Hyphens become underscores.
  hints.add(`${safe.replace(/-/g, "_")}::`);
  // Go imports — quoted path.
  hints.add(`"${safe}"`);
  return Array.from(hints);
}

/**
 * Walk the repo's tree at `baseSha` and return file paths whose contents
 * mention the dependency. Caps at `opts.maxFiles` so a runaway dep that
 * touches the whole repo can't blow the prompt budget.
 *
 * NB: we currently read each blob to scan it. That's O(repo size) but
 * fine for the small repos this lives behind. If we ever need it on
 * 100k-file repos we can add a `git grep -l` shortcut.
 */
export async function findUsages(
  owner: string,
  name: string,
  ref: string,
  dependency: string,
  opts: { maxFiles?: number; maxBytesPerFile?: number } = {}
): Promise<string[]> {
  const maxFiles = opts.maxFiles ?? 12;
  const maxBytes = opts.maxBytesPerFile ?? 200_000;
  const tree = await getTreeRecursive(owner, name, ref);
  if (!tree) return [];
  const hints = dependencyHints(dependency);
  if (hints.length === 0) return [];

  const matched: string[] = [];
  for (const entry of tree.tree) {
    if (entry.type !== "blob") continue;
    if (entry.size != null && entry.size > maxBytes) continue;
    // Manifest + lockfile mentions don't tell us anything we don't already
    // know — skip them to focus on call-sites + tests.
    if ((SUPPORTED_MANIFESTS as readonly string[]).includes(entry.path)) {
      continue;
    }
    if (/(^|\/)(package-lock\.json|bun\.lockb|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/.test(
      entry.path
    )) {
      continue;
    }
    let blob;
    try {
      blob = await getBlob(owner, name, ref, entry.path);
    } catch {
      continue;
    }
    if (!blob || blob.isBinary) continue;
    if (hints.some((h) => blob!.content.includes(h))) {
      matched.push(entry.path);
      if (matched.length >= maxFiles) break;
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Prompt + helpers
// ---------------------------------------------------------------------------

/**
 * Build the Claude prompt. Pure so unit tests can pin the shape.
 */
export function buildMigrationPrompt(args: {
  dependency: string;
  fromVersion: string;
  toVersion: string;
  manifestPath: string | null;
  changelog?: string | null;
  files: Array<{ path: string; content: string }>;
}): string {
  const { dependency, fromVersion, toVersion, manifestPath, changelog, files } =
    args;
  const fileBlocks = files
    .map(
      (f) =>
        `### \`${f.path}\`\n\`\`\`\n${f.content}\n\`\`\``
    )
    .join("\n\n");
  const changelogBlock = changelog?.trim()
    ? `\n\n**Changelog:**\n\`\`\`\n${changelog.trim()}\n\`\`\``
    : "\n\n**Changelog:** _(none provided)_";
  return [
    `Upgrade \`${dependency}\` from \`${fromVersion}\` to \`${toVersion}\`.`,
    `Manifest: \`${manifestPath ?? "(unknown)"}\``,
    "",
    "Below are the files in the repo that reference this dependency. Update",
    "each one for the new major version. If a test file needs its fixtures",
    "or assertions adjusted to match the new API, include it under",
    `"test_updates" instead of "patches" so reviewers can see the split.`,
    changelogBlock,
    "",
    "Files:",
    "",
    fileBlocks || "_(none — repo had no usages)_",
    "",
    "Respond ONLY with JSON of this exact shape:",
    "{",
    '  "explanation": "Short paragraph describing the breaking changes and how you addressed them.",',
    '  "patches":     [{ "path": "src/foo.ts", "new_content": "FULL replacement file" }],',
    '  "test_updates":[{ "path": "test/foo.test.ts", "new_content": "FULL replacement file" }]',
    "}",
    "",
    "Rules:",
    `- Bump the dependency's version in the manifest itself if shown above.`,
    "- new_content MUST be the entire file (not a diff).",
    "- Only touch files you've been shown.",
    "- If you cannot perform the migration safely, return empty patches/test_updates.",
  ].join("\n");
}

/**
 * Branch name. Test override wins; otherwise we use a slug + timestamp.
 */
export function migrationBranchName(
  dependency: string,
  toVersion: string,
  override?: string
): string {
  if (override && override.trim()) return override.trim();
  const slug =
    `${dependency}-${toVersion}`
      .toLowerCase()
      .replace(/[^a-z0-9.+]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "migration";
  return `ai-migration/${slug}-${Date.now()}`;
}

/**
 * Render the PR body. Pure helper exported for tests.
 */
export function renderMigrationPrBody(args: {
  dependency: string;
  fromVersion: string;
  toVersion: string;
  explanation: string;
  patchPaths: string[];
  testPaths: string[];
  changelog?: string | null;
}): string {
  const {
    dependency,
    fromVersion,
    toVersion,
    explanation,
    patchPaths,
    testPaths,
    changelog,
  } = args;
  const fileList = (xs: string[]) =>
    xs.length ? xs.map((p) => `- \`${p}\``).join("\n") : "_(none)_";
  return [
    MIGRATION_MARKER,
    `## Major-version migration: \`${dependency}\` ${fromVersion} → ${toVersion}`,
    "",
    "### Summary",
    explanation || "_(no explanation provided)_",
    "",
    "### Source changes",
    fileList(patchPaths),
    "",
    "### Test changes",
    fileList(testPaths),
    "",
    changelog?.trim()
      ? `### Changelog excerpt\n\n\`\`\`\n${changelog.trim()}\n\`\`\``
      : "_(no changelog provided)_",
    "",
    "---",
    "",
    `Labels: \`${MIGRATION_LABEL}\``,
    "",
    "_Auto-generated by GlueCron AI. Review carefully — major upgrades often have edge cases the model can't see._",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function resolveOwnerName(
  repositoryId: string
): Promise<{ owner: string; name: string; ownerId: string; defaultBranch: string | null } | null> {
  try {
    const [row] = await db
      .select({
        ownerId: repositories.ownerId,
        ownerUsername: users.username,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!row) return null;
    return {
      owner: row.ownerUsername,
      name: row.name,
      ownerId: row.ownerId,
      defaultBranch: row.defaultBranch ?? null,
    };
  } catch (err) {
    console.error(
      "[ai-migration] resolveOwnerName failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function ensureMigrationLabel(repositoryId: string): Promise<void> {
  try {
    await db
      .insert(labels)
      .values({
        repositoryId,
        name: MIGRATION_LABEL,
        color: "#8c6dff",
        description:
          "Major-version dependency migration proposed by GlueCron AI",
      })
      .onConflictDoNothing?.();
  } catch (err) {
    console.warn(
      "[ai-migration] ensureMigrationLabel failed:",
      err instanceof Error ? err.message : err
    );
  }
}

async function seedBranchFromBase(
  owner: string,
  name: string,
  branch: string,
  baseSha: string
): Promise<boolean> {
  const fullRef = `refs/heads/${branch}`;
  if (await refExists(owner, name, fullRef)) return true;
  return updateRef(owner, name, fullRef, baseSha);
}

/**
 * Has this exact `{dep, toVersion}` migration been proposed for this repo
 * in the throttle window? Used by the watcher (skipThrottle:false). The
 * audit row's metadata JSON is the source of truth.
 */
export async function recentlyProposed(
  repositoryId: string,
  dependency: string,
  toVersion: string,
  windowHours: number = MIGRATION_THROTTLE_HOURS
): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const rows = await db
      .select({ metadata: auditLog.metadata, createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.repositoryId, repositoryId),
          eq(auditLog.action, MIGRATION_AUDIT_ACTION),
          gte(auditLog.createdAt, cutoff)
        )
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(50);
    for (const r of rows) {
      if (!r.metadata) continue;
      try {
        const md = JSON.parse(r.metadata) as {
          dependency?: string;
          toVersion?: string;
        };
        if (md.dependency === dependency && md.toVersion === toVersion) {
          return true;
        }
      } catch {
        // Skip rows with malformed JSON.
      }
    }
    return false;
  } catch (err) {
    // If we can't query, fall through and let the caller try.
    console.warn(
      "[ai-migration] recentlyProposed query failed:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Ask Claude for the migration. Returns parsed JSON or null on any
 * failure (network, parse error).
 */
async function askClaudeForMigration(
  client: Pick<Anthropic, "messages">,
  prompt: string
): Promise<ClaudeMigrationResponse | null> {
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });
    try {
      const { recordAiCost, extractUsage } = await import("./ai-cost-tracker");
      const usage = extractUsage(message);
      await recordAiCost({
        model: MODEL_SONNET,
        inputTokens: usage.input,
        outputTokens: usage.output,
        category: "refactor",
        sourceKind: "migration_assistant",
      });
    } catch {
      /* swallow — best-effort */
    }
    const text = extractText(message);
    return parseJsonResponse<ClaudeMigrationResponse>(text);
  } catch (err) {
    console.warn(
      "[ai-migration] Claude call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Propose a major-version migration. Returns the new branch + PR number,
 * or `null` if anything went wrong / nothing actionable came back.
 *
 * Failure modes that yield null (and are logged but never thrown):
 *   - ANTHROPIC_API_KEY missing AND no `client` injected
 *   - repository row can't be resolved
 *   - already proposed within the throttle window
 *   - no manifest detected
 *   - Claude returned zero patches AND zero test_updates
 *   - git or DB write failed
 */
export async function proposeMajorMigration(
  opts: ProposeMigrationOptions
): Promise<ProposeMigrationResult | null> {
  if (!opts.dependency?.trim() || !opts.toVersion?.trim()) return null;

  // Lazy-resolve client so tests can inject without an API key.
  let client: Pick<Anthropic, "messages">;
  if (opts.client) {
    client = opts.client;
  } else {
    if (!config.anthropicApiKey) return null;
    try {
      client = getAnthropic();
    } catch {
      return null;
    }
  }

  const repo = await resolveOwnerName(opts.repositoryId);
  if (!repo) return null;

  if (!opts.skipThrottle) {
    const dup = await recentlyProposed(
      opts.repositoryId,
      opts.dependency,
      opts.toVersion
    );
    if (dup) return null;
  }

  await ensureMigrationLabel(opts.repositoryId);

  // Locate manifest + usages.
  const manifest = await findManifest(repo.owner, repo.name, opts.baseSha);
  const usagePaths = await findUsages(
    repo.owner,
    repo.name,
    opts.baseSha,
    opts.dependency
  );

  // Build the context the model needs. Manifest is always included (so
  // the model can bump the version pin); usages are appended.
  const files: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  if (manifest) {
    files.push({ path: manifest.path, content: manifest.content });
    seen.add(manifest.path);
  }
  for (const p of usagePaths) {
    if (seen.has(p)) continue;
    try {
      const blob = await getBlob(repo.owner, repo.name, opts.baseSha, p);
      if (!blob || blob.isBinary) continue;
      files.push({ path: p, content: blob.content });
      seen.add(p);
    } catch {
      // skip
    }
  }

  if (files.length === 0) {
    // Nothing for the model to operate on.
    return null;
  }

  const prompt = buildMigrationPrompt({
    dependency: opts.dependency,
    fromVersion: opts.fromVersion,
    toVersion: opts.toVersion,
    manifestPath: manifest?.path ?? null,
    changelog: opts.changelog ?? null,
    files,
  });

  const claudeRes = await askClaudeForMigration(client, prompt);
  if (!claudeRes) return null;

  const patches = Array.isArray(claudeRes.patches) ? claudeRes.patches : [];
  const testUpdates = Array.isArray(claudeRes.test_updates)
    ? claudeRes.test_updates
    : [];
  if (patches.length === 0 && testUpdates.length === 0) return null;

  // Seed a fresh branch from baseSha.
  const branch = migrationBranchName(
    opts.dependency,
    opts.toVersion,
    opts.branchOverride
  );
  const seeded = await seedBranchFromBase(
    repo.owner,
    repo.name,
    branch,
    opts.baseSha
  );
  if (!seeded) {
    console.warn(
      `[ai-migration] could not seed branch ${branch} from ${opts.baseSha} for ${repo.owner}/${repo.name}`
    );
    return null;
  }

  const allChanges = [
    ...patches.map((p) => ({ ...p, kind: "patch" as const })),
    ...testUpdates.map((p) => ({ ...p, kind: "test" as const })),
  ];

  const writtenPatchPaths: string[] = [];
  const writtenTestPaths: string[] = [];
  let writeError: string | null = null;
  for (const change of allChanges) {
    if (
      !change ||
      typeof change.path !== "string" ||
      typeof change.new_content !== "string"
    ) {
      continue;
    }
    const res = await createOrUpdateFileOnBranch({
      owner: repo.owner,
      name: repo.name,
      branch,
      filePath: change.path,
      bytes: new TextEncoder().encode(change.new_content),
      message: `chore(migration): ${opts.dependency} ${opts.fromVersion} -> ${opts.toVersion} (${change.path})`,
      authorName: "GlueCron AI",
      authorEmail: "ai@gluecron.com",
    });
    if ("error" in res) {
      writeError = res.error;
      break;
    }
    if (change.kind === "patch") writtenPatchPaths.push(change.path);
    else writtenTestPaths.push(change.path);
  }

  if (writeError || writtenPatchPaths.length + writtenTestPaths.length === 0) {
    console.warn(
      `[ai-migration] write failed (${writeError ?? "no patches written"}) on ${repo.owner}/${repo.name}@${branch}`
    );
    return null;
  }

  // Default branch lookup (base for the PR).
  let baseBranch = repo.defaultBranch || "main";
  try {
    if (!repo.defaultBranch) {
      const probed = await getDefaultBranch(repo.owner, repo.name);
      if (probed) baseBranch = probed;
    }
  } catch {
    // keep default
  }

  const title = `[migration] ${opts.dependency} ${opts.fromVersion} → ${opts.toVersion}`;
  const body = renderMigrationPrBody({
    dependency: opts.dependency,
    fromVersion: opts.fromVersion,
    toVersion: opts.toVersion,
    explanation: claudeRes.explanation || "",
    patchPaths: writtenPatchPaths,
    testPaths: writtenTestPaths,
    changelog: opts.changelog ?? null,
  });

  let prNumber: number | null = null;
  try {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: opts.repositoryId,
        authorId: repo.ownerId,
        title,
        body,
        baseBranch,
        headBranch: branch,
        isDraft: false,
      })
      .returning({ number: pullRequests.number, id: pullRequests.id });
    if (pr) {
      prNumber = pr.number;
      // Drop a marker comment so the label can be associated without
      // a PR<->label join table — same pattern ai-patch-generator uses.
      try {
        await db.insert(prComments).values({
          pullRequestId: pr.id,
          authorId: repo.ownerId,
          isAiReview: true,
          body: `${MIGRATION_MARKER}\nApplied label: \`${MIGRATION_LABEL}\``,
        });
      } catch (err) {
        console.warn(
          "[ai-migration] failed to insert label-marker comment:",
          err instanceof Error ? err.message : err
        );
      }
    }
  } catch (err) {
    console.error(
      "[ai-migration] failed to insert pullRequests row:",
      err instanceof Error ? err.message : err
    );
    return null;
  }

  if (prNumber == null) return null;

  await audit({
    userId: null,
    action: MIGRATION_AUDIT_ACTION,
    repositoryId: opts.repositoryId,
    metadata: {
      dependency: opts.dependency,
      fromVersion: opts.fromVersion,
      toVersion: opts.toVersion,
      branch,
      prNumber,
      baseSha: opts.baseSha,
      patchCount: writtenPatchPaths.length,
      testCount: writtenTestPaths.length,
    },
  });

  return { branch, prNumber };
}

// ---------------------------------------------------------------------------
// Watcher — autopilot task entry point
// ---------------------------------------------------------------------------

export interface MigrationWatcherSummary {
  considered: number;
  proposed: number;
  skippedThrottle: number;
  skippedNotEnabled: number;
  errors: number;
}

export interface MigrationWatcherDeps {
  /** Override the npm-latest lookup (DI for tests). */
  fetchLatest?: (name: string) => Promise<string | null>;
  /** Override the propose call (DI for tests). */
  propose?: (
    opts: ProposeMigrationOptions
  ) => Promise<ProposeMigrationResult | null>;
  /**
   * Override the per-repo "is migration_watch on?" check. Default reads
   * the env flag (`MIGRATION_WATCHER_ENABLED`) + the repo's
   * `aiPrSummaryEnabled` flag as a proxy for "AI features are on for
   * this repo". When we add a dedicated column this default flips to
   * read it.
   */
  isEnabled?: (repositoryId: string) => Promise<boolean>;
  /** Hard cap on repos visited per tick. */
  maxReposPerTick?: number;
}

/**
 * Detect "is this version several majors behind?". Returns the parsed
 * `from`/`to` strings ready to feed `proposeMajorMigration`, or null when
 * either side can't be parsed or it isn't a major bump.
 *
 * Exported for direct unit testing.
 */
export function detectMajorBump(
  currentRange: string,
  latestVersion: string
): { from: string; to: string } | null {
  const cur = matchSemver(currentRange);
  const lat = matchSemver(latestVersion);
  if (!cur || !lat) return null;
  if (lat.major <= cur.major) return null;
  return { from: currentRange.trim(), to: latestVersion.trim() };
}

function matchSemver(s: string): { major: number; minor: number; patch: number } | null {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  };
}

/** Default registry-latest lookup with a 5s timeout. Never throws. */
async function defaultFetchLatest(pkg: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const safe = encodeURIComponent(pkg).replace(/%40/g, "@");
      const res = await fetch(`https://registry.npmjs.org/${safe}/latest`, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: unknown };
      return typeof data.version === "string" ? data.version : null;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

/**
 * Default "is migration_watch enabled?" check. Reads
 * `MIGRATION_WATCHER_ENABLED` env var (must be `1`/`true`) and falls
 * back to the repo's `aiPrSummaryEnabled` flag as a proxy for AI opt-in.
 * Returns true only when both signals agree.
 */
async function defaultIsEnabled(repositoryId: string): Promise<boolean> {
  const envFlag =
    process.env.MIGRATION_WATCHER_ENABLED === "1" ||
    process.env.MIGRATION_WATCHER_ENABLED === "true";
  if (!envFlag) return false;
  try {
    const [row] = await db
      .select({ on: repoSettings.aiPrSummaryEnabled })
      .from(repoSettings)
      .where(eq(repoSettings.repositoryId, repositoryId))
      .limit(1);
    if (!row) return true; // default-on when settings row is absent
    return Boolean(row.on);
  } catch {
    return false;
  }
}

/**
 * One iteration of the migration-watcher autopilot task.
 *
 * Per repo:
 *   1. Skip if disabled.
 *   2. Skip if a migration was already proposed in the last 7 days
 *      (single audit lookup, no per-dep cost yet).
 *   3. Pull `package.json` from the default branch (other manifests are
 *      a future expansion).
 *   4. For each declared dep, fetch the latest from npm (5s timeout,
 *      fail-soft).
 *   5. If at least one major behind AND not already proposed for this
 *      exact `{dep, latest}`, kick off `proposeMajorMigration` and stop
 *      after the first one (cap 1 per repo per tick).
 */
export async function runMigrationWatcherTaskOnce(
  deps: MigrationWatcherDeps = {}
): Promise<MigrationWatcherSummary> {
  const summary: MigrationWatcherSummary = {
    considered: 0,
    proposed: 0,
    skippedThrottle: 0,
    skippedNotEnabled: 0,
    errors: 0,
  };

  if (!config.anthropicApiKey && !deps.propose) {
    // No AI configured + no test injection -> nothing useful to do.
    return summary;
  }

  const fetchLatest = deps.fetchLatest ?? defaultFetchLatest;
  const propose = deps.propose ?? proposeMajorMigration;
  const isEnabled = deps.isEnabled ?? defaultIsEnabled;
  const maxRepos = deps.maxReposPerTick ?? 25;

  let repos: Array<{
    id: string;
    owner: string;
    name: string;
    defaultBranch: string | null;
  }> = [];
  try {
    repos = await db
      .select({
        id: repositories.id,
        owner: users.username,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .limit(maxRepos);
  } catch (err) {
    console.warn(
      "[ai-migration] watcher repo lookup failed:",
      err instanceof Error ? err.message : err
    );
    return summary;
  }

  for (const repo of repos) {
    summary.considered++;
    try {
      const enabled = await isEnabled(repo.id);
      if (!enabled) {
        summary.skippedNotEnabled++;
        continue;
      }

      // Coarse repo-level throttle: only one migration PR per repo per
      // window. Cheap-ish — one audit query per repo.
      const recentAny = await anyMigrationInWindow(repo.id);
      if (recentAny) {
        summary.skippedThrottle++;
        continue;
      }

      const branch = repo.defaultBranch || "main";
      const baseSha = await resolveRef(repo.owner, repo.name, branch);
      if (!baseSha) continue;
      const blob = await getBlob(repo.owner, repo.name, branch, "package.json");
      if (!blob || blob.isBinary) continue;

      const manifest = parseManifest(blob.content);
      const allDeps: Array<{ name: string; range: string }> = [
        ...Object.entries(manifest.dependencies || {}).map(([name, range]) => ({
          name,
          range,
        })),
        ...Object.entries(manifest.devDependencies || {}).map(
          ([name, range]) => ({ name, range })
        ),
      ];

      for (const dep of allDeps) {
        const latest = await fetchLatest(dep.name);
        if (!latest) continue;
        const bump = detectMajorBump(dep.range, latest);
        if (!bump) continue;
        // Per-{dep, version} dedup — guards against the watcher proposing
        // the same migration twice in a single 7d window (e.g. across
        // restarts).
        const dup = await recentlyProposed(repo.id, dep.name, bump.to);
        if (dup) {
          summary.skippedThrottle++;
          continue;
        }
        const result = await propose({
          repositoryId: repo.id,
          dependency: dep.name,
          fromVersion: bump.from,
          toVersion: bump.to,
          baseSha,
        });
        if (result) {
          summary.proposed++;
        }
        // One per repo per tick regardless of result.
        break;
      }
    } catch (err) {
      summary.errors++;
      console.warn(
        `[ai-migration] watcher repo ${repo.owner}/${repo.name} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return summary;
}

/**
 * Cheap "has anything been proposed for this repo in the throttle window?"
 * check used by the watcher's per-repo cap. Separate from
 * `recentlyProposed` because that one matches a specific {dep, version}.
 */
async function anyMigrationInWindow(
  repositoryId: string,
  windowHours: number = MIGRATION_THROTTLE_HOURS
): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.repositoryId, repositoryId),
          eq(auditLog.action, MIGRATION_AUDIT_ACTION),
          gte(auditLog.createdAt, cutoff)
        )
      );
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test-only re-exports
// ---------------------------------------------------------------------------

export const __test = {
  resolveOwnerName,
  ensureMigrationLabel,
  seedBranchFromBase,
  askClaudeForMigration,
  anyMigrationInWindow,
  defaultIsEnabled,
  defaultFetchLatest,
  matchSemver,
};
