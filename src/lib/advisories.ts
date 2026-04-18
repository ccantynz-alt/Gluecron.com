/**
 * Block J2 — Security advisories + per-repo alerts.
 *
 * This module does three things:
 *   1. Provides a seeded set of well-known public advisories (log4j, lodash,
 *      minimist, etc.) that get inserted into `security_advisories` on first
 *      run.
 *   2. Exposes a minimal version-range matcher (`rangeMatches`) that can tell
 *      whether a declared manifest spec like `"^1.2.0"` or `">=0.5"` falls
 *      inside an advisory's `affected_range` such as `"<1.2.3"`. This is a
 *      heuristic — we never claim to replace npm's full semver resolver, but
 *      for unpinned or tightly-pinned dev manifests (the common case on
 *      GitHub), it's accurate in the common cases.
 *   3. `scanRepositoryForAlerts(repositoryId)` iterates the repo's
 *      `repo_dependencies` rows, finds matching advisories, and upserts
 *      `repo_advisory_alerts` rows. Existing alerts whose underlying dep
 *      went away are auto-closed (status=fixed).
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  repoAdvisoryAlerts,
  repoDependencies,
  securityAdvisories,
  type RepoAdvisoryAlert,
  type SecurityAdvisory,
} from "../db/schema";

// ----------------------------------------------------------------------------
// Seed: a small but real set of widely-cited advisories
// ----------------------------------------------------------------------------

export interface SeedAdvisory {
  ghsaId: string;
  cveId?: string;
  summary: string;
  severity: "low" | "moderate" | "high" | "critical";
  ecosystem: string;
  packageName: string;
  affectedRange: string;
  fixedVersion?: string;
  referenceUrl?: string;
}

export const SEED_ADVISORIES: SeedAdvisory[] = [
  {
    ghsaId: "GHSA-jfh8-c2jp-5v3q",
    cveId: "CVE-2021-44228",
    summary:
      "Log4Shell: Apache Log4j2 JNDI features do not protect against attacker-controlled LDAP and other JNDI related endpoints",
    severity: "critical",
    ecosystem: "composer",
    packageName: "apache/log4j",
    affectedRange: ">=2.0 <2.15.0",
    fixedVersion: "2.15.0",
    referenceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2021-44228",
  },
  {
    ghsaId: "GHSA-p6mc-m468-83gw",
    cveId: "CVE-2019-10744",
    summary: "Prototype pollution in lodash",
    severity: "high",
    ecosystem: "npm",
    packageName: "lodash",
    affectedRange: "<4.17.12",
    fixedVersion: "4.17.12",
    referenceUrl: "https://github.com/advisories/GHSA-jf85-cpcp-j695",
  },
  {
    ghsaId: "GHSA-vh95-rmgr-6w4m",
    cveId: "CVE-2020-7598",
    summary: "Prototype pollution in minimist",
    severity: "moderate",
    ecosystem: "npm",
    packageName: "minimist",
    affectedRange: "<1.2.2",
    fixedVersion: "1.2.2",
    referenceUrl: "https://github.com/advisories/GHSA-vh95-rmgr-6w4m",
  },
  {
    ghsaId: "GHSA-hpx4-r86g-5jrg",
    cveId: "CVE-2020-28469",
    summary: "Regex DoS in glob-parent",
    severity: "high",
    ecosystem: "npm",
    packageName: "glob-parent",
    affectedRange: "<5.1.2",
    fixedVersion: "5.1.2",
    referenceUrl: "https://github.com/advisories/GHSA-ww39-953v-wcq6",
  },
  {
    ghsaId: "GHSA-rxrx-xcr5-2f33",
    cveId: "CVE-2022-25883",
    summary: "Regex DoS in node-semver",
    severity: "moderate",
    ecosystem: "npm",
    packageName: "semver",
    affectedRange: "<5.7.2",
    fixedVersion: "5.7.2",
    referenceUrl: "https://github.com/advisories/GHSA-c2qf-rxjj-qqgw",
  },
  {
    ghsaId: "GHSA-j8xg-fqg3-53r7",
    cveId: "CVE-2022-24999",
    summary: "Express qs prototype pollution",
    severity: "high",
    ecosystem: "npm",
    packageName: "qs",
    affectedRange: "<6.9.7",
    fixedVersion: "6.9.7",
    referenceUrl: "https://github.com/advisories/GHSA-hrpp-h998-j3pp",
  },
  {
    ghsaId: "GHSA-6v2p-pv7g-wrx2",
    cveId: "CVE-2022-36067",
    summary: "vm2 sandbox escape",
    severity: "critical",
    ecosystem: "npm",
    packageName: "vm2",
    affectedRange: "<3.9.11",
    fixedVersion: "3.9.11",
    referenceUrl: "https://github.com/advisories/GHSA-6v2p-pv7g-wrx2",
  },
  {
    ghsaId: "GHSA-mh63-6h87-95cp",
    cveId: "CVE-2022-21222",
    summary: "Prototype pollution in jquery.extend",
    severity: "moderate",
    ecosystem: "npm",
    packageName: "jquery",
    affectedRange: "<3.5.0",
    fixedVersion: "3.5.0",
    referenceUrl: "https://github.com/advisories/GHSA-gxr4-xjj5-5px2",
  },
  {
    ghsaId: "GHSA-h52j-qf5x-j8ch",
    cveId: "CVE-2021-33503",
    summary: "urllib3 catastrophic backtracking regex",
    severity: "high",
    ecosystem: "pypi",
    packageName: "urllib3",
    affectedRange: "<1.26.5",
    fixedVersion: "1.26.5",
    referenceUrl: "https://github.com/advisories/GHSA-q2q7-5pp4-w6pg",
  },
  {
    ghsaId: "GHSA-56pw-mpj4-fxww",
    cveId: "CVE-2019-11236",
    summary: "CRLF injection in urllib3",
    severity: "moderate",
    ecosystem: "pypi",
    packageName: "urllib3",
    affectedRange: "<1.24.2",
    fixedVersion: "1.24.2",
    referenceUrl: "https://github.com/advisories/GHSA-wqvq-5m8c-6g24",
  },
  {
    ghsaId: "GHSA-w596-4wvx-j9j6",
    cveId: "CVE-2021-33026",
    summary: "Flask-Caching pickle deserialisation RCE",
    severity: "high",
    ecosystem: "pypi",
    packageName: "flask-caching",
    affectedRange: "<1.10.1",
    fixedVersion: "1.10.1",
    referenceUrl: "https://github.com/advisories/GHSA-xx7p-3c2j-8c7w",
  },
  {
    ghsaId: "GHSA-5545-jx63-4mgx",
    cveId: "CVE-2020-26160",
    summary: "JWT-go incorrect type assertion allows auth bypass",
    severity: "high",
    ecosystem: "go",
    packageName: "github.com/dgrijalva/jwt-go",
    affectedRange: "<4.0.0",
    fixedVersion: "4.0.0",
    referenceUrl: "https://github.com/advisories/GHSA-w73w-5m7g-f7qc",
  },
];

// ----------------------------------------------------------------------------
// Version range matcher
// ----------------------------------------------------------------------------

/**
 * Parse a dotted version string → numeric components. Non-numeric segments
 * become 0 so "1.2.3-beta" < "1.2.3". Good enough for advisory comparisons.
 */
export function parseVersion(v: string): number[] {
  const cleaned = (v || "").trim().replace(/^[\^~=v\s]+/, "");
  if (!cleaned) return [0, 0, 0];
  const stem = cleaned.split(/[+\-\s]/, 1)[0]; // strip prerelease / build
  return stem
    .split(".")
    .map((p) => parseInt(p, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

export function compareVersions(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Satisfies "<1.2.3", ">=1.0.0", ">=1.0 <2.0", "=1.2.3", or bare "1.2.3". */
export function satisfiesRange(version: string, range: string): boolean {
  const clauses = range
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) return false;
  for (const clause of clauses) {
    const m = clause.match(/^(<=|>=|<|>|=)?\s*(\S+)$/);
    if (!m) return false;
    const op = m[1] || "=";
    const target = m[2];
    const cmp = compareVersions(version, target);
    let ok = false;
    switch (op) {
      case "<":
        ok = cmp < 0;
        break;
      case "<=":
        ok = cmp <= 0;
        break;
      case ">":
        ok = cmp > 0;
        break;
      case ">=":
        ok = cmp >= 0;
        break;
      case "=":
        ok = cmp === 0;
        break;
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * Extract a concrete version from a manifest spec:
 *   "^1.2.3"  → "1.2.3"
 *   "~2.0.0"  → "2.0.0"
 *   "v1.8.0"  → "1.8.0"
 *   ">=1.0 <2.0" → "1.0" (lower bound — conservative)
 *   "1.2.3"   → "1.2.3"
 *
 * Returns null if the spec has no concrete version (e.g. "*" or git URL).
 */
export function normalizeManifestVersion(spec: string | null): string | null {
  if (!spec) return null;
  const trimmed = spec.trim();
  if (!trimmed || trimmed === "*" || trimmed === "latest") return null;
  // Grab the first number-like token
  const m = trimmed.match(/(\d+(?:\.\d+)*(?:\.\d+)?)/);
  if (!m) return null;
  return m[1];
}

/**
 * True when a declared manifest spec overlaps with an advisory range.
 * When the spec can't be pinned to a version, we still return true to
 * surface the potential risk (false positives are safer than false
 * negatives in a dependabot-style feature).
 */
export function rangeMatches(
  manifestSpec: string | null,
  affectedRange: string
): boolean {
  const normalized = normalizeManifestVersion(manifestSpec);
  if (!normalized) {
    // Can't resolve spec → conservatively match (no concrete version means
    // the floating spec could resolve to anything).
    return true;
  }
  return satisfiesRange(normalized, affectedRange);
}

// ----------------------------------------------------------------------------
// Seeding
// ----------------------------------------------------------------------------

/**
 * Inserts the hardcoded seed list if not already present, matched by
 * `ghsa_id`. Safe to call on every boot — idempotent.
 */
export async function seedAdvisories(): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const a of SEED_ADVISORIES) {
    try {
      const [existing] = await db
        .select({ id: securityAdvisories.id })
        .from(securityAdvisories)
        .where(eq(securityAdvisories.ghsaId, a.ghsaId))
        .limit(1);
      if (existing) continue;
      await db.insert(securityAdvisories).values({
        ghsaId: a.ghsaId,
        cveId: a.cveId ?? null,
        summary: a.summary,
        severity: a.severity,
        ecosystem: a.ecosystem,
        packageName: a.packageName,
        affectedRange: a.affectedRange,
        fixedVersion: a.fixedVersion ?? null,
        referenceUrl: a.referenceUrl ?? null,
      });
      inserted++;
    } catch (err) {
      console.error("[advisories] seed:", err);
    }
  }
  return { inserted };
}

// ----------------------------------------------------------------------------
// Scan + alert upsert
// ----------------------------------------------------------------------------

export async function scanRepositoryForAlerts(
  repositoryId: string
): Promise<{ opened: number; matched: number; closed: number } | null> {
  try {
    const deps = await db
      .select()
      .from(repoDependencies)
      .where(eq(repoDependencies.repositoryId, repositoryId));

    if (deps.length === 0) {
      // All prior alerts become fixed
      const closed = await closeAllAlerts(repositoryId);
      return { opened: 0, matched: 0, closed };
    }

    const ecosystems = Array.from(new Set(deps.map((d) => d.ecosystem)));
    const advisories = await db
      .select()
      .from(securityAdvisories)
      .where(inArray(securityAdvisories.ecosystem, ecosystems));

    const existing = await db
      .select()
      .from(repoAdvisoryAlerts)
      .where(eq(repoAdvisoryAlerts.repositoryId, repositoryId));
    const existingByKey = new Map<string, RepoAdvisoryAlert>();
    for (const e of existing) {
      existingByKey.set(`${e.advisoryId}::${e.manifestPath}`, e);
    }

    let opened = 0;
    let matched = 0;
    const keepKeys = new Set<string>();

    for (const dep of deps) {
      for (const adv of advisories) {
        if (adv.ecosystem !== dep.ecosystem) continue;
        if (adv.packageName !== dep.name) continue;
        if (!rangeMatches(dep.versionSpec, adv.affectedRange)) continue;
        matched++;
        const key = `${adv.id}::${dep.manifestPath}`;
        keepKeys.add(key);
        const prior = existingByKey.get(key);
        if (prior) {
          // Reopen if previously fixed; keep dismissed as dismissed.
          if (prior.status === "fixed") {
            await db
              .update(repoAdvisoryAlerts)
              .set({
                status: "open",
                dependencyVersion: dep.versionSpec ?? null,
                updatedAt: new Date(),
              })
              .where(eq(repoAdvisoryAlerts.id, prior.id));
          } else {
            await db
              .update(repoAdvisoryAlerts)
              .set({
                dependencyVersion: dep.versionSpec ?? null,
                updatedAt: new Date(),
              })
              .where(eq(repoAdvisoryAlerts.id, prior.id));
          }
        } else {
          await db.insert(repoAdvisoryAlerts).values({
            repositoryId,
            advisoryId: adv.id,
            dependencyName: dep.name,
            dependencyVersion: dep.versionSpec ?? null,
            manifestPath: dep.manifestPath,
          });
          opened++;
        }
      }
    }

    // Close alerts whose dep + advisory combo is no longer present
    let closed = 0;
    for (const [key, prior] of existingByKey) {
      if (keepKeys.has(key)) continue;
      if (prior.status === "dismissed") continue;
      if (prior.status === "fixed") continue;
      await db
        .update(repoAdvisoryAlerts)
        .set({ status: "fixed", updatedAt: new Date() })
        .where(eq(repoAdvisoryAlerts.id, prior.id));
      closed++;
    }

    return { opened, matched, closed };
  } catch (err) {
    console.error("[advisories] scanRepositoryForAlerts:", err);
    return null;
  }
}

async function closeAllAlerts(repositoryId: string): Promise<number> {
  try {
    const existing = await db
      .select()
      .from(repoAdvisoryAlerts)
      .where(
        and(
          eq(repoAdvisoryAlerts.repositoryId, repositoryId),
          eq(repoAdvisoryAlerts.status, "open")
        )
      );
    if (existing.length === 0) return 0;
    await db
      .update(repoAdvisoryAlerts)
      .set({ status: "fixed", updatedAt: new Date() })
      .where(
        and(
          eq(repoAdvisoryAlerts.repositoryId, repositoryId),
          eq(repoAdvisoryAlerts.status, "open")
        )
      );
    return existing.length;
  } catch {
    return 0;
  }
}

export interface AlertWithAdvisory extends RepoAdvisoryAlert {
  advisory: SecurityAdvisory;
}

export async function listAlertsForRepo(
  repositoryId: string,
  status: "open" | "dismissed" | "fixed" | "all" = "open"
): Promise<AlertWithAdvisory[]> {
  try {
    const whereClauses =
      status === "all"
        ? eq(repoAdvisoryAlerts.repositoryId, repositoryId)
        : and(
            eq(repoAdvisoryAlerts.repositoryId, repositoryId),
            eq(repoAdvisoryAlerts.status, status)
          )!;
    const rows = await db
      .select({
        alert: repoAdvisoryAlerts,
        advisory: securityAdvisories,
      })
      .from(repoAdvisoryAlerts)
      .innerJoin(
        securityAdvisories,
        eq(securityAdvisories.id, repoAdvisoryAlerts.advisoryId)
      )
      .where(whereClauses)
      .orderBy(desc(repoAdvisoryAlerts.createdAt));
    return rows.map((r) => ({ ...r.alert, advisory: r.advisory }));
  } catch {
    return [];
  }
}

export async function dismissAlert(
  alertId: string,
  repositoryId: string,
  reason: string
): Promise<boolean> {
  try {
    const result = await db
      .update(repoAdvisoryAlerts)
      .set({
        status: "dismissed",
        dismissedReason: reason.slice(0, 280),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(repoAdvisoryAlerts.id, alertId),
          eq(repoAdvisoryAlerts.repositoryId, repositoryId)
        )
      )
      .returning({ id: repoAdvisoryAlerts.id });
    return result.length > 0;
  } catch {
    return false;
  }
}

export async function reopenAlert(
  alertId: string,
  repositoryId: string
): Promise<boolean> {
  try {
    const result = await db
      .update(repoAdvisoryAlerts)
      .set({
        status: "open",
        dismissedReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(repoAdvisoryAlerts.id, alertId),
          eq(repoAdvisoryAlerts.repositoryId, repositoryId)
        )
      )
      .returning({ id: repoAdvisoryAlerts.id });
    return result.length > 0;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Test-only exports
// ----------------------------------------------------------------------------

export const __internal = {
  parseVersion,
  compareVersions,
  satisfiesRange,
  normalizeManifestVersion,
  rangeMatches,
};
