-- Platform-level search parameters and provider metadata.
--
-- `search_config_json` holds the per-instance search parameters (targetResults,
-- maxPages, safeSearch, ...). They live in their own column instead of the
-- vendor `config_json` so a provider's vendor options and the platform's search
-- policy can be validated, migrated and locked independently.
--
-- `installed_at` records when the provider was added from the marketplace, so
-- the UI can tell "never configured" apart from "configured long ago".
ALTER TABLE provider_instances ADD COLUMN search_config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE provider_instances ADD COLUMN installed_at TEXT;
