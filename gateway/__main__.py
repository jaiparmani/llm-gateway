"""Entry point: runs both servers, and the small CLI that bootstraps them.

    python -m gateway serve                 REST + gRPC together
    python -m gateway key add <key> [label]
    python -m gateway key list
    python -m gateway client add <name>     prints a token, once
"""

from __future__ import annotations

import sys
import threading

from . import __version__, config
from .store import Store


def _store(settings) -> Store:
    return Store(settings.database_url)


def serve(settings) -> None:
    import uvicorn

    from .grpc_server import serve as serve_grpc
    from .rest import build_app
    from .service import Gateway

    store = _store(settings)
    # One Gateway, one key queue, shared by both transports — otherwise the two
    # surfaces would rotate independently and each burn the front key.
    gateway = Gateway(store, settings)

    grpc_server = serve_grpc(store, settings, gateway)
    print(f"llm-gateway {__version__}")
    print(f"  REST  http://0.0.0.0:{settings.rest_port}   (admin UI at /)")
    print(f"  gRPC  0.0.0.0:{settings.grpc_port}")
    print(f"  keys  {len(store.keys())} in rotation")
    if not settings.admin_token:
        print("  ADMIN_TOKEN is unset — key management is disabled until you set it.")

    app = build_app(store, settings, gateway)
    try:
        uvicorn.run(app, host="0.0.0.0", port=settings.rest_port, log_level="info")
    finally:
        grpc_server.stop(grace=2)


def main(argv: list[str]) -> int:
    settings = config.load()
    command = argv[0] if argv else "serve"

    if command == "serve":
        serve(settings)
        return 0

    if command == "key":
        store = _store(settings)
        action = argv[1] if len(argv) > 1 else "list"
        if action == "add":
            if len(argv) < 3:
                print("usage: python -m gateway key add <key> [label]")
                return 1
            record = store.add_key(argv[2], argv[3] if len(argv) > 3 else "")
            print(f"added {record.masked}" if record else "already stored")
            return 0
        if action == "remove" and len(argv) > 2:
            print("removed" if store.remove_key(int(argv[2])) else "no such key")
            return 0
        for key in store.keys():
            print(f"{key.id:>3}  {key.masked}  {key.uses:>5} calls  {key.label}")
        return 0

    if command == "client":
        store = _store(settings)
        if len(argv) > 2 and argv[1] == "add":
            print(store.issue_client(argv[2]))
            print("^ copy this now; only its hash is stored", file=sys.stderr)
            return 0
        if len(argv) > 2 and argv[1] == "revoke":
            print("revoked" if store.revoke_client(argv[2]) else "no such client")
            return 0
        for row in store.clients():
            print(f"{row['name']:<16} {row['calls']:>6} calls  last seen {row['last_seen'] or 'never'}")
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
