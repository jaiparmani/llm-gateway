"""Settings, all from the environment. No secrets in this repo, ever."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    upstream_url: str
    default_model: str
    admin_token: str
    rest_port: int
    grpc_port: int
    request_timeout: float
    referer: str
    title: str

    @property
    def configured(self) -> bool:
        return bool(self.admin_token)


def load() -> Settings:
    return Settings(
        # A file by default so `docker run` with no volume still works; point at
        # a mounted path or Postgres for anything you care about keeping.
        database_url=os.environ.get("DATABASE_URL", "gateway.db"),
        upstream_url=os.environ.get(
            "UPSTREAM_URL", "https://openrouter.ai/api/v1/chat/completions"
        ),
        default_model=os.environ.get("DEFAULT_MODEL", "openrouter/free"),
        # Gates the admin UI and key management. Without it the gateway will
        # serve traffic but refuse to let anyone add or remove keys.
        admin_token=os.environ.get("ADMIN_TOKEN", ""),
        rest_port=int(os.environ.get("REST_PORT", "8080")),
        grpc_port=int(os.environ.get("GRPC_PORT", "50051")),
        request_timeout=float(os.environ.get("REQUEST_TIMEOUT", "45")),
        referer=os.environ.get("OPENROUTER_REFERER", "https://github.com/jaiparmani/llm-gateway"),
        title=os.environ.get("OPENROUTER_TITLE", "llm-gateway"),
    )
