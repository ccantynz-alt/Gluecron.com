// List repos for a user — diagnoses "Repository not found" on push.
//
// Run:  EMERGENCY_PAT_USER=<username> bun run scripts/list-repos.ts
// Or just:  bun run scripts/list-repos.ts   (lists everything)
//
// Uses raw SQL to survive any schema drift.

import { neon } from "@neondatabase/serverless";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const sql = neon(url);
  const wanted = process.env.EMERGENCY_PAT_USER?.trim();

  const rows = wanted
    ? (await sql`
        SELECT r.name, r.is_private, u.username AS owner
        FROM repositories r JOIN users u ON u.id = r.owner_id
        WHERE LOWER(u.username) = LOWER(${wanted})
        ORDER BY r.created_at ASC
      `) as Array<{ name: string; is_private: boolean; owner: string }>
    : (await sql`
        SELECT r.name, r.is_private, u.username AS owner
        FROM repositories r JOIN users u ON u.id = r.owner_id
        ORDER BY u.username, r.created_at ASC LIMIT 50
      `) as Array<{ name: string; is_private: boolean; owner: string }>;

  if (rows.length === 0) {
    console.log(wanted ? `No repos for user "${wanted}".` : "No repos in DB.");
    return;
  }

  console.log("");
  console.log("Repos found:");
  console.log("");
  for (const r of rows) {
    console.log(
      `  ${r.owner}/${r.name}    private=${r.is_private}    push-url=https://gluecron.com/${r.owner}/${r.name}.git`
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
