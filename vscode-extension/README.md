# Gluecron — VS Code Extension

Talk to your Gluecron server straight from the editor. Explain files, open on
the web, run semantic searches, scaffold failing tests.

## Install (dev)

```
cd vscode-extension
npm install
npm run compile
code --install-extension .
```

## Configure

Add to your `settings.json`:

```json
{
  "gluecron.host": "https://gluecron.com",
  "gluecron.token": "glc_..."
}
```

Tokens come from `/settings/tokens` on your Gluecron instance.

## Commands

| Command | What it does |
|---|---|
| `Gluecron: Explain This File` | 3-5 bullet summary via `/api/copilot/completions` |
| `Gluecron: Open Current File on Web` | Opens `./owner/repo/blob/main/<path>#L<line>` |
| `Gluecron: Semantic Search` | Prompts for a query, hits `/api/graphql` |
| `Gluecron: Generate Tests for Current File` | Scaffolds a failing test via `/ai/tests?format=raw` |

## Repo detection

The extension reads `git config --get remote.origin.url` and strips the host
prefix. If you're using a self-hosted Gluecron, set `gluecron.host` accordingly.
