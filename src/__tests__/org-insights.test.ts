/**
 * Block F2 — Org insights smoke tests.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { computeOrgInsights } from "../routes/org-insights";

describe("org-insights — route smoke", () => {
  it("GET /orgs/:slug/insights without auth → 302 /login", async () => {
    const res = await app.request("/orgs/nobody/insights");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

describe("org-insights — computeOrgInsights", () => {
  it("returns empty summary for unknown org id", async () => {
    const s = await computeOrgInsights(
      "00000000-0000-0000-0000-000000000000"
    );
    expect(s.repoCount).toBe(0);
    expect(s.gateRunsTotal).toBe(0);
    expect(s.greenRate).toBe(0);
    expect(s.perRepo).toEqual([]);
  });
});
