/**
 * Third-party integrations registry.
 *
 * Each integration is a row in the `integrations` table that maps a repo +
 * event-kind to an outbound webhook in some other product's native shape.
 * v1 ships connectors for Slack, Discord, Linear, Vercel, Jira (Atlassian
 * webhook), PagerDuty (Events V2), Sentry (project webhook), Datadog
 * (events API), Figma (file comments — placeholder), Cursor (generic), and
 * a generic JSON webhook fallback.
 *
 * `deliverEvent(repoId, event, payload)` looks up every enabled integration
 * subscribed to `event` and POSTs the connector's rendered payload. Each
 * delivery records a row in `integration_deliveries` (status, http code,
 * duration). Never throws into the caller.
 *
 * Auth model:
 *   - Each integration's `config` JSON carries the connector-specific
 *     credentials (webhookUrl, channel, projectKey, integrationKey, ...).
 *   - We do NOT round-trip secrets to the UI. Reads go through `redactConfig`.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  integrations,
  integrationDeliveries,
  type Integration,
  type NewIntegration,
} from "../db/schema";

export const INTEGRATION_KINDS = [
  "slack",
  "discord",
  "linear",
  "vercel",
  "jira",
  "pagerduty",
  "sentry",
  "datadog",
  "figma",
  "cursor",
  "generic_webhook",
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const INTEGRATION_EVENTS = [
  "push",
  "pr.opened",
  "pr.merged",
  "pr.closed",
  "issue.opened",
  "issue.closed",
  "deploy.success",
  "deploy.failed",
  "gate.failed",
  "ai.repair",
  "ai.incident",
] as const;
export type IntegrationEvent = (typeof INTEGRATION_EVENTS)[number];

export interface ConnectorMeta {
  kind: IntegrationKind;
  label: string;
  description: string;
  /** Names of the config fields users must fill in. */
  configFields: { name: string; label: string; required: boolean; secret?: boolean }[];
}

export const CONNECTORS: ConnectorMeta[] = [
  {
    kind: "slack",
    label: "Slack",
    description: "Post events to a Slack channel via an incoming webhook.",
    configFields: [
      { name: "webhookUrl", label: "Incoming webhook URL", required: true, secret: true },
      { name: "channel", label: "Channel override (optional)", required: false },
    ],
  },
  {
    kind: "discord",
    label: "Discord",
    description: "Post events to a Discord channel via a server webhook.",
    configFields: [
      { name: "webhookUrl", label: "Webhook URL", required: true, secret: true },
    ],
  },
  {
    kind: "linear",
    label: "Linear",
    description: "Mirror gluecron events into Linear via their generic webhook.",
    configFields: [
      { name: "webhookUrl", label: "Linear webhook URL", required: true, secret: true },
      { name: "teamKey", label: "Team key (e.g. ENG)", required: false },
    ],
  },
  {
    kind: "vercel",
    label: "Vercel",
    description: "Trigger a Vercel deploy hook on every push to main.",
    configFields: [
      { name: "deployHookUrl", label: "Deploy hook URL", required: true, secret: true },
    ],
  },
  {
    kind: "jira",
    label: "Jira",
    description: "Forward gluecron events into Jira (incoming webhook).",
    configFields: [
      { name: "webhookUrl", label: "Jira webhook URL", required: true, secret: true },
      { name: "projectKey", label: "Project key", required: false },
    ],
  },
  {
    kind: "pagerduty",
    label: "PagerDuty",
    description:
      "Open / resolve incidents via the PagerDuty Events V2 API. Best for deploy.failed and gate.failed.",
    configFields: [
      { name: "integrationKey", label: "Routing key (integration key)", required: true, secret: true },
      { name: "severity", label: "Severity (info|warning|error|critical)", required: false },
    ],
  },
  {
    kind: "sentry",
    label: "Sentry",
    description: "Notify Sentry (alert webhook) on AI incidents and gate failures.",
    configFields: [
      { name: "webhookUrl", label: "Sentry alert webhook URL", required: true, secret: true },
    ],
  },
  {
    kind: "datadog",
    label: "Datadog",
    description: "Post gluecron events to the Datadog events API.",
    configFields: [
      { name: "apiKey", label: "DD-API-KEY", required: true, secret: true },
      { name: "site", label: "Site (e.g. datadoghq.com)", required: false },
    ],
  },
  {
    kind: "figma",
    label: "Figma",
    description: "Generic webhook into Figma plugins. v1 sends generic JSON.",
    configFields: [
      { name: "webhookUrl", label: "Webhook URL", required: true, secret: true },
    ],
  },
  {
    kind: "cursor",
    label: "Cursor",
    description: "Mirror events into Cursor / any IDE bridge that listens on a webhook.",
    configFields: [
      { name: "webhookUrl", label: "Webhook URL", required: true, secret: true },
    ],
  },
  {
    kind: "generic_webhook",
    label: "Generic webhook",
    description: "POST raw JSON to any URL. Use this for anything not above.",
    configFields: [
      { name: "webhookUrl", label: "URL", required: true, secret: true },
      { name: "secret", label: "HMAC secret (optional)", required: false, secret: true },
    ],
  },
];

export function getConnector(kind: string): ConnectorMeta | null {
  return CONNECTORS.find((c) => c.kind === kind) ?? null;
}

export function isValidKind(k: string): k is IntegrationKind {
  return (INTEGRATION_KINDS as readonly string[]).includes(k);
}

export function isValidEvent(e: string): e is IntegrationEvent {
  return (INTEGRATION_EVENTS as readonly string[]).includes(e);
}

/** Strip secret-marked fields before round-tripping config to the UI. */
export function redactConfig(
  kind: IntegrationKind,
  config: Record<string, unknown>
): Record<string, unknown> {
  const meta = getConnector(kind);
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const field of meta.configFields) {
    const v = config[field.name];
    if (v == null) continue;
    if (field.secret) {
      const s = String(v);
      out[field.name] = s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-2)}` : "***";
    } else {
      out[field.name] = v;
    }
  }
  return out;
}

export interface CreateInput {
  repositoryId: string;
  kind: IntegrationKind;
  name: string;
  config: Record<string, unknown>;
  events: IntegrationEvent[];
  createdBy?: string | null;
}

export async function createIntegration(input: CreateInput): Promise<Integration | null> {
  const validation = validateConfig(input.kind, input.config);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const validEvents = (input.events ?? []).filter(isValidEvent);
  const insert: NewIntegration = {
    repositoryId: input.repositoryId,
    kind: input.kind,
    name: input.name.trim().slice(0, 80) || "(unnamed)",
    enabled: true,
    config: input.config,
    events: validEvents,
    createdBy: input.createdBy ?? null,
  };
  try {
    const [row] = await db.insert(integrations).values(insert).returning();
    return row ?? null;
  } catch (err) {
    console.error("[integrations] create failed:", err);
    return null;
  }
}

export async function updateIntegration(
  id: string,
  patch: Partial<{
    name: string;
    enabled: boolean;
    config: Record<string, unknown>;
    events: IntegrationEvent[];
  }>
): Promise<Integration | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof patch.name === "string") updates.name = patch.name.trim().slice(0, 80);
  if (typeof patch.enabled === "boolean") updates.enabled = patch.enabled;
  if (patch.config) updates.config = patch.config;
  if (patch.events) updates.events = patch.events.filter(isValidEvent);
  try {
    const [row] = await db
      .update(integrations)
      .set(updates as never)
      .where(eq(integrations.id, id))
      .returning();
    return row ?? null;
  } catch (err) {
    console.error("[integrations] update failed:", err);
    return null;
  }
}

export async function deleteIntegration(id: string): Promise<boolean> {
  try {
    await db.delete(integrations).where(eq(integrations.id, id));
    return true;
  } catch (err) {
    console.error("[integrations] delete failed:", err);
    return false;
  }
}

export async function listForRepo(repositoryId: string): Promise<Integration[]> {
  try {
    return await db
      .select()
      .from(integrations)
      .where(eq(integrations.repositoryId, repositoryId));
  } catch {
    return [];
  }
}

export async function getById(id: string): Promise<Integration | null> {
  try {
    const [row] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

export async function listDeliveries(
  integrationId: string,
  limit = 25
): Promise<Array<typeof integrationDeliveries.$inferSelect>> {
  try {
    const rows = await db
      .select()
      .from(integrationDeliveries)
      .where(eq(integrationDeliveries.integrationId, integrationId))
      .limit(Math.max(1, Math.min(200, limit)));
    return rows;
  } catch {
    return [];
  }
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateConfig(
  kind: IntegrationKind,
  config: Record<string, unknown>
): ValidationResult {
  const meta = getConnector(kind);
  if (!meta) return { ok: false, error: `Unknown integration kind: ${kind}` };
  for (const field of meta.configFields) {
    if (!field.required) continue;
    const v = config[field.name];
    if (typeof v !== "string" || !v.trim()) {
      return { ok: false, error: `Missing required field: ${field.label}` };
    }
    if (field.name.toLowerCase().endsWith("url") && !isHttpUrl(String(v))) {
      return { ok: false, error: `${field.label} must be a valid http(s) URL` };
    }
  }
  return { ok: true };
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// ─── Delivery ────────────────────────────────────────────────

export interface DeliveryResult {
  integrationId: string;
  status: "ok" | "fail" | "skipped";
  httpStatus?: number;
  error?: string;
  durationMs: number;
}

/**
 * Find every integration on `repositoryId` subscribed to `event` and POST the
 * connector-rendered payload. Returns one DeliveryResult per integration.
 * Always resolves; never throws.
 */
export async function deliverEvent(
  repositoryId: string,
  event: IntegrationEvent | string,
  payload: Record<string, unknown>
): Promise<DeliveryResult[]> {
  if (!isValidEvent(event)) return [];
  let rows: Integration[] = [];
  try {
    rows = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.repositoryId, repositoryId),
          eq(integrations.enabled, true)
        )
      );
  } catch (err) {
    console.error("[integrations] list-for-delivery failed:", err);
    return [];
  }
  const subscribed = rows.filter((r) => {
    const evs = Array.isArray(r.events) ? (r.events as string[]) : [];
    return evs.includes(event);
  });
  const results: DeliveryResult[] = [];
  for (const row of subscribed) {
    const r = await deliverOne(row, event, payload);
    results.push(r);
    void recordDelivery(row.id, event, r);
  }
  return results;
}

/** Deliver a single integration. Used by the test-button on the UI. */
export async function deliverOne(
  integration: Integration,
  event: IntegrationEvent | string,
  payload: Record<string, unknown>
): Promise<DeliveryResult> {
  const t0 = Date.now();
  try {
    const rendered = render(
      integration.kind as IntegrationKind,
      integration.config as Record<string, unknown>,
      event,
      payload
    );
    if (!rendered) {
      return {
        integrationId: integration.id,
        status: "skipped",
        durationMs: Date.now() - t0,
      };
    }
    const response = await fetch(rendered.url, {
      method: rendered.method ?? "POST",
      headers: rendered.headers,
      body: rendered.body,
      signal: AbortSignal.timeout(10_000),
    });
    return {
      integrationId: integration.id,
      status: response.ok ? "ok" : "fail",
      httpStatus: response.status,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      integrationId: integration.id,
      status: "fail",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    };
  }
}

async function recordDelivery(
  integrationId: string,
  event: string,
  r: DeliveryResult
): Promise<void> {
  try {
    await db.insert(integrationDeliveries).values({
      integrationId,
      event,
      status: r.status,
      httpStatus: r.httpStatus ?? null,
      error: r.error ?? null,
      durationMs: r.durationMs,
    });
    await db
      .update(integrations)
      .set({
        lastDeliveryAt: new Date(),
        lastStatus: r.status,
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, integrationId));
  } catch {
    /* observability-only — never break delivery */
  }
}

// ─── Connector renderers ─────────────────────────────────────

interface RenderedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
}

export function render(
  kind: IntegrationKind,
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  switch (kind) {
    case "slack":
      return renderSlack(config, event, payload);
    case "discord":
      return renderDiscord(config, event, payload);
    case "linear":
      return renderLinear(config, event, payload);
    case "vercel":
      return renderVercel(config, event, payload);
    case "jira":
      return renderJira(config, event, payload);
    case "pagerduty":
      return renderPagerDuty(config, event, payload);
    case "sentry":
      return renderSentry(config, event, payload);
    case "datadog":
      return renderDatadog(config, event, payload);
    case "figma":
    case "cursor":
    case "generic_webhook":
      return renderGeneric(config, event, payload);
    default:
      return null;
  }
}

function summary(event: string, payload: Record<string, unknown>): string {
  const repo = String(payload.repository ?? "?");
  if (event === "push") return `Push to ${repo}`;
  if (event === "pr.opened") return `PR opened on ${repo}: ${payload.title ?? ""}`;
  if (event === "pr.merged") return `PR merged on ${repo}: ${payload.title ?? ""}`;
  if (event === "pr.closed") return `PR closed on ${repo}: ${payload.title ?? ""}`;
  if (event === "issue.opened") return `Issue opened on ${repo}: ${payload.title ?? ""}`;
  if (event === "issue.closed") return `Issue closed on ${repo}: ${payload.title ?? ""}`;
  if (event === "deploy.success") return `Deploy succeeded on ${repo}`;
  if (event === "deploy.failed") return `Deploy FAILED on ${repo}`;
  if (event === "gate.failed") return `Gate FAILED on ${repo}`;
  if (event === "ai.repair") return `Auto-repair on ${repo}`;
  if (event === "ai.incident") return `AI incident on ${repo}: ${payload.title ?? ""}`;
  return `${event} on ${repo}`;
}

function renderSlack(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  const url = String(config.webhookUrl ?? "");
  if (!isHttpUrl(url)) return null;
  const text = `*gluecron* — ${summary(event, payload)}`;
  const body: Record<string, unknown> = { text };
  if (config.channel) body.channel = config.channel;
  return {
    url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function renderDiscord(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  const url = String(config.webhookUrl ?? "");
  if (!isHttpUrl(url)) return null;
  const content = `**gluecron** — ${summary(event, payload)}`;
  return {
    url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  };
}

function renderLinear(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  const url = String(config.webhookUrl ?? "");
  if (!isHttpUrl(url)) return null;
  return {
    url,
    headers: { "Content-Type": "application/json", "User-Agent": "gluecron-linear/1" },
    body: JSON.stringify({
      type: "gluecron." + event,
      data: payload,
      teamKey: config.teamKey ?? null,
    }),
  };
}

function renderVercel(
  config: Record<string, unknown>,
  event: string,
  _payload: Record<string, unknown>
): RenderedRequest | null {
  // Vercel deploy hooks are POST-with-empty-body URLs; only fire on push +
  // deploy.success so we don't redeploy on noise.
  if (event !== "push" && event !== "deploy.success") return null;
  const url = String(config.deployHookUrl ?? "");
  if (!isHttpUrl(url)) return null;
  return { url, headers: {}, body: "" };
}

function renderJira(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  const url = String(config.webhookUrl ?? "");
  if (!isHttpUrl(url)) return null;
  return {
    url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookEvent: "gluecron:" + event,
      projectKey: config.projectKey ?? null,
      payload,
    }),
  };
}

function renderPagerDuty(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  const routing_key = String(config.integrationKey ?? "");
  if (!routing_key) return null;
  // Only escalate failures into PD by default.
  if (
    event !== "deploy.failed" &&
    event !== "gate.failed" &&
    event !== "ai.incident"
  ) {
    return null;
  }
  const severity =
    typeof config.severity === "string" &&
    ["info", "warning", "error", "critical"].includes(config.severity)
      ? config.severity
      : "error";
  const body = {
    routing_key,
    event_action: "trigger",
    payload: {
      summary: summary(event, payload),
      severity,
      source: "gluecron",
      custom_details: payload,
    },
  };
  return {
    url: "https://events.pagerduty.com/v2/enqueue",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function renderSentry(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  const url = String(config.webhookUrl ?? "");
  if (!isHttpUrl(url)) return null;
  return {
    url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: event,
      message: summary(event, payload),
      data: payload,
    }),
  };
}

function renderDatadog(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  const apiKey = String(config.apiKey ?? "");
  if (!apiKey) return null;
  const site = typeof config.site === "string" ? config.site : "datadoghq.com";
  const url = `https://api.${site}/api/v1/events`;
  return {
    url,
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": apiKey,
    },
    body: JSON.stringify({
      title: summary(event, payload),
      text: JSON.stringify(payload),
      tags: [`source:gluecron`, `event:${event}`],
      alert_type:
        event === "deploy.failed" || event === "gate.failed" ? "error" : "info",
    }),
  };
}

function renderGeneric(
  config: Record<string, unknown>,
  event: string,
  payload: Record<string, unknown>
): RenderedRequest | null {
  const url = String(config.webhookUrl ?? "");
  if (!isHttpUrl(url)) return null;
  const body = JSON.stringify({ event, payload, ts: new Date().toISOString() });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "gluecron-webhook/1",
    "X-Gluecron-Event": event,
  };
  if (typeof config.secret === "string" && config.secret.length > 0) {
    headers["X-Gluecron-Signature"] = hmacHex(String(config.secret), body);
  }
  return { url, headers, body };
}

function hmacHex(secret: string, body: string): string {
  // We need a sync-friendly call inside render(); subtle.crypto is async, so
  // fall back to a Node-style HMAC via dynamic require to avoid an upfront
  // dependency on `node:crypto`. Render() is hot but small.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require("node:crypto") as typeof import("node:crypto");
    return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  } catch {
    return "";
  }
}

export const __test = {
  render,
  validateConfig,
  redactConfig,
  summary,
  isHttpUrl,
  hmacHex,
};
