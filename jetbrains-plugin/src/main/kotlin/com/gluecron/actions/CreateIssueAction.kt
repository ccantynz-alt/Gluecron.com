package com.gluecron.actions

import com.gluecron.GluecronUtil
import com.gluecron.settings.GluecronSettingsState
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware

/**
 * Opens a browser tab showing the new-issue form for the current repository.
 *
 * URL pattern: {host}/{owner}/{repo}/issues/new
 *
 * This is the JetBrains equivalent of the VS Code "gluecron.createIssue" flow.
 * Rather than embedding a form in the IDE (which would require additional UI
 * scaffolding), we open the Gluecron web UI so users can fill in labels,
 * assignees, and description with full markdown preview.
 */
class CreateIssueAction : AnAction(), DumbAware {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settings = GluecronSettingsState.getInstance()

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

        val url = "${settings.host}/$owner/$repo/issues/new"
        GluecronUtil.openBrowser(url)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
