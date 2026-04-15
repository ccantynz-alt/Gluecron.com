/**
 * Block J21 — CODEOWNERS validator UI.
 *
 *   GET /:owner/:repo/codeowners
 *
 * Lints the CODEOWNERS file at any of the standard locations (root,
 * `.github/`, `docs/`) on the default branch, using the pure validator
 * in `src/lib/codeowners-lint.ts`. Non-destructive — report-only.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  organizations,
  repositories,
  teams,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getBlob, getDefaultBranch } from "../git/repository";
import {
  validateCodeowners,
  type LintFinding,
  type LintReport,
  type OwnerResolver,
} from "../lib/codeowners-lint";

const codeownersRoutes = new Hono<AuthEnv>();

const CODEOWNERS_PATHS = [
  "CODEOWNERS",
  ".github/CODEOWNERS",
  "docs/CODEOWNERS",
];

async function resolveRepo(ownerName: string, repoName: string) {
  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) return null;
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

async function loadCodeowners(
  ownerName: string,
  repoName: string
): Promise<{ path: string; content: string } | null> {
  try {
    const defaultBranch =
      (await getDefaultBranch(ownerName, repoName)) || "main";
    for (const path of CODEOWNERS_PATHS) {
      try {
        const blob = await getBlob(ownerName, repoName, defaultBranch, path);
        if (blob && !blob.isBinary) {
          return { path, content: blob.content };
        }
      } catch {
        // next
      }
    }
  } catch {
    // Default-branch lookup failed
  }
  return null;
}

function buildResolver(): OwnerResolver {
  const userCache = new Map<string, boolean>();
  const teamCache = new Map<string, boolean>();
  return {
    async isUser(username: string) {
      const key = username.toLowerCase();
      if (userCache.has(key)) return userCache.get(key)!;
      try {
        const [row] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, username))
          .limit(1);
        const ok = !!row;
        userCache.set(key, ok);
        return ok;
      } catch {
        userCache.set(key, false);
        return false;
      }
    },
    async isTeam(orgSlug: string, teamSlug: string) {
      const key = `${orgSlug.toLowerCase()}/${teamSlug.toLowerCase()}`;
      if (teamCache.has(key)) return teamCache.get(key)!;
      try {
        const [org] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, orgSlug))
          .limit(1);
        if (!org) {
          teamCache.set(key, false);
          return false;
        }
        const [team] = await db
          .select({ id: teams.id })
          .from(teams)
          .where(and(eq(teams.orgId, org.id), eq(teams.slug, teamSlug)))
          .limit(1);
        const ok = !!team;
        teamCache.set(key, ok);
        return ok;
      } catch {
        teamCache.set(key, false);
        return false;
      }
    },
  };
}

codeownersRoutes.get(
  "/:owner/:repo/codeowners",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Repository not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    const { repo } = resolved;
    if (repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Repository not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    const located = await loadCodeowners(ownerName, repoName);
    let report: LintReport | null = null;
    if (located) {
      try {
        report = await validateCodeowners(located.content, buildResolver());
      } catch {
        report = null;
      }
    }

    return c.html(
      <Layout
        title={`CODEOWNERS — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="code" />
        <div style="max-width: 960px; margin-top: 16px">
          <h2 style="margin: 0 0 6px 0">CODEOWNERS</h2>
          <p style="color: var(--text-muted); margin: 0 0 20px 0">
            Validates the CODEOWNERS file against known users, teams, and
            syntax. Searched (in order):{" "}
            <code>{CODEOWNERS_PATHS.join(" · ")}</code>
          </p>

          {!located && (
            <div
              style="border: 1px dashed var(--border); border-radius: 6px; padding: 24px; text-align: center; color: var(--text-muted)"
            >
              <h3 style="margin: 0 0 6px 0; color: var(--text)">
                No CODEOWNERS file found
              </h3>
              <p style="margin: 0 0 12px 0">
                Add a <code>CODEOWNERS</code> file at one of the standard
                paths to auto-assign reviewers when pull requests touch
                matching files.
              </p>
              <a
                href={`/${ownerName}/${repoName}/new?path=${encodeURIComponent(
                  ".github/CODEOWNERS"
                )}`}
                class="btn btn-primary"
              >
                Create .github/CODEOWNERS
              </a>
            </div>
          )}

          {located && report && (
            <SummaryCards report={report} path={located.path} />
          )}

          {located && report && report.findings.length > 0 && (
            <section style="margin-top: 20px">
              <h3 style="font-size: 14px; margin: 0 0 8px 0">Findings</h3>
              <ul style="list-style: none; padding: 0; margin: 0; font-size: 13px">
                {report.findings.map((f) => (
                  <FindingRow finding={f} />
                ))}
              </ul>
            </section>
          )}

          {located && report && report.ok && report.findings.length === 0 && (
            <div
              style="margin-top: 20px; border: 1px solid #2ea043; border-radius: 6px; padding: 16px; background: rgba(46, 160, 67, 0.08); color: #2ea043"
            >
              No issues found. CODEOWNERS is clean.
            </div>
          )}

          {located && (
            <section style="margin-top: 24px">
              <h3 style="font-size: 14px; margin: 0 0 8px 0">
                {located.path}
              </h3>
              <pre
                style="border: 1px solid var(--border); border-radius: 6px; padding: 12px; background: var(--bg-secondary); overflow-x: auto; font-size: 12px; line-height: 1.5"
              >
                {renderFileWithLineNos(located.content)}
              </pre>
            </section>
          )}
        </div>
      </Layout>
    );
  }
);

function SummaryCards(props: { report: LintReport; path: string }) {
  const r = props.report;
  return (
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 12px">
      <Card label="Rules" value={r.totalRules} tone="grey" />
      <Card label="Errors" value={r.errors.length} tone="red" />
      <Card label="Warnings" value={r.warnings.length} tone="orange" />
      <Card label="Info" value={r.infos.length} tone="blue" />
    </div>
  );
}

const TONES: Record<string, string> = {
  red: "#f85149",
  orange: "#f0883e",
  blue: "#58a6ff",
  green: "#2ea043",
  grey: "var(--text-muted)",
};

function Card(props: { label: string; value: number; tone: string }) {
  const colour = TONES[props.tone] || TONES.grey;
  return (
    <div style="border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; background: var(--bg-secondary)">
      <div style={`font-size: 20px; font-weight: 600; color: ${colour}; line-height: 1`}>
        {props.value}
      </div>
      <div style="color: var(--text-muted); font-size: 11px; margin-top: 4px">
        {props.label}
      </div>
    </div>
  );
}

function FindingRow(props: { finding: LintFinding }) {
  const f = props.finding;
  const icon =
    f.severity === "error" ? "\u2716" : f.severity === "warning" ? "\u26A0" : "\u2139";
  const tone =
    f.severity === "error"
      ? TONES.red
      : f.severity === "warning"
      ? TONES.orange
      : TONES.blue;
  return (
    <li style="padding: 8px 10px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: start">
      <span
        style={`color: ${tone}; font-weight: 600; font-size: 13px; min-width: 18px; text-align: center`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div style="flex: 1">
        <div>
          <span style="color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px">
            line {f.line}
          </span>{" "}
          <span style={`color: ${tone}; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em`}>
            {f.severity}
          </span>{" "}
          <span style="color: var(--text-muted); font-size: 11px">
            {f.code}
          </span>
        </div>
        <div style="margin-top: 2px">{f.message}</div>
      </div>
    </li>
  );
}

function renderFileWithLineNos(content: string): string {
  const lines = content.split(/\r?\n/);
  const width = String(lines.length).length;
  return lines
    .map((l, i) => `${String(i + 1).padStart(width)}  ${l}`)
    .join("\n");
}

export default codeownersRoutes;
