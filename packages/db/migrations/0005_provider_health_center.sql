-- Provider health management centre (v0.1.7).
--
-- Two things live here, and neither duplicates the append-only probe log in
-- `provider_health_checks`:
--
--  1. `provider_probe_state` — the *scheduler's* bookkeeping for one provider:
--     whether automatic probing is on, how many consecutive failures it has,
--     how far the exponential backoff has gone, and when the next attempt is
--     due. Keeping it out of `provider_health_checks` means a schedule change
--     never rewrites history.
--
--  2. `health_probe_budget` — a durable ledger of probe spend, one row per UTC
--     day and probe kind. Counting rows in the probe log would be a
--     read-then-act race: two concurrent probes both see "19 used" and both
--     spend. The ledger is decremented by a conditional UPDATE, so the limit
--     holds under concurrency.
CREATE TABLE IF NOT EXISTS "provider_probe_state" (
  "provider_id" text PRIMARY KEY NOT NULL
    REFERENCES "provider_instances"("id") ON DELETE CASCADE,
  -- Per-provider switch. The global switch still gates everything: this can
  -- only turn a provider *off* within an enabled schedule.
  "auto_probe_enabled" integer NOT NULL DEFAULT 1,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "backoff_level" integer NOT NULL DEFAULT 0,
  "next_probe_at" text,
  -- Manual reset: probe rows older than this no longer determine the status,
  -- but they stay in the log for audit.
  "reset_at" text,
  "updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_probe_state_next"
  ON "provider_probe_state" ("next_probe_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "health_probe_budget" (
  -- UTC date, YYYY-MM-DD. The boundary is documented in docs/provider-health.md.
  "day" text NOT NULL,
  "kind" text NOT NULL,
  "used" integer NOT NULL DEFAULT 0,
  "updated_at" text NOT NULL,
  PRIMARY KEY ("day", "kind")
);
