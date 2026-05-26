package com.gluecron.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Reveals the Gluecron tool window and focuses its Chat sub-view.
 *
 * The tool window itself is registered in plugin.xml — we just open it
 * here. This mirrors `gluecron.chatWithRepo` in the VS Code extension.
 */
class ChatWithRepoAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val tw = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID) ?: return
        tw.activate({
            // The tool window factory installs a JTabbedPane with Chat
            // as the first tab, so simply showing the window puts the
            // user on Chat. We don't need to fiddle with content here.
        }, true, true)
    }

    companion object {
        const val TOOL_WINDOW_ID = "Gluecron"
    }
}
