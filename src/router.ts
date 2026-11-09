import { Gateway, GatewayError, generateRequestId, type Message } from "./gateway.ts";
import { chatMessages, insightsMessages, parseHistory, parseInsightsResult } from "./insights.ts";
import { intentMessages, parseIntentOptions, resolveIntent } from "./intent.ts";
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
  /**
   * Lets a Response go out before work that started it has finished — needed
   * for a streamed completion, whose usage-ledger write only becomes
   * possible once the stream itself ends, well after the client already has
   * the Response. Passed straight through from the Worker's own `ctx.waitUntil`.
   */
  waitUntil: (promise: Promise<unknown>) => void;
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
        embeddings: Boolean(p.embeddings),
      })),
    });
  }

  // One file, three pages: the console, the chat, and insights. All the same
  // document, which picks its tab from the path, so there is still only one
  // asset to ship.
  if (["", "/", "/monitor", "/chat", "/insights", "/dashboard", "/requests", "/keys", "/providers",
       "/analytics", "/limits", "/apps", "/routing", "/alerts", "/settings"].includes(path) && method === "GET") {
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
      const rateCheck = await deps.store.checkClientRate(client);
      if (!rateCheck.allowed) {
        return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Client rate limit exceeded." } }, null, 2), {
          status: 429, headers: { "content-type": "application/json; charset=utf-8", ...CORS, "retry-after": String(rateCheck.retryAfter ?? 60) },
        });
      }
      const body = (await request.json()) as Record<string, any>;
      const messages = parseMessages(body.messages);
      if (!messages) {
        return json({ error: { code: "validation_failed", message: "`messages` must be a non-empty array of {role, content}." } }, 400);
      }
      const requestId = generateRequestId();
      const startMs = Date.now();

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
            keyAttempts: completion.keysTried.length,
            requestId, latencyMs: Date.now() - startMs,
          });
          return json({
            data,
            model: completion.model,
            attempts: completion.attempts,
            usage: { input_tokens: completion.inputTokens, output_tokens: completion.outputTokens },
            x_gateway: { key: completion.keyMasked, request_id: requestId },
          });
        }

        if (body.stream === true) {
          const streamResult = await deps.gateway.chatStream(messages, {
            model: body.model,
            maxTokens: body.max_tokens,
            jsonObject: body.response_format?.type === "json_object",
            requestId,
          });
          deps.waitUntil(streamResult.outcome.then((o) =>
            record(deps, client, {
              model: o.model, keyMasked: streamResult.keyMasked, keyId: streamResult.keyId, provider: streamResult.provider,
              inputTokens: o.inputTokens, outputTokens: o.outputTokens, ok: o.ok, error: o.error,
              keyAttempts: streamResult.keysTried.length,
              requestId, latencyMs: Date.now() - startMs, errorCode: o.ok ? null : "stream_error",
            }),
          ));
          return new Response(streamResult.body, {
            headers: {
              ...CORS,
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              "connection": "keep-alive",
              "x-request-id": requestId,
            },
          });
        }

        const completion = await deps.gateway.chat(messages, {
          model: body.model,
          maxTokens: body.max_tokens,
          jsonObject: body.response_format?.type === "json_object",
          requestId,
        });
        const latencyMs = Date.now() - startMs;
        await record(deps, client, {
          model: completion.model, keyMasked: completion.keyMasked, keyId: completion.keyId, provider: completion.provider,
          inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, ok: true, error: null,
          keyAttempts: completion.keysTried.length,
          requestId, latencyMs,
        });
        return json({
          id: requestId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: completion.model,
          choices: [{ index: 0, message: { role: "assistant", content: completion.content }, finish_reason: completion.finishReason }],
          usage: {
            prompt_tokens: completion.inputTokens ?? 0,
            completion_tokens: completion.outputTokens ?? 0,
            total_tokens: (completion.inputTokens ?? 0) + (completion.outputTokens ?? 0),
          },
          x_gateway: { key: completion.keyMasked, keys_tried: completion.keysTried, request_id: requestId, latency_ms: latencyMs },
        });
      } catch (e) {
        if (e instanceof GatewayError) {
          await recordGatewayError(deps, client, e, requestId, Date.now() - startMs);
          return jsonWithRequestId({ error: { code: e.code, message: e.message, ...e.extra } }, e.status, requestId);
        }
        throw e;
      }
    }

    // ── intent classification ──────────────────────────────────────────────
    if (path === "/v1/intent" && method === "POST") {
      const client = await deps.store.authenticate(bearer);
      if (!client) {
        return json({ error: { code: "unauthorized", message: "Send Authorization: Bearer <client token>." } }, 401);
      }
      const rateCheck2 = await deps.store.checkClientRate(client);
      if (!rateCheck2.allowed) {
        return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Client rate limit exceeded." } }, null, 2), {
          status: 429, headers: { "content-type": "application/json; charset=utf-8", ...CORS, "retry-after": String(rateCheck2.retryAfter ?? 60) },
        });
      }
      const body = (await request.json()) as Record<string, any>;
      const message = typeof body.message === "string" ? body.message : "";
      const options = parseIntentOptions(body.options);
      const fallback = typeof body.default === "string" ? body.default : undefined;
      if (!message || !options) {
        return json(
          { error: { code: "validation_failed", message: "`message` must be a non-empty string and `options` a non-empty array of {id, description}." } },
          400,
        );
      }
      const requestId = generateRequestId();
      const startMs = Date.now();

      try {
        const { data, completion } = await deps.gateway.json(intentMessages(message, options), { expectKey: "id" });
        const result = resolveIntent(data, options, fallback);
        await record(deps, client, {
          model: completion.model, keyMasked: completion.keyMasked, keyId: completion.keyId, provider: completion.provider,
          inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, ok: true, error: null,
          keyAttempts: completion.keysTried.length,
          requestId, latencyMs: Date.now() - startMs,
        });
        return json(result);
      } catch (e) {
        if (e instanceof GatewayError) {
          await recordGatewayError(deps, client, e, requestId, Date.now() - startMs);
          return jsonWithRequestId({ error: { code: e.code, message: e.message, ...e.extra } }, e.status, requestId);
        }
        throw e;
      }
    }

    // OpenAI-compatible embeddings.
    if (path === "/v1/embeddings" && method === "POST") {
      const client = await deps.store.authenticate(bearer);
      if (!client) {
        return json({ error: { code: "unauthorized", message: "Send Authorization: Bearer <client token>." } }, 401);
      }
      const rateCheck3 = await deps.store.checkClientRate(client);
      if (!rateCheck3.allowed) {
        return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Client rate limit exceeded." } }, null, 2), {
          status: 429, headers: { "content-type": "application/json; charset=utf-8", ...CORS, "retry-after": String(rateCheck3.retryAfter ?? 60) },
        });
      }
      const body = (await request.json()) as Record<string, any>;
      const inputs = parseEmbeddingInput(body.input);
      if (!inputs) {
        return json(
          { error: { code: "validation_failed", message: "`input` must be a non-empty string or array of non-empty strings." } },
          400,
        );
      }
      const requestId = generateRequestId();
      const startMs = Date.now();

      try {
        const result = await deps.gateway.embed(inputs, { model: body.model, requestId });
        await record(deps, client, {
          model: result.model, keyMasked: result.keyMasked, keyId: result.keyId, provider: result.provider,
          inputTokens: result.inputTokens, outputTokens: null, ok: true, error: null,
          keyAttempts: result.keysTried.length,
          requestId, latencyMs: Date.now() - startMs,
        });
        return json({
          object: "list",
          data: result.embeddings.map((embedding, index) => ({ object: "embedding", embedding, index })),
          model: result.model,
          usage: { prompt_tokens: result.inputTokens ?? 0, total_tokens: result.inputTokens ?? 0 },
          x_gateway: { key: result.keyMasked, keys_tried: result.keysTried, request_id: requestId },
        });
      } catch (e) {
        if (e instanceof GatewayError) {
          await recordGatewayError(deps, client, e, requestId, Date.now() - startMs);
          return jsonWithRequestId({ error: { code: e.code, message: e.message, ...e.extra } }, e.status, requestId);
        }
        throw e;
      }
    }

    // ── management: admin token only ────────────────────────────────────────
    if (
      path.startsWith("/v1/keys") || path.startsWith("/v1/clients") ||
      path === "/v1/usage" || path === "/v1/models" ||
      path === "/v1/limits" || path === "/v1/latency" || path === "/v1/reliability" || path.startsWith("/v1/insights") ||
      path === "/v1/dashboard" || path.startsWith("/v1/requests") ||
      path.startsWith("/v1/pricing") || path.startsWith("/v1/analytics") ||
      path.startsWith("/v1/applications") || path.startsWith("/v1/routing") ||
      path.startsWith("/v1/alerts") || path.startsWith("/v1/rate-limits") ||
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

    // Observed limit signals only — see Gateway.limitsView for why nothing
    // here is a guessed provider quota.
    if (path === "/v1/limits" && method === "GET") {
      return json(await deps.gateway.limitsView());
    }

    // Retry economics — raw counts; see Store.retryStats for the honest
    // "without retries vs. with retries" reasoning.
    if (path === "/v1/reliability" && method === "GET") {
      return json(await deps.store.retryStats());
    }

    // The gateway reasoning about its own ledger — on demand only, so it
    // never spends a rotation call the admin didn't ask for. Both routes
    // below share the same snapshot; see insights.ts for the prompts.
    // Latency percentiles for the monitoring UI.
    if (path === "/v1/latency" && method === "GET") {
      return json(await deps.store.latencyPercentiles(24));
    }

    if (path === "/v1/insights" && method === "POST") {
      const context = await insightsContext(deps);
      try {
        const { data, completion } = await deps.gateway.json(insightsMessages(context), { expectKey: "headline" });
        const result = parseInsightsResult(data);
        await record(deps, "gateway:insights", {
          model: completion.model, keyMasked: completion.keyMasked, keyId: completion.keyId, provider: completion.provider,
          inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, ok: true, error: null,
          keyAttempts: completion.keysTried.length,
        });
        return json({ ...result, model: completion.model, key: completion.keyMasked, generatedAt: context.generatedAt });
      } catch (e) {
        if (e instanceof GatewayError) {
          await recordGatewayError(deps, "gateway:insights", e);
          return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
        }
        throw e;
      }
    }

    if (path === "/v1/insights/chat" && method === "POST") {
      const body = (await request.json()) as { question?: unknown; history?: unknown };
      const question = typeof body.question === "string" ? body.question.trim() : "";
      const history = parseHistory(body.history);
      if (!question || !history) {
        return json(
          { error: { code: "validation_failed", message: "`question` must be a non-empty string; `history`, if given, an array of {role: \"user\"|\"assistant\", content}." } },
          400,
        );
      }

      const context = await insightsContext(deps);
      try {
        const completion = await deps.gateway.chat(chatMessages(context, question, history));
        await record(deps, "gateway:chat-insights", {
          model: completion.model, keyMasked: completion.keyMasked, keyId: completion.keyId, provider: completion.provider,
          inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, ok: true, error: null,
          keyAttempts: completion.keysTried.length,
        });
        return json({ answer: completion.content, model: completion.model, key: completion.keyMasked });
      } catch (e) {
        if (e instanceof GatewayError) {
          await recordGatewayError(deps, "gateway:chat-insights", e);
          return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status);
        }
        throw e;
      }
    }

    // ── dashboard ──────────────────────────────────────────────────────────
    if (path === "/v1/dashboard" && method === "GET") {
      const metrics = await deps.store.dashboardMetrics();
      const keys = await deps.store.publicKeys();
      const pausedProviders = await deps.store.pausedProviders();
      const nowMs = Date.now();
      const active = keys.filter((k) => !k.benched && !k.paused && !pausedProviders.has(k.provider) && (!k.rateLimitedUntil || Date.parse(k.rateLimitedUntil) <= nowMs)).length;
      const limited = keys.filter((k) => k.rateLimitedUntil && Date.parse(k.rateLimitedUntil) > nowMs && !k.benched && !k.paused).length;
      const benched = keys.filter((k) => k.benched).length;
      const paused = keys.length - keys.filter((k) => !k.paused && !pausedProviders.has(k.provider)).length;
      return json({
        ...metrics,
        keys: { total: keys.length, active, limited, benched, paused },
      });
    }

    // ── request explorer ────────────────────────────────────────────────────
    if (path === "/v1/requests" && method === "GET") {
      const p = url.searchParams;
      return json(await deps.store.searchRequests({
        client: p.get("client") || undefined,
        provider: p.get("provider") || undefined,
        status: p.get("status") === "ok" || p.get("status") === "error" ? p.get("status") as "ok" | "error" : undefined,
        errorCode: p.get("error_code") || undefined,
        from: p.get("from") || undefined,
        to: p.get("to") || undefined,
        minLatency: p.get("min_latency") ? Number(p.get("min_latency")) : undefined,
        limit: p.get("limit") ? Number(p.get("limit")) : undefined,
        offset: p.get("offset") ? Number(p.get("offset")) : undefined,
      }));
    }
    const requestMatch = /^\/v1\/requests\/([^/]+)$/.exec(path);
    if (requestMatch && method === "GET") {
      const row = await deps.store.getRequest(decodeURIComponent(requestMatch[1]!));
      if (!row) return json({ error: { code: "not_found", message: "No request with that id." } }, 404);
      return json(row);
    }

    // ── pricing ─────────────────────────────────────────────────────────────
    if (path === "/v1/pricing" && method === "GET") {
      return json({ pricing: await deps.store.getPricing() });
    }
    if (path === "/v1/pricing" && method === "POST") {
      const body = (await request.json()) as { provider?: unknown; model?: unknown; inputPricePerM?: unknown; outputPricePerM?: unknown };
      const provider = typeof body.provider === "string" ? body.provider : "";
      const model = typeof body.model === "string" ? body.model : "";
      const inp = typeof body.inputPricePerM === "number" ? body.inputPricePerM : NaN;
      const out = typeof body.outputPricePerM === "number" ? body.outputPricePerM : NaN;
      if (!provider || !model || !Number.isFinite(inp) || !Number.isFinite(out)) {
        return json({ error: { code: "validation_failed", message: "provider, model, inputPricePerM, outputPricePerM required." } }, 400);
      }
      await deps.store.setPricing(provider, model, inp, out);
      return json({ ok: true });
    }
    const pricingDelMatch = /^\/v1\/pricing\/([^/]+)\/(.+)$/.exec(path);
    if (pricingDelMatch && method === "DELETE") {
      const ok = await deps.store.deletePricing(decodeURIComponent(pricingDelMatch[1]!), decodeURIComponent(pricingDelMatch[2]!));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }

    // ── cost analytics ──────────────────────────────────────────────────────
    if (path === "/v1/analytics/cost" && method === "GET") {
      const groupBy = url.searchParams.get("group_by") as "client" | "provider" | "model" || "provider";
      const days = Number(url.searchParams.get("days") ?? 30) || 30;
      return json({ data: await deps.store.costAnalytics(groupBy, days) });
    }

    // ── applications ────────────────────────────────────────────────────────
    if (path === "/v1/applications" && method === "GET") {
      return json({ applications: await deps.store.listApplications() });
    }
    if (path === "/v1/applications" && method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
        return json({ error: { code: "validation_failed", message: "name must be lowercase kebab/snake, 1-40 chars." } }, 400);
      }
      const app = await deps.store.createApplication({
        name,
        description: typeof body.description === "string" ? body.description : undefined,
        rateLimitRpm: typeof body.rateLimitRpm === "number" ? body.rateLimitRpm : undefined,
        rateLimitRpd: typeof body.rateLimitRpd === "number" ? body.rateLimitRpd : undefined,
        budgetDaily: typeof body.budgetDaily === "number" ? body.budgetDaily : undefined,
        budgetMonthly: typeof body.budgetMonthly === "number" ? body.budgetMonthly : undefined,
      });
      return json(app, 201);
    }
    const appMatch = /^\/v1\/applications\/(\d+)$/.exec(path);
    if (appMatch && method === "GET") {
      const app = await deps.store.getApplication(Number(appMatch[1]));
      if (!app) return json({ error: { code: "not_found" } }, 404);
      const models = await deps.store.getApplicationModels(Number(appMatch[1]));
      return json({ ...app, models });
    }
    if (appMatch && method === "DELETE") {
      const ok = await deps.store.deleteApplication(Number(appMatch[1]));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }
    const appModelsMatch = /^\/v1\/applications\/(\d+)\/models$/.exec(path);
    if (appModelsMatch && method === "POST") {
      const body = (await request.json()) as { models?: unknown };
      if (!Array.isArray(body.models)) return json({ error: { code: "validation_failed", message: "models must be an array." } }, 400);
      const models = body.models.filter((m: unknown): m is { provider: string; model: string } =>
        !!m && typeof m === "object" && typeof (m as Record<string, unknown>).provider === "string");
      await deps.store.setApplicationModels(Number(appModelsMatch[1]), models.map((m) => ({ provider: m.provider, model: m.model ?? "*" })));
      return json({ ok: true, models: await deps.store.getApplicationModels(Number(appModelsMatch[1])) });
    }

    // ── routing rules ───────────────────────────────────────────────────────
    if (path === "/v1/routing" && method === "GET") {
      const appId = url.searchParams.get("application_id");
      return json({ rules: await deps.store.listRoutingRules(appId ? Number(appId) : undefined) });
    }
    if (path === "/v1/routing" && method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      const ruleType = typeof body.ruleType === "string" ? body.ruleType : "";
      const config = typeof body.config === "string" ? body.config : JSON.stringify(body.config ?? {});
      if (!ruleType) return json({ error: { code: "validation_failed", message: "ruleType required." } }, 400);
      const rule = await deps.store.createRoutingRule({
        applicationId: typeof body.applicationId === "number" ? body.applicationId : undefined,
        priority: typeof body.priority === "number" ? body.priority : 0,
        ruleType, config,
      });
      return json(rule, 201);
    }
    const routingMatch = /^\/v1\/routing\/(\d+)$/.exec(path);
    if (routingMatch && method === "DELETE") {
      const ok = await deps.store.deleteRoutingRule(Number(routingMatch[1]));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }

    // ── alerts ──────────────────────────────────────────────────────────────
    if (path === "/v1/alerts" && method === "GET") {
      return json({ rules: await deps.store.listAlertRules() });
    }
    if (path === "/v1/alerts" && method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const conditionType = typeof body.conditionType === "string" ? body.conditionType : "";
      const threshold = typeof body.threshold === "number" ? body.threshold : NaN;
      const webhookUrl = typeof body.webhookUrl === "string" ? body.webhookUrl : "";
      if (!name || !conditionType || !Number.isFinite(threshold) || !webhookUrl) {
        return json({ error: { code: "validation_failed", message: "name, conditionType, threshold, webhookUrl required." } }, 400);
      }
      const rule = await deps.store.createAlertRule({
        name, conditionType, threshold,
        windowMinutes: typeof body.windowMinutes === "number" ? body.windowMinutes : 5,
        webhookUrl,
        cooldownMinutes: typeof body.cooldownMinutes === "number" ? body.cooldownMinutes : undefined,
      });
      return json(rule, 201);
    }
    const alertMatch = /^\/v1\/alerts\/(\d+)$/.exec(path);
    if (alertMatch && method === "DELETE") {
      const ok = await deps.store.deleteAlertRule(Number(alertMatch[1]));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }
    if (path === "/v1/alerts/history" && method === "GET") {
      const ruleId = url.searchParams.get("rule_id");
      return json({ history: await deps.store.alertHistory(ruleId ? Number(ruleId) : undefined) });
    }

    // ── client rate limits ──────────────────────────────────────────────────
    if (path === "/v1/rate-limits" && method === "GET") {
      const client = url.searchParams.get("client");
      if (client) {
        const limit = await deps.store.getClientRateLimit(client);
        return json(limit ?? { requestsPerMinute: null, requestsPerDay: null });
      }
      return json({ note: "Pass ?client=name to check a client's rate limits." });
    }
    if (path === "/v1/rate-limits" && method === "POST") {
      const body = (await request.json()) as { client?: unknown; requestsPerMinute?: unknown; requestsPerDay?: unknown };
      const client = typeof body.client === "string" ? body.client : "";
      if (!client) return json({ error: { code: "validation_failed", message: "client required." } }, 400);
      const rpm = typeof body.requestsPerMinute === "number" ? body.requestsPerMinute : null;
      const rpd = typeof body.requestsPerDay === "number" ? body.requestsPerDay : null;
      await deps.store.setClientRateLimit(client, rpm, rpd);
      return json({ ok: true, client, requestsPerMinute: rpm, requestsPerDay: rpd });
    }
    const rateLimitDelMatch = /^\/v1\/rate-limits\/([^/]+)$/.exec(path);
    if (rateLimitDelMatch && method === "DELETE") {
      const ok = await deps.store.deleteClientRateLimit(decodeURIComponent(rateLimitDelMatch[1]!));
      return json(ok ? { ok: true } : { error: { code: "not_found" } }, ok ? 200 : 404);
    }

    return json({ error: { code: "not_found", message: `No route for ${method} ${path}.` } }, 404);
  } catch (e) {
    if (e instanceof SyntaxError) {
      return json({ error: { code: "bad_json", message: e.message } }, 400);
    }
    // Never leak raw Error.message — it can contain stack traces, file paths,
    // or (via a provider error class that was not caught above) a key.
    return json({ error: { code: "internal", message: "An unexpected error occurred." } }, 500);
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
  keyAttempts: number | null;
  requestId?: string | null;
  latencyMs?: number | null;
  errorCode?: string | null;
}) {
  try {
    await deps.store.record({ client, ...entry });
  } catch {
    // Accounting must never be the reason an answer does not reach the caller.
  }
}

/** Shared error-recording path for every GatewayError caught in an inference endpoint. */
async function recordGatewayError(
  deps: RouterDeps,
  client: string,
  e: GatewayError,
  requestId?: string,
  latencyMs?: number,
) {
  await record(deps, client, {
    model: null, keyMasked: e.keyMasked, keyId: e.keyId, provider: e.provider,
    inputTokens: null, outputTokens: null, ok: false, error: e.message,
    keyAttempts: e.keysTried.length || null,
    requestId: requestId ?? (e.requestId || null),
    latencyMs: latencyMs ?? null,
    errorCode: e.code,
  });
}

function jsonWithRequestId(data: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, "x-request-id": requestId },
  });
}

/**
 * The JSON snapshot both /v1/insights and /v1/insights/chat ground their
 * reply in — usage totals, observed limit signals, retry economics, clients,
 * and the most recent failures. Everything in it already passed through
 * Store's own masking/redaction on the way in, so there is nothing here an
 * admin couldn't already see on the Console, Limits & health, and
 * Reliability cards.
 */
async function insightsContext(deps: RouterDeps) {
  const [summary, limits, reliability, recent, clients] = await Promise.all([
    deps.store.summary(),
    deps.gateway.limitsView(),
    deps.store.retryStats(),
    deps.store.usage(25),
    deps.store.clients(),
  ]);
  const recentFailures = (recent as Record<string, unknown>[])
    .filter((r) => !r.ok)
    .slice(0, 10)
    .map((r) => ({
      at: r.at, client: r.client, provider: r.provider,
      error: typeof r.error === "string" ? r.error.slice(0, 200) : r.error,
    }));

  return {
    generatedAt: new Date().toISOString(),
    usage: {
      calls: Number(summary.calls ?? 0),
      ok: Number(summary.ok ?? 0),
      inputTokens: Number(summary.input_tokens ?? 0),
      outputTokens: Number(summary.output_tokens ?? 0),
      byProvider: summary.byProvider,
    },
    limits,
    reliability,
    clients,
    recentFailures,
  };
}

/** A single non-empty string, or an array of them — the two shapes OpenAI's embeddings API accepts. */
function parseEmbeddingInput(raw: unknown): string[] | null {
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list || list.length === 0) return null;
  if (!list.every((v): v is string => typeof v === "string" && v.length > 0)) return null;
  return list;
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
