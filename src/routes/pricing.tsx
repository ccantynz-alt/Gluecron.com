/**
 * Block L8 — public `/pricing` page.
 *
 * Anonymous-safe GET /pricing. Reads the real plan rows from
 * `billing_plans` (or `FALLBACK_PLANS` when seeds aren't loaded yet — both
 * mirror migration 0020) so the price column never drifts from the actual
 * billing config. This route is mounted BEFORE `routes/marketing.tsx` in
 * `app.tsx` so the new editorial layout wins; the legacy marketing /pricing
 * remains as a safety net.
 *
 * Anchors:
 *   #free        → "What you get on the free tier" block
 *   #self-host   → Self-host vs Cloud comparison
 *   #faq         → Frequently asked questions
 *
 * Pure presentational — no billing logic is created here. The page only
 * surfaces what `src/lib/billing.ts` already ships.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { formatPrice, listPlans } from "../lib/billing";

const pricing = new Hono<AuthEnv>();
pricing.use("*", softAuth);

// ---- Per-slug copy: tagline + included-bullet list ------------------------
// Indexed by the seeded plan slugs. Anything not in this map falls back to
// generic copy derived from the plan's numeric limits so we never miss a
// row even if a future migration adds a new tier.
const PLAN_COPY: Record<
  string,
  { tagline: string; supportTier: string }
> = {
  free: {
    tagline: "AI review on every PR, auto-merge, and spec-to-PR — on unlimited public repos, forever.",
    supportTier: "Community support",
  },
  pro: {
    tagline: "Private repos + higher AI quota. AI review, auto-merge, and spec-to-PR for working developers shipping daily.",
    supportTier: "Email support, priority AI queue",
  },
  team: {
    tagline: "Full AI suite for production teams — AI review, auto-merge when gates pass, and spec-to-PR at scale.",
    supportTier: "Slack channel + 24h response",
  },
  enterprise: {
    tagline: "SSO, audit log, on-prem deploy — with the full AI suite: review, auto-merge, and spec-to-PR.",
    supportTier: "24/7 incident response + DPA",
  },
};

pricing.get("/pricing", async (c) => {
  const user = c.get("user");
  const plans = await listPlans();
  return c.html(
    <Layout
      title="Pricing — Gluecron"
      user={user}
      description="Simple pricing for AI-native git hosting. Unlimited repos, AI review, auto-merge, spec-to-PR. Start free."
      ogTitle="Pricing — Gluecron"
      ogDescription="Simple pricing for AI-native git hosting. Unlimited repos, AI review, auto-merge, spec-to-PR. Start free."
      twitterCard="summary"
    >
      <PricingPage plans={plans} loggedIn={!!user} />
    </Layout>
  );
});

interface Plan {
  slug: string;
  name: string;
  priceCents: number;
  repoLimit: number;
  storageMbLimit: number;
  aiTokensMonthly: number;
  bandwidthGbMonthly: number;
  privateRepos: boolean;
}

const PricingPage: FC<{ plans: Plan[]; loggedIn: boolean }> = ({
  plans,
  loggedIn,
}) => (
  <>
    <style dangerouslySetInnerHTML={{ __html: pricingCss }} />
    <div class="pl-root">
      {/* ------------------- Hero ------------------- */}
      <header class="pl-hero">
        <div class="pl-hero-hairline" aria-hidden="true" />
        <div class="pl-hero-orb" aria-hidden="true" />
        <div class="eyebrow">Pricing</div>
        <p class="pl-hero-speed">Spec to PR in 90 seconds.</p>
        <h1 class="display pl-hero-title">
          One subscription.{" "}
          <span class="gradient-text">
            Replaces three on GitHub.
          </span>
        </h1>
        <p class="pl-hero-sub">
          AI review fires in ~8s. Merges the instant gates pass. Spec to PR in
          90 seconds. What costs $89/user on GitHub + Copilot + Advanced
          Security starts at $0 here.
        </p>
        <div class="pl-hero-jumps">
          <a href="#compare" class="pl-jump">Bundle math vs GitHub →</a>
          <a href="#free" class="pl-jump">What's free</a>
          <a href="#self-host" class="pl-jump">Self-host vs Cloud</a>
          <a href="#faq" class="pl-jump">FAQ</a>
        </div>
      </header>

      {/* ------------------- Plan cards ------------------- */}
      <section class="pl-plans stagger">
        {plans.map((p) => (
          <PlanCard plan={p} loggedIn={loggedIn} />
        ))}
      </section>

      {/* ------------------- Included in every plan ------------------- */}
      <section class="pl-section pl-every-plan">
        <div class="pl-every-plan-inner">
          <div class="pl-every-plan-label">Included in every plan</div>
          <ul class="pl-every-plan-list">
            <li>AI review on every PR</li>
            <li>Auto-merge when gates pass</li>
            <li>Spec to PR in 90 seconds</li>
            <li>Push Watch live stream</li>
          </ul>
        </div>
      </section>

      {/* ------------------- Bundle math vs GitHub ------------------- */}
      <section id="compare" class="pl-section pl-compare">
        <div class="section-header">
          <div class="eyebrow">Bundle math</div>
          <h2>
            What you'd actually pay on GitHub
            <span class="gradient-text"> for the same features.</span>
          </h2>
          <p>
            GitHub charges separately for Copilot, Advanced Security, and the
            base plan. Gluecron bundles everything. Here's the receipt.
          </p>
        </div>
        <div class="pl-compare-grid">
          <div class="pl-compare-col">
            <div class="pl-compare-name">GitHub stack</div>
            <div class="pl-compare-price">$89<span class="pl-compare-per">/user/mo</span></div>
            <ul class="pl-compare-feats">
              <li><span class="pl-compare-bullet">$21</span> GitHub Enterprise (per-user)</li>
              <li><span class="pl-compare-bullet">$19</span> GitHub Copilot Business</li>
              <li><span class="pl-compare-bullet">$49</span> GitHub Advanced Security add-on</li>
              <li class="pl-compare-missing">— No AI auto-merge</li>
              <li class="pl-compare-missing">— No AI incident responder</li>
              <li class="pl-compare-missing">— No AI spec-to-PR</li>
              <li class="pl-compare-missing">— No MCP-native integration</li>
            </ul>
          </div>
          <div class="pl-compare-col pl-compare-us">
            <div class="pl-compare-name">Gluecron Team</div>
            <div class="pl-compare-price">$29<span class="pl-compare-per">/user/mo</span></div>
            <ul class="pl-compare-feats">
              <li><span class="pl-compare-check">✓</span> Unlimited private repos + git host</li>
              <li><span class="pl-compare-check">✓</span> AI code review on every PR (Claude Sonnet)</li>
              <li><span class="pl-compare-check">✓</span> AI auto-merge when gates pass</li>
              <li><span class="pl-compare-check">✓</span> AI incident responder on deploy failure</li>
              <li><span class="pl-compare-check">✓</span> AI spec-to-PR (label an issue, get a PR)</li>
              <li><span class="pl-compare-check">✓</span> AI completion + commit messages + tests</li>
              <li><span class="pl-compare-check">✓</span> MCP server — drive it from Claude Desktop</li>
              <li><span class="pl-compare-check">✓</span> SSO, audit log, branch protection, rulesets</li>
            </ul>
          </div>
        </div>
        <p class="pl-compare-footer">
          For a 10-person team, the math is{" "}
          <strong>$10,680/year on GitHub vs $3,480/year on Gluecron</strong>
          {" — "}
          and you get the AI features that don't exist on GitHub at any price.
        </p>
      </section>

      {/* ------------------- What's on the free tier ------------------- */}
      <section id="free" class="pl-section pl-free">
        <div class="section-header">
          <div class="eyebrow">Free tier</div>
          <h2>Everything below is yours on the free tier.</h2>
          <p>
            All the AI features. Not a "try it for 14 days" trial. Not a
            "core features" stub. The whole Claude-powered platform — on
            unlimited public repos, forever.
          </p>
        </div>
        <ul class="pl-free-grid">
          <FreeItem label="Unlimited public repos" />
          <FreeItem label="AI code review on every PR (Sonnet 4)" />
          <FreeItem label="AI auto-merge when checks pass (K2)" />
          <FreeItem label="ai:build label → spec-to-PR (K3)" />
          <FreeItem label="Sleep Mode digest (L1)" />
          <FreeItem label="AI hours saved counter (L9)" />
          <FreeItem label="MCP server access (K1)" />
          <FreeItem label="Claude Code skill bundle (L7)" />
          <FreeItem label="One-command install" />
          <FreeItem label="GitHub OIDC sign-in" />
          <FreeItem label="Webhooks + REST API v2 + GraphQL" />
          <FreeItem label="Package registry + Pages hosting" />
        </ul>
      </section>

      {/* ------------------- Self-host vs Cloud ------------------- */}
      <section id="self-host" class="pl-section">
        <div class="section-header">
          <div class="eyebrow">Two ways to run it</div>
          <h2>Self-host on your metal. Or let us run it.</h2>
          <p>
            Same product, same code, same Claude-powered features. The only
            difference is who pays the electricity bill.
          </p>
        </div>
        <div class="pl-host-grid">
          <div class="pl-host-col">
            <div class="pl-host-name">Self-host</div>
            <div class="pl-host-price">Free forever</div>
            <ul class="pl-host-feats">
              <li>Free forever — no license, no per-seat fee</li>
              <li>Your database, your disk, your control</li>
              <li>You pay your Anthropic API key directly</li>
              <li>Run via <code>curl gluecron.com/install</code></li>
              <li>Or the Hetzner bootstrap script in 30 seconds</li>
            </ul>
            <a href="/install" class="btn btn-secondary btn-block pl-host-cta">
              Self-host guide
            </a>
          </div>
          <div class="pl-host-col pl-host-cloud">
            <div class="pl-host-name">Gluecron Cloud</div>
            <div class="pl-host-price">From $0/mo</div>
            <ul class="pl-host-feats">
              <li>Managed — we run the server, you push code</li>
              <li>Opinionated stack, zero ops on your end</li>
              <li>Automatic upgrades to every new block</li>
              <li>Support included on paid plans</li>
              <li>Plan-based pricing, no surprise overage</li>
            </ul>
            <a
              href={loggedIn ? "/settings/billing" : "/register?next=/settings/billing"}
              class="btn btn-primary btn-block pl-host-cta"
            >
              Start on Cloud
            </a>
          </div>
        </div>
      </section>

      {/* ------------------- FAQ ------------------- */}
      <section id="faq" class="pl-section">
        <div class="section-header">
          <div class="eyebrow">Questions</div>
          <h2>The fine print, in plain English.</h2>
        </div>
        <div class="pl-faq">
          <FaqItem
            q="Is it really free? What's the catch?"
            a="Really free. The free tier exists because we want every Claude-curious developer to try Gluecron without a credit card. The catch — if you can call it that — is that we hope you'll upgrade to Pro once you're shipping production traffic and need higher AI quotas."
          />
          <FaqItem
            q="Do I need to bring my own Anthropic API key on the free tier?"
            a="No. The free tier includes a generous monthly AI quota powered by our keys. If you'd rather use your own key (for cost control or enterprise rate limits), you can plug it in at /settings — Pro and above can route AI through your account."
          />
          <FaqItem
            q="What happens when I exceed my plan's quota?"
            a="AI features degrade gracefully — git push, hosting, and gates keep working. AI suggestions queue at the back of the line until the next cycle. We never auto-bill you for overage or auto-upgrade your plan."
          />
          <FaqItem
            q="Can I migrate from GitHub for free?"
            a="Yes. The migration tool is on every tier, free included. Point it at a GitHub repo URL and we mirror code, issues, PRs, and releases in one shot. No vendor lock — you can migrate back the same way."
          />
          <FaqItem
            q="Does the free tier include private repos?"
            a="The free tier is built around unlimited public repos. Private repos start on the Pro plan — that's the main paid-tier perk along with the higher AI quota. If you're self-hosting, all repos are private by default and there's no plan to worry about."
          />
        </div>
      </section>

      {/* ------------------- CTA ------------------- */}
      <section class="pl-section pl-cta-wrap">
        <div class="pl-cta">
          <h2 class="pl-cta-title">
            Ready to push your first repo?
          </h2>
          <p class="pl-cta-sub">
            Free, no credit card, full AI suite from minute one.
          </p>
          <div class="pl-cta-buttons">
            <a href="/register" class="btn btn-primary btn-xl">
              Start free
            </a>
            <a href="/vs-github" class="btn btn-ghost btn-xl">
              Compare to GitHub
            </a>
          </div>
        </div>
      </section>
    </div>
  </>
);

// ---- Sub-components -------------------------------------------------------

const PlanCard: FC<{ plan: Plan; loggedIn: boolean }> = ({ plan, loggedIn }) => {
  const copy = PLAN_COPY[plan.slug] || {
    tagline: `${plan.name} plan.`,
    supportTier: "Support included",
  };
  const href = loggedIn
    ? `/settings/billing?plan=${plan.slug}`
    : `/register?next=/settings/billing?plan=${plan.slug}`;
  const isPro = plan.slug === "pro";
  return (
    <div class={`pl-card${isPro ? " pl-card-hl" : ""}`}>
      {isPro && <div class="pl-card-badge">Most popular</div>}
      <div class="pl-card-name">{plan.name}</div>
      <div class="pl-card-price">
        <span class="pl-card-num">{formatPrice(plan.priceCents)}</span>
      </div>
      <p class="pl-card-tag">{copy.tagline}</p>
      <ul class="pl-card-feats">
        <li>
          <span class="pl-check">{"✓"}</span>
          {plan.repoLimit.toLocaleString()} repos
          {plan.privateRepos ? " (public + private)" : " (public only)"}
        </li>
        <li>
          <span class="pl-check">{"✓"}</span>
          {plan.aiTokensMonthly.toLocaleString()} AI tokens / month
        </li>
        <li>
          <span class="pl-check">{"✓"}</span>
          {plan.storageMbLimit.toLocaleString()} MB storage
        </li>
        <li>
          <span class="pl-check">{"✓"}</span>
          {plan.bandwidthGbMonthly.toLocaleString()} GB bandwidth / month
        </li>
        <li>
          <span class="pl-check">{"✓"}</span>
          {copy.supportTier}
        </li>
      </ul>
      <a
        href={href}
        class={`btn ${isPro ? "btn-primary" : "btn-secondary"} btn-block pl-card-cta`}
      >
        Choose {plan.name}
      </a>
    </div>
  );
};

const FreeItem: FC<{ label: string }> = ({ label }) => (
  <li class="pl-free-item">
    <span class="pl-free-check">{"✓"}</span>
    <span>{label}</span>
  </li>
);

const FaqItem: FC<{ q: string; a: string }> = ({ q, a }) => (
  <details class="pl-faq-item">
    <summary class="pl-faq-q">
      <span>{q}</span>
      <span class="pl-faq-toggle" aria-hidden="true">{"+"}</span>
    </summary>
    <p class="pl-faq-a">{a}</p>
  </details>
);

// ---- Styles (scoped under .pl-) -------------------------------------------

const pricingCss = `
  .pl-root { max-width: 1180px; margin: 0 auto; padding: 0 16px; }

  /* Hero */
  .pl-hero {
    text-align: center;
    padding: var(--s-16) 0 var(--s-10);
    max-width: 920px;
    margin: 0 auto;
    position: relative;
  }
  .pl-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 50%;
    transform: translateX(-50%);
    width: 70%; height: 60%;
    background: radial-gradient(ellipse at center, rgba(140,109,255,0.14), transparent 65%);
    z-index: -1;
    pointer-events: none;
  }
  /* 2026 polish — gradient hairline accent across the top of the hero
     (matches /admin, /admin/ops, error pages). */
  .pl-hero-hairline {
    position: absolute;
    top: 0; left: 8%; right: 8%;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.65;
    pointer-events: none;
    z-index: 0;
    border-radius: 2px;
  }
  /* 2026 polish — soft animated radial orb behind the headline. */
  .pl-hero-orb {
    position: absolute;
    top: 8%; left: 50%;
    transform: translateX(-50%);
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: -1;
    animation: plHeroOrb 16s ease-in-out infinite;
  }
  @keyframes plHeroOrb {
    0%, 100% { transform: translateX(-50%) scale(1); opacity: 0.55; }
    50%      { transform: translateX(-50%) scale(1.12); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pl-hero-orb { animation: none; }
  }
  .pl-hero .eyebrow { justify-content: center; margin: 0 auto var(--s-4); }
  .pl-hero-speed {
    font-family: var(--font-mono);
    font-size: clamp(13px, 1.4vw, 16px);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--accent);
    margin: 0 0 var(--s-3);
    text-transform: uppercase;
  }
  .pl-hero-title {
    font-size: clamp(36px, 6.5vw, 72px);
    line-height: 1.02;
    letter-spacing: -0.038em;
    margin: 0 0 var(--s-5);
  }
  .pl-hero-sub {
    font-size: clamp(15px, 1.5vw, 18px);
    color: var(--text-muted);
    max-width: 640px;
    margin: 0 auto;
    line-height: 1.55;
  }
  .pl-hero-jumps {
    display: flex;
    gap: 18px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: var(--s-7);
  }
  .pl-jump {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
    padding: 6px 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-full);
    transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .pl-jump:hover { color: var(--accent); border-color: rgba(140,109,255,0.35); }

  /* Plan cards */
  .pl-plans {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin: var(--s-10) auto var(--s-14);
    align-items: stretch;
  }
  .pl-card {
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
  .pl-card:hover { border-color: var(--border-strong); transform: translateY(-3px); }
  .pl-card-hl {
    border-color: rgba(140,109,255,0.40);
    box-shadow: var(--elev-2), 0 0 0 1px rgba(140,109,255,0.30);
    background:
      linear-gradient(180deg, rgba(140,109,255,0.05), transparent 50%),
      var(--bg-elevated);
  }
  .pl-card-badge {
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
  .pl-card-name {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-muted);
  }
  .pl-card-price { display: flex; align-items: baseline; gap: 6px; }
  .pl-card-num {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.03em;
    color: var(--text-strong);
  }
  .pl-card-tag {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }
  .pl-card-feats {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: 13px;
    color: var(--text);
  }
  .pl-card-feats li {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    line-height: 1.45;
  }
  .pl-check {
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
    line-height: 1.45;
  }
  .pl-card-cta { margin-top: auto; }

  /* Section base */
  .pl-section { margin: var(--s-14) auto; }

  /* Free-tier block */
  .pl-free-grid {
    list-style: none;
    padding: 0;
    margin: var(--s-6) auto 0;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px 32px;
    max-width: 880px;
  }
  .pl-free-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--r);
    font-size: var(--t-sm);
    color: var(--text);
    line-height: 1.45;
    transition: border-color var(--t-fast) var(--ease);
  }
  .pl-free-item:hover { border-color: rgba(140,109,255,0.35); }
  .pl-free-check {
    color: var(--green);
    font-weight: 700;
    flex-shrink: 0;
  }

  /* Self-host vs Cloud */
  .pl-host-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    max-width: 920px;
    margin: 0 auto;
  }
  .pl-host-col {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-7) var(--s-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .pl-host-cloud {
    border-color: rgba(140,109,255,0.35);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.20);
    background:
      linear-gradient(180deg, rgba(140,109,255,0.04), transparent 60%),
      var(--bg-elevated);
  }
  .pl-host-name {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-muted);
  }
  .pl-host-price {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.025em;
    color: var(--text-strong);
  }
  .pl-host-feats {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: var(--t-sm);
    color: var(--text);
  }
  .pl-host-feats li {
    display: flex;
    gap: 9px;
    line-height: 1.5;
  }
  .pl-host-feats li::before {
    content: '→';
    color: var(--accent);
    flex-shrink: 0;
  }
  .pl-host-feats code {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11.5px;
    font-family: var(--font-mono);
    color: var(--accent);
  }
  .pl-host-cta { margin-top: auto; }

  /* ------------------- Bundle-math comparison (vs GitHub) ------------------- */
  /* 2026 polish — side-by-side cost comparison that makes the AI-bundled
     value proposition unmissable. Same visual rhythm as .pl-host-grid; the
     "us" side wins via accent border + subtle gradient glow. */
  .pl-compare {
    margin-top: var(--s-14);
  }
  .pl-compare-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-5);
    max-width: 1040px;
    margin: 0 auto;
  }
  .pl-compare-col {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: var(--space-5) var(--space-5) var(--space-6);
    display: flex;
    flex-direction: column;
    transition: transform var(--t-base, 180ms) var(--ease, ease),
                box-shadow var(--t-base, 180ms) var(--ease, ease);
  }
  .pl-compare-col:hover { transform: translateY(-2px); }
  .pl-compare-us {
    position: relative;
    border: 1px solid transparent;
    background-image:
      linear-gradient(var(--bg-elevated), var(--bg-elevated)),
      linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    background-origin: border-box;
    background-clip: padding-box, border-box;
    box-shadow: 0 16px 56px -12px rgba(140, 109, 255, 0.20);
  }
  .pl-compare-us::before {
    content: 'Better deal';
    position: absolute;
    top: -12px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 12px;
    border-radius: 999px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .pl-compare-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: var(--space-2);
  }
  .pl-compare-us .pl-compare-name {
    color: var(--accent);
  }
  .pl-compare-price {
    font-family: var(--font-display);
    font-size: 56px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--text-strong);
    margin-bottom: var(--space-5);
  }
  .pl-compare-per {
    font-size: 16px;
    font-weight: 500;
    color: var(--text-muted);
    margin-left: 4px;
    letter-spacing: 0;
  }
  .pl-compare-feats {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--text);
  }
  .pl-compare-bullet {
    display: inline-block;
    min-width: 44px;
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-muted);
    margin-right: 8px;
  }
  .pl-compare-check {
    display: inline-block;
    min-width: 22px;
    color: var(--accent);
    font-weight: 700;
  }
  .pl-compare-missing {
    color: var(--text-muted);
    font-style: italic;
  }
  .pl-compare-footer {
    max-width: 720px;
    margin: var(--space-6) auto 0;
    text-align: center;
    font-size: 16px;
    line-height: 1.55;
    color: var(--text);
  }
  .pl-compare-footer strong {
    color: var(--text-strong);
    background-image: linear-gradient(transparent 62%, rgba(140, 109, 255, 0.18) 62%);
  }
  @media (max-width: 720px) {
    .pl-compare-grid { grid-template-columns: 1fr; }
    .pl-compare-price { font-size: 44px; }
  }

  /* FAQ */
  .pl-faq {
    max-width: 760px;
    margin: 0 auto;
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .pl-faq-item { border-bottom: 1px solid var(--border-subtle); }
  .pl-faq-item:last-child { border-bottom: none; }
  .pl-faq-q {
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
  .pl-faq-q::-webkit-details-marker { display: none; }
  .pl-faq-q:hover { background: var(--bg-hover); }
  .pl-faq-toggle {
    font-family: var(--font-mono);
    font-size: 18px;
    color: var(--text-muted);
    transition: transform var(--t-base) var(--ease-spring);
    flex-shrink: 0;
  }
  .pl-faq-item[open] .pl-faq-toggle { transform: rotate(45deg); color: var(--accent); }
  .pl-faq-a {
    padding: 0 24px 20px;
    color: var(--text-muted);
    font-size: var(--t-sm);
    line-height: 1.6;
    margin: 0;
  }

  /* CTA */
  .pl-cta-wrap { margin: var(--s-16) auto var(--s-10); }
  .pl-cta {
    position: relative;
    text-align: center;
    padding: var(--s-12) var(--s-6);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-2xl);
    background:
      radial-gradient(60% 100% at 50% 0%, rgba(140,109,255,0.14), transparent 65%),
      var(--bg-elevated);
    overflow: hidden;
  }
  .pl-cta-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.5vw, 40px);
    line-height: 1.1;
    letter-spacing: -0.025em;
    font-weight: 600;
    margin: 0 0 var(--s-3);
    color: var(--text-strong);
  }
  .pl-cta-sub {
    font-size: var(--t-md);
    color: var(--text-muted);
    margin: 0 auto var(--s-6);
    max-width: 480px;
  }
  .pl-cta-buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
  }

  /* Every-plan strip */
  .pl-every-plan { margin: calc(var(--s-14) * -0.5) auto var(--s-10); }
  .pl-every-plan-inner {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
    justify-content: center;
    padding: 14px 28px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--r-full);
    background: var(--bg-elevated);
    max-width: 760px;
    margin: 0 auto;
    font-size: 13px;
  }
  .pl-every-plan-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .pl-every-plan-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    gap: 0;
    flex-wrap: wrap;
    justify-content: center;
  }
  .pl-every-plan-list li {
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .pl-every-plan-list li + li::before {
    content: '·';
    color: var(--text-muted);
    margin-right: 10px;
  }

  /* Responsive */
  @media (max-width: 960px) {
    .pl-plans { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 720px) {
    .pl-host-grid { grid-template-columns: 1fr; }
    .pl-free-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 560px) {
    .pl-plans { grid-template-columns: 1fr; }
    .pl-cta-buttons .btn { width: 100%; justify-content: center; }
  }
`;

export default pricing;
