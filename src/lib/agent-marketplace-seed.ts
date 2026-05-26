/**
 * Seed the agent marketplace with 4 example, admin-published listings on
 * first boot. Idempotent — runs SELECT first and bails when any of the
 * canonical slugs is already in the DB. Designed to fire-and-forget from
 * `src/index.ts`; never throws past its own boundary.
 *
 * The listings wrap existing in-tree AI helpers:
 *   - "Gluecron AI Reviewer"  → ai-review-trio
 *   - "Test Generator Bot"    → ai-test-generator
 *   - "Doc Drift Watcher"     → ai-doc-updater
 *   - "Security Patrol"       → ai-patch-generator (weekly cadence)
 *
 * Publisher: the bootstrap admin (first user / SITE_ADMIN_USERNAME). When
 * no admin exists yet we skip — the seed will pick up on a later boot.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentMarketplaceListings, users } from "../db/schema";
import { getEnvAdminUsername } from "./admin-bootstrap";
import { createListing } from "./agent-marketplace";

interface SeedListing {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: "reviewer" | "tester" | "docs" | "security";
  pricingModel: "free" | "per_invocation" | "per_repo_per_month";
  priceCents: number;
  agentTemplate: Record<string, unknown>;
  sourceUrl?: string;
}

const SEEDS: SeedListing[] = [
  {
    slug: "gluecron-ai-reviewer",
    name: "Gluecron AI Reviewer",
    tagline:
      "The official trio-review pass — security, correctness, style — on every PR.",
    description:
      "Runs the built-in `ai-review-trio` pipeline on every pull request. " +
      "Three specialised passes (security, correctness, style) land as " +
      "inline comments on the diff. Same agent the Gluecron team uses on " +
      "its own monorepo.\n\n" +
      "**Capabilities:** `pr:read`, `pr:comment:write`.\n",
    category: "reviewer",
    pricingModel: "per_invocation",
    priceCents: 25,
    agentTemplate: {
      branchNamespace: "agents/ai-reviewer",
      budgetCentsPerDay: 1000,
      capabilities: ["pr:read", "pr:comment:write"],
      handler: "ai-review-trio",
    },
    sourceUrl: "https://gluecron.com/ccantynz/Gluecron.com/blob/main/src/lib/ai-review-trio.ts",
  },
  {
    slug: "test-generator-bot",
    name: "Test Generator Bot",
    tagline:
      "Auto-writes failing tests for every uncovered function in a PR diff.",
    description:
      "Scans the PR diff, finds functions without test coverage, and opens " +
      "a follow-up PR with generated unit tests. Backed by " +
      "`ai-test-generator` — the same engine that powers the autopilot " +
      "weekly test-gen sweep.\n",
    category: "tester",
    pricingModel: "per_invocation",
    priceCents: 35,
    agentTemplate: {
      branchNamespace: "agents/test-gen",
      budgetCentsPerDay: 1500,
      capabilities: ["pr:read", "repo:write"],
      handler: "ai-test-generator",
    },
    sourceUrl: "https://gluecron.com/ccantynz/Gluecron.com/blob/main/src/lib/ai-test-generator.ts",
  },
  {
    slug: "doc-drift-watcher",
    name: "Doc Drift Watcher",
    tagline:
      "Spots when code changes drift from docstrings and opens a doc-update PR.",
    description:
      "Watches every push and flags doc drift — functions whose " +
      "implementation has changed but whose docstring hasn't. Opens a " +
      "follow-up PR with the proposed doc update. Wraps " +
      "`ai-doc-updater`.\n",
    category: "docs",
    pricingModel: "free",
    priceCents: 0,
    agentTemplate: {
      branchNamespace: "agents/doc-drift",
      budgetCentsPerDay: 500,
      capabilities: ["repo:read", "pr:write"],
      handler: "ai-doc-updater",
    },
    sourceUrl: "https://gluecron.com/ccantynz/Gluecron.com/blob/main/src/lib/ai-doc-updater.ts",
  },
  {
    slug: "security-patrol",
    name: "Security Patrol",
    tagline:
      "Weekly automated security scan + patch PRs for known CVEs in your deps.",
    description:
      "Runs once a week on a per-repo cadence. Scans your dependency " +
      "tree for known CVEs (via the advisories DB), then opens a patch " +
      "PR with the minimum-viable bump. Wraps `ai-patch-generator`.\n",
    category: "security",
    pricingModel: "per_repo_per_month",
    priceCents: 500,
    agentTemplate: {
      branchNamespace: "agents/security-patrol",
      budgetCentsPerDay: 2000,
      capabilities: ["repo:read", "pr:write"],
      handler: "ai-patch-generator",
      cadence: "weekly",
    },
    sourceUrl: "https://gluecron.com/ccantynz/Gluecron.com/blob/main/src/lib/ai-patch-generator.ts",
  },
];

/**
 * Idempotent seed. Returns the number of new listings inserted. Skips
 * silently when no admin user exists yet (so the very first boot of a
 * fresh DB doesn't error).
 */
export async function ensureMarketplaceSeed(): Promise<number> {
  let publisher: { id: string } | null = null;
  try {
    // Prefer the env-configured site admin if set, else oldest user.
    const envAdminName = getEnvAdminUsername();
    if (envAdminName) {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, envAdminName))
        .limit(1);
      if (row) publisher = row;
    }
    if (!publisher) {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .orderBy(users.createdAt)
        .limit(1);
      if (row) publisher = row;
    }
  } catch {
    return 0;
  }
  if (!publisher) return 0;

  let inserted = 0;
  for (const seed of SEEDS) {
    try {
      const [existing] = await db
        .select({ id: agentMarketplaceListings.id })
        .from(agentMarketplaceListings)
        .where(eq(agentMarketplaceListings.slug, seed.slug))
        .limit(1);
      if (existing) continue;
      const row = await createListing({
        publisherUserId: publisher.id,
        name: seed.name,
        tagline: seed.tagline,
        description: seed.description,
        category: seed.category,
        pricingModel: seed.pricingModel,
        priceCents: seed.priceCents,
        agentTemplate: seed.agentTemplate,
        sourceUrl: seed.sourceUrl,
        initialStatus: "approved",
      });
      if (row) {
        // createListing sometimes invents a hex suffix on slug conflict; force
        // the canonical slug back so subsequent runs see "already exists".
        if (row.slug !== seed.slug) {
          await db
            .update(agentMarketplaceListings)
            .set({ slug: seed.slug })
            .where(eq(agentMarketplaceListings.id, row.id))
            .catch(() => undefined);
        }
        inserted++;
      }
    } catch (err) {
      console.warn(
        `[agent-marketplace-seed] ${seed.slug} skipped:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  if (inserted > 0) {
    console.log(`[agent-marketplace-seed] inserted ${inserted} listing(s)`);
  }
  return inserted;
}
