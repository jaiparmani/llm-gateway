-- Run once against an already-deployed database:
--
--   wrangler d1 execute llm-gateway --remote --file=migrations/0006_retry_analytics.sql
--
-- Must run BEFORE the Worker code that writes this column deploys — every
-- recorded call now writes key_attempts, so deploying the code first would
-- break every request's usage-ledger write until this runs.
--
-- One nullable column, safe to run once. Every existing row backfills as
-- NULL — the truthful "attempts unknown" state for usage recorded before
-- this tracking existed, same as how provider/key_id already read for a
-- request that predates those columns.

ALTER TABLE usage ADD COLUMN key_attempts INTEGER;
