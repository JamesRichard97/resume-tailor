"""Read side of the application registry.

Rows are written by the download endpoint in routers/tailor.py, never from
here. This is read-only on purpose: the registry is a record of what was
actually downloaded, and a record you can edit is not much of a record.

Filtering and sorting happen in the browser. The table is one person's
application history — hundreds of rows, not millions — so shipping the list
once and letting the page sort it instantly beats a round trip per click. The
date range below is the exception: it is an indexed lookup on the stored local
day, so narrowing it is real work saved rather than the same work done
elsewhere.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException, Query, status

from .. import registry
from ..schemas import RegistryEntry

router = APIRouter(prefix="/registry", tags=["registry"])


@router.get(
    "",
    response_model=list[RegistryEntry],
    summary="Every resume download, newest first",
)
def list_registry(
    start: date | None = Query(
        default=None,
        alias="from",
        description="Only days on or after this date (YYYY-MM-DD).",
    ),
    end: date | None = Query(
        default=None,
        alias="to",
        description="Only days on or before this date (YYYY-MM-DD).",
    ),
) -> list[dict]:
    if start and end and start > end:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="`from` is after `to`.",
        )
    return registry.all_entries(start, end)


@router.get("/days", summary="How many downloads on each day")
def list_days() -> dict:
    """A quick shape-of-the-history view: how far back it goes and how busy
    each day was, without downloading every row to count them."""
    days = registry.days()
    return {"days": days, "total": sum(d["entries"] for d in days)}
