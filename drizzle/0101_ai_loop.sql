-- Migration 0101: Add ai_loop columns to pull_requests table
-- Tracks the autonomous issue-to-merged-PR loop state per PR.

ALTER TABLE pull_requests ADD COLUMN IF NOT EXISTS ai_loop_attempts int NOT NULL DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN IF NOT EXISTS ai_loop_status text; -- null | 'running' | 'merged' | 'failed'
