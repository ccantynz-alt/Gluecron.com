/**
 * Pure-function tests for the integrations connector layer.
 * Covers config validation, redaction, and per-connector renderers.
 * No DB calls — that surface is covered by route smoke tests downstream.
 */

import { describe, it, expect } from "bun:test";
import {
  CONNECTORS,
  INTEGRATION_KINDS,
  INTEGRATION_EVENTS,
  __test,
  getConnector,
  isHttpUrl,
  isValidEvent,
  isValidKind,
  redactConfig,
  validateConfig,
} from "../lib/integrations";

const { render, summary, hmacHex } = __test;

describe("integrations — registry shape", () => {
  it("exposes one connector per declared kind", () => {
    for (const kind of INTEGRATION_KINDS) {
      expect(getConnector(kind)).toBeTruthy();
    }
  });

  it("validates kind + event whitelists", () => {
    expect(isValidKind("slack")).toBe(true);
    expect(isValidKind("not-a-thing")).toBe(false);
    expect(isValidEvent("push")).toBe(true);
    expect(isValidEvent("nope")).toBe(false);
  });

  it("CONNECTORS list matches INTEGRATION_KINDS", () => {
    const kinds = new Set(CONNECTORS.map((c) => c.kind));
    for (const k of INTEGRATION_KINDS) expect(kinds.has(k)).toBe(true);
  });
});

describe("integrations — isHttpUrl", () => {
  it("accepts http(s) only", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("not-a-url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("integrations — validateConfig", () => {
  it("flags missing required fields", () => {
    const r = validateConfig("slack", {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Incoming webhook URL");
  });

  it("flags non-URL values for URL fields", () => {
    const r = validateConfig("slack", { webhookUrl: "not-a-url" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("URL");
  });

  it("accepts a valid Slack config", () => {
    const r = validateConfig("slack", {
      webhookUrl: "https://hooks.slack.com/services/xxx",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown kind", () => {
    const r = validateConfig("not-a-kind" as never, {});
    expect(r.ok).toBe(false);
  });

  it("PagerDuty requires only the routing key (no URL)", () => {
    expect(
      validateConfig("pagerduty", { integrationKey: "abc123" }).ok
    ).toBe(true);
    expect(validateConfig("pagerduty", {}).ok).toBe(false);
  });
});

describe("integrations — redactConfig", () => {
  it("redacts secret fields", () => {
    const out = redactConfig("slack", {
      webhookUrl: "https://hooks.slack.com/services/T0/B0/abc123",
      channel: "#eng",
    });
    expect(typeof out.webhookUrl).toBe("string");
    expect(String(out.webhookUrl)).toContain("…");
    expect(out.channel).toBe("#eng");
  });

  it("returns short-form for very short secrets", () => {
    const out = redactConfig("slack", { webhookUrl: "abcd" });
    expect(String(out.webhookUrl)).toBe("***");
  });

  it("ignores unknown fields", () => {
    const out = redactConfig("slack", { mystery: "value" });
    expect(out.mystery).toBeUndefined();
  });
});

describe("integrations — summary helper", () => {
  it("formats per-event human strings", () => {
    expect(summary("push", { repository: "a/b" })).toContain("Push to a/b");
    expect(summary("pr.opened", { repository: "a/b", title: "T" })).toContain(
      "PR opened"
    );
    expect(summary("deploy.failed", { repository: "a/b" })).toContain("FAILED");
  });
});

describe("integrations — render Slack", () => {
  it("returns null on missing webhook", () => {
    expect(
      render("slack", {}, "push", { repository: "a/b" })
    ).toBeNull();
  });
  it("renders a JSON Slack body", () => {
    const r = render(
      "slack",
      { webhookUrl: "https://hooks.slack.com/services/abc" },
      "push",
      { repository: "a/b" }
    )!;
    expect(r.url).toContain("hooks.slack.com");
    expect(r.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(r.body).text).toContain("Push to a/b");
  });
  it("includes channel override when provided", () => {
    const r = render(
      "slack",
      {
        webhookUrl: "https://hooks.slack.com/services/abc",
        channel: "#eng",
      },
      "push",
      { repository: "a/b" }
    )!;
    expect(JSON.parse(r.body).channel).toBe("#eng");
  });
});

describe("integrations — render Discord", () => {
  it("renders a content payload", () => {
    const r = render(
      "discord",
      { webhookUrl: "https://discord.com/api/webhooks/x/y" },
      "pr.opened",
      { repository: "a/b", title: "PR" }
    )!;
    expect(JSON.parse(r.body).content).toContain("PR opened");
  });
});

describe("integrations — render Vercel", () => {
  it("only fires on push or deploy.success", () => {
    expect(
      render(
        "vercel",
        { deployHookUrl: "https://api.vercel.com/v1/integrations/deploy/x" },
        "issue.opened",
        { repository: "a/b" }
      )
    ).toBeNull();
    const r = render(
      "vercel",
      { deployHookUrl: "https://api.vercel.com/v1/integrations/deploy/x" },
      "push",
      { repository: "a/b" }
    )!;
    expect(r.url).toContain("vercel.com");
    expect(r.body).toBe("");
  });
});

describe("integrations — render PagerDuty", () => {
  it("only escalates failures", () => {
    expect(
      render("pagerduty", { integrationKey: "k" }, "push", { repository: "a/b" })
    ).toBeNull();
    const r = render("pagerduty", { integrationKey: "k" }, "deploy.failed", {
      repository: "a/b",
    })!;
    const body = JSON.parse(r.body);
    expect(body.routing_key).toBe("k");
    expect(body.event_action).toBe("trigger");
    expect(body.payload.severity).toBe("error");
  });
  it("respects user-set severity", () => {
    const r = render(
      "pagerduty",
      { integrationKey: "k", severity: "critical" },
      "ai.incident",
      { repository: "a/b", title: "down" }
    )!;
    expect(JSON.parse(r.body).payload.severity).toBe("critical");
  });
});

describe("integrations — render Datadog", () => {
  it("requires apiKey, defaults site, alert_type maps from event", () => {
    expect(render("datadog", {}, "push", { repository: "a/b" })).toBeNull();
    const r = render("datadog", { apiKey: "k" }, "deploy.failed", {
      repository: "a/b",
    })!;
    expect(r.url).toContain("api.datadoghq.com");
    expect(r.headers["DD-API-KEY"]).toBe("k");
    expect(JSON.parse(r.body).alert_type).toBe("error");
  });
});

describe("integrations — render generic_webhook", () => {
  it("requires a URL", () => {
    expect(
      render("generic_webhook", {}, "push", { repository: "a/b" })
    ).toBeNull();
  });
  it("signs body when secret is set", () => {
    const r = render(
      "generic_webhook",
      {
        webhookUrl: "https://example.com/hook",
        secret: "shh",
      },
      "push",
      { repository: "a/b" }
    )!;
    expect(r.headers["X-Gluecron-Signature"]).toContain("sha256=");
  });
  it("omits signature without secret", () => {
    const r = render(
      "generic_webhook",
      { webhookUrl: "https://example.com/hook" },
      "push",
      { repository: "a/b" }
    )!;
    expect(r.headers["X-Gluecron-Signature"]).toBeUndefined();
  });
});

describe("integrations — hmacHex", () => {
  it("produces deterministic sha256 digests", () => {
    const a = hmacHex("k", "body");
    const b = hmacHex("k", "body");
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("integrations — INTEGRATION_EVENTS shape", () => {
  it("includes the canonical lifecycle events", () => {
    for (const ev of [
      "push",
      "pr.opened",
      "pr.merged",
      "deploy.success",
      "deploy.failed",
      "ai.repair",
      "ai.incident",
    ]) {
      expect(INTEGRATION_EVENTS).toContain(ev as never);
    }
  });
});
