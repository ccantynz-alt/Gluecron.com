/**
 * DB-side helpers for server targets — exists to keep route + hook code
 * thin and to centralise the audit-log call so every mutation logs.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  serverTargetAudit,
  serverTargetDeployments,
  serverTargetEnv,
  serverTargets,
  type ServerTarget,
  type NewServerTarget,
  type ServerTargetEnv,
} from "../db/schema";
import { decryptValue, encryptValue, isValidEnvName } from "./server-targets-crypto";

export async function listTargets(): Promise<ServerTarget[]> {
  return db
    .select()
    .from(serverTargets)
    .orderBy(desc(serverTargets.createdAt));
}

export async function getTarget(
  id: string
): Promise<ServerTarget | null> {
  const [row] = await db
    .select()
    .from(serverTargets)
    .where(eq(serverTargets.id, id))
    .limit(1);
  return row ?? null;
}

export async function getTargetByName(
  name: string
): Promise<ServerTarget | null> {
  const [row] = await db
    .select()
    .from(serverTargets)
    .where(eq(serverTargets.name, name))
    .limit(1);
  return row ?? null;
}

export interface CreateTargetInput {
  name: string;
  host: string;
  port?: number;
  sshUser: string;
  privateKey: string;
  deployPath?: string;
  deployScript?: string;
  watchedRepositoryId?: string | null;
  watchedBranch?: string | null;
  createdBy: string;
}

export async function createTarget(
  input: CreateTargetInput
): Promise<{ ok: true; target: ServerTarget } | { ok: false; error: string }> {
  const enc = encryptValue(input.privateKey);
  if (!enc.ok) return { ok: false, error: enc.error };
  const insert: NewServerTarget = {
    name: input.name,
    host: input.host,
    port: input.port ?? 22,
    sshUser: input.sshUser,
    encryptedPrivateKey: enc.ciphertext,
    deployPath: input.deployPath ?? "/var/www/app",
    deployScript: input.deployScript ?? "bash deploy.sh",
    watchedRepositoryId: input.watchedRepositoryId ?? null,
    watchedBranch: input.watchedBranch ?? null,
    createdBy: input.createdBy,
  };
  try {
    const [row] = await db.insert(serverTargets).values(insert).returning();
    if (!row) return { ok: false, error: "insert returned no row" };
    await logAudit({
      targetId: row.id,
      actorId: input.createdBy,
      action: "target.created",
      detail: `${row.sshUser}@${row.host}:${row.port}`,
    });
    return { ok: true, target: row };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteTarget(
  id: string,
  actorId: string
): Promise<void> {
  await db.delete(serverTargets).where(eq(serverTargets.id, id));
  await logAudit({
    targetId: id,
    actorId,
    action: "target.deleted",
  });
}

export async function recordPin(
  targetId: string,
  fingerprint: string,
  actorId: string
): Promise<void> {
  await db
    .update(serverTargets)
    .set({
      hostFingerprint: fingerprint,
      status: "verified",
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(serverTargets.id, targetId));
  await logAudit({
    targetId,
    actorId,
    action: "target.fingerprint_pinned",
    detail: fingerprint,
  });
}

// --- env vars ---------------------------------------------------------------

export async function listEnv(targetId: string): Promise<ServerTargetEnv[]> {
  return db
    .select()
    .from(serverTargetEnv)
    .where(eq(serverTargetEnv.targetId, targetId))
    .orderBy(serverTargetEnv.name);
}

/**
 * Decrypt the env vars for a target into a KEY→value map. Skips rows whose
 * ciphertext fails to decrypt (logged) — a corrupt row should not abort a
 * deploy, but the missing var becomes obvious in the run log.
 */
export async function resolveEnv(
  targetId: string
): Promise<Record<string, string>> {
  const rows = await listEnv(targetId);
  const out: Record<string, string> = {};
  for (const row of rows) {
    const dec = decryptValue(row.encryptedValue);
    if (dec.ok) out[row.name] = dec.plaintext;
    else console.warn(`[server-targets] decrypt env ${row.name}: ${dec.error}`);
  }
  return out;
}

export async function upsertEnv(input: {
  targetId: string;
  name: string;
  value: string;
  isSecret?: boolean;
  actorId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidEnvName(input.name)) {
    return {
      ok: false,
      error: "name must match /^[A-Z_][A-Z0-9_]*$/ (uppercase, digits, _)",
    };
  }
  const enc = encryptValue(input.value);
  if (!enc.ok) return { ok: false, error: enc.error };
  const now = new Date();
  try {
    const [existing] = await db
      .select()
      .from(serverTargetEnv)
      .where(
        and(
          eq(serverTargetEnv.targetId, input.targetId),
          eq(serverTargetEnv.name, input.name)
        )
      )
      .limit(1);
    if (existing) {
      await db
        .update(serverTargetEnv)
        .set({
          encryptedValue: enc.ciphertext,
          isSecret: input.isSecret ?? existing.isSecret,
          updatedBy: input.actorId,
          updatedAt: now,
        })
        .where(eq(serverTargetEnv.id, existing.id));
    } else {
      await db.insert(serverTargetEnv).values({
        targetId: input.targetId,
        name: input.name,
        encryptedValue: enc.ciphertext,
        isSecret: input.isSecret ?? true,
        updatedBy: input.actorId,
      });
    }
    await logAudit({
      targetId: input.targetId,
      actorId: input.actorId,
      action: "env.upserted",
      detail: input.name,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteEnv(input: {
  targetId: string;
  name: string;
  actorId: string;
}): Promise<void> {
  await db
    .delete(serverTargetEnv)
    .where(
      and(
        eq(serverTargetEnv.targetId, input.targetId),
        eq(serverTargetEnv.name, input.name)
      )
    );
  await logAudit({
    targetId: input.targetId,
    actorId: input.actorId,
    action: "env.deleted",
    detail: input.name,
  });
}

// --- deployments + audit ----------------------------------------------------

export interface RecordDeployInput {
  targetId: string;
  commitSha?: string | null;
  ref?: string | null;
  triggeredBy?: string | null;
  triggerSource: "push" | "manual";
}

export async function startDeployRow(
  input: RecordDeployInput
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(serverTargetDeployments)
      .values({
        targetId: input.targetId,
        commitSha: input.commitSha ?? null,
        ref: input.ref ?? null,
        triggeredBy: input.triggeredBy ?? null,
        triggerSource: input.triggerSource,
        status: "running",
      })
      .returning();
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export async function finishDeployRow(input: {
  id: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): Promise<void> {
  try {
    await db
      .update(serverTargetDeployments)
      .set({
        status: input.exitCode === 0 ? "success" : "failed",
        exitCode: input.exitCode,
        stdout: input.stdout.slice(0, 1_000_000),
        stderr: input.stderr.slice(0, 1_000_000),
        finishedAt: new Date(),
      })
      .where(eq(serverTargetDeployments.id, input.id));
  } catch {
    /* ignore */
  }
}

export async function recentDeploys(
  targetId: string,
  limit = 20
): Promise<Array<typeof serverTargetDeployments.$inferSelect>> {
  return db
    .select()
    .from(serverTargetDeployments)
    .where(eq(serverTargetDeployments.targetId, targetId))
    .orderBy(desc(serverTargetDeployments.startedAt))
    .limit(limit);
}

export async function logAudit(input: {
  targetId?: string | null;
  actorId?: string | null;
  action: string;
  detail?: string | null;
  ip?: string | null;
}): Promise<void> {
  try {
    await db.insert(serverTargetAudit).values({
      targetId: input.targetId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      detail: input.detail ?? null,
      ip: input.ip ?? null,
    });
  } catch {
    /* never fail the caller because of audit */
  }
}

export async function findTargetsForPush(input: {
  repositoryId: string;
  branch: string;
}): Promise<ServerTarget[]> {
  return db
    .select()
    .from(serverTargets)
    .where(
      and(
        eq(serverTargets.watchedRepositoryId, input.repositoryId),
        eq(serverTargets.watchedBranch, input.branch)
      )
    );
}
