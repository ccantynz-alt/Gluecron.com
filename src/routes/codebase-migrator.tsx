/**
 * AI Codebase Migration — one-click language/framework translation with Claude.
 *
 *   GET  /:owner/:repo/migrate              — migration form (owner only)
 *   POST /:owner/:repo/migrate/start        — start a job (requireAuth, owner only)
 *   GET  /:owner/:repo/migrate/:jobId       — job progress page (auto-refreshes)
 *   GET  /:owner/:repo/migrate/:jobId/status — JSON status endpoint (polling)
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { users, repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  startMigration,
  getJob,
  isRepoMigrating,
  type MigrationJob,
  type MigrationTarget,
} from "../lib/codebase-migrator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedRepo {
  ownerId: string;
  repoId: string;
  defaultBranch: string;
}

async function resolveRepo(
  ownerName: string,
  repoName: string
): Promise<ResolvedRepo | null> {
  try {
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerRow) return null;
    const [repoRow] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repoRow) return null;
    return {
      ownerId: ownerRow.id,
      repoId: repoRow.id,
      defaultBranch: repoRow.defaultBranch || "main",
    };
  } catch {
    return null;
  }
}

function isOwner(resolved: ResolvedRepo, userId: string | undefined): boolean {
  return !!userId && resolved.ownerId === userId;
}

function statusLabel(status: MigrationJob["status"]): string {
  const labels: Record<MigrationJob["status"], string> = {
    queued: "Queued",
    analyzing: "Analyzing",
    translating: "Translating",
    committing: "Committing",
    "opening-pr": "Opening PR",
    done: "Done",
    failed: "Failed",
  };
  return labels[status] ?? status;
}

function targetDescription(target: MigrationTarget): string {
  if (target.type === "language") return `${target.from} → ${target.to}`;
  if (target.type === "framework") return `${target.from} → ${target.to}`;
  return target.description;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const migrateStyles = `
  .mg-wrap {
    max-width: 860px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4) var(--space-8);
  }

  /* Header */
  .mg-head { margin-bottom: var(--space-5); }
  .mg-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .mg-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    box-shadow: 0 0 0 3px rgba(245,158,11,0.18);
  }
  .mg-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.2vw, 36px);
    font-weight: 800;
    letter-spacing: -0.025em;
    line-height: 1.08;
    margin: 0 0 8px;
    color: var(--text-strong);
  }
  .mg-title-grad {
    background-image: linear-gradient(135deg, #f59e0b 0%, #ef4444 60%, #8b5cf6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .mg-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 600px;
  }

  /* Warning banner */
  .mg-warning {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    background: rgba(245,158,11,0.08);
    border: 1px solid rgba(245,158,11,0.28);
    border-radius: 10px;
    margin-bottom: var(--space-5);
    font-size: 13px;
    color: var(--text);
    line-height: 1.5;
  }
  .mg-warning-icon {
    font-size: 16px;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .mg-warning strong { color: var(--text-strong); }

  /* Error banner */
  .mg-error {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.28);
    border-radius: 10px;
    margin-bottom: var(--space-4);
    font-size: 13px;
    color: var(--text);
  }

  /* Section card */
  .mg-section {
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-bottom: var(--space-4);
    overflow: hidden;
  }
  .mg-section-head {
    padding: 16px 20px 14px;
    border-bottom: 1px solid var(--border);
  }
  .mg-section-title {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.005em;
  }
  .mg-section-sub {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .mg-section-body { padding: 18px 20px; }

  /* Radio types */
  .mg-type-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px;
    margin-bottom: 20px;
  }
  .mg-type-card {
    position: relative;
    cursor: pointer;
  }
  .mg-type-card input[type="radio"] {
    position: absolute;
    opacity: 0;
    width: 0; height: 0;
  }
  .mg-type-label {
    display: block;
    padding: 14px 16px;
    border: 1.5px solid var(--border-strong);
    border-radius: 10px;
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
    user-select: none;
  }
  .mg-type-card input[type="radio"]:checked + .mg-type-label {
    border-color: rgba(245,158,11,0.65);
    background: rgba(245,158,11,0.06);
    box-shadow: 0 0 0 3px rgba(245,158,11,0.14);
  }
  .mg-type-emoji { font-size: 20px; margin-bottom: 6px; display: block; }
  .mg-type-name {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--text-strong);
    display: block;
    margin-bottom: 3px;
  }
  .mg-type-desc { font-size: 12px; color: var(--text-muted); line-height: 1.4; }

  /* Form fields */
  .mg-field { margin-bottom: 16px; }
  .mg-field:last-child { margin-bottom: 0; }
  .mg-field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .mg-field-row {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 10px;
    align-items: center;
  }
  .mg-arrow { color: var(--text-muted); font-size: 18px; text-align: center; }
  .mg-input, .mg-select, .mg-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 11px;
    font: inherit;
    font-size: 13.5px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .mg-input:focus, .mg-select:focus, .mg-textarea:focus {
    outline: none;
    border-color: rgba(245,158,11,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(245,158,11,0.18);
  }
  .mg-textarea { resize: vertical; min-height: 90px; font-size: 13px; }
  .mg-select {
    appearance: none;
    padding-right: 28px;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
      linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
    background-position: right 10px top 52%, right 6px top 52%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
  }

  /* Collapsible type panels */
  .mg-type-panel { display: none; }
  .mg-type-panel.is-active { display: block; }

  /* Submit */
  .mg-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: var(--space-4);
  }
  .mg-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 22px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    white-space: nowrap;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, opacity 120ms ease;
  }
  .mg-btn-primary {
    background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
    color: #fff;
    box-shadow: 0 6px 18px -6px rgba(245,158,11,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .mg-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(245,158,11,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .mg-btn-primary:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    transform: none;
    box-shadow: none;
  }
  .mg-btn-secondary {
    background: rgba(255,255,255,0.06);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .mg-btn-secondary:hover {
    background: rgba(255,255,255,0.09);
    text-decoration: none;
    color: var(--text);
  }
  .mg-hint { font-size: 12px; color: var(--text-muted); }

  /* ─── Progress page ─────────────────────────────────────────── */
  .mgp-wrap {
    max-width: 600px;
    margin: 0 auto;
    padding: var(--space-8) var(--space-4);
  }
  .mgp-head { text-align: center; margin-bottom: var(--space-6); }
  .mgp-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .mgp-eyebrow-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    animation: mgp-pulse 1.5s ease-in-out infinite;
  }
  .mgp-eyebrow-dot.is-done { animation: none; background: #22c55e; }
  .mgp-eyebrow-dot.is-failed { animation: none; background: #ef4444; }
  @keyframes mgp-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0.50); }
    50% { box-shadow: 0 0 0 6px rgba(245,158,11,0); }
  }
  .mgp-title {
    font-family: var(--font-display);
    font-size: clamp(20px, 2.6vw, 28px);
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .mgp-sub { font-size: 14px; color: var(--text-muted); margin: 0; }

  /* Phase pills */
  .mgp-phases {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
    margin-bottom: var(--space-5);
  }
  .mgp-phase {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 11px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    background: rgba(255,255,255,0.05);
    border: 1px solid var(--border);
    color: var(--text-muted);
    transition: all 120ms ease;
  }
  .mgp-phase.is-active {
    background: rgba(245,158,11,0.12);
    border-color: rgba(245,158,11,0.40);
    color: #fbbf24;
  }
  .mgp-phase.is-done-phase {
    background: rgba(34,197,94,0.10);
    border-color: rgba(34,197,94,0.30);
    color: #4ade80;
  }
  .mgp-phase.is-failed-phase {
    background: rgba(239,68,68,0.10);
    border-color: rgba(239,68,68,0.28);
    color: #f87171;
  }

  /* Progress bar */
  .mgp-bar-wrap {
    background: rgba(255,255,255,0.06);
    border-radius: 9999px;
    height: 6px;
    overflow: hidden;
    margin-bottom: var(--space-3);
  }
  .mgp-bar-fill {
    height: 100%;
    border-radius: 9999px;
    background: linear-gradient(90deg, #f59e0b, #ef4444);
    transition: width 600ms ease;
  }
  .mgp-bar-fill.is-done { background: linear-gradient(90deg, #22c55e, #4ade80); }
  .mgp-bar-fill.is-failed { background: #ef4444; }

  /* Status card */
  .mgp-card {
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: var(--space-4);
  }
  .mgp-current-file {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-muted);
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
    margin-top: 10px;
  }
  .mgp-file-count {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 6px;
  }

  /* Done / fail states */
  .mgp-done-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 24px;
    background: rgba(34,197,94,0.07);
    border: 1px solid rgba(34,197,94,0.25);
    border-radius: 12px;
    text-align: center;
  }
  .mgp-done-icon { font-size: 36px; }
  .mgp-done-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
  }
  .mgp-done-sub { font-size: 13px; color: var(--text-muted); margin: 0; }
  .mgp-fail-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px;
    background: rgba(239,68,68,0.07);
    border: 1px solid rgba(239,68,68,0.25);
    border-radius: 12px;
    text-align: center;
  }
  .mgp-fail-icon { font-size: 32px; }
  .mgp-fail-title {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
  }
  .mgp-fail-msg {
    font-size: 13px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    padding: 8px 12px;
    border-radius: 7px;
    word-break: break-word;
  }
`;

// ---------------------------------------------------------------------------
// JS for the migration form (radio-driven panel toggling)
// ---------------------------------------------------------------------------

const migrateFormJs = `
(function() {
  var radios = document.querySelectorAll('input[name="migrationType"]');
  var panels = document.querySelectorAll('.mg-type-panel');

  function showPanel(val) {
    panels.forEach(function(p) {
      if (p.dataset.type === val) {
        p.classList.add('is-active');
      } else {
        p.classList.remove('is-active');
      }
    });
  }

  radios.forEach(function(r) {
    r.addEventListener('change', function() {
      showPanel(this.value);
    });
    if (r.checked) showPanel(r.value);
  });

  // Disable submit button on form submission
  var form = document.getElementById('migrate-form');
  if (form) {
    form.addEventListener('submit', function() {
      var btn = form.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Starting migration…';
      }
    });
  }
})();
`;

// ---------------------------------------------------------------------------
// Phase computation helper
// ---------------------------------------------------------------------------

const PHASES: MigrationJob["status"][] = [
  "analyzing",
  "translating",
  "committing",
  "opening-pr",
  "done",
];

function phaseClass(
  phase: MigrationJob["status"],
  current: MigrationJob["status"]
): string {
  if (current === "failed") {
    return phase === current ? "is-failed-phase" : "";
  }
  const phaseIdx = PHASES.indexOf(phase);
  const currentIdx = PHASES.indexOf(current);
  if (currentIdx < 0) return "";
  if (phaseIdx < currentIdx) return "is-done-phase";
  if (phaseIdx === currentIdx) return "is-active";
  return "";
}

// ---------------------------------------------------------------------------
// Route components
// ---------------------------------------------------------------------------

function MigrationFormPage({
  owner,
  repo,
  user,
  error,
}: {
  owner: string;
  repo: string;
  user: { username: string };
  error?: string;
}) {
  const languages = [
    "TypeScript",
    "JavaScript",
    "Python",
    "Go",
    "Rust",
    "Java",
    "Ruby",
    "PHP",
    "C#",
    "Swift",
    "Kotlin",
  ];

  return (
    <div class="mg-wrap">
      <header class="mg-head">
        <div class="mg-eyebrow">
          <span class="mg-eyebrow-dot" aria-hidden="true" />
          Repository &middot; AI Migration
        </div>
        <h1 class="mg-title">
          <span class="mg-title-grad">AI Codebase Migration</span>
        </h1>
        <p class="mg-sub">
          Say what you want migrated. Claude translates your code, creates a
          new branch, and opens a draft PR — without touching your existing
          code.
        </p>
      </header>

      <div class="mg-warning">
        <span class="mg-warning-icon">&#9888;</span>
        <span>
          <strong>This does NOT modify your existing code.</strong> A new branch
          is created with the translated files and a pull request is opened for
          your review. Inspect the diff and test thoroughly before merging.
        </span>
      </div>

      {error && (
        <div class="mg-error">
          <span>&#10005; {error}</span>
        </div>
      )}

      <section class="mg-section">
        <div class="mg-section-head">
          <h2 class="mg-section-title">Migration type</h2>
          <p class="mg-section-sub">
            Choose what kind of migration you want to perform.
          </p>
        </div>
        <div class="mg-section-body">
          <form
            method="post"
            action={`/${owner}/${repo}/migrate/start`}
            id="migrate-form"
          >
            <div class="mg-type-grid">
              <label class="mg-type-card">
                <input
                  type="radio"
                  name="migrationType"
                  value="language"
                  defaultChecked
                />
                <span class="mg-type-label">
                  <span class="mg-type-emoji">&#127758;</span>
                  <span class="mg-type-name">Language</span>
                  <span class="mg-type-desc">
                    Translate source files to a different programming language
                  </span>
                </span>
              </label>
              <label class="mg-type-card">
                <input type="radio" name="migrationType" value="framework" />
                <span class="mg-type-label">
                  <span class="mg-type-emoji">&#128295;</span>
                  <span class="mg-type-name">Framework</span>
                  <span class="mg-type-desc">
                    Switch from one framework or library to another
                  </span>
                </span>
              </label>
              <label class="mg-type-card">
                <input type="radio" name="migrationType" value="custom" />
                <span class="mg-type-label">
                  <span class="mg-type-emoji">&#10024;</span>
                  <span class="mg-type-name">Custom</span>
                  <span class="mg-type-desc">
                    Free-form instruction for any kind of codebase transformation
                  </span>
                </span>
              </label>
            </div>

            {/* Language panel */}
            <div class="mg-type-panel is-active" data-type="language">
              <div class="mg-field">
                <span class="mg-field-label">Language migration</span>
                <div class="mg-field-row">
                  <select name="langFrom" class="mg-select">
                    {languages.map((l) => (
                      <option value={l}>{l}</option>
                    ))}
                  </select>
                  <span class="mg-arrow">&#8594;</span>
                  <select name="langTo" class="mg-select">
                    {languages.map((l, i) => (
                      <option value={l} selected={i === 1}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Framework panel */}
            <div class="mg-type-panel" data-type="framework">
              <div class="mg-field">
                <span class="mg-field-label">Framework migration</span>
                <div class="mg-field-row">
                  <input
                    type="text"
                    name="frameworkFrom"
                    class="mg-input"
                    placeholder="Express"
                  />
                  <span class="mg-arrow">&#8594;</span>
                  <input
                    type="text"
                    name="frameworkTo"
                    class="mg-input"
                    placeholder="Hono"
                  />
                </div>
              </div>
            </div>

            {/* Custom panel */}
            <div class="mg-type-panel" data-type="custom">
              <div class="mg-field">
                <label class="mg-field-label" for="customDesc">
                  Describe the transformation
                </label>
                <textarea
                  name="customDesc"
                  id="customDesc"
                  class="mg-textarea"
                  placeholder="Convert all class components to React functional hooks, update deprecated APIs, and modernise the build config"
                  rows={4}
                />
              </div>
            </div>

            <div class="mg-actions">
              <button type="submit" class="mg-btn mg-btn-primary">
                &#9889; Start Migration
              </button>
              <a
                href={`/${owner}/${repo}`}
                class="mg-btn mg-btn-secondary"
              >
                Cancel
              </a>
              <span class="mg-hint">
                Takes 2–10 minutes depending on repo size.
              </span>
            </div>
          </form>
        </div>
      </section>

      <script dangerouslySetInnerHTML={{ __html: migrateFormJs }} />
      <style dangerouslySetInnerHTML={{ __html: migrateStyles }} />
    </div>
  );
}

function ProgressPage({
  owner,
  repo,
  job,
}: {
  owner: string;
  repo: string;
  job: MigrationJob;
}) {
  const isDone = job.status === "done";
  const isFailed = job.status === "failed";
  const isRunning = !isDone && !isFailed;

  const dotClass = isDone
    ? "mgp-eyebrow-dot is-done"
    : isFailed
    ? "mgp-eyebrow-dot is-failed"
    : "mgp-eyebrow-dot";

  const barClass =
    "mgp-bar-fill" +
    (isDone ? " is-done" : isFailed ? " is-failed" : "");

  const phases: { key: MigrationJob["status"]; label: string }[] = [
    { key: "analyzing", label: "Analyzing" },
    { key: "translating", label: "Translating" },
    { key: "committing", label: "Committing" },
    { key: "opening-pr", label: "Opening PR" },
    { key: "done", label: "Done" },
  ];

  return (
    <div class="mgp-wrap">
      {/* Auto-refresh while running */}
      {isRunning && (
        <meta http-equiv="refresh" content="3" />
      )}

      <header class="mgp-head">
        <div class="mgp-eyebrow">
          <span class={dotClass} aria-hidden="true" />
          {isDone
            ? "Migration complete"
            : isFailed
            ? "Migration failed"
            : "Migration in progress"}
        </div>
        <h1 class="mgp-title">{targetDescription(job.target)}</h1>
        <p class="mgp-sub">
          {owner}/{repo} &middot; Branch:{" "}
          <code style="font-family: var(--font-mono); font-size: 12px;">
            {job.branchName}
          </code>
        </p>
      </header>

      {/* Phase pills */}
      <div class="mgp-phases">
        {phases.map(({ key, label }) => (
          <span class={`mgp-phase ${phaseClass(key, job.status)}`}>
            {key === "done" && isDone && "✓ "}
            {label}
          </span>
        ))}
      </div>

      {/* Progress bar */}
      <div class="mgp-bar-wrap">
        <div
          class={barClass}
          style={`width: ${job.progress}%`}
          role="progressbar"
          aria-valuenow={job.progress}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      {/* Status card */}
      {isRunning && (
        <div class="mgp-card">
          <p style="margin: 0; font-size: 14px; color: var(--text-strong); font-weight: 600;">
            {statusLabel(job.status)}…
          </p>
          {job.currentFile && (
            <p class="mgp-current-file">Translating {job.currentFile}</p>
          )}
          {job.filesTotal > 0 && (
            <p class="mgp-file-count">
              {job.filesTranslated} / {job.filesTotal} files
            </p>
          )}
        </div>
      )}

      {/* Done */}
      {isDone && job.prNumber && (
        <div class="mgp-done-box">
          <span class="mgp-done-icon">&#127881;</span>
          <h2 class="mgp-done-title">Migration complete!</h2>
          <p class="mgp-done-sub">
            {job.filesTranslated} file
            {job.filesTranslated !== 1 ? "s" : ""} translated and committed to{" "}
            <code
              style="font-family: var(--font-mono); font-size: 12px;"
            >
              {job.branchName}
            </code>
          </p>
          <a
            href={`/${owner}/${repo}/pulls/${job.prNumber}`}
            class="mg-btn mg-btn-primary"
          >
            View Pull Request #{job.prNumber}
          </a>
        </div>
      )}

      {/* Failed */}
      {isFailed && (
        <div class="mgp-fail-box">
          <span class="mgp-fail-icon">&#10060;</span>
          <h2 class="mgp-fail-title">Migration failed</h2>
          {job.error && <p class="mgp-fail-msg">{job.error}</p>}
          <a
            href={`/${owner}/${repo}/migrate`}
            class="mg-btn mg-btn-secondary"
          >
            Try again
          </a>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: migrateStyles }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const codebaseMigratorRoutes = new Hono<AuthEnv>();

/** GET /:owner/:repo/migrate — migration form */
codebaseMigratorRoutes.get(
  "/:owner/:repo/migrate",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.notFound();

    if (!isOwner(resolved, user.id)) {
      return c.html(
        <Layout title="Forbidden" user={user}>
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="migrate" />
          <div style="max-width:600px;margin:3rem auto;padding:0 1rem;text-align:center">
            <h2 style="margin-bottom:8px">Owner access required</h2>
            <p style="color:var(--text-muted)">
              Only the repository owner can start a codebase migration.
            </p>
          </div>
        </Layout>,
        403
      );
    }

    return c.html(
      <Layout title={`AI Migration — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <RepoNav owner={owner} repo={repo} active="migrate" />
        <MigrationFormPage owner={owner} repo={repo} user={user} />
      </Layout>
    );
  }
);

/** POST /:owner/:repo/migrate/start — start a migration job */
codebaseMigratorRoutes.post(
  "/:owner/:repo/migrate/start",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;

    const resolved = await resolveRepo(owner, repo);
    if (!resolved) return c.notFound();

    if (!isOwner(resolved, user.id)) {
      return c.html(
        <Layout title="Forbidden" user={user}>
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="migrate" />
          <div style="max-width:600px;margin:3rem auto;padding:0 1rem;text-align:center">
            <h2>Owner access required</h2>
          </div>
        </Layout>,
        403
      );
    }

    const body = await c.req.parseBody();
    const migrationType = String(body.migrationType || "language").trim();

    let target: MigrationTarget;
    let validationError: string | null = null;

    if (migrationType === "language") {
      const from = String(body.langFrom || "").trim();
      const to = String(body.langTo || "").trim();
      if (!from || !to) {
        validationError = "Both source and target languages are required.";
      } else if (from === to) {
        validationError = "Source and target languages must be different.";
      } else {
        target = { type: "language", from, to };
      }
    } else if (migrationType === "framework") {
      const from = String(body.frameworkFrom || "").trim();
      const to = String(body.frameworkTo || "").trim();
      if (!from || !to) {
        validationError =
          "Both source and target framework names are required.";
      } else if (from.toLowerCase() === to.toLowerCase()) {
        validationError = "Source and target frameworks must be different.";
      } else {
        target = { type: "framework", from, to };
      }
    } else if (migrationType === "custom") {
      const description = String(body.customDesc || "").trim();
      if (!description) {
        validationError = "A description of the transformation is required.";
      } else if (description.length < 10) {
        validationError = "Please provide a more detailed description (min 10 characters).";
      } else {
        target = { type: "custom", description };
      }
    } else {
      validationError = "Invalid migration type.";
    }

    if (validationError) {
      return c.html(
        <Layout title={`AI Migration — ${owner}/${repo}`} user={user}>
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="migrate" />
          <MigrationFormPage
            owner={owner}
            repo={repo}
            user={user}
            error={validationError}
          />
        </Layout>,
        400
      );
    }

    const result = await startMigration({
      owner,
      repo,
      repoId: resolved.repoId,
      userId: user.id,
      target: target!,
    });

    if (!result.ok) {
      return c.html(
        <Layout title={`AI Migration — ${owner}/${repo}`} user={user}>
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="migrate" />
          <MigrationFormPage
            owner={owner}
            repo={repo}
            user={user}
            error={result.error}
          />
        </Layout>,
        429
      );
    }

    return c.redirect(`/${owner}/${repo}/migrate/${result.job.id}`);
  }
);

/** GET /:owner/:repo/migrate/:jobId — progress page */
codebaseMigratorRoutes.get(
  "/:owner/:repo/migrate/:jobId",
  softAuth,
  async (c) => {
    const { owner, repo, jobId } = c.req.param();
    const user = c.get("user") ?? null;

    const job = getJob(jobId);
    if (!job || job.owner !== owner || job.repo !== repo) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div style="max-width:600px;margin:3rem auto;padding:0 1rem;text-align:center">
            <h2>Migration job not found</h2>
            <p style="color:var(--text-muted)">
              This job may have expired or never existed.
            </p>
            <a href={`/${owner}/${repo}/migrate`} style="color:var(--accent)">
              Start a new migration
            </a>
          </div>
        </Layout>,
        404
      );
    }

    return c.html(
      <Layout title={`Migration — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <RepoNav owner={owner} repo={repo} active="migrate" />
        <ProgressPage owner={owner} repo={repo} job={job} />
      </Layout>
    );
  }
);

/** GET /:owner/:repo/migrate/:jobId/status — JSON status */
codebaseMigratorRoutes.get(
  "/:owner/:repo/migrate/:jobId/status",
  async (c) => {
    const { owner, repo, jobId } = c.req.param();
    const job = getJob(jobId);
    if (!job || job.owner !== owner || job.repo !== repo) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(job);
  }
);

export default codebaseMigratorRoutes;
