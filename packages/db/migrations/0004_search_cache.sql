-- Persistent search cache (v0.1.7).
--
-- Replaces the in-memory Map that vanished on every restart. The cache lives in
-- the same SQLite database as everything else, so a Docker volume, a systemd
-- restart or a Windows reboot all keep it — and so the existing backup and
-- upgrade paths cover it without extra work.
--
-- `cache_key` is a SHA-256 of the request fingerprint, never the query text: a
-- raw query as a primary key turns the table into a readable search history and
-- makes long queries expensive to index.
CREATE TABLE IF NOT EXISTS "search_cache" (
  "cache_key" text PRIMARY KEY NOT NULL,
  "response_json" text NOT NULL,
  "status" text NOT NULL,
  "mode" text NOT NULL,
  "created_at" text NOT NULL,
  "expires_at" text NOT NULL,
  "last_accessed_at" text NOT NULL,
  -- UTF-8 byte length of `response_json`, not the JS string length.
  "size_bytes" integer NOT NULL,
  "hit_count" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_search_cache_expires"
  ON "search_cache" ("expires_at");
--> statement-breakpoint
-- LRU eviction sorts by this column, so it must be indexed.
CREATE INDEX IF NOT EXISTS "idx_search_cache_accessed"
  ON "search_cache" ("last_accessed_at");
--> statement-breakpoint

-- Hourly counters. Bounded by construction (one row per hour), so the 24-hour
-- hit rate stays a cheap query and a quiet instance can say "no data yet"
-- instead of inventing a percentage from one request.
CREATE TABLE IF NOT EXISTS "search_cache_metrics" (
  "bucket" text PRIMARY KEY NOT NULL,
  "hits" integer NOT NULL DEFAULT 0,
  "misses" integer NOT NULL DEFAULT 0,
  "expired_removed" integer NOT NULL DEFAULT 0,
  "evicted" integer NOT NULL DEFAULT 0,
  "updated_at" text NOT NULL
);
--> statement-breakpoint

-- Bookkeeping that must survive a restart: last sweep time, lifetime totals.
CREATE TABLE IF NOT EXISTS "search_cache_state" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "updated_at" text NOT NULL
);
