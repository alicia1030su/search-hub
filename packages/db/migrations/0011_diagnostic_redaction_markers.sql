-- Mark diagnostics written after the v0.1.12 credential-redaction fix.
-- Existing rows keep their original bytes for audit but default to false, so
-- readers can withhold free-form text that may contain a rotated/deleted secret
-- which can no longer be recovered from the current key row.

ALTER TABLE "api_keys"
  ADD COLUMN "last_error_sanitized" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "provider_health_checks"
  ADD COLUMN "diagnostics_sanitized" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "search_tasks"
  ADD COLUMN "diagnostics_sanitized" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "search_events"
  ADD COLUMN "diagnostics_sanitized" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "provider_test_batches"
  ADD COLUMN "diagnostics_sanitized" integer NOT NULL DEFAULT 0;
