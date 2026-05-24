/**
 * BLOCK O2 — Shared error page surface (404 / 500 / 403 / 429).
 *
 * One JSX component renders every error surface consistently. Used by:
 *   - `app.notFound` (global 404 fall-through)
 *   - `app.onError` (global 500 catcher — preserves request ID + trace)
 *   - `requireAdmin` middleware (403, via the DB-free standalone renderer)
 *   - Future per-route 429 / 403 helpers (`RateLimitPage`, `ForbiddenPage`)
 *
 * Visual recipe (2026 polish — matches admin-integrations / build-agent-spec):
 *   - Gradient hairline strip across the top (purple→cyan, 2px)
 *   - Soft radial orb in the corner (blurred, low-opacity)
 *   - Large display headline using clamp() + the gradient-text utility
 *   - Plain-English subtitle (no jargon, no stack traces in production)
 *   - Real button links — Home / Explore / Help / Search, picked per code
 *   - Request ID surfaced on 500 so support can trace the failure
 *   - Retry-after timing on 429 so the user knows when to come back
 *
 * Hard rules honoured:
 *   - NO database access (must render when DB is down)
 *   - Reuses existing tokens via Layout (--accent, --bg-elevated, etc.)
 *   - New CSS scoped under `.err-*` (legacy `.error-page-*` classes kept
 *     on the same elements only where existing tests assert against them)
 *   - Dark + light theme both via the same gradient-text utility
 *   - Accessible: role="main", aria-labelledby, polite live region
 */

import type { FC } from "hono/jsx";
import type { User } from "../db/schema";
import { Layout } from "./layout";

export interface ErrorPageSuggestion { href: string; label: string; hint?: string }
export interface ErrorPageProps {
  code: string;
  eyebrow: string;
  title: string;
  body: string;
  requestId?: string;
  user?: User | null;
  suggestions?: ErrorPageSuggestion[];
  primaryCta?: { href: string; label: string };
  secondaryCta?: { href: string; label: string };
  meta?: string;
  trace?: string;
  layoutTitle?: string;
  /** Optional helper paragraph rendered between body + actions. */
  note?: string;
  /** Optional retry-after seconds (used by the 429 surface). */
  retryAfterSeconds?: number;
}

export const ErrorPage: FC<ErrorPageProps> = ({
  code, eyebrow, title, body, requestId, user, suggestions,
  primaryCta, secondaryCta, meta, trace, layoutTitle, note, retryAfterSeconds,
}) => {
  const primary = primaryCta ?? { href: "/", label: "Go home" };
  const secondary = secondaryCta ?? { href: "/status", label: "Status page" };
  return (
    <Layout title={layoutTitle ?? `${code} ${eyebrow}`} user={user ?? null}>
      <main
        class="err-page error-page"
        role="main"
        aria-labelledby="error-page-title"
        data-error-code={code}
      >
        <div class="err-hero">
          <div class="err-orb" aria-hidden="true" />
          <div class="err-hero-inner">
            <div class="err-eyebrow">
              <span class="err-eyebrow-dot" aria-hidden="true" />
              {eyebrow}
            </div>
            <div class="err-code gradient-text error-page-code" aria-hidden="true">
              {code}
            </div>
            <h1 id="error-page-title" class="err-title">{title}</h1>
            <p class="err-body">{body}</p>
            {note && <p class="err-note">{note}</p>}
            <div class="err-actions">
              <a href={primary.href} class="err-btn err-btn-primary" data-error-cta="primary">
                {primary.label}
              </a>
              <a href={secondary.href} class="err-btn err-btn-ghost" data-error-cta="secondary">
                {secondary.label}
              </a>
            </div>
            {suggestions && suggestions.length > 0 && (
              <ul class="err-suggestions" aria-label="Try one of these">
                {suggestions.map((s) => (
                  <li>
                    <a href={s.href}>
                      <span class="err-suggestion-label">{s.label}</span>
                      {s.hint && <span class="err-suggestion-hint">{s.hint}</span>}
                      <span class="err-suggestion-arrow" aria-hidden="true">&rarr;</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <div class="err-meta-block">
              {requestId && (
                <div class="err-meta" aria-live="polite">
                  <span class="err-meta-label">Request ID:</span>
                  <span class="err-meta-value meta-mono">{requestId}</span>
                </div>
              )}
              {typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 && (
                <div class="err-meta">
                  <span class="err-meta-label">Retry after:</span>
                  <span class="err-meta-value meta-mono">
                    {formatRetryAfter(retryAfterSeconds)}
                  </span>
                </div>
              )}
              {meta && (
                <div class="err-meta">
                  <span class="err-meta-label">Request:</span>
                  <span class="err-meta-value meta-mono">{meta}</span>
                </div>
              )}
            </div>
            {trace && (
              <pre class="err-trace error-page-trace" aria-label="Stack trace">
                {trace}
              </pre>
            )}
          </div>
        </div>
      </main>
      <style dangerouslySetInnerHTML={{ __html: errorPageCss }} />
    </Layout>
  );
};

/* ─────────────────────────────────────────────────────────────────────────
 * 404 — Not found. The most common error the user will see.
 *
 * For paths shaped like `/:owner/:repo/...` we add a contextual note: a real
 * class of bugs has landed users on a 404 when they typed `ccantynz-alt`
 * instead of `ccantynz`. Cheap to suggest "double-check the owner/name".
 * ───────────────────────────────────────────────────────────────────── */
export const NotFoundPage: FC<{ user?: User | null; method?: string; path?: string }> = ({ user, method, path }) => {
  const looksLikeRepoPath =
    typeof path === "string" &&
    /^\/[^/]+\/[^/]+(\/.*)?$/.test(path) &&
    !path.startsWith("/api/") &&
    !path.startsWith("/admin/") &&
    !path.startsWith("/static/");
  const note = looksLikeRepoPath
    ? "Looks like a repository URL. Double-check the owner and repo name — a one-character typo (think `ccantynz` vs `ccantynz-alt`) is the most common reason this page shows up."
    : undefined;
  const suggestions: ErrorPageSuggestion[] = [
    { href: "/explore", label: "Explore public repositories", hint: "browse what's trending" },
    { href: "/search", label: "Search across Gluecron", hint: "code, repos, issues, PRs" },
    { href: "/help", label: "Read the quickstart guide", hint: "5-minute tour" },
  ];
  return (
    <ErrorPage
      code="404"
      eyebrow="Not found"
      title="We can't find that page."
      body="The URL might be wrong, the resource might have moved, or you might not have permission to see it."
      user={user}
      note={note}
      primaryCta={{ href: "/", label: "Go home" }}
      secondaryCta={{ href: "/status", label: "Status page" }}
      suggestions={suggestions}
      meta={method && path ? `${method} ${path}` : undefined}
      layoutTitle="Not Found"
    />
  );
};

/* ─────────────────────────────────────────────────────────────────────────
 * 500 — Server error. We surface the Request ID so the user can include it
 * when filing a support issue, and (outside production) the error message
 * for fast local debugging. NEVER show a full stack trace in production.
 * ───────────────────────────────────────────────────────────────────── */
export const ServerErrorPage: FC<{ user?: User | null; requestId?: string; trace?: string }> = ({ user, requestId, trace }) => (
  <ErrorPage
    code="500"
    eyebrow="Server error"
    title="Something went wrong on our end."
    body="The error has been reported and the team has been paged. Try again in a moment — if it persists, include the Request ID below when you file an issue."
    user={user}
    primaryCta={{ href: "/", label: "Go home" }}
    secondaryCta={{ href: "/status", label: "Check status" }}
    suggestions={[
      { href: "/status", label: "Platform status", hint: "live health of every service" },
      { href: "/help", label: "Contact support", hint: "include the Request ID" },
    ]}
    requestId={requestId}
    trace={trace}
    layoutTitle="Error"
  />
);

/* ─────────────────────────────────────────────────────────────────────────
 * 403 — Forbidden. Two flavours: signed-in (need a different account or
 * elevated role) vs signed-out (just sign in). Default copy matches the
 * admin gate so the existing `requireAdmin` middleware looks consistent.
 * ───────────────────────────────────────────────────────────────────── */
export const ForbiddenPage: FC<{ user?: User | null; message?: string }> = ({ user, message }) => {
  const suggestions: ErrorPageSuggestion[] = user
    ? [
        { href: "/logout", label: "Sign in as a different user", hint: "switch accounts" },
        { href: "/help", label: "Read the access docs", hint: "permissions & teams" },
      ]
    : [
        { href: "/login", label: "Sign in", hint: "you might just need to log in" },
        { href: "/help", label: "Read the access docs", hint: "permissions & teams" },
      ];
  return (
    <ErrorPage
      code="403"
      eyebrow="Forbidden"
      title={message ?? "Admin access required."}
      body="You're signed in, but this resource is restricted. If you think this is a mistake, contact a site admin."
      user={user}
      primaryCta={{ href: "/", label: "Go home" }}
      secondaryCta={{ href: "/help", label: "Get help" }}
      suggestions={suggestions}
      layoutTitle="Forbidden"
    />
  );
};

/* ─────────────────────────────────────────────────────────────────────────
 * 429 — Too many requests. The rate-limit middleware currently returns a
 * JSON payload (API-shaped), but we expose this surface for any HTML
 * route that wants to render a friendly throttling page. Surfaces the
 * Retry-After timing so the user knows when to come back.
 * ───────────────────────────────────────────────────────────────────── */
export const RateLimitPage: FC<{ user?: User | null; retryAfterSeconds?: number; requestId?: string }> = ({ user, retryAfterSeconds, requestId }) => (
  <ErrorPage
    code="429"
    eyebrow="Too many requests"
    title="You're going a little too fast."
    body="We rate-limit certain endpoints to keep things responsive for everyone. The bucket refills in a few seconds — wait it out and try again."
    user={user}
    note="If you're hitting this from a script, add a polite delay between calls. Authenticated requests get 4× the anonymous bucket."
    primaryCta={{ href: "/", label: "Go home" }}
    secondaryCta={{ href: "/help", label: "Read the rate-limit docs" }}
    suggestions={[
      { href: "/help", label: "Rate-limit reference", hint: "current caps per endpoint" },
      { href: "/settings/tokens", label: "Create a personal access token", hint: "authed callers get a bigger bucket" },
    ]}
    requestId={requestId}
    retryAfterSeconds={retryAfterSeconds}
    layoutTitle="Rate limited"
  />
);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every new class prefixed `.err-*` so it can't bleed into
 * other surfaces. Two legacy classes (`.error-page-code`, `.error-page-trace`)
 * remain on the same elements so the existing system-states tests keep
 * passing; they just inherit the new visual treatment via .err-* parents.
 *
 * Design tokens reused from the layout:
 *   --accent (#8c6dff), --accent-2 (#36c5d6), --accent-gradient,
 *   --bg-elevated, --border, --border-strong, --border-focus,
 *   --text, --text-strong, --text-muted, --space-*, --font-display,
 *   --font-mono. The gradient-text utility comes from the layout too.
 * ───────────────────────────────────────────────────────────────────── */
export const errorPageCss = `
  .err-page {
    max-width: 760px;
    margin: var(--space-8, 56px) auto var(--space-16, 96px);
    padding: 0 var(--space-4, 24px);
  }

  .err-hero {
    position: relative;
    padding: clamp(28px, 4vw, 56px) clamp(24px, 4vw, 56px) clamp(32px, 4vw, 56px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 20px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 20px 48px -12px rgba(0,0,0,0.45);
  }
  /* Gradient hairline strip across the top — the signature 2026 motif. */
  .err-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  /* Soft radial orb — blurred, low opacity, off the top-right corner.
     Adds atmosphere without competing with the headline. */
  .err-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .err-hero-inner { position: relative; z-index: 1; }

  .err-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 18px;
  }
  .err-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* The display code — 404, 500, etc. */
  .err-code {
    font-family: var(--font-display);
    font-size: clamp(56px, 8vw, 96px);
    line-height: 0.95;
    font-weight: 800;
    letter-spacing: -0.04em;
    margin: 0 0 12px;
    /* Fallback colour for browsers that don't paint -webkit-text-fill-color
       on background-clip:text. The .gradient-text utility (defined in the
       layout) applies the gradient on top. */
    color: var(--accent);
  }

  .err-title {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 700;
    letter-spacing: -0.022em;
    line-height: 1.2;
    margin: 0 0 12px;
    color: var(--text-strong);
  }
  .err-body {
    font-size: 16px;
    line-height: 1.6;
    color: var(--text-muted);
    max-width: 560px;
    margin: 0 0 16px;
  }
  .err-note {
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
    max-width: 600px;
    margin: 0 0 22px;
    padding: 12px 14px;
    background: rgba(140,109,255,0.06);
    border: 1px solid rgba(140,109,255,0.22);
    border-radius: 10px;
  }

  /* Real button links — primary + ghost. We deliberately don't reuse
     .btn from the layout because it's redefined in a dozen places; a
     local pair keeps the error surface visually self-contained. */
  .err-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin: 22px 0 28px;
  }
  .err-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 11px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease;
    line-height: 1;
  }
  .err-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .err-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .err-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong, var(--border));
  }
  .err-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* Suggestion list — each row is a full-width link with hover tint. */
  .err-suggestions {
    list-style: none;
    padding: 0;
    margin: 0 0 24px;
    border-top: 1px solid var(--border);
  }
  .err-suggestions li { margin: 0; }
  .err-suggestions a {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 4px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
    transition: padding-left 120ms ease, color 120ms ease;
  }
  .err-suggestions a:hover {
    padding-left: 8px;
    color: var(--text-strong);
    text-decoration: none;
  }
  .err-suggestion-label {
    font-size: 14.5px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .err-suggestion-hint {
    flex: 1;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .err-suggestion-arrow {
    font-size: 14px;
    color: var(--accent);
    transition: transform 120ms ease;
  }
  .err-suggestions a:hover .err-suggestion-arrow { transform: translateX(3px); }

  .err-meta-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
  }
  .err-meta {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .err-meta-label {
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--text-muted);
  }
  .err-meta-value,
  .err-page .meta-mono {
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 12px;
    color: var(--text);
  }

  .err-trace {
    text-align: left;
    margin: 22px 0 0;
    padding: 14px 16px;
    background: rgba(0,0,0,0.28);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text-muted);
    overflow-x: auto;
    max-width: 100%;
    white-space: pre-wrap;
  }

  /* Light-theme adjustments — orb + note tint look heavy on white. */
  :root[data-theme='light'] .err-hero {
    box-shadow: 0 1px 0 rgba(0,0,0,0.02), 0 12px 36px -10px rgba(15,16,28,0.10);
  }
  :root[data-theme='light'] .err-orb {
    background: radial-gradient(circle, rgba(109,77,255,0.16), rgba(8,145,178,0.08) 45%, transparent 70%);
  }
  :root[data-theme='light'] .err-meta-value,
  :root[data-theme='light'] .err-page .meta-mono {
    background: rgba(15,16,28,0.04);
  }
  :root[data-theme='light'] .err-trace {
    background: rgba(15,16,28,0.04);
  }

  @media (max-width: 540px) {
    .err-page { margin: 24px auto 56px; }
    .err-hero { padding: 24px 20px 28px; border-radius: 16px; }
    .err-actions .err-btn { flex: 1 1 auto; }
  }
`;

function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Standalone (DB-free) renderer — used by `requireAdmin` middleware so
 * the 403 page renders even when the DB / Layout is unavailable. Returns
 * a complete <!doctype html> document with inline styles. Mirrors the
 * `.err-*` visual treatment so the 403 doesn't look like a different
 * product than the rest of the surface.
 * ───────────────────────────────────────────────────────────────────── */
export function renderStandaloneErrorPage(opts: {
  code: string; eyebrow: string; title: string; body: string;
  requestId?: string; signedIn?: boolean;
}): string {
  const { code, eyebrow, title, body, requestId, signedIn } = opts;
  const suggestionsHtml = signedIn
    ? `<li><a href="/logout"><span class="err-suggestion-label">Sign in as a different user</span><span class="err-suggestion-hint">switch accounts</span><span class="err-suggestion-arrow" aria-hidden="true">&rarr;</span></a></li>
       <li><a href="/help"><span class="err-suggestion-label">Read the access docs</span><span class="err-suggestion-hint">permissions &amp; teams</span><span class="err-suggestion-arrow" aria-hidden="true">&rarr;</span></a></li>`
    : `<li><a href="/login"><span class="err-suggestion-label">Sign in</span><span class="err-suggestion-hint">you might just need to log in</span><span class="err-suggestion-arrow" aria-hidden="true">&rarr;</span></a></li>
       <li><a href="/help"><span class="err-suggestion-label">Read the access docs</span><span class="err-suggestion-hint">permissions &amp; teams</span><span class="err-suggestion-arrow" aria-hidden="true">&rarr;</span></a></li>`;
  const requestIdHtml = requestId
    ? `<div class="err-meta-block"><div class="err-meta" aria-live="polite"><span class="err-meta-label">Request ID:</span><span class="err-meta-value meta-mono">${escapeHtml(requestId)}</span></div></div>`
    : "";
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(code)} ${escapeHtml(eyebrow)}</title>
<style>
:root {
  --bg:#0a0b14; --bg-elevated:#0f111a; --text:#e6edf3; --text-strong:#f7f7fb; --text-muted:#8b949e;
  --border:rgba(255,255,255,0.08); --border-strong:rgba(255,255,255,0.13);
  --accent:#8c6dff; --accent-2:#36c5d6;
  --font-display:'Inter Tight','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
}
html,body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; margin:0; padding:0; min-height:100vh; }
body::before {
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
  background:
    radial-gradient(70% 55% at 85% -20%, rgba(140,109,255,0.07), transparent 65%),
    radial-gradient(55% 45% at -10% 115%, rgba(54,197,214,0.05), transparent 65%);
}
.err-page { position:relative; z-index:1; max-width:760px; margin:56px auto 96px; padding:0 24px; }
.err-hero {
  position:relative; padding:clamp(28px,4vw,56px) clamp(24px,4vw,56px) clamp(32px,4vw,56px);
  background:var(--bg-elevated); border:1px solid var(--border); border-radius:20px; overflow:hidden;
  box-shadow:0 1px 0 rgba(255,255,255,0.04), 0 20px 48px -12px rgba(0,0,0,0.45);
}
.err-hero::before {
  content:''; position:absolute; top:0; left:0; right:0; height:2px;
  background:linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
  opacity:0.75;
}
.err-orb {
  position:absolute; inset:-30% -15% auto auto; width:460px; height:460px;
  background:radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
  filter:blur(80px); opacity:0.75; z-index:0;
}
.err-hero-inner { position:relative; z-index:1; }
.err-eyebrow {
  display:inline-flex; align-items:center; gap:8px; text-transform:uppercase;
  font-family:var(--font-mono); font-size:11px; letter-spacing:0.18em;
  color:var(--text-muted); font-weight:600; margin-bottom:18px;
}
.err-eyebrow-dot {
  width:8px; height:8px; border-radius:9999px;
  background:linear-gradient(135deg,#8c6dff,#36c5d6);
  box-shadow:0 0 0 3px rgba(140,109,255,0.18);
}
.err-code {
  font-family:var(--font-display); font-size:clamp(56px,8vw,96px); line-height:0.95;
  font-weight:800; letter-spacing:-0.04em; margin:0 0 12px;
  background:linear-gradient(135deg,#a855f7 0%,#06b6d4 100%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;
}
.err-title { font-family:var(--font-display); font-size:clamp(22px,3vw,30px); font-weight:700; letter-spacing:-0.022em; line-height:1.2; margin:0 0 12px; color:var(--text-strong); }
.err-body { font-size:16px; line-height:1.6; color:var(--text-muted); max-width:560px; margin:0 0 16px; }
.err-actions { display:flex; gap:10px; flex-wrap:wrap; margin:22px 0 28px; }
.err-btn { display:inline-flex; align-items:center; justify-content:center; padding:11px 20px; border-radius:10px; font-size:14px; font-weight:600; text-decoration:none; border:1px solid transparent; line-height:1; transition:transform 120ms ease, box-shadow 120ms ease, background 120ms ease; }
.err-btn-primary { background:linear-gradient(135deg,#8c6dff 0%,#36c5d6 100%); color:#fff; box-shadow:0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16); }
.err-btn-primary:hover { transform:translateY(-1px); }
.err-btn-ghost { background:transparent; color:var(--text); border-color:var(--border-strong); }
.err-btn-ghost:hover { background:rgba(140,109,255,0.06); border-color:rgba(140,109,255,0.45); }
.err-suggestions { list-style:none; padding:0; margin:0 0 24px; border-top:1px solid var(--border); }
.err-suggestions a { display:flex; align-items:baseline; gap:10px; padding:12px 4px; border-bottom:1px solid var(--border); color:var(--text); text-decoration:none; transition:padding-left 120ms ease; }
.err-suggestions a:hover { padding-left:8px; color:var(--text-strong); }
.err-suggestion-label { font-size:14.5px; font-weight:600; color:var(--text-strong); }
.err-suggestion-hint { flex:1; font-size:12.5px; color:var(--text-muted); }
.err-suggestion-arrow { font-size:14px; color:var(--accent); }
.err-meta-block { display:flex; flex-direction:column; gap:8px; margin-top:4px; }
.err-meta { display:inline-flex; align-items:center; gap:10px; font-size:12.5px; color:var(--text-muted); flex-wrap:wrap; }
.err-meta-label { text-transform:uppercase; letter-spacing:0.14em; font-size:10.5px; font-weight:700; color:var(--text-muted); }
.err-meta-value, .meta-mono { font-family:var(--font-mono); background:rgba(255,255,255,0.04); border:1px solid var(--border); border-radius:6px; padding:3px 8px; font-size:12px; color:var(--text); }
@media (max-width:540px) {
  .err-page { margin:24px auto 56px; }
  .err-hero { padding:24px 20px 28px; border-radius:16px; }
}
</style>
</head>
<body>
<main class="err-page" role="main" aria-labelledby="error-page-title" data-error-code="${escapeHtml(code)}">
  <div class="err-hero">
    <div class="err-orb" aria-hidden="true"></div>
    <div class="err-hero-inner">
      <div class="err-eyebrow"><span class="err-eyebrow-dot" aria-hidden="true"></span>${escapeHtml(eyebrow)}</div>
      <div class="err-code" aria-hidden="true">${escapeHtml(code)}</div>
      <h1 id="error-page-title" class="err-title">${escapeHtml(title)}</h1>
      <p class="err-body">${escapeHtml(body)}</p>
      <div class="err-actions">
        <a href="/" class="err-btn err-btn-primary" data-error-cta="primary">Go home</a>
        <a href="/status" class="err-btn err-btn-ghost" data-error-cta="secondary">Status page</a>
      </div>
      <ul class="err-suggestions" aria-label="Try one of these">${suggestionsHtml}</ul>
      ${requestIdHtml}
    </div>
  </div>
</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
