/**
 * DMCA Copyright Policy — 17 USC §512 notice-and-takedown procedure.
 *
 * DRAFT — requires attorney review. Designated-agent registration with
 * the U.S. Copyright Office has not yet been completed; safe-harbor
 * protection is not assured during this interim pre-launch period.
 */

import { Hono } from "hono";
import { Layout } from "../../views/layout";
import { softAuth } from "../../middleware/auth";
import type { AuthEnv } from "../../middleware/auth";

const dmca = new Hono<AuthEnv>();

dmca.use("*", softAuth);

dmca.get("/legal/dmca", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="DMCA Policy" user={user}>
      <article style="max-width: 820px; margin: 0 auto; line-height: 1.7; font-size: 15px">
        <h1 style="font-size: 28px; margin-bottom: 8px">
          DMCA Copyright Policy
        </h1>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 24px">
          DRAFT — requires attorney review. Last updated: 2026-04-16.
        </p>

        <div
          style="background: rgba(210, 153, 34, 0.1); border: 1px solid var(--yellow); color: var(--yellow); padding: 12px 16px; border-radius: var(--radius); margin-bottom: 24px; font-size: 13px"
        >
          <strong>DRAFT notice.</strong> Gluecron is in pre-launch. This DMCA
          Policy has not yet been reviewed by counsel.
        </div>

        <h2>1. Notice-and-takedown procedure</h2>
        <p>
          Gluecron respects the intellectual-property rights of others and
          expects its users to do the same. In accordance with the Digital
          Millennium Copyright Act ("DMCA"), 17 U.S.C. &sect; 512, we will
          respond expeditiously to properly-formed notices of alleged
          copyright infringement submitted by the copyright owner or their
          authorized agent.
        </p>

        <h2>2. Designated agent</h2>
        <p>
          <strong>Interim-period notice.</strong> We intend to register a
          DMCA designated agent with the U.S. Copyright Office prior to
          operating as a paid hosting provider. Until that registration is
          complete, please send DMCA notices to{" "}
          <strong>dmca@gluecron.com</strong> (placeholder).{" "}
          <strong>
            Safe-harbor protection under 17 U.S.C. &sect; 512(c) is not
            assured during this interim period.
          </strong>{" "}
          We will nonetheless process properly-formed notices in good faith.{" "}
          <em>DRAFT — requires attorney review.</em>
        </p>

        <h2>3. Required notice elements (17 U.S.C. &sect; 512(c)(3))</h2>
        <p>
          A valid DMCA notice must include all of the following:
        </p>
        <ol>
          <li>
            A physical or electronic signature of a person authorized to
            act on behalf of the owner of the exclusive right that is
            allegedly infringed.
          </li>
          <li>
            Identification of the copyrighted work claimed to have been
            infringed, or, if multiple copyrighted works at a single online
            site are covered, a representative list of such works.
          </li>
          <li>
            Identification of the material claimed to be infringing or the
            subject of infringing activity, and information reasonably
            sufficient to permit us to locate the material (e.g., a URL on
            Gluecron, repository owner and name, commit SHA, file path).
          </li>
          <li>
            Information reasonably sufficient to permit us to contact the
            complaining party, including name, mailing address, telephone
            number, and email address.
          </li>
          <li>
            A statement that the complaining party has a good-faith belief
            that the use of the material in the manner complained of is not
            authorized by the copyright owner, its agent, or the law.
          </li>
          <li>
            A statement that the information in the notification is
            accurate, and <strong>under penalty of perjury</strong>, that
            the complaining party is authorized to act on behalf of the
            owner of an exclusive right that is allegedly infringed.
          </li>
        </ol>
        <p>
          Notices missing any of these elements may be invalid and we may
          decline to act on them.
        </p>

        <h2>4. Counter-notice procedure (17 U.S.C. &sect; 512(g))</h2>
        <p>
          If you believe material you posted was removed or disabled as a
          result of mistake or misidentification, you may submit a
          counter-notice to <strong>dmca@gluecron.com</strong> (placeholder)
          containing the following:
        </p>
        <ol>
          <li>Your physical or electronic signature.</li>
          <li>
            Identification of the material that was removed or disabled, and
            the location at which the material appeared before removal.
          </li>
          <li>
            A statement <strong>under penalty of perjury</strong> that you
            have a good-faith belief that the material was removed or
            disabled as a result of mistake or misidentification.
          </li>
          <li>
            Your name, address, telephone number, and a statement that you
            consent to the jurisdiction of the U.S. Federal District Court
            for the judicial district in which your address is located (or,
            if your address is outside the U.S., any district in which
            Gluecron may be found), and that you will accept service of
            process from the person who provided the original notice or an
            agent of that person.
          </li>
        </ol>
        <p>
          We may restore the material in not less than 10 and not more than
          14 business days following receipt of a valid counter-notice,
          unless the complaining party notifies us that they have filed an
          action seeking a court order to restrain you from further
          infringement.
        </p>

        <h2>5. Repeat-infringer policy</h2>
        <p>
          In accordance with 17 U.S.C. &sect; 512(i), we have adopted a
          policy of <strong>terminating accounts</strong>, in appropriate
          circumstances and at our sole discretion, of users who are
          determined to be repeat infringers. We consider three or more
          valid takedown notices within any 12-month period sufficient to
          trigger a repeat-infringer review, though we reserve the right to
          terminate at any threshold based on the severity and nature of
          the infringement.
        </p>

        <h2>6. Good-faith requirement and misrepresentation</h2>
        <p>
          Under 17 U.S.C. &sect; 512(f), <strong>any person who knowingly
          materially misrepresents</strong> (a) that material or activity is
          infringing, or (b) that material or activity was removed or
          disabled by mistake or misidentification, <strong>shall be
          liable for any damages</strong> — including costs and attorneys'
          fees — incurred by the alleged infringer, the copyright owner, or
          by Gluecron. Please do not submit false claims.
        </p>

        <hr style="margin: 32px 0; border: none; border-top: 1px solid var(--border)" />
        <p style="font-size: 13px; color: var(--text-muted)">
          See also:{" "}
          <a href="/legal/terms">Terms of Service</a> ·{" "}
          <a href="/legal/privacy">Privacy Policy</a> ·{" "}
          <a href="/legal/acceptable-use">Acceptable Use Policy</a>
        </p>
      </article>
    </Layout>
  );
});

export default dmca;
