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
  created_at: string;
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
  createdAt: string;
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
    createdAt: row.created_at,
  };
}

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
   */
  async pushToBack(id: number, rateLimited: boolean): Promise<void> {
    const at = now();
    await this.db
      .prepare(
        `UPDATE api_keys
            SET position = (SELECT COALESCE(MAX(position), 0) + 1 FROM api_keys),
                uses = uses + 1,
                last_used_at = ?,
                last_rate_limited_at = CASE WHEN ? = 1 THEN ? ELSE last_rate_limited_at END
          WHERE id = ?`,
      )
      .bind(at, rateLimited ? 1 : 0, at, id)
      .run();
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
    inputTokens: number | null;
    outputTokens: number | null;
    ok: boolean;
    error: string | null;
  }): Promise<void> {
    const at = now();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO usage (at, client, model, key_masked, input_tokens, output_tokens, ok, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(at, entry.client, entry.model, entry.keyMasked, entry.inputTokens,
              entry.outputTokens, entry.ok ? 1 : 0, entry.error),
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

  async summary(): Promise<Record<string, unknown>> {
    const totals = await this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM usage`,
      )
      .first<Record<string, number>>();
    const { results } = await this.db
      .prepare("SELECT client, COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok FROM usage GROUP BY client ORDER BY calls DESC")
      .all();
    return { ...(totals ?? { calls: 0, ok: 0, input_tokens: 0, output_tokens: 0 }), byClient: results ?? [] };
  }
}
