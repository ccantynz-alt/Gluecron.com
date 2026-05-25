# Gluecron License Change Notice

**Status:** Announced 2026-05-25 · Effective with v1.0 release · Pending counsel review

## What's changing

Gluecron is moving from the **MIT License** to the **GNU Affero General
Public License v3.0 (AGPL-3.0)** effective with the v1.0 release.

The current `LICENSE` file (MIT) continues to apply to every commit up
to the v1.0 cutover. From v1.0 onwards, all new contributions and the
codebase as a whole are licensed under AGPL-3.0.

## Why

### The short answer

The AGPL is the only widely-recognised license that closes the
"network-use loophole." If someone takes Gluecron, modifies it, and runs
it as a service — they must publish their modifications. Other licenses
(MIT, Apache, even GPL) let cloud vendors privatise improvements.

### The strategic answer

Gluecron is built to be the AI-native git platform for the next decade.
We need to ensure:

1. **The platform stays open.** AGPL guarantees every Gluecron
   instance, anywhere, contributes back any modifications it ships
   to its users.

2. **Hyperscale forks return value.** Microsoft, AWS, GCP — if any of
   them fork Gluecron and run it as a managed service, AGPL forces
   them to release their changes. MIT/Apache let them do so without
   contribution.

3. **The community benefits from every deployment.** Whether you run
   Gluecron at home, in an enterprise, or as a SaaS — your improvements
   flow back to the commons.

### What this means for you

- **You can still use Gluecron commercially.** AGPL doesn't restrict
  commercial use. Run it for your company, your customers, your SaaS —
  all permitted.
- **You must share modifications you ship to users.** If you modify
  Gluecron and run that modified version as a network service that
  your users interact with, you must make the modified source code
  available to those users.
- **Private internal modifications are fine without disclosure.**
  AGPL only triggers when your modified version is offered as a
  service to others. Internal-only changes have no disclosure
  requirement.

## What about my existing fork/integration?

Anything you forked or integrated against under the MIT license
**stays MIT-licensed**. You don't have to retroactively re-license
work that was done before the v1.0 cutover.

For integrations against the Gluecron API (Holden Mercer, Crontech,
Cursor, etc.) — the API contract is unchanged. Your integration code
remains under whatever license you originally chose.

## What about Crontech?

Crontech and Gluecron are sister platforms. The AGPL change is
neutral on the Crontech ↔ Gluecron edge-layer relationship — Crontech
acts as a network service in front of Gluecron, not a fork of it. No
AGPL implications for that integration.

## What about contributors?

By submitting a PR to Gluecron after the v1.0 cutover, you agree to
license your contribution under AGPL-3.0. Pre-v1.0 contributions
remain under MIT.

## When does v1.0 ship?

v1.0 is the "platform stability" milestone. We'll cut it once:
- The closed-loop core (spec → code → ship → monitor) is stable
- Agent multiplayer is production-tested at scale
- We have at least one external enterprise customer in production
- Counsel has reviewed the AGPL transition

Target: late 2026 calendar year.

## The single sentence

**Gluecron will be open source forever. AGPL guarantees that
"forever" includes every hyperscale fork of us, not just every
self-host of us.**

— Gluecron team, 2026-05-25
