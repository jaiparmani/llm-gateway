# llm-gateway

One place for the LLM API keys, so no other repo has to hold them.

Every app that wanted an LLM used to carry its own copy of the same three things:
a set of OpenRouter keys, a rotation scheme to make the free tier last, and a pile
of defensive code to survive whatever the model actually returned. Three copies
means three places to rotate a key and three chances to get the hard part wrong.

```
                    ┌──────────────────────────┐
  brain ───REST────▶│                          │
  (Cloudflare       │       llm-gateway        │───▶ OpenRouter
   Worker)          │                          │
                    │  keys · rotation         │
  ToolBox ──gRPC───▶│  JSON salvage · retry    │
  (Django)          │  per-client auth · usage │
                    └──────────────────────────┘
  anything else ────▶  REST or gRPC, same core
```

The keys live here and nowhere else.

## Why two transports

**gRPC** is the fast path: one HTTP/2 connection, binary frames, no JSON parse per
call, and a generated client that fails at compile time rather than at 3am. For a
Python service calling a Python service it is the obvious choice.

**REST** exists because gRPC is not universally reachable. Cloudflare Workers cannot
speak it — no HTTP/2 trailers, no raw sockets — and `brain` is a Worker. A gRPC-only
gateway would simply be unreachable from half of what needs it.

Both are thin adapters over [`gateway/service.py`](gateway/service.py). Every rule —
rotation, retry, salvaging, accounting — is written once there, and a test asserts the
two surfaces return the same answer to the same question, because two transports that
disagree are worse than one transport.

## What it actually does for you

**Round-robin keys.** Take the key at the front of the queue, use it, push it to the
back. N keys give N times the free tier's daily cap instead of one key being spent
down while the others idle. A 429 pushes that key to the back and the next one serves
the same request — a 429 does not consume quota, so there is nothing to bench and
nothing to remember about which keys are "spent". The queue sorts itself out.

**Surviving the free pool.** The default `openrouter/free` model routes every call to
a different model. Some wrap the object in prose, some emit a `<think>` block
containing its own braces, some ignore JSON mode entirely and fence the whole reply.
[`salvage.py`](gateway/salvage.py) strips all of that and scans for balanced `{...}`
spans by brace counting — string-aware, so a brace inside a value does not miscount —
preferring the object that carries the key you asked for. A reply that still is not
usable earns one retry with a correction, which often lands on a model that behaves.

**Per-client tokens.** Each app gets its own, so usage is attributable and one app can
be cut off without touching the others. Tokens are stored as hashes and compared in
constant time; a token is shown once, at issue.

**A usage ledger.** Every call records which client, which transport, which model
actually served it, which key, and the token counts — visible at `/` and `/v1/usage`.

## Endpoints

| | |
|---|---|
| `POST /v1/chat/completions` | **OpenAI-shaped.** An existing OpenRouter client moves here by changing one URL and one key. |
| `POST /v1/json` | Salvages and validates server-side; returns a parsed object. |
| `GET /v1/keys` · `POST` · `DELETE /v1/keys/{id}` | The rotation queue. Admin token. Masked values only. |
| `GET /v1/clients` · `POST` · `DELETE /v1/clients/{name}` | Issue and revoke client tokens. Admin token. |
| `GET /v1/usage` | Per-client and per-key accounting. Admin token. |
| `GET /health` | Public. |
| `GET /` | The admin UI: add keys, issue tokens, read the ledger. |

gRPC mirrors it: `Chat`, `Json`, `Keys`, `Health` — see [`proto/llm.proto`](proto/llm.proto).
Auth is the same bearer token, in call metadata.

## Running it

```bash
make install
cp .env.example .env    # set ADMIN_TOKEN: openssl rand -hex 32
make serve
```

REST on `:8080` with the admin UI at `/`, gRPC on `:50051`. Or:

```bash
docker compose up --build
```

Open `/`, unlock with your `ADMIN_TOKEN`, paste your keys, and issue a token per app.
Keys can also be managed from the CLI:

```bash
python -m gateway key add sk-or-v1-... "laptop"
python -m gateway key list
python -m gateway client add brain
```

**Mount a volume.** The database holds the keys, so a container without `/data`
mounted comes back up with an empty queue.

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

For gRPC, generate a client from `proto/llm.proto` and send the same token as
`authorization` metadata.

## Security

The one rule: **a key goes in and never comes back out.** Every API response and every
pixel of the UI shows `sk-or-v1-abc...wxyz`, never a value — there is a test for it on
each surface. Keys sit in the database in plaintext, exactly as they did in the Django
table this replaces: anyone with database access can read them, which is why the
database is gitignored, belongs on a volume you control, and should not be world-readable.

`ADMIN_TOKEN` gates every management endpoint. Leave it unset and the gateway still
serves inference but refuses to let anyone add or remove a key.

## Tests

```bash
make test
```

43 tests: the salvaging, the rotation, the retry, both transports, and the two that
matter most — REST and gRPC returning the same answer, and both sharing one key queue
rather than each burning the front key.
