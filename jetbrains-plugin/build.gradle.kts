plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.21"
    id("org.jetbrains.intellij") version "1.16.1"
}

group = "com.gluecron"
version = "0.1.0"

repositories {
    mavenCentral()
}

// Configure IntelliJ Platform Plugin Gradle Plugin 1.x
intellij {
    pluginName.set("Gluecron")
    version.set(project.property("platform.version").toString())
    type.set("IC") // IntelliJ IDEA Community Edition
    plugins.set(listOf("git4idea"))
}

kotlin {
    jvmToolchain(17)
}

tasks {
    buildSearchableOptions {
        enabled = false
    }

    patchPluginXml {
        sinceBuild.set("231")   // 2023.1
        untilBuild.set("251.*") // 2025.1.*
        changeNotes.set(
            """
            <ul>
              <li>0.1.0: Initial release — Open PR, Create Issue, Merge PR, View Health</li>
            </ul>
            """.trimIndent()
        )
    }

    signPlugin {
        certificateChain.set(System.getenv("CERTIFICATE_CHAIN") ?: "")
        privateKey.set(System.getenv("PRIVATE_KEY") ?: "")
        password.set(System.getenv("PRIVATE_KEY_PASSWORD") ?: "")
    }

    publishPlugin {
        token.set(System.getenv("PUBLISH_TOKEN") ?: "")
    }
}
