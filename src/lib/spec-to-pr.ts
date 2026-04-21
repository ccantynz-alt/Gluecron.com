/**
 * Spec-to-PR (experimental).
 *
 * Entry point for the "describe a change in English, get a PR" feature. The
 * full pipeline — read the repo tree, call Claude to produce a patch, run it
 * through git plumbing, open a PR — is a follow-up patch. This file ships the
 * backend stub: it validates prerequisites (API key, repo existence) and
 * returns a structured `{ok:false}` result with a human-readable error that
 * the UI route surfaces directly.
 *
 * Keeping the stub real (not a throw) lets the UI wire up end-to-end today
 * and lets us light up the AI path without touching callers.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, pullRequests } from "../db/schema";

export type SpecPRResult = {
  ok: boolean;
  prNumber?: number;
  branchName?: string;
  filesChanged?: string[];
  error?: string;
};

export type SpecPRArgs = {
  repoId: number;
  spec: string;
  baseRef?: string;
  userId: number;
};

export async function createSpecPR(args: SpecPRArgs): Promise<SpecPRResult> {
  // 1. Require ANTHROPIC_API_KEY — without it the AI step can't run, so we
  //    fail fast rather than doing a pointless DB round-trip.
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY required for spec-to-PR" };
  }

  // 2. Look up repo. If the repo doesn't exist we surface that specifically
  //    so the UI can distinguish "bad id" from "AI not configured".
  try {
    const rows = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, args.repoId as unknown as string))
      .limit(1);
    if (rows.length === 0) return { ok: false, error: "repo not found" };
  } catch (err) {
    return { ok: false, error: "db lookup failed" };
  }

  // Touch the remaining imports so they aren't flagged as unused and so that
  // the eventual implementation (user lookup for PR author, pullRequests
  // insert) doesn't need an import change in the follow-up patch.
  void users;
  void pullRequests;

  // 3. v1 stub — feature is experimental. For now, just return a clear
  //    message. Full implementation (read tree, call Claude, git plumbing,
  //    PR insert) is a follow-up. The UI route handles {ok:false} gracefully.
  return {
    ok: false,
    error:
      "spec-to-PR is experimental and not yet fully implemented. Backend stub only — full AI integration arriving in a follow-up patch.",
  };
}
