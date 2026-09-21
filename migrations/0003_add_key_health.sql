-- Run once against an already-deployed database:
--
--   wrangler d1 execute llm-gateway --remote --file=migrations/0003_add_key_health.sql
--
-- Three new columns, so like 0001 this needs ALTER — every existing row starts
-- at zero consecutive failures and unbenched, which is the correct backfill:
-- nothing about a key's history before this migration should count toward the
-- threshold that benches it now.

ALTER TABLE api_keys ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN benched_at TEXT;
ALTER TABLE api_keys ADD COLUMN last_failure_reason TEXT;
