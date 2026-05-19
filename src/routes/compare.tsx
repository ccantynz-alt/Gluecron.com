/**
 * Compare view — diff between two branches or commits.
 * URL: /:owner/:repo/compare/:base...:head
 *
 * The picker view and the comparison view both carry the 2026 polish:
 * hero card with gradient hairline strip + display title, polished
 * branch-selector cards with a prominent arrow between them, +/- diff
 * stats with tabular numerals, modernized commit rows (SHA pill +
 * monospace message + author + age), and a gradient "Create pull
 * request" CTA. All styling is scoped via `.compare-*` class prefixes
 * inside an inline <style> block so no other surface is touched.
 *
 * No business logic was changed in this polish pass — branch listing,
 * diff fetching, commit enumeration, and the PR-creation redirect URL
 * (`/:owner/:repo/pulls/new?base=…&head=…`) are preserved exactly.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader, DiffView } from "../views/components";
import { IssueNav } from "./issues";
import {
  listBranches,
  repoExists,
  getRepoPath,
} from "../git/repository";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import type { GitDiffFile } from "../git/repository";
import { EmptyState } from "../views/ui";

const compare = new Hono<AuthEnv>();

compare.use("*", softAuth);

/* ──────────────────────────────────────────────────────────────────────
 * Inline CSS scoped via `.compare-*` so other surfaces remain untouched.
 * Tokens come from layout.tsx `:root` for light/dark consistency.
 * ──────────────────────────────────────────────────────────────────── */
const COMPARE_STYLES = `
  .compare-hero {
    position: relative;
    margin: 0 0 var(--space-5);
    padding: 22px 26px 24px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .compare-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .compare-hero-inner { position: relative; z-index: 1; }
  .compare-eyebrow {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .compare-eyebrow strong { color: var(--accent); font-weight: 600; }
  .compare-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 3.4vw, 34px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.06;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .compare-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .compare-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    max-width: 640px;
  }

  /* Branch selector — base ← head */
  .compare-branches {
    display: flex;
    align-items: stretch;
    gap: 12px;
    flex-wrap: wrap;
    margin: 0 0 var(--space-4);
  }
  .compare-branch-card {
    flex: 1 1 240px;
    min-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 140ms ease, box-shadow 160ms ease;
  }
  .compare-branch-card:focus-within {
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .compare-branch-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-family: var(--font-mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
  }
  .compare-branch-label .compare-branch-icon {
    color: var(--text-faint);
    font-size: 12px;
  }
  .compare-branch-card.is-base .compare-branch-label strong { color: #ff9d76; }
  .compare-branch-card.is-head .compare-branch-label strong { color: #b69dff; }
  .compare-branch-select {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    padding: 8px 32px 8px 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-strong);
    font-size: 13.5px;
    font-family: var(--font-mono);
    line-height: 1.4;
    cursor: pointer;
    background-image: linear-gradient(45deg, transparent 50%, var(--text-muted) 50%), linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
    background-position: calc(100% - 16px) 14px, calc(100% - 11px) 14px;
    background-size: 5px 5px;
    background-repeat: no-repeat;
    transition: border-color 140ms ease, background-color 140ms ease;
  }
  .compare-branch-select:hover { border-color: var(--border-strong); }
  .compare-branch-select:focus { outline: none; border-color: rgba(140,109,255,0.55); }
  .compare-branch-arrow {
    flex: 0 0 auto;
    align-self: center;
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.16));
    border: 1px solid rgba(140,109,255,0.30);
    color: var(--text-strong);
    font-size: 16px;
    line-height: 1;
    font-weight: 700;
    box-shadow: 0 0 18px -8px rgba(140,109,255,0.45);
  }
  @media (max-width: 720px) {
    .compare-branch-arrow { align-self: flex-start; transform: rotate(90deg); }
  }
  .compare-form-actions {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  }
  .compare-cta {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 18px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #6f5be8 60%, #36c5d6 140%);
    border: 1px solid rgba(140,109,255,0.55);
    box-shadow: 0 6px 18px -8px rgba(140,109,255,0.55);
    text-decoration: none;
    cursor: pointer;
    transition: transform 120ms ease, box-shadow 160ms ease, filter 160ms ease;
  }
  .compare-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -6px rgba(140,109,255,0.6);
    color: #fff;
  }
  .compare-cta.is-disabled,
  .compare-cta[aria-disabled="true"] {
    opacity: 0.55;
    cursor: not-allowed;
    filter: grayscale(0.4);
    transform: none;
    box-shadow: none;
  }
  .compare-cta-secondary {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 9px 14px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    text-decoration: none;
    transition: border-color 140ms ease, color 140ms ease;
  }
  .compare-cta-secondary:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
  }

  /* Summary stats — commits ahead / behind */
  .compare-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 0 var(--space-4);
  }
  .compare-stat-badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    border-radius: 9999px;
    font-size: 12.5px;
    font-weight: 600;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text);
  }
  .compare-stat-badge .compare-stat-count { color: var(--text-strong); }
  .compare-stat-badge.is-ahead {
    color: var(--green);
    border-color: rgba(52,211,153,0.32);
    background: rgba(52,211,153,0.10);
  }
  .compare-stat-badge.is-behind {
    color: var(--red);
    border-color: rgba(248,113,113,0.32);
    background: rgba(248,113,113,0.10);
  }
  .compare-stat-badge.is-files {
    color: var(--text-link);
    border-color: rgba(140,109,255,0.32);
    background: rgba(140,109,255,0.08);
  }

  /* Diff stats bar — +/- counts */
  .compare-diffstats {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 6px 12px;
    border-radius: 9999px;
    font-size: 12.5px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
  }
  .compare-diffstats .compare-add { color: var(--green); font-weight: 700; }
  .compare-diffstats .compare-del { color: var(--red); font-weight: 700; }
  .compare-diffstats .compare-files-c { color: var(--text-muted); }

  /* Section heading row above commit list / diff */
  .compare-section-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px;
    margin: 0 0 12px;
    flex-wrap: wrap;
  }
  .compare-section-title {
    font-size: 11.5px;
    font-family: var(--font-mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
    margin: 0;
  }

  /* Commit list */
  .compare-commits {
    display: flex; flex-direction: column;
    margin: 0 0 var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .compare-commit {
    display: flex; align-items: center; gap: 14px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    transition: background 120ms ease;
  }
  .compare-commit:last-child { border-bottom: none; }
  .compare-commit:hover { background: var(--bg-hover); }
  .compare-commit-body { flex: 1; min-width: 0; }
  .compare-commit-msg {
    font-size: 14px;
    color: var(--text-strong);
    line-height: 1.4;
    margin: 0 0 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compare-commit-msg a {
    color: var(--text-strong);
    text-decoration: none;
    font-weight: 500;
  }
  .compare-commit-msg a:hover { color: var(--accent); }
  .compare-commit-meta {
    font-size: 12px;
    color: var(--text-muted);
    display: inline-flex; align-items: center; gap: 8px;
  }
  .compare-commit-meta .compare-commit-author {
    color: var(--text);
    font-weight: 500;
  }
  .compare-commit-meta .compare-commit-dot {
    color: var(--text-faint);
  }
  .compare-commit-sha {
    flex: 0 0 auto;
    display: inline-flex; align-items: center;
    padding: 4px 10px;
    border-radius: 9999px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
    text-decoration: none;
    transition: border-color 140ms ease, color 140ms ease;
  }
  .compare-commit-sha:hover {
    border-color: rgba(140,109,255,0.45);
    color: var(--text-link);
  }

  /* Empty / identical state */
  .compare-empty {
    padding: 36px 28px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: 12px;
    background: var(--bg-secondary);
    color: var(--text-muted);
    margin: 0 0 var(--space-5);
  }
  .compare-empty strong {
    display: block;
    color: var(--text-strong);
    font-size: 15px;
    margin-bottom: 6px;
  }
  .compare-empty p {
    margin: 0 auto;
    max-width: 460px;
    font-size: 13.5px;
    line-height: 1.55;
  }
  .compare-empty .compare-empty-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 44px; height: 44px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.16), rgba(54,197,214,0.14));
    border: 1px solid rgba(140,109,255,0.28);
    color: var(--text-strong);
    font-size: 18px;
    margin: 0 auto 12px;
  }

  @media (max-width: 720px) {
    .compare-hero { padding: 18px 18px 20px; }
    .compare-form-actions { width: 100%; }
    .compare-cta, .compare-cta-secondary { flex: 1 1 auto; justify-content: center; }
  }
`;

/** Format an ISO date as a short relative string ("3h", "2d", "5w"). */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

compare.get("/:owner/:repo/compare/:spec?", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const spec = c.req.param("spec");

  if (!(await repoExists(owner, repo))) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <EmptyState title="Repository not found" />
      </Layout>,
      404
    );
  }

  const branches = await listBranches(owner, repo);

  if (!spec || !spec.includes("...")) {
    // Show compare picker
    const defaultBase = branches.includes("main") ? "main" : branches[0] || "";
    const defaultHead =
      branches.find((b) => b !== defaultBase) || defaultBase;
    return c.html(
      <Layout title={`Compare — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <IssueNav owner={owner} repo={repo} active="code" />
        <style dangerouslySetInnerHTML={{ __html: COMPARE_STYLES }} />

        <section class="compare-hero">
          <div class="compare-hero-inner">
            <div class="compare-eyebrow">
              Compare changes · <strong>{owner}/{repo}</strong>
            </div>
            <h1 class="compare-title">
              <span class="gradient-text">Compare</span> branches.
            </h1>
            <p class="compare-sub">
              Pick a base and a head branch to see exactly what changed.
              Open a pull request when the diff looks right.
            </p>
          </div>
        </section>

        <form method="get" action={`/${owner}/${repo}/compare`}>
          <div class="compare-branches">
            <div class="compare-branch-card is-base">
              <label class="compare-branch-label" for="compare-base">
                <span class="compare-branch-icon">⇤</span>
                <strong>Base</strong>
                <span style="color:var(--text-faint);font-weight:500">
                  · what you merge into
                </span>
              </label>
              <select
                id="compare-base"
                name="base"
                class="compare-branch-select"
              >
                {branches.map((b) => (
                  <option value={b} selected={b === defaultBase}>
                    {b}
                  </option>
                ))}
              </select>
            </div>

            <div class="compare-branch-arrow" aria-hidden="true">←</div>

            <div class="compare-branch-card is-head">
              <label class="compare-branch-label" for="compare-head">
                <span class="compare-branch-icon">⇥</span>
                <strong>Head</strong>
                <span style="color:var(--text-faint);font-weight:500">
                  · what you want to merge
                </span>
              </label>
              <select
                id="compare-head"
                name="head"
                class="compare-branch-select"
              >
                {branches.map((b) => (
                  <option value={b} selected={b === defaultHead}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div class="compare-form-actions">
            <button
              type="submit"
              class="compare-cta"
              onclick={`this.form.action='/${owner}/${repo}/compare/'+this.form.base.value+'...'+this.form.head.value; return true;`}
            >
              Compare branches →
            </button>
            <a
              href={`/${owner}/${repo}`}
              class="compare-cta-secondary"
            >
              Cancel
            </a>
          </div>
        </form>
      </Layout>
    );
  }

  const [base, head] = spec.split("...");

  // Get diff
  const repoDir = getRepoPath(owner, repo);
  const proc = Bun.spawn(
    ["git", "diff", `${base}...${head}`],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  // Get numstat
  const statProc = Bun.spawn(
    ["git", "diff", "--numstat", `${base}...${head}`],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const stat = await new Response(statProc.stdout).text();
  await statProc.exited;

  const files: GitDiffFile[] = stat
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, filePath] = line.split("\t");
      return {
        path: filePath,
        status: "modified",
        additions: add === "-" ? 0 : parseInt(add, 10),
        deletions: del === "-" ? 0 : parseInt(del, 10),
        patch: "",
      };
    });

  // Get commits between
  const logProc = Bun.spawn(
    [
      "git",
      "log",
      "--format=%H%x00%s%x00%an%x00%aI",
      `${base}...${head}`,
    ],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const logOutput = await new Response(logProc.stdout).text();
  await logProc.exited;

  const commitsBetween = logOutput
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, msg, author, date] = line.split("\0");
      return { sha, message: msg, author, date };
    });

  // Aggregate diff stats for the badge bar.
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const isIdentical = base === head;
  const hasChanges = commitsBetween.length > 0 || files.length > 0;

  return c.html(
    <Layout title={`${base}...${head} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <IssueNav owner={owner} repo={repo} active="code" />
      <style dangerouslySetInnerHTML={{ __html: COMPARE_STYLES }} />

      <section class="compare-hero">
        <div class="compare-hero-inner">
          <div class="compare-eyebrow">
            Comparing · <strong>{owner}/{repo}</strong>
          </div>
          <h1 class="compare-title">
            {hasChanges ? (
              <>
                <span class="gradient-text">
                  {commitsBetween.length} commit
                  {commitsBetween.length !== 1 ? "s" : ""}
                </span>{" "}
                ahead.
              </>
            ) : isIdentical ? (
              <>
                <span class="gradient-text">Nothing</span> to compare.
              </>
            ) : (
              <>
                <span class="gradient-text">No changes</span> between branches.
              </>
            )}
          </h1>
          <p class="compare-sub">
            <span style="font-family:var(--font-mono);color:var(--text)">
              {base}
            </span>{" "}
            <span style="color:var(--text-faint)">←</span>{" "}
            <span style="font-family:var(--font-mono);color:var(--text)">
              {head}
            </span>
            {hasChanges
              ? " — review the diff below, then open a pull request when it looks right."
              : isIdentical
                ? " — base and head point to the same ref. Pick different branches to see a diff."
                : " — these branches diverge but produce no diff. Nothing to merge."}
          </p>
        </div>
      </section>

      {/* Summary stats row */}
      {hasChanges && (
        <div class="compare-stats">
          <span class="compare-stat-badge is-ahead">
            <span class="compare-stat-count">+{commitsBetween.length}</span>
            commit{commitsBetween.length !== 1 ? "s" : ""} ahead
          </span>
          <span class="compare-stat-badge is-files">
            <span class="compare-stat-count">{files.length}</span>
            file{files.length !== 1 ? "s" : ""} changed
          </span>
          <span class="compare-diffstats">
            <span class="compare-add">+{totalAdditions}</span>
            <span class="compare-del">−{totalDeletions}</span>
            <span class="compare-files-c">lines</span>
          </span>
          <a
            href={`/${owner}/${repo}/pulls/new?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`}
            class="compare-cta"
            style="margin-left:auto"
          >
            Create pull request →
          </a>
        </div>
      )}

      {!hasChanges && (
        <div class="compare-empty">
          <div class="compare-empty-icon">≡</div>
          <strong>
            {isIdentical
              ? "Nothing to compare."
              : "No diff between these branches."}
          </strong>
          <p>
            {isIdentical
              ? "Base and head are the same branch. Push some commits to a feature branch, then come back here to compare and open a PR."
              : "These branches diverge but produce no file changes. There's nothing to merge."}
          </p>
          <div
            class="compare-form-actions"
            style="justify-content:center;margin-top:16px"
          >
            <a
              href={`/${owner}/${repo}/compare`}
              class="compare-cta-secondary"
            >
              ← Pick different branches
            </a>
            <span
              class="compare-cta is-disabled"
              aria-disabled="true"
              title="Nothing to compare yet"
            >
              Create pull request →
            </span>
          </div>
        </div>
      )}

      {commitsBetween.length > 0 && (
        <>
          <div class="compare-section-head">
            <h2 class="compare-section-title">Commits in this comparison</h2>
            <span class="compare-stat-badge">
              <span class="compare-stat-count">{commitsBetween.length}</span>
              total
            </span>
          </div>
          <div class="compare-commits">
            {commitsBetween.map((cm) => (
              <div class="compare-commit">
                <div class="compare-commit-body">
                  <div class="compare-commit-msg">
                    <a href={`/${owner}/${repo}/commit/${cm.sha}`}>
                      {cm.message}
                    </a>
                  </div>
                  <div class="compare-commit-meta">
                    <span class="compare-commit-author">{cm.author}</span>
                    <span class="compare-commit-dot">·</span>
                    <span>{relTime(cm.date)}</span>
                  </div>
                </div>
                <a
                  href={`/${owner}/${repo}/commit/${cm.sha}`}
                  class="compare-commit-sha"
                >
                  {cm.sha.slice(0, 7)}
                </a>
              </div>
            ))}
          </div>
        </>
      )}

      {files.length > 0 && (
        <>
          <div class="compare-section-head">
            <h2 class="compare-section-title">File changes</h2>
            <span class="compare-diffstats">
              <span class="compare-add">+{totalAdditions}</span>
              <span class="compare-del">−{totalDeletions}</span>
              <span class="compare-files-c">
                across {files.length} file{files.length !== 1 ? "s" : ""}
              </span>
            </span>
          </div>
          <DiffView raw={raw} files={files} />
        </>
      )}
    </Layout>
  );
});

export default compare;
