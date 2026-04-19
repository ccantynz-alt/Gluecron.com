-- Add admin flag to users table.
-- First registered user becomes admin automatically (handled in app code).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE NOT NULL;
