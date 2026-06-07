package com.gluecron.actions

import com.gluecron.GluecronUtil
import com.gluecron.settings.GluecronSettingsState
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware

/**
 * Opens a browser tab showing the repository health / CI dashboard.
 *
 * URL pattern: {host}/{owner}/{repo}/health
 *
 * The health page aggregates:
 *   - GateTest scan results from the most recent push
 *   - CI/CD pipeline status
 *   - Branch protection rule compliance
 *   - Open PR count and review coverage
 *
 * This is the JetBrains equivalent of the VS Code "gluecron.viewHealth" command,
 * and mirrors the /admin/deploys live step stream mentioned in the project docs.
 */
class ViewHealthAction : AnAction(), DumbAware {

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

        val url = "${settings.host}/$owner/$repo/health"
        GluecronUtil.openBrowser(url)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
