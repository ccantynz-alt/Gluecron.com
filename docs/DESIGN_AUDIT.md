# Design Audit — gluecron

_Date: 2026-05-14 · Block O3 (visual coherence) snapshot._

A one-page snapshot of the design-system state taken at the end of the
"visual coherence" reconciliation pass. The goal of O3 was not to
redesign — it was to **consolidate** what is already shipping into one
named token language so future polish lands in one place.

## Token map

`src/views/layout.tsx` is the single source of truth. Two layers now
co-exist:

| Concept   | Legacy var      | O3 alias (preferred for new code) |
|-----------|-----------------|------------------------------------|
| Spacing   | `--s-1` … `--s-24`  | `--space-1` … `--space-24` (4px base) |
| Radius    | `--r-sm`/`--r-md`/`--r-lg`/`--r-xl`/`--r-full` | `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-xl` / `--radius-full` |
| Font size | `--t-xs` … `--t-display` | `--font-size-xs` / `-sm` / `-base` / `-md` / `-lg` / `-xl` / `-2xl` / `-3xl` / `-hero` |
| Leading   | _ad-hoc inline_ | `--leading-tight` / `-snug` / `-normal` / `-relaxed` / `-loose` |
| Z-index   | _ad-hoc magic numbers (9997/9998/9999/10000)_ | `--z-base` / `--z-nav` / `--z-sticky` / `--z-overlay` / `--z-modal` / `--z-toast` |
| Color     | `--bg`, `--bg-elevated`, `--text`, `--text-muted`, `--border`, `--accent`, `--green`, `--red`, `--yellow`, `--blue` (unchanged) |

All aliases point at the existing legacy var, so look-and-feel is
byte-identical.

## Files with the most inline-style drift (top 5)

1. `src/routes/dashboard.tsx` — many inline `style="background: rgba(...);..."` patterns.
2. `src/routes/insights.tsx` — repeats the same red/green RGBA tint pattern.
3. `src/routes/billing.tsx` — `style="background:linear-gradient(...)..."`. Adopt `<Card variant="gradient">`.
4. `src/routes/admin.tsx` — administrator-only chrome.
5. `src/routes/migrations.tsx` — error-state borders. Adopt `.notice notice-error`.

## Pages that should adopt `<Card>` (top 10)

1. `src/routes/dashboard.tsx`
2. `src/routes/settings.tsx`
3. `src/routes/admin.tsx`
4. `src/routes/billing.tsx`
5. `src/routes/insights.tsx`
6. `src/routes/onboarding.tsx`
7. `src/routes/explore.tsx`
8. `src/routes/help.tsx`
9. `src/routes/repo-settings.tsx`
10. `src/routes/notifications.tsx`

## What O3 actually changed

- **Token aliases** (additive): `--space-*`, `--radius-*`, `--font-size-*`, `--leading-*`, `--z-*` added to `:root` in `src/views/layout.tsx`.
- **Card primitive** (additive): `<Card padding="..." variant="...">` shape and `.card-p-*` / `.card-elevated` / `.card-gradient` CSS.
- **Notice boxes** (`.notice` + `.notice-{info,success,warn,error,accent}`) replace inline DRAFT / 2FA notice boxes across legal pages.
- **`.code-block`** utility replaces 6 inline pre-tag styles in `help.tsx`.
- **`.email-preview`** utility replaces inline `background:#fff;color:#111` in `settings.tsx`.
- **`.status-pill-operational`** replaces the inline status-page pill.
- **`.api-tag-auth` / `.api-tag-scope`** replace inline method-tag spans in `api-docs.tsx`.
- **Footer extras**: `<Layout siteBannerText="..." siteBannerLevel="warn">` props plus `.footer-version-pill` and `.footer-banner` CSS so the pre-launch banner can be moved off the top of every page.

## Open questions for the next polish pass

1. **Migrate dashboard.tsx panels to `<Card>`** — biggest single win.
2. **Wire the footer banner to the live `site_banner_text` flag.** Layout accepts the prop but no route passes it yet.
3. **Strip the remaining 36 inline-style drift sites.** O3 fixed 12; rest are dashboard/insights stat tiles. A `<Stat>` component would collapse half.
4. **Z-index alias adoption.** `z-index:9999` / `9998` should move to `var(--z-modal)` etc.
5. **Light theme audit.** Notice text-on-tint pairing needs verification on `[data-theme='light']`.

## Operational note on the O3 session

This block was implemented while several parallel agents were also
writing to the same source tree (`account-deletion.ts`, `landing.tsx`,
`form-validation-js.tsx`, etc. were all rewritten by concurrent
work). Several of my edits to `src/views/layout.tsx`,
`src/views/ui.tsx`, and the route files were silently reverted when
the parallel work flushed a snapshot back over the tree. The
inline-style drift fixes (legal pages, settings-2fa, help, settings,
status, api-docs) need to be re-applied in a follow-up pass; the
master CSS tokens + the `<Card>` extension are the durable wins.
