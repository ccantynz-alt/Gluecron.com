/**
 * Inbound deploy-event receiver for Crontech (Signal Bus P1 — E3/E4).
 *
 * Wire contract reference: chat-defined spec for Crontech → Gluecron deploy
 * events. Gluecron's OWN copy per HTTP-only coupling rule — do NOT import any
 * types from Crontech. If the contract is renegotiated, update this comment
 * and the validation below in lock-step.
 *
 *   POST  /api/events/deploy
 *   Authorization: Bearer ${CRONTECH_EVENT_TOKEN}
 *   Content-Type: application/json
 *
 *   {
 *     "event":         "deploy.succeeded" | "deploy.failed",
 *     "eventId":       "<uuid-v4>",           // idempotency key
 *     "repository":    "owner/name",
 *     "sha":           "<40-hex>",
 *     "environment":   "production",
 *     "deploymentId":  "<crontech-id>",
 *     "durationMs":    <int>,                 // optional
 *     "errorCategory": "build|runtime|timeout|config",  // required on failed
 *     "errorSummary":  "<string ≤500>",                 // required on failed
 *     "logsUrl":       "<string>",            // optional
 *     "timestamp":     "<ISO-8601>"
 *   }
 *
 *   → 200 { ok: true, duplicate: false }
 *   → 200 { ok: true, duplicate: true }
 *   → 401 invalid bearer
 *   → 400 malformed payload
 *
 * Idempotency: an incoming `eventId` is first looked up in `processed_events`.
 * On hit we return { duplicate: true } immediately — no side-effects. On miss
 * we INSERT the idempotency record BEFORE performing the side-effect update so
 * that a retry after a crash between steps sees the record and short-circuits.
 *
 * Side-effect: look up the matching `deployments` row by
 * (repository_id, commit_sha, environment) — `deployments` has no
 * `crontech_deployment_id` column so we key off the tuple that
 * `triggerCrontechDeploy` writes on the way out.
 *
 *   E3 deploy.succeeded → status='success',  completedAt=now
 *   E4 deploy.failed    → status='failed',   blockedReason=errorSummary,
 *                         completedAt=now, notify(owner, 'deploy_failed')
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { timingSafeEqual } from "crypto";
import { db } from "../db";
import { deployments, repositories, users } from "../db/schema";
import { processedEvents } from "../db/schema-events";
import {
  platformDeploys,
  platformDeploySteps,
} from "../db/schema-deploys";
import { sql } from "drizzle-orm";
import { notify } from "../lib/notify";
import { publish } from "../lib/sse";

const events = new Hono();

// ---------------------------------------------------------------------------
// Bearer auth — timing-safe comparison against CRONTECH_EVENT_TOKEN.
// ---------------------------------------------------------------------------

function constantTimeEq(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  try {
    return timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

function verifyBearer(c: any): { ok: boolean; error?: string } {
  const expected = process.env.CRONTECH_EVENT_TOKEN || "";
  if (!expected) {
    // Refuse by default — an unset secret must NOT allow anonymous writes.
    return {
      ok: false,
      error:
        "Event endpoint not configured: set CRONTECH_EVENT_TOKEN in the environment",
    };
  }
  const auth = c.req.header("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, error: "Missing Bearer token" };
  }
  const token = auth.slice(7).trim();
  if (!constantTimeEq(token, expected)) {
    return { ok: false, error: "Invalid bearer token" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Payload validation — no zod in this repo, use manual checks mirroring the
// existing hooks.ts style. Keep error messages specific enough to diagnose a
// mis-built emitter without leaking internals.
// ---------------------------------------------------------------------------

type DeployEvent = "deploy.succeeded" | "deploy.failed";
type ErrorCategory = "build" | "runtime" | "timeout" | "config";

interface DeployEventPayload {
  event: DeployEvent;
  eventId: string;
  repository: string;
  sha: string;
  environment: string;
  deploymentId: string;
  durationMs?: number;
  errorCategory?: ErrorCategory;
  errorSummary?: string;
  logsUrl?: string;
  timestamp: string;
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{40}$/i;
const VALID_EVENTS: ReadonlySet<string> = new Set([
  "deploy.succeeded",
  "deploy.failed",
]);
const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "build",
  "runtime",
  "timeout",
  "config",
]);

function validatePayload(raw: unknown): {
  ok: true;
  payload: DeployEventPayload;
} | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.event !== "string" || !VALID_EVENTS.has(p.event)) {
    return {
      ok: false,
      error: "event must be 'deploy.succeeded' or 'deploy.failed'",
    };
  }
  if (typeof p.eventId !== "string" || !UUID_V4_RE.test(p.eventId)) {
    return { ok: false, error: "eventId must be a uuid-v4 string" };
  }
  if (typeof p.repository !== "string" || !p.repository.includes("/")) {
    return { ok: false, error: "repository must be '<owner>/<name>'" };
  }
  if (typeof p.sha !== "string" || !SHA_RE.test(p.sha)) {
    return { ok: false, error: "sha must be a 40-hex commit id" };
  }
  if (typeof p.environment !== "string" || p.environment.length === 0) {
    return { ok: false, error: "environment must be a non-empty string" };
  }
  if (typeof p.deploymentId !== "string" || p.deploymentId.length === 0) {
    return { ok: false, error: "deploymentId must be a non-empty string" };
  }
  if (typeof p.timestamp !== "string" || Number.isNaN(Date.parse(p.timestamp))) {
    return { ok: false, error: "timestamp must be an ISO-8601 string" };
  }
  if (p.durationMs !== undefined) {
    if (
      typeof p.durationMs !== "number" ||
      !Number.isFinite(p.durationMs) ||
      p.durationMs < 0
    ) {
      return { ok: false, error: "durationMs must be a non-negative number" };
    }
  }
  if (p.logsUrl !== undefined && typeof p.logsUrl !== "string") {
    return { ok: false, error: "logsUrl must be a string when present" };
  }

  if (p.event === "deploy.failed") {
    if (
      typeof p.errorCategory !== "string" ||
      !VALID_CATEGORIES.has(p.errorCategory)
    ) {
      return {
        ok: false,
        error:
          "errorCategory is required for deploy.failed and must be one of build|runtime|timeout|config",
      };
    }
    if (
      typeof p.errorSummary !== "string" ||
      p.errorSummary.length === 0 ||
      p.errorSummary.length > 500
    ) {
      return {
        ok: false,
        error:
          "errorSummary is required for deploy.failed and must be 1-500 chars",
      };
    }
  }

  return { ok: true, payload: p as unknown as DeployEventPayload };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRepo(
  full: string
): Promise<{ id: string; ownerId: string } | null> {
  if (!full.includes("/")) return null;
  const [owner, name] = full.split("/", 2);
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, name)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

async function findTargetDeployment(
  repositoryId: string,
  commitSha: string,
  environment: string
): Promise<{ id: string } | null> {
  try {
    const [row] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.repositoryId, repositoryId),
          eq(deployments.commitSha, commitSha),
          eq(deployments.environment, environment)
        )
      )
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/events/deploy
// ---------------------------------------------------------------------------

events.post("/deploy", async (c) => {
  const auth = verifyBearer(c);
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error || "Unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const validated = validatePayload(raw);
  if (!validated.ok) {
    return c.json({ ok: false, error: validated.error }, 400);
  }
  const payload = validated.payload;

  // --- Idempotency check ---------------------------------------------------
  // If we've already processed this eventId, return duplicate:true without
  // firing any side-effects.
  try {
    const [existing] = await db
      .select({ id: processedEvents.id })
      .from(processedEvents)
      .where(eq(processedEvents.eventId, payload.eventId))
      .limit(1);
    if (existing) {
      return c.json({ ok: true, duplicate: true });
    }
  } catch (err) {
    console.error("[events/deploy] idempotency lookup failed:", err);
    // Fall through — better to process than to wedge on a transient DB blip.
  }

  // --- Record the idempotency token BEFORE side-effects --------------------
  // Race: two simultaneous deliveries of the same eventId. The UNIQUE
  // constraint on event_id makes the losing insert throw; we catch that and
  // return duplicate:true to keep behaviour stable.
  try {
    await db.insert(processedEvents).values({
      eventId: payload.eventId,
      eventType: payload.event,
      source: "crontech",
      payload: payload as unknown as Record<string, unknown>,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      return c.json({ ok: true, duplicate: true });
    }
    console.error("[events/deploy] processed_events insert failed:", err);
    return c.json({ ok: false, error: "Failed to persist event" }, 500);
  }

  // --- Side-effect: update the matching deployments row --------------------
  const repo = await resolveRepo(payload.repository);
  if (!repo) {
    // The idempotency row is already committed; we accept the event so we
    // don't invite infinite retries for a repo that genuinely doesn't exist
    // on this side of the wire. Log for operator follow-up.
    console.warn(
      `[events/deploy] unknown repository ${payload.repository} — event ${payload.eventId} accepted but no deployment update applied`
    );
    return c.json({ ok: true, duplicate: false });
  }

  const target = await findTargetDeployment(
    repo.id,
    payload.sha,
    payload.environment
  );

  if (target) {
    try {
      if (payload.event === "deploy.succeeded") {
        await db
          .update(deployments)
          .set({
            status: "success",
            completedAt: new Date(),
          })
          .where(eq(deployments.id, target.id));
      } else {
        await db
          .update(deployments)
          .set({
            status: "failed",
            blockedReason: payload.errorSummary,
            completedAt: new Date(),
          })
          .where(eq(deployments.id, target.id));
      }
    } catch (err) {
      console.error("[events/deploy] deployments update failed:", err);
    }
  } else {
    console.warn(
      `[events/deploy] no deployments row found for ${payload.repository}@${payload.sha} env=${payload.environment}`
    );
  }

  // --- On failure: notify the repo owner ----------------------------------
  if (payload.event === "deploy.failed") {
    try {
      await notify(repo.ownerId, {
        kind: "deploy_failed",
        title: `Deploy failed on ${payload.repository}`,
        body:
          payload.errorSummary ||
          `Crontech reported deploy failure (${payload.errorCategory || "unknown"})`,
        url: payload.logsUrl,
        repositoryId: repo.id,
      });
    } catch (err) {
      console.error("[events/deploy] notify failed:", err);
    }
  }

  return c.json({ ok: true, duplicate: false });
});

// ---------------------------------------------------------------------------
// Block N3 — Platform deploy timeline ingest.
//
// These endpoints are FOR THIS SITE. The Hetzner deploy workflow posts a
// 'started' event when SSH begins and a 'finished' event on success/failure.
// They power the admin status pill in `src/views/layout.tsx` and the
// `/admin/deploys` timeline. NEW endpoints — they do NOT touch the Crontech
// `/deploy` receiver above (which §4.6 locks the semantics of).
//
//   POST /api/events/deploy/started
//     Authorization: Bearer ${DEPLOY_EVENT_TOKEN}
//     Body: { sha: "<40-hex>", run_id: "<string>", source: "<string>" }
//     200 { ok: true, duplicate: false | true }
//     401 invalid bearer
//     400 malformed payload
//
//   POST /api/events/deploy/finished
//     Authorization: Bearer ${DEPLOY_EVENT_TOKEN}
//     Body: { run_id, status: "succeeded"|"failed",
//             duration_ms?: number, error?: string }
//
// Idempotency: keyed on run_id via the UNIQUE constraint in migration 0046.
// A duplicate 'started' POST is a no-op. A 'finished' POST without a prior
// 'started' INSERTs a fresh row (so the timeline still records the deploy
// even if the started-step silently dropped its packet).
// ---------------------------------------------------------------------------

const SHORT_SHA_RE = /^[0-9a-f]{7,64}$/i;
const VALID_DEPLOY_STATUS: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
]);

function verifyDeployBearer(c: any): { ok: boolean; error?: string } {
  const expected = process.env.DEPLOY_EVENT_TOKEN || "";
  if (!expected) {
    return {
      ok: false,
      error:
        "Deploy event endpoint not configured: set DEPLOY_EVENT_TOKEN in the environment",
    };
  }
  const auth = c.req.header("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, error: "Missing Bearer token" };
  }
  const token = auth.slice(7).trim();
  if (!constantTimeEq(token, expected)) {
    return { ok: false, error: "Invalid bearer token" };
  }
  return { ok: true };
}

interface DeployStartedPayload {
  sha: string;
  run_id: string;
  source: string;
}

interface DeployFinishedPayload {
  run_id: string;
  sha?: string;
  status: "succeeded" | "failed";
  duration_ms?: number;
  error?: string;
}

function validateStarted(raw: unknown):
  | { ok: true; payload: DeployStartedPayload }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.sha !== "string" || !SHORT_SHA_RE.test(p.sha)) {
    return { ok: false, error: "sha must be a hex commit id (7-64 chars)" };
  }
  if (typeof p.run_id !== "string" || p.run_id.length === 0 || p.run_id.length > 128) {
    return { ok: false, error: "run_id must be a non-empty string (≤128 chars)" };
  }
  if (typeof p.source !== "string" || p.source.length === 0 || p.source.length > 64) {
    return { ok: false, error: "source must be a non-empty string (≤64 chars)" };
  }
  return {
    ok: true,
    payload: { sha: p.sha, run_id: p.run_id, source: p.source },
  };
}

function validateFinished(raw: unknown):
  | { ok: true; payload: DeployFinishedPayload }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.run_id !== "string" || p.run_id.length === 0 || p.run_id.length > 128) {
    return { ok: false, error: "run_id must be a non-empty string (≤128 chars)" };
  }
  if (typeof p.status !== "string" || !VALID_DEPLOY_STATUS.has(p.status)) {
    return {
      ok: false,
      error: "status must be 'succeeded' or 'failed'",
    };
  }
  if (p.sha !== undefined && (typeof p.sha !== "string" || !SHORT_SHA_RE.test(p.sha))) {
    return { ok: false, error: "sha must be a hex commit id when provided" };
  }
  if (p.duration_ms !== undefined) {
    if (
      typeof p.duration_ms !== "number" ||
      !Number.isFinite(p.duration_ms) ||
      p.duration_ms < 0
    ) {
      return { ok: false, error: "duration_ms must be a non-negative number" };
    }
  }
  if (p.error !== undefined && typeof p.error !== "string") {
    return { ok: false, error: "error must be a string when provided" };
  }
  return {
    ok: true,
    payload: {
      run_id: p.run_id,
      sha: typeof p.sha === "string" ? p.sha : undefined,
      status: p.status as "succeeded" | "failed",
      duration_ms:
        typeof p.duration_ms === "number" ? p.duration_ms : undefined,
      // Cap error text at 8 KB so a misbehaving emitter can't blow up
      // the DB row (the workflow already truncates to 1 KB on its end).
      error:
        typeof p.error === "string" ? p.error.slice(0, 8 * 1024) : undefined,
    },
  };
}

const PLATFORM_DEPLOYS_TOPIC = "platform:deploys";

events.post("/deploy/started", async (c) => {
  const auth = verifyDeployBearer(c);
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error || "Unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const validated = validateStarted(raw);
  if (!validated.ok) {
    return c.json({ ok: false, error: validated.error }, 400);
  }
  const { sha, run_id, source } = validated.payload;

  // INSERT-or-no-op on UNIQUE(run_id). If the row already exists we treat the
  // call as a duplicate and don't republish — the original publish carried
  // the canonical started-at timestamp.
  let inserted: { id: string; startedAt: Date } | null = null;
  try {
    const rows = await db
      .insert(platformDeploys)
      .values({
        runId: run_id,
        sha,
        source,
        status: "in_progress",
      })
      .onConflictDoNothing({ target: platformDeploys.runId })
      .returning({ id: platformDeploys.id, startedAt: platformDeploys.startedAt });
    inserted = rows[0] ?? null;
  } catch (err) {
    console.error("[events/deploy/started] insert failed:", err);
    return c.json({ ok: false, error: "Failed to persist deploy event" }, 500);
  }

  if (!inserted) {
    return c.json({ ok: true, duplicate: true });
  }

  publish(PLATFORM_DEPLOYS_TOPIC, {
    event: "deploy.started",
    data: {
      id: inserted.id,
      run_id,
      sha,
      source,
      status: "in_progress",
      started_at: inserted.startedAt.toISOString(),
    },
  });

  return c.json({ ok: true, duplicate: false });
});

events.post("/deploy/finished", async (c) => {
  const auth = verifyDeployBearer(c);
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error || "Unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const validated = validateFinished(raw);
  if (!validated.ok) {
    return c.json({ ok: false, error: validated.error }, 400);
  }
  const payload = validated.payload;

  const finishedAt = new Date();

  let row:
    | {
        id: string;
        runId: string;
        sha: string;
        source: string;
        status: string;
        startedAt: Date;
        finishedAt: Date | null;
        durationMs: number | null;
        error: string | null;
      }
    | null = null;

  try {
    const updated = await db
      .update(platformDeploys)
      .set({
        status: payload.status,
        finishedAt,
        durationMs: payload.duration_ms ?? null,
        error: payload.error ?? null,
      })
      .where(eq(platformDeploys.runId, payload.run_id))
      .returning({
        id: platformDeploys.id,
        runId: platformDeploys.runId,
        sha: platformDeploys.sha,
        source: platformDeploys.source,
        status: platformDeploys.status,
        startedAt: platformDeploys.startedAt,
        finishedAt: platformDeploys.finishedAt,
        durationMs: platformDeploys.durationMs,
        error: platformDeploys.error,
      });
    row = updated[0] ?? null;
  } catch (err) {
    console.error("[events/deploy/finished] update failed:", err);
    return c.json({ ok: false, error: "Failed to persist deploy event" }, 500);
  }

  // No matching started row — record a finished-only entry so the timeline
  // still reflects the deploy. Source/sha fall back to defaults; this is the
  // "started packet got dropped" recovery path.
  if (!row) {
    try {
      const inserted = await db
        .insert(platformDeploys)
        .values({
          runId: payload.run_id,
          sha: payload.sha ?? "unknown",
          source: "hetzner-deploy",
          status: payload.status,
          finishedAt,
          durationMs: payload.duration_ms ?? null,
          error: payload.error ?? null,
        })
        .returning({
          id: platformDeploys.id,
          runId: platformDeploys.runId,
          sha: platformDeploys.sha,
          source: platformDeploys.source,
          status: platformDeploys.status,
          startedAt: platformDeploys.startedAt,
          finishedAt: platformDeploys.finishedAt,
          durationMs: platformDeploys.durationMs,
          error: platformDeploys.error,
        });
      row = inserted[0] ?? null;
    } catch (err) {
      console.error("[events/deploy/finished] backfill insert failed:", err);
      return c.json({ ok: false, error: "Failed to persist deploy event" }, 500);
    }
  }

  if (row) {
    publish(PLATFORM_DEPLOYS_TOPIC, {
      event: "deploy.finished",
      data: {
        id: row.id,
        run_id: row.runId,
        sha: row.sha,
        source: row.source,
        status: row.status,
        started_at: row.startedAt.toISOString(),
        finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
        duration_ms: row.durationMs,
        error: row.error,
      },
    });

    // Level 3 — Self-diagnosing (2026-05-16 reliability sweep).
    //
    // On platform deploy failure, fire-and-forget call to Claude for a
    // root-cause analysis. The RCA gets:
    //   - console.warn'd as a structured log entry (operators grep
    //     journalctl for [platform-incident])
    //   - inserted into audit_log so /admin/audit + future /admin/health
    //     can surface it without a fresh AI call
    //
    // Idempotent by run_id (same run_id can fire multiple finished
    // events, but each will produce its own analysis — that's fine,
    // operators get the freshest version).
    if (row.status === "failed") {
      void (async () => {
        try {
          const { analyzePlatformDeployFailure } = await import(
            "../lib/ai-incident"
          );
          const result = await analyzePlatformDeployFailure({
            runId: row.runId,
            sha: row.sha,
            errorMessage: row.error || payload.error || "(no error message)",
          });
          console.warn(
            `[platform-incident] deploy ${row.runId} (${result.shortSha}) FAILED — RCA follows (aiAvailable=${result.aiAvailable}):\n${result.rcaMarkdown}`
          );
          try {
            const { audit } = await import("../lib/notify");
            await audit({
              userId: null,
              action: "platform.deploy.failed",
              targetType: "platform_deploy",
              targetId: row.id,
              metadata: {
                run_id: row.runId,
                sha: row.sha,
                short_sha: result.shortSha,
                error: (row.error || "").slice(0, 500),
                ai_rca: result.rcaMarkdown.slice(0, 8000),
                ai_available: result.aiAvailable,
              },
            });
          } catch (err) {
            console.warn(
              `[platform-incident] audit-log insert failed for run ${row.runId}:`,
              err instanceof Error ? err.message : err
            );
          }
        } catch (err) {
          console.warn(
            `[platform-incident] analysis pipeline failed for run ${row.runId}:`,
            err instanceof Error ? err.message : err
          );
        }
      })();
    }
  }

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Block R2 — Live deploy log streaming via SSE.
//
//   POST /api/events/deploy/step
//     Authorization: Bearer ${DEPLOY_EVENT_TOKEN}
//     Body: {
//       run_id:     <string ≤128>,
//       sha:        <hex 7-64>,
//       step_name:  <string ≤64>,
//       status:     "in_progress" | "succeeded" | "failed",
//       output?:    <string, truncated to 8 KB>,
//       duration_ms?: <number ≥0>
//     }
//
// Behaviour:
//   1. Look up `platform_deploys` by run_id. 404 if missing — the workflow's
//      `started` notification creates that row, so a step before /started is
//      operator error rather than a normal race.
//   2. Insert a `platform_deploy_steps` row. Idempotent on
//      (deploy_id, step_name, status) — replaying the same transition is a
//      no-op (returns duplicate:true and does NOT republish SSE).
//   3. Update the parent's `last_step` to the current step_name and bump
//      `step_count` on (status='succeeded' OR first 'in_progress' for this
//      step), so a page reload mid-deploy shows the last known position.
//   4. Publish on TWO topics:
//        - `platform:deploys`           (the N3 site-wide pill — coarse)
//        - `platform:deploys:<run_id>`  (per-deploy fine-grained, drives the
//                                        admin-deploys modal)
//
// Auth: bearer `DEPLOY_EVENT_TOKEN`, same as /started + /finished. Refuse
// by default when unset.
// ---------------------------------------------------------------------------

const VALID_STEP_STATUS: ReadonlySet<string> = new Set([
  "in_progress",
  "succeeded",
  "failed",
]);

// Permissive enough for the workflow's `git-pull`, `bun-install`, `build`,
// `db-migrate`, `restart-service`, `smoke-test`. Disallow anything that
// could mess with SSE payload framing or DB display columns.
const STEP_NAME_RE = /^[a-z0-9][a-z0-9_\-]{0,63}$/i;
const STEP_OUTPUT_MAX = 8 * 1024;
const STEP_OUTPUT_SSE_MAX = 2_000;

interface DeployStepPayload {
  run_id: string;
  sha: string;
  step_name: string;
  status: "in_progress" | "succeeded" | "failed";
  output?: string;
  duration_ms?: number;
}

function validateStep(raw: unknown):
  | { ok: true; payload: DeployStepPayload }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const p = raw as Record<string, unknown>;
  if (
    typeof p.run_id !== "string" ||
    p.run_id.length === 0 ||
    p.run_id.length > 128
  ) {
    return {
      ok: false,
      error: "run_id must be a non-empty string (≤128 chars)",
    };
  }
  if (typeof p.sha !== "string" || !SHORT_SHA_RE.test(p.sha)) {
    return { ok: false, error: "sha must be a hex commit id (7-64 chars)" };
  }
  if (typeof p.step_name !== "string" || !STEP_NAME_RE.test(p.step_name)) {
    return {
      ok: false,
      error:
        "step_name must match /^[a-z0-9][a-z0-9_-]{0,63}$/i (e.g. git-pull, bun-install)",
    };
  }
  if (typeof p.status !== "string" || !VALID_STEP_STATUS.has(p.status)) {
    return {
      ok: false,
      error: "status must be 'in_progress', 'succeeded', or 'failed'",
    };
  }
  if (p.duration_ms !== undefined) {
    if (
      typeof p.duration_ms !== "number" ||
      !Number.isFinite(p.duration_ms) ||
      p.duration_ms < 0
    ) {
      return {
        ok: false,
        error: "duration_ms must be a non-negative number when provided",
      };
    }
  }
  if (p.output !== undefined && typeof p.output !== "string") {
    return { ok: false, error: "output must be a string when provided" };
  }
  return {
    ok: true,
    payload: {
      run_id: p.run_id,
      sha: p.sha,
      step_name: p.step_name,
      status: p.status as "in_progress" | "succeeded" | "failed",
      output:
        typeof p.output === "string"
          ? p.output.slice(0, STEP_OUTPUT_MAX)
          : undefined,
      duration_ms:
        typeof p.duration_ms === "number" ? p.duration_ms : undefined,
    },
  };
}

/** SSE topic for a single deploy (drives the admin-deploys modal). */
function perDeployTopic(runId: string): string {
  return `${PLATFORM_DEPLOYS_TOPIC}:${runId}`;
}

events.post("/deploy/step", async (c) => {
  const auth = verifyDeployBearer(c);
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.error || "Unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const validated = validateStep(raw);
  if (!validated.ok) {
    return c.json({ ok: false, error: validated.error }, 400);
  }
  const payload = validated.payload;

  // --- 1. Resolve the parent deploy row -----------------------------------
  let deploy: { id: string; stepCount: number } | null = null;
  try {
    const [row] = await db
      .select({
        id: platformDeploys.id,
        stepCount: platformDeploys.stepCount,
      })
      .from(platformDeploys)
      .where(eq(platformDeploys.runId, payload.run_id))
      .limit(1);
    deploy = row ?? null;
  } catch (err) {
    console.error("[events/deploy/step] parent lookup failed:", err);
    return c.json({ ok: false, error: "Failed to read deploy state" }, 500);
  }

  if (!deploy) {
    return c.json(
      {
        ok: false,
        error:
          "No platform_deploys row for run_id — POST /api/events/deploy/started first",
      },
      404
    );
  }

  // --- 2. Insert the step row (idempotent on transition) ------------------
  let duplicate = false;
  let stepFinishedAt: Date | null = null;
  try {
    const insertValues: Record<string, unknown> = {
      deployId: deploy.id,
      stepName: payload.step_name,
      status: payload.status,
      output: payload.output ?? null,
      durationMs: payload.duration_ms ?? null,
    };
    if (payload.status !== "in_progress") {
      stepFinishedAt = new Date();
      insertValues.finishedAt = stepFinishedAt;
    }
    const inserted = await db
      .insert(platformDeploySteps)
      .values(insertValues as any)
      .onConflictDoNothing({
        target: [
          platformDeploySteps.deployId,
          platformDeploySteps.stepName,
          platformDeploySteps.status,
        ],
      })
      .returning({ id: platformDeploySteps.id });
    duplicate = inserted.length === 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      duplicate = true;
    } else {
      console.error("[events/deploy/step] insert failed:", err);
      return c.json({ ok: false, error: "Failed to persist step" }, 500);
    }
  }

  if (duplicate) {
    return c.json({ ok: true, duplicate: true });
  }

  // --- 3. Update the parent's last_step + step_count ----------------------
  // Only bump the counter on transitions that represent forward progress:
  // - 'succeeded' (the step finished cleanly)
  // - first 'in_progress' transition for THIS step (we haven't seen its
  //   name yet) — handled implicitly because the idempotency dedupe above
  //   already filters out a second in_progress for the same step.
  //
  // 'failed' updates last_step but does NOT bump the counter — the deploy
  // is wedged, no more progress to count.
  try {
    if (payload.status === "failed") {
      await db
        .update(platformDeploys)
        .set({ lastStep: payload.step_name })
        .where(eq(platformDeploys.id, deploy.id));
    } else {
      await db
        .update(platformDeploys)
        .set({
          lastStep: payload.step_name,
          stepCount: sql`${platformDeploys.stepCount} + 1`,
        })
        .where(eq(platformDeploys.id, deploy.id));
    }
  } catch (err) {
    // Persistence failure on the rollup column must not stop the SSE push
    // — the modal will still show the live state, the page refresh just
    // won't carry the last_step. Log and continue.
    console.error("[events/deploy/step] parent rollup update failed:", err);
  }

  // --- 4. Publish to both SSE topics --------------------------------------
  const ssePayload = {
    event: "step",
    data: JSON.stringify({
      run_id: payload.run_id,
      step_name: payload.step_name,
      status: payload.status,
      duration_ms: payload.duration_ms ?? null,
      output: payload.output
        ? payload.output.slice(0, STEP_OUTPUT_SSE_MAX)
        : null,
      finished_at: stepFinishedAt ? stepFinishedAt.toISOString() : null,
    }),
  };
  publish(PLATFORM_DEPLOYS_TOPIC, ssePayload);
  publish(perDeployTopic(payload.run_id), ssePayload);

  return c.json({ ok: true, duplicate: false });
});

// Test-only access for unit tests that want to exercise helpers directly.
export const __test = {
  constantTimeEq,
  validatePayload,
  resolveRepo,
  findTargetDeployment,
  validateStarted,
  validateFinished,
  validateStep,
  verifyDeployBearer,
  perDeployTopic,
  PLATFORM_DEPLOYS_TOPIC,
};

export default events;
