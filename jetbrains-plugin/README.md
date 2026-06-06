# Gluecron JetBrains Plugin

IntelliJ Platform plugin for [Gluecron](https://gluecron.com) — AI-native code intelligence.

Works in **IntelliJ IDEA**, **WebStorm**, **GoLand**, **PyCharm**, and any other JetBrains IDE
based on the IntelliJ Platform 2023.1+.

## Features

| Action | Location | What it does |
|--------|----------|--------------|
| **Open PR List** | Gluecron menu / VCS Operations | Opens `{host}/{owner}/{repo}/pulls` in your browser |
| **Create Issue** | Gluecron menu / VCS Operations | Opens `{host}/{owner}/{repo}/issues/new` in your browser |
| **Merge PR for Current Branch** | Gluecron menu / VCS Operations | POSTs to the Gluecron API to merge the open PR for the checked-out branch |
| **View Repo Health** | Gluecron menu / VCS Operations | Opens `{host}/{owner}/{repo}/health` in your browser |

The plugin detects `owner/repo` automatically from your project's git remote URL.

## Requirements

- JDK 17+
- Gradle 8.x (the Gradle wrapper `gradlew` is the recommended way to build)
- A Gluecron server (self-hosted or [gluecron.com](https://gluecron.com))
- A personal access token with `repo` scope (generate one at `{host}/settings/tokens`)

## Building

```bash
# Clone the repository
git clone https://gluecron.com/ccantynz/Gluecron.com.git
cd Gluecron.com/jetbrains-plugin

# Build the plugin zip (output: build/distributions/gluecron-jetbrains-0.1.0.zip)
./gradlew buildPlugin

# Run the plugin in a sandboxed IDE for development
./gradlew runIde
```

The `buildPlugin` task produces a zip archive at:

```
build/distributions/gluecron-jetbrains-<version>.zip
```

## Installing the Plugin

### From local zip (manual install)

1. Open your JetBrains IDE.
2. Go to **Settings → Plugins → ⚙ → Install Plugin from Disk…**
3. Select `build/distributions/gluecron-jetbrains-0.1.0.zip`.
4. Restart the IDE when prompted.

### From JetBrains Marketplace (once published)

Search for **"Gluecron"** in **Settings → Plugins → Marketplace**.

## Configuration

After installation, configure the plugin:

1. Open **Settings → Tools → Gluecron**.
2. Set **Server URL** to your Gluecron instance (e.g. `https://gluecron.com`).
3. Set **Access Token** to a personal access token generated at `{host}/settings/tokens`.

Alternatively, set environment variables before launching your IDE:

```bash
export GLUECRON_HOST=https://gluecron.com
export GLUECRON_TOKEN=glc_your_token_here
```

The plugin reads these on startup and pre-fills the settings if they are not yet configured.

## Project Structure

```
jetbrains-plugin/
  build.gradle.kts                          Gradle build — IntelliJ Platform Plugin 1.x
  settings.gradle.kts                       Root project name
  gradle.properties                         plugin.id, plugin.version, platform.version
  src/main/
    resources/META-INF/plugin.xml           Plugin manifest (actions, extensions)
    kotlin/com/gluecron/
      GluecronPlugin.kt                     Startup activity (env var seeding, welcome notification)
      GluecronUtil.kt                       Shared helpers (git remote detection, browser, API)
      actions/
        OpenPrAction.kt                     Opens PR list in browser
        CreateIssueAction.kt                Opens new issue form in browser
        MergePrAction.kt                    Calls Gluecron API to merge current branch's PR
        ViewHealthAction.kt                 Opens repo health dashboard in browser
      settings/
        GluecronSettingsState.kt            PersistentStateComponent (host + token)
        GluecronSettingsConfigurable.kt     Settings UI (two text fields)
```

## Merge PR — API details

`MergePrAction` sends:

```
POST {host}/api/repos/{owner}/{repo}/pulls/merge
Authorization: Bearer {token}
Content-Type: application/json

{"head": "<current-branch>", "merge_method": "merge"}
```

A confirmation dialog is shown before the request is sent. The action
requires a valid access token to be configured.

## License

MIT — see the root `LICENSE` file.
