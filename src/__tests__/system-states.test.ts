/**
 * BLOCK O2 — Every system state polished.
 *
 * Covers the four polished surfaces:
 *   1. Error pages (404 / 500 / 403)
 *   2. Empty state component
 *   3. Skeleton component
 *   4. Form validation script
 *
 * No mock pollution — each test renders the real component to JSX
 * string output (or hits the real Hono router) and asserts on the
 * rendered HTML.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  ErrorPage,
  NotFoundPage,
  ServerErrorPage,
  ForbiddenPage,
  renderStandaloneErrorPage,
} from "../views/error-page";
import { EmptyState } from "../views/empty-state";
import {
  Skeleton,
  SkeletonList,
  SkeletonRepoRow,
} from "../views/skeleton";
import {
  formValidationScript,
  formValidationCss,
  FormValidationAssets,
} from "../views/form-validation-js";

// Render a JSX element to its HTML string via Hono's JSX runtime.
async function renderJsx(node: any): Promise<string> {
  if (node && typeof node === "object" && "toString" in node) {
    const s = await Promise.resolve(node.toString());
    return typeof s === "string" ? s : String(s);
  }
  return String(node);
}

describe("BLOCK O2 — Error pages", () => {
  it("GET unknown deep path returns the polished 404 page via app.notFound", async () => {
    // A path with 4+ segments doesn't match any defined route — falls
    // through to app.notFound. (`/:owner` would otherwise swallow a
    // single-segment 404 with a 200 user-profile shell on DB miss.)
    const res = await app.request("/__o2_unknown__/a/b/c/d");
    expect(res.status).toBe(404);
    const body = await res.text();
    // Big "404" gradient text
    expect(body).toContain("data-error-code=\"404\"");
    expect(body).toContain(">404<");
    expect(body).toContain("gradient-text");
    // Two CTAs (primary + secondary)
    expect(body).toMatch(/data-error-cta="primary"/);
    expect(body).toMatch(/data-error-cta="secondary"/);
    expect(body).toContain("Go home");
    expect(body).toContain("Status page");
    // Subhead/body
    expect(body).toContain("Not found");
  });

  it("ServerErrorPage component renders the 500 + request ID line", async () => {
    const node = ServerErrorPage({
      user: null,
      requestId: "req-test-abc-123",
    } as any);
    const body = await renderJsx(node);
    expect(body).toContain(">500<");
    expect(body).toContain("Server error");
    expect(body).toContain("Request ID:");
    expect(body).toContain("req-test-abc-123");
    // Two CTAs
    expect(body).toMatch(/data-error-cta="primary"/);
    expect(body).toMatch(/data-error-cta="secondary"/);
  });

  it("ForbiddenPage component renders the polished 403", async () => {
    const node = ForbiddenPage({ user: null } as any);
    const body = await renderJsx(node);
    expect(body).toContain(">403<");
    expect(body).toContain("Forbidden");
    expect(body).toContain("Admin access required");
    // Signed-out path → "Sign in" suggestion
    expect(body).toContain("Sign in");
  });

  it("ForbiddenPage when signed in offers 'sign in as different user'", async () => {
    const fakeUser: any = { id: "u1", username: "alice" };
    const node = ForbiddenPage({ user: fakeUser } as any);
    const body = await renderJsx(node);
    expect(body).toContain("Sign in as a different user");
    expect(body).toContain("/logout");
  });

  it("renderStandaloneErrorPage returns a complete <!doctype html> document", () => {
    const html = renderStandaloneErrorPage({
      code: "403",
      eyebrow: "Forbidden",
      title: "Admin access required.",
      body: "Body copy.",
      signedIn: true,
    });
    expect(html.toLowerCase()).toContain("<!doctype html>");
    expect(html).toContain("data-error-code=\"403\"");
    expect(html).toContain("Admin access required.");
    expect(html).toContain("Body copy.");
    // Self-contained — has its own <style> + gradient CSS for the code.
    expect(html).toContain("background-clip:text");
    // Signed-in CTA
    expect(html).toContain("Sign in as a different user");
  });

  it("ErrorPage component honours a custom Request ID + trace", async () => {
    const node = ErrorPage({
      code: "500",
      eyebrow: "Server error",
      title: "Boom.",
      body: "Body.",
      requestId: "req-xyz",
      trace: "Error: synthetic\n  at test",
    } as any);
    const body = await renderJsx(node);
    expect(body).toContain("req-xyz");
    expect(body).toContain("error-page-trace");
    expect(body).toContain("Error: synthetic");
  });
});

describe("BLOCK O2 — EmptyState component", () => {
  it("renders title, body and both CTAs", async () => {
    const node = EmptyState({
      icon: "🐛",
      title: "No issues yet",
      body: "When you or your team file issues, they'll appear here.",
      primaryCta: { href: "/new", label: "Open the first issue" },
      secondaryCta: { href: "/closed", label: "View closed" },
    } as any);
    const body = await renderJsx(node);
    expect(body).toContain("No issues yet");
    expect(body).toContain("When you or your team file issues");
    expect(body).toContain("Open the first issue");
    expect(body).toContain("View closed");
    expect(body).toContain("/new");
    expect(body).toContain("/closed");
    // The default icon SVG isn't used here because we passed an emoji.
    expect(body).toContain("🐛");
  });

  it("uses the default gradient SVG when icon is omitted", async () => {
    const node = EmptyState({
      title: "Nothing here",
      body: "Body.",
    } as any);
    const body = await renderJsx(node);
    // SVG gradient block is inlined.
    expect(body).toContain("linearGradient");
    expect(body).toContain("#8c6dff");
    expect(body).toContain("#36c5d6");
  });

  it("renders without CTAs when none are provided", async () => {
    const node = EmptyState({
      title: "Quiet",
      body: "Nothing to do.",
    } as any);
    const body = await renderJsx(node);
    expect(body).toContain("Quiet");
    // No <a class="btn"> markers
    expect(body).not.toContain('class="btn btn-primary"');
  });
});

describe("BLOCK O2 — Skeleton component", () => {
  it("renders the requested number of bars", async () => {
    const node = Skeleton({ count: 5, height: "14px" } as any);
    const body = await renderJsx(node);
    // 5 skeleton bars
    const matches = body.match(/class="skeleton-bar"/g) || [];
    expect(matches.length).toBe(5);
    // height inline
    expect(body).toContain("height:14px");
  });

  it("defaults to one bar", async () => {
    const node = Skeleton({} as any);
    const body = await renderJsx(node);
    const matches = body.match(/class="skeleton-bar"/g) || [];
    expect(matches.length).toBe(1);
  });

  it("SkeletonRepoRow renders an avatar circle and two text bars", async () => {
    const node = SkeletonRepoRow({} as any);
    const body = await renderJsx(node);
    expect(body).toContain("border-radius:50%");
    const matches = body.match(/class="skeleton-bar"/g) || [];
    expect(matches.length).toBe(3); // avatar + 2 text bars
  });

  it("SkeletonList renders N rep rows with aria-busy", async () => {
    const node = SkeletonList({ count: 3 } as any);
    const body = await renderJsx(node);
    const rows = body.match(/class="skeleton-repo-row"/g) || [];
    expect(rows.length).toBe(3);
    expect(body).toContain('aria-busy="true"');
    expect(body).toContain('role="status"');
  });

  it("emits the @keyframes skeleton-shimmer animation", async () => {
    const node = Skeleton({} as any);
    const body = await renderJsx(node);
    expect(body).toContain("@keyframes skeleton-shimmer");
    expect(body).toContain("background-position: 200% 0");
  });
});

describe("BLOCK O2 — formValidationScript", () => {
  it("is well-formed JS (parseable by the engine)", () => {
    // `new Function` throws SyntaxError on malformed JS.
    expect(() => {
      new Function(formValidationScript);
    }).not.toThrow();
  });

  it("contains the expected event handlers", () => {
    expect(formValidationScript).toContain('addEventListener("blur"');
    expect(formValidationScript).toContain('addEventListener("input"');
    expect(formValidationScript).toContain("__gluecronFormValidationMounted");
    // Guards against double-mount.
    expect(formValidationScript).toContain("if (window.__gluecronFormValidationMounted) return");
  });

  it("validates required / email / pattern / minlength / maxlength", () => {
    expect(formValidationScript).toContain('hasAttribute("required")');
    expect(formValidationScript).toContain('el.type === "email"');
    expect(formValidationScript).toContain('getAttribute("pattern")');
    expect(formValidationScript).toContain('getAttribute("minlength")');
    expect(formValidationScript).toContain('getAttribute("maxlength")');
  });

  it("respects data-validation-message overrides", () => {
    expect(formValidationScript).toContain('getAttribute("data-validation-message")');
    expect(formValidationScript).toContain('getAttribute("data-validation-required")');
  });

  it("formValidationCss exposes the .input-valid / .input-invalid / .field-error styles", () => {
    expect(formValidationCss).toContain(".input-invalid");
    expect(formValidationCss).toContain(".input-valid");
    expect(formValidationCss).toContain(".field-error");
    // SVG checkmark for green-state confirmation
    expect(formValidationCss).toContain("data:image/svg+xml");
  });

  it("FormValidationAssets emits both style and script tags", async () => {
    const node = FormValidationAssets({} as any);
    const body = await renderJsx(node);
    expect(body).toContain("<style");
    expect(body).toContain("<script");
    expect(body).toContain("input-invalid");
    expect(body).toContain("__gluecronFormValidationMounted");
  });
});

describe("BLOCK O2 — NotFoundPage component (unit, no HTTP)", () => {
  it("renders the 404 number, both CTAs, and the suggestion list", async () => {
    const node = NotFoundPage({ user: null, method: "GET", path: "/foo" } as any);
    const body = await renderJsx(node);
    expect(body).toContain(">404<");
    expect(body).toContain("Not found");
    expect(body).toContain("We can&#39;t find that page");
    // Two CTAs
    expect(body).toMatch(/data-error-cta="primary"/);
    expect(body).toMatch(/data-error-cta="secondary"/);
    // Method/path meta
    expect(body).toContain("GET /foo");
    // Suggestion list
    expect(body).toContain("Explore public repositories");
    expect(body).toContain("Read the quickstart guide");
  });
});
