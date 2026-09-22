import { Gateway, GatewayError, type Message } from "./gateway.ts";
import { isKnownProvider, PROVIDERS, providerOf } from "./providers.ts";
import { mask, Store } from "./store.ts";
import { ADMIN_HTML } from "./ui.generated.ts";

/**
 * REST surface. Two shapes on purpose:
 *
 *   POST /v1/chat/completions   OpenAI-compatible, so a client already pointed
 *                               at OpenRouter moves here by changing one URL
 *                               and one key, with no other code change.
 *   POST /v1/json               Richer: salvages and validates server side, so
 *                               every caller gets the hardening for free.
 *
 * Thin by design — parse, delegate, serialise.
 */

export interface RouterDeps {
  store: Store;
  gateway: Gateway;
  /** Gates the admin UI and every key/client endpoint. */
  adminToken: string;
}

export async function handle(request: Request, deps: RouterDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  if (path === "/health") {
    return json({ ok: true, keys: (await deps.store.keys()).length, version: "0.1.0" });
  }

  // Which providers a key can be added for. No secrets in it, so it is public
  // the same way /health is — the admin console uses it to build the "add
  // keys" provider picker without hard-coding the list twice. `paused` is
  // included too — that state isn't sensitive, only changing it is (gated
  // below), and the console needs it to render the pause/resume toggle.
  if (path === "/v1/providers" && method === "GET") {
    const paused = await deps.store.pausedProviders();
    return json({
      providers: Object.values(PROVIDERS).map((p) => ({
        id: p.id,
        label: p.label,
        keyHint: p.keyHint,
        paused: paused.has(p.id),
      })),
    });
  }

  // One file, two pages: the console and the chat. Both are the same document,
  // which picks its tab from the path, so there is still only one asset to ship.
  if ((path === "/" || path === "/chat") && method === "GET") {
    return new Response(ADMIN_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy":
          "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      },
    });
  }

  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const isAdmin = Boolean(deps.adminToken) && timingSafeEqual(bearer, deps.adminToken);

  try {
    // ── inference ───────────────────────────────────────────────────────────
    if (path === "/v1/chat/completions" || path === "/v1/json") {
      const client = await deps.store.authenticate(bearer);
      if (!client) {
        return json({ error: { code: "unauthorized", message: "Send Authorization: Bearer <client token>." } }, 401);
      }
      const body = (await request.json()) as Record<string, any>;
      const messages = parseMessages(body.messages);
      if (!messages) {
        return json({ error: { code: "validation_failed", message: "`messages` must be a non-empty array of {role, content}." } }, 400);
      }

      try {
        if (path === "/v1/json") {
          const { data, completion } = await deps.gateway.json(messages, {
            model: body.model,
            maxTokens: body.max_tokens,
            expectKey: body.expect_key,
            maxAttempts: body.max_attempts,
          });
          await record(deps, client, {
            model: completion.model, keyMasked: completion.keyMasked, keyId: completion.keyId, provider: completion.provider,
            inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, ok: true, error: null,
          });
          return json({
            data,
            model: completion.model,
            attempts: completion.attempts,
            usage: { input_tokens: completion.inputTokens, output_tokens: completion.outputTokens },
            x_gateway: { key: completion.keyMasked },
          });
        }

        const completion = await deps.gateway.chat(messages, {
          model: body.model,
          maxTokens: body.max_tokens,
          jsonObject: body.response_format?.type === "json_object",
        });
        await record(deps, client, {
          model: completion.model, keyMasked: completion.keyMasked, keyId: completion.keyId, provider: completion.provider,
          inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, ok: true, error: null,
        });
        return json({
          id: `gw-${Date.now().toString(16)}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: completion.model,
          choices: [{ index: 0, message: { role: "assistant", content: completion.content }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: completion.inputTokens ?? 0,
            completion_tokens: completion.outputTokens ?? 0,
            total_tokens: (completion.inputTokens ?? 0) + (completion.outputTokens ?? 0),
          },
          // Additive; a strict OpenAI client ignores it, and it is the only way
          // to see which key served a call.
          x_gateway: { key: completion.keyMasked, keys_tried: completion.keysTried },
        });
      } catch (e) {
        if (e instanceof GatewayError) {
          await record(deps, client, {
            model: null, keyMasked: e.keyMasked, keyId: e.keyId, provider: e.provider,
            inputTokens: null, outputTokens: null, ok: false, error: e.message,
          });
          return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
        }
        throw e;
      }
    }

    // ── management: admin token only ────────────────────────────────────────
    if (
      path.startsWith("/v1/keys") || path.startsWith("/v1/clients") ||
      path === "/v1/usage" || path === "/v1/models" ||
      /^\/v1\/providers\/[^/]+\/(pause|resume)$/.test(path)
    ) {
      if (!deps.adminToken) {
        return json({ error: { code: "no_admin_token", message: "ADMIN_TOKEN is not set, so management is disabled." } }, 503);
      }
      if (!isAdmin) {
        return json({ error: { code: "unauthorized", message: "Admin token required." } }, 401);
      }
    }

    if (path === "/v1/models" && method === "GET") {
      return json({ models: await deps.gateway.modelSettings() });
    }

    if (path === "/v1/models" && method === "POST") {
      const body = (await request.json()) as { provider?: unknown; model?: unknown };
      const providerId = typeof body.provider === "string" ? body.provider : "";
      const model = typeof body.model === "string" ? body.model : "";
      const ok = await deps.gateway.setModel(providerId, model);
      if (!ok) {
        return json(
          { error: { code: "validation_failed", message: `Unknown provider "${providerId}". See GET /v1/providers.` } },
          400,
        );
      }
      return json({ models: await deps.gateway.modelSettings() });
    }

    if (path === "/v1/keys" && method === "GET") {
      return json(await deps.gateway.queueView());
    }

    if (path === "/v1/keys" && method === "POST") {
      const body = (await request.json()) as { keys?: unknown; label?: unknown; provider?: unknown };
      const raw = typeof body.keys === "string" ? body.keys : "";
      const label = typeof body.label === "string" ? body.label : "";
      const providerId = typeof body.provider === "string" && body.provider ? body.provider : "openrouter";
      const candidates = [...new Set(raw.split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean))];

      if (!isKnownProvider(providerId)) {
        return json(
          { error: { code: "validation_failed", message: `Unknown provider "${providerId}". See GET /v1/providers.` } },
          400,
        );
      }
      const provider = providerOf(providerId);

      const added = [];
      const skipped: string[] = [];
      for (const key of candidates) {
        if (!provider.keyShape.test(key)) {
          skipped.push(`${mask(key)} — does not look like a ${provider.label} key (expected ${provider.keyHint})`);
          continue;
        }
        const stored = await deps.store.addKey(key, label, providerId);
        if (stored) added.push(stored);
        else skipped.push(`${mask(key)} — already stored`);
      }
      return json(
        { added, skipped, note: added.length ? "Stored. A key is never shown again — only a masked form." : "Nothing stored." },
        added.length ? 201 : 400,
      );
    }

    // Probe one key by name, outside the rotation, so a typo is caught at the
    // moment it is pasted rather than by a caller a week later.
    const probeMatch = /^\/v1\/keys\/(\d+)\/test$/.exec(path);
    if (probeMatch && method === "POST") {
      const result = await deps.gateway.probe(Number(probeMatch[1]));
      if (!result) return json({ error: { code: "not_found", message: "No key with that id." } }, 404);
      return json(result);
    }

    const keyMatch = /^\/v1\/keys\/(\d+)$/.exec(path);
    if (keyMatch && method === "DELETE") {
      const ok = await deps.store.removeKey(Number(keyMatch[1]));
      return json(ok ? { ok: true, removed: Number(keyMatch[1]) } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }

    // Manually clears a key's benched state — the same effect a successful
    // call has, for when an admin has fixed whatever was wrong upstream and
    // does not want to wait for the all-benched fallback in Gateway.chat to
    // happen to try it again.
    const unbenchMatch = /^\/v1\/keys\/(\d+)\/unbench$/.exec(path);
    if (unbenchMatch && method === "POST") {
      const ok = await deps.store.clearFailures(Number(unbenchMatch[1]));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }

    // Manual "stop using this key" — unlike unbench above, not evidence-
    // driven and not self-healing. See the schema comment on paused_at.
    const keyPauseMatch = /^\/v1\/keys\/(\d+)\/pause$/.exec(path);
    if (keyPauseMatch && method === "POST") {
      const ok = await deps.store.pauseKey(Number(keyPauseMatch[1]));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }

    const keyResumeMatch = /^\/v1\/keys\/(\d+)\/resume$/.exec(path);
    if (keyResumeMatch && method === "POST") {
      const ok = await deps.store.resumeKey(Number(keyResumeMatch[1]));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }

    // The provider-wide equivalent — stops every key on that provider at
    // once, present and future, without touching any individual key's own
    // paused/benched state.
    const providerPauseMatch = /^\/v1\/providers\/([^/]+)\/pause$/.exec(path);
    if (providerPauseMatch && method === "POST") {
      const id = providerPauseMatch[1]!;
      if (!isKnownProvider(id)) return json({ error: { code: "not_found", message: "No provider with that id." } }, 404);
      await deps.store.pauseProvider(id);
      return json({ ok: true, provider: id, paused: true });
    }

    const providerResumeMatch = /^\/v1\/providers\/([^/]+)\/resume$/.exec(path);
    if (providerResumeMatch && method === "POST") {
      const id = providerResumeMatch[1]!;
      if (!isKnownProvider(id)) return json({ error: { code: "not_found", message: "No provider with that id." } }, 404);
      await deps.store.resumeProvider(id);
      return json({ ok: true, provider: id, paused: false });
    }

    if (path === "/v1/clients" && method === "GET") {
      return json({ clients: await deps.store.clients() });
    }

    if (path === "/v1/clients" && method === "POST") {
      const body = (await request.json()) as { name?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
        return json({ error: { code: "validation_failed", message: "name must be lowercase kebab/snake, 1-40 chars." } }, 400);
      }
      return json(
        {
          name,
          token: await deps.store.issueClient(name),
          note: "Copy this now — it is hashed on save and cannot be shown again.",
        },
        201,
      );
    }

    const clientMatch = /^\/v1\/clients\/([^/]+)$/.exec(path);
    if (clientMatch && method === "DELETE") {
      const ok = await deps.store.revokeClient(decodeURIComponent(clientMatch[1]!));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }

    if (path === "/v1/usage" && method === "GET") {
      return json({
        summary: await deps.store.summary(),
        recent: await deps.store.usage(Number(url.searchParams.get("limit") ?? 50) || 50),
      });
    }

    return json({ error: { code: "not_found", message: `No route for ${method} ${path}.` } }, 404);
  } catch (e) {
    if (e instanceof SyntaxError) {
      return json({ error: { code: "bad_json", message: e.message } }, 400);
    }
    return json({ error: { code: "internal", message: (e as Error).message } }, 500);
  }
}

async function record(deps: RouterDeps, client: string, entry: {
  model: string | null;
  keyMasked: string | null;
  keyId: number | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ok: boolean;
  error: string | null;
}) {
  try {
    await deps.store.record({ client, ...entry });
  } catch {
    // Accounting must never be the reason an answer does not reach the caller.
  }
}

function parseMessages(raw: unknown): Message[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Message[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "system" && role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;
    out.push({ role, content });
  }
  return out;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function cors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

/** Constant-time compare so the admin token can't be recovered by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
