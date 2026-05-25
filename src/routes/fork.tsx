/**
 * Fork route — copy a repository into your account.
 *
 * GET  /:owner/:repo/fork  — polished confirmation page (source repo
 *                            card + destination owner picker + gradient
 *                            "Create my fork" submit). Mirrors the
 *                            existing inline POST button on RepoHeader;
 *                            the form here POSTs to the same endpoint
 *                            below, so the POST handler logic is the
 *                            single source of truth.
 * POST /:owner/:repo/fork  — perform the fork.
 *
 * All CSS is scoped under `.fork-*` so it can't bleed into other
 * surfaces. Visual recipe follows `src/routes/import.tsx` and
 * `src/routes/connect-claude.tsx`.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, activityFeed } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getRepoPath, repoExists } from "../git/repository";
import { config } from "../lib/config";
import { join } from "path";
import { Layout } from "../views/layout";

const fork = new Hono<AuthEnv>();

fork.use("*", softAuth);

// ─── Scoped CSS — `.fork-*` ────────────────────────────────────────────────
const forkStyles = `
  .fork-wrap { max-width: 760px; margin: 0 auto; padding: var(--space-6, 32px) var(--space-4, 24px); }

  /* ─── Hero ─── */
  .fork-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 36px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .fork-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .fork-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    animation: forkHeroOrb 14s ease-in-out infinite;
    z-index: 0;
  }
  @keyframes forkHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.08) translate(-12px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .fork-hero-orb { animation: none; }
  }
  .fork-hero-inner { position: relative; z-index: 1; max-width: 640px; }
  .fork-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 12px;
  }
  .fork-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .fork-eyebrow strong { color: var(--accent); font-weight: 700; }
  .fork-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.06;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .fork-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .fork-sub {
    font-size: 15px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
    max-width: 560px;
  }

  /* ─── Source repo card ─── */
  .fork-source-card {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 18px;
    margin-bottom: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .fork-source-card::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: linear-gradient(180deg, #8c6dff 0%, #36c5d6 100%);
  }
  .fork-source-icon {
    flex-shrink: 0;
    width: 44px; height: 44px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    border: 1px solid rgba(140,109,255,0.35);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c5b3ff;
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 20px;
  }
  .fork-source-body { flex: 1; min-width: 0; }
  .fork-source-eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 3px;
  }
  .fork-source-name {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.012em;
    display: block;
  }
  .fork-source-name:hover { color: var(--accent); }
  .fork-source-desc {
    font-size: 13px;
    color: var(--text-muted);
    margin: 3px 0 0;
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── Form card ─── */
  .fork-form-card {
    position: relative;
    padding: clamp(20px, 3vw, 28px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .fork-form-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .fork-form-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: #c5b3ff;
    border: 1px solid rgba(140,109,255,0.40);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
  }
  .fork-form-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
    margin: 0;
  }
  .fork-form-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 var(--space-3);
    line-height: 1.55;
  }
  .fork-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--space-3); }
  .fork-field-label {
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 600;
  }
  .fork-dest-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .fork-dest-avatar {
    width: 28px; height: 28px;
    border-radius: 50%;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
    flex-shrink: 0;
  }
  .fork-dest-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    color: var(--text-strong);
  }
  .fork-dest-slash {
    color: var(--text-muted);
    font-family: var(--font-mono);
    margin: 0 2px;
  }
  .fork-dest-repo {
    font-family: var(--font-mono);
    font-size: 13.5px;
    color: var(--text);
  }
  .fork-dest-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 6px;
  }

  /* ─── Banners ─── */
  .fork-banner {
    position: relative;
    padding: 12px 16px 12px 40px;
    margin-bottom: var(--space-4);
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    font-size: 14px;
    line-height: 1.5;
  }
  .fork-banner::before {
    content: '';
    position: absolute;
    left: 14px; top: 16px;
    width: 12px; height: 12px;
    border-radius: 50%;
  }
  .fork-banner-warn {
    border-color: rgba(251, 191, 36, 0.32);
    background: linear-gradient(180deg, rgba(251,191,36,0.06) 0%, var(--bg-elevated) 100%);
  }
  .fork-banner-warn::before {
    background: radial-gradient(circle, #fbbf24 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(251,191,36,0.5);
  }
  .fork-banner-error {
    border-color: rgba(248, 81, 73, 0.32);
    background: linear-gradient(180deg, rgba(248,81,73,0.06) 0%, var(--bg-elevated) 100%);
  }
  .fork-banner-error::before {
    background: radial-gradient(circle, #f85149 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(248,81,73,0.5);
  }
  .fork-banner a { color: var(--accent); text-decoration: none; }
  .fork-banner a:hover { text-decoration: underline; }

  /* ─── Actions ─── */
  .fork-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-4);
    flex-wrap: wrap;
  }
  .fork-submit {
    appearance: none;
    border: 1px solid rgba(140,109,255,0.45);
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    padding: 12px 22px;
    border-radius: 10px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    box-shadow: 0 10px 24px -10px rgba(140,109,255,0.55);
    transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease;
  }
  .fork-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 14px 28px -10px rgba(140,109,255,0.7);
    filter: brightness(1.06);
  }
  .fork-submit:focus-visible {
    outline: 3px solid rgba(140,109,255,0.45);
    outline-offset: 2px;
  }
  .fork-submit:disabled {
    cursor: not-allowed;
    filter: grayscale(0.6) brightness(0.8);
    box-shadow: none;
  }
  .fork-cancel {
    font-size: 13.5px;
    color: var(--text-muted);
    text-decoration: none;
  }
  .fork-cancel:hover { color: var(--text-strong); }

  /* ─── Empty state (zero state when invalid source) ─── */
  .fork-empty {
    position: relative;
    padding: 48px 24px;
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .fork-empty-orb {
    position: absolute;
    inset: -40% 25% auto 25%;
    width: 50%; height: 240px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), transparent 65%);
    filter: blur(60px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .fork-empty-inner { position: relative; z-index: 1; }
  .fork-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.014em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .fork-empty-desc {
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 0 var(--space-3);
  }
`;

// ─── GET — confirmation form ───────────────────────────────────────────────
// Preserves the existing POST contract; this just gives users a polished
// confirmation surface before firing. The existing inline button on the
// repo header is untouched and still posts straight through.
fork.get("/:owner/:repo/fork", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;

  // Resolve source repo for the card
  const [sourceOwner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);

  const sourceRepo = sourceOwner
    ? (
        await db
          .select()
          .from(repositories)
          .where(
            and(
              eq(repositories.ownerId, sourceOwner.id),
              eq(repositories.name, repoName)
            )
          )
          .limit(1)
      )[0]
    : null;

  // Zero state — invalid source
  if (!sourceOwner || !sourceRepo || !(await repoExists(ownerName, repoName))) {
    return c.html(
      <Layout title="Fork repository" user={user}>
        <style dangerouslySetInnerHTML={{ __html: forkStyles }} />
        <div class="fork-wrap">
          <div class="fork-empty">
            <div class="fork-empty-orb" aria-hidden="true" />
            <div class="fork-empty-inner">
              <h1 class="fork-empty-title">
                {ownerName}/{repoName} can't be forked
              </h1>
              <p class="fork-empty-desc">
                Either the repository doesn't exist or it's no longer
                available. Try browsing repositories you can fork.
              </p>
              <a href="/explore" class="fork-submit">Explore repositories</a>
            </div>
          </div>
        </div>
      </Layout>,
      404
    );
  }

  // Owner forking own repo
  const isSelf = ownerName === user.username;
  // Already forked
  const alreadyForked = !isSelf && (await repoExists(user.username, repoName));

  const avatarLetter = (user.username || "?").charAt(0).toUpperCase();

  return c.html(
    <Layout
      title={`Fork ${ownerName}/${repoName}`}
      user={user}
    >
      <style dangerouslySetInnerHTML={{ __html: forkStyles }} />
      <div class="fork-wrap">
        {/* ─── Hero ─── */}
        <div class="fork-hero">
          <div class="fork-hero-orb" aria-hidden="true" />
          <div class="fork-hero-inner">
            <div class="fork-eyebrow">
              <span class="fork-eyebrow-dot" aria-hidden="true" />
              <strong>Fork</strong> · copy to your account
            </div>
            <h1 class="fork-title">
              Fork{" "}
              <span class="fork-title-grad">{ownerName}/{repoName}</span>.
            </h1>
            <p class="fork-sub">
              We'll make a private copy under <strong>{user.username}</strong>.
              All branches and history carry over; gates, AI review, and
              auto-merge are wired up the moment the fork is ready.
            </p>
          </div>
        </div>

        {/* ─── Source repo card ─── */}
        <div class="fork-source-card">
          <div class="fork-source-icon" aria-hidden="true">
            {(sourceRepo.name || "?").charAt(0).toUpperCase()}
          </div>
          <div class="fork-source-body">
            <div class="fork-source-eyebrow">Source</div>
            <a
              class="fork-source-name"
              href={`/${ownerName}/${repoName}`}
            >
              {ownerName}/{repoName}
            </a>
            {sourceRepo.description && (
              <p class="fork-source-desc" title={sourceRepo.description}>
                {sourceRepo.description}
              </p>
            )}
          </div>
        </div>

        {/* ─── Conflict banners ─── */}
        {isSelf && (
          <div class="fork-banner fork-banner-warn" role="alert">
            You can't fork your own repository. Browse{" "}
            <a href="/explore">other repositories</a> instead.
          </div>
        )}
        {alreadyForked && (
          <div class="fork-banner fork-banner-warn" role="alert">
            You already have a fork at{" "}
            <a href={`/${user.username}/${repoName}`}>
              {user.username}/{repoName}
            </a>
            .
          </div>
        )}

        {/* ─── Destination + submit ─── */}
        <div class="fork-form-card">
          <div class="fork-form-head">
            <span class="fork-form-badge" aria-hidden="true">1</span>
            <h2 class="fork-form-title">Destination</h2>
          </div>
          <p class="fork-form-sub">
            v1 forks always land under your personal account. Org
            destinations coming soon.
          </p>
          <div class="fork-field">
            <span class="fork-field-label">Owner</span>
            <div class="fork-dest-row">
              <span class="fork-dest-avatar" aria-hidden="true">
                {avatarLetter}
              </span>
              <span class="fork-dest-name">{user.username}</span>
              <span class="fork-dest-slash" aria-hidden="true">/</span>
              <span class="fork-dest-repo">{repoName}</span>
            </div>
            <p class="fork-dest-hint">
              The fork will live at{" "}
              <strong>{user.username}/{repoName}</strong>.
            </p>
          </div>

          <form
            method="post"
            action={`/${ownerName}/${repoName}/fork`}
          >
            <div class="fork-actions">
              <button
                type="submit"
                class="fork-submit"
                disabled={isSelf || alreadyForked}
              >
                {alreadyForked ? "Already forked" : "Create my fork"}
              </button>
              <a href={`/${ownerName}/${repoName}`} class="fork-cancel">
                Cancel
              </a>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  );
});

// Fork a repository
fork.post("/:owner/:repo/fork", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;

  // Can't fork your own repo
  if (ownerName === user.username) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }

  // Check source exists
  if (!(await repoExists(ownerName, repoName))) {
    return c.redirect(`/${ownerName}/${repoName}`);
  }

  // Check if already forked
  if (await repoExists(user.username, repoName)) {
    return c.redirect(`/${user.username}/${repoName}`);
  }

  // Get source repo from DB
  const [sourceOwner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!sourceOwner) return c.redirect(`/${ownerName}/${repoName}`);

  const [sourceRepo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerId, sourceOwner.id),
        eq(repositories.name, repoName)
      )
    )
    .limit(1);
  if (!sourceRepo) return c.redirect(`/${ownerName}/${repoName}`);

  // Clone the bare repo
  const sourcePath = getRepoPath(ownerName, repoName);
  const destPath = join(config.gitReposPath, user.username, `${repoName}.git`);

  const proc = Bun.spawn(["git", "clone", "--bare", sourcePath, destPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  // Insert into DB
  const [newRepo] = await db
    .insert(repositories)
    .values({
      name: repoName,
      ownerId: user.id,
      description: sourceRepo.description
        ? `Fork of ${ownerName}/${repoName} — ${sourceRepo.description}`
        : `Fork of ${ownerName}/${repoName}`,
      isPrivate: false,
      defaultBranch: sourceRepo.defaultBranch,
      diskPath: destPath,
      forkedFromId: sourceRepo.id,
    })
    .returning();

  // Bootstrap the fork with green-by-default settings, protection, labels
  if (newRepo) {
    const { bootstrapRepository } = await import("../lib/repo-bootstrap");
    await bootstrapRepository({
      repositoryId: newRepo.id,
      ownerUserId: user.id,
      defaultBranch: sourceRepo.defaultBranch,
      skipWelcomeIssue: true, // forks don't need a welcome issue
    });
  }

  // Update fork count
  await db
    .update(repositories)
    .set({ forkCount: sourceRepo.forkCount + 1 })
    .where(eq(repositories.id, sourceRepo.id));

  // Log activity
  try {
    await db.insert(activityFeed).values({
      repositoryId: sourceRepo.id,
      userId: user.id,
      action: "fork",
      metadata: JSON.stringify({ forkOwner: user.username }),
    });
  } catch {
    // best effort
  }

  return c.redirect(`/${user.username}/${repoName}`);
});

export default fork;
