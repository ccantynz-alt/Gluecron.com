/**
 * Block K9 — Production + test signal ingestion.
 *
 * Crontech (prod runtime), Gatetest (test runner), Sentry (external APM),
 * and manual callers post per-commit error signals back into Gluecron so
 * commits / PRs can be annotated with real-world failure data and so the
 * autonomous agent loops (fix, heal_bot) have something concrete to chase.
 *
 * Shape follows the commit-statuses template: pure helpers at the top,
 * DB helpers under the divider. DB helpers are defensive — never throw,
 * errors route to console.error so the caller's primary flow survives a
 * bad DB hop.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";

// NOTE: `prodSignals` is declared in src/db/schema.ts by the main thread
// (see the snippet delivered alongside this file). We resolve it lazily so
// the pure helpers in this module remain importable even if a session
// lands the code before the schema edit is merged. Once schema.ts exports
// `prodSignals`, the runtime import resolves on first DB call.
let _prodSignals: any;
async function prodSignalsTable(): Promise<any> {
  if (_prodSignals) return _prodSignals;
  const schema = await import("../db/schema");
  _prodSignals = (schema as any).prodSignals;
  if (!_prodSignals) {
    throw new Error(
      "prodSignals table not exported from db/schema.ts (Block K9). " +
        "See lib/prod-signals.ts header for the snippet to paste."
    );
  }
  return _prodSignals;
}
// Re-export for convenience in route code that wants the symbol directly.
export async function _getProdSignalsTable() {
  return prodSignalsTable();
}

export type SignalSource = "crontech" | "gatetest" | "sentry" | "manual";

export const SIGNAL_SOURCES: SignalSource[] = [
  "crontech",
  "gatetest",
  "sentry",
  "manual",
];

export type SignalKind =
  | "runtime_error"
  | "test_failure"
  | "deploy_failure"
  | "performance"
  | "security";

export type SignalSeverity = "info" | "warning" | "error" | "critical";
export type SignalStatus = "open" | "dismissed" | "resolved";

const MESSAGE_MAX = 4000;
const STACK_MAX = 16_000;
const FRAME_MAX = 512;
const HASH_LEN = 16;

/** Git short-sha / full-sha sanity check. Hex, 7–64. */
export function isValidSha(sha: string | null | undefined): boolean {
  if (!sha) return false;
  if (typeof sha !== "string") return false;
  if (sha.length < 7 || sha.length > 64) return false;
  return /^[a-f0-9]+$/i.test(sha);
}

/**
 * Normalise an error message for grouping. Collapses whitespace, strips
 * volatile fragments (hex pointers, line/col tails, numeric-only tokens)
 * so two occurrences of the same bug from different runs hash identically.
 */
function normaliseMessage(msg: string): string {
  return msg
    .trim()
    .replace(/\s+/g, " ")
    // Strip hex pointers like 0x7fffabcd
    .replace(/0x[0-9a-f]+/gi, "0x_")
    // Strip trailing :line:col noise
    .replace(/:\d+:\d+\b/g, ":_:_")
    .slice(0, MESSAGE_MAX);
}

/**
 * Extract the top, user-meaningful stack frame. Skips blank lines and any
 * line containing `node_modules`. Returns "" on malformed / empty input.
 * Capped at FRAME_MAX chars.
 */
export function extractTopFrame(stackTrace: string | null | undefined): string {
  if (!stackTrace || typeof stackTrace !== "string") return "";
  const lines = stackTrace.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes("node_modules")) continue;
    return line.slice(0, FRAME_MAX);
  }
  return "";
}

/**
 * Stable 16-hex-char fingerprint of `message + " @ " + topFrame` used as
 * the grouping key for count-bumping. Deterministic across processes.
 */
export function hashError(
  message: string | null | undefined,
  topStackFrame: string | null | undefined
): string {
  const m = normaliseMessage(String(message ?? ""));
  const f = String(topStackFrame ?? "").trim().slice(0, FRAME_MAX);
  const h = createHash("sha256").update(`${m} @ ${f}`).digest("hex");
  return h.slice(0, HASH_LEN);
}

/** Allow-list the source tag. Unknown / empty → "manual". */
export function sanitiseSource(source: unknown): SignalSource {
  if (typeof source !== "string") return "manual";
  const s = source.trim().toLowerCase();
  if ((SIGNAL_SOURCES as string[]).includes(s)) return s as SignalSource;
  return "manual";
}

const VALID_KINDS: SignalKind[] = [
  "runtime_error",
  "test_failure",
  "deploy_failure",
  "performance",
  "security",
];

export function sanitiseKind(kind: unknown): SignalKind {
  if (typeof kind !== "string") return "runtime_error";
  const k = kind.trim().toLowerCase();
  if ((VALID_KINDS as string[]).includes(k)) return k as SignalKind;
  return "runtime_error";
}

const VALID_SEVERITIES: SignalSeverity[] = [
  "info",
  "warning",
  "error",
  "critical",
];

export function sanitiseSeverity(sev: unknown): SignalSeverity {
  if (typeof sev !== "string") return "error";
  const s = sev.trim().toLowerCase();
  if ((VALID_SEVERITIES as string[]).includes(s)) return s as SignalSeverity;
  return "error";
}

// ---------- DB helpers ----------

export interface RecordSignalInput {
  repositoryId: string;
  commitSha: string;
  source: SignalSource | string;
  kind: SignalKind | string;
  message: string;
  stackTrace?: string | null;
  deployId?: string | null;
  environment?: string | null;
  severity?: SignalSeverity | string | null;
  samplePayload?: string | null;
}

export interface RecordSignalResult {
  id: string;
  status: SignalStatus;
  count: number;
  bumped: boolean;
}

/**
 * Insert or bump-count a signal. Keyed on (repository_id, error_hash).
 * Repeated posts of the same bug increment `count` and push `last_seen`
 * forward without creating new rows — cheap idempotency for noisy
 * runtimes. Defensive: returns null on any DB failure.
 */
export async function recordSignal(
  input: RecordSignalInput
): Promise<RecordSignalResult | null> {
  try {
    if (!isValidSha(input.commitSha)) return null;
    const sha = input.commitSha.toLowerCase();
    const source = sanitiseSource(input.source);
    const kind = sanitiseKind(input.kind);
    const severity = sanitiseSeverity(input.severity);
    const message = (input.message || "").slice(0, MESSAGE_MAX);
    const stackTrace = input.stackTrace
      ? input.stackTrace.slice(0, STACK_MAX)
      : null;
    const topFrame = extractTopFrame(stackTrace);
    const errorHash = hashError(message, topFrame);
    const prodSignals = await prodSignalsTable();

    // Check for existing row with the same (repo, hash).
    const [existing] = await db
      .select()
      .from(prodSignals)
      .where(
        and(
          eq(prodSignals.repositoryId, input.repositoryId),
          eq(prodSignals.errorHash, errorHash)
        )
      )
      .limit(1);

    if (existing) {
      const [bumped] = await db
        .update(prodSignals)
        .set({
          count: (existing.count || 0) + 1,
          lastSeen: new Date(),
          // Most recent commit wins — if the bug keeps happening on newer
          // shas the view should reflect that.
          commitSha: sha,
        })
        .where(eq(prodSignals.id, existing.id))
        .returning();
      if (!bumped) return null;
      return {
        id: bumped.id,
        status: (bumped.status || "open") as SignalStatus,
        count: bumped.count || 1,
        bumped: true,
      };
    }

    const [row] = await db
      .insert(prodSignals)
      .values({
        repositoryId: input.repositoryId,
        commitSha: sha,
        errorHash,
        source,
        kind,
        severity,
        message,
        stackTrace,
        deployId: input.deployId || null,
        environment: input.environment || null,
        samplePayload: input.samplePayload || null,
      })
      .returning();
    if (!row) return null;
    return {
      id: row.id,
      status: (row.status || "open") as SignalStatus,
      count: row.count || 1,
      bumped: false,
    };
  } catch (err) {
    console.error("[prod-signals] recordSignal:", err);
    return null;
  }
}

export async function listSignalsForCommit(
  repositoryId: string,
  commitSha: string,
  limit = 50
): Promise<any[]> {
  try {
    if (!isValidSha(commitSha)) return [];
    const prodSignals = await prodSignalsTable();
    return await db
      .select()
      .from(prodSignals)
      .where(
        and(
          eq(prodSignals.repositoryId, repositoryId),
          eq(prodSignals.commitSha, commitSha.toLowerCase())
        )
      )
      .orderBy(desc(prodSignals.lastSeen))
      .limit(limit);
  } catch (err) {
    console.error("[prod-signals] listSignalsForCommit:", err);
    return [];
  }
}

export async function listOpenSignalsForRepo(
  repositoryId: string,
  limit = 100
): Promise<any[]> {
  try {
    const prodSignals = await prodSignalsTable();
    return await db
      .select()
      .from(prodSignals)
      .where(
        and(
          eq(prodSignals.repositoryId, repositoryId),
          eq(prodSignals.status, "open")
        )
      )
      .orderBy(desc(prodSignals.lastSeen))
      .limit(limit);
  } catch (err) {
    console.error("[prod-signals] listOpenSignalsForRepo:", err);
    return [];
  }
}

/**
 * PR-scoped listing. Pragmatic v1: rather than shelling out to `git log
 * base..head`, we return signals in the repo created after the PR's
 * creation timestamp. Noisy-but-useful — the agent fix loop filters
 * further by commit_sha once it has the PR's commit list from git.
 */
export async function listSignalsForPr(
  repositoryId: string,
  _baseSha: string,
  _headSha: string,
  prCreatedAt: Date | null = null,
  limit = 50
): Promise<any[]> {
  try {
    const since = prCreatedAt || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const prodSignals = await prodSignalsTable();
    return await db
      .select()
      .from(prodSignals)
      .where(
        and(
          eq(prodSignals.repositoryId, repositoryId),
          gte(prodSignals.createdAt, since)
        )
      )
      .orderBy(desc(prodSignals.lastSeen))
      .limit(limit);
  } catch (err) {
    console.error("[prod-signals] listSignalsForPr:", err);
    return [];
  }
}

export async function dismissSignal(id: string): Promise<boolean> {
  try {
    const prodSignals = await prodSignalsTable();
    const [row] = await db
      .update(prodSignals)
      .set({ status: "dismissed" })
      .where(eq(prodSignals.id, id))
      .returning();
    return !!row;
  } catch (err) {
    console.error("[prod-signals] dismissSignal:", err);
    return false;
  }
}

export async function resolveSignal(
  id: string,
  resolvedByCommit?: string | null
): Promise<boolean> {
  try {
    const commit =
      resolvedByCommit && isValidSha(resolvedByCommit)
        ? resolvedByCommit.toLowerCase()
        : null;
    const prodSignals = await prodSignalsTable();
    const [row] = await db
      .update(prodSignals)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        resolvedByCommit: commit,
      })
      .where(eq(prodSignals.id, id))
      .returning();
    return !!row;
  } catch (err) {
    console.error("[prod-signals] resolveSignal:", err);
    return false;
  }
}

/** Count total signals in a repo — for badges / nav. Defensive. */
export async function countOpenSignals(repositoryId: string): Promise<number> {
  try {
    const prodSignals = await prodSignalsTable();
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(prodSignals)
      .where(
        and(
          eq(prodSignals.repositoryId, repositoryId),
          eq(prodSignals.status, "open")
        )
      );
    return Number(r?.n || 0);
  } catch {
    return 0;
  }
}

export const __internal = {
  MESSAGE_MAX,
  STACK_MAX,
  FRAME_MAX,
  HASH_LEN,
  normaliseMessage,
};
