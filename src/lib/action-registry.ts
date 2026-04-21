/**
 * Built-in action registry for workflow engine v2 (Block C1 / Sprint 1 — Agent 8).
 *
 * Workflow YAML steps of the form `uses: gluecron/<name>@<version>` are
 * resolved here. The registry is in-memory and populated eagerly at module
 * load by calling `registerAll()` once. Re-registering is idempotent so
 * repeated imports (e.g. in tests) do not error.
 *
 * The runner (Agent 5) is the only expected caller of `resolveAction`. It
 * constructs an `ActionContext` from the running job's state and awaits
 * `handler.run(ctx)`. Handlers MUST NOT throw — every built-in wraps its
 * body in try/catch and returns `{ exitCode: 1, stderr }` on failure so the
 * runner's control flow stays predictable.
 */

export type ActionContext = {
  with: Record<string, unknown>;
  env: Record<string, string>;
  workspace: string; // absolute path to checked-out code
  runId: string;
  jobId: string;
  repoId: string;
  commitSha?: string | null;
  ref?: string | null;
};

export type ActionResult = {
  exitCode: number; // 0 = success
  outputs?: Record<string, string>;
  stdout?: string;
  stderr?: string;
};

export type ActionHandler = {
  name: string; // e.g. 'gluecron/gatetest'
  version: string; // e.g. 'v1'
  run: (ctx: ActionContext) => Promise<ActionResult>;
};

// Keyed by `${name}@${version}`. A secondary "latest" pointer per name is
// maintained so `uses: gluecron/foo` (no version) still resolves.
const handlers = new Map<string, ActionHandler>();
const latestByName = new Map<string, string>(); // name -> version

export function registerAction(handler: ActionHandler): void {
  if (!handler || !handler.name || !handler.version) return;
  const key = `${handler.name}@${handler.version}`;
  handlers.set(key, handler);
  // Simple latest-wins policy: last registration for a given name becomes
  // the default. Built-ins register in deterministic order (see registerAll).
  latestByName.set(handler.name, handler.version);
}

/**
 * Parse `uses` into (name, version). `version` defaults to `v1` when
 * omitted. Trailing whitespace tolerated; empty input yields nulls.
 */
function parseUses(uses: string): { name: string; version: string | null } | null {
  if (!uses || typeof uses !== "string") return null;
  const trimmed = uses.trim();
  if (!trimmed) return null;
  const at = trimmed.lastIndexOf("@");
  if (at === -1) {
    return { name: trimmed, version: null };
  }
  const name = trimmed.slice(0, at).trim();
  const version = trimmed.slice(at + 1).trim();
  if (!name) return null;
  return { name, version: version || null };
}

export function resolveAction(uses: string): ActionHandler | null {
  const parsed = parseUses(uses);
  if (!parsed) return null;

  // Explicit version first.
  if (parsed.version) {
    const key = `${parsed.name}@${parsed.version}`;
    return handlers.get(key) ?? null;
  }

  // No version: try the latest registered, fall back to v1.
  const latest = latestByName.get(parsed.name);
  if (latest) {
    const key = `${parsed.name}@${latest}`;
    const h = handlers.get(key);
    if (h) return h;
  }
  return handlers.get(`${parsed.name}@v1`) ?? null;
}

export function listActions(): { name: string; version: string }[] {
  return Array.from(handlers.values()).map((h) => ({
    name: h.name,
    version: h.version,
  }));
}

// -------------------------------------------------------------------------
// Built-in registration
// -------------------------------------------------------------------------

import { checkoutAction } from "./actions/checkout-action";
import { gatetestAction } from "./actions/gatetest-action";
import { cacheAction } from "./actions/cache-action";
import { uploadArtifactAction } from "./actions/upload-artifact-action";
import { downloadArtifactAction } from "./actions/download-artifact-action";

let registered = false;

/**
 * Register every built-in action. Idempotent: safe to call multiple times.
 * Called once at module load below, but exported for tests that want to
 * reset state explicitly.
 */
export function registerAll(): void {
  if (registered) return;
  registerAction(checkoutAction);
  registerAction(gatetestAction);
  registerAction(cacheAction);
  registerAction(uploadArtifactAction);
  registerAction(downloadArtifactAction);
  registered = true;
}

registerAll();
