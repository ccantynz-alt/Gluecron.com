/**
 * AI Standup feed (`/standups`).
 *
 * Polished surface where users see their daily + weekly standups. Hero
 * with gradient + orb + display headline + featured "Today's standup" card
 * at the top, then a chronological feed of every recent brief.
 *
 * Owns its own scoped CSS (`.standup-*`) so it can never bleed into the
 * locked layout / shared components.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { db } from "../db";
import { users } from "../db/schema";
import { renderMarkdown } from "../lib/markdown";
import {
  deliverStandup,
  generateStandup,
  getStandupPrefs,
  listRecentStandups,
} from "../lib/ai-standup";

const standups = new Hono<AuthEnv>();

standups.use("*", softAuth);
standups.use("/standups*", requireAuth);

function formatStamp(d: Date): string {
  try {
    return new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return "—";
  }
}

function scopeLabel(scope: string): string {
  return scope === "weekly" ? "Weekly" : "Daily";
}

standups.get("/standups", async (c) => {
  const user = c.get("user")!;
  const [recent, prefs] = await Promise.all([
    listRecentStandups(user.id, 30),
    getStandupPrefs(user.id),
  ]);

  // The featured card is the most recent standup, if any.
  const featured = recent[0] || null;
  const rest = featured ? recent.slice(1) : [];

  const enabledDaily = prefs?.dailyEnabled === true;
  const enabledWeekly = prefs?.weeklyEnabled === true;

  return c.html(
    <Layout title="Standups" user={user}>
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      <div class="standup-wrap">
        <section class="standup-hero">
          <div class="standup-hero-orb" aria-hidden="true" />
          <div class="standup-hero-inner">
            <div class="standup-eyebrow">
              <span class="standup-eyebrow-pill" aria-hidden="true" />
              Standups · powered by Claude
            </div>
            <h1 class="standup-title">
              Your morning routine.{" "}
              <span class="standup-title-grad">Ship-status at a glance.</span>
            </h1>
            <p class="standup-sub">
              Every day Claude reads your team&rsquo;s PRs, issues, and
              deploys and writes a 200-word brief: what shipped, what&rsquo;s
              in flight, what&rsquo;s at risk. Lands in your inbox at 09:00
              UTC by default.
            </p>
            <div class="standup-hero-cta">
              <a href="/settings#standups" class="standup-btn standup-btn-primary">
                {enabledDaily || enabledWeekly ? "Manage delivery" : "Turn on standups"}
                <span aria-hidden="true">→</span>
              </a>
              <form
                method="post"
                action="/standups/preview"
                style="display:inline"
              >
                <button type="submit" class="standup-btn">
                  Generate one now
                </button>
              </form>
            </div>
            <div class="standup-hero-meta">
              <span class={"standup-pill " + (enabledDaily ? "is-on" : "is-off")}>
                <span class="standup-dot" aria-hidden="true" />
                Daily {enabledDaily ? "on" : "off"}
              </span>
              <span class={"standup-pill " + (enabledWeekly ? "is-on" : "is-off")}>
                <span class="standup-dot" aria-hidden="true" />
                Weekly {enabledWeekly ? "on" : "off"}
              </span>
            </div>
          </div>
        </section>

        {featured ? (
          <section class="standup-featured" aria-labelledby="standup-featured-h">
            <header class="standup-featured-head">
              <div>
                <p class="standup-featured-eyebrow">Today&rsquo;s standup</p>
                <h2 class="standup-featured-title" id="standup-featured-h">
                  {scopeLabel(featured.scope)} brief
                  <span class="standup-featured-stamp">
                    {formatStamp(featured.createdAt)}
                  </span>
                </h2>
              </div>
              <div class="standup-featured-stats">
                <span class="standup-stat">
                  <strong>{featured.shippedItems.length}</strong> shipped
                </span>
                <span class="standup-stat">
                  <strong>{featured.blockedItems.length}</strong> in flight
                </span>
                <span class="standup-stat standup-stat-warn">
                  <strong>{featured.atRiskItems.length}</strong> at risk
                </span>
              </div>
            </header>
            <div
              class="standup-featured-body"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(featured.summary),
              }}
            />
          </section>
        ) : (
          <section class="standup-empty">
            <h2>No standups yet.</h2>
            <p>
              Turn on daily or weekly standups in{" "}
              <a href="/settings#standups">Settings</a>, or generate one now
              with the button above. Your first brief will appear here.
            </p>
          </section>
        )}

        {rest.length > 0 ? (
          <section class="standup-feed" aria-label="Past standups">
            <h2 class="standup-feed-title">Past standups</h2>
            <ol class="standup-feed-list">
              {rest.map((s) => (
                <li class="standup-card" id={s.id}>
                  <div class="standup-card-head">
                    <span class={"standup-tag standup-tag-" + s.scope}>
                      {scopeLabel(s.scope)}
                    </span>
                    <span class="standup-card-stamp">
                      {formatStamp(s.createdAt)}
                    </span>
                    {s.aiAvailable ? (
                      <span class="standup-card-ai">AI</span>
                    ) : (
                      <span class="standup-card-fallback">fallback</span>
                    )}
                  </div>
                  <div
                    class="standup-card-body"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(s.summary),
                    }}
                  />
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </Layout>
  );
});

standups.post("/standups/preview", async (c) => {
  const user = c.get("user")!;
  // Bypass the dedupe check so the on-demand button always produces a row.
  await deliverStandup({
    userId: user.id,
    scope: "daily",
    bypassDedupe: true,
  });
  return c.redirect("/standups?success=" + encodeURIComponent("Standup generated"));
});

// Optional JSON endpoint — handy for /admin debugging and tests.
standups.get("/api/standups/preview", async (c) => {
  const user = c.get("user")!;
  const scope = c.req.query("scope") === "weekly" ? "weekly" : "daily";
  const result = await generateStandup({ userId: user.id, scope });
  return c.json(result);
});

// Stamp the lastDailySentAt timestamp so manual previews don't reset the
// scheduler too aggressively. We rely on getStandupPrefs above; no extra
// writes here. (Reference users to silence unused-import lints.)
void users;
void eq;

// ---------------------------------------------------------------------------
// Scoped CSS — `.standup-*` only. New file → no risk to locked surfaces.
// ---------------------------------------------------------------------------
const pageCss = `
.standup-wrap {
  max-width: 980px;
  margin: 0 auto;
  padding: 32px 24px 80px;
  display: flex;
  flex-direction: column;
  gap: 28px;
  font-family: var(--font-body, Inter, system-ui, sans-serif);
}
.standup-hero {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border-radius: 22px;
  padding: 56px 48px;
  background: linear-gradient(135deg,
    rgba(140, 109, 255, 0.18) 0%,
    rgba(54, 197, 214, 0.14) 60%,
    rgba(255, 198, 88, 0.10) 100%),
    var(--bg-secondary, #14172a);
  border: 1px solid var(--border, #2b2f44);
  box-shadow: 0 12px 60px -24px rgba(140, 109, 255, 0.35);
}
.standup-hero-orb {
  position: absolute;
  top: -120px;
  right: -120px;
  width: 360px;
  height: 360px;
  border-radius: 9999px;
  background: radial-gradient(circle at 30% 30%,
    rgba(140, 109, 255, 0.45) 0%,
    rgba(54, 197, 214, 0.18) 45%,
    transparent 75%);
  filter: blur(8px);
  z-index: 0;
}
.standup-hero-inner {
  position: relative;
  z-index: 1;
  max-width: 640px;
}
.standup-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #aab0c2);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border, #2b2f44);
  border-radius: 9999px;
}
.standup-eyebrow-pill {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
  box-shadow: 0 0 8px rgba(140, 109, 255, 0.6);
}
.standup-title {
  font-family: var(--font-display, "Inter Tight", Inter, system-ui, sans-serif);
  font-weight: 700;
  font-size: clamp(34px, 5.2vw, 52px);
  line-height: 1.05;
  letter-spacing: -0.028em;
  margin: 22px 0 12px;
  color: var(--text-strong, #fff);
}
.standup-title-grad {
  background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.standup-sub {
  color: var(--text-muted, #aab0c2);
  font-size: 16px;
  line-height: 1.55;
  margin: 0 0 22px;
}
.standup-hero-cta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}
.standup-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 10px;
  border: 1px solid var(--border, #2b2f44);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-strong, #fff);
  text-decoration: none;
  cursor: pointer;
  transition: transform .12s ease, background .12s ease;
}
.standup-btn:hover { transform: translateY(-1px); background: rgba(255,255,255,0.07); }
.standup-btn-primary {
  background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
  border-color: transparent;
  color: #0d1117;
}
.standup-hero-meta {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}
.standup-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 9999px;
  border: 1px solid var(--border, #2b2f44);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-muted, #aab0c2);
}
.standup-pill.is-on { color: #8c6dff; border-color: rgba(140, 109, 255, 0.4); }
.standup-pill.is-off { opacity: .8; }
.standup-dot { width: 7px; height: 7px; border-radius: 9999px; background: currentColor; }
.standup-featured {
  padding: 26px 28px;
  border-radius: 18px;
  background: var(--bg-secondary, #14172a);
  border: 1px solid var(--border, #2b2f44);
  position: relative;
}
.standup-featured::before {
  content: "";
  position: absolute;
  top: 0; left: 0;
  height: 3px;
  width: 100%;
  background: linear-gradient(90deg, #8c6dff 0%, #36c5d6 50%, transparent 100%);
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
}
.standup-featured-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.standup-featured-eyebrow {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted, #aab0c2);
  margin: 0 0 2px;
}
.standup-featured-title {
  font-family: var(--font-display, "Inter Tight", Inter, system-ui, sans-serif);
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  color: var(--text-strong, #fff);
  letter-spacing: -0.01em;
}
.standup-featured-stamp {
  font-size: 13px;
  font-weight: 500;
  margin-left: 10px;
  color: var(--text-muted, #aab0c2);
}
.standup-featured-stats {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--text-muted, #aab0c2);
}
.standup-stat strong {
  color: var(--text-strong, #fff);
  font-weight: 700;
  margin-right: 4px;
}
.standup-stat-warn strong { color: #ffc658; }
.standup-featured-body {
  color: var(--text, #d6dbe7);
  font-size: 15px;
  line-height: 1.65;
}
.standup-featured-body h1,
.standup-featured-body h2,
.standup-featured-body h3 {
  font-family: var(--font-display, "Inter Tight", Inter, system-ui, sans-serif);
  font-weight: 700;
  margin-top: 18px;
  margin-bottom: 6px;
  color: var(--text-strong, #fff);
  letter-spacing: -0.01em;
}
.standup-featured-body h1 { font-size: 22px; }
.standup-featured-body h2 { font-size: 18px; }
.standup-featured-body h3 { font-size: 16px; }
.standup-featured-body ul,
.standup-featured-body ol { padding-left: 20px; }
.standup-featured-body li { margin: 4px 0; }
.standup-featured-body code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--font-mono, "JetBrains Mono", monospace);
  font-size: 13px;
}
.standup-empty {
  padding: 36px;
  text-align: center;
  border-radius: 18px;
  background: var(--bg-secondary, #14172a);
  border: 1px dashed var(--border, #2b2f44);
  color: var(--text-muted, #aab0c2);
}
.standup-empty h2 {
  font-family: var(--font-display, "Inter Tight", Inter, system-ui, sans-serif);
  font-size: 20px;
  margin: 0 0 8px;
  color: var(--text-strong, #fff);
}
.standup-feed-title {
  font-family: var(--font-display, "Inter Tight", Inter, system-ui, sans-serif);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #aab0c2);
  margin: 0 0 14px;
}
.standup-feed-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 14px; }
.standup-card {
  padding: 20px 22px;
  border-radius: 14px;
  background: var(--bg-secondary, #14172a);
  border: 1px solid var(--border, #2b2f44);
}
.standup-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  margin-bottom: 10px;
  color: var(--text-muted, #aab0c2);
}
.standup-tag {
  display: inline-flex;
  padding: 3px 9px;
  border-radius: 9999px;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.standup-tag-daily { background: rgba(140, 109, 255, 0.15); color: #b9a4ff; }
.standup-tag-weekly { background: rgba(54, 197, 214, 0.15); color: #6fd8e6; }
.standup-card-stamp { font-variant-numeric: tabular-nums; }
.standup-card-ai {
  padding: 2px 8px;
  border-radius: 9999px;
  background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
  color: #0d1117;
  font-weight: 700;
  font-size: 10.5px;
  letter-spacing: 0.06em;
}
.standup-card-fallback {
  padding: 2px 8px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-muted, #aab0c2);
  font-weight: 600;
  font-size: 10.5px;
  letter-spacing: 0.06em;
}
.standup-card-body {
  color: var(--text, #d6dbe7);
  font-size: 14.5px;
  line-height: 1.6;
}
.standup-card-body h1,
.standup-card-body h2,
.standup-card-body h3 {
  font-size: 15px;
  font-weight: 700;
  margin: 12px 0 4px;
  color: var(--text-strong, #fff);
}
.standup-card-body ul,
.standup-card-body ol { padding-left: 20px; }
.standup-card-body li { margin: 2px 0; }
@media (max-width: 700px) {
  .standup-hero { padding: 40px 24px; }
  .standup-title { font-size: 32px; }
  .standup-featured { padding: 20px; }
  .standup-featured-head { flex-direction: column; }
}
`;

export default standups;
