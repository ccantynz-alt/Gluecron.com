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
 */

import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  Form,
  FormGroup,
  Input,
  Button,
  Text,
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
      <div class="play-landing">
        <div class="play-card">
          <div class="play-eyebrow">PLAYGROUND</div>
          <h1 class="play-title">
            Try Gluecron for {hours} hours.
            <br />
            <span class="play-title-accent">No signup.</span>
          </h1>
          <p class="play-sub">
            One click and you're inside the product — a public sandbox
            repo, real git, real issues, Claude already working on the
            first one. Decide later whether to keep it.
          </p>

          {err && (
            <div class="auth-error" role="alert">
              {decodeURIComponent(err)}
            </div>
          )}

          <Form
            method="post"
            action="/play"
            csrfToken={csrf}
            class="play-form"
          >
            <Button type="submit" variant="primary">
              Start playing &rarr;
            </Button>
          </Form>

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

          <p class="play-footnote">
            Already have an account?{" "}
            <a href="/login">Sign in</a> or{" "}
            <a href="/register">create one</a> the normal way.
          </p>
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: /* css */ `
          .play-landing {
            max-width: 720px;
            margin: 48px auto;
            padding: 0 24px;
          }
          .play-card {
            background: var(--panel, #161b22);
            border: 1px solid var(--border, #30363d);
            border-radius: 16px;
            padding: 40px;
            text-align: center;
          }
          .play-eyebrow {
            font-family: var(--font-mono, ui-monospace, monospace);
            font-size: 11px;
            letter-spacing: 0.18em;
            color: var(--yellow, #fbbf24);
            margin-bottom: 12px;
          }
          .play-title {
            margin: 0 0 16px;
            font-size: 36px;
            line-height: 1.15;
            font-weight: 700;
            color: var(--text-strong, #e6edf3);
          }
          .play-title-accent {
            background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
          }
          .play-sub {
            margin: 0 auto 24px;
            max-width: 480px;
            font-size: 15px;
            line-height: 1.55;
            color: var(--text-muted, #8b949e);
          }
          .play-form {
            margin: 24px 0;
            display: inline-block;
          }
          .play-form button[type="submit"] {
            font-size: 16px;
            padding: 14px 28px;
          }
          .play-bullets {
            margin: 24px auto 0;
            max-width: 520px;
            padding-left: 20px;
            text-align: left;
            font-size: 14px;
            line-height: 1.7;
            color: var(--text, #c9d1d9);
          }
          .play-bullets li { margin-bottom: 6px; }
          .play-bullets code {
            font-family: var(--font-mono, ui-monospace, monospace);
            font-size: 12px;
            padding: 1px 6px;
            border-radius: 4px;
            background: rgba(140,109,255,0.16);
            color: #c8b6ff;
          }
          .play-footnote {
            margin: 24px 0 0;
            font-size: 13px;
            color: var(--text-muted, #8b949e);
          }
        `,
        }}
      />
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
      <div class="auth-container">
        <h2>Save your work</h2>
        <p class="auth-switch" style="margin-bottom: 16px; margin-top: 0">
          Convert{" "}
          <code class="mono">{user.username}</code>{" "}
          into a permanent account. We'll send a verification link to your
          email; nothing is changed about the repo you've been working in.
        </p>
        {err && (
          <div class="auth-error" role="alert">
            {decodeURIComponent(err)}
          </div>
        )}
        <Form
          method="post"
          action="/play/claim"
          csrfToken={csrf}
        >
          <FormGroup label="Email" htmlFor="email">
            <Input
              type="email"
              name="email"
              required
              placeholder="you@example.com"
              autocomplete="email"
              aria-label="Email"
            />
          </FormGroup>
          <FormGroup label="Password" htmlFor="password">
            <Input
              type="password"
              name="password"
              required
              minLength={8}
              placeholder="Min 8 characters"
              autocomplete="new-password"
              aria-label="Password"
            />
          </FormGroup>
          <FormGroup
            label="Pick a new username (optional)"
            htmlFor="username"
          >
            <Input
              type="text"
              name="username"
              pattern="^[a-zA-Z0-9_-]+$"
              minLength={2}
              maxLength={39}
              placeholder={user.username}
              autocomplete="username"
            />
          </FormGroup>
          <Button type="submit" variant="primary">
            Save my account
          </Button>
        </Form>
        <p class="auth-switch">
          <Text>
            Changed your mind?{" "}
            <a href={`/${user.username}/sandbox`}>Back to the sandbox</a>
          </Text>
        </p>
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
