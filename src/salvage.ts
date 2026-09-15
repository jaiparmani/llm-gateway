/**
 * Pulling a usable JSON object out of whatever a model actually returned.
 *
 * The default `openrouter/free` pool routes every call to a different model, so
 * the request is the easy part — surviving the response is the work. Some models
 * wrap the object in prose, some emit a <think> block containing its own braces
 * first, some ignore JSON mode entirely and fence the whole reply.
 *
 * This is the one place that knows about all of that, so every caller of the
 * gateway gets the hardening without writing any of it.
 */

export class SalvageError extends Error {}

/**
 * Yields every balanced {...} span in `text`, outermost first.
 *
 * Brace counting rather than a regex: a greedy /\{.*\}/s swallows everything
 * between the first and last brace, which is exactly wrong when a reasoning
 * preamble contains its own object. Quoted strings and escapes are tracked so a
 * brace inside a value does not miscount.
 */
function* jsonSpans(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) yield text.slice(start, i + 1);
      }
    }
  }
}

/**
 * Reads the answer object out of a model reply. With `expectKey`, prefers the
 * first balanced object carrying that key, so a reasoning preamble containing
 * some other object does not win.
 */
export function extractJson(text: string, expectKey?: string): Record<string, unknown> {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?|```/g, "");

  try {
    const candidate = JSON.parse(cleaned);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  } catch {
    // Fall through to span scanning.
  }

  let fallback: Record<string, unknown> | null = null;
  for (const span of jsonSpans(cleaned)) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(span);
    } catch {
      continue;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const obj = candidate as Record<string, unknown>;
    if (!expectKey || expectKey in obj) return obj;
    if (!fallback) fallback = obj;
  }

  if (fallback) return fallback;
  throw new SalvageError("Could not find a JSON object in the model's response.");
}
