/**
 * Block O3 — visual coherence tests.
 *
 * Asserts the design-token + component contract introduced by the O3
 * pass.
 *
 * NOTE: This test runs WITHOUT mock pollution — no `mock.module()`,
 * no shared global state, no DB. It only hits in-process HTTP routes
 * via `app.request()` and renders the canonical components directly
 * to strings via hono/jsx's built-in stringifier.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { Card } from "../views/ui";
import { Layout } from "../views/layout";

// hono/jsx exposes a stringifier on every node.
async function renderToString(node: any): Promise<string> {
  if (node && typeof node.toString === "function") {
    return String(await node.toString());
  }
  return String(node);
}

describe("O3 — design token aliases in master CSS", () => {
  it("layout.tsx exposes the --space-* alias scale", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("--space-1:");
    expect(body).toContain("--space-2:");
    expect(body).toContain("--space-3:");
    expect(body).toContain("--space-4:");
    expect(body).toContain("--space-6:");
    expect(body).toContain("--space-8:");
  });

  it("layout.tsx exposes the --radius-* alias scale", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("--radius-sm:");
    expect(body).toContain("--radius-md:");
    expect(body).toContain("--radius-lg:");
    expect(body).toContain("--radius-full:");
  });

  it("layout.tsx exposes the --font-size-* alias scale", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("--font-size-xs:");
    expect(body).toContain("--font-size-sm:");
    expect(body).toContain("--font-size-base:");
    expect(body).toContain("--font-size-lg:");
    expect(body).toContain("--font-size-xl:");
  });

  it("layout.tsx exposes the --leading-* aliases", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("--leading-tight:");
    expect(body).toContain("--leading-normal:");
    expect(body).toContain("--leading-loose:");
  });

  it("layout.tsx exposes the --z-* index scale", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("--z-nav:");
    expect(body).toContain("--z-modal:");
    expect(body).toContain("--z-toast:");
  });

  it("ships the notice / email-preview / code-block utility classes", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain(".notice");
    expect(body).toContain(".notice-warn");
    expect(body).toContain(".email-preview");
    expect(body).toContain(".code-block");
  });
});

describe("O3 — site-wide footer renders on every page", () => {
  // /explore queries the DB which is not available in the unit-test
  // process. Footer presence is well-covered by the other four pages.
  const PAGES = ["/", "/help", "/status", "/pricing"];

  for (const path of PAGES) {
    it(`GET ${path} includes the canonical footer`, async () => {
      const res = await app.request(path);
      expect(res.status).toBeLessThan(500);
      const body = await res.text();
      expect(body).toContain("<footer");
      expect(body.toLowerCase()).toContain("gluecron");
    });
  }
});

describe("O3 — Card component padding + variant props", () => {
  it("renders without props (legacy default)", async () => {
    const html = await renderToString(<Card>hello</Card>);
    expect(html).toContain('class="card"');
    expect(html).toContain("hello");
  });

  it('supports padding="none"', async () => {
    const html = await renderToString(<Card padding="none">x</Card>);
    expect(html).toContain("card-p-none");
  });

  it('supports padding="sm"', async () => {
    const html = await renderToString(<Card padding="sm">x</Card>);
    expect(html).toContain("card-p-sm");
  });

  it('supports padding="md"', async () => {
    const html = await renderToString(<Card padding="md">x</Card>);
    expect(html).toContain("card-p-md");
  });

  it('supports padding="lg"', async () => {
    const html = await renderToString(<Card padding="lg">x</Card>);
    expect(html).toContain("card-p-lg");
  });

  it('supports variant="elevated"', async () => {
    const html = await renderToString(<Card variant="elevated">x</Card>);
    expect(html).toContain("card-elevated");
  });

  it('supports variant="gradient"', async () => {
    const html = await renderToString(<Card variant="gradient">x</Card>);
    expect(html).toContain("card-gradient");
  });

  it("composes padding and variant together", async () => {
    const html = await renderToString(
      <Card padding="lg" variant="elevated">x</Card>
    );
    expect(html).toContain("card-p-lg");
    expect(html).toContain("card-elevated");
  });
});

describe("O3 — flag-gated footer banner", () => {
  it("does NOT render the .footer-banner stripe when siteBannerText is empty", async () => {
    const html = await renderToString(
      <Layout title="t">
        <p>body</p>
      </Layout>
    );
    expect(html).not.toContain('class="footer-banner');
  });

  it("renders the .footer-banner stripe when siteBannerText is non-empty", async () => {
    const html = await renderToString(
      <Layout title="t" siteBannerText="Scheduled maintenance tonight">
        <p>body</p>
      </Layout>
    );
    expect(html).toContain("footer-banner");
    expect(html).toContain("Scheduled maintenance tonight");
  });

  it("honours the siteBannerLevel modifier", async () => {
    const html = await renderToString(
      <Layout title="t" siteBannerText="x" siteBannerLevel="warn">
        <p>body</p>
      </Layout>
    );
    expect(html).toContain("footer-banner-warn");
  });
});

describe("O3 — no critical page leaks a banner stripe by default", () => {
  const PAGES = ["/", "/help", "/pricing"];

  for (const path of PAGES) {
    it(`GET ${path} does not render the footer-banner stripe by default`, async () => {
      const res = await app.request(path);
      const body = await res.text();
      expect(body).not.toContain('class="footer-banner');
    });
  }
});
