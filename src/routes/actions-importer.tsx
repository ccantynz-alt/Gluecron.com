/**
 * GitHub Actions Importer — stateless YAML converter.
 *
 * Routes:
 *   GET  /import/actions        — landing page with paste/upload form
 *   POST /import/actions        — parse & convert, show split-panel results
 *   GET  /import/actions/guide  — migration guide
 *
 * No DB tables needed — the converter is fully stateless.
 *
 * Conversion logic:
 *   - actions/checkout@*        → stripped (Gluecron clones automatically)
 *   - actions/setup-node@*      → NODE_VERSION env var
 *   - actions/setup-python@*    → PYTHON_VERSION env var
 *   - actions/setup-java@*      → JAVA_VERSION env var
 *   - actions/setup-go@*        → GO_VERSION env var
 *   - npm test / run / build    → GateTest `run:` step
 *   - ${{ secrets.FOO }}        → $FOO
 *   - ${{ github.* }}           → stripped / noted as unsupported
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const actionsImporterRoutes = new Hono<AuthEnv>();
actionsImporterRoutes.use("*", softAuth);

// ─── Types ───────────────────────────────────────────────────────────────────

interface GateStep {
  name: string;
  run: string;
  env?: Record<string, string>;
  on: string[];
}

interface ConversionResult {
  gates: GateStep[];
  supported: SupportedMapping[];
  unsupported: UnsupportedItem[];
  gatesYaml: string;
}

interface SupportedMapping {
  from: string;
  to: string;
}

interface UnsupportedItem {
  action: string;
  reason: string;
}

// ─── Scoped CSS (.ai-*) ──────────────────────────────────────────────────────

const importerStyles = `
  .ai-wrap {
    max-width: 1320px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-10);
  }

  /* ─── Hero ─── */
  .ai-hero {
    position: relative;
    margin-bottom: var(--space-8);
    padding: var(--space-8) var(--space-8);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    text-align: center;
  }
  .ai-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    pointer-events: none;
  }
  .ai-hero-orb {
    position: absolute;
    top: -80px; right: -80px;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18) 0%, rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
    z-index: 0;
  }
  .ai-hero-orb2 {
    position: absolute;
    bottom: -60px; left: -60px;
    width: 260px; height: 260px;
    background: radial-gradient(circle, rgba(54,197,214,0.14) 0%, transparent 70%);
    filter: blur(55px);
    pointer-events: none;
    z-index: 0;
  }
  .ai-hero-content { position: relative; z-index: 1; }
  .ai-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: var(--space-3);
  }
  .ai-hero h1 {
    font-size: clamp(28px, 4vw, 48px);
    font-family: var(--font-display);
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.1;
    margin-bottom: var(--space-3);
    color: var(--text-strong);
  }
  .ai-hero-sub {
    font-size: 17px;
    color: var(--text-muted);
    max-width: 600px;
    margin: 0 auto var(--space-6);
    line-height: 1.6;
  }
  .ai-grad {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  /* ─── Form card ─── */
  .ai-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-6);
    margin-bottom: var(--space-6);
  }
  .ai-form-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: var(--space-2);
  }
  .ai-form-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .ai-textarea {
    width: 100%;
    min-height: 280px;
    padding: var(--space-3) var(--space-4);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    resize: vertical;
    transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
  }
  .ai-textarea:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--ring);
  }
  .ai-textarea::placeholder { color: var(--text-faint); }

  .ai-upload-zone {
    border: 2px dashed var(--border);
    border-radius: var(--r-md);
    padding: var(--space-5);
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    cursor: pointer;
    transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
    margin-top: var(--space-3);
  }
  .ai-upload-zone:hover {
    border-color: var(--accent);
    background: rgba(140,109,255,0.04);
  }
  .ai-upload-zone input[type=file] {
    display: none;
  }

  .ai-or-sep {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-4) 0;
    color: var(--text-faint);
    font-size: 12px;
  }
  .ai-or-sep::before, .ai-or-sep::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .ai-submit-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-5);
    flex-wrap: wrap;
  }
  .ai-submit-row .btn {
    min-width: 160px;
  }
  .ai-note {
    font-size: 12px;
    color: var(--text-muted);
    flex: 1;
  }
  .ai-note a { color: var(--text-link); }

  /* ─── Split panel (results) ─── */
  .ai-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }
  @media (max-width: 900px) {
    .ai-split { grid-template-columns: 1fr; }
  }
  .ai-panel {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .ai-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--bg-tertiary);
    gap: var(--space-3);
    flex-shrink: 0;
  }
  .ai-panel-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    font-family: var(--font-mono);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .ai-panel-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 9999px;
    font-weight: 600;
    background: var(--bg-surface);
    color: var(--text-muted);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
  }
  .ai-panel-badge.badge-green {
    background: rgba(52,211,153,0.1);
    color: var(--green);
    border-color: rgba(52,211,153,0.25);
  }
  .ai-code-block {
    flex: 1;
    margin: 0;
    padding: var(--space-4);
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.7;
    color: var(--text);
    background: transparent;
    white-space: pre;
    max-height: 520px;
  }
  .ai-panel-actions {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
    display: flex;
    gap: var(--space-2);
    background: var(--bg-tertiary);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .ai-panel-actions .btn {
    font-size: 12px;
    padding: 6px 12px;
  }

  /* ─── Mappings list ─── */
  .ai-results-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }
  @media (max-width: 768px) {
    .ai-results-grid { grid-template-columns: 1fr; }
  }
  .ai-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .ai-card-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--bg-tertiary);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .ai-card-head svg { flex-shrink: 0; }
  .ai-card-body { padding: var(--space-3) 0; }
  .ai-map-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
  }
  .ai-map-row:hover { background: var(--bg-hover); }
  .ai-map-icon {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    margin-top: 1px;
  }
  .ai-map-icon.ok { background: rgba(52,211,153,0.15); color: var(--green); }
  .ai-map-icon.warn { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .ai-map-from {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    word-break: break-all;
  }
  .ai-map-arrow {
    color: var(--text-faint);
    font-size: 11px;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .ai-map-to {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
    word-break: break-all;
  }
  .ai-map-content { flex: 1; }
  .ai-map-reason {
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  /* ─── Empty state ─── */
  .ai-empty {
    padding: var(--space-6) var(--space-4);
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
  }

  /* ─── Auto-import note ─── */
  .ai-auto-note {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    background: rgba(140,109,255,0.07);
    border: 1px solid rgba(140,109,255,0.22);
    border-radius: 10px;
    margin-bottom: var(--space-6);
  }
  .ai-auto-note-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: rgba(140,109,255,0.18);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--accent);
  }
  .ai-auto-note-text {
    font-size: 13.5px;
    color: var(--text);
    line-height: 1.55;
  }
  .ai-auto-note-text strong { color: var(--text-strong); }

  /* ─── Try again ─── */
  .ai-try-again {
    margin-bottom: var(--space-6);
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  /* ─── Guide ─── */
  .ai-guide-wrap {
    max-width: 860px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4) var(--space-12);
  }
  .ai-guide-wrap h2 {
    font-size: 20px;
    margin: var(--space-8) 0 var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    color: var(--text-strong);
  }
  .ai-guide-wrap h2:first-of-type { border-top: none; margin-top: var(--space-5); }
  .ai-guide-wrap p {
    font-size: 15px;
    line-height: 1.7;
    color: var(--text);
    margin-bottom: var(--space-4);
  }
  .ai-guide-wrap ul, .ai-guide-wrap ol {
    padding-left: var(--space-6);
    margin-bottom: var(--space-4);
  }
  .ai-guide-wrap li {
    font-size: 15px;
    line-height: 1.7;
    color: var(--text);
    margin-bottom: var(--space-1);
  }
  .ai-guide-wrap code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    padding: 2px 6px;
    border-radius: var(--r-sm);
  }
  .ai-guide-pre {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--space-4);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.7;
    overflow-x: auto;
    margin-bottom: var(--space-5);
    white-space: pre;
  }
  .ai-step-list {
    list-style: none;
    padding: 0;
    counter-reset: step;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }
  .ai-step-item {
    display: flex;
    gap: var(--space-4);
    align-items: flex-start;
    counter-increment: step;
  }
  .ai-step-num {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent-gradient);
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .ai-step-body { flex: 1; padding-top: 3px; }
  .ai-step-title {
    font-weight: 600;
    color: var(--text-strong);
    font-size: 15px;
    margin-bottom: var(--space-1);
  }
  .ai-step-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: var(--r);
    font-size: 14px;
    font-weight: 600;
    font-family: var(--font-sans);
    border: 1px solid transparent;
    cursor: pointer;
    transition: all var(--t-fast) var(--ease);
    text-decoration: none;
    line-height: 1.3;
  }
  .btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #7059e0 100%);
    color: #fff;
    border-color: rgba(140,109,255,0.6);
    box-shadow: 0 2px 8px rgba(140,109,255,0.30);
  }
  .btn-primary:hover {
    background: linear-gradient(135deg, #a48bff 0%, #8c6dff 100%);
    box-shadow: 0 4px 14px rgba(140,109,255,0.40);
    text-decoration: none;
    color: #fff;
  }
  .btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text);
    border-color: var(--border);
  }
  .btn-secondary:hover { background: var(--bg-hover); border-color: var(--border-strong); text-decoration: none; color: var(--text-strong); }
  .btn-ghost {
    background: transparent;
    color: var(--text-muted);
    border-color: transparent;
  }
  .btn-ghost:hover { background: var(--bg-hover); color: var(--text); text-decoration: none; }
`;

// ─── Conversion logic ─────────────────────────────────────────────────────────

/** Known GitHub Actions that map to Gluecron env vars. */
const SETUP_ACTIONS: Record<string, { envKey: string; envValue: string; label: string }> = {
  "actions/setup-node": {
    envKey: "NODE_VERSION",
    envValue: "20",
    label: 'NODE_VERSION: "20"',
  },
  "actions/setup-python": {
    envKey: "PYTHON_VERSION",
    envValue: "3.11",
    label: 'PYTHON_VERSION: "3.11"',
  },
  "actions/setup-java": {
    envKey: "JAVA_VERSION",
    envValue: "21",
    label: 'JAVA_VERSION: "21"',
  },
  "actions/setup-go": {
    envKey: "GO_VERSION",
    envValue: "1.22",
    label: 'GO_VERSION: "1.22"',
  },
  "actions/setup-ruby": {
    envKey: "RUBY_VERSION",
    envValue: "3.3",
    label: 'RUBY_VERSION: "3.3"',
  },
  "actions/setup-dotnet": {
    envKey: "DOTNET_VERSION",
    envValue: "8.0",
    label: 'DOTNET_VERSION: "8.0"',
  },
};

/** Well-known run commands → gate names. */
const RUN_NAME_MAP: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bnpm\s+test\b/, name: "Test" },
  { pattern: /\bnpm\s+run\s+test\b/, name: "Test" },
  { pattern: /\bnpm\s+run\s+lint\b/, name: "Lint" },
  { pattern: /\bnpm\s+run\s+build\b/, name: "Build" },
  { pattern: /\bpnpm\s+test\b/, name: "Test" },
  { pattern: /\bpnpm\s+run\s+test\b/, name: "Test" },
  { pattern: /\bpnpm\s+run\s+lint\b/, name: "Lint" },
  { pattern: /\bpnpm\s+run\s+build\b/, name: "Build" },
  { pattern: /\byarn\s+test\b/, name: "Test" },
  { pattern: /\byarn\s+lint\b/, name: "Lint" },
  { pattern: /\byarn\s+build\b/, name: "Build" },
  { pattern: /\bpython\s+-m\s+pytest\b/, name: "Test" },
  { pattern: /\bpytest\b/, name: "Test" },
  { pattern: /\bflake8\b/, name: "Lint" },
  { pattern: /\bruff\b/, name: "Lint" },
  { pattern: /\bblack\b/, name: "Lint" },
  { pattern: /\bgo\s+test\b/, name: "Test" },
  { pattern: /\bgo\s+build\b/, name: "Build" },
  { pattern: /\bmvn\s+test\b/, name: "Test" },
  { pattern: /\bmvn\s+package\b/, name: "Build" },
  { pattern: /\bgradle\b.*test\b/, name: "Test" },
  { pattern: /\bgradle\b.*build\b/, name: "Build" },
  { pattern: /\bcargo\s+test\b/, name: "Test" },
  { pattern: /\bcargo\s+build\b/, name: "Build" },
  { pattern: /\bcargo\s+clippy\b/, name: "Lint" },
];

/** Actions that are silently dropped (no gate produced). */
const IGNORED_ACTIONS = new Set([
  "actions/checkout",
  "actions/upload-artifact",
  "actions/download-artifact",
  "actions/cache",
  "actions/github-script",
]);

/**
 * Very lightweight YAML line-by-line parser specifically for GitHub Actions
 * workflow files. Does NOT need a full YAML parser — we extract jobs, steps,
 * `uses:` and `run:` keys, and the `on:` trigger events.
 */
function convertActionsYaml(raw: string): ConversionResult {
  const lines = raw.split("\n");

  // ── Pass 1: collect trigger events from `on:` block ──────────────────────
  const triggerEvents: string[] = [];
  let inOn = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^on\s*:/.test(trimmed)) {
      inOn = true;
      // Inline form: `on: [push, pull_request]`
      const inlineMatch = trimmed.match(/^on\s*:\s*\[([^\]]+)\]/);
      if (inlineMatch) {
        for (const e of inlineMatch[1].split(",")) triggerEvents.push(e.trim());
        inOn = false;
      }
      continue;
    }
    if (inOn) {
      if (/^\S/.test(line) && !/^\s*-/.test(line) && !trimmed.startsWith("#")) {
        // New top-level key — we've left the `on:` block
        inOn = false;
        continue;
      }
      const evtMatch = trimmed.match(/^-?\s*(\w[\w_-]*)(?:\s*:)?$/);
      if (evtMatch) triggerEvents.push(evtMatch[1]);
    }
  }

  const events =
    triggerEvents.length > 0
      ? triggerEvents.filter((e) => ["push", "pull_request", "schedule", "workflow_dispatch"].includes(e))
      : ["push", "pull_request"];
  const finalEvents = events.length > 0 ? events : ["push", "pull_request"];

  // ── Pass 2: parse jobs → steps ────────────────────────────────────────────
  const gates: GateStep[] = [];
  const supported: SupportedMapping[] = [];
  const unsupported: UnsupportedItem[] = [];
  const seenGateNames = new Map<string, number>();

  // Track per-job env vars (from setup actions)
  let currentJobEnv: Record<string, string> = {};
  const pendingRunSteps: Array<{ run: string; stepName: string }> = [];

  let inJobs = false;
  let inSteps = false;
  let currentUses = "";
  let currentRun = "";
  let currentStepName = "";
  let stepIndent = -1;
  let stepsIndent = -1;

  const flushRunStep = (runCmd: string, stepName: string) => {
    if (!runCmd.trim()) return;
    // Replace ${{ secrets.FOO }} → $FOO
    const converted = runCmd.replace(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g, "\\$$1");

    // Determine gate name
    let gateName = stepName || "";
    if (!gateName) {
      for (const { pattern, name } of RUN_NAME_MAP) {
        if (pattern.test(converted)) {
          gateName = name;
          break;
        }
      }
    }
    if (!gateName) gateName = "CI";

    // Deduplicate gate names
    const existing = seenGateNames.get(gateName) ?? 0;
    seenGateNames.set(gateName, existing + 1);
    const uniqueName = existing === 0 ? gateName : `${gateName} ${existing + 1}`;

    const gate: GateStep = {
      name: uniqueName,
      run: converted.trim(),
      on: finalEvents,
    };
    if (Object.keys(currentJobEnv).length > 0) {
      gate.env = { ...currentJobEnv };
    }
    gates.push(gate);

    // Track supported mapping for secrets
    if (runCmd.includes("${{")) {
      const secretMatches = runCmd.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g);
      for (const m of secretMatches) {
        supported.push({ from: `\${{ secrets.${m[1]} }}`, to: `\$${m[1]}` });
      }
    }
  };

  const flushUses = (uses: string) => {
    const action = uses.split("@")[0];
    if (IGNORED_ACTIONS.has(action)) {
      if (action === "actions/checkout") {
        supported.push({
          from: uses,
          to: "Automatic (Gluecron clones before every gate run)",
        });
      }
      return;
    }
    if (SETUP_ACTIONS[action]) {
      const mapping = SETUP_ACTIONS[action];
      currentJobEnv[mapping.envKey] = mapping.envValue;
      supported.push({ from: uses, to: mapping.label });
      return;
    }
    // Unknown action — surface as unsupported
    unsupported.push({
      action: uses,
      reason: "Third-party action — check the action's README and replicate the equivalent shell commands.",
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    // Top-level `jobs:` marker
    if (/^jobs\s*:/.test(trimmed) && indent === 0) {
      inJobs = true;
      inSteps = false;
      continue;
    }

    if (!inJobs) continue;

    // Job-level key (2-space or 4-space indent) — new job resets env + steps
    if (indent <= 2 && /^[a-z_-]+\s*:/i.test(trimmed) && trimmed !== "steps:") {
      // Flush any pending run from previous job
      if (currentRun) {
        flushRunStep(currentRun, currentStepName);
        currentRun = "";
        currentStepName = "";
      }
      currentJobEnv = {};
      inSteps = false;
      stepsIndent = -1;
      stepIndent = -1;
      continue;
    }

    // `steps:` block
    if (/^steps\s*:/.test(trimmed)) {
      inSteps = true;
      stepsIndent = indent;
      if (currentRun) {
        flushRunStep(currentRun, currentStepName);
        currentRun = "";
        currentStepName = "";
      }
      continue;
    }

    if (!inSteps) continue;

    // New step marker (list item `- `)
    if (trimmed.startsWith("- ") || trimmed === "-") {
      // Flush previous step
      if (currentUses) {
        flushUses(currentUses);
        currentUses = "";
      }
      if (currentRun) {
        flushRunStep(currentRun, currentStepName);
        currentRun = "";
      }
      currentStepName = "";
      stepIndent = indent;

      const restOfLine = trimmed.slice(2).trim();
      if (restOfLine.startsWith("name:")) {
        currentStepName = restOfLine.replace(/^name\s*:\s*/, "").replace(/^['"]|['"]$/g, "");
      } else if (restOfLine.startsWith("uses:")) {
        currentUses = restOfLine.replace(/^uses\s*:\s*/, "").trim();
      } else if (restOfLine.startsWith("run:")) {
        currentRun = restOfLine.replace(/^run\s*:\s*/, "");
      }
      continue;
    }

    // Continuation lines within a step
    if (stepIndent >= 0 && indent > stepIndent) {
      if (/^name\s*:/i.test(trimmed)) {
        currentStepName = trimmed.replace(/^name\s*:\s*/i, "").replace(/^['"]|['"]$/g, "");
      } else if (/^uses\s*:/i.test(trimmed)) {
        currentUses = trimmed.replace(/^uses\s*:\s*/i, "").trim();
      } else if (/^run\s*:/i.test(trimmed)) {
        currentRun = trimmed.replace(/^run\s*:\s*/i, "");
      } else if (currentRun && /^\|/.test(trimmed)) {
        // multiline run block marker — the run content is on following lines
        currentRun = "";
      } else if (currentRun !== "" && trimmed && !trimmed.includes(":")) {
        // Continuation of multiline run
        currentRun += "\n" + trimmed;
      } else if (currentRun && /^\$\{\{/.test(trimmed) || (currentRun && trimmed.match(/^[a-z]/))) {
        // looks like a run continuation
        currentRun += " " + trimmed;
      }
    }
  }

  // Flush last step
  if (currentUses) flushUses(currentUses);
  if (currentRun) flushRunStep(currentRun, currentStepName);

  // ── Check for unsupported github.* expressions ────────────────────────────
  const githubExprCount = (raw.match(/\$\{\{\s*github\./g) || []).length;
  if (githubExprCount > 0) {
    unsupported.push({
      action: "${{ github.* }} expressions (" + githubExprCount + " found)",
      reason: "GitHub context variables have no direct Gluecron equivalent. Use environment variables or gate output for dynamic values.",
    });
  }

  // ── Check for env.* expressions ──────────────────────────────────────────
  const envExprCount = (raw.match(/\$\{\{\s*env\./g) || []).length;
  if (envExprCount > 0) {
    unsupported.push({
      action: "${{ env.* }} expressions (" + envExprCount + " found)",
      reason: "Gluecron uses plain shell environment variables. Replace with the equivalent $VAR_NAME syntax.",
    });
  }

  // ── Dedup supported mappings ──────────────────────────────────────────────
  const seenFrom = new Set<string>();
  const dedupedSupported = supported.filter((s) => {
    if (seenFrom.has(s.from)) return false;
    seenFrom.add(s.from);
    return true;
  });

  // ── Serialize to gates.yml ────────────────────────────────────────────────
  let gatesYaml = "# .gluecron/gates.yml\n# Generated by Gluecron GitHub Actions Importer\n\n";
  if (gates.length === 0) {
    gatesYaml += "gates: []\n\n# No convertible run steps were found.\n# Paste a workflow with `run:` steps to generate gates.\n";
  } else {
    gatesYaml += "gates:\n";
    for (const gate of gates) {
      gatesYaml += `  - name: "${gate.name}"\n`;
      gatesYaml += `    on: [${gate.on.join(", ")}]\n`;
      if (gate.env && Object.keys(gate.env).length > 0) {
        gatesYaml += "    env:\n";
        for (const [k, v] of Object.entries(gate.env)) {
          gatesYaml += `      ${k}: "${v}"\n`;
        }
      }
      // Multi-line run uses YAML block scalar
      if (gate.run.includes("\n")) {
        gatesYaml += "    run: |\n";
        for (const runLine of gate.run.split("\n")) {
          gatesYaml += `      ${runLine}\n`;
        }
      } else {
        gatesYaml += `    run: "${gate.run.replace(/"/g, '\\"')}"\n`;
      }
    }
  }

  return { gates, supported: dedupedSupported, unsupported, gatesYaml };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /import/actions — landing form
actionsImporterRoutes.get("/import/actions", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout
      title="GitHub Actions Importer — gluecron"
      user={user}
      description="Convert your GitHub Actions workflows to Gluecron gates.yml in seconds. Paste YAML or upload a workflow file."
    >
      <style dangerouslySetInnerHTML={{ __html: importerStyles }} />
      <div class="ai-wrap">
        <ImporterHero />
        <ImporterForm />
        <AutoImportNote />
      </div>
    </Layout>,
  );
});

// POST /import/actions — convert and show results
actionsImporterRoutes.post("/import/actions", async (c) => {
  const user = c.get("user");

  const formData = await c.req.parseBody();
  let rawYaml = (formData["yaml"] as string | undefined) ?? "";

  // File upload support — browser sends as Blob
  if (!rawYaml && formData["file"]) {
    const file = formData["file"] as File | undefined;
    if (file && typeof file.text === "function") {
      rawYaml = await file.text();
    }
  }

  rawYaml = rawYaml.trim();

  if (!rawYaml) {
    return c.html(
      <Layout title="GitHub Actions Importer — gluecron" user={user}>
        <style dangerouslySetInnerHTML={{ __html: importerStyles }} />
        <div class="ai-wrap">
          <ImporterHero />
          <div
            style="padding:16px 20px;border-radius:10px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:var(--red);font-size:14px;margin-bottom:24px"
          >
            No YAML provided. Please paste a workflow or upload a file.
          </div>
          <ImporterForm />
        </div>
      </Layout>,
      400,
    );
  }

  const result = convertActionsYaml(rawYaml);

  return c.html(
    <Layout title="Converted — GitHub Actions Importer" user={user}>
      <style dangerouslySetInnerHTML={{ __html: importerStyles }} />
      <div class="ai-wrap">
        <ImporterHero compact />
        <div class="ai-try-again">
          <a href="/import/actions" class="btn btn-secondary">
            ← Try another workflow
          </a>
          <a href="/import/actions/guide" class="btn btn-ghost">
            Migration guide
          </a>
        </div>
        <AutoImportNote />
        <ResultsSplitPanel original={rawYaml} result={result} />
        <ResultsMappings result={result} />
      </div>
    </Layout>,
  );
});

// GET /import/actions/guide — migration guide
actionsImporterRoutes.get("/import/actions/guide", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout
      title="GitHub Actions → Gluecron Migration Guide"
      user={user}
      description="Step-by-step guide for migrating your GitHub Actions CI/CD pipelines to Gluecron gates."
    >
      <style dangerouslySetInnerHTML={{ __html: importerStyles }} />
      <div class="ai-guide-wrap">
        <MigrationGuide />
      </div>
    </Layout>,
  );
});

// ─── JSX Components ──────────────────────────────────────────────────────────

function ImporterHero({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <div style="margin-bottom:var(--space-5)">
        <div class="ai-eyebrow">GitHub Actions Importer</div>
        <h1 style="font-size:24px;font-family:var(--font-display);font-weight:700;color:var(--text-strong);margin:0">
          Conversion results
        </h1>
      </div>
    );
  }
  return (
    <div class="ai-hero">
      <div class="ai-hero-orb" aria-hidden="true" />
      <div class="ai-hero-orb2" aria-hidden="true" />
      <div class="ai-hero-content">
        <div class="ai-eyebrow">Migration tools</div>
        <h1>
          Convert GitHub Actions to{" "}
          <span class="ai-grad">Gluecron gates</span>
        </h1>
        <p class="ai-hero-sub">
          Paste your <code>.github/workflows/*.yml</code> file and get an
          equivalent <code>.gluecron/gates.yml</code> in seconds. The #1
          migration blocker — eliminated.
        </p>
        <div style="display:flex;align-items:center;justify-content:center;gap:var(--space-3);flex-wrap:wrap">
          <a href="#converter-form" class="btn btn-primary">
            Start converting
          </a>
          <a href="/import/actions/guide" class="btn btn-secondary">
            Migration guide
          </a>
        </div>
      </div>
    </div>
  );
}

function AutoImportNote() {
  return (
    <div class="ai-auto-note">
      <div class="ai-auto-note-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <div class="ai-auto-note-text">
        <strong>Import a repo from GitHub and this conversion runs automatically.</strong>{" "}
        When you use{" "}
        <a href="/import">Import from GitHub</a>, Gluecron detects your
        workflow files and generates a <code>.gluecron/gates.yml</code> for
        you — no manual copy-paste required.
      </div>
    </div>
  );
}

function ImporterForm() {
  return (
    <div class="ai-form-card" id="converter-form">
      <form method="POST" action="/import/actions" enctype="multipart/form-data">
        <label class="ai-form-label" for="yaml-input">
          Paste your GitHub Actions workflow YAML
        </label>
        <p class="ai-form-hint">
          Paste the contents of a <code>.github/workflows/*.yml</code> file
          below. Secrets, setup steps, and run commands are all handled.
        </p>
        <textarea
          id="yaml-input"
          name="yaml"
          class="ai-textarea"
          placeholder={`name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n      - run: npm ci\n      - run: npm test\n      - run: npm run lint`}
          spellcheck={false}
          autocomplete="off"
        />

        <div class="ai-or-sep">or upload a file</div>

        <label class="ai-upload-zone" for="file-upload" tabIndex={0}>
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            style="margin-bottom:8px;color:var(--text-faint)"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <div>
            Drop a <code>.yml</code> workflow file here, or{" "}
            <span style="color:var(--accent);text-decoration:underline">browse</span>
          </div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:4px">
            YAML files only &mdash; max 512 KB
          </div>
          <input
            id="file-upload"
            type="file"
            name="file"
            accept=".yml,.yaml,text/yaml,application/yaml"
          />
        </label>

        <div class="ai-submit-row">
          <button type="submit" class="btn btn-primary">
            Convert to Gluecron gates.yml
          </button>
          <span class="ai-note">
            No data is stored. The conversion runs entirely on the server and
            the result is returned immediately.{" "}
            <a href="/import/actions/guide">Read the migration guide →</a>
          </span>
        </div>
      </form>
    </div>
  );
}

function ResultsSplitPanel({ original, result }: { original: string; result: ConversionResult }) {
  const outputId = "ai-gates-output";
  const inputId = "ai-original-input";
  const gateCount = result.gates.length;

  return (
    <div class="ai-split">
      {/* Left: original */}
      <div class="ai-panel">
        <div class="ai-panel-header">
          <span class="ai-panel-title">.github/workflows/ci.yml</span>
          <span class="ai-panel-badge">Original</span>
        </div>
        <pre class="ai-code-block" id={inputId}>{original}</pre>
      </div>

      {/* Right: converted */}
      <div class="ai-panel">
        <div class="ai-panel-header">
          <span class="ai-panel-title">.gluecron/gates.yml</span>
          <span class={`ai-panel-badge${gateCount > 0 ? " badge-green" : ""}`}>
            {gateCount} {gateCount === 1 ? "gate" : "gates"} converted
          </span>
        </div>
        <pre class="ai-code-block" id={outputId}>{result.gatesYaml}</pre>
        <div class="ai-panel-actions">
          <button
            type="button"
            class="btn btn-secondary"
            onclick={`(function(){
              var el = document.getElementById('${outputId}');
              if (!el) return;
              navigator.clipboard && navigator.clipboard.writeText(el.textContent || '').then(function(){
                var b = event.currentTarget;
                var orig = b.textContent;
                b.textContent = 'Copied!';
                setTimeout(function(){ b.textContent = orig; }, 1800);
              });
            })()`}
          >
            Copy to clipboard
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            onclick={`(function(){
              var el = document.getElementById('${outputId}');
              if (!el) return;
              var blob = new Blob([el.textContent || ''], { type: 'text/yaml' });
              var url = URL.createObjectURL(blob);
              var a = document.createElement('a');
              a.href = url;
              a.download = 'gates.yml';
              document.body.appendChild(a);
              a.click();
              setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
            })()`}
          >
            Download as .gluecron/gates.yml
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultsMappings({ result }: { result: ConversionResult }) {
  return (
    <div class="ai-results-grid">
      {/* Supported mappings */}
      <div class="ai-card">
        <div class="ai-card-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Supported mappings ({result.supported.length})
        </div>
        <div class="ai-card-body">
          {result.supported.length === 0 ? (
            <div class="ai-empty">No mapped actions detected in this workflow.</div>
          ) : (
            result.supported.map((m) => (
              <div class="ai-map-row">
                <span class="ai-map-icon ok" aria-label="Supported">✓</span>
                <div class="ai-map-content">
                  <div class="ai-map-from">{m.from}</div>
                  <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
                    <span class="ai-map-arrow">→</span>
                    <div class="ai-map-to">{m.to}</div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Unsupported / manual attention */}
      <div class="ai-card">
        <div class="ai-card-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--yellow)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Needs manual attention ({result.unsupported.length})
        </div>
        <div class="ai-card-body">
          {result.unsupported.length === 0 ? (
            <div class="ai-empty" style="color:var(--green)">
              All actions were handled automatically.
            </div>
          ) : (
            result.unsupported.map((u) => (
              <div class="ai-map-row">
                <span class="ai-map-icon warn" aria-label="Needs attention">!</span>
                <div class="ai-map-content">
                  <div class="ai-map-from">{u.action}</div>
                  <div class="ai-map-reason">{u.reason}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MigrationGuide() {
  return (
    <>
      <div class="ai-eyebrow" style="margin-bottom:var(--space-3)">Migration guide</div>
      <h1 style="font-size:clamp(28px,4vw,40px);font-family:var(--font-display);font-weight:700;letter-spacing:-0.03em;line-height:1.1;margin-bottom:var(--space-3);color:var(--text-strong)">
        GitHub Actions → Gluecron gates
      </h1>
      <p style="font-size:16px;color:var(--text-muted);margin-bottom:var(--space-8);max-width:620px">
        Everything you need to know to migrate your CI/CD pipelines from
        GitHub Actions to Gluecron&rsquo;s gate system — with zero downtime and
        full automation coverage.
      </p>

      <h2>Overview</h2>
      <p>
        Gluecron replaces GitHub Actions workflows with a lightweight{" "}
        <code>.gluecron/gates.yml</code> file checked into your repository.
        Gates run on push and pull request events — just like GitHub Actions —
        but without the YAML boilerplate, the runner billing, or the
        marketplace dependency risk.
      </p>
      <p>
        Key differences from GitHub Actions:
      </p>
      <ul>
        <li>
          <strong>No checkout step needed.</strong> Gluecron clones your repo
          automatically before every gate run.
        </li>
        <li>
          <strong>No runner OS selection.</strong> All gates run in a managed,
          clean environment per push.
        </li>
        <li>
          <strong>Secrets are plain env vars.</strong>{" "}
          <code>{"${{ secrets.MY_TOKEN }}"}</code> becomes{" "}
          <code>$MY_TOKEN</code> — set in your repo&rsquo;s Secrets settings.
        </li>
        <li>
          <strong>No matrix builds yet.</strong> Run multiple gates instead of
          a matrix strategy.
        </li>
      </ul>

      <h2>Quick start</h2>
      <ol class="ai-step-list">
        <li class="ai-step-item">
          <div class="ai-step-num">1</div>
          <div class="ai-step-body">
            <div class="ai-step-title">Paste your workflow into the importer</div>
            <div class="ai-step-desc">
              Head to{" "}
              <a href="/import/actions">/import/actions</a> and paste your{" "}
              <code>.github/workflows/*.yml</code> file. The converter handles
              secrets, setup actions, and run commands automatically.
            </div>
          </div>
        </li>
        <li class="ai-step-item">
          <div class="ai-step-num">2</div>
          <div class="ai-step-body">
            <div class="ai-step-title">Download the generated gates.yml</div>
            <div class="ai-step-desc">
              Click &ldquo;Download as .gluecron/gates.yml&rdquo; and commit
              the file to the root of your repo at{" "}
              <code>.gluecron/gates.yml</code>.
            </div>
          </div>
        </li>
        <li class="ai-step-item">
          <div class="ai-step-num">3</div>
          <div class="ai-step-body">
            <div class="ai-step-title">Migrate your secrets</div>
            <div class="ai-step-desc">
              Go to your repo&rsquo;s <strong>Settings → Secrets</strong> and
              add each secret that your workflow referenced. The names stay the
              same — only the reference syntax changes.
            </div>
          </div>
        </li>
        <li class="ai-step-item">
          <div class="ai-step-num">4</div>
          <div class="ai-step-body">
            <div class="ai-step-title">Push and verify</div>
            <div class="ai-step-desc">
              Push a commit and watch your gates run in real time under{" "}
              <strong>/:owner/:repo/push/:sha</strong>. Green gates on the
              first push means you&rsquo;re done.
            </div>
          </div>
        </li>
      </ol>

      <h2>Gates YAML reference</h2>
      <p>
        A complete <code>.gluecron/gates.yml</code> looks like this:
      </p>
      <pre class="ai-guide-pre">{`gates:
  - name: "Test"
    on: [push, pull_request]
    env:
      NODE_VERSION: "20"
    run: "npm test"

  - name: "Lint"
    on: [push, pull_request]
    run: "npm run lint"

  - name: "Build"
    on: [push]
    run: "npm run build"`}
      </pre>

      <h2>Action mapping reference</h2>
      <p>
        The following GitHub Actions are automatically converted:
      </p>

      <div style="overflow-x:auto;margin-bottom:var(--space-6)">
        <table style="width:100%;border-collapse:collapse;font-size:13.5px">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:10px 12px;color:var(--text-muted);font-weight:600">GitHub Actions</th>
              <th style="text-align:left;padding:10px 12px;color:var(--text-muted);font-weight:600">Gluecron equivalent</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["actions/checkout@v3", "Automatic — no step needed"],
              ["actions/setup-node@v3 (node-version: 20)", 'NODE_VERSION: "20" env var'],
              ["actions/setup-python@v3 (python-version: 3.11)", 'PYTHON_VERSION: "3.11" env var'],
              ["actions/setup-java@v3", 'JAVA_VERSION: "21" env var'],
              ["actions/setup-go@v3", 'GO_VERSION: "1.22" env var'],
              ["actions/setup-ruby@v3", 'RUBY_VERSION: "3.3" env var'],
              ["actions/setup-dotnet@v3", 'DOTNET_VERSION: "8.0" env var'],
              ["actions/cache@v3", "No equivalent — cache is persistent across runs"],
              ["actions/upload-artifact@v3", "No equivalent — use external storage or release assets"],
              ['${{ secrets.MY_TOKEN }}', "$MY_TOKEN (plain env var)"],
            ].map(([from, to]) => (
              <tr style="border-bottom:1px solid var(--border-subtle)">
                <td style="padding:10px 12px;font-family:var(--font-mono);font-size:12.5px;color:var(--text-muted)">{from}</td>
                <td style="padding:10px 12px;font-family:var(--font-mono);font-size:12.5px;color:var(--text-strong)">{to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Manual steps</h2>
      <p>
        Some GitHub Actions patterns need manual adaptation:
      </p>
      <ul>
        <li>
          <strong>Matrix builds</strong> — create separate named gates instead.
          E.g. replace a <code>node: [18, 20, 22]</code> matrix with three
          gates named &ldquo;Test Node 18&rdquo;, &ldquo;Test Node 20&rdquo;,
          &ldquo;Test Node 22&rdquo;.
        </li>
        <li>
          <strong>Workflow-level env / outputs</strong> — use plain shell
          variables or a shared setup script sourced by multiple gates.
        </li>
        <li>
          <strong>if: conditions</strong> — Gluecron gates run on every
          matched event. Conditional logic should live inside the run script.
        </li>
        <li>
          <strong>Third-party marketplace actions</strong> — read the action
          README and replicate the equivalent shell commands in a{" "}
          <code>run:</code> step.
        </li>
        <li>
          <strong>Scheduled workflows (<code>schedule:</code>)</strong> — use
          Gluecron&rsquo;s cron gate trigger once available, or migrate to a
          lightweight external scheduler.
        </li>
      </ul>

      <h2>Need help?</h2>
      <p>
        Open an issue on any of your repos or reach us at{" "}
        <a href="/help">the help page</a>. The{" "}
        <a href="/import/actions">Actions Importer</a> handles the common 80%
        — for complex workflows, the Gluecron team can review your YAML and
        provide a hand-crafted gates.yml.
      </p>

      <div style="margin-top:var(--space-8);display:flex;gap:var(--space-3);flex-wrap:wrap">
        <a href="/import/actions" class="btn btn-primary">
          Open the importer
        </a>
        <a href="/import" class="btn btn-secondary">
          Import a repo from GitHub
        </a>
      </div>
    </>
  );
}

export default actionsImporterRoutes;
