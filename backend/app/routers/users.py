"""User endpoints.

Thin: validate the payload, order the dated entries, and hand the work to the
data layer. Everything about how a user is stored lives in app/db.py.
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status

from .. import db
from ..schemas import Message, User, UserCreate, UserOption, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])

# The dated sections, all handled the same way.
DATED_SECTIONS = tuple(db.SECTIONS)

EMAIL_TAKEN = "A user with that email already exists"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _present(user: dict) -> dict:
    """Stored row -> response shape, with the counts the list view shows."""
    out = {**user}
    skills = user.get("skills") or {}

    out["experience_count"] = len(out.get("experiences") or [])
    out["education_count"] = len(out.get("education") or [])
    out["project_count"] = len(out.get("projects") or [])
    out["skill_count"] = sum(len(skills.get(g) or []) for g in db.SKILL_GROUPS)
    out["is_complete"] = db.is_complete(user)
    return out


def _prepare_dated(entries: list[dict]) -> list[dict]:
    """Stamp an id on new entries, keep the one an edited entry already had,
    and order newest-first — the order a resume reads in."""
    prepared = [
        {**entry, "id": entry.get("id") or str(uuid.uuid4())} for entry in entries
    ]
    # Ongoing entries first, then by start date descending.
    prepared.sort(
        key=lambda e: (e.get("is_current", False), e.get("start_date") or ""),
        reverse=True,
    )
    return prepared


@router.get("", response_model=list[User], summary="List users")
def list_users(
    q: str | None = Query(
        default=None, description="Case-insensitive search on name/email/LinkedIn."
    ),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[dict]:
    return [_present(u) for u in db.list_users(q, limit, offset)]


@router.get(
    "/options",
    response_model=list[UserOption],
    summary="Lightweight list for the user select box",
)
def list_user_options(q: str | None = Query(default=None)) -> list[dict]:
    return list_users(q=q, limit=500, offset=0)


@router.get("/{user_id}", response_model=User, summary="Get one user")
def get_user(user_id: str) -> dict:
    user = db.get_user(user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User not found")
    return _present(user)


@router.post(
    "",
    response_model=User,
    status_code=status.HTTP_201_CREATED,
    summary="Register a user",
)
def create_user(payload: UserCreate) -> dict:
    if db.email_taken(payload.email):
        raise HTTPException(status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN)

    fields = payload.model_dump(mode="json")
    for name in DATED_SECTIONS:
        fields[name] = _prepare_dated(fields.get(name) or [])

    try:
        user = db.create_user(fields, stamp=_now())
    except sqlite3.IntegrityError as exc:
        # The unique index caught what the check above raced past — two
        # registrations with the same email arriving together.
        raise HTTPException(status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN) from exc
    return _present(user)


@router.patch("/{user_id}", response_model=User, summary="Update a user")
def update_user(user_id: str, payload: UserUpdate) -> dict:
    if db.get_user(user_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User not found")

    changes = payload.model_dump(mode="json", exclude_unset=True)
    for name in DATED_SECTIONS:
        if name in changes:
            changes[name] = _prepare_dated(changes[name] or [])

    if "email" in changes and db.email_taken(changes["email"], exclude_id=user_id):
        raise HTTPException(status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN)

    try:
        user = db.update_user(user_id, changes, stamp=_now())
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=EMAIL_TAKEN) from exc
    return _present(user)


@router.delete("/{user_id}", response_model=Message, summary="Delete a user")
def delete_user(user_id: str) -> dict:
    # The user's experiences, education, projects and skills go with them —
    # the foreign keys say ON DELETE CASCADE.
    if not db.delete_user(user_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User not found")
    return {"detail": "User deleted"}
