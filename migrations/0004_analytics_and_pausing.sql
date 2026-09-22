-- Run once against an already-deployed database:
--
--   wrangler d1 execute llm-gateway --remote --file=migrations/0004_analytics_and_pausing.sql
--
-- Five new columns plus a new table, so like 0001/0003 this needs ALTER for
-- the columns and CREATE TABLE IF NOT EXISTS for paused_providers — both safe
-- to run once. Every existing row backfills correctly: zero lifetime
-- failures and unpaused is the truthful history for a key that predates this
-- migration, and every existing usage row simply has no provider/key_id on
-- it, same as a request that failed before any key was tried.

ALTER TABLE api_keys ADD COLUMN total_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN paused_at TEXT;

ALTER TABLE usage ADD COLUMN provider TEXT;
ALTER TABLE usage ADD COLUMN key_id INTEGER;

CREATE TABLE IF NOT EXISTS paused_providers (
    provider  TEXT PRIMARY KEY,
    paused_at TEXT NOT NULL
);
