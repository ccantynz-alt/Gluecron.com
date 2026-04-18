-- Block J4 — User following / follow-feed.
--
-- Directed graph of user -> user. Used to filter activity_feed into a
-- personalised "what's happening in my network" view.

CREATE TABLE IF NOT EXISTS "user_follows" (
  "follower_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "following_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("follower_id", "following_id"),
  CONSTRAINT "user_follows_no_self" CHECK ("follower_id" <> "following_id")
);

CREATE INDEX IF NOT EXISTS "user_follows_following_idx"
  ON "user_follows" ("following_id");
