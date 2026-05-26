package com.gluecron.plugin.toolwindow

import com.gluecron.plugin.GluecronPlugin
import com.gluecron.plugin.git.RepoResolver
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import java.awt.BorderLayout
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * Tool window factory — registered in plugin.xml under id "Gluecron".
 *
 * Lays out four JCEF browser tabs (Chat / PRs / Issues / Standups),
 * each pointing at the relevant `?embed=1` URL on the configured host.
 * If JCEF is unavailable (e.g. JetBrains Gateway thin client) we
 * fall back to a friendly notice that links out to the web UI.
 */
class GluecronToolWindow : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val tabs = JBTabbedPane()
        val host = GluecronPlugin.DEFAULT_HOST.trimEnd('/')
        val info = RepoResolver.resolveGluecron(project)

        if (info == null) {
            tabs.addTab("Gluecron", emptyState("Open a folder backed by a Gluecron-hosted repo to see chat, PRs, issues, and standups here."))
        } else {
            val base = "$host/${info.owner}/${info.repo}"
            tabs.addTab("Chat", browserPanel("$base/chat?embed=1"))
            tabs.addTab("PRs", browserPanel("$base/pulls?embed=1"))
            tabs.addTab("Issues", browserPanel("$base/issues?embed=1"))
            tabs.addTab("Standups", browserPanel("$base/standups?embed=1"))
        }

        val panel = JPanel(BorderLayout()).apply {
            add(tabs, BorderLayout.CENTER)
        }
        val content = toolWindow.contentManager.factory.createContent(panel, "", false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true

    private fun browserPanel(url: String): JComponent {
        if (!JBCefApp.isSupported()) {
            return emptyState(
                "Embedded browser (JCEF) isn't available in this IDE distribution. " +
                    "Open $url in your browser instead.",
            )
        }
        val browser = JBCefBrowser(url)
        return JPanel(BorderLayout()).apply {
            add(browser.component, BorderLayout.CENTER)
        }
    }

    private fun emptyState(text: String): JComponent {
        return JPanel(BorderLayout()).apply {
            val label = JBLabel(
                "<html><div style='padding:16px; max-width:320px'>$text</div></html>",
                SwingConstants.LEFT,
            )
            add(label, BorderLayout.NORTH)
        }
    }
}
