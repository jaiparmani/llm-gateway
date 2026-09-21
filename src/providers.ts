/**
 * Every provider this gateway can rotate keys for.
 *
 * They are all here because they all speak the same shape: Bearer auth, a
 * `{model, messages}` POST, and an OpenAI-style `{choices, usage, model}`
 * reply. That is what let `Gateway.post` stay provider-agnostic — the only
 * per-provider things are the upstream URL, the default model, and what a
 * key for it looks like, which is exactly what lives here.
 */

export interface ProviderDef {
  id: string;
  label: string;
  upstreamUrl: string;
  /** Asked for when a caller (or key) does not pin a model of its own. */
  defaultModel: string;
  keyShape: RegExp;
  /** Shown in the "does not look like a ... key" refusal. */
  keyHint: string;
}

export const DEFAULT_PROVIDER = "openrouter";

export const PROVIDERS: Record<string, ProviderDef> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    upstreamUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "openrouter/free",
    keyShape: /^sk-or-v1-[A-Za-z0-9]{32,}$/,
    keyHint: "sk-or-v1-…",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    // Gemini's OpenAI-compatible endpoint — same request/response shape as
    // everything else here, so nothing in gateway.ts had to change for it.
    upstreamUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.0-flash",
    keyShape: /^AIza[A-Za-z0-9_-]{35}$/,
    keyHint: "AIza…",
  },
  groq: {
    id: "groq",
    label: "Groq",
    upstreamUrl: "https://api.groq.com/openai/v1/chat/completions",
    // llama-3.3-70b-versatile moved behind Enterprise pricing; Groq's own docs
    // point free/dev-tier callers at gpt-oss-120b instead.
    defaultModel: "openai/gpt-oss-120b",
    keyShape: /^gsk_[A-Za-z0-9]{32,}$/,
    keyHint: "gsk_…",
  },
  cerebras: {
    id: "cerebras",
    label: "Cerebras",
    upstreamUrl: "https://api.cerebras.ai/v1/chat/completions",
    // Llama 3.3 70B has been fully retired from Cerebras's catalog — confirmed
    // against the ground truth, not docs: curl https://api.cerebras.ai/public/v1/models
    // (unauthenticated). As of writing it lists exactly two models, deprecated:false:
    // gpt-oss-120b and qwen-3.8-27b.
    defaultModel: "gpt-oss-120b",
    keyShape: /^csk-[A-Za-z0-9]{32,}$/,
    keyHint: "csk-…",
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    upstreamUrl: "https://api.mistral.ai/v1/chat/completions",
    defaultModel: "mistral-small-latest",
    // Mistral keys carry no fixed prefix, so this only checks length/alphabet —
    // weaker than the others, but there is nothing more specific to check.
    keyShape: /^[A-Za-z0-9]{32}$/,
    keyHint: "a 32-character key",
  },
};

export function providerIds(): string[] {
  return Object.keys(PROVIDERS);
}

export function isKnownProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/** Falls back to OpenRouter for a row written before this column existed. */
export function providerOf(id: string | null | undefined): ProviderDef {
  return (id && PROVIDERS[id]) || PROVIDERS[DEFAULT_PROVIDER]!;
}
