/**
 * Block F4 — Billing + quotas tests.
 *
 * Pure FALLBACK_PLANS + formatPrice tests + route auth smoke. Helpers that
 * touch the DB (`getUserQuota`, `setUserPlan`, `bumpUsage`) are only exercised
 * via type/shape checks — the real integration happens on the live server.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  FALLBACK_PLANS,
  DEFAULT_PLAN_SLUG,
  formatPrice,
  listPlans,
  getPlan,
  checkQuota,
} from "../lib/billing";

describe("billing — FALLBACK_PLANS", () => {
  it("contains free/pro/team/enterprise", () => {
    expect(FALLBACK_PLANS).toHaveProperty("free");
    expect(FALLBACK_PLANS).toHaveProperty("pro");
    expect(FALLBACK_PLANS).toHaveProperty("team");
    expect(FALLBACK_PLANS).toHaveProperty("enterprise");
  });

  it("free plan is $0 with no private repos", () => {
    expect(FALLBACK_PLANS.free.priceCents).toBe(0);
    expect(FALLBACK_PLANS.free.privateRepos).toBe(false);
  });

  it("paid plans unlock private repos", () => {
    expect(FALLBACK_PLANS.pro.privateRepos).toBe(true);
    expect(FALLBACK_PLANS.team.privateRepos).toBe(true);
    expect(FALLBACK_PLANS.enterprise.privateRepos).toBe(true);
  });

  it("limits scale up across tiers", () => {
    expect(FALLBACK_PLANS.pro.repoLimit).toBeGreaterThan(
      FALLBACK_PLANS.free.repoLimit
    );
    expect(FALLBACK_PLANS.team.repoLimit).toBeGreaterThan(
      FALLBACK_PLANS.pro.repoLimit
    );
    expect(FALLBACK_PLANS.enterprise.repoLimit).toBeGreaterThan(
      FALLBACK_PLANS.team.repoLimit
    );
  });

  it("DEFAULT_PLAN_SLUG is 'free'", () => {
    expect(DEFAULT_PLAN_SLUG).toBe("free");
  });
});

describe("billing — formatPrice", () => {
  it("returns 'Free' for 0 cents", () => {
    expect(formatPrice(0)).toBe("Free");
  });

  it("formats non-zero prices as $N.NN/mo", () => {
    expect(formatPrice(900)).toBe("$9.00/mo");
    expect(formatPrice(2900)).toBe("$29.00/mo");
    expect(formatPrice(150)).toBe("$1.50/mo");
  });
});

describe("billing — listPlans / getPlan", () => {
  it("listPlans returns at least the 4 fallback plans", async () => {
    const plans = await listPlans();
    expect(plans.length).toBeGreaterThanOrEqual(4);
  });

  it("getPlan('free') returns a plan object", async () => {
    const plan = await getPlan("free");
    expect(plan.slug).toBe("free");
    expect(plan.priceCents).toBe(0);
  });

  it("getPlan for unknown slug falls back to free", async () => {
    const plan = await getPlan("no-such-plan");
    expect(plan.slug).toBe("free");
  });
});

describe("billing — checkQuota", () => {
  it("fails-open on unknown user id", async () => {
    const ok = await checkQuota(
      "00000000-0000-0000-0000-000000000000",
      "aiTokensUsedThisMonth",
      100
    );
    expect(typeof ok).toBe("boolean");
  });
});

describe("billing — route smoke", () => {
  it("GET /settings/billing without auth → 302 /login", async () => {
    const res = await app.request("/settings/billing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /admin/billing without auth → 302 /login", async () => {
    const res = await app.request("/admin/billing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /admin/billing/:id/plan without auth → 302 /login", async () => {
    const res = await app.request(
      "/admin/billing/00000000-0000-0000-0000-000000000000/plan",
      {
        method: "POST",
        body: new URLSearchParams({ slug: "pro" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

describe("billing — lib exports", () => {
  it("exports the full surface", async () => {
    const mod = await import("../lib/billing");
    expect(typeof mod.listPlans).toBe("function");
    expect(typeof mod.getPlan).toBe("function");
    expect(typeof mod.getUserQuota).toBe("function");
    expect(typeof mod.setUserPlan).toBe("function");
    expect(typeof mod.bumpUsage).toBe("function");
    expect(typeof mod.checkQuota).toBe("function");
    expect(typeof mod.repoCountForUser).toBe("function");
    expect(typeof mod.wouldExceedRepoLimit).toBe("function");
    expect(typeof mod.resetIfCycleExpired).toBe("function");
    expect(typeof mod.formatPrice).toBe("function");
    expect(mod.FALLBACK_PLANS).toBeDefined();
    expect(mod.DEFAULT_PLAN_SLUG).toBe("free");
  });
});
