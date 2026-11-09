# Data Model

## Current Schema (D1 / SQLite)

### api_keys
The key rotation queue. Position-ordered, pushed to back after each use.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| key | TEXT UNIQUE | Raw provider key (never exposed via API) |
| masked | TEXT | Display form (e.g., `sk-or-v1-abc...xyz`) |
| label | TEXT | Admin-assigned label |
| provider | TEXT DEFAULT 'openrouter' | Provider ID from registry |
| position | INTEGER | Queue position (lowest = front) |
| uses | INTEGER | Lifetime call count |
| last_used_at | TEXT (ISO 8601) | Last rotation timestamp |
| last_rate_limited_at | TEXT | Last 429 timestamp |
| rate_limited_until | TEXT | Provider-reported reset time (rotation skips if future) |
| consecutive_failures | INTEGER | Resets to 0 on success |
| benched_at | TEXT | Set when failures >= BENCH_THRESHOLD (5) |
| last_failure_reason | TEXT | Redacted error message |
| total_failures | INTEGER | Lifetime (never resets) |
| paused_at | TEXT | Manual admin pause |
| rate_limit_limit | INTEGER | Observed from x-ratelimit-limit header |
| rate_limit_remaining | INTEGER | Observed from x-ratelimit-remaining header |
| rate_limit_reset | TEXT | Observed from x-ratelimit-reset header |
| rate_limit_observed_at | TEXT | When snapshot was captured |
| created_at | TEXT | |

Indexes: `(position, id)`, `(provider)`

### clients
Client applications that call inference endpoints.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| name | TEXT UNIQUE | Lowercase kebab/snake, 1-40 chars |
| token_hash | TEXT | SHA-256 of `llm-gateway:<token>` |
| calls | INTEGER | Lifetime call count |
| last_seen | TEXT | Last request timestamp |
| created_at | TEXT | |

### usage
Request ledger — one row per inference call.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| at | TEXT | Request timestamp |
| client | TEXT | Client name |
| model | TEXT | Model that served the request |
| key_masked | TEXT | Which key (masked) |
| provider | TEXT | Provider ID (null if never reached a key) |
| key_id | INTEGER | FK to api_keys (null if never reached a key) |
| input_tokens | INTEGER | Prompt tokens |
| output_tokens | INTEGER | Completion tokens |
| ok | INTEGER | 1 = success, 0 = failure |
| error | TEXT | Error message (null on success) |
| key_attempts | INTEGER | Keys tried before success/failure |
| request_id | TEXT | Gateway request ID (`gw-*`) |
| latency_ms | INTEGER | Wall-clock milliseconds |
| error_code | TEXT | Gateway error code (null on success) |

Indexes: `(at DESC)`, `(request_id)`

### provider_models
Admin model overrides per provider.

| Column | Type | Description |
|--------|------|-------------|
| provider | TEXT PK | Provider ID |
| model | TEXT | Override model name |
| updated_at | TEXT | |

### paused_providers
Provider-wide pause state.

| Column | Type | Description |
|--------|------|-------------|
| provider | TEXT PK | Provider ID |
| paused_at | TEXT | |

## New Tables for Phase 1

### requests (replaces usage for detailed request log)
Extended version of `usage` for the Request Explorer. The existing `usage` table stays for backwards compatibility; new requests write to both.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| request_id | TEXT UNIQUE | Gateway request ID |
| at | TEXT | |
| client | TEXT | |
| application_id | INTEGER | FK to applications (nullable) |
| provider | TEXT | |
| model | TEXT | |
| key_id | INTEGER | |
| key_masked | TEXT | |
| input_tokens | INTEGER | |
| output_tokens | INTEGER | |
| latency_ms | INTEGER | |
| ok | INTEGER | |
| error | TEXT | |
| error_code | TEXT | |
| key_attempts | INTEGER | |
| keys_tried | TEXT | JSON array of masked keys |
| finish_reason | TEXT | |
| estimated_cost | REAL | Computed from pricing table |

Indexes: `(at DESC)`, `(request_id)`, `(client, at DESC)`, `(provider, at DESC)`, `(application_id, at DESC)`

### applications
Logical groupings of clients with shared configuration.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| name | TEXT UNIQUE | |
| description | TEXT | |
| created_at | TEXT | |
| updated_at | TEXT | |
| rate_limit_rpm | INTEGER | Requests per minute (null = unlimited) |
| rate_limit_rpd | INTEGER | Requests per day (null = unlimited) |
| budget_daily | REAL | Daily cost cap in USD (null = unlimited) |
| budget_monthly | REAL | Monthly cost cap (null = unlimited) |

### application_models
Which models/providers an application may use.

| Column | Type | Description |
|--------|------|-------------|
| application_id | INTEGER | FK to applications |
| provider | TEXT | Provider ID |
| model | TEXT | Model name (wildcard `*` = all models on this provider) |

PK: `(application_id, provider, model)`

### model_pricing
Token pricing for cost estimation.

| Column | Type | Description |
|--------|------|-------------|
| provider | TEXT | |
| model | TEXT | |
| input_price_per_m | REAL | USD per million input tokens |
| output_price_per_m | REAL | USD per million output tokens |
| updated_at | TEXT | |

PK: `(provider, model)`

### routing_rules
Per-application or global routing configuration.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| application_id | INTEGER | FK (null = global) |
| priority | INTEGER | Lower = higher priority |
| rule | TEXT | JSON rule definition |
| enabled | INTEGER | |
| created_at | TEXT | |
| updated_at | TEXT | |

### alert_rules
Alert configuration.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| name | TEXT | |
| condition_type | TEXT | error_rate, latency_p95, all_benched, budget, rate_limit |
| threshold | REAL | |
| window_minutes | INTEGER | Evaluation window |
| webhook_url | TEXT | Delivery target |
| enabled | INTEGER | |
| cooldown_minutes | INTEGER | Minimum time between firings |
| last_fired_at | TEXT | |
| created_at | TEXT | |

### alert_history
Record of alert firings.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | |
| alert_rule_id | INTEGER | FK to alert_rules |
| fired_at | TEXT | |
| condition_value | REAL | The value that triggered it |
| payload | TEXT | JSON payload sent to webhook |
| delivery_ok | INTEGER | Whether webhook returned 2xx |

### client_rate_limits
Per-client rate limiting (overrides application defaults).

| Column | Type | Description |
|--------|------|-------------|
| client | TEXT PK | FK to clients.name |
| requests_per_minute | INTEGER | |
| requests_per_day | INTEGER | |
| updated_at | TEXT | |

## Migration Strategy

Each new table gets its own migration file in `migrations/`. Order:
1. `0008_request_explorer.sql` — requests table + indexes
2. `0009_applications.sql` — applications + application_models
3. `0010_pricing.sql` — model_pricing with default free-tier values
4. `0011_routing.sql` — routing_rules
5. `0012_alerts.sql` — alert_rules + alert_history
6. `0013_client_rate_limits.sql` — client_rate_limits

All migrations are additive (CREATE TABLE IF NOT EXISTS). No existing table is altered or dropped. The existing `usage` table continues to be written for backwards compatibility; new features read from `requests` when available.

## Key Invariants

1. **`api_keys.key` never leaves the database** — only `masked` is serialized
2. **`clients.token_hash` is irreversible** — SHA-256, token shown once at creation
3. **`usage.ok`/`requests.ok` is the source of truth** for success/failure counts
4. **`rate_limit_*` columns are observed data** — null means "provider hasn't reported", never "unlimited"
5. **`consecutive_failures` resets on success** — `total_failures` never does
6. **`paused_at` (manual) is never overridden** by the all-benched fallback
7. **`position` updates are single-statement** — no read-modify-write race
