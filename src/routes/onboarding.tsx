/**
 * Onboarding flow — guided setup for new users.
 *
 * Goal: get a fresh user from 0 to first repo in <60 seconds.
 * Headline + 1-line value prop + 4 concrete numbered step cards +
 * skip-to-dashboard. 2026 polish — gradient hairline hero, orb, eyebrow,
 * gradient verb in the headline, numbered step cards. All scoped under
 * `.onb-*`.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { repositories, sshKeys, apiTokens } from "../db/schema";
import { config } from "../lib/config";

const onboardingRoutes = new Hono<AuthEnv>();

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.onb-` so this surface can't bleed
 * into other pages. Mirrors the gradient-hairline hero + section card
 * patterns from admin-integrations.tsx, admin-ops.tsx, error-page.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .onb-wrap { max-width: 1000px; margin: 0 auto; padding: var(--space-6, 32px) var(--space-4, 24px); }

  /* ─── Hero ─── */
  .onb-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 48px) clamp(24px, 4vw, 48px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .onb-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .onb-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .onb-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .onb-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 16px;
  }
  .onb-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .onb-eyebrow strong { color: var(--accent); font-weight: 600; letter-spacing: 0.04em; }
  .onb-title {
    font-family: var(--font-display);
    font-size: clamp(32px, 5vw, 48px);
    font-weight: 800;
    letter-spacing: -0.030em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .onb-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .onb-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 600px;
  }

  /* ─── Welcome banner ─── */
  .onb-welcome {
    margin-bottom: var(--space-5);
    padding: 14px 18px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(140,109,255,0.16), rgba(54,197,214,0.10));
    border: 1px solid rgba(140,109,255,0.40);
    font-size: 14px;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .onb-welcome-spark {
    width: 10px; height: 10px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.18);
    flex-shrink: 0;
  }

  /* ─── Step cards grid ─── */
  .onb-steps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .onb-step {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
  }
  .onb-step:hover {
    border-color: rgba(140,109,255,0.45);
    transform: translateY(-2px);
    box-shadow: 0 10px 28px -10px rgba(140,109,255,0.30);
  }
  .onb-step.is-done {
    border-color: rgba(52,211,153,0.40);
    background: linear-gradient(180deg, rgba(52,211,153,0.04), var(--bg-elevated) 60%);
  }
  .onb-step-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .onb-step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px; height: 30px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: #c5b3ff;
    border: 1px solid rgba(140,109,255,0.40);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    flex-shrink: 0;
  }
  .onb-step.is-done .onb-step-num {
    background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
    color: #062b1f;
    border-color: rgba(52,211,153,0.55);
  }
  .onb-step-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px; height: 30px;
    border-radius: 9px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    margin-left: auto;
    flex-shrink: 0;
  }
  .onb-step-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
    letter-spacing: -0.012em;
  }
  .onb-step-desc {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    flex: 1;
  }
  .onb-step-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }
  .onb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
  }
  .onb-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 16px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .onb-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 22px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .onb-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong, var(--border));
  }
  .onb-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .onb-skip {
    background: transparent;
    color: var(--text-muted);
    border: none;
    padding: 6px 4px;
    font-size: 12px;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 3px;
  }
  .onb-skip:hover { color: var(--text); text-decoration-style: solid; }
  .onb-step-done-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .onb-step-done-badge .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }

  /* ─── Push snippet card ─── */
  .onb-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .onb-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .onb-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.014em;
  }
  .onb-section-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .onb-section-body { padding: var(--space-4) var(--space-5); }
  .onb-code {
    margin: 0;
    padding: 14px 16px;
    background: var(--bg-secondary, rgba(0,0,0,0.20));
    border: 1px solid var(--border-subtle, var(--border));
    border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--text);
    overflow-x: auto;
    white-space: pre;
  }

  /* ─── Empty / "all done" celebration ─── */
  .onb-empty {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(20px, 4vw, 40px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed rgba(140,109,255,0.40);
    border-radius: 16px;
    overflow: hidden;
  }
  .onb-empty-orb {
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(52,211,153,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(60px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .onb-empty-inner { position: relative; z-index: 1; }
  .onb-empty-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.12));
    color: #c5b3ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
    margin-bottom: 14px;
  }
  .onb-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 8px;
    color: var(--text-strong);
    letter-spacing: -0.018em;
  }
  .onb-empty-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0 auto 18px;
    max-width: 480px;
    line-height: 1.55;
  }
  .onb-empty-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
  }

  /* ─── Skip + help foot ─── */
  .onb-foot {
    text-align: center;
    padding: var(--space-3) 0 var(--space-6);
    color: var(--text-muted);
    font-size: 13px;
  }
  .onb-foot a { color: var(--accent); text-decoration: none; }
  .onb-foot a:hover { text-decoration: underline; }
  .onb-foot-kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    padding: 1px 6px;
    margin: 0 2px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.04);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
  }
`;

/* Inline SVG icons used in the step cards. Small, monochrome, currentColor. */
function IconConnect() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}
function IconImport() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
function IconRun() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}
function IconShip() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}
function IconKey() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}
function IconToken() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function IconSparkle() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    </svg>
  );
}

// P3 — `/onboarding` is the canonical post-register landing. Alias the
// existing `/getting-started` handler so both URLs work; new users hit
// /onboarding?welcome=1 and see a celebration banner.
const gettingStartedHandler = async (c: any) => {
  const user = c.get("user")!;
  const welcome = c.req.query("welcome") === "1";

  // Check what the user has done
  let repoCount = 0;
  let hasKeys = false;
  let hasTokens = false;

  try {
    const [repos] = await db
      .select({ count: sql<number>`count(*)` })
      .from(repositories)
      .where(eq(repositories.ownerId, user.id));
    repoCount = repos?.count ?? 0;

    const [keys] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sshKeys)
      .where(eq(sshKeys.userId, user.id));
    hasKeys = (keys?.count ?? 0) > 0;

    const [tokens] = await db
      .select({ count: sql<number>`count(*)` })
      .from(apiTokens)
      .where(eq(apiTokens.userId, user.id));
    hasTokens = (tokens?.count ?? 0) > 0;
  } catch { /* DB may not be ready */ }

  const firstRun = repoCount === 0;
  const allDone = repoCount > 0 && hasKeys && hasTokens;

  // The 4 steps. For new users: Connect / Import / Run / Ship.
  // For existing users with some setup, mark completed cards as done.
  const steps = firstRun
    ? [
        {
          n: 1,
          title: "Create a repository",
          desc: "Green-ecosystem defaults, branch protection, labels, CODEOWNERS — wired on day one.",
          cta: { href: "/new", label: "Create repo", primary: true },
          skip: null,
          icon: <IconConnect />,
          done: false,
        },
        {
          n: 2,
          title: "Import from GitHub",
          desc: "Mirror an existing repo by URL. History, branches, and tags come across on the first sync.",
          cta: { href: "/import", label: "Import repo", primary: false },
          skip: { href: "/dashboard", label: "Skip" },
          icon: <IconImport />,
          done: false,
        },
        {
          n: 3,
          title: "Run the gates",
          desc: "Push a commit and watch GateTest, AI review, and CI run automatically.",
          cta: { href: "/explore", label: "Browse repos", primary: false },
          skip: { href: "/dashboard", label: "Skip" },
          icon: <IconRun />,
          done: false,
        },
        {
          n: 4,
          title: "Ship to production",
          desc: "Configure auto-merge + deploy webhooks. Your push lands live in ~25 seconds.",
          cta: { href: "/help", label: "Read the guide", primary: false },
          skip: { href: "/dashboard", label: "Skip" },
          icon: <IconShip />,
          done: false,
        },
      ]
    : [
        {
          n: 1,
          title: "Your repositories",
          desc: `You have ${repoCount} repositor${repoCount === 1 ? "y" : "ies"}. Push code, open issues, review PRs.`,
          cta: { href: "/dashboard", label: "Open dashboard", primary: true },
          skip: null,
          icon: <IconConnect />,
          done: repoCount > 0,
        },
        {
          n: 2,
          title: hasKeys ? "SSH key added" : "Add an SSH key",
          desc: hasKeys
            ? "Push without entering a password every time."
            : "Generate a public key on your machine and paste it in to push without a password.",
          cta: hasKeys
            ? { href: "/settings/keys", label: "Manage keys", primary: false }
            : { href: "/settings/keys", label: "Add key", primary: true },
          skip: hasKeys ? null : { href: "/dashboard", label: "Skip" },
          icon: <IconKey />,
          done: hasKeys,
        },
        {
          n: 3,
          title: hasTokens ? "API token ready" : "Create an API token",
          desc: hasTokens
            ? "Use it for CI, CLI, and automation — same scopes as the web."
            : "Authenticate scripts, CI, and the CLI. Scoped to your account, revocable any time.",
          cta: hasTokens
            ? { href: "/settings/tokens", label: "Manage tokens", primary: false }
            : { href: "/settings/tokens", label: "Create token", primary: true },
          skip: hasTokens ? null : { href: "/dashboard", label: "Skip" },
          icon: <IconToken />,
          done: hasTokens,
        },
        {
          n: 4,
          title: "Ship to production",
          desc: "Configure auto-merge + deploy webhooks. Your push lands live in ~25 seconds.",
          cta: { href: "/help", label: "Read the guide", primary: false },
          skip: { href: "/dashboard", label: "Skip" },
          icon: <IconShip />,
          done: false,
        },
      ];

  return c.html(
    <Layout title="Getting Started" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="onb-wrap">
        {welcome && (
          <div class="onb-welcome" data-onboarding-welcome="1">
            <span class="onb-welcome-spark" aria-hidden="true" />
            Welcome to Gluecron, <strong>@{user.username}</strong> — let's get you set up.
          </div>
        )}

        {/* ─── Hero ─── */}
        <section class="onb-hero">
          <div class="onb-hero-orb" aria-hidden="true" />
          <div class="onb-hero-inner">
            <div class="onb-eyebrow">
              <span class="onb-eyebrow-dot" aria-hidden="true" />
              Onboarding · <strong>@{user.username}</strong>
            </div>
            <h1 class="onb-title">
              <span class="onb-title-grad">{firstRun ? "Get started." : "Finish setup."}</span>
            </h1>
            <p class="onb-sub">
              Ship safer code with AI-native hosting, automated CI, and push-time
              gates. Four short steps — under a minute end-to-end.
            </p>
          </div>
        </section>

        {/* ─── Numbered step cards ─── */}
        <div class="onb-steps">
          {steps.map((s) => (
            <div class={"onb-step" + (s.done ? " is-done" : "")}>
              <div class="onb-step-head">
                <span class="onb-step-num">{s.done ? "✓" : s.n}</span>
                <span class="onb-step-icon" aria-hidden="true">{s.icon}</span>
              </div>
              <h3 class="onb-step-title">{s.title}</h3>
              <p class="onb-step-desc">{s.desc}</p>
              <div class="onb-step-foot">
                {s.done ? (
                  <span class="onb-step-done-badge">
                    <span class="dot" aria-hidden="true" />
                    Done
                  </span>
                ) : (
                  <a
                    href={s.cta.href}
                    class={"onb-btn " + (s.cta.primary ? "onb-btn-primary" : "onb-btn-ghost")}
                  >
                    {s.cta.label}
                  </a>
                )}
                {s.skip && !s.done && (
                  <a href={s.skip.href} class="onb-skip">
                    {s.skip.label}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* ─── Push snippet (only once the user has at least one repo) ─── */}
        {!firstRun && (
          <section class="onb-section">
            <header class="onb-section-head">
              <h3 class="onb-section-title">Push an existing project</h3>
              <p class="onb-section-sub">
                Add Gluecron as a git remote and push. We'll pick up the history on the first sync.
              </p>
            </header>
            <div class="onb-section-body">
              <pre class="onb-code">{`git remote add gluecron ${config.appBaseUrl}/${user.username}/your-repo.git
git push -u gluecron main`}</pre>
            </div>
          </section>
        )}

        {/* ─── All-done empty state — celebration card ─── */}
        {allDone && (
          <section class="onb-empty">
            <div class="onb-empty-orb" aria-hidden="true" />
            <div class="onb-empty-inner">
              <span class="onb-empty-glyph" aria-hidden="true"><IconSparkle /></span>
              <h2 class="onb-empty-title">You're all set.</h2>
              <p class="onb-empty-sub">
                Setup complete. Start building, browsing, or invite a teammate.
              </p>
              <div class="onb-empty-actions">
                <a href="/dashboard" class="onb-btn onb-btn-primary">Open dashboard</a>
                <a href="/explore" class="onb-btn onb-btn-ghost">Discover repos</a>
              </div>
            </div>
          </section>
        )}

        {/* ─── Skip-to-dashboard + help foot ─── */}
        <div class="onb-foot">
          <a href="/dashboard">Skip to dashboard &rarr;</a>
          <div style="margin-top:10px">
            Need help? See the <a href="/api/docs">API docs</a> or press{" "}
            <span class="onb-foot-kbd">?</span> for shortcuts.
          </div>
        </div>
      </div>
    </Layout>
  );
};

onboardingRoutes.get("/getting-started", softAuth, requireAuth, gettingStartedHandler);
onboardingRoutes.get("/onboarding", softAuth, requireAuth, gettingStartedHandler);

export default onboardingRoutes;
