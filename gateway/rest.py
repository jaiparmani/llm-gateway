"""REST surface.

Two shapes on purpose:

  POST /v1/chat/completions   OpenAI-compatible. A client already pointed at
                              OpenRouter moves here by changing one URL and one
                              key, with no other code change.
  POST /v1/json               Richer: salvages and validates the JSON server
                              side, so every caller gets the hardening for free
                              instead of each reimplementing it.

Everything below is a thin adapter over gateway/service.py.
"""

from __future__ import annotations

import hmac
import re
import time
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from .config import Settings
from .service import Gateway, GatewayError, Message
from .store import Store, mask

ADMIN_CLIENT = "__admin__"

# Anything else is a typo, and a typo stored is a 401 on every call for a week.
KEY_SHAPE = re.compile(r"sk-or-v1-[A-Za-z0-9]{32,}")


class MessageIn(BaseModel):
    role: str = Field(pattern="^(system|user|assistant)$")
    content: str


class ChatIn(BaseModel):
    messages: list[MessageIn]
    model: str | None = None
    max_tokens: int | None = None
    response_format: dict[str, Any] | None = None


class JsonIn(BaseModel):
    messages: list[MessageIn]
    model: str | None = None
    max_tokens: int | None = None
    expect_key: str | None = None
    max_attempts: int = 2


class KeyIn(BaseModel):
    keys: str
    label: str = ""


class ClientIn(BaseModel):
    name: str = Field(min_length=1, max_length=40, pattern="^[a-z0-9][a-z0-9_-]*$")


def build_app(store: Store, settings: Settings, gateway: Gateway | None = None) -> FastAPI:
    gw = gateway or Gateway(store, settings)
    app = FastAPI(title="llm-gateway", version="0.1.0", docs_url="/docs")

    def client_name(authorization: str = Header(default="")) -> str:
        """Every call is attributed to a named client, so usage is per-app."""
        token = authorization.removeprefix("Bearer ").removeprefix("bearer ").strip()
        name = store.authenticate(token)
        if not name:
            raise HTTPException(401, "Send Authorization: Bearer <client token>.")
        return name

    def admin(authorization: str = Header(default="")) -> str:
        token = authorization.removeprefix("Bearer ").removeprefix("bearer ").strip()
        if not settings.admin_token:
            raise HTTPException(503, "ADMIN_TOKEN is not set, so key management is disabled.")
        if not hmac.compare_digest(token, settings.admin_token):
            raise HTTPException(401, "Admin token required.")
        return ADMIN_CLIENT

    @app.exception_handler(GatewayError)
    async def _gateway_error(_: Request, exc: GatewayError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": exc.code, "message": str(exc), **exc.extra}},
            status_code=exc.status,
        )

    # ── inference ───────────────────────────────────────────────────────────

    @app.post("/v1/chat/completions")
    def chat_completions(body: ChatIn, client: str = Depends(client_name)) -> dict:
        """OpenAI-shaped, so an existing client only changes its base URL."""
        wants_json = (body.response_format or {}).get("type") == "json_object"
        try:
            completion = gw.chat(
                [Message(m.role, m.content) for m in body.messages],
                model=body.model, max_tokens=body.max_tokens, json_object=wants_json,
            )
        except GatewayError as exc:
            gw.record(client=client, transport="rest", completion=None, error=str(exc))
            raise
        gw.record(client=client, transport="rest", completion=completion, error=None)
        return {
            "id": f"gw-{int(time.time() * 1000):x}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": completion.model,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": completion.content},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": completion.input_tokens or 0,
                "completion_tokens": completion.output_tokens or 0,
                "total_tokens": (completion.input_tokens or 0) + (completion.output_tokens or 0),
            },
            # Not part of the OpenAI shape; harmless to clients that ignore it,
            # and the only way to see which key served a call.
            "x_gateway": {"key": completion.key_masked, "keys_tried": completion.keys_tried},
        }

    @app.post("/v1/json")
    def json_call(body: JsonIn, client: str = Depends(client_name)) -> dict:
        try:
            parsed, completion = gw.json(
                [Message(m.role, m.content) for m in body.messages],
                model=body.model, max_tokens=body.max_tokens,
                expect_key=body.expect_key, max_attempts=body.max_attempts,
            )
        except GatewayError as exc:
            gw.record(client=client, transport="rest", completion=None, error=str(exc))
            raise
        gw.record(client=client, transport="rest", completion=completion, error=None)
        return {
            "data": parsed,
            "model": completion.model,
            "attempts": completion.attempts,
            "usage": {
                "input_tokens": completion.input_tokens,
                "output_tokens": completion.output_tokens,
            },
            "x_gateway": {"key": completion.key_masked},
        }

    # ── keys and clients ────────────────────────────────────────────────────

    @app.get("/v1/keys")
    def list_keys(_: str = Depends(admin)) -> dict:
        return gw.queue_view()

    @app.post("/v1/keys", status_code=201)
    def add_keys(body: KeyIn, _: str = Depends(admin)) -> dict:
        """Accepts a paste of several keys — newline, comma or space separated,
        because that is how anyone actually holds a set of them. A key that is
        not shaped like an OpenRouter key is refused with a reason rather than
        stored to 401 on every call later."""
        added: list[dict] = []
        skipped: list[str] = []

        for raw in dict.fromkeys(k for k in re.split(r"[\s,;]+", body.keys) if k):
            if not KEY_SHAPE.fullmatch(raw):
                skipped.append(f"{mask(raw)} — does not look like an OpenRouter key (expected sk-or-v1-…)")
                continue
            record = store.add_key(raw, body.label)
            if record is None:
                skipped.append(f"{mask(raw)} — already stored")
            else:
                added.append(record.public())

        if not added:
            raise HTTPException(400, {"added": [], "skipped": skipped})
        return {
            "added": added,
            "skipped": skipped,
            "note": "Stored. A key is never shown again — only a masked form.",
        }

    @app.delete("/v1/keys/{key_id}")
    def remove_key(key_id: int, _: str = Depends(admin)) -> dict:
        if not store.remove_key(key_id):
            raise HTTPException(404, "No such key.")
        return {"ok": True, "removed": key_id}

    @app.get("/v1/clients")
    def list_clients(_: str = Depends(admin)) -> dict:
        return {"clients": store.clients()}

    @app.post("/v1/clients", status_code=201)
    def create_client(body: ClientIn, _: str = Depends(admin)) -> dict:
        token = store.issue_client(body.name)
        return {
            "name": body.name,
            "token": token,
            "note": "Copy this now — it is hashed on save and cannot be shown again.",
        }

    @app.delete("/v1/clients/{name}")
    def revoke_client(name: str, _: str = Depends(admin)) -> dict:
        if not store.revoke_client(name):
            raise HTTPException(404, "No such client.")
        return {"ok": True, "revoked": name}

    # ── observability ───────────────────────────────────────────────────────

    @app.get("/v1/usage")
    def usage(limit: int = 50, _: str = Depends(admin)) -> dict:
        return {"summary": store.summary(), "recent": store.usage(limit)}

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "keys": len(store.keys()), "version": app.version}

    @app.get("/", response_class=HTMLResponse)
    def admin_page() -> str:
        from .admin import ADMIN_HTML
        return ADMIN_HTML

    return app
