/**
 * Gluecron VS Code extension entry point.
 *
 * Activation registers:
 *   - sign in / sign out commands (PAT stored in vscode.SecretStorage)
 *   - sidebar chat + pulls + issues + standups (iframe-embedded webviews)
 *   - "open current file in Gluecron" + "open PRs" deep-links
 *   - "ship spec" + "voice to PR" host shortcuts
 *   - "generate AI commit message" — wires up the SCM input box
 */

import * as vscode from "vscode";
import { relative } from "node:path";
import {
  clearToken,
  restoreSignedInContext,
  signInFlow,
} from "./auth";
import {
  getDefaultBranch,
  getGluecronRepoInfo,
  getHost,
  hostUrl,
  pickWorkspaceFolder,
} from "./repo";
import { buildBlobUrl } from "./git";
import {
  chatViewProvider,
  issuesViewProvider,
  pullsViewProvider,
  standupsViewProvider,
} from "./sidebar/iframe-view";
import { runAiCommitMessage } from "./commands/ai-commit";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Gluecron");
  context.subscriptions.push(output);
  output.appendLine("Gluecron activated.");

  await restoreSignedInContext(context);

  // ── Commands ──────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.signIn", async () => {
      await signInFlow(context, getHost());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.signOut", async () => {
      await clearToken(context);
      vscode.window.showInformationMessage("Gluecron: signed out.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.chatWithRepo", async () => {
      // Reveal the sidebar then focus the chat view.
      await vscode.commands.executeCommand("workbench.view.extension.gluecron-sidebar");
      await vscode.commands.executeCommand("gluecron.chat.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.openInGluecron", async () => {
      const editor = vscode.window.activeTextEditor;
      const folder = pickWorkspaceFolder();
      const info = await getGluecronRepoInfo();
      if (!folder || !info) {
        vscode.window.showWarningMessage(
          "Gluecron: no Gluecron remote detected for this workspace."
        );
        return;
      }
      const filePath = editor
        ? relative(folder.uri.fsPath, editor.document.uri.fsPath)
        : "";
      const branch = getDefaultBranch();
      const url = filePath
        ? buildBlobUrl(
            getHost(),
            info.owner,
            info.repo,
            branch,
            filePath,
            editor?.selection.active.line
          )
        : hostUrl(`/${info.owner}/${info.repo}`);
      await vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.openPRs", async () => {
      const info = await getGluecronRepoInfo();
      const url = info
        ? hostUrl(`/${info.owner}/${info.repo}/pulls`)
        : hostUrl("/pulls");
      await vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.openIssues", async () => {
      const info = await getGluecronRepoInfo();
      const url = info
        ? hostUrl(`/${info.owner}/${info.repo}/issues`)
        : hostUrl("/issues");
      await vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.openStandups", async () => {
      const info = await getGluecronRepoInfo();
      const url = info
        ? hostUrl(`/${info.owner}/${info.repo}/standups`)
        : hostUrl("/standups");
      await vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.shipSpec", async () => {
      const editor = vscode.window.activeTextEditor;
      const folder = pickWorkspaceFolder();
      const info = await getGluecronRepoInfo();
      if (!editor || !folder || !info) {
        vscode.window.showWarningMessage(
          "Gluecron: open a file inside a Gluecron-hosted repo first."
        );
        return;
      }
      const rel = relative(folder.uri.fsPath, editor.document.uri.fsPath);
      const url = hostUrl(
        `/${info.owner}/${info.repo}/specs/new?path=${encodeURIComponent(rel)}`
      );
      await vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.voiceToPR", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(hostUrl("/voice")));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gluecron.aiCommitMessage", async () => {
      await runAiCommitMessage(context);
    })
  );

  // ── Sidebar views ─────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "gluecron.chat",
      chatViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewViewProvider(
      "gluecron.pulls",
      pullsViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewViewProvider(
      "gluecron.issues",
      issuesViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewViewProvider(
      "gluecron.standups",
      standupsViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate(): void {
  // nothing — VS Code cleans up registered subscriptions automatically.
}
