# Claude Setup for Gluecron

This doc covers how to wire Claude (Desktop or Code) to Gluecron's native
MCP server so it drives this repo through Gluecron's tools — not GitHub's.

## Why we use Gluecron MCP instead of GitHub MCP

Gluecron self-hosts. The canonical remote for every Gluecron repo is
`https://gluecron.com/<owner>/<repo>.git`; GitHub is a 7-day fallback
mirror only. Every PR, issue, comment, merge, and review must land on
Gluecron first or it doesn't exist as far as the platform is concerned.

The Gluecron MCP server (`POST /mcp`, see `src/lib/mcp-tools.ts`) exposes
15 tools — 5 read, 10 write — covering the full lifecycle:

- `gluecron_repo_search`, `gluecron_repo_read_file`,
  `gluecron_repo_list_issues`, `gluecron_repo_explain_codebase`,
  `gluecron_repo_health` (read).
- `gluecron_create_issue`, `gluecron_comment_issue`,
  `gluecron_close_issue`, `gluecron_reopen_issue` (issues).
- `gluecron_create_pr`, `gluecron_get_pr`, `gluecron_list_prs`,
  `gluecron_comment_pr`, `gluecron_merge_pr`, `gluecron_close_pr` (PRs).

If Claude falls back to a `mcp__github__*` write tool, the change lands on
the wrong source of truth and the deploy pipeline (`scripts/self-deploy.sh`)
never fires. That's why `.claude/settings.json` denies the GitHub write
tools at the harness layer.

## Set up Claude Desktop (30 seconds)

Two equally valid paths:

### Option A — drag the `.dxt` extension

1. Open <https://gluecron.com/> and download `public/gluecron.dxt`.
2. Drag it onto the Claude Desktop window. Claude prompts for two values:
   - `gluecron_host` — leave as `https://gluecron.com` unless you run a
     private instance.
   - `gluecron_pat` — paste a token from `/settings/tokens` (admin
     scope; the merge tool needs it).
3. Done. Restart Claude Desktop. Ask "list my open Gluecron repos" — it
   should call `gluecron_repo_search` immediately.

### Option B — one-line installer

```bash
curl -sSL https://gluecron.com/install | bash
```

The script signs you in, mints a PAT, and merges a `gluecron` entry into
`~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux / WSL).
Idempotent — safe to re-run.

## Set up Claude Code

**No setup.** The repo ships `.claude/settings.json`. Claude Code reads
it automatically every session opened inside this checkout.

The only thing you provide is a `GLUECRON_PAT` env var in your shell:

```bash
export GLUECRON_PAT="glc_..."   # from https://gluecron.com/settings/tokens
```

The settings file uses `${env:GLUECRON_PAT}` as the bearer token, so the
PAT never lands in any file under version control.

## Verify it's working

Open Claude inside this repo and ask:

> list my open PRs

A correctly-wired Claude will call `gluecron_list_prs` (you'll see it in
the tool-call trace). It must NOT call anything starting with
`mcp__github__`. If it does, the settings file's deny list will surface
a `permission denied` error — switch to the `gluecron_*` equivalent.

Other smoke prompts:

| Prompt | Expected MCP tool |
| --- | --- |
| "Show me issue 17" | `gluecron_repo_list_issues` (then narrow) |
| "Comment 'thanks' on PR 42" | `gluecron_comment_pr` |
| "What's the health score of ccantynz/Gluecron.com?" | `gluecron_repo_health` |
| "Search repos for 'rate limiter'" | `gluecron_repo_search` |

## Troubleshooting

- **"authentication required for gluecron_..."** — the MCP server got the
  request but the PAT didn't authenticate. Re-mint at `/settings/tokens`
  and update `GLUECRON_PAT`.
- **"permission denied: mcp__github__create_pull_request"** — Claude
  tried to fall back to GitHub. The deny list caught it. Re-prompt
  with "use Gluecron, not GitHub".
- **Skill not auto-invoking** — make sure the active git remote contains
  `gluecron.com` (`git remote -v`), or export `GLUECRON_HOST` to override
  the detection.
