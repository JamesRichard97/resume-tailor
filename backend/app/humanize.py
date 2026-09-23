"""Merging a humanized rewrite back onto the original resume.

The prompt tells Claude not to change any facts. This module makes that
guarantee structural rather than hopeful: the merged resume takes every factual
field from the ORIGINAL and accepts only the prose fields from the rewrite. If
the model renames an employer, moves a date or adds a technology, that edit
simply never reaches the document — there is no code path for it.

Rewritable: headline, summary, experience[].bullets, projects[].bullets,
education[].details.
Everything else is copied from the original.
"""

from __future__ import annotations

from typing import Any

from .schemas import ResumeDoc

# Fields the rewrite is allowed to touch, for the report below.
REWRITABLE = ("headline", "summary", "bullets", "details")


def _bullets_from(candidate: Any, fallback: list[str]) -> list[str]:
    """Accept the rewrite's bullets only if they are a non-empty list of
    non-empty strings — a model that returns [] or null must not silently
    delete someone's experience."""
    if not isinstance(candidate, list):
        return fallback
    cleaned = [str(b).strip() for b in candidate if str(b).strip()]
    return cleaned or fallback


def _text_from(candidate: Any, fallback: str) -> str:
    if not isinstance(candidate, str):
        return fallback
    text = candidate.strip()
    return text or fallback


def merge(original: ResumeDoc, rewrite: dict[str, Any]) -> tuple[ResumeDoc, dict]:
    """Returns (merged resume, report).

    The report records what the rewrite tried to change outside its remit, so
    the caller can log it. It is diagnostic only — the merge already ignored it.
    """
    base = original.model_dump(mode="json")
    out = {**base}
    ignored: list[str] = []

    out["headline"] = _text_from(rewrite.get("headline"), base.get("headline", ""))
    out["summary"] = _text_from(rewrite.get("summary"), base.get("summary", ""))

    # --- experience -------------------------------------------------------
    r_exp = rewrite.get("experience")
    r_exp = r_exp if isinstance(r_exp, list) else []
    merged_exp = []
    for i, entry in enumerate(base.get("experience", [])):
        incoming = r_exp[i] if i < len(r_exp) and isinstance(r_exp[i], dict) else {}
        for key in ("position", "company", "dates"):
            if key in incoming and str(incoming[key]).strip() != str(entry.get(key, "")):
                ignored.append(f"experience[{i}].{key}")
        merged_exp.append(
            {**entry, "bullets": _bullets_from(incoming.get("bullets"), entry.get("bullets", []))}
        )
    out["experience"] = merged_exp

    # --- projects ---------------------------------------------------------
    r_proj = rewrite.get("projects")
    r_proj = r_proj if isinstance(r_proj, list) else []
    merged_proj = []
    for i, entry in enumerate(base.get("projects", [])):
        incoming = r_proj[i] if i < len(r_proj) and isinstance(r_proj[i], dict) else {}
        for key in ("name", "dates"):
            if key in incoming and str(incoming[key]).strip() != str(entry.get(key, "")):
                ignored.append(f"projects[{i}].{key}")
        merged_proj.append(
            {**entry, "bullets": _bullets_from(incoming.get("bullets"), entry.get("bullets", []))}
        )
    out["projects"] = merged_proj

    # --- education --------------------------------------------------------
    r_edu = rewrite.get("education")
    r_edu = r_edu if isinstance(r_edu, list) else []
    merged_edu = []
    for i, entry in enumerate(base.get("education", [])):
        incoming = r_edu[i] if i < len(r_edu) and isinstance(r_edu[i], dict) else {}
        for key in ("university", "dates"):
            if key in incoming and str(incoming[key]).strip() != str(entry.get(key, "")):
                ignored.append(f"education[{i}].{key}")
        merged_edu.append(
            {**entry, "details": _text_from(incoming.get("details"), entry.get("details", ""))}
        )
    out["education"] = merged_edu

    # --- never rewritten --------------------------------------------------
    if rewrite.get("full_name") and rewrite["full_name"] != base.get("full_name"):
        ignored.append("full_name")
    if isinstance(rewrite.get("contact"), dict) and rewrite["contact"] != base.get("contact"):
        ignored.append("contact")
    if isinstance(rewrite.get("skills"), dict) and rewrite["skills"] != base.get("skills"):
        ignored.append("skills")

    out["full_name"] = base["full_name"]
    out["contact"] = base.get("contact", {})
    out["skills"] = base.get("skills", {})

    merged = ResumeDoc.model_validate(out)
    return merged, {"ignored_changes": ignored, "ignored_count": len(ignored)}
