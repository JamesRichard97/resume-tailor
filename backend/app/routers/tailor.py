"""Resume generation and download."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import ValidationError

from .. import db, humanize, llm, registry, render
from ..config import settings
from ..prompts import build_humanize_messages, build_messages
from ..schemas import (
    ResumeDoc,
    TailorRequest,
    TailorResponse,
    TailorStatus,
)

logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/tailor", tags=["tailor"])

DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

# Each failure mode gets its own status code so the client can tell
# "nobody configured a model" from "the model is down".
ERROR_STATUS = {
    llm.LLMNotConfigured: status.HTTP_503_SERVICE_UNAVAILABLE,
    llm.LLMUnavailable: status.HTTP_502_BAD_GATEWAY,
    llm.LLMTimeout: status.HTTP_504_GATEWAY_TIMEOUT,
    llm.LLMBadResponse: status.HTTP_502_BAD_GATEWAY,
}


@router.get(
    "/status",
    response_model=TailorStatus,
    summary="Whether the generation and humanizing endpoints are configured",
)
def tailor_status() -> dict:
    """Lets the UI warn about a missing endpoint before anyone types a posting."""
    return {
        "configured": settings.llm_configured,
        "base_url": settings.llm_base_url or None,
        "model": settings.llm_model if settings.llm_configured else None,
        "detail": (
            None
            if settings.llm_configured
            else (
                "No LLM endpoint is configured. Set LLM_BASE_URL in backend/.env "
                "(for example http://localhost:1234/v1) and restart the server."
            )
        ),
        "humanize": {
            "configured": settings.claude_configured,
            "base_url": settings.claude_base_url or None,
            "model": settings.claude_model or None,
            "detail": (
                None
                if settings.claude_configured
                else (
                    "Claude is not configured. Set CLAUDE_MODEL (and "
                    "CLAUDE_API_KEY for api.anthropic.com) in backend/.env and "
                    "restart the server."
                )
            ),
        },
    }


@router.post("", response_model=TailorResponse, summary="Generate a tailored resume")
async def tailor(payload: TailorRequest) -> dict:
    user = db.get_user(payload.user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User not found")

    job = payload.job.model_dump(mode="json")

    try:
        completion = await llm.chat(build_messages(user, job), json_mode=True)
        data = llm.extract_json(
            completion.text,
            hint="If your server supports it, set LLM_JSON_MODE=on.",
        )
    except llm.LLMError as exc:
        raise HTTPException(
            ERROR_STATUS.get(type(exc), status.HTTP_502_BAD_GATEWAY),
            detail=str(exc),
        ) from exc

    # The model chose these values; the schema is what makes them safe to build
    # a document from. A bad shape is the model's fault, not the caller's, so it
    # surfaces as 502 like any other upstream problem.
    data.setdefault("full_name", user.get("full_name") or "")
    try:
        resume = ResumeDoc.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(x) for x in first["loc"]) or "response"
        message = (
            "The model returned a resume in the wrong shape "
            f"({where}: {first['msg']}). Try again, or use a stronger model."
        )
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=message) from exc

    record = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "full_name": user.get("full_name"),
        "company": job["company"],
        "position": job["position"],
        "url": job.get("url"),
        # Kept so a registry row written at download time can carry the posting
        # this resume was written against.
        "description": job.get("description"),
        "model": completion.model,
        "resume": resume.model_dump(mode="json"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    # Stored so Download can stream the file later without paying for a second
    # generation — and so a refresh doesn't lose the result.
    db.save_resume(record)

    return _present(record)


def _present(record: dict) -> dict:
    """Stored record -> response, rendering Markdown for whichever versions
    exist."""
    resume = ResumeDoc.model_validate(record["resume"])
    out = {**record, "resume_markdown": render.to_markdown(resume)}

    if record.get("humanized"):
        humanized = ResumeDoc.model_validate(record["humanized"])
        out["humanized_markdown"] = render.to_markdown(humanized)

    return out


def _timestamp(value: str | None) -> datetime | None:
    """Stored ISO string -> datetime. Returns None for anything unparseable
    (a row written by an older version, say) so the caller falls back to now
    instead of failing a download over a filename."""
    try:
        return datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def _load(resume_id: str) -> dict:
    record = db.get_resume(resume_id)
    if record is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail="That generated resume is no longer available. Generate it again.",
        )
    return record


@router.get(
    "/{resume_id}", response_model=TailorResponse, summary="Fetch a generated resume"
)
def get_resume(resume_id: str) -> dict:
    return _present(_load(resume_id))


@router.post(
    "/{resume_id}/humanize",
    response_model=TailorResponse,
    summary="Rewrite a generated resume so it reads like a person wrote it",
)
async def humanize_resume(resume_id: str) -> dict:
    record = _load(resume_id)
    # Always rewrite from the original, so humanizing twice doesn't compound
    # into something drifting further from the facts each time.
    original = ResumeDoc.model_validate(record["resume"])

    system, user_content = build_humanize_messages(original.model_dump(mode="json"))

    try:
        completion = await llm.claude(system, user_content)
        rewrite = llm.extract_json(completion.text)
    except llm.LLMError as exc:
        raise HTTPException(
            ERROR_STATUS.get(type(exc), status.HTTP_502_BAD_GATEWAY),
            detail=str(exc),
        ) from exc

    # The prompt asks Claude not to change facts; this makes it impossible.
    merged, report = humanize.merge(original, rewrite)

    if report["ignored_count"]:
        logger.warning(
            "Humanize pass tried to change %d protected field(s) on resume %s: %s",
            report["ignored_count"],
            resume_id,
            ", ".join(report["ignored_changes"]),
        )

    record = db.save_humanized(
        resume_id,
        humanized=merged.model_dump(mode="json"),
        model=completion.model,
        at=datetime.now(timezone.utc).isoformat(),
        ignored_changes=report["ignored_changes"],
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Resume not found")

    return _present(record)


@router.get(
    "/{resume_id}/docx",
    summary="Download a generated resume as .docx",
    response_class=Response,
    responses={200: {"content": {DOCX_MEDIA_TYPE: {}}, "description": "Word document"}},
)
def download_docx(
    resume_id: str,
    version: str = Query(
        default="auto",
        pattern="^(auto|original|humanized)$",
        description="auto uses the humanized version when one exists.",
    ),
) -> Response:
    record = _load(resume_id)

    if version == "humanized" and not record.get("humanized"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="This resume has not been humanized yet.",
        )

    use_humanized = record.get("humanized") and version in ("auto", "humanized")
    source = record["humanized"] if use_humanized else record["resume"]
    resume = ResumeDoc.model_validate(source)

    content = render.to_docx_bytes(resume)
    # Name it after the version being sent, dated when that version was made —
    # so the two downloads never collide in the browser's Downloads folder, and
    # re-downloading last week's resume keeps last week's date.
    filename = render.filename_for(
        "Humanized" if use_humanized else "Tailored",
        full_name=record.get("full_name") or resume.full_name,
        company=record.get("company") or "",
        position=record.get("position") or "",
        when=_timestamp(
            record.get("humanized_at") if use_humanized else record.get("generated_at")
        ),
    )

    # The registry records what actually left the machine, so the row is written
    # here rather than at generation time — a resume you generated but never
    # downloaded is not an application. Every download appends its own row.
    registry.add(
        full_name=record.get("full_name") or resume.full_name,
        company=record.get("company"),
        position=record.get("position"),
        url=record.get("url"),
        resume_name=filename,
        job_description=record.get("description"),
        resume_id=resume_id,
        version="humanized" if use_humanized else "original",
    )

    return Response(
        content=content,
        media_type=DOCX_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # The browser can't read Content-Disposition cross-origin unless it
            # is exposed; the dev proxy makes this same-origin, but a deployment
            # behind a different host needs it.
            "Access-Control-Expose-Headers": "Content-Disposition",
            "Content-Length": str(len(content)),
        },
    )
