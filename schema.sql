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
    position             INTEGER NOT NULL DEFAULT 0,
    uses                 INTEGER NOT NULL DEFAULT 0,
    last_used_at         TEXT,
    last_rate_limited_at TEXT,
    created_at           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_position ON api_keys (position, id);

CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    token_hash TEXT    NOT NULL,
    calls      INTEGER NOT NULL DEFAULT 0,
    last_seen  TEXT,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT    NOT NULL,
    client        TEXT    NOT NULL,
    model         TEXT,
    key_masked    TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    ok            INTEGER NOT NULL,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS usage_at ON usage (at DESC);
