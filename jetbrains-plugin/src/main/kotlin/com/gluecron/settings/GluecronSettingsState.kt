package com.gluecron.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Persistent state for Gluecron plugin settings.
 *
 * Stored in: <config>/options/GluecronSettings.xml
 *
 * Fields:
 *   host  — the Gluecron server base URL (e.g. "https://gluecron.com")
 *   token — a personal access token (glc_...) with read+write repo scope
 *
 * Both fields can also be seeded from environment variables at first
 * launch (see [GluecronPlugin]):
 *   GLUECRON_HOST  → host
 *   GLUECRON_TOKEN → token
 */
@State(
    name = "GluecronSettingsState",
    storages = [Storage("GluecronSettings.xml")]
)
class GluecronSettingsState : PersistentStateComponent<GluecronSettingsState.State> {

    data class State(
        var host: String = "http://localhost:3000",
        var token: String = ""
    )

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    /** Gluecron server base URL, e.g. "https://gluecron.com" (no trailing slash). */
    var host: String
        get() = myState.host.trimEnd('/')
        set(value) { myState.host = value.trimEnd('/') }

    /** Personal access token (glc_...). May be empty if the server is public. */
    var token: String
        get() = myState.token
        set(value) { myState.token = value }

    companion object {
        fun getInstance(): GluecronSettingsState =
            ApplicationManager.getApplication()
                .getService(GluecronSettingsState::class.java)
    }
}
