/**
 * Acceptable Use Policy — aggressive, explicit prohibitions with
 * zero-tolerance categories and enforcement ladder.
 *
 * DRAFT — requires attorney review.
 */

import { Hono } from "hono";
import { Layout } from "../../views/layout";
import { softAuth } from "../../middleware/auth";
import type { AuthEnv } from "../../middleware/auth";

const acceptableUse = new Hono<AuthEnv>();

acceptableUse.use("*", softAuth);

acceptableUse.get("/legal/acceptable-use", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Acceptable Use Policy" user={user}>
      <article style="max-width: 820px; margin: 0 auto; line-height: 1.7; font-size: 15px">
        <h1 style="font-size: 28px; margin-bottom: 8px">
          Acceptable Use Policy
        </h1>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 24px">
          DRAFT — requires attorney review. Last updated: 2026-04-16.
        </p>

        <div
          style="background: rgba(210, 153, 34, 0.1); border: 1px solid var(--yellow); color: var(--yellow); padding: 12px 16px; border-radius: var(--radius); margin-bottom: 24px; font-size: 13px"
        >
          <strong>DRAFT notice.</strong> This Acceptable Use Policy ("AUP")
          is incorporated by reference into the{" "}
          <a href="/legal/terms">Terms of Service</a>. Violation of this AUP
          is a material breach of the Terms and may result in immediate
          suspension or termination.
        </div>

        <h2>Prohibited uses</h2>
        <p>
          You may not, and may not permit any third party (including your
          users, contributors, or integrations) to, use the Service to
          engage in, promote, or facilitate any of the following:
        </p>
        <ol>
          <li>
            <strong>Illegal content or activity.</strong> Any content or
            activity unlawful in any jurisdiction reasonably connected to
            you, Gluecron, or the intended audience. This includes, without
            limitation, fraud, money laundering, sanctions evasion, illegal
            gambling, illegal drug sale, and trafficking.
          </li>
          <li>
            <strong>Child sexual abuse material ("CSAM").</strong> Zero
            tolerance. Any upload, storage, transmission, generation (including
            via AI features), or solicitation of CSAM results in
            <strong> immediate and permanent account termination</strong>,
            preservation of evidence, and <strong>mandatory reporting to law
            enforcement</strong> and the National Center for Missing &amp;
            Exploited Children ("NCMEC") or equivalent authority, as required
            by applicable law.
          </li>
          <li>
            <strong>Malware and harmful code.</strong> Creating,
            distributing, or operating viruses, worms, trojans, ransomware,
            rootkits, keyloggers, cryptominers deployed without consent, or
            any software designed to damage, disable, or gain unauthorized
            access to systems or data.
          </li>
          <li>
            <strong>Stress testing, DDoS, and security-offensive tooling.</strong>{" "}
            Conducting load tests, stress tests, denial-of-service attacks,
            or vulnerability exploitation against the Service, its
            infrastructure, or any third-party system you are not explicitly
            authorized in writing to test.
          </li>
          <li>
            <strong>Scraping and automated abuse.</strong> Scraping,
            crawling, or automated harvesting of the Service (including web
            UI surfaces) except via our public APIs and within rate limits.
            Use of the Service to scrape or abuse third-party services is
            also prohibited.
          </li>
          <li>
            <strong>Impersonation and deception.</strong> Impersonating any
            person, organization, or Gluecron staff; creating misleading
            usernames, organizations, or repositories; misrepresenting your
            affiliation or authority.
          </li>
          <li>
            <strong>Hate speech, harassment, and threats.</strong> Content
            that incites violence, targets individuals or groups on the
            basis of protected characteristics, or constitutes targeted
            harassment, doxing, or credible threats.
          </li>
          <li>
            <strong>Copyright and trademark infringement.</strong> Posting
            content that infringes a third party's intellectual-property
            rights. See our{" "}
            <a href="/legal/dmca">DMCA Policy</a> for the notice-and-takedown
            procedure.
          </li>
          <li>
            <strong>Privacy violations.</strong> Publishing another person's
            private or personally-identifying information without their
            consent (including doxing, non-consensual imagery, and leaked
            credentials, API keys, or secrets belonging to another party).
          </li>
          <li>
            <strong>Circumventing security or rate limits.</strong>{" "}
            Bypassing, disabling, or interfering with authentication,
            authorization, rate limiting, quota enforcement, or billing
            controls; sharing credentials; creating multiple accounts to
            evade limits or bans.
          </li>
          <li>
            <strong>Commercial abuse of the free tier.</strong> Use of free
            allowances beyond reasonable fair-use limits, including but not
            limited to: re-selling hosting, using Gluecron as a public-good
            CDN for unrelated workloads, or running continuous
            compute-intensive workloads without a paid plan.
          </li>
        </ol>

        <h2>Enforcement</h2>
        <ul>
          <li>
            <strong>Immediate suspension</strong> — for severe violations
            including CSAM, illegal content, active security attacks,
            credible threats, and any conduct posing imminent harm.
            Suspension is at our sole discretion and may occur without prior
            notice.
          </li>
          <li>
            <strong>Warning and temporary suspension</strong> — for lesser
            violations, we may (at our discretion) issue a warning,
            rate-limit the account, temporarily suspend specific features,
            or remove specific content, before full termination.
          </li>
          <li>
            <strong>Appeals</strong> — you may appeal an enforcement action
            by emailing <strong>support@gluecron.com</strong> (placeholder).
            We intend to respond within fourteen (14) days. Our decisions
            are final at our discretion, subject to applicable law.
          </li>
          <li>
            <strong>No refunds.</strong> Accounts terminated for AUP
            violations are not eligible for refunds of any prepaid fees.
          </li>
          <li>
            <strong>Law-enforcement cooperation.</strong> We will cooperate
            with valid legal process and may, at our discretion, preserve
            and disclose account information and content where we believe
            in good faith that disclosure is necessary to prevent imminent
            harm or comply with applicable law.
          </li>
        </ul>

        <hr style="margin: 32px 0; border: none; border-top: 1px solid var(--border)" />
        <p style="font-size: 13px; color: var(--text-muted)">
          See also:{" "}
          <a href="/legal/terms">Terms of Service</a> ·{" "}
          <a href="/legal/privacy">Privacy Policy</a> ·{" "}
          <a href="/legal/dmca">DMCA Policy</a>
        </p>
      </article>
    </Layout>
  );
});

export default acceptableUse;
