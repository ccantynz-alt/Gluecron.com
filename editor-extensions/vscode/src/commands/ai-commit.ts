/**
 * Generate an AI commit message for the currently-staged diff and drop
 * it into the Source Control input box.
 *
 * Strategy:
 *   1. Read the staged diff via `git diff --cached` in the workspace.
 *   2. POST it to `${host}/api/v2/ai/commit-message` with the user's PAT.
 *   3. Format `{ subject, body }` into a single string and assign it to
 *      the active git SCM repository's `inputBox.value`.
 *
 * We talk to the API directly rather than shelling out to the `gluecron`
 * CLI — the CLI may not be installed in the user's $PATH, and the API
 * surface is the same.
 */

import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getToken, signInFlow } from "../auth";
import { getHost, pickWorkspaceFolder } from "../repo";

const execFileP = promisify(execFile);

/**
 * VS Code's built-in git extension exposes a typed API; we declare just
 * the bits we touch so the extension compiles without bundling
 * `@types/vscode.git`.
 */
interface GitInputBox {
  value: string;
}
interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: GitInputBox;
}
interface GitApi {
  repositories: GitRepository[];
  getRepository?(uri: vscode.Uri): GitRepository | null;
}
interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

async function getStagedDiff(cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", ["diff", "--cached"], {
    cwd,
    maxBuffer: 16 * 1024 * 1024, // 16 MiB — generous; API caps server-side too.
  });
  return stdout;
}

function pickRepository(cwd: string): GitRepository | null {
  const git = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!git) return null;
  const api = git.isActive ? git.exports.getAPI(1) : null;
  if (!api) return null;
  if (api.getRepository) {
    const found = api.getRepository(vscode.Uri.file(cwd));
    if (found) return found;
  }
  return api.repositories[0] || null;
}

export async function runAiCommitMessage(
  context: vscode.ExtensionContext
): Promise<void> {
  const folder = pickWorkspaceFolder();
  if (!folder) {
    vscode.window.showWarningMessage("Gluecron: no workspace open.");
    return;
  }

  let token = await getToken(context);
  if (!token) {
    const ok = await signInFlow(context, getHost());
    if (!ok) return;
    token = await getToken(context);
  }
  if (!token) return;

  let diff: string;
  try {
    diff = await getStagedDiff(folder.uri.fsPath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Gluecron: failed to read staged diff (${(err as Error).message}).`
    );
    return;
  }
  if (!diff.trim()) {
    vscode.window.showInformationMessage(
      "Gluecron: nothing staged. Stage changes first (git add)."
    );
    return;
  }

  const message = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: "Gluecron: drafting commit message...",
      cancellable: false,
    },
    async () => {
      const url = `${getHost().replace(/\/+$/, "")}/api/v2/ai/commit-message`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ diff, style: "conventional" }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`server returned ${res.status}: ${text.slice(0, 200)}`);
      }
      let json: { subject?: string; body?: string };
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("server returned non-JSON");
      }
      const subject = (json.subject || "").trim();
      const body = (json.body || "").trim();
      if (!subject) throw new Error("server returned an empty subject");
      return body ? `${subject}\n\n${body}` : subject;
    }
  ).then(
    (v) => v,
    (err: Error) => {
      vscode.window.showErrorMessage(`Gluecron: ${err.message}`);
      return null;
    }
  );

  if (!message) return;

  const repo = pickRepository(folder.uri.fsPath);
  if (repo) {
    repo.inputBox.value = message;
    vscode.window.showInformationMessage(
      "Gluecron: commit message dropped into Source Control."
    );
  } else {
    // Git extension isn't ready — fall back to copying the message.
    await vscode.env.clipboard.writeText(message);
    vscode.window.showInformationMessage(
      "Gluecron: copied commit message to clipboard (git SCM not ready)."
    );
  }
}
