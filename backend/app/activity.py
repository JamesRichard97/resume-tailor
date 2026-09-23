"""Append-only activity log, stored in the same JSON file as everything else.

Records one entry per generation and per humanizing pass — successes AND
failures, since "it kept timing out at 5pm" is exactly what a log is for.

Two deliberate limits:

* **No content.** The job description and the generated resume are not copied
  here. They can run to thousands of words, they are already stored on the
  resume record, and duplicating someone's contact details and work history
  into a second place is a privacy cost with no operational benefit. Sizes and
  counts are recorded instead, which is what you actually query.
* **Bounded length.** The log is trimmed to the newest `LOG_MAX_ENTRIES`, so a
  long-running server cannot grow db.json without limit. Set it to 0 to disable
  logging entirely.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from . import db
from .config import settings

logger = logging.getLogger("uvicorn.error")

COLLECTION = "logs"


def record(
    *,
    event: str,
    status: str,
    user_id: str | None = None,
    full_name: str | None = None,
    resume_id: str | None = None,
    company: str | None = None,
    position: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    duration_ms: int | None = None,
    usage: dict[str, int] | None = None,
    detail: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict | None:
    """Append one entry. Never raises — a log that breaks the request it is
    logging is worse than no log."""
    if settings.log_max_entries <= 0:
        return None

    entry = {
        "id": str(uuid.uuid4()),
        "at": datetime.now(timezone.utc).isoformat(),
        "event": event,          # "generate" | "humanize"
        "status": status,        # "ok" | "error"
        "user_id": user_id,
        "full_name": full_name,
        "resume_id": resume_id,
        "company": company,
        "position": position,
        "provider": provider,    # "openai-compatible" | "anthropic"
        "model": model,
        "duration_ms": duration_ms,
        "usage": usage or {},
        "detail": detail,        # the error message, when status == "error"
        **(extra or {}),
    }

    try:
        with db.transaction() as store:
            entries = store.setdefault(COLLECTION, [])
            entries.append(entry)
            # Ring buffer: keep the newest N.
            if len(entries) > settings.log_max_entries:
                del entries[: len(entries) - settings.log_max_entries]
    except Exception:  # noqa: BLE001 — logging must not break the request
        logger.exception("Could not write the activity log entry")
        return None

    return entry


def query(
    *,
    event: str | None = None,
    status: str | None = None,
    user_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    """Newest first."""
    entries = db.collection(COLLECTION)

    if event:
        entries = [e for e in entries if e.get("event") == event]
    if status:
        entries = [e for e in entries if e.get("status") == status]
    if user_id:
        entries = [e for e in entries if e.get("user_id") == user_id]

    entries = sorted(entries, key=lambda e: e.get("at") or "", reverse=True)
    return entries[offset : offset + limit]


def summary() -> dict:
    """Counts and token totals, for a quick "what has this cost me" answer."""
    entries = db.collection(COLLECTION)

    tokens = sum(
        (e.get("usage") or {}).get("total_tokens", 0)
        for e in entries
        if e.get("status") == "ok"
    )
    durations = [
        e["duration_ms"]
        for e in entries
        if e.get("status") == "ok" and isinstance(e.get("duration_ms"), int)
    ]

    by_event: dict[str, dict[str, int]] = {}
    for e in entries:
        bucket = by_event.setdefault(e.get("event") or "unknown", {"ok": 0, "error": 0})
        bucket[e.get("status") or "error"] = bucket.get(e.get("status") or "error", 0) + 1

    return {
        "entries": len(entries),
        "capacity": settings.log_max_entries,
        "total_tokens": tokens,
        "avg_duration_ms": round(sum(durations) / len(durations)) if durations else None,
        "by_event": by_event,
        "oldest": min((e.get("at") for e in entries if e.get("at")), default=None),
        "newest": max((e.get("at") for e in entries if e.get("at")), default=None),
    }
