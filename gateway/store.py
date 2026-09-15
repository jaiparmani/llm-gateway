"""SQLite-backed storage: the key queue, client tokens, and a usage ledger.

The key queue is a direct port of the Django `OpenRouterKey` model this service
replaces — a `position` column, lowest at the front, and `push_to_back()` after
every use. Keeping the same shape means the behaviour is the one already proven
in production rather than a second invention.

One key allows a limited number of free-tier requests per day. Several multiply
that: take the key at the front, use it, push it to the back, so calls spread
evenly instead of burning one key down and failing over. A key that comes back
rate limited goes to the back too and the next is tried — a 429 does not consume
quota, so there is nothing to remember about which keys are "spent".
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_keys (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    key                  TEXT    NOT NULL UNIQUE,
    masked               TEXT    NOT NULL,
    label                TEXT    NOT NULL DEFAULT '',
    position             INTEGER NOT NULL DEFAULT 0,
    uses                 INTEGER NOT NULL DEFAULT 0,
    last_used_at         TEXT,
    last_rate_limited_at TEXT,
    created_at           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_position ON api_keys (position, id);

CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    token_hash TEXT    NOT NULL,
    calls      INTEGER NOT NULL DEFAULT 0,
    last_seen  TEXT,
    created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT    NOT NULL,
    client        TEXT    NOT NULL,
    transport     TEXT    NOT NULL,
    model         TEXT,
    key_masked    TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    ok            INTEGER NOT NULL,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS usage_at ON usage (at DESC);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def mask(key: str) -> str:
    """Never show a whole key. Same shape as the Django side it replaces."""
    if len(key) <= 14:
        return f"{key[:4]}...{key[-2:]}"
    return f"{key[:12]}...{key[-4:]}"


@dataclass
class ApiKey:
    id: int
    key: str
    masked: str
    label: str
    position: int
    uses: int
    last_used_at: str | None
    last_rate_limited_at: str | None
    created_at: str

    def public(self) -> dict:
        """What the API and UI are allowed to see. Never includes `key`."""
        return {
            "id": self.id,
            "masked": self.masked,
            "label": self.label,
            "uses": self.uses,
            "last_used_at": self.last_used_at,
            "last_rate_limited_at": self.last_rate_limited_at,
            "created_at": self.created_at,
        }


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        # check_same_thread=False plus a lock: the REST and gRPC servers share
        # one store across threads, and SQLite is happier with one connection
        # guarded than with a pool it cannot see.
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._tx() as cur:
            cur.executescript(SCHEMA)
            cur.execute("PRAGMA journal_mode=WAL")

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Cursor]:
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            finally:
                cur.close()

    # ── keys ────────────────────────────────────────────────────────────────

    def _next_position(self, cur: sqlite3.Cursor) -> int:
        row = cur.execute("SELECT COALESCE(MAX(position), 0) AS m FROM api_keys").fetchone()
        return int(row["m"]) + 1

    def add_key(self, key: str, label: str = "") -> ApiKey | None:
        """Adds a key at the back of the queue. None if it is already there."""
        with self._tx() as cur:
            if cur.execute("SELECT 1 FROM api_keys WHERE key = ?", (key,)).fetchone():
                return None
            cur.execute(
                "INSERT INTO api_keys (key, masked, label, position, created_at) VALUES (?,?,?,?,?)",
                (key, mask(key), label[:60], self._next_position(cur), _now()),
            )
            return self._row_to_key(
                cur.execute("SELECT * FROM api_keys WHERE id = ?", (cur.lastrowid,)).fetchone()
            )

    def keys(self) -> list[ApiKey]:
        """The queue, front first."""
        with self._tx() as cur:
            rows = cur.execute("SELECT * FROM api_keys ORDER BY position, id").fetchall()
        return [self._row_to_key(r) for r in rows]

    def remove_key(self, key_id: int) -> bool:
        with self._tx() as cur:
            cur.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
            return cur.rowcount > 0

    def push_to_back(self, key_id: int, *, rate_limited: bool) -> None:
        """Send this key to the end of the queue, so the next call takes another."""
        with self._tx() as cur:
            cur.execute(
                """UPDATE api_keys
                      SET position = ?, uses = uses + 1, last_used_at = ?,
                          last_rate_limited_at = CASE WHEN ? THEN ? ELSE last_rate_limited_at END
                    WHERE id = ?""",
                (self._next_position(cur), _now(), 1 if rate_limited else 0, _now(), key_id),
            )

    @staticmethod
    def _row_to_key(row: sqlite3.Row) -> ApiKey:
        return ApiKey(
            id=row["id"], key=row["key"], masked=row["masked"], label=row["label"],
            position=row["position"], uses=row["uses"], last_used_at=row["last_used_at"],
            last_rate_limited_at=row["last_rate_limited_at"], created_at=row["created_at"],
        )

    # ── clients ─────────────────────────────────────────────────────────────

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(f"llm-gateway:{token}".encode()).hexdigest()

    def issue_client(self, name: str) -> str:
        """Creates or re-keys a client and returns its token. Shown once."""
        token = f"lgw_{secrets.token_urlsafe(32)}"
        with self._tx() as cur:
            cur.execute(
                """INSERT INTO clients (name, token_hash, created_at) VALUES (?,?,?)
                   ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash""",
                (name, self.hash_token(token), _now()),
            )
        return token

    def authenticate(self, token: str) -> str | None:
        """Client name for a token, or None. Compared in constant time."""
        if not token:
            return None
        digest = self.hash_token(token)
        with self._tx() as cur:
            rows = cur.execute("SELECT name, token_hash FROM clients").fetchall()
        for row in rows:
            if hmac.compare_digest(digest, row["token_hash"]):
                return row["name"]
        return None

    def clients(self) -> list[dict]:
        with self._tx() as cur:
            rows = cur.execute(
                "SELECT name, calls, last_seen, created_at FROM clients ORDER BY name"
            ).fetchall()
        return [dict(r) for r in rows]

    def revoke_client(self, name: str) -> bool:
        with self._tx() as cur:
            cur.execute("DELETE FROM clients WHERE name = ?", (name,))
            return cur.rowcount > 0

    # ── usage ───────────────────────────────────────────────────────────────

    def record(
        self, *, client: str, transport: str, model: str | None, key_masked: str | None,
        input_tokens: int | None, output_tokens: int | None, ok: bool, error: str | None,
    ) -> None:
        with self._tx() as cur:
            cur.execute(
                """INSERT INTO usage
                   (at, client, transport, model, key_masked, input_tokens, output_tokens, ok, error)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (_now(), client, transport, model, key_masked, input_tokens, output_tokens,
                 1 if ok else 0, error),
            )
            cur.execute(
                "UPDATE clients SET calls = calls + 1, last_seen = ? WHERE name = ?",
                (_now(), client),
            )

    def usage(self, limit: int = 50) -> list[dict]:
        with self._tx() as cur:
            rows = cur.execute(
                "SELECT * FROM usage ORDER BY at DESC LIMIT ?", (min(limit, 500),)
            ).fetchall()
        return [dict(r) for r in rows]

    def summary(self) -> dict:
        with self._tx() as cur:
            totals = cur.execute(
                """SELECT COUNT(*) AS calls,
                          SUM(ok) AS ok,
                          SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                          SUM(COALESCE(output_tokens, 0)) AS output_tokens
                     FROM usage"""
            ).fetchone()
            by_client = cur.execute(
                """SELECT client, COUNT(*) AS calls, SUM(ok) AS ok
                     FROM usage GROUP BY client ORDER BY calls DESC"""
            ).fetchall()
        return {
            "calls": totals["calls"] or 0,
            "ok": totals["ok"] or 0,
            "input_tokens": totals["input_tokens"] or 0,
            "output_tokens": totals["output_tokens"] or 0,
            "by_client": [dict(r) for r in by_client],
        }
