# Gluecron for VS Code

AI-native git inside your editor — chat with the repo, ship PRs, run specs, voice-to-PR, and let Claude write your commit messages.

> The Gluecron platform: https://gluecron.com

## Features

- **Repo chat** — sidebar chat grounded in the current repository (uses the same retrieval/citation pipeline as the web UI).
- **AI commit messages** — click the sparkle in the Source Control title bar to drop a Conventional Commits–style message into the input box, drafted from your staged diff.
- **Open in Gluecron** — jump from the active file (and line) straight to its blob page on the server.
- **Pull requests / Issues / Standups** — sidebar webviews that embed the live web UI; everything works without a second auth round-trip.
- **Ship a spec** — turn the current file into a Gluecron spec (auto-generates a draft PR).
- **Voice-to-PR** — open the `/voice` console for phone-first dictation.

## Install

### From a .vsix (current path)

```bash
cd editor-extensions/vscode
npm install
npm run compile
npx vsce package
code --install-extension gluecron-vscode-0.1.0.vsix
```

### From the marketplace (coming soon)

Once published, install from the Extensions panel by searching for **Gluecron**.

## Configure

| Setting | Default | Description |
| --- | --- | --- |
| `gluecron.host` | `https://gluecron.com` | Override for self-hosted instances. Accepts any URL the browser would. |
| `gluecron.defaultBranch` | `main` | Branch used when constructing `…/blob/<branch>/…` deep-links. |

Sign in with a Personal Access Token (`glc_…`). Create one at `${host}/settings/tokens` (the **admin** scope is required for the commit-message API).

## Commands

| Command | Default trigger |
| --- | --- |
| `Gluecron: Sign In (Personal Access Token)` | Command palette |
| `Gluecron: Chat With This Repo` | Command palette / activity bar icon |
| `Gluecron: Open Current File on Web` | Editor context menu |
| `Gluecron: Open Pull Requests` | Command palette |
| `Gluecron: Ship Current File as Spec` | Command palette |
| `Gluecron: Voice-to-PR` | Command palette |
| `Generate AI Commit Message` | Source Control title bar (`$(sparkle)`) |

## Screenshots

_Coming soon — drop PNGs into `editor-extensions/vscode/media/` and reference them here._

- `media/chat.png` — sidebar chat
- `media/commit.png` — sparkle in the SCM title bar
- `media/pulls.png` — pulls sidebar

## How it talks to the server

- `POST /api/v2/ai/commit-message` for AI-drafted commit messages (see `src/lib/ai-commit-message.ts`).
- `GET /api/v2/user` to validate PATs.
- The chat / pulls / issues / standups sidebars are iframes pointing at the web UI's `?embed=1` views — no separate auth surface, no duplicated rendering code.

## Development

```bash
npm install
npm run watch       # type-check on save
npm run test        # node --test (pure git URL parser unit tests)
```

To debug against a self-hosted Gluecron, set `gluecron.host` in your User Settings (e.g. `http://localhost:3000`) and reload the window.

## License

MIT — same as the rest of the Gluecron source.
