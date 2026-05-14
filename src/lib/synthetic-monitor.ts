/**
 * BLOCK S4 — Synthetic monitor.
 *
 * Runs a small URL-only smoke suite against the live site on every
 * autopilot tick (5 min for v1; 60 s goal tracked as a follow-up). Each
 * check has a 5 s timeout. Results are persisted to `synthetic_checks`
 * and published on the SSE topic `monitor:synthetic` so the /admin/status
 * dashboard can light up red without a page reload.
 *
 * The check list is URL-only on purpose — this module must never depend
 * on the DB, the AI client, or anything else that the autopilot tick
 * itself owns. If the site is on fire, this is the layer that tells us.
 */
import { desc, sql } from "drizzle-orm";
import { db } from "../db";
import { syntheticChecks } from "../db/schema";
import { config } from "./config";
import { publish } from "./sse";

export type SyntheticCheckStatus = "green" | "red" | "yellow";

export interface SyntheticCheckResult {
  name: string;
  status: SyntheticCheckStatus;
  statusCode?: number;
  durationMs: number;
  error?: string;
}

export interface SyntheticCheckSpec {
  name: string;
  /** Relative path; prepended with APP_BASE_URL or `opts.baseUrl`. */
  url: string;
  /** Acceptable HTTP status(es). Defaults to 200. */
  expectStatus?: number | number[];
  /**
   * If set, response body must parse as JSON and contain this top-level
   * key (key presence — value can be any non-undefined). Implies a JSON
   * Accept header.
   */
  expectKeyInJson?: string;
  /** If set, body string must contain this substring (case-sensitive). */
  expectContains?: string;
  /** Per-check timeout in ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Topic published to whenever a check completes. */
export const SSE_TOPIC = "monitor:synthetic";

/** Default per-check timeout. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The S4 check list — URL-only, mirrors the S1+S3 smoke suite minus the
 * migration check (which would have to talk to the DB).
 */
export const SYNTHETIC_CHECKS: ReadonlyArray<SyntheticCheckSpec> = [
  { name: "healthz", url: "/healthz", expectKeyInJson: "ok" },
  { name: "readyz", url: "/readyz" },
  { name: "version", url: "/api/version", expectKeyInJson: "sha" },
  { name: "login", url: "/login", expectContains: "Sign in" },
  { name: "register", url: "/register", expectContains: "Create account" },
  { name: "landing", url: "/" },
  { name: "explore", url: "/explore" },
  { name: "pricing", url: "/pricing" },
  { name: "status", url: "/status" },
  { name: "manifest", url: "/manifest.webmanifest" },
  { name: "sw.js", url: "/sw.js" },
  { name: "gluecron.dxt", url: "/gluecron.dxt" },
  { name: "mcp discovery", url: "/mcp", expectKeyInJson: "serverInfo" },
  { name: "robots.txt", url: "/robots.txt" },
];

function statusMatches(
  expect: number | number[] | undefined,
  actual: number
): boolean {
  if (expect === undefined) return actual === 200;
  if (Array.isArray(expect)) return expect.includes(actual);
  return expect === actual;
}

async function runOneCheck(
  spec: SyntheticCheckSpec,
  baseUrl: string,
  fetchImpl: typeof fetch
): Promise<SyntheticCheckResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fullUrl = baseUrl.replace(/\/+$/, "") + spec.url;
  const t0 = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "User-Agent": "gluecron-synthetic-monitor/1",
    };
    if (spec.expectKeyInJson) headers["Accept"] = "application/json";

    const res = await fetchImpl(fullUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "manual",
    });
    const durationMs = Date.now() - t0;

    if (!statusMatches(spec.expectStatus, res.status)) {
      return {
        name: spec.name,
        status: "red",
        statusCode: res.status,
        durationMs,
        error: `expected status ${JSON.stringify(spec.expectStatus ?? 200)}, got ${res.status}`,
      };
    }

    if (spec.expectKeyInJson || spec.expectContains) {
      const body = await res.text();
      if (spec.expectKeyInJson) {
        let parsed: any;
        try {
          parsed = JSON.parse(body);
        } catch {
          return {
            name: spec.name,
            status: "red",
            statusCode: res.status,
            durationMs,
            error: `expected JSON body with key "${spec.expectKeyInJson}", got non-JSON`,
          };
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !(spec.expectKeyInJson in parsed)
        ) {
          return {
            name: spec.name,
            status: "red",
            statusCode: res.status,
            durationMs,
            error: `expected key "${spec.expectKeyInJson}" in JSON response`,
          };
        }
      }
      if (spec.expectContains && !body.includes(spec.expectContains)) {
        return {
          name: spec.name,
          status: "red",
          statusCode: res.status,
          durationMs,
          error: `expected body to contain "${spec.expectContains}"`,
        };
      }
    }

    return {
      name: spec.name,
      status: "green",
      statusCode: res.status,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : err.message
        : String(err ?? "unknown error");
    return {
      name: spec.name,
      status: "red",
      durationMs,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every check in SYNTHETIC_CHECKS in parallel and return one result
 * per check. Each individual check is wrapped in try/catch and obeys its
 * own timeout — a slow check cannot wedge the others.
 *
 * Pure-ish: takes a fetch implementation + base URL so unit tests can
 * inject fakes without touching the network.
 */
export async function runSyntheticChecks(opts?: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  checks?: ReadonlyArray<SyntheticCheckSpec>;
}): Promise<SyntheticCheckResult[]> {
  const baseUrl = opts?.baseUrl ?? config.appBaseUrl;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const checks = opts?.checks ?? SYNTHETIC_CHECKS;
  return Promise.all(checks.map((c) => runOneCheck(c, baseUrl, fetchImpl)));
}

/**
 * Persist a batch of results into `synthetic_checks` and publish each
 * one onto the SSE topic. Never throws — a DB hiccup must not kill the
 * autopilot tick.
 */
export async function persistChecks(
  results: SyntheticCheckResult[]
): Promise<void> {
  if (results.length === 0) return;
  try {
    await db.insert(syntheticChecks).values(
      results.map((r) => ({
        checkName: r.name,
        status: r.status,
        statusCode: r.statusCode ?? null,
        durationMs: r.durationMs,
        error: r.error ?? null,
      }))
    );
  } catch (err) {
    console.error("[synthetic-monitor] persist failed:", err);
  }
  for (const r of results) {
    try {
      publish(SSE_TOPIC, { event: "check", data: r });
    } catch {
      // sse.publish already swallows; belt-and-braces.
    }
  }
}

/**
 * Return the most-recent recorded result per check_name. Used by the
 * /admin/status renderer + the auto-merge transition detector. Returns
 * an empty object on any DB error.
 */
export async function latestStatusByCheck(): Promise<
  Record<string, SyntheticCheckResult & { checkedAt: Date }>
> {
  try {
    // DISTINCT ON (check_name) — Postgres pattern: ORDER BY check_name,
    // checked_at DESC and keep the first row per name.
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (check_name)
        check_name, status, status_code, duration_ms, error, checked_at
      FROM synthetic_checks
      ORDER BY check_name ASC, checked_at DESC
    `);
    const out: Record<string, SyntheticCheckResult & { checkedAt: Date }> = {};
    // Drizzle's `db.execute(sql\`...\`)` returns an iterable of records.
    const list: any[] = Array.isArray(rows)
      ? (rows as any[])
      : (rows as any).rows ?? [];
    for (const r of list) {
      const name = String(r.check_name ?? r.checkName ?? "");
      if (!name) continue;
      out[name] = {
        name,
        status: (r.status as SyntheticCheckStatus) ?? "red",
        statusCode:
          r.status_code === null || r.status_code === undefined
            ? undefined
            : Number(r.status_code),
        durationMs: Number(r.duration_ms ?? r.durationMs ?? 0),
        error: r.error ?? undefined,
        checkedAt: new Date(r.checked_at ?? r.checkedAt ?? Date.now()),
      };
    }
    return out;
  } catch (err) {
    console.error("[synthetic-monitor] latestStatusByCheck failed:", err);
    return {};
  }
}

/**
 * Return red rows from the last `hours` hours, newest-first. Used by
 * `/status` "Recent incidents" + the /admin/status detail page.
 */
export async function recentRedChecks(
  hours: number = 24,
  limit: number = 50
): Promise<Array<SyntheticCheckResult & { checkedAt: Date }>> {
  try {
    const rows = await db
      .select()
      .from(syntheticChecks)
      .where(sql`${syntheticChecks.status} = 'red' AND ${syntheticChecks.checkedAt} > now() - (${hours} || ' hours')::interval`)
      .orderBy(desc(syntheticChecks.checkedAt))
      .limit(limit);
    return rows.map((r) => ({
      name: r.checkName,
      status: r.status as SyntheticCheckStatus,
      statusCode: r.statusCode ?? undefined,
      durationMs: r.durationMs,
      error: r.error ?? undefined,
      checkedAt: r.checkedAt,
    }));
  } catch (err) {
    console.error("[synthetic-monitor] recentRedChecks failed:", err);
    return [];
  }
}

/** Exported for tests + the autopilot transition detector. */
export const __test = {
  runOneCheck,
  statusMatches,
};
