/**
 * Per-repo automation settings — the single read/write surface for the
 * "Automation" settings page (`/:owner/:repo/settings/automation`) and for
 * every automation dispatch site (AI review, PR/issue triage, auto-merge,
 * CI autofix).
 *
 * Contract:
 *
 *   - One `repo_automation_settings` row per repository (migration 0106).
 *     No row → `AUTOMATION_DEFAULTS`, which match pre-0106 behavior exactly,
 *     so a repo that never touches the page behaves as it always did.
 *   - `getAutomationSettings` FAILS OPEN: any DB error returns the defaults
 *     so a broken lookup can never change platform behavior.
 *   - Env kill-switches stay supreme. A feature disabled at the environment
 *     level (missing ANTHROPIC_API_KEY, AI_LOOP_ENABLED unset, …) is off
 *     regardless of the stored mode — see `resolveEffectiveMode`. Dispatch
 *     sites keep their existing env guards; this module only ever *narrows*
 *     what runs, never widens it.
 *
 * Mode semantics per feature (see drizzle/0106 for the long-form docs):
 *
 *   aiReviewMode     'off' | 'suggest'            (default 'suggest')
 *   prTriageMode     'off' | 'suggest'            (default 'suggest')
 *   issueTriageMode  'off' | 'suggest'            (default 'suggest')
 *   autoMergeMode    'off' | 'suggest' | 'auto'   (default 'auto')
 *   ciAutofixMode    'off' | 'suggest' | 'auto'   (default 'suggest')
 *
 * Where only on/off is meaningful, 'auto' is treated the same as 'suggest'
 * (i.e. "on") — `isAutomationOn` encodes that rule.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { repoAutomationSettings } from "../db/schema";

// ---------------------------------------------------------------------------
// Types + defaults
// ---------------------------------------------------------------------------

export type AutomationMode = "off" | "suggest" | "auto";

export interface AutomationSettings {
  aiReviewMode: AutomationMode;
  prTriageMode: AutomationMode;
  issueTriageMode: AutomationMode;
  autoMergeMode: AutomationMode;
  ciAutofixMode: AutomationMode;
}

/** Loader signature — the DI seam dispatch sites accept for tests. */
export type AutomationSettingsLoader = (
  repositoryId: string
) => Promise<AutomationSettings>;

/**
 * Defaults = pre-0106 platform behavior. Auto-merge defaults to 'auto'
 * because the K2/K3 path already merges automatically (still default-deny
 * per branch via branch_protection.enable_auto_merge); everything else
 * defaults to 'suggest' because those features only ever posted advisory
 * comments.
 */
export const AUTOMATION_DEFAULTS: Readonly<AutomationSettings> = Object.freeze({
  aiReviewMode: "suggest",
  prTriageMode: "suggest",
  issueTriageMode: "suggest",
  autoMergeMode: "auto",
  ciAutofixMode: "suggest",
});

// ---------------------------------------------------------------------------
// Pure mode-resolution helpers (unit-testable, no DB)
// ---------------------------------------------------------------------------

/** Parse an untrusted value (form input, stale DB row) into a mode. */
export function normalizeMode(
  value: unknown,
  fallback: AutomationMode
): AutomationMode {
  return value === "off" || value === "suggest" || value === "auto"
    ? value
    : fallback;
}

/**
 * Env-supremacy rule: when the environment kill-switch for a feature is
 * off, the effective mode is 'off' no matter what the repo row says. The
 * repo setting can only narrow further (e.g. env on + repo 'off' → 'off').
 */
export function resolveEffectiveMode(
  repoMode: AutomationMode,
  envEnabled: boolean
): AutomationMode {
  if (!envEnabled) return "off";
  return repoMode;
}

/** "Is this feature on at all?" — 'suggest' and 'auto' both count as on. */
export function isAutomationOn(mode: AutomationMode): boolean {
  return mode !== "off";
}

/**
 * Coerce a raw row (or anything row-shaped) into a fully-valid settings
 * object, falling back per-field to the defaults. Exported for tests.
 */
export function settingsFromRow(
  row: Partial<Record<keyof AutomationSettings, unknown>> | null | undefined
): AutomationSettings {
  if (!row) return { ...AUTOMATION_DEFAULTS };
  return {
    aiReviewMode: normalizeMode(row.aiReviewMode, AUTOMATION_DEFAULTS.aiReviewMode),
    prTriageMode: normalizeMode(row.prTriageMode, AUTOMATION_DEFAULTS.prTriageMode),
    issueTriageMode: normalizeMode(
      row.issueTriageMode,
      AUTOMATION_DEFAULTS.issueTriageMode
    ),
    autoMergeMode: normalizeMode(row.autoMergeMode, AUTOMATION_DEFAULTS.autoMergeMode),
    ciAutofixMode: normalizeMode(row.ciAutofixMode, AUTOMATION_DEFAULTS.ciAutofixMode),
  };
}

// ---------------------------------------------------------------------------
// DB-backed loader + upsert
// ---------------------------------------------------------------------------

/**
 * Load the automation settings for a repository. No row → defaults.
 * FAILS OPEN: any DB error also returns the defaults (logged once at warn)
 * so a broken settings lookup never alters current platform behavior.
 */
export async function getAutomationSettings(
  repositoryId: string
): Promise<AutomationSettings> {
  try {
    const [row] = await db
      .select()
      .from(repoAutomationSettings)
      .where(eq(repoAutomationSettings.repositoryId, repositoryId))
      .limit(1);
    return settingsFromRow(row ?? null);
  } catch (err) {
    console.warn(
      "[automation-settings] lookup failed (falling back to defaults):",
      err instanceof Error ? err.message : err
    );
    return { ...AUTOMATION_DEFAULTS };
  }
}

/**
 * Create or update the settings row for a repository. Partial patches are
 * merged over the current effective settings so a form that only posts one
 * field can't reset the others. Throws on DB failure — callers (the
 * settings route) surface the error to the user.
 */
export async function upsertAutomationSettings(
  repositoryId: string,
  patch: Partial<AutomationSettings>
): Promise<AutomationSettings> {
  const current = await getAutomationSettings(repositoryId);
  const next: AutomationSettings = {
    aiReviewMode: normalizeMode(patch.aiReviewMode, current.aiReviewMode),
    prTriageMode: normalizeMode(patch.prTriageMode, current.prTriageMode),
    issueTriageMode: normalizeMode(patch.issueTriageMode, current.issueTriageMode),
    autoMergeMode: normalizeMode(patch.autoMergeMode, current.autoMergeMode),
    ciAutofixMode: normalizeMode(patch.ciAutofixMode, current.ciAutofixMode),
  };

  await db
    .insert(repoAutomationSettings)
    .values({ repositoryId, ...next })
    .onConflictDoUpdate({
      target: repoAutomationSettings.repositoryId,
      set: { ...next, updatedAt: new Date() },
    });

  return next;
}
