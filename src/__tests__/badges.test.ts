/**
 * Block J10 — Badge renderer tests + route smokes.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  colorForState,
  escapeXml,
  estimateTextWidth,
  renderBadge,
} from "../lib/badge";

describe("badge — escapeXml", () => {
  it("escapes the five standard chars", () => {
    expect(escapeXml("<a & b > c \"d\" 'e'")).toBe(
      "&lt;a &amp; b &gt; c &quot;d&quot; &#39;e&#39;"
    );
  });

  it("returns empty for empty input", () => {
    expect(escapeXml("")).toBe("");
  });
});

describe("badge — estimateTextWidth", () => {
  it("returns 0 for empty", () => {
    expect(estimateTextWidth("")).toBe(0);
  });

  it("scales roughly linearly with string length", () => {
    const a = estimateTextWidth("abcd");
    const b = estimateTextWidth("abcdabcd");
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(a * 2.5);
  });

  it("handles punctuation + digits without throwing", () => {
    expect(() => estimateTextWidth("Hi! 12.3%")).not.toThrow();
  });
});

describe("badge — colorForState", () => {
  it("maps success / passed to green", () => {
    expect(colorForState("success")).toBe("green");
    expect(colorForState("passed")).toBe("green");
  });

  it("maps pending to yellow", () => {
    expect(colorForState("pending")).toBe("yellow");
  });

  it("maps failure / failed / error to red", () => {
    expect(colorForState("failure")).toBe("red");
    expect(colorForState("failed")).toBe("red");
    expect(colorForState("error")).toBe("red");
  });

  it("unknown → grey", () => {
    expect(colorForState("unknown" as any)).toBe("grey");
  });
});

describe("badge — renderBadge", () => {
  it("emits well-formed SVG with label + value + title", () => {
    const svg = renderBadge({ label: "build", value: "passing", color: "green" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.includes("</svg>")).toBe(true);
    expect(svg.includes("build")).toBe(true);
    expect(svg.includes("passing")).toBe(true);
    expect(svg.includes("<title>build: passing</title>")).toBe(true);
  });

  it("honours named colours", () => {
    expect(renderBadge({ label: "x", value: "y", color: "red" })).toContain(
      "#da3633"
    );
    expect(renderBadge({ label: "x", value: "y", color: "green" })).toContain(
      "#2ea043"
    );
  });

  it("falls back to grey for unknown colour", () => {
    const svg = renderBadge({ label: "x", value: "y", color: "puce" });
    expect(svg).toContain("#586069");
  });

  it("accepts hex colour literals", () => {
    const svg = renderBadge({ label: "x", value: "y", color: "#abc" });
    expect(svg).toContain("#abc");
  });

  it("escapes markup in label + value", () => {
    const svg = renderBadge({ label: "<evil>", value: "\"v&v'", color: "blue" });
    expect(svg).toContain("&lt;evil&gt;");
    expect(svg).toContain("&quot;v&amp;v&#39;");
    expect(svg).not.toContain("<evil>");
  });

  it("clamps ridiculously long inputs to ≤64 chars each", () => {
    const long = "z".repeat(200);
    const svg = renderBadge({ label: long, value: long });
    // "z" is not used in any SVG attribute / tag name, so every occurrence
    // in the output comes from our label / value payloads. Each of label +
    // value appears in: <title>, aria-label, shadow <text>, main <text> —
    // so at most 64 chars × 2 payloads × 4 occurrences = 512. Unclamped a
    // 200-char payload would produce well over 1000.
    const matches = svg.match(/z/g) || [];
    expect(matches.length).toBeLessThan(600);
    expect(matches.length).toBeGreaterThan(0);
    // Sanity: SVG should be well under the unclamped size.
    expect(svg.length).toBeLessThan(2500);
  });
});

describe("badge — routes", () => {
  it("GET /:o/:r/badge/gates.svg returns SVG (even when repo missing)", async () => {
    const res = await app.request("/alice/nope/badge/gates.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<svg")).toBe(true);
  });

  it("GET /:o/:r/badge/issues.svg returns SVG", async () => {
    const res = await app.request("/alice/nope/badge/issues.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("GET /:o/:r/badge/prs.svg returns SVG", async () => {
    const res = await app.request("/alice/nope/badge/prs.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("GET /:o/:r/badge/status.svg returns SVG", async () => {
    const res = await app.request("/alice/nope/badge/status.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("GET /:o/:r/badge/status/:context.svg returns SVG", async () => {
    const res = await app.request("/alice/nope/badge/status/ci.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body).toContain("ci");
  });

  it("responses are Cache-Control aware", async () => {
    const res = await app.request("/alice/nope/badge/gates.svg");
    const cc = res.headers.get("cache-control") || "";
    expect(cc).toContain("max-age");
  });
});
