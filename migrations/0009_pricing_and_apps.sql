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

-- Which models/providers an application may use.
-- provider='*' means all providers, model='*' means all models on that provider.
CREATE TABLE IF NOT EXISTS application_models (
    application_id INTEGER NOT NULL,
    provider       TEXT    NOT NULL,
    model          TEXT    NOT NULL DEFAULT '*',
    PRIMARY KEY (application_id, provider, model)
);

-- Link clients to applications.
-- Nullable — existing clients without an application keep working.
ALTER TABLE clients ADD COLUMN application_id INTEGER;

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

-- Alert firing history.
CREATE TABLE IF NOT EXISTS alert_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_rule_id   INTEGER NOT NULL,
    fired_at        TEXT    NOT NULL,
    condition_value REAL,
    payload         TEXT,
    delivery_ok     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alert_history_rule_at ON alert_history (alert_rule_id, fired_at DESC);

-- Per-client rate limits (overrides application defaults).
CREATE TABLE IF NOT EXISTS client_rate_limits (
    client              TEXT PRIMARY KEY,
    requests_per_minute INTEGER,
    requests_per_day    INTEGER,
    updated_at          TEXT NOT NULL
);
