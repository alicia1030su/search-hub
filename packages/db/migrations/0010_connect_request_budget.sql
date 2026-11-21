-- Connectivity probe budget counts physical HTTP hops (v0.1.12).
--
-- v0.1.11 counted one logical connect probe per reservation. A probe can issue
-- several physical requests through pagination or redirects, so preserve the
-- old rows and recompute a conservative hop count from the recorded detail.
-- Missing/zero request counts are treated as one hop; counters never decrease.

CREATE TABLE IF NOT EXISTS "health_probe_budget_connect_legacy" (
  "day" text NOT NULL,
  "kind" text NOT NULL,
  "used" integer NOT NULL,
  "updated_at" text NOT NULL,
  PRIMARY KEY ("day", "kind")
);
--> statement-breakpoint
INSERT OR IGNORE INTO "health_probe_budget_connect_legacy" ("day", "kind", "used", "updated_at")
SELECT "day", "kind", "used", "updated_at"
FROM "health_probe_budget"
WHERE "kind" = 'connect';
--> statement-breakpoint
WITH "recomputed" AS (
  SELECT
    "billing"."budget_day" AS "day",
    sum(
      CASE
        WHEN json_valid("check"."detail_json") THEN
          max(1, coalesce(cast(json_extract("check"."detail_json", '$.requests') as integer), 1))
        ELSE 1
      END
    ) AS "used"
  FROM "provider_health_billing" AS "billing"
  JOIN "provider_health_checks" AS "check" ON "check"."id" = "billing"."health_check_id"
  WHERE ("billing"."budget_kind" = 'connect' OR "check"."kind" = 'connect')
    AND "billing"."spent" = 1
  GROUP BY "billing"."budget_day"
)
UPDATE "health_probe_budget"
SET
  "used" = max("used", coalesce((
    SELECT "recomputed"."used"
    FROM "recomputed"
    WHERE "recomputed"."day" = "health_probe_budget"."day"
  ), 0)),
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE "kind" = 'connect';
--> statement-breakpoint
WITH "recomputed" AS (
  SELECT
    "billing"."budget_day" AS "day",
    sum(
      CASE
        WHEN json_valid("check"."detail_json") THEN
          max(1, coalesce(cast(json_extract("check"."detail_json", '$.requests') as integer), 1))
        ELSE 1
      END
    ) AS "used"
  FROM "provider_health_billing" AS "billing"
  JOIN "provider_health_checks" AS "check" ON "check"."id" = "billing"."health_check_id"
  WHERE ("billing"."budget_kind" = 'connect' OR "check"."kind" = 'connect')
    AND "billing"."spent" = 1
  GROUP BY "billing"."budget_day"
)
INSERT INTO "health_probe_budget" ("day", "kind", "used", "updated_at")
SELECT "day", 'connect', "used", strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM "recomputed"
WHERE true
ON CONFLICT ("day", "kind") DO UPDATE SET
  "used" = max("health_probe_budget"."used", "excluded"."used"),
  "updated_at" = CASE
    WHEN "excluded"."used" > "health_probe_budget"."used" THEN "excluded"."updated_at"
    ELSE "health_probe_budget"."updated_at"
  END;
