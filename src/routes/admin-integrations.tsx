/**
 * /admin/integrations — DB-stored platform integration secrets.
 *
 *   GET  /admin/integrations   — render the form (masked values)
 *   POST /admin/integrations   — upsert each field + audit-log every change
 *
 * Replaces the SSH-into-the-box workflow for runtime-changeable keys
 * (ANTHROPIC_API_KEY, RESEND_API_KEY, GITHUB_TOKEN, etc.). Boot hook in
 * `src/index.ts` loads saved rows into `process.env` BEFORE any other
 * module reads them, so existing synchronous `config.X` getters keep
 * working transparently — no restart needed.
 *
 * Gated by `isSiteAdmin` using the same `gate()` pattern as
 * `src/routes/admin.tsx`. Scoped CSS prefixed `.admin-int-` to avoid
 * collisions with the parent admin polish.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isSiteAdmin } from "../lib/admin";
import { audit } from "../lib/notify";
import {
  getConfigValue,
  setConfigValue,
  maskSecret,
  isMaskedValue,
  INTEGRATION_FIELDS,
} from "../lib/system-config";

const integrations = new Hono<AuthEnv>();
integrations.use("*", softAuth);

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.admin-int-` so this surface can't
 * bleed into the wider admin panel. Mirrors the gradient-hairline hero +
 * card patterns from commits 07f4b70 and 98eb360.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .admin-int-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .admin-int-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .admin-int-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .admin-int-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .admin-int-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .admin-int-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .admin-int-eyebrow .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .admin-int-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .admin-int-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .admin-int-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 620px;
  }

  .admin-int-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .admin-int-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .admin-int-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  .admin-int-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .admin-int-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .admin-int-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .admin-int-section-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .admin-int-section-body { padding: var(--space-4) var(--space-5); }

  .admin-int-field { margin-bottom: var(--space-4); }
  .admin-int-field:last-child { margin-bottom: 0; }
  .admin-int-field-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: 6px;
  }
  .admin-int-field label {
    display: block;
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .admin-int-input {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .admin-int-input:focus {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .admin-int-hint {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 6px;
    line-height: 1.45;
  }
  .admin-int-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .admin-int-hint a { color: var(--accent); text-decoration: none; }
  .admin-int-hint a:hover { text-decoration: underline; }

  .admin-int-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .admin-int-status.is-set {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .admin-int-status.is-missing {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .admin-int-status .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }

  .admin-int-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  .admin-int-foot-hint {
    margin-right: auto;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  .admin-int-bottom-actions {
    margin-top: var(--space-5);
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .admin-int-bottom-actions a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .admin-int-bottom-actions a:hover { text-decoration: underline; }

  .admin-int-403 {
    max-width: 540px;
    margin: var(--space-12) auto;
    padding: var(--space-6);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
  }
  .admin-int-403 h2 {
    font-family: var(--font-display);
    font-size: 22px;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .admin-int-403 p { color: var(--text-muted); margin: 0; font-size: 14px; }

  /* Solid white .env spec block — high-contrast block the operator copies
     and pastes into their /etc/gluecron.env file. Intentionally light so
     it reads like a printed spec on the dark admin page. */
  .admin-int-spec {
    margin-bottom: var(--space-5);
    background: #ffffff;
    color: #0a0a0a;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.18);
  }
  .admin-int-spec-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-wrap: wrap;
  }
  .admin-int-spec-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-display, system-ui, sans-serif);
    font-size: 14px;
    font-weight: 700;
    color: #111827;
    letter-spacing: -0.005em;
    margin: 0;
  }
  .admin-int-spec-title-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .admin-int-spec-sub {
    font-size: 12px;
    color: #6b7280;
    margin-left: 16px;
  }
  .admin-int-spec-copy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12.5px;
    font-weight: 600;
    color: #111827;
    background: #ffffff;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .admin-int-spec-copy:hover {
    background: #f3f4f6;
    border-color: #9ca3af;
  }
  .admin-int-spec-copy.is-copied {
    background: #ecfdf5;
    border-color: #6ee7b7;
    color: #047857;
  }
  .admin-int-spec-copy svg { display: block; }
  .admin-int-spec-pre {
    margin: 0;
    padding: 18px 20px;
    font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
    font-size: 13px;
    line-height: 1.7;
    color: #0a0a0a;
    background: #ffffff;
    white-space: pre;
    overflow-x: auto;
    tab-size: 2;
  }
  .admin-int-spec-pre .c { color: #6b7280; }
  .admin-int-spec-pre .k { color: #1f2937; font-weight: 600; }
  .admin-int-spec-pre .v { color: #047857; }
  .admin-int-spec-pre .vp { color: #9ca3af; }
  .admin-int-spec-foot {
    padding: 10px 16px;
    border-top: 1px solid #e5e7eb;
    background: #f9fafb;
    font-size: 12px;
    color: #6b7280;
  }
  .admin-int-spec-foot code {
    background: #eef2ff;
    color: #4338ca;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11.5px;
  }
`;

interface GroupDef {
  id: string;
  title: string;
  blurb: string;
}

const GROUPS: Record<string, GroupDef> = {
  platform: {
    id: "platform",
    title: "Platform",
    blurb:
      "Public URL + self-host repo name. APP_BASE_URL must be right or OAuth fails with redirect_uri_mismatch.",
  },
  ai: {
    id: "ai",
    title: "AI",
    blurb: "Anthropic — powers PR review, incident response, commit messages.",
  },
  email: {
    id: "email",
    title: "Email",
    blurb: "Verification, password reset, and magic-link delivery.",
  },
  scm: {
    id: "scm",
    title: "Source control",
    blurb: "GitHub-side API calls (mirror sync, auto-merge sweep).",
  },
  security: {
    id: "security",
    title: "Security",
    blurb: "Push-time security scanning via GateTest.",
  },
  observability: {
    id: "observability",
    title: "Observability",
    blurb: "Deploy timeline + AI incident responder.",
  },
  webhook: {
    id: "webhook",
    title: "Outbound webhooks",
    blurb: "Optional notifications to downstream platforms.",
  },
};

async function gate(c: any): Promise<{ user: any } | Response> {
  const user = c.get("user");
  if (!user) return c.redirect("/login?next=/admin/integrations");
  if (!(await isSiteAdmin(user.id))) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div class="admin-int-403">
          <h2>403 — Not a site admin</h2>
          <p>You don't have permission to view this page.</p>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </Layout>,
      403
    );
  }
  return { user };
}

integrations.get("/admin/integrations", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  // Load every field's current value (DB → env → empty). Run in parallel.
  const values = await Promise.all(
    INTEGRATION_FIELDS.map(async (f) => ({
      field: f,
      value: await getConfigValue(f.key, f.envFallback),
    }))
  );

  const groups = new Map<string, typeof values>();
  for (const v of values) {
    const arr = groups.get(v.field.group) ?? [];
    arr.push(v);
    groups.set(v.field.group, arr);
  }

  const groupOrder: Array<keyof typeof GROUPS> = [
    "platform",
    "ai",
    "email",
    "scm",
    "security",
    "observability",
    "webhook",
  ];

  const msg = c.req.query("result") || c.req.query("error");
  const isErr = !!c.req.query("error");

  const totalConfigured = values.filter((v) => v.value.trim().length > 0).length;

  // Build the copyable .env spec — same key order as the form, grouped by
  // section, with placeholders for unset keys. Real secrets are NOT inlined
  // here (mask them); operators paste this into /etc/gluecron.env and fill
  // in the blanks. Lines are joined with \n; the inline copy JS reads
  // textContent so the rendered string is exactly what the operator pastes.
  const specLines: string[] = [];
  specLines.push("# Gluecron platform integrations");
  specLines.push("# Generated from /admin/integrations — paste into /etc/gluecron.env");
  specLines.push("");
  for (const gid of groupOrder) {
    const items = groups.get(gid);
    if (!items || items.length === 0) continue;
    const g = GROUPS[gid]!;
    specLines.push(`# ─── ${g.title} ───`);
    specLines.push(`# ${g.blurb}`);
    for (const { field, value } of items) {
      const v = value.trim();
      if (field.isSecret) {
        // Never leak the real secret into the spec — always a placeholder
        // for paste-and-fill.
        specLines.push(`${field.key}=${v ? "<unchanged — already set>" : `<paste-${field.key.toLowerCase()}>`}`);
      } else {
        specLines.push(`${field.key}=${v || `<set-${field.key.toLowerCase()}>`}`);
      }
    }
    specLines.push("");
  }
  const specText = specLines.join("\n").trimEnd();

  return c.html(
    <Layout title="Integrations — admin" user={user}>
      <div class="admin-int-wrap">
        <section class="admin-int-hero">
          <div class="admin-int-hero-orb" aria-hidden="true" />
          <div class="admin-int-hero-inner">
            <div class="admin-int-eyebrow">
              <span class="pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </svg>
              </span>
              Platform integrations · Site admin · <span style="color:var(--accent);font-weight:600">{user.username}</span>
            </div>
            <h2 class="admin-int-title">
              <span class="admin-int-title-grad">Wire it up.</span>
            </h2>
            <p class="admin-int-sub">
              Every key you'd otherwise put in <code style="font-family:var(--font-mono);font-size:13px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">/etc/gluecron.env</code>.
              Changes apply immediately — no restart. {totalConfigured} of {INTEGRATION_FIELDS.length} configured.
            </p>
          </div>
        </section>

        {msg && (
          <div class={"admin-int-banner " + (isErr ? "is-error" : "is-ok")}>
            {decodeURIComponent(msg)}
          </div>
        )}

        <section class="admin-int-spec" aria-labelledby="env-spec-title">
          <header class="admin-int-spec-head">
            <div>
              <p class="admin-int-spec-title" id="env-spec-title">
                <span class="admin-int-spec-title-dot" aria-hidden="true" />
                .env spec
              </p>
              <span class="admin-int-spec-sub">
                Copy top-to-bottom, paste into <code style="font-family:var(--font-mono);background:#eef2ff;color:#4338ca;padding:1px 5px;border-radius:4px;font-size:11.5px">/etc/gluecron.env</code>, fill in the placeholders.
              </span>
            </div>
            <button
              type="button"
              class="admin-int-spec-copy"
              data-spec-copy
              aria-label="Copy .env spec to clipboard"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span data-spec-copy-label>Copy</span>
            </button>
          </header>
          <pre class="admin-int-spec-pre" data-spec-text>{specText}</pre>
          <div class="admin-int-spec-foot">
            Reload after editing the env file: <code>sudo systemctl restart gluecron</code> · or save inline below for no-restart updates.
          </div>
        </section>

        <form method="post" action="/admin/integrations">
          {groupOrder.map((gid) => {
            const items = groups.get(gid);
            if (!items || items.length === 0) return null;
            const g = GROUPS[gid]!;
            return (
              <section class="admin-int-section">
                <header class="admin-int-section-head">
                  <div>
                    <h3 class="admin-int-section-title">{g.title}</h3>
                    <p class="admin-int-section-sub">{g.blurb}</p>
                  </div>
                </header>
                <div class="admin-int-section-body">
                  {items.map(({ field, value }) => {
                    const configured = value.trim().length > 0;
                    const display = field.isSecret && configured
                      ? maskSecret(value)
                      : value;
                    return (
                      <div class="admin-int-field">
                        <div class="admin-int-field-row">
                          <label for={`int-${field.key}`}>{field.key}</label>
                          <span
                            class={
                              "admin-int-status " +
                              (configured ? "is-set" : "is-missing")
                            }
                          >
                            <span class="dot" aria-hidden="true" />
                            {configured ? "configured" : "missing"}
                          </span>
                        </div>
                        <input
                          id={`int-${field.key}`}
                          type="text"
                          name={field.key}
                          value={display}
                          aria-label={field.label}
                          placeholder={
                            field.isSecret
                              ? "Paste the secret here"
                              : "Set a value"
                          }
                          class="admin-int-input"
                          autocomplete="off"
                          spellcheck={false}
                        />
                        <div class="admin-int-hint">
                          {field.helper}
                          {field.helperLink && (
                            <>
                              {" "}
                              <a
                                href={field.helperLink.href}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {field.helperLink.text} ↗
                              </a>
                            </>
                          )}
                          {" · env fallback: "}
                          <code>{field.envFallback}</code>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <div class="admin-int-section" style="margin-bottom:0">
            <div class="admin-int-foot">
              <span class="admin-int-foot-hint">
                Values containing <code style="font-family:var(--font-mono);font-size:11.5px;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px">••••••</code> are treated as unchanged — your real secret is preserved.
              </span>
              <button type="submit" class="btn btn-primary">
                Save all changes
              </button>
            </div>
          </div>
        </form>

        <div class="admin-int-bottom-actions">
          Verify your changes turned the warnings green on{" "}
          <a href="/admin/health">/admin/health</a>.
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function(){
              var btn = document.querySelector('[data-spec-copy]');
              var pre = document.querySelector('[data-spec-text]');
              var label = document.querySelector('[data-spec-copy-label]');
              if (!btn || !pre || !label) return;
              btn.addEventListener('click', function(){
                var text = pre.textContent || '';
                var done = function(){
                  btn.classList.add('is-copied');
                  label.textContent = 'Copied';
                  setTimeout(function(){
                    btn.classList.remove('is-copied');
                    label.textContent = 'Copy';
                  }, 1800);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(text).then(done).catch(function(){
                    // Fallback for older browsers / non-secure contexts
                    var ta = document.createElement('textarea');
                    ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
                    document.body.appendChild(ta); ta.select();
                    try { document.execCommand('copy'); done(); } catch(e){}
                    document.body.removeChild(ta);
                  });
                } else {
                  var ta = document.createElement('textarea');
                  ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
                  document.body.appendChild(ta); ta.select();
                  try { document.execCommand('copy'); done(); } catch(e){}
                  document.body.removeChild(ta);
                }
              });
            })();
          `,
        }}
      />
    </Layout>
  );
});

integrations.post("/admin/integrations", async (c) => {
  const g = await gate(c);
  if (g instanceof Response) return g;
  const { user } = g;

  const body = await c.req.parseBody();

  let saved = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const field of INTEGRATION_FIELDS) {
    const submitted = String(body[field.key] ?? "").trim();

    // Don't overwrite a real secret with the mask we showed in the form.
    if (isMaskedValue(submitted)) {
      skipped++;
      continue;
    }

    // Read the current value to detect a no-op (avoids spurious audit rows).
    const current = await getConfigValue(field.key, field.envFallback);
    if (submitted === current) {
      skipped++;
      continue;
    }

    try {
      await setConfigValue(field.key, submitted, user.id);
      await audit({
        userId: user.id,
        action: "admin.integrations.save",
        targetType: "system_config",
        targetId: field.key,
        // Audit the KEY name + whether a value is now set — NEVER the value.
        metadata: {
          key: field.key,
          hadValue: current.length > 0,
          hasValue: submitted.length > 0,
        },
      });
      saved++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${field.key}: ${msg}`);
    }
  }

  if (errors.length > 0) {
    return c.redirect(
      `/admin/integrations?error=${encodeURIComponent(
        `Saved ${saved}, but ${errors.length} failed: ${errors.join("; ")}`
      )}`
    );
  }

  const summary =
    saved === 0
      ? "No changes — every field matched the current value."
      : `Saved ${saved} integration${saved === 1 ? "" : "s"}.${skipped > 0 ? ` ${skipped} unchanged.` : ""}`;
  return c.redirect(`/admin/integrations?result=${encodeURIComponent(summary)}`);
});

export default integrations;
