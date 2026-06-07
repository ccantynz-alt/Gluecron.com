/**
 * GET  /admin/stripe            — Stripe subscription sync dashboard
 * POST /admin/stripe/:userId/sync — update local plan to match Stripe
 *
 * Shows all non-free users, their local plan, and live Stripe status.
 * Mismatches (local says pro/team but Stripe cancelled, or vice versa)
 * are highlighted with a "Fix" button.
 *
 * If STRIPE_SECRET_KEY is not set, only local data is shown.
 *
 * Gated by isSiteAdmin (same pattern as all other admin sub-pages).
 */

import { Hono } from "hono";
import { desc, eq, ne } from "drizzle-orm";
import { db } from "../db";
import { userQuotas, users } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { getSubscription, planSlugFromSubscription } from "../lib/stripe";
import { audit } from "../lib/notify";

const adminStripe = new Hono<AuthEnv>();
adminStripe.use("*", softAuth);

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/stripe");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div style="max-width:540px;margin:80px auto;padding:32px;text-align:center;background:var(--bg-elevated);border:1px solid var(--border);border-radius:16px;">
          <h2 style="font-family:var(--font-display);font-size:22px;margin:0 0 8px;color:var(--text-strong);">403 — Not a site admin</h2>
          <p style="color:var(--text-muted);margin:0;font-size:14px;">You don't have permission to view this page.</p>
        </div>
      </Layout>,
      403
    );
  }
  return { user };
}

const styles = `
  .adm-stripe-wrap { max-width: 1400px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .adm-stripe-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .adm-stripe-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #818cf8 30%, #38bdf8 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .adm-stripe-hero-inner { position: relative; z-index: 1; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .adm-stripe-eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #818cf8; margin-bottom: 6px; }
  .adm-stripe-title { font-family: var(--font-display); font-size: clamp(24px,3.5vw,36px); font-weight: 800; letter-spacing: -0.025em; margin: 0 0 4px; color: var(--text-strong); }
  .adm-stripe-sub { font-size: 14px; color: var(--text-muted); margin: 0; line-height: 1.5; }
  .adm-stripe-back { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; font-size: 12.5px; color: var(--text-muted); background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 8px; text-decoration: none; font-weight: 500; transition: border-color 120ms,color 120ms,background 120ms; }
  .adm-stripe-back:hover { border-color: var(--border-strong); color: var(--text-strong); background: rgba(255,255,255,0.04); }

  .adm-stripe-notice {
    margin-bottom: var(--space-4);
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid rgba(251,191,36,0.40);
    background: rgba(251,191,36,0.06);
    color: #fde68a;
    line-height: 1.5;
  }
  .adm-stripe-notice code { font-family: var(--font-mono); font-size: 12.5px; background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; }

  .adm-stripe-banner { margin-bottom: var(--space-4); padding: 10px 14px; border-radius: 10px; font-size: 13.5px; border: 1px solid var(--border); background: rgba(255,255,255,0.025); color: var(--text); }
  .adm-stripe-banner.is-ok { border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08); color: #bbf7d0; }
  .adm-stripe-banner.is-err { border-color: rgba(248,113,113,0.40); background: rgba(248,113,113,0.08); color: #fecaca; }

  .adm-stripe-table { width: 100%; border-collapse: collapse; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
  .adm-stripe-table thead th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); padding: 10px 14px; background: rgba(255,255,255,0.015); border-bottom: 1px solid var(--border); }
  .adm-stripe-table tbody td { padding: 10px 14px; border-bottom: 1px solid var(--border-subtle); font-size: 13px; color: var(--text); vertical-align: middle; }
  .adm-stripe-table tbody tr:last-child td { border-bottom: none; }
  .adm-stripe-table tbody tr:hover td { background: rgba(255,255,255,0.018); }
  .adm-stripe-table code { font-family: var(--font-mono); font-size: 11px; color: var(--text-strong); }

  .adm-stripe-pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 700; }
  .adm-stripe-pill-active { background: rgba(52,211,153,0.12); color: #6ee7b7; box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30); }
  .adm-stripe-pill-warn { background: rgba(251,146,60,0.12); color: #fdba74; box-shadow: inset 0 0 0 1px rgba(251,146,60,0.32); }
  .adm-stripe-pill-err { background: rgba(248,113,113,0.12); color: #fca5a5; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.35); }
  .adm-stripe-pill-muted { background: rgba(255,255,255,0.04); color: var(--text-muted); box-shadow: inset 0 0 0 1px var(--border); }

  .adm-stripe-mismatch-row td { background: rgba(251,146,60,0.05) !important; }

  .adm-stripe-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; line-height: 1; transition: background 120ms, border-color 120ms; border: 1px solid rgba(140,109,255,0.45); background: rgba(140,109,255,0.08); color: #c5b3ff; }
  .adm-stripe-btn:hover { background: rgba(140,109,255,0.18); border-color: rgba(140,109,255,0.70); color: #e0d5ff; }

  .adm-stripe-empty { padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: 13.5px; background: var(--bg-elevated); border: 1px dashed var(--border); border-radius: 14px; }

  @media (max-width: 720px) {
    .adm-stripe-wrap { padding: var(--space-4) var(--space-3); }
    .adm-stripe-hero { padding: var(--space-4); }
    .adm-stripe-table { display: block; overflow-x: auto; }
  }
`;

type StripeRow = {
  userId: string;
  username: string;
  email: string;
  localPlan: string;
  stripeSubId: string | null;
  stripeStatus: string | null;
  stripePlan: string | null;
  mismatch: boolean;
  stripeError: string | null;
};

function statusPill(status: string | null, stripeKeySet: boolean) {
  if (!stripeKeySet) {
    return <span class="adm-stripe-pill adm-stripe-pill-muted">N/A</span>;
  }
  if (!status) {
    return <span class="adm-stripe-pill adm-stripe-pill-muted">no sub</span>;
  }
  const lower = status.toLowerCase();
  if (lower === "active" || lower === "trialing") {
    return <span class="adm-stripe-pill adm-stripe-pill-active">{status}</span>;
  }
  if (lower === "past_due") {
    return <span class="adm-stripe-pill adm-stripe-pill-warn">{status}</span>;
  }
  return <span class="adm-stripe-pill adm-stripe-pill-err">{status}</span>;
}

adminStripe.get("/admin/stripe", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const stripeKeySet = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.length >= 10);

  // Fetch all non-free users (join users + user_quotas)
  const nonFreeRows = await db
    .select({
      userId: userQuotas.userId,
      planSlug: userQuotas.planSlug,
      stripeCustomerId: userQuotas.stripeCustomerId,
      stripeSubscriptionId: userQuotas.stripeSubscriptionId,
      stripeSubscriptionStatus: userQuotas.stripeSubscriptionStatus,
      username: users.username,
      email: users.email,
    })
    .from(userQuotas)
    .innerJoin(users, eq(userQuotas.userId, users.id))
    .where(ne(userQuotas.planSlug, "free"))
    .orderBy(desc(userQuotas.planSlug), users.username)
    .limit(500);

  // For each user, fetch live Stripe status (if key is set)
  const rows: StripeRow[] = [];
  for (const r of nonFreeRows) {
    let stripeStatus: string | null = r.stripeSubscriptionStatus;
    let stripePlan: string | null = null;
    let stripeError: string | null = null;

    if (stripeKeySet && r.stripeSubscriptionId) {
      try {
        const res = await getSubscription(r.stripeSubscriptionId);
        if (res.ok) {
          stripeStatus = res.subscription.status;
          stripePlan = planSlugFromSubscription(res.subscription);
        } else {
          stripeError = res.error;
          // Keep DB-cached status as fallback
        }
      } catch (err) {
        stripeError = err instanceof Error ? err.message : String(err);
      }
    }

    // Determine mismatch:
    // - local plan is non-free but Stripe subscription is cancelled/past_due/missing
    // - local plan is free but Stripe shows active (shouldn't happen but catch it)
    const activeOnStripe =
      stripeStatus === "active" || stripeStatus === "trialing";
    const cancelledOnStripe =
      stripeStatus && stripeStatus !== "active" && stripeStatus !== "trialing";

    let mismatch = false;
    if (stripeKeySet && r.stripeSubscriptionId) {
      if (cancelledOnStripe && r.planSlug !== "free") mismatch = true;
    }

    rows.push({
      userId: r.userId,
      username: r.username,
      email: r.email,
      localPlan: r.planSlug,
      stripeSubId: r.stripeSubscriptionId,
      stripeStatus,
      stripePlan,
      mismatch,
      stripeError,
    });
  }

  const mismatches = rows.filter((r) => r.mismatch);

  const msg = c.req.query("msg") || "";
  const errMsg = c.req.query("err") || "";

  return c.html(
    <Layout title="Admin — Stripe Sync" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="adm-stripe-wrap">
        <div class="adm-stripe-hero">
          <div class="adm-stripe-hero-inner">
            <div>
              <div class="adm-stripe-eyebrow">Admin / Billing</div>
              <h1 class="adm-stripe-title">Stripe Sync</h1>
              <p class="adm-stripe-sub">
                Non-free users — local plan vs live Stripe subscription status.
                {mismatches.length > 0 && ` ${mismatches.length} mismatch${mismatches.length > 1 ? "es" : ""} detected.`}
              </p>
            </div>
            <a href="/admin" class="adm-stripe-back">← Admin</a>
          </div>
        </div>

        {!stripeKeySet && (
          <div class="adm-stripe-notice">
            <strong>STRIPE_SECRET_KEY not configured</strong> — showing local plan data only.
            Set <code>STRIPE_SECRET_KEY</code> in your environment to enable live Stripe sync.
          </div>
        )}

        {msg && <div class="adm-stripe-banner is-ok">{msg}</div>}
        {errMsg && <div class="adm-stripe-banner is-err">{errMsg}</div>}

        {rows.length === 0 ? (
          <div class="adm-stripe-empty">No non-free users found.</div>
        ) : (
          <table class="adm-stripe-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Local plan</th>
                <th>Stripe status</th>
                <th>Stripe plan</th>
                <th>Subscription ID</th>
                <th>Mismatch</th>
                {stripeKeySet && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr class={r.mismatch ? "adm-stripe-mismatch-row" : ""}>
                  <td>
                    <a href={`/${r.username}`} style="color:var(--accent);text-decoration:none;font-weight:600;">
                      {r.username}
                    </a>
                  </td>
                  <td style="color:var(--text-muted)">{r.email}</td>
                  <td>
                    <span class="adm-stripe-pill adm-stripe-pill-active">{r.localPlan}</span>
                  </td>
                  <td>{statusPill(r.stripeStatus, stripeKeySet)}</td>
                  <td>
                    {r.stripePlan
                      ? <span class="adm-stripe-pill adm-stripe-pill-active">{r.stripePlan}</span>
                      : <span style="color:var(--text-muted)">—</span>
                    }
                  </td>
                  <td>
                    {r.stripeSubId
                      ? <code>{r.stripeSubId.slice(0, 20)}…</code>
                      : <span style="color:var(--text-muted)">—</span>
                    }
                    {r.stripeError && (
                      <span style="color:#fca5a5;font-size:11px;display:block;margin-top:2px" title={r.stripeError}>
                        ⚠ fetch failed
                      </span>
                    )}
                  </td>
                  <td>
                    {r.mismatch
                      ? <span class="adm-stripe-pill adm-stripe-pill-warn">mismatch</span>
                      : <span class="adm-stripe-pill adm-stripe-pill-muted">ok</span>
                    }
                  </td>
                  {stripeKeySet && (
                    <td>
                      {r.mismatch ? (
                        <form method="post" action={`/admin/stripe/${r.userId}/sync`}>
                          <button type="submit" class="adm-stripe-btn"
                            title={`Update local plan to match Stripe (${r.stripeStatus ?? "no sub"})`}>
                            Fix
                          </button>
                        </form>
                      ) : (
                        <span style="color:var(--text-muted);font-size:12px">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
});

// POST /admin/stripe/:userId/sync — update local plan to match Stripe
adminStripe.post("/admin/stripe/:userId/sync", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user: adminUser } = g;

  const targetUserId = c.req.param("userId");

  // Fetch quota row
  const quotaRows = await db
    .select({
      userId: userQuotas.userId,
      planSlug: userQuotas.planSlug,
      stripeSubscriptionId: userQuotas.stripeSubscriptionId,
      stripeSubscriptionStatus: userQuotas.stripeSubscriptionStatus,
    })
    .from(userQuotas)
    .where(eq(userQuotas.userId, targetUserId))
    .limit(1);

  const quota = quotaRows[0];
  if (!quota) {
    return c.redirect("/admin/stripe?err=" + encodeURIComponent("User quota row not found."));
  }

  // Determine the correct plan from Stripe
  let newPlan: string = "free";
  let stripeStatus: string | null = null;

  if (!quota.stripeSubscriptionId) {
    newPlan = "free";
  } else {
    try {
      const res = await getSubscription(quota.stripeSubscriptionId);
      if (res.ok) {
        stripeStatus = res.subscription.status;
        const isActive = stripeStatus === "active" || stripeStatus === "trialing";
        if (isActive) {
          const slug = planSlugFromSubscription(res.subscription);
          newPlan = slug ?? "free";
        } else {
          newPlan = "free";
        }
      } else {
        return c.redirect("/admin/stripe?err=" + encodeURIComponent(`Stripe API error: ${res.error}`));
      }
    } catch (err) {
      return c.redirect("/admin/stripe?err=" + encodeURIComponent(`Stripe request failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Update local plan
  try {
    await db
      .update(userQuotas)
      .set({
        planSlug: newPlan,
        stripeSubscriptionStatus: stripeStatus ?? quota.stripeSubscriptionStatus,
        updatedAt: new Date(),
      })
      .where(eq(userQuotas.userId, targetUserId));
  } catch (err) {
    return c.redirect("/admin/stripe?err=" + encodeURIComponent(`DB update failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  await audit({
    userId: adminUser.id,
    action: "billing.admin_sync",
    targetType: "user",
    targetId: targetUserId,
    metadata: {
      oldPlan: quota.planSlug,
      newPlan,
      stripeStatus: stripeStatus ?? "unknown",
      triggeredBy: adminUser.id,
    },
  });

  return c.redirect(
    "/admin/stripe?msg=" +
      encodeURIComponent(`Plan updated: ${quota.planSlug} → ${newPlan} (Stripe status: ${stripeStatus ?? "unknown"})`)
  );
});

export default adminStripe;
