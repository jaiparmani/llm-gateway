import { Gateway } from "./gateway.ts";
import { providerIds } from "./providers.ts";
import { handle } from "./router.ts";
import { Store } from "./store.ts";

export interface Env {
  DB: D1Database;
  /** Gates the admin UI and every key/client endpoint. */
  ADMIN_TOKEN: string;
  /** Which model to ask for on an OpenRouter key when a caller does not name one. */
  DEFAULT_MODEL?: string;
  /** Per-provider default-model overrides — optional, every provider already has a free-tier default. */
  DEFAULT_MODEL_GEMINI?: string;
  DEFAULT_MODEL_GROQ?: string;
  DEFAULT_MODEL_CEREBRAS?: string;
  DEFAULT_MODEL_MISTRAL?: string;
  /** Override every provider's endpoint. Exists so tests can point at a stub. */
  UPSTREAM_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.DB) {
      return new Response(
        JSON.stringify({ error: { code: "misconfigured", message: "No D1 binding. Run: npm run db:init" } }, null, 2),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    const store = new Store(env.DB);
    const overrides = env as unknown as Record<string, string | undefined>;
    const providerDefaultModels: Record<string, string> = {};
    for (const id of providerIds()) {
      const value = overrides[`DEFAULT_MODEL_${id.toUpperCase()}`]?.trim();
      if (value) providerDefaultModels[id] = value;
    }

    const gateway = new Gateway(store, {
      defaultModel: env.DEFAULT_MODEL?.trim() || "openrouter/free",
      providerDefaultModels,
      ...(env.UPSTREAM_URL ? { upstreamUrl: env.UPSTREAM_URL } : {}),
      referer: "https://github.com/jaiparmani/llm-gateway",
      title: "llm-gateway",
    });

    return handle(request, { store, gateway, adminToken: env.ADMIN_TOKEN ?? "" });
  },
};
