-- Search quality evaluation lab (v0.1.8).
--
-- Five tables, deliberately separated by lifetime:
--
--  1. `quality_datasets` / `quality_queries` / `quality_judgments` are the
--     *input*: a versioned qrel set. Freezing a dataset bumps its version and
--     makes it read-only, so a score produced yesterday stays interpretable.
--
--  2. `quality_runs` is one experiment's context: dataset version, code commit,
--     engine version, fusion parameters and the budget it was allowed to spend.
--
--  3. `quality_snapshots` is the *raw per-provider result list* of one run. It
--     is what makes a comparison fair: two fusion strategies are re-ranked from
--     the same snapshot instead of from two different network moments.
--
--  4. `quality_run_results` is the per-query ranked list plus its metrics, so a
--     regression can be traced to a specific query and document rather than to
--     an average.
--
-- No table stores a credential, and no table references `search_tasks`: an
-- evaluation is not a user search, and must not appear in success-rate
-- statistics or be readable from another token's task list.

CREATE TABLE IF NOT EXISTS "quality_datasets" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "language" text NOT NULL DEFAULT 'zh',
  -- Monotonic; bumped by freeze. A run records the version it used.
  "version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'draft',
  -- manual | imported | synthetic_fixture. Decides what a score may be called.
  "origin" text NOT NULL DEFAULT 'manual',
  -- 1 only when the qrels are exhaustive for this query set: recall is N/A
  -- otherwise, never computed from a partial ground truth.
  "judgments_complete" integer NOT NULL DEFAULT 0,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "frozen_at" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quality_datasets_status"
  ON "quality_datasets" ("status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quality_queries" (
  "id" text PRIMARY KEY NOT NULL,
  "dataset_id" text NOT NULL
    REFERENCES "quality_datasets"("id") ON DELETE CASCADE,
  "query" text NOT NULL,
  "category" text NOT NULL DEFAULT 'general',
  "language" text NOT NULL DEFAULT 'zh',
  "intent" text NOT NULL DEFAULT '',
  "notes" text NOT NULL DEFAULT '',
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quality_queries_dataset"
  ON "quality_queries" ("dataset_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quality_judgments" (
  "id" text PRIMARY KEY NOT NULL,
  "dataset_id" text NOT NULL
    REFERENCES "quality_datasets"("id") ON DELETE CASCADE,
  "query_id" text NOT NULL
    REFERENCES "quality_queries"("id") ON DELETE CASCADE,
  -- Normalized document identity (normalizeUrl). Never a list position: a
  -- position changes between runs, the document does not.
  "document_id" text NOT NULL,
  -- 0 off-topic, 1 mentions the topic, 2 answers part, 3 answers the intent.
  "relevance" integer NOT NULL,
  "assessor" text NOT NULL,
  -- human | machine_generated | synthetic_fixture. Only `human` is truth.
  "source" text NOT NULL,
  "notes" text NOT NULL DEFAULT '',
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
-- One grade per document per query. A second judgment replaces the first, which
-- keeps a re-assessment from silently doubling the qrel set.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_quality_judgments_document"
  ON "quality_judgments" ("query_id", "document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quality_judgments_dataset"
  ON "quality_judgments" ("dataset_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quality_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "dataset_id" text NOT NULL,
  -- Copied at start: editing the dataset later must not reinterpret this run.
  "dataset_version" integer NOT NULL,
  "dataset_origin" text NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "notes" text NOT NULL DEFAULT '',
  -- offline | live. Offline never leaves the process.
  "mode" text NOT NULL,
  "fusion_strategy" text NOT NULL,
  "fusion_json" text NOT NULL,
  "limit_value" integer NOT NULL,
  -- Metric cutoff. Recorded because @10 and @20 are different questions: a
  -- comparison that re-derives the cutoff from a default would silently compare
  -- two numbers measured at different depths.
  "cutoff_value" integer NOT NULL DEFAULT 10,
  -- When set, this run re-ranks the *existing* snapshots of another run, which
  -- is how two fusion strategies are compared over identical raw results.
  "snapshot_run_id" text,
  "code_commit" text,
  "engine_version" text NOT NULL,
  "status" text NOT NULL,
  -- Hard ceiling on upstream requests, and what was actually spent.
  "request_budget" integer NOT NULL DEFAULT 0,
  "requests_used" integer NOT NULL DEFAULT 0,
  "cache_hits" integer NOT NULL DEFAULT 0,
  "query_count" integer NOT NULL DEFAULT 0,
  "error_json" text,
  "metrics_json" text,
  "actor" text,
  "started_at" text NOT NULL,
  "finished_at" text,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quality_runs_dataset"
  ON "quality_runs" ("dataset_id", "started_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quality_snapshots" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "run_id" text NOT NULL
    REFERENCES "quality_runs"("id") ON DELETE CASCADE,
  "query_id" text NOT NULL,
  -- ProviderSnapshot[]: the ordered per-provider lists as captured.
  "snapshot_json" text NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_quality_snapshots_query"
  ON "quality_snapshots" ("run_id", "query_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quality_run_results" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "run_id" text NOT NULL
    REFERENCES "quality_runs"("id") ON DELETE CASCADE,
  "query_id" text NOT NULL,
  "status" text NOT NULL,
  -- Ordered document ids: the thing a regression is actually about.
  "ranked_json" text NOT NULL,
  "metrics_json" text NOT NULL,
  "latency_ms" real,
  "upstream_requests" integer NOT NULL DEFAULT 0,
  "error_json" text,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quality_run_results_run"
  ON "quality_run_results" ("run_id");
