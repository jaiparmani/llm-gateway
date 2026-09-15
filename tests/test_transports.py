"""REST and gRPC are adapters, so the thing worth testing is that they agree.

Both are driven against the same stubbed provider and the same store, and the
last test asserts they return the same answer for the same question — which is
the only real guarantee that a rule fixed in one is fixed in both.
"""

import json

import grpc
import pytest
from fastapi.testclient import TestClient

from gateway.gen import llm_pb2, llm_pb2_grpc
from gateway.grpc_server import LlmServicer
from gateway.rest import build_app
from tests.conftest import key


# ── REST ────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(store, settings, gateway):
    return TestClient(build_app(store, settings, gateway), raise_server_exceptions=False)


@pytest.fixture
def token(store):
    return store.issue_client("brain")


def auth(t):
    return {"Authorization": f"Bearer {t}"}


def test_health_is_public(client):
    assert client.get("/health").json()["ok"] is True


def test_inference_requires_a_client_token(client):
    r = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 401


def test_a_revoked_client_is_locked_out(client, store, token):
    store.revoke_client("brain")
    r = client.post("/v1/chat/completions",
                    json={"messages": [{"role": "user", "content": "hi"}]}, headers=auth(token))
    assert r.status_code == 401


def test_chat_completions_is_openai_shaped(client, store, provider, token):
    """The whole point: an existing OpenRouter client changes only its URL."""
    store.add_key(key("a"))
    provider.script = [provider.say("hello there")]
    r = client.post("/v1/chat/completions",
                    json={"messages": [{"role": "user", "content": "hi"}], "model": "x"},
                    headers=auth(token))
    body = r.json()
    assert r.status_code == 200
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["content"] == "hello there"
    assert body["choices"][0]["message"]["role"] == "assistant"
    assert body["usage"]["total_tokens"] == 18
    # The extra block is additive, so a strict OpenAI client just ignores it.
    assert body["x_gateway"]["key"].endswith("aaaa")


def test_response_format_is_passed_upstream(client, store, provider, token):
    store.add_key(key("a"))
    provider.script = [provider.json_say({"a": 1})]
    client.post("/v1/chat/completions",
                json={"messages": [{"role": "user", "content": "hi"}],
                      "response_format": {"type": "json_object"}},
                headers=auth(token))
    assert provider.seen[0]["body"]["response_format"] == {"type": "json_object"}


def test_json_endpoint_returns_a_parsed_object(client, store, provider, token):
    store.add_key(key("a"))
    provider.script = [provider.say('prose\n```json\n{"items":[1,2]}\n```')]
    r = client.post("/v1/json",
                    json={"messages": [{"role": "user", "content": "q"}], "expect_key": "items"},
                    headers=auth(token))
    assert r.json()["data"] == {"items": [1, 2]}
    assert r.json()["attempts"] == 1


def test_no_keys_is_503_not_500(client, token):
    r = client.post("/v1/chat/completions",
                    json={"messages": [{"role": "user", "content": "hi"}]}, headers=auth(token))
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "no_keys_configured"


def test_exhausted_quota_is_429_with_a_reset(client, store, provider, token):
    store.add_key(key("a"))
    provider.script = [provider.rate_limited()]
    r = client.post("/v1/chat/completions",
                    json={"messages": [{"role": "user", "content": "hi"}]}, headers=auth(token))
    assert r.status_code == 429
    assert r.json()["error"]["reset_at"]


# ── key management ──────────────────────────────────────────────────────────

def test_key_management_needs_the_admin_token(client, token):
    assert client.get("/v1/keys", headers=auth(token)).status_code == 401
    assert client.get("/v1/keys", headers=auth("admin-t0ken")).status_code == 200


def test_several_keys_can_be_pasted_at_once(client):
    r = client.post("/v1/keys", json={"keys": f"{key('a')}\n{key('b')}, {key('c')}"},
                    headers=auth("admin-t0ken"))
    assert r.status_code == 201
    assert len(r.json()["added"]) == 3


def test_a_malformed_key_is_refused_with_a_reason(client):
    r = client.post("/v1/keys", json={"keys": "hunter2"}, headers=auth("admin-t0ken"))
    assert r.status_code == 400
    assert "OpenRouter key" in json.dumps(r.json())
    assert "hunter2" not in json.dumps(r.json())


def test_listing_keys_never_returns_one(client):
    client.post("/v1/keys", json={"keys": key("a")}, headers=auth("admin-t0ken"))
    body = client.get("/v1/keys", headers=auth("admin-t0ken")).text
    assert key("a") not in body
    assert "sk-or-v1-aaa...aaaa" in body


def test_a_client_token_is_shown_once_and_stored_hashed(client, store):
    r = client.post("/v1/clients", json={"name": "toolbox"}, headers=auth("admin-t0ken"))
    issued = r.json()["token"]
    assert store.authenticate(issued) == "toolbox"
    # The listing never carries it back.
    assert issued not in client.get("/v1/clients", headers=auth("admin-t0ken")).text


def test_the_admin_page_is_served(client):
    r = client.get("/")
    assert r.status_code == 200 and "llm-gateway" in r.text


# ── gRPC ────────────────────────────────────────────────────────────────────

class FakeContext:
    """Enough grpc.ServicerContext for the servicer under test."""

    def __init__(self, token=""):
        self._md = (("authorization", f"Bearer {token}"),) if token else ()
        self.code = None
        self.details = None

    def invocation_metadata(self):
        return self._md

    def abort(self, code, details):
        self.code, self.details = code, details
        raise _Aborted(details)


class _Aborted(Exception):
    pass


@pytest.fixture
def servicer(store, settings, gateway):
    return LlmServicer(store, settings, gateway)


def test_grpc_requires_a_token(servicer):
    ctx = FakeContext()
    with pytest.raises(_Aborted):
        servicer.Chat(llm_pb2.ChatRequest(messages=[llm_pb2.Message(role="user", content="hi")]), ctx)
    assert ctx.code == grpc.StatusCode.UNAUTHENTICATED


def test_grpc_chat(servicer, store, provider, token):
    store.add_key(key("a"))
    provider.script = [provider.say("over grpc")]
    reply = servicer.Chat(
        llm_pb2.ChatRequest(messages=[llm_pb2.Message(role="user", content="hi")]),
        FakeContext(token),
    )
    assert reply.content == "over grpc"
    assert reply.input_tokens == 7 and reply.output_tokens == 11
    assert reply.key_masked.endswith("aaaa")


def test_grpc_json(servicer, store, provider, token):
    store.add_key(key("a"))
    provider.script = [provider.say('junk\n{"items":[1]}')]
    reply = servicer.Json(
        llm_pb2.JsonRequest(messages=[llm_pb2.Message(role="user", content="q")], expect_key="items"),
        FakeContext(token),
    )
    assert json.loads(reply.json) == {"items": [1]}


def test_grpc_maps_no_keys_to_failed_precondition(servicer, token):
    ctx = FakeContext(token)
    with pytest.raises(_Aborted):
        servicer.Chat(llm_pb2.ChatRequest(messages=[llm_pb2.Message(role="user", content="hi")]), ctx)
    assert ctx.code == grpc.StatusCode.FAILED_PRECONDITION


def test_grpc_maps_quota_to_resource_exhausted(servicer, store, provider, token):
    store.add_key(key("a"))
    provider.script = [provider.rate_limited()]
    ctx = FakeContext(token)
    with pytest.raises(_Aborted):
        servicer.Chat(llm_pb2.ChatRequest(messages=[llm_pb2.Message(role="user", content="hi")]), ctx)
    assert ctx.code == grpc.StatusCode.RESOURCE_EXHAUSTED


def test_grpc_keys_never_returns_a_key(servicer, store, token):
    store.add_key(key("a"))
    reply = servicer.Keys(llm_pb2.KeysRequest(), FakeContext(token))
    assert key("a") not in str(reply)
    assert reply.queue[0].next is True


# ── the guarantee that makes two transports safe ────────────────────────────

def test_rest_and_grpc_give_the_same_answer(client, servicer, store, provider, token):
    store.add_key(key("a"))

    provider.script = [provider.say('{"answer":"same"}')]
    rest = client.post("/v1/json", json={"messages": [{"role": "user", "content": "q"}]},
                       headers=auth(token)).json()["data"]

    provider.script = [provider.say('{"answer":"same"}')]
    grpc_reply = servicer.Json(
        llm_pb2.JsonRequest(messages=[llm_pb2.Message(role="user", content="q")]),
        FakeContext(token),
    )

    assert rest == json.loads(grpc_reply.json)


def test_both_transports_share_one_key_queue(client, servicer, store, provider, token):
    """A separate queue per transport would burn the front key twice as fast."""
    store.add_key(key("a"))
    store.add_key(key("b"))

    provider.script = [provider.say("via rest")]
    client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]},
                headers=auth(token))

    provider.script = [provider.say("via grpc")]
    servicer.Chat(llm_pb2.ChatRequest(messages=[llm_pb2.Message(role="user", content="hi")]),
                  FakeContext(token))

    # REST took the front key; gRPC must have taken the other one.
    assert provider.keys_used == [key("a"), key("b")]


def test_usage_records_which_transport_was_used(client, servicer, store, provider, token):
    store.add_key(key("a"))
    provider.script = [provider.say("x")]
    client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]},
                headers=auth(token))
    provider.script = [provider.say("y")]
    servicer.Chat(llm_pb2.ChatRequest(messages=[llm_pb2.Message(role="user", content="hi")]),
                  FakeContext(token))

    transports = {row["transport"] for row in store.usage()}
    assert transports == {"rest", "grpc"}
