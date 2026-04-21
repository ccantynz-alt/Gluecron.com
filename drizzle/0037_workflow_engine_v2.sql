-- Workflow engine v2 — Sprint 1 storage additions.
--
-- Strictly additive to Block C1 (drizzle/0008_workflows.sql is LOCKED).
-- The four tables below back new capabilities:
--
--   workflow_secrets          encrypted per-repo secrets (AES-256-GCM, base64
--                             payload = iv || authTag || ciphertext). The
--                             crypto lib lives in src/lib/workflow-crypto.ts;
--                             the DB only stores opaque bytes.
--   workflow_dispatch_inputs  parameter schema for the `workflow_dispatch`
--                             trigger — one row per input on a workflow.
--   workflow_run_cache        content-addressable cache, keyed by user-chosen
--                             cache_key within a scope (repo / branch / tag).
--                             Backs the `gluecron/cache@v1` action.
--   workflow_runner_pool      warm-runner worker registry used by the job
--                             scheduler to avoid cold-start per run.
--
-- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` throughout so
-- reruns are idempotent. Size/format validation (secret name regex, 100MB
-- cache cap) is enforced at the write-site, not in the DB.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "encrypted_value" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_secrets_repo_name_uq"
  ON "workflow_secrets" ("repository_id", "name");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_secrets_repo_idx"
  ON "workflow_secrets" ("repository_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_dispatch_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "type" text NOT NULL CHECK (type IN ('string', 'boolean', 'choice', 'number')),
  "required" boolean NOT NULL DEFAULT false,
  "default_value" text,
  "options" jsonb,
  "description" text
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_dispatch_inputs_wf_name_uq"
  ON "workflow_dispatch_inputs" ("workflow_id", "name");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_run_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "cache_key" text NOT NULL,
  "scope" text NOT NULL DEFAULT 'repo',
  "scope_ref" text,
  "content_hash" text NOT NULL,
  "content" bytea NOT NULL,
  "size_bytes" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_accessed_at" timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_run_cache_repo_key_scope_uq"
  ON "workflow_run_cache" ("repository_id", "cache_key", "scope", "scope_ref");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_cache_repo_lru_idx"
  ON "workflow_run_cache" ("repository_id", "last_accessed_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runner_pool" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "worker_id" text NOT NULL UNIQUE,
  "status" text NOT NULL CHECK (status IN ('idle', 'busy', 'draining', 'dead')),
  "current_run_id" uuid REFERENCES "workflow_runs"("id") ON DELETE SET NULL,
  "warmed_at" timestamptz NOT NULL DEFAULT now(),
  "last_heartbeat_at" timestamptz NOT NULL DEFAULT now(),
  "capacity" integer NOT NULL DEFAULT 1
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runner_pool_status_idx"
  ON "workflow_runner_pool" ("status");
