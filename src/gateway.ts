import { extractJson, SalvageError } from "./salvage.ts";
import { isKnownProvider, providerIds, providerOf } from "./providers.ts";
import { Store, type ApiKeyRow } from "./store.ts";

/**
 * The gateway itself: rotation, retry, salvaging. The router is a thin adapter
 * over this, so every rule is written once and is testable without HTTP.
 *
 * Keys queue together across providers — the queue does not care whose key is
 * next, only that it is a key. What varies per provider is just the upstream
 * URL and the model asked for when nothing more specific was given; both come
 * from `src/providers.ts`, keyed off `key.provider`.
 */

export const RETRY_INSTRUCTION =
  "That was not usable. Reply with ONLY a JSON object — no prose, no code fences.";

export class GatewayError extends Error {
  status = 502;
  code = "upstream_error";
  extra: Record<string, unknown> = {};
}

export class NoKeysConfigured extends GatewayError {
  override status = 503;
  override code = "no_keys_configured";
}

export class RateLimited extends GatewayError {
  override status = 429;
  override code = "rate_limited";
  constructor(message: string, resetAt: string | null) {
    super(message);
    this.extra = { reset_at: resetAt };
  }
}

export class BadModelOutput extends GatewayError {
  override status = 502;
  override code = "bad_model_output";
}

/**
 * The provider rejected the request itself (a 400), not the key or the
 * model behind it. Every key would send the identical body and get the
 * identical rejection, so this is the one upstream failure `Gateway.chat`
 * does not rotate past — see the comment there.
 */
export class BadRequest extends GatewayError {
  override status = 400;
  override code = "bad_request";
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What a single key looks like to the provider right now. Masked, always. */
export interface ProbeResult {
  /** True when the provider recognised the key — a spent key is still valid. */
  ok: boolean;
  status: "live" | "rate_limited" | "failed";
  key: string;
  message: string;
  resetAt?: string | null;
}

export interface Completion {
  content: string;
  /** The model that ACTUALLY served it — the free pool differs per call. */
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  keyMasked: string;
  attempts: number;
  keysTried: string[];
}

export interface GatewayConfig {
  /** The OpenRouter default — kept under its old name for compatibility. */
  defaultModel: string;
  /** Per-provider default-model overrides, keyed by provider id. */
  providerDefaultModels?: Partial<Record<string, string>>;
  /** Overrides every provider's upstream URL. Exists so tests can point at a stub. */
  upstreamUrl?: string;
  referer?: string;
  title?: string;
  timeoutMs?: number;
}

export class Gateway {
  constructor(private store: Store, private config: GatewayConfig) {}

  /** The provider headers for one key. The only place a key is written out. */
  private headers(key: ApiKeyRow): Record<string, string> {
    return {
      Authorization: `Bearer ${key.key}`,
      "Content-Type": "application/json",
      ...(this.config.referer ? { "HTTP-Referer": this.config.referer } : {}),
      ...(this.config.title ? { "X-Title": this.config.title } : {}),
    };
  }

  private urlFor(providerId: string): string {
    return this.config.upstreamUrl ?? providerOf(providerId).upstreamUrl;
  }

  /**
   * The model to ask for on a key with this provider, when nothing more
   * specific applies, in order: an override set from the admin console (a
   * provider renaming or retiring a model is then a text field, not a
   * deploy), a `wrangler.toml` env override, else the registry's default.
   * `defaultModel` keeps its old meaning — the OpenRouter env override —
   * rather than silently becoming every provider's fallback.
   */
  private modelFor(providerId: string, overrides: Record<string, string>): string {
    return (
      overrides[providerId] ??
      this.config.providerDefaultModels?.[providerId] ??
      (providerId === "openrouter" ? this.config.defaultModel : undefined) ??
      providerOf(providerId).defaultModel
    );
  }

  private async post(
    messages: Message[],
    key: ApiKeyRow,
    model: string,
    maxTokens: number | undefined,
    jsonObject: boolean,
  ): Promise<Completion> {
    const body: Record<string, unknown> = { model, messages };
    if (jsonObject) {
      // Stops compliant models wrapping the object in prose. Not every model in
      // the free pool honours it, hence extractJson.
      body.response_format = { type: "json_object" };
    }
    if (maxTokens) body.max_tokens = maxTokens;

    let response: Response;
    try {
      response = await fetch(this.urlFor(key.provider), {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 45_000),
      });
    } catch (e) {
      throw new GatewayError(`Could not reach the upstream provider: ${redact((e as Error).message, key)}`);
    }

    if (response.status === 429) {
      const { message, resetAt } = await rateLimitDetails(response);
      throw new RateLimited(message, resetAt);
    }
    if (!response.ok) {
      // The provider's own sentence rather than its JSON envelope, and redacted:
      // an upstream that echoes back the credential it rejected must not turn a
      // 401 into the one thing this service never lets out.
      const message = `The provider returned ${response.status}: ${redact(await providerMessage(response), key)}`;
      // A 400 is the gateway's own request being unacceptable — a parameter
      // the model does not support, most likely — not a verdict on the key.
      // See BadRequest and the branch for it in chat().
      throw response.status === 400 ? new BadRequest(message) : new GatewayError(message);
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string; reasoning?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const message = payload.choices?.[0]?.message;
    // Reasoning models in the free pool sometimes spend the whole token budget
    // thinking and return an empty `content` with the answer in `reasoning`.
    // Taking the reasoning is worse than a clean answer and better than nothing.
    const content = message?.content || message?.reasoning;
    if (!content) {
      throw new BadModelOutput(
        `${payload.model ?? model} returned an empty message` +
          (payload.usage?.completion_tokens
            ? ` after ${payload.usage.completion_tokens} tokens — it likely spent the budget reasoning.`
            : "."),
      );
    }

    return {
      content,
      model: payload.model ?? model,
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
      keyMasked: key.masked,
      attempts: 1,
      keysTried: [],
    };
  }

  /**
   * One completion, rotating keys until one answers or every quota is spent.
   *
   * Take the key at the front, use it, push it to the back. A 429 pushes that
   * key back too and the next one serves the same request — a 429 does not
   * consume quota, so there is nothing to bench and nothing to remember about
   * which keys are "spent". The queue sorts itself out.
   *
   * A reply that arrives but is unusable — an empty message, most often a
   * reasoning model that spent its whole budget thinking — also moves to the
   * next key. That is not really about the key: `openrouter/free` routes each
   * call to a different model, so the next key is the cheapest way to reach a
   * different model, and one bad responder in the pool should not fail a
   * request the pool as a whole can serve.
   *
   * Everything else the provider (or the network) can throw at a call also
   * rotates to the next key rather than aborting the whole request — a
   * network failure, a stale/revoked key (401/403), a model id an admin has
   * not fixed yet (404), an upstream 5xx. The one exception is `BadRequest`
   * (a 400): that means this gateway's own request was unacceptable, every
   * key would get the identical body and the identical rejection, and
   * rotating would just spend healthy keys to relearn what is already known.
   *
   * Unlike a 429 or an empty completion, this class of failure *is* evidence
   * the key (or its provider) is actually broken, so — 400 aside — it also
   * counts toward `Store.recordFailure`: enough of them in a row benches the
   * key, and normal rotation (below) then skips it. A provider-wide problem,
   * like a retired model id that 404s for every key on that provider, benches
   * every one of that provider's keys the same way with no separate "provider
   * health" mechanism needed — the per-key bench already covers it. Benching
   * is not allowed to wedge the queue shut, though: if every key is currently
   * benched, this still tries all of them, in the usual order, rather than
   * behaving as if none were configured. That is simpler than a second,
   * time-based path back into rotation (mirroring how a 429 resets at its own
   * reset time) and it self-heals the same way a real fix would — a call that
   * succeeds clears the bench, exactly like the admin console's manual
   * "un-bench" button.
   */
  async chat(
    messages: Message[],
    opts: { model?: string; maxTokens?: number; jsonObject?: boolean } = {},
  ): Promise<Completion> {
    const allKeys = await this.store.keys();
    if (allKeys.length === 0) {
      throw new NoKeysConfigured(
          "No provider key is configured on the gateway. Add one at the admin page.",
        );
    }
    const active = allKeys.filter((k) => !k.benched_at);
    const keys = active.length > 0 ? active : allKeys;

    const overrides = await this.store.modelOverrides();
    const tried: string[] = [];
    let lastRateLimit: RateLimited | null = null;
    let lastUnusable: BadModelOutput | null = null;
    let lastHardFailure: GatewayError | null = null;

    for (const key of keys) {
      tried.push(key.masked);
      try {
        // A caller-supplied model is only meaningful for the provider whose
        // namespace it names. Only OpenRouter's `model` has ever been safe to
        // pass through generically — everyone else's model ids are provider-
        // specific, so those keys stick to their own configured default.
        const model = key.provider === "openrouter" && opts.model ? opts.model : this.modelFor(key.provider, overrides);
        const completion = await this.post(messages, key, model, opts.maxTokens, !!opts.jsonObject);
        await this.store.pushToBack(key.id, false);
        await this.store.clearFailures(key.id);
        completion.keysTried = tried;
        return completion;
      } catch (e) {
        if (e instanceof RateLimited) {
          await this.store.pushToBack(key.id, true);
          lastRateLimit = e;
          continue;
        }
        if (e instanceof BadModelOutput) {
          // The key worked; the model behind it did not. Spend the call and
          // move on, so the next attempt lands on a different model. Not
          // counted as a key failure, for the same reason.
          await this.store.pushToBack(key.id, false);
          lastUnusable = e;
          continue;
        }
        if (e instanceof BadRequest) {
          // Not this key's fault, and every other key would fail identically
          // — see the class comment. Nothing moves in the queue either: this
          // attempt never really tested the key.
          throw e;
        }
        if (e instanceof GatewayError) {
          await this.store.pushToBack(key.id, false);
          await this.store.recordFailure(key.id, e.message);
          lastHardFailure = e;
          continue;
        }
        throw e;
      }
    }

    throw (
      lastRateLimit ??
      lastUnusable ??
      lastHardFailure ??
      new GatewayError("Every configured key was rejected.")
    );
  }

  /**
   * A completion salvaged into a JSON object, retrying once on a bad reply.
   * Because the free pool routes to a different model per call, a retry often
   * lands on one that behaves, so a single bad responder should not fail it.
   */
  async json(
    messages: Message[],
    opts: { model?: string; maxTokens?: number; expectKey?: string; maxAttempts?: number } = {},
  ): Promise<{ data: Record<string, unknown>; completion: Completion }> {
    const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 2, 4));
    let conversation = messages;
    let lastError: SalvageError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const completion = await this.chat(conversation, { ...opts, jsonObject: true });
      try {
        const data = extractJson(completion.content, opts.expectKey);
        completion.attempts = attempt;
        return { data, completion };
      } catch (e) {
        if (!(e instanceof SalvageError)) throw e;
        lastError = e;
        conversation = [
          ...messages,
          { role: "assistant", content: completion.content.slice(0, 1000) },
          { role: "user", content: RETRY_INSTRUCTION },
        ];
      }
    }

    throw new BadModelOutput(
        `The model would not return usable JSON after ${maxAttempts} attempts: ${lastError?.message}`,
      );
  }

  /**
   * Asks the provider whether one specific key works, with the smallest call it
   * will accept — one word, one token back.
   *
   * Deliberately outside the rotation: it names the key, does not fall through
   * to the next one, and does not move anything in the queue. A typo should be
   * caught the moment it is pasted, not a week later when every caller has been
   * quietly falling back to whichever key still answers.
   *
   * A 429 is a pass, not a failure — the provider only rate limits a key it
   * recognises, so the key is good and merely spent.
   *
   * Null when there is no key with that id.
   */
  async probe(id: number): Promise<ProbeResult | null> {
    const key = (await this.store.keys()).find((k) => k.id === id);
    if (!key) return null;

    let response: Response;
    try {
      response = await fetch(this.urlFor(key.provider), {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify({
          model: this.modelFor(key.provider, await this.store.modelOverrides()),
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(Math.min(this.config.timeoutMs ?? 45_000, 15_000)),
      });
    } catch (e) {
      return {
        ok: false,
        status: "failed",
        key: key.masked,
        message: `Could not reach the provider: ${redact((e as Error).message, key)}`,
      };
    }

    if (response.status === 429) {
      const { resetAt } = await rateLimitDetails(response);
      return {
        ok: true,
        status: "rate_limited",
        key: key.masked,
        resetAt,
        message: resetAt
          ? `Valid, but its quota is spent until ${resetAt.slice(0, 16).replace("T", " ")} UTC.`
          : "Valid, but its quota is spent right now. Only a key the provider recognises gets a 429.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: "failed",
        key: key.masked,
        message: `The provider returned ${response.status}: ${redact(await providerMessage(response), key)}`,
      };
    }
    // Content is not read on purpose: a model that answers with nothing under a
    // one-token cap still proves the key authenticated.
    return { ok: true, status: "live", key: key.masked, message: "The provider accepted this key." };
  }

  /** Key queue health. Masked values only — nothing here can make a call. */
  async queueView(): Promise<Record<string, unknown>> {
    const keys = await this.store.publicKeys();
    // "next" mirrors what chat() would actually do: the front of the active
    // (unbenched) keys, or — if every key is benched — the front of all of
    // them, since that is what the fallback in chat() falls back to.
    const active = keys.filter((k) => !k.benched);
    const nextId = (active[0] ?? keys[0])?.id;
    const benchedCount = keys.length - active.length;
    return {
      configured: keys.length,
      queue: keys.map((k) => ({ ...k, next: k.id === nextId })),
      note: keys.length
        ? `${keys.length} key${keys.length === 1 ? "" : "s"} in rotation` +
          (benchedCount ? `, ${benchedCount} benched after repeated failures` : "") +
          `. Each call takes the key at the front and sends it to the back, so the free tier's ` +
          "daily cap multiplies instead of being spent down on one key."
        : "No keys configured — every call will fail with 503 until one is added.",
    };
  }

  /**
   * Every provider's model, and where it comes from — for the admin console's
   * "default models" card. `effective` is exactly what `modelFor` would pick.
   */
  async modelSettings(): Promise<
    { provider: string; label: string; registryDefault: string; override: string | null; effective: string }[]
  > {
    const overrides = await this.store.modelOverrides();
    return providerIds().map((id) => {
      const def = providerOf(id);
      return {
        provider: id,
        label: def.label,
        registryDefault: def.defaultModel,
        override: overrides[id] ?? null,
        effective: this.modelFor(id, overrides),
      };
    });
  }

  /** Empty `model` clears the override, reverting to the registry (or env) default. False for an unknown provider. */
  async setModel(provider: string, model: string): Promise<boolean> {
    if (!isKnownProvider(provider)) return false;
    await this.store.setModelOverride(provider, model.trim());
    return true;
  }
}

/**
 * The one rule, enforced on the way out: a key goes in and never comes back.
 * Anything quoting the provider passes through here, because the provider is
 * free to echo the credential it just refused.
 */
function redact(text: string, key: ApiKeyRow): string {
  return text.split(key.key).join(key.masked);
}

/** The provider's own sentence where there is one, the raw body where not. */
async function providerMessage(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 400);
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message =
      typeof body.error === "string" ? body.error : body.error?.message ?? body.message;
    if (message) return String(message).slice(0, 300);
  } catch {
    // Not every provider answers a rejection in JSON.
  }
  return text.slice(0, 300) || response.statusText || "no detail given";
}

/** A sentence the caller can act on, plus when it is worth retrying. */
async function rateLimitDetails(response: Response): Promise<{ message: string; resetAt: string | null }> {
  let resetAt: string | null = null;
  try {
    const body = (await response.json()) as {
      error?: { metadata?: { headers?: Record<string, string> } };
    };
    const raw = body.error?.metadata?.headers?.["X-RateLimit-Reset"];
    if (raw) resetAt = new Date(Number(raw)).toISOString();
  } catch {
    // Providers vary; an absent reset time is not worth failing over.
  }
  let message = "The upstream provider's request quota is used up.";
  if (resetAt) message += ` It resets at ${resetAt.slice(0, 16).replace("T", " ")} UTC.`;
  message += " Try again after that, or add another key to the gateway.";
  return { message, resetAt };
}
