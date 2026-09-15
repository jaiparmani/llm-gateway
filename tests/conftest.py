import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gateway.config import Settings
from gateway.service import Gateway
from gateway.store import Store


class StubProvider:
    """Stands in for OpenRouter. `script` is a queue of canned replies."""

    def __init__(self):
        self.script: list[httpx.Response] = []
        self.seen: list[dict] = []

    def say(self, content, model="stub/model-a"):
        return httpx.Response(200, json={
            "model": model,
            "usage": {"prompt_tokens": 7, "completion_tokens": 11},
            "choices": [{"message": {"content": content}}],
        })

    def json_say(self, obj, model="stub/model-a"):
        return self.say(json.dumps(obj), model)

    def rate_limited(self, reset="1789000000000"):
        return httpx.Response(429, json={"error": {"metadata": {"headers": {"X-RateLimit-Reset": reset}}}})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.seen.append({
            "auth": request.headers.get("authorization", ""),
            "body": json.loads(request.content),
        })
        return self.script.pop(0) if self.script else self.say("{}")

    @property
    def keys_used(self) -> list[str]:
        return [s["auth"].removeprefix("Bearer ") for s in self.seen]


@pytest.fixture
def settings(tmp_path):
    return Settings(
        database_url=str(tmp_path / "t.db"),
        upstream_url="https://stub.invalid/v1/chat/completions",
        default_model="stub/default",
        admin_token="admin-t0ken",
        rest_port=0, grpc_port=0, request_timeout=5,
        referer="r", title="t",
    )


@pytest.fixture
def store(settings):
    return Store(settings.database_url)


@pytest.fixture
def provider():
    return StubProvider()


@pytest.fixture
def gateway(store, settings, provider):
    return Gateway(store, settings, httpx.Client(transport=httpx.MockTransport(provider.handler)))


def key(n: str) -> str:
    return "sk-or-v1-" + (n * 64)[:64]
