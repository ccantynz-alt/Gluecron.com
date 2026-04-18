/**
 * Block F4 — Billing + quota UI.
 *
 *   GET  /settings/billing                  — personal quota view + plan table
 *   GET  /admin/billing                     — site admin: user list + overrides
 *   POST /admin/billing/:userId/plan        — set user's plan (audit-logged)
 *
 * All read operations degrade gracefully if the billing tables are empty
 * (FALLBACK_PLANS in lib/billing.ts mirror the seed rows). Plan assignment
 * is site-admin only; there is no self-service purchase flow here — that's
 * Stripe's job, and deliberately out-of-scope for the v1 panel.
 */

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { users, userQuotas } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";
import {
  formatPrice,
  getUserQuota,
  listPlans,
  setUserPlan,
} from "../lib/billing";

const billing = new Hono<AuthEnv>();
billing.use("*", softAuth);

// ----- Personal billing page -----

billing.get("/settings/billing", requireAuth, async (c) => {
  const user = c.get("user")!;
  const [quota, plans] = await Promise.all([
    getUserQuota(user.id),
    listPlans(),
  ]);

  const bar = (pct: number) => {
    const color = pct >= 90 ? "var(--red)" : pct >= 70 ? "#f0b72f" : "var(--green)";
    return (
      <div
        style="background:var(--bg-secondary);height:8px;border-radius:4px;overflow:hidden"
      >
        <div
          style={`width:${pct}%;height:100%;background:${color};transition:width .2s`}
        />
      </div>
    );
  };

  return c.html(
    <Layout title="Billing — Gluecron" user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>Billing & usage</h2>
        <a href="/settings" class="btn btn-sm">
          Back to settings
        </a>
      </div>

      <div class="panel" style="padding:16px;margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:12px;color:var(--text-muted);text-transform:uppercase">
              Current plan
            </div>
            <div style="font-size:22px;font-weight:700">{quota.plan.name}</div>
            <div style="font-size:13px;color:var(--text-muted)">
              {formatPrice(quota.plan.priceCents)}
            </div>
          </div>
          <div style="text-align:right;font-size:12px;color:var(--text-muted)">
            {quota.cycleStart
              ? `Cycle started ${new Date(quota.cycleStart).toLocaleDateString()}`
              : "No cycle recorded"}
          </div>
        </div>
      </div>

      <h3>Usage this cycle</h3>
      <div class="panel" style="padding:16px;margin-bottom:20px">
        <div class="form-group">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span>Storage</span>
            <span style="color:var(--text-muted);font-family:var(--font-mono)">
              {quota.usage.storageMbUsed} / {quota.plan.storageMbLimit} MB
            </span>
          </div>
          {bar(quota.percent.storage)}
        </div>
        <div class="form-group">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span>AI tokens (monthly)</span>
            <span style="color:var(--text-muted);font-family:var(--font-mono)">
              {quota.usage.aiTokensUsedThisMonth.toLocaleString()} /{" "}
              {quota.plan.aiTokensMonthly.toLocaleString()}
            </span>
          </div>
          {bar(quota.percent.aiTokens)}
        </div>
        <div class="form-group" style="margin-bottom:0">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span>Bandwidth (monthly)</span>
            <span style="color:var(--text-muted);font-family:var(--font-mono)">
              {quota.usage.bandwidthGbUsedThisMonth} /{" "}
              {quota.plan.bandwidthGbMonthly} GB
            </span>
          </div>
          {bar(quota.percent.bandwidth)}
        </div>
      </div>

      <h3>Available plans</h3>
      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px"
      >
        {plans.map((p) => {
          const isCurrent = p.slug === quota.planSlug;
          return (
            <div
              class="panel"
              style={`padding:16px${isCurrent ? ";border-color:var(--green)" : ""}`}
            >
              <div style="font-size:16px;font-weight:700">{p.name}</div>
              <div style="font-size:18px;margin:6px 0">
                {formatPrice(p.priceCents)}
              </div>
              <div style="font-size:12px;color:var(--text-muted);line-height:1.6">
                <div>{p.repoLimit.toLocaleString()} repos</div>
                <div>{p.storageMbLimit.toLocaleString()} MB storage</div>
                <div>{p.aiTokensMonthly.toLocaleString()} AI tokens/mo</div>
                <div>{p.bandwidthGbMonthly} GB bandwidth/mo</div>
                <div>
                  {p.privateRepos ? "Private repos ✓" : "Public repos only"}
                </div>
              </div>
              {isCurrent && (
                <div
                  style="margin-top:10px;font-size:11px;color:var(--green);font-weight:600"
                >
                  CURRENT PLAN
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin-top:12px">
        To change plans, contact a site administrator.
      </p>
    </Layout>
  );
});

// ----- Admin billing panel -----

billing.get("/admin/billing", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/billing");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="empty-state">
          <h2>403 — Not a site admin</h2>
        </div>
      </Layout>,
      403
    );
  }

  const plans = await listPlans();
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      planSlug: userQuotas.planSlug,
      storageMbUsed: userQuotas.storageMbUsed,
      aiTokensUsedThisMonth: userQuotas.aiTokensUsedThisMonth,
    })
    .from(users)
    .leftJoin(userQuotas, eq(users.id, userQuotas.userId))
    .orderBy(desc(users.createdAt))
    .limit(200);

  return c.html(
    <Layout title="Admin — Billing" user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>Billing — all users</h2>
        <a href="/admin" class="btn btn-sm">
          Back
        </a>
      </div>
      <div class="panel">
        {rows.length === 0 ? (
          <div class="panel-empty">No users.</div>
        ) : (
          rows.map((r) => (
            <div class="panel-item" style="justify-content:space-between">
              <div style="flex:1;min-width:0">
                <a href={`/${r.username}`} style="font-weight:600">
                  {r.username}
                </a>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
                  Plan: <strong>{r.planSlug || "free"}</strong> ·{" "}
                  {r.storageMbUsed || 0} MB ·{" "}
                  {(r.aiTokensUsedThisMonth || 0).toLocaleString()} tokens
                </div>
              </div>
              <form
                method="POST"
                action={`/admin/billing/${r.id}/plan`}
                style="display:flex;gap:6px;align-items:center"
              >
                <select name="slug" style="font-size:12px">
                  {plans.map((p) => (
                    <option
                      value={p.slug}
                      selected={(r.planSlug || "free") === p.slug}
                    >
                      {p.name}
                    </option>
                  ))}
                </select>
                <button type="submit" class="btn btn-sm">
                  Set
                </button>
              </form>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

billing.post("/admin/billing/:userId/plan", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/billing");
  if (!(await isSiteAdmin(user.id))) {
    return c.text("Forbidden", 403);
  }
  const userId = c.req.param("userId");
  const body = await c.req.parseBody();
  const slug = String(body.slug || "free");
  await setUserPlan(userId, slug);
  await audit({
    userId: user.id,
    action: "admin.billing.set_plan",
    targetType: "user",
    targetId: userId,
    metadata: { plan: slug },
  });
  return c.redirect("/admin/billing");
});

export default billing;
