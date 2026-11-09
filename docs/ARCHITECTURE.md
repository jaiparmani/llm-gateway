# Architecture

## System Overview

llm-gateway is a single Cloudflare Worker that sits between callers and multiple LLM providers (OpenRouter, Gemini, Groq, Cerebras, Mistral). It rotates API keys round-robin, retries on failure, and serves an admin console — all from one deployment with zero external dependencies beyond D1.

```
Clients ──► Cloudflare Worker ──► LLM Providers
                │                   (OpenRouter, Gemini, Groq, Cerebras, Mistral)
                │
             D1 (SQLite)
             ├── api_keys        (key queue)
             ├── clients         (auth tokens)
             ├── usage           (request ledger)
             ├── provider_models (model overrides)
             └── paused_providers
```

## Component Map

### Entry Point — `src/worker.ts` (48 lines)
Cloudflare Worker `fetch` handler. Wires up `Store`, `Gateway`, and `Router` from environment bindings. Reads per-provider model overrides from env vars (`DEFAULT_MODEL_<PROVIDER>`).

### HTTP Layer — `src/router.ts` (629 lines)
All routing and request handling. Two shapes:
- **Inference endpoints** (client-token auth): `/v1/chat/completions`, `/v1/json`, `/v1/embeddings`, `/v1/intent`
- **Management endpoints** (admin-token auth): `/v1/keys`, `/v1/clients`, `/v1/usage`, `/v1/models`, `/v1/limits`, `/v1/latency`, `/v1/reliability`, `/v1/insights`, provider pause/resume
- **UI**: serves `admin.html` at `/`, `/monitor`, `/chat`, `/insights`

Security: timing-safe admin token comparison, generic 500 messages (never leaks raw errors), CORS on all responses.

### Core Gateway — `src/gateway.ts` (1123 lines)
The rotation engine. Key concepts:
- **Key queue**: front-to-back round-robin. Each call takes the front key, pushes it to the back.
- **Rate-limit awareness**: keys with known `rate_limited_until` in the future are skipped. If all keys are limited, waits up to `maxRateLimitWaitMs` (3s default) for the soonest reset.
- **Benching**: 5 consecutive real failures bench a key (rotation skips it). A success clears it. If all keys are benched, tries them all anyway (self-healing).
- **Manual pause**: admin-set, never overridden by fallback logic.
- **Proactive rate-limit capture**: parses `x-ratelimit-*` headers on both 200 and 429 responses.
- **Streaming**: SSE pass-through with reshaping into gateway's own envelope. `streamCompletion()` handles upstream read errors and client disconnects.
- **JSON salvaging**: delegates to `salvage.ts` for extracting JSON from messy model output.
- **Request IDs**: `gw-<timestamp36>-<random>` threaded through the entire lifecycle.

### Storage — `src/store.ts` (562 lines)
D1-backed persistence. All writes are SQL (no read-modify-write races). Key operations:
- `pushToBack()`: atomic position update, concurrent-safe
- `recordFailure()` / `clearFailures()`: bench/unbench lifecycle
- `updateRateLimitSnapshot()`: writes observed rate-limit headers
- `record()`: usage ledger with request_id, latency_ms, error_code
- `latencyPercentiles()`: p50/p95/p99 from trailing window
- `retryStats()`: first-attempt vs. post-retry success rates
- `hashToken()` / `newToken()`: SHA-256 hashed client tokens

### Provider Registry — `src/providers.ts` (103 lines)
Static definitions: upstream URL, default model, key shape regex, key hint, optional embeddings endpoint. Currently 5 providers. Adding a provider = adding one object to `PROVIDERS`.

### Domain Logic
- **`src/insights.ts`** (104 lines): LLM-powered self-analysis. Builds prompts grounding the model in observed data only.
- **`src/intent.ts`** (73 lines): Message classification to caller-supplied destinations.
- **`src/salvage.ts`** (83 lines): JSON extraction from model output — handles `<think>` blocks, code fences, nested braces.

### Admin UI — `src/admin.html` (822 lines)
Single HTML file, embedded at build time via `scripts/build-ui.mjs`. Four tabs:
- **Keys**: key management, provider pause/resume, model overrides, client tokens, usage stats
- **Monitor**: real-time health, latency percentiles + sparkline, rate-limit countdowns, reliability bars, recent errors. Auto-refresh 30s.
- **Chat**: streaming chat playground using client tokens
- **Insights**: limits/health tables, reliability analysis, LLM-powered analysis, data Q&A chatbot

CSP: `default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`

### Test Infrastructure — `test/d1.ts` (52 lines)
In-memory D1 shim using `node:sqlite`. The test suite (`test/gateway.test.ts`, 1276 lines, 136 tests) exercises the full stack through `handle()` with stubbed HTTP upstream.

## Data Flow

### Inference Request
```
Client → Router (auth via hashed token lookup)
  → Gateway.chat() / chatStream() / embed()
    → usableKeys() filters paused/benched/rate-limited
    → waitForEarliestReset() if all keys limited
    → for each key: post() → upstream provider
      → on 429: pushToBack(rateLimited=true), continue
      → on success: pushToBack, clearFailures, capture rate-limit headers
      → on hard failure: pushToBack, recordFailure, continue
      → on 400 (BadRequest): throw immediately (don't rotate)
  → Router records usage (model, tokens, latency, request_id)
  → Response with x-request-id header
```

### Admin UI Data
```
Browser → GET / (serves admin.html)
  → JS fetches /v1/keys, /v1/usage, /v1/limits, /v1/latency, /v1/reliability
  → Monitor tab auto-refreshes every 30s
  → All dates rendered as relative time (ago())
  → Rate-limit countdowns tick every 1s
```

## Build & Deploy

- **Build**: `node scripts/build-ui.mjs` embeds `admin.html` → `src/ui.generated.ts` (gitignored)
- **Deploy**: `wrangler deploy` (predeploy hook runs build:ui)
- **Test**: `tsx test/gateway.test.ts` (pretest hook runs build:ui)
- **Migrations**: `wrangler d1 execute` with SQL files in `migrations/`

## Security Model

1. **Admin token**: timing-safe comparison, gates all management endpoints
2. **Client tokens**: SHA-256 hashed, shown once at creation, used for inference endpoints
3. **Key secrecy**: `mask()` on the way in, never serialized back. `redact()` strips keys from provider error messages.
4. **Error handling**: 500 handler uses generic message, never raw `Error.message`
5. **CSP**: restrictive, inline-only styles/scripts, no external resources
6. **No key leakage**: tests assert keys never appear in API responses

## Constraints & Boundaries

- **Single Worker**: no background jobs, no cron triggers. Everything is request-driven.
- **D1 limits**: 100k writes/day free tier. Each inference request = 2+ writes (usage + pushToBack).
- **No persistent connections**: Workers are stateless per request.
- **Single-file UI**: everything in admin.html, no framework, no build step beyond embedding.
- **Free-tier models**: the default pool routes to different models per call, hence salvaging.
