/**
 * Block G4 — Gluecron VS Code extension.
 *
 * Commands:
 *   gluecron.explainFile     — call `/api/v1/ai/explain-file` + show in a hover
 *   gluecron.openOnWeb       — opens the current file on the Gluecron web UI
 *   gluecron.searchSemantic  — quickPick -> /api/v1/search/semantic
 *   gluecron.generateTests   — scaffold a failing test via /api/v1/ai/tests
 *
 * We keep this file zero-runtime-dependencies besides `vscode`. Everything
 * else is pure stdlib + fetch.
 */

import * as vscode from "vscode";
import { execSync } from "node:child_process";
import { basename, relative } from "node:path";

function getHost(): string {
  return (
    vscode.workspace.getConfiguration("gluecron").get<string>("host") ||
    "http://localhost:3000"
  );
}

function getToken(): string {
  return (
    vscode.workspace.getConfiguration("gluecron").get<string>("token") || ""
  );
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const url = getHost().replace(/\/+$/, "") + path;
  const token = getToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[${res.status}] ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Inspect the current workspace for a git remote whose URL matches a Gluecron
 * host. Returns `{ owner, repo }` if found.
 */
export function detectGlueRepo(cwd: string, host: string): {
  owner: string;
  repo: string;
} | null {
  try {
    const url = execSync("git config --get remote.origin.url", {
      cwd,
      encoding: "utf8",
    }).trim();
    if (!url) return null;
    // host-agnostic parsing — look for /:owner/:repo at end
    const cleaned = url
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/^git@[^:]+:/, "")
      .replace(/\.git$/, "");
    const [owner, repo] = cleaned.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

export function buildWebUrl(
  host: string,
  owner: string,
  repo: string,
  relPath: string,
  line?: number
): string {
  const base = `${host.replace(/\/+$/, "")}/${owner}/${repo}/blob/main/${relPath}`;
  return line ? `${base}#L${line + 1}` : base;
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Gluecron");
  output.appendLine("Gluecron activated.");

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.openOnWeb", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("No active editor");
        return;
      }
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!folder) {
        vscode.window.showWarningMessage("File is not in a workspace");
        return;
      }
      const cwd = folder.uri.fsPath;
      const rel = relative(cwd, editor.document.uri.fsPath);
      const repo = detectGlueRepo(cwd, getHost());
      if (!repo) {
        vscode.window.showWarningMessage("No Gluecron remote detected");
        return;
      }
      const url = buildWebUrl(
        getHost(),
        repo.owner,
        repo.repo,
        rel,
        editor.selection.active.line
      );
      vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.explainFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const content = editor.document.getText();
      const path = basename(editor.document.fileName);
      output.show(true);
      output.appendLine(`Explaining ${path}...`);
      try {
        const res = await api<{ explanation?: string }>(
          `/api/copilot/completions`,
          {
            method: "POST",
            body: JSON.stringify({
              prompt: `Explain this file in 3-5 bullet points:\n\n${content.slice(
                0,
                8000
              )}`,
              max_tokens: 400,
            }),
          }
        );
        output.appendLine(res.explanation || JSON.stringify(res, null, 2));
      } catch (err) {
        output.appendLine(`error: ${(err as Error).message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.searchSemantic", async () => {
      const q = await vscode.window.showInputBox({
        prompt: "Semantic search across repo",
        placeHolder: "how does auth work?",
      });
      if (!q) return;
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      const repo = detectGlueRepo(folder.uri.fsPath, getHost());
      if (!repo) return;
      const res = await api<{ results?: Array<{ path: string; score: number }> }>(
        `/api/graphql`,
        {
          method: "POST",
          body: JSON.stringify({
            query: `{ search(q:"${q.replace(/"/g, "'")}", limit:10) { name ownerUsername } }`,
          }),
        }
      );
      output.show(true);
      output.appendLine(JSON.stringify(res, null, 2));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.generateTests", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!folder) return;
      const repo = detectGlueRepo(folder.uri.fsPath, getHost());
      if (!repo) return;
      const rel = relative(folder.uri.fsPath, editor.document.uri.fsPath);
      try {
        const res = await api(
          `/${repo.owner}/${repo.repo}/ai/tests?format=raw&path=${encodeURIComponent(
            rel
          )}`
        );
        const doc = await vscode.workspace.openTextDocument({
          content: typeof res === "string" ? res : JSON.stringify(res, null, 2),
          language: editor.document.languageId,
        });
        vscode.window.showTextDocument(doc);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Gluecron test generation failed: ${(err as Error).message}`
        );
      }
    })
  );
}

export function deactivate() {
  // nothing to clean up
}
