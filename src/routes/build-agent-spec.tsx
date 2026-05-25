/**
 * /docs/build-agent-integration — public spec page for AI build agents
 * integrating with Gluecron (Holden Mercer, Cursor, Claude Code, etc.).
 *
 * Renders a solid-white copyable spec block (high contrast against the
 * dark theme) telling the integrating vendor exactly what to change on
 * their side: detect Gluecron, swap base URL, swap auth token prefix,
 * call our REST v2 endpoints. Mirrors GitHub REST v3 by design so most
 * existing code reuses with a base-URL swap.
 *
 * Scoped CSS under `.ba-spec-*`. Public — no auth required.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const buildAgentSpec = new Hono<AuthEnv>();
buildAgentSpec.use("*", softAuth);

const styles = `
  .ba-spec-wrap { max-width: 980px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .ba-spec-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .ba-spec-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .ba-spec-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .ba-spec-hero-inner { position: relative; z-index: 1; max-width: 760px; }
  .ba-spec-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .ba-spec-eyebrow .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .ba-spec-title {
    font-size: clamp(28px, 4vw, 44px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .ba-spec-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .ba-spec-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 680px;
  }

  /* Solid white spec block — high contrast against dark theme. */
  .ba-spec-block {
    margin-bottom: var(--space-5);
    background: #ffffff;
    color: #0a0a0a;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.18);
  }
  .ba-spec-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .ba-spec-title-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display, system-ui, sans-serif);
    font-size: 14px;
    font-weight: 700;
    color: #111827;
    letter-spacing: -0.005em;
    margin: 0;
  }
  .ba-spec-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .ba-spec-copy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12.5px;
    font-weight: 600;
    color: #111827;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .ba-spec-copy:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
  .ba-spec-copy.is-copied {
    background: #ecfdf5;
    border-color: #6ee7b7;
    color: #047857;
  }
  .ba-spec-copy svg { display: block; }
  .ba-spec-pre {
    margin: 0;
    padding: 22px 24px;
    font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
    font-size: 12.5px;
    line-height: 1.7;
    color: #0a0a0a;
    background: #ffffff;
    white-space: pre;
    overflow-x: auto;
    tab-size: 2;
    max-height: 70vh;
    overflow-y: auto;
  }
  .ba-spec-foot {
    padding: 10px 16px;
    border-top: 1px solid #e5e7eb;
    background: #f9fafb;
    font-size: 12px;
    color: #6b7280;
  }
  .ba-spec-foot code {
    background: #eef2ff;
    color: #4338ca;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11.5px;
  }

  .ba-spec-callout {
    margin-top: var(--space-5);
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .ba-spec-callout a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .ba-spec-callout a:hover { text-decoration: underline; }
`;

const SPEC_TEXT = `═══════════════════════════════════════════════════════════════════════════════
HOLDEN MERCER × GLUECRON INTEGRATION SPEC
What HM needs to change on its side to support Gluecron-hosted repos
Gluecron API v1.1 — all endpoints below are LIVE (rolled out 2026-05-20)
═══════════════════════════════════════════════════════════════════════════════

TL;DR
─────────────────────────────────────────────────────────────────────────────
Your earlier read of Gluecron's API was based on v1, which lacked
/contents, /git/*, and /actions/workflows/:filename/dispatches. Those
gaps are now closed. Shapes match GitHub REST v3 exactly — a base-URL
swap reuses most of your existing GitHub integration. The "clone +
push" workaround you architected still works (path A below); the
native dispatch flow (path B) is now also available if you want it.

Required changes on HM's side
─────────────────────────────────────────────────────────────────────────────

1. ADD GLUECRON AS A DESTINATION
   Surface Gluecron alongside GitHub in your repo picker. Detect with:

     hostname === "gluecron.com"
       || process.env.GLUECRON_HOST    // self-hosted instances

2. SWAP THE BASE URL
   GitHub:    https://api.github.com
   Gluecron:  https://gluecron.com/api/v2
              (or https://<GLUECRON_HOST>/api/v2 for self-hosted)

3. SWAP THE AUTH TOKEN PREFIX — header name stays
   GitHub:    Authorization: Bearer ghp_…
   Gluecron:  Authorization: Bearer glc_…        (PAT, scope=repo)
              Or OAuth:      Bearer glct_…       (admin scope NOT issuable)
              Or App install:Bearer ghi_…

4. CHANGE NOTHING ELSE IN YOUR REQUEST/RESPONSE PARSING
   - Same field names (snake_case)
   - Same status codes
   - Same base64 content encoding
   - Same git-objects API surface

Endpoints HM will call
─────────────────────────────────────────────────────────────────────────────

READ FILES
  GET    /api/v2/repos/:owner/:repo/contents/:path?ref=<branch_or_sha>
         → { type, name, path, size, sha, encoding:"base64", content,
             html_url, download_url }

ATOMIC MULTI-FILE WRITE (preferred for agent turns)
  POST   /api/v2/repos/:owner/:repo/git/blobs
         body: { content, encoding: "utf-8" | "base64" }
         → { sha, url, size }

  POST   /api/v2/repos/:owner/:repo/git/trees
         body: { base_tree?, tree: [{ path, mode:"100644",
                                       type:"blob", sha|null }] }
         → { sha, url, tree[] }
         (sha:null in a tree entry = delete that path from base_tree)

  POST   /api/v2/repos/:owner/:repo/git/commits
         body: { message, tree, parents: [<head_sha>] }
         → { sha, tree, message, parents, author, html_url }

  GET    /api/v2/repos/:owner/:repo/git/refs/heads/:branch
         → { ref, object: { sha, type:"commit" } }

  PATCH  /api/v2/repos/:owner/:repo/git/refs/heads/:branch
         body: { sha: <new_commit>, force?: false }
         → { ref, object }   (422 if not fast-forward and force=false)

OPEN A PULL REQUEST
  POST   /api/v2/repos/:owner/:repo/pulls
         body: { title, body, base, head }
         → { id, number, title, state, html_url, ... }

DISPATCH A NATIVE BUILD ON GLUECRON ACTIONS  (optional — path B)
  POST   /api/v2/repos/:owner/:repo/actions/workflows/:filename/dispatches
         body: { ref:"main", inputs?: { prompt, model, … } }
         → 204 No Content

  GET    /api/v2/repos/:owner/:repo/actions/workflows/:filename/runs
         ?branch=&head_sha=&per_page=30&page=1
         → { total_count, workflow_runs:[...] }

  GET    /api/v2/repos/:owner/:repo/actions/runs/:run_id
         → { id, name, head_branch, head_sha, status, conclusion,
             event, created_at, updated_at, run_started_at, html_url }

  GET    /api/v2/repos/:owner/:repo/actions/runs/:run_id/logs
         → application/zip (one .log file per job)

  POST   /api/v2/repos/:owner/:repo/actions/runs/:run_id/cancel
         → 202 Accepted   (409 if already terminal)

User-side workflow file  (one-time setup per repo, for path B)
─────────────────────────────────────────────────────────────────────────────

If HM dispatches via path B, the user's repo needs a YAML committed to
.gluecron/workflows/holden-mercer.yml. Recommend this template:

  name: Holden Mercer build agent
  on:
    workflow_dispatch:
      inputs:
        prompt:
          description: What the agent should build / fix
          required: true
          type: string
        model:
          description: Anthropic model to use
          required: false
          default: claude-haiku-4-5
          type: string
  jobs:
    agent:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - name: Run HM agent
          env:
            ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
            HM_PROMPT:         \${{ inputs.prompt }}
            HM_MODEL:          \${{ inputs.model }}
          run: npx @holden-mercer/agent run

Two integration paths — pick one (or offer both in HM's UI)
─────────────────────────────────────────────────────────────────────────────

PATH A — Your-backend mode  (matches your original v1 workaround)
   1. Clone the repo using a credential helper (NOT URL-embedded token):
      git -c credential.helper=… clone https://gluecron.com/:owner/:repo.git
   2. Run the tool-use loop on HM's backend against local files
   3. Push the result via the git-objects API (one atomic commit):
      POST /git/blobs → /git/trees → /git/commits → PATCH /git/refs/heads
   4. POST /pulls to open the PR
   Pros: full control, you own compute. Cons: you bear all build minutes.

PATH B — Gluecron-native mode  (uses our runner)
   1. POST /actions/workflows/holden-mercer.yml/dispatches with inputs
   2. Your agent code runs inside Gluecron Actions on the user's repo
   3. The runner pushes commits + opens the PR itself
   Pros: zero infra on your side, lower egress. Cons: Gluecron concurrency
   + timeout limits apply per tier.

Both paths supported. Most vendors ship A first, add B later as an opt-in.

Webhook callback  (optional but recommended)
─────────────────────────────────────────────────────────────────────────────
Subscribe to pull_request + workflow_run events at
  /:owner/:repo/settings/webhooks
HMAC signature header:  X-Gluecron-Signature: sha256=<hex>
Delivery:               at-least-once with exponential backoff
                        (30s, 2m, 10m, 1h, 6h — max 6 attempts then
                        dead-letter)
Dedupe with:            X-Gluecron-Delivery: <uuid>

Compatibility checklist  (matches GitHub REST v3 by design)
─────────────────────────────────────────────────────────────────────────────
[x] Same endpoint shapes
[x] Same field names (snake_case)
[x] Same base64 content encoding
[x] Same status codes
[x] Same git plumbing API (blobs / trees / commits / refs)
[x] Same workflow_dispatch shape
[x] HMAC-SHA256 webhook signatures
[x] PKCE OAuth (RFC 7636)
[x] Pagination via ?limit, ?offset (default 30, max 100)

Differences to flag in HM's client code
─────────────────────────────────────────────────────────────────────────────
- Token prefix:    glc_ (PAT) / glct_ (OAuth) / ghi_ (app install)
- Pagination:      ?limit not ?per_page  (recommend limit)
- OAuth scopes:    namespaced — read:repo / write:repo  (admin NOT issuable)
- Webhook header:  X-Gluecron-Signature  not  X-Hub-Signature-256

Estimated work on HM's side
─────────────────────────────────────────────────────────────────────────────
- UI change (add Gluecron destination)          ~2-4 hrs
- API client base-URL/token swap                ~2-3 hrs
- Webhook handler for X-Gluecron-Signature      ~1 hr
- Path B dispatch integration  (optional)       ~4-6 hrs
TOTAL minimum (paths A only):  ~5-8 hrs
TOTAL with path B as well:     ~10-15 hrs

Support
─────────────────────────────────────────────────────────────────────────────
Live spec:   https://gluecron.com/docs/build-agent-integration  (this page)
Status:      https://gluecron.com/admin/health
Issues:      https://gluecron.com/ccantynz/Gluecron.com/issues
Contact:     ccantynz on gluecron.com
═══════════════════════════════════════════════════════════════════════════════`;

const MCP_TOOLS_TEXT = `═══════════════════════════════════════════════════════════════════════════════
GLUECRON MCP TOOL SURFACE  (50+ tools, model-context-protocol/2025-06-18)
═══════════════════════════════════════════════════════════════════════════════

Transport:  POST /mcp           — JSON-RPC 2.0 (single or batch)
            GET  /mcp           — discovery handshake
Auth:       same as REST v2     — Bearer glc_… (PAT) or session cookie
            agent tokens (agt_…) routed via agent-multiplayer

Call shape:
  {
    "jsonrpc": "2.0", "id": 1,
    "method": "tools/call",
    "params": { "name": "<tool_name>", "arguments": { … } }
  }

─── READ TOOLS (public, no auth) ────────────────────────────────────────────
gluecron_repo_search                Search public repos by keyword
gluecron_repo_read_file             Read a file at a ref
gluecron_repo_list_issues           List open issues on a repo
gluecron_repo_explain_codebase      Cached AI 'explain this codebase' markdown
gluecron_repo_health                Health score + breakdown for a repo

─── REPOS (write — requires 'repo' or 'admin') ──────────────────────────────
gluecron_fork_repo                  Fork a repo to the caller's namespace
gluecron_delete_repo                Permanently delete a repo (admin)
gluecron_update_repo                Description / visibility / default branch
gluecron_search_repos               Full search (sort, limit, filters)
gluecron_clone_url                  Authed HTTPS clone URL + helper hint

─── ISSUES (write — requires 'repo') ────────────────────────────────────────
gluecron_create_issue               Open a new issue
gluecron_comment_issue              Add a comment
gluecron_close_issue                Close an open issue (idempotent)
gluecron_reopen_issue               Reopen a closed issue
gluecron_label_issue                Attach labels (auto-creates missing)
gluecron_unlabel_issue              Detach a single label
gluecron_assign_issue               Assign to a user (via assignee:* label)
gluecron_search_issues              Title/body keyword search per repo

─── PULL REQUESTS (write — requires 'repo') ─────────────────────────────────
gluecron_create_pr                  Open a PR
gluecron_open_draft_pr              Open a draft PR
gluecron_get_pr                     Fetch full PR record
gluecron_list_prs                   List PRs by state
gluecron_search_prs                 Keyword search on title/body
gluecron_comment_pr                 Add a PR comment
gluecron_request_changes            Post an AI-review 'changes requested' comment
gluecron_merge_pr                   Merge a PR (enforces every gate + risk score)
gluecron_close_pr                   Close without merging (idempotent)
gluecron_generate_pr_description    AI commit-message-style description

─── FILES & GIT PLUMBING (write — requires 'repo') ──────────────────────────
gluecron_read_file                  GET /contents wrapper
gluecron_write_file                 PUT /contents wrapper (utf8 or base64)
gluecron_delete_file                DELETE /contents wrapper
gluecron_list_tree                  GET /tree wrapper (recursive supported)
gluecron_get_commit                 GET /commits/:sha wrapper
gluecron_create_branch              Create a new branch ref at a sha
gluecron_atomic_multi_file_commit   blob/tree/commit/ref-update in one call
                                    — the killer agent tool

─── AI WORKFLOWS (Gluecron-native — requires 'repo') ────────────────────────
gluecron_ship_spec                  Drop .gluecron/specs/*.md status:ready
gluecron_voice_to_pr                Transcript → spec or issue (auto-classified)
gluecron_refactor_across_repos      Plan + execute a multi-repo refactor
gluecron_explain_repo               Cached 'explain this repo' markdown
gluecron_chat_with_repo             Start a chat + send the first message
gluecron_chat_continue              Send another message in a chat
gluecron_generate_tests             AI tests for a PR (follow-up-pr / append)
gluecron_generate_commit_message    Conventional / plain commit message for a diff
gluecron_generate_release_notes     Section-bucketed notes between two tags
gluecron_propose_migration          Dep-upgrade PR via migration-assistant
gluecron_propose_doc_update         Doc-drift scan + PR opens

─── CI / DEPLOYS (write — requires 'repo') ──────────────────────────────────
gluecron_trigger_workflow           workflow_dispatch
gluecron_get_workflow_run           Run status + metadata
gluecron_get_workflow_logs          Per-job log payload (JSON; ZIP via REST)
gluecron_cancel_workflow_run        Cancel queued/running run
gluecron_get_preview_url            Branch-preview URL + status
gluecron_provision_pr_sandbox       Re-provision a PR sandbox

─── AGENTS (multiplayer surface — admin to mint, repo to lease) ─────────────
gluecron_create_agent_session       Mint agent token (returned ONCE) (admin)
gluecron_acquire_lease              Grab an exclusive target lease
gluecron_release_lease              Release a held lease
gluecron_get_agent_budget           spent / cap / remaining cents

─── SEMANTIC ────────────────────────────────────────────────────────────────
gluecron_semantic_search            Vector-index query (Voyage or hash)
gluecron_find_symbol                findDefinitions wrapper

─── INSIGHTS ────────────────────────────────────────────────────────────────
gluecron_pr_status_summary          State + risk + trio verdict for a PR
gluecron_repo_health                (also under READ; included here for parity)
gluecron_ai_cost_summary            Spend rollup (user / repo / agent)

═══════════════════════════════════════════════════════════════════════════════`;

buildAgentSpec.get("/docs/build-agent-integration", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Build agent integration spec — Gluecron" user={user}>
      <div class="ba-spec-wrap">
        <section class="ba-spec-hero">
          <div class="ba-spec-hero-orb" aria-hidden="true" />
          <div class="ba-spec-hero-inner">
            <div class="ba-spec-eyebrow">
              <span class="pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
              </span>
              Integration spec · For AI build-agent vendors (Holden Mercer, Cursor, Claude Code)
            </div>
            <h1 class="ba-spec-title">
              <span class="ba-spec-title-grad">Wire your agent into Gluecron.</span>
            </h1>
            <p class="ba-spec-sub">
              Drop-in compatible with GitHub REST v3. One base-URL swap reuses your existing
              GitHub integration. Copy the block below and paste it to your engineering team —
              everything they need to ship is in there.
            </p>
          </div>
        </section>

        <section class="ba-spec-block" aria-labelledby="ba-spec-title">
          <header class="ba-spec-head">
            <div>
              <p class="ba-spec-title-bar" id="ba-spec-title">
                <span class="ba-spec-dot" aria-hidden="true" />
                HM × Gluecron integration spec
              </p>
            </div>
            <button
              type="button"
              class="ba-spec-copy"
              data-spec-copy
              aria-label="Copy spec to clipboard"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span data-spec-copy-label>Copy spec</span>
            </button>
          </header>
          <pre class="ba-spec-pre" data-spec-text>{SPEC_TEXT}</pre>
          <div class="ba-spec-foot">
            Share this page directly: <code>https://gluecron.com/docs/build-agent-integration</code>
          </div>
        </section>

        {/* ─── MCP tools surface ─────────────────────────────────────── */}
        <section class="ba-spec-block" aria-labelledby="ba-mcp-title">
          <header class="ba-spec-head">
            <div>
              <p class="ba-spec-title-bar" id="ba-mcp-title">
                <span class="ba-spec-dot" aria-hidden="true" />
                MCP tools — every Gluecron action callable from any AI agent
              </p>
            </div>
          </header>
          <pre class="ba-spec-pre">{MCP_TOOLS_TEXT}</pre>
          <div class="ba-spec-foot">
            JSON-RPC 2.0 endpoint: <code>POST https://gluecron.com/mcp</code> —
            send <code>{"{ method: \"tools/list\" }"}</code> to enumerate at runtime.
          </div>
        </section>

        <div class="ba-spec-callout">
          Looking for the full Gluecron platform spec? See{" "}
          <a href="/help">/help</a> and{" "}
          <a href="/admin/integrations">/admin/integrations</a> for env-var setup.
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function(){
              var btn = document.querySelector('[data-spec-copy]');
              var pre = document.querySelector('[data-spec-text]');
              var label = document.querySelector('[data-spec-copy-label]');
              if (!btn || !pre || !label) return;
              btn.addEventListener('click', function(){
                var text = pre.textContent || '';
                var done = function(){
                  btn.classList.add('is-copied');
                  label.textContent = 'Copied';
                  setTimeout(function(){
                    btn.classList.remove('is-copied');
                    label.textContent = 'Copy spec';
                  }, 1800);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(text).then(done).catch(function(){
                    var ta = document.createElement('textarea');
                    ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
                    document.body.appendChild(ta); ta.select();
                    try { document.execCommand('copy'); done(); } catch(e){}
                    document.body.removeChild(ta);
                  });
                } else {
                  var ta = document.createElement('textarea');
                  ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
                  document.body.appendChild(ta); ta.select();
                  try { document.execCommand('copy'); done(); } catch(e){}
                  document.body.removeChild(ta);
                }
              });
            })();
          `,
        }}
      />
    </Layout>
  );
});

export default buildAgentSpec;
