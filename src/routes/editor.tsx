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
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { join } from "path";

const editor = new Hono<AuthEnv>();

editor.use("*", softAuth);

// New file form
editor.get("/:owner/:repo/new/:ref{.+$}", requireAuth, async (c) => {
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
        <Form action={`/${owner}/${repo}/new/${ref}`}>
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
editor.post("/:owner/:repo/new/:ref", requireAuth, async (c) => {
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
editor.get("/:owner/:repo/edit/:ref{.+$}", requireAuth, async (c) => {
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
        <Form action={`/${owner}/${repo}/edit/${ref}/${filePath}`}>
          <FormGroup>
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
              name="message"
              placeholder={`Update ${filePath.split("/").pop()}`}
              required
            />
          </FormGroup>
          <Flex gap={8}>
            <Button type="submit" variant="primary">
              Commit changes
            </Button>
            <LinkButton href={`/${owner}/${repo}/blob/${ref}/${filePath}`}>
              Cancel
            </LinkButton>
          </Flex>
        </Form>
      </Container>
    </Layout>
  );
});

// Save edited file
editor.post("/:owner/:repo/edit/:ref{.+$}", requireAuth, async (c) => {
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
