package com.gluecron.plugin.actions

import com.gluecron.plugin.GluecronPlugin
import com.gluecron.plugin.git.RepoResolver
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ui.Messages
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Treat the current editor file as a Gluecron spec and ship it.
 *
 * For parity with the VS Code command, we don't upload the content here
 * — we deep-link to `/specs/new?path=<rel>` and let the server's spec
 * wizard read the file from the user's git working tree on the
 * subsequent draft-PR step. Keeps auth + diff handling on the server.
 */
class ShipSpecAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val info = RepoResolver.resolveGluecron(project)
        if (file == null || info == null) {
            Messages.showWarningDialog(
                project,
                "Open a file inside a Gluecron-hosted repo first.",
                "Gluecron — Ship Spec",
            )
            return
        }
        val base = project.basePath ?: return
        val rel = file.path.removePrefix(base).trimStart('/')
        val encoded = URLEncoder.encode(rel, StandardCharsets.UTF_8)
        val host = GluecronPlugin.DEFAULT_HOST.trimEnd('/')
        BrowserUtil.browse("$host/${info.owner}/${info.repo}/specs/new?path=$encoded")
    }
}
