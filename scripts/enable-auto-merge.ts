/**
 * Block N1 — Enable auto-merge on a single repo + branch pattern.
 *
 * Operator-driven, single-shot bootstrap script. After PR #62 lands and
 * the K3 autopilot sweep is live, the operator flips one repo into
 * "auto-merge mode" with:
 *
 *     bun run scripts/enable-auto-merge.ts ccantynz/Gluecron.com
 *     bun run scripts/enable-auto-merge.ts ccantynz/Gluecron.com release/*
 *
 * Behaviour (idempotent):
 *   1. Resolve repo by `owner/name`. Fail loudly if not found.
 *   2. If a `branch_protection` row already exists for (repo, pattern):
 *      flip `enableAutoMerge=true` (only that field — everything else
 *      stays as the owner configured it).
 *   3. If no row exists: INSERT a new row with the safety defaults below,
 *      with `enableAutoMerge=true`.
 *   4. Print a before / after diff so the operator sees exactly what
 *      changed.
 *   5. Write an `auto_merge.enabled_on_main` audit row so we can trace
 *      who flipped the switch.
 *
 * Safety defaults on a fresh insert:
 *   - pattern             = the supplied branch (default `main`)
 *   - requireGreenGates   = true   (no flaky tests slipping through)
 *   - requireAiApproval   = true   (Claude must approve — that's the point)
 *   - requireHumanReview  = false  (otherwise auto-merge can't fire)
 *   - requiredApprovals   = 0
 *   - enableAutoMerge     = true
 *   - dismissStaleReviews = false  (we don't want stale-review churn)
 *   - requirePullRequest  = true
 *   - allowForcePush      = false
 *   - allowDeletion       = false
 *
 * Revert: re-run with `--off`, or hand-toggle the column.
 *
 * Reads DATABASE_URL from env. The pure orchestrator `runEnableAutoMerge`
 * is exported and takes a DB-shaped dependency so tests can drive every
 * branch without touching Neon.
 */

import { and, eq } from "drizzle-orm";
import {
  branchProtection,
  repositories,
  users,
  auditLog,
} from "../src/db/schema";
import type { BranchProtection } from "../src/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnableAutoMergeArgs {
  ownerSlash: string; // "owner/name"
  pattern: string; // e.g. "main" or "release/*"
  off?: boolean; // when true, set enableAutoMerge=false instead
  actorUserId?: string | null; // optional audit attribution
}

export interface EnableAutoMergeResult {
  action: "inserted" | "updated" | "noop";
  before: BranchProtection | null;
  after: BranchProtection;
  auditWritten: boolean;
}

/**
 * Minimal DB surface this script needs. Mirrors the Drizzle methods used
 * directly so tests can supply a fake without standing up a real Drizzle
 * instance.
 */
export interface DbLike {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
}

// ---------------------------------------------------------------------------
// Core orchestrator
// ---------------------------------------------------------------------------

const SAFETY_DEFAULTS = {
  requirePullRequest: true,
  requireGreenGates: true,
  requireAiApproval: true,
  requireHumanReview: false,
  requiredApprovals: 0,
  allowForcePush: false,
  allowDeletion: false,
  dismissStaleReviews: false,
} as const;

/**
 * Resolve a repo row by `owner/name`. Returns null when either the owner
 * or the repo is missing — the caller turns that into a clean exit code.
 */
export async function resolveRepo(
  db: DbLike,
  ownerSlash: string
): Promise<{ id: string; ownerId: string; name: string; defaultBranch: string } | null> {
  const slashIdx = ownerSlash.indexOf("/");
  if (slashIdx <= 0 || slashIdx === ownerSlash.length - 1) return null;
  const ownerName = ownerSlash.slice(0, slashIdx);
  const repoName = ownerSlash.slice(slashIdx + 1);

  const ownerRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  const owner = (ownerRows as Array<{ id: string }>)[0];
  if (!owner) return null;

  const repoRows = await db
    .select({
      id: repositories.id,
      ownerId: repositories.ownerId,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  const repo = (repoRows as Array<{
    id: string;
    ownerId: string;
    name: string;
    defaultBranch: string;
  }>)[0];
  return repo ?? null;
}

/**
 * Pure orchestrator. All DB access goes through `db` so tests can inject
 * a fake. Returns the before/after rows so the CLI can render a diff and
 * the test suite can assert on the transition.
 */
export async function runEnableAutoMerge(
  db: DbLike,
  args: EnableAutoMergeArgs,
  audit: (opts: {
    userId?: string | null;
    repositoryId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>
): Promise<EnableAutoMergeResult> {
  const repo = await resolveRepo(db, args.ownerSlash);
  if (!repo) {
    throw new Error(
      `Repository not found: ${args.ownerSlash}. Pass owner/name (e.g. ccantynz/Gluecron.com).`
    );
  }

  const desiredEnableAutoMerge = !args.off;

  // Look up existing rule for this (repo, pattern).
  const existingRows = await db
    .select()
    .from(branchProtection)
    .where(
      and(
        eq(branchProtection.repositoryId, repo.id),
        eq(branchProtection.pattern, args.pattern)
      )
    )
    .limit(1);
  const existing = (existingRows as BranchProtection[])[0] ?? null;

  if (existing) {
    // Idempotent: when the row is already in the desired state, skip
    // both the UPDATE and the audit write. Operators running the script
    // twice in a row should see "no-op", not a noisy audit trail.
    if (existing.enableAutoMerge === desiredEnableAutoMerge) {
      return {
        action: "noop",
        before: existing,
        after: existing,
        auditWritten: false,
      };
    }

    // Snapshot BEFORE the mutation — `existing` may be the same row
    // reference the DB layer hands to `update().set()`, so we copy here
    // to keep the returned `before` field stable for callers.
    const beforeSnapshot: BranchProtection = { ...existing };

    const now = new Date();
    await db
      .update(branchProtection)
      .set({ enableAutoMerge: desiredEnableAutoMerge, updatedAt: now })
      .where(eq(branchProtection.id, existing.id));

    const after: BranchProtection = {
      ...beforeSnapshot,
      enableAutoMerge: desiredEnableAutoMerge,
      updatedAt: now,
    };

    await audit({
      userId: args.actorUserId ?? null,
      repositoryId: repo.id,
      action: desiredEnableAutoMerge
        ? "auto_merge.enabled_on_main"
        : "auto_merge.disabled_on_main",
      targetType: "branch_protection",
      targetId: existing.id,
      metadata: {
        pattern: args.pattern,
        before: { enableAutoMerge: beforeSnapshot.enableAutoMerge },
        after: { enableAutoMerge: desiredEnableAutoMerge },
      },
    });

    return {
      action: "updated",
      before: beforeSnapshot,
      after,
      auditWritten: true,
    };
  }

  // No existing row — INSERT a new one with the documented safety
  // defaults plus the requested auto-merge bit.
  const inserted = await db
    .insert(branchProtection)
    .values({
      repositoryId: repo.id,
      pattern: args.pattern,
      ...SAFETY_DEFAULTS,
      enableAutoMerge: desiredEnableAutoMerge,
    })
    .returning();
  const after = (inserted as BranchProtection[])[0];
  if (!after) {
    throw new Error(
      "INSERT into branch_protection returned no row — refusing to record audit."
    );
  }

  await audit({
    userId: args.actorUserId ?? null,
    repositoryId: repo.id,
    action: desiredEnableAutoMerge
      ? "auto_merge.enabled_on_main"
      : "auto_merge.disabled_on_main",
    targetType: "branch_protection",
    targetId: after.id,
    metadata: {
      pattern: args.pattern,
      created: true,
      defaults: { ...SAFETY_DEFAULTS, enableAutoMerge: desiredEnableAutoMerge },
    },
  });

  return {
    action: "inserted",
    before: null,
    after,
    auditWritten: true,
  };
}

// ---------------------------------------------------------------------------
// Diff renderer (pure, test-friendly)
// ---------------------------------------------------------------------------

const TRACKED_FIELDS: Array<keyof BranchProtection> = [
  "pattern",
  "requirePullRequest",
  "requireGreenGates",
  "requireAiApproval",
  "requireHumanReview",
  "requiredApprovals",
  "allowForcePush",
  "allowDeletion",
  "dismissStaleReviews",
  "enableAutoMerge",
];

export function renderDiff(
  before: BranchProtection | null,
  after: BranchProtection
): string {
  const lines: string[] = [];
  if (!before) {
    lines.push("(no previous branch_protection row)");
    lines.push("AFTER:");
    for (const f of TRACKED_FIELDS) {
      lines.push(`  + ${f} = ${JSON.stringify((after as any)[f])}`);
    }
    return lines.join("\n");
  }
  lines.push("BEFORE -> AFTER (only changed fields shown):");
  let anyChanged = false;
  for (const f of TRACKED_FIELDS) {
    const b = (before as any)[f];
    const a = (after as any)[f];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      anyChanged = true;
      lines.push(`  ~ ${f}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    }
  }
  if (!anyChanged) lines.push("  (no field changes)");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(
    "Usage: bun run scripts/enable-auto-merge.ts <owner/name> [pattern] [--off]"
  );
  console.error(
    "       pattern defaults to 'main'. Pass --off to flip the switch back to disabled."
  );
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();

  let off = false;
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--off") {
      off = true;
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      usage();
    } else {
      positional.push(a);
    }
  }
  const [ownerSlash, patternArg] = positional;
  if (!ownerSlash) usage();
  const pattern = patternArg ?? "main";

  // Lazy import the real DB only at CLI-entry time so unit tests can
  // import this module without booting a Neon connection.
  const { db } = await import("../src/db");
  const { audit } = await import("../src/lib/notify");

  const result = await runEnableAutoMerge(
    db as unknown as DbLike,
    { ownerSlash, pattern, off },
    audit
  );

  console.log(`gluecron enable-auto-merge — ${ownerSlash} @ ${pattern}`);
  console.log(`action: ${result.action}`);
  console.log(renderDiff(result.before, result.after));
  if (result.auditWritten) {
    console.log(
      `audit: wrote ${off ? "auto_merge.disabled_on_main" : "auto_merge.enabled_on_main"}`
    );
  } else {
    console.log("audit: skipped (no-op, row already in desired state)");
  }
  if (result.action === "inserted") {
    console.log(
      "note: created a fresh branch_protection row with the safety defaults."
    );
  }
}

// Only run when invoked as a script (not when imported by tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

// Silence unused-import warning when this module is only used as a CLI.
void auditLog;
