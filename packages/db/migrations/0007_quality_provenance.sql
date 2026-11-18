-- Quality lab provenance and query categories (v0.1.10).
--
-- Additive only: every statement is an ALTER TABLE ADD COLUMN with a default
-- where a value is required. A database written by v0.1.9 keeps every row it
-- already had, and the new columns read as "not recorded" rather than as an
-- invented value:
--
--   * `provider_ids_json` / `provider_fingerprint` / `model_fingerprint` /
--     `qrels_fingerprint` stay NULL on old runs. Filling them from the *current*
--     configuration would describe a run that never happened.
--   * `per_provider_limit` / `request_timeout_ms` stay NULL: v0.1.9 used an
--     implicit limit and the engine default, and neither is recoverable.
--   * `failure_reason` distinguishes a run that failed at persistence from one
--     that failed upstream. Old failures keep NULL and are reported as unknown.
--   * `persisted_query_count` / `partial` default to 0: an old run stored
--     complete results by construction.
--
-- `extra_categories` is a JSON array of the secondary category labels. The
-- primary label stays in `category`, so an old client that never sends extra
-- labels is still valid and reads back as a single-category query.

ALTER TABLE "quality_queries"
  ADD COLUMN "extra_categories" text NOT NULL DEFAULT '[]';
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "provider_ids_json" text;
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "provider_fingerprint" text;
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "model_fingerprint" text;
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "qrels_fingerprint" text;
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "per_provider_limit" integer;
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "request_timeout_ms" integer;
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "failure_reason" text;
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "persisted_query_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "quality_runs"
  ADD COLUMN "partial" integer NOT NULL DEFAULT 0;

-- The unjudged listing asks "which rows mention this query", which is a lookup
-- by `query_id` alone. Without this index every such request scans the whole
-- results table, and that table grows with every evaluation ever run.
CREATE INDEX IF NOT EXISTS "idx_quality_run_results_query"
  ON "quality_run_results" ("query_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_quality_snapshots_query_only"
  ON "quality_snapshots" ("query_id");
