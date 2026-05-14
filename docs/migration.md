# Migration guide

This document covers the rough edges that come up when moving an existing
repo onto Gluecron. The git history side is easy — `git clone --bare` does
the work. The tricky bits live around things GitHub _doesn't_ expose
through its API.

## Migrating GitHub Actions secrets

GitHub's API exposes the **names** of a repo's Actions secrets but never
the **values** — even an authenticated repo owner cannot read them back
through the API. (This is deliberate on GitHub's part. The same constraint
applies to `gh secret list` and any third-party tool.) So when you move a
repo from GitHub to Gluecron, you have to re-paste each secret value
once. We make this as painless as we can.

**The flow:**

1. Import your repo at [`/import`](/import) (Option 2 — single-repo URL).
   Paste your repository URL **and** a GitHub personal access token with
   the `repo` scope. The token is used to:
   - clone private repositories (existing behaviour);
   - list the secret **names** on the GitHub repo (new in Block T1) so we
     can pre-create empty placeholder rows in Gluecron's encrypted
     `workflow_secrets` table.
2. After the import completes, if any secrets were found you'll be
   redirected to the secrets-checklist page at
   `/:owner/:repo/import/secrets`. Each row shows the secret name and a
   status pill — "Empty" (yellow) for placeholders we just created and
   "Pasted" (green) for ones you've already filled in.
3. For each secret, paste the value into the password input and click
   **Save**. The value is encrypted with AES-256-GCM under the per-host
   `WORKFLOW_SECRETS_KEY` and stored in the existing `workflow_secrets`
   table — exactly the same code path as the regular secrets-settings
   UI. We never log plaintext values anywhere.
4. When you're done — or partway through if you need to find more values
   later — click **Done — take me to my repo**. You can optionally tick
   the "Also delete the N empty placeholders on my way out" box to clean
   up any rows you haven't filled. Either way you can come back and edit
   any time via `/:owner/:repo/settings/secrets`.
5. Reference your secrets in `.gluecron/workflows/*.yml` as
   `${{ secrets.NAME }}` — the same syntax as GitHub Actions. The
   workflow runner does the substitution at step-execution time; tokens
   pointing at missing names are left intact in the run log as a loud
   "this secret is unset" failure signal.

### Where do I find each value?

GitHub doesn't let you read it back. Look in:

- the password manager (1Password, Bitwarden, etc.) you used when you
  first added the secret to GitHub
- the `.env` / `.env.production` file in your local checkout
- the original provisioning script that minted the credential
- the upstream service's dashboard (Stripe, AWS, etc.) — most providers
  let you regenerate the credential, which is a good security hygiene
  step anyway

### Skipping the checklist

The checklist step is **opt-in via the token field**. If you import a
repo without supplying a GitHub PAT (or supply one that lacks the
`repo` scope) we silently skip the secrets step and drop you on the
imported repo's main page. Adding the secrets later by hand at
`/:owner/:repo/settings/secrets` works exactly the same way.

### What gets logged

Just the secret **name** (e.g. `STRIPE_API_KEY`) and a hash of the
audit-log row — never the value, never any byte of the encrypted blob.
The audit-log actions are `workflow.secret.import_pasted` (per-secret
save) and `workflow.secret.import_cleanup` (cleanup of remaining empty
placeholders on Done).
