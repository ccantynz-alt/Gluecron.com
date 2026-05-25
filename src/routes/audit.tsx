/**
 * Audit log UI — personal audit (who has done what with *my* account) and
 * per-repo audit (who has done what in *my* repo). Reads the `audit_log`
 * table written by `src/lib/notify.ts#audit()`.
 *
 * Visual recipe (2026 polish — mirrors admin-integrations / admin-ops /
 * admin-deploys-page):
 *   - Gradient hairline strip across the top of the hero (purple→cyan, 2px)
 *   - Soft radial orb in the corner of the hero
 *   - Eyebrow with pill icon + actor name
 *   - Display headline with gradient-text on the verb ("Trail.")
 *   - Searchable filter pills (action / actor / target)
 *   - Each row is a card with avatar + action verb + target + timestamp
 *   - IDs in monospace, expand-on-click for full metadata JSON
 *
 * Scoped CSS — every class prefixed `.audit-page-` so this surface can't
 * bleed into other admin pages. The legacy `.audit-table` global class
 * (still used by deployments.tsx) is left untouched.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Hono } from "hono";
import { desc, eq, and } from "drizzle-orm";
import { db } from "../db";
import { auditLog, repositories, users } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";

const audit = new Hono<AuthEnv>();

audit.use("/settings/audit", requireAuth);
audit.use("/:owner/:repo/settings/audit", requireAuth);

const LIMIT = 200;

type AuditRow = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: string | null;
  createdAt: Date;
  actor: string | null;
};

function prettyMetadata(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function compactMetadata(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

function timeAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic hex colour for a username — same name maps to the same
 * orb tint so the operator can scan the feed by actor at a glance.
 */
function actorHue(name: string | null): number {
  const v = name || "system";
  let h = 0;
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) % 360;
  return h;
}

function initials(name: string | null): string {
  const n = (name || "?").trim();
  if (!n) return "?";
  const parts = n.split(/[_\-.\s]+/).filter(Boolean);
  if (parts.length === 0) return n.slice(0, 2).toUpperCase();
  if (parts.length === 1) return n.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function IconShield() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function FilterPills({ rows }: { rows: AuditRow[] }) {
  // Build distinct action / actor / target-type sets for the filter pills.
  // We render them as data-filter buttons; the inline JS toggles them and
  // hides non-matching rows.
  const actions = Array.from(new Set(rows.map((r) => r.action))).sort();
  const actors = Array.from(
    new Set(rows.map((r) => r.actor || "system"))
  ).sort();
  const targets = Array.from(
    new Set(
      rows
        .map((r) => r.targetType)
        .filter((t): t is string => typeof t === "string" && t.length > 0)
    )
  ).sort();

  if (actions.length === 0 && actors.length === 0 && targets.length === 0) {
    return null;
  }

  return (
    <div class="audit-filters" data-audit-filters>
      <div class="audit-filter-search">
        <input
          type="search"
          placeholder="Filter by action, actor, target, ID…"
          aria-label="Filter audit events"
          data-audit-search
        />
      </div>
      {actions.length > 0 && (
        <div class="audit-filter-group" data-audit-group="action">
          <span class="audit-filter-label">Action</span>
          <div class="audit-filter-pills">
            {actions.slice(0, 12).map((a) => (
              <button
                type="button"
                class="audit-filter-pill"
                data-audit-filter="action"
                data-audit-value={a}
              >
                <code>{a}</code>
              </button>
            ))}
          </div>
        </div>
      )}
      {actors.length > 0 && (
        <div class="audit-filter-group" data-audit-group="actor">
          <span class="audit-filter-label">Actor</span>
          <div class="audit-filter-pills">
            {actors.slice(0, 12).map((a) => (
              <button
                type="button"
                class="audit-filter-pill"
                data-audit-filter="actor"
                data-audit-value={a}
              >
                @{a}
              </button>
            ))}
          </div>
        </div>
      )}
      {targets.length > 0 && (
        <div class="audit-filter-group" data-audit-group="target">
          <span class="audit-filter-label">Target</span>
          <div class="audit-filter-pills">
            {targets.slice(0, 12).map((a) => (
              <button
                type="button"
                class="audit-filter-pill"
                data-audit-filter="target"
                data-audit-value={a}
              >
                {a}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AuditList({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <div class="audit-empty">
        <h2>No audit events yet</h2>
        <p>Sensitive actions will appear here as they happen.</p>
      </div>
    );
  }
  return (
    <div>
      <FilterPills rows={rows} />
      <div class="audit-count" data-audit-count>
        Showing <strong data-audit-visible>{rows.length}</strong> of {rows.length} events
      </div>
      <ol class="audit-feed" aria-label="Audit events">
        {rows.map((r) => {
          const actor = r.actor || "system";
          const hue = actorHue(actor);
          const metaJson = prettyMetadata(r.metadata);
          const metaCompact = compactMetadata(r.metadata);
          const haystack = [
            r.action,
            actor,
            r.targetType || "",
            r.targetId || "",
            r.ip || "",
            metaCompact,
          ]
            .join(" ")
            .toLowerCase();
          return (
            <li
              class="audit-card"
              data-audit-row
              data-audit-action={r.action}
              data-audit-actor={actor}
              data-audit-target={r.targetType || ""}
              data-audit-haystack={haystack}
            >
              <div class="audit-card-head">
                <span
                  class="audit-avatar"
                  aria-hidden="true"
                  style={`background:hsl(${hue} 65% 18%);color:hsl(${hue} 75% 78%);box-shadow:inset 0 0 0 1px hsl(${hue} 70% 40% / 0.55)`}
                >
                  {initials(actor)}
                </span>
                <div class="audit-card-actor">
                  <span class="audit-card-name">{actor}</span>
                  <span class="audit-card-when" title={r.createdAt.toISOString()}>
                    {timeAgo(new Date(r.createdAt))}
                  </span>
                </div>
                <span class="audit-card-spacer" />
                <code class="audit-card-action">{r.action}</code>
              </div>
              <div class="audit-card-body">
                <div class="audit-card-target">
                  {r.targetType ? (
                    <>
                      <span class="audit-card-key">Target</span>
                      <span class="audit-card-val">{r.targetType}</span>
                      {r.targetId && (
                        <code class="audit-card-id" title={r.targetId}>
                          {r.targetId.slice(0, 8)}
                        </code>
                      )}
                    </>
                  ) : (
                    <span class="audit-card-muted">no target</span>
                  )}
                </div>
                <div class="audit-card-ip">
                  <span class="audit-card-key">IP</span>
                  <code class="audit-card-val">{r.ip || "—"}</code>
                </div>
                {r.metadata && (
                  <details class="audit-card-meta">
                    <summary>
                      <span class="audit-card-key">Metadata</span>
                      <code class="audit-card-meta-preview">
                        {metaCompact.slice(0, 80)}
                        {metaCompact.length > 80 ? "…" : ""}
                      </code>
                      <span class="audit-card-meta-chev" aria-hidden="true">▾</span>
                    </summary>
                    <pre class="audit-card-meta-pre">{metaJson}</pre>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scoped CSS — `.audit-page-*` for the wrap so we don't collide with the
// legacy `.audit-table` class still used by deployments.tsx.
// ---------------------------------------------------------------------------

const AUDIT_CSS = `
  .audit-wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }

  /* ─── Hero ─── */
  .audit-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(28px, 4vw, 44px) clamp(24px, 4vw, 44px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .audit-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .audit-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .audit-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .audit-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 14px;
    letter-spacing: 0.02em;
  }
  .audit-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .audit-eyebrow-who { color: var(--accent); font-weight: 600; }
  .audit-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .audit-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .audit-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .audit-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 5px;
    color: var(--text);
  }

  .audit-breadcrumb {
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    margin-bottom: 10px;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .audit-breadcrumb a {
    color: var(--text-muted);
    text-decoration: none;
  }
  .audit-breadcrumb a:hover { color: var(--text-strong); }
  .audit-breadcrumb-sep { opacity: 0.5; }

  /* ─── Filters ─── */
  .audit-filters {
    margin-bottom: var(--space-4);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .audit-filter-search input {
    width: 100%;
    padding: 10px 14px;
    font-size: 13px;
    color: var(--text);
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .audit-filter-search input:focus {
    border-color: rgba(140,109,255,0.50);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .audit-filter-group {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .audit-filter-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    width: 60px;
    flex-shrink: 0;
  }
  .audit-filter-pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    flex: 1;
  }
  .audit-filter-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 9999px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 11.5px;
    cursor: pointer;
    font: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .audit-filter-pill code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: inherit;
    background: transparent;
    padding: 0;
  }
  .audit-filter-pill:hover {
    background: rgba(140,109,255,0.10);
    border-color: rgba(140,109,255,0.40);
    color: var(--text-strong);
  }
  .audit-filter-pill.is-active {
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    border-color: rgba(140,109,255,0.50);
    color: #e9d5ff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .audit-count {
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .audit-count strong { color: var(--text-strong); font-weight: 700; }

  /* ─── Feed cards ─── */
  .audit-feed {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .audit-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
    transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
  }
  .audit-card:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
    box-shadow: 0 8px 22px -16px rgba(0,0,0,0.5);
  }
  .audit-card[hidden] { display: none; }
  .audit-card-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .audit-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px; height: 32px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .audit-card-actor {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .audit-card-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .audit-card-when {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .audit-card-spacer { flex: 1; }
  .audit-card-action {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
    background: linear-gradient(135deg, rgba(140,109,255,0.10), rgba(54,197,214,0.06));
    border: 1px solid rgba(140,109,255,0.22);
    padding: 3px 9px;
    border-radius: 9999px;
  }
  .audit-card-body {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 16px;
    font-size: 12.5px;
  }
  .audit-card-target,
  .audit-card-ip {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .audit-card-key {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    flex-shrink: 0;
  }
  .audit-card-val {
    color: var(--text);
    font-size: 12.5px;
  }
  .audit-card-ip .audit-card-val {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .audit-card-id {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
  }
  .audit-card-muted {
    color: var(--text-muted);
    font-style: italic;
    font-size: 12px;
  }
  .audit-card-meta {
    grid-column: 1 / -1;
  }
  .audit-card-meta summary {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    list-style: none;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .audit-card-meta summary::-webkit-details-marker { display: none; }
  .audit-card-meta summary:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.32);
  }
  .audit-card-meta-preview {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    background: transparent;
    padding: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .audit-card-meta-chev {
    color: var(--text-muted);
    transition: transform 120ms ease;
    font-size: 11px;
  }
  .audit-card-meta[open] .audit-card-meta-chev { transform: rotate(180deg); }
  .audit-card-meta-pre {
    margin: 8px 0 0;
    padding: 12px 14px;
    background: rgba(0,0,0,0.32);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    line-height: 1.55;
    overflow-x: auto;
    white-space: pre;
  }

  /* ─── Empty state ─── */
  .audit-empty {
    padding: clamp(36px, 6vw, 56px) clamp(24px, 4vw, 44px);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 16px;
    background: rgba(255,255,255,0.015);
    text-align: center;
  }
  .audit-empty h2 {
    font-family: var(--font-display);
    font-size: 20px;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .audit-empty p {
    margin: 0;
    color: var(--text-muted);
    font-size: 13.5px;
  }

  @media (max-width: 640px) {
    .audit-wrap { padding: var(--space-4) var(--space-3) var(--space-8); }
    .audit-card-body { grid-template-columns: 1fr; }
    .audit-filter-label { width: auto; }
  }
`;

const AUDIT_JS = `
(function(){
  var root = document.querySelector('[data-audit-filters]');
  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-audit-row]'));
  var visibleEl = document.querySelector('[data-audit-visible]');
  if (rows.length === 0) return;

  var search = root && root.querySelector('[data-audit-search]');
  var pills = root ? Array.prototype.slice.call(root.querySelectorAll('[data-audit-filter]')) : [];

  // active[group] = Set of selected values
  var active = { action: new Set(), actor: new Set(), target: new Set() };

  function apply() {
    var q = (search && search.value || '').trim().toLowerCase();
    var visible = 0;
    rows.forEach(function(row){
      var action = row.getAttribute('data-audit-action') || '';
      var actor  = row.getAttribute('data-audit-actor') || '';
      var target = row.getAttribute('data-audit-target') || '';
      var hay    = row.getAttribute('data-audit-haystack') || '';
      var ok = true;
      if (active.action.size && !active.action.has(action)) ok = false;
      if (ok && active.actor.size && !active.actor.has(actor)) ok = false;
      if (ok && active.target.size && !active.target.has(target)) ok = false;
      if (ok && q && hay.indexOf(q) === -1) ok = false;
      row.hidden = !ok;
      if (ok) visible++;
    });
    if (visibleEl) visibleEl.textContent = String(visible);
  }

  pills.forEach(function(btn){
    btn.addEventListener('click', function(){
      var group = btn.getAttribute('data-audit-filter');
      var value = btn.getAttribute('data-audit-value');
      if (!group || !value || !active[group]) return;
      if (active[group].has(value)) {
        active[group].delete(value);
        btn.classList.remove('is-active');
      } else {
        active[group].add(value);
        btn.classList.add('is-active');
      }
      apply();
    });
  });

  if (search) {
    var t = null;
    search.addEventListener('input', function(){
      if (t) clearTimeout(t);
      t = setTimeout(apply, 80);
    });
  }
})();
`;

function AuditPage({
  user,
  title,
  subtitle,
  eyebrowSuffix,
  rows,
  breadcrumb,
}: {
  user: any;
  title: string;
  subtitle: any;
  eyebrowSuffix: string;
  rows: AuditRow[];
  breadcrumb?: any;
}) {
  return (
    <Layout title={title} user={user}>
      <div class="audit-wrap">
        <section class="audit-hero">
          <div class="audit-hero-orb" aria-hidden="true" />
          <div class="audit-hero-inner">
            {breadcrumb && <div class="audit-breadcrumb">{breadcrumb}</div>}
            <div class="audit-eyebrow">
              <span class="audit-eyebrow-pill" aria-hidden="true">
                <IconShield />
              </span>
              Audit log · <span class="audit-eyebrow-who">{user.username}</span>
              {eyebrowSuffix && (
                <>
                  {" "}· <span>{eyebrowSuffix}</span>
                </>
              )}
            </div>
            <h1 class="audit-title">
              <span class="audit-title-grad">Trail.</span>
            </h1>
            <p class="audit-sub">{subtitle}</p>
            <p class="audit-sub" style="margin-top: 8px; font-size: 13px;">
              <strong>Also surfaces:</strong> findings from the AI proactive
              monitor (<code>action=ai.monitor.*</code>) — stale TODOs, stuck
              PRs, suspicious patterns it filed automatically. Filter by
              actor <code>system</code> to see only the monitor's events.
            </p>
          </div>
        </section>

        <AuditList rows={rows} />
      </div>
      <style dangerouslySetInnerHTML={{ __html: AUDIT_CSS }} />
      <script dangerouslySetInnerHTML={{ __html: AUDIT_JS }} />
    </Layout>
  );
}

// Personal audit — events where userId = current user.
audit.get("/settings/audit", async (c) => {
  const user = c.get("user")!;
  let rows: AuditRow[] = [];
  try {
    const raw = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        ip: auditLog.ip,
        userAgent: auditLog.userAgent,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
        actor: users.username,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(eq(auditLog.userId, user.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(LIMIT);
    rows = raw as AuditRow[];
  } catch (err) {
    console.error("[audit] personal:", err);
  }

  return c.html(
    <AuditPage
      user={user}
      title="Audit log"
      eyebrowSuffix="personal"
      subtitle={
        <>
          The most recent {LIMIT} sensitive actions tied to your account —
          logins, token activity, merges, deploys, branch protection changes.
        </>
      }
      rows={rows}
    />
  );
});

// Per-repo audit — events with repositoryId = this repo. Owner-only.
audit.get("/:owner/:repo/settings/audit", async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();

  let repoRow: { id: string; ownerId: string; name: string } | null = null;
  try {
    const [r] = await db
      .select({ id: repositories.id, ownerId: repositories.ownerId, name: repositories.name })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    repoRow = (r as any) || null;
  } catch (err) {
    console.error("[audit] repo lookup:", err);
  }
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.html(
      <Layout title="Audit log" user={user}>
        <div class="empty-state">
          <h2>Forbidden</h2>
          <p>Only the repository owner can view the audit log.</p>
        </div>
      </Layout>,
      403
    );
  }

  let rows: AuditRow[] = [];
  try {
    const raw = await db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        ip: auditLog.ip,
        userAgent: auditLog.userAgent,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
        actor: users.username,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(eq(auditLog.repositoryId, repoRow.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(LIMIT);
    rows = raw as AuditRow[];
  } catch (err) {
    console.error("[audit] repo:", err);
  }

  return c.html(
    <AuditPage
      user={user}
      title={`${owner}/${repo} — audit`}
      eyebrowSuffix={`repo ${owner}/${repo}`}
      subtitle={
        <>
          Who did what in{" "}
          <code>
            {owner}/{repo}
          </code>{" "}
          — most recent {LIMIT} events.
        </>
      }
      breadcrumb={
        <>
          <a href={`/${owner}/${repo}`}>
            {owner}/{repo}
          </a>
          <span class="audit-breadcrumb-sep">/</span>
          <a href={`/${owner}/${repo}/settings`}>settings</a>
          <span class="audit-breadcrumb-sep">/</span>
          <span>audit</span>
        </>
      }
      rows={rows}
    />
  );
});

export default audit;
