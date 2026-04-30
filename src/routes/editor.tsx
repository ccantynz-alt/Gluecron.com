/**
 * Web file editor — create and edit files directly in the browser.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav, Breadcrumb } from "../views/components";
import {
  Container,
  Flex,
  Form,
  FormGroup,
  Input,
  TextArea,
  Button,
  LinkButton,
  EmptyState,
  Text,
} from "../views/ui";
import {
  getBlob,
  getDefaultBranch,
  getRepoPath,
  repoExists,
} from "../git/repository";
import { generateCommitMessage } from "../lib/ai-generators";
import { isAiAvailable } from "../lib/ai-client";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { join } from "path";

const editor = new Hono<AuthEnv>();

editor.use("*", softAuth);

/**
 * Inline JS for the editor's "Suggest with AI" commit-message button.
 * Picks up the textarea content + form-pinned ref/filePath, POSTs JSON
 * to the suggest endpoint, fills the message Input on success.
 *
 * Built as a string so we don't need a bundler. JSON-escapes against
 * </script> breakout. Defensive DOM lookups (silent no-op on absence).
 */
function AI_COMMIT_MSG_SCRIPT(args: {
  endpoint: string;
  ref: string;
  filePath: string;
}): string {
  const safe = (v: string) =>
    JSON.stringify(v)
      .split("<").join("\\u003C")
      .split(">").join("\\u003E")
      .split("&").join("\\u0026");
  const url = safe(args.endpoint);
  const ref = safe(args.ref);
  const filePath = safe(args.filePath);
  return (
    "(function(){try{" +
    "var btn=document.getElementById('ai-commit-msg-btn');" +
    "var status=document.getElementById('ai-commit-msg-status');" +
    "var input=document.getElementById('commit-message-input');" +
    "var ta=document.querySelector('textarea[name=\"content\"]');" +
    "if(!btn||!input||!ta)return;" +
    "btn.addEventListener('click',function(ev){ev.preventDefault();" +
    "btn.disabled=true;if(status)status.textContent='Drafting (10-30s)...';" +
    "var fd='ref='+encodeURIComponent(" + ref + ")+'&filePath='+encodeURIComponent(" + filePath + ")+'&content='+encodeURIComponent(ta.value||'');" +
    "fetch(" + url + ",{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:fd,credentials:'same-origin'})" +
    ".then(function(r){return r.json().catch(function(){return {ok:false,error:'Server error.'};});})" +
    ".then(function(j){btn.disabled=false;" +
    "if(j&&j.ok&&typeof j.message==='string'){" +
    "if(input.value&&input.value.trim().length>0){if(!confirm('Replace existing message?')){if(status)status.textContent='Cancelled.';return;}}" +
    "input.value=j.message;if(status)status.textContent='Filled from AI. Edit before committing.';" +
    "}else{if(status)status.textContent=(j&&j.error)||'AI unavailable.';}" +
    "}).catch(function(){btn.disabled=false;if(status)status.textContent='Network error.';});" +
    "});" +
    "}catch(e){}})();"
  );
}

// New file form
editor.get("/:owner/:repo/new/:ref{.+$}", requireAuth, requireRepoAccess("write"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const refAndPath = c.req.param("ref");

  // Parse ref — use first segment
  const slashIdx = refAndPath.indexOf("/");
  const ref = slashIdx === -1 ? refAndPath : refAndPath.slice(0, slashIdx);
  const dirPath = slashIdx === -1 ? "" : refAndPath.slice(slashIdx + 1);

  return c.html(
    <Layout title={`New file — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <Container maxWidth={900}>
        <h2 style="margin-bottom: 16px">Create new file</h2>
        <Form method="post" action={`/${owner}/${repo}/new/${ref}`}>
          <input type="hidden" name="dir_path" value={dirPath} />
          <FormGroup label="File path">
            <Flex align="center" gap={4}>
              {dirPath && (
                <Text muted size={14}>
                  {dirPath}/
                </Text>
              )}
              <Input
                name="filename"
                required
                placeholder="filename.ts"
                style="flex: 1"
                autocomplete="off"
              />
            </Flex>
          </FormGroup>
          <FormGroup label="Content">
            <TextArea
              name="content"
              rows={20}
              placeholder="Enter file content..."
              mono
              style="line-height: 1.5; tab-size: 2"
            />
          </FormGroup>
          <FormGroup label="Commit message">
            <Input
              name="message"
              placeholder="Create new file"
              required
            />
          </FormGroup>
          <Button type="submit" variant="primary">
            Commit new file
          </Button>
        </Form>
      </Container>
    </Layout>
  );
});

// Create file via commit
editor.post("/:owner/:repo/new/:ref", requireAuth, requireRepoAccess("write"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const ref = c.req.param("ref");
  const body = await c.req.parseBody();
  const dirPath = String(body.dir_path || "").trim();
  const filename = String(body.filename || "").trim();
  const content = String(body.content || "");
  const message = String(body.message || `Create ${filename}`).trim();

  if (!filename) return c.redirect(`/${owner}/${repo}`);

  const fullPath = dirPath ? `${dirPath}/${filename}` : filename;

  // Use git hash-object + update-index + write-tree + commit-tree
  const repoDir = getRepoPath(owner, repo);

  const run = async (cmd: string[], cwd: string, stdin?: string) => {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : undefined,
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(new TextEncoder().encode(stdin));
      proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
  };

  // Hash the new file content
  const blobSha = await run(
    ["git", "hash-object", "-w", "--stdin"],
    repoDir,
    content
  );

  // Read current tree
  const currentTreeSha = await run(
    ["git", "rev-parse", `${ref}^{tree}`],
    repoDir
  );

  // Read current tree and add new entry
  const treeContent = await run(["git", "ls-tree", "-r", ref], repoDir);
  const entries = treeContent
    .split("\n")
    .filter(Boolean)
    .map((line) => line + "\n")
    .join("");
  const newEntry = `100644 blob ${blobSha}\t${fullPath}\n`;

  const newTreeSha = await run(
    ["git", "mktree"],
    repoDir,
    entries + newEntry
  );

  // Get parent commit
  const parentSha = await run(
    ["git", "rev-parse", ref],
    repoDir
  );

  // Create commit
  const env = {
    GIT_AUTHOR_NAME: user.displayName || user.username,
    GIT_AUTHOR_EMAIL: user.email,
    GIT_COMMITTER_NAME: user.displayName || user.username,
    GIT_COMMITTER_EMAIL: user.email,
  };

  const commitProc = Bun.spawn(
    ["git", "commit-tree", newTreeSha, "-p", parentSha, "-m", message],
    {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    }
  );
  const commitSha = (await new Response(commitProc.stdout).text()).trim();
  await commitProc.exited;

  // Update branch ref
  await run(
    ["git", "update-ref", `refs/heads/${ref}`, commitSha],
    repoDir
  );

  return c.redirect(`/${owner}/${repo}/blob/${ref}/${fullPath}`);
});

// Edit file form
editor.get("/:owner/:repo/edit/:ref{.+$}", requireAuth, requireRepoAccess("write"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const refAndPath = c.req.param("ref");

  // Parse ref/path
  const slashIdx = refAndPath.indexOf("/");
  if (slashIdx === -1) return c.text("Not found", 404);
  const ref = refAndPath.slice(0, slashIdx);
  const filePath = refAndPath.slice(slashIdx + 1);

  const blob = await getBlob(owner, repo, ref, filePath);
  if (!blob || blob.isBinary) {
    return c.html(
      <Layout title="Cannot edit" user={user}>
        <EmptyState title={blob?.isBinary ? "Cannot edit binary file" : "File not found"} />
      </Layout>,
      404
    );
  }

  return c.html(
    <Layout title={`Editing ${filePath} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <Breadcrumb owner={owner} repo={repo} ref={ref} path={filePath} />
      <Container maxWidth={900}>
        <Form method="post" action={`/${owner}/${repo}/edit/${ref}/${filePath}`}>
          <FormGroup label="Content">
            <TextArea
              name="content"
              rows={25}
              value={blob.content}
              mono
              style="line-height: 1.5; tab-size: 2; width: 100%"
            />
          </FormGroup>
          <FormGroup label="Commit message">
            <Input
              id="commit-message-input"
              name="message"
              placeholder={`Update ${filePath.split("/").pop()}`}
              required
            />
          </FormGroup>
          <Flex gap={8} align="center">
            <Button type="submit" variant="primary">
              Commit changes
            </Button>
            <button
              type="button"
              id="ai-commit-msg-btn"
              class="btn"
              title="Generate a one-line commit message using Claude based on the diff"
            >
              Suggest with AI
            </button>
            <span
              id="ai-commit-msg-status"
              style="color:var(--text-muted);font-size:13px"
            />
            <LinkButton href={`/${owner}/${repo}/blob/${ref}/${filePath}`}>
              Cancel
            </LinkButton>
          </Flex>
          <script
            dangerouslySetInnerHTML={{
              __html: AI_COMMIT_MSG_SCRIPT({
                endpoint: `/${owner}/${repo}/ai/commit-message`,
                ref,
                filePath,
              }),
            }}
          />
        </Form>
      </Container>
    </Layout>
  );
});

// AI-suggested commit message — JSON endpoint driven by the editor button.
// Reads the on-disk blob at (ref, filePath), diffs against the submitted
// new content, and asks generateCommitMessage() for a one-liner. Returns
// {ok:true, message} on success, {ok:false, error} otherwise. Always 200.
editor.post(
  "/:owner/:repo/ai/commit-message",
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner, repo } = c.req.param();
    if (!isAiAvailable()) {
      return c.json({
        ok: false,
        error: "AI is not available — set ANTHROPIC_API_KEY.",
      });
    }
    const body = await c.req.parseBody();
    const ref = String(body.ref || "").trim();
    const filePath = String(body.filePath || "").trim();
    const newContent = String(body.content || "");
    if (!ref || !filePath) {
      return c.json({ ok: false, error: "ref + filePath required" });
    }

    let oldContent = "";
    try {
      const blob = await getBlob(owner, repo, ref, filePath);
      oldContent = blob?.content || "";
    } catch {
      oldContent = "";
    }

    if (oldContent === newContent) {
      return c.json({
        ok: false,
        error: "No changes to summarise.",
      });
    }

    // Build a minimal unified-diff-ish summary the AI helper can consume.
    // generateCommitMessage was written for git diff text; we feed a
    // header + truncated old/new sample so it has shape to summarise.
    const truncate = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n…(truncated)" : s);
    const diff =
      `--- a/${filePath}\n+++ b/${filePath}\n` +
      "## Old:\n" +
      truncate(oldContent) +
      "\n\n## New:\n" +
      truncate(newContent);

    let message = "";
    try {
      message = await generateCommitMessage(diff);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI request failed.";
      return c.json({ ok: false, error: msg });
    }
    if (!message.trim()) {
      return c.json({
        ok: false,
        error: "AI returned an empty draft.",
      });
    }
    // Cap to one line + 100 chars (commit-message convention).
    const oneLine = message.split("\n")[0]!.trim();
    const capped = oneLine.length > 100 ? oneLine.slice(0, 97) + "..." : oneLine;
    return c.json({ ok: true, message: capped });
  }
);

// Save edited file
editor.post("/:owner/:repo/edit/:ref{.+$}", requireAuth, requireRepoAccess("write"), async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user")!;
  const refAndPath = c.req.param("ref");

  const slashIdx = refAndPath.indexOf("/");
  if (slashIdx === -1) return c.redirect(`/${owner}/${repo}`);
  const ref = refAndPath.slice(0, slashIdx);
  const filePath = refAndPath.slice(slashIdx + 1);

  const body = await c.req.parseBody();
  const content = String(body.content || "");
  const message = String(
    body.message || `Update ${filePath.split("/").pop()}`
  ).trim();

  const repoDir = getRepoPath(owner, repo);

  const run = async (cmd: string[], cwd: string, stdin?: string) => {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : undefined,
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(new TextEncoder().encode(stdin));
      proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim();
  };

  // Hash new content
  const blobSha = await run(
    ["git", "hash-object", "-w", "--stdin"],
    repoDir,
    content
  );

  // Read current tree, replace the file
  const treeContent = await run(["git", "ls-tree", "-r", ref], repoDir);
  const lines = treeContent.split("\n").filter(Boolean);
  const updated = lines
    .map((line) => {
      const parts = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
      if (parts && parts[4] === filePath) {
        return `${parts[1]} blob ${blobSha}\t${parts[4]}`;
      }
      return line;
    })
    .join("\n") + "\n";

  const newTreeSha = await run(["git", "mktree"], repoDir, updated);
  const parentSha = await run(["git", "rev-parse", ref], repoDir);

  const env = {
    GIT_AUTHOR_NAME: user.displayName || user.username,
    GIT_AUTHOR_EMAIL: user.email,
    GIT_COMMITTER_NAME: user.displayName || user.username,
    GIT_COMMITTER_EMAIL: user.email,
  };

  const commitProc = Bun.spawn(
    ["git", "commit-tree", newTreeSha, "-p", parentSha, "-m", message],
    {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    }
  );
  const commitSha = (await new Response(commitProc.stdout).text()).trim();
  await commitProc.exited;

  await run(
    ["git", "update-ref", `refs/heads/${ref}`, commitSha],
    repoDir
  );

  return c.redirect(`/${owner}/${repo}/blob/${ref}/${filePath}`);
});

export default editor;
