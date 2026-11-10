/**
 * D1-backed storage: the key queue, client tokens, and a usage ledger.
 *
 * D1 rather than KV because this writes on every call — rotation and accounting —
 * and KV's free tier allows a thousand writes a day where D1 allows a hundred
 * thousand. It is also real SQL, so the queue is an ORDER BY rather than a
 * read-modify-write of a JSON blob that two concurrent calls would clobber.
 */

export interface ApiKeyRow {
  id: number;
  key: string;
  masked: string;
  label: string;
  provider: string;
  position: number;
  uses: number;
  last_used_at: string | null;
  last_rate_limited_at: string | null;
  /** When the provider's 429 said this key is usable again — null when unknown. See Gateway.usableKeys. */
  rate_limited_until: string | null;
  created_at: string;
  // Real-failure tracking — see Gateway.chat for what counts as "real" and
  // BENCH_THRESHOLD below. A 429 never touches these; the key is merely spent.
  consecutive_failures: number;
  benched_at: string | null;
  last_failure_reason: string | null;
  /** Lifetime, unlike consecutive_failures — never reset by a success. */
  total_failures: number;
  /** A manual "stop using this key" from the console. See the schema comment. */
  paused_at: string | null;
  // Rate-limit snapshot from the provider's response headers.
  rate_limit_limit: number | null;
  rate_limit_remaining: number | null;
  rate_limit_reset: string | null;
  rate_limit_observed_at: string | null;
}

/** What the API and UI are allowed to see. Never includes the key. */
export interface PublicKey {
  id: number;
  masked: string;
  label: string;
  provider: string;
  uses: number;
  lastUsedAt: string | null;
  lastRateLimitedAt: string | null;
  /** Still in the future means rotation is currently skipping this key — see Gateway.usableKeys. */
  rateLimitedUntil: string | null;
  createdAt: string;
  benched: boolean;
  benchedAt: string | null;
  /** The redacted message from the failure that tipped this key into being
   * benched (or the most recent one since). Never a raw key — everything
   * stored here already passed through Gateway's redact() on the way in. */
  benchedReason: string | null;
  totalFailures: number;
  paused: boolean;
  pausedAt: string | null;
  /** Provider-reported rate limit (requests per window). Null = never reported. */
  rateLimitLimit: number | null;
  /** Provider-reported remaining requests in the current window. Null = never reported. */
  rateLimitRemaining: number | null;
  /** Provider-reported window reset time. Null = never reported. */
  rateLimitReset: string | null;
  /** When the snapshot was last observed from response headers. */
  rateLimitObservedAt: string | null;
}

export interface ClientRow {
  name: string;
  calls: number;
  last_seen: string | null;
  created_at: string;
}

/** Never show a whole key. Same shape as the Django side this replaces. */
export function mask(key: string): string {
  if (key.length <= 14) return `${key.slice(0, 4)}...${key.slice(-2)}`;
  return `${key.slice(0, 12)}...${key.slice(-4)}`;
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(`llm-gateway:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `lgw_${b64}`;
}

function now(): string {
  return new Date().toISOString();
}

function publicKey(row: ApiKeyRow): PublicKey {
  return {
    id: row.id,
    masked: row.masked,
    label: row.label,
    provider: row.provider,
    uses: row.uses,
    lastUsedAt: row.last_used_at,
    lastRateLimitedAt: row.last_rate_limited_at,
    rateLimitedUntil: row.rate_limited_until,
    createdAt: row.created_at,
    benched: row.benched_at !== null,
    benchedAt: row.benched_at,
    benchedReason: row.last_failure_reason,
    totalFailures: row.total_failures,
    paused: row.paused_at !== null,
    pausedAt: row.paused_at,
    rateLimitLimit: row.rate_limit_limit,
    rateLimitRemaining: row.rate_limit_remaining,
    rateLimitReset: row.rate_limit_reset,
    rateLimitObservedAt: row.rate_limit_observed_at,
  };
}

/**
 * Real failures in a row before normal rotation skips a key — see
 * Gateway.chat for exactly what counts (not a 429, and not on its own an
 * empty completion). Five is enough to tell "broken" from "unlucky once,"
 * without silently draining a whole request's worth of attempts on a key
 * that is merely having a bad run.
 */
export const BENCH_THRESHOLD = 5;

export class Store {
  constructor(private db: D1Database) {}

  // ── keys ──────────────────────────────────────────────────────────────────

  /** The queue, front first. Includes the secrets — callers must not serialise it. */
  async keys(): Promise<ApiKeyRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM api_keys ORDER BY position, id")
      .all<ApiKeyRow>();
    return results ?? [];
  }

  async publicKeys(): Promise<PublicKey[]> {
    return (await this.keys()).map(publicKey);
  }

  /** Adds a key at the back of the queue. Null if it is already there. */
  async addKey(key: string, label = "", provider = "openrouter"): Promise<PublicKey | null> {
    const existing = await this.db
      .prepare("SELECT id FROM api_keys WHERE key = ?")
      .bind(key)
      .first<{ id: number }>();
    if (existing) return null;

    const row = await this.db
      .prepare(
        `INSERT INTO api_keys (key, masked, label, provider, position, created_at)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM api_keys), ?)
         RETURNING *`,
      )
      .bind(key, mask(key), label.slice(0, 60), provider, now())
      .first<ApiKeyRow>();
    return row ? publicKey(row) : null;
  }

  async removeKey(id: number): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Sends a key to the end of the queue, so the next call takes another.
   *
   * One statement, so two concurrent requests cannot read the same MAX(position)
   * and both land on it.
   *
   * `rateLimitedUntil` is whatever the provider's 429 said (or null, if it
   * said nothing parseable) and is written unconditionally — including as
   * null on every non-429 call, which is what clears a stale value once a
   * key is used again at all, successful or not. See Gateway.usableKeys.
   */
  async pushToBack(id: number, rateLimited: boolean, rateLimitedUntil: string | null = null): Promise<void> {
    const at = now();
    await this.db
      .prepare(
        `UPDATE api_keys
            SET position = (SELECT COALESCE(MAX(position), 0) + 1 FROM api_keys),
                uses = uses + 1,
                last_used_at = ?,
                last_rate_limited_at = CASE WHEN ? = 1 THEN ? ELSE last_rate_limited_at END,
                rate_limited_until = ?
          WHERE id = ?`,
      )
      .bind(at, rateLimited ? 1 : 0, at, rateLimitedUntil, id)
      .run();
  }

  /**
   * Records a real failure against a key. Crossing BENCH_THRESHOLD in a row
   * benches it (`benched_at` set, left alone if already set — the first
   * crossing is the one worth remembering the time of) so `Gateway.chat`
   * skips it in normal rotation. `reason` is stored as-is because callers
   * only ever pass an already-redacted GatewayError message.
   *
   * The right-hand sides here see the row as it was before this statement,
   * so `consecutive_failures + 1` is deliberate — it is what the column is
   * about to become, not what it already is.
   */
  async recordFailure(id: number, reason: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE api_keys
            SET consecutive_failures = consecutive_failures + 1,
                total_failures = total_failures + 1,
                last_failure_reason = ?,
                benched_at = CASE
                  WHEN consecutive_failures + 1 >= ? AND benched_at IS NULL THEN ?
                  ELSE benched_at
                END
          WHERE id = ?`,
      )
      .bind(reason, BENCH_THRESHOLD, now(), id)
      .run();
  }

  /**
   * Clears a key's failure count and bench — what a successful call does on
   * its own, and what the admin console's manual "un-bench" button asks for
   * directly, once whatever was wrong upstream is fixed.
   */
  async clearFailures(id: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE api_keys
            SET consecutive_failures = 0, benched_at = NULL, last_failure_reason = NULL
          WHERE id = ?`,
      )
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * A manual "stop using this key" — unlike benching, this is not evidence of
   * anything and does not clear itself. It stays paused until `resumeKey`.
   */
  async pauseKey(id: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE api_keys SET paused_at = ? WHERE id = ? AND paused_at IS NULL")
      .bind(now(), id)
      .run();
    // Already paused is not a failure to report — this call still did what
    // it was asked, the key just got there first.
    if ((result.meta.changes ?? 0) > 0) return true;
    const row = await this.db.prepare("SELECT id FROM api_keys WHERE id = ?").bind(id).first<{ id: number }>();
    return row !== null;
  }

  async resumeKey(id: number): Promise<boolean> {
    const result = await this.db.prepare("UPDATE api_keys SET paused_at = NULL WHERE id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Updates the rate-limit snapshot on a key from the provider's response
   * headers. Only writes when at least one header was present — a response
   * with no x-ratelimit-* headers does not overwrite a previous snapshot,
   * so the UI's "last observed" timestamp stays honest.
   */
  async updateRateLimitSnapshot(
    id: number,
    snapshot: { limit: number | null; remaining: number | null; reset: string | null },
  ): Promise<void> {
    if (snapshot.limit === null && snapshot.remaining === null && snapshot.reset === null) return;
    await this.db
      .prepare(
        `UPDATE api_keys
            SET rate_limit_limit = ?,
                rate_limit_remaining = ?,
                rate_limit_reset = ?,
                rate_limit_observed_at = ?
          WHERE id = ?`,
      )
      .bind(snapshot.limit, snapshot.remaining, snapshot.reset, now(), id)
      .run();
  }

  // ── provider pausing ─────────────────────────────────────────────────────

  /** Every provider an admin has manually stopped, regardless of which keys it has. */
  async pausedProviders(): Promise<Set<string>> {
    const { results } = await this.db.prepare("SELECT provider FROM paused_providers").all<{ provider: string }>();
    return new Set((results ?? []).map((r) => r.provider));
  }

  async pauseProvider(id: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO paused_providers (provider, paused_at) VALUES (?, ?) ON CONFLICT(provider) DO NOTHING")
      .bind(id, now())
      .run();
  }

  async resumeProvider(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM paused_providers WHERE provider = ?").bind(id).run();
  }

  // ── model overrides ──────────────────────────────────────────────────────

  /** Provider id → overridden model, for every provider an admin has set one on. */
  async modelOverrides(): Promise<Record<string, string>> {
    const { results } = await this.db
      .prepare("SELECT provider, model FROM provider_models")
      .all<{ provider: string; model: string }>();
    const out: Record<string, string> = {};
    for (const row of results ?? []) out[row.provider] = row.model;
    return out;
  }

  /** Empty `model` clears the override, reverting that provider to its registry default. */
  async setModelOverride(provider: string, model: string): Promise<void> {
    if (!model) {
      await this.db.prepare("DELETE FROM provider_models WHERE provider = ?").bind(provider).run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO provider_models (provider, model, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`,
      )
      .bind(provider, model, now())
      .run();
  }

  // ── clients ───────────────────────────────────────────────────────────────

  /** Creates or re-keys a client and returns its token. Shown once. */
  async issueClient(name: string): Promise<string> {
    const token = newToken();
    await this.db
      .prepare(
        `INSERT INTO clients (name, token_hash, created_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash`,
      )
      .bind(name, await hashToken(token), now())
      .run();
    return token;
  }

  /** Client name for a token, or null. Looked up by hash, never by comparison. */
  async authenticate(token: string): Promise<string | null> {
    if (!token) return null;
    const row = await this.db
      .prepare("SELECT name FROM clients WHERE token_hash = ?")
      .bind(await hashToken(token))
      .first<{ name: string }>();
    return row?.name ?? null;
  }

  async clients(): Promise<ClientRow[]> {
    const { results } = await this.db
      .prepare("SELECT name, calls, last_seen, created_at FROM clients ORDER BY name")
      .all<ClientRow>();
    return results ?? [];
  }

  async revokeClient(name: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM clients WHERE name = ?").bind(name).run();
    return (result.meta.changes ?? 0) > 0;
  }

  // ── usage ─────────────────────────────────────────────────────────────────

  async record(entry: {
    client: string;
    model: string | null;
    keyMasked: string | null;
    /** Null when the request never reached a key — no_keys_configured, every provider paused. */
    keyId: number | null;
    provider: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    ok: boolean;
    error: string | null;
    /** How many keys this request tried in total. Null under the same conditions keyId is. See Gateway.GatewayError.keysTried. */
    keyAttempts: number | null;
    /** Gateway-assigned request id — ties a ledger row to the X-Request-Id header the caller received. */
    requestId?: string | null;
    /** Wall-clock milliseconds from the moment the router received the request to the moment it sent the response. */
    latencyMs?: number | null;
    /** The gateway's own error code (upstream_error, rate_limited, etc.) — null on success. */
    errorCode?: string | null;
  }): Promise<void> {
    const at = now();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO usage (at, client, model, key_masked, provider, key_id, input_tokens, output_tokens, ok, error, key_attempts, request_id, latency_ms, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(at, entry.client, entry.model, entry.keyMasked, entry.provider, entry.keyId,
              entry.inputTokens, entry.outputTokens, entry.ok ? 1 : 0, entry.error, entry.keyAttempts,
              entry.requestId ?? null, entry.latencyMs ?? null, entry.errorCode ?? null),
      this.db
        .prepare("UPDATE clients SET calls = calls + 1, last_seen = ? WHERE name = ?")
        .bind(at, entry.client),
    ]);
  }

  async usage(limit = 50): Promise<Record<string, unknown>[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM usage ORDER BY at DESC LIMIT ?")
      .bind(Math.min(limit, 200))
      .all();
    return (results ?? []) as Record<string, unknown>[];
  }

  /** Calls in the trailing `hours` window, grouped by key and by provider — the raw material for "how close to a limit" without ever guessing what that limit is. */
  async usageWindow(hours: number): Promise<{ byKey: Record<number, number>; byProvider: Record<string, number> }> {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { results } = await this.db
      .prepare(
        `SELECT key_id, provider, COUNT(*) AS calls
           FROM usage WHERE at >= ? AND key_id IS NOT NULL GROUP BY key_id, provider`,
      )
      .bind(since)
      .all<{ key_id: number; provider: string; calls: number }>();
    const byKey: Record<number, number> = {};
    const byProvider: Record<string, number> = {};
    for (const row of results ?? []) {
      byKey[row.key_id] = (byKey[row.key_id] ?? 0) + row.calls;
      byProvider[row.provider] = (byProvider[row.provider] ?? 0) + row.calls;
    }
    return { byKey, byProvider };
  }

  async summary(): Promise<Record<string, unknown>> {
    const totals = await this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM usage`,
      )
      .first<Record<string, number>>();
    const { results: byClient } = await this.db
      .prepare("SELECT client, COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok FROM usage GROUP BY client ORDER BY calls DESC")
      .all();
    // provider/key_id are null on a request that never reached a key (no
    // keys configured, every provider paused) — excluded here since there is
    // nothing to attribute a breakdown row to.
    const { results: byProvider } = await this.db
      .prepare(
        `SELECT provider, COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM usage WHERE provider IS NOT NULL GROUP BY provider ORDER BY calls DESC`,
      )
      .all();
    const { results: byKey } = await this.db
      .prepare(
        `SELECT key_id, key_masked, provider, COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM usage WHERE key_id IS NOT NULL GROUP BY key_id ORDER BY calls DESC`,
      )
      .all();
    return {
      ...(totals ?? { calls: 0, ok: 0, input_tokens: 0, output_tokens: 0 }),
      byClient: byClient ?? [],
      byProvider: byProvider ?? [],
      byKey: byKey ?? [],
    };
  }

  /** Latency percentiles from the trailing `hours` window — p50, p95, p99, and the raw values for charting. */
  async latencyPercentiles(hours: number): Promise<{
    p50: number | null; p95: number | null; p99: number | null; count: number;
    recent: { at: string; latencyMs: number; ok: boolean; provider: string | null }[];
  }> {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { results } = await this.db
      .prepare(
        `SELECT latency_ms FROM usage
          WHERE at >= ? AND latency_ms IS NOT NULL
          ORDER BY latency_ms`,
      )
      .bind(since)
      .all<{ latency_ms: number }>();
    const values = (results ?? []).map((r) => r.latency_ms);
    const pct = (p: number) => values.length ? values[Math.min(Math.floor(values.length * p), values.length - 1)]! : null;

    const { results: recentRows } = await this.db
      .prepare(
        `SELECT at, latency_ms, ok, provider FROM usage
          WHERE at >= ? AND latency_ms IS NOT NULL
          ORDER BY at DESC LIMIT 50`,
      )
      .bind(since)
      .all<{ at: string; latency_ms: number; ok: number; provider: string | null }>();

    return {
      p50: pct(0.5),
      p95: pct(0.95),
      p99: pct(0.99),
      count: values.length,
      recent: (recentRows ?? []).map((r) => ({
        at: r.at, latencyMs: r.latency_ms, ok: r.ok === 1, provider: r.provider,
      })),
    };
  }

  async retryStats(): Promise<Record<string, unknown>> {
    const totals = await this.db
      .prepare(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(ok), 0) AS ok,
            COALESCE(SUM(CASE WHEN key_attempts IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_key_attempts,
            COALESCE(SUM(CASE WHEN key_attempts IS NOT NULL AND ok = 1 THEN 1 ELSE 0 END), 0) AS ok_with_key_attempts,
            COALESCE(SUM(CASE WHEN key_attempts = 1 AND ok = 1 THEN 1 ELSE 0 END), 0) AS first_attempt_ok,
            COALESCE(SUM(CASE WHEN key_attempts > 1 THEN 1 ELSE 0 END), 0) AS needed_retry,
            COALESCE(SUM(CASE WHEN key_attempts > 1 AND ok = 1 THEN 1 ELSE 0 END), 0) AS retry_rescued,
            COALESCE(AVG(key_attempts), 0) AS avg_key_attempts
          FROM usage WHERE client NOT LIKE 'gateway:%'`,
      )
      .first<Record<string, number>>();
    const { results: byProvider } = await this.db
      .prepare(
        `SELECT
            provider,
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN key_attempts = 1 AND ok = 1 THEN 1 ELSE 0 END), 0) AS first_attempt_ok,
            COALESCE(SUM(CASE WHEN key_attempts > 1 THEN 1 ELSE 0 END), 0) AS needed_retry,
            COALESCE(SUM(CASE WHEN key_attempts > 1 AND ok = 1 THEN 1 ELSE 0 END), 0) AS retry_rescued
          FROM usage WHERE provider IS NOT NULL AND client NOT LIKE 'gateway:%'
          GROUP BY provider ORDER BY total DESC`,
      )
      .all();
    return {
      ...(totals ?? {
        total: 0, ok: 0, with_key_attempts: 0, ok_with_key_attempts: 0,
        first_attempt_ok: 0, needed_retry: 0, retry_rescued: 0, avg_key_attempts: 0,
      }),
      byProvider: byProvider ?? [],
    };
  }

  // ── dashboard ─────────────────────────────────────────────────────────

  async dashboardMetrics(hours?: number): Promise<{
    windows: { label: string; requests: number; ok: number; errorRate: number }[];
    latency: { p50: number | null; p95: number | null; p99: number | null };
    tokens: { inputLast24h: number; outputLast24h: number };
  }> {
    const h = hours ?? 24;
    const windowDefs = h <= 4
      ? [{ label: "5m", ms: 5 * 60_000 }, { label: "1h", ms: 3_600_000 }, { label: "4h", ms: 4 * 3_600_000 }]
      : h <= 24
        ? [{ label: "5m", ms: 5 * 60_000 }, { label: "1h", ms: 3_600_000 }, { label: "24h", ms: 86_400_000 }]
        : [{ label: "1h", ms: 3_600_000 }, { label: "24h", ms: 86_400_000 }, { label: h + "h", ms: h * 3_600_000 }];
    const windows = [];
    for (const w of windowDefs) {
      const since = new Date(Date.now() - w.ms).toISOString();
      const row = await this.db
        .prepare("SELECT COUNT(*) AS reqs, COALESCE(SUM(ok), 0) AS ok FROM usage WHERE at >= ?")
        .bind(since)
        .first<{ reqs: number; ok: number }>();
      const reqs = row?.reqs ?? 0;
      const ok = row?.ok ?? 0;
      windows.push({ label: w.label, requests: reqs, ok, errorRate: reqs ? 1 - ok / reqs : 0 });
    }
    const latency = await this.latencyPercentiles(h);
    const tokenMs = h * 3_600_000;
    const sinceTokens = new Date(Date.now() - tokenMs).toISOString();
    const tokens = await this.db
      .prepare("SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o FROM usage WHERE at >= ?")
      .bind(sinceTokens)
      .first<{ i: number; o: number }>();
    return {
      windows,
      latency: { p50: latency.p50, p95: latency.p95, p99: latency.p99 },
      tokens: { inputLast24h: tokens?.i ?? 0, outputLast24h: tokens?.o ?? 0 },
    };
  }

  // ── request explorer ──────────────────────────────────────────────────

  async searchRequests(filters: {
    client?: string; provider?: string; status?: "ok" | "error"; errorCode?: string;
    from?: string; to?: string; minLatency?: number; limit?: number; offset?: number;
  }): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.client) { conditions.push("client = ?"); params.push(filters.client); }
    if (filters.provider) { conditions.push("provider = ?"); params.push(filters.provider); }
    if (filters.status === "ok") conditions.push("ok = 1");
    else if (filters.status === "error") conditions.push("ok = 0");
    if (filters.errorCode) { conditions.push("error_code = ?"); params.push(filters.errorCode); }
    if (filters.from) { conditions.push("at >= ?"); params.push(filters.from); }
    if (filters.to) { conditions.push("at <= ?"); params.push(filters.to); }
    if (filters.minLatency) { conditions.push("latency_ms >= ?"); params.push(filters.minLatency); }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;
    const countRow = await this.db
      .prepare("SELECT COUNT(*) AS total FROM usage" + where)
      .bind(...params)
      .first<{ total: number }>();
    const { results } = await this.db
      .prepare("SELECT * FROM usage" + where + " ORDER BY at DESC LIMIT ? OFFSET ?")
      .bind(...params, limit, offset)
      .all();
    return { rows: (results ?? []) as Record<string, unknown>[], total: countRow?.total ?? 0 };
  }

  async getRequest(requestId: string): Promise<Record<string, unknown> | null> {
    return await this.db
      .prepare("SELECT * FROM usage WHERE request_id = ?")
      .bind(requestId)
      .first<Record<string, unknown>>() ?? null;
  }

  // ── model pricing ─────────────────────────────────────────────────────

  async getPricing(): Promise<{ provider: string; model: string; inputPricePerM: number; outputPricePerM: number }[]> {
    const { results } = await this.db
      .prepare("SELECT provider, model, input_price_per_m, output_price_per_m FROM model_pricing ORDER BY provider, model")
      .all<{ provider: string; model: string; input_price_per_m: number; output_price_per_m: number }>();
    return (results ?? []).map((r) => ({
      provider: r.provider, model: r.model, inputPricePerM: r.input_price_per_m, outputPricePerM: r.output_price_per_m,
    }));
  }

  async setPricing(provider: string, model: string, inputPricePerM: number, outputPricePerM: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO model_pricing (provider, model, input_price_per_m, output_price_per_m, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET input_price_per_m = excluded.input_price_per_m,
           output_price_per_m = excluded.output_price_per_m, updated_at = excluded.updated_at`,
      )
      .bind(provider, model, inputPricePerM, outputPricePerM, now())
      .run();
  }

  async deletePricing(provider: string, model: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM model_pricing WHERE provider = ? AND model = ?").bind(provider, model).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async costAnalytics(groupBy: "client" | "provider" | "model", days: number): Promise<Record<string, unknown>[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const col = groupBy === "client" ? "u.client" : groupBy === "provider" ? "u.provider" : "u.model";
    const { results } = await this.db
      .prepare(
        `SELECT ${col} AS group_key, COUNT(*) AS requests,
                COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(
                  (COALESCE(u.input_tokens, 0) * COALESCE(p.input_price_per_m, 0) +
                   COALESCE(u.output_tokens, 0) * COALESCE(p.output_price_per_m, 0)) / 1000000.0
                ), 0) AS estimated_cost
           FROM usage u
           LEFT JOIN model_pricing p ON u.provider = p.provider AND u.model = p.model
          WHERE u.at >= ?
          GROUP BY ${col}
          ORDER BY estimated_cost DESC`,
      )
      .bind(since)
      .all();
    return (results ?? []) as Record<string, unknown>[];
  }

  // ── applications ──────────────────────────────────────────────────────

  async createApplication(app: {
    name: string; description?: string; rateLimitRpm?: number; rateLimitRpd?: number;
    budgetDaily?: number; budgetMonthly?: number;
  }): Promise<Record<string, unknown> | null> {
    const at = now();
    return await this.db
      .prepare(
        `INSERT INTO applications (name, description, rate_limit_rpm, rate_limit_rpd, budget_daily, budget_monthly, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .bind(app.name, app.description ?? "", app.rateLimitRpm ?? null, app.rateLimitRpd ?? null,
            app.budgetDaily ?? null, app.budgetMonthly ?? null, at, at)
      .first<Record<string, unknown>>() ?? null;
  }

  async listApplications(): Promise<Record<string, unknown>[]> {
    const { results } = await this.db.prepare("SELECT * FROM applications ORDER BY name").all();
    return (results ?? []) as Record<string, unknown>[];
  }

  async getApplication(id: number): Promise<Record<string, unknown> | null> {
    return await this.db.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first<Record<string, unknown>>() ?? null;
  }

  async deleteApplication(id: number): Promise<boolean> {
    await this.db.prepare("DELETE FROM application_models WHERE application_id = ?").bind(id).run();
    const result = await this.db.prepare("DELETE FROM applications WHERE id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async setApplicationModels(appId: number, models: { provider: string; model: string }[]): Promise<void> {
    await this.db.prepare("DELETE FROM application_models WHERE application_id = ?").bind(appId).run();
    for (const m of models) {
      await this.db
        .prepare("INSERT INTO application_models (application_id, provider, model) VALUES (?, ?, ?)")
        .bind(appId, m.provider, m.model)
        .run();
    }
  }

  async getApplicationModels(appId: number): Promise<{ provider: string; model: string }[]> {
    const { results } = await this.db
      .prepare("SELECT provider, model FROM application_models WHERE application_id = ?")
      .bind(appId)
      .all<{ provider: string; model: string }>();
    return results ?? [];
  }

  // ── routing rules ─────────────────────────────────────────────────────

  async listRoutingRules(appId?: number): Promise<Record<string, unknown>[]> {
    const where = appId !== undefined ? " WHERE application_id = ?" : "";
    const stmt = this.db.prepare("SELECT * FROM routing_rules" + where + " ORDER BY priority");
    const { results } = appId !== undefined ? await stmt.bind(appId).all() : await stmt.all();
    return (results ?? []) as Record<string, unknown>[];
  }

  async createRoutingRule(rule: { applicationId?: number; priority: number; ruleType: string; config: string }): Promise<Record<string, unknown> | null> {
    const at = now();
    return await this.db
      .prepare(
        `INSERT INTO routing_rules (application_id, priority, rule_type, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .bind(rule.applicationId ?? null, rule.priority, rule.ruleType, rule.config, at, at)
      .first<Record<string, unknown>>() ?? null;
  }

  async deleteRoutingRule(id: number): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM routing_rules WHERE id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  // ── alert rules ───────────────────────────────────────────────────────

  async listAlertRules(): Promise<Record<string, unknown>[]> {
    const { results } = await this.db.prepare("SELECT * FROM alert_rules ORDER BY name").all();
    return (results ?? []) as Record<string, unknown>[];
  }

  async createAlertRule(rule: {
    name: string; conditionType: string; threshold: number; windowMinutes: number;
    webhookUrl: string; cooldownMinutes?: number;
  }): Promise<Record<string, unknown> | null> {
    return await this.db
      .prepare(
        `INSERT INTO alert_rules (name, condition_type, threshold, window_minutes, webhook_url, cooldown_minutes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .bind(rule.name, rule.conditionType, rule.threshold, rule.windowMinutes,
            rule.webhookUrl, rule.cooldownMinutes ?? 30, now())
      .first<Record<string, unknown>>() ?? null;
  }

  async deleteAlertRule(id: number): Promise<boolean> {
    await this.db.prepare("DELETE FROM alert_history WHERE alert_rule_id = ?").bind(id).run();
    const result = await this.db.prepare("DELETE FROM alert_rules WHERE id = ?").bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async recordAlertFiring(ruleId: number, conditionValue: number, payload: string, deliveryOk: boolean): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("INSERT INTO alert_history (alert_rule_id, fired_at, condition_value, payload, delivery_ok) VALUES (?, ?, ?, ?, ?)")
        .bind(ruleId, now(), conditionValue, payload, deliveryOk ? 1 : 0),
      this.db
        .prepare("UPDATE alert_rules SET last_fired_at = ? WHERE id = ?")
        .bind(now(), ruleId),
    ]);
  }

  async alertHistory(ruleId?: number, limit = 50): Promise<Record<string, unknown>[]> {
    const where = ruleId !== undefined ? " WHERE alert_rule_id = ?" : "";
    const stmt = this.db.prepare("SELECT * FROM alert_history" + where + " ORDER BY fired_at DESC LIMIT ?");
    const { results } = ruleId !== undefined ? await stmt.bind(ruleId, limit).all() : await stmt.bind(limit).all();
    return (results ?? []) as Record<string, unknown>[];
  }

  async checkAlertCondition(conditionType: string, windowMinutes: number): Promise<number> {
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    if (conditionType === "error_rate") {
      const row = await this.db
        .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok FROM usage WHERE at >= ? AND client NOT LIKE 'gateway:%'")
        .bind(since)
        .first<{ total: number; ok: number }>();
      return row && row.total > 0 ? 1 - row.ok / row.total : 0;
    }
    if (conditionType === "latency_p95") {
      const { results } = await this.db
        .prepare("SELECT latency_ms FROM usage WHERE at >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms")
        .bind(since)
        .all<{ latency_ms: number }>();
      const values = (results ?? []).map((r) => r.latency_ms);
      return values.length ? values[Math.min(Math.floor(values.length * 0.95), values.length - 1)]! : 0;
    }
    return 0;
  }

  // ── client rate limits ────────────────────────────────────────────────

  async getClientRateLimit(client: string): Promise<{ requestsPerMinute: number | null; requestsPerDay: number | null } | null> {
    const row = await this.db
      .prepare("SELECT requests_per_minute, requests_per_day FROM client_rate_limits WHERE client = ?")
      .bind(client)
      .first<{ requests_per_minute: number | null; requests_per_day: number | null }>();
    if (!row) return null;
    return { requestsPerMinute: row.requests_per_minute, requestsPerDay: row.requests_per_day };
  }

  async setClientRateLimit(client: string, rpm: number | null, rpd: number | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO client_rate_limits (client, requests_per_minute, requests_per_day, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client) DO UPDATE SET requests_per_minute = excluded.requests_per_minute,
           requests_per_day = excluded.requests_per_day, updated_at = excluded.updated_at`,
      )
      .bind(client, rpm, rpd, now())
      .run();
  }

  async deleteClientRateLimit(client: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM client_rate_limits WHERE client = ?").bind(client).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async checkClientRate(client: string): Promise<{ allowed: boolean; retryAfter?: number }> {
    const limits = await this.getClientRateLimit(client);
    if (!limits) return { allowed: true };
    if (limits.requestsPerMinute !== null) {
      const since = new Date(Date.now() - 60_000).toISOString();
      const row = await this.db
        .prepare("SELECT COUNT(*) AS c FROM usage WHERE client = ? AND at >= ?")
        .bind(client, since)
        .first<{ c: number }>();
      if ((row?.c ?? 0) >= limits.requestsPerMinute) return { allowed: false, retryAfter: 60 };
    }
    if (limits.requestsPerDay !== null) {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const row = await this.db
        .prepare("SELECT COUNT(*) AS c FROM usage WHERE client = ? AND at >= ?")
        .bind(client, since)
        .first<{ c: number }>();
      if ((row?.c ?? 0) >= limits.requestsPerDay) return { allowed: false, retryAfter: 3600 };
    }
    return { allowed: true };
  }
}
