/**
 * Workspace-aware helpers that combine VS Code APIs with the pure parser
 * in `git.ts`. Returns `null` whenever the active workspace can't be
 * resolved to a Gluecron-hosted repo.
 */

import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseGitRemote, isGluecronRemote, type RepoInfo } from "./git";

const execFileP = promisify(execFile);

export function getHost(): string {
  const v = vscode.workspace
    .getConfiguration("gluecron")
    .get<string>("host");
  return (v && v.trim()) || "https://gluecron.com";
}

export function getDefaultBranch(): string {
  const v = vscode.workspace
    .getConfiguration("gluecron")
    .get<string>("defaultBranch");
  return (v && v.trim()) || "main";
}

/**
 * Pick a workspace folder — prefers the active editor's folder, falls back
 * to the first workspace folder. Returns `null` if there is no workspace.
 */
export function pickWorkspaceFolder(): vscode.WorkspaceFolder | null {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0];
  return null;
}

/**
 * Resolve the current workspace's Gluecron repo. Returns `null` if there
 * is no workspace, no git remote, or the remote isn't hosted on the
 * configured Gluecron instance.
 */
export async function getRepoInfo(): Promise<RepoInfo | null> {
  const folder = pickWorkspaceFolder();
  if (!folder) return null;
  let url: string;
  try {
    const { stdout } = await execFileP(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: folder.uri.fsPath }
    );
    url = stdout.trim();
  } catch {
    return null;
  }
  const info = parseGitRemote(url);
  if (!info) return null;
  if (!isGluecronRemote(info.host, getHost())) {
    // We still return the parse — callers may want the bare info for
    // building cross-host URLs — but most callers should use
    // `getGluecronRepoInfo` which filters this out.
    return info;
  }
  return info;
}

/**
 * Like `getRepoInfo` but returns `null` for non-Gluecron remotes.
 */
export async function getGluecronRepoInfo(): Promise<RepoInfo | null> {
  const info = await getRepoInfo();
  if (!info) return null;
  if (!isGluecronRemote(info.host, getHost())) return null;
  return info;
}

/**
 * Build a URL inside the configured Gluecron host.
 */
export function hostUrl(path: string): string {
  const host = getHost().replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return host + p;
}
