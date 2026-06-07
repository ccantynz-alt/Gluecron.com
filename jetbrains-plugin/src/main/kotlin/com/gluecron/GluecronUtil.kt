package com.gluecron

import com.gluecron.settings.GluecronSettingsState
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import git4idea.repo.GitRepositoryManager
import java.awt.Desktop
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Shared utilities for Gluecron actions.
 *
 * - [detectOwnerRepo] — infers `owner/repo` from the project's git remote URL
 * - [openBrowser]     — opens a URL in the system's default browser
 * - [apiPost]         — synchronous POST helper used by MergePrAction
 * - [notify]          — show a balloon notification
 */
object GluecronUtil {

    /**
     * Detects the owner and repository name from the first git remote URL
     * in the project that contains the configured Gluecron host, or falls
     * back to any remote named "origin".
     *
     * Handles both HTTPS and SSH remote formats:
     *   https://gluecron.com/owner/repo.git
     *   git@gluecron.com:owner/repo.git
     *
     * Returns null if no usable git remote is found.
     */
    fun detectOwnerRepo(project: Project): Pair<String, String>? {
        val settings = GluecronSettingsState.getInstance()
        val manager = GitRepositoryManager.getInstance(project)
        val repos = manager.repositories
        if (repos.isEmpty()) return null

        // Prefer remotes whose URL contains the configured host
        val hostDomain = settings.host
            .removePrefix("https://")
            .removePrefix("http://")
            .trimEnd('/')

        fun parseRemoteUrl(url: String): Pair<String, String>? {
            // Normalise: strip protocol + host prefix or git@ prefix
            val cleaned = url
                .replace(Regex("^https?://[^/]+/"), "")
                .replace(Regex("^git@[^:]+:"), "")
                .removeSuffix(".git")
            val parts = cleaned.split("/").filter { it.isNotBlank() }
            if (parts.size < 2) return null
            return Pair(parts[0], parts[1])
        }

        for (repo in repos) {
            val remotes = repo.remotes
            // Try host-matching remote first
            for (remote in remotes) {
                val url = remote.firstUrl ?: continue
                if (url.contains(hostDomain)) {
                    return parseRemoteUrl(url)
                }
            }
            // Fall back to any remote named "origin"
            val origin = remotes.firstOrNull { it.name == "origin" }
            if (origin != null) {
                val url = origin.firstUrl ?: continue
                return parseRemoteUrl(url)
            }
        }
        return null
    }

    /**
     * Returns the name of the currently checked-out branch in the first
     * git repository found in the project, or null if none.
     */
    fun currentBranch(project: Project): String? {
        val manager = GitRepositoryManager.getInstance(project)
        return manager.repositories.firstOrNull()
            ?.currentBranchName
    }

    /**
     * Opens [url] in the system's default browser.
     * Falls back gracefully if Desktop is not supported.
     */
    fun openBrowser(url: String) {
        if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
            Desktop.getDesktop().browse(URI(url))
        }
    }

    /**
     * Performs a synchronous HTTP POST to [path] (relative to the configured host)
     * with a JSON [body]. Returns the response body as a string, or throws on error.
     *
     * This is intentionally minimal — used only by MergePrAction which needs a
     * blocking call so we can surface the result in the same action invocation.
     */
    fun apiPost(path: String, body: String): String {
        val settings = GluecronSettingsState.getInstance()
        val url = "${settings.host}$path"
        val token = settings.token

        val client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build()

        val requestBuilder = HttpRequest.newBuilder()
            .uri(URI(url))
            .timeout(Duration.ofSeconds(30))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))

        if (token.isNotBlank()) {
            requestBuilder.header("Authorization", "Bearer $token")
        }

        val response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            throw RuntimeException("HTTP ${response.statusCode()}: ${response.body().take(200)}")
        }
        return response.body()
    }

    /**
     * Shows a balloon notification attached to [project].
     */
    fun notify(project: Project, message: String, type: NotificationType = NotificationType.INFORMATION) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Gluecron Notifications")
            .createNotification("Gluecron", message, type)
            .notify(project)
    }
}
