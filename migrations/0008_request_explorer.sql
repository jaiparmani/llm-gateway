-- Request explorer: richer per-request data for search/filter.
-- The existing usage table stays for backwards compatibility; new fields
-- that the explorer needs live here.

-- Additional indexes on the existing usage table for efficient filtering.
CREATE INDEX IF NOT EXISTS usage_client_at ON usage (client, at DESC);
CREATE INDEX IF NOT EXISTS usage_provider_at ON usage (provider, at DESC);
CREATE INDEX IF NOT EXISTS usage_ok_at ON usage (ok, at DESC);
CREATE INDEX IF NOT EXISTS usage_error_code_at ON usage (error_code, at DESC);
