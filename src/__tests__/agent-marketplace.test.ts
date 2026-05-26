/**
 * Agent marketplace — listings catalog, install flow, reviews.
 *
 * Two layers, same shape as agent-multiplayer.test.ts:
 *   - Pure helpers (slug, price, gradient, revenue split, category guard)
 *     run unconditionally — no DB required.
 *   - DB-backed flows (listListings filters/sort, installListing wiring,
 *     review insert + rating aggregation) are gated behind `HAS_DB`.
 */

import { describe, it, expect } from "bun:test";
import { randomBytes } from "crypto";
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_REVENUE_SPLIT_BPS,
  formatPrice,
  gradientForSlug,
  isValidCategory,
  isValidPricingModel,
  listingInitials,
  slugifyListing,
  splitRevenueCents,
} from "../lib/agent-marketplace";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("agent-marketplace — pure helpers", () => {
  it("slugifyListing lower-cases, dashes, caps at 60 chars", () => {
    expect(slugifyListing("Gluecron AI Reviewer")).toBe("gluecron-ai-reviewer");
    expect(slugifyListing("  Test  Generator  Bot ")).toBe(
      "test-generator-bot"
    );
    expect(slugifyListing("Docs! & Drift?? Watcher 99")).toBe(
      "docs-drift-watcher-99"
    );
    const long = "a".repeat(120);
    expect(slugifyListing(long).length).toBe(60);
    expect(slugifyListing("  --- ")).toBe("");
  });

  it("formatPrice renders 'Free' for free listings even when price > 0", () => {
    expect(formatPrice(0, "free")).toBe("Free");
    expect(formatPrice(500, "free")).toBe("Free");
    expect(formatPrice(0, "per_invocation")).toBe("Free");
    expect(formatPrice(125, "per_invocation")).toBe("$1.25/run");
    expect(formatPrice(500, "per_repo_per_month")).toBe("$5.00/repo/mo");
    expect(formatPrice(999, "per_invocation")).toBe("$9.99/run");
  });

  it("isValidCategory + isValidPricingModel guard the closed vocabularies", () => {
    expect(isValidCategory("reviewer")).toBe(true);
    expect(isValidCategory("security")).toBe(true);
    expect(isValidCategory("CUSTOM")).toBe(false); // case-sensitive
    expect(isValidCategory("malware")).toBe(false);
    expect(isValidCategory(123)).toBe(false);

    expect(isValidPricingModel("free")).toBe(true);
    expect(isValidPricingModel("per_invocation")).toBe(true);
    expect(isValidPricingModel("monthly")).toBe(false);
  });

  it("splitRevenueCents takes 30% to platform, 70% to publisher", () => {
    expect(MARKETPLACE_REVENUE_SPLIT_BPS).toBe(3000);
    expect(splitRevenueCents(0)).toEqual({
      platformCents: 0,
      publisherCents: 0,
    });
    expect(splitRevenueCents(100)).toEqual({
      platformCents: 30,
      publisherCents: 70,
    });
    expect(splitRevenueCents(1000)).toEqual({
      platformCents: 300,
      publisherCents: 700,
    });
    // Uneven cents — platform rounds down so publisher keeps the dust.
    const r = splitRevenueCents(33);
    expect(r.platformCents + r.publisherCents).toBe(33);
    expect(r.platformCents).toBeLessThanOrEqual(10);
  });

  it("gradientForSlug is deterministic + within the palette", () => {
    const a = gradientForSlug("foo-bar");
    const b = gradientForSlug("foo-bar");
    expect(a).toBe(b);
    expect(a.startsWith("linear-gradient")).toBe(true);
  });

  it("listingInitials picks two-word initials, falls back to first 2 chars", () => {
    expect(listingInitials("Gluecron AI Reviewer")).toBe("GA");
    expect(listingInitials("test-generator-bot")).toBe("TG");
    expect(listingInitials("Docs")).toBe("DO");
  });

  it("MARKETPLACE_CATEGORIES contains the six advertised values", () => {
    expect(MARKETPLACE_CATEGORIES).toEqual([
      "reviewer",
      "tester",
      "migrator",
      "security",
      "docs",
      "custom",
    ]);
  });
});

// ---------------------------------------------------------------------------
// DB-backed flows
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("agent-marketplace — DB flows", () => {
  it("listListings filters by category + sorts", async () => {
    const { db } = await import("../db");
    const { users, agentMarketplaceListings } = await import("../db/schema");
    const { listListings, createListing, approveListing } = await import(
      "../lib/agent-marketplace"
    );

    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `pub-${stamp}`,
        email: `pub-${stamp}@example.com`,
        passwordHash: "x",
      })
      .returning();
    if (!u) throw new Error("user insert failed");

    const a = await createListing({
      publisherUserId: u.id,
      name: `Reviewer ${stamp} A`,
      category: "reviewer",
      initialStatus: "approved",
    });
    const b = await createListing({
      publisherUserId: u.id,
      name: `Tester ${stamp} B`,
      category: "tester",
      initialStatus: "approved",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const reviewers = await listListings({ category: "reviewer" });
    const reviewerSlugs = reviewers.map((r) => r.slug);
    expect(reviewerSlugs).toContain(a!.slug);
    expect(reviewerSlugs).not.toContain(b!.slug);

    // sort=new should land the most-recently-created at the top within
    // the current creation window — verify ordering relation only.
    const newest = await listListings({ sort: "new" });
    const aIdx = newest.findIndex((r) => r.slug === a!.slug);
    const bIdx = newest.findIndex((r) => r.slug === b!.slug);
    if (aIdx >= 0 && bIdx >= 0) {
      // b was created after a, so b should appear at or before a.
      expect(bIdx).toBeLessThanOrEqual(aIdx);
    }

    // search hits tagline + name (case-insensitive ilike).
    const searched = await listListings({ search: stamp });
    expect(searched.length).toBeGreaterThanOrEqual(2);

    // status filter: pending_review listings are hidden by default.
    const hidden = await createListing({
      publisherUserId: u.id,
      name: `Pending ${stamp}`,
      category: "custom",
    });
    expect(hidden).not.toBeNull();
    expect(hidden!.status).toBe("pending_review");
    const approved = await listListings({ search: stamp });
    expect(approved.find((r) => r.slug === hidden!.slug)).toBeUndefined();
    const all = await listListings({ search: stamp, status: "any" });
    expect(all.find((r) => r.slug === hidden!.slug)).toBeDefined();

    // approveListing flips status
    const flipped = await approveListing(hidden!.slug, u.id);
    expect(flipped?.status).toBe("approved");

    // cleanup
    await db
      .delete(agentMarketplaceListings)
      .where(eq(agentMarketplaceListings.publisherUserId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  });

  it("installListing creates an agent_session with the listing's namespace", async () => {
    const { db } = await import("../db");
    const {
      users,
      repositories,
      agentSessions,
      agentMarketplaceListings,
      agentMarketplaceInstalls,
    } = await import("../db/schema");
    const { createListing, installListing, uninstallListing } = await import(
      "../lib/agent-marketplace"
    );

    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `inst-${stamp}`,
        email: `inst-${stamp}@example.com`,
        passwordHash: "x",
      })
      .returning();
    if (!u) throw new Error("user insert failed");

    const [repo] = await db
      .insert(repositories)
      .values({
        name: `r-${stamp}`,
        ownerId: u.id,
        diskPath: `/tmp/r-${stamp}`,
      })
      .returning();
    if (!repo) throw new Error("repo insert failed");

    const listing = await createListing({
      publisherUserId: u.id,
      name: `Installable ${stamp}`,
      category: "reviewer",
      initialStatus: "approved",
      agentTemplate: {
        branchNamespace: `agents/marketplace-${stamp}`,
        budgetCentsPerDay: 750,
      },
    });
    if (!listing) throw new Error("listing insert failed");

    const result = await installListing({
      listingId: listing.id,
      repositoryId: repo.id,
      installedByUserId: u.id,
    });
    expect(result).not.toBeNull();
    expect(result!.agentToken.startsWith("agt_")).toBe(true);
    expect(result!.install.agentSessionId).toBeTruthy();

    const [sess] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result!.install.agentSessionId!))
      .limit(1);
    expect(sess).toBeDefined();
    expect(sess!.budgetCentsPerDay).toBe(750);
    expect(sess!.branchNamespace).toBe(`agents/marketplace-${stamp}/`);
    expect(sess!.repositoryId).toBe(repo.id);

    // Second install on the same repo must be rejected by the unique index.
    const dup = await installListing({
      listingId: listing.id,
      repositoryId: repo.id,
      installedByUserId: u.id,
    });
    expect(dup).toBeNull();

    // Uninstall revokes the agent_session.
    const ok = await uninstallListing({ installId: result!.install.id });
    expect(ok).toBe(true);
    const [sessAfter] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result!.install.agentSessionId!))
      .limit(1);
    expect(sessAfter).toBeUndefined();

    // cleanup
    await db
      .delete(agentMarketplaceInstalls)
      .where(eq(agentMarketplaceInstalls.listingId, listing.id));
    await db
      .delete(agentMarketplaceListings)
      .where(eq(agentMarketplaceListings.id, listing.id));
    await db.delete(repositories).where(eq(repositories.id, repo.id));
    await db.delete(users).where(eq(users.id, u.id));
  });

  it("recordReview inserts the row and updates rating_avg / rating_count", async () => {
    const { db } = await import("../db");
    const { users, agentMarketplaceListings, agentMarketplaceReviews } =
      await import("../db/schema");
    const { createListing, recordReview, getListing } = await import(
      "../lib/agent-marketplace"
    );

    const stamp = randomBytes(4).toString("hex");
    const [pub] = await db
      .insert(users)
      .values({
        username: `rev-pub-${stamp}`,
        email: `rev-pub-${stamp}@example.com`,
        passwordHash: "x",
      })
      .returning();
    const [r1] = await db
      .insert(users)
      .values({
        username: `rev-r1-${stamp}`,
        email: `rev-r1-${stamp}@example.com`,
        passwordHash: "x",
      })
      .returning();
    const [r2] = await db
      .insert(users)
      .values({
        username: `rev-r2-${stamp}`,
        email: `rev-r2-${stamp}@example.com`,
        passwordHash: "x",
      })
      .returning();
    if (!pub || !r1 || !r2) throw new Error("user insert failed");

    const listing = await createListing({
      publisherUserId: pub.id,
      name: `Reviewable ${stamp}`,
      category: "tester",
      initialStatus: "approved",
    });
    if (!listing) throw new Error("listing insert failed");

    const a = await recordReview({
      listingId: listing.id,
      reviewerUserId: r1.id,
      rating: 5,
      body: "great",
    });
    expect(a).not.toBeNull();
    expect(a!.rating).toBe(5);

    const b = await recordReview({
      listingId: listing.id,
      reviewerUserId: r2.id,
      rating: 3,
      body: "ok",
    });
    expect(b).not.toBeNull();

    // Out-of-range ratings clamp into [1..5].
    const clamped = await recordReview({
      listingId: listing.id,
      reviewerUserId: r2.id,
      rating: 99,
      body: "loud",
    });
    expect(clamped!.rating).toBe(5);

    const detail = await getListing(listing.slug);
    expect(detail).not.toBeNull();
    expect(detail!.listing.ratingCount).toBe(3);
    // (5 + 3 + 5) / 3 = 4.33
    expect(Number(detail!.listing.ratingAvg)).toBeCloseTo(4.33, 1);
    expect(detail!.reviews.length).toBe(3);

    // cleanup
    await db
      .delete(agentMarketplaceReviews)
      .where(eq(agentMarketplaceReviews.listingId, listing.id));
    await db
      .delete(agentMarketplaceListings)
      .where(eq(agentMarketplaceListings.id, listing.id));
    await db.delete(users).where(eq(users.id, r1.id));
    await db.delete(users).where(eq(users.id, r2.id));
    await db.delete(users).where(eq(users.id, pub.id));
  });
});

// Imported at the bottom so the no-DB pure block above doesn't pull drizzle.
import { eq } from "drizzle-orm";
