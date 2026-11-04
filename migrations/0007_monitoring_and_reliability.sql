-- Run BEFORE deploying the new Worker code:
--
--   wrangler d1 execute llm-gateway --remote --file=migrations/0007_monitoring_and_reliability.sql
--
-- Adds rate-limit snapshot columns to api_keys (what the provider's response
-- headers last reported — observed values, never guessed quotas) and request
-- tracking columns to usage (gateway request id, latency, error code).

-- ── api_keys: observed rate-limit snapshot ─────────────────────────────────
ALTER TABLE api_keys ADD COLUMN rate_limit_limit INTEGER;
ALTER TABLE api_keys ADD COLUMN rate_limit_remaining INTEGER;
ALTER TABLE api_keys ADD COLUMN rate_limit_reset TEXT;
ALTER TABLE api_keys ADD COLUMN rate_limit_observed_at TEXT;

-- ── usage: request tracking ────────────────────────────────────────────────
ALTER TABLE usage ADD COLUMN request_id TEXT;
ALTER TABLE usage ADD COLUMN latency_ms INTEGER;
ALTER TABLE usage ADD COLUMN error_code TEXT;

-- Index for fast request-id lookups (debugging a single request by id).
CREATE INDEX IF NOT EXISTS usage_request_id ON usage (request_id);
