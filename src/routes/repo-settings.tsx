/**
 * Repository settings — description, visibility, default branch, danger zone.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, repoTransfers, branchProtection } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { listBranches } from "../git/repository";
import { audit } from "../lib/notify";
import { rm } from "fs/promises";
import { EmptyState } from "../views/ui";

const repoSettings = new Hono<AuthEnv>();

repoSettings.use("*", softAuth);

// Inline, scoped CSS — every class prefixed `.repo-settings-` so styles cannot
// bleed into other surfaces. Pattern mirrors the user-settings polish
// (commit 98eb360) and the admin-panel polish (commit 07f4b70).
const repoSettingsStyles = `
  .repo-settings-container { max-width: 1200px; margin: 0 auto; padding: 0 var(--space-3); }

  /* ─── Hero ─── */
  .repo-settings-hero {
    position: relative;
    margin: var(--space-5) 0 var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .repo-settings-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .repo-settings-hero-bg {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 360px; height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .repo-settings-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.65;
    animation: repoSettingsHeroOrb 14s ease-in-out infinite;
  }
  @keyframes repoSettingsHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.08) translate(-8px, 6px); opacity: 0.78; }
  }
  @media (prefers-reduced-motion: reduce) {
    .repo-settings-hero-orb { animation: none; }
  }
  .repo-settings-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .repo-settings-hero-eyebrow {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: -0.005em;
  }
  .repo-settings-hero-eyebrow .repo-settings-hero-repo {
    color: var(--accent);
    font-weight: 600;
  }
  .repo-settings-hero-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .repo-settings-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .repo-settings-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .repo-settings-hero-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: var(--space-3);
    font-size: 13.5px;
    color: var(--text-link, var(--accent));
    text-decoration: none;
    font-weight: 500;
  }
  .repo-settings-hero-link:hover { text-decoration: underline; }
  .repo-settings-hero-link .arrow { transition: transform 120ms ease; }
  .repo-settings-hero-link:hover .arrow { transform: translateX(2px); }

  /* ─── Banners (success / error) ─── */
  .repo-settings-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 13.5px;
    margin-bottom: var(--space-4);
    line-height: 1.5;
  }
  .repo-settings-banner-success {
    background: rgba(52,211,153,0.08);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .repo-settings-banner-error {
    background: rgba(248,113,113,0.08);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.30);
  }
  .repo-settings-banner-icon {
    width: 18px; height: 18px;
    border-radius: 9999px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
  }
  .repo-settings-banner-success .repo-settings-banner-icon {
    background: rgba(52,211,153,0.18);
    color: #34d399;
  }
  .repo-settings-banner-error .repo-settings-banner-icon {
    background: rgba(248,113,113,0.18);
    color: #f87171;
  }

  /* ─── Section cards ─── */
  .repo-settings-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    overflow: hidden;
  }
  .repo-settings-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .repo-settings-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .repo-settings-section-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .repo-settings-section-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .repo-settings-section-body { padding: var(--space-4) var(--space-5); }
  .repo-settings-section-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .repo-settings-section-foot .repo-settings-foot-hint {
    margin-right: auto;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ─── Form rows ─── */
  .repo-settings-field { margin-bottom: var(--space-4); }
  .repo-settings-field:last-child { margin-bottom: 0; }
  .repo-settings-field-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.005em;
  }
  .repo-settings-field-hint {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .repo-settings-input,
  .repo-settings-select {
    width: 100%;
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 8px;
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    font-family: var(--font-sans);
  }
  .repo-settings-input:focus,
  .repo-settings-select:focus {
    border-color: var(--border-focus, var(--accent));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* ─── Visibility radio cards ─── */
  .repo-settings-visibility {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-2);
  }
  @media (max-width: 600px) {
    .repo-settings-visibility { grid-template-columns: 1fr; }
  }
  .repo-settings-vis-card {
    display: flex;
    gap: 10px;
    padding: 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .repo-settings-vis-card:hover { border-color: var(--border-strong, var(--border)); }
  .repo-settings-vis-card:has(input:checked) {
    border-color: rgba(140,109,255,0.55);
    background: rgba(140,109,255,0.06);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.25);
  }
  .repo-settings-vis-radio {
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .repo-settings-vis-body { display: flex; flex-direction: column; gap: 4px; }
  .repo-settings-vis-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .repo-settings-vis-desc {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* ─── Toggle rows (stale-sweep) ─── */
  .repo-settings-toggle-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--border-subtle, var(--border));
    background: var(--bg-secondary, var(--bg));
    margin-bottom: 8px;
    transition: border-color 120ms ease, background 120ms ease;
    cursor: pointer;
  }
  .repo-settings-toggle-row:last-of-type { margin-bottom: 0; }
  .repo-settings-toggle-row:hover {
    border-color: var(--border);
    background: rgba(255,255,255,0.02);
  }
  .repo-settings-toggle-row:has(input:checked) {
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.05);
  }
  .repo-settings-toggle-row input[type="checkbox"] {
    margin-top: 2px;
    flex-shrink: 0;
    width: 16px; height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .repo-settings-toggle-text {
    flex: 1;
    font-size: 14px;
    color: var(--text);
    line-height: 1.45;
  }
  .repo-settings-toggle-text-title {
    display: block;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 2px;
  }
  .repo-settings-toggle-text-hint {
    display: block;
    margin-top: 3px;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  /* ─── Primary CTA ─── */
  .repo-settings-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    font-size: 14px;
    font-weight: 600;
    color: white;
    background: linear-gradient(135deg, #8c6dff 0%, #5b7bff 100%);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
    text-decoration: none;
    font-family: inherit;
  }
  .repo-settings-cta:hover {
    filter: brightness(1.08);
    box-shadow: 0 6px 18px rgba(140,109,255,0.25);
    transform: translateY(-1px);
  }
  .repo-settings-cta .arrow { transition: transform 120ms ease; }
  .repo-settings-cta:hover .arrow { transform: translateX(2px); }
  .repo-settings-cta-secondary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 8px;
    cursor: pointer;
    text-decoration: none;
    transition: border-color 120ms ease, background 120ms ease;
    font-family: inherit;
  }
  .repo-settings-cta-secondary:hover {
    border-color: var(--accent);
    background: rgba(140,109,255,0.06);
  }

  /* ─── Inline transfer row ─── */
  .repo-settings-inline-row {
    display: flex;
    gap: var(--space-2);
    align-items: stretch;
    flex-wrap: wrap;
  }
  .repo-settings-inline-row .repo-settings-input { flex: 1; min-width: 220px; }

  /* ─── Status pill (template / archived) ─── */
  .repo-settings-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    margin-bottom: var(--space-2);
  }
  .repo-settings-pill.is-on {
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .repo-settings-pill.is-off {
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .repo-settings-pill .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
    box-shadow: 0 0 8px currentColor;
  }
  .repo-settings-pill.is-off .dot { box-shadow: none; opacity: 0.6; }

  /* ─── Danger zone ─── */
  .repo-settings-danger {
    position: relative;
    margin-top: var(--space-6);
    padding: 0;
    border: 1px solid rgba(248,113,113,0.30);
    border-radius: 14px;
    background:
      linear-gradient(180deg, rgba(248,113,113,0.05) 0%, rgba(248,113,113,0.02) 100%),
      var(--bg-elevated);
    overflow: hidden;
  }
  .repo-settings-danger::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f87171 30%, #ffb45e 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .repo-settings-danger-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid rgba(248,113,113,0.15);
  }
  .repo-settings-danger-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #f87171;
    margin-bottom: 6px;
  }
  .repo-settings-danger-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .repo-settings-danger-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .repo-settings-danger-body { padding: var(--space-4) var(--space-5); }
  .repo-settings-danger-body p { margin: 0 0 var(--space-3); font-size: 14px; line-height: 1.55; }
  .repo-settings-danger-body p:last-child { margin-bottom: 0; }
  .repo-settings-danger-body p.muted { color: var(--text-muted); font-size: 13px; }
  .repo-settings-danger-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: filter 120ms ease, box-shadow 120ms ease, transform 120ms ease;
  }
  .repo-settings-danger-btn:hover {
    filter: brightness(1.08);
    box-shadow: 0 6px 18px rgba(248,113,113,0.25);
    transform: translateY(-1px);
  }

  /* ─── Responsive ─── */
  @media (max-width: 720px) {
    .repo-settings-hero { padding: var(--space-4) var(--space-4); }
    .repo-settings-section-head,
    .repo-settings-section-body,
    .repo-settings-section-foot,
    .repo-settings-danger-head,
    .repo-settings-danger-body { padding-left: var(--space-4); padding-right: var(--space-4); }
  }
`;

/** Hero header for the repo settings page. */
function RepoSettingsHero(props: { owner: string; repo: string }) {
  const { owner, repo } = props;
  return (
    <div class="repo-settings-hero">
      <div class="repo-settings-hero-bg" aria-hidden="true">
        <div class="repo-settings-hero-orb" />
      </div>
      <div class="repo-settings-hero-inner">
        <div class="repo-settings-hero-eyebrow">
          Repository settings ·{" "}
          <span class="repo-settings-hero-repo">
            {owner}/{repo}
          </span>
        </div>
        <h1 class="repo-settings-hero-title">
          <span class="gradient-text">Configure</span>.
        </h1>
        <p class="repo-settings-hero-sub">
          Description, visibility, branches, automation. Owners only.
        </p>
        <a
          href={`/${owner}/${repo}/settings/collaborators`}
          class="repo-settings-hero-link"
        >
          Manage collaborators <span class="arrow">→</span>
        </a>
      </div>
    </div>
  );
}

function Banner(props: { kind: "success" | "error"; text: string }) {
  return (
    <div
      class={`repo-settings-banner repo-settings-banner-${props.kind}`}
      role="status"
    >
      <span class="repo-settings-banner-icon" aria-hidden="true">
        {props.kind === "success" ? "✓" : "!"}
      </span>
      <span>{props.text}</span>
    </div>
  );
}

// Settings page
repoSettings.get("/:owner/:repo/settings", requireAuth, requireRepoAccess("admin"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");

  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);

  if (!owner || owner.id !== user.id) {
    return c.html(
      <Layout title="Unauthorized" user={user}>
        <EmptyState title="Unauthorized">
          <p>Only the repository owner can access settings.</p>
        </EmptyState>
      </Layout>,
      403
    );
  }

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);

  if (!repo) return c.notFound();

  const branches = await listBranches(ownerName, repoName);

  // Branch protection rules for the "Branch protection" settings section.
  const existingBranchRules = await db
    .select()
    .from(branchProtection)
    .where(eq(branchProtection.repositoryId, repo.id))
    .catch(() => [] as typeof branchProtection.$inferSelect[]);

  return c.html(
    <Layout title={`Settings — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <style dangerouslySetInnerHTML={{ __html: repoSettingsStyles }} />
      <div class="repo-settings-container">
        <RepoSettingsHero owner={ownerName} repo={repoName} />

        {success && (
          <Banner kind="success" text={decodeURIComponent(success)} />
        )}
        {error && <Banner kind="error" text={decodeURIComponent(error)} />}

        {/* ─── General: description + default branch + visibility ─── */}
        <section class="repo-settings-section">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">General</div>
            <h2 class="repo-settings-section-title">Repository basics</h2>
            <p class="repo-settings-section-desc">
              The headline details visitors see — description, the default
              branch they land on, and who can browse the code.
            </p>
          </div>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings`}
          >
            <div class="repo-settings-section-body">
              <div class="repo-settings-field">
                <label class="repo-settings-field-label" for="description">
                  Description
                </label>
                <input
                  class="repo-settings-input"
                  name="description"
                  id="description"
                  value={repo.description || ""}
                  placeholder="A short description"
                />
                <div class="repo-settings-field-hint">
                  Shown on the repo home, search results, and explore pages.
                </div>
              </div>
              <div class="repo-settings-field">
                <label
                  class="repo-settings-field-label"
                  for="default_branch"
                >
                  Default branch
                </label>
                <select
                  class="repo-settings-select"
                  name="default_branch"
                  id="default_branch"
                >
                  {branches.length === 0 ? (
                    <option value={repo.defaultBranch}>
                      {repo.defaultBranch}
                    </option>
                  ) : (
                    branches.map((b) => (
                      <option value={b} selected={b === repo.defaultBranch}>
                        {b}
                      </option>
                    ))
                  )}
                </select>
                <div class="repo-settings-field-hint">
                  Where pulls land, where compare views start, and what
                  clones check out by default.
                </div>
              </div>
              <div class="repo-settings-field">
                <label class="repo-settings-field-label">Visibility</label>
                <div class="repo-settings-visibility">
                  <label class="repo-settings-vis-card">
                    <input
                      type="radio"
                      name="visibility"
                      value="public"
                      checked={!repo.isPrivate}
                      class="repo-settings-vis-radio"
                      aria-label="Public"
                    />
                    <span class="repo-settings-vis-body">
                      <span class="repo-settings-vis-label">Public</span>
                      <span class="repo-settings-vis-desc">
                        Anyone can see this repository. You choose who can
                        commit.
                      </span>
                    </span>
                  </label>
                  <label class="repo-settings-vis-card">
                    <input
                      type="radio"
                      name="visibility"
                      value="private"
                      checked={repo.isPrivate}
                      class="repo-settings-vis-radio"
                      aria-label="Private"
                    />
                    <span class="repo-settings-vis-body">
                      <span class="repo-settings-vis-label">Private</span>
                      <span class="repo-settings-vis-desc">
                        Only you (and collaborators you invite) can see this
                        repository.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
              <div class="repo-settings-field">
                <label class="repo-settings-field-label">Data region</label>
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <span
                    style={`display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border-radius:9999px; font-size:12px; font-weight:600; font-family:var(--font-mono); ${
                      repo.dataRegion === "eu"
                        ? "background:rgba(54,197,214,0.10); color:#67e8f9; border:1px solid rgba(54,197,214,0.28);"
                        : "background:rgba(140,109,255,0.10); color:#c4b5fd; border:1px solid rgba(140,109,255,0.28);"
                    }`}
                  >
                    {repo.dataRegion === "eu" ? "EU · Frankfurt" : "US · Default"}
                  </span>
                  <span class="repo-settings-field-hint" style="margin:0;">
                    Data region is set at creation and cannot be changed. EU data
                    residency requires a{" "}
                    <a href="/pricing" style="color:var(--accent);text-decoration:none;">Pro plan or higher</a>.
                  </span>
                </div>
              </div>
            </div>
            <div class="repo-settings-section-foot">
              <button type="submit" class="repo-settings-cta">
                Save changes <span class="arrow">→</span>
              </button>
            </div>
          </form>
        </section>

        {/* ─── Spec to PR ─── */}
        <section class="repo-settings-section">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">
              Automation · experimental
            </div>
            <h2 class="repo-settings-section-title">Spec to PR</h2>
            <p class="repo-settings-section-desc">
              Paste a plain-English feature spec and let Claude draft a pull
              request for you. PRs open as drafts — review every line before
              merging.
            </p>
          </div>
          <div class="repo-settings-section-body">
            <a
              href={`/${ownerName}/${repoName}/spec`}
              class="repo-settings-cta"
            >
              Open Spec to PR <span class="arrow">→</span>
            </a>
          </div>
        </section>

        {/* ─── Template repository ─── */}
        <section class="repo-settings-section">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">Template</div>
            <h2 class="repo-settings-section-title">Template repository</h2>
            <p class="repo-settings-section-desc">
              {repo.isTemplate
                ? "This repository is a template. Users can click “Use this template” to create a new repository with the same files."
                : "Mark this repository as a template so others can seed new repositories from its files."}
            </p>
          </div>
          <div class="repo-settings-section-body">
            <span
              class={`repo-settings-pill ${repo.isTemplate ? "is-on" : "is-off"}`}
            >
              <span class="dot" aria-hidden="true" />
              {repo.isTemplate ? "Template enabled" : "Not a template"}
            </span>
            <form
              method="post"
              action={`/${ownerName}/${repoName}/settings/template`}
              style="margin-top: var(--space-3)"
            >
              <input
                type="hidden"
                name="template"
                value={repo.isTemplate ? "0" : "1"}
              />
              <button type="submit" class="repo-settings-cta-secondary">
                {repo.isTemplate ? "Unmark as template" : "Mark as template"}
              </button>
            </form>
          </div>
        </section>

        {/* ─── Transfer ownership ─── */}
        <section class="repo-settings-section">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">Ownership</div>
            <h2 class="repo-settings-section-title">Transfer ownership</h2>
            <p class="repo-settings-section-desc">
              Hand this repository to another user. The new owner can accept
              or decline the transfer by viewing it.
            </p>
          </div>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/transfer`}
            onsubmit="return confirm('Transfer this repository? The new owner will have full control.')"
          >
            <div class="repo-settings-section-body">
              <div class="repo-settings-field">
                <label class="repo-settings-field-label" for="new_owner">
                  New owner username
                </label>
                <div class="repo-settings-inline-row">
                  <input
                    type="text"
                    name="new_owner"
                    id="new_owner"
                    class="repo-settings-input"
                    placeholder="new-owner-username"
                    required
                    aria-label="New owner username"
                  />
                  <button type="submit" class="repo-settings-cta-secondary">
                    Transfer
                  </button>
                </div>
                <div class="repo-settings-field-hint">
                  Transfers are immediate. The new owner can rename or delete
                  the repository at any time.
                </div>
              </div>
            </div>
          </form>
        </section>

        {/* ─── Archive ─── */}
        <section class="repo-settings-section">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">Lifecycle</div>
            <h2 class="repo-settings-section-title">
              {repo.isArchived ? "Unarchive repository" : "Archive repository"}
            </h2>
            <p class="repo-settings-section-desc">
              {repo.isArchived
                ? "This repository is archived and read-only. Unarchive to allow pushes and issue/PR activity again."
                : "Mark this repository as archived. It becomes read-only — no pushes, no new issues or PRs. You can unarchive at any time."}
            </p>
          </div>
          <div class="repo-settings-section-body">
            <span
              class={`repo-settings-pill ${repo.isArchived ? "is-on" : "is-off"}`}
            >
              <span class="dot" aria-hidden="true" />
              {repo.isArchived ? "Archived" : "Active"}
            </span>
            <form
              method="post"
              action={`/${ownerName}/${repoName}/settings/archive`}
              style="margin-top: var(--space-3)"
            >
              <input
                type="hidden"
                name="archive"
                value={repo.isArchived ? "0" : "1"}
              />
              <button type="submit" class="repo-settings-cta-secondary">
                {repo.isArchived ? "Unarchive" : "Archive"} this repository
              </button>
            </form>
          </div>
        </section>

        {/* ─── AI test generator ─── */}
        <section class="repo-settings-section">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">AI tests</div>
            <h2 class="repo-settings-section-title">Auto-generate tests on PR open</h2>
            <p class="repo-settings-section-desc">
              When a pull request opens, Gluecron AI reads the diff and writes
              tests for the new code, matching whatever framework your repo
              already uses. Tests land on the same branch. Default off —
              opt in here.
            </p>
          </div>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/ai-tests`}
          >
            <div class="repo-settings-section-body">
              <label
                class="repo-settings-toggle-row"
                aria-label="Auto-generate tests when a PR opens"
              >
                <input
                  type="checkbox"
                  name="auto_generate_tests"
                  value="1"
                  checked={repo.autoGenerateTests}
                />
                <span class="repo-settings-toggle-text">
                  <span class="repo-settings-toggle-text-title">
                    Auto-generate tests on PR open
                  </span>
                  <span class="repo-settings-toggle-text-hint">
                    Requires <code>ANTHROPIC_API_KEY</code>. Skips PRs without
                    source-file changes and PRs already opened by AI.
                  </span>
                </span>
              </label>
            </div>
            <div class="repo-settings-section-foot">
              <button type="submit" class="repo-settings-cta">
                Save AI test settings <span class="arrow">→</span>
              </button>
            </div>
          </form>
        </section>

        {/* ─── Dependency auto-updater ─── */}
        <section
          id="dep-updater"
          class="repo-settings-section"
        >
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">AI dependency updates</div>
            <h2 class="repo-settings-section-title">Automatic dependency updates</h2>
            <p class="repo-settings-section-desc">
              Once per day, Gluecron reads your <code>package.json</code>,
              checks npm for patch and minor updates, and applies them
              automatically. If the gate check passes, the PR is auto-merged.
              If it fails, Gluecron opens a PR with an AI-written guide
              explaining what broke and how to fix it. Major updates always
              require human review and are handled separately by the migration
              watcher. Default off.
            </p>
          </div>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/dep-updater`}
          >
            <div class="repo-settings-section-body">
              <label
                class="repo-settings-toggle-row"
                aria-label="Enable automatic dependency updates for this repo"
              >
                <input
                  type="checkbox"
                  name="dep_updater_enabled"
                  value="1"
                  checked={
                    (repo as { depUpdaterEnabled?: boolean }).depUpdaterEnabled ??
                    false
                  }
                />
                <span class="repo-settings-toggle-text">
                  <span class="repo-settings-toggle-text-title">
                    Enable automatic dependency updates
                  </span>
                  <span class="repo-settings-toggle-text-hint">
                    Patch and minor updates only. Runs once per day; max 2
                    packages per sweep. Requires <code>DEP_UPDATER_ENABLED=1</code>{" "}
                    on the server. Auto-merges when gate passes; opens a PR
                    with an AI migration guide when it fails.
                  </span>
                </span>
              </label>
            </div>
            <div class="repo-settings-section-foot">
              <button type="submit" class="repo-settings-cta">
                Save dependency update settings <span class="arrow">→</span>
              </button>
            </div>
          </form>
        </section>

        {/* ─── Cloud dev environments ─── */}
        <section
          id="dev-envs"
          class="repo-settings-section"
        >
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">Dev environments</div>
            <h2 class="repo-settings-section-title">Enable cloud dev environments</h2>
            <p class="repo-settings-section-desc">
              When enabled, anyone with read access can hit{" "}
              <code>/{ownerName}/{repoName}/dev</code> to spin up a
              hosted VS Code IDE in the browser, backed by a cold-start
              container. We read <code>.gluecron/dev.yml</code> for the
              image + install commands; idle envs stop themselves after
              30 minutes. Default off — each env burns a container.
            </p>
          </div>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/dev-envs`}
          >
            <div class="repo-settings-section-body">
              <label
                class="repo-settings-toggle-row"
                aria-label="Enable cloud dev environments for this repo"
              >
                <input
                  type="checkbox"
                  name="dev_envs_enabled"
                  value="1"
                  checked={
                    (repo as { devEnvsEnabled?: boolean }).devEnvsEnabled ??
                    false
                  }
                />
                <span class="repo-settings-toggle-text">
                  <span class="repo-settings-toggle-text-title">
                    Enable dev environments
                  </span>
                  <span class="repo-settings-toggle-text-hint">
                    Surfaces the <code>/{ownerName}/{repoName}/dev</code>{" "}
                    route. Commit <code>.gluecron/dev.yml</code> to your
                    repo to customise the image, ports, and extensions.
                  </span>
                </span>
              </label>
            </div>
            <div class="repo-settings-section-foot">
              <button type="submit" class="repo-settings-cta">
                Save dev env settings <span class="arrow">→</span>
              </button>
            </div>
          </form>
        </section>

        {/* ─── Stale activity ─── */}
        <section class="repo-settings-section">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">Stale sweep</div>
            <h2 class="repo-settings-section-title">Stale activity</h2>
            <p class="repo-settings-section-desc">
              Autopilot pokes PRs and issues that have gone quiet, then offers
              a one-click close path. Each toggle controls the final close
              step — pokes always happen, but they&apos;re harmless reminders.
            </p>
          </div>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/stale`}
          >
            <div class="repo-settings-section-body">
              <label
                class="repo-settings-toggle-row"
                aria-label="Auto-close stale PRs after 14 days of no activity post-poke"
              >
                <input
                  type="checkbox"
                  name="auto_close_stale_prs"
                  value="1"
                  checked={repo.autoCloseStalePrs}
                />
                <span class="repo-settings-toggle-text">
                  <span class="repo-settings-toggle-text-title">
                    Auto-close stale PRs
                  </span>
                  <span class="repo-settings-toggle-text-hint">
                    Close PRs that go quiet for 14 days after autopilot pokes
                    them.
                  </span>
                </span>
              </label>
              <label
                class="repo-settings-toggle-row"
                aria-label="Auto-close stale issues after 60 days of no activity post-poke"
              >
                <input
                  type="checkbox"
                  name="auto_close_stale_issues"
                  value="1"
                  checked={repo.autoCloseStaleIssues}
                />
                <span class="repo-settings-toggle-text">
                  <span class="repo-settings-toggle-text-title">
                    Auto-close stale issues
                  </span>
                  <span class="repo-settings-toggle-text-hint">
                    Close issues that go quiet for 60 days after autopilot
                    pokes them.
                  </span>
                </span>
              </label>
            </div>
            <div class="repo-settings-section-foot">
              <button type="submit" class="repo-settings-cta">
                Save stale settings <span class="arrow">→</span>
              </button>
            </div>
          </form>
        </section>

        {/* ─── PR preview builds (migration 0077) ─── */}
        <section class="repo-settings-section">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">Preview builds</div>
            <h2 class="repo-settings-section-title">PR preview environments</h2>
            <p class="repo-settings-section-desc">
              When a build command is set, every PR push automatically clones
              the branch, runs the command, and serves the built output from a
              unique preview URL — like Vercel, but native to Gluecron. Leave
              blank to use URL-only previews (no build runs).
            </p>
          </div>
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/previews`}
          >
            <div class="repo-settings-section-body">
              <div class="repo-settings-field">
                <label class="repo-settings-field-label" for="preview_build_command">
                  Build command
                </label>
                <input
                  id="preview_build_command"
                  class="repo-settings-input"
                  type="text"
                  name="preview_build_command"
                  placeholder="npm run build"
                  value={
                    (repo as { previewBuildCommand?: string | null }).previewBuildCommand ?? ""
                  }
                />
                <p class="repo-settings-field-hint">
                  e.g. <code>npm run build</code>, <code>bun run build</code>, or{" "}
                  <code>hugo</code>. Runs inside the cloned branch directory.
                </p>
              </div>
              <div class="repo-settings-field">
                <label class="repo-settings-field-label" for="preview_output_dir">
                  Output directory
                </label>
                <input
                  id="preview_output_dir"
                  class="repo-settings-input"
                  type="text"
                  name="preview_output_dir"
                  placeholder="dist"
                  value={
                    (repo as { previewOutputDir?: string | null }).previewOutputDir ?? "dist"
                  }
                />
                <p class="repo-settings-field-hint">
                  The directory your build writes to. Common values:{" "}
                  <code>dist</code>, <code>public</code>, <code>out</code>,{" "}
                  <code>build</code>. Served from{" "}
                  <code>/previews/{ownerName}/{repoName}/{"<branch>"}/</code>
                </p>
              </div>
            </div>
            <div class="repo-settings-section-foot">
              <button type="submit" class="repo-settings-cta">
                Save preview settings <span class="arrow">→</span>
              </button>
            </div>
          </form>
        </section>

        {/* ─── Branch protection ─── */}
        <section class="repo-settings-section" id="branch-protection">
          <div class="repo-settings-section-head">
            <div class="repo-settings-section-eyebrow">Branch protection</div>
            <h2 class="repo-settings-section-title">Required reviews before merge</h2>
            <p class="repo-settings-section-desc">
              Protect branches by requiring a minimum number of human approvals before
              a pull request can be merged. Patterns support wildcards (e.g.{" "}
              <code>release/*</code>). CODEOWNERS auto-assignment applies independently.
            </p>
          </div>

          {/* Existing rules list */}
          {existingBranchRules.length > 0 && (
            <div style="padding: var(--space-3) var(--space-5) 0">
              {existingBranchRules.map((rule) => (
                <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
                  <span style="flex:1;font-family:var(--font-mono);font-size:13px;color:var(--text-strong)">
                    {rule.pattern}
                  </span>
                  <span style="font-size:12.5px;color:var(--text-muted)">
                    {rule.requiredApprovals} required approval{rule.requiredApprovals !== 1 ? "s" : ""}
                  </span>
                  {rule.requireHumanReview && (
                    <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:9999px;background:rgba(140,109,255,0.12);color:#b69dff">
                      codeowner review required
                    </span>
                  )}
                  {rule.dismissStaleReviews && (
                    <span style="font-size:11px;color:var(--text-muted)">
                      dismiss stale
                    </span>
                  )}
                  <form method="post" action={`/${ownerName}/${repoName}/settings/branch-protection/${rule.id}/delete`}>
                    <button type="submit"
                      class="repo-settings-cta-secondary"
                      style="padding:4px 10px;font-size:12px;color:var(--red,#f87171)"
                      onclick="return confirm('Delete this branch protection rule?')"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}

          {/* Add new rule form */}
          <form
            method="post"
            action={`/${ownerName}/${repoName}/settings/branch-protection`}
          >
            <div class="repo-settings-section-body">
              <div style="display:grid;grid-template-columns:1fr 120px;gap:var(--space-3);align-items:end">
                <div class="repo-settings-field" style="margin-bottom:0">
                  <label class="repo-settings-field-label" for="bp_pattern">
                    Branch name pattern
                  </label>
                  <input
                    class="repo-settings-input"
                    name="pattern"
                    id="bp_pattern"
                    placeholder="main"
                    required
                    aria-label="Branch name pattern"
                  />
                  <div class="repo-settings-field-hint">
                    Exact name or glob like <code>release/*</code>
                  </div>
                </div>
                <div class="repo-settings-field" style="margin-bottom:0">
                  <label class="repo-settings-field-label" for="bp_required">
                    Required approvals
                  </label>
                  <input
                    class="repo-settings-input"
                    name="required_approvals"
                    id="bp_required"
                    type="number"
                    min="0"
                    max="10"
                    value="1"
                    aria-label="Number of required approvals"
                  />
                </div>
              </div>
              <div style="margin-top:var(--space-3);display:flex;flex-direction:column;gap:8px">
                <label class="repo-settings-toggle-row" aria-label="Require codeowner review">
                  <input
                    type="checkbox"
                    name="require_codeowner_review"
                    value="1"
                  />
                  <span class="repo-settings-toggle-text">
                    <span class="repo-settings-toggle-text-title">
                      Require codeowner review
                    </span>
                    <span class="repo-settings-toggle-text-hint">
                      At least one CODEOWNERS-matched reviewer must approve before merging.
                    </span>
                  </span>
                </label>
                <label class="repo-settings-toggle-row" aria-label="Dismiss stale reviews">
                  <input
                    type="checkbox"
                    name="dismiss_stale_reviews"
                    value="1"
                  />
                  <span class="repo-settings-toggle-text">
                    <span class="repo-settings-toggle-text-title">
                      Dismiss stale reviews on new push
                    </span>
                    <span class="repo-settings-toggle-text-hint">
                      Prior approvals are dismissed when the head branch receives a new commit.
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div class="repo-settings-section-foot">
              <button type="submit" class="repo-settings-cta">
                Add rule <span class="arrow">→</span>
              </button>
            </div>
          </form>
        </section>

        {/* ─── Danger zone ─── */}
        <section class="repo-settings-danger">
          <div class="repo-settings-danger-head">
            <div class="repo-settings-danger-eyebrow">Danger zone</div>
            <h2 class="repo-settings-danger-title">Delete this repository</h2>
            <p class="repo-settings-danger-desc">
              Permanently remove this repository and every byte of its history,
              issues, PRs, stars, and webhooks. There is no undo.
            </p>
          </div>
          <div class="repo-settings-danger-body">
            <p class="muted">
              Once deleted, the URL <code>{ownerName}/{repoName}</code> frees
              up immediately. Open clones will fail to fetch or push.
            </p>
            <form
              method="post"
              action={`/${ownerName}/${repoName}/settings/delete`}
              onsubmit="return confirm('Are you sure? This cannot be undone.')"
            >
              <button type="submit" class="repo-settings-danger-btn">
                Delete this repository
              </button>
            </form>
          </div>
        </section>
      </div>
    </Layout>
  );
});

// Save settings
repoSettings.post("/:owner/:repo/settings", requireAuth, requireRepoAccess("admin"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);

  if (!owner || owner.id !== user.id) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }

  await db
    .update(repositories)
    .set({
      description: String(body.description || "").trim() || null,
      defaultBranch: String(body.default_branch || "main"),
      isPrivate: body.visibility === "private",
      updatedAt: new Date(),
    })
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    );

  return c.redirect(
    `/${ownerName}/${repoName}/settings?success=Settings+saved`
  );
});

// Toggle template flag
repoSettings.post(
  "/:owner/:repo/settings/template",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const target = String(body.template || "1") === "1";
    await db
      .update(repositories)
      .set({ isTemplate: target, updatedAt: new Date() })
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      );
    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=${
        target ? "Marked+as+template" : "Unmarked+as+template"
      }`
    );
  }
);

// Transfer repository to a new owner (by username)
repoSettings.post(
  "/:owner/:repo/settings/transfer",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const newOwnerName = String(body.new_owner || "").trim();
    if (!newOwnerName) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=New+owner+required`
      );
    }
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const [newOwner] = await db
      .select()
      .from(users)
      .where(eq(users.username, newOwnerName))
      .limit(1);
    if (!newOwner) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=User+not+found`
      );
    }
    if (newOwner.id === owner.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=Same+owner`
      );
    }
    // Reject if new owner already has a repo by this name
    const [conflict] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, newOwner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (conflict) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=Target+owner+already+has+a+repo+by+that+name`
      );
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.notFound();
    await db
      .update(repositories)
      .set({ ownerId: newOwner.id, orgId: null, updatedAt: new Date() })
      .where(eq(repositories.id, repo.id));
    await db.insert(repoTransfers).values({
      repositoryId: repo.id,
      fromOwnerId: owner.id,
      fromOrgId: repo.orgId,
      toOwnerId: newOwner.id,
      toOrgId: null,
      initiatedBy: user.id,
    });
    return c.redirect(`/${newOwnerName}/${repoName}`);
  }
);

// Archive / unarchive repository
repoSettings.post(
  "/:owner/:repo/settings/archive",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const target = String(body.archive || "1") === "1";
    await db
      .update(repositories)
      .set({ isArchived: target, updatedAt: new Date() })
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      );
    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=${
        target ? "Repository+archived" : "Repository+unarchived"
      }`
    );
  }
);

// Block M5: stale activity opt-out flags. Owner-only; audits each toggle.
repoSettings.post(
  "/:owner/:repo/settings/stale",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.notFound();

    // Unchecked checkboxes are absent from the form payload, so coerce to bool.
    const newPrs = body.auto_close_stale_prs === "1";
    const newIssues = body.auto_close_stale_issues === "1";

    await db
      .update(repositories)
      .set({
        autoCloseStalePrs: newPrs,
        autoCloseStaleIssues: newIssues,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repo.id));

    // Audit toggle deltas so the repo's audit log shows the change. Two
    // separate rows (one per flag) so the action names stay stable + grep-able.
    if (newPrs !== repo.autoCloseStalePrs) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "repo.auto_close_stale_prs.toggled",
        targetType: "repository",
        targetId: repo.id,
        metadata: { from: repo.autoCloseStalePrs, to: newPrs },
      });
    }
    if (newIssues !== repo.autoCloseStaleIssues) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "repo.auto_close_stale_issues.toggled",
        targetType: "repository",
        targetId: repo.id,
        metadata: { from: repo.autoCloseStaleIssues, to: newIssues },
      });
    }

    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=Stale+settings+saved`
    );
  }
);

// AI test generator opt-in. Owner-only; audits the toggle delta so the
// repo's audit log shows the change.
repoSettings.post(
  "/:owner/:repo/settings/ai-tests",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.notFound();

    // Unchecked checkboxes are absent from the form payload, so coerce.
    const next = body.auto_generate_tests === "1";

    await db
      .update(repositories)
      .set({
        autoGenerateTests: next,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repo.id));

    if (next !== repo.autoGenerateTests) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "repo.auto_generate_tests.toggled",
        targetType: "repository",
        targetId: repo.id,
        metadata: { from: repo.autoGenerateTests, to: next },
      });
    }

    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=AI+test+settings+saved`
    );
  }
);

// Migration 0072 — toggle cloud dev environments. Owner-only; audits
// the toggle delta so the repo's audit log shows the change.
repoSettings.post(
  "/:owner/:repo/settings/dev-envs",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.notFound();

    const next = body.dev_envs_enabled === "1";
    const prev = (repo as { devEnvsEnabled?: boolean }).devEnvsEnabled ?? false;

    await db
      .update(repositories)
      .set({
        devEnvsEnabled: next,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repo.id));

    if (next !== prev) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "repo.dev_envs_enabled.toggled",
        targetType: "repository",
        targetId: repo.id,
        metadata: { from: prev, to: next },
      });
    }

    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=Dev+env+settings+saved#dev-envs`
    );
  }
);

// Migration 0077 — toggle AI dependency auto-updater. Owner-only; audits
// the toggle delta so the repo's audit log shows the change.
repoSettings.post(
  "/:owner/:repo/settings/dep-updater",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
      )
      .limit(1);
    if (!repo) return c.notFound();

    const next = body.dep_updater_enabled === "1";
    const prev =
      (repo as { depUpdaterEnabled?: boolean }).depUpdaterEnabled ?? false;

    await db
      .update(repositories)
      .set({
        depUpdaterEnabled: next,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repo.id));

    if (next !== prev) {
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "repo.dep_updater_enabled.toggled",
        targetType: "repository",
        targetId: repo.id,
        metadata: { from: prev, to: next },
      });
    }

    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=Dependency+update+settings+saved#dep-updater`
    );
  }
);

// Delete repository
repoSettings.post(
  "/:owner/:repo/settings/delete",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);

    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);

    if (!repo) return c.redirect(`/${ownerName}`);

    // Delete from disk
    try {
      await rm(repo.diskPath, { recursive: true, force: true });
    } catch {
      // Disk cleanup best-effort
    }

    // Delete from DB (cascades to stars, issues, etc.)
    await db.delete(repositories).where(eq(repositories.id, repo.id));

    return c.redirect(`/${ownerName}`);
  }
);

// Migration 0077 — PR preview build configuration. Owner-only.
repoSettings.post(
  "/:owner/:repo/settings/previews",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
      )
      .limit(1);
    if (!repo) return c.notFound();

    const buildCommand = String(body.preview_build_command || "").trim() || null;
    const outputDir = String(body.preview_output_dir || "").trim() || "dist";

    await db
      .update(repositories)
      .set({
        previewBuildCommand: buildCommand,
        previewOutputDir: outputDir,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, repo.id));

    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=Preview+build+settings+saved`
    );
  }
);

// ─── Branch protection: add rule ───────────────────────────────────────────
repoSettings.post(
  "/:owner/:repo/settings/branch-protection",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName)))
      .limit(1);
    if (!repo) return c.notFound();

    const pattern = String(body.pattern || "").trim();
    if (!pattern) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=Pattern+is+required#branch-protection`
      );
    }

    const requiredApprovals = Math.max(0, parseInt(String(body.required_approvals || "1"), 10) || 0);
    const requireHumanReview = body.require_codeowner_review === "1";
    const dismissStaleReviews = body.dismiss_stale_reviews === "1";

    try {
      await db
        .insert(branchProtection)
        .values({
          repositoryId: repo.id,
          pattern,
          requiredApprovals,
          requireHumanReview,
          dismissStaleReviews,
        })
        .onConflictDoUpdate({
          target: [branchProtection.repositoryId, branchProtection.pattern],
          set: {
            requiredApprovals,
            requireHumanReview,
            dismissStaleReviews,
            updatedAt: new Date(),
          },
        });

      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "branch_protection.updated",
        targetType: "repository",
        targetId: repo.id,
        metadata: { pattern, requiredApprovals, requireHumanReview, dismissStaleReviews },
      });
    } catch (err) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings?error=${encodeURIComponent("Failed to save rule: " + String(err instanceof Error ? err.message : err))}#branch-protection`
      );
    }

    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=Branch+protection+rule+saved#branch-protection`
    );
  }
);

// ─── Branch protection: delete rule ────────────────────────────────────────
repoSettings.post(
  "/:owner/:repo/settings/branch-protection/:ruleId/delete",
  requireAuth,
  requireRepoAccess("admin"),
  async (c) => {
    const { owner: ownerName, repo: repoName, ruleId } = c.req.param();
    const user = c.get("user")!;

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner || owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName)))
      .limit(1);
    if (!repo) return c.notFound();

    await db
      .delete(branchProtection)
      .where(
        and(
          eq(branchProtection.id, ruleId),
          eq(branchProtection.repositoryId, repo.id)
        )
      );

    await audit({
      userId: user.id,
      repositoryId: repo.id,
      action: "branch_protection.deleted",
      targetType: "repository",
      targetId: repo.id,
      metadata: { ruleId },
    });

    return c.redirect(
      `/${ownerName}/${repoName}/settings?success=Branch+protection+rule+deleted#branch-protection`
    );
  }
);

export default repoSettings;
