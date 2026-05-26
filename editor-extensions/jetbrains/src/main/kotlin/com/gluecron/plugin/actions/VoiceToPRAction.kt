package com.gluecron.plugin.actions

import com.gluecron.plugin.GluecronPlugin
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/**
 * Opens the `/voice` console in the user's browser — the same shortcut
 * the VS Code extension exposes.
 *
 * We don't try to embed the voice UI inside the IDE: it relies on the
 * browser's WebRTC + microphone permissions, which behave better in a
 * real browser tab than in a JCEF wrapper.
 */
class VoiceToPRAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val host = GluecronPlugin.DEFAULT_HOST.trimEnd('/')
        BrowserUtil.browse("$host/voice")
    }
}
