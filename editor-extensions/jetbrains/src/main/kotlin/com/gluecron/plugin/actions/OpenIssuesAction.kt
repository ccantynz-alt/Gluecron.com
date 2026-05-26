package com.gluecron.plugin.actions

import com.gluecron.plugin.GluecronPlugin
import com.gluecron.plugin.git.RepoResolver
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/**
 * Opens the current repo's issues page in the browser, with a sensible
 * dashboard fallback for non-Gluecron workspaces.
 */
class OpenIssuesAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val host = GluecronPlugin.DEFAULT_HOST.trimEnd('/')
        val target = project?.let { RepoResolver.resolveGluecron(it) }?.let {
            "$host/${it.owner}/${it.repo}/issues"
        } ?: "$host/issues"
        BrowserUtil.browse(target)
    }
}
