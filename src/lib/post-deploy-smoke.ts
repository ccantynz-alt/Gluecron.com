/**
 * Post-deploy smoke suite — pure helpers + DI'd runner.
 *
 * Block S1+S3: after every `systemctl restart` we curl a list of critical
 * endpoints and verify each returns the right status and shape. If ANY
 * check fails, the workflow auto-rolls back to the previous good SHA.
 *
 * This file is the PURE side of that suite: the CHECKS array, the
 * assertion helpers (assertStatus / assertKey / assertContains), the
 * runner (which takes a `fetch` impl via DI so tests don't hit the
 * network), and the migration-verification helper.
 *
 * The CLI driver lives in `scripts/post-deploy-smoke.ts`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Types ──────────────────────────────────────────────────────────

export interface Check {
  name: string;
  url: string;
  /** One status, or an array of acceptable status codes. */
  expectStatus: number | number[];
  /** Required JSON key in the response body (when set, response must be JSON). */
  expectKey?: string;
  /** Required substring in the response body (text or JSON). */
  expectContains?: string;
}

export interface CheckResult {
  name: string;
  url: string;
  status: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> }
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

// ─── The 15-endpoint smoke list ─────────────────────────────────────
//
// Every endpoint a customer touches in their first 60 seconds must be
// covered here. If a request crashes (e.g. selecting columns that
// don't exist because migrations didn't run), the test fails and the
// deploy rolls back automatically.

export const CHECKS: readonly Check[] = [
  { name: "healthz", url: "/healthz", expectStatus: 200, expectKey: "ok" },
  { name: "readyz", url: "/readyz", expectStatus: 200 },
  { name: "version", url: "/api/version", expectStatus: 200, expectKey: "sha" },
  {
    name: "login renders",
    url: "/login",
    expectStatus: 200,
    expectContains: "Sign in",
  },
  {
    name: "register renders",
    url: "/register",
    expectStatus: 200,
    expectContains: "Create account",
  },
  { name: "landing renders", url: "/", expectStatus: 200 },
  { name: "explore renders", url: "/explore", expectStatus: 200 },
  { name: "demo renders", url: "/demo", expectStatus: [200, 302] },
  { name: "pricing renders", url: "/pricing", expectStatus: 200 },
  { name: "status renders", url: "/status", expectStatus: 200 },
  // /api/v2 is the v2 surface; /api/v2/healthz isn't required to exist
  // yet, so 404 is also acceptable.
  { name: "api v2 health", url: "/api/v2/healthz", expectStatus: [200, 404] },
  {
    name: "mcp discovery",
    url: "/mcp",
    expectStatus: 200,
    expectKey: "serverInfo",
  },
  { name: "manifest", url: "/manifest.webmanifest", expectStatus: 200 },
  { name: "sw", url: "/sw.js", expectStatus: 200 },
  { name: "dxt download", url: "/gluecron.dxt", expectStatus: 200 },
];

// ─── Pure assertion helpers ─────────────────────────────────────────

/** Returns null on pass, an error string on fail. */
export function assertStatus(
  got: number,
  expected: number | number[]
): string | null {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (allowed.includes(got)) return null;
  return `expected status ${allowed.join("/")}, got ${got}`;
}

/** Returns null on pass, an error string on fail. */
export function assertKey(body: string, key: string): string | null {
  // expectKey implies JSON. Parse defensively — non-JSON is a failure.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `expected JSON with key "${key}", got non-JSON body`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `expected JSON object with key "${key}", got ${typeof parsed}`;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
    return `expected JSON key "${key}", not present`;
  }
  return null;
}

/** Returns null on pass, an error string on fail. */
export function assertContains(body: string, needle: string): string | null {
  if (body.includes(needle)) return null;
  return `expected body to contain ${JSON.stringify(needle)}`;
}

// ─── The runner ─────────────────────────────────────────────────────

export interface RunOptions {
  baseUrl: string;
  fetchImpl: FetchLike;
  checks?: readonly Check[];
  /** Optional clock for deterministic durations in tests. */
  now?: () => number;
  /** Optional sink for human-readable progress lines. */
  log?: (line: string) => void;
}

export interface RunSummary {
  results: CheckResult[];
  passed: number;
  failed: number;
  ok: boolean;
}

export async function runChecks(opts: RunOptions): Promise<RunSummary> {
  const checks = opts.checks ?? CHECKS;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => undefined);
  const results: CheckResult[] = [];

  for (const check of checks) {
    const t0 = now();
    let status = 0;
    let body = "";
    let fetchErr: string | undefined;
    try {
      const res = await opts.fetchImpl(opts.baseUrl + check.url);
      status = res.status;
      try {
        body = await res.text();
      } catch (err) {
        body = "";
        fetchErr = `body read failed: ${(err as Error).message}`;
      }
    } catch (err) {
      fetchErr = `fetch failed: ${(err as Error).message}`;
    }

    const durationMs = now() - t0;
    let error: string | null = fetchErr ?? null;
    if (!error) error = assertStatus(status, check.expectStatus);
    if (!error && check.expectKey) error = assertKey(body, check.expectKey);
    if (!error && check.expectContains)
      error = assertContains(body, check.expectContains);

    const result: CheckResult = {
      name: check.name,
      url: check.url,
      status,
      durationMs,
      ok: error === null,
      ...(error !== null ? { error } : {}),
    };
    results.push(result);
    log(
      `[smoke] ${result.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(20)} ${String(status).padStart(3)}  ${durationMs}ms${error ? "  — " + error : ""}`
    );
  }

  const failed = results.filter((r) => !r.ok).length;
  return {
    results,
    passed: results.length - failed,
    failed,
    ok: failed === 0,
  };
}

// ─── ASCII table for the workflow summary ───────────────────────────

export function formatTable(results: readonly CheckResult[]): string {
  const header = ["name", "status", "duration_ms", "result"];
  const rows = results.map((r) => [
    r.name,
    String(r.status),
    String(r.durationMs),
    r.ok ? "PASS" : `FAIL: ${r.error ?? "?"}`,
  ]);
  const all = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...all.map((row) => row[col].length))
  );
  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  return [fmt(header), sep, ...rows.map(fmt)].join("\n");
}

// ─── Migration verification helper ──────────────────────────────────

/**
 * Returns the list of migration file names that are present on disk
 * but NOT present in the DB-applied list. Empty list means "all good".
 *
 * Both inputs are bare file names (e.g. "0053_deploy_steps.sql") so
 * the caller is free to source them however they like (ls drizzle/*.sql
 * for files, SELECT name FROM _migrations for applied).
 */
export function missingMigrations(
  fileNames: readonly string[],
  appliedNames: readonly string[]
): string[] {
  const applied = new Set(appliedNames);
  return fileNames
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => !applied.has(name))
    .slice()
    .sort();
}

/**
 * Returns the latest migration file (lexicographic max .sql), or null
 * if the input is empty.
 */
export function latestMigration(fileNames: readonly string[]): string | null {
  const sql = fileNames.filter((n) => n.endsWith(".sql")).slice().sort();
  return sql.length === 0 ? null : sql[sql.length - 1];
}
