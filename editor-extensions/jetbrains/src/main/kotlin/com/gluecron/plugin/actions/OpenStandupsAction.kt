package com.gluecron.plugin.actions

import com.gluecron.plugin.GluecronPlugin
import com.gluecron.plugin.git.RepoResolver
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/**
 * Opens the per-repo AI Standups page in the browser. Falls back to the
 * global /standups view when no Gluecron remote is attached.
 */
class OpenStandupsAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val host = GluecronPlugin.DEFAULT_HOST.trimEnd('/')
        val target = project?.let { RepoResolver.resolveGluecron(it) }?.let {
            "$host/${it.owner}/${it.repo}/standups"
        } ?: "$host/standups"
        BrowserUtil.browse(target)
    }
}
