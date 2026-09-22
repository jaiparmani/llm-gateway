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
    error         TEXT
);
CREATE INDEX IF NOT EXISTS usage_at ON usage (at DESC);
