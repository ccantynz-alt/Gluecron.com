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
import { notify } from "../lib/notify";

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

// Test-only access for unit tests that want to exercise helpers directly.
export const __test = {
  constantTimeEq,
  validatePayload,
  resolveRepo,
  findTargetDeployment,
};

export default events;
