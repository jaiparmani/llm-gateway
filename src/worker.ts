import { Gateway } from "./gateway.ts";
import { handle } from "./router.ts";
import { Store } from "./store.ts";

export interface Env {
  DB: D1Database;
  /** Gates the admin UI and every key/client endpoint. */
  ADMIN_TOKEN: string;
  /** Which model to ask for when a caller does not name one. */
  DEFAULT_MODEL?: string;
  /** Override the provider endpoint. Exists so tests can point at a stub. */
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
    const gateway = new Gateway(store, {
      defaultModel: env.DEFAULT_MODEL?.trim() || "openrouter/free",
      ...(env.UPSTREAM_URL ? { upstreamUrl: env.UPSTREAM_URL } : {}),
      referer: "https://github.com/jaiparmani/llm-gateway",
      title: "llm-gateway",
    });

    return handle(request, { store, gateway, adminToken: env.ADMIN_TOKEN ?? "" });
  },
};
