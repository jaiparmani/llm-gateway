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
        headers: {
          Authorization: `Bearer ${key.key}`,
          "Content-Type": "application/json",
          ...(this.config.referer ? { "HTTP-Referer": this.config.referer } : {}),
          ...(this.config.title ? { "X-Title": this.config.title } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 45_000),
      });
    } catch (e) {
      throw wrap(new GatewayError(`Could not reach the upstream provider: ${(e as Error).message}`));
    }

    if (response.status === 429) {
      const { message, resetAt } = await rateLimitDetails(response);
      throw new RateLimited(message, resetAt);
    }
    if (!response.ok) {
      throw wrap(
        new GatewayError(`Upstream returned ${response.status}: ${(await response.text()).slice(0, 300)}`),
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw wrap(new BadModelOutput("Upstream returned an empty message."));

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
   */
  async chat(
    messages: Message[],
    opts: { model?: string; maxTokens?: number; jsonObject?: boolean } = {},
  ): Promise<Completion> {
    const keys = await this.store.keys();
    if (keys.length === 0) {
      throw wrap(
        new NoKeysConfigured(
          "No OpenRouter key is configured on the gateway. Add one at the admin page.",
        ),
      );
    }

    const model = opts.model || this.config.defaultModel;
    const tried: string[] = [];
    let lastRateLimit: RateLimited | null = null;

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
        throw e;
      }
    }

    throw lastRateLimit ?? wrap(new GatewayError("Every configured key was rejected."));
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

    throw wrap(
      new BadModelOutput(
        `The model would not return usable JSON after ${maxAttempts} attempts: ${lastError?.message}`,
      ),
    );
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

/** Preserves the subclass's status/code through construction. */
function wrap<T extends GatewayError>(e: T): T {
  return e;
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
