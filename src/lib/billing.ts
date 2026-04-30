/**
 * Block F4 — Billing + quotas.
 *
 * Plans live in `billing_plans` (seeded with free/pro/team/enterprise by
 * migration 0020). Each user has a row in `user_quotas` keyed by
 * `plan_slug` + running usage counters (storage, AI tokens, bandwidth).
 *
 *   getPlan(slug)                       — load a plan by slug
 *   getUserQuota(userId)                — row + plan join, initialises on first read
 *   listPlans()                         — admin UI
 *   setUserPlan(userId, slug, byId)     — admin override (audit-logged outside)
 *   bumpUsage(userId, field, delta)     — fire-and-forget counter increment
 *   checkQuota(userId, field, amount)   — boolean "allowed?" for pre-write gating
 *   repoCountForUser(userId)            — counts owned repos (enforced at create)
 *   resetIfCycleExpired(userId)         — flips cycleStart each month
 *
 * All helpers swallow DB errors (plan goes to "free" on failure) so billing is
 * never a hard dependency for the primary request path.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  billingPlans,
  userQuotas,
  repositories,
  type BillingPlan,
  type UserQuota,
} from "../db/schema";

export const DEFAULT_PLAN_SLUG = "free";

/** Mirrors the seed rows in migration 0020 so billing works even pre-migration. */
export const FALLBACK_PLANS: Record<string, Omit<BillingPlan, "id" | "createdAt">> = {
  free: {
    slug: "free",
    name: "Free",
    priceCents: 0,
    repoLimit: 5,
    storageMbLimit: 500,
    aiTokensMonthly: 50_000,
    bandwidthGbMonthly: 5,
    privateRepos: false,
  },
  pro: {
    slug: "pro",
    name: "Pro",
    priceCents: 900,
    repoLimit: 50,
    storageMbLimit: 5_000,
    aiTokensMonthly: 500_000,
    bandwidthGbMonthly: 50,
    privateRepos: true,
  },
  team: {
    slug: "team",
    name: "Team",
    priceCents: 2900,
    repoLimit: 200,
    storageMbLimit: 20_000,
    aiTokensMonthly: 2_000_000,
    bandwidthGbMonthly: 200,
    privateRepos: true,
  },
  enterprise: {
    slug: "enterprise",
    name: "Enterprise",
    priceCents: 9900,
    repoLimit: 10_000,
    storageMbLimit: 500_000,
    aiTokensMonthly: 50_000_000,
    bandwidthGbMonthly: 5_000,
    privateRepos: true,
  },
};

export async function listPlans(): Promise<
  Array<Omit<BillingPlan, "id" | "createdAt">>
> {
  try {
    const rows = await db.select().from(billingPlans).orderBy(billingPlans.priceCents);
    if (rows.length > 0) return rows;
  } catch {
    // fall through
  }
  return Object.values(FALLBACK_PLANS);
}

export async function getPlan(
  slug: string
): Promise<Omit<BillingPlan, "id" | "createdAt">> {
  try {
    const [row] = await db
      .select()
      .from(billingPlans)
      .where(eq(billingPlans.slug, slug))
      .limit(1);
    if (row) return row;
  } catch {
    // fall through
  }
  return FALLBACK_PLANS[slug] || FALLBACK_PLANS.free;
}

export type QuotaField =
  | "storageMbUsed"
  | "aiTokensUsedThisMonth"
  | "bandwidthGbUsedThisMonth";

export interface QuotaView {
  planSlug: string;
  plan: Omit<BillingPlan, "id" | "createdAt">;
  usage: {
    storageMbUsed: number;
    aiTokensUsedThisMonth: number;
    bandwidthGbUsedThisMonth: number;
  };
  cycleStart: Date | null;
  /** Stripe linkage — populated once the user completes a checkout session. */
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  percent: {
    storage: number;
    aiTokens: number;
    bandwidth: number;
  };
}

/** Loads the quota row, inserting a free-plan row on first read. */
export async function getUserQuota(userId: string): Promise<QuotaView> {
  let row: UserQuota | undefined;
  try {
    const [r] = await db
      .select()
      .from(userQuotas)
      .where(eq(userQuotas.userId, userId))
      .limit(1);
    row = r;
    if (!row) {
      await db
        .insert(userQuotas)
        .values({ userId, planSlug: DEFAULT_PLAN_SLUG })
        .onConflictDoNothing();
      const [r2] = await db
        .select()
        .from(userQuotas)
        .where(eq(userQuotas.userId, userId))
        .limit(1);
      row = r2;
    }
  } catch {
    // fall through
  }

  const planSlug = row?.planSlug || DEFAULT_PLAN_SLUG;
  const plan = await getPlan(planSlug);
  const usage = {
    storageMbUsed: row?.storageMbUsed || 0,
    aiTokensUsedThisMonth: row?.aiTokensUsedThisMonth || 0,
    bandwidthGbUsedThisMonth: row?.bandwidthGbUsedThisMonth || 0,
  };
  const pct = (used: number, limit: number) =>
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return {
    planSlug,
    plan,
    usage,
    cycleStart: (row?.cycleStart as Date | null) || null,
    stripeCustomerId: (row?.stripeCustomerId as string | null) || null,
    stripeSubscriptionId: (row?.stripeSubscriptionId as string | null) || null,
    stripeSubscriptionStatus:
      (row?.stripeSubscriptionStatus as string | null) || null,
    currentPeriodEnd: (row?.currentPeriodEnd as Date | null) || null,
    percent: {
      storage: pct(usage.storageMbUsed, plan.storageMbLimit),
      aiTokens: pct(usage.aiTokensUsedThisMonth, plan.aiTokensMonthly),
      bandwidth: pct(usage.bandwidthGbUsedThisMonth, plan.bandwidthGbMonthly),
    },
  };
}

export async function setUserPlan(
  userId: string,
  planSlug: string
): Promise<boolean> {
  try {
    await db
      .insert(userQuotas)
      .values({ userId, planSlug })
      .onConflictDoUpdate({
        target: userQuotas.userId,
        set: { planSlug, updatedAt: new Date() },
      });
    return true;
  } catch (err) {
    console.error("[billing] setUserPlan:", err);
    return false;
  }
}

/** Fire-and-forget counter bump. Returns the new value on success. */
export async function bumpUsage(
  userId: string,
  field: QuotaField,
  delta: number
): Promise<number | null> {
  if (!userId || delta === 0) return null;
  const column =
    field === "storageMbUsed"
      ? userQuotas.storageMbUsed
      : field === "aiTokensUsedThisMonth"
      ? userQuotas.aiTokensUsedThisMonth
      : userQuotas.bandwidthGbUsedThisMonth;
  try {
    await db
      .insert(userQuotas)
      .values({
        userId,
        planSlug: DEFAULT_PLAN_SLUG,
        [field]: delta,
      } as any)
      .onConflictDoUpdate({
        target: userQuotas.userId,
        set: {
          [field]: sql`${column} + ${delta}`,
          updatedAt: new Date(),
        } as any,
      });
    const [r] = await db
      .select({ n: column })
      .from(userQuotas)
      .where(eq(userQuotas.userId, userId))
      .limit(1);
    return Number(r?.n || 0);
  } catch (err) {
    console.error("[billing] bumpUsage:", err);
    return null;
  }
}

/** True if the user has budget left for an action costing `amount` against `field`. */
export async function checkQuota(
  userId: string,
  field: QuotaField,
  amount: number = 1
): Promise<boolean> {
  try {
    const { plan, usage } = await getUserQuota(userId);
    if (field === "storageMbUsed")
      return usage.storageMbUsed + amount <= plan.storageMbLimit;
    if (field === "aiTokensUsedThisMonth")
      return usage.aiTokensUsedThisMonth + amount <= plan.aiTokensMonthly;
    if (field === "bandwidthGbUsedThisMonth")
      return usage.bandwidthGbUsedThisMonth + amount <= plan.bandwidthGbMonthly;
    return true;
  } catch {
    return true; // fail-open on billing errors
  }
}

export async function repoCountForUser(userId: string): Promise<number> {
  try {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(repositories)
      .where(eq(repositories.ownerId, userId));
    return Number(r?.n || 0);
  } catch {
    return 0;
  }
}

/** True if creating another repo would exceed the plan's repoLimit. */
export async function wouldExceedRepoLimit(userId: string): Promise<boolean> {
  try {
    const [quota, count] = await Promise.all([
      getUserQuota(userId),
      repoCountForUser(userId),
    ]);
    return count >= quota.plan.repoLimit;
  } catch {
    return false;
  }
}

/** Resets monthly counters if >30 days have passed since cycleStart. */
export async function resetIfCycleExpired(userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ cycleStart: userQuotas.cycleStart })
      .from(userQuotas)
      .where(eq(userQuotas.userId, userId))
      .limit(1);
    if (!row?.cycleStart) return false;
    const age = Date.now() - new Date(row.cycleStart).getTime();
    if (age < 30 * 24 * 60 * 60 * 1000) return false;
    await db
      .update(userQuotas)
      .set({
        aiTokensUsedThisMonth: 0,
        bandwidthGbUsedThisMonth: 0,
        cycleStart: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userQuotas.userId, userId));
    return true;
  } catch {
    return false;
  }
}

export function formatPrice(cents: number): string {
  if (cents === 0) return "Free";
  return `$${(cents / 100).toFixed(2)}/mo`;
}
