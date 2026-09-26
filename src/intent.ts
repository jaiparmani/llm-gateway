import { BadModelOutput, type Message } from "./gateway.ts";

/**
 * Classifying which of several caller-supplied destinations a message belongs
 * to — used by a client that needs to route a message rather than answer it
 * (see /v1/intent in router.ts). Domain-agnostic on purpose: this file has no
 * idea what the destinations mean, only that there is a fixed set of them
 * with a short description each. What they represent is the caller's
 * business, not the gateway's — the same reasoning that keeps client.py's
 * callers on the ToolBox side describing what they want rather than this
 * repo knowing about expenses, quests, or anything else.
 */

export interface IntentOption {
  id: string;
  description: string;
}

export interface IntentResult {
  id: string;
  confidence: number;
}

/** A non-empty array of {id, description} strings, or null. */
export function parseIntentOptions(raw: unknown): IntentOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: IntentOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") return null;
    const { id, description } = o as { id?: unknown; description?: unknown };
    if (typeof id !== "string" || !id) return null;
    if (typeof description !== "string" || !description) return null;
    out.push({ id, description });
  }
  return out;
}

export function intentMessages(message: string, options: IntentOption[]): Message[] {
  const list = options.map((o) => `- ${o.id}: ${o.description}`).join("\n");
  return [
    {
      role: "system",
      content:
        "You route a message to exactly one destination, chosen from this list:\n" +
        list +
        '\n\nReply with ONLY a JSON object: {"id": "<the chosen id>", "confidence": <a number from 0 to 1>}. ' +
        "Pick the single best match even when a message could plausibly fit more than one.",
    },
    { role: "user", content: message },
  ];
}

/**
 * Turns the model's parsed reply into a result, falling back to `fallback`
 * (when given) if the model named a destination that was never offered — a
 * small model in the free pool occasionally invents one. With no fallback,
 * that is a `BadModelOutput`, the same class every other malformed reply in
 * this gateway raises, so it reaches the caller as the usual 502.
 */
export function resolveIntent(
  data: Record<string, unknown>,
  options: IntentOption[],
  fallback?: string,
): IntentResult {
  const ids = new Set(options.map((o) => o.id));
  const id = typeof data.id === "string" ? data.id : "";
  const confidenceRaw = typeof data.confidence === "number" ? data.confidence : Number(data.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;

  if (ids.has(id)) return { id, confidence };
  if (fallback !== undefined && ids.has(fallback)) return { id: fallback, confidence: 0 };
  throw new BadModelOutput(`The model chose an unknown destination${id ? ` ("${id}")` : ""}.`);
}
