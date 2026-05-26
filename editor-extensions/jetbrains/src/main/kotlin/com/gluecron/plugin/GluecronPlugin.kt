package com.gluecron.plugin

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.project.Project

/**
 * Plugin "entry point" — JetBrains plugins do most wiring via plugin.xml
 * extension points, so this class exists mainly so we have a single
 * place to log activation and to surface plugin-wide constants.
 *
 * Implements [ProjectActivity] (the modern replacement for
 * StartupActivity) so we run once per opened project. Heavy lifting
 * happens lazily inside individual actions / services.
 */
class GluecronPlugin : ProjectActivity {

    override suspend fun execute(project: Project) {
        LOG.info("Gluecron plugin activated for project: ${project.name}")
    }

    companion object {
        const val PLUGIN_ID = "com.gluecron.plugin"

        /** Configuration default — overrideable via env GLUECRON_HOST. */
        val DEFAULT_HOST: String =
            System.getenv("GLUECRON_HOST")?.takeIf { it.isNotBlank() }
                ?: "https://gluecron.com"

        private val LOG = Logger.getInstance(GluecronPlugin::class.java)
    }
}
