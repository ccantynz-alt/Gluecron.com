package com.gluecron.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Settings UI for the Gluecron plugin.
 *
 * Accessible via: Settings → Tools → Gluecron
 *
 * Provides two fields:
 *   - Server URL  — the Gluecron host (e.g. "https://gluecron.com")
 *   - Access Token — personal access token (glc_...)
 */
class GluecronSettingsConfigurable : Configurable {

    private var hostField: JBTextField? = null
    private var tokenField: JBTextField? = null

    override fun getDisplayName(): String = "Gluecron"

    override fun createComponent(): JComponent {
        val settings = GluecronSettingsState.getInstance()

        hostField = JBTextField(settings.host, 40)
        tokenField = JBTextField(settings.token, 40)

        return FormBuilder.createFormBuilder()
            .addLabeledComponent(
                JBLabel("Server URL:"),
                hostField!!,
                1,
                false
            )
            .addLabeledComponent(
                JBLabel("Access Token:"),
                tokenField!!,
                1,
                false
            )
            .addComponentFillVertically(JPanel(), 0)
            .panel
    }

    override fun isModified(): Boolean {
        val settings = GluecronSettingsState.getInstance()
        return hostField?.text?.trimEnd('/') != settings.host ||
               tokenField?.text != settings.token
    }

    override fun apply() {
        val settings = GluecronSettingsState.getInstance()
        hostField?.text?.let { settings.host = it }
        tokenField?.text?.let { settings.token = it }
    }

    override fun reset() {
        val settings = GluecronSettingsState.getInstance()
        hostField?.text = settings.host
        tokenField?.text = settings.token
    }

    override fun disposeUIResources() {
        hostField = null
        tokenField = null
    }
}
