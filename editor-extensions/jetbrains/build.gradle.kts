/*
 * Gradle build for the Gluecron JetBrains plugin.
 *
 * Uses the IntelliJ Platform Gradle Plugin v1.17+ (the still-stable line
 * that targets IC-2024.1 across IDEA, WebStorm, GoLand, PyCharm, RustRover
 * and Rider). The plugin builds a single .zip via `./gradlew buildPlugin`.
 *
 * NOTE: gradle itself is intentionally NOT installed in the dev container —
 * this file just declares everything. CI / contributors invoke gradle via
 * the wrapper (`./gradlew`) which downloads its own JDK + gradle dist.
 */

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.24"
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "com.gluecron"
version = "0.1.0"

repositories {
    mavenCentral()
}

// -----------------------------------------------------------------------
// IntelliJ Platform target.
//
// IC-2024.1 is the floor: it is the earliest 2024.x platform release and
// is binary-compatible with every JetBrains IDE 2024.1+. We list all the
// IDEs we want to load into via `plugins`/`type` overrides during
// `runIde` — for buildPlugin, the IC base is enough.
// -----------------------------------------------------------------------

intellij {
    version.set("2024.1")
    type.set("IC")
    plugins.set(listOf("Git4Idea")) // VCS APIs (CheckinHandlerFactory etc.)
}

// -----------------------------------------------------------------------
// Compile + run targets.
// -----------------------------------------------------------------------

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    // Kotlin stdlib is bundled with the platform, but pin it for IDE happiness.
    implementation("org.jetbrains.kotlin:kotlin-stdlib")

    // JSON for /api/v2 payloads.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // ktor-client for HTTP. CIO engine has no native deps so it works
    // identically on macOS/Linux/Windows.
    implementation("io.ktor:ktor-client-core:2.3.12")
    implementation("io.ktor:ktor-client-cio:2.3.12")
    implementation("io.ktor:ktor-client-content-negotiation:2.3.12")
    implementation("io.ktor:ktor-serialization-kotlinx-json:2.3.12")
}

tasks {
    patchPluginXml {
        sinceBuild.set("241")  // 2024.1
        untilBuild.set("251.*") // 2025.1 — bump as we test newer platforms
    }

    // Tighten the build artifact name so the install/jetbrains route can
    // reference a stable zip name.
    buildPlugin {
        archiveBaseName.set("gluecron-jetbrains")
    }

    // Marketplace publishing is opt-in. Tokens come from env so we don't
    // accidentally commit them; CI populates them when we choose to ship.
    publishPlugin {
        token.set(providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN").orElse(""))
        channels.set(listOf(providers.environmentVariable("JETBRAINS_PUBLISH_CHANNEL").getOrElse("default")))
    }
}
