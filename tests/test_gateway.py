"""The rules, once, regardless of transport."""

import json

import pytest

from gateway.salvage import SalvageError, extract_json
from gateway.service import BadModelOutput, Message, NoKeysConfigured, RateLimited
from tests.conftest import key


# ── salvaging whatever the free pool returns ────────────────────────────────

def test_plain_json():
    assert extract_json('{"a":1}')["a"] == 1

def test_fenced_json():
    assert extract_json('```json\n{"a":2}\n```')["a"] == 2

def test_json_wrapped_in_prose():
    assert extract_json("Sure! Here you go:\n{\"a\":3}\nHope that helps.")["a"] == 3

def test_think_block_is_stripped():
    assert extract_json('<think>{"wrong":1}</think>{"a":4}')["a"] == 4

def test_expect_key_beats_a_preamble_object():
    text = '{"reasoning":"first"} then {"items":[1,2]}'
    assert extract_json(text, "items")["items"] == [1, 2]

def test_braces_inside_strings_do_not_miscount():
    assert extract_json('{"a":"a { brace }","b":5}')["b"] == 5

def test_unparseable_text_raises():
    with pytest.raises(SalvageError):
        extract_json("no json here at all")


# ── key rotation ────────────────────────────────────────────────────────────

def test_no_keys_is_a_clear_error(gateway):
    with pytest.raises(NoKeysConfigured):
        gateway.chat([Message("user", "hi")])


def test_round_robin_spreads_calls_evenly(gateway, store, provider):
    for n in "abc":
        store.add_key(key(n))
    for i in range(6):
        provider.script = [provider.say(f"reply {i}")]
        gateway.chat([Message("user", "hi")])

    used = provider.keys_used
    assert len(used) == 6
    # Two calls each, never the same key twice running — round robin, not failover.
    for n in "abc":
        assert used.count(key(n)) == 2
    assert all(a != b for a, b in zip(used, used[1:]))


def test_rate_limited_key_steps_aside_within_the_same_call(gateway, store, provider):
    store.add_key(key("a"))
    store.add_key(key("b"))
    provider.script = [provider.rate_limited(), provider.say("second key served it")]

    result = gateway.chat([Message("user", "hi")])
    assert result.content == "second key served it"
    assert len(provider.keys_used) == 2
    # The 429'd key is marked, so the UI can show why it went quiet.
    limited = [k for k in store.keys() if k.last_rate_limited_at]
    assert len(limited) == 1


def test_all_keys_exhausted_reports_the_quota_message(gateway, store, provider):
    store.add_key(key("a"))
    store.add_key(key("b"))
    provider.script = [provider.rate_limited(), provider.rate_limited()]
    with pytest.raises(RateLimited) as excinfo:
        gateway.chat([Message("user", "hi")])
    assert "quota" in str(excinfo.value).lower()
    assert excinfo.value.extra["reset_at"]


def test_a_new_key_joins_at_the_back(gateway, store, provider):
    store.add_key(key("a"))
    provider.script = [provider.say("x")]
    gateway.chat([Message("user", "hi")])       # 'a' goes to the back
    store.add_key(key("b"))                      # joins behind it
    assert [k.masked for k in store.keys()][0] == store.keys()[0].masked
    provider.script = [provider.say("y")]
    gateway.chat([Message("user", "hi")])
    # 'a' had position 2, 'b' got 3, so 'a' serves again before 'b'.
    assert provider.keys_used[-1] == key("a")


def test_duplicate_keys_are_refused(store):
    assert store.add_key(key("a")) is not None
    assert store.add_key(key("a")) is None


# ── json calls ──────────────────────────────────────────────────────────────

def test_json_salvages_a_messy_reply(gateway, store, provider):
    store.add_key(key("a"))
    provider.script = [provider.say('<think>{"draft":1}</think>\nOK:\n```json\n{"answer":42}\n```')]
    parsed, completion = gateway.json([Message("user", "q")], expect_key="answer")
    assert parsed == {"answer": 42}
    assert completion.attempts == 1
    assert completion.model == "stub/model-a"


def test_json_retries_once_then_gives_up(gateway, store, provider):
    store.add_key(key("a"))
    provider.script = [provider.say("I cannot do that"), provider.say("still no")]
    with pytest.raises(BadModelOutput):
        gateway.json([Message("user", "q")])
    assert len(provider.seen) == 2


def test_the_retry_carries_the_correction(gateway, store, provider):
    store.add_key(key("a"))
    provider.script = [provider.say("nope"), provider.json_say({"ok": True})]
    parsed, completion = gateway.json([Message("user", "q")])
    assert parsed == {"ok": True}
    assert completion.attempts == 2
    retry_messages = provider.seen[1]["body"]["messages"]
    assert retry_messages[-1]["content"].startswith("That was not usable")


def test_json_mode_is_requested(gateway, store, provider):
    store.add_key(key("a"))
    provider.script = [provider.json_say({"a": 1})]
    gateway.json([Message("user", "q")])
    assert provider.seen[0]["body"]["response_format"] == {"type": "json_object"}


def test_the_model_that_served_is_reported_not_the_one_asked_for(gateway, store, provider):
    store.add_key(key("a"))
    provider.script = [provider.json_say({"a": 1}, model="meta/llama-actually")]
    _, completion = gateway.json([Message("user", "q")], model="openrouter/free")
    assert completion.model == "meta/llama-actually"


# ── accounting ──────────────────────────────────────────────────────────────

def test_usage_is_recorded_per_client(gateway, store, provider):
    store.add_key(key("a"))
    store.issue_client("brain")
    store.issue_client("toolbox")
    for name in ("brain", "brain", "toolbox"):
        provider.script = [provider.say("x")]
        completion = gateway.chat([Message("user", "hi")])
        gateway.record(client=name, transport="rest", completion=completion, error=None)

    summary = store.summary()
    assert summary["calls"] == 3
    by_client = {row["client"]: row["calls"] for row in summary["by_client"]}
    assert by_client == {"brain": 2, "toolbox": 1}


def test_a_key_is_never_in_the_public_view(gateway, store):
    store.add_key(key("a"), "laptop")
    view = gateway.queue_view()
    assert key("a") not in json.dumps(view)
    assert view["queue"][0]["masked"].count(".") == 3
    assert view["queue"][0]["next"] is True
