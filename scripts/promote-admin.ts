/**
 * Promote a user to site admin.
 *
 * Usage:
 *   docker compose exec gluecron bun run scripts/promote-admin.ts <email>
 *
 * Sets both `users.is_admin = true` AND inserts into `site_admins`, so the
 * account is admin under both the bootstrap rule and the explicit-list rule.
 *
 * Idempotent: safe to re-run. Reports what changed.
 */
import { db } from "../src/db/client";
import { users, siteAdmins } from "../src/db/schema";
import { and, eq } from "drizzle-orm";

const emailArg = process.argv[2];
if (!emailArg) {
	console.error("Usage: bun run scripts/promote-admin.ts <email>");
	process.exit(2);
}
const email = emailArg.toLowerCase().trim();

const userRow = await db
	.select({ id: users.id, email: users.email, isAdmin: users.isAdmin })
	.from(users)
	.where(eq(users.email, email))
	.limit(1);

if (userRow.length === 0) {
	console.error(`No user found for email: ${email}`);
	console.error("Register at /register first, then re-run this script.");
	process.exit(1);
}
const u = userRow[0];

let flippedIsAdmin = false;
if (!u.isAdmin) {
	await db.update(users).set({ isAdmin: true }).where(eq(users.id, u.id));
	flippedIsAdmin = true;
}

const existing = await db
	.select({ userId: siteAdmins.userId })
	.from(siteAdmins)
	.where(eq(siteAdmins.userId, u.id))
	.limit(1);

let insertedSiteAdmin = false;
if (existing.length === 0) {
	await db.insert(siteAdmins).values({ userId: u.id, grantedBy: u.id });
	insertedSiteAdmin = true;
}

console.log(`User: ${u.email} (${u.id})`);
console.log(`  users.is_admin    : ${flippedIsAdmin ? "flipped FALSE -> TRUE" : "already TRUE"}`);
console.log(`  site_admins row   : ${insertedSiteAdmin ? "INSERTED" : "already present"}`);
console.log("");
console.log("✓ This account is now a site admin. Log out and back in if /admin still 403s.");
