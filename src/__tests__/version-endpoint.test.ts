/**
 * /api/version smoke + build-info shape tests.
 */
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import versionRoutes from "../routes/version";
import { getBuildInfo } from "../lib/build-info";

describe("/api/version", () => {
  const app = new Hono();
  app.route("/", versionRoutes);

  it("returns 200 + JSON with sha + uptimeMs + builtAt", async () => {
    const res = await app.request("/api/version");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control") || "").toContain("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.sha).toBe("string");
    expect(typeof body.shaFull).toBe("string");
    expect(typeof body.branch).toBe("string");
    expect(typeof body.builtAt).toBe("string");
    expect(typeof body.uptimeMs).toBe("number");
    expect((body.sha as string).length).toBeGreaterThan(0);
  });

  it("returns short sha (7 chars or 'unknown')", () => {
    const b = getBuildInfo();
    expect(b.sha === "unknown" || b.sha.length === 7).toBe(true);
  });

  it("uptimeMs increments between calls", async () => {
    const a = getBuildInfo().uptimeMs;
    await new Promise((r) => setTimeout(r, 5));
    const b = getBuildInfo().uptimeMs;
    expect(b).toBeGreaterThan(a);
  });
});
