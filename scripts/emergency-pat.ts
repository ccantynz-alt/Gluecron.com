// Emergency PAT creator — bypasses the live site entirely.
//
// Use case: the deployed site is broken (e.g. SW reload loop) such that
// you can't reach /settings/tokens in the browser, but you need a PAT
// to `git push` the fix. This script writes a PAT row directly into
// the production database via DATABASE_URL.
//
// Run: bun run scripts/emergency-pat.ts
// Required env: DATABASE_URL (from your local .env, or set inline)
//
// Uses RAW SQL via @neondatabase/serverless rather than drizzle's
// schema layer. Reason: when this script is needed, production is
// usually missing recent migrations, so drizzle's SELECT (which lists
// every schema column) blows up on missing columns. Raw SQL only
// touches the columns we name, so schema drift doesn't matter.

import { neon } from "@neondatabase/serverless";

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
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const sql = neon(url);

  const requestedUser = process.env.EMERGENCY_PAT_USER?.trim();

  let userRow: { id: string; username: string } | undefined;
  if (requestedUser) {
    const rows = (await sql`
      SELECT id, username FROM users WHERE username = ${requestedUser} LIMIT 1
    `) as Array<{ id: string; username: string }>;
    userRow = rows[0];
    if (!userRow) {
      console.error(`No user with username "${requestedUser}".`);
      process.exit(1);
    }
  } else {
    const rows = (await sql`
      SELECT id, username FROM users WHERE is_admin = true ORDER BY created_at ASC LIMIT 1
    `) as Array<{ id: string; username: string }>;
    userRow = rows[0];
    if (!userRow) {
      console.error(
        "No admin user found. Set EMERGENCY_PAT_USER=<username> and rerun."
      );
      process.exit(1);
    }
  }

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const tokenPrefix = token.slice(0, 12);

  await sql`
    INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, scopes)
    VALUES (${userRow.id}, 'emergency-deploy-fix', ${tokenHash}, ${tokenPrefix}, 'admin')
  `;

  console.log("");
  console.log(`User:    ${userRow.username}`);
  console.log(`Token:   ${token}`);
  console.log("");
  console.log("Copy the token NOW (only shown once). Then run these two:");
  console.log("");
  console.log(`  git remote set-url gluecron "https://${userRow.username}:${token}@gluecron.com/ccantynz/Gluecron.com.git"`);
  console.log("  git push gluecron main");
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
