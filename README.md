# gluecron

AI-native code intelligence platform — git hosting, automated CI, and green ecosystem enforcement.

## Quick Start

```bash
bun install
bun dev
```

Then visit `http://localhost:3000` to register and create your first repository.

## Features

- **Git hosting** — clone, push, fetch via Smart HTTP protocol
- **Web code browser** — file tree, syntax-highlighted source, commit log, unified diffs
- **Authentication** — registration, login, sessions with bcrypt password hashing
- **User profiles** — avatar, bio, public repository listing
- **Repository management** — create repos via web UI, public/private visibility
- **Branch switching** — dropdown to navigate between branches
- **Stars** — star/unstar repositories
- **SSH keys** — add/remove SSH keys for your account
- **GateTest integration** — automated code scanning on every push
- **Crontech deploy** — trigger deploys on push to main

## Stack

Bun + Hono + Drizzle ORM + Neon (PostgreSQL)
