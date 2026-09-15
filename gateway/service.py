"""The gateway, minus any transport.

REST and gRPC are both thin adapters over this module. Every rule that matters —
key rotation, retry, JSON salvaging, usage accounting — lives here exactly once,
so the two surfaces cannot drift apart and a fix lands in both at the same time.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx

from .config import Settings
from .salvage import SalvageError, extract_json
from .store import ApiKey, Store

RETRY_INSTRUCTION = (
    "That was not usable. Reply with ONLY a JSON object — no prose, no code fences."
)


class GatewayError(Exception):
    """Something went wrong that the caller should see."""

    status = 502
    code = "upstream_error"

    def __init__(self, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.extra = extra


class NoKeysConfigured(GatewayError):
    status, code = 503, "no_keys_configured"


class RateLimited(GatewayError):
    """One key's quota is spent. Only reaches the caller if every key's is."""

    status, code = 429, "rate_limited"


class BadModelOutput(GatewayError):
    status, code = 502, "bad_model_output"


@dataclass
class Message:
    role: str
    content: str

    def wire(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass
class Completion:
    content: str
    model: str
    input_tokens: int | None
    output_tokens: int | None
    key_masked: str
    attempts: int = 1
    keys_tried: list[str] = field(default_factory=list)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Gateway:
    def __init__(self, store: Store, settings: Settings, client: httpx.Client | None = None) -> None:
        self.store = store
        self.settings = settings
        self._http = client or httpx.Client(timeout=settings.request_timeout)

    # ── the one call that talks to the provider ─────────────────────────────

    def _post(self, messages: list[Message], key: ApiKey, model: str, max_tokens: int | None,
              json_object: bool) -> Completion:
        body: dict[str, Any] = {"model": model, "messages": [m.wire() for m in messages]}
        if json_object:
            # Stops compliant models wrapping the object in prose. Not every
            # model in the free pool honours it, hence salvage.extract_json.
            body["response_format"] = {"type": "json_object"}
        if max_tokens:
            body["max_tokens"] = max_tokens

        try:
            response = self._http.post(
                self.settings.upstream_url,
                json=body,
                headers={
                    "Authorization": f"Bearer {key.key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": self.settings.referer,
                    "X-Title": self.settings.title,
                },
            )
        except httpx.HTTPError as exc:
            raise GatewayError(f"Could not reach the upstream provider: {exc}") from exc

        if response.status_code == 429:
            message, extra = _rate_limit_message(response)
            raise RateLimited(message, **extra)

        if response.status_code >= 400:
            raise GatewayError(
                f"Upstream returned {response.status_code}: {response.text[:300]}",
                status_code=response.status_code,
            )

        payload = response.json()
        choices = payload.get("choices") or []
        if not choices:
            raise BadModelOutput("Upstream returned no choices.")
        content = (choices[0].get("message") or {}).get("content")
        if not content:
            raise BadModelOutput("Upstream returned an empty message.")

        usage = payload.get("usage") or {}
        return Completion(
            content=content,
            # The free pool reports which model actually served the call, and it
            # differs between calls — worth recording rather than echoing back
            # whatever was asked for.
            model=payload.get("model") or model,
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
            key_masked=key.masked,
        )

    # ── rotation ────────────────────────────────────────────────────────────

    def chat(self, messages: list[Message], *, model: str | None = None,
             max_tokens: int | None = None, json_object: bool = False) -> Completion:
        """One completion, rotating keys until one answers or all are spent."""
        keys = self.store.keys()
        if not keys:
            raise NoKeysConfigured(
                "No OpenRouter key is configured on the gateway. Add one at / or with "
                "`python -m gateway key add <key>`."
            )

        chosen_model = model or self.settings.default_model
        last_rate_limit: RateLimited | None = None
        tried: list[str] = []

        for key in keys:
            tried.append(key.masked)
            try:
                completion = self._post(messages, key, chosen_model, max_tokens, json_object)
            except RateLimited as exc:
                # Spent for now. Back of the queue, and let the next key serve.
                self.store.push_to_back(key.id, rate_limited=True)
                last_rate_limit = exc
                continue
            # Used it — back of the queue, so the next call takes a different one.
            self.store.push_to_back(key.id, rate_limited=False)
            completion.keys_tried = tried
            return completion

        raise last_rate_limit or GatewayError("Every configured key was rejected.")

    def json(self, messages: list[Message], *, model: str | None = None,
             max_tokens: int | None = None, expect_key: str | None = None,
             max_attempts: int = 2) -> tuple[dict[str, Any], Completion]:
        """A completion salvaged into a JSON object, retrying once on a bad reply.

        Because the free pool routes to a different model per call, a retry often
        lands on one that behaves — so a single bad responder should not fail the
        request.
        """
        conversation = list(messages)
        last_error: SalvageError | None = None

        for attempt in range(1, max(1, max_attempts) + 1):
            completion = self.chat(
                conversation, model=model, max_tokens=max_tokens, json_object=True
            )
            try:
                parsed = extract_json(completion.content, expect_key)
            except SalvageError as exc:
                last_error = exc
                conversation = list(messages) + [
                    Message("assistant", completion.content[:1000]),
                    Message("user", RETRY_INSTRUCTION),
                ]
                continue
            completion.attempts = attempt
            return parsed, completion

        raise BadModelOutput(
            f"The model would not return usable JSON after {max_attempts} attempts: {last_error}"
        )

    # ── accounting ──────────────────────────────────────────────────────────

    def record(self, *, client: str, transport: str, completion: Completion | None,
               error: str | None) -> None:
        self.store.record(
            client=client,
            transport=transport,
            model=completion.model if completion else None,
            key_masked=completion.key_masked if completion else None,
            input_tokens=completion.input_tokens if completion else None,
            output_tokens=completion.output_tokens if completion else None,
            ok=error is None,
            error=error,
        )

    def queue_view(self) -> dict:
        """Key queue health. Masked values only — nothing here can make a call."""
        keys = self.store.keys()
        return {
            "configured": len(keys),
            "queue": [
                {**k.public(), "next": i == 0}
                for i, k in enumerate(keys)
            ],
            "note": (
                "No keys configured — every call will fail with 503 until one is added."
                if not keys else
                f"{len(keys)} key{'' if len(keys) == 1 else 's'} in rotation. Each call takes the "
                "key at the front and sends it to the back, so the free tier's daily cap multiplies "
                "instead of being spent down on one key."
            ),
        }


def _rate_limit_message(response: httpx.Response) -> tuple[str, dict]:
    """A sentence the caller can act on, plus when it is worth retrying."""
    reset = None
    try:
        meta = (response.json().get("error") or {}).get("metadata") or {}
        raw = (meta.get("headers") or {}).get("X-RateLimit-Reset")
        if raw:
            reset = datetime.fromtimestamp(int(raw) / 1000, tz=timezone.utc).isoformat()
    except (ValueError, AttributeError, TypeError):
        pass

    message = "The upstream provider's request quota is used up."
    if reset:
        message += f" It resets at {reset[:16].replace('T', ' ')} UTC."
    message += " Try again after that, or add another key to the gateway."
    return message, {"reset_at": reset}
