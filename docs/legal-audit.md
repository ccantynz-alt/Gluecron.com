# Gluecron Legal Pages Audit

**Date:** 2026-04-16
**Branch:** `claude/setup-multi-repo-dev-BCwNQ`
**Scope:** Inventory of user-facing legal pages on gluecron.com ahead of attorney review.

## Summary

**No user-facing legal pages exist** in the Gluecron codebase as of this audit.

A filesystem search of `src/routes/` and `src/views/` for the conventional filenames
(`legal.*`, `terms.*`, `privacy.*`, `tos.*`, `eula.*`, `dmca.*`, `cookies.*`)
returned zero matches. A broader substring grep across `src/` for the words
`terms`, `privacy`, and `legal` surfaced only unrelated hits (a rate-limit
error message and a test describing "legal characters" in a package-name
validator) - no user-visible policy documents, no routes, no views, no links
in the footer or navigation.

The layout footer (`src/views/layout.tsx`) currently renders only the tagline
"gluecron - AI-native code intelligence" with no links to Terms, Privacy,
Acceptable Use, DMCA, or any other policy page.

## Implication

Gluecron has **no independent legal surface** at this time. There are two
defensible postures heading into attorney review; the attorney should be
briefed on both so they can direct which path is taken before public launch:

### Scenario A - Gluecron operates under Crontech's umbrella legal terms

If the business structure is that Crontech is the legal entity and Gluecron
is a product surface of that entity, then Crontech's published Terms,
Privacy Policy, Acceptable Use Policy, and DMCA notice would apply to
Gluecron users by reference.

Required before launch under this scenario:
- Crontech's existing legal pages must explicitly name Gluecron and git
  hosting as covered products (or the umbrella clause must be demonstrably
  broad enough to cover user-uploaded code, git pushes, and third-party
  code hosted on behalf of users).
- A footer link on every Gluecron page pointing to the Crontech legal pages
  so users have notice and can locate the governing terms.
- Any Gluecron-specific data flows (e.g. git clone/push logs, SSH key
  retention, webhook payload retention, AI ingestion of hosted code) must
  be reflected in Crontech's privacy policy or addressed in a Gluecron
  supplement.

### Scenario B - Gluecron requires independent legal pages before public launch

If Gluecron is (or will be) a separately-branded product with distinct
risk surface (user-uploaded code, third-party repositories, AI review of
private code, DMCA takedowns, export-controlled content), independent
legal pages are likely required regardless of the corporate relationship
to Crontech.

Required before launch under this scenario:
- Terms of Service (including acceptable use, content licensing grant
  from users to the platform for the purpose of hosting/serving, AI
  processing disclosure).
- Privacy Policy (covering git hosting data, SSH keys, webhooks,
  access logs, AI ingestion, retention, subprocessors).
- DMCA / Copyright policy (with a designated agent - statutory
  requirement for safe harbor under 17 U.S.C. § 512).
- Acceptable Use Policy (malware hosting, phishing kits, abuse,
  rate-limit bypass).
- Cookie / tracking notice if any analytics or third-party embeds are
  used on the public site.

## Recommendation to Attorney

Brief the attorney on **both** scenarios. Ask them to:

1. Advise which posture Gluecron should adopt at launch (umbrella vs.
   standalone).
2. If umbrella: confirm Crontech's existing pages cover Gluecron's risk
   surface, or list the gaps that need patching.
3. If standalone: provide drafts (or approve drafts) for Terms, Privacy,
   DMCA, and Acceptable Use.
4. In either case, confirm the pre-launch banner currently shipped on
   gluecron.com ("Pre-launch - Gluecron is in final validation. Public
   signups and git hosting for non-owner users open after launch review.")
   is sufficient to manage reliance expectations during the validation
   window.

## Appendix - Files inspected

- `src/routes/` - no legal-related routes
- `src/views/layout.tsx` - footer has no legal links
- `src/views/` - no legal-related view files
- `docs/` - did not exist prior to this audit
- Grep of `src/` for `terms`, `privacy`, `legal` (case-insensitive) -
  only non-legal hits (rate-limit error string, test description)
