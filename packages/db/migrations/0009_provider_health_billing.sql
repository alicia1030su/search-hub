-- Provider health billing classification (v0.1.11).
--
-- `provider_health_checks.kind` distinguishes connectivity from search, but it
-- cannot distinguish a credentialed search from a keyless one. Keep that billing
-- fact in a side table so re-typing a provider or deleting a key never rewrites
-- history. Legacy searches are charged conservatively to the paid bucket.

-- Preserve every pre-migration ledger row before the one-shot recompute. The
-- marker guard keeps repeated executions from archiving reservations made later.
CREATE TABLE IF NOT EXISTS "health_probe_budget_legacy" (
  "day" text NOT NULL,
  "kind" text NOT NULL,
  "used" integer NOT NULL,
  "updated_at" text NOT NULL,
  PRIMARY KEY ("day", "kind")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_health_billing_migration" (
  "id" integer PRIMARY KEY NOT NULL CHECK ("id" = 1),
  "applied_at" text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO "health_probe_budget_legacy" ("day", "kind", "used", "updated_at")
SELECT "day", "kind", "used", "updated_at"
FROM "health_probe_budget"
WHERE NOT EXISTS (SELECT 1 FROM "provider_health_billing_migration" WHERE "id" = 1);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_health_billing" (
  "health_check_id" text PRIMARY KEY NOT NULL
    REFERENCES "provider_health_checks"("id") ON DELETE CASCADE,
  "budget_kind" text NOT NULL
    CHECK ("budget_kind" IN ('connect', 'search', 'search_anonymous')),
  "budget_day" text NOT NULL,
  "classification" text NOT NULL
    CHECK ("classification" IN ('exact', 'legacy_conservative')),
  "provider_type_snapshot" text,
  "credential_used" integer NOT NULL DEFAULT 0
    CHECK ("credential_used" IN (0, 1)),
  "spent" integer NOT NULL DEFAULT 0
    CHECK ("spent" IN (0, 1)),
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_health_billing_budget"
  ON "provider_health_billing" ("budget_kind", "classification", "health_check_id");
--> statement-breakpoint
INSERT INTO "provider_health_billing" (
  "health_check_id",
  "budget_kind",
  "budget_day",
  "classification",
  "provider_type_snapshot",
  "credential_used",
  "spent",
  "created_at"
)
SELECT
  "id",
  CASE "kind" WHEN 'connect' THEN 'connect' ELSE 'search' END,
  substr("checked_at", 1, 10),
  CASE "kind" WHEN 'connect' THEN 'exact' ELSE 'legacy_conservative' END,
  NULL,
  0,
  1,
  "checked_at"
FROM "provider_health_checks"
WHERE "kind" IN ('connect', 'search')
ON CONFLICT ("health_check_id") DO NOTHING;
--> statement-breakpoint
-- One-shot recompute. Paid and connectivity counters never decrease; the old
-- anonymous bucket was polluted by the v0.1.10 seed bug, so only exact anonymous
-- classifications survive there. Its original value remains in the archive.
WITH "classified" AS (
  SELECT
    "billing"."budget_day" AS "day",
    "billing"."budget_kind" AS "budget_kind",
    "billing"."classification" AS "classification",
    count(*) AS "used"
  FROM "provider_health_billing" AS "billing"
  WHERE "billing"."spent" = 1
  GROUP BY "day", "budget_kind", "classification"
)
UPDATE "health_probe_budget"
SET
  "used" = CASE "kind"
    WHEN 'search' THEN max("used", coalesce((
      SELECT sum("classified"."used")
      FROM "classified"
      WHERE "classified"."day" = "health_probe_budget"."day"
        AND "classified"."budget_kind" = 'search'
    ), 0))
    WHEN 'connect' THEN max("used", coalesce((
      SELECT sum("classified"."used")
      FROM "classified"
      WHERE "classified"."day" = "health_probe_budget"."day"
        AND "classified"."budget_kind" = 'connect'
    ), 0))
    WHEN 'search_anonymous' THEN coalesce((
      SELECT sum("classified"."used")
      FROM "classified"
      WHERE "classified"."day" = "health_probe_budget"."day"
        AND "classified"."budget_kind" = 'search_anonymous'
        AND "classified"."classification" = 'exact'
    ), 0)
    ELSE "used"
  END,
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "kind" IN ('search', 'connect', 'search_anonymous')
  AND NOT EXISTS (SELECT 1 FROM "provider_health_billing_migration" WHERE "id" = 1);
--> statement-breakpoint
INSERT INTO "provider_health_billing_migration" ("id", "applied_at")
SELECT 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM "provider_health_billing_migration" WHERE "id" = 1)
ON CONFLICT ("id") DO NOTHING;
