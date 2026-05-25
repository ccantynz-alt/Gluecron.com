/**
 * Block Q3 — Anonymous playground routes.
 *
 * GET  /play         — landing page; one-button start.
 * POST /play         — mint a playground account, set the cookie,
 *                      redirect to the sandbox.
 * GET  /play/claim   — render the "Save your work" form. requireAuth.
 * POST /play/claim   — call claimPlaygroundAccount, redirect to dashboard.
 *
 * POST /play is rate-limited at 3/min/IP via the shared rate-limit
 * middleware so a bot can't hammer the endpoint and mint accounts +
 * repos by the thousand.
 *
 * 2026 polish: gradient-hairline hero + orb, eyebrow + display headline,
 * three explanation cards (what / try / examples) before the start
 * button, polished claim form card with focus rings + gradient submit.
 * All CSS scoped under `.play-*`.
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  Form,
} from "../views/ui";
import { rateLimit } from "../middleware/rate-limit";
import {
  createPlaygroundAccount,
  claimPlaygroundAccount,
  PLAYGROUND_TTL_MS,
} from "../lib/playground";
import { sessionCookieOptions } from "../lib/auth";

const playgroundRoutes = new Hono<AuthEnv>();

// ── 3 req / min / IP cap on POST /play. The shared rate-limit
//    middleware no-ops in test env (so the 1756-test suite isn't fragile)
//    but enforces in prod / dev.
const playgroundCreateRateLimit = rateLimit(3, 60_000, "playground-create");

// ─── Scoped CSS — all classes prefixed `.play-*` ───────────────────────────
const playStyles = `
  .play-wrap { max-width: 980px; margin: 0 auto; padding: var(--space-6, 32px) var(--space-4, 24px); }

  /* ─── Hero ─── */
  .play-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 48px) clamp(24px, 4vw, 48px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .play-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .play-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    animation: playHeroOrb 14s ease-in-out infinite;
    z-index: 0;
  }
  @keyframes playHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.08) translate(-12px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .play-hero-orb { animation: none; }
  }
  .play-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .play-eyebrow {
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
  .play-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .play-eyebrow strong { color: var(--accent); font-weight: 600; letter-spacing: 0.04em; }
  .play-title {
    font-family: var(--font-display);
    font-size: clamp(32px, 5vw, 48px);
    font-weight: 800;
    letter-spacing: -0.030em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .play-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .play-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 600px;
  }

  /* ─── Error banner ─── */
  .play-error {
    position: relative;
    padding: 14px 16px 14px 44px;
    margin-bottom: var(--space-5);
    border-radius: 12px;
    border: 1px solid rgba(248, 81, 73, 0.32);
    background: linear-gradient(180deg, rgba(248,81,73,0.06) 0%, var(--bg-elevated) 100%);
    color: var(--text);
    font-size: 14px;
  }
  .play-error::before {
    content: '';
    position: absolute;
    left: 14px; top: 18px;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: radial-gradient(circle, #f85149 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(248,81,73,0.5);
  }

  /* ─── Explanation cards (what / try / examples) ─── */
  .play-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .play-card {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
  }
  .play-card:hover {
    border-color: rgba(140,109,255,0.45);
    transform: translateY(-2px);
    box-shadow: 0 10px 28px -10px rgba(140,109,255,0.30);
  }
  .play-card-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px; height: 28px;
    border-radius: 8px;
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: #c5b3ff;
    border: 1px solid rgba(140,109,255,0.40);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
  }
  .play-card-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.014em;
    color: var(--text-strong);
    margin: 0;
  }
  .play-card-body {
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }
  .play-card-body code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(140,109,255,0.10);
    color: #c8b6ff;
    padding: 1px 6px;
    border-radius: 5px;
  }

  /* ─── Start panel (big CTA + bullets) ─── */
  .play-start {
    position: relative;
    padding: clamp(24px, 3.5vw, 36px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .play-start::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, #8c6dff 0%, #36c5d6 50%, #8c6dff 100%);
    opacity: 0.65;
    pointer-events: none;
  }
  .play-start-inner {
    display: flex;
    gap: var(--space-5);
    align-items: center;
    flex-wrap: wrap;
  }
  .play-start-text { flex: 1; min-width: 260px; }
  .play-start-eyebrow {
    font-size: 11px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--accent);
    font-weight: 700;
    margin-bottom: 6px;
  }
  .play-start-headline {
    font-family: var(--font-display);
    font-size: clamp(20px, 2.4vw, 26px);
    font-weight: 700;
    letter-spacing: -0.018em;
    line-height: 1.18;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .play-start-desc {
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }
  .play-start-cta { flex-shrink: 0; }
  .play-submit {
    appearance: none;
    border: 1px solid rgba(140,109,255,0.45);
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    padding: 14px 24px;
    border-radius: 12px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 15px;
    letter-spacing: -0.005em;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 8px;
    box-shadow: 0 10px 24px -10px rgba(140,109,255,0.55);
    transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease;
  }
  .play-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 14px 28px -10px rgba(140,109,255,0.7);
    filter: brightness(1.06);
  }
  .play-submit:focus-visible {
    outline: 3px solid rgba(140,109,255,0.45);
    outline-offset: 2px;
  }
  .play-bullets {
    margin: var(--space-4) 0 0;
    padding-left: 20px;
    font-size: 13.5px;
    line-height: 1.7;
    color: var(--text);
  }
  .play-bullets li { margin-bottom: 4px; }
  .play-bullets li strong { color: var(--text-strong); }
  .play-bullets code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(140,109,255,0.10);
    color: #c8b6ff;
    padding: 1px 6px;
    border-radius: 5px;
  }

  /* ─── Footnote ─── */
  .play-footnote {
    text-align: center;
    font-size: 13px;
    color: var(--text-muted);
    margin: var(--space-2) 0 0;
  }
  .play-footnote a { color: var(--accent); text-decoration: none; }
  .play-footnote a:hover { text-decoration: underline; }

  /* ─── Claim form card ─── */
  .play-claim-wrap { max-width: 560px; margin: 0 auto; padding: var(--space-6, 32px) var(--space-4, 24px); }
  .play-claim-card {
    position: relative;
    padding: clamp(24px, 3vw, 32px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .play-claim-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .play-claim-eyebrow {
    font-size: 11px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--accent);
    font-weight: 700;
    margin-bottom: 6px;
  }
  .play-claim-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 28px);
    font-weight: 800;
    letter-spacing: -0.020em;
    line-height: 1.15;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .play-claim-desc {
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 0 var(--space-4);
  }
  .play-claim-desc code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 6px;
    color: var(--text-strong);
  }
  .play-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--space-3); }
  .play-field-label {
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 600;
  }
  .play-field-input {
    appearance: none;
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text-strong);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 14px;
    font-family: inherit;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .play-field-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .play-claim-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
    align-items: center;
    flex-wrap: wrap;
  }
  .play-claim-cancel {
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
  }
  .play-claim-cancel:hover { color: var(--text-strong); }
`;

// ---------------------------------------------------------------------------
// GET /play — landing page
// ---------------------------------------------------------------------------

playgroundRoutes.get("/play", softAuth, (c) => {
  const user = c.get("user");
  const csrf = c.get("csrfToken") as string | undefined;
  const err = c.req.query("error");
  const hours = Math.round(PLAYGROUND_TTL_MS / (60 * 60 * 1000));
  return c.html(
    <Layout
      title="Try Gluecron — no signup"
      user={user ?? null}
      description={`Try Gluecron for ${hours} hours, no signup. Get a sandbox repo and watch Claude work.`}
      ogTitle="Try Gluecron — no signup"
      ogDescription="A 24-hour public sandbox. Push, open issues, watch Claude work."
    >
      <style dangerouslySetInnerHTML={{ __html: playStyles }} />
      <div class="play-wrap">
        {/* ─── Hero ─── */}
        <div class="play-hero">
          <div class="play-hero-orb" aria-hidden="true" />
          <div class="play-hero-inner">
            <div class="play-eyebrow">
              <span class="play-eyebrow-dot" aria-hidden="true" />
              <strong>Playground</strong> · no signup
            </div>
            <h1 class="play-title">
              Try Gluecron for {hours} hours.{" "}
              <span class="play-title-grad">No signup.</span>
            </h1>
            <p class="play-sub">
              One click and you're inside the product — a public sandbox
              repo, real git, real issues, Claude already working on the
              first one. Decide later whether to keep it.
            </p>
          </div>
        </div>

        {err && (
          <div class="play-error" role="alert">
            {decodeURIComponent(err)}
          </div>
        )}

        {/* ─── Explanation cards ─── */}
        <div class="play-cards">
          <div class="play-card">
            <span class="play-card-badge" aria-hidden="true">1</span>
            <h3 class="play-card-title">What you get</h3>
            <p class="play-card-body">
              A fresh public sandbox repo under a temporary{" "}
              <code>guest-*</code> account. Real git, real issues, real
              push — gone after {hours} hours unless you claim it.
            </p>
          </div>
          <div class="play-card">
            <span class="play-card-badge" aria-hidden="true">2</span>
            <h3 class="play-card-title">Try this first</h3>
            <p class="play-card-body">
              Open an issue, label it <code>ai:build</code>, watch the
              autopilot pick it up and open a PR within minutes. Then
              review it like you would any other.
            </p>
          </div>
          <div class="play-card">
            <span class="play-card-badge" aria-hidden="true">3</span>
            <h3 class="play-card-title">Push from your laptop</h3>
            <p class="play-card-body">
              Clone via HTTPS, push commits, watch the gate pipeline run.
              Branch protection, AI review, auto-merge — all live in your
              sandbox.
            </p>
          </div>
        </div>

        {/* ─── Start CTA ─── */}
        <div class="play-start">
          <div class="play-start-inner">
            <div class="play-start-text">
              <div class="play-start-eyebrow">Start the clock</div>
              <h2 class="play-start-headline">
                One click and you're in. No email, no card.
              </h2>
              <p class="play-start-desc">
                We mint a temporary account, spin up your sandbox repo,
                and seed the first issue. Took us about 800ms last test.
              </p>
            </div>
            <div class="play-start-cta">
              <Form
                method="post"
                action="/play"
                csrfToken={csrf}
              >
                <button type="submit" class="play-submit">
                  Start playing &rarr;
                </button>
              </Form>
            </div>
          </div>

          <ul class="play-bullets" aria-label="What you get">
            <li>
              <strong>A sandbox repo</strong> &mdash; public, real git, real
              push, real issues.
            </li>
            <li>
              <strong>Claude is already working</strong> &mdash; one issue
              is labelled <code>ai:build</code> so the autopilot picks it
              up within minutes.
            </li>
            <li>
              <strong>{hours} hours to try every feature</strong> &mdash;
              gates, branch protection, AI review, the lot.
            </li>
            <li>
              <strong>Save your work</strong> &mdash; one button converts
              the playground account into a real one. Otherwise: poof.
            </li>
          </ul>
        </div>

        <p class="play-footnote">
          Already have an account?{" "}
          <a href="/login">Sign in</a> or{" "}
          <a href="/register">create one</a> the normal way.
        </p>
      </div>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /play — mint
// ---------------------------------------------------------------------------

playgroundRoutes.post("/play", playgroundCreateRateLimit, async (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined;
  let result;
  try {
    result = await createPlaygroundAccount({ requestIp: ip });
  } catch (err) {
    // createPlaygroundAccount is supposed to never throw, but if a
    // freshly-deployed migration is missing or anything else goes
    // sideways, fall back to a graceful redirect.
    console.error("[playground] /play POST threw:", err);
    return c.redirect(
      "/play?error=Could+not+create+playground+account.+Try+again."
    );
  }

  if (!result.sessionToken || !result.user.id) {
    return c.redirect(
      "/play?error=Could+not+create+playground+account.+Try+again."
    );
  }

  // 24h cookie matches the playground TTL so the cookie can't outlive
  // the account in the DB. `sessionCookieOptions()` defaults to 30d
  // maxAge; override here.
  const base = sessionCookieOptions();
  setCookie(c, "session", result.sessionToken, {
    ...base,
    maxAge: Math.floor(PLAYGROUND_TTL_MS / 1000),
  });

  return c.redirect(
    `/${result.user.username}/sandbox?welcome=1`
  );
});

// ---------------------------------------------------------------------------
// GET /play/claim — render the "Save your work" form
// ---------------------------------------------------------------------------

playgroundRoutes.get("/play/claim", requireAuth, (c) => {
  const user = c.get("user")!;
  const csrf = c.get("csrfToken") as string | undefined;
  const err = c.req.query("error");

  // Already-real users: bounce home with a hint.
  if (!(user as any).isPlayground) {
    return c.redirect("/dashboard?info=Your+account+is+already+saved");
  }

  return c.html(
    <Layout title="Save your playground" user={user}>
      <style dangerouslySetInnerHTML={{ __html: playStyles }} />
      <div class="play-claim-wrap">
        <div class="play-claim-card">
          <div class="play-claim-eyebrow">Claim your sandbox</div>
          <h1 class="play-claim-title">Save your work</h1>
          <p class="play-claim-desc">
            Convert{" "}
            <code>{user.username}</code>{" "}
            into a permanent account. We'll send a verification link to your
            email; nothing changes about the repo you've been working in.
          </p>
          {err && (
            <div class="play-error" role="alert">
              {decodeURIComponent(err)}
            </div>
          )}
          <Form
            method="post"
            action="/play/claim"
            csrfToken={csrf}
          >
            <div class="play-field">
              <label class="play-field-label" for="email">Email</label>
              <input
                type="email"
                id="email"
                name="email"
                required
                placeholder="you@example.com"
                autocomplete="email"
                aria-label="Email"
                class="play-field-input"
              />
            </div>
            <div class="play-field">
              <label class="play-field-label" for="password">Password</label>
              <input
                type="password"
                id="password"
                name="password"
                required
                minLength={8}
                placeholder="Min 8 characters"
                autocomplete="new-password"
                aria-label="Password"
                class="play-field-input"
              />
            </div>
            <div class="play-field">
              <label class="play-field-label" for="username">
                Pick a new username (optional)
              </label>
              <input
                type="text"
                id="username"
                name="username"
                pattern="^[a-zA-Z0-9_-]+$"
                minLength={2}
                maxLength={39}
                placeholder={user.username}
                autocomplete="username"
                class="play-field-input"
              />
            </div>
            <div class="play-claim-actions">
              <button type="submit" class="play-submit">
                Save my account
              </button>
              <a href={`/${user.username}/sandbox`} class="play-claim-cancel">
                Back to the sandbox
              </a>
            </div>
          </Form>
        </div>
      </div>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /play/claim — convert to real account
// ---------------------------------------------------------------------------

const CLAIM_REASON_TO_MSG: Record<string, string> = {
  invalid_email: "That doesn't look like a valid email.",
  password_too_short: "Password must be at least 8 characters.",
  invalid_username:
    "Usernames may only contain letters, numbers, hyphens and underscores (2–39 chars).",
  email_taken: "That email is already registered.",
  username_taken: "That username is already taken.",
  not_a_playground_account: "Your account is already saved.",
  user_not_found: "Account not found. Please sign in again.",
  lookup_failed: "Service unavailable. Please try again.",
  update_failed: "Service unavailable. Please try again.",
};

playgroundRoutes.post("/play/claim", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const email = String(body.email || "");
  const password = String(body.password || "");
  const usernameRaw = String(body.username || "").trim();

  const result = await claimPlaygroundAccount(user.id, {
    email,
    password,
    username: usernameRaw ? usernameRaw : undefined,
  });

  if (!result.ok) {
    const msg =
      (result.reason && CLAIM_REASON_TO_MSG[result.reason]) ||
      "Could not save account. Try again.";
    return c.redirect(
      `/play/claim?error=${encodeURIComponent(msg)}`
    );
  }

  return c.redirect("/dashboard?info=Account+saved.+Check+your+email+to+verify.");
});

export default playgroundRoutes;
