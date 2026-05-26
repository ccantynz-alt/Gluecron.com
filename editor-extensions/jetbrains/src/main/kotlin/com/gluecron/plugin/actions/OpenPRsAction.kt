package com.gluecron.plugin.actions

import com.gluecron.plugin.GluecronPlugin
import com.gluecron.plugin.git.RepoResolver
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/**
 * Opens the current repo's pull-requests page in the user's browser.
 * Falls back to the global /pulls dashboard when we can't resolve a repo.
 */
class OpenPRsAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val host = GluecronPlugin.DEFAULT_HOST.trimEnd('/')
        val target = project?.let { RepoResolver.resolveGluecron(it) }?.let {
            "$host/${it.owner}/${it.repo}/pulls"
        } ?: "$host/pulls"
        BrowserUtil.browse(target)
    }
}
