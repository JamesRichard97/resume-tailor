"""Read side of the activity log.

Writing happens in app/activity.py, from the tailor routes. This router only
exposes what was written, so you can answer "did that generation actually go
through?" without opening db.json in an editor.

Read-only by design: entries are never edited, and there is no delete. The log
trims itself to LOG_MAX_ENTRIES, so it cannot grow without bound.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from .. import activity

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("", summary="Recent generation and humanizing activity")
def list_logs(
    event: str | None = Query(
        default=None,
        pattern="^(generate|humanize)$",
        description="Only this kind of activity.",
    ),
    status: str | None = Query(
        default=None,
        pattern="^(ok|error)$",
        description="Only successes, or only failures.",
    ),
    user_id: str | None = Query(default=None, description="Only this person's runs."),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """Newest first. Entries hold metadata only — no job description and no
    resume text, just who/what/when, the model used, timings and token counts."""
    return {
        "entries": activity.query(
            event=event, status=status, user_id=user_id, limit=limit, offset=offset
        ),
        "summary": activity.summary(),
    }
