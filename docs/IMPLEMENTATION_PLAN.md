# Implementation Plan

## Approach

Implement in layers: backend data first, then API endpoints, then UI. Each feature is shippable on its own. The existing admin.html will be rewritten into a sidebar-navigated console with dedicated pages per feature area.

## Phase 1A — Foundation (Backend)

### 1. Dashboard endpoint
- New `GET /v1/dashboard` in router.ts
- Aggregates: requests (5m/1h/24h), success rate, p50/p95/p99 latency, active/limited/benched keys, token throughput
- All computed from existing `usage` + `api_keys` tables — no schema change
- Add `Store.dashboardMetrics(windows: number[])` method

### 2. Request Explorer
- Migration `0008`: `requests` table with extended columns + indexes
- Dual-write: `Store.record()` writes to both `usage` and `requests`
- `Store.searchRequests(filters, pagination)` method
- `GET /v1/requests?client=&provider=&status=&from=&to=&limit=&offset=`
- `GET /v1/requests/:id` — single request detail
- New index on `usage(client, at DESC)` for the transition period

### 3. Cost tracking
- Migration `0009`: `model_pricing` table with default free-tier entries ($0)
- `Store.estimateCost(provider, model, inputTokens, outputTokens)` 
- Cost computed at record time, stored in `requests.estimated_cost`
- `GET /v1/analytics/cost?group_by=client|provider|model&period=day|week|month`
- `CRUD /v1/pricing` — admin manages per-model pricing

### 4. Application management
- Migration `0010`: `applications` + `application_models` tables
- `Store.createApplication()`, `getApplication()`, `listApplications()`, `updateApplication()`, `deleteApplication()`
- Link clients to applications: add `application_id` column to `clients`
- `Gateway.chat()` checks application model restrictions before rotation
- `CRUD /v1/applications`

### 5. Client rate limiting
- Migration `0011`: `client_rate_limits` table
- Sliding window counter in `usage` table: `SELECT COUNT(*) FROM usage WHERE client = ? AND at >= ?`
- Check in router.ts before inference — return 429 with retry-after if exceeded
- `CRUD /v1/rate-limits`

### 6. Routing rules
- Migration `0012`: `routing_rules` table
- Rule types: provider priority, model mapping, load balancing strategy
- `Gateway.usableKeys()` applies routing rules to filter/order candidates
- `CRUD /v1/routing`

### 7. Alert rules
- Migration `0013`: `alert_rules` + `alert_history` tables
- Evaluation: check conditions after each request (piggyback on `record()`)
- Fire webhook via `fetch()` with `waitUntil()` — never blocks inference
- `CRUD /v1/alerts`
- `GET /v1/alerts/history`

## Phase 1B — UI Rewrite

### Architecture
Replace the single-file 4-tab layout with a sidebar-navigated console:

```
┌─────────┬───────────────────────────────┐
│ Sidebar │  Page Content                 │
│         │                               │
│ ◆ Dash  │  [Dashboard / Monitoring /    │
│ ◆ Mon   │   Requests / Keys / etc.]    │
│ ◆ Reqs  │                               │
│ ◆ Keys  │                               │
│ ◆ Provs │                               │
│ ◆ Cost  │                               │
│ ◆ Limits│                               │
│ ◆ Apps  │                               │
│ ◆ Route │                               │
│ ◆ Alert │                               │
│ ◆ Chat  │                               │
│ ◆ ⚙     │                               │
└─────────┴───────────────────────────────┘
```

### Still a single HTML file
The build-ui.mjs pattern stays — one file, no framework, no dependencies. The JS organizes into page-render functions, one per sidebar item.

### Theme system
CSS custom properties on `:root` for dark (default) and light mode. Toggle in settings. `@media (prefers-color-scheme)` for auto-detect.

### Page implementations

1. **Dashboard page**: metric cards (requests, success rate, latency, keys, tokens), mini charts (request volume over 24h, error rate trend), recent errors list. All from `GET /v1/dashboard`.

2. **Monitoring page**: evolve existing Monitor tab. Add request throughput chart, per-provider breakdown, configurable refresh interval.

3. **Requests page**: table with sortable columns, filter bar (client, provider, status, time range, latency), pagination, click-to-expand detail view. From `GET /v1/requests`.

4. **Keys page**: current key management + per-key usage sparkline, bulk operations.

5. **Providers page**: current provider management + health score, model catalog.

6. **Analytics page**: cost breakdowns (by client, provider, model, time), trend charts, budget utilization.

7. **Rate Limits page**: current limits view + per-client quota configuration, utilization bars, rate-limit frequency charts.

8. **Applications page**: CRUD for applications, model restrictions, associated clients, usage summary.

9. **Routing page**: visual rule builder, priority ordering, test routing.

10. **Alerts page**: rule list, create/edit form, firing history.

11. **Chat page**: existing chat playground, unchanged.

12. **Settings**: theme toggle, AI insights (moved from tab), data Q&A chatbot.

## Phase 2 — Polish & Security

### Content logging
- Configurable per application: off (default), metadata-only, full with redaction
- Redaction patterns: email, phone, SSN, credit card — regex-based, configurable
- Separate `request_content` table (not in main `requests` — opt-in only)
- Retention policy: auto-delete after N days

### Security hardening
- Rate limit the admin endpoints themselves (prevent brute-force)
- Audit log for admin actions (key add/remove, pause/resume, client issue/revoke)
- CORS tightening (allow-origin from env var instead of `*`)

### Testing
- Extend test suite for every new endpoint
- Test application model restrictions
- Test client rate limiting
- Test routing rules
- Test alert evaluation and webhook delivery

## Implementation Order

Each step is independently deployable:

| # | Feature | Files | Migration | Estimated Size |
|---|---------|-------|-----------|----------------|
| 1 | Dashboard endpoint | store.ts, router.ts | none | ~60 lines |
| 2 | Request explorer (backend) | store.ts, router.ts | 0008 | ~120 lines |
| 3 | Cost tracking (backend) | store.ts, router.ts | 0009 | ~100 lines |
| 4 | UI rewrite: sidebar + dashboard + requests | admin.html | none | ~600 lines |
| 5 | UI: monitoring page (migrate existing) | admin.html | none | ~200 lines |
| 6 | UI: keys + providers (migrate existing) | admin.html | none | ~300 lines |
| 7 | UI: analytics + rate limits pages | admin.html | none | ~300 lines |
| 8 | Applications (full stack) | store.ts, gateway.ts, router.ts, admin.html | 0010 | ~250 lines |
| 9 | Client rate limiting | store.ts, router.ts, admin.html | 0011 | ~100 lines |
| 10 | Routing rules | gateway.ts, store.ts, router.ts, admin.html | 0012 | ~200 lines |
| 11 | Alerts | store.ts, router.ts, admin.html | 0013 | ~200 lines |
| 12 | Chat + settings (migrate existing) | admin.html | none | ~100 lines |
| 13 | Dark/light theme | admin.html | none | ~80 lines |
| 14 | Tests for new features | gateway.test.ts | none | ~400 lines |

## Constraints

- **D1 write budget**: 100k writes/day. Dual-writing to `usage` + `requests` doubles write count per request. Monitor via Cloudflare dashboard.
- **Worker CPU time**: 10ms free tier. Dashboard aggregations must be efficient (indexed queries, no full table scans).
- **Single HTML file**: keep admin.html under 2000 lines. If it grows past that, consider splitting JS into a second file served from the same Worker.
- **No external dependencies**: no npm packages in the Worker, no CDN loads in the UI.
- **Backwards compatibility**: existing API endpoints and their response shapes don't change. New features are additive.
