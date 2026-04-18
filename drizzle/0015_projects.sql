-- Gluecron migration 0015: Block E1 — Projects / kanban boards.
--
-- Tables:
--   projects          — top-level board scoped to a repo (or org later)
--   project_columns   — ordered columns (To Do / Doing / Done, etc)
--   project_items     — cards on the board. Can be a freeform note OR linked
--                       to an existing issue / pull_request (polymorphic fk).
--
-- Schema follows a lightweight GitHub Projects v2 model but scoped to a repo
-- for v1 (cross-repo + org boards can be added by nulling repository_id later).

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "number" serial NOT NULL,
  "repository_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "state" text NOT NULL DEFAULT 'open',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "projects_repo_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "projects_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id")
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_repo" ON "projects" ("repository_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_repo_number" ON "projects" ("repository_id", "number");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_columns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "project_columns_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_columns_project" ON "project_columns" ("project_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "column_id" uuid NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  -- Card content. A card is EITHER a free-form note (note + title set) OR
  -- a linked issue / pull_request (item_type + item_id set).
  "item_type" text NOT NULL DEFAULT 'note',   -- note | issue | pr
  "item_id" uuid,                              -- FK handled per-type at app level
  "title" text NOT NULL DEFAULT '',
  "note" text NOT NULL DEFAULT '',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "project_items_project_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
  CONSTRAINT "project_items_column_fk" FOREIGN KEY ("column_id") REFERENCES "project_columns"("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_items_project" ON "project_items" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_items_column" ON "project_items" ("column_id", "position");
