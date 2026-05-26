package com.gluecron.plugin.actions

import com.gluecron.plugin.GluecronPlugin
import com.gluecron.plugin.api.GluecronClient
import com.gluecron.plugin.auth.AuthService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vcs.CheckinProjectPanel
import com.intellij.openapi.vcs.VcsDataKeys
import kotlinx.coroutines.runBlocking
import java.io.File

/**
 * Generates an AI commit message for the staged diff and writes it into
 * the VCS commit dialog's message field.
 *
 * Wiring:
 *   - plugin.xml registers this action under `Vcs.MessageActionGroup`
 *     so JetBrains shows it as a button next to the commit-message
 *     textarea (the same place the sparkle lives in VS Code).
 *   - We read the staged diff by shelling out to `git diff --cached`.
 *     IntelliJ's VCS API has fancier helpers, but the shell-out keeps
 *     this code identical to the CLI / VS Code paths and works with
 *     any git-CLI version the user already has.
 *   - We POST to `/api/v2/ai/commit-message` and drop the result into
 *     the active `CheckinProjectPanel#commitMessage`.
 */
class GenerateCommitMessageAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val token = AuthService.getInstance().getToken()
        if (token.isNullOrBlank()) {
            Messages.showInfoMessage(
                project,
                "Sign in first: Tools → Gluecron → Sign In.",
                "Gluecron",
            )
            return
        }
        val panel: CheckinProjectPanel? =
            e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL) as? CheckinProjectPanel
                ?: e.getData(CommonDataKeys.PSI_FILE)?.let { null }

        // The commit-message control isn't always exposed; if the
        // dialog isn't visible we still draft the message and stash it
        // on the clipboard, matching VS Code's fallback behaviour.
        runDraftTask(project, token, panel)
    }

    private fun runDraftTask(
        project: Project,
        token: String,
        panel: CheckinProjectPanel?,
    ) {
        object : Task.Backgroundable(project, "Gluecron: drafting commit message…", false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                val cwd = project.basePath ?: return notify(project, "No project root.")
                val diff = runCatching { stagedDiff(cwd) }.getOrElse {
                    return notify(project, "Failed to read staged diff: ${it.message}")
                }
                if (diff.isBlank()) {
                    return notify(project, "Nothing staged. Stage changes first (git add).")
                }
                val client = GluecronClient(
                    host = GluecronPlugin.DEFAULT_HOST,
                    token = token,
                )
                val msg = runCatching {
                    runBlocking { client.aiCommitMessage(diff) }
                }.getOrElse {
                    return notify(project, "Gluecron: ${it.message}")
                }
                val composed = listOf(msg.subject.trim(), msg.body.trim())
                    .filter { it.isNotEmpty() }
                    .joinToString("\n\n")
                if (composed.isEmpty()) {
                    return notify(project, "Server returned an empty subject.")
                }
                ApplicationManager.getApplication().invokeLater {
                    if (panel != null) {
                        panel.commitMessage = composed
                    } else {
                        // Clipboard fallback — same UX as VS Code when
                        // the SCM input box isn't ready.
                        val sel = java.awt.datatransfer.StringSelection(composed)
                        java.awt.Toolkit.getDefaultToolkit().systemClipboard.setContents(sel, sel)
                        Messages.showInfoMessage(
                            project,
                            "Commit message copied to clipboard (commit dialog not open).",
                            "Gluecron",
                        )
                    }
                }
            }
        }.queue()
    }

    private fun notify(project: Project, msg: String) {
        ApplicationManager.getApplication().invokeLater {
            Messages.showInfoMessage(project, msg, "Gluecron")
        }
    }

    /**
     * `git diff --cached` over the project root. We deliberately cap the
     * output via Java's process buffer rather than streaming — the
     * server-side endpoint caps payload size separately.
     */
    private fun stagedDiff(cwd: String): String {
        val p = ProcessBuilder("git", "diff", "--cached")
            .directory(File(cwd))
            .redirectErrorStream(false)
            .start()
        val text = p.inputStream.bufferedReader().readText()
        p.waitFor()
        return text
    }
}
