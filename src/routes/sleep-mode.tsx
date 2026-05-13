/**
 * Block L1 — Sleep Mode marketing page.
 *
 * Public, no auth. Pitch: "Toggle Sleep Mode. Walk away. Wake up to a
 * digest of what Claude shipped overnight." Three-step "how it works",
 * a sample digest rendered from a synthetic `SleepModeReport`, and a
 * CTA to /settings.
 */

import { Hono } from "hono";
import { raw } from "hono/html";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  renderSleepModeDigest,
  type SleepModeReport,
} from "../lib/sleep-mode";

const sleepMode = new Hono<AuthEnv>();
sleepMode.use("*", softAuth);

/** A synthetic, on-brand report used to render the sample digest screenshot. */
const SAMPLE_REPORT: SleepModeReport = {
  windowHours: 24,
  prsAutoMerged: [
    { number: 412, title: "Bump axios to 1.7.4", repo: "api-gateway" },
    { number: 88, title: "Fix flaky retry test", repo: "billing" },
    { number: 134, title: "Cache stage results", repo: "workflow-runner" },
  ],
  issuesBuiltByAi: [
    {
      number: 207,
      title: "Add /metrics endpoint with Prometheus format",
      repo: "api-gateway",
      prNumber: 413,
    },
    {
      number: 56,
      title: "Dark-mode toggle in admin nav",
      repo: "dashboard",
      prNumber: 89,
    },
  ],
  aiReviewsPosted: 14,
  securityIssuesAutoFixed: 2,
  gateFailuresAutoRepaired: 5,
  hoursSaved: 7.4,
};

sleepMode.get("/sleep-mode", (c) => {
  const user = c.get("user");
  const sample = renderSleepModeDigest(SAMPLE_REPORT, {
    username: user?.username || "you",
  });
  return c.html(
    <Layout title="Sleep Mode — gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      <div class="sm-root">
        <header class="sm-hero">
          <div class="eyebrow">Sleep Mode</div>
          <h1 class="display sm-hero-title">
            Toggle Sleep Mode. Walk away.{" "}
            <span class="gradient-text">Wake up to a digest.</span>
          </h1>
          <p class="sm-hero-sub">
            Claude keeps your repos shipping while you sleep &mdash;
            auto-merging green PRs, building features from{" "}
            <code>ai:build</code> issues, reviewing code, and quietly fixing
            the gates that fail. Sleep Mode emails you the highlights at the
            UTC hour you pick.
          </p>
          <div class="sm-hero-cta">
            <a href="/settings" class="btn btn-primary btn-lg">
              Enable Sleep Mode in Settings &rarr;
            </a>
            <a href="/settings/sleep-mode/preview" class="btn btn-ghost btn-lg">
              Preview your digest
            </a>
          </div>
        </header>

        <section class="sm-section">
          <div class="section-header">
            <div class="eyebrow">How it works</div>
            <h2>Three steps. Then forget about it.</h2>
          </div>
          <div class="sm-steps">
            <div class="sm-step">
              <div class="sm-step-num">1</div>
              <h3>Flip the toggle</h3>
              <p>
                A single checkbox in <a href="/settings">/settings</a>. Pick
                the UTC hour you want the digest to land &mdash; default is
                9 AM.
              </p>
            </div>
            <div class="sm-step">
              <div class="sm-step-num">2</div>
              <h3>Claude works the night shift</h3>
              <p>
                The autopilot sweeps every 5 minutes. Green PRs get
                auto-merged. <code>ai:build</code> issues become PRs. Gate
                failures get auto-repaired. Security findings get patched.
              </p>
            </div>
            <div class="sm-step">
              <div class="sm-step-num">3</div>
              <h3>Wake up to a digest</h3>
              <p>
                One email. Subject line tells you everything: "while you
                slept, Claude shipped <em>N</em> things". Headlines, links,
                and an estimate of hours saved.
              </p>
            </div>
          </div>
        </section>

        <section class="sm-section">
          <div class="section-header">
            <div class="eyebrow">Sample digest</div>
            <h2>Here&rsquo;s what lands in your inbox.</h2>
            <p>
              A real Sleep Mode digest, rendered from a synthetic report so
              you can see the shape before you turn it on.
            </p>
          </div>
          <div class="sm-sample">
            <div class="sm-sample-frame">
              <div class="sm-sample-meta">
                <span class="sm-sample-from">no-reply@gluecron.app</span>
                <span class="sm-sample-subject">{sample.subject}</span>
              </div>
              <div class="sm-sample-body">{raw(sample.html)}</div>
            </div>
          </div>
        </section>

        <section class="sm-section sm-cta-section">
          <h2>Ready to walk away?</h2>
          <p>
            Sleep Mode is on-by-default safe &mdash; it can&rsquo;t merge
            anything that wouldn&rsquo;t pass your branch protection rules.
            Turn it on, sleep well.
          </p>
          <a href="/settings" class="btn btn-primary btn-lg">
            Enable Sleep Mode &rarr;
          </a>
        </section>
      </div>
    </Layout>
  );
});

const pageCss = `
.sm-root { max-width: 1080px; margin: 0 auto; padding: 48px 24px 80px; }
.sm-hero { text-align: center; padding: 32px 0 48px; }
.sm-hero-title { font-size: clamp(32px, 5vw, 56px); line-height: 1.1; margin: 16px 0 20px; }
.sm-hero-sub { max-width: 640px; margin: 0 auto; color: var(--text-muted); font-size: 17px; line-height: 1.6; }
.sm-hero-cta { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 32px; }
.sm-section { margin: 64px 0; }
.sm-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 24px;
  margin-top: 32px;
}
.sm-step {
  background: var(--accent-gradient-faint);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
}
.sm-step h3 { margin: 16px 0 8px; font-size: 18px; }
.sm-step p { color: var(--text-muted); line-height: 1.55; font-size: 14px; }
.sm-step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 9999px;
  background: var(--accent-gradient);
  color: #fff;
  font-weight: 700;
  font-size: 15px;
}
.sm-sample { margin-top: 24px; display: flex; justify-content: center; }
.sm-sample-frame {
  background: #fff;
  color: #111;
  border-radius: 12px;
  width: 100%;
  max-width: 720px;
  box-shadow: 0 16px 40px rgba(0,0,0,0.25);
  overflow: hidden;
  border: 1px solid var(--border);
}
.sm-sample-meta {
  background: #f6f7fb;
  padding: 12px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px solid #e6e7ed;
  font-size: 13px;
  color: #4a4d59;
}
.sm-sample-from { font-size: 12px; color: #8a8e9c; }
.sm-sample-subject { font-weight: 600; color: #0f1019; }
.sm-sample-body { background: #fff; }
.sm-sample-body > * { /* Sample digest html supplies its own padded body. */ }
.sm-cta-section { text-align: center; padding: 48px 24px; background: var(--accent-gradient-soft); border-radius: 16px; }
.sm-cta-section h2 { font-size: 28px; margin-bottom: 12px; }
.sm-cta-section p { max-width: 520px; margin: 0 auto 24px; color: var(--text-muted); }
`;

export default sleepMode;
