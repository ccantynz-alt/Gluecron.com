/**
 * Marketing surface — public pages that don't fit the app shell.
 * Pricing, features, about. Logged-out and logged-in safe (softAuth).
 *
 * All pages use the new Editorial-Technical design system: .display,
 * .eyebrow, .section-header, .stagger, .gradient-text utilities are
 * defined globally in src/views/layout.tsx.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const marketing = new Hono<AuthEnv>();
marketing.use("*", softAuth);

// ============================================================
// /pricing
// ============================================================

marketing.get("/pricing", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Pricing — gluecron" user={user}>
      <PricingPage />
    </Layout>,
  );
});

const PricingPage: FC = () => (
  <>
    <style>{pricingCss}</style>
    <div class="mkt-root">
      <header class="mkt-hero">
        <div class="eyebrow">Pricing</div>
        <h1 class="display mkt-hero-title">
          Honest pricing for{" "}
          <span class="gradient-text">teams that ship.</span>
        </h1>
        <p class="mkt-hero-sub">
          Self-hosting is free forever. Hosted plans price the AI calls, not
          the seats. No one pays per developer.
        </p>
      </header>

      <section class="mkt-pricing-grid stagger">
        <PricingTier
          tier="Free"
          price="$0"
          cadence="forever"
          desc="For personal projects + open source. Full AI suite included."
          features={[
            "Unlimited public repos",
            "3 private repos",
            "5,000 AI calls / month",
            "GateTest + auto-repair",
            "Webhooks + workflows",
            "Community support",
          ]}
          cta="Start free"
          href="/register"
        />
        <PricingTier
          tier="Pro"
          price="$12"
          cadence="per user / month"
          desc="For working developers. Lifts every quota and adds priority routing."
          features={[
            "Unlimited private repos",
            "100,000 AI calls / month",
            "Priority AI queue",
            "Custom domains",
            "Advanced analytics",
            "Email support",
          ]}
          cta="Go Pro"
          href="/settings/billing"
          highlight
        />
        <PricingTier
          tier="Team"
          price="$29"
          cadence="per user / month"
          desc="For organisations running production on Gluecron."
          features={[
            "Everything in Pro",
            "Unlimited AI calls",
            "Org-level SSO + SCIM",
            "Audit log retention",
            "SLA-backed uptime",
            "Slack support channel",
          ]}
          cta="Talk to us"
          href="mailto:hello@gluecron.com"
        />
        <PricingTier
          tier="Enterprise"
          price="Custom"
          cadence="contact us"
          desc="On-prem deploy, dedicated capacity, 24/7 incident response."
          features={[
            "Everything in Team",
            "On-prem / VPC deploy",
            "Dedicated AI capacity",
            "Private model routing",
            "DPA + custom contracts",
            "24/7 incident response",
          ]}
          cta="Contact sales"
          href="mailto:enterprise@gluecron.com"
        />
      </section>

      <section class="mkt-section">
        <div class="section-header">
          <div class="eyebrow">Self-hosted</div>
          <h2>Run it on your own metal. No license, no telemetry.</h2>
          <p>
            Gluecron is a single Bun binary plus Postgres. Deploy to Fly,
            Railway, your own VPS, or air-gapped infra. Free forever for
            self-hosters of any size.
          </p>
        </div>
        <div class="mkt-selfhost-card surface-glow">
          <div class="mkt-selfhost-grid">
            <div class="mkt-selfhost-cell">
              <div class="mkt-selfhost-num">$0</div>
              <div class="mkt-selfhost-label">License</div>
            </div>
            <div class="mkt-selfhost-cell">
              <div class="mkt-selfhost-num">∞</div>
              <div class="mkt-selfhost-label">Users</div>
            </div>
            <div class="mkt-selfhost-cell">
              <div class="mkt-selfhost-num">∞</div>
              <div class="mkt-selfhost-label">Repos</div>
            </div>
            <div class="mkt-selfhost-cell">
              <div class="mkt-selfhost-num">0</div>
              <div class="mkt-selfhost-label">Telemetry</div>
            </div>
          </div>
          <div class="mkt-selfhost-cta">
            <a href="/help" class="btn btn-primary btn-lg">Self-host guide</a>
            <a
              href="https://github.com/ccantynz-alt/Gluecron.com"
              class="btn btn-ghost btn-lg"
            >
              View source
            </a>
          </div>
        </div>
      </section>

      <section class="mkt-section">
        <div class="section-header">
          <div class="eyebrow">Questions</div>
          <h2>The fine print, in plain English.</h2>
        </div>
        <div class="mkt-faq">
          <FaqItem
            q="What counts as an AI call?"
            a="Every Claude inference: PR review, security scan, spec-to-PR draft, commit message suggestion, chat reply. We don't bill for failed calls or retries on our end."
          />
          <FaqItem
            q="Can I bring my own Anthropic key?"
            a="Yes. Pro and above can supply ANTHROPIC_API_KEY; calls run against your account and don't count toward our quota. Useful for orgs with prepaid commits or enterprise rate limits."
          />
          <FaqItem
            q="What happens if I hit my AI quota?"
            a="AI features degrade gracefully — gates still run, code still hosts. AI suggestions queue at the back of the line. No surprise overage bills, ever."
          />
          <FaqItem
            q="Do you charge for runner minutes?"
            a="No. Workflow runs are unmetered on hosted plans. Self-hosters bring their own compute, of course."
          />
          <FaqItem
            q="What's the uptime SLA?"
            a="Team and Enterprise carry a 99.9% monthly SLA with credits. Free and Pro are best-effort but we publish live status at /status and historical incidents in CHANGELOG.md."
          />
          <FaqItem
            q="How do I migrate off Gluecron?"
            a="Same way you migrate off GitHub: git remote set-url and push. We're git-compatible to the byte. No vendor lock, no migration tax."
          />
        </div>
      </section>

      <CtaBlock />
    </div>
  </>
);

const PricingTier: FC<{
  tier: string;
  price: string;
  cadence: string;
  desc: string;
  features: string[];
  cta: string;
  href: string;
  highlight?: boolean;
}> = ({ tier, price, cadence, desc, features, cta, href, highlight }) => (
  <div class={`mkt-tier${highlight ? " mkt-tier-hl" : ""}`}>
    {highlight && <div class="mkt-tier-badge">Most popular</div>}
    <div class="mkt-tier-name">{tier}</div>
    <div class="mkt-tier-amount">
      <span class="mkt-tier-num">{price}</span>
      <span class="mkt-tier-cad">{cadence}</span>
    </div>
    <p class="mkt-tier-desc">{desc}</p>
    <ul class="mkt-tier-features">
      {features.map((f) => (
        <li>
          <span class="mkt-tier-check">{"✓"}</span>
          {f}
        </li>
      ))}
    </ul>
    <a
      href={href}
      class={`btn ${highlight ? "btn-primary" : "btn-secondary"} btn-block`}
      style="margin-top:auto"
    >
      {cta}
    </a>
  </div>
);

const FaqItem: FC<{ q: string; a: string }> = ({ q, a }) => (
  <details class="mkt-faq-item">
    <summary class="mkt-faq-q">
      <span>{q}</span>
      <span class="mkt-faq-toggle" aria-hidden="true">{"+"}</span>
    </summary>
    <p class="mkt-faq-a">{a}</p>
  </details>
);

// ============================================================
// /features
// ============================================================

marketing.get("/features", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Features — gluecron" user={user}>
      <FeaturesPage />
    </Layout>,
  );
});

const FeaturesPage: FC = () => (
  <>
    <style>{featuresCss}</style>
    <div class="mkt-root">
      <header class="mkt-hero">
        <div class="eyebrow">Features</div>
        <h1 class="display mkt-hero-title">
          A complete dev platform.{" "}
          <span class="gradient-text">Nothing extra to buy.</span>
        </h1>
        <p class="mkt-hero-sub">
          Hosting, CI, AI review, security scanning, deploy webhooks,
          marketplace, packages, pages — every surface you need, ready on
          day one.
        </p>
      </header>

      <FeatureCategory
        eyebrow="Code intelligence"
        title="The AI is a teammate, not an upsell."
        items={[
          {
            title: "AI code review",
            desc: "Real Claude review on every PR open. Inline file/line comments. Idempotent across re-runs.",
          },
          {
            title: "Spec-to-PR",
            desc: "Drop a feature spec in plain English. AI drafts the entire PR — branch, commits, description.",
          },
          {
            title: "AI security review",
            desc: "Sonnet 4 reads diffs for OWASP-class issues. Posts as inline review comments, not noise.",
          },
          {
            title: "Auto-repair",
            desc: "Failed gate? AI tries to fix it and pushes a follow-up commit. Your repo self-corrects.",
          },
          {
            title: "AI commit messages",
            desc: "One-click 'suggest with AI' on the web editor. Concise, conventional-commit format.",
          },
          {
            title: "AI changelogs",
            desc: "Generated on release create. Plus an arbitrary-range viewer at /:repo/ai/changelog.",
          },
          {
            title: "AI incident responder",
            desc: "Failed deploy? AI opens an issue with the failing logs + suggested fix + linked PR.",
          },
          {
            title: "AI test generation",
            desc: "Drops test stubs for uncovered functions. You review, edit, commit.",
          },
        ]}
      />

      <FeatureCategory
        eyebrow="Quality gate"
        title="Nothing broken ever reaches production."
        items={[
          {
            title: "GateTest integration",
            desc: "Push triggers GateTest. Results post back as inline annotations on the commit.",
          },
          {
            title: "Secret scanner",
            desc: "15 patterns, runs on every push. Blocks the push if a real secret leaks.",
          },
          {
            title: "Branch protection",
            desc: "Required checks, code-owner reviews, push restrictions, force-push blocking.",
          },
          {
            title: "Repository rulesets",
            desc: "Named policy bundles. Six rule types from commit message regex to max file size.",
          },
          {
            title: "Required checks matrix",
            desc: "Per branch-protection list of named checks that must pass before merge.",
          },
          {
            title: "Protected tags",
            desc: "Owners declare patterns (v*, release-*) that only owners can push.",
          },
          {
            title: "Merge queue",
            desc: "Serialised merge with re-test against latest base. No more 'green when merged, red on main'.",
          },
          {
            title: "Pre-receive policy",
            desc: "Ref-name patterns and push policies enforced at the HTTP layer with 403s.",
          },
        ]}
      />

      <FeatureCategory
        eyebrow="Real-time"
        title="No polling, no refresh, no waiting."
        items={[
          {
            title: "Live workflow logs",
            desc: "Step-by-step output streams over SSE the moment your runner emits it.",
          },
          {
            title: "Live PR comments",
            desc: "New comment in another tab? You see a 'reload to view' banner immediately.",
          },
          {
            title: "Live deploy events",
            desc: "Crontech-Gluecron event bus pushes deploy state. Watch deploys happen.",
          },
          {
            title: "Live presence",
            desc: "See who's looking at the same PR right now. Avoid double review work.",
          },
        ]}
      />

      <FeatureCategory
        eyebrow="Platform"
        title="Everything GitHub charges extra for."
        items={[
          {
            title: "Workflow runner",
            desc: "Drop yaml in `.gluecron/workflows/`. Runs on push. Cron triggers, secrets, matrix.",
          },
          {
            title: "Packages registry",
            desc: "npm protocol. Publish, install, yank with `glc_` PAT auth. Container registry deferred.",
          },
          {
            title: "Pages hosting",
            desc: "Serves blobs from the latest gh-pages commit. Custom domains, short cache headers.",
          },
          {
            title: "Marketplace + apps",
            desc: "Install third-party apps with permission scopes. App-bot push auth via ghi_ tokens.",
          },
          {
            title: "Discussions",
            desc: "Categorised threads, pinned, locked, Q&A answers. Zero extra config.",
          },
          {
            title: "Wikis + Gists + Projects",
            desc: "All shipped, all free, all integrated. No upsell tier.",
          },
        ]}
      />

      <FeatureCategory
        eyebrow="Identity + governance"
        title="Enterprise-tier auth from day one."
        items={[
          {
            title: "TOTP + WebAuthn",
            desc: "Both 2FA paths shipped. Passkey-only login if you want it.",
          },
          {
            title: "OIDC SSO",
            desc: "Okta, Azure AD, Auth0, Google Workspace. Auto-create users. Email-domain allowlist.",
          },
          {
            title: "OAuth provider",
            desc: "Third-party apps request scoped access to user repos. Standard auth-code flow.",
          },
          {
            title: "Personal access tokens",
            desc: "SHA-256 hashed, scoped, revocable. The clean way to script Gluecron.",
          },
          {
            title: "Audit log (per-user + per-repo)",
            desc: "Every sensitive action recorded. Browseable at /settings/audit.",
          },
          {
            title: "Site admin panel",
            desc: "/admin for site-wide flags: registration locks, banners, read-only mode.",
          },
        ]}
      />

      <FeatureCategory
        eyebrow="Integrations"
        title="Speak every protocol your tools use."
        items={[
          {
            title: "MCP server",
            desc: "Claude Desktop, Cursor, Code, Cline plug in natively. Read + scoped write tools.",
          },
          {
            title: "REST API v2",
            desc: "Full CRUD across resources. Versioned, documented, stable.",
          },
          {
            title: "GraphQL endpoint",
            desc: "Single-request fetch for complex client views. GraphiQL explorer at /api/graphql.",
          },
          {
            title: "Webhooks",
            desc: "HMAC-signed outbound to your URLs on push, issue, PR, star, comment, deploy.",
          },
          {
            title: "Smart-HTTP git",
            desc: "git push, git pull, git clone — exactly what your tools already speak.",
          },
          {
            title: "VS Code extension",
            desc: "Explain, open-on-web, semantic search, generate tests — all from the editor.",
          },
        ]}
      />

      <CtaBlock />
    </div>
  </>
);

const FeatureCategory: FC<{
  eyebrow: string;
  title: string;
  items: Array<{ title: string; desc: string }>;
}> = ({ eyebrow, title, items }) => (
  <section class="mkt-section">
    <div class="section-header left">
      <div class="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
    </div>
    <div class="mkt-feat-grid stagger">
      {items.map((it) => (
        <div class="mkt-feat-cell">
          <h3 class="mkt-feat-title">{it.title}</h3>
          <p class="mkt-feat-desc">{it.desc}</p>
        </div>
      ))}
    </div>
  </section>
);

// ============================================================
// /about
// ============================================================

marketing.get("/about", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="About — gluecron" user={user}>
      <AboutPage />
    </Layout>,
  );
});

const AboutPage: FC = () => (
  <>
    <style>{aboutCss}</style>
    <div class="mkt-root">
      <header class="mkt-hero">
        <div class="eyebrow">About</div>
        <h1 class="display mkt-hero-title">
          We're building the platform{" "}
          <span class="gradient-text">software writes itself on.</span>
        </h1>
        <p class="mkt-hero-sub">
          Most code in 2026 is written by AI. Most reviews are too. The
          platforms hosting that code were built for a previous era.
          Gluecron is built for this one.
        </p>
      </header>

      <section class="mkt-section">
        <div class="mkt-prose">
          <div class="eyebrow">Mission</div>
          <h2>An IDE for your repo. A teammate, not a sidebar.</h2>
          <p>
            GitHub treats AI as a feature you bolt onto your workflow. We
            treat it as a peer that opens PRs, reviews diffs, fixes
            regressions, and ships its own changes — visibly, accountably,
            with a real identity in your history.
          </p>
          <p>
            Everything is green by default. Every new repo auto-configures
            gates, branch protection, labels, CODEOWNERS, and a welcome issue.
            Users opt out per feature. Defaults are maximum-green so
            <strong> nothing broken ever reaches production, the website,
            or the customer.</strong>
          </p>
        </div>
      </section>

      <section class="mkt-section">
        <div class="section-header">
          <div class="eyebrow">Principles</div>
          <h2>Six rules we don't compromise on.</h2>
        </div>
        <div class="mkt-principles stagger">
          <PrincipleCard
            n="01"
            title="No vendor lock"
            desc="We're git-compatible to the byte. Migrate off Gluecron the same way you migrate off GitHub: git remote set-url. Your code is yours."
          />
          <PrincipleCard
            n="02"
            title="No surprise bills"
            desc="AI quotas degrade gracefully when hit. No overage, no automatic upgrade. We publish prices in dollars, not credits."
          />
          <PrincipleCard
            n="03"
            title="Self-host is first-class"
            desc="Single Bun binary, single Postgres, zero telemetry. The same product the hosted version runs on, free forever for self-hosters."
          />
          <PrincipleCard
            n="04"
            title="AI is accountable"
            desc="Every AI commit is signed by an app-bot identity. Every AI comment is labelled. You can audit, revert, or disable any AI agent at any time."
          />
          <PrincipleCard
            n="05"
            title="Real-time over polling"
            desc="SSE for logs, comments, deploys, presence. The web should feel like a desktop app. No spinners on a tab you've already loaded."
          />
          <PrincipleCard
            n="06"
            title="Open by default"
            desc="REST + GraphQL + MCP + Smart-HTTP + webhooks. Your tools speak our platform without asking. Programmatic access is not an enterprise tier."
          />
        </div>
      </section>

      <section class="mkt-section">
        <div class="section-header">
          <div class="eyebrow">Stack</div>
          <h2>Built on the boring, fast parts.</h2>
        </div>
        <div class="mkt-stack">
          <StackPill name="Bun" desc="runtime" />
          <StackPill name="Hono" desc="server framework" />
          <StackPill name="Drizzle" desc="ORM" />
          <StackPill name="Neon Postgres" desc="primary database" />
          <StackPill name="Claude Sonnet 4" desc="AI review + chat" />
          <StackPill name="Claude Haiku 4.5" desc="AI commits + summaries" />
          <StackPill name="Smart-HTTP git" desc="protocol" />
          <StackPill name="Fly.io" desc="deploy target" />
        </div>
      </section>

      <section class="mkt-section mkt-contact">
        <div class="section-header">
          <div class="eyebrow">Contact</div>
          <h2>Three places to find us.</h2>
        </div>
        <div class="mkt-contact-grid">
          <ContactCard
            label="Product + sales"
            email="hello@gluecron.com"
            line="For demos, pricing questions, partnership ideas."
          />
          <ContactCard
            label="Security"
            email="security@gluecron.com"
            line="Responsible disclosure. PGP key on request."
          />
          <ContactCard
            label="Support"
            email="support@gluecron.com"
            line="Bugs, account help, anything that's broken."
          />
        </div>
      </section>

      <CtaBlock />
    </div>
  </>
);

const PrincipleCard: FC<{ n: string; title: string; desc: string }> = ({
  n,
  title,
  desc,
}) => (
  <div class="mkt-principle">
    <div class="mkt-principle-num">{n}</div>
    <h3 class="mkt-principle-title">{title}</h3>
    <p class="mkt-principle-desc">{desc}</p>
  </div>
);

const StackPill: FC<{ name: string; desc: string }> = ({ name, desc }) => (
  <div class="mkt-stack-pill">
    <span class="mkt-stack-name">{name}</span>
    <span class="mkt-stack-desc">{desc}</span>
  </div>
);

const ContactCard: FC<{ label: string; email: string; line: string }> = ({
  label,
  email,
  line,
}) => (
  <a href={`mailto:${email}`} class="mkt-contact-card">
    <div class="mkt-contact-label">{label}</div>
    <div class="mkt-contact-email">{email}</div>
    <p class="mkt-contact-line">{line}</p>
  </a>
);

// ============================================================
// Shared closing CTA block
// ============================================================

const CtaBlock: FC = () => (
  <section class="mkt-cta">
    <div class="mkt-cta-card">
      <div class="mkt-cta-bg" aria-hidden="true" />
      <div class="eyebrow">Get started</div>
      <h2 class="mkt-cta-title">
        Stop maintaining the platform.<br />
        <span class="gradient-text">Start shipping the product.</span>
      </h2>
      <div class="mkt-cta-buttons">
        <a href="/register" class="btn btn-primary btn-xl">
          Create your account
          <span aria-hidden="true">{"→"}</span>
        </a>
        <a href="/import" class="btn btn-ghost btn-xl">
          Migrate from GitHub
        </a>
      </div>
    </div>
  </section>
);

// ============================================================
// Styles — namespaced under .mkt- so they don't leak
// ============================================================

const sharedMktCss = `
  .mkt-root {
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 16px;
  }

  /* Hero */
  .mkt-hero {
    text-align: center;
    padding: var(--s-16) 0 var(--s-12);
    max-width: 920px;
    margin: 0 auto;
    position: relative;
  }
  .mkt-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 50%;
    transform: translateX(-50%);
    width: 70%; height: 60%;
    background: radial-gradient(ellipse at center, rgba(140,109,255,0.14), transparent 65%);
    z-index: -1;
    pointer-events: none;
  }
  .mkt-hero .eyebrow { justify-content: center; margin: 0 auto var(--s-4); }
  .mkt-hero-title {
    font-size: clamp(36px, 6.5vw, 76px);
    line-height: 1.02;
    letter-spacing: -0.038em;
    margin: 0 0 var(--s-5);
  }
  .mkt-hero-sub {
    font-size: clamp(15px, 1.5vw, 18px);
    color: var(--text-muted);
    max-width: 640px;
    margin: 0 auto;
    line-height: 1.55;
  }

  /* Section spacing */
  .mkt-section { margin: var(--s-16) auto; }

  /* Closing CTA */
  .mkt-cta { margin: var(--s-20) auto var(--s-12); }
  .mkt-cta-card {
    position: relative;
    text-align: center;
    padding: var(--s-14) var(--s-7);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-2xl);
    background: var(--bg-elevated);
    overflow: hidden;
    isolation: isolate;
  }
  .mkt-cta-bg {
    position: absolute;
    inset: 0;
    z-index: -1;
    background:
      radial-gradient(60% 100% at 50% 0%, rgba(140,109,255,0.16), transparent 65%),
      radial-gradient(40% 80% at 80% 100%, rgba(54,197,214,0.10), transparent 65%);
  }
  .mkt-cta-card .eyebrow { justify-content: center; }
  .mkt-cta-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 52px);
    line-height: 1.05;
    letter-spacing: -0.03em;
    font-weight: 600;
    margin: var(--s-3) 0 var(--s-7);
    color: var(--text-strong);
  }
  .mkt-cta-buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
  }

  @media (max-width: 640px) {
    .mkt-hero { padding: var(--s-10) 0 var(--s-8); }
    .mkt-section { margin: var(--s-12) auto; }
    .mkt-cta-buttons .btn { width: 100%; justify-content: center; }
  }
`;

const pricingCss = sharedMktCss + `
  .mkt-pricing-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin: var(--s-12) auto var(--s-16);
    align-items: stretch;
  }
  .mkt-tier {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-7) var(--s-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease-out-quart);
  }
  .mkt-tier:hover { border-color: var(--border-strong); transform: translateY(-3px); }
  .mkt-tier-hl {
    border-color: rgba(140,109,255,0.40);
    box-shadow: var(--elev-2), 0 0 0 1px rgba(140,109,255,0.30);
    background:
      linear-gradient(180deg, rgba(140,109,255,0.05), transparent 50%),
      var(--bg-elevated);
  }
  .mkt-tier-hl:hover { border-color: rgba(140,109,255,0.60); }
  .mkt-tier-badge {
    position: absolute;
    top: -10px;
    left: 50%;
    transform: translateX(-50%);
    padding: 3px 12px;
    background: var(--accent-gradient);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 600;
    border-radius: var(--r-full);
    box-shadow: 0 4px 14px -2px rgba(140,109,255,0.45);
    white-space: nowrap;
  }
  .mkt-tier-name {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-muted);
  }
  .mkt-tier-amount {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .mkt-tier-num {
    font-family: var(--font-display);
    font-size: 36px;
    font-weight: 600;
    letter-spacing: -0.03em;
    color: var(--text-strong);
  }
  .mkt-tier-cad {
    font-size: 12px;
    color: var(--text-faint);
  }
  .mkt-tier-desc {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }
  .mkt-tier-features {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: var(--t-sm);
    color: var(--text);
  }
  .mkt-tier-features li {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    line-height: 1.45;
  }
  .mkt-tier-check {
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
    line-height: 1.45;
  }

  .mkt-selfhost-card {
    max-width: 880px;
    margin: 0 auto;
    padding: var(--s-10);
    text-align: center;
  }
  .mkt-selfhost-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--s-6);
    margin-bottom: var(--s-8);
    padding-bottom: var(--s-8);
    border-bottom: 1px solid var(--border-subtle);
  }
  .mkt-selfhost-cell { text-align: center; }
  .mkt-selfhost-num {
    font-family: var(--font-display);
    font-size: 44px;
    font-weight: 600;
    letter-spacing: -0.03em;
    color: var(--text-strong);
    line-height: 1;
    background: var(--accent-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .mkt-selfhost-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin-top: var(--s-2);
  }
  .mkt-selfhost-cta {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
  }

  .mkt-faq {
    max-width: 760px;
    margin: 0 auto;
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .mkt-faq-item {
    border-bottom: 1px solid var(--border-subtle);
  }
  .mkt-faq-item:last-child { border-bottom: none; }
  .mkt-faq-q {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 18px 24px;
    cursor: pointer;
    font-size: var(--t-md);
    font-weight: 500;
    color: var(--text-strong);
    list-style: none;
    transition: background var(--t-fast) var(--ease);
  }
  .mkt-faq-q::-webkit-details-marker { display: none; }
  .mkt-faq-q:hover { background: var(--bg-hover); }
  .mkt-faq-toggle {
    font-family: var(--font-mono);
    font-size: 18px;
    color: var(--text-muted);
    transition: transform var(--t-base) var(--ease-spring);
    flex-shrink: 0;
  }
  .mkt-faq-item[open] .mkt-faq-toggle { transform: rotate(45deg); color: var(--accent); }
  .mkt-faq-a {
    padding: 0 24px 20px;
    color: var(--text-muted);
    font-size: var(--t-sm);
    line-height: 1.6;
    margin: 0;
  }

  @media (max-width: 960px) {
    .mkt-pricing-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 640px) {
    .mkt-pricing-grid { grid-template-columns: 1fr; }
    .mkt-selfhost-grid { grid-template-columns: repeat(2, 1fr); }
    .mkt-selfhost-card { padding: var(--s-7); }
  }
`;

const featuresCss = sharedMktCss + `
  .mkt-feat-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;
    background: var(--border-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    overflow: hidden;
  }
  .mkt-feat-cell {
    padding: var(--s-6);
    background: var(--bg-elevated);
    transition: background var(--t-fast) var(--ease);
    position: relative;
  }
  .mkt-feat-cell:hover { background: var(--bg-surface); }
  .mkt-feat-cell::before {
    content: '';
    position: absolute;
    left: var(--s-6);
    top: var(--s-6);
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .mkt-feat-cell:hover::before { opacity: 1; }
  .mkt-feat-title {
    font-family: var(--font-display);
    font-size: var(--t-md);
    font-weight: 600;
    letter-spacing: -0.012em;
    margin: 0 0 var(--s-2);
    color: var(--text-strong);
    padding-left: 14px;
  }
  .mkt-feat-desc {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
    padding-left: 14px;
  }
  @media (max-width: 720px) {
    .mkt-feat-grid { grid-template-columns: 1fr; }
  }
`;

const aboutCss = sharedMktCss + `
  .mkt-prose {
    max-width: 720px;
    margin: 0 auto;
  }
  .mkt-prose h2 {
    font-size: clamp(24px, 3vw, 36px);
    line-height: 1.15;
    letter-spacing: -0.025em;
    margin: var(--s-3) 0 var(--s-5);
  }
  .mkt-prose p {
    color: var(--text);
    font-size: var(--t-md);
    line-height: 1.7;
    margin: 0 0 var(--s-4);
  }
  .mkt-prose p strong { color: var(--text-strong); font-weight: 600; }

  .mkt-principles {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
  .mkt-principle {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-7);
    transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease-out-quart);
  }
  .mkt-principle:hover { border-color: var(--border-strong); transform: translateY(-2px); }
  .mkt-principle-num {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
    background: var(--accent-gradient-faint);
    border: 1px solid rgba(140,109,255,0.30);
    padding: 3px 9px;
    border-radius: var(--r-full);
    letter-spacing: 0.06em;
    display: inline-block;
    margin-bottom: var(--s-4);
  }
  .mkt-principle-title {
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.018em;
    margin: 0 0 var(--s-2);
    color: var(--text-strong);
  }
  .mkt-principle-desc {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0;
  }

  .mkt-stack {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: center;
    max-width: 880px;
    margin: 0 auto;
  }
  .mkt-stack-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-full);
    transition: border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
  }
  .mkt-stack-pill:hover { border-color: rgba(140,109,255,0.4); transform: translateY(-1px); }
  .mkt-stack-name {
    font-family: var(--font-display);
    font-weight: 600;
    color: var(--text-strong);
    font-size: var(--t-sm);
    letter-spacing: -0.01em;
  }
  .mkt-stack-desc {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }

  .mkt-contact-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    max-width: 880px;
    margin: 0 auto;
  }
  .mkt-contact-card {
    display: block;
    padding: var(--s-7);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    text-decoration: none;
    transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease-out-quart);
  }
  .mkt-contact-card:hover {
    border-color: rgba(140,109,255,0.4);
    transform: translateY(-2px);
    text-decoration: none;
  }
  .mkt-contact-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin-bottom: var(--s-3);
  }
  .mkt-contact-email {
    font-family: var(--font-display);
    font-size: var(--t-md);
    font-weight: 600;
    letter-spacing: -0.012em;
    color: var(--accent);
    margin-bottom: var(--s-2);
    word-break: break-all;
  }
  .mkt-contact-line {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  @media (max-width: 880px) {
    .mkt-principles { grid-template-columns: repeat(2, 1fr); }
    .mkt-contact-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 560px) {
    .mkt-principles { grid-template-columns: 1fr; }
  }
`;

export default marketing;
