/**
 * Block D7 — AI-generated changelog for an arbitrary commit range.
 *
 *   GET /:owner/:repo/ai/changelog
 *     - No query args: renders a form (from/to selects populated from
 *       branches + recent tags).
 *     - ?from=&to= (&format=markdown|html): runs `git log <from>..<to>`,
 *       feeds commits to `generateChangelog`, and renders the result.
 *     - ?format=markdown returns `text/markdown` for CLI/CI consumers.
 *
 * Public repos are readable without auth (softAuth) — matching the
 * behaviour of `src/routes/compare.tsx`.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import {
  listBranches,
  listTags,
  resolveRef,
  repoExists,
  getRepoPath,
} from "../git/repository";
import { generateChangelog } from "../lib/ai-generators";
import { renderMarkdown } from "../lib/markdown";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const aiChangelog = new Hono<AuthEnv>();

aiChangelog.use("*", softAuth);

interface RangeCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

async function commitsInRange(
  owner: string,
  repo: string,
  from: string,
  to: string
): Promise<RangeCommit[]> {
  const repoDir = getRepoPath(owner, repo);
  const proc = Bun.spawn(
    [
      "git",
      "log",
      "--format=%H%x00%s%x00%an%x00%aI",
      `${from}..${to}`,
    ],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 500)
    .map((line) => {
      const [sha, message, author, date] = line.split("\0");
      return { sha, message, author, date };
    });
}

aiChangelog.get("/:owner/:repo/ai/changelog", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const from = (c.req.query("from") || "").trim();
  const to = (c.req.query("to") || "").trim();
  const format = (c.req.query("format") || "").trim().toLowerCase();

  if (!(await repoExists(owner, repo))) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const [branches, tags] = await Promise.all([
    listBranches(owner, repo).catch(() => [] as string[]),
    listTags(owner, repo).catch(
      () => [] as Array<{ name: string; sha: string; date: string }>
    ),
  ]);
  const refChoices = [
    ...branches,
    ...tags.slice(0, 25).map((t) => t.name),
  ];

  const renderForm = (opts: { error?: string; notice?: string } = {}) =>
    c.html(
      <Layout title={`AI Changelog — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <IssueNav owner={owner} repo={repo} active="code" />
        <h2 style="margin-bottom: 8px">AI Changelog</h2>
        <p style="color: var(--text-muted); margin-bottom: 20px; font-size: 14px">
          Generate release notes for any commit range. Pick a base (from) and
          a head (to) — Claude will group commits into Features / Fixes /
          Perf / Refactors / Docs / Other.
        </p>
        {opts.error && (
          <div class="auth-error" style="margin-bottom: 16px">
            {opts.error}
          </div>
        )}
        {opts.notice && (
          <div
            class="empty-state"
            style="margin-bottom: 16px; padding: 12px; text-align: left"
          >
            {opts.notice}
          </div>
        )}
        <form
          method="get"
          action={`/${owner}/${repo}/ai/changelog`}
          style="display: flex; gap: 12px; align-items: center; margin-bottom: 20px; flex-wrap: wrap"
        >
          <label style="font-size: 13px; color: var(--text-muted)">
            From
          </label>
          <input
            type="text"
            name="from"
            list="ai-changelog-refs"
            value={from}
            placeholder="v1.0.0"
            aria-label="From ref"
            style="padding: 6px 10px"
          />
          <label style="font-size: 13px; color: var(--text-muted)">To</label>
          <input
            type="text"
            name="to"
            list="ai-changelog-refs"
            value={to}
            placeholder="main"
            aria-label="To ref"
            style="padding: 6px 10px"
          />
          <datalist id="ai-changelog-refs">
            {refChoices.map((r) => (
              <option value={r}></option>
            ))}
          </datalist>
          <button type="submit" class="btn btn-primary">
            Generate
          </button>
        </form>
        {refChoices.length > 0 && (
          <div style="font-size: 12px; color: var(--text-muted)">
            Known refs: {refChoices.slice(0, 20).join(", ")}
            {refChoices.length > 20 ? ", …" : ""}
          </div>
        )}
      </Layout>
    );

  // No range supplied — show picker.
  if (!from || !to) {
    return renderForm();
  }

  // Resolve both refs.
  const [fromSha, toSha] = await Promise.all([
    resolveRef(owner, repo, from),
    resolveRef(owner, repo, to),
  ]);
  if (!fromSha || !toSha) {
    const which =
      !fromSha && !toSha
        ? `Could not resolve refs "${from}" or "${to}".`
        : !fromSha
        ? `Could not resolve "from" ref "${from}".`
        : `Could not resolve "to" ref "${to}".`;
    return renderForm({ error: which });
  }

  // Collect commits in range.
  let commits: RangeCommit[] = [];
  try {
    commits = await commitsInRange(owner, repo, from, to);
  } catch (err) {
    return renderForm({
      error: `Failed to read commit range: ${String(
        (err as Error).message || err
      )}`,
    });
  }

  if (commits.length === 0) {
    return renderForm({
      notice: `No commits between ${from} and ${to}.`,
    });
  }

  // Hand off to Claude (or the deterministic fallback).
  let markdown = "";
  try {
    markdown = await generateChangelog(
      `${owner}/${repo}`,
      from,
      to,
      commits
    );
  } catch (err) {
    // generateChangelog has its own no-key fallback, but network/SDK
    // failures should still return a useful page rather than a 500.
    markdown =
      `## ${to} (since ${from})\n\n` +
      commits
        .map(
          (c2) =>
            `- ${c2.message.split("\n")[0]} (${c2.sha.slice(0, 7)}) — ${
              c2.author
            }`
        )
        .join("\n") +
      `\n\n_AI generation failed: ${String(
        (err as Error).message || err
      )}_`;
  }

  // CLI / CI consumers want raw Markdown.
  if (format === "markdown") {
    return c.text(markdown, 200, { "Content-Type": "text/markdown" });
  }

  const html = renderMarkdown(markdown);

  return c.html(
    <Layout title={`AI Changelog — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <IssueNav owner={owner} repo={repo} active="code" />
      <h2 style="margin-bottom: 4px">AI Changelog</h2>
      <div style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px">
        {from} <span style="opacity: 0.6">..</span> {to} —{" "}
        {commits.length} commit{commits.length !== 1 ? "s" : ""}
      </div>
      <form
        method="get"
        action={`/${owner}/${repo}/ai/changelog`}
        style="display: flex; gap: 8px; align-items: center; margin-bottom: 20px; flex-wrap: wrap"
      >
        <input
          type="text"
          name="from"
          list="ai-changelog-refs"
          value={from}
          aria-label="From ref"
          style="padding: 6px 10px"
        />
        <span style="color: var(--text-muted)">..</span>
        <input
          type="text"
          name="to"
          list="ai-changelog-refs"
          value={to}
          aria-label="To ref"
          style="padding: 6px 10px"
        />
        <datalist id="ai-changelog-refs">
          {refChoices.map((r) => (
            <option value={r}></option>
          ))}
        </datalist>
        <button type="submit" class="btn">
          Regenerate
        </button>
        <a
          href={`/${owner}/${repo}/ai/changelog?from=${encodeURIComponent(
            from
          )}&to=${encodeURIComponent(to)}&format=markdown`}
          class="btn"
        >
          Raw Markdown
        </a>
      </form>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start">
        <div
          class="markdown-body"
          dangerouslySetInnerHTML={{ __html: html }}
        ></div>
        <div>
          <div
            style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px"
          >
            Copy Markdown
          </div>
          <textarea
            readonly
            rows={24}
            style="width: 100%; font-family: var(--font-mono, monospace); font-size: 12px; padding: 10px; background: var(--bg-elevated); color: var(--text); border: 1px solid var(--border); border-radius: 6px"
            onclick="this.select()"
          >
            {markdown}
          </textarea>
        </div>
      </div>
    </Layout>
  );
});

export default aiChangelog;
