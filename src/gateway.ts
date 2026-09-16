import { extractJson, SalvageError } from "./salvage.ts";
import { Store, type ApiKeyRow } from "./store.ts";

/**
 * The gateway itself: rotation, retry, salvaging. The router is a thin adapter
 * over this, so every rule is written once and is testable without HTTP.
 */

const UPSTREAM = "https://openrouter.ai/api/v1/chat/completions";

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
  defaultModel: string;
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
      response = await fetch(this.config.upstreamUrl ?? UPSTREAM, {
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
      throw new GatewayError(
          `The provider returned ${response.status}: ${redact(await providerMessage(response), key)}`,
        );
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
   */
  async chat(
    messages: Message[],
    opts: { model?: string; maxTokens?: number; jsonObject?: boolean } = {},
  ): Promise<Completion> {
    const keys = await this.store.keys();
    if (keys.length === 0) {
      throw new NoKeysConfigured(
          "No OpenRouter key is configured on the gateway. Add one at the admin page.",
        );
    }

    const model = opts.model || this.config.defaultModel;
    const tried: string[] = [];
    let lastRateLimit: RateLimited | null = null;
    let lastUnusable: BadModelOutput | null = null;

    for (const key of keys) {
      tried.push(key.masked);
      try {
        const completion = await this.post(messages, key, model, opts.maxTokens, !!opts.jsonObject);
        await this.store.pushToBack(key.id, false);
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
          // move on, so the next attempt lands on a different model.
          await this.store.pushToBack(key.id, false);
          lastUnusable = e;
          continue;
        }
        throw e;
      }
    }

    throw (
      lastRateLimit ??
      lastUnusable ??
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
      response = await fetch(this.config.upstreamUrl ?? UPSTREAM, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify({
          model: this.config.defaultModel,
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
    return {
      configured: keys.length,
      queue: keys.map((k, i) => ({ ...k, next: i === 0 })),
      note: keys.length
        ? `${keys.length} key${keys.length === 1 ? "" : "s"} in rotation. Each call takes the key at ` +
          "the front and sends it to the back, so the free tier's daily cap multiplies instead of " +
          "being spent down on one key."
        : "No keys configured — every call will fail with 503 until one is added.",
    };
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
