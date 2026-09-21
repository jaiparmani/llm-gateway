-- Run once against an already-deployed database — `schema.sql`'s
-- CREATE TABLE IF NOT EXISTS does not retrofit existing tables.
--
--   wrangler d1 execute llm-gateway --remote --file=migrations/0001_add_provider.sql
--
-- Every row that already exists was an OpenRouter key (the only provider the
-- gateway supported before this migration), so the default backfills them
-- correctly with no further UPDATE needed.

ALTER TABLE api_keys ADD COLUMN provider TEXT NOT NULL DEFAULT 'openrouter';
CREATE INDEX IF NOT EXISTS api_keys_provider ON api_keys (provider);
