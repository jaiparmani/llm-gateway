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

// ── a stub OpenRouter ───────────────────────────────────────────────────────
let script: { status: number; body: unknown }[] = [];
const seen: { auth: string; body: any }[] = [];

const stub = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  seen.push({ auth: req.headers.authorization ?? "", body: JSON.parse(Buffer.concat(chunks).toString()) });
  const next = script.shift() ?? { status: 200, body: { choices: [{ message: { content: "{}" } }] } };
  res.writeHead(next.status, { "content-type": "application/json" });
  // __KEY__ stands for whichever key this call actually carried, so a scripted
  // reply can echo the credential back the way a real provider might.
  res.end(JSON.stringify(next.body).split("__KEY__").join(seen.at(-1)!.auth.replace("Bearer ", "")));
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
// A hard failure — not a 429, not an empty completion — the kind that now
// rotates to the next key and counts toward benching one.
const serverError = () => ({
  status: 500,
  body: { error: { message: "internal error at __KEY__" } },
});
const keyOf = (n: string) => "sk-or-v1-" + (n.repeat(64)).slice(0, 64);
const keysUsed = () => seen.map((s) => s.auth.replace("Bearer ", ""));

// ── harness ─────────────────────────────────────────────────────────────────
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const db = makeD1(schema);
const store = new Store(db);
const gateway = new Gateway(store, { defaultModel: "stub/default", upstreamUrl, timeoutMs: 5000 });
const deps = { store, gateway, adminToken: "admin-t0ken" };

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
const deps2 = { store: store2, gateway: gateway2, adminToken: "admin-t0ken" };
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
function reqFor(deps: { store: Store; gateway: Gateway; adminToken: string }) {
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
const deps3 = { store: store3, gateway: gateway3, adminToken: "admin-t0ken" };
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
const deps4 = { store: store4, gateway: gateway4, adminToken: "admin-t0ken" };
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
const deps5 = { store: store5, gateway: gateway5, adminToken: "admin-t0ken" };
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
const deps6 = { store: store6, gateway: gateway6, adminToken: "admin-t0ken" };
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
const deps7 = { store: store7, gateway: gateway7, adminToken: "admin-t0ken" };
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
const deps8 = { store: store8, gateway: gateway8, adminToken: "admin-t0ken" };
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
const deps9 = { store: store9, gateway: gateway9, adminToken: "admin-t0ken" };
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

stub.close();
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
