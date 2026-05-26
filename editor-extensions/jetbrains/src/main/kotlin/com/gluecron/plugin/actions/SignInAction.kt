package com.gluecron.plugin.actions

import com.gluecron.plugin.auth.AuthService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ui.Messages

/**
 * Prompts the user for a Gluecron personal access token and stashes it
 * in the IDE password safe.
 *
 * The token is NOT round-tripped to the server here — the AuthService
 * (and the API client) will surface 401s on the next request. We keep
 * sign-in fast & offline-friendly to match the VS Code flow.
 */
class SignInAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val current = AuthService.getInstance().getToken()
        val prompt = if (current == null) {
            "Paste a Gluecron PAT (create one at https://gluecron.com/settings/tokens)"
        } else {
            "Replace the saved token (current token starts with '${current.take(6)}…')"
        }
        val token = Messages.showInputDialog(
            e.project,
            prompt,
            "Gluecron — Sign In",
            null,
        )?.trim()
        if (token.isNullOrEmpty()) return
        if (!token.startsWith("glc_")) {
            Messages.showWarningDialog(
                e.project,
                "Token should start with 'glc_'. Saving anyway — you can re-run sign-in.",
                "Gluecron",
            )
        }
        AuthService.getInstance().setToken(token)
        Messages.showInfoMessage(
            e.project,
            "Token saved to the IDE password safe.",
            "Gluecron",
        )
    }
}
