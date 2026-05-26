# Gluecron for JetBrains IDEs

AI-native git inside IntelliJ IDEA, WebStorm, GoLand, PyCharm, RustRover, and
Rider — chat with the repo, draft commit messages, ship specs, voice-to-PR.

> The Gluecron platform: https://gluecron.com

## Features

- **Repo chat** — sidebar tool window grounded in the current repository.
- **AI commit messages** — sparkle button on the VCS commit dialog drops a
  Conventional Commits–style message into the input from your staged diff.
- **Pull requests / Issues / Standups** — embedded JCEF browser tabs that
  point at the live web UI; no second auth round-trip.
- **Ship a spec** — turn the current file into a Gluecron spec (auto-drafts
  a PR).
- **Voice-to-PR** — opens the `/voice` console in your browser.

## Install

### From the JetBrains Marketplace (coming soon)

1. **Settings** → **Plugins** → search for **Gluecron**.
2. Install, then restart the IDE.

### Sideload a .zip (current path)

1. Build the plugin once:
   ```bash
   cd editor-extensions/jetbrains
   ./gradlew buildPlugin
   ```
2. The artifact is written to
   `build/distributions/gluecron-jetbrains-0.1.0.zip`.
3. In the IDE: **Settings** → **Plugins** → gear icon →
   **Install Plugin from Disk…** and pick the zip. Restart when prompted.

Sideloads can also be served from the host: visit
`https://gluecron.com/install/jetbrains` for marketplace + sideload links.

## Configure

| Setting | Source | Description |
| --- | --- | --- |
| `host` | env `GLUECRON_HOST` | Override for self-hosted instances (defaults to `https://gluecron.com`). |
| `token` | env `GLUECRON_TOKEN` or IDE password safe | Personal access token (`glc_…`). |

Sign in with **Tools → Gluecron → Sign In (Personal Access Token)**. Create a
PAT at `https://gluecron.com/settings/tokens` (the **admin** scope is
required for the commit-message API).

## Commands

| Command | Where you'll find it |
| --- | --- |
| Sign In (Personal Access Token) | Tools → Gluecron |
| Chat with This Repo | Tools → Gluecron · Editor right-click menu |
| Open Pull Requests | Tools → Gluecron · VCS menu |
| Open Issues | Tools → Gluecron |
| Open AI Standups | Tools → Gluecron |
| Ship Current File as Spec | Tools → Gluecron · Editor right-click menu |
| Voice-to-PR | Tools → Gluecron |
| Generate AI Commit Message | VCS commit dialog (sparkle icon) |

## Screenshots

_Coming soon — drop PNGs into `editor-extensions/jetbrains/screenshots/` and
reference them here:_

- `screenshots/chat.png` — Gluecron tool window with the Chat tab open.
- `screenshots/commit.png` — sparkle button in the commit dialog.
- `screenshots/prs.png` — embedded PRs tab.

## How it talks to the server

- `POST /api/v2/ai/commit-message` — staged diff → commit text.
- `GET  /api/v2/user`              — PAT validation on sign-in.
- Tool-window tabs embed `/:owner/:repo/{chat,pulls,issues,standups}?embed=1`
  inside a JCEF browser — same `?embed=1` views as the VS Code extension.

## License

MIT — same as the rest of the Gluecron source.
