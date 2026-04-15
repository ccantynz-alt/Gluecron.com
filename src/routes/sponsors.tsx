/**
 * Block I6 — Sponsors.
 *
 *   GET  /sponsors/:username                  — public sponsor page
 *   GET  /settings/sponsors                   — maintain your own tiers + activity
 *   POST /settings/sponsors/tiers/new         — publish a tier
 *   POST /settings/sponsors/tiers/:id/delete  — retire a tier
 *   POST /sponsors/:username                  — record a sponsorship
 *
 * Payment rails are out of scope — this captures intent + thank-you notes.
 */

import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  sponsorships,
  sponsorshipTiers,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const sponsors = new Hono<AuthEnv>();
sponsors.use("*", softAuth);

function formatCents(cents: number): string {
  if (cents === 0) return "Any amount";
  const dollars = (cents / 100).toFixed(2);
  return `$${dollars}`;
}

// ---------- Public sponsor page ----------

sponsors.get("/sponsors/:username", async (c) => {
  const user = c.get("user");
  const targetName = c.req.param("username");
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.username, targetName))
    .limit(1);
  if (!target) return c.notFound();

  const tiers = await db
    .select()
    .from(sponsorshipTiers)
    .where(
      and(
        eq(sponsorshipTiers.maintainerId, target.id),
        eq(sponsorshipTiers.isActive, true)
      )
    )
    .orderBy(sponsorshipTiers.monthlyCents);

  const recentPublic = await db
    .select({
      id: sponsorships.id,
      amountCents: sponsorships.amountCents,
      createdAt: sponsorships.createdAt,
      note: sponsorships.note,
      sponsorName: users.username,
    })
    .from(sponsorships)
    .innerJoin(users, eq(sponsorships.sponsorId, users.id))
    .where(
      and(
        eq(sponsorships.maintainerId, target.id),
        eq(sponsorships.isPublic, true),
        isNull(sponsorships.cancelledAt)
      )
    )
    .orderBy(desc(sponsorships.createdAt))
    .limit(20);

  return c.html(
    <Layout title={`Sponsor ${targetName}`} user={user}>
      <h2>Sponsor {targetName}</h2>
      <p
        style="font-size:14px;color:var(--text-muted);margin:8px 0 20px"
      >
        Support {targetName}'s open-source work on Gluecron.
      </p>

      {tiers.length === 0 ? (
        <div class="panel" style="padding:16px">
          <p style="margin-bottom:12px">
            {targetName} hasn't published any sponsorship tiers yet.
          </p>
          {user ? (
            <form method="POST" action={`/sponsors/${targetName}`}>
              <input
                type="number"
                name="amount_cents"
                placeholder="Amount in cents (e.g. 500 = $5)"
                min="100"
                required
                style="width:60%"
              />{" "}
              <button type="submit" class="btn btn-primary">
                Sponsor (one-time)
              </button>
            </form>
          ) : (
            <a href={`/login?next=/sponsors/${targetName}`}>
              Sign in to sponsor
            </a>
          )}
        </div>
      ) : (
        <div
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:20px"
        >
          {tiers.map((t) => (
            <form
              method="POST"
              action={`/sponsors/${targetName}`}
              class="panel"
              style="padding:16px;display:flex;flex-direction:column;gap:8px"
            >
              <input type="hidden" name="tier_id" value={t.id} />
              <div style="font-weight:700;font-size:16px">{t.name}</div>
              <div style="font-size:22px;color:var(--accent);font-weight:700">
                {formatCents(t.monthlyCents)}
                {t.monthlyCents > 0 && (
                  <span style="font-size:13px;color:var(--text-muted);font-weight:400">
                    /mo
                  </span>
                )}
              </div>
              <div
                style="font-size:13px;color:var(--text-muted);flex:1"
              >
                {t.description || "\u2014"}
              </div>
              {user ? (
                <>
                  <select name="kind" style="font-size:13px">
                    <option value="monthly">Monthly</option>
                    {t.oneTimeAllowed && (
                      <option value="one_time">One-time</option>
                    )}
                  </select>
                  <button type="submit" class="btn btn-primary">
                    Sponsor
                  </button>
                </>
              ) : (
                <a
                  href={`/login?next=/sponsors/${targetName}`}
                  class="btn"
                  style="text-align:center"
                >
                  Sign in to sponsor
                </a>
              )}
            </form>
          ))}
        </div>
      )}

      <h3>Recent sponsors</h3>
      <div class="panel">
        {recentPublic.length === 0 ? (
          <div class="panel-empty">Be the first to sponsor.</div>
        ) : (
          recentPublic.map((s) => (
            <div class="panel-item" style="justify-content:space-between">
              <div>
                <a href={`/${s.sponsorName}`}>
                  <strong>{s.sponsorName}</strong>
                </a>
                {s.note && (
                  <span
                    style="margin-left:8px;font-size:13px;color:var(--text-muted)"
                  >
                    "{s.note}"
                  </span>
                )}
              </div>
              <div
                style="font-size:12px;color:var(--text-muted);white-space:nowrap"
              >
                {formatCents(s.amountCents)} ·{" "}
                {new Date(s.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

// Record a sponsorship
sponsors.post("/sponsors/:username", requireAuth, async (c) => {
  const user = c.get("user")!;
  const targetName = c.req.param("username");
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.username, targetName))
    .limit(1);
  if (!target) return c.notFound();
  if (target.id === user.id) {
    return c.redirect(`/sponsors/${targetName}`);
  }
  const body = await c.req.parseBody();
  const tierId = body.tier_id ? String(body.tier_id) : null;
  let amountCents = 0;
  let kind = String(body.kind || "one_time");
  if (kind !== "monthly" && kind !== "one_time") kind = "one_time";

  if (tierId) {
    const [tier] = await db
      .select()
      .from(sponsorshipTiers)
      .where(eq(sponsorshipTiers.id, tierId))
      .limit(1);
    if (!tier || tier.maintainerId !== target.id) {
      return c.redirect(`/sponsors/${targetName}`);
    }
    amountCents = tier.monthlyCents;
  } else {
    amountCents = Math.max(0, parseInt(String(body.amount_cents || "0"), 10));
  }
  if (amountCents <= 0 && !tierId) {
    return c.redirect(`/sponsors/${targetName}`);
  }

  await db.insert(sponsorships).values({
    sponsorId: user.id,
    maintainerId: target.id,
    tierId: tierId || null,
    amountCents,
    kind,
    note: body.note ? String(body.note).slice(0, 200) : null,
    isPublic: body.is_public !== "0",
  });
  return c.redirect(`/sponsors/${targetName}?thanks=1`);
});

// ---------- Maintainer settings ----------

sponsors.get("/settings/sponsors", requireAuth, async (c) => {
  const user = c.get("user")!;
  const [tiers, activity] = await Promise.all([
    db
      .select()
      .from(sponsorshipTiers)
      .where(eq(sponsorshipTiers.maintainerId, user.id))
      .orderBy(sponsorshipTiers.monthlyCents),
    db
      .select({
        id: sponsorships.id,
        amountCents: sponsorships.amountCents,
        kind: sponsorships.kind,
        createdAt: sponsorships.createdAt,
        sponsorName: users.username,
      })
      .from(sponsorships)
      .innerJoin(users, eq(sponsorships.sponsorId, users.id))
      .where(eq(sponsorships.maintainerId, user.id))
      .orderBy(desc(sponsorships.createdAt))
      .limit(50),
  ]);
  const total = activity.reduce((sum, s) => sum + s.amountCents, 0);
  return c.html(
    <Layout title="Sponsorship settings" user={user}>
      <h2>Sponsorship</h2>
      <p style="color:var(--text-muted);margin-bottom:16px">
        Your public sponsor page is at{" "}
        <a href={`/sponsors/${user.username}`}>/sponsors/{user.username}</a>.
      </p>

      <div class="panel" style="padding:16px;margin-bottom:20px">
        <div style="font-size:12px;color:var(--text-muted)">
          Total received
        </div>
        <div style="font-size:24px;font-weight:700">
          {formatCents(total)}
        </div>
      </div>

      <h3>Tiers</h3>
      <div class="panel" style="margin-bottom:20px">
        {tiers.length === 0 ? (
          <div class="panel-empty">
            No tiers yet. Add one below to start accepting support.
          </div>
        ) : (
          tiers.map((t) => (
            <div class="panel-item" style="justify-content:space-between">
              <div>
                <div style="font-weight:600">{t.name}</div>
                <div
                  style="font-size:12px;color:var(--text-muted);margin-top:2px"
                >
                  {formatCents(t.monthlyCents)}/mo ·{" "}
                  {t.description || "no description"}
                </div>
              </div>
              <form
                method="POST"
                action={`/settings/sponsors/tiers/${t.id}/delete`}
                onsubmit="return confirm('Retire this tier?')"
              >
                <button type="submit" class="btn btn-sm btn-danger">
                  Retire
                </button>
              </form>
            </div>
          ))
        )}
      </div>

      <h3>Add a tier</h3>
      <form
        method="POST"
        action="/settings/sponsors/tiers/new"
        class="panel"
        style="padding:16px"
      >
        <div class="form-group">
          <label>Name</label>
          <input type="text" name="name" required style="width:100%" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea name="description" rows="2" style="width:100%" />
        </div>
        <div class="form-group">
          <label>Monthly amount (cents)</label>
          <input
            type="number"
            name="monthly_cents"
            min="0"
            placeholder="500 = $5/mo"
            required
          />
        </div>
        <button type="submit" class="btn btn-primary">
          Add tier
        </button>
      </form>

      <h3 style="margin-top:24px">Recent activity</h3>
      <div class="panel">
        {activity.length === 0 ? (
          <div class="panel-empty">No sponsors yet.</div>
        ) : (
          activity.map((a) => (
            <div class="panel-item" style="justify-content:space-between">
              <div>
                <a href={`/${a.sponsorName}`}>{a.sponsorName}</a>
                <span
                  style="margin-left:8px;font-size:12px;color:var(--text-muted)"
                >
                  {a.kind}
                </span>
              </div>
              <div
                style="font-size:12px;color:var(--text-muted);white-space:nowrap"
              >
                {formatCents(a.amountCents)} ·{" "}
                {new Date(a.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

sponsors.post("/settings/sponsors/tiers/new", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  if (!name) return c.redirect("/settings/sponsors");
  const monthlyCents = Math.max(
    0,
    parseInt(String(body.monthly_cents || "0"), 10)
  );
  await db.insert(sponsorshipTiers).values({
    maintainerId: user.id,
    name,
    description: String(body.description || ""),
    monthlyCents,
  });
  return c.redirect("/settings/sponsors");
});

sponsors.post(
  "/settings/sponsors/tiers/:id/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    await db
      .update(sponsorshipTiers)
      .set({ isActive: false })
      .where(
        and(
          eq(sponsorshipTiers.id, id),
          eq(sponsorshipTiers.maintainerId, user.id)
        )
      );
    return c.redirect("/settings/sponsors");
  }
);

// Handy stat helper for other pages
export async function sponsorshipTotalForUser(
  userId: string
): Promise<number> {
  try {
    const [r] = await db
      .select({ n: sql<number>`coalesce(sum(${sponsorships.amountCents}), 0)::int` })
      .from(sponsorships)
      .where(eq(sponsorships.maintainerId, userId));
    return Number(r?.n || 0);
  } catch {
    return 0;
  }
}

/** Test-only hook. */
export const __internal = { formatCents };

export default sponsors;
