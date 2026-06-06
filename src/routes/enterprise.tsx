/**
 * Enterprise sales page — GET /enterprise
 *
 * Targets engineering leaders and procurement teams evaluating Gluecron for
 * large-scale or compliance-sensitive deployments. Covers:
 *   - Custom pricing (volume repos, unlimited AI usage)
 *   - SSO (SAML/OIDC, already built)
 *   - Dedicated SLA support
 *   - Data residency (EU / US choice)
 *   - SOC 2 Type II (in progress)
 *   - Audit log SIEM export (GET /api/v2/audit)
 *
 * Contact form: POST /enterprise/contact
 *   Fields: name, company, email, team_size, message
 *   Persisted to the `enterprise_leads` table (migration 0077).
 *   Optionally sends an email alert when ENTERPRISE_LEADS_EMAIL env var is set.
 *
 * Visual style: same dark-theme design language as /pricing and /about.
 * All classes prefixed `.ent-` to avoid bleed.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { db } from "../db";
import { enterpriseLeads } from "../db/schema";

const enterprise = new Hono<AuthEnv>();
enterprise.use("*", softAuth);

// ─── GET /enterprise ────────────────────────────────────────────────────────

enterprise.get("/enterprise", async (c) => {
  const user = c.get("user");
  const submitted = c.req.query("submitted") === "1";
  return c.html(
    <Layout
      title="Enterprise — Gluecron"
      description="AI-native git hosting with the security and compliance your enterprise requires. SSO, SOC 2, audit log SIEM export, dedicated SLA."
      user={user}
    >
      <EnterprisePage submitted={submitted} />
    </Layout>
  );
});

// ─── POST /enterprise/contact ────────────────────────────────────────────────

enterprise.post("/enterprise/contact", async (c) => {
  const body = await c.req.parseBody();

  const name     = String(body.name     ?? "").trim().slice(0, 200);
  const company  = String(body.company  ?? "").trim().slice(0, 200);
  const email    = String(body.email    ?? "").trim().slice(0, 200);
  const teamSize = String(body.team_size ?? "").trim().slice(0, 50);
  const message  = String(body.message  ?? "").trim().slice(0, 4000);

  if (!name || !company || !email || !teamSize) {
    return c.redirect("/enterprise?error=missing_fields");
  }

  // Basic email sanity check
  if (!email.includes("@")) {
    return c.redirect("/enterprise?error=invalid_email");
  }

  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("cf-connecting-ip")
    ?? null;

  try {
    await db.insert(enterpriseLeads).values({
      name,
      company,
      email,
      teamSize,
      message: message || null,
      ip,
    });
  } catch (err) {
    console.error("[enterprise/contact] db error:", err);
    // Don't fail visibly on DB error — still redirect to thank-you
  }

  return c.redirect("/enterprise?submitted=1");
});

// ─── Components ─────────────────────────────────────────────────────────────

const EnterprisePage: FC<{ submitted: boolean }> = ({ submitted }) => (
  <>
    <style dangerouslySetInnerHTML={{ __html: enterpriseCss }} />
    <div class="ent-root">

      {/* ── Hero ── */}
      <header class="ent-hero">
        <div class="ent-hero-hairline" aria-hidden="true" />
        <div class="ent-hero-orb" aria-hidden="true" />
        <div class="eyebrow">Enterprise</div>
        <h1 class="ent-hero-title display">
          Gluecron for{" "}
          <span class="gradient-text">Enterprise</span>
        </h1>
        <p class="ent-hero-sub">
          AI-native git hosting with the security and compliance your team
          requires. Custom pricing, SSO, SOC&nbsp;2, audit log SIEM export,
          and dedicated support — all on the same platform your developers
          already love.
        </p>
        <div class="ent-hero-ctas">
          <a href="#contact" class="btn btn-primary btn-lg">Talk to us</a>
          <a href="/pricing" class="btn btn-ghost btn-lg">See standard plans</a>
        </div>
      </header>

      {/* ── Feature grid ── */}
      <section class="ent-section ent-features">
        <div class="section-header">
          <div class="eyebrow">What you get</div>
          <h2>
            Everything in Team, plus{" "}
            <span class="gradient-text">enterprise-grade controls.</span>
          </h2>
        </div>
        <div class="ent-grid">
          <FeatureCard
            icon="🔐"
            title="Single Sign-On"
            body="SAML 2.0 and OIDC are already built in. Connect your IdP (Okta, Azure AD, Google Workspace, OneLogin) and enforce SSO for your entire organisation in minutes. SCIM provisioning coming Q3."
          />
          <FeatureCard
            icon="📋"
            title="Audit Log & SIEM Export"
            body="Every sensitive action — push, merge, token creation, branch protection change — is captured in a tamper-evident audit log. Stream to Splunk, Datadog, or any SIEM via GET /api/v2/audit."
          />
          <FeatureCard
            icon="🌍"
            title="Data Residency"
            body="Choose EU (Frankfurt) or US (Virginia) as your primary data region. Your code, metadata, and AI inferences never leave your chosen region. Compliance-ready from day one."
          />
          <FeatureCard
            icon="📜"
            title="SOC 2 Type II"
            body="We are in the final stages of our SOC 2 Type II audit (target: Q3 2026). Existing customers receive the report under NDA on request. HIPAA BAA available on Enterprise plans."
          />
          <FeatureCard
            icon="🤝"
            title="Dedicated SLA"
            body="99.9% uptime SLA, 1-hour response for P1 incidents, and a named account engineer. We sign your vendor DPA and join your Slack channel so there is no ticket queue between you and a fix."
          />
          <FeatureCard
            icon="💳"
            title="Custom Pricing"
            body="Volume discounts on repo seats, unlimited AI usage (your Anthropic key or ours), and annual invoicing with NET-30 terms. We will meet your procurement requirements — no credit card walls."
          />
        </div>
      </section>

      {/* ── SIEM detail ── */}
      <section class="ent-section ent-siem">
        <div class="ent-siem-inner">
          <div class="ent-siem-text">
            <div class="eyebrow">Audit log API</div>
            <h2>Pipe every event into your SIEM.</h2>
            <p>
              The <code>GET /api/v2/audit</code> endpoint returns a paginated
              JSON stream of every platform event — repo creates, force pushes,
              token revocations, merge-gate overrides, and more. Filter by
              actor, action prefix, or resource type, and page through millions
              of rows using cursor-based pagination.
            </p>
            <ul class="ent-siem-list">
              <li>ISO 8601 timestamps on every event</li>
              <li>Actor username, IP address, and full metadata payload</li>
              <li>Cursor pagination — no duplicate events across batches</li>
              <li>Compatible with Splunk HEC, Datadog Logs, AWS S3 event sink</li>
            </ul>
          </div>
          <div class="ent-siem-code">
            <div class="ent-code-label">curl example</div>
            <pre class="ent-code">{`GET /api/v2/audit?since=2026-01-01T00:00:00Z&limit=500
Authorization: Bearer glc_<token>

{
  "events": [
    {
      "id": "018e4a...",
      "action": "repo.force_push",
      "actor_id": "abc123",
      "actor_username": "alice",
      "resource_type": "repository",
      "resource_id": "repo-789",
      "metadata": { "ref": "refs/heads/main", "old_sha": "..." },
      "created_at": "2026-06-01T14:23:05.000Z",
      "ip_address": "203.0.113.42"
    }
  ],
  "nextCursor": "018e4b...",
  "hasMore": true
}`}</pre>
          </div>
        </div>
      </section>

      {/* ── Social proof strip ── */}
      <section class="ent-section ent-proof">
        <div class="ent-proof-inner">
          <div class="ent-proof-stat">
            <div class="ent-stat-num">99.9%</div>
            <div class="ent-stat-label">uptime SLA</div>
          </div>
          <div class="ent-proof-divider" aria-hidden="true" />
          <div class="ent-proof-stat">
            <div class="ent-stat-num">1h</div>
            <div class="ent-stat-label">P1 response time</div>
          </div>
          <div class="ent-proof-divider" aria-hidden="true" />
          <div class="ent-proof-stat">
            <div class="ent-stat-num">EU / US</div>
            <div class="ent-stat-label">data residency</div>
          </div>
          <div class="ent-proof-divider" aria-hidden="true" />
          <div class="ent-proof-stat">
            <div class="ent-stat-num">SOC 2</div>
            <div class="ent-stat-label">Type II in progress</div>
          </div>
        </div>
      </section>

      {/* ── Contact form ── */}
      <section id="contact" class="ent-section ent-contact-wrap">
        <div class="ent-contact">
          <div class="ent-contact-header">
            <div class="eyebrow">Get in touch</div>
            <h2>Talk to the team.</h2>
            <p>
              Tell us about your team and what you need. We will reply within
              one business day with a custom proposal.
            </p>
          </div>

          {submitted ? (
            <div class="ent-submitted" role="status">
              <div class="ent-submitted-icon" aria-hidden="true">✓</div>
              <h3>We got it — thanks!</h3>
              <p>
                Expect a reply from our team within one business day. In the
                meantime you can explore{" "}
                <a href="/pricing">our standard plans</a> or{" "}
                <a href="/register">sign up free</a>.
              </p>
            </div>
          ) : (
            <form action="/enterprise/contact" method="post" class="ent-form" novalidate>
              <div class="ent-form-row">
                <div class="ent-field">
                  <label for="ent-name">Your name</label>
                  <input
                    type="text"
                    id="ent-name"
                    name="name"
                    placeholder="Alice Smith"
                    required
                    maxlength={200}
                    autocomplete="name"
                  />
                </div>
                <div class="ent-field">
                  <label for="ent-company">Company</label>
                  <input
                    type="text"
                    id="ent-company"
                    name="company"
                    placeholder="Acme Corp"
                    required
                    maxlength={200}
                    autocomplete="organization"
                  />
                </div>
              </div>
              <div class="ent-form-row">
                <div class="ent-field">
                  <label for="ent-email">Work email</label>
                  <input
                    type="email"
                    id="ent-email"
                    name="email"
                    placeholder="alice@acmecorp.com"
                    required
                    maxlength={200}
                    autocomplete="email"
                  />
                </div>
                <div class="ent-field">
                  <label for="ent-team-size">Team size</label>
                  <select id="ent-team-size" name="team_size" required>
                    <option value="" disabled selected>Select range…</option>
                    <option value="10-50">10 – 50 developers</option>
                    <option value="50-200">50 – 200 developers</option>
                    <option value="200-1000">200 – 1 000 developers</option>
                    <option value="1000+">1 000+ developers</option>
                  </select>
                </div>
              </div>
              <div class="ent-field">
                <label for="ent-message">
                  What are you looking for?{" "}
                  <span class="ent-field-optional">(optional)</span>
                </label>
                <textarea
                  id="ent-message"
                  name="message"
                  rows={5}
                  maxlength={4000}
                  placeholder="Tell us about your stack, compliance requirements, or anything else that would help us put together a proposal."
                />
              </div>
              <button type="submit" class="btn btn-primary btn-lg ent-submit">
                Send message
              </button>
            </form>
          )}
        </div>
      </section>

    </div>
  </>
);

const FeatureCard: FC<{ icon: string; title: string; body: string }> = ({
  icon,
  title,
  body,
}) => (
  <div class="ent-feature-card">
    <div class="ent-feature-icon" aria-hidden="true">{icon}</div>
    <div class="ent-feature-title">{title}</div>
    <p class="ent-feature-body">{body}</p>
  </div>
);

// ─── Scoped CSS ──────────────────────────────────────────────────────────────

const enterpriseCss = `
  .ent-root { max-width: 1180px; margin: 0 auto; padding: 0 16px 80px; }

  /* ── Hero ── */
  .ent-hero {
    text-align: center;
    padding: var(--s-16) 0 var(--s-12);
    position: relative;
    max-width: 820px;
    margin: 0 auto;
  }
  .ent-hero-hairline {
    position: absolute;
    top: 0; left: 8%; right: 8%;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.65;
    pointer-events: none;
    border-radius: 2px;
  }
  .ent-hero-orb {
    position: absolute;
    top: 6%; left: 50%;
    transform: translateX(-50%);
    width: 480px; height: 480px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(90px);
    opacity: 0.65;
    pointer-events: none;
    z-index: -1;
    animation: entHeroOrb 18s ease-in-out infinite;
  }
  @keyframes entHeroOrb {
    0%, 100% { transform: translateX(-50%) scale(1); opacity: 0.5; }
    50%      { transform: translateX(-50%) scale(1.1); opacity: 0.8; }
  }
  @media (prefers-reduced-motion: reduce) { .ent-hero-orb { animation: none; } }
  .ent-hero .eyebrow { justify-content: center; margin: 0 auto var(--s-4); }
  .ent-hero-title {
    font-size: clamp(36px, 6vw, 68px);
    line-height: 1.04;
    letter-spacing: -0.038em;
    margin: 0 0 var(--s-5);
  }
  .ent-hero-sub {
    font-size: clamp(15px, 1.6vw, 18px);
    color: var(--text-muted);
    max-width: 640px;
    margin: 0 auto;
    line-height: 1.6;
  }
  .ent-hero-ctas {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: var(--s-8);
  }

  /* ── Sections ── */
  .ent-section { margin: var(--s-14) auto; }

  /* ── Feature grid ── */
  .ent-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-top: var(--s-8);
  }
  @media (max-width: 900px) { .ent-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { .ent-grid { grid-template-columns: 1fr; } }

  .ent-feature-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    transition: border-color var(--t-fast) var(--ease), transform var(--t-base) var(--ease-out-quart);
  }
  .ent-feature-card:hover {
    border-color: rgba(140,109,255,0.35);
    transform: translateY(-2px);
  }
  .ent-feature-icon {
    font-size: 28px;
    line-height: 1;
  }
  .ent-feature-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.01em;
  }
  .ent-feature-body {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0;
  }

  /* ── SIEM detail ── */
  .ent-siem {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-2xl);
    overflow: hidden;
  }
  .ent-siem-inner {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    align-items: start;
  }
  @media (max-width: 860px) { .ent-siem-inner { grid-template-columns: 1fr; } }
  .ent-siem-text {
    padding: var(--s-10) var(--s-8);
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .ent-siem-text .eyebrow { justify-content: flex-start; }
  .ent-siem-text h2 {
    font-size: clamp(22px, 2.8vw, 32px);
    letter-spacing: -0.025em;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0;
    line-height: 1.2;
  }
  .ent-siem-text p {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.65;
    margin: 0;
  }
  .ent-siem-text code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--accent);
    white-space: nowrap;
  }
  .ent-siem-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ent-siem-list li {
    font-size: var(--t-sm);
    color: var(--text);
    display: flex;
    gap: 10px;
    line-height: 1.5;
  }
  .ent-siem-list li::before {
    content: '✓';
    color: var(--accent);
    font-weight: 700;
    flex-shrink: 0;
  }
  .ent-siem-code {
    background:
      linear-gradient(160deg, rgba(140,109,255,0.06), rgba(54,197,214,0.04) 60%, transparent),
      var(--bg-secondary);
    border-left: 1px solid var(--border);
    padding: var(--s-10) var(--s-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  @media (max-width: 860px) {
    .ent-siem-code { border-left: none; border-top: 1px solid var(--border); }
  }
  .ent-code-label {
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-faint);
  }
  .ent-code {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    background: none;
    border: none;
    padding: 0;
  }

  /* ── Social proof ── */
  .ent-proof {
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
    padding: var(--s-8) var(--s-6);
  }
  .ent-proof-inner {
    display: flex;
    align-items: center;
    justify-content: space-around;
    flex-wrap: wrap;
    gap: var(--s-6);
  }
  .ent-proof-stat { text-align: center; }
  .ent-stat-num {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--text-strong);
    line-height: 1;
  }
  .ent-stat-label {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .ent-proof-divider {
    width: 1px;
    height: 40px;
    background: var(--border);
  }
  @media (max-width: 600px) { .ent-proof-divider { display: none; } }

  /* ── Contact form ── */
  .ent-contact-wrap { margin: var(--s-16) auto; }
  .ent-contact {
    max-width: 760px;
    margin: 0 auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-2xl);
    padding: var(--s-10) var(--s-8);
    position: relative;
    background:
      radial-gradient(60% 100% at 50% 0%, rgba(140,109,255,0.10), transparent 60%),
      var(--bg-elevated);
  }
  .ent-contact-header {
    text-align: center;
    margin-bottom: var(--s-8);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .ent-contact-header .eyebrow { justify-content: center; }
  .ent-contact-header h2 {
    font-size: clamp(24px, 3vw, 36px);
    letter-spacing: -0.025em;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0;
  }
  .ent-contact-header p {
    font-size: var(--t-sm);
    color: var(--text-muted);
    margin: 0;
    line-height: 1.6;
    max-width: 480px;
    margin: 0 auto;
  }
  .ent-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-5);
  }
  .ent-form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-4);
  }
  @media (max-width: 580px) { .ent-form-row { grid-template-columns: 1fr; } }
  .ent-field {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .ent-field label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
  }
  .ent-field-optional {
    font-weight: 400;
    color: var(--text-muted);
    font-size: 12px;
  }
  .ent-field input,
  .ent-field select,
  .ent-field textarea {
    font-family: inherit;
    font-size: var(--t-sm);
    color: var(--text);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--r);
    padding: 10px 14px;
    outline: none;
    transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
    resize: vertical;
  }
  .ent-field input::placeholder,
  .ent-field textarea::placeholder { color: var(--text-faint); }
  .ent-field input:focus,
  .ent-field select:focus,
  .ent-field textarea:focus {
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.12);
  }
  .ent-submit { width: 100%; justify-content: center; margin-top: var(--s-2); }

  /* ── Submitted state ── */
  .ent-submitted {
    text-align: center;
    padding: var(--s-8) var(--s-4);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-4);
  }
  .ent-submitted-icon {
    width: 56px; height: 56px;
    border-radius: 50%;
    background: rgba(52,211,153,0.15);
    border: 2px solid rgba(52,211,153,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    color: var(--green);
    margin: 0 auto;
  }
  .ent-submitted h3 {
    font-size: 22px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0;
  }
  .ent-submitted p {
    color: var(--text-muted);
    font-size: var(--t-sm);
    max-width: 400px;
    margin: 0;
    line-height: 1.6;
  }
  .ent-submitted a { color: var(--accent); }
`;

export default enterprise;
