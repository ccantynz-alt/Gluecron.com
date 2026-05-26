# Contributing — Gluecron JetBrains plugin

## Prerequisites

- **JDK 17** (Temurin / Zulu / Oracle — any will do).
- The IntelliJ Platform Gradle Plugin downloads its own IDE distribution
  during the build, so you don't need to install IntelliJ separately.
- **Gradle is NOT pinned in this repo** — use the wrapper that gradle
  generates for you, or invoke an installed `gradle` from the JetBrains
  Toolbox / SDKMan. The dev container intentionally does not preinstall it.

## Build the plugin .zip

```bash
cd editor-extensions/jetbrains
./gradlew buildPlugin
```

Output lands at:

```
build/distributions/gluecron-jetbrains-0.1.0.zip
```

Drop the zip into IDEA via **Settings → Plugins → ⚙ → Install Plugin from
Disk…** to test locally.

## Run the plugin in a sandbox IDE

```bash
./gradlew runIde
```

Spins up an IntelliJ IDEA Community sandbox with the plugin pre-installed.
Useful for clicking through the actions without restarting your daily IDE.

## Publish to the JetBrains Marketplace

```bash
# 1. Get a publish token from https://plugins.jetbrains.com/author/me/tokens
export JETBRAINS_MARKETPLACE_TOKEN=...

# 2. Optional — push to a non-default channel ("eap" / "nightly" / etc.)
export JETBRAINS_PUBLISH_CHANNEL=default

# 3. Build + upload
./gradlew publishPlugin
```

`publishPlugin` re-runs `buildPlugin`, signs nothing extra (the marketplace
takes unsigned plugins), and uploads via the documented REST API.

## Source layout

```
editor-extensions/jetbrains/
  build.gradle.kts              ← IntelliJ Platform plugin + ktor + serialization
  settings.gradle.kts
  gradle.properties
  src/main/kotlin/com/gluecron/plugin/
    GluecronPlugin.kt           ← post-startup activity / constants
    auth/AuthService.kt         ← PasswordSafe-backed PAT storage
    api/GluecronClient.kt       ← ktor HTTP client for /api/v2
    git/RepoResolver.kt         ← git remote → owner/repo
    actions/                    ← all menu actions
    toolwindow/GluecronToolWindow.kt
  src/main/resources/
    META-INF/plugin.xml
    META-INF/pluginIcon.svg     ← marketplace icon
    icons/toolWindowIcon.svg
    icons/commitMessageIcon.svg
```

## Code style

- Kotlin official style (matches `kotlin.code.style=official` in
  `gradle.properties`).
- Keep new actions narrow: one file each, with a doc-block explaining
  what menu they live in and why.
- Don't add new server endpoints from here — talk to the existing
  `/api/v2/*` surface so the VS Code, CLI, and JetBrains extensions
  stay in sync.
