/**
 * Block K10 — Agent Marketplace tests.
 *
 * Pure form-parser tests are fully exercised. Route smokes only assert auth
 * behaviour — DB-backed flows live in the integration suite.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  parseListingForm,
  ALLOWED_LISTING_KINDS,
  SLUG_RE,
  TAGLINE_MAX,
  DESCRIPTION_MAX,
  PRICING_MAX_CENTS,
  type ListingFormInput,
} from "../routes/agent-marketplace";

// ---------------------------------------------------------------------------
// parseListingForm
// ---------------------------------------------------------------------------

describe("agent-marketplace — parseListingForm", () => {
  const validInput: ListingFormInput = {
    slug: "my-agent",
    name: "My Agent",
    tagline: "It does things.",
    description: "Hello world.",
    kind: "triage",
    homepage_url: "https://example.com",
    icon_url: "https://example.com/icon.png",
    pricing_cents_per_month: "500",
  };

  it("accepts a fully valid form", () => {
    const r = parseListingForm(validInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.slug).toBe("my-agent");
      expect(r.data.name).toBe("My Agent");
      expect(r.data.kind).toBe("triage");
      expect(r.data.pricingCentsPerMonth).toBe(500);
      expect(r.data.homepageUrl).toBe("https://example.com");
    }
  });

  it("rejects slug shorter than 3 chars", () => {
    const r = parseListingForm({ ...validInput, slug: "ab" });
    expect(r.ok).toBe(false);
  });

  it("rejects slug starting with digit", () => {
    const r = parseListingForm({ ...validInput, slug: "1abc" });
    expect(r.ok).toBe(false);
  });

  it("rejects slug with uppercase", () => {
    const r = parseListingForm({ ...validInput, slug: "MyAgent" });
    expect(r.ok).toBe(false);
  });

  it("accepts slug with hyphens and digits", () => {
    const r = parseListingForm({ ...validInput, slug: "my-agent-v2" });
    expect(r.ok).toBe(true);
  });

  it("rejects empty name", () => {
    const r = parseListingForm({ ...validInput, name: "   " });
    expect(r.ok).toBe(false);
  });

  it("rejects name over 100 chars", () => {
    const r = parseListingForm({ ...validInput, name: "x".repeat(101) });
    expect(r.ok).toBe(false);
  });

  it("rejects empty tagline", () => {
    const r = parseListingForm({ ...validInput, tagline: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects tagline > TAGLINE_MAX", () => {
    const r = parseListingForm({
      ...validInput,
      tagline: "x".repeat(TAGLINE_MAX + 1),
    });
    expect(r.ok).toBe(false);
  });

  it("silently truncates description to DESCRIPTION_MAX", () => {
    const r = parseListingForm({
      ...validInput,
      description: "x".repeat(DESCRIPTION_MAX + 500),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.description.length).toBe(DESCRIPTION_MAX);
    }
  });

  it("rejects unknown kind", () => {
    const r = parseListingForm({ ...validInput, kind: "hackerman" });
    expect(r.ok).toBe(false);
  });

  it("accepts every allowed kind", () => {
    for (const k of ALLOWED_LISTING_KINDS) {
      const r = parseListingForm({ ...validInput, kind: k });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects negative pricing", () => {
    const r = parseListingForm({
      ...validInput,
      pricing_cents_per_month: "-5",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric pricing", () => {
    const r = parseListingForm({
      ...validInput,
      pricing_cents_per_month: "abc",
    });
    // parseInt -> NaN, isFinite false, rejected.
    expect(r.ok).toBe(false);
  });

  it("caps pricing at PRICING_MAX_CENTS", () => {
    const r = parseListingForm({
      ...validInput,
      pricing_cents_per_month: "999999999",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.pricingCentsPerMonth).toBe(PRICING_MAX_CENTS);
  });

  it("nullifies invalid homepage URLs", () => {
    const r = parseListingForm({
      ...validInput,
      homepage_url: "javascript:alert(1)",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.homepageUrl).toBeNull();
  });

  it("keeps https homepage URLs", () => {
    const r = parseListingForm({
      ...validInput,
      homepage_url: "https://safe.example.com/path",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.homepageUrl).toBe("https://safe.example.com/path");
  });

  it("default pricing is 0 when omitted", () => {
    const { pricing_cents_per_month, ...rest } = validInput;
    void pricing_cents_per_month;
    const r = parseListingForm(rest as ListingFormInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.pricingCentsPerMonth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Constants are sane
// ---------------------------------------------------------------------------

describe("agent-marketplace — constants", () => {
  it("SLUG_RE matches typical slugs", () => {
    expect(SLUG_RE.test("my-agent")).toBe(true);
    expect(SLUG_RE.test("abc")).toBe(true);
    expect(SLUG_RE.test("A")).toBe(false);
  });
  it("ALLOWED_LISTING_KINDS contains every expected kind", () => {
    expect(ALLOWED_LISTING_KINDS).toContain("triage");
    expect(ALLOWED_LISTING_KINDS).toContain("fix");
    expect(ALLOWED_LISTING_KINDS).toContain("heal_bot");
    expect(ALLOWED_LISTING_KINDS).toContain("deploy_watch");
  });
});

// ---------------------------------------------------------------------------
// Route auth smokes
// ---------------------------------------------------------------------------

describe("agent-marketplace — route auth smokes", () => {
  it("GET /marketplace/agents (public) → 200", async () => {
    const res = await app.fetch(new Request("http://test/marketplace/agents"));
    expect(res.status).toBe(200);
  });

  it("POST /marketplace/agents/:slug/install without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/marketplace/agents/any/install", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ repo_id: "x" }),
      })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("POST /marketplace/agents/:slug/uninstall without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/marketplace/agents/any/uninstall", {
        method: "POST",
      })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("GET /settings/agent-listings without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/settings/agent-listings")
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("POST /settings/agent-listings without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/settings/agent-listings", { method: "POST" })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("POST /settings/agent-listings/:id/publish without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/settings/agent-listings/00000000-0000-0000-0000-000000000000/publish",
        { method: "POST" }
      )
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("GET /admin/marketplace/agents without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/admin/marketplace/agents")
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });
});
