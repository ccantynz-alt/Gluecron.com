package com.gluecron.actions

import com.gluecron.GluecronUtil
import com.gluecron.settings.GluecronSettingsState
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.ui.Messages

/**
 * Merges the open pull request for the currently checked-out branch.
 *
 * Flow:
 *   1. Detect owner/repo from the git remote URL.
 *   2. Detect the current branch name.
 *   3. Ask the user to confirm (the merge is irreversible).
 *   4. POST to {host}/api/repos/{owner}/{repo}/pulls/merge
 *      with body: { "head": "<branch>", "merge_method": "merge" }
 *   5. Show a success or error balloon notification.
 *
 * The API call runs on a background thread via ProgressManager so it
 * doesn't block the EDT.
 *
 * This is the JetBrains equivalent of the VS Code "gluecron.mergePr" command.
 */
class MergePrAction : AnAction(), DumbAware {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settings = GluecronSettingsState.getInstance()

        if (settings.token.isBlank()) {
            GluecronUtil.notify(
                project,
                "Gluecron access token is not configured. " +
                    "Go to Settings → Tools → Gluecron to add your token.",
                NotificationType.ERROR
            )
            return
        }

        val (owner, repo) = GluecronUtil.detectOwnerRepo(project)
            ?: run {
                GluecronUtil.notify(
                    project,
                    "No Gluecron remote detected. Ensure the project has a git remote " +
                        "pointing to ${settings.host}.",
                    NotificationType.WARNING
                )
                return
            }

        val branch = GluecronUtil.currentBranch(project)
            ?: run {
                GluecronUtil.notify(
                    project,
                    "Could not determine the current branch.",
                    NotificationType.WARNING
                )
                return
            }

        // Confirm before merging — this is a destructive action
        val confirmed = Messages.showYesNoDialog(
            project,
            "Merge the open pull request for branch \"$branch\" into $owner/$repo?\n\n" +
                "This action cannot be undone.",
            "Merge PR — Gluecron",
            "Merge",
            "Cancel",
            Messages.getQuestionIcon()
        )
        if (confirmed != Messages.YES) return

        // Run the API call on a background thread
        ProgressManager.getInstance().run(object : Task.Backgroundable(
            project,
            "Gluecron: Merging PR for branch \"$branch\"…",
            false
        ) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                try {
                    val path = "/api/repos/$owner/$repo/pulls/merge"
                    val body = """{"head":"$branch","merge_method":"merge"}"""
                    GluecronUtil.apiPost(path, body)

                    ApplicationManager.getApplication().invokeLater {
                        GluecronUtil.notify(
                            project,
                            "PR for branch \"$branch\" merged successfully into $owner/$repo.",
                            NotificationType.INFORMATION
                        )
                    }
                } catch (ex: Exception) {
                    ApplicationManager.getApplication().invokeLater {
                        GluecronUtil.notify(
                            project,
                            "Failed to merge PR: ${ex.message}",
                            NotificationType.ERROR
                        )
                    }
                }
            }
        })
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
