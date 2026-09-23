"""SQLite connection handling and schema.

Replaces the JSON files the app used to keep its data in. Everything lives in
one database file now: users and the sections they registered, generated
resumes, and the application registry.

Why stdlib `sqlite3` and not an ORM: the whole data layer is a few hundred
lines of plain SQL, and an ORM would add a dependency, a migration tool and a
layer of indirection to save none of it. The trade is that the SQL is written
out by hand, which is also the point — you can read exactly what hits the disk.

**Connections are per thread.** FastAPI runs sync endpoints in a worker
threadpool, and a SQLite connection object may not be shared across threads.
Each thread lazily opens its own and keeps it for the life of the process.

**WAL mode**, so a reader never blocks on a writer. Combined with a busy
timeout this removes the old "run exactly one uvicorn worker" constraint: the
JSON store was guarded by an in-process lock that several processes could not
share, whereas SQLite arbitrates between processes itself.

**Foreign keys are on** (they are off by default in SQLite, per connection),
so deleting a user really does take their experiences with them instead of
leaving orphans behind.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import settings

logger = logging.getLogger("uvicorn.error")

_local = threading.local()

SCHEMA_VERSION = 1

# Schema notes:
#
# * The three dated sections get a table each rather than one table with a
#   "kind" column. They genuinely differ — an experience has a company, a
#   project has a name — and three small honest tables beat one wide table of
#   mostly-NULL columns.
# * `sort_order` preserves the order the app displays: ongoing first, then
#   newest start date. SQL has no inherent row order, so it has to be stored.
# * The generated resume stays JSON in a single column. It is an artifact the
#   model produced and the app only ever reads whole; splitting it into six
#   more tables would buy nothing and cost a join on every read.
# * `applied_day` on the registry is the local calendar day, denormalised from
#   applied_at so the date filters are an indexed lookup rather than a scan
#   with timezone arithmetic in it.
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    full_name    TEXT NOT NULL DEFAULT '',
    linkedin_url TEXT,
    email        TEXT,
    phone        TEXT,
    created_at   TEXT,
    updated_at   TEXT
);

-- Emails are optional, so only a supplied one can collide. A partial,
-- case-insensitive unique index enforces that in the database as well as in
-- the router, which closes the window where two simultaneous registrations
-- both pass the check and both insert.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (lower(email)) WHERE email IS NOT NULL AND email <> '';

CREATE TABLE IF NOT EXISTS experiences (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    position   TEXT,
    company    TEXT,
    details    TEXT,
    start_date TEXT,
    end_date   TEXT,
    is_current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS experiences_user ON experiences (user_id, sort_order);

CREATE TABLE IF NOT EXISTS education (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    university TEXT,
    details    TEXT,
    start_date TEXT,
    end_date   TEXT,
    is_current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS education_user ON education (user_id, sort_order);

CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name       TEXT,
    details    TEXT,
    start_date TEXT,
    end_date   TEXT,
    is_current INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS projects_user ON projects (user_id, sort_order);

-- One row per skill, so "who knows Kafka" is a query rather than a scan of
-- JSON blobs. `kind` is one of the four groups the form offers.
CREATE TABLE IF NOT EXISTS skills (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    value      TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind, value)
);
CREATE INDEX IF NOT EXISTS skills_value ON skills (value);

CREATE TABLE IF NOT EXISTS resumes (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    full_name       TEXT,
    company         TEXT,
    position        TEXT,
    url             TEXT,
    description     TEXT,
    model           TEXT,
    resume_json     TEXT NOT NULL,
    generated_at    TEXT,
    humanized_json  TEXT,
    humanized_model TEXT,
    humanized_at    TEXT,
    ignored_changes TEXT
);
CREATE INDEX IF NOT EXISTS resumes_generated ON resumes (generated_at DESC);

CREATE TABLE IF NOT EXISTS registry (
    id              TEXT PRIMARY KEY,
    applied_at      TEXT NOT NULL,
    applied_day     TEXT NOT NULL,
    full_name       TEXT NOT NULL DEFAULT '',
    company         TEXT NOT NULL DEFAULT '',
    position        TEXT NOT NULL DEFAULT '',
    url             TEXT NOT NULL DEFAULT '',
    resume_name     TEXT NOT NULL DEFAULT '',
    job_description TEXT NOT NULL DEFAULT '',
    resume_id       TEXT,
    version         TEXT
);
CREATE INDEX IF NOT EXISTS registry_applied ON registry (applied_at DESC);
CREATE INDEX IF NOT EXISTS registry_day ON registry (applied_day);

-- Bookkeeping: the schema version, and whether the one-time import from the
-- old JSON files has already run.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def path() -> Path:
    return settings.database_file


def connect() -> sqlite3.Connection:
    """This thread's connection, opened on first use."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn

    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(target),
        # Long enough to outlast any write this app performs, so a concurrent
        # writer waits rather than raising "database is locked".
        timeout=15.0,
        isolation_level=None,  # explicit BEGIN/COMMIT via transaction() below
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    # NORMAL is the usual pairing with WAL: durable across process crashes,
    # and only at risk from an OS-level crash mid-write.
    conn.execute("PRAGMA synchronous = NORMAL")
    _local.conn = conn
    return conn


def close() -> None:
    """Close this thread's connection, if it has one."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """Run a block in one transaction, committing on success and rolling the
    whole thing back on any exception — so a half-written user is impossible."""
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def query(sql: str, params: tuple | dict = ()) -> list[sqlite3.Row]:
    return connect().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple | dict = ()) -> sqlite3.Row | None:
    return connect().execute(sql, params).fetchone()


def get_meta(key: str) -> str | None:
    row = query_one("SELECT value FROM meta WHERE key = ?", (key,))
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def init() -> None:
    """Create the schema if it is not there. Safe to call on every startup."""
    conn = connect()
    conn.executescript(SCHEMA)
    with transaction() as tx:
        set_meta(tx, "schema_version", str(SCHEMA_VERSION))
    logger.info("SQLite database ready at %s", path())


def loads(value: str | None, fallback: Any) -> Any:
    """Parse a JSON column, tolerating a row written by hand or by an older
    version — a malformed blob yields the fallback instead of a 500."""
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        logger.warning("Ignoring malformed JSON in a database column")
        return fallback


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
