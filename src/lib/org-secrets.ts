/**
 * Org-level secrets — DB CRUD + runtime loader (Block M1).
 *
 * Stores AES-256-GCM ciphertext produced by `workflow-secrets-crypto.ts`.
 * The table is defined inline here because `src/db/schema.ts` is locked —
 * no new tables may be added there.
 *
 * Public API:
 *   listOrgSecrets(orgId)              — metadata only, never plaintext
 *   upsertOrgSecret(orgId, name, …)    — create or replace by (org_id, name)
 *   deleteOrgSecret(orgId, secretId)   — scoped delete, prevents cross-org deletes
 *   loadOrgSecretsForRepo(orgId)       — { NAME: plaintext } map for runner
 */

import { and, asc, eq } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { db } from "../db";
import { encryptSecret, decryptSecret } from "./workflow-secrets-crypto";

// ── Inline Drizzle table definition ────────────────────────────────────────

export const orgSecrets = pgTable(
  "org_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    iv: text("iv").notNull(),
    keyHint: text("key_hint"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("org_secrets_org_name_uq").on(table.orgId, table.name),
    index("org_secrets_org_idx").on(table.orgId),
  ]
);

export type OrgSecret = typeof orgSecrets.$inferSelect;

// ── Validation ──────────────────────────────────────────────────────────────

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_NAME_LEN = 100;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * List all secrets for an org — metadata only (no plaintext, no ciphertext).
 * Ordered alphabetically by name.
 */
export async function listOrgSecrets(
  orgId: string
): Promise<
  Array<{
    id: string;
    name: string;
    keyHint: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  try {
    const rows = await db
      .select({
        id: orgSecrets.id,
        name: orgSecrets.name,
        keyHint: orgSecrets.keyHint,
        createdAt: orgSecrets.createdAt,
        updatedAt: orgSecrets.updatedAt,
      })
      .from(orgSecrets)
      .where(eq(orgSecrets.orgId, orgId))
      .orderBy(asc(orgSecrets.name));
    return rows;
  } catch (err) {
    console.error("[org-secrets] listOrgSecrets:", err);
    return [];
  }
}

/**
 * Create or replace a secret. Name must be `[A-Z_][A-Z0-9_]*`.
 * Uses delete-then-insert to handle the unique constraint on (org_id, name).
 */
export async function upsertOrgSecret(
  orgId: string,
  name: string,
  plaintext: string,
  createdBy: string
): Promise<void> {
  if (!SECRET_NAME_RE.test(name) || name.length > MAX_NAME_LEN) {
    throw new Error(
      `Secret name must match /^[A-Z_][A-Z0-9_]*$/ and be at most ${MAX_NAME_LEN} chars.`
    );
  }

  const result = encryptSecret(plaintext);
  if (!result.ok) {
    throw new Error(`Encryption failed: ${result.error}`);
  }

  // keyHint: last 4 chars of the plaintext, displayed in the UI
  const keyHint =
    plaintext.length >= 4 ? plaintext.slice(-4) : "*".repeat(plaintext.length);

  // The encrypted blob from encryptSecret is a single base64 string that
  // already contains [iv(12) || tag(16) || ciphertext]. We store it in
  // `encrypted_value` and leave `iv` as an empty string to satisfy the
  // NOT NULL constraint (the column was part of the original schema spec
  // but the crypto module packs iv into the ciphertext blob).
  const now = new Date();

  // Delete existing row for this (orgId, name) if present, then insert.
  await db
    .delete(orgSecrets)
    .where(and(eq(orgSecrets.orgId, orgId), eq(orgSecrets.name, name)));

  await db.insert(orgSecrets).values({
    orgId,
    name,
    encryptedValue: result.ciphertext,
    iv: "", // iv is packed into encryptedValue by encryptSecret
    keyHint,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Delete a specific secret, scoped by both orgId and secretId so a caller
 * with one org's context cannot delete another org's secret by guessing a UUID.
 */
export async function deleteOrgSecret(
  orgId: string,
  secretId: string
): Promise<void> {
  await db
    .delete(orgSecrets)
    .where(and(eq(orgSecrets.orgId, orgId), eq(orgSecrets.id, secretId)));
}

/**
 * Load all org secrets as a `{ NAME: plaintext }` map.
 * Called by the workflow runner to merge org-level secrets with repo-level ones
 * (repo-level secrets of the same name take precedence — callers apply that
 * merge logic themselves via `{ ...orgSecrets, ...repoSecrets }`).
 *
 * Swallows all errors and returns `{}` on failure so a misconfigured master
 * key or a transient DB outage never aborts a workflow run.
 */
export async function loadOrgSecretsForRepo(
  orgId: string
): Promise<Record<string, string>> {
  try {
    const rows = await db
      .select({
        name: orgSecrets.name,
        encryptedValue: orgSecrets.encryptedValue,
      })
      .from(orgSecrets)
      .where(eq(orgSecrets.orgId, orgId));

    const map: Record<string, string> = {};
    for (const row of rows) {
      const dec = decryptSecret(row.encryptedValue);
      if (dec.ok) {
        map[row.name] = dec.plaintext;
      }
    }
    return map;
  } catch (err) {
    console.error("[org-secrets] loadOrgSecretsForRepo:", err);
    return {};
  }
}
