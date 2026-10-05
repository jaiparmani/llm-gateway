-- Run once against an already-deployed database:
--
--   wrangler d1 execute llm-gateway --remote --file=migrations/0005_rate_limit_aware_rotation.sql
--
-- Must run BEFORE the Worker code that writes this column deploys — every
-- call does a pushToBack() that now sets rate_limited_until, so deploying
-- the code first would break every request until this runs.
--
-- One nullable column, safe to run once. Every existing row backfills as
-- NULL, the truthful "not known to be rate limited" state for a key that
-- predates this migration.

ALTER TABLE api_keys ADD COLUMN rate_limited_until TEXT;
