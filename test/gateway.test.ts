import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Gateway } from "../src/gateway.ts";
import { handle } from "../src/router.ts";
import { extractJson } from "../src/salvage.ts";
import { mask, Store } from "../src/store.ts";
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

script = [{ status: 401, body: { error: { message: "No auth credentials found for __KEY__" } } }];
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

stub.close();
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
