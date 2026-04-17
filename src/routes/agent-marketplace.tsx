/**
 * Block K10 — Agent Marketplace.
 *
 * Publisher-curated directory of installable K-agents. Each listing is a
 * thin pointer to an existing agent app (via `app_bots`) so installs reuse
 * the mature K2 / Block H agent-identity flow.
 *
 * ROUTES
 *   GET  /marketplace/agents                     public directory
 *   GET  /marketplace/agents/:slug               detail + install form (auth'd)
 *   POST /marketplace/agents/:slug/install       auth; install into a repo owned by user
 *   POST /marketplace/agents/:slug/uninstall     auth; uninstall
 *   GET  /settings/agent-listings                publisher dashboard
 *   POST /settings/agent-listings                create listing (unpublished)
 *   POST /settings/agent-listings/:id/publish    site-admin; publish
 *   POST /settings/agent-listings/:id/unpublish  site-admin; unpublish
 *   GET  /admin/marketplace/agents               site-admin; all listings
 *
 * DATA
 *   marketplace_agent_listings (migration 0037). `sql\`...\`` raw queries
 *   here so this file works before the schema.ts edit lands — matches the
 *   `agents.tsx` defensive pattern.
 */

import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { apps, appBots, appInstallations, repositories, users } from "../db/schema";
import {
  ensureAgentApp,
  installAgentForRepo,
  uninstallAgent,
  AGENT_PERMISSIONS,
} from "../lib/agent-identity";
import { isSiteAdmin } from "../lib/admin";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

export const ALLOWED_LISTING_KINDS = [
  "triage",
  "fix",
  "review",
  "heal_bot",
  "deploy_watch",
  "custom",
] as const;

export type ListingKind = (typeof ALLOWED_LISTING_KINDS)[number];

export const SLUG_RE = /^[a-z][a-z0-9-]{2,48}$/;
export const TAGLINE_MAX = 200;
export const DESCRIPTION_MAX = 5000;
export const PRICING_MAX_CENTS = 100_000; // $1000/mo hard cap

export interface ListingFormInput {
  slug?: string;
  name?: string;
  tagline?: string;
  description?: string;
  kind?: string;
  homepage_url?: string;
  icon_url?: string;
  pricing_cents_per_month?: string;
}

export interface ParsedListing {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  kind: ListingKind;
  homepageUrl: string | null;
  iconUrl: string | null;
  pricingCentsPerMonth: number;
}

export type ParseListingResult =
  | { ok: true; data: ParsedListing }
  | { ok: false; error: string };

export function parseListingForm(input: ListingFormInput): ParseListingResult {
  const slug = String(input.slug ?? "").trim();
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      error: "slug must match ^[a-z][a-z0-9-]{2,48}$",
    };
  }

  const name = String(input.name ?? "").trim();
  if (!name || name.length > 100) {
    return { ok: false, error: "name is required and must be ≤100 chars" };
  }

  const tagline = String(input.tagline ?? "").trim();
  if (!tagline) return { ok: false, error: "tagline is required" };
  if (tagline.length > TAGLINE_MAX) {
    return { ok: false, error: `tagline must be ≤${TAGLINE_MAX} chars` };
  }

  const description = String(input.description ?? "").slice(0, DESCRIPTION_MAX);

  const kindRaw = String(input.kind ?? "").trim();
  if (!(ALLOWED_LISTING_KINDS as readonly string[]).includes(kindRaw)) {
    return {
      ok: false,
      error: `kind must be one of: ${ALLOWED_LISTING_KINDS.join(", ")}`,
    };
  }
  const kind = kindRaw as ListingKind;

  const homepageUrl = normaliseUrl(input.homepage_url);
  const iconUrl = normaliseUrl(input.icon_url);

  const pricingRaw = Number.parseInt(
    String(input.pricing_cents_per_month ?? "0"),
    10
  );
  if (!Number.isFinite(pricingRaw) || pricingRaw < 0) {
    return { ok: false, error: "pricing must be a non-negative integer" };
  }
  const pricingCentsPerMonth = Math.min(pricingRaw, PRICING_MAX_CENTS);

  return {
    ok: true,
    data: {
      slug,
      name,
      tagline,
      description,
      kind,
      homepageUrl,
      iconUrl,
      pricingCentsPerMonth,
    },
  };
}

function normaliseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) return null;
  if (v.length > 500) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Raw-SQL DB helpers (work before schema.ts gets the Drizzle table added)
// ---------------------------------------------------------------------------

interface ListingRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  publisherUserId: string | null;
  appBotId: string;
  kind: string;
  homepageUrl: string | null;
  iconUrl: string | null;
  pricingCentsPerMonth: number;
  published: boolean;
  installCount: number;
  createdAt: Date;
}

function coerceRow(r: Record<string, unknown>): ListingRow {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    tagline: String(r.tagline),
    description: String(r.description ?? ""),
    publisherUserId: (r.publisher_user_id as string | null) ?? null,
    appBotId: String(r.app_bot_id),
    kind: String(r.kind),
    homepageUrl: (r.homepage_url as string | null) ?? null,
    iconUrl: (r.icon_url as string | null) ?? null,
    pricingCentsPerMonth: Number(r.pricing_cents_per_month ?? 0),
    published: !!r.published,
    installCount: Number(r.install_count ?? 0),
    createdAt: (r.created_at as Date) ?? new Date(0),
  };
}

async function listPublishedListings(params: {
  kind?: string;
  q?: string;
  limit?: number;
}): Promise<ListingRow[]> {
  try {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    const kindFilter = params.kind
      ? sql`AND kind = ${params.kind}`
      : sql``;
    const qFilter =
      params.q && params.q.length >= 2
        ? sql`AND (name ILIKE ${"%" + params.q + "%"} OR tagline ILIKE ${"%" + params.q + "%"})`
        : sql``;
    const rows = (await db.execute(sql`
      SELECT * FROM marketplace_agent_listings
      WHERE published = true
      ${kindFilter}
      ${qFilter}
      ORDER BY install_count DESC, created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    return Array.isArray(rows) ? rows.map(coerceRow) : [];
  } catch (err) {
    console.error("[agent-marketplace] listPublishedListings:", err);
    return [];
  }
}

async function getListingBySlug(slug: string): Promise<ListingRow | null> {
  try {
    const rows = (await db.execute(sql`
      SELECT * FROM marketplace_agent_listings WHERE slug = ${slug} LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? coerceRow(row) : null;
  } catch (err) {
    console.error("[agent-marketplace] getListingBySlug:", err);
    return null;
  }
}

async function getListingById(id: string): Promise<ListingRow | null> {
  try {
    const rows = (await db.execute(sql`
      SELECT * FROM marketplace_agent_listings WHERE id = ${id} LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? coerceRow(row) : null;
  } catch (err) {
    console.error("[agent-marketplace] getListingById:", err);
    return null;
  }
}

async function listListingsForPublisher(
  userId: string
): Promise<ListingRow[]> {
  try {
    const rows = (await db.execute(sql`
      SELECT * FROM marketplace_agent_listings
      WHERE publisher_user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 100
    `)) as unknown as Array<Record<string, unknown>>;
    return Array.isArray(rows) ? rows.map(coerceRow) : [];
  } catch (err) {
    console.error("[agent-marketplace] listListingsForPublisher:", err);
    return [];
  }
}

async function listAllListings(): Promise<ListingRow[]> {
  try {
    const rows = (await db.execute(sql`
      SELECT * FROM marketplace_agent_listings
      ORDER BY published DESC, created_at DESC
      LIMIT 500
    `)) as unknown as Array<Record<string, unknown>>;
    return Array.isArray(rows) ? rows.map(coerceRow) : [];
  } catch (err) {
    console.error("[agent-marketplace] listAllListings:", err);
    return [];
  }
}

async function insertListing(params: {
  parsed: ParsedListing;
  publisherUserId: string;
  appBotId: string;
}): Promise<ListingRow | null> {
  try {
    const rows = (await db.execute(sql`
      INSERT INTO marketplace_agent_listings
        (slug, name, tagline, description, publisher_user_id, app_bot_id,
         kind, homepage_url, icon_url, pricing_cents_per_month, published)
      VALUES (
        ${params.parsed.slug},
        ${params.parsed.name},
        ${params.parsed.tagline},
        ${params.parsed.description},
        ${params.publisherUserId},
        ${params.appBotId},
        ${params.parsed.kind},
        ${params.parsed.homepageUrl},
        ${params.parsed.iconUrl},
        ${params.parsed.pricingCentsPerMonth},
        false
      )
      RETURNING *
    `)) as unknown as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? coerceRow(row) : null;
  } catch (err) {
    console.error("[agent-marketplace] insertListing:", err);
    return null;
  }
}

async function setPublished(id: string, published: boolean): Promise<boolean> {
  try {
    await db.execute(sql`
      UPDATE marketplace_agent_listings
      SET published = ${published}, updated_at = now()
      WHERE id = ${id}
    `);
    return true;
  } catch (err) {
    console.error("[agent-marketplace] setPublished:", err);
    return false;
  }
}

async function bumpInstallCount(id: string, delta: 1 | -1): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE marketplace_agent_listings
      SET install_count = GREATEST(0, install_count + ${delta}),
          updated_at = now()
      WHERE id = ${id}
    `);
  } catch (err) {
    console.error("[agent-marketplace] bumpInstallCount:", err);
  }
}

async function getBotAppSlug(appBotId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ slug: apps.slug })
      .from(appBots)
      .innerJoin(apps, eq(apps.id, appBots.appId))
      .where(eq(appBots.id, appBotId))
      .limit(1);
    return row?.slug ?? null;
  } catch (err) {
    console.error("[agent-marketplace] getBotAppSlug:", err);
    return null;
  }
}

async function userOwnsRepo(
  userId: string,
  repoId: string
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(eq(repositories.id, repoId), eq(repositories.ownerId, userId))
      )
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

async function listOwnedRepos(userId: string) {
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .where(eq(repositories.ownerId, userId))
      .limit(100);
    return rows;
  } catch {
    return [];
  }
}

async function isInstalledForRepo(
  appBotId: string,
  repoId: string
): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: appInstallations.id })
      .from(appInstallations)
      .innerJoin(appBots, eq(appBots.appId, appInstallations.appId))
      .where(
        and(
          eq(appBots.id, appBotId),
          eq(appInstallations.targetType, "repository"),
          eq(appInstallations.targetId, repoId)
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const app = new Hono<{ Variables: AuthEnv }>();

// Public directory
app.get("/marketplace/agents", softAuth, async (c) => {
  const kind = c.req.query("kind") || undefined;
  const q = c.req.query("q") || undefined;
  const listings = await listPublishedListings({ kind, q });
  return c.html(
    <Layout title="Agent Marketplace" user={c.get("user") ?? null}>
      <div class="page-wrap">
        <h1>Agent Marketplace</h1>
        <p class="muted">
          Installable autonomous agents — triage, fix, review, heal, watch.
        </p>
        <form method="get" class="search-form" style="margin: 16px 0">
          <input
            type="search"
            name="q"
            value={q ?? ""}
            placeholder="Search listings…"
            class="input"
          />
          <select name="kind" class="input">
            <option value="">All kinds</option>
            {ALLOWED_LISTING_KINDS.map((k) => (
              <option value={k} selected={kind === k}>
                {k}
              </option>
            ))}
          </select>
          <button type="submit" class="btn">Search</button>
        </form>
        {listings.length === 0 ? (
          <div class="empty-state">
            <p>No published agents yet.</p>
          </div>
        ) : (
          <div class="card-grid">
            {listings.map((l) => (
              <a href={`/marketplace/agents/${l.slug}`} class="card">
                <h3>{l.name}</h3>
                <p class="muted">{l.tagline}</p>
                <div class="pill-row">
                  <span class="pill">{l.kind}</span>
                  <span class="pill">{l.installCount} installs</span>
                  {l.pricingCentsPerMonth > 0 && (
                    <span class="pill">${(l.pricingCentsPerMonth / 100).toFixed(2)}/mo</span>
                  )}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
});

// Detail
app.get("/marketplace/agents/:slug", softAuth, async (c) => {
  const slug = c.req.param("slug");
  const listing = await getListingBySlug(slug);
  if (!listing || !listing.published) {
    return c.notFound();
  }
  const user = c.get("user") ?? null;
  const repos = user ? await listOwnedRepos(user.id) : [];
  return c.html(
    <Layout title={listing.name} user={user}>
      <div class="page-wrap">
        <h1>{listing.name}</h1>
        <p class="muted">{listing.tagline}</p>
        <div class="pill-row">
          <span class="pill">{listing.kind}</span>
          <span class="pill">{listing.installCount} installs</span>
          {listing.pricingCentsPerMonth > 0 && (
            <span class="pill">${(listing.pricingCentsPerMonth / 100).toFixed(2)}/mo</span>
          )}
          {listing.homepageUrl && (
            <a class="pill" href={listing.homepageUrl} rel="noreferrer nofollow">
              Homepage ↗
            </a>
          )}
        </div>
        {listing.description && (
          <pre class="listing-description">{listing.description}</pre>
        )}
        {user ? (
          repos.length === 0 ? (
            <p class="muted">You have no repositories to install into.</p>
          ) : (
            <form
              method="post"
              action={`/marketplace/agents/${listing.slug}/install`}
              class="install-form"
            >
              <label>
                Install into repo:
                <select name="repo_id" class="input" required>
                  {repos.map((r) => (
                    <option value={r.id}>{r.name}</option>
                  ))}
                </select>
              </label>
              <button type="submit" class="btn btn-primary">
                Install
              </button>
            </form>
          )
        ) : (
          <p>
            <a href={`/login?next=/marketplace/agents/${listing.slug}`}>
              Log in
            </a>{" "}
            to install.
          </p>
        )}
      </div>
    </Layout>
  );
});

// Install
app.post("/marketplace/agents/:slug/install", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const listing = await getListingBySlug(slug);
  if (!listing || !listing.published) {
    return c.text("listing not found", 404);
  }
  const body = await c.req.parseBody();
  const repoId = String(body.repo_id ?? "");
  if (!repoId) return c.text("repo_id required", 400);
  if (!(await userOwnsRepo(user.id, repoId))) {
    return c.text("forbidden", 403);
  }
  const appSlug = await getBotAppSlug(listing.appBotId);
  if (!appSlug) return c.text("listing references missing app", 500);

  const install = await installAgentForRepo(
    appSlug,
    repoId,
    user.id,
    AGENT_PERMISSIONS
  );
  if (!install) return c.text("install failed", 500);
  await bumpInstallCount(listing.id, 1);
  return c.redirect(`/marketplace/agents/${slug}`);
});

// Uninstall
app.post("/marketplace/agents/:slug/uninstall", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const listing = await getListingBySlug(slug);
  if (!listing) return c.text("listing not found", 404);
  const body = await c.req.parseBody();
  const repoId = String(body.repo_id ?? "");
  if (!repoId) return c.text("repo_id required", 400);
  if (!(await userOwnsRepo(user.id, repoId))) {
    return c.text("forbidden", 403);
  }
  const appSlug = await getBotAppSlug(listing.appBotId);
  if (!appSlug) return c.text("listing references missing app", 500);
  const ok = await uninstallAgent(appSlug, repoId);
  if (ok) await bumpInstallCount(listing.id, -1);
  return c.redirect(`/marketplace/agents/${slug}`);
});

// Publisher dashboard
app.get("/settings/agent-listings", requireAuth, async (c) => {
  const user = c.get("user")!;
  const mine = await listListingsForPublisher(user.id);
  return c.html(
    <Layout title="My Agent Listings" user={user}>
      <div class="page-wrap">
        <h1>My Agent Listings</h1>
        <section style="margin-bottom: 24px">
          <h2>Create new listing</h2>
          <form method="post" action="/settings/agent-listings" class="create-form">
            <label>Slug<input name="slug" required class="input" placeholder="my-agent" /></label>
            <label>Name<input name="name" required class="input" /></label>
            <label>Tagline<input name="tagline" required class="input" maxLength={TAGLINE_MAX} /></label>
            <label>Kind
              <select name="kind" class="input" required>
                {ALLOWED_LISTING_KINDS.map((k) => (
                  <option value={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>Description<textarea name="description" class="input" rows={4} maxLength={DESCRIPTION_MAX} /></label>
            <label>Homepage URL<input name="homepage_url" class="input" placeholder="https://…" /></label>
            <label>Icon URL<input name="icon_url" class="input" placeholder="https://…" /></label>
            <label>Pricing (cents / month)<input name="pricing_cents_per_month" type="number" min="0" value="0" class="input" /></label>
            <button type="submit" class="btn btn-primary">Create</button>
          </form>
        </section>
        <section>
          <h2>Existing listings</h2>
          {mine.length === 0 ? (
            <p class="muted">You haven't published any agents yet.</p>
          ) : (
            <table class="table">
              <thead><tr><th>Slug</th><th>Name</th><th>Kind</th><th>Installs</th><th>Published</th></tr></thead>
              <tbody>
                {mine.map((l) => (
                  <tr>
                    <td><code>{l.slug}</code></td>
                    <td>{l.name}</td>
                    <td>{l.kind}</td>
                    <td>{l.installCount}</td>
                    <td>{l.published ? "yes" : "no — awaiting review"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </Layout>
  );
});

app.post("/settings/agent-listings", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = (await c.req.parseBody()) as ListingFormInput;
  const parsed = parseListingForm(body);
  if (!parsed.ok) return c.text(parsed.error, 400);

  // Ensure the agent app for this listing exists (idempotent).
  const appRow = await ensureAgentApp(
    parsed.data.slug,
    parsed.data.name,
    AGENT_PERMISSIONS
  );
  if (!appRow) return c.text("could not bootstrap agent app", 500);

  const [bot] = await db
    .select({ id: appBots.id })
    .from(appBots)
    .where(eq(appBots.appId, appRow.id))
    .limit(1);
  if (!bot) return c.text("no bot row for app", 500);

  const listing = await insertListing({
    parsed: parsed.data,
    publisherUserId: user.id,
    appBotId: bot.id,
  });
  if (!listing) return c.text("listing insert failed (slug taken?)", 400);
  return c.redirect("/settings/agent-listings");
});

app.post("/settings/agent-listings/:id/publish", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!(await isSiteAdmin(user.id))) {
    return c.text("forbidden", 403);
  }
  const id = c.req.param("id");
  const listing = await getListingById(id);
  if (!listing) return c.text("not found", 404);
  await setPublished(id, true);
  return c.redirect("/admin/marketplace/agents");
});

app.post("/settings/agent-listings/:id/unpublish", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!(await isSiteAdmin(user.id))) {
    return c.text("forbidden", 403);
  }
  const id = c.req.param("id");
  const listing = await getListingById(id);
  if (!listing) return c.text("not found", 404);
  await setPublished(id, false);
  return c.redirect("/admin/marketplace/agents");
});

app.get("/admin/marketplace/agents", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!(await isSiteAdmin(user.id))) {
    return c.text("forbidden", 403);
  }
  const listings = await listAllListings();
  return c.html(
    <Layout title="Admin — Agent Marketplace" user={user}>
      <div class="page-wrap">
        <h1>Admin — Agent Marketplace</h1>
        <table class="table">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Name</th>
              <th>Kind</th>
              <th>Installs</th>
              <th>Published</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <tr>
                <td><code>{l.slug}</code></td>
                <td>{l.name}</td>
                <td>{l.kind}</td>
                <td>{l.installCount}</td>
                <td>{l.published ? "yes" : "no"}</td>
                <td>
                  <form
                    method="post"
                    action={`/settings/agent-listings/${l.id}/${l.published ? "unpublish" : "publish"}`}
                    style="display: inline"
                  >
                    <button type="submit" class="btn">
                      {l.published ? "Unpublish" : "Publish"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
});

export default app;

// Explicit named exports for tests / external wiring.
export {
  listPublishedListings as _listPublishedListings,
  getListingBySlug as _getListingBySlug,
  isInstalledForRepo as _isInstalledForRepo,
};
