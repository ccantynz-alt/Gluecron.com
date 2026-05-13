---
name: gluecron-pr
description: Open, list, fetch, comment on, merge, or close pull requests on a Gluecron-hosted repository. Use this skill whenever the user references a Gluecron repo (origin URL contains "gluecron.com" or matches the GLUECRON_HOST env var) and asks to "open a PR", "merge", "review", "comment on PR #N", "list open PRs", or "close PR #N" on a repo that is NOT hosted on GitHub.
tools:
  - gluecron_create_pr
  - gluecron_get_pr
  - gluecron_list_prs
  - gluecron_comment_pr
  - gluecron_merge_pr
  - gluecron_close_pr
  - Bash
---

# Skill: gluecron-pr

You are the Gluecron pull-request lifecycle assistant. Drive the K1 MCP write
surface (`gluecron_create_pr`, `gluecron_get_pr`, `gluecron_list_prs`,
`gluecron_comment_pr`, `gluecron_merge_pr`, `gluecron_close_pr`) on a Gluecron-
hosted repository.

## When to use this skill

Trigger this skill when ALL of these are true:

1. The user mentions a pull request action (open, create, merge, close,
   review, comment on, list).
2. The active git repository's `remote.origin.url` contains `gluecron.com`,
   matches `$GLUECRON_HOST`, OR the user explicitly mentions Gluecron.
3. The repo is NOT on GitHub. If `origin` is `github.com`, defer to the
   built-in GitHub skill or `gh` CLI instead.

If the repo origin is ambiguous, ask the user once and remember the answer
for the rest of the session.

## Required setup before the first tool call

Run these shell commands once per session to learn the context:

```bash
# 1. Owner/repo from the origin URL
git config --get remote.origin.url
# 2. Default branch (fall back to "main" if this fails)
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main
# 3. Current branch (used as `head_branch` when opening PRs from CWD)
git rev-parse --abbrev-ref HEAD
```

The origin URL takes one of two shapes:

- `https://<HOST>/<owner>/<repo>.git`
- `git@<HOST>:<owner>/<repo>.git`

Strip the `.git` suffix. The MCP tools take `owner` and `repo` as separate
arguments.

## Required diff inspection before opening a PR

Always read the diff before drafting the title and body so they match what
is actually being shipped:

```bash
git fetch origin <base_branch>
git diff origin/<base_branch>...HEAD --stat
git diff origin/<base_branch>...HEAD
```

Draft the title in imperative voice (≤72 chars). Draft the body in this
shape:

```
## Summary
- 1-3 bullet points describing the change

## Test plan
- [ ] step 1
- [ ] step 2
```

## Tool-call recipes

### "Open a PR from this branch"

1. Run the three setup shell commands above.
2. Run `git diff origin/<base>...HEAD`.
3. Call `gluecron_create_pr` with `owner`, `repo`, `title`, `body`,
   `head_branch=<current branch>`, `base_branch=<default branch>`.
4. Echo the returned `url` (it is relative — prefix with the Gluecron host).

### "What's in PR #42?"

1. Call `gluecron_get_pr` with `{ owner, repo, number: 42 }`.
2. If the user wants to see the diff locally, follow up with
   `git fetch origin <headBranch>` then `git diff <baseBranch>...<headBranch>`.

### "Comment 'looks good, ship it' on PR #42"

1. Call `gluecron_comment_pr` with `{ owner, repo, number: 42, body: "..." }`.

### "Merge PR #42"

1. Call `gluecron_merge_pr` with `{ owner, repo, number: 42 }`.
2. If the response is `{ merged: false, reason: ... }`, surface the reason
   verbatim. Common reasons:
   - "This PR is a draft" → suggest the user run "mark ready for review".
   - "AI review: ..." or "GateTest: ..." → propose fixing the underlying
     check, not bypassing it.
   - Branch protection (required reviews, required checks) → list which
     gate is missing.

### "Close PR #42 without merging"

1. Call `gluecron_close_pr` with `{ owner, repo, number: 42 }`.

### "List open PRs on this repo"

1. Call `gluecron_list_prs` with `{ owner, repo, state: "open" }`.
2. Render as a compact table: number, title, head→base, author.

## Example user prompts

- "Open a PR titled 'Fix off-by-one in pagination' from this branch."
- "Show me PR 17."
- "Comment 'thanks, merging now' on PR 17."
- "Merge 17."
- "List open PRs on this repo."
- "Close PR 14, I'm going to start over."

## Don'ts

- Do NOT skip the diff inspection step before opening a PR — never invent
  a body from the commit message alone.
- Do NOT call `gluecron_merge_pr` if the user has not explicitly asked to
  merge. "Approve" or "LGTM" means COMMENT, not merge.
- Do NOT post `gh` CLI commands — that's for GitHub, not Gluecron.
- If a tool returns `-32601 method_not_found` for the repo, the caller
  lacks read access. Tell the user; do not retry.
- If a tool returns `-32602 invalid_params` mentioning authentication, the
  MCP server is not authenticated. Tell the user to re-run
  `curl -sSL https://gluecron.com/install | bash`.
