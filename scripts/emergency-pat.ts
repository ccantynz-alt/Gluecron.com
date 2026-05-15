// Emergency PAT creator — bypasses the live site entirely.
//
// Use case: the deployed site is broken (e.g. SW reload loop) such that
// you can't reach /settings/tokens in the browser, but you need a PAT
// to `git push` the fix. This script writes a PAT row directly into
// the production database via DATABASE_URL.
//
// Run: bun run scripts/emergency-pat.ts
// Required env: DATABASE_URL (from your local .env)
//
// The script:
//   1. Loads .env
//   2. Finds the first admin user (or a user matching $EMERGENCY_PAT_USER)
//   3. Inserts a fresh PAT with `admin` scope
//   4. Prints the raw token — you only see it once, so copy it now

import { db } from "../src/db/index";
import { users, apiTokens } from "../src/db/schema";
import { eq } from "drizzle-orm";

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return (
    "glc_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function main() {
  const requestedUser = process.env.EMERGENCY_PAT_USER?.trim();
  let user: typeof users.$inferSelect | undefined;

  if (requestedUser) {
    [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, requestedUser))
      .limit(1);
    if (!user) {
      console.error(`No user with username "${requestedUser}".`);
      process.exit(1);
    }
  } else {
    [user] = await db
      .select()
      .from(users)
      .where(eq(users.isAdmin, true))
      .limit(1);
    if (!user) {
      console.error(
        "No admin user found. Set EMERGENCY_PAT_USER=<username> and rerun."
      );
      process.exit(1);
    }
  }

  const token = generateToken();
  const tokenHash = await hashToken(token);
  await db.insert(apiTokens).values({
    userId: user.id,
    name: "emergency-deploy-fix",
    tokenHash,
    tokenPrefix: token.slice(0, 12),
    scopes: "admin",
  });

  console.log(`User:    ${user.username} (id ${user.id})`);
  console.log(`Token:   ${token}`);
  console.log("");
  console.log("Copy the token above NOW — it is hashed in the DB and");
  console.log("cannot be recovered later. Then push with:");
  console.log("");
  console.log(`  git remote set-url gluecron "https://${user.username}:${token}@gluecron.com/ccantynz/Gluecron.com.git"`);
  console.log("  git push gluecron main");
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
