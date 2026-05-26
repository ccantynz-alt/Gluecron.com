/**
 * Agent Marketplace — catalog + install + reviews.
 *
 * Third-party AI agents listed in a public catalog, one-click installable
 * per repo. Builds on `agent_sessions` (src/lib/agent-multiplayer.ts):
 * every install provisions a fresh agent session whose `branch_namespace`
 * and `budget_cents_per_day` are seeded from the listing's
 * `agent_template`. The one-time agent token is returned to the caller
 * exactly once, mirroring the PAT-issuance pattern.
 *
 * Revenue split: Gluecron takes 30%, publisher keeps 70%. The cut is a
 * pure helper (`splitRevenueCents`) so accounting tests can exercise it
 * without a DB. Actual payout is handled by the billing pipeline that
 * already reads `ai_cost_events`.
 *
 * All DB-touching helpers swallow errors and return `null`/`false`/`[]`
 * — same graceful-degradation pattern as `agent-multiplayer.ts`. Pure
 * format helpers (slug, price, gradient, category validation) run
 * without a DB so the test suite can drive them in isolation.
 */

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  agentMarketplaceListings,
  agentMarketplaceInstalls,
  agentMarketplaceReviews,
  users,
} from "../db/schema";
import type {
  AgentMarketplaceListing,
  AgentMarketplaceInstall,
  AgentMarketplaceReview,
} from "../db/schema";
import { createAgentSession, revokeAgentSession } from "./agent-multiplayer";
import type { CreateAgentSessionResult } from "./agent-multiplayer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MARKETPLACE_CATEGORIES = [
  "reviewer",
  "tester",
  "migrator",
  "security",
  "docs",
  "custom",
] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

export const PRICING_MODELS = [
  "per_invocation",
  "per_repo_per_month",
  "free",
] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const LISTING_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Gluecron's cut of paid invocations, in basis points (3000 = 30%). */
export const MARKETPLACE_REVENUE_SPLIT_BPS = 3000;

// ---------------------------------------------------------------------------
// Pure helpers (no DB)
// ---------------------------------------------------------------------------

/**
 * Normalise a free-form name to a URL-safe slug. Lower-case, alphanumeric +
 * dashes, cap at 60 chars. Mirrors `lib/marketplace.ts.slugify` but with a
 * longer cap because agent listings tend to have longer names.
 */
export function slugifyListing(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Format a `price_cents` integer as a display string per pricing model.
 * Free listings always render "Free" — we never show "$0" because that
 * looks broken in the catalog grid.
 */
export function formatPrice(
  priceCents: number,
  pricingModel: PricingModel | string
): string {
  if (pricingModel === "free" || priceCents <= 0) return "Free";
  const dollars = (priceCents / 100).toFixed(2);
  if (pricingModel === "per_repo_per_month") return `$${dollars}/repo/mo`;
  if (pricingModel === "per_invocation") return `$${dollars}/run`;
  return `$${dollars}`;
}

/** Whether `value` is a recognised category. Used to validate publisher input. */
export function isValidCategory(value: unknown): value is MarketplaceCategory {
  return (
    typeof value === "string" &&
    (MARKETPLACE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Whether `value` is a recognised pricing model. */
export function isValidPricingModel(value: unknown): value is PricingModel {
  return (
    typeof value === "string" &&
    (PRICING_MODELS as readonly string[]).includes(value)
  );
}

/**
 * Compute the platform/publisher split on a `price_cents` amount, in cents.
 * Rounds the platform cut down (favoring publishers when the cents don't
 * divide evenly). Pure — exercise from tests without a DB.
 */
export function splitRevenueCents(priceCents: number): {
  platformCents: number;
  publisherCents: number;
} {
  const amount = Math.max(0, Math.floor(priceCents));
  const platformCents = Math.floor(
    (amount * MARKETPLACE_REVENUE_SPLIT_BPS) / 10_000
  );
  return { platformCents, publisherCents: amount - platformCents };
}

/**
 * Deterministic gradient picker for the listing logo. Same input always
 * returns the same gradient so the catalog stays visually stable across
 * rebuilds. Mirrors the pattern in `routes/marketplace.tsx`.
 */
const LOGO_GRADIENTS = [
  "linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%)",
  "linear-gradient(135deg, #ec4899 0%, #f43f5e 100%)",
  "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)",
  "linear-gradient(135deg, #10b981 0%, #14b8a6 100%)",
  "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
  "linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)",
  "linear-gradient(135deg, #84cc16 0%, #22c55e 100%)",
  "linear-gradient(135deg, #f97316 0%, #fb7185 100%)",
];

export function gradientForSlug(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const idx =
    ((h % LOGO_GRADIENTS.length) + LOGO_GRADIENTS.length) %
    LOGO_GRADIENTS.length;
  return LOGO_GRADIENTS[idx]!;
}

export function listingInitials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Listing reads
// ---------------------------------------------------------------------------

export type ListListingsSort = "top" | "new" | "rated";

export interface ListListingsArgs {
  category?: string;
  search?: string;
  sort?: ListListingsSort;
  /** Default: only approved listings show in the public catalog. */
  status?: ListingStatus | "any";
  limit?: number;
}

/**
 * Public catalog query. Defaults to approved-only + sorted by install_count
 * desc. The admin moderation queue calls this with `status: "pending_review"`.
 */
export async function listListings(
  args: ListListingsArgs = {}
): Promise<AgentMarketplaceListing[]> {
  const limit = Math.min(200, Math.max(1, args.limit ?? 100));
  const sort: ListListingsSort = args.sort ?? "top";

  const where = [] as ReturnType<typeof eq>[];
  if (!args.status || args.status === "approved") {
    where.push(eq(agentMarketplaceListings.status, "approved"));
  } else if (args.status !== "any") {
    where.push(eq(agentMarketplaceListings.status, args.status));
  }
  if (args.category && isValidCategory(args.category)) {
    where.push(eq(agentMarketplaceListings.category, args.category));
  }
  if (args.search) {
    const term = `%${args.search}%`;
    const matchOr = or(
      ilike(agentMarketplaceListings.name, term),
      ilike(agentMarketplaceListings.tagline, term),
      ilike(agentMarketplaceListings.description, term)
    );
    if (matchOr) where.push(matchOr as ReturnType<typeof eq>);
  }

  const orderBy =
    sort === "new"
      ? desc(agentMarketplaceListings.createdAt)
      : sort === "rated"
      ? desc(agentMarketplaceListings.ratingAvg)
      : desc(agentMarketplaceListings.installCount);

  try {
    const rows = await db
      .select()
      .from(agentMarketplaceListings)
      .where(where.length ? and(...where) : undefined)
      .orderBy(orderBy)
      .limit(limit);
    return rows;
  } catch {
    return [];
  }
}

export interface ListingWithPublisher extends AgentMarketplaceListing {
  publisherUsername: string | null;
}

export interface ListingDetail {
  listing: ListingWithPublisher;
  reviews: Array<AgentMarketplaceReview & { reviewerUsername: string | null }>;
}

/**
 * Detail view — listing + publisher handle + 20 most-recent reviews with
 * the reviewer's username inlined. Returns null when the slug is unknown
 * or the DB call throws.
 */
export async function getListing(slug: string): Promise<ListingDetail | null> {
  try {
    const [row] = await db
      .select({
        listing: agentMarketplaceListings,
        publisherUsername: users.username,
      })
      .from(agentMarketplaceListings)
      .leftJoin(users, eq(users.id, agentMarketplaceListings.publisherUserId))
      .where(eq(agentMarketplaceListings.slug, slug))
      .limit(1);
    if (!row) return null;

    const reviewRows = await db
      .select({
        review: agentMarketplaceReviews,
        reviewerUsername: users.username,
      })
      .from(agentMarketplaceReviews)
      .leftJoin(users, eq(users.id, agentMarketplaceReviews.reviewerUserId))
      .where(eq(agentMarketplaceReviews.listingId, row.listing.id))
      .orderBy(desc(agentMarketplaceReviews.createdAt))
      .limit(20);

    return {
      listing: {
        ...row.listing,
        publisherUsername: row.publisherUsername,
      },
      reviews: reviewRows.map((r) => ({
        ...r.review,
        reviewerUsername: r.reviewerUsername,
      })),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listing writes
// ---------------------------------------------------------------------------

export interface CreateListingArgs {
  publisherUserId: string;
  name: string;
  tagline?: string;
  description?: string;
  category?: string;
  pricingModel?: string;
  priceCents?: number;
  agentTemplate?: Record<string, unknown>;
  sourceUrl?: string;
  /** Skip the pending_review state — only used by the seed script. */
  initialStatus?: ListingStatus;
}

/**
 * Create a draft listing. Slug is derived from `name`; retries on collision
 * with a short hex suffix. Publisher submissions land in `pending_review`
 * so a moderator can vet them; the seed path passes `initialStatus:
 * "approved"` for the four example listings.
 */
export async function createListing(
  args: CreateListingArgs
): Promise<AgentMarketplaceListing | null> {
  const name = args.name.trim();
  if (!name) return null;
  const category = isValidCategory(args.category)
    ? args.category
    : "custom";
  const pricingModel = isValidPricingModel(args.pricingModel)
    ? args.pricingModel
    : "free";
  const status: ListingStatus = args.initialStatus ?? "pending_review";
  const baseSlug = slugifyListing(name) || "agent";

  for (let attempt = 0; attempt < 6; attempt++) {
    const slug =
      attempt === 0
        ? baseSlug
        : `${baseSlug}-${Math.floor(Math.random() * 0xffff)
            .toString(16)
            .padStart(4, "0")}`;
    try {
      const [row] = await db
        .insert(agentMarketplaceListings)
        .values({
          publisherUserId: args.publisherUserId,
          slug,
          name,
          tagline: (args.tagline ?? "").slice(0, 280),
          description: args.description ?? "",
          category,
          pricingModel,
          priceCents: Math.max(0, Math.floor(args.priceCents ?? 0)),
          agentTemplate: (args.agentTemplate ?? {}) as never,
          sourceUrl: args.sourceUrl ?? null,
          status,
        })
        .returning();
      return row ?? null;
    } catch (err) {
      // 23505 unique violation on slug — retry with a fresh suffix.
      const code = (err as { code?: string } | undefined)?.code;
      if (code === "23505") continue;
      console.error("[agent-marketplace] createListing:", err);
      return null;
    }
  }
  return null;
}

/** Flip a listing to approved. Idempotent. */
export async function approveListing(
  slug: string,
  _moderatorUserId: string
): Promise<AgentMarketplaceListing | null> {
  try {
    const [row] = await db
      .update(agentMarketplaceListings)
      .set({ status: "approved", updatedAt: new Date() })
      .where(eq(agentMarketplaceListings.slug, slug))
      .returning();
    return row ?? null;
  } catch {
    return null;
  }
}

/** Flip a listing to rejected. Reason isn't persisted yet — surfaced via audit. */
export async function rejectListing(
  slug: string,
  _moderatorUserId: string,
  _reason: string
): Promise<AgentMarketplaceListing | null> {
  try {
    const [row] = await db
      .update(agentMarketplaceListings)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(agentMarketplaceListings.slug, slug))
      .returning();
    return row ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Installs
// ---------------------------------------------------------------------------

export interface InstallListingArgs {
  listingId: string;
  repositoryId: string;
  installedByUserId: string;
}

export interface InstallListingResult {
  install: AgentMarketplaceInstall;
  /** One-time agent token — store immediately, never retrievable again. */
  agentToken: string;
}

/**
 * Wire a listing onto a repo. Side-effects:
 *   1. Provisions a fresh `agent_session` seeded by the listing's
 *      `agent_template` (branchNamespace, budgetCentsPerDay).
 *   2. Inserts the link row. The UNIQUE (listing_id, repository_id) index
 *      ensures we can't double-install.
 *   3. Bumps `install_count`.
 *   4. Returns the plaintext agent token exactly once.
 *
 * On any failure after the session is created we attempt to revoke it so
 * we don't leak orphan agents.
 */
export async function installListing(
  args: InstallListingArgs
): Promise<InstallListingResult | null> {
  const listing = await fetchListingById(args.listingId);
  if (!listing || listing.status !== "approved") return null;

  const tpl = listing.agentTemplate ?? {};
  const sessionName =
    `mkt-${listing.slug}-${args.repositoryId.slice(0, 8)}`.slice(0, 60);
  const sess: CreateAgentSessionResult | null = await createAgentSession({
    ownerUserId: args.installedByUserId,
    name: sessionName,
    repositoryId: args.repositoryId,
    branchNamespace:
      typeof tpl.branchNamespace === "string"
        ? tpl.branchNamespace
        : `agents/${listing.slug}`,
    budgetCentsPerDay:
      typeof tpl.budgetCentsPerDay === "number" ? tpl.budgetCentsPerDay : 500,
  });
  if (!sess) return null;

  try {
    const [install] = await db
      .insert(agentMarketplaceInstalls)
      .values({
        listingId: args.listingId,
        repositoryId: args.repositoryId,
        installedByUserId: args.installedByUserId,
        agentSessionId: sess.session.id,
        status: "active",
      })
      .returning();
    if (!install) {
      await revokeAgentSession(sess.session.id, args.installedByUserId);
      return null;
    }
    // Bump the listing's install_count (best-effort).
    db.update(agentMarketplaceListings)
      .set({
        installCount: sql`${agentMarketplaceListings.installCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(agentMarketplaceListings.id, args.listingId))
      .catch(() => undefined);
    return { install, agentToken: sess.token };
  } catch (err) {
    // 23505 unique violation → already installed. Roll back the session.
    await revokeAgentSession(sess.session.id, args.installedByUserId);
    const code = (err as { code?: string } | undefined)?.code;
    if (code !== "23505") {
      console.error("[agent-marketplace] installListing:", err);
    }
    return null;
  }
}

/**
 * Flip an install to 'uninstalled' and revoke the underlying agent_session
 * so the agent's token immediately stops authenticating.
 */
export async function uninstallListing(args: {
  installId: string;
}): Promise<boolean> {
  try {
    const [row] = await db
      .update(agentMarketplaceInstalls)
      .set({ status: "uninstalled" })
      .where(eq(agentMarketplaceInstalls.id, args.installId))
      .returning();
    if (!row) return false;
    if (row.agentSessionId) {
      await revokeAgentSession(row.agentSessionId, row.installedByUserId);
    }
    return true;
  } catch {
    return false;
  }
}

export async function listInstallsForRepo(
  repositoryId: string
): Promise<AgentMarketplaceInstall[]> {
  try {
    return await db
      .select()
      .from(agentMarketplaceInstalls)
      .where(eq(agentMarketplaceInstalls.repositoryId, repositoryId))
      .orderBy(desc(agentMarketplaceInstalls.installedAt));
  } catch {
    return [];
  }
}

async function fetchListingById(
  id: string
): Promise<AgentMarketplaceListing | null> {
  try {
    const [row] = await db
      .select()
      .from(agentMarketplaceListings)
      .where(eq(agentMarketplaceListings.id, id))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/** Slug-form sibling of `fetchListingById`. Public — used by route handlers. */
export async function fetchListingBySlug(
  slug: string
): Promise<AgentMarketplaceListing | null> {
  try {
    const [row] = await db
      .select()
      .from(agentMarketplaceListings)
      .where(eq(agentMarketplaceListings.slug, slug))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export interface RecordReviewArgs {
  listingId: string;
  reviewerUserId: string;
  rating: number;
  body?: string;
}

/**
 * Insert a 1-5 rating + body, then recompute `rating_avg`/`rating_count`
 * for the listing. The aggregate update is a single SQL `AVG` so we
 * don't race against concurrent inserts.
 */
export async function recordReview(
  args: RecordReviewArgs
): Promise<AgentMarketplaceReview | null> {
  const rating = Math.max(1, Math.min(5, Math.floor(args.rating)));
  try {
    const [row] = await db
      .insert(agentMarketplaceReviews)
      .values({
        listingId: args.listingId,
        reviewerUserId: args.reviewerUserId,
        rating,
        body: (args.body ?? "").slice(0, 4000),
      })
      .returning();
    if (!row) return null;

    // Recompute aggregate from the source of truth — single round-trip.
    await db
      .update(agentMarketplaceListings)
      .set({
        ratingAvg: sql`(
          SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0)
          FROM ${agentMarketplaceReviews}
          WHERE ${agentMarketplaceReviews.listingId} = ${args.listingId}
        )`,
        ratingCount: sql`(
          SELECT COUNT(*)::int
          FROM ${agentMarketplaceReviews}
          WHERE ${agentMarketplaceReviews.listingId} = ${args.listingId}
        )`,
        updatedAt: new Date(),
      })
      .where(eq(agentMarketplaceListings.id, args.listingId));

    return row;
  } catch {
    return null;
  }
}
