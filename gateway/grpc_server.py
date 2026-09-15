"""gRPC surface.

Same adapter job as rest.py against the same `Gateway` — the point of this
service is that a rule is written once and both transports inherit it.

Worth being clear about why both exist: gRPC is the faster path for
service-to-service callers (one HTTP/2 connection, binary frames, no JSON
parse per call), but it is not universally reachable. Cloudflare Workers, for
one, cannot speak it, so a REST surface is not a nicety here — it is the only
way some callers can get in at all.
"""

from __future__ import annotations

import json as jsonlib
from concurrent import futures

import grpc

from .config import Settings
from .gen import llm_pb2, llm_pb2_grpc
from .service import Gateway, GatewayError, Message
from .store import Store

# GatewayError codes mapped onto the closest gRPC status.
_STATUS = {
    "no_keys_configured": grpc.StatusCode.FAILED_PRECONDITION,
    "rate_limited": grpc.StatusCode.RESOURCE_EXHAUSTED,
    "bad_model_output": grpc.StatusCode.INTERNAL,
    "upstream_error": grpc.StatusCode.UNAVAILABLE,
}


class LlmServicer(llm_pb2_grpc.LlmServicer):
    def __init__(self, store: Store, settings: Settings, gateway: Gateway | None = None) -> None:
        self.store = store
        self.settings = settings
        self.gw = gateway or Gateway(store, settings)

    # ── auth ────────────────────────────────────────────────────────────────

    def _client(self, context: grpc.ServicerContext) -> str:
        """Same per-client bearer token as REST, carried in call metadata."""
        metadata = dict(context.invocation_metadata() or {})
        raw = metadata.get("authorization", "")
        token = raw[7:].strip() if raw[:7].lower() == "bearer " else raw.strip()
        name = self.store.authenticate(token)
        if not name:
            context.abort(
                grpc.StatusCode.UNAUTHENTICATED,
                "Send metadata authorization: Bearer <client token>.",
            )
        return name

    @staticmethod
    def _messages(request) -> list[Message]:
        return [Message(m.role, m.content) for m in request.messages]

    def _fail(self, context: grpc.ServicerContext, client: str, exc: GatewayError):
        self.gw.record(client=client, transport="grpc", completion=None, error=str(exc))
        context.abort(_STATUS.get(exc.code, grpc.StatusCode.UNKNOWN), str(exc))

    # ── rpcs ────────────────────────────────────────────────────────────────

    def Chat(self, request, context):
        client = self._client(context)
        try:
            completion = self.gw.chat(
                self._messages(request),
                model=request.model or None,
                max_tokens=request.max_tokens or None,
                json_object=request.json_object,
            )
        except GatewayError as exc:
            return self._fail(context, client, exc)

        self.gw.record(client=client, transport="grpc", completion=completion, error=None)
        return llm_pb2.ChatResponse(
            content=completion.content,
            model=completion.model,
            input_tokens=completion.input_tokens or 0,
            output_tokens=completion.output_tokens or 0,
            key_masked=completion.key_masked,
        )

    def Json(self, request, context):
        client = self._client(context)
        try:
            parsed, completion = self.gw.json(
                self._messages(request),
                model=request.model or None,
                max_tokens=request.max_tokens or None,
                expect_key=request.expect_key or None,
                max_attempts=request.max_attempts or 2,
            )
        except GatewayError as exc:
            return self._fail(context, client, exc)

        self.gw.record(client=client, transport="grpc", completion=completion, error=None)
        return llm_pb2.JsonResponse(
            json=jsonlib.dumps(parsed),
            model=completion.model,
            input_tokens=completion.input_tokens or 0,
            output_tokens=completion.output_tokens or 0,
            attempts=completion.attempts,
            key_masked=completion.key_masked,
        )

    def Keys(self, request, context):
        self._client(context)
        view = self.gw.queue_view()
        return llm_pb2.KeysResponse(
            configured=view["configured"],
            note=view["note"],
            queue=[
                llm_pb2.KeyInfo(
                    masked=k["masked"], label=k["label"], uses=k["uses"], next=k["next"],
                    last_used_at=k["last_used_at"] or "",
                    last_rate_limited_at=k["last_rate_limited_at"] or "",
                )
                for k in view["queue"]
            ],
        )

    def Health(self, request, context):
        return llm_pb2.HealthResponse(ok=True, keys=len(self.store.keys()), version="0.1.0")


def serve(store: Store, settings: Settings, gateway: Gateway | None = None) -> grpc.Server:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=16))
    llm_pb2_grpc.add_LlmServicer_to_server(LlmServicer(store, settings, gateway), server)
    server.add_insecure_port(f"[::]:{settings.grpc_port}")
    server.start()
    return server
