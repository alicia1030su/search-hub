-- Bulk provider test jobs (v0.1.10).
--
-- Two things, and deliberately only two:
--
--  1. `provider_health_checks.batch_id` — a nullable pointer from a health fact
--     to the run that produced it. Historical rows stay NULL; nothing is
--     backfilled, because a run id invented for an old row would be a fiction.
--
--  2. `provider_test_batches` — the run ledger. It answers one question:
--     "how far did this run get". It is **not** a second health table: the
--     per-source conclusion still lives in `provider_health_checks`, which
--     remains the single source of truth for source health.
--
-- `status` is intentionally a small closed vocabulary
-- (`running|completed|partial|cancelled|interrupted`). A `running` row left
-- behind by a crash is rewritten to `interrupted` at the next boot, so a
-- restart can never claim a run completed.

ALTER TABLE "provider_health_checks" ADD COLUMN "batch_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_health_batch" ON "provider_health_checks" ("batch_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_test_batches" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL DEFAULT 'search',
  "status" text NOT NULL DEFAULT 'running',
  "total" integer NOT NULL DEFAULT 0,
  "done" integer NOT NULL DEFAULT 0,
  "ok_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "pending_count" integer NOT NULL DEFAULT 0,
  "skipped_count" integer NOT NULL DEFAULT 0,
  "concurrency" integer NOT NULL DEFAULT 2,
  "options_json" text NOT NULL DEFAULT '{}',
  "items_json" text NOT NULL DEFAULT '[]',
  "budget_json" text NOT NULL DEFAULT '{}',
  "created_by" text,
  "created_at" text NOT NULL,
  "started_at" text,
  "finished_at" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_batches_status" ON "provider_test_batches" ("status", "created_at");
