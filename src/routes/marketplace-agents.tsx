/**
 * Agent Marketplace UI + admin moderation queue.
 *
 *   GET  /marketplace/agents                — catalog grid
 *   GET  /marketplace/agents/publish        — publisher submission form
 *   POST /marketplace/agents/publish        — submit listing (pending_review)
 *   GET  /marketplace/agents/:slug          — listing detail + reviews
 *   POST /marketplace/agents/:slug/install  — install on a repo
 *   POST /marketplace/agents/:slug/reviews  — leave a review
 *   GET  /admin/marketplace/queue           — moderation queue (admin)
 *   POST /admin/marketplace/queue/:slug/:action — approve | reject
 *
 * Visual pattern lifted from `routes/marketplace.tsx` (gradient hairline
 * hero + orb + eyebrow + verb-as-title + category pills + card grid).
 * Every selector is scoped under `.amkt-*` so this surface can't bleed
 * into the existing `.mkt-*` marketplace.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";
import { audit } from "../lib/notify";
import { renderMarkdown } from "../lib/markdown";
import {
  repositories,
  users,
  agentMarketplaceInstalls,
} from "../db/schema";
import {
  MARKETPLACE_CATEGORIES,
  PRICING_MODELS,
  approveListing,
  createListing,
  fetchListingBySlug,
  formatPrice,
  getListing,
  gradientForSlug,
  installListing,
  isValidCategory,
  isValidPricingModel,
  listListings,
  listingInitials,
  recordReview,
  rejectListing,
  uninstallListing,
} from "../lib/agent-marketplace";

const marketplaceAgents = new Hono<AuthEnv>();
marketplaceAgents.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every selector under `.amkt-*` so we can't bleed into the
 * pre-existing `.mkt-*` marketplace surface. Pattern mirrors that file.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .amkt-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-6, 32px) var(--space-4, 24px); }

  /* ─── Hero ─── */
  .amkt-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .amkt-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .amkt-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .amkt-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .amkt-hero-text { max-width: 680px; flex: 1; min-width: 240px; }
  .amkt-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 16px;
  }
  .amkt-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .amkt-title {
    font-family: var(--font-display);
    font-size: clamp(32px, 5vw, 48px);
    font-weight: 800;
    letter-spacing: -0.030em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .amkt-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .amkt-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 580px;
  }
  .amkt-hero-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    text-decoration: none;
    border: 1px solid transparent;
    box-shadow: 0 6px 16px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .amkt-hero-cta:hover {
    transform: translateY(-1px);
    color: #fff;
    text-decoration: none;
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60);
  }

  /* ─── Category filter pills ─── */
  .amkt-pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
  }
  .amkt-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border);
    text-decoration: none;
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
  }
  .amkt-pill:hover {
    color: var(--text-strong);
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.06);
    text-decoration: none;
  }
  .amkt-pill.is-active {
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: #c5b3ff;
    border-color: rgba(140,109,255,0.45);
  }

  /* ─── Card grid ─── */
  .amkt-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3);
  }
  .amkt-card {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    color: inherit;
    text-decoration: none;
    transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
  }
  .amkt-card:hover {
    border-color: rgba(140,109,255,0.45);
    transform: translateY(-2px);
    box-shadow: 0 10px 28px -10px rgba(140,109,255,0.30);
    text-decoration: none;
    color: inherit;
  }
  .amkt-card-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .amkt-logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px; height: 44px;
    border-radius: 11px;
    flex-shrink: 0;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 18px;
    color: #fff;
    letter-spacing: -0.02em;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 12px -6px rgba(0,0,0,0.45);
  }
  .amkt-card-name {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
    letter-spacing: -0.012em;
  }
  .amkt-card-publisher {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 1px;
  }
  .amkt-card-tagline {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    flex: 1;
  }
  .amkt-card-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .amkt-card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 4px;
  }
  .amkt-price-pill {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    color: #c5b3ff;
    background: rgba(140,109,255,0.10);
    border: 1px solid rgba(140,109,255,0.30);
    font-family: var(--font-mono);
  }
  .amkt-price-pill.is-free {
    color: #86efac;
    background: rgba(34,197,94,0.10);
    border-color: rgba(34,197,94,0.30);
  }
  .amkt-install-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    text-decoration: none;
    box-shadow: 0 4px 12px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease;
  }
  .amkt-install-btn:hover {
    transform: translateY(-1px);
    color: #fff;
    text-decoration: none;
  }
  .amkt-stars { display: inline-flex; gap: 2px; color: #f5b942; }

  /* ─── Empty / zero state ─── */
  .amkt-empty {
    position: relative;
    padding: clamp(28px, 4vw, 44px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed rgba(140,109,255,0.40);
    border-radius: 16px;
    overflow: hidden;
  }
  .amkt-empty-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 8px;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .amkt-empty-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0 auto 18px;
    max-width: 480px;
    line-height: 1.55;
  }

  /* ─── Section card ─── */
  .amkt-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .amkt-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .amkt-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.014em;
  }
  .amkt-section-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .amkt-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Detail page ─── */
  .amkt-detail-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .amkt-detail-logo {
    width: 64px; height: 64px;
    border-radius: 14px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 26px;
    color: #fff;
    letter-spacing: -0.02em;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 6px 18px -6px rgba(0,0,0,0.45);
  }
  .amkt-detail-name {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 800;
    color: var(--text-strong);
    margin: 0;
    letter-spacing: -0.022em;
  }
  .amkt-detail-meta {
    margin-top: 4px;
    font-size: 12.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .amkt-prose {
    color: var(--text);
    font-size: 14.5px;
    line-height: 1.65;
  }
  .amkt-prose p { margin: 0 0 12px; }
  .amkt-prose h1, .amkt-prose h2, .amkt-prose h3 {
    font-family: var(--font-display);
    color: var(--text-strong);
    margin: 18px 0 8px;
  }
  .amkt-prose code {
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.9em;
  }

  /* ─── Reviews ─── */
  .amkt-review {
    padding: 14px 0;
    border-bottom: 1px solid var(--border);
  }
  .amkt-review:last-child { border-bottom: none; }
  .amkt-review-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .amkt-review-author {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text);
    font-weight: 600;
  }
  .amkt-review-body {
    color: var(--text);
    font-size: 14px;
    line-height: 1.55;
    margin: 0;
  }
  .amkt-review-date {
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }

  /* ─── Form ─── */
  .amkt-form-group { margin-bottom: var(--space-3); }
  .amkt-form-group label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .amkt-form-group input[type="text"],
  .amkt-form-group input[type="url"],
  .amkt-form-group input[type="number"],
  .amkt-form-group textarea,
  .amkt-form-group select {
    width: 100%;
    padding: 9px 12px;
    background: var(--bg-secondary, rgba(0,0,0,0.15));
    border: 1px solid var(--border);
    border-radius: 9px;
    font: inherit;
    font-size: 13.5px;
    color: var(--text);
    box-sizing: border-box;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .amkt-form-group input:focus,
  .amkt-form-group textarea:focus,
  .amkt-form-group select:focus {
    outline: none;
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* ─── Buttons ─── */
  .amkt-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
  }
  .amkt-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .amkt-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60);
    color: #ffffff;
    text-decoration: none;
  }
  .amkt-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border);
  }
  .amkt-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .amkt-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
  }
  .amkt-btn-danger:hover {
    background: rgba(248,113,113,0.06);
    border-color: rgba(248,113,113,0.70);
    color: #fecaca;
  }

  /* ─── Token reveal ─── */
  .amkt-token-block {
    padding: 14px 16px;
    margin-top: 12px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-strong);
    word-break: break-all;
  }

  /* ─── Queue row ─── */
  .amkt-queue-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .amkt-queue-row:last-child { border-bottom: none; }
  .amkt-queue-actions { display: flex; gap: 6px; }
`;

function StarRow({ rating }: { rating: number }) {
  const full = Math.round(rating);
  return (
    <span class="amkt-stars" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span style={`opacity:${i <= full ? 1 : 0.25}`}>★</span>
      ))}
    </span>
  );
}

// -------- GET /marketplace/agents (catalog) ---------------------------------

marketplaceAgents.get("/marketplace/agents", async (c) => {
  const user = c.get("user");
  const category = c.req.query("category") || "";
  const search = c.req.query("q") || "";
  const sortRaw = c.req.query("sort") || "top";
  const sort: "top" | "new" | "rated" =
    sortRaw === "new" || sortRaw === "rated" ? sortRaw : "top";
  const listings = await listListings({
    category: category || undefined,
    search: search || undefined,
    sort,
  });

  return c.html(
    <Layout title="Agent Marketplace — Gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="amkt-wrap">
        <section class="amkt-hero">
          <div class="amkt-hero-orb" aria-hidden="true" />
          <div class="amkt-hero-inner">
            <div class="amkt-hero-text">
              <div class="amkt-eyebrow">
                <span class="amkt-eyebrow-dot" aria-hidden="true" />
                Marketplace · Agents
              </div>
              <h1 class="amkt-title">
                <span class="amkt-title-grad">Agents from the community.</span>
              </h1>
              <p class="amkt-sub">
                Third-party AI agents that plug into your repos with one click.
                Each install provisions a scoped session with its own branch
                namespace and daily budget — safe to run alongside the rest of
                your fleet.
              </p>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <a href="/marketplace" class="amkt-pill">All apps</a>
              {user && (
                <a href="/marketplace/agents/publish" class="amkt-hero-cta">
                  + Publish agent
                </a>
              )}
            </div>
          </div>
        </section>

        <form
          method="get"
          action="/marketplace/agents"
          style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap"
        >
          <input
            type="text"
            name="q"
            value={search}
            placeholder="Search agents"
            aria-label="Search agents"
            style="flex:1;min-width:240px;padding:9px 12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;font-size:14px;color:var(--text)"
          />
          {category && <input type="hidden" name="category" value={category} />}
          <select
            name="sort"
            aria-label="Sort"
            style="padding:9px 12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;font-size:13px;color:var(--text)"
          >
            <option value="top" selected={sort === "top"}>Top installed</option>
            <option value="new" selected={sort === "new"}>Newest</option>
            <option value="rated" selected={sort === "rated"}>Highest rated</option>
          </select>
          <button
            type="submit"
            class="amkt-btn amkt-btn-ghost"
            style="padding:9px 16px"
          >
            Search
          </button>
        </form>

        <div class="amkt-pills" role="tablist" aria-label="Filter by category">
          <a
            href={`/marketplace/agents${search ? `?q=${encodeURIComponent(search)}` : ""}`}
            class={"amkt-pill" + (!category ? " is-active" : "")}
          >
            All
          </a>
          {MARKETPLACE_CATEGORIES.map((cat) => {
            const params = new URLSearchParams();
            params.set("category", cat);
            if (search) params.set("q", search);
            return (
              <a
                href={`/marketplace/agents?${params.toString()}`}
                class={"amkt-pill" + (category === cat ? " is-active" : "")}
              >
                {cat}
              </a>
            );
          })}
        </div>

        {listings.length === 0 ? (
          <div class="amkt-empty">
            <h2 class="amkt-empty-title">No agents match.</h2>
            <p class="amkt-empty-sub">
              {search || category
                ? "Try clearing the filter or searching for something else."
                : "No agents have been published yet. Be the first."}
            </p>
            {user && (
              <a href="/marketplace/agents/publish" class="amkt-btn amkt-btn-primary">
                Publish an agent
              </a>
            )}
          </div>
        ) : (
          <div class="amkt-grid">
            {listings.map((l) => {
              const ratingNum = Number(l.ratingAvg) || 0;
              return (
                <a href={`/marketplace/agents/${l.slug}`} class="amkt-card">
                  <div class="amkt-card-head">
                    <span
                      class="amkt-logo"
                      aria-hidden="true"
                      style={`background:${gradientForSlug(l.slug)}`}
                    >
                      {listingInitials(l.name)}
                    </span>
                    <div style="min-width:0">
                      <h3 class="amkt-card-name">{l.name}</h3>
                      <div class="amkt-card-publisher">
                        {l.category} · {l.installCount} install
                        {l.installCount === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                  <p class="amkt-card-tagline">
                    {(l.tagline || "No tagline.").slice(0, 140)}
                  </p>
                  <div class="amkt-card-meta">
                    <span>
                      <StarRow rating={ratingNum} /> {ratingNum.toFixed(1)}{" "}
                      ({l.ratingCount})
                    </span>
                  </div>
                  <div class="amkt-card-foot">
                    <span
                      class={
                        "amkt-price-pill" +
                        (l.pricingModel === "free" ? " is-free" : "")
                      }
                    >
                      {formatPrice(l.priceCents, l.pricingModel)}
                    </span>
                    <span class="amkt-install-btn">Install &rarr;</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
});

// -------- GET /marketplace/agents/publish (form) ----------------------------

marketplaceAgents.get("/marketplace/agents/publish", requireAuth, async (c) => {
  const user = c.get("user")!;
  return c.html(
    <Layout title="Publish agent — Marketplace" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="amkt-wrap">
        <section class="amkt-hero">
          <div class="amkt-hero-orb" aria-hidden="true" />
          <div class="amkt-hero-inner">
            <div class="amkt-hero-text">
              <div class="amkt-eyebrow">
                <span class="amkt-eyebrow-dot" aria-hidden="true" />
                Publisher
              </div>
              <h1 class="amkt-title">
                <span class="amkt-title-grad">Publish.</span>
              </h1>
              <p class="amkt-sub">
                Submit your AI agent. Once approved by a moderator, it appears
                in the catalog and earns a 70% revenue share on paid
                invocations.
              </p>
            </div>
            <a href="/marketplace/agents" class="amkt-btn amkt-btn-ghost">
              Cancel
            </a>
          </div>
        </section>

        <form method="post" action="/marketplace/agents/publish" class="amkt-section">
          <div class="amkt-section-body">
            <div class="amkt-form-group">
              <label>Name</label>
              <input type="text" name="name" required maxlength={80} />
            </div>
            <div class="amkt-form-group">
              <label>Tagline (one line)</label>
              <input type="text" name="tagline" maxlength={280} />
            </div>
            <div class="amkt-form-group">
              <label>Description (markdown)</label>
              <textarea name="description" rows={6} />
            </div>
            <div class="amkt-form-group">
              <label>Category</label>
              <select name="category">
                {MARKETPLACE_CATEGORIES.map((c) => (
                  <option value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div class="amkt-form-group">
              <label>Pricing model</label>
              <select name="pricingModel">
                {PRICING_MODELS.map((p) => (
                  <option value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div class="amkt-form-group">
              <label>Price (cents)</label>
              <input type="number" name="priceCents" min={0} value={0} />
            </div>
            <div class="amkt-form-group">
              <label>Source URL</label>
              <input type="url" name="sourceUrl" />
            </div>
            <button type="submit" class="amkt-btn amkt-btn-primary">
              Submit for review
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
});

// -------- POST /marketplace/agents/publish ----------------------------------

marketplaceAgents.post("/marketplace/agents/publish", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  if (!name) return c.redirect("/marketplace/agents/publish");
  const listing = await createListing({
    publisherUserId: user.id,
    name,
    tagline: String(body.tagline || ""),
    description: String(body.description || ""),
    category: String(body.category || "custom"),
    pricingModel: String(body.pricingModel || "free"),
    priceCents: Number(body.priceCents || 0),
    sourceUrl: String(body.sourceUrl || "") || undefined,
  });
  if (!listing) return c.text("failed to create", 500);
  await audit({
    userId: user.id,
    action: "marketplace.agent.submit",
    targetType: "agent_marketplace_listing",
    targetId: listing.id,
  });
  return c.redirect(`/marketplace/agents/${listing.slug}`);
});

// -------- GET /marketplace/agents/:slug (detail) ----------------------------

marketplaceAgents.get("/marketplace/agents/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const detail = await getListing(slug);
  if (!detail) return c.notFound();
  // Only the publisher + admins can see a non-approved listing.
  const isOwner = user?.id === detail.listing.publisherUserId;
  const isAdmin = !!user?.isAdmin;
  if (detail.listing.status !== "approved" && !isOwner && !isAdmin) {
    return c.notFound();
  }

  // Show the install form against the user's repos.
  const userRepos = user
    ? await db
        .select({
          id: repositories.id,
          name: repositories.name,
          ownerName: users.username,
        })
        .from(repositories)
        .leftJoin(users, eq(users.id, repositories.ownerId))
        .where(eq(repositories.ownerId, user.id))
        .limit(50)
    : [];

  const ratingNum = Number(detail.listing.ratingAvg) || 0;
  const descHtml = renderMarkdown(detail.listing.description || "");

  return c.html(
    <Layout title={`${detail.listing.name} — Agent Marketplace`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="amkt-wrap">
        <section class="amkt-hero">
          <div class="amkt-hero-orb" aria-hidden="true" />
          <div class="amkt-hero-inner">
            <div class="amkt-hero-text" style="flex:1">
              <div class="amkt-detail-head">
                <span
                  class="amkt-detail-logo"
                  aria-hidden="true"
                  style={`background:${gradientForSlug(detail.listing.slug)}`}
                >
                  {listingInitials(detail.listing.name)}
                </span>
                <div style="min-width:0">
                  <h1 class="amkt-detail-name">{detail.listing.name}</h1>
                  <div class="amkt-detail-meta">
                    by{" "}
                    <strong style="color:var(--text)">
                      @{detail.listing.publisherUsername || "unknown"}
                    </strong>{" "}
                    · {detail.listing.installCount} install
                    {detail.listing.installCount === 1 ? "" : "s"} ·{" "}
                    <StarRow rating={ratingNum} /> {ratingNum.toFixed(1)} (
                    {detail.listing.ratingCount})
                  </div>
                </div>
              </div>
              <p class="amkt-sub">{detail.listing.tagline}</p>
              <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <span
                  class={
                    "amkt-price-pill" +
                    (detail.listing.pricingModel === "free" ? " is-free" : "")
                  }
                >
                  {formatPrice(
                    detail.listing.priceCents,
                    detail.listing.pricingModel
                  )}
                </span>
                <span class="amkt-price-pill">{detail.listing.category}</span>
                {detail.listing.status !== "approved" && (
                  <span class="amkt-price-pill">{detail.listing.status}</span>
                )}
                {detail.listing.sourceUrl && (
                  <a
                    href={detail.listing.sourceUrl}
                    class="amkt-btn amkt-btn-ghost"
                    style="padding:6px 12px;font-size:12px"
                  >
                    Source
                  </a>
                )}
              </div>
            </div>
          </div>
        </section>

        <section class="amkt-section">
          <header class="amkt-section-head">
            <h3 class="amkt-section-title">About</h3>
          </header>
          <div class="amkt-section-body">
            <div
              class="amkt-prose"
              dangerouslySetInnerHTML={{
                __html: descHtml || "<p>No description provided.</p>",
              }}
            />
          </div>
        </section>

        {user ? (
          <section class="amkt-section">
            <header class="amkt-section-head">
              <h3 class="amkt-section-title">Install on a repo</h3>
              <p class="amkt-section-sub">
                Provisions a scoped agent session with budget{" "}
                {detail.listing.agentTemplate?.budgetCentsPerDay ?? 500}¢/day.
                Token is shown once.
              </p>
            </header>
            <div class="amkt-section-body">
              {userRepos.length === 0 ? (
                <p style="color:var(--text-muted);font-size:13.5px;margin:0">
                  You don't own any repos yet —{" "}
                  <a href="/new" style="color:var(--accent)">
                    create one
                  </a>{" "}
                  to install this agent.
                </p>
              ) : (
                <form
                  method="post"
                  action={`/marketplace/agents/${slug}/install`}
                  style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"
                >
                  <select
                    name="repositoryId"
                    aria-label="Repository"
                    style="flex:1;min-width:200px;padding:9px 12px;background:var(--bg-secondary,rgba(0,0,0,0.15));border:1px solid var(--border);border-radius:9px;color:var(--text);font:inherit;font-size:13.5px"
                  >
                    {userRepos.map((r) => (
                      <option value={r.id}>
                        {r.ownerName}/{r.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    class="amkt-btn amkt-btn-primary"
                    disabled={detail.listing.status !== "approved"}
                  >
                    Install
                  </button>
                </form>
              )}
            </div>
          </section>
        ) : (
          <section class="amkt-section">
            <div class="amkt-section-body">
              <p style="margin:0;color:var(--text-muted);font-size:14px">
                <a
                  href={`/login?next=/marketplace/agents/${slug}`}
                  style="color:var(--accent)"
                >
                  Sign in
                </a>{" "}
                to install this agent on one of your repos.
              </p>
            </div>
          </section>
        )}

        <section class="amkt-section">
          <header class="amkt-section-head">
            <h3 class="amkt-section-title">
              Reviews ({detail.listing.ratingCount})
            </h3>
          </header>
          <div class="amkt-section-body">
            {detail.reviews.length === 0 ? (
              <p style="color:var(--text-muted);font-size:13.5px;margin:0">
                No reviews yet.
              </p>
            ) : (
              detail.reviews.map((r) => (
                <div class="amkt-review">
                  <div class="amkt-review-head">
                    <StarRow rating={r.rating} />
                    <span class="amkt-review-author">
                      @{r.reviewerUsername || "anon"}
                    </span>
                    <span class="amkt-review-date">
                      {r.createdAt
                        ? new Date(r.createdAt).toLocaleDateString()
                        : ""}
                    </span>
                  </div>
                  <p class="amkt-review-body">{r.body || "(no body)"}</p>
                </div>
              ))
            )}
            {user && (
              <form
                method="post"
                action={`/marketplace/agents/${slug}/reviews`}
                style="margin-top:18px;padding-top:18px;border-top:1px solid var(--border)"
              >
                <div class="amkt-form-group">
                  <label>Rating</label>
                  <select name="rating" style="max-width:120px">
                    {[5, 4, 3, 2, 1].map((n) => (
                      <option value={n}>{n} ★</option>
                    ))}
                  </select>
                </div>
                <div class="amkt-form-group">
                  <label>Review</label>
                  <textarea name="body" rows={3} maxlength={4000} />
                </div>
                <button type="submit" class="amkt-btn amkt-btn-primary">
                  Post review
                </button>
              </form>
            )}
          </div>
        </section>
      </div>
    </Layout>
  );
});

// -------- POST /marketplace/agents/:slug/install ----------------------------

marketplaceAgents.post(
  "/marketplace/agents/:slug/install",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const listing = await fetchListingBySlug(slug);
    if (!listing || listing.status !== "approved") {
      return c.text("not found", 404);
    }
    const body = await c.req.parseBody();
    const repositoryId = String(body.repositoryId || "");
    if (!repositoryId) {
      return c.redirect(`/marketplace/agents/${slug}`);
    }
    // Must own the repo.
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.id, repositoryId), eq(repositories.ownerId, user.id))
      )
      .limit(1);
    if (!repo) return c.text("forbidden", 403);

    const result = await installListing({
      listingId: listing.id,
      repositoryId: repo.id,
      installedByUserId: user.id,
    });
    if (!result) {
      return c.text(
        "install failed (already installed or session provisioning error)",
        409
      );
    }
    await audit({
      userId: user.id,
      action: "marketplace.agent.install",
      targetType: "agent_marketplace_install",
      targetId: result.install.id,
      metadata: { slug, repositoryId },
    });

    return c.html(
      <Layout title="Agent installed" user={user}>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="amkt-wrap">
          <section class="amkt-hero">
            <div class="amkt-hero-orb" aria-hidden="true" />
            <div class="amkt-hero-inner">
              <div class="amkt-hero-text">
                <div class="amkt-eyebrow">
                  <span class="amkt-eyebrow-dot" aria-hidden="true" />
                  Token issued
                </div>
                <h1 class="amkt-title">
                  <span class="amkt-title-grad">Copy now.</span>
                </h1>
                <p class="amkt-sub">
                  This agent token is shown once. Store it safely — it's the
                  agent's bearer credential.
                </p>
              </div>
            </div>
          </section>
          <section class="amkt-section">
            <div class="amkt-section-body">
              <div class="amkt-token-block">{result.agentToken}</div>
              <a
                href={`/marketplace/agents/${slug}`}
                class="amkt-btn amkt-btn-ghost"
                style="margin-top:14px"
              >
                Back to listing
              </a>
            </div>
          </section>
        </div>
      </Layout>
    );
  }
);

// -------- POST /marketplace/agents/:slug/reviews ----------------------------

marketplaceAgents.post(
  "/marketplace/agents/:slug/reviews",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const listing = await fetchListingBySlug(slug);
    if (!listing) return c.text("not found", 404);
    const body = await c.req.parseBody();
    const rating = Number(body.rating || 0);
    await recordReview({
      listingId: listing.id,
      reviewerUserId: user.id,
      rating,
      body: String(body.body || ""),
    });
    return c.redirect(`/marketplace/agents/${slug}`);
  }
);

// -------- POST /marketplace/installs/:id/uninstall --------------------------

marketplaceAgents.post(
  "/marketplace/installs/:id/uninstall",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(agentMarketplaceInstalls)
      .where(eq(agentMarketplaceInstalls.id, id))
      .limit(1);
    if (!row || row.installedByUserId !== user.id) {
      return c.text("forbidden", 403);
    }
    const ok = await uninstallListing({ installId: id });
    if (ok) {
      await audit({
        userId: user.id,
        action: "marketplace.agent.uninstall",
        targetType: "agent_marketplace_install",
        targetId: id,
      });
    }
    return c.redirect("/marketplace/agents");
  }
);

// -------- GET /admin/marketplace/queue --------------------------------------

marketplaceAgents.get(
  "/admin/marketplace/queue",
  requireAuth,
  requireAdmin,
  async (c) => {
    const user = c.get("user")!;
    const pending = await listListings({ status: "pending_review", sort: "new" });
    const rejected = await listListings({ status: "rejected", sort: "new" });
    return c.html(
      <Layout title="Marketplace moderation — Admin" user={user}>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="amkt-wrap">
          <section class="amkt-hero">
            <div class="amkt-hero-orb" aria-hidden="true" />
            <div class="amkt-hero-inner">
              <div class="amkt-hero-text">
                <div class="amkt-eyebrow">
                  <span class="amkt-eyebrow-dot" aria-hidden="true" />
                  Admin · Marketplace
                </div>
                <h1 class="amkt-title">
                  <span class="amkt-title-grad">Moderate.</span>
                </h1>
                <p class="amkt-sub">
                  Approve or reject pending agent submissions. Approved listings
                  go live immediately.
                </p>
              </div>
            </div>
          </section>

          <section class="amkt-section">
            <header class="amkt-section-head">
              <h3 class="amkt-section-title">
                Pending ({pending.length})
              </h3>
            </header>
            {pending.length === 0 ? (
              <div class="amkt-section-body">
                <p style="color:var(--text-muted);margin:0">Queue is empty.</p>
              </div>
            ) : (
              pending.map((l) => (
                <div class="amkt-queue-row">
                  <div style="min-width:0;flex:1">
                    <a
                      href={`/marketplace/agents/${l.slug}`}
                      style="color:var(--text-strong);font-weight:600;text-decoration:none"
                    >
                      {l.name}
                    </a>
                    <div
                      style="font-size:12px;color:var(--text-muted);margin-top:2px"
                    >
                      {l.category} · {formatPrice(l.priceCents, l.pricingModel)}{" "}
                      · submitted{" "}
                      {l.createdAt
                        ? new Date(l.createdAt).toLocaleDateString()
                        : ""}
                    </div>
                  </div>
                  <div class="amkt-queue-actions">
                    <form
                      method="post"
                      action={`/admin/marketplace/queue/${l.slug}/approve`}
                      style="margin:0"
                    >
                      <button class="amkt-btn amkt-btn-primary">Approve</button>
                    </form>
                    <form
                      method="post"
                      action={`/admin/marketplace/queue/${l.slug}/reject`}
                      style="margin:0"
                    >
                      <button class="amkt-btn amkt-btn-danger">Reject</button>
                    </form>
                  </div>
                </div>
              ))
            )}
          </section>

          {rejected.length > 0 && (
            <section class="amkt-section">
              <header class="amkt-section-head">
                <h3 class="amkt-section-title">
                  Recently rejected ({rejected.length})
                </h3>
              </header>
              {rejected.map((l) => (
                <div class="amkt-queue-row">
                  <div style="min-width:0;flex:1">
                    <span style="color:var(--text);font-weight:600">{l.name}</span>
                    <div
                      style="font-size:12px;color:var(--text-muted);margin-top:2px"
                    >
                      {l.category} · rejected
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>
      </Layout>
    );
  }
);

// -------- POST /admin/marketplace/queue/:slug/:action -----------------------

marketplaceAgents.post(
  "/admin/marketplace/queue/:slug/:action",
  requireAuth,
  requireAdmin,
  async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const action = c.req.param("action");
    if (action === "approve") {
      await approveListing(slug, user.id);
      await audit({
        userId: user.id,
        action: "marketplace.agent.approve",
        targetType: "agent_marketplace_listing",
        targetId: slug,
      });
    } else if (action === "reject") {
      const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
      await rejectListing(slug, user.id, String(body.reason || ""));
      await audit({
        userId: user.id,
        action: "marketplace.agent.reject",
        targetType: "agent_marketplace_listing",
        targetId: slug,
      });
    }
    return c.redirect("/admin/marketplace/queue");
  }
);

// ============================================================================
// API v2 endpoints — JSON surface for the same operations.
// Mounted as a separate sub-app at /api/v2/marketplace so the public auth
// stack (PAT / Bearer) applies cleanly.
// ============================================================================

import { apiAuth, requireApiAuth, requireScope } from "../middleware/api-auth";
import type { ApiAuthEnv } from "../middleware/api-auth";

const marketplaceAgentsApi = new Hono<ApiAuthEnv>().basePath(
  "/api/v2/marketplace"
);
marketplaceAgentsApi.use("*", apiAuth);

marketplaceAgentsApi.get("/agents", async (c) => {
  const list = await listListings({
    category: c.req.query("category") || undefined,
    search: c.req.query("q") || undefined,
    sort: ((): "top" | "new" | "rated" => {
      const s = c.req.query("sort");
      return s === "new" || s === "rated" ? s : "top";
    })(),
  });
  return c.json({ listings: list });
});

marketplaceAgentsApi.get("/agents/:slug", async (c) => {
  const slug = c.req.param("slug");
  const detail = await getListing(slug);
  if (!detail || detail.listing.status !== "approved") {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(detail);
});

marketplaceAgentsApi.post(
  "/agents",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const user = c.get("user")!;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = String(body.name || "").trim();
    if (!name) return c.json({ error: "name required" }, 400);
    const category = String(body.category || "custom");
    const pricingModel = String(body.pricingModel || "free");
    if (!isValidCategory(category)) return c.json({ error: "bad category" }, 400);
    if (!isValidPricingModel(pricingModel)) {
      return c.json({ error: "bad pricingModel" }, 400);
    }
    const listing = await createListing({
      publisherUserId: user.id,
      name,
      tagline: String(body.tagline || ""),
      description: String(body.description || ""),
      category,
      pricingModel,
      priceCents: Number(body.priceCents || 0),
      sourceUrl:
        typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
      agentTemplate:
        body.agentTemplate && typeof body.agentTemplate === "object"
          ? (body.agentTemplate as Record<string, unknown>)
          : undefined,
    });
    if (!listing) return c.json({ error: "failed" }, 500);
    return c.json({ listing }, 201);
  }
);

marketplaceAgentsApi.post(
  "/agents/:slug/install",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const listing = await fetchListingBySlug(slug);
    if (!listing || listing.status !== "approved") {
      return c.json({ error: "not found" }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const repositoryId = String(body.repositoryId || "");
    if (!repositoryId) {
      return c.json({ error: "repositoryId required" }, 400);
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.id, repositoryId), eq(repositories.ownerId, user.id))
      )
      .limit(1);
    if (!repo) return c.json({ error: "repo not found or not owned" }, 403);

    const result = await installListing({
      listingId: listing.id,
      repositoryId: repo.id,
      installedByUserId: user.id,
    });
    if (!result) return c.json({ error: "install failed" }, 409);
    return c.json(
      {
        installId: result.install.id,
        agentToken: result.agentToken,
        agentSessionId: result.install.agentSessionId,
      },
      201
    );
  }
);

marketplaceAgentsApi.delete(
  "/installs/:id",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(agentMarketplaceInstalls)
      .where(eq(agentMarketplaceInstalls.id, id))
      .limit(1);
    if (!row || row.installedByUserId !== user.id) {
      return c.json({ error: "forbidden" }, 403);
    }
    const ok = await uninstallListing({ installId: id });
    return c.json({ ok });
  }
);

marketplaceAgentsApi.post(
  "/agents/:slug/reviews",
  requireApiAuth,
  requireScope("repo"),
  async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const listing = await fetchListingBySlug(slug);
    if (!listing) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rating = Number(body.rating || 0);
    if (rating < 1 || rating > 5) {
      return c.json({ error: "rating must be 1..5" }, 400);
    }
    const review = await recordReview({
      listingId: listing.id,
      reviewerUserId: user.id,
      rating,
      body: String(body.body || ""),
    });
    if (!review) return c.json({ error: "failed" }, 500);
    return c.json({ review }, 201);
  }
);

// Compose both sub-apps onto one mount.
marketplaceAgents.route("/", marketplaceAgentsApi);

export default marketplaceAgents;
