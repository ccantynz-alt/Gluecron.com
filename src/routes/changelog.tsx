/**
 * /changelog — manually curated list of recent platform releases.
 * Public, no auth required.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const changelog = new Hono<AuthEnv>();
changelog.use("*", softAuth);

changelog.get("/changelog", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout
      title="Changelog — gluecron"
      description="What's new in gluecron — recent feature releases, improvements, and platform updates."
      user={user}
    >
      <ChangelogPage />
    </Layout>,
  );
});

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface ChangelogEntry {
  title: string;
  description: string;
}

interface ChangelogMonth {
  month: string;
  entries: ChangelogEntry[];
}

const RELEASES: ChangelogMonth[] = [
  {
    month: "June 2026",
    entries: [
      {
        title: "AI Trio Review",
        description:
          "Three-model parallel PR review running Security, Correctness, and Style passes simultaneously — faster feedback, broader coverage.",
      },
      {
        title: "Spec-to-Live progress UI",
        description:
          "Watch your spec become a merged PR in real time: a live progress stream shows each agent step from spec parse to gate green to merge.",
      },
      {
        title: "Pack-content ruleset enforcement",
        description:
          "Block bad commits at push time with pack-content rulesets — enforce file-size limits, banned extensions, and content patterns before the push lands.",
      },
      {
        title: "Customer deploy targets",
        description:
          "SSH deploy to your own server directly from a merge. Register a server target in repo settings and autopilot handles the rsync.",
      },
      {
        title: "Workflow cache SAVE",
        description:
          "CI runs warm from the second run. Workflow jobs can now persist dependency caches between runs, cutting install time on hot paths by up to 80%.",
      },
      {
        title: "Push Watch",
        description:
          "A pulsing Live indicator appears in the repo header whenever a push is in flight — gate runs, AI review, and deploy status update without a page reload.",
      },
    ],
  },
  {
    month: "May 2026",
    entries: [
      {
        title: "Branch preview URLs with auto-expiry cleanup",
        description:
          "Every PR branch gets an isolated preview URL. Autopilot tears down stale previews 24 hours after the branch is merged or closed.",
      },
      {
        title: "Dashboard AI activity widget",
        description:
          "A compact widget on /dashboard surfaces the last hour of autopilot actions across all your repos — repairs, reviews, deploys, and digest sends at a glance.",
      },
      {
        title: "Health score badge on repo header",
        description:
          "A colour-coded health score (0–100) appears in the repo header, computed from gate pass rate, stale PR count, and recent deploy success.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const ChangelogPage: FC = () => (
  <>
    <style dangerouslySetInnerHTML={{ __html: changelogCss }} />
    <div class="cl-root">
      <header class="cl-hero">
        <div class="cl-hero-inner">
          <p class="cl-eyebrow">Platform updates</p>
          <h1 class="cl-title">What's New in Gluecron</h1>
          <p class="cl-subtitle">
            Recent features, fixes, and improvements shipped to the platform.
          </p>
          <a href="/settings/notifications" class="cl-cta">
            Subscribe to updates &rarr;
          </a>
        </div>
      </header>

      <div class="cl-content">
        {RELEASES.map((rel) => (
          <section class="cl-month" key={rel.month}>
            <h2 class="cl-month-heading">{rel.month}</h2>
            <ul class="cl-entries">
              {rel.entries.map((entry) => (
                <li class="cl-entry" key={entry.title}>
                  <span class="cl-entry-dot" aria-hidden="true" />
                  <div class="cl-entry-body">
                    <strong class="cl-entry-title">{entry.title}</strong>
                    <p class="cl-entry-desc">{entry.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  </>
);

// ---------------------------------------------------------------------------
// Styles (dark-theme aware, uses CSS custom properties from layout.tsx)
// ---------------------------------------------------------------------------

const changelogCss = `
.cl-root {
  max-width: 760px;
  margin: 0 auto;
  padding: 48px 24px 80px;
}

/* Hero */
.cl-hero {
  margin-bottom: 56px;
  text-align: center;
}
.cl-hero-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.cl-eyebrow {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  margin: 0;
}
.cl-title {
  font-size: clamp(28px, 5vw, 40px);
  font-weight: 700;
  color: var(--text-strong);
  margin: 0;
  line-height: 1.2;
}
.cl-subtitle {
  font-size: 16px;
  color: var(--text-muted);
  margin: 0;
  max-width: 520px;
  line-height: 1.6;
}
.cl-cta {
  display: inline-block;
  margin-top: 8px;
  padding: 10px 20px;
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: opacity 0.15s;
}
.cl-cta:hover { opacity: 0.85; text-decoration: none; }

/* Month groups */
.cl-content {
  display: flex;
  flex-direction: column;
  gap: 48px;
}
.cl-month {}
.cl-month-heading {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-strong);
  margin: 0 0 24px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
}

/* Entry list */
.cl-entries {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.cl-entry {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.cl-entry-dot {
  flex-shrink: 0;
  margin-top: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px rgba(140,109,255,0.5);
}
.cl-entry-body {
  flex: 1;
}
.cl-entry-title {
  display: block;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-strong);
  margin-bottom: 4px;
}
.cl-entry-desc {
  margin: 0;
  font-size: 14px;
  color: var(--text-muted);
  line-height: 1.6;
}

@media (max-width: 600px) {
  .cl-root { padding: 32px 16px 64px; }
}
`;

export default changelog;
