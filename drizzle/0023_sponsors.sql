-- Gluecron migration 0023: Sponsors (Block I6).
--
-- Lightweight sponsorship model:
--   sponsorship_tiers   — the maintainer's published tiers (amount, description, benefit)
--   sponsorships        — ongoing or one-time support relationships
--
-- Payment rails are out of scope — we store the intent + any external
-- provider/transaction reference. The UI surfaces a "Sponsor" button on user
-- profiles that have at least one active tier.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sponsorship_tiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "maintainer_id" uuid NOT NULL,
  "name" text NOT NULL,                       -- "Coffee", "Champion", "Patron"
  "description" text NOT NULL DEFAULT '',
  "monthly_cents" integer NOT NULL,           -- 500 = $5/mo; 0 = one-time-only
  "one_time_allowed" boolean NOT NULL DEFAULT true,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "sponsor_tiers_maintainer_fk" FOREIGN KEY ("maintainer_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsor_tiers_maintainer" ON "sponsorship_tiers" ("maintainer_id", "is_active");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sponsorships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sponsor_id" uuid NOT NULL,                 -- the user paying
  "maintainer_id" uuid NOT NULL,              -- the user receiving
  "tier_id" uuid,                             -- optional (custom amounts allowed)
  "amount_cents" integer NOT NULL,
  "kind" text NOT NULL,                       -- one_time | monthly
  "note" text,                                -- public or private thank-you note
  "is_public" boolean NOT NULL DEFAULT true,
  "external_ref" text,                        -- stripe/provider txn id
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "sponsorships_sponsor_fk" FOREIGN KEY ("sponsor_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "sponsorships_maintainer_fk" FOREIGN KEY ("maintainer_id") REFERENCES "users"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsorships_maintainer" ON "sponsorships" ("maintainer_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sponsorships_sponsor" ON "sponsorships" ("sponsor_id", "created_at");
