package com.gluecron.plugin.git

import com.gluecron.plugin.GluecronPlugin
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.io.File
import java.net.URI

/**
 * Owner/repo resolver — shells out to `git remote get-url origin` and
 * parses the URL with the same rules as the VS Code extension's
 * `git.ts#parseGitRemote`. Kept dependency-free so we can unit-test the
 * parser without an IDE.
 */
data class RepoInfo(val owner: String, val repo: String, val host: String)

object RepoResolver {

    private val LOG = Logger.getInstance(RepoResolver::class.java)

    /**
     * Run `git remote get-url origin` in the project root (the first
     * content root). Returns null if there is no project, no remote, or
     * the URL doesn't parse.
     */
    fun resolve(project: Project): RepoInfo? {
        val root = project.basePath ?: return null
        val url = runGit(root, "remote", "get-url", "origin") ?: return null
        return parseGitRemote(url)
    }

    /**
     * Returns the resolver result only when the remote is on the
     * configured Gluecron host. Plays the same role as
     * `getGluecronRepoInfo` in the VS Code extension.
     */
    fun resolveGluecron(project: Project, configuredHost: String = GluecronPlugin.DEFAULT_HOST): RepoInfo? {
        val info = resolve(project) ?: return null
        return if (isGluecronRemote(info.host, configuredHost)) info else null
    }

    /**
     * Parse any of the URL flavours git understands:
     *   - https://gluecron.com/owner/repo.git
     *   - https://user:pw@gluecron.com/owner/repo
     *   - http://localhost:3000/owner/repo.git
     *   - git@gluecron.com:owner/repo.git
     *   - ssh://git@gluecron.com:2222/owner/repo.git
     */
    fun parseGitRemote(raw: String): RepoInfo? {
        val url = raw.trim()
        if (url.isEmpty()) return null

        // SCP-style: user@host:owner/repo[.git]
        val scp = SCP_REGEX.matchEntire(url)
        if (scp != null) {
            val host = scp.groupValues[1]
            val (owner, repo) = splitPath(scp.groupValues[2]) ?: return null
            return RepoInfo(owner, repo, host)
        }

        // URL forms (http, https, ssh, git)
        val parsed = runCatching { URI(url) }.getOrNull() ?: return null
        val host = parsed.host?.lowercase() ?: return null
        val path = parsed.path?.trimStart('/')?.removeSuffix(".git")?.removeSuffix("/") ?: return null
        val (owner, repo) = splitPath(path) ?: return null
        return RepoInfo(owner, repo, host)
    }

    fun isGluecronRemote(remoteHost: String, configuredHost: String): Boolean {
        if (remoteHost.isBlank()) return false
        val cfgHost = runCatching { URI(configuredHost).host }.getOrNull()
            ?: configuredHost.substringAfter("://").substringBefore('/')
        return remoteHost.equals(cfgHost, ignoreCase = true)
    }

    private fun splitPath(path: String): Pair<String, String>? {
        val parts = path.split('/').filter { it.isNotEmpty() }
        if (parts.size < 2) return null
        // Owner/repo are always the LAST two segments — handles path-prefixed
        // self-hosted setups like /git/owner/repo.
        return parts[parts.size - 2] to parts[parts.size - 1]
    }

    private fun runGit(cwd: String, vararg args: String): String? {
        return try {
            val p = ProcessBuilder(listOf("git") + args.toList())
                .directory(File(cwd))
                .redirectErrorStream(false)
                .start()
            val out = p.inputStream.bufferedReader().readText()
            val finished = p.waitFor()
            if (finished != 0) null else out.trim().ifEmpty { null }
        } catch (e: Exception) {
            LOG.debug("git ${args.joinToString(" ")} failed: ${e.message}")
            null
        }
    }

    // SCP form has no `//` after the scheme — URI() refuses it.
    private val SCP_REGEX = Regex("""^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?/?$""")
}
