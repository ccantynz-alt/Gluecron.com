/**
 * /help — public quickstart + API cheatsheet for owners migrating their
 * products onto gluecron. Covers the first five minutes (register, clone,
 * push), integration surfaces (SSH, import, webhooks, tokens), and the
 * AI-native extras (gates + AI review). Linked from the landing page nav.
 *
 * Uses softAuth so the nav bar renders with the signed-in user's session
 * cookie when present; the page itself is reachable without auth.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const help = new Hono<AuthEnv>();
help.use("*", softAuth);

help.get("/help", (c) => {
  const user = c.get("user");

  return c.html(
    <Layout title="Help — gluecron" user={user}>
      <div style="max-width: 860px; margin: 0 auto; padding: 24px 16px">
        <h1 style="margin: 0 0 8px; font-size: 28px">Help & quickstart</h1>
        <p style="color: var(--text-muted); margin-bottom: 24px">
          Everything an owner migrating a product onto gluecron needs in one
          page. If something's unclear, open an issue — link at the bottom.
        </p>

        <nav
          class="panel"
          style="margin-bottom: 32px; padding: 12px 16px; font-size: 13px"
        >
          <strong
            style="display: block; margin-bottom: 6px; font-size: 12px; text-transform: uppercase; color: var(--text-muted)"
          >
            On this page
          </strong>
          <a href="#getting-started">Getting started</a> &middot;{" "}
          <a href="#git-https">Git over HTTPS</a> &middot;{" "}
          <a href="#git-ssh">Git over SSH</a> &middot;{" "}
          <a href="#import">Importing from GitHub</a> &middot;{" "}
          <a href="#webhooks">Webhooks</a> &middot;{" "}
          <a href="#tokens">Personal access tokens</a> &middot;{" "}
          <a href="#gates">Gates & AI review</a> &middot;{" "}
          <a href="#ai-native">AI-native flow</a> &middot;{" "}
          <a href="#shortcuts">Keyboard shortcuts</a> &middot;{" "}
          <a href="#api">API</a>
        </nav>

        <section id="getting-started" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">Getting started</h2>
          <div class="panel">
            <div class="panel-item">
              <div>
                <strong>1. Register an account.</strong>{" "}
                Head to <a href="/register">/register</a>, pick a username, and
                set a password. Usernames are your public handle and appear in
                every repo URL.
              </div>
            </div>
            <div class="panel-item">
              <div>
                <strong>2. Verify your email.</strong>{" "}
                We send a one-time link the first time you sign in. Verified
                addresses can receive issue, PR, and gate-run notifications.
              </div>
            </div>
            <div class="panel-item">
              <div>
                <strong>3. Create your first repo.</strong>{" "}
                From the dashboard hit <strong>New repository</strong>, or
                visit <a href="/new">/new</a>. Pick public or private, add a
                README, and you're ready to clone.
              </div>
            </div>
          </div>
        </section>

        <section id="git-https" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">Git over HTTPS</h2>
          <p style="color: var(--text-muted); margin-bottom: 12px">
            HTTPS works out of the box. Authenticate with your account
            password or, better, a personal access token.
          </p>
          <div class="panel">
            <div class="panel-item">
              <div style="width: 100%">
                <strong>Clone</strong>
                <pre
                  style="margin: 6px 0 0; padding: 10px; background: var(--bg-muted, #0d1117); border-radius: 4px; font-size: 12px; overflow-x: auto"
                >
{`git clone https://<your-host>/<owner>/<repo>.git`}
                </pre>
              </div>
            </div>
            <div class="panel-item">
              <div style="width: 100%">
                <strong>Push</strong>
                <pre
                  style="margin: 6px 0 0; padding: 10px; background: var(--bg-muted, #0d1117); border-radius: 4px; font-size: 12px; overflow-x: auto"
                >
{`git push origin main`}
                </pre>
              </div>
            </div>
            <div class="panel-item">
              <div style="width: 100%">
                <strong>Pull</strong>
                <pre
                  style="margin: 6px 0 0; padding: 10px; background: var(--bg-muted, #0d1117); border-radius: 4px; font-size: 12px; overflow-x: auto"
                >
{`git pull origin main`}
                </pre>
              </div>
            </div>
          </div>
        </section>

        <section id="git-ssh" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">Git over SSH</h2>
          <p style="color: var(--text-muted); margin-bottom: 12px">
            SSH avoids typing credentials and is recommended for day-to-day
            work.
          </p>
          <div class="panel">
            <div class="panel-item">
              <div>
                <strong>1. Add your key.</strong>{" "}
                Copy your public key (usually{" "}
                <code>~/.ssh/id_ed25519.pub</code>) and paste it into{" "}
                <a href="/settings/keys">/settings/keys</a>. Keys take effect
                immediately.
              </div>
            </div>
            <div class="panel-item">
              <div style="width: 100%">
                <strong>2. Clone using the SSH URL.</strong>
                <pre
                  style="margin: 6px 0 0; padding: 10px; background: var(--bg-muted, #0d1117); border-radius: 4px; font-size: 12px; overflow-x: auto"
                >
{`git clone git@<your-host>:<owner>/<repo>.git`}
                </pre>
              </div>
            </div>
            <div class="panel-item">
              <div>
                <strong>3. Rotate or revoke</strong> any key from the same
                settings page — useful when a laptop walks off.
              </div>
            </div>
          </div>
        </section>

        <section id="import" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">
            Importing from GitHub
          </h2>
          <div class="panel">
            <div class="panel-item">
              <div>
                Visit <a href="/import">/import</a>, paste the source URL, and
                gluecron will mirror the repository — full history, branches,
                and tags. The mirror is a one-time copy; subsequent pushes
                land on gluecron, not the source. Private sources need a PAT
                on the source side.
              </div>
            </div>
          </div>
        </section>

        <section id="webhooks" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">Webhooks</h2>
          <p style="color: var(--text-muted); margin-bottom: 12px">
            Per-repo webhooks live at{" "}
            <code>/:owner/:repo/settings/webhooks</code>. Register a URL, pick
            events (push, issue, pr, star), and set a secret.
          </p>
          <div class="panel">
            <div class="panel-item">
              <div>
                <strong>HMAC signature.</strong>{" "}
                Every delivery includes{" "}
                <code>X-Gluecron-Signature: sha256=&lt;hex&gt;</code>.{" "}
                Compute HMAC-SHA256 over the raw request body using your
                secret and compare in constant time.
              </div>
            </div>
            <div class="panel-item">
              <div style="width: 100%">
                <strong>Payload shape.</strong>
                <pre
                  style="margin: 6px 0 0; padding: 10px; background: var(--bg-muted, #0d1117); border-radius: 4px; font-size: 12px; overflow-x: auto"
                >
{`{
  "event": "push",
  "repo": { "owner": "acme", "name": "api" },
  "ref": "refs/heads/main",
  "before": "<sha>",
  "after": "<sha>",
  "commits": [ /* ... */ ],
  "sender": { "username": "kit" }
}`}
                </pre>
              </div>
            </div>
            <div class="panel-item">
              <div>
                Deliveries are retried with exponential backoff; inspect the
                last N attempts from the webhook's settings page.
              </div>
            </div>
          </div>
        </section>

        <section id="tokens" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">
            Personal access tokens
          </h2>
          <p style="color: var(--text-muted); margin-bottom: 12px">
            Tokens authenticate CLI clients, CI jobs, and scripts. Create
            them at <a href="/settings/tokens">/settings/tokens</a>; the value
            is shown once, so copy it immediately. Tokens start with{" "}
            <code>glc_</code>.
          </p>
          <div class="panel">
            <div class="panel-item">
              <div style="width: 100%">
                <strong>Example: list your repos via the API.</strong>
                <pre
                  style="margin: 6px 0 0; padding: 10px; background: var(--bg-muted, #0d1117); border-radius: 4px; font-size: 12px; overflow-x: auto"
                >
{`curl -H "Authorization: Bearer glc_your_token_here" \\
  https://<your-host>/api/v2/repos`}
                </pre>
              </div>
            </div>
            <div class="panel-item">
              <div>
                Tokens can also authenticate <code>git</code> over HTTPS — use
                the token as the password in place of your account password.
              </div>
            </div>
          </div>
        </section>

        <section id="gates" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">
            Gates & AI review
          </h2>
          <div class="panel">
            <div class="panel-item">
              <div>
                Every push to the default branch (usually <code>main</code>)
                triggers a gate run: GateTest scans the diff for secrets,
                dependency advisories, and policy violations, while the AI
                reviewer reads the patch and comments on any PRs that touch
                the same files. Failing gates block the push by default;
                results appear on the commit page and in the repo's{" "}
                <em>Gate runs</em> tab. Configure gate policy per-repo in
                <strong> Settings → Gates</strong>.
              </div>
            </div>
          </div>
        </section>

        <section id="ai-native" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">
            AI-native flow
          </h2>
          <div class="panel">
            <div class="panel-item">
              <div>
                <strong>Issue → PR in one click.</strong> Open any issue you
                own and hit <em>Build with AI</em> in the header. The spec
                form pre-fills with the issue title + body and a{" "}
                <code>Closes #N</code> footer; Claude drafts the diff, opens
                a draft PR, and the merge auto-closes the originating issue.
              </div>
            </div>
            <div class="panel-item">
              <div>
                <strong>AI-drafted PR descriptions.</strong> The new-PR form
                has a <em>Suggest description with AI</em> button that runs
                <code> generatePrSummary</code> against{" "}
                <code>git diff base...head</code> and fills the description
                with a structured summary (Why · Key changes · Test plan ·
                Risks).
              </div>
            </div>
            <div class="panel-item">
              <div>
                <strong>Auto-review on PR open.</strong> Non-draft PRs get a
                summary comment plus inline file/line annotations from the
                AI reviewer. A second comment posts label + reviewer +
                priority suggestions (the <em>AI Triage</em> block). All
                suggestions; nothing applied automatically.
              </div>
            </div>
            <div class="panel-item">
              <div>
                <strong>Repo-wide AI surfaces.</strong>{" "}
                <a href="/help#explore">Explain</a> a codebase, run{" "}
                <a href="/help#explore">semantic search</a>, ask the chat
                anything about the repo, generate failing test stubs from a
                source file (the <em>Tests</em> link in the repo nav), and
                draft full PRs from a plain-English spec via{" "}
                <em>Spec to PR</em>. All require{" "}
                <code>ANTHROPIC_API_KEY</code>; without it the surfaces
                degrade gracefully to deterministic fallbacks.
              </div>
            </div>
            <div class="panel-item">
              <div>
                <strong>Scheduled workflows.</strong> Drop{" "}
                <code>on: schedule: [{`{cron: "0 * * * *"}`}]</code> into any
                <code> .gluecron/workflows/*.yml</code>. The autopilot
                ticker fires the cron from the same node that handles your
                pushes — no external scheduler needed.
              </div>
            </div>
          </div>
        </section>

        <section id="shortcuts" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">
            Keyboard shortcuts
          </h2>
          <div class="panel">
            <div class="panel-item">
              <div>
                gluecron ships a full keyboard-first mode — see{" "}
                <a href="/shortcuts">/shortcuts</a> for the complete cheat
                sheet. Press <code>?</code> on any page to pop the overlay.
              </div>
            </div>
          </div>
        </section>

        <section id="api" style="margin-bottom: 32px">
          <h2 style="margin-bottom: 12px; font-size: 20px">API</h2>
          <div class="panel">
            <div class="panel-item">
              <div>
                Full REST + GraphQL reference lives at{" "}
                <a href="/api/docs">/api/docs</a>. The GraphQL explorer is at{" "}
                <a href="/api/graphql">/api/graphql</a>.
              </div>
            </div>
          </div>
        </section>

        <p
          style="color: var(--text-muted); font-size: 13px; margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border)"
        >
          Something missing? Open an issue on gluecron's source repo.
        </p>
      </div>
    </Layout>
  );
});

export default help;
