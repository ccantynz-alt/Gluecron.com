# GateTest ↔ GlueCron integration

GlueCron exposes **two** inbound paths for GateTest to report scan results back.
Use the primary path for normal traffic; the backup path exists so you always
have a way in if the shared secret is misconfigured.

Base URL: `https://<your-gluecron-host>` (e.g. `https://gluecron.com`)

---

## Primary: shared-secret hook

**URL:** `POST /api/hooks/gatetest`

### Auth (pick one)

**Option A — Bearer token**
```
Authorization: Bearer <GATETEST_CALLBACK_SECRET>
```
or if the GateTest side can't set `Authorization`:
```
X-GateTest-Token: <GATETEST_CALLBACK_SECRET>
```

**Option B — HMAC-SHA256 over raw body**
```
X-GateTest-Signature: sha256=<hex(hmac_sha256(GATETEST_HMAC_SECRET, rawBody))>
```

Both are compared with a timing-safe equality check.

### Request body (JSON)

```json
{
  "repository": "owner/name",
  "sha": "0123abcd0123abcd0123abcd0123abcd01234567",
  "ref": "refs/heads/main",
  "pullRequestNumber": 42,
  "status": "passed",
  "summary": "12 tests passed, 0 failed, 3.4s",
  "details": { "...": "arbitrary JSON, persisted as-is" },
  "durationMs": 3400
}
```

| Field | Required | Notes |
|---|---|---|
| `repository` | ✅ | `"owner/name"` |
| `sha` | ✅ | full 40-char commit SHA |
| `status` | ✅ | `"passed"` \| `"failed"` \| `"error"` \| `"success"` |
| `ref` | optional | defaults to `refs/heads/main` |
| `pullRequestNumber` | optional | links the gate run to a PR |
| `summary` | optional | shown on the gates UI |
| `details` | optional | arbitrary JSON, stored verbatim |
| `durationMs` | optional | for metrics |

### Response

```json
{ "ok": true, "gateRunId": "uuid-of-the-inserted-row" }
```

On failure:
- `400` — invalid JSON or missing required fields
- `401` — missing / invalid credentials
- `404` — repository not known to GlueCron
- `500` — DB error (retry-safe, idempotent on sha + gate_name)

### Side effects on a `failed` status
1. Row inserted in `gate_runs`
2. In-app notification to the repo owner (kind `gate_failed`)
3. Entry in `audit_log` (action `gate_callback`)

---

## Backup: personal access token

**URL:** `POST /api/v1/gate-runs`

### Auth
Standard GlueCron PAT, created at `/settings/tokens`:
```
Authorization: Bearer glc_<64-hex-chars>
```
Alternative header if Bearer isn't possible:
```
X-API-Token: glc_<64-hex-chars>
```

### Request body
Identical to the primary path, plus optional `gateName`:
```json
{
  "repository": "owner/name",
  "sha": "...",
  "status": "passed",
  "gateName": "GateTest",
  "summary": "...",
  "details": { }
}
```

### Authorisation rules
- The PAT's owner must match the repo's owner (MVP rule — will expand with orgs/teams in Block B).
- Token is rejected if expired.
- Successful use updates `api_tokens.last_used_at`.

### Listing prior runs
```
GET /api/v1/gate-runs?repository=owner/name&limit=20
Authorization: Bearer glc_...
```

Returns:
```json
{ "ok": true, "runs": [ {...}, ... ] }
```

---

## Liveness probe (no auth)

```
GET /api/hooks/ping
```
Returns:
```json
{
  "ok": true,
  "service": "gluecron",
  "hooks": ["gatetest", "gatetest/recent", "api/v1/gate-runs (backup)"],
  "timestamp": "2026-04-14T..."
}
```

Use this in GateTest's connectivity check before trying an authenticated call.

---

## Configuring the secrets

On the GlueCron host (Railway / Fly / Docker) set either or both:
```
GATETEST_CALLBACK_SECRET=<long random bearer token>
GATETEST_HMAC_SECRET=<long random HMAC key>
```

Generate with:
```bash
openssl rand -hex 32
```

Share the same value with GateTest. **If neither is set, the callback endpoint
refuses all requests** — there is no anonymous write path by design.

---

## Example curl (primary path)

```bash
curl -X POST "https://gluecron.com/api/hooks/gatetest" \
  -H "Authorization: Bearer $GATETEST_CALLBACK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "repository": "alice/webapp",
    "sha": "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
    "ref": "refs/heads/main",
    "status": "failed",
    "summary": "2 tests failed in src/auth.test.ts",
    "durationMs": 4812
  }'
```

Response:
```json
{ "ok": true, "gateRunId": "b7f3e2a1-..." }
```

The repo owner immediately sees a red notification; the run shows up at
`/<owner>/<repo>/gates`.
