# llm-gateway

One place for the LLM API keys, so no other repo has to hold them.

Every app that wanted an LLM used to carry its own copy of the same three things:
a set of provider keys, a rotation scheme to make each free tier last, and a pile
of defensive code to survive whatever the model actually returned. Three copies
means three places to rotate a key and three chances to get the hard part wrong.

```
  brain ──────────────┐
  (Worker)            │     ┌──────────────────────────┐     ┌─ OpenRouter
                      ├────▶│       llm-gateway        │─────┼─ Gemini
  ToolBox ────────────┤     │    (Cloudflare Worker)   │     ├─ Groq
  (Django)            │     │                          │     ├─ Cerebras
                      │     │  keys · rotation         │     └─ Mistral
  anything else ──────┘     │  JSON salvage · retry    │
                            │  per-client auth · usage │
                            └──────────────────────────┘
```

The keys live here and nowhere else. One queue rotates across every provider —
see [`src/providers.ts`](src/providers.ts) for the registry, which is also where
a new free-tier provider gets added.

Live at <https://llm-gateway.brain-store.workers.dev>. Its first caller is
[brain](https://github.com/jaiparmani/brain-store), which holds a client token and no
provider key at all.

## Why a Worker

It runs on Cloudflare's free plan with no card and **no cold start**, which matters
more than it sounds: an LLM call already takes several seconds, and a free host that
sleeps after fifteen idle minutes would put a minute in front of the first one and
time the caller out.

Storage is **D1**, not KV, because this writes on every call — rotation and
accounting. D1's free plan allows a hundred thousand writes a day where KV allows a
thousand, and a queue wants real SQL rather than read-modify-write on a JSON blob
that two concurrent calls would clobber.

**REST only.** An earlier draft was a Python service with a gRPC surface alongside —
it is in the git history at `783d4ab` if it is ever wanted back. gRPC is genuinely
faster for service-to-service calls, but Cloudflare's edge does not proxy it and a
Worker cannot act as a gRPC client either, so `brain` — the first thing that needed
this — could never have reached it. A transport half the callers cannot use is not
worth a second implementation to keep in sync.

## What it actually does for you

**Five free providers, one queue.** [`src/providers.ts`](src/providers.ts) holds the
registry — OpenRouter, [Google Gemini](https://ai.google.dev/), [Groq](https://groq.com/),
[Cerebras](https://cerebras.ai/), and [Mistral](https://mistral.ai/) — each just an
upstream URL, a default model, and what a key for it looks like. All five speak the same
shape (Bearer auth, `{model, messages}` in, OpenAI-style `{choices, usage, model}` out),
which is what lets one rotation loop and one `post()` serve every one of them. Adding a
sixth is a registry entry, not a new code path.

**Round-robin keys, across providers.** Take the key at the front of the queue, use it,
push it to the back — it does not matter whose key is next, only that it is one. N keys
give N times the free tier's daily cap instead of one key being spent down while the
others idle, and mixing providers means a provider's own outage or tightened rate limit
no longer stalls every call. A 429 pushes that key to the back and the next one serves
the same request — a 429 does not consume quota, so there is nothing to bench and
nothing to remember about which keys are "spent". The queue sorts itself out.

**Rotating past a real failure, and benching what stays broken.** A 429 or an empty
completion were never the whole story — a revoked key (401), a model id a provider
retired (404), an outage (5xx or a network failure) used to abort the entire request,
even with healthy keys sitting right behind it in the queue. Now those rotate to the
next key too. Unlike a 429 (merely spent) or an empty completion (the model's fault, not
the key's), this kind of failure *is* evidence the key or its provider is actually
broken, so it also counts: five in a row and the key is benched, skipped by normal
rotation until a call succeeds or an admin clears it from the console. A provider-wide
problem — a retired model id 404ing identically for every key on that provider — needs
no separate detection, since it benches every one of that provider's keys the same way.
The one upstream failure that does *not* rotate is a 400: that means this gateway's own
request was unacceptable, every key would get the identical rejection, and rotating
would just spend healthy keys relearning what one attempt already showed. Benching can
never wedge the queue shut, either — if every key ends up benched at once, the gateway
still tries all of them rather than answering as if none were configured; a success
clears the bench the same way the console's manual "un-bench" does.

**Surviving the free pool.** The default `openrouter/free` model routes every call to
a different model. Some wrap the object in prose, some emit a `<think>` block
containing its own braces, some ignore JSON mode entirely and fence the whole reply.
[`salvage.ts`](src/salvage.ts) strips all of that and scans for balanced `{...}`
spans by brace counting — string-aware, so a brace inside a value does not miscount —
preferring the object that carries the key you asked for. A reply that still is not
usable earns one retry with a correction, which often lands on a model that behaves.

**Testing a key on its own.** `POST /v1/keys/{id}/test` sends the smallest call the
provider will take, using that one key and never falling through to the next. A typo
is worth catching the moment it is pasted rather than a week later, when every caller
has quietly been served by the other keys. A 429 counts as a pass — the provider only
rate limits a key it recognises, so the key is good and merely spent.

**Per-client tokens.** Each app gets its own, so usage is attributable and one app can
be cut off without touching the others. Tokens are stored as hashes and looked up by
hash; a token is shown once, at issue.

**A chat page.** `/chat` is the same single HTML file as the console, on the same
gateway, so there is somewhere to actually use the LLM rather than only administer it.
It authenticates with a **client token, not the admin one** — it is a caller like any
other, it shows up in the ledger under its own name, and nobody needs the admin token
to have a conversation. Each reply says which model answered and which key served it,
which the default pool makes worth knowing: it routes every call somewhere else.

**A usage ledger.** Every call records which client, which model actually served it,
which key, and the token counts — visible at `/` and `/v1/usage`.

## Endpoints

| | |
|---|---|
| `POST /v1/chat/completions` | **OpenAI-shaped.** An existing OpenRouter client moves here by changing one URL and one key. |
| `POST /v1/json` | Salvages and validates server-side; returns a parsed object. |
| `GET /v1/keys` · `POST` · `DELETE /v1/keys/{id}` | The rotation queue. `POST` takes a `provider` field (see `GET /v1/providers`), defaulting to `openrouter`. Each key reports whether it is currently benched and why. Admin token. Masked values only. |
| `POST /v1/keys/{id}/test` | Asks the provider about that one key, outside the rotation. Admin token. |
| `POST /v1/keys/{id}/unbench` | Manually clears a key's benched state — the same effect a successful call has, for after you've fixed whatever was wrong upstream. Admin token. |
| `GET /v1/providers` | The provider registry — id, label, and what a key looks like. Public, no secrets in it. |
| `GET /v1/models` · `POST` | Each provider's effective model and any override. `POST {provider, model}` sets one; an empty `model` clears it. Admin token. |
| `GET /v1/clients` · `POST` · `DELETE /v1/clients/{name}` | Issue and revoke client tokens. Admin token. |
| `GET /v1/usage` | Per-client and per-key accounting. Admin token. |
| `GET /health` | Public. |
| `GET /` | The console: add keys, test them, issue tokens, read the ledger. |
| `GET /chat` | A chat page, on a client token, for actually using the thing. |

## Running it

```bash
npm install
npx wrangler d1 create llm-gateway        # put the id in wrangler.toml
npm run db:init                           # apply schema.sql
npx wrangler secret put ADMIN_TOKEN       # openssl rand -hex 32
npm run deploy
```

Open the Worker URL, unlock with your `ADMIN_TOKEN`, pick a provider, paste your keys,
press Test on each one, and issue a token per app. `/chat` takes one of those tokens if
you want to talk to it. `npm run dev` runs it locally against a local D1.

Without `ADMIN_TOKEN` set, the gateway still serves inference but refuses to let
anyone add or remove a key — it disables management rather than failing open.

Each provider in [`src/providers.ts`](src/providers.ts) already has a sensible free-tier
default model. Providers rename and retire models often enough that this needed to be
fixable without a deploy — the console's "Default models" card sets a per-provider
override straight in D1 (`GET`/`POST /v1/models`). `wrangler.toml`'s
`DEFAULT_MODEL_GEMINI` / `DEFAULT_MODEL_GROQ` / `DEFAULT_MODEL_CEREBRAS` /
`DEFAULT_MODEL_MISTRAL` (OpenRouter keeps plain `DEFAULT_MODEL`, as before) still work as
a lower-priority fallback, mainly for a fresh deployment before anyone has opened the
console.

**Upgrading an existing deployment:** each file under [`migrations/`](migrations) is
applied once, in order — `db:migrate` runs the newest one, so after pulling several
releases at once, run the older ones by hand first (each file's header has the exact
`wrangler d1 execute` command):

```bash
wrangler d1 execute llm-gateway --remote --file=migrations/0001_add_provider.sql          # if not already applied
wrangler d1 execute llm-gateway --remote --file=migrations/0002_add_provider_models.sql   # if not already applied
npm run db:migrate                        # applies migrations/0003_add_key_health.sql
npm run deploy
```

Every key already stored was an OpenRouter key — the only provider that existed before
this — so migration 0001's default backfills them correctly with nothing further to do.
Migration 0003 backfills every existing key as unbenched with zero failures, which is
correct for the same reason: nothing about a key's history before the upgrade should
count toward benching it now.

## Migrating keys in

If keys already live somewhere else, move them without ever putting one on screen:

```bash
GATEWAY_URL=https://llm-gateway.example.workers.dev ADMIN_TOKEN=... \
  KV_NAMESPACE_ID=... node scripts/import-from-brain-kv.mjs
```

It pipes them from Cloudflare KV straight into the gateway — not through a file, not
through shell history — reports the masked forms it stored, and prints the command to
delete the old copy once you have checked the count.

## Pointing something at it

Anything already calling OpenRouter changes two values:

```diff
- OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
- Authorization: Bearer sk-or-v1-...
+ OPENROUTER_URL = "https://<gateway>/v1/chat/completions"
+ Authorization: Bearer lgw_...          # this app's client token
```

The response shape is unchanged, so parsing, validation and retry logic on the client
keep working untouched. Callers that want the hardening for free can move to
`POST /v1/json` and delete their own copy of it.

[`docs/migrating-toolbox.md`](docs/migrating-toolbox.md) has that diff written out for
the Django side, unapplied.

## Security

The one rule: **a key goes in and never comes back out.** Every API response and every
pixel of the UI shows a masked form like `sk-or-v1-abc...wxyz`, never a value — there is
a test for it on each surface that returns anything. That includes the surfaces that
quote the provider:
a provider is free to echo back the credential it just refused, so anything passing an
upstream message through masks the key inside it first.

Keys sit in D1 in plaintext, exactly as they did in the Django table this replaces:
anyone with access to that database can read them. D1 is private to your Cloudflare
account, and nothing in this repo ever holds one.

`ADMIN_TOKEN` gates every management endpoint, and is compared in constant time.

## Tests

```bash
npm test
```

97 checks: the salvaging, the rotation across one provider and across several, key
health — rotating past a hard failure, benching one that keeps failing, a success
resetting the count, a 429 never counting toward it, and the queue never wedging shut
even with every key benched — model overrides taking effect on the very next call, the
retry, the auth, the accounting, and on every surface that returns anything, an
assertion that a key is not in it. They run against real SQL — a `node:sqlite` stand-in
for D1 — rather than a fake that agrees with whatever the code happens to do.
