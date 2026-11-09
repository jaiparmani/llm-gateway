-- D1 schema. Applied with: npm run db:init
--
-- The key queue is a direct port of the Django OpenRouterKey model this service
-- replaces: a `position` column, lowest at the front, pushed to the back after
-- every use. Keeping the same shape means the behaviour is the one already
-- proven in production rather than a second invention.

CREATE TABLE IF NOT EXISTS api_keys (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    key                  TEXT    NOT NULL UNIQUE,
    masked               TEXT    NOT NULL,
    label                TEXT    NOT NULL DEFAULT '',
    -- Which provider this key belongs to — see src/providers.ts for the
    -- registry. Defaulted rather than required so a row from before this
    -- column existed still reads as the one provider the gateway used to
    -- support.
    provider             TEXT    NOT NULL DEFAULT 'openrouter',
    position             INTEGER NOT NULL DEFAULT 0,
    uses                 INTEGER NOT NULL DEFAULT 0,
    last_used_at         TEXT,
    last_rate_limited_at TEXT,
    -- When the provider's own 429 said this key would be usable again (from
    -- Retry-After or OpenRouter's reset-time metadata) — null whenever that
    -- isn't known. Unlike last_rate_limited_at (history), rotation reads this
    -- to skip a key it already knows is still spent instead of round-robining
    -- into it; see Gateway.usableKeys and Gateway.waitForEarliestReset.
    rate_limited_until   TEXT,
    -- Real-failure tracking (see migrations/0003 and Gateway.chat) — a 429
    -- never touches these, only a failure that is actual evidence the key or
    -- its provider is broken. consecutive_failures resets to 0 on a success;
    -- crossing BENCH_THRESHOLD in a row sets benched_at, which normal
    -- rotation then skips until it is cleared, by a success or by hand.
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    benched_at           TEXT,
    last_failure_reason  TEXT,
    -- Lifetime failures, for analytics — unlike consecutive_failures this
    -- never resets on a success, so it survives what benching forgives.
    total_failures       INTEGER NOT NULL DEFAULT 0,
    -- A manual "stop using this key", set from the console. Unlike
    -- benched_at it is not self-healing and not overridden by the
    -- all-benched fallback in Gateway.chat — an admin's explicit call is
    -- respected until they clear it themselves.
    paused_at            TEXT,
    -- Rate-limit snapshot from the provider's response headers. These are
    -- observed values, not guessed quotas — the UI reads them and says "not
    -- reported by provider" when they are null. Updated on every call that
    -- returns x-ratelimit-* headers. See Gateway.parseRateLimitHeaders.
    rate_limit_limit     INTEGER,
    rate_limit_remaining INTEGER,
    rate_limit_reset     TEXT,
    rate_limit_observed_at TEXT,
    created_at           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_position ON api_keys (position, id);
CREATE INDEX IF NOT EXISTS api_keys_provider ON api_keys (provider);

-- The provider-wide equivalent of api_keys.paused_at — existence of a row
-- means that provider is stopped, regardless of which keys it has.
CREATE TABLE IF NOT EXISTS paused_providers (
    provider  TEXT PRIMARY KEY,
    paused_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    token_hash TEXT    NOT NULL,
    calls      INTEGER NOT NULL DEFAULT 0,
    last_seen  TEXT,
    created_at TEXT    NOT NULL
);

-- One row per provider with a model set from the admin console, overriding
-- its registry default in src/providers.ts. Providers rename and retire
-- models often enough (see migrations/0002) that this needed to be a value an
-- admin can fix from the UI, not a constant that needs a deploy.
CREATE TABLE IF NOT EXISTS provider_models (
    provider   TEXT PRIMARY KEY,
    model      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT    NOT NULL,
    client        TEXT    NOT NULL,
    model         TEXT,
    key_masked    TEXT,
    -- Which provider and which key actually served (or failed) this request —
    -- key_id is nullable because a request can fail before any key is ever
    -- tried (no_keys_configured, every provider paused). Lets the ledger be
    -- broken down per provider and per key, not just per client.
    provider      TEXT,
    key_id        INTEGER,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    ok            INTEGER NOT NULL,
    error         TEXT,
    -- How many keys this request tried in total — null exactly when it
    -- never reached a key at all (same nullability as provider/key_id).
    -- A request with more than one attempt *always* failed on its first
    -- (the loop only ever advances after a failure), which is what lets
    -- Store.retryStats() compare first-attempt vs. post-retry success
    -- honestly, from this column alone. Not the same thing as the
    -- unrelated Completion.attempts (the /v1/json salvage-retry count).
    key_attempts  INTEGER,
    -- Gateway request id, total latency and the gateway's own error code —
    -- see migrations/0007 for the reasoning.
    request_id    TEXT,
    latency_ms    INTEGER,
    error_code    TEXT
);
CREATE INDEX IF NOT EXISTS usage_at ON usage (at DESC);
CREATE INDEX IF NOT EXISTS usage_request_id ON usage (request_id);
CREATE INDEX IF NOT EXISTS usage_client_at ON usage (client, at DESC);
CREATE INDEX IF NOT EXISTS usage_provider_at ON usage (provider, at DESC);
CREATE INDEX IF NOT EXISTS usage_ok_at ON usage (ok, at DESC);
CREATE INDEX IF NOT EXISTS usage_error_code_at ON usage (error_code, at DESC);

-- Model pricing for cost estimation.
CREATE TABLE IF NOT EXISTS model_pricing (
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    input_price_per_m  REAL NOT NULL DEFAULT 0,
    output_price_per_m REAL NOT NULL DEFAULT 0,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (provider, model)
);

-- Applications: logical grouping of clients with shared config.
CREATE TABLE IF NOT EXISTS applications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL UNIQUE,
    description     TEXT    NOT NULL DEFAULT '',
    rate_limit_rpm  INTEGER,
    rate_limit_rpd  INTEGER,
    budget_daily    REAL,
    budget_monthly  REAL,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS application_models (
    application_id INTEGER NOT NULL,
    provider       TEXT    NOT NULL,
    model          TEXT    NOT NULL DEFAULT '*',
    PRIMARY KEY (application_id, provider, model)
);

-- Routing rules.
CREATE TABLE IF NOT EXISTS routing_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id  INTEGER,
    priority        INTEGER NOT NULL DEFAULT 0,
    rule_type       TEXT    NOT NULL,
    config          TEXT    NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

-- Alert rules.
CREATE TABLE IF NOT EXISTS alert_rules (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    condition_type    TEXT    NOT NULL,
    threshold         REAL    NOT NULL,
    window_minutes    INTEGER NOT NULL DEFAULT 5,
    webhook_url       TEXT    NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    cooldown_minutes  INTEGER NOT NULL DEFAULT 30,
    last_fired_at     TEXT,
    created_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_rule_id   INTEGER NOT NULL,
    fired_at        TEXT    NOT NULL,
    condition_value REAL,
    payload         TEXT,
    delivery_ok     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alert_history_rule_at ON alert_history (alert_rule_id, fired_at DESC);

-- Per-client rate limits.
CREATE TABLE IF NOT EXISTS client_rate_limits (
    client              TEXT PRIMARY KEY,
    requests_per_minute INTEGER,
    requests_per_day    INTEGER,
    updated_at          TEXT NOT NULL
);
