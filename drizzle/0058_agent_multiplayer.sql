-- Agent multiplayer v1 — per-agent namespacing + leases + budget caps.
--
-- Premise: when 10-100 AI agents push to the same repo, they must not step
-- on each other. Each agent gets a stable `agent_sessions` row with a
-- token, a branch-namespace prefix the git plumbing must enforce, and a
-- daily budget. Coordination on shared resources (issues, PRs, file
-- paths, branches) flows through `agent_leases` — a soft mutex with a
-- TTL. The autopilot resets `spent_cents_today` at midnight UTC and
-- expires stale leases.

CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-facing handle: "claude-1", "holden-mercer", "release-bot". Not
  -- globally unique — uniqueness is enforced per owner_user_id via the
  -- partial index below so multiple humans can each have a "claude-1".
  name text NOT NULL,
  -- The human who manages this agent and pays for its actions.
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Optional repo scope. NULL means the agent is global to the owner.
  repository_id uuid REFERENCES repositories(id) ON DELETE CASCADE,
  -- SHA-256 of the plaintext "agt_..." token. Never store plaintext.
  token_hash text NOT NULL UNIQUE,
  -- Branch prefix the git plumbing must enforce on every ref update,
  -- e.g. "agents/claude-1/". Should end with "/" so simple startsWith
  -- checks are unambiguous, but the helper normalises it.
  branch_namespace text NOT NULL,
  -- Daily spend cap in cents. Default $5.00 — enough for routine PR
  -- work, low enough that a runaway agent gets caught fast.
  budget_cents_per_day integer NOT NULL DEFAULT 500,
  spent_cents_today integer NOT NULL DEFAULT 0,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An owner can't have two agents with the same name.
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_owner_name
  ON agent_sessions (owner_user_id, name);

CREATE INDEX IF NOT EXISTS agent_sessions_owner
  ON agent_sessions (owner_user_id);

CREATE INDEX IF NOT EXISTS agent_sessions_repo
  ON agent_sessions (repository_id)
  WHERE repository_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  -- What kind of thing the lease covers — keeps the (type, id) space
  -- naturally partitioned. Vocabulary is open-ended; the lib enforces
  -- the known set.
  target_type text NOT NULL,  -- 'issue' | 'pr' | 'file_path' | 'branch'
  target_id text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',  -- 'active' | 'released' | 'expired'
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-target lookup — answers "who holds the lease on issue 42?" in O(1).
-- Partial unique on the active row prevents two agents holding the same
-- target simultaneously. Released/expired rows don't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS agent_leases_active_target
  ON agent_leases (target_type, target_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS agent_leases_agent
  ON agent_leases (agent_session_id, status);

CREATE INDEX IF NOT EXISTS agent_leases_expires
  ON agent_leases (expires_at)
  WHERE status = 'active';
