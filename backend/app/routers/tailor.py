"""Resume generation and download."""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from .. import db, humanize, llm, registry, render, terms
from ..config import settings
from ..prompts import (
    build_coverage_messages,
    build_humanize_messages,
    build_match_messages,
    build_messages,
    format_profile,
)
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
        "timeout": settings.llm_timeout,
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
            "timeout": settings.claude_timeout,
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


# The phases a generation moves through, in order, with the words the UI shows.
# Kept here rather than in the frontend so what is displayed cannot drift from
# what the server actually does — a label naming a step the code no longer runs
# is worse than no label at all.
PHASES = {
    "profile": "Reading the profile",
    "prompt": "Building the prompt",
    "model": "The model is writing",
    "checking": "Checking what came back",
    "coverage": "Covering terms it missed",
    "matching": "Adding evidence from the profile",
    "saving": "Saving",
    "done": "Done",
    "error": "Failed",
}


@router.post("", response_model=TailorResponse, summary="Generate a tailored resume")
async def tailor(payload: TailorRequest) -> dict:
    """The plain endpoint: same work, but nothing is reported until it ends."""
    async for event in _generate(payload):
        if event["phase"] == "done":
            return event["result"]
        if event["phase"] == "error":
            raise HTTPException(event["status"], detail=event["detail"])
    raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail="Generation produced no result.")


@router.post("/stream", summary="Generate, reporting each phase as it happens")
async def tailor_stream(payload: TailorRequest) -> StreamingResponse:
    """The same generation, as a stream of newline-delimited JSON events.

    NDJSON over a POST rather than server-sent events: SSE is GET-only and the
    posting can be thousands of words, which does not belong in a URL. The
    client reads the body as it arrives and shows the latest phase.

    An error arrives as a final event rather than an HTTP status, because by
    then the 200 and its headers have already gone. The status the plain
    endpoint would have returned is carried in the event so the client can
    treat it the same way.
    """

    async def body():
        async for event in _generate(payload):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(
        body(),
        media_type="application/x-ndjson",
        headers={
            # Without this an nginx in front of the app buffers the whole
            # response and every phase arrives at once, at the end, which
            # defeats the point of streaming them.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
        },
    )


async def _generate(payload: TailorRequest):
    """Runs one generation, yielding a phase event before each stage.

    One implementation behind both endpoints: if the phases lived only in the
    streaming path they would be free to describe something the plain path does
    not do, and the two would drift apart.
    """
    yield _phase("profile")

    user = db.get_user(payload.user_id)
    if user is None:
        yield _error(status.HTTP_404_NOT_FOUND, "User not found")
        return

    job = payload.job.model_dump(mode="json")

    # ONE deadline for the whole request, not one per call. Generating a resume
    # can take three calls — the resume, the coverage pass, the recovery pass —
    # and giving each the configured timeout meant a 40s setting could hold the
    # browser for two minutes. LLM_TIMEOUT is what this endpoint may take, full
    # stop; the passes after the first get whatever is left of it and are
    # skipped when that is too little to be worth starting.
    deadline = time.monotonic() + settings.llm_timeout
    tally = _Tally()

    yield _phase("prompt")
    messages = build_messages(user, job)

    yield _phase("model", call=1)
    try:
        completion = await llm.chat(
            messages,
            json_mode=True,
            budget=_left(deadline),
        )
        tally.add(completion)
        yield _phase("checking")
        data = llm.extract_json(
            completion.text,
            hint="If your server supports it, set LLM_JSON_MODE=on.",
        )
    except llm.LLMError as exc:
        yield _error(
            ERROR_STATUS.get(type(exc), status.HTTP_502_BAD_GATEWAY), str(exc)
        )
        return

    # The model chose these values; the schema is what makes them safe to build
    # a document from. A bad shape is the model's fault, not the caller's, so it
    # surfaces as 502 like any other upstream problem.
    data.setdefault("full_name", user.get("full_name") or "")
    _fill_contact(data, user)
    try:
        resume = ResumeDoc.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(x) for x in first["loc"]) or "response"
        yield _error(
            status.HTTP_502_BAD_GATEWAY,
            "The model returned a resume in the wrong shape "
            f"({where}: {first['msg']}). Try again, or use a stronger model.",
        )
        return

    # The refine passes each decide for themselves whether to run — refine off,
    # no time left, nothing missing — so the phase is announced from in there,
    # where the decision is, rather than guessed at from out here.
    async for event, value in _with_phases(
        _cover_missing_terms(resume, deadline, tally)
    ):
        if event is not None:
            yield event
        else:
            resume = value

    async for event, value in _with_phases(
        _close_missed_matches(resume, user, deadline, tally)
    ):
        if event is not None:
            yield event
        else:
            resume = value

    resume = _mark_profile_terms(resume, user)

    yield _phase("saving")
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
        "usage": tally.as_dict(),
        "resume": resume.model_dump(mode="json"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    # Stored so Download can stream the file later without paying for a second
    # generation — and so a refresh doesn't lose the result.
    db.save_resume(record)

    yield {"phase": "done", "label": PHASES["done"], "result": _present(record)}


def _fill_contact(data: dict, user: dict) -> None:
    """Fill any contact field the model left out, from the profile.

    The contact block is the one part of a resume that is pure transcription:
    the profile already holds the authoritative email, phone, LinkedIn and
    city, and the model is only being asked to copy them across. Trusting it to
    do that every time is a bet with no upside — when it forgets, the resume
    goes out with no way to reach the candidate on it, which is worse than any
    wording problem the model could have instead.

    Only fills what is missing. A value the model did supply is left alone,
    because it may have reformatted it deliberately, and nothing here can
    invent a detail the profile does not already contain.
    """
    contact = data.get("contact")
    if not isinstance(contact, dict):
        contact = {}
        data["contact"] = contact

    for key, source in (
        ("email", "email"),
        ("phone", "phone"),
        ("linkedin", "linkedin_url"),
        ("location", "location"),
    ):
        if not str(contact.get(key) or "").strip():
            value = user.get(source)
            if value:
                contact[key] = value


def _phase(name: str, **extra) -> dict:
    """One progress event. The label travels with it so the client never has to
    keep its own copy of these strings."""
    return {"phase": name, "label": PHASES[name], **extra}


def _error(http_status: int, detail: str) -> dict:
    return {
        "phase": "error",
        "label": PHASES["error"],
        "status": http_status,
        "detail": detail,
    }


async def _with_phases(source):
    """Adapts a helper that yields phase events and finally its result.

    Yields (event, None) for each phase and (None, result) for the result, so
    the caller can tell them apart without a sentinel value that a real result
    might one day equal.
    """
    async for item in source:
        if isinstance(item, dict) and "phase" in item:
            yield item, None
        else:
            yield None, item


@dataclass
class _Tally:
    """Adds up what one generation cost across however many calls it made.

    A generation is one call by default and three with LLM_REFINE=on, and the
    number worth showing is what the whole thing cost, not what the first call
    did. Carried explicitly rather than kept in module state because two
    requests can be in flight at once and a shared counter would mix them.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    calls: int = 0

    def add(self, completion: "llm.Completion") -> None:
        self.prompt_tokens += completion.prompt_tokens
        self.completion_tokens += completion.completion_tokens
        self.calls += 1

    def as_dict(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
            "calls": self.calls,
        }


def _left(deadline: float) -> float:
    """Seconds still available before this request must be answered."""
    return deadline - time.monotonic()


# How many times to go back for the terms still missing. Two is enough in
# practice: the first pass usually clears all of them and the second mops up a
# word form the model got wrong. Past that it is paying for the same answer.
MAX_COVERAGE_ROUNDS = 2


async def _cover_missing_terms(
    resume: ResumeDoc, deadline: float, tally: _Tally
):
    """Ask for sentences covering the terms the sample sentences left out.

    The schema checks coverage but cannot fix it, and telling the candidate
    which terms were missed leaves them writing the line by hand — which is the
    work they came here to avoid. So the gap is closed by asking, and only
    what is still missing after that is reported.

    Best-effort by design: this runs after a resume has already been generated
    and validated, so a failure here costs some sample sentences, never the
    resume. Any error is logged and swallowed.

    Yields a phase event before each round it actually makes, then the resume.
    The event is emitted here, past every reason this pass might not run, so a
    generation that skips it never claims to have done it.
    """
    if not settings.llm_refine:
        yield resume
        return

    for round_number in range(MAX_COVERAGE_ROUNDS):
        missing = resume.posting.uncovered_terms
        if not missing:
            yield resume
            return
        if _left(deadline) < llm.MIN_BUDGET:
            logger.info("No time left for the coverage pass; returning as generated.")
            yield resume
            return

        yield _phase("coverage", terms=len(missing), round=round_number + 1)
        try:
            completion = await llm.chat(
                build_coverage_messages(missing, resume.posting.sample_sentences),
                json_mode=True,
                budget=_left(deadline),
            )
            tally.add(completion)
            payload = llm.extract_json(completion.text)
        except llm.LLMError as exc:
            logger.warning("Could not cover %d missing term(s): %s", len(missing), exc)
            yield resume
            return

        extra = payload.get("sentences")
        if not isinstance(extra, list) or not extra:
            logger.warning("Coverage pass returned no sentences for: %s", ", ".join(missing))
            yield resume
            return

        data = resume.model_dump(mode="json")
        # Deduped as they are merged. Round two is asked about the terms round
        # one failed to cover, and a model that answers both rounds with the
        # same sentence would otherwise have it listed twice — which reads as
        # a mistake in the panel, and is one.
        merged_sentences: list[str] = []
        seen_sentences: set[str] = set()
        for sentence in (*resume.posting.sample_sentences, *extra):
            text = str(sentence).strip()
            key = text.casefold()
            if not text or key in seen_sentences:
                continue
            seen_sentences.add(key)
            merged_sentences.append(text)
        data["posting"]["sample_sentences"] = merged_sentences
        try:
            # Re-validating is what re-runs the check, so the next round sees
            # only what these new sentences still failed to cover.
            grown = ResumeDoc.model_validate(data)
        except ValidationError as exc:
            logger.warning("Coverage pass produced an unusable shape: %s", exc)
            yield resume
            return

        # A round that covered nothing new will not do better for being repeated.
        if len(grown.posting.uncovered_terms) >= len(missing):
            yield grown
            return
        resume = grown

    yield resume


def _experience_text(user: dict) -> str:
    """Everything the profile says about where this person has worked.

    Only the experience entries: the roles, the employers and what was done in
    them. Skills the person listed are a claim; the experience is the account
    of the work behind it, and it is what the green marking below is asked to
    check a line against.
    """
    parts: list[str] = []
    for entry in user.get("experiences") or []:
        for key in ("position", "company", "details"):
            value = entry.get(key)
            if value:
                parts.append(str(value))
    return "\n".join(parts)


# One revision round. The first pass has the profile and the posting in front
# of it and should not need a second; when it does, once is enough to catch the
# sentence it skimmed. Twice starts rewriting a document that was already fine.
MAX_MATCH_ROUNDS = 1


def _missed_matches(resume: ResumeDoc, user: dict) -> list[str]:
    """Posting terms the PROFILE evidences that the RESUME does not contain.

    Not a gap in the candidate — the profile has these. They are matches the
    document dropped, usually because the profile and the posting called the
    same thing by different names, or because the sentence sat in a role that
    got summarised away. Matched by the same rule everywhere else in this app:
    whole terms, case-insensitive, no stemming.
    """
    posting = resume.posting
    listed = [
        *posting.hard_skills,
        *posting.tech_stack,
        *posting.soft_skills,
        *posting.keywords,
    ]
    if not listed:
        return []

    evidenced = terms.present(format_profile(user), listed)
    return terms.missing(render.all_text(resume), evidenced)


async def _close_missed_matches(
    resume: ResumeDoc, user: dict, deadline: float, tally: _Tally
):
    """Asks for the dropped matches to be worked back in from the profile.

    Best-effort, like the coverage pass: this runs after a valid resume exists,
    so any failure costs the revision and never the resume. The result is
    merged through `humanize.merge`, which accepts only prose — bullets,
    details, headline, summary — and copies every factual field from the
    resume we already had. So this round can improve the wording and cannot
    invent an employer, a date or a skill, whatever comes back.

    Yields a phase event before each round it actually makes, then the resume.
    Like the coverage pass, the event sits past every reason this might not
    run, so it is never announced for work that did not happen.
    """
    for round_number in range(MAX_MATCH_ROUNDS if settings.llm_refine else 0):
        missed = _missed_matches(resume, user)
        if not missed:
            break
        if _left(deadline) < llm.MIN_BUDGET:
            logger.info("No time left for the match pass; returning as generated.")
            break

        yield _phase("matching", terms=len(missed), round=round_number + 1)
        try:
            completion = await llm.chat(
                build_match_messages(resume.model_dump(mode="json"), user, missed),
                json_mode=True,
                budget=_left(deadline),
            )
            tally.add(completion)
            revision = llm.extract_json(completion.text)
        except llm.LLMError as exc:
            logger.warning("Could not recover %d missed match(es): %s", len(missed), exc)
            break

        try:
            merged, report = humanize.merge(resume, revision)
        except ValidationError as exc:
            logger.warning("Match pass produced an unusable shape: %s", exc)
            break

        if report["ignored_count"]:
            logger.info(
                "Match pass tried to change %d protected field(s): %s",
                report["ignored_count"],
                ", ".join(report["ignored_changes"]),
            )

        still = _missed_matches(merged, user)
        # A round that recovered nothing has not understood the ask, and its
        # rewrite is not worth taking in exchange.
        if len(still) >= len(missed):
            logger.info("Match pass recovered nothing; keeping the original resume.")
            break
        logger.info(
            "Match pass recovered %d term(s): %s",
            len(missed) - len(still),
            ", ".join(t for t in missed if t not in still),
        )
        resume = merged

    resume.missed_terms = _missed_matches(resume, user)
    yield resume


def _mark_profile_terms(resume: ResumeDoc, user: dict) -> ResumeDoc:
    """Which sample sentences this profile's EXPERIENCE fully backs.

    A line is marked only when every posting term it uses appears in the
    experience — not one of them, all of them. The distinction is the whole
    point: a sentence about deep learning in PyTorch on AWS, where the
    experience mentions only AWS, is not a line this person can stand behind,
    and marking it would say they could. So the mark means "every term in this
    line is accounted for by work already described", and a line that is only
    partly covered reads the same as one that is not covered at all — which is
    correct, because both need editing before they are true.

    Matched by the same rule the coverage check uses: whole terms, case
    insensitive, no stemming. A looser rule would mark a line on a resemblance
    a screener would not count.
    """
    posting = resume.posting
    listed = [
        *posting.hard_skills,
        *posting.tech_stack,
        *posting.soft_skills,
        *posting.keywords,
    ]
    if not listed or not posting.sample_sentences:
        return resume

    experience = _experience_text(user)
    backed = terms.present(experience, listed)
    known = {term.casefold() for term in backed}
    posting.terms_in_profile = backed

    marked: list[int] = []
    for position, sentence in enumerate(posting.sample_sentences, start=1):
        used = [term for term in listed if terms.mentions(sentence, term)]
        # A sentence naming no listed term at all is not "fully covered" — it
        # is uncheckable, and `all()` over an empty list would quietly call it
        # covered.
        if used and all(term.casefold() in known for term in used):
            marked.append(position)
    posting.sentences_in_profile = marked
    return resume


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
