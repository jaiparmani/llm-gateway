import { BadModelOutput, type Message } from "./gateway.ts";

/**
 * The gateway reasoning about its own operational data — an on-demand
 * narrative (`insightsMessages`) and an ask-anything chatbot grounded in the
 * same snapshot (`chatMessages`). Pure message-building, no gateway/store
 * dependency, the same shape as intent.ts: this file has no idea how the
 * snapshot was assembled (see /v1/insights and /v1/insights/chat in
 * router.ts), only what to ask the model to do with it.
 *
 * Every number in the snapshot is something the gateway actually observed —
 * calls, failures, rate-limit timestamps. Never a provider's published quota
 * (nothing here tracks one; see Gateway.limitsView), so a reply grounded in
 * it can't cite a limit the gateway doesn't actually know.
 */

export interface InsightsResult {
  headline: string;
  bullets: string[];
}

const SNAPSHOT_INTRO =
  "You are given a JSON snapshot of a small self-hosted LLM API gateway: its usage ledger, " +
  "key rotation health, and rate-limit signals. Every number in it is something the gateway " +
  "actually observed — never a provider's published quota, since it doesn't track one.";

export function insightsMessages(context: unknown): Message[] {
  return [
    {
      role: "system",
      content:
        `${SNAPSHOT_INTRO}\n\n` +
        'Reply with ONLY a JSON object: {"headline": string, "bullets": string[]}. ' +
        '"headline" is one sentence: the single most useful thing to notice right now. ' +
        '"bullets" is 2-5 short, specific observations, grounded ONLY in the numbers given — ' +
        "name the actual providers, keys, or clients the data names, never invent one. " +
        "If nothing stands out — healthy, quiet, unremarkable — say that plainly instead of " +
        "manufacturing concern.",
    },
    { role: "user", content: `Snapshot:\n${JSON.stringify(context, null, 2)}` },
  ];
}

/**
 * Turns the model's parsed reply into a result. A model in the free pool
 * occasionally drops `bullets` or returns it as a single string rather than
 * an array — coerced where reasonable, `BadModelOutput` (the same class
 * every other malformed reply in this gateway raises) otherwise.
 */
export function parseInsightsResult(data: Record<string, unknown>): InsightsResult {
  const headline = typeof data.headline === "string" ? data.headline.trim() : "";
  const rawBullets = data.bullets;
  const bullets = Array.isArray(rawBullets)
    ? rawBullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0).map((b) => b.trim())
    : typeof rawBullets === "string" && rawBullets.trim()
      ? [rawBullets.trim()]
      : [];

  if (!headline || bullets.length === 0) {
    throw new BadModelOutput("The model did not return a usable headline and bullet list.");
  }
  return { headline, bullets: bullets.slice(0, 8) };
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const MAX_HISTORY_TURNS = 20;
const MAX_TURN_LENGTH = 4000;

/** Prior turns of the "ask about your data" chat, or null if the shape is wrong. */
export function parseHistory(raw: unknown): ChatTurn[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_HISTORY_TURNS) return null;
  const out: ChatTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") return null;
    const { role, content } = t as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string" || !content) return null;
    out.push({ role, content: content.slice(0, MAX_TURN_LENGTH) });
  }
  return out;
}

export function chatMessages(context: unknown, question: string, history: ChatTurn[]): Message[] {
  return [
    {
      role: "system",
      content:
        `${SNAPSHOT_INTRO}\n\n` +
        "Answer questions using ONLY that snapshot. If the answer isn't in it, say so rather than " +
        "guessing. Be concise — a few sentences, not a report. The snapshot only ever contains " +
        "masked key forms, never a real one, so there is nothing sensitive to withhold beyond that.",
    },
    { role: "user", content: `Snapshot:\n${JSON.stringify(context, null, 2)}` },
    { role: "assistant", content: "Understood — I'll answer using only that data." },
    ...history,
    { role: "user", content: question },
  ];
}
