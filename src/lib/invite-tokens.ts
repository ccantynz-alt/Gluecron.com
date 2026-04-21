/**
 * Invite tokens — opaque secrets used to gate collaborator invitation links.
 *
 * The plaintext token is emailed to the invitee as a URL fragment; only its
 * sha256 hash is persisted on the `repo_collaborators` row. When the invitee
 * clicks the link, we re-hash the presented token and match it against the
 * stored hash. Storing only the hash means a DB compromise does not leak
 * live invite URLs.
 *
 * Token format: 32 hex chars (16 bytes of entropy). Plenty of collision
 * resistance for short-lived single-use invites, and short enough to paste.
 */

import { randomBytes, createHash } from "crypto";

/**
 * Generate a fresh invite token — 32 hex chars, cryptographically random.
 */
export function generateInviteToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Hash an invite token for storage/lookup. Deterministic sha256 hex so the
 * same token always maps to the same row.
 */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
