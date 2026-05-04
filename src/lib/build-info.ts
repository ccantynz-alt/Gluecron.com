/**
 * Build info — captured once at boot, exposed everywhere.
 *
 * Reads git HEAD + boot time on first access so the running process can
 * tell anyone (the /api/version endpoint, the footer SHA stamp, the
 * client-side update poller) exactly which commit it's serving.
 *
 * Falls back gracefully when the .git directory isn't available
 * (e.g. running from a Docker image that didn't include it).
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export interface BuildInfo {
  sha: string;       // 7-char short sha
  shaFull: string;   // 40-char full sha
  branch: string;
  builtAt: string;   // ISO of process boot
  uptimeMs: number;  // computed at access time
}

const STARTED_AT = Date.now();

let _cached: Omit<BuildInfo, "uptimeMs"> | null = null;

function read(): Omit<BuildInfo, "uptimeMs"> {
  if (_cached) return _cached;

  // Honour explicit env overrides first (set by the deploy script in
  // immutable container images that strip the .git directory).
  const envSha = process.env.GIT_SHA?.trim();
  const envBranch = process.env.GIT_BRANCH?.trim();
  if (envSha) {
    _cached = {
      sha: envSha.slice(0, 7),
      shaFull: envSha,
      branch: envBranch || "main",
      builtAt: new Date(STARTED_AT).toISOString(),
    };
    return _cached;
  }

  // Otherwise read from local .git
  const cwd = process.cwd();
  const hasGit = existsSync(join(cwd, ".git"));
  if (!hasGit) {
    _cached = {
      sha: "unknown",
      shaFull: "unknown",
      branch: "unknown",
      builtAt: new Date(STARTED_AT).toISOString(),
    };
    return _cached;
  }

  try {
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
    const shaFull = (sha.stdout || "").trim();
    _cached = {
      sha: shaFull.slice(0, 7) || "unknown",
      shaFull: shaFull || "unknown",
      branch: (branch.stdout || "").trim() || "main",
      builtAt: new Date(STARTED_AT).toISOString(),
    };
  } catch {
    _cached = {
      sha: "unknown",
      shaFull: "unknown",
      branch: "unknown",
      builtAt: new Date(STARTED_AT).toISOString(),
    };
  }
  return _cached;
}

export function getBuildInfo(): BuildInfo {
  const base = read();
  return {
    ...base,
    uptimeMs: Date.now() - STARTED_AT,
  };
}
