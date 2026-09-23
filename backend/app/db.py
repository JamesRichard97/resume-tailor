"""Users and generated resumes, stored in SQLite.

This module is the only place that knows the table layout. The routers call
the functions here and get plain dicts back in exactly the shape the API
responses expect, so moving from JSON files to SQL changed nothing above this
line — and moving to Postgres later would change nothing below it either.

The read path assembles a user from four tables. That is two queries per list
request (users, then all their sections at once) rather than one query per
user, because the N+1 version is the classic way a page like this gets slow
without anyone noticing until there are two hundred rows in it.
"""

from __future__ import annotations

import sqlite3
import uuid
from typing import Any, Iterable

from . import database
from .database import query, query_one, transaction

# The four skill groups the registration form offers, in display order.
SKILL_GROUPS = ("languages", "frameworks", "developer_tools", "libraries")

# Fields that must be present and non-empty for a row to be usable. A row that
# predates one of them is returned with is_complete=false rather than hidden.
REQUIRED_USER_FIELDS = ("full_name", "linkedin_url", "email", "phone")

# The dated sections: response key -> (table, the column holding its title).
SECTIONS = {
    "experiences": ("experiences", "position"),
    "education": ("education", "university"),
    "projects": ("projects", "name"),
}


def is_complete(user: dict[str, Any]) -> bool:
    return all(user.get(f) for f in REQUIRED_USER_FIELDS)


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------


def _entry(row: sqlite3.Row, title_column: str) -> dict[str, Any]:
    entry = {
        "id": row["id"],
        "start_date": row["start_date"],
        "end_date": row["end_date"],
        "is_current": bool(row["is_current"]),
        "details": row["details"],
    }
    entry[title_column] = row[title_column]
    if title_column == "position":
        entry["company"] = row["company"]
    return entry


def _attach_sections(users: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fill in experiences, education, projects and skills for a batch of
    users in four queries total, rather than four per user."""
    if not users:
        return users

    by_id = {u["id"]: u for u in users}
    for u in users:
        for key in SECTIONS:
            u[key] = []
        u["skills"] = {group: [] for group in SKILL_GROUPS}

    placeholders = ",".join("?" * len(by_id))
    ids = tuple(by_id)

    for key, (table, title) in SECTIONS.items():
        rows = query(
            f"SELECT * FROM {table} WHERE user_id IN ({placeholders}) "
            "ORDER BY user_id, sort_order",
            ids,
        )
        for row in rows:
            by_id[row["user_id"]][key].append(_entry(row, title))

    for row in query(
        f"SELECT user_id, kind, value FROM skills WHERE user_id IN ({placeholders}) "
        "ORDER BY user_id, kind, sort_order",
        ids,
    ):
        groups = by_id[row["user_id"]]["skills"]
        # A `kind` the app no longer offers is ignored rather than crashing.
        if row["kind"] in groups:
            groups[row["kind"]].append(row["value"])

    return users


def _user(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "full_name": row["full_name"],
        "linkedin_url": row["linkedin_url"],
        "email": row["email"],
        "phone": row["phone"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_users(
    q: str | None = None, limit: int = 100, offset: int = 0
) -> list[dict[str, Any]]:
    """Alphabetical by name. Search is a case-insensitive substring over the
    three fields you would actually search by."""
    sql = "SELECT * FROM users"
    params: list[Any] = []
    if q:
        sql += (
            " WHERE lower(full_name) LIKE ? OR lower(coalesce(email, '')) LIKE ?"
            " OR lower(coalesce(linkedin_url, '')) LIKE ?"
        )
        needle = f"%{q.lower()}%"
        params += [needle, needle, needle]
    sql += " ORDER BY lower(full_name) LIMIT ? OFFSET ?"
    params += [limit, offset]

    return _attach_sections([_user(r) for r in query(sql, tuple(params))])


def get_user(user_id: str) -> dict[str, Any] | None:
    row = query_one("SELECT * FROM users WHERE id = ?", (user_id,))
    if row is None:
        return None
    return _attach_sections([_user(row)])[0]


def email_taken(email: str | None, *, exclude_id: str | None = None) -> bool:
    if not email:
        return False
    row = query_one(
        "SELECT 1 FROM users WHERE lower(email) = ? AND id IS NOT ? LIMIT 1",
        (email.lower(), exclude_id),
    )
    return row is not None


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------


def _write_sections(
    conn: sqlite3.Connection, user_id: str, key: str, entries: Iterable[dict]
) -> None:
    """Replace one section wholesale.

    The API's PATCH semantics are "here is the new list", so delete-then-insert
    matches the contract exactly and avoids diffing rows to work out what the
    client meant. Inside a transaction it is atomic.
    """
    table, title = SECTIONS[key]
    conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))

    for order, entry in enumerate(entries):
        columns = ["id", "user_id", "sort_order", title, "details",
                   "start_date", "end_date", "is_current"]
        values = [
            entry.get("id") or str(uuid.uuid4()),
            user_id,
            order,
            entry.get(title),
            entry.get("details"),
            entry.get("start_date"),
            entry.get("end_date"),
            1 if entry.get("is_current") else 0,
        ]
        if title == "position":
            columns.insert(4, "company")
            values.insert(4, entry.get("company"))
        conn.execute(
            f"INSERT INTO {table} ({', '.join(columns)}) "
            f"VALUES ({', '.join('?' * len(values))})",
            tuple(values),
        )


def _write_skills(
    conn: sqlite3.Connection, user_id: str, skills: dict[str, list[str]]
) -> None:
    conn.execute("DELETE FROM skills WHERE user_id = ?", (user_id,))
    for kind in SKILL_GROUPS:
        for order, value in enumerate(skills.get(kind) or []):
            conn.execute(
                "INSERT OR IGNORE INTO skills (user_id, kind, value, sort_order) "
                "VALUES (?, ?, ?, ?)",
                (user_id, kind, value, order),
            )


def create_user(fields: dict[str, Any], *, stamp: str) -> dict[str, Any]:
    user_id = str(uuid.uuid4())
    with transaction() as conn:
        conn.execute(
            "INSERT INTO users (id, full_name, linkedin_url, email, phone,"
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                user_id,
                fields.get("full_name") or "",
                fields.get("linkedin_url"),
                fields.get("email"),
                fields.get("phone"),
                stamp,
                stamp,
            ),
        )
        for key in SECTIONS:
            _write_sections(conn, user_id, key, fields.get(key) or [])
        _write_skills(conn, user_id, fields.get("skills") or {})

    return get_user(user_id)


def update_user(user_id: str, changes: dict[str, Any], *, stamp: str) -> dict[str, Any]:
    """Partial update. Only the keys present are touched — a PATCH that omits
    `projects` leaves the projects alone."""
    scalars = {
        k: v
        for k, v in changes.items()
        if k in ("full_name", "linkedin_url", "email", "phone")
    }
    with transaction() as conn:
        if scalars:
            assignments = ", ".join(f"{k} = ?" for k in scalars)
            conn.execute(
                f"UPDATE users SET {assignments}, updated_at = ? WHERE id = ?",
                (*scalars.values(), stamp, user_id),
            )
        else:
            conn.execute(
                "UPDATE users SET updated_at = ? WHERE id = ?", (stamp, user_id)
            )

        for key in SECTIONS:
            if key in changes:
                _write_sections(conn, user_id, key, changes[key] or [])
        if "skills" in changes:
            _write_skills(conn, user_id, changes["skills"] or {})

    return get_user(user_id)


def delete_user(user_id: str) -> bool:
    """Returns whether a row was actually removed. The sections go with it,
    because the foreign keys say ON DELETE CASCADE."""
    with transaction() as conn:
        cursor = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        return cursor.rowcount > 0


# --------------------------------------------------------------------------
# Generated resumes
# --------------------------------------------------------------------------


def _resume(row: sqlite3.Row) -> dict[str, Any]:
    record = {
        "id": row["id"],
        "user_id": row["user_id"],
        "full_name": row["full_name"],
        "company": row["company"],
        "position": row["position"],
        "url": row["url"],
        "description": row["description"],
        "model": row["model"],
        "resume": database.loads(row["resume_json"], {}),
        "generated_at": row["generated_at"],
    }
    if row["humanized_json"]:
        record["humanized"] = database.loads(row["humanized_json"], None)
        record["humanized_model"] = row["humanized_model"]
        record["humanized_at"] = row["humanized_at"]
        record["ignored_changes"] = database.loads(row["ignored_changes"], [])
    return record


def save_resume(record: dict[str, Any]) -> dict[str, Any]:
    with transaction() as conn:
        conn.execute(
            "INSERT INTO resumes (id, user_id, full_name, company, position, url,"
            " description, model, resume_json, generated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                record["id"],
                record.get("user_id"),
                record.get("full_name"),
                record.get("company"),
                record.get("position"),
                record.get("url"),
                record.get("description"),
                record.get("model"),
                database.dumps(record["resume"]),
                record.get("generated_at"),
            ),
        )
    return record


def get_resume(resume_id: str) -> dict[str, Any] | None:
    row = query_one("SELECT * FROM resumes WHERE id = ?", (resume_id,))
    return _resume(row) if row else None


def save_humanized(
    resume_id: str,
    *,
    humanized: dict,
    model: str | None,
    at: str,
    ignored_changes: list[str],
) -> dict[str, Any] | None:
    with transaction() as conn:
        cursor = conn.execute(
            "UPDATE resumes SET humanized_json = ?, humanized_model = ?,"
            " humanized_at = ?, ignored_changes = ? WHERE id = ?",
            (
                database.dumps(humanized),
                model,
                at,
                database.dumps(ignored_changes),
                resume_id,
            ),
        )
        if cursor.rowcount == 0:
            return None
    return get_resume(resume_id)


def counts() -> dict[str, int]:
    """Row counts, for the startup log and the health endpoint."""
    return {
        name: query_one(f"SELECT count(*) AS n FROM {name}")["n"]
        for name in ("users", "resumes", "registry")
    }


def incomplete_count() -> int:
    missing = " OR ".join(
        f"coalesce({f}, '') = ''" for f in REQUIRED_USER_FIELDS
    )
    return query_one(f"SELECT count(*) AS n FROM users WHERE {missing}")["n"]
