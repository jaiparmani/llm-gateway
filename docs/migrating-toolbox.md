# Pointing ToolBox at the gateway

ToolBox (`jaiparmani/ToolBoxWebServices`) already does everything this gateway does,
in `toolboxservices/llm/client.py`: key queue, rotation, salvaging, retry. This is the
diff that hands those jobs over — **without touching the five `call_json` call sites**
in `expenses/services.py` and `insights/services.py`.

Nothing here has been applied. It is written for a live app on `feature/test`, so read
it before running it.

## Step 1 — issue ToolBox a token

On the gateway:

```bash
python -m gateway client add toolbox
```

Copy the `lgw_…` token. It is shown once.

## Step 2 — two settings

```diff
  # toolboxservices/settings.py
- OPENROUTER_API_KEY = os.environ.get('OPENROUTER_API_KEY', '')
  OPENROUTER_MODEL = os.environ.get('OPENROUTER_MODEL', 'openrouter/free')
+ # The gateway holds the keys now. This is ToolBox's client token, not a provider key.
+ LLM_GATEWAY_URL = os.environ.get('LLM_GATEWAY_URL', '')
+ LLM_GATEWAY_TOKEN = os.environ.get('LLM_GATEWAY_TOKEN', '')
+ # Kept so a stored key still works if the gateway is ever unreachable.
+ OPENROUTER_API_KEY = os.environ.get('OPENROUTER_API_KEY', '')
```

## Step 3 — one function in `llm/client.py`

The gateway speaks OpenAI's response shape, so `_post` needs only a different URL and
a different bearer. Everything below it — `extract_json`, `call_json`, the retry, the
`LLMRateLimited` handling — keeps working unchanged.

```diff
- OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
+ OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
+
+
+ def _endpoint_and_key(api_key):
+     """Prefer the gateway; fall back to a locally stored key.
+
+     The gateway owns the keys, the rotation and the daily cap. A stored key is
+     the escape hatch for the gateway being down, not the normal path.
+     """
+     url = getattr(settings, 'LLM_GATEWAY_URL', '')
+     token = getattr(settings, 'LLM_GATEWAY_TOKEN', '')
+     if url and token:
+         return url.rstrip('/') + '/v1/chat/completions', token
+     return OPENROUTER_URL, api_key
```

and in `_post`:

```diff
  def _post(messages, api_key, model, timeout, max_tokens):
+     url, bearer = _endpoint_and_key(api_key)
      body = { ... }
      try:
          response = requests.post(
-             OPENROUTER_URL,
+             url,
              headers={
-                 "Authorization": f"Bearer {api_key}",
+                 "Authorization": f"Bearer {bearer}",
                  "Content-Type": "application/json",
              },
```

## Step 4 — let `_candidate_keys` yield when the gateway is configured

Today `_candidate_keys()` raises `LLMNotConfigured` when no key is stored. With the
gateway there is nothing to store, so it must not raise:

```diff
  def _candidate_keys():
      ...
      if not candidates:
+         # The gateway carries the keys; one placeholder drives one pass through
+         # the loop, and the real rotation happens on the other side.
+         if getattr(settings, 'LLM_GATEWAY_URL', '') and getattr(settings, 'LLM_GATEWAY_TOKEN', ''):
+             return [(None, None)]
          raise LLMNotConfigured(...)
```

## What this leaves in place, deliberately

- The `OpenRouterKey` table, admin and management command. Empty in normal operation,
  but a place to drop a key back in if the gateway is unreachable.
- `extract_json` and `call_json`. The gateway salvages too, but ToolBox's own copy
  costs nothing and means a gateway change cannot break expense parsing.
- All five `call_json` call sites. Untouched.

## The fuller migration, when you want it

Once this has run for a while, `POST /v1/json` replaces most of `client.py`: send the
messages and `expect_key`, get a parsed object back. That deletes `extract_json`, the
retry loop and the key queue from ToolBox entirely — about 200 lines — and leaves
`call_json` as an HTTP call plus the caller's `validate`. Worth doing only after the
gateway has earned the trust.

## Rollback

Unset `LLM_GATEWAY_URL`. `_endpoint_and_key` falls back to the stored keys and ToolBox
is exactly where it was.
