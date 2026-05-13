/**
 * Reset (or create) the site admin's password.
 *
 * Use this when you have shell access to the deployment but have lost the
 * site-admin password. Idempotent: if the user exists, updates the password
 * hash; if not, creates the user. Either way, ensures the user is in
 * `site_admins` so they bypass the bootstrap-rule chicken-and-egg.
 *
 * Run against the live database via:
 *
 *     bun run scripts/reset-admin-password.ts <username> <email> <password>
 *
 * On Fly.io that looks like:
 *
 *     fly ssh console -C "bun run scripts/reset-admin-password.ts admin you@example.com 'new-password'"
 *
 * Requires DATABASE_URL set in the environment (which is true inside the
 * Fly machine; locally you'd export it first).
 *
 * Password is bcrypt-hashed with the same parameters as `src/lib/auth.ts`
 * (cost 10). Plaintext is never persisted or logged.
 */

import { db } from "../src/db";
import { users, siteAdmins } from "../src/db/schema";
import { eq, or } from "drizzle-orm";
import { hashPassword } from "../src/lib/auth";

function usage(): never {
  console.error(
    "Usage: bun run scripts/reset-admin-password.ts <username> <email> <password>"
  );
  process.exit(2);
}

const [, , username, email, password] = process.argv;

if (!username || !email || !password) usage();
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(2);
}
if (!email.includes("@")) {
  console.error("Email looks invalid (no @).");
  process.exit(2);
}

const passwordHash = await hashPassword(password);

// Find by username OR email — either uniquely identifies an existing user.
const existing = await db
  .select({ id: users.id, username: users.username, email: users.email })
  .from(users)
  .where(or(eq(users.username, username), eq(users.email, email)))
  .limit(1);

let userId: string;
let action: "updated" | "created";

if (existing.length > 0) {
  const row = existing[0]!;
  userId = row.id;
  await db
    .update(users)
    .set({ passwordHash, email, username, updatedAt: new Date() })
    .where(eq(users.id, userId));
  action = "updated";
  if (row.username !== username || row.email !== email) {
    console.log(
      `(Note: existing user matched on ${row.username === username ? "username" : "email"}; username/email fields realigned to the values you passed.)`
    );
  }
} else {
  const inserted = await db
    .insert(users)
    .values({ username, email, passwordHash })
    .returning({ id: users.id });
  userId = inserted[0]!.id;
  action = "created";
}

// Ensure site-admin row so we don't depend on the oldest-user bootstrap rule.
await db
  .insert(siteAdmins)
  .values({ userId })
  .onConflictDoNothing({ target: siteAdmins.userId });

console.log(
  `OK — ${action} user "${username}" <${email}> and ensured site_admins row.`
);
console.log(`Sign in at /login with username "${username}".`);
