-- Migration 0078: Login attempt tracking for account lockout (SOC 2 CC6.1).
-- Records failed login attempts per email+IP. After 10 failures in 1 hour,
-- auth.login.locked is emitted and logins from that email are blocked for 15 min.

CREATE TABLE IF NOT EXISTS login_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  ip          text NOT NULL,
  success     boolean NOT NULL DEFAULT false,
  created_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_email_created
  ON login_attempts (email, created_at);

CREATE INDEX IF NOT EXISTS login_attempts_ip_created
  ON login_attempts (ip, created_at);
