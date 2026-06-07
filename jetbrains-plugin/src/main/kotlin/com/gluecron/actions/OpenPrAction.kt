package com.gluecron.actions

import com.gluecron.GluecronUtil
import com.gluecron.settings.GluecronSettingsState
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware

/**
 * Opens a browser tab showing the pull request list for the current repository.
 *
 * URL pattern: {host}/{owner}/{repo}/pulls
 *
 * This is the JetBrains equivalent of the VS Code "gluecron.openOnWeb" command
 * adapted for PR-centric workflow — surfacing the PR list rather than an
 * individual file, since JetBrains users primarily navigate via the IDE tree.
 */
class OpenPrAction : AnAction(), DumbAware {

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

        val url = "${settings.host}/$owner/$repo/pulls"
        GluecronUtil.openBrowser(url)
    }

    override fun update(e: AnActionEvent) {
        // Only enable when a project is open
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
