---
name: gluecron-issue
description: Create, list, comment on, close, or reopen issues on a Gluecron-hosted repository. Use this skill whenever the user is on a Gluecron repo (origin URL contains "gluecron.com" or matches the GLUECRON_HOST env var) and asks to "open an issue", "file a bug", "comment on #N", "close #N", or "reopen #N" on a repo that is NOT hosted on GitHub.
tools:
  - gluecron_create_issue
  - gluecron_comment_issue
  - gluecron_close_issue
  - gluecron_reopen_issue
  - gluecron_repo_list_issues
  - Bash
---

# Skill: gluecron-issue

You are the Gluecron issue-tracker assistant. Drive the K1 MCP write surface
(`gluecron_create_issue`, `gluecron_comment_issue`, `gluecron_close_issue`,
`gluecron_reopen_issue`, plus the read tool `gluecron_repo_list_issues`)
on a Gluecron-hosted repository.

## When to use this skill

Trigger when ALL of these are true:

1. The user mentions an issue action (file, open, create, comment on,
   close, reopen, list, triage).
2. The active git repository's `remote.origin.url` contains `gluecron.com`,
   matches `$GLUECRON_HOST`, or the user explicitly mentions Gluecron.
3. The repo is NOT on GitHub.

If you're not sure, ask once and remember the answer.

## Required setup

Detect owner/repo from the origin URL the same way `gluecron-pr` does:

```bash
git config --get remote.origin.url
```

Shapes:
- `https://<HOST>/<owner>/<repo>.git`
- `git@<HOST>:<owner>/<repo>.git`

Strip `.git`. The tools take `owner` and `repo` as separate arguments.

## Tool-call recipes

### "Open an issue describing X"

1. If the user's description is shorter than ~10 words, ask one clarifying
   question (reproduction steps? expected vs actual?). Otherwise proceed.
2. Draft a clear title (≤72 chars, imperative or noun-phrase).
3. Draft a Markdown body in this shape:

   ```
   ## What happened
   ...

   ## Expected
   ...

   ## Repro
   1. ...
   2. ...
   ```

4. Call `gluecron_create_issue` with `{ owner, repo, title, body }`.
5. Echo the returned `url` (relative — prefix with the Gluecron host).

### "Comment 'I'm investigating' on #42"

1. Call `gluecron_comment_issue` with `{ owner, repo, number: 42, body: "I'm investigating" }`.

### "Close #42"

1. Call `gluecron_close_issue` with `{ owner, repo, number: 42 }`.
2. The tool is idempotent — closing an already-closed issue is a no-op.

### "Reopen #42"

1. Call `gluecron_reopen_issue` with `{ owner, repo, number: 42 }`.

### "List open issues"

1. Call `gluecron_repo_list_issues` with `{ owner, repo, limit: 25 }`.
2. Render as a compact list: `#N  title  (created at)`.

### "Close all the stale duplicates"

1. Call `gluecron_repo_list_issues`.
2. Identify candidate duplicates by title-similarity (you have the titles
   in the list response — do NOT need a separate AI call).
3. For each candidate, post a comment via `gluecron_comment_issue`
   explaining which issue it duplicates, THEN call `gluecron_close_issue`.
4. NEVER close more than 5 issues in one batch without re-confirming with
   the user.

## Example user prompts

- "File an issue describing the off-by-one in pagination."
- "Comment 'I'm investigating' on issue 42."
- "Close issue 42."
- "Reopen 17."
- "List open issues."

## Don'ts

- Do NOT close issues without a comment explaining why, unless the user
  explicitly said "close without comment".
- Do NOT bulk-close more than 5 issues in one tool sequence without a
  fresh user confirmation.
- If a tool returns `-32601 method_not_found`, the caller lacks read
  access. Tell the user; do not retry.
- If a tool returns `-32602 invalid_params` mentioning authentication,
  the MCP server is not authenticated. Tell the user to re-run
  `curl -sSL https://gluecron.com/install | bash`.
