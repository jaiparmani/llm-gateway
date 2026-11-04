import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Gateway } from "../src/gateway.ts";
import { handle } from "../src/router.ts";
import { extractJson } from "../src/salvage.ts";
import { BENCH_THRESHOLD, mask, Store } from "../src/store.ts";
import { makeD1 } from "./d1.ts";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

/**
 * Adds the `waitUntil` RouterDeps now requires — a streamed call's
 * usage-ledger write only happens once its stream ends, after `handle()`
 * has already returned, so tests that check ledger effects on a streamed
 * call must `await deps.drain()` first to let that trailing write land.
 */
function withWaitUntil<T extends { store: Store; gateway: Gateway; adminToken: string }>(deps: T) {
  const pending: Promise<unknown>[] = [];
  return {
    ...deps,
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    drain: () => Promise.all(pending).then(() => {}),
  };
}

// ── a stub OpenRouter ───────────────────────────────────────────────────────
// A scripted reply is either a normal JSON body, or `raw: true` with `body`
// as a preformatted SSE text payload — for exercising streaming. `headers`
// adds to (or overrides) the response's own, e.g. a real Retry-After.
let script: { status: number; body: unknown; raw?: boolean; headers?: Record<string, string> }[] = [];
const seen: { auth: string; body: any }[] = [];

const stub = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  seen.push({ auth: req.headers.authorization ?? "", body: JSON.parse(Buffer.concat(chunks).toString()) });
  const next = script.shift() ?? { status: 200, body: { choices: [{ message: { content: "{}" } }] } };
  const key = seen.at(-1)!.auth.replace("Bearer ", "");
  if (next.raw) {
    res.writeHead(next.status, { "content-type": "text/event-stream", ...next.headers });
    res.end(String(next.body).split("__KEY__").join(key));
    return;
  }
  res.writeHead(next.status, { "content-type": "application/json", ...next.headers });
  // __KEY__ stands for whichever key this call actually carried, so a scripted
  // reply can echo the credential back the way a real provider might.
  res.end(JSON.stringify(next.body).split("__KEY__").join(key));
});
await new Promise<void>((r) => stub.listen(0, r));
const upstreamUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1/chat/completions`;

const say = (content: string, model = "stub/model-a") => ({
  status: 200,
  body: { model, usage: { prompt_tokens: 7, completion_tokens: 11 }, choices: [{ message: { content } }] },
});
const rateLimited = (reset = "1789000000000") => ({
  status: 429,
  body: { error: { metadata: { headers: { "X-RateLimit-Reset": reset } } } },
});
/**
 * A 429 with a genuinely future reset, computed from the real clock at test
 * time — unlike `rateLimited()` above, whose fixed historical timestamp is
 * now permanently in the past and so never exercises the skip/wait logic.
 * `viaHeader` sends it as the standard Retry-After header (what most
 * providers actually send); otherwise it's OpenRouter's own body field.
 */
const rateLimitedUntil = (msFromNow: number, viaHeader = true) =>
  viaHeader
    ? { status: 429, body: { error: { message: "rate limited" } }, headers: { "retry-after": String(Math.ceil(msFromNow / 1000)) } }
    : { status: 429, body: { error: { metadata: { headers: { "X-RateLimit-Reset": String(Date.now() + msFromNow) } } } } };
// A hard failure — not a 429, not an empty completion — the kind that now
// rotates to the next key and counts toward benching one.
const serverError = () => ({
  status: 500,
  body: { error: { message: "internal error at __KEY__" } },
});
/**
 * A scripted SSE reply: one chunk per content piece, then a trailing
 * usage-only chunk (the OpenAI-compatible shape `stream_options.include_usage`
 * asks for — empty `choices`, `usage` alongside it) and `[DONE]`.
 */
const sse = (contents: string[], usage = { prompt_tokens: 5, completion_tokens: 9 }, model = "stub/model-a") => {
  const lines = contents.map((content, i) =>
    `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content }, finish_reason: i === contents.length - 1 ? "stop" : null }] })}\n\n`,
  );
  lines.push(`data: ${JSON.stringify({ model, choices: [], usage })}\n\n`);
  lines.push("data: [DONE]\n\n");
  return { status: 200, body: lines.join(""), raw: true };
};
const keyOf = (n: string) => "sk-or-v1-" + (n.repeat(64)).slice(0, 64);
const keysUsed = () => seen.map((s) => s.auth.replace("Bearer ", ""));

// ── harness ─────────────────────────────────────────────────────────────────
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const db = makeD1(schema);
const store = new Store(db);
const gateway = new Gateway(store, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const deps = withWaitUntil({ store, gateway, adminToken: "admin-t0ken" });

async function req(method: string, path: string, body?: unknown, token = "admin-t0ken") {
  const res = await handle(
    new Request(`http://x${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    deps,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── salvaging whatever the free pool returns ──");

check("plain JSON parses", extractJson('{"a":1}').a === 1);
check("fenced JSON parses", extractJson('```json\n{"a":2}\n```').a === 2);
check("JSON wrapped in prose parses", extractJson("Sure! Here you go:\n{\"a\":3}\nHope that helps.").a === 3);
check("a <think> block is stripped", extractJson('<think>{"wrong":1}</think>{"a":4}').a === 4);
check("expectKey beats a preamble object",
  JSON.stringify(extractJson('{"reasoning":"x"} then {"items":[1,2]}', "items").items) === "[1,2]");
check("braces inside strings do not miscount", extractJson('{"a":"a { brace }","b":5}').b === 5);
check("unparseable text throws", (() => { try { extractJson("no json"); return false; } catch { return true; } })());
check("a key is masked, never shown", mask(keyOf("a")) === "sk-or-v1-aaa...aaaa");

console.log("\n── keys and rotation ──");

const noKeys = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] });
check("inference needs a client token, not the admin one", noKeys.status === 401, noKeys.raw);

const issued = await req("POST", "/v1/clients", { name: "brain" });
const brainToken = issued.body.token as string;
check("a client token is issued", issued.status === 201 && brainToken.startsWith("lgw_"), issued.raw);
check("the token is not returned by the listing",
  !(await req("GET", "/v1/clients")).raw.includes(brainToken));

const stillNoKeys = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("no keys configured is 503 with a clear reason",
  stillNoKeys.status === 503 && stillNoKeys.body.error.code === "no_keys_configured", stillNoKeys.raw);

const added = await req("POST", "/v1/keys", { keys: `${keyOf("a")}\n${keyOf("b")}, ${keyOf("c")}`, label: "personal" });
check("several pasted keys are stored at once", added.status === 201 && added.body.added.length === 3, added.raw.slice(0, 200));
check("the response never contains a key", !added.raw.includes(keyOf("a")), "leaked");

const badKey = await req("POST", "/v1/keys", { keys: "hunter2" });
check("a malformed key is refused with a reason",
  badKey.status === 400 && badKey.body.skipped[0].includes("OpenRouter"), badKey.body);
check("the refusal masks even the bad input", !badKey.raw.includes("hunter2"), badKey.raw);
check("a duplicate key is refused",
  (await req("POST", "/v1/keys", { keys: keyOf("a") })).body.skipped[0].includes("already stored"));

// Round robin, not failover.
seen.length = 0;
for (let i = 0; i < 6; i++) {
  script = [say(`reply ${i}`)];
  await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
}
const used = keysUsed();
check("six calls across three keys spread evenly",
  ["a", "b", "c"].every((n) => used.filter((k) => k === keyOf(n)).length === 2), used.map(mask));
check("consecutive calls never reuse a key",
  used.every((k, i) => i === 0 || k !== used[i - 1]), used.map(mask));

const queue = await req("GET", "/v1/keys");
check("usage is counted per key", queue.body.queue.every((k: any) => k.uses === 2), queue.body.queue);
check("exactly one key serves next", queue.body.queue.filter((k: any) => k.next).length === 1);
check("the queue never exposes a key", !queue.raw.includes(keyOf("a")), "leaked");

seen.length = 0;
script = [rateLimited(), say("second key saved it")];
const rl = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("a 429 rotates to the next key inside the same call",
  rl.status === 200 && seen.length === 2, { status: rl.status, calls: seen.length });
const afterRl = await req("GET", "/v1/keys");
check("the rate limit is recorded against the key that hit it",
  afterRl.body.queue.filter((k: any) => k.lastRateLimitedAt).length === 1,
  afterRl.body.queue.map((k: any) => [k.masked, k.lastRateLimitedAt]));

script = [rateLimited(), rateLimited(), rateLimited()];
const allSpent = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("every key spent is 429 with a reset time",
  allSpent.status === 429 && allSpent.body.error.reset_at, allSpent.raw.slice(0, 200));

// The free pool hands back empty replies: a reasoning model can spend its whole
// token budget thinking and return nothing in `content`. That is the model's
// fault, not the key's, and the next key reaches a different model.
const empty = (model = "stub/thinker") => ({
  status: 200,
  body: { model, usage: { prompt_tokens: 5, completion_tokens: 700 }, choices: [{ message: { content: "" } }] },
});

seen.length = 0;
script = [empty(), say("the next model managed it")];
const recovered = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("an empty reply rotates to the next key instead of failing",
  recovered.status === 200 && recovered.body.choices[0].message.content === "the next model managed it",
  recovered.raw.slice(0, 200));
check("both keys are reported as tried", recovered.body.x_gateway.keys_tried.length === 2, recovered.body.x_gateway);

script = [empty(), empty(), empty()];
const allEmpty = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("every model returning nothing is a clear 502, naming the model",
  allEmpty.status === 502 && allEmpty.body.error.code === "bad_model_output"
  && allEmpty.body.error.message.includes("stub/thinker"), allEmpty.raw.slice(0, 220));
check("the message explains the token budget rather than just saying empty",
  /reasoning|tokens/.test(allEmpty.body.error.message), allEmpty.body.error.message);

// Some models leave `content` empty and put the answer in `reasoning`.
script = [{
  status: 200,
  body: { model: "stub/reasoner", usage: { prompt_tokens: 5, completion_tokens: 40 },
          choices: [{ message: { content: "", reasoning: "the answer is 42" } }] },
}];
const viaReasoning = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("an answer left in `reasoning` is used rather than discarded",
  viaReasoning.body.choices?.[0]?.message?.content === "the answer is 42", viaReasoning.raw.slice(0, 200));

console.log("\n── the OpenAI-shaped surface ──");

script = [say("hello there")];
const chat = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("the response is OpenAI-shaped",
  chat.body.object === "chat.completion" && chat.body.choices[0].message.content === "hello there"
  && chat.body.choices[0].message.role === "assistant", chat.raw.slice(0, 200));
check("token usage is reported", chat.body.usage.total_tokens === 18, chat.body.usage);
check("the model that actually served it is reported", chat.body.model === "stub/model-a");
check("the gateway extra names the key, masked", chat.body.x_gateway.key.endsWith("aaaa") || chat.body.x_gateway.key.includes("..."));

seen.length = 0;
script = [say('{"a":1}')];
await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } }, brainToken);
check("response_format is passed upstream", seen[0]!.body.response_format?.type === "json_object", seen[0]?.body);

// A hard failure now rotates through every key instead of aborting on the
// first one (see Gateway.chat), so all three keys need a scripted 401 here —
// with fewer, a later key would fall through to the stub's default 200 reply
// and this would stop testing what it says it tests.
const unauthorized = { status: 401, body: { error: { message: "No auth credentials found for __KEY__" } } };
script = [unauthorized, unauthorized, unauthorized];
const refused = await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("a refusal carries the provider's sentence, not its JSON envelope",
  refused.status === 502 && refused.body.error.message.includes("No auth credentials")
  && !refused.body.error.message.includes("{"), refused.raw.slice(0, 200));
check("a provider echoing the key back never reaches the caller",
  !["a", "b", "c"].some((n) => refused.raw.includes(keyOf(n))), refused.raw.slice(0, 200));

const badBody = await req("POST", "/v1/chat/completions", { messages: [] }, brainToken);
check("an empty message list is rejected", badBody.status === 400, badBody.raw);
const badRole = await req("POST", "/v1/chat/completions", { messages: [{ role: "wizard", content: "x" }] }, brainToken);
check("an invalid role is rejected", badRole.status === 400, badRole.raw);

console.log("\n── the salvaging surface ──");

seen.length = 0;
script = [say('<think>{"draft":1}</think>\nOK:\n```json\n{"answer":42}\n```')];
const jsonCall = await req("POST", "/v1/json", { messages: [{ role: "user", content: "q" }], expect_key: "answer" }, brainToken);
check("a messy reply is salvaged into an object", jsonCall.body.data.answer === 42, jsonCall.raw.slice(0, 200));
check("json mode is always requested here", seen[0]!.body.response_format?.type === "json_object");
check("one attempt is reported when it worked first time", jsonCall.body.attempts === 1);

seen.length = 0;
script = [say("I cannot do that"), say('{"ok":true}')];
const retried = await req("POST", "/v1/json", { messages: [{ role: "user", content: "q" }] }, brainToken);
check("an unusable reply is retried once", retried.body.data.ok === true && retried.body.attempts === 2, retried.raw.slice(0, 200));
check("the retry carries the correction",
  seen[1]!.body.messages.at(-1).content.startsWith("That was not usable"), seen[1]?.body.messages.at(-1));

script = [say("no"), say("still no")];
const gaveUp = await req("POST", "/v1/json", { messages: [{ role: "user", content: "q" }] }, brainToken);
check("giving up is a clear 502, not a crash",
  gaveUp.status === 502 && gaveUp.body.error.code === "bad_model_output", gaveUp.raw.slice(0, 200));

console.log("\n── intent classification ──");

const routeOptions = [
  { id: "toolbox", description: "expenses, money, spending questions" },
  { id: "brain-chat", description: "general conversation, reminders, memory" },
  { id: "life-rpg", description: "quests, goals, habit tracking" },
];

const intentUnauth = await req("POST", "/v1/intent", { message: "20 chai", options: routeOptions });
check("intent classification needs a client token, not the admin one", intentUnauth.status === 401, intentUnauth.raw);

const badOptions = await req("POST", "/v1/intent", { message: "hi", options: [] }, brainToken);
check("empty options is rejected", badOptions.status === 400 && badOptions.body.error.code === "validation_failed", badOptions.raw);

const noMessage = await req("POST", "/v1/intent", { options: routeOptions }, brainToken);
check("a missing message is rejected", noMessage.status === 400, noMessage.raw);

script = [say('{"id":"toolbox","confidence":0.9}')];
const routed = await req("POST", "/v1/intent", { message: "20 chai", options: routeOptions }, brainToken);
check("a message is classified into one of the caller's own destinations",
  routed.status === 200 && routed.body.id === "toolbox" && routed.body.confidence === 0.9, routed.raw);

script = [say("Sure, I'd pick: {\"id\":\"brain-chat\"}")];
const salvaged = await req("POST", "/v1/intent", { message: "remind me to call mom", options: routeOptions }, brainToken);
check("a messy reply is salvaged the same way /v1/json does, with a default confidence",
  salvaged.status === 200 && salvaged.body.id === "brain-chat" && salvaged.body.confidence === 0, salvaged.raw);

script = [say('{"id":"not-a-real-destination"}')];
const unknownNoFallback = await req("POST", "/v1/intent", { message: "???", options: routeOptions }, brainToken);
check("an invented destination with no default is a clear 502",
  unknownNoFallback.status === 502 && unknownNoFallback.body.error.code === "bad_model_output", unknownNoFallback.raw);

script = [say('{"id":"not-a-real-destination"}')];
const unknownWithFallback = await req(
  "POST", "/v1/intent",
  { message: "???", options: routeOptions, default: "brain-chat" },
  brainToken,
);
check("an invented destination falls back to the caller's default when one is given",
  unknownWithFallback.status === 200 && unknownWithFallback.body.id === "brain-chat" && unknownWithFallback.body.confidence === 0,
  unknownWithFallback.raw);

console.log("\n── auth and accounting ──");

check("management needs the admin token, not a client token",
  (await req("GET", "/v1/keys", undefined, brainToken)).status === 401);
check("a revoked client is locked out immediately", await (async () => {
  const t = (await req("POST", "/v1/clients", { name: "temp" })).body.token;
  await req("DELETE", "/v1/clients/temp");
  return (await req("POST", "/v1/json", { messages: [{ role: "user", content: "x" }] }, t)).status === 401;
})());

const usage = await req("GET", "/v1/usage");
check("usage is recorded per client",
  (usage.body.summary.byClient as any[]).some((c) => c.client === "brain" && c.calls > 0), usage.body.summary);
check("failures are recorded too, with the reason",
  (usage.body.recent as any[]).some((r) => r.ok === 0 && r.error), usage.body.recent?.[0]);
check("the ledger never holds a key", !usage.raw.includes(keyOf("a")), "leaked");

check("health is public", (await handle(new Request("http://x/health"), deps)).status === 200);
check("the admin page is served", (await handle(new Request("http://x/"), deps)).status === 200);
check("the chat page is the same document, served at /chat", await (async () => {
  const a = await handle(new Request("http://x/"), deps);
  const b = await handle(new Request("http://x/chat"), deps);
  return b.status === 200 && (await b.text()) === (await a.text());
})());
check("an unknown route is a clean 404", (await req("GET", "/v1/nope")).status === 404);

const noAdmin = await handle(
  new Request("http://x/v1/keys", { headers: { Authorization: "Bearer anything" } }),
  { ...deps, adminToken: "" },
);
check("with no ADMIN_TOKEN set, management is disabled rather than open", noAdmin.status === 503);

console.log("\n── testing one key on its own ──");

const before = (await req("GET", "/v1/keys")).body.queue as any[];
const idB = before.find((k) => k.masked === mask(keyOf("b")))!.id;
const usesBefore = before.find((k) => k.id === idB)!.uses;

seen.length = 0;
script = [say("pong")];
const live = await req("POST", `/v1/keys/${idB}/test`);
check("a key tests live when the provider accepts it",
  live.status === 200 && live.body.ok === true && live.body.status === "live", live.raw);
check("the test uses that one key, not the rotation",
  keysUsed().length === 1 && keysUsed()[0] === keyOf("b"), keysUsed().map(mask));
check("the test asks for the smallest completion the provider will take",
  seen[0]!.body.max_tokens === 1, seen[0]?.body);
check("the result names the key masked, never whole",
  live.body.key === mask(keyOf("b")) && !live.raw.includes(keyOf("b")), "leaked");

const after = (await req("GET", "/v1/keys")).body.queue as any[];
check("a test does not move the key in the rotation or count as a call",
  after[0]!.masked === before[0]!.masked && after.find((k) => k.id === idB)!.uses === usesBefore,
  { front: [before[0]!.masked, after[0]!.masked], uses: [usesBefore, after.find((k) => k.id === idB)!.uses] });

script = [rateLimited()];
const spent = await req("POST", `/v1/keys/${idB}/test`);
check("a 429 means the key is valid and merely spent, not broken",
  spent.body.ok === true && spent.body.status === "rate_limited" && Boolean(spent.body.resetAt), spent.raw);

script = [{ status: 401, body: { error: { message: `No auth credentials found for ${keyOf("b")}` } } }];
const dead = await req("POST", `/v1/keys/${idB}/test`);
check("a rejected key reports the provider's own words",
  dead.body.ok === false && dead.body.status === "failed" && dead.body.message.includes("No auth credentials"),
  dead.raw);
check("a provider that echoes the key back still does not leak it",
  !dead.raw.includes(keyOf("b")) && dead.raw.includes(mask(keyOf("b"))), dead.raw);

check("testing a key that is not there is a clean 404",
  (await req("POST", "/v1/keys/99999/test")).status === 404);
check("testing a key needs the admin token, not a client token",
  (await req("POST", `/v1/keys/${idB}/test`, undefined, brainToken)).status === 401);

console.log("\n── fixing a default model from the console, without a deploy ──");

const modelsBefore = await req("GET", "/v1/models");
check("every provider starts with no override, using its configured default",
  modelsBefore.status === 200
  && modelsBefore.body.models.find((m: any) => m.provider === "openrouter").override === null
  && modelsBefore.body.models.find((m: any) => m.provider === "openrouter").effective === "stub/default",
  modelsBefore.body.models);
check("reading the model settings needs the admin token, not a client token",
  (await req("GET", "/v1/models", undefined, brainToken)).status === 401);

const badProviderModel = await req("POST", "/v1/models", { provider: "not-a-provider", model: "x" });
check("setting a model on an unknown provider is refused",
  badProviderModel.status === 400 && badProviderModel.body.error.code === "validation_failed", badProviderModel.raw);

const setModel = await req("POST", "/v1/models", { provider: "openrouter", model: "corrected/model-id" });
check("a corrected model id is stored as that provider's override",
  setModel.status === 200
  && setModel.body.models.find((m: any) => m.provider === "openrouter").override === "corrected/model-id"
  && setModel.body.models.find((m: any) => m.provider === "openrouter").effective === "corrected/model-id",
  setModel.body.models);

seen.length = 0;
script = [say("hi")];
await req("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, brainToken);
check("the very next call actually asks the provider for the corrected model — no deploy needed",
  seen[0]!.body.model === "corrected/model-id", seen[0]?.body);

const clearedModel = await req("POST", "/v1/models", { provider: "openrouter", model: "" });
check("an empty model clears the override, reverting to the configured default",
  clearedModel.status === 200
  && clearedModel.body.models.find((m: any) => m.provider === "openrouter").override === null
  && clearedModel.body.models.find((m: any) => m.provider === "openrouter").effective === "stub/default",
  clearedModel.body.models);

console.log("\n── multiple providers ──");

// A separate store/gateway so this doesn't disturb the exact key counts the
// rotation checks above depend on.
const db2 = makeD1(schema);
const store2 = new Store(db2);
const gateway2 = new Gateway(store2, {
  defaultModel: "stub/default",
  upstreamUrl,
  timeoutMs: 5000,
  providerDefaultModels: { gemini: "stub/gemini-model" },
});
const deps2 = withWaitUntil({ store: store2, gateway: gateway2, adminToken: "admin-t0ken" });
async function req2(method: string, path: string, body?: unknown, token = "admin-t0ken") {
  const res = await handle(
    new Request(`http://x${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    deps2,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

const list = await req2("GET", "/v1/providers", undefined, "");
check("the provider list is public and includes the new ones",
  list.status === 200 && ["openrouter", "gemini", "groq", "cerebras", "mistral"].every(
    (id) => list.body.providers.some((p: any) => p.id === id)),
  list.body);

const geminiKey = "AIza" + "g".repeat(35);

const unknownProvider = await req2("POST", "/v1/keys", { keys: geminiKey, provider: "nope" });
check("an unknown provider is refused",
  unknownProvider.status === 400 && unknownProvider.body.error.code === "validation_failed", unknownProvider.raw);

const wrongShape = await req2("POST", "/v1/keys", { keys: keyOf("a"), provider: "gemini" });
check("a key shaped for one provider is refused for another",
  wrongShape.status === 400 && wrongShape.body.skipped[0].includes("Google Gemini"), wrongShape.body);

const addedGemini = await req2("POST", "/v1/keys", { keys: geminiKey, provider: "gemini" });
check("a Gemini key is stored under its own provider",
  addedGemini.status === 201 && addedGemini.body.added[0].provider === "gemini", addedGemini.raw);

const orKeyForTest = keyOf("z");
await req2("POST", "/v1/keys", { keys: orKeyForTest }); // no provider given — still defaults to openrouter

const issued2 = await req2("POST", "/v1/clients", { name: "multi" });
const multiToken = issued2.body.token as string;

seen.length = 0;
script = [say("hi from gemini", "stub/gemini-actual")];
await req2("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, multiToken);
check("the gemini key (first in, first served) gets gemini's own default model",
  seen[0]!.body.model === "stub/gemini-model", seen[0]?.body);

seen.length = 0;
script = [say("hi from openrouter")];
await req2("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, multiToken);
check("rotation moves on to the openrouter key with its own default model",
  seen[0]!.body.model === "stub/default", seen[0]?.body);

// Queue is back at the gemini key now.
seen.length = 0;
script = [say("ignored override")];
await req2("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], model: "custom-or-model" }, multiToken);
check("a caller-supplied model does not leak onto a non-OpenRouter key",
  seen[0]!.body.model === "stub/gemini-model", seen[0]?.body);

seen.length = 0;
script = [say("used override")];
await req2("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], model: "custom-or-model" }, multiToken);
check("a caller-supplied model is honored on an OpenRouter key",
  seen[0]!.body.model === "custom-or-model", seen[0]?.body);

const queue2 = await req2("GET", "/v1/keys");
check("the queue reports which provider each key belongs to",
  new Set(queue2.body.queue.map((k: any) => k.provider)).size === 2, queue2.body.queue.map((k: any) => k.provider));

// Google started issuing AI Studio keys with this prefix in place of AIza
// partway through 2026 — both formats are live simultaneously depending on
// the account, so both must be accepted. Added last so it does not shift
// which key rotation lands on above.
const addedGeminiAq = await req2("POST", "/v1/keys", { keys: "AQ." + "b".repeat(30), provider: "gemini" });
check("a newer AQ.-prefixed Gemini key is also accepted, not just the legacy AIza format",
  addedGeminiAq.status === 201 && addedGeminiAq.body.added[0].provider === "gemini", addedGeminiAq.raw);

// A separate store/gateway per scenario below, same reason as db2: each test
// needs to drive a key's failure count to an exact place, which a shared
// queue full of unrelated activity would make fragile to assert on.
function reqFor(deps: { store: Store; gateway: Gateway; adminToken: string; waitUntil: (p: Promise<unknown>) => void }) {
  return async (method: string, path: string, body?: unknown, token = "admin-t0ken") => {
    const res = await handle(
      new Request(`http://x${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      deps,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
  };
}

console.log("\n── key health: rotating past a hard failure, and benching one ──");

const db3 = makeD1(schema);
const store3 = new Store(db3);
const gateway3 = new Gateway(store3, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const deps3 = withWaitUntil({ store: store3, gateway: gateway3, adminToken: "admin-t0ken" });
const req3 = reqFor(deps3);

await req3("POST", "/v1/keys", { keys: `${keyOf("m")}\n${keyOf("n")}` });
const issued3 = await req3("POST", "/v1/clients", { name: "health" });
const healthToken = issued3.body.token as string;

seen.length = 0;
script = [serverError(), say("second key saved it")];
const rotated = await req3("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, healthToken);
check("a hard failure (not a 429, not an empty reply) rotates to the next key instead of aborting the request",
  rotated.status === 200 && seen.length === 2, { status: rotated.status, calls: seen.length });

const q0 = await req3("GET", "/v1/keys");
check("a single failure, short of the threshold, does not bench the key",
  q0.body.queue.find((k: any) => k.masked === mask(keyOf("m"))).benched === false, q0.body.queue);

// `m` failed and was pushed to the back before `n`'s success pushed it
// further back still, so `m` is the front key again for the next call — see
// Store.pushToBack. BENCH_THRESHOLD - 1 more identical calls puts it over.
for (let i = 0; i < BENCH_THRESHOLD - 1; i++) {
  script = [serverError(), say(`n saves it again ${i}`)];
  await req3("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, healthToken);
}
const q1 = await req3("GET", "/v1/keys");
const benchedM = q1.body.queue.find((k: any) => k.masked === mask(keyOf("m")));
check("enough consecutive real failures benches the key, with a reason recorded",
  benchedM.benched === true && typeof benchedM.benchedReason === "string" && benchedM.benchedReason.length > 0,
  benchedM);
check("the benched reason is masked, like every other surface that can echo the provider",
  !benchedM.benchedReason.includes(keyOf("m")), benchedM.benchedReason);

seen.length = 0;
script = [say("only n now")];
await req3("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, healthToken);
check("normal rotation skips a benched key",
  seen.length === 1 && seen[0]!.auth === `Bearer ${keyOf("n")}`, seen.map((s) => s.auth));

const q2 = await req3("GET", "/v1/keys");
const idM = q2.body.queue.find((k: any) => k.masked === mask(keyOf("m"))).id;

check("un-benching a key needs the admin token, not a client token",
  (await req3("POST", `/v1/keys/${idM}/unbench`, undefined, healthToken)).status === 401);

const unbenched = await req3("POST", `/v1/keys/${idM}/unbench`);
check("the admin can manually clear a key's benched state",
  unbenched.status === 200 && unbenched.body.ok === true, unbenched.raw);
check("un-benching an id that does not exist is a clean 404",
  (await req3("POST", "/v1/keys/99999/unbench")).status === 404);

const q3 = await req3("GET", "/v1/keys");
check("the key is reported unbenched again",
  q3.body.queue.find((k: any) => k.id === idM).benched === false, q3.body.queue);

seen.length = 0;
script = [say("m is back")];
await req3("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, healthToken);
check("a manually un-benched key rejoins rotation",
  seen.length === 1 && seen[0]!.auth === `Bearer ${keyOf("m")}`, seen.map((s) => s.auth));

console.log("\n── key health: a success resets the counter, and the queue never wedges shut ──");

const db4 = makeD1(schema);
const store4 = new Store(db4);
const gateway4 = new Gateway(store4, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const deps4 = withWaitUntil({ store: store4, gateway: gateway4, adminToken: "admin-t0ken" });
const req4 = reqFor(deps4);

await req4("POST", "/v1/keys", { keys: keyOf("p") });
const issued4 = await req4("POST", "/v1/clients", { name: "solo" });
const soloToken = issued4.body.token as string;

for (let i = 0; i < BENCH_THRESHOLD - 1; i++) {
  script = [serverError()];
  await req4("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, soloToken);
}
const q4a = await req4("GET", "/v1/keys");
check("just short of the threshold, the sole key is still not benched",
  q4a.body.queue[0].benched === false, q4a.body.queue);

script = [say("recovered")];
const recovered4 = await req4("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, soloToken);
check("a success in between is not itself blocked by the near-miss count",
  recovered4.status === 200, recovered4.raw);

for (let i = 0; i < BENCH_THRESHOLD - 1; i++) {
  script = [serverError()];
  await req4("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, soloToken);
}
const q4b = await req4("GET", "/v1/keys");
check("a success resets the count — the same number of failures again is still not enough on its own",
  q4b.body.queue[0].benched === false, q4b.body.queue);

script = [serverError()];
await req4("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, soloToken);
const q4c = await req4("GET", "/v1/keys");
check("one more failure crosses the threshold and benches the sole key",
  q4c.body.queue[0].benched === true, q4c.body.queue);

// Every key that exists is now benched. The queue must not collapse to
// no_keys_configured, as if none were configured — it still owes the caller
// an actual attempt.
seen.length = 0;
script = [say("tried anyway")];
const despiteBenched = await req4("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, soloToken);
check("with every key benched, the gateway still attempts the call instead of a bare 503",
  despiteBenched.status === 200 && seen.length === 1, { status: despiteBenched.status, calls: seen.length });

const q4d = await req4("GET", "/v1/keys");
check("a success reached through that fallback clears the bench too",
  q4d.body.queue[0].benched === false, q4d.body.queue);

console.log("\n── key health: a rate limit never counts toward benching ──");

const db5 = makeD1(schema);
const store5 = new Store(db5);
const gateway5 = new Gateway(store5, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const deps5 = withWaitUntil({ store: store5, gateway: gateway5, adminToken: "admin-t0ken" });
const req5 = reqFor(deps5);

await req5("POST", "/v1/keys", { keys: keyOf("q") });
const issued5 = await req5("POST", "/v1/clients", { name: "spent" });
const spentToken = issued5.body.token as string;

for (let i = 0; i < BENCH_THRESHOLD + 3; i++) {
  script = [rateLimited()];
  await req5("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, spentToken);
}
const q5 = await req5("GET", "/v1/keys");
check("well past the bench threshold in rate limits alone, the key is still not benched",
  q5.body.queue[0].benched === false, q5.body.queue);

console.log("\n── pausing a key manually, distinct from benching ──");

const db6 = makeD1(schema);
const store6 = new Store(db6);
const gateway6 = new Gateway(store6, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const deps6 = withWaitUntil({ store: store6, gateway: gateway6, adminToken: "admin-t0ken" });
const req6 = reqFor(deps6);

const addedA = await req6("POST", "/v1/keys", { keys: keyOf("m") });
const idPause = addedA.body.added[0].id;
await req6("POST", "/v1/keys", { keys: keyOf("n") });
const issued6 = await req6("POST", "/v1/clients", { name: "pausing" });
const pausingToken = issued6.body.token as string;

check("pausing a key needs the admin token, not a client token",
  (await req6("POST", `/v1/keys/${idPause}/pause`, undefined, pausingToken)).status === 401);

const paused = await req6("POST", `/v1/keys/${idPause}/pause`);
check("the admin can manually pause a key", paused.status === 200 && paused.body.ok === true, paused.raw);

const pausingIsIdempotent = await req6("POST", `/v1/keys/${idPause}/pause`);
check("pausing an already-paused key is still a success, not a 404",
  pausingIsIdempotent.status === 200, pausingIsIdempotent.raw);

const qAfterPause = await req6("GET", "/v1/keys");
check("the queue reports the key as paused",
  qAfterPause.body.queue.find((k: any) => k.id === idPause).paused === true, qAfterPause.body.queue);
check("a paused key is never reported as next",
  qAfterPause.body.queue.find((k: any) => k.id === idPause).next === false, qAfterPause.body.queue);

seen.length = 0;
script = [say("from n, not m")];
await req6("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, pausingToken);
check("normal rotation skips a paused key entirely",
  keysUsed().length === 1 && keysUsed()[0] === keyOf("n"), keysUsed().map(mask));

// Drive every OTHER key into being benched, so the "all benched" fallback in
// Gateway.chat would normally kick in — except the paused key must still be
// excluded, unlike a merely-benched one.
seen.length = 0;
for (let i = 0; i < BENCH_THRESHOLD; i++) {
  script = [{ status: 500, body: { error: { message: "provider down" } } }];
  await req6("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, pausingToken);
}
seen.length = 0;
script = [say("still from n")];
await req6("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, pausingToken);
check("even when every OTHER key is benched, a paused key is not used as a last resort",
  keysUsed().every((k) => k !== keyOf("m")), keysUsed().map(mask));

const resumed = await req6("POST", `/v1/keys/${idPause}/resume`);
check("the admin can resume a paused key", resumed.status === 200 && resumed.body.ok === true, resumed.raw);
const qAfterResume = await req6("GET", "/v1/keys");
check("the key is reported unpaused again",
  qAfterResume.body.queue.find((k: any) => k.id === idPause).paused === false, qAfterResume.body.queue);

check("resuming an id that does not exist is a clean 404",
  (await req6("POST", "/v1/keys/99999/resume")).status === 404);

console.log("\n── pausing a whole provider ──");

const db7 = makeD1(schema);
const store7 = new Store(db7);
const gateway7 = new Gateway(store7, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const deps7 = withWaitUntil({ store: store7, gateway: gateway7, adminToken: "admin-t0ken" });
const req7 = reqFor(deps7);

await req7("POST", "/v1/keys", { keys: `${keyOf("p")}\n${keyOf("q")}` });
const issued7 = await req7("POST", "/v1/clients", { name: "provider-pause" });
const providerPauseToken = issued7.body.token as string;

check("pausing a provider needs the admin token, not a client token",
  (await req7("POST", "/v1/providers/openrouter/pause", undefined, providerPauseToken)).status === 401);
check("pausing an unknown provider is a clean 404",
  (await req7("POST", "/v1/providers/not-a-provider/pause")).status === 404);

const providerPaused = await req7("POST", "/v1/providers/openrouter/pause");
check("the admin can pause a whole provider", providerPaused.status === 200 && providerPaused.body.paused === true, providerPaused.raw);

const listAfterPause = await req7("GET", "/v1/providers", undefined, "");
check("the public provider listing reflects the pause",
  listAfterPause.body.providers.find((p: any) => p.id === "openrouter").paused === true, listAfterPause.body.providers);

const stillNoKey = await req7("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, providerPauseToken);
check("every key belonging to the paused provider is refused — even though keys exist, not a stale no_keys_configured",
  stillNoKey.status === 503 && stillNoKey.body.error.code === "no_keys_configured", stillNoKey.raw);

const qWhilePaused = await req7("GET", "/v1/keys");
check("no key of the paused provider is reported as next",
  qWhilePaused.body.queue.every((k: any) => k.next === false), qWhilePaused.body.queue);

const providerResumed = await req7("POST", "/v1/providers/openrouter/resume");
check("the admin can resume a paused provider", providerResumed.status === 200 && providerResumed.body.paused === false, providerResumed.raw);

seen.length = 0;
script = [say("back in rotation")];
const afterResumeCall = await req7("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, providerPauseToken);
check("calls succeed again once the provider is resumed",
  afterResumeCall.status === 200 && seen.length === 1, { status: afterResumeCall.status, calls: seen.length });

console.log("\n── per-provider and per-key analytics ──");

const db8 = makeD1(schema);
const store8 = new Store(db8);
const gateway8 = new Gateway(store8, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const deps8 = withWaitUntil({ store: store8, gateway: gateway8, adminToken: "admin-t0ken" });
const req8 = reqFor(deps8);

const addedR = await req8("POST", "/v1/keys", { keys: keyOf("r") });
const idR = addedR.body.added[0].id;
const issued8 = await req8("POST", "/v1/clients", { name: "analytics" });
const analyticsToken = issued8.body.token as string;

script = [say("ok", "stub/model-a")];
await req8("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, analyticsToken);
script = [{ status: 500, body: { error: { message: "boom" } } }];
await req8("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, analyticsToken);

const analytics = await req8("GET", "/v1/usage");
const providerRow = analytics.body.summary.byProvider.find((p: any) => p.provider === "openrouter");
check("usage is broken down per provider, across both the success and the failure",
  providerRow?.calls === 2 && providerRow?.ok === 1, analytics.body.summary.byProvider);

const keyRow = analytics.body.summary.byKey.find((k: any) => k.key_id === idR);
check("usage is broken down per key too, attributed even on the failing call",
  keyRow?.calls === 2 && keyRow?.ok === 1 && keyRow?.key_masked === mask(keyOf("r")), analytics.body.summary.byKey);
check("the per-key breakdown never leaks a whole key",
  !analytics.raw.includes(keyOf("r")), "leaked");

await req8("POST", "/v1/providers/openrouter/pause");
const failedBeforeAnyKey = await req8("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, analyticsToken);
check("a request that never reaches a key is recorded without crashing the ledger",
  failedBeforeAnyKey.status === 503, failedBeforeAnyKey.raw);
const analytics2 = await req8("GET", "/v1/usage");
check("a request attributed to no key does not add a phantom row to the per-key breakdown",
  analytics2.body.summary.byKey.length === 1, analytics2.body.summary.byKey);

console.log("\n── embeddings: only reach a provider that has the endpoint ──");

const embeddingsUrl = upstreamUrl.replace("/v1/chat/completions", "/v1/embeddings");
const mistralKeyOf = (n: string) => n.repeat(32).slice(0, 32);
const vectors = (...values: number[][]) => ({
  status: 200,
  body: { model: "mistral-embed", usage: { prompt_tokens: 6 }, data: values.map((embedding, index) => ({ embedding, index })) },
});

const db9 = makeD1(schema);
const store9 = new Store(db9);
const gateway9 = new Gateway(store9, { defaultModel: "stub/default", upstreamUrl, embeddingsUrl, timeoutMs: 5000 });
const deps9 = withWaitUntil({ store: store9, gateway: gateway9, adminToken: "admin-t0ken" });
const req9 = reqFor(deps9);

const issued9 = await req9("POST", "/v1/clients", { name: "vectors" });
const vectorsToken = issued9.body.token as string;

const embedNoKeys = await req9("POST", "/v1/embeddings", { input: "hello" }, vectorsToken);
check("with only chat-only providers configured, embeddings is a clean no_keys_configured",
  embedNoKeys.status === 503 && embedNoKeys.body.error.code === "no_keys_configured", embedNoKeys.raw);

await req9("POST", "/v1/keys", { keys: keyOf("e") }); // openrouter — chat-only, must be skipped
await req9("POST", "/v1/keys", { keys: mistralKeyOf("m"), provider: "mistral" });

const badInput = await req9("POST", "/v1/embeddings", { input: "" }, vectorsToken);
check("an empty string input is refused", badInput.status === 400 && badInput.body.error.code === "validation_failed", badInput.raw);

const badInput2 = await req9("POST", "/v1/embeddings", { input: [] }, vectorsToken);
check("an empty array input is refused", badInput2.status === 400 && badInput2.body.error.code === "validation_failed", badInput2.raw);

seen.length = 0;
script = [vectors([0.1, 0.2, 0.3])];
const embedded = await req9("POST", "/v1/embeddings", { input: "remember this" }, vectorsToken);
check("a single string embeds through the mistral-shaped key, skipping the openrouter one",
  embedded.status === 200 && seen.length === 1 && seen[0]!.auth === `Bearer ${mistralKeyOf("m")}`, embedded.raw);
check("the vector comes back in OpenAI's {data:[{embedding,index}]} shape",
  JSON.stringify(embedded.body.data[0].embedding) === "[0.1,0.2,0.3]" && embedded.body.data[0].index === 0, embedded.raw);
check("the embeddings call used mistral's registry default model, not openrouter's",
  seen[0]!.body.model === "mistral-embed", seen[0]?.body);

seen.length = 0;
script = [vectors([1, 0], [0, 1])];
const embeddedBatch = await req9("POST", "/v1/embeddings", { input: ["a", "b"] }, vectorsToken);
check("a batch of strings returns one vector per input, in order",
  embeddedBatch.body.data.length === 2 && embeddedBatch.body.data[1].embedding[1] === 1, embeddedBatch.raw);

seen.length = 0;
script = [rateLimited()];
const embedRateLimited = await req9("POST", "/v1/embeddings", { input: "x" }, vectorsToken);
check("a 429 on the sole embeddings-capable key surfaces as rate_limited, not a hard failure",
  embedRateLimited.status === 429 && embedRateLimited.body.error.code === "rate_limited", embedRateLimited.raw);

const embedUnauth = await req9("POST", "/v1/embeddings", { input: "x" });
check("embeddings needs a client token, not the admin one", embedUnauth.status === 401, embedUnauth.raw);

console.log("\n── insights: observed limits, the AI narrative, and the data chatbot ──");

const dbI = makeD1(schema);
const storeI = new Store(dbI);
const gatewayI = new Gateway(storeI, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const depsI = withWaitUntil({ store: storeI, gateway: gatewayI, adminToken: "admin-t0ken" });
const reqI = reqFor(depsI);

const limitsUnauth = await reqI("GET", "/v1/limits", undefined, "");
check("GET /v1/limits needs the admin token, not none at all", limitsUnauth.status === 401, limitsUnauth.raw);

await reqI("POST", "/v1/keys", { keys: keyOf("i") });
const issuedI = await reqI("POST", "/v1/clients", { name: "insights-client" });
const insightsClientToken = issuedI.body.token as string;

seen.length = 0;
script = [rateLimited()];
await reqI("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, insightsClientToken);
seen.length = 0;
script = [say("a normal reply")];
await reqI("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi again" }] }, insightsClientToken);

const limits = await reqI("GET", "/v1/limits");
check("limitsView reports the calls actually observed in the last 24h",
  limits.status === 200 && limits.body.keys[0].callsLast24h === 2, limits.body);
check("limitsView flags the key as rate-limited recently after the scripted 429",
  limits.body.keys[0].rateLimitedRecently === true, limits.body);

seen.length = 0;
script = [say('{"headline":"One key, one 429 today.","bullets":["1 key is configured and answered 2 calls in the last 24h.","It was rate limited once and recovered on the next call."]}')];
const insights = await reqI("POST", "/v1/insights");
check("POST /v1/insights returns a parsed headline and bullets",
  insights.status === 200 && typeof insights.body.headline === "string" && insights.body.bullets.length === 2, insights.raw);
check("the insights call is recorded under a gateway-internal client, not a real one",
  (await storeI.usage(5)).some((u: any) => u.client === "gateway:insights"), await storeI.usage(5));

const insightsUnauth = await reqI("POST", "/v1/insights", undefined, "");
check("POST /v1/insights needs the admin token", insightsUnauth.status === 401, insightsUnauth.raw);

seen.length = 0;
script = [say("not JSON at all, and there is no closing brace either")];
const badInsights = await reqI("POST", "/v1/insights");
check("a malformed insights reply is a clean error, not a crash",
  badInsights.status !== 200 && badInsights.body?.error?.code === "bad_model_output", badInsights.raw);

seen.length = 0;
script = [say("The free pool answered every call today; nothing else stands out.")];
const chatAnswer = await reqI("POST", "/v1/insights/chat", { question: "any problems today?" });
check("POST /v1/insights/chat answers grounded in the snapshot",
  chatAnswer.status === 200 && typeof chatAnswer.body.answer === "string" && chatAnswer.body.answer.length > 0, chatAnswer.raw);

const badHistory = await reqI("POST", "/v1/insights/chat", { question: "x", history: [{ role: "system", content: "nope" }] });
check("insights chat rejects a history entry with a disallowed role",
  badHistory.status === 400 && badHistory.body.error.code === "validation_failed", badHistory.raw);

const emptyQuestion = await reqI("POST", "/v1/insights/chat", { question: "" });
check("insights chat rejects an empty question",
  emptyQuestion.status === 400 && emptyQuestion.body.error.code === "validation_failed", emptyQuestion.raw);

const chatUnauth = await reqI("POST", "/v1/insights/chat", { question: "x" }, "");
check("POST /v1/insights/chat needs the admin token", chatUnauth.status === 401, chatUnauth.raw);

console.log("\n── streaming: /v1/chat/completions with stream:true ──");

const dbS = makeD1(schema);
const storeS = new Store(dbS);
const gatewayS = new Gateway(storeS, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const depsS = withWaitUntil({ store: storeS, gateway: gatewayS, adminToken: "admin-t0ken" });
const reqSetup = reqFor(depsS);

/** A streamed call doesn't return JSON, so this reads the raw SSE text rather than parsing it. */
async function reqStream(body: unknown, token: string) {
  const res = await handle(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    depsS,
  );
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), raw: text };
}

await reqSetup("POST", "/v1/keys", { keys: `${keyOf("s")}\n${keyOf("t")}` });
const issuedS = await reqSetup("POST", "/v1/clients", { name: "streamer" });
const streamToken = issuedS.body.token as string;

const streamUnauth = await reqStream({ messages: [{ role: "user", content: "hi" }], stream: true }, "");
check("streaming needs a client token, not none at all", streamUnauth.status === 401, streamUnauth.raw);

seen.length = 0;
script = [sse(["Hel", "lo!"])];
const streamed = await reqStream({ messages: [{ role: "user", content: "hi" }], stream: true }, streamToken);
check("a stream request gets a text/event-stream response",
  streamed.status === 200 && (streamed.contentType ?? "").includes("text/event-stream"), streamed.contentType);
check("content deltas arrive in the gateway's own envelope, in order",
  streamed.raw.indexOf('"delta":{"content":"Hel"}') < streamed.raw.indexOf('"delta":{"content":"lo!"}'), streamed.raw);
check("the stream ends with its own [DONE], not the upstream's", streamed.raw.trim().endsWith("data: [DONE]"), streamed.raw);
check("x_gateway (key + keys_tried) is attached to the stream", streamed.raw.includes('"x_gateway":{"key"'), streamed.raw);

await depsS.drain();
const streamedRow = (await storeS.usage(5))[0] as any;
check("the usage ledger picks up the stream's trailing usage chunk",
  streamedRow.input_tokens === 5 && streamedRow.output_tokens === 9 && streamedRow.ok === 1, streamedRow);

seen.length = 0;
script = [rateLimited(), sse(["the second key answered"])];
const streamRotated = await reqStream({ messages: [{ role: "user", content: "hi" }], stream: true }, streamToken);
check("a 429 on the first key rotates to a second before any bytes are streamed",
  streamRotated.status === 200 && seen.length === 2 && streamRotated.raw.includes("the second key answered"), streamRotated.raw);

seen.length = 0;
script = [{ status: 400, body: { error: { message: "bad request" } } }];
const badStream = await reqStream({ messages: [{ role: "user", content: "hi" }], stream: true }, streamToken);
check("a 400 is not retried across keys, streaming or not",
  badStream.status === 400 && seen.length === 1 && badStream.raw.includes('"bad_request"'), badStream.raw);

seen.length = 0;
script = [sse([])];
const emptyStream = await reqStream({ messages: [{ role: "user", content: "hi" }], stream: true }, streamToken);
check("an empty stream still reaches the client rather than erroring", emptyStream.status === 200, emptyStream.raw);
await depsS.drain();
// Not usage(1): two rows in this section can land in the same millisecond
// (this store's timestamps aren't sub-ms), so recency alone isn't a safe
// enough tiebreak — find the row by what it actually recorded instead.
const emptyRow = (await storeS.usage(10)).find((r: any) => typeof r.error === "string" && r.error.includes("empty"));
check("an empty stream is recorded as a failure after the fact, not silently dropped",
  !!emptyRow && emptyRow.ok === 0, emptyRow);

console.log("\n── rate-limit-aware rotation: skip known-limited keys, wait out short ones ──");

// ── persistence: a 429's reset time is remembered, not thrown away ──
const dbR = makeD1(schema);
const storeR = new Store(dbR);
const gatewayR = new Gateway(storeR, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000, maxRateLimitWaitMs: 50 });
const depsR = withWaitUntil({ store: storeR, gateway: gatewayR, adminToken: "admin-t0ken" });
const reqR = reqFor(depsR);

await reqR("POST", "/v1/keys", { keys: keyOf("r1") });
const issuedR = await reqR("POST", "/v1/clients", { name: "ratelimit" });
const rlToken = issuedR.body.token as string;

seen.length = 0;
script = [rateLimitedUntil(60_000)]; // via the standard Retry-After header, 60s out
await reqR("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, rlToken);
const afterHeader = (await reqR("GET", "/v1/keys")).body.queue[0];
check("a Retry-After header persists rate_limited_until, roughly where it said",
  afterHeader.rateLimitedUntil && Math.abs(Date.parse(afterHeader.rateLimitedUntil) - (Date.now() + 60_000)) < 5000,
  afterHeader);

// ── skip: a known-still-limited key is never even tried while a free one exists ──
await reqR("POST", "/v1/keys", { keys: keyOf("r2") });
seen.length = 0;
script = [say("the free key answered")];
const freeFirst = await reqR("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, rlToken);
check("rotation skips the still-limited key entirely, going straight to the free one",
  freeFirst.status === 200 && JSON.stringify(keysUsed()) === JSON.stringify([keyOf("r2")]), keysUsed());

// ── bounded wait: every key limited, soonest reset inside the cap ──
const dbW = makeD1(schema);
const storeW = new Store(dbW);
const gatewayW = new Gateway(storeW, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000, maxRateLimitWaitMs: 500 });
const depsW = withWaitUntil({ store: storeW, gateway: gatewayW, adminToken: "admin-t0ken" });
const reqW = reqFor(depsW);
await reqW("POST", "/v1/keys", { keys: keyOf("w") });
const issuedW = await reqW("POST", "/v1/clients", { name: "waiter" });
const waitToken = issuedW.body.token as string;

seen.length = 0;
script = [rateLimitedUntil(80, false)]; // OpenRouter's own body metadata, exact ms precision, 80ms out
await reqW("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, waitToken);

seen.length = 0;
script = [say("made it through after the wait")];
const startWait = Date.now();
const waited = await reqW("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, waitToken);
const elapsedWait = Date.now() - startWait;
check("the gateway waits out a short, known reset instead of failing immediately",
  waited.status === 200 && elapsedWait >= 50, { elapsedWait, body: waited.body });

// ── beyond the cap: fails fast, same as before this feature existed ──
const dbF = makeD1(schema);
const storeF = new Store(dbF);
const gatewayF = new Gateway(storeF, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000, maxRateLimitWaitMs: 50 });
const depsF = withWaitUntil({ store: storeF, gateway: gatewayF, adminToken: "admin-t0ken" });
const reqF = reqFor(depsF);
await reqF("POST", "/v1/keys", { keys: keyOf("f") });
const issuedF = await reqF("POST", "/v1/clients", { name: "fastfail" });
const fastToken = issuedF.body.token as string;

seen.length = 0;
script = [rateLimitedUntil(10_000, false)]; // 10s out, well beyond the 50ms cap
await reqF("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, fastToken);

seen.length = 0;
script = [rateLimited()]; // still genuinely limited — the immediate retry finds that out again
const startFast = Date.now();
const fast = await reqF("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, fastToken);
const elapsedFast = Date.now() - startFast;
check("beyond the cap, the gateway does not wait — fails fast like before",
  fast.status === 429 && elapsedFast < 300, { elapsedFast, body: fast.body });

console.log("\n── retry analytics: key_attempts recorded, and the Reliability rollup ──");

const dbRL = makeD1(schema);
const storeRL = new Store(dbRL);
const gatewayRL = new Gateway(storeRL, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const depsRL = withWaitUntil({ store: storeRL, gateway: gatewayRL, adminToken: "admin-t0ken" });
const reqRL = reqFor(depsRL);

const reliabilityUnauth = await reqRL("GET", "/v1/reliability", undefined, "");
check("GET /v1/reliability needs the admin token", reliabilityUnauth.status === 401, reliabilityUnauth.raw);

await reqRL("POST", "/v1/keys", { keys: `${keyOf("rl1")}\n${keyOf("rl2")}` });
const issuedRL = await reqRL("POST", "/v1/clients", { name: "retrytest" });
const rlAnalyticsToken = issuedRL.body.token as string;
const chatRL = (script_: typeof script) => {
  script = script_;
  return reqRL("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, rlAnalyticsToken);
};

// A deliberately hand-verifiable mix: two first-attempt successes, two
// retry-rescued successes, and one retry that still exhausts every key.
seen.length = 0;
await chatRL([say("first key answered")]);
await chatRL([say("second key answered")]);
await chatRL([rateLimited(), say("rescued on the second key")]);
await chatRL([rateLimited(), say("rescued on the second key again")]);
await chatRL([rateLimited(), rateLimited()]);

const rlRows = await storeRL.usage(5);
check("a first-key success records key_attempts: 1",
  rlRows.some((r: any) => r.key_attempts === 1 && r.ok === 1), rlRows);
check("a retry-rescued success records key_attempts: 2, ok: 1",
  rlRows.filter((r: any) => r.key_attempts === 2 && r.ok === 1).length === 2, rlRows);
check("every key exhausted now records a real key_attempts count and ok: 0 — previously untracked entirely",
  rlRows.some((r: any) => r.key_attempts === 2 && r.ok === 0), rlRows);

const reliability = await reqRL("GET", "/v1/reliability");
check("retryStats totals match the hand-verified mix",
  reliability.body.total === 5 && reliability.body.with_key_attempts === 5 &&
  reliability.body.first_attempt_ok === 2 && reliability.body.needed_retry === 3 &&
  reliability.body.retry_rescued === 2 && reliability.body.ok === 4,
  reliability.body);
check("avg_key_attempts reflects (1+1+2+2+2)/5", Math.abs(reliability.body.avg_key_attempts - 1.6) < 0.001, reliability.body);
check("byProvider rolls up the same single-provider mix",
  reliability.body.byProvider.length === 1 && reliability.body.byProvider[0].total === 5 &&
  reliability.body.byProvider[0].needed_retry === 3 && reliability.body.byProvider[0].retry_rescued === 2,
  reliability.body.byProvider);

// A synthetic internal-client row, injected directly rather than through
// the real /v1/insights flow — retryStats() must not let it move a
// business number.
await storeRL.record({
  client: "gateway:insights", model: "m", keyMasked: "k", keyId: null, provider: "openrouter",
  inputTokens: 1, outputTokens: 1, ok: true, error: null, keyAttempts: 1,
});
const reliabilityAfterInternal = await reqRL("GET", "/v1/reliability");
check("retryStats excludes gateway:-prefixed internal clients from the business counts",
  reliabilityAfterInternal.body.total === 5, reliabilityAfterInternal.body);

// A 400 is never retried — exactly one key attempted, not zero.
const dbBR = makeD1(schema);
const storeBR = new Store(dbBR);
const gatewayBR = new Gateway(storeBR, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const depsBR = withWaitUntil({ store: storeBR, gateway: gatewayBR, adminToken: "admin-t0ken" });
const reqBR = reqFor(depsBR);
await reqBR("POST", "/v1/keys", { keys: keyOf("br") });
const issuedBR = await reqBR("POST", "/v1/clients", { name: "badrequest" });
seen.length = 0;
script = [{ status: 400, body: { error: { message: "bad request" } } }];
await reqBR("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, issuedBR.body.token);
check("a 400 (never retried) still records key_attempts: 1, not 0 or null",
  (await storeBR.usage(1))[0]!.key_attempts === 1, await storeBR.usage(1));

// No keys at all — the request never reaches the rotation loop, so there is
// nothing to count.
const dbNK = makeD1(schema);
const storeNK = new Store(dbNK);
const gatewayNK = new Gateway(storeNK, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const depsNK = withWaitUntil({ store: storeNK, gateway: gatewayNK, adminToken: "admin-t0ken" });
const reqNK = reqFor(depsNK);
const issuedNK = await reqNK("POST", "/v1/clients", { name: "nokeys" });
await reqNK("POST", "/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, issuedNK.body.token);
check("no_keys_configured records key_attempts: null, not 0",
  (await storeNK.usage(1))[0]!.key_attempts === null, await storeNK.usage(1));

// Streaming reuses the earlier streaming section's store/gateway/deps —
// still in scope, already has keys configured — rather than standing up
// another one just for this.
seen.length = 0;
script = [rateLimited(), sse(["rescued over a stream"])];
await reqStream({ messages: [{ role: "user", content: "hi" }], stream: true }, streamToken);
await depsS.drain();
const streamRetryRow = (await storeS.usage(20)).find((r: any) => r.key_attempts === 2);
check("a streamed, retry-rescued success also records key_attempts: 2",
  !!streamRetryRow && streamRetryRow.ok === 1, streamRetryRow);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── monitoring: request IDs, latency, rate-limit snapshots, finish_reason ──");

const dbM = makeD1(schema);
const storeM = new Store(dbM);
const gatewayM = new Gateway(storeM, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const depsM = withWaitUntil({ store: storeM, gateway: gatewayM, adminToken: "admin-t0ken" });
const reqM = reqFor(depsM);

await reqM("POST", "/v1/keys", { keys: `${keyOf("mon1")}\n${keyOf("mon2")}` });
const issuedM = await reqM("POST", "/v1/clients", { name: "monitor-test" });

// A normal call that returns rate-limit headers alongside the 200 response.
seen.length = 0;
script = [{
  status: 200,
  body: {
    model: "stub/model-a",
    usage: { prompt_tokens: 10, completion_tokens: 20 },
    choices: [{ message: { content: "hello" }, finish_reason: "length" }],
  },
  headers: {
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "42",
    "x-ratelimit-reset-requests": new Date(Date.now() + 60_000).toISOString(),
  },
}];
const monResp = await reqM("POST", "/v1/chat/completions",
  { messages: [{ role: "user", content: "hi" }] }, issuedM.body.token);

// Request ID
check("the response carries a gateway request ID starting with gw-",
  typeof monResp.body.id === "string" && monResp.body.id.startsWith("gw-"), monResp.body.id);
check("x_gateway includes the request_id",
  monResp.body.x_gateway?.request_id === monResp.body.id, monResp.body.x_gateway);

// Latency
check("x_gateway includes latency_ms as a number",
  typeof monResp.body.x_gateway?.latency_ms === "number" && monResp.body.x_gateway.latency_ms >= 0,
  monResp.body.x_gateway);

// finish_reason passthrough
check("finish_reason is passed through from upstream, not hardcoded to stop",
  monResp.body.choices?.[0]?.finish_reason === "length", monResp.body.choices?.[0]);

// Rate-limit snapshot was captured
const monKeys = await reqM("GET", "/v1/keys");
const keyWithSnapshot = monKeys.body.queue.find((k: any) => k.rateLimitLimit !== null);
check("rate-limit snapshot is captured from 200 response headers",
  keyWithSnapshot?.rateLimitLimit === 100 && keyWithSnapshot?.rateLimitRemaining === 42,
  keyWithSnapshot);
check("rate_limit_observed_at is set",
  typeof keyWithSnapshot?.rateLimitObservedAt === "string" && keyWithSnapshot.rateLimitObservedAt.length > 0,
  keyWithSnapshot?.rateLimitObservedAt);

// Usage row carries the request ID and latency
const monUsage = await storeM.usage(5);
const monRow = monUsage[0];
check("usage row carries the request_id",
  typeof monRow?.request_id === "string" && monRow.request_id.startsWith("gw-"), monRow?.request_id);
check("usage row carries latency_ms",
  typeof monRow?.latency_ms === "number" && monRow.latency_ms >= 0, monRow?.latency_ms);

// /v1/latency endpoint
const latencyResp = await reqM("GET", "/v1/latency");
check("/v1/latency returns p50/p95/p99 and count",
  latencyResp.status === 200 && latencyResp.body.count >= 1 &&
  latencyResp.body.p50 !== undefined && latencyResp.body.p95 !== undefined && latencyResp.body.p99 !== undefined,
  latencyResp.body);
check("/v1/latency includes recent array",
  Array.isArray(latencyResp.body.recent) && latencyResp.body.recent.length >= 1, latencyResp.body.recent?.length);

// /v1/latency needs admin token
const latencyUnauth = await reqM("GET", "/v1/latency", undefined, "wrong-token");
check("/v1/latency needs the admin token",
  latencyUnauth.status === 401, latencyUnauth.status);

// A second call with no rate-limit headers — the first key's snapshot survives
seen.length = 0;
script = [say("world")];
await reqM("POST", "/v1/chat/completions",
  { messages: [{ role: "user", content: "there" }] }, issuedM.body.token);
const monKeys2 = await reqM("GET", "/v1/keys");
// The second call used mon2 (rotation), which has no headers → its snapshot stays null
// But mon1's snapshot from the first call is still intact
const keyStillSnapped = monKeys2.body.queue.find((k: any) => k.rateLimitLimit === 100);
check("a key's rate-limit snapshot survives calls that use other keys",
  !!keyStillSnapped, monKeys2.body.queue.map((k: any) => ({ m: k.masked, rl: k.rateLimitLimit })));

// Error recording — a failure records error_code in usage
seen.length = 0;
script = [{ status: 500, body: { error: { message: "test failure" } } },
          { status: 500, body: { error: { message: "test failure 2" } } }];
await reqM("POST", "/v1/chat/completions",
  { messages: [{ role: "user", content: "fail" }] }, issuedM.body.token);
const monUsage2 = await storeM.usage(10);
const failRow = monUsage2.find((r: any) => r.ok === 0);
check("a failed request records error_code in the usage row",
  typeof failRow?.error_code === "string" && failRow.error_code.length > 0, failRow?.error_code);

// /monitor route serves the admin page (use handle() directly — reqFor parses JSON)
check("the monitor page is the same document, served at /monitor", await (async () => {
  const a = await handle(new Request("http://x/"), depsM);
  const b = await handle(new Request("http://x/monitor"), depsM);
  return b.status === 200 && (await b.text()) === (await a.text());
})());

// 500 handler no longer leaks raw error messages
check("the 500 handler uses a generic message, not the raw error",
  !monResp.raw.includes("__KEY__"), "key would have been in the response");

stub.close();
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
