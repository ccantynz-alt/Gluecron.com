-- Repair Flywheel
--
-- Every auto-repair attempt — mechanical, AI-driven, or cache-hit — gets
-- recorded here with its failure signature, the patch produced, and the
-- eventual outcome. Future failures with the same signature can short-
-- circuit straight to the cached patch (Tier 0), saving AI cost + latency.
--
-- After ~5000 entries the flywheel dominates: most CI failures hit a
-- cached pattern and get fixed in seconds.

CREATE TABLE IF NOT EXISTS "repair_flywheel" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "repository_id" UUID REFERENCES "repositories"("id") ON DELETE CASCADE,

  -- Fingerprint: SHA-256 of the normalised failure text (variables/paths
  -- stripped). Two failures with the same signature are considered the
  -- same problem.
  "failure_signature" TEXT NOT NULL,

  -- Original failure text (capped to 4KB) — for human review at /admin/repair-flywheel.
  "failure_text" TEXT NOT NULL,

  -- Mechanical classification, if any: 'lockfile' | 'formatting' | 'imports'
  -- | NULL (then it was AI-driven or human-driven).
  "failure_classification" TEXT,

  -- Which tier produced the fix.
  "repair_tier" TEXT NOT NULL,

  -- Plain-English summary (always populated, max 400 chars).
  "patch_summary" TEXT NOT NULL,

  -- File paths the repair touched.
  "files_changed" JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Resulting commit SHA (NULL until the repair commits).
  "commit_sha" TEXT,

  -- Outcome: 'pending' (just applied), 'success' (smoke passed),
  -- 'failed' (smoke failed), 'reverted' (later reverted by a human).
  "outcome" TEXT NOT NULL DEFAULT 'pending',
  "applied_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
  "outcome_at" TIMESTAMPTZ,

  -- Cache lineage: if this entry was applied from another flywheel pattern
  -- (Tier 0 hit), parent_pattern_id points at the original. Lets us count
  -- "this pattern was reused N times" for confidence weighting.
  "parent_pattern_id" UUID REFERENCES "repair_flywheel"("id") ON DELETE SET NULL,
  "cache_hit_count" INTEGER NOT NULL DEFAULT 0,

  -- Privacy gate: only patterns marked public participate in cross-repo
  -- learning. Default off; site admins can flip per-pattern, or owners can
  -- bulk-opt-in via repo settings.
  "is_public_pattern" BOOLEAN NOT NULL DEFAULT false,

  "created_at" TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "repair_flywheel_signature_idx" ON "repair_flywheel"("failure_signature");
CREATE INDEX IF NOT EXISTS "repair_flywheel_repo_idx" ON "repair_flywheel"("repository_id");
CREATE INDEX IF NOT EXISTS "repair_flywheel_outcome_idx" ON "repair_flywheel"("outcome");
CREATE INDEX IF NOT EXISTS "repair_flywheel_classification_idx" ON "repair_flywheel"("failure_classification");
-- Composite for the cache lookup hot path: "find a successful repair for this
-- repo + this exact failure signature."
CREATE INDEX IF NOT EXISTS "repair_flywheel_lookup_idx"
  ON "repair_flywheel"("repository_id", "failure_signature", "outcome");
