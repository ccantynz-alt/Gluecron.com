/**
 * Check whether a user is a site admin.
 *
 * Usage:
 *   docker compose exec gluecron bun run scripts/check-admin.ts <email>
 *
 * Reports both `users.is_admin` and `site_admins` table presence so you can
 * see if your account is admin-promoted at either level. Use
 * `scripts/promote-admin.ts` to grant admin if it isn't.
 */
import { db } from "../src/db/client";
import { users, siteAdmins } from "../src/db/schema";
import { eq } from "drizzle-orm";

const emailArg = process.argv[2];
if (!emailArg) {
	console.error("Usage: bun run scripts/check-admin.ts <email>");
	process.exit(2);
}
const email = emailArg.toLowerCase().trim();

const userRow = await db
	.select({ id: users.id, email: users.email, isAdmin: users.isAdmin, createdAt: users.createdAt })
	.from(users)
	.where(eq(users.email, email))
	.limit(1);

if (userRow.length === 0) {
	console.error(`No user found for email: ${email}`);
	console.error("Register at /register first, then re-run this script.");
	process.exit(1);
}

const u = userRow[0];
const inSiteAdmins = await db
	.select({ userId: siteAdmins.userId })
	.from(siteAdmins)
	.where(eq(siteAdmins.userId, u.id))
	.limit(1);

const totalSiteAdmins = await db.select({ userId: siteAdmins.userId }).from(siteAdmins);

console.log(`User: ${u.email}`);
console.log(`  id:                ${u.id}`);
console.log(`  created_at:        ${u.createdAt.toISOString()}`);
console.log(`  users.is_admin:    ${u.isAdmin ? "YES" : "no"}`);
console.log(`  in site_admins:    ${inSiteAdmins.length > 0 ? "YES" : "no"}`);
console.log(`  total site_admins: ${totalSiteAdmins.length}`);

if (totalSiteAdmins.length === 0) {
	console.log("");
	console.log("site_admins table is empty — the bootstrap rule applies:");
	console.log("  the oldest user in `users` is treated as admin by app code.");
	console.log("  Run scripts/promote-admin.ts to make this explicit and durable.");
}

if (u.isAdmin && inSiteAdmins.length > 0) {
	console.log("");
	console.log("✓ This account is a full site admin.");
	process.exit(0);
}

if (u.isAdmin || inSiteAdmins.length > 0) {
	console.log("");
	console.log("~ Partial admin state. Run scripts/promote-admin.ts to normalise.");
	process.exit(0);
}

console.log("");
console.log("× This account is NOT admin. Run:");
console.log(`    docker compose exec gluecron bun run scripts/promote-admin.ts ${email}`);
process.exit(0);
