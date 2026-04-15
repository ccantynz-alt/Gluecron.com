/**
 * Block D8 — AI-generated test suite route.
 *
 *   GET  /:owner/:repo/ai/tests?path=...&ref=...
 *       Renders a form to pick a source file and generate a failing test
 *       stub for it. When `path` is provided the form is pre-filled with
 *       the currently-selected file so the user can "Generate" with one
 *       click.
 *
 *   GET  /:owner/:repo/ai/tests?path=...&format=raw
 *       Returns `c.text(result.code, 200, {"Content-Type": ...})` for CLI
 *       consumption (e.g. `curl | bat`). No HTML shell.
 *
 *   POST /:owner/:repo/ai/tests/generate
 *       Auth required. Actually runs the model and renders the result
 *       page with highlighted source, highlighted test, a copy-to-clipboard
 *       button, a review warning, and a regenerate button.
 */

import { Hono } from "hono";
import { html, raw } from "hono/html";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { IssueNav } from "./issues";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  getBlob,
  getDefaultBranch,
  getTree,
  resolveRef,
} from "../git/repository";
import type { GitTreeEntry } from "../git/repository";
import { highlightCode } from "../lib/highlight";
import {
  contentTypeFor,
  detectLanguage,
  detectTestFramework,
  generateTestStub,
} from "../lib/ai-tests";

const aiTestsRoutes = new Hono<AuthEnv>();

interface ResolvedRepo {
  ownerId: string;
  ownerUsername: string;
  repoId: string;
  repoName: string;
}

async function resolveRepo(
  ownerName: string,
  repoName: string
): Promise<ResolvedRepo | null> {
  try {
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerRow) return null;
    const [repoRow] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repoRow) return null;
    return {
      ownerId: ownerRow.id,
      ownerUsername: ownerRow.username,
      repoId: repoRow.id,
      repoName: repoRow.name,
    };
  } catch {
    return null;
  }
}

/**
 * Shallow listing of source blobs reachable from the tree root and a couple
 * of common top-level source directories. Kept intentionally small — the
 * picker in the form is just a convenience, users can also type a path
 * directly.
 */
async function listRepoFiles(
  owner: string,
  repo: string,
  ref: string
): Promise<string[]> {
  const out: string[] = [];
  let root: GitTreeEntry[] = [];
  try {
    root = await getTree(owner, repo, ref, "");
  } catch {
    root = [];
  }
  for (const entry of root) {
    if (entry.type === "blob") {
      out.push(entry.name);
    }
  }
  const candidates = ["src", "lib", "app", "server", "pkg", "tests"];
  for (const dir of candidates) {
    const hit = root.find((e) => e.type === "tree" && e.name === dir);
    if (!hit) continue;
    let children: GitTreeEntry[] = [];
    try {
      children = await getTree(owner, repo, ref, dir);
    } catch {
      children = [];
    }
    for (const child of children) {
      if (child.type === "blob") {
        out.push(`${dir}/${child.name}`);
      } else if (child.type === "tree") {
        let grand: GitTreeEntry[] = [];
        try {
          grand = await getTree(owner, repo, ref, `${dir}/${child.name}`);
        } catch {
          grand = [];
        }
        for (const g of grand) {
          if (g.type === "blob") {
            out.push(`${dir}/${child.name}/${g.name}`);
          }
        }
      }
    }
    if (out.length > 500) break;
  }
  return out;
}

function renderPicker(
  ownerName: string,
  repoName: string,
  allFiles: string[],
  currentPath: string,
  ref: string
) {
  const trimmed = allFiles.slice(0, 200);
  return (
    <form
      method="POST"
      action={`/${ownerName}/${repoName}/ai/tests/generate`}
      style="margin-top: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 720px;"
    >
      <input type="hidden" name="ref" value={ref} />
      <label style="display: flex; flex-direction: column; gap: 6px;">
        <span style="font-weight: 600;">Source file</span>
        <input
          type="text"
          name="path"
          value={currentPath}
          placeholder="src/lib/foo.ts"
          required
          style="padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text);"
        />
      </label>
      {trimmed.length > 0 && (
        <label style="display: flex; flex-direction: column; gap: 6px;">
          <span style="font-weight: 600;">…or pick from the repo</span>
          <select
            name="pickPath"
            onchange="this.form.path.value = this.value"
            style="padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text);"
          >
            <option value="">— select a file —</option>
            {trimmed.map((f) => (
              <option value={f} selected={f === currentPath}>
                {f}
              </option>
            ))}
          </select>
        </label>
      )}
      <div>
        <button type="submit" class="star-btn" style="padding: 6px 14px;">
          Generate tests
        </button>
      </div>
    </form>
  );
}

aiTestsRoutes.get("/:owner/:repo/ai/tests", softAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const path = (c.req.query("path") || "").trim();
  const reqRef = (c.req.query("ref") || "").trim();
  const format = (c.req.query("format") || "").trim().toLowerCase();

  const resolved = await resolveRepo(owner, repo);
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

  const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
  const ref = reqRef || defaultBranch;
  const sha = (await resolveRef(owner, repo, ref)) || ref;

  // Raw format: just emit the generated code (for CLI use).
  if (format === "raw") {
    if (!path) {
      return c.text("missing ?path=", 400, {
        "Content-Type": "text/plain; charset=utf-8",
      });
    }
    const blob = await getBlob(owner, repo, sha, path).catch(() => null);
    if (!blob || blob.isBinary) {
      return c.text("file not found", 404, {
        "Content-Type": "text/plain; charset=utf-8",
      });
    }
    const language = detectLanguage(path);
    const repoFiles = await listRepoFiles(owner, repo, sha);
    const framework = detectTestFramework(language, repoFiles);
    const result = await generateTestStub({
      path,
      language,
      framework,
      sourceCode: blob.content,
    });
    return c.text(result.code, 200, {
      "Content-Type": contentTypeFor(result.language),
    });
  }

  // HTML form mode.
  const repoFiles = await listRepoFiles(owner, repo, sha);
  const detectedLang = path ? detectLanguage(path) : "other";
  const detectedFramework = detectTestFramework(detectedLang, repoFiles);

  return c.html(
    <Layout title={`AI tests — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <IssueNav owner={owner} repo={repo} active="code" />
      <div style="margin: 16px 0;">
        <h2 style="margin: 0 0 8px;">AI-generated tests</h2>
        <p style="color: var(--text-muted); margin: 0;">
          Pick a source file and gluecron will ask Claude to draft a{" "}
          <strong>failing</strong> test stub that exercises its public surface.
          Treat the output as a starting-point — always review before
          committing.
        </p>
        {path && (
          <p style="color: var(--text-muted); margin: 8px 0 0; font-size: 13px;">
            Detected language: <code>{detectedLang}</code> · framework:{" "}
            <code>{detectedFramework}</code>
          </p>
        )}
      </div>
      {renderPicker(owner, repo, repoFiles, path, ref)}
    </Layout>
  );
});

aiTestsRoutes.post(
  "/:owner/:repo/ai/tests/generate",
  requireAuth,
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const path = String(body.path || "").trim();
    const reqRef = String(body.ref || "").trim();

    const resolved = await resolveRepo(owner, repo);
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

    if (!path) {
      return c.redirect(`/${owner}/${repo}/ai/tests`);
    }

    const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
    const ref = reqRef || defaultBranch;
    const sha = (await resolveRef(owner, repo, ref)) || ref;

    const blob = await getBlob(owner, repo, sha, path).catch(() => null);
    if (!blob || blob.isBinary) {
      return c.html(
        <Layout title={`AI tests — ${owner}/${repo}`} user={user}>
          <RepoHeader owner={owner} repo={repo} />
          <IssueNav owner={owner} repo={repo} active="code" />
          <div class="empty-state">
            <h2>Couldn't read that file</h2>
            <p>
              No such path at <code>{ref}</code>, or the file is binary.
            </p>
            <p>
              <a href={`/${owner}/${repo}/ai/tests`}>Back to the picker</a>
            </p>
          </div>
        </Layout>,
        404
      );
    }

    const language = detectLanguage(path);
    const repoFiles = await listRepoFiles(owner, repo, sha);
    const framework = detectTestFramework(language, repoFiles);

    const result = await generateTestStub({
      path,
      language,
      framework,
      sourceCode: blob.content,
    });

    const sourceHl = highlightCode(blob.content, path);
    const testHl = highlightCode(result.code || "", result.suggestedPath);

    const aiFailed = result.framework === "fallback" || !result.code;

    return c.html(
      <Layout title={`AI tests — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <IssueNav owner={owner} repo={repo} active="code" />
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 16px 0;">
          <div>
            <h2 style="margin: 0;">AI-generated tests for <code>{path}</code></h2>
            <p style="color: var(--text-muted); margin: 4px 0 0; font-size: 13px;">
              Detected language: <code>{language}</code> · framework:{" "}
              <code>{aiFailed ? "fallback" : framework}</code> · ref{" "}
              <code>{ref}</code>
            </p>
          </div>
          <form
            method="POST"
            action={`/${owner}/${repo}/ai/tests/generate`}
            style="display: inline;"
          >
            <input type="hidden" name="path" value={path} />
            <input type="hidden" name="ref" value={ref} />
            <button type="submit" class="star-btn">Regenerate</button>
          </form>
        </div>

        <div
          class="flash-warning"
          style="border: 1px solid var(--border); background: rgba(210, 153, 34, 0.12); padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 14px;"
        >
          <strong>Review before committing.</strong> These tests are a
          starting-point only — they are intentionally written to{" "}
          <em>fail</em> so you are forced to supply real expected values.
          Gluecron does not verify the behaviour is correct.
        </div>

        {aiFailed && (
          <div
            class="empty-state"
            style="border: 1px dashed var(--border); padding: 16px; border-radius: 6px; margin-bottom: 16px;"
          >
            <p style="margin: 0;">
              Couldn't generate a test stub. The AI backend may not be
              configured, or the model returned an empty response. A suggested
              path was still computed: <code>{result.suggestedPath}</code>.
            </p>
          </div>
        )}

        <section style="margin-bottom: 24px;">
          <h3 style="margin: 0 0 8px; font-size: 14px; text-transform: uppercase; color: var(--text-muted);">
            Source — <code>{path}</code>
          </h3>
          <pre class="hljs" style="padding: 12px; border: 1px solid var(--border); border-radius: 6px; overflow: auto;">
            <code>{raw(sourceHl.html)}</code>
          </pre>
        </section>

        <section>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <h3 style="margin: 0; font-size: 14px; text-transform: uppercase; color: var(--text-muted);">
              Suggested test — <code>{result.suggestedPath}</code>
            </h3>
            <button
              type="button"
              class="star-btn"
              id="copy-test-btn"
              data-test-code-id="ai-test-code"
            >
              Copy
            </button>
          </div>
          <pre
            class="hljs"
            id="ai-test-code"
            style="padding: 12px; border: 1px solid var(--border); border-radius: 6px; overflow: auto; white-space: pre;"
          >
            <code>{result.code ? raw(testHl.html) : "// (no output)"}</code>
          </pre>
        </section>

        {html`<script>
          (function () {
            var btn = document.getElementById('copy-test-btn');
            if (!btn) return;
            btn.addEventListener('click', function () {
              var id = btn.getAttribute('data-test-code-id');
              var el = id ? document.getElementById(id) : null;
              var text = el ? el.innerText : '';
              if (!text) return;
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () {
                  var prev = btn.textContent;
                  btn.textContent = 'Copied';
                  setTimeout(function () { btn.textContent = prev; }, 1500);
                });
              }
            });
          })();
        </script>`}
      </Layout>
    );
  }
);

export default aiTestsRoutes;
