# Platform Status — cross-repo contract

The three products (Crontech, Gluecron, GateTest) each expose a small public endpoint:

```
GET /api/platform-status
```

Returns JSON:

```json
{
  "product": "crontech" | "gluecron" | "gatetest",
  "version": "1.0.0",
  "commit": "4c512ce",
  "healthy": true,
  "timestamp": "2026-04-20T12:34:56Z",
  "siblings": {
    "crontech": "https://crontech.ai/api/platform-status",
    "gluecron": "https://gluecron.com/api/platform-status",
    "gatetest": "https://gatetest.io/api/platform-status"
  }
}
```

## Why

Each admin console fetches the other two siblings so the operator can see all three platforms' state from one page. Each customer dashboard fetches its own endpoint (+ any siblings the user has entitlements for) so end users see a unified "your platform" card.

This is the first step of the three-repo platform wiring. It is intentionally small: no auth, no shared packages, no cross-repo SSO. The endpoints only publish non-sensitive product state that is safe to read from any browser session.

## Wire-up status

- **Crontech** (`apps/web/src/routes/api/platform-status.ts`) — auto-picked by SolidStart file router, zero wiring.
- **Gluecron** (`src/routes/platform-status.ts`) — exported Hono handler. Needs one line in `src/app.tsx`:
  ```ts
  import { platformStatus } from "./routes/platform-status";
  app.route("/api/platform-status", platformStatus);
  ```
- **GateTest** (`website/app/api/platform-status/route.ts`) — auto-picked by Next.js App Router, zero wiring.

## Environment variables

Each deploy should set:

- `APP_VERSION` — semver tag (default `"dev"`)
- `GIT_COMMIT` — short SHA (default `"unknown"`)

## CORS

The endpoint sends `Access-Control-Allow-Origin: *` because product status is public — no secrets, no user data, no PII. Safe to poll from any admin browser session or status page.

## Next steps (follow-up PRs)

1. Admin UI widget — add a 3-card grid to each product's existing `/admin` page that fetches all three siblings and renders health + commit + last-seen.
2. Customer onboarding card — show on each product's customer dashboard: "Your status on each product" (bootstrapped from the sibling endpoints, gated by entitlements once SSO lands).
3. Shared identity (SSO) — dedicated follow-up session. Will add an `entitlements` table and require CLAUDE.md PIN per doctrine.
