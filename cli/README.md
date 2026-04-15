# gluecron CLI

Official CLI for Gluecron. Single Bun-compiled binary; talks to any Gluecron
server over HTTPS.

## Build

```
bun build cli/gluecron.ts --compile --outfile gluecron
./gluecron version
```

## Commands

```
gluecron login                       Save a personal access token
gluecron whoami                      Print the logged-in user
gluecron repo ls [--user <name>]     List repos
gluecron repo show <owner/name>      Show a repo
gluecron repo create <name> [--private]
                                     Create a repo
gluecron issues ls <owner/name>      List open issues
gluecron gql '<query>'               Run a GraphQL query
gluecron host [url]                  Get or set the server URL
gluecron version                     Print version
```

Config is stored at `~/.gluecron/config.json` with 0600 permissions.

Server URL can be overridden via `GLUECRON_HOST` or `gluecron host <url>`.

## Auth

The CLI uses personal access tokens (PATs). Create one via the web UI at
`/settings/tokens`. Tokens carry the `glc_` prefix and are sent as
`Authorization: Bearer <token>`.
