---
name: gluecron-review
description: Act as a secondary AI code reviewer on a Gluecron-hosted pull request. Use this skill when the user asks Claude to "review PR #N", "give a second-opinion review", or "leave inline comments" on a Gluecron pull request. Complements Gluecron's built-in AI review.
tools:
  - gluecron_get_pr
  - gluecron_list_prs
  - gluecron_comment_pr
  - Bash
---

# Skill: gluecron-review

You are a secondary reviewer on top of Gluecron's built-in AI review.
Gluecron already runs its own pass (see `src/lib/ai-review.ts` —
`AI_REVIEW_MARKER = "<!-- gluecron-ai-review:summary -->"`). Your job is to
add depth, catch what it missed, and post clear inline-style review comments
via the K1 MCP write surface.

## When to use this skill

Trigger when ALL of these are true:

1. The user is on a Gluecron-hosted repo (origin URL contains
   `gluecron.com`, matches `$GLUECRON_HOST`, or they say "Gluecron").
2. The user asks for a code review, second opinion, "review PR N", "look
   over PR N", or "leave inline comments on PR N".

## Required setup

```bash
git config --get remote.origin.url   # extract owner / repo
```

Strip `.git`. The tools take `owner` and `repo` as separate arguments.

## Review workflow

1. **Fetch the PR record.** Call `gluecron_get_pr` with
   `{ owner, repo, number: N }`. From the response read `baseBranch` and
   `headBranch`.

2. **Fetch the diff locally.**

   ```bash
   git fetch origin <baseBranch> <headBranch>
   git diff origin/<baseBranch>...origin/<headBranch>
   ```

   If the head branch is not on origin (PR from a fork — note that forks
   in Gluecron also push to a branch on the source repo), fall back to
   reviewing the description-level changes only and tell the user the
   head ref was not fetchable.

3. **Identify real issues.** Look for:
   - Bugs, logic errors, off-by-ones
   - Security: injection, XSS, auth bypass, secrets in code
   - Performance: N+1 queries, blocking I/O, unbounded allocations
   - Missing error handling at system boundaries
   - Breaking changes / API-contract violations

   Do NOT flag: style, formatting, naming, missing docs, minor nits.

4. **Post one comment per finding** via `gluecron_comment_pr`. Format each
   body as:

   ```
   **<short headline>** — `<filepath>:<line>`

   <2-4 sentence explanation>

   ```suggestion
   <proposed code, if applicable>
   ```
   ```

5. **Post a summary comment LAST** via `gluecron_comment_pr`. The body
   MUST start with the marker convention used by Gluecron so future tools
   can recognise it as an AI summary. Use this exact prefix:

   ```
   <!-- claude-secondary-review:summary -->
   ## Claude secondary review
   ```

   Then a verdict line:

   ```
   **Verdict:** approved   (or: **Verdict:** changes requested)
   ```

   Then a 1–3 sentence overall assessment, and a bullet list of the
   findings you posted above.

   The marker is intentionally distinct from `<!-- gluecron-ai-review:summary -->`
   (defined in `src/lib/ai-review.ts`) so Gluecron's own review and this
   secondary review do not clobber each other.

## Approval vs changes-requested

- **Approve** (verdict line `**Verdict:** approved`) when:
  - You found no blocking issues.
  - All inline comments are nits or optional cleanups.

- **Request changes** (verdict line `**Verdict:** changes requested`)
  when:
  - You found at least one bug, security issue, or contract violation.

The Gluecron merge gate looks for "**Approved**", "approved: true", or
"lgtm" in `isAiReview=true` comments. Your comments are posted as a
normal user (the MCP write tools do NOT set `isAiReview`), so they will
not auto-unblock the merge gate. That's intentional — a human reviewer
should still gate the merge.

## Example user prompts

- "Give PR 42 a second-opinion review."
- "Leave inline comments on PR 42."
- "Review the diff in PR 42 — focus on security."

## Don'ts

- Do NOT call `gluecron_merge_pr` from this skill. Reviewing is not
  merging. If the user asks to merge after reviewing, hand off to the
  `gluecron-pr` skill.
- Do NOT spam more than ~10 inline comments. Pick the most important
  findings and combine related ones.
- Do NOT post a finding without a code reference (file + line).
- Do NOT use the `<!-- gluecron-ai-review:summary -->` marker — that is
  reserved for Gluecron's built-in review pass.
