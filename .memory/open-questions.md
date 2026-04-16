# GlueCron — Open Questions

> Items that need owner input or a decision before building.

## Active

### Q001: GateTest repair boundaries
- **Question:** What types of failures should GateTest auto-fix vs escalate to a human?
- **Context:** Building the self-healing loop. Auto-fixing lint/format is safe. Auto-fixing logic bugs is risky.
- **Proposed answer:** Auto-fix: formatting, import ordering, unused variables, missing semicolons, secret redaction, simple type errors. Escalate: logic changes, API contract changes, test failures that require new test logic, security vulnerabilities requiring architectural changes.
- **Status:** Awaiting confirmation

### Q002: Client-side interactivity timeline
- **Question:** When does the platform need client-side JS beyond SSE?
- **Context:** Currently pure SSR. SSE handles real-time. But features like drag-and-drop project boards, inline code editing, and live collaborative review need JS.
- **Proposed answer:** Build with progressive enhancement — SSR first, sprinkle vanilla JS for specific interactions (code editor, drag-drop). No React/Vue/Svelte until proven necessary.
- **Status:** Low priority, track demand

### Q003: Pricing model
- **Question:** Free tier limits, paid tier features, enterprise tier
- **Context:** SBOM is free (differentiator). What else is free vs paid?
- **Status:** Not yet discussed

### Q004: Legal review of flywheel
- **Question:** Owner mentioned needing to review legal implications of the flywheel
- **Context:** The flywheel learns from code review outcomes. Need to verify: data ownership, privacy (does it learn across repos?), GDPR compliance for EU users.
- **Proposed answer:** Flywheel patterns are scoped per-repo by default. Global patterns only from aggregated, anonymized data. Users can opt out via repo settings.
- **Status:** Owner flagged for later review

## Resolved

(none yet)
