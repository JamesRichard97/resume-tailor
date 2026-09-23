"""The application registry: what was downloaded, for which job, and when.

One row per completed `.docx` download, in the `registry` table.

It used to be one JSON file per day. The day is still there — `applied_day`
holds the local calendar date and is indexed — so "everything in September" is
still a cheap lookup, but the rows are now queried rather than merged by
reading a directory. Archiving a period is a `DELETE ... WHERE applied_day`
instead of deleting files, and the whole history is backed up by copying one
database file.

`applied_at` is the moment of the download, not of generation: the download is
what corresponds to actually sending the resume somewhere. The day is taken
from the *local* clock, because a download at 8pm in Montreal belongs to that
evening, not to tomorrow in UTC.

Unlike the resume record, a row keeps the full job description. That is the
point of a registry — months later, "what was this job actually asking for" is
the question you cannot answer from a company name alone.
"""

from __future__ import annotations

import logging
import sqlite3
import uuid
from datetime import date, datetime, timezone
from typing import Any

from .database import query, transaction

logger = logging.getLogger("uvicorn.error")

COLUMNS = (
    "id, applied_at, applied_day, full_name, company, position, url,"
    " resume_name, job_description, resume_id, version"
)


def _row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "applied_at": row["applied_at"],
        "full_name": row["full_name"],
        "company": row["company"],
        "position": row["position"],
        "url": row["url"],
        "resume_name": row["resume_name"],
        "job_description": row["job_description"],
        "resume_id": row["resume_id"],
        "version": row["version"],
    }


def add(
    *,
    full_name: str | None,
    company: str | None,
    position: str | None,
    url: str | None,
    resume_name: str,
    job_description: str | None,
    resume_id: str | None = None,
    version: str | None = None,
    when: datetime | None = None,
) -> dict | None:
    """Append one row. Never raises — a registry write that fails should not
    turn a working download into an error, so it is logged and swallowed."""
    moment = when or datetime.now(timezone.utc)
    entry = {
        "id": str(uuid.uuid4()),
        "applied_at": moment.isoformat(),
        "full_name": full_name or "",
        "company": company or "",
        "position": position or "",
        "url": url or "",
        "resume_name": resume_name,
        "job_description": job_description or "",
        "resume_id": resume_id,
        "version": version,
    }
    day = f"{moment.astimezone().date():%Y-%m-%d}"

    try:
        with transaction() as conn:
            conn.execute(
                f"INSERT INTO registry ({COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    entry["id"],
                    entry["applied_at"],
                    day,
                    entry["full_name"],
                    entry["company"],
                    entry["position"],
                    entry["url"],
                    entry["resume_name"],
                    entry["job_description"],
                    entry["resume_id"],
                    entry["version"],
                ),
            )
    except Exception:  # noqa: BLE001 — the download matters more than the row
        logger.exception("Could not write the registry entry for %s", resume_name)
        return None

    return entry


def all_entries(start: date | None = None, end: date | None = None) -> list[dict]:
    """Every row, newest first — the order the table wants before anyone sorts
    it. The optional range is matched against the local day, which is what the
    page's date filters mean."""
    sql = f"SELECT {COLUMNS} FROM registry"
    where: list[str] = []
    params: list[Any] = []
    if start:
        where.append("applied_day >= ?")
        params.append(f"{start:%Y-%m-%d}")
    if end:
        where.append("applied_day <= ?")
        params.append(f"{end:%Y-%m-%d}")
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY applied_at DESC"

    return [_row(r) for r in query(sql, tuple(params))]


def days() -> list[dict]:
    """How many downloads on each day, newest first. What the old per-day files
    told you at a glance, without having to list a directory."""
    return [
        {"day": r["applied_day"], "entries": r["n"]}
        for r in query(
            "SELECT applied_day, count(*) AS n FROM registry"
            " GROUP BY applied_day ORDER BY applied_day DESC"
        )
    ]
