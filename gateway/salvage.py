"""Pulling a usable JSON object out of whatever a model actually returned.

The default `openrouter/free` pool routes every call to a different model, so
the request is the easy part — surviving the response is the work. Some models
wrap the object in prose, some emit a <think> block containing its own braces
first, some ignore json_object mode entirely and fence the whole thing.

This module is the one place that knows about all of that, so callers only have
to say what shape they wanted.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterator


class SalvageError(ValueError):
    """The reply held nothing that could be read as a JSON object."""


_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCE = re.compile(r"```(?:json)?|```")


def _json_spans(text: str) -> Iterator[str]:
    """Yield every balanced {...} span in `text`, outermost first.

    Brace counting rather than a regex: a greedy ``\\{.*\\}`` swallows everything
    between the first and last brace, which is exactly wrong when a reasoning
    preamble contains its own object. Quoted strings and escapes are tracked so
    a brace inside a value does not miscount.
    """
    depth = 0
    start = -1
    in_string = False
    escaped = False

    for i, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth:
                depth -= 1
                if depth == 0 and start >= 0:
                    yield text[start:i + 1]


def extract_json(text: str, expect_key: str | None = None) -> dict[str, Any]:
    """Read the answer object out of a model reply.

    With `expect_key`, prefers the first balanced object carrying that key, so a
    reasoning preamble containing some other object does not win.
    """
    cleaned = _FENCE.sub("", _THINK.sub("", text))

    try:
        candidate = json.loads(cleaned)
        if isinstance(candidate, dict):
            return candidate
    except json.JSONDecodeError:
        pass

    fallback: dict[str, Any] | None = None
    for span in _json_spans(cleaned):
        try:
            candidate = json.loads(span)
        except json.JSONDecodeError:
            continue
        if not isinstance(candidate, dict):
            continue
        if expect_key is None or expect_key in candidate:
            return candidate
        if fallback is None:
            fallback = candidate

    if fallback is not None:
        return fallback
    raise SalvageError("Could not find a JSON object in the model's response.")
