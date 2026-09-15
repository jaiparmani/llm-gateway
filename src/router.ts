import { Gateway, GatewayError, type Message } from "./gateway.ts";
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

/** Anything else is a typo, and a typo stored 401s every call for a week. */
const KEY_SHAPE = /^sk-or-v1-[A-Za-z0-9]{32,}$/;

export async function handle(request: Request, deps: RouterDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  if (path === "/health") {
    return json({ ok: true, keys: (await deps.store.keys()).length, version: "0.1.0" });
  }

  if (path === "/" && method === "GET") {
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
          await record(deps, client, completion, null);
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
        await record(deps, client, completion, null);
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
          await record(deps, client, null, e.message);
          return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
        }
        throw e;
      }
    }

    // ── management: admin token only ────────────────────────────────────────
    if (path.startsWith("/v1/keys") || path.startsWith("/v1/clients") || path === "/v1/usage") {
      if (!deps.adminToken) {
        return json({ error: { code: "no_admin_token", message: "ADMIN_TOKEN is not set, so management is disabled." } }, 503);
      }
      if (!isAdmin) {
        return json({ error: { code: "unauthorized", message: "Admin token required." } }, 401);
      }
    }

    if (path === "/v1/keys" && method === "GET") {
      return json(await deps.gateway.queueView());
    }

    if (path === "/v1/keys" && method === "POST") {
      const body = (await request.json()) as { keys?: unknown; label?: unknown };
      const raw = typeof body.keys === "string" ? body.keys : "";
      const label = typeof body.label === "string" ? body.label : "";
      const candidates = [...new Set(raw.split(/[\s,;]+/).map((k) => k.trim()).filter(Boolean))];

      const added = [];
      const skipped: string[] = [];
      for (const key of candidates) {
        if (!KEY_SHAPE.test(key)) {
          skipped.push(`${mask(key)} — does not look like an OpenRouter key (expected sk-or-v1-…)`);
          continue;
        }
        const stored = await deps.store.addKey(key, label);
        if (stored) added.push(stored);
        else skipped.push(`${mask(key)} — already stored`);
      }
      return json(
        { added, skipped, note: added.length ? "Stored. A key is never shown again — only a masked form." : "Nothing stored." },
        added.length ? 201 : 400,
      );
    }

    const keyMatch = /^\/v1\/keys\/(\d+)$/.exec(path);
    if (keyMatch && method === "DELETE") {
      const ok = await deps.store.removeKey(Number(keyMatch[1]));
      return json(ok ? { ok: true, removed: Number(keyMatch[1]) } : { error: { code: "not_found" } }, ok ? 200 : 404);
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

async function record(deps: RouterDeps, client: string, completion: { model: string; keyMasked: string; inputTokens: number | null; outputTokens: number | null } | null, error: string | null) {
  try {
    await deps.store.record({
      client,
      model: completion?.model ?? null,
      keyMasked: completion?.keyMasked ?? null,
      inputTokens: completion?.inputTokens ?? null,
      outputTokens: completion?.outputTokens ?? null,
      ok: error === null,
      error,
    });
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
