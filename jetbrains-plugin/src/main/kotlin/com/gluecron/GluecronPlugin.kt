package com.gluecron

import com.gluecron.settings.GluecronSettingsState
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity

/**
 * Post-startup activity for the Gluecron plugin.
 *
 * Runs once per project open, after the IDE has fully initialized.
 * Responsibilities:
 *   1. Seed settings from environment variables if not already configured
 *      (GLUECRON_HOST → host, GLUECRON_TOKEN → token).
 *   2. Emit a notification if the host is still at the default localhost
 *      value so new users know to configure the plugin.
 */
class GluecronPlugin : StartupActivity {

    override fun runActivity(project: Project) {
        val settings = GluecronSettingsState.getInstance()

        // Seed from environment variables on first run
        val envHost = System.getenv("GLUECRON_HOST")
        if (!envHost.isNullOrBlank() && settings.host == "http://localhost:3000") {
            settings.host = envHost
        }

        val envToken = System.getenv("GLUECRON_TOKEN")
        if (!envToken.isNullOrBlank() && settings.token.isBlank()) {
            settings.token = envToken
        }

        // Warn if still using the default localhost address
        if (settings.host == "http://localhost:3000" && settings.token.isBlank()) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Gluecron Notifications")
                .createNotification(
                    "Gluecron",
                    "Configure your Gluecron server URL and access token in " +
                        "<b>Settings → Tools → Gluecron</b>.",
                    NotificationType.INFORMATION
                )
                .notify(project)
        }
    }
}
