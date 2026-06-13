/**
 * Per-repo Automation settings — ONE page where a developer sees every
 * automation on the platform and flips each between off / suggest (manual)
 * / automatic, wherever those modes exist today.
 *
 *   GET  /:owner/:repo/settings/automation  — the control table
 *   POST /:owner/:repo/settings/automation  — save modes
 *
 * Admin-gated (same requireAuth + requireRepoAccess("admin") pattern as
 * src/routes/repo-settings.tsx).
 *
 * Storage:
 *   - The five mode-controlled automations (AI review, PR triage, issue
 *     triage, auto-merge, CI autofix) live in `repo_automation_settings`
 *     (migration 0106) via src/lib/automation-settings.ts.
 *   - AI test generation and the dependency updater keep their existing
 *     homes on the repositories row (`auto_generate_tests`,
 *     `dep_updater_enabled`) — this page is just a second door to the same
 *     columns, so the older toggles stay in sync.
 *
 * Env kill-switches stay supreme: a feature disabled at the environment
 * level is off regardless of what is selected here. The page says so.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { repositories } from "../db/schema";
import type { Repository } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import {
  getAutomationSettings,
  upsertAutomationSettings,
  normalizeMode,
  type AutomationMode,
  type AutomationSettings,
} from "../lib/automation-settings";

const automationSettings = new Hono<AuthEnv>();

automationSettings.use("*", softAuth);

// Scoped CSS — every class prefixed `.automation-` so styles cannot bleed.
// Mirrors the section-card system in repo-settings.tsx.
const automationStyles = `
  .automation-container { max-width: 1080px; margin: 0 auto; padding: 0 var(--space-3) var(--space-8); }
  .automation-hero {
    position: relative;
    margin: var(--space-5) 0;
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .automation-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .automation-hero-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .automation-hero-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .automation-hero-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 680px;
  }
  .automation-hero-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .automation-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 13.5px;
    margin-bottom: var(--space-4);
    line-height: 1.5;
  }
  .automation-banner-success {
    background: rgba(52,211,153,0.08);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .automation-banner-error {
    background: rgba(248,113,113,0.08);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);
  }
  .automation-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .automation-table { width: 100%; border-collapse: collapse; }
  .automation-table th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 12px var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .automation-table td {
    padding: 14px var(--space-5);
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .automation-table tr:last-child td { border-bottom: none; }
  .automation-feature-name {
    font-weight: 600;
    font-size: 13.5px;
    color: var(--text-strong);
    white-space: nowrap;
  }
  .automation-feature-desc {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 520px;
  }
  .automation-feature-desc code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .automation-select {
    background: var(--bg-tertiary);
    color: var(--text-strong);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 13px;
    min-width: 150px;
  }
  .automation-env-pill {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 9999px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    white-space: nowrap;
  }
  .automation-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--space-3);
  }
  .automation-foot-hint {
    margin-right: auto;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .automation-cta {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 18px;
    background: linear-gradient(135deg, #8c6dff, #6c63ff);
    color: #fff;
    border: none;
    border-radius: 9px;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .automation-cta:hover { filter: brightness(1.08); }
`;

/** One row of the control table — a three-way (or two-way) mode selector. */
function ModeSelect(props: {
  name: string;
  value: AutomationMode;
  modes: AutomationMode[];
  labels?: Partial<Record<AutomationMode, string>>;
}) {
  const defaultLabels: Record<AutomationMode, string> = {
    off: "Off",
    suggest: "Suggest (manual)",
    auto: "Automatic",
  };
  return (
    <select class="automation-select" name={props.name} aria-label={props.name}>
      {props.modes.map((m) => (
        <option value={m} selected={m === props.value}>
          {props.labels?.[m] ?? defaultLabels[m]}
        </option>
      ))}
    </select>
  );
}

automationSettings.get(
  "/:owner/:repo/settings/automation",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const repo = c.get("repository" as never) as Repository;
    const success = c.req.query("success");
    const error = c.req.query("error");

    const settings = await getAutomationSettings(repo.id);

    return c.html(
      <Layout title={`Automation — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <style dangerouslySetInnerHTML={{ __html: automationStyles }} />
        <div class="automation-container">
          <div class="automation-hero">
            <div class="automation-hero-eyebrow">Repository settings</div>
            <h1 class="automation-hero-title">Automation</h1>
            <p class="automation-hero-sub">
              Every automation on this repository in one place. <strong>Off</strong>{" "}
              disables a feature, <strong>Suggest</strong> posts advisory
              comments and leaves the action to you, <strong>Automatic</strong>{" "}
              lets Gluecron act on its own. Server-level kill-switches (e.g. a
              missing <code>ANTHROPIC_API_KEY</code>) always win — a feature
              disabled in the environment stays off no matter what you pick
              here.
            </p>
          </div>

          {success && (
            <div class="automation-banner automation-banner-success">
              {decodeURIComponent(success)}
            </div>
          )}
          {error && (
            <div class="automation-banner automation-banner-error">
              {decodeURIComponent(error)}
            </div>
          )}

          <form method="post" action={`/${ownerName}/${repoName}/settings/automation`}>
            <div class="automation-card">
              <table class="automation-table">
                <thead>
                  <tr>
                    <th>Automation</th>
                    <th>What it does</th>
                    <th>Mode</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td class="automation-feature-name">AI code review</td>
                    <td class="automation-feature-desc">
                      Claude reviews every non-draft PR diff on open and posts
                      a summary plus inline findings. Review comments are
                      always advisory.
                    </td>
                    <td>
                      <ModeSelect
                        name="ai_review_mode"
                        value={settings.aiReviewMode}
                        modes={["off", "suggest"]}
                        labels={{ suggest: "Suggest (on)" }}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="automation-feature-name">PR triage</td>
                    <td class="automation-feature-desc">
                      Suggests labels, reviewers, priority, and a risk area as
                      a comment when a PR opens. Nothing is applied for you.
                    </td>
                    <td>
                      <ModeSelect
                        name="pr_triage_mode"
                        value={settings.prTriageMode}
                        modes={["off", "suggest"]}
                        labels={{ suggest: "Suggest (on)" }}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="automation-feature-name">Issue triage</td>
                    <td class="automation-feature-desc">
                      Suggests labels, priority, and possible duplicates as a
                      comment when an issue is created.
                    </td>
                    <td>
                      <ModeSelect
                        name="issue_triage_mode"
                        value={settings.issueTriageMode}
                        modes={["off", "suggest"]}
                        labels={{ suggest: "Suggest (on)" }}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="automation-feature-name">Auto-merge</td>
                    <td class="automation-feature-desc">
                      Merges a PR once every branch-protection gate is green.
                      Still default-deny per branch — a rule with{" "}
                      <a href={`/${ownerName}/${repoName}/settings#branch-protection`}>
                        auto-merge enabled
                      </a>{" "}
                      must match the base branch. <em>Suggest</em> evaluates
                      and records the decision but leaves the Merge click to a
                      human.
                    </td>
                    <td>
                      <ModeSelect
                        name="auto_merge_mode"
                        value={settings.autoMergeMode}
                        modes={["off", "suggest", "auto"]}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="automation-feature-name">CI auto-fix</td>
                    <td class="automation-feature-desc">
                      When a gate run fails on a PR, posts a ready-to-apply
                      patch (repair-cache first, then Claude). <em>Suggest</em>{" "}
                      stops at the comment with an Apply Fix button;{" "}
                      <em>Automatic</em> also applies the patch onto a{" "}
                      <code>fix/</code> branch.
                    </td>
                    <td>
                      <ModeSelect
                        name="ci_autofix_mode"
                        value={settings.ciAutofixMode}
                        modes={["off", "suggest", "auto"]}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="automation-feature-name">AI test generation</td>
                    <td class="automation-feature-desc">
                      Writes tests for new code when a PR opens and commits
                      them onto the same branch. Acts on its own once enabled.
                    </td>
                    <td>
                      <ModeSelect
                        name="auto_generate_tests"
                        value={repo.autoGenerateTests ? "auto" : "off"}
                        modes={["off", "auto"]}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="automation-feature-name">Dependency updates</td>
                    <td class="automation-feature-desc">
                      Daily patch/minor dependency bumps; auto-merges when the
                      gate passes, opens a PR with an AI migration guide when
                      it fails. Also needs <code>DEP_UPDATER_ENABLED=1</code>{" "}
                      on the server.{" "}
                      <a href={`/${ownerName}/${repoName}/settings/dep-updater`}>
                        Run history →
                      </a>
                    </td>
                    <td>
                      <ModeSelect
                        name="dep_updater_enabled"
                        value={
                          (repo as { depUpdaterEnabled?: boolean })
                            .depUpdaterEnabled
                            ? "auto"
                            : "off"
                        }
                        modes={["off", "auto"]}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td class="automation-feature-name">AI loop (issue → PR → merge)</td>
                    <td class="automation-feature-desc">
                      The fully-autonomous build loop. Controlled by the
                      server-level <code>AI_LOOP_ENABLED=1</code> flag — there
                      is no per-repo dial for it today.
                    </td>
                    <td>
                      <span class="automation-env-pill">env-controlled</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div class="automation-foot">
                <span class="automation-foot-hint">
                  Defaults match prior behavior — saving without changes
                  changes nothing.
                </span>
                <button type="submit" class="automation-cta">
                  Save automation settings <span>→</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </Layout>
    );
  }
);

automationSettings.post(
  "/:owner/:repo/settings/automation",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const repo = c.get("repository" as never) as Repository;
    const body = await c.req.parseBody();
    const base = `/${ownerName}/${repoName}/settings/automation`;

    try {
      await upsertAutomationSettings(repo.id, {
        aiReviewMode: normalizeMode(body["ai_review_mode"], "suggest"),
        prTriageMode: normalizeMode(body["pr_triage_mode"], "suggest"),
        issueTriageMode: normalizeMode(body["issue_triage_mode"], "suggest"),
        autoMergeMode: normalizeMode(body["auto_merge_mode"], "auto"),
        ciAutofixMode: normalizeMode(body["ci_autofix_mode"], "suggest"),
      });

      // The two automations that already lived on the repositories row keep
      // their existing storage so the older settings sections stay in sync.
      await db
        .update(repositories)
        .set({
          autoGenerateTests: body["auto_generate_tests"] === "auto",
          depUpdaterEnabled: body["dep_updater_enabled"] === "auto",
          updatedAt: new Date(),
        })
        .where(eq(repositories.id, repo.id));
    } catch (err) {
      console.error(
        "[automation-settings] save failed:",
        err instanceof Error ? err.message : err
      );
      return c.redirect(
        `${base}?error=${encodeURIComponent("Could not save automation settings. Please try again.")}`
      );
    }

    return c.redirect(
      `${base}?success=${encodeURIComponent("Automation settings saved.")}`
    );
  }
);

export default automationSettings;
