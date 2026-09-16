# Pointing ToolBox at the gateway

**Applied.** `jaiparmani/ToolBoxWebServices`, branch `feature/llm-gateway`, commit
`5febda5`. Not merged and not deployed — this is what it does and how to finish or
undo it.

## What changed

Three files, and none of the call sites.

`_post()` in `llm/client.py` picks a different URL and a different bearer when the
gateway is configured. That is the whole switch, and it is small because the gateway
answers in OpenAI's response shape: `extract_json`, the retry loop, the `validate`
callbacks and all five `call_json` sites in `expenses/services.py` and
`insights/services.py` are untouched.

`_candidate_keys()` no longer raises when the key table is empty — with the gateway
configured there is nothing to queue locally, so it yields one placeholder to drive a
single pass through the retry loop and lets `_post()` route it out.

Two gateway-specific conditions get their own errors, because both are configuration
and a generic upstream error hides the fix:

- **401** → `LLMNotConfigured`, naming `LLM_GATEWAY_TOKEN`
- **503** → `LLMError`, saying the keys need adding on the gateway, not here

## Finishing it

Issue ToolBox a client token — on the gateway's Console tab, or:

```bash
curl -s -X POST https://llm-gateway.brain-store.workers.dev/v1/clients \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"toolbox"}'
```

Then set two variables wherever PythonAnywhere holds this app's environment — the
WSGI config file, typically:

```
LLM_GATEWAY_URL=https://llm-gateway.brain-store.workers.dev
LLM_GATEWAY_TOKEN=lgw_...
```

Reload the web app. `LLM_GATEWAY_TOKEN` is ToolBox's client token, **not** an
OpenRouter key, and cannot be used as one.

## What stays, deliberately

The `OpenRouterKey` table, its admin, the management command and the
`OPENROUTER_API_KEY` fallback. They are the escape hatch, not dead weight: unset
`LLM_GATEWAY_URL` and ToolBox is exactly where it started, with its stored keys still
working. Emptying that table is a later cleanup, once the gateway has earned it.

## Rollback

Unset `LLM_GATEWAY_URL` and reload. One variable, no deploy, no migration.

## The fuller migration, later

`POST /v1/json` replaces most of `client.py`: send the messages and `expect_key`, get
a parsed object back. That deletes `extract_json`, the retry loop and the key queue
from ToolBox — around 200 lines — leaving `call_json` as an HTTP call plus the
caller's `validate`. Worth doing only once the thin version has run for a while.
