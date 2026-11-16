-- Provider health checks (v0.1.5).
--
-- Health is derived data, never configuration: keeping it out of
-- `provider_instances` means a failing probe can never be mistaken for
-- "the administrator disabled this provider".
CREATE TABLE IF NOT EXISTS "provider_health_checks" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_id" text NOT NULL REFERENCES "provider_instances"("id") ON DELETE CASCADE,
  "key_id" text,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "error_code" text,
  "latency_ms" integer,
  "result_count" integer,
  "health_score" integer NOT NULL DEFAULT 0,
  "detail_json" text NOT NULL DEFAULT '{}',
  "trigger" text NOT NULL,
  "checked_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_health_provider_time"
  ON "provider_health_checks" ("provider_id", "checked_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_health_checked_at"
  ON "provider_health_checks" ("checked_at" DESC);
