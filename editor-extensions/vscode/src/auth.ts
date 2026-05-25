/**
 * Token storage + sign-in flow.
 *
 * Tokens are persisted via `vscode.SecretStorage` (OS keychain on
 * macOS/Windows/Linux). We never write them to settings.json or disk.
 */

import * as vscode from "vscode";

export const SECRET_KEY = "gluecron.pat";
const CONTEXT_KEY = "gluecron:signedIn";

export async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function setToken(
  context: vscode.ExtensionContext,
  token: string
): Promise<void> {
  await context.secrets.store(SECRET_KEY, token);
  await vscode.commands.executeCommand("setContext", CONTEXT_KEY, true);
}

export async function clearToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  await vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
}

/**
 * Prompt the user for a PAT, validate it against `/api/v2/user`, and store it.
 */
export async function signInFlow(
  context: vscode.ExtensionContext,
  host: string
): Promise<boolean> {
  const url = `${host.replace(/\/+$/, "")}/settings/tokens`;
  const token = await vscode.window.showInputBox({
    prompt: `Paste a Gluecron PAT (create one at ${url})`,
    placeHolder: "glc_...",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = (v || "").trim();
      if (!t) return "Token is required";
      if (!/^glc_/.test(t)) return "Token should start with 'glc_'";
      return null;
    },
  });
  if (!token) return false;

  // Best-effort validation; don't block sign-in if the network is flaky —
  // the user can still use the extension and we'll surface 401s later.
  try {
    const me = await fetch(`${host.replace(/\/+$/, "")}/api/v2/user`, {
      headers: { authorization: `Bearer ${token.trim()}` },
    });
    if (me.ok) {
      const body = (await me.json()) as { username?: string };
      vscode.window.showInformationMessage(
        `Gluecron: signed in as ${body.username || "(unknown)"}`
      );
    } else if (me.status === 401) {
      vscode.window.showWarningMessage(
        "Gluecron: token was rejected (401). Saving anyway — you can re-run sign-in."
      );
    }
  } catch {
    vscode.window.showWarningMessage(
      "Gluecron: couldn't reach the server to validate your token. Saving locally."
    );
  }

  await setToken(context, token.trim());
  return true;
}

/**
 * Restore the signed-in context flag at activation time.
 */
export async function restoreSignedInContext(
  context: vscode.ExtensionContext
): Promise<void> {
  const t = await getToken(context);
  await vscode.commands.executeCommand("setContext", CONTEXT_KEY, !!t);
}
