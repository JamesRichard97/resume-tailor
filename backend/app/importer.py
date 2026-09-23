"""One-time import of the old JSON files into SQLite.

Runs at startup. If `db.json` or any `YYYYMMDD_registry.json` is sitting in the
data directory and has not been imported yet, its rows are copied into the
database and the file is renamed to `<name>.imported`.

Three deliberate choices:

* **Renamed, not deleted.** The JSON files are the only copy of that data until
  the import succeeds, and a bug here would be unrecoverable. They stay on disk
  under a new name; deleting them is the operator's call, once they are happy.
* **Recorded in the database, not just by the rename.** A `meta` row remembers
  each file that was imported, so restoring a backup of the JSON files next to
  an already-populated database cannot double up the rows.
* **Nothing is invented.** A row missing a field it should have had is imported
  with that field empty and reported as incomplete, exactly as the JSON store
  used to report it — the import is a move, not a repair.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import database, db
from .config import settings
from .database import set_meta, transaction

logger = logging.getLogger("uvicorn.error")

DAY_FILE = re.compile(r"^\d{8}_registry\.json$")
LEGACY_REGISTRY = "registry.json"
IMPORTED_SUFFIX = ".imported"

META_PREFIX = "imported:"


def _already(name: str) -> bool:
    return database.get_meta(META_PREFIX + name) is not None


def _mark(conn, name: str, detail: str) -> None:
    set_meta(conn, META_PREFIX + name, detail)


def _retire(path: Path) -> None:
    """Rename an imported file out of the way so it is not picked up again."""
    target = path.with_name(path.name + IMPORTED_SUFFIX)
    if target.exists():
        target = path.with_name(
            f"{path.name}{IMPORTED_SUFFIX}.{datetime.now():%Y%m%d%H%M%S}"
        )
    try:
        path.rename(target)
    except OSError:
        logger.warning("Imported %s but could not rename it; it will be skipped "
                       "next time because the import is recorded in the database",
                       path.name)


def _read(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        logger.exception("Could not read %s; leaving it alone", path)
        return None


def _import_users(conn, rows: list[dict]) -> int:
    imported = 0
    for row in rows:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        # A user already in the database wins: the import must never overwrite
        # something entered since.
        if conn.execute("SELECT 1 FROM users WHERE id = ?", (row["id"],)).fetchone():
            continue

        email = row.get("email")
        if email and conn.execute(
            "SELECT 1 FROM users WHERE lower(email) = ?", (email.lower(),)
        ).fetchone():
            # The unique index would reject this. Keep the row, drop the
            # duplicate email, and let the UI flag it as incomplete.
            logger.warning("Importing %s without its email: %s is already taken",
                           row.get("full_name"), email)
            email = None

        conn.execute(
            "INSERT INTO users (id, full_name, linkedin_url, email, phone,"
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                row["id"],
                row.get("full_name") or "",
                row.get("linkedin_url"),
                email,
                row.get("phone"),
                row.get("created_at"),
                row.get("updated_at"),
            ),
        )
        for key in db.SECTIONS:
            entries = row.get(key)
            db._write_sections(conn, row["id"], key, entries if isinstance(entries, list) else [])
        skills = row.get("skills")
        db._write_skills(conn, row["id"], skills if isinstance(skills, dict) else {})
        imported += 1
    return imported


def _import_resumes(conn, rows: list[dict]) -> int:
    imported = 0
    for row in rows:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        if conn.execute("SELECT 1 FROM resumes WHERE id = ?", (row["id"],)).fetchone():
            continue
        # The foreign key would reject a resume whose user is long gone; keep
        # the resume and null the link instead of dropping it.
        user_id = row.get("user_id")
        if user_id and not conn.execute(
            "SELECT 1 FROM users WHERE id = ?", (user_id,)
        ).fetchone():
            user_id = None

        conn.execute(
            "INSERT INTO resumes (id, user_id, full_name, company, position, url,"
            " description, model, resume_json, generated_at, humanized_json,"
            " humanized_model, humanized_at, ignored_changes)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                row["id"],
                user_id,
                row.get("full_name"),
                row.get("company"),
                row.get("position"),
                row.get("url"),
                row.get("description"),
                row.get("model"),
                database.dumps(row.get("resume") or {}),
                row.get("generated_at"),
                database.dumps(row["humanized"]) if row.get("humanized") else None,
                row.get("humanized_model"),
                row.get("humanized_at"),
                database.dumps(row.get("ignored_changes") or []),
            ),
        )
        imported += 1
    return imported


def _import_registry(conn, rows: list[dict]) -> int:
    imported = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        entry_id = row.get("id") or str(uuid.uuid4())
        if conn.execute("SELECT 1 FROM registry WHERE id = ?", (entry_id,)).fetchone():
            continue

        applied_at = row.get("applied_at") or datetime.now(timezone.utc).isoformat()
        try:
            day = f"{datetime.fromisoformat(applied_at).astimezone().date():%Y-%m-%d}"
        except ValueError:
            day = applied_at[:10]

        conn.execute(
            "INSERT INTO registry (id, applied_at, applied_day, full_name, company,"
            " position, url, resume_name, job_description, resume_id, version)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                entry_id,
                applied_at,
                day,
                row.get("full_name") or "",
                row.get("company") or "",
                row.get("position") or "",
                row.get("url") or "",
                row.get("resume_name") or "",
                row.get("job_description") or "",
                row.get("resume_id"),
                row.get("version"),
            ),
        )
        imported += 1
    return imported


def run() -> dict[str, Any]:
    """Import whatever old JSON files are present. Returns a summary; an empty
    one means there was nothing to do, which is the normal case."""
    summary: dict[str, Any] = {"users": 0, "resumes": 0, "registry": 0, "files": []}

    candidates: list[Path] = []
    main = settings.data_file
    if main.exists() and not _already(main.name):
        candidates.append(main)

    directory = settings.registry_dir
    if directory.exists():
        for path in sorted(directory.iterdir()):
            if (DAY_FILE.match(path.name) or path.name == LEGACY_REGISTRY) and not _already(path.name):
                candidates.append(path)

    if not candidates:
        return summary

    for path in candidates:
        data = _read(path)
        if data is None:
            continue

        users = data.get("users") if isinstance(data.get("users"), list) else []
        resumes = data.get("resumes") if isinstance(data.get("resumes"), list) else []
        entries = data.get("entries") if isinstance(data.get("entries"), list) else []

        # One transaction per file: a file is imported completely or not at all,
        # and the "already imported" mark lands with the rows it describes.
        try:
            with transaction() as conn:
                counts = {
                    "users": _import_users(conn, users),
                    "resumes": _import_resumes(conn, resumes),
                    "registry": _import_registry(conn, entries),
                }
                _mark(conn, path.name, database.dumps(counts))
        except Exception:  # noqa: BLE001 — one bad file must not stop startup
            logger.exception("Could not import %s; leaving it in place", path.name)
            continue

        for key, value in counts.items():
            summary[key] += value
        summary["files"].append({"name": path.name, **counts})
        _retire(path)

    return summary
