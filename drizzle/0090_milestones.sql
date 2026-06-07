-- Migration 0077: Add milestone_id to issues table
-- The milestones table and pull_requests.milestone_id already exist (migration 0001).
-- This migration adds milestone_id to the issues table.

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "milestone_id" uuid REFERENCES "milestones"("id") ON DELETE SET NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_milestone" ON "issues" ("milestone_id");
