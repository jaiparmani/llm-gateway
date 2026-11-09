# Product Specification — LLM Operations Console

## Vision

Transform llm-gateway from a key-rotation proxy into a production-grade LLM operations console — the control plane for managing, monitoring, and optimizing LLM API usage across providers.

## Current State

### What Exists
- Multi-provider key rotation (OpenRouter, Gemini, Groq, Cerebras, Mistral)
- Automatic retry with bench/pause/rate-limit awareness
- Usage ledger with request IDs, latency, error codes
- Admin console: key management, monitoring, chat playground, AI insights
- Client token auth with SHA-256 hashing
- SSE streaming with gateway envelope
- Proactive rate-limit header capture

### What's Missing for Production
- No dashboard with at-a-glance operational overview
- Request explorer (search/filter individual requests)
- Cost tracking (no token pricing, no budget alerts)
- Application-level isolation (all clients share one pool)
- Routing rules and fallback chains
- Alerting and notifications
- Content logging with redaction
- Dark/light theme, responsive sidebar navigation

## Feature Specification

### 1. Dashboard
**The landing page.** At a glance: system health, request volume (24h), error rate, p95 latency, active keys, top providers, recent errors.

Data sources: `usage` table aggregations, `api_keys` status, `latencyPercentiles()`.

Key metrics:
- Requests/min (trailing 5m, 1h, 24h)
- Success rate (overall and per-provider)
- Latency p50/p95/p99
- Active/limited/benched/paused key counts
- Token throughput (in/out per hour)

### 2. Real-Time Monitoring
**Evolve existing Monitor tab.** Live-updating health, latency sparklines, rate-limit countdowns with per-key quota bars, reliability trends.

Additions:
- Request throughput chart (requests over time)
- Per-provider health breakdown
- Latency distribution histogram
- Error rate trend line
- Auto-refresh with configurable interval (10s/30s/60s)

### 3. Request Explorer
**New.** Searchable, filterable log of every request through the gateway.

Fields: request_id, timestamp, client, provider, model, status (ok/error), latency_ms, input_tokens, output_tokens, error_code, keys_tried.

Filters: time range, client, provider, model, status, latency threshold, error code.

Data source: `usage` table with pagination. New index: `usage(client, at DESC)`.

### 4. API Key Management
**Enhance existing Keys tab.** Current: add/remove/test/pause/unbench. Add:
- Key health timeline (when benched, when recovered)
- Per-key usage sparkline
- Bulk operations (pause all keys for a provider)
- Key expiration warnings (if provider supports)
- Import/export key lists (masked for export)

### 5. Provider & Model Management
**Enhance existing.** Current: model override per provider, provider pause. Add:
- Provider health score (success rate, avg latency, rate-limit frequency)
- Model catalog per provider (fetched or manual)
- Default model selection with validation
- Provider-specific configuration (timeout, retry policy)

### 6. Cost & Usage Analytics
**New.** Token-based cost estimation.

Requirements:
- Per-model pricing table (configurable, stored in D1)
- Cost per request = (input_tokens × input_price) + (output_tokens × output_price)
- Aggregations: by client, by provider, by model, by day/week/month
- Budget alerts (daily/monthly threshold per client or global)
- Cost trend charts

New tables: `model_pricing`, `cost_alerts`.

### 7. Rate Limits & Quotas
**Enhance existing limits view.** Current: observed rate-limit headers, 429 tracking. Add:
- Quota utilization bars (remaining/limit from headers)
- Historical rate-limit frequency (how often each key hits 429)
- Configurable gateway-level rate limits per client
- Rate-limit forecast ("at current pace, key X hits limit in ~2h")

New table: `client_rate_limits` (client, requests_per_minute, requests_per_day).

### 8. Application Management
**New.** Isolate clients into applications with their own configuration.

An application:
- Has a name, description, allowed models, allowed providers
- Issues its own client tokens
- Has its own rate limits and budget
- Cannot access models/providers it isn't authorized for

New tables: `applications`, `application_models`.

Security constraint: "Never silently route to a model that the application has not been authorized to use."

### 9. Routing & Fallback Configuration
**New.** Configurable routing rules per application or globally.

Rules:
- Provider priority order (try Groq first, fall back to OpenRouter)
- Model mapping (application asks for "gpt-4" → route to Gemini flash)
- Load balancing strategy (round-robin, least-latency, least-cost)
- Fallback chains with conditions (on 429 → next provider, on 5xx → skip provider for N minutes)

Storage: `routing_rules` table with JSON rule definitions.

### 10. Alerts & Notifications
**New.** Webhook-based alerting.

Alert conditions:
- Error rate exceeds threshold (e.g., >10% in 5 minutes)
- All keys for a provider benched
- Latency p95 exceeds threshold
- Budget threshold reached
- Key approaching rate limit

Delivery: webhook URL (POST with JSON payload). Future: email, Slack.

New tables: `alert_rules`, `alert_history`.

## UX Design

### Navigation
Sidebar with icon + label:
- Dashboard (home)
- Monitoring
- Requests
- Keys
- Providers
- Analytics
- Rate Limits
- Applications
- Routing
- Alerts
- Settings (chat playground moves here)

### Theme
- Dark mode default (current), light mode option
- CSS custom properties for theming
- Monospace for data, system font for UI chrome

### Responsive
- Sidebar collapses to icons on mobile
- Tables become cards on narrow viewports
- Charts resize gracefully

## API Surface

### Existing (keep as-is)
- `POST /v1/chat/completions` — OpenAI-compatible inference
- `POST /v1/json` — JSON-mode with salvaging
- `POST /v1/embeddings` — OpenAI-compatible embeddings
- `POST /v1/intent` — intent classification

### New Management Endpoints
- `GET /v1/requests` — paginated request log with filters
- `GET /v1/requests/:id` — single request detail
- `GET /v1/dashboard` — aggregated dashboard metrics
- `GET /v1/analytics/cost` — cost breakdowns
- `GET /v1/analytics/trends` — time-series metrics
- `CRUD /v1/applications` — application management
- `CRUD /v1/routing` — routing rules
- `CRUD /v1/alerts` — alert configuration
- `GET /v1/alerts/history` — alert firing history
- `CRUD /v1/pricing` — model pricing configuration

## Security Constraints

1. Never store or expose sensitive prompts/completions by default
2. Never expose provider secrets or gateway API key secrets through logs or frontend APIs
3. Monitoring failures must not bring down inference
4. Display secrets only once at creation; store hashes
5. Never silently route to an unauthorized model
6. Content logging requires explicit opt-in with configurable redaction
7. All new management endpoints require admin token
8. Application tokens inherit application's model/provider restrictions
