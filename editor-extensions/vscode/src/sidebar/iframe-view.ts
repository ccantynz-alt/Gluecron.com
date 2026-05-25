/**
 * Generic WebviewViewProvider that embeds a Gluecron page in an iframe.
 *
 * We re-resolve the URL on every `resolveWebviewView` call so that
 * workspace changes (different repo, different host) are picked up
 * without a window reload.
 *
 * The chat view also passes `?embed=1` so the server can render a
 * sidebar-friendly layout (no nav chrome).
 */

import * as vscode from "vscode";
import { getGluecronRepoInfo, hostUrl } from "../repo";

export type UrlBuilder = (repo: { owner: string; repo: string }) => string;

export class IframeView implements vscode.WebviewViewProvider {
  constructor(
    private readonly emptyState: string,
    private readonly buildUrl: UrlBuilder
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    webviewView.webview.options = {
      enableScripts: true,
      enableForms: true,
      enableCommandUris: false,
    };
    this.render(webviewView);

    // Re-render on host changes (settings) — covers self-host switches.
    const sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("gluecron.host")) {
        this.render(webviewView);
      }
    });
    webviewView.onDidDispose(() => sub.dispose());
  }

  private async render(view: vscode.WebviewView): Promise<void> {
    const info = await getGluecronRepoInfo();
    if (!info) {
      view.webview.html = htmlShell(emptyHtml(this.emptyState));
      return;
    }
    const url = this.buildUrl(info);
    view.webview.html = htmlShell(iframeHtml(url));
  }
}

export function chatViewProvider(): IframeView {
  return new IframeView(
    "Open a folder backed by a Gluecron repository to start chatting.",
    ({ owner, repo }) => hostUrl(`/${owner}/${repo}/chat?embed=1`)
  );
}

export function pullsViewProvider(): IframeView {
  return new IframeView(
    "Open a Gluecron-hosted folder to see its pull requests.",
    ({ owner, repo }) => hostUrl(`/${owner}/${repo}/pulls?embed=1`)
  );
}

export function issuesViewProvider(): IframeView {
  return new IframeView(
    "Open a Gluecron-hosted folder to see its issues.",
    ({ owner, repo }) => hostUrl(`/${owner}/${repo}/issues?embed=1`)
  );
}

export function standupsViewProvider(): IframeView {
  return new IframeView(
    "Open a Gluecron-hosted folder to see AI standups.",
    ({ owner, repo }) => hostUrl(`/${owner}/${repo}/standups?embed=1`)
  );
}

function htmlShell(body: string): string {
  // Note: we deliberately allow `frame-src` to whatever HTTP host we
  // embed, but we keep `default-src` tight so an injected script can't
  // execute anything inside the webview shell itself.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src http: https:;" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  iframe { width: 100%; height: 100%; border: 0; }
  .empty { padding: 16px; font-size: 13px; line-height: 1.5; opacity: 0.8; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function iframeHtml(url: string): string {
  // Escape the URL for attribute context.
  const safe = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<iframe src="${safe}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>`;
}

function emptyHtml(message: string): string {
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<div class="empty">${safe}</div>`;
}
