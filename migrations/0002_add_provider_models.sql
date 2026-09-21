-- Run once against an already-deployed database:
--
--   wrangler d1 execute llm-gateway --remote --file=migrations/0002_add_provider_models.sql
--
-- A new table, so unlike 0001 this needs no ALTER — CREATE TABLE IF NOT EXISTS
-- is enough, and safe to re-run.

CREATE TABLE IF NOT EXISTS provider_models (
    provider   TEXT PRIMARY KEY,
    model      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
