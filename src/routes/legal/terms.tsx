/**
 * Terms of Service — aggressive defensive posture.
 *
 * DRAFT — requires attorney review before any paid launch.
 * Purpose: establish maximum legal protection for Gluecron during
 * pre-launch. Plain-English draft intended to be redlined by counsel.
 */

import { Hono } from "hono";
import { Layout } from "../../views/layout";
import { softAuth } from "../../middleware/auth";
import type { AuthEnv } from "../../middleware/auth";

const terms = new Hono<AuthEnv>();

terms.use("*", softAuth);

terms.get("/legal/terms", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Terms of Service" user={user}>
      <article style="max-width: 820px; margin: 0 auto; line-height: 1.7; font-size: 15px">
        <h1 style="font-size: 28px; margin-bottom: 8px">Terms of Service</h1>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 24px">
          DRAFT — requires attorney review. Last updated: 2026-04-16.
        </p>

        <div
          style="background: rgba(210, 153, 34, 0.1); border: 1px solid var(--yellow); color: var(--yellow); padding: 12px 16px; border-radius: var(--radius); margin-bottom: 24px; font-size: 13px"
        >
          <strong>DRAFT notice.</strong> Gluecron is in pre-launch. These Terms
          are a good-faith draft and have not yet been reviewed by counsel.
          They will be finalized and updated before general availability. If
          you are relying on any provision of these Terms, contact
          support@gluecron.com for written confirmation first.
        </div>

        <h2>1. Acceptance</h2>
        <p>
          By accessing or using Gluecron (the "Service"), you agree to be bound
          by these Terms of Service ("Terms"). If you do not agree, do not use
          the Service. Your use of the Service constitutes your binding
          acceptance, whether or not you create an account.
        </p>

        <h2>2. Service description</h2>
        <p>
          Gluecron is a git hosting, code collaboration, and AI-assisted code
          intelligence platform. The Service is currently in a pre-launch /
          final validation phase. Features, availability, and pricing may
          change without notice. Nothing in the Service is guaranteed to be
          production-ready, continuously available, or backed by a service
          level agreement unless agreed to in a separate, signed writing.
        </p>

        <h2>3. User accounts</h2>
        <p>
          You must be at least 18 years of age to create an account. You must
          provide accurate and current registration information, and you are
          solely responsible for all activity under your account, including
          maintaining the confidentiality of your credentials, tokens,
          passkeys, and SSH keys. We intend to offer multi-factor
          authentication; enabling it is your responsibility. We are not
          liable for any loss arising from unauthorized access to your
          account.
        </p>

        <h2>4. Acceptable use</h2>
        <p>
          Your use of the Service is governed by our{" "}
          <a href="/legal/acceptable-use">Acceptable Use Policy</a> ("AUP"),
          which is incorporated into these Terms by reference. Violation of
          the AUP is a material breach of these Terms.
        </p>

        <h2>5. Intellectual property</h2>
        <p>
          You retain all ownership of the content, code, and data you push,
          upload, or submit to the Service ("User Content"). You grant
          Gluecron a worldwide, non-exclusive, royalty-free license to host,
          store, reproduce, transmit, display, and create derivative works of
          your User Content, solely as needed to operate, maintain, secure,
          analyze, and improve the Service, including for AI features you
          invoke. You represent and warrant that you have all rights
          necessary to grant this license.
        </p>

        <h2>6. AI features</h2>
        <p>
          The Service includes AI-assisted features (code review, chat,
          explanations, test generation, auto-repair, dependency updates,
          incident summaries, semantic search). AI output is provided on an
          informational basis only. <strong>AI output is not professional
          advice</strong>, is not a substitute for human review, and may be
          incorrect, incomplete, or unsafe. You are solely responsible for
          reviewing, testing, and validating any AI output before relying on
          it. AI output may be generated in part by third-party large language
          model providers; we do not warrant the accuracy, fitness,
          originality, or non-infringement of any AI output. <em>DRAFT —
          requires attorney review.</em>
        </p>

        <h2>7. Binding individual arbitration &amp; class-action waiver</h2>
        <p>
          <strong>Please read this section carefully.</strong> You and
          Gluecron agree that any dispute, claim, or controversy arising out
          of or relating to these Terms or the Service shall be resolved
          exclusively by binding individual arbitration, and not in a class,
          collective, or representative proceeding. The arbitration shall be
          administered under the rules of the American Arbitration Association
          ("AAA") or JAMS (claimant's choice). The arbitrator may award only
          individual relief. <strong>You waive any right to participate in a
          class action, class arbitration, or representative proceeding.</strong>
        </p>
        <p>
          <strong>30-day mail-in opt-out.</strong> You may opt out of this
          arbitration agreement by mailing a written, signed opt-out notice
          containing your name, username, and a clear statement that you wish
          to opt out, to the address we publish on our contact page, within
          30 days of first accepting these Terms. Opt-out is effective only
          if postmarked within that window.
        </p>
        <p>
          <strong>Small-claims carve-out.</strong> Either party may bring an
          individual action in small-claims court instead of arbitration, so
          long as the action remains in that court and is brought
          individually.
        </p>
        <p>
          <em>DRAFT — requires attorney review; AAA/JAMS choice, seat of
          arbitration, and consumer-arbitration fee allocation must be
          reconciled with New Zealand governing law (see Section 14).</em>
        </p>

        <h2>8. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE TOTAL
          AGGREGATE LIABILITY OF GLUECRON, ITS AFFILIATES, OFFICERS,
          EMPLOYEES, CONTRACTORS, AND AGENTS, ARISING OUT OF OR RELATING TO
          THESE TERMS OR THE SERVICE, SHALL NOT EXCEED THE GREATER OF (A)
          ONE HUNDRED U.S. DOLLARS ($100 USD) OR (B) THE FEES YOU ACTUALLY
          PAID TO GLUECRON FOR THE SERVICE IN THE TWELVE (12) MONTHS
          IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM. Because
          Gluecron has no billing yet during pre-launch, this cap is
          effectively $100 USD. <em>DRAFT — requires attorney review.</em>
        </p>

        <h2>9. No consequential damages</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, GLUECRON SHALL NOT BE
          LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
          PUNITIVE, OR EXEMPLARY DAMAGES, INCLUDING BUT NOT LIMITED TO LOST
          PROFITS, LOST REVENUE, LOST DATA, LOST GOODWILL, BUSINESS
          INTERRUPTION, OR COST OF SUBSTITUTE SERVICES, WHETHER ARISING IN
          CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR
          OTHERWISE, AND WHETHER OR NOT GLUECRON HAS BEEN ADVISED OF THE
          POSSIBILITY OF SUCH DAMAGES.
        </p>

        <h2>10. AS-IS / AS-AVAILABLE; no warranties</h2>
        <p>
          THE SERVICE IS PROVIDED <strong>"AS IS" AND "AS AVAILABLE"</strong>{" "}
          WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. GLUECRON
          DISCLAIMS ALL WARRANTIES, INCLUDING WITHOUT LIMITATION THE IMPLIED
          WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
          NON-INFRINGEMENT, TITLE, ACCURACY, UNINTERRUPTED OR ERROR-FREE
          OPERATION, OR THAT ANY DEFECTS WILL BE CORRECTED. WE DO NOT WARRANT
          THAT THE SERVICE WILL MEET YOUR REQUIREMENTS, THAT ANY AI OUTPUT IS
          ACCURATE OR SAFE, OR THAT YOUR DATA WILL NOT BE LOST.
        </p>

        <h2>11. Indemnification</h2>
        <p>
          You agree to indemnify, defend, and hold harmless Gluecron, its
          affiliates, officers, directors, employees, contractors, and agents
          from and against any and all claims, liabilities, damages, losses,
          costs, and expenses (including reasonable attorneys' fees) arising
          out of or related to: (a) your User Content; (b) your code, data,
          or dependencies; (c) your use of the Service; (d) your violation
          of these Terms, the AUP, or applicable law; (e) your violation of
          any third-party right, including any intellectual property, privacy,
          or publicity right; or (f) any claim that your User Content caused
          damage to a third party.
        </p>

        <h2>12. Termination and suspension</h2>
        <p>
          We may suspend or terminate your account, any individual repository,
          or your access to any portion of the Service, at any time, for any
          reason or no reason, with or without notice, at our sole discretion.
          Upon termination, we intend to retain your data for thirty (30) days
          to allow for export or reinstatement, after which we intend to
          purge it, though we make no guarantee of recoverability.
        </p>

        <h2>13. Prohibited uses</h2>
        <p>
          Without limiting the <a href="/legal/acceptable-use">AUP</a>, you
          may not use the Service to: (a) host, distribute, or develop illegal
          content; (b) host, store, transmit, or generate child sexual abuse
          material ("CSAM"), which will result in immediate termination and
          reporting to law enforcement; (c) develop, distribute, or execute
          malware, viruses, ransomware, or other harmful code; (d) conduct
          stress tests, denial-of-service attacks, or load tests against the
          Service or any third party; (e) reverse-engineer, decompile, or
          disassemble the Service; or (f) scrape, crawl, or use automated
          means to access the Service except as permitted by our public APIs.
        </p>

        <h2>14. Governing law</h2>
        <p>
          These Terms are governed by and construed in accordance with the
          laws of <strong>New Zealand</strong>, without regard to conflict-of-law
          principles. Subject to Section 7, the courts of New Zealand shall
          have exclusive jurisdiction over any dispute not subject to
          arbitration. <em>DRAFT — requires attorney review; NZ governing
          law is inferred from the founder's handle and must be confirmed
          or changed by counsel.</em>
        </p>

        <h2>15. Export controls and sanctions</h2>
        <p>
          You represent and warrant that you are not located in, and are not
          a national or resident of, any country that is subject to a
          comprehensive U.S., U.K., E.U., or U.N. embargo, and that you are
          not on any government list of prohibited or restricted parties. You
          agree to comply with all applicable export-control and sanctions
          laws, including the U.S. Export Administration Regulations and
          sanctions administered by the U.S. Treasury Department's Office of
          Foreign Assets Control ("OFAC"). You will not use the Service to
          develop, design, manufacture, or produce any weapon of mass
          destruction.
        </p>

        <h2>16. Force majeure</h2>
        <p>
          Gluecron shall not be liable for any failure or delay in
          performance caused by circumstances beyond our reasonable control,
          including acts of God, natural disasters, war, terrorism, riots,
          civil unrest, government action, epidemics or pandemics, labor
          shortages, internet or telecommunications outages, third-party
          service-provider failures (including hosting, DNS, CDN, database,
          or AI providers), cyberattacks, or power failures.
        </p>

        <h2>17. Severability and entire agreement</h2>
        <p>
          If any provision of these Terms is held invalid or unenforceable,
          that provision shall be enforced to the maximum extent permissible,
          and the remaining provisions shall remain in full force and effect.
          These Terms, together with the AUP, Privacy Policy, and DMCA
          Policy, constitute the entire agreement between you and Gluecron
          with respect to the Service, and supersede all prior or
          contemporaneous understandings.
        </p>

        <h2>18. Changes to these Terms</h2>
        <p>
          We intend to provide thirty (30) days' notice of material changes
          to these Terms, by email to the address on your account or by
          posting a notice in the Service. Your continued use of the Service
          after the effective date of any change constitutes your acceptance
          of the revised Terms. We may, at our discretion, make non-material
          changes (clarifications, typo fixes) without notice.
        </p>

        <hr style="margin: 32px 0; border: none; border-top: 1px solid var(--border)" />
        <p style="font-size: 13px; color: var(--text-muted)">
          See also:{" "}
          <a href="/legal/privacy">Privacy Policy</a> ·{" "}
          <a href="/legal/acceptable-use">Acceptable Use Policy</a> ·{" "}
          <a href="/legal/dmca">DMCA Policy</a>
        </p>
      </article>
    </Layout>
  );
});

export default terms;
