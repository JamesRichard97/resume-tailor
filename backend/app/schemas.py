"""Pydantic models for request/response bodies.

Note the deliberate asymmetry between input and output models:

* **Input** (`UserCreate`) is strict — all four fields are required and
  validated. Nothing incomplete can enter the store from here on.
* **Output** (`User`, `UserOption`) is lenient — fields are nullable. The JSON
  store is schemaless, so rows written by an earlier version of this app can
  still be read back instead of blowing up serialization with a 500. `db.migrate()`
  reshapes those rows on startup; these models are the belt to its braces.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import ClassVar

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)

from .terms import missing as _missing_terms

# Resume dates are month-precision: "2024-03", as <input type="month"> emits.
_MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")

# Accepts linkedin.com and its country subdomains (ca., uk., fr., …).
_LINKEDIN_HOST = re.compile(r"^([a-z]{2,3}\.)?linkedin\.com$", re.IGNORECASE)
_SCHEME = re.compile(r"^https?://", re.IGNORECASE)

# Deliberately loose: any mix of the usual separators is fine, and the real
# check is the digit count, so international formats all pass.
_PHONE_CHARS = re.compile(r"^\+?[0-9 ()\-./]+$")


def normalize_linkedin(value: str) -> str:
    """Accept `linkedin.com/in/ada`, `www.linkedin.com/in/ada` or a full URL,
    and return a canonical `https://…` form."""
    raw = value.strip().rstrip("/")
    if not raw:
        raise ValueError("LinkedIn address is required")

    candidate = raw if _SCHEME.match(raw) else f"https://{raw}"
    without_scheme = _SCHEME.sub("", candidate)
    host, _, path = without_scheme.partition("/")

    if not _LINKEDIN_HOST.match(host):
        raise ValueError("Must be a linkedin.com address")
    if not path:
        raise ValueError("Include the profile path, e.g. linkedin.com/in/your-name")

    return f"https://{host.lower()}/{path}"


def normalize_phone(value: str) -> str:
    raw = " ".join(value.split())
    if not _PHONE_CHARS.match(raw):
        raise ValueError("Enter a valid phone number")
    digits = re.sub(r"\D", "", raw)
    # E.164 allows up to 15 digits; 7 is about the shortest real local number.
    if not 7 <= len(digits) <= 15:
        raise ValueError("Enter a valid phone number")
    return raw


def check_month(value: str, label: str) -> str:
    raw = value.strip()
    if not _MONTH.match(raw):
        raise ValueError(f"{label} must be a month, e.g. 2024-03")
    return raw


# --------------------------------------------------------------------------
# Dated entries — experience, education, projects
# --------------------------------------------------------------------------


class DatedEntryIn(BaseModel):
    """Shared base for anything with a month range.

    Dates are month-precision strings compared as text — ISO `YYYY-MM` sorts
    correctly lexicographically, so no date parsing is needed anywhere.
    """

    model_config = ConfigDict(str_strip_whitespace=True)

    # Present when the client is editing an existing row; generated otherwise.
    id: str | None = None
    start_date: str
    end_date: str | None = None
    is_current: bool = False

    @field_validator("start_date")
    @classmethod
    def _check_start(cls, v: str) -> str:
        return check_month(v, "Start date")

    @field_validator("end_date")
    @classmethod
    def _check_end(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        return check_month(v, "End date")

    @model_validator(mode="after")
    def _check_range(self):
        if self.is_current:
            # Something ongoing has no end date, whatever the client sent.
            object.__setattr__(self, "end_date", None)
            return self
        if self.end_date is None:
            raise ValueError("End date is required unless this is marked as current")
        if self.end_date < self.start_date:
            raise ValueError("End date cannot be before the start date")
        return self


class DatedEntry(BaseModel):
    """Shared output base — lenient, so rows stored before a field existed
    still read back instead of failing serialization."""

    id: str
    start_date: str | None = None
    end_date: str | None = None
    is_current: bool = False


# `details` is deliberately unbounded. It is the account of what someone did,
# and a cap on it is a cap on how well the resume can be tailored: the
# generator can only use evidence that is written down, so truncating this
# field silently costs matches. It only has to be non-empty.
#
# What it does cost is prompt size — the whole profile is sent with every
# generation — so a profile of many very long entries can outgrow the model's
# context or run past LLM_TIMEOUT. That is a limit of the model in use, not a
# rule this app should impose on someone's history.


class ExperienceIn(DatedEntryIn):
    position: str = Field(min_length=1, max_length=120)
    company: str = Field(min_length=1, max_length=120)
    details: str = Field(min_length=1)
    # Sentences added with Insert, kept beside `details` rather than inside it.
    # Unlike `details` this has no min_length and defaults to empty: a role
    # with nothing inserted is the normal case, and it is what an older client
    # — or a payload built before this field existed — sends.
    inserted: list[str] = Field(default_factory=list)

    @field_validator("inserted", mode="before")
    @classmethod
    def _clean_inserted(cls, v) -> list[str]:
        if v is None:
            return []
        if not isinstance(v, (list, tuple)):
            return []
        return [s.strip() for s in (str(x) for x in v) if s.strip()]


class Experience(DatedEntry):
    position: str | None = None
    company: str | None = None
    details: str | None = None
    inserted: list[str] = Field(default_factory=list)

    @field_validator("inserted", mode="before")
    @classmethod
    def _clean_inserted(cls, v) -> list[str]:
        # Lenient like the rest of the output models: a row read back before
        # the column existed has None here and must not 500.
        if not isinstance(v, (list, tuple)):
            return []
        return [s.strip() for s in (str(x) for x in v) if s.strip()]


class EducationIn(DatedEntryIn):
    university: str = Field(min_length=1, max_length=160)
    details: str = Field(min_length=1)


class Education(DatedEntry):
    university: str | None = None
    details: str | None = None


class ProjectIn(DatedEntryIn):
    name: str = Field(min_length=1, max_length=160)
    details: str = Field(min_length=1)


class Project(DatedEntry):
    name: str | None = None
    details: str | None = None


# --------------------------------------------------------------------------
# Technical skills
# --------------------------------------------------------------------------

MAX_SKILLS_PER_GROUP = 60
MAX_SKILL_LENGTH = 60


def clean_skill_list(values: list[str] | None) -> list[str]:
    """Trim, drop blanks, and de-duplicate case-insensitively while keeping the
    first spelling the user typed and their ordering."""
    if not values:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for raw in values:
        item = " ".join(str(raw).split())
        if not item:
            continue
        if len(item) > MAX_SKILL_LENGTH:
            raise ValueError(f"'{item[:20]}…' is too long (max {MAX_SKILL_LENGTH})")
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    if len(out) > MAX_SKILLS_PER_GROUP:
        raise ValueError(f"At most {MAX_SKILLS_PER_GROUP} entries per group")
    return out


def coerce_skills(value) -> list[str]:
    """One flat list, from either shape.

    Skills used to be four named groups. A client or a stored row still sending
    that object is flattened here rather than rejected, in the order the groups
    were shown, so nothing anyone typed is lost to the change.
    """
    if isinstance(value, dict):
        merged: list[str] = []
        for group in ("languages", "frameworks", "developer_tools", "libraries"):
            merged.extend(value.get(group) or [])
        # Anything under a key this app never used still belongs to the person.
        for key, items in value.items():
            if key not in ("languages", "frameworks", "developer_tools", "libraries"):
                if isinstance(items, list):
                    merged.extend(items)
        value = merged
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        return []
    # clean_skill_list trims, drops blanks and de-duplicates case-insensitively,
    # which is what turns two groups that both listed Python into one entry.
    return clean_skill_list(value)


# --------------------------------------------------------------------------
# Input models — strict
# --------------------------------------------------------------------------


class UserCreate(BaseModel):
    """Payload for POST /api/users. All four fields are required."""

    model_config = ConfigDict(str_strip_whitespace=True)

    full_name: str = Field(min_length=1, max_length=120)
    linkedin_url: str = Field(min_length=1, max_length=200)
    email: EmailStr
    phone: str = Field(min_length=1, max_length=40)
    # Where the candidate is, as they would write it on a resume — "Montreal,
    # QC", "Toronto, ON (remote)". Optional, unlike the four above: a resume is
    # valid without it, and requiring it would reject every profile saved
    # before the field existed. Free text on purpose — the useful forms vary by
    # country and "open to relocation" is a legitimate thing to put here.
    location: str | None = Field(default=None, max_length=120)
    # Optional as a whole — a person may have none yet — but every entry that
    # IS supplied must be complete.
    experiences: list[ExperienceIn] = Field(default_factory=list)
    education: list[EducationIn] = Field(default_factory=list)
    projects: list[ProjectIn] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)

    @field_validator("skills", mode="before")
    @classmethod
    def _flatten_skills(cls, v) -> list[str]:
        return coerce_skills(v)

    @field_validator("linkedin_url")
    @classmethod
    def _check_linkedin(cls, v: str) -> str:
        return normalize_linkedin(v)

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, v: str) -> str:
        return normalize_phone(v)


class UserUpdate(BaseModel):
    """Payload for PATCH /api/users/{id} — every field optional, but any field
    that IS sent must still be valid. This is how a legacy row gets completed."""

    model_config = ConfigDict(str_strip_whitespace=True)

    full_name: str | None = Field(default=None, min_length=1, max_length=120)
    linkedin_url: str | None = Field(default=None, min_length=1, max_length=200)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, min_length=1, max_length=40)
    # No min_length, unlike the fields above: for an optional field, "" is how
    # the form says "clear this", and rejecting it would leave a location that
    # was typed once impossible to remove.
    location: str | None = Field(default=None, max_length=120)
    # When sent, replaces the whole list — simpler and more predictable than
    # per-entry patching.
    experiences: list[ExperienceIn] | None = None
    education: list[EducationIn] | None = None
    projects: list[ProjectIn] | None = None
    skills: list[str] | None = None

    @field_validator("skills", mode="before")
    @classmethod
    def _flatten_skills(cls, v) -> list[str] | None:
        # None means "not sent"; anything else replaces the whole list.
        return None if v is None else coerce_skills(v)

    @field_validator("linkedin_url")
    @classmethod
    def _check_linkedin(cls, v: str | None) -> str | None:
        return None if v is None else normalize_linkedin(v)

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, v: str | None) -> str | None:
        return None if v is None else normalize_phone(v)


# --------------------------------------------------------------------------
# Output models — lenient, so legacy rows are readable
# --------------------------------------------------------------------------


class User(BaseModel):
    id: str
    full_name: str
    linkedin_url: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    location: str | None = None
    experiences: list[Experience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)

    @field_validator("skills", mode="before")
    @classmethod
    def _flatten_skills(cls, v) -> list[str]:
        # Lenient like the rest of this model: a row stored in the old grouped
        # shape must still read back, not 500.
        return coerce_skills(v)
    # Nullable like every other field here: a row written before these existed
    # is reshaped with None, and a 500 on read would defeat the whole point of
    # keeping this model lenient. Nothing in the UI renders them.
    created_at: datetime | None = None
    updated_at: datetime | None = None
    is_complete: bool = True


class UserOption(BaseModel):
    """Trimmed shape for the select box on the tailor page."""

    id: str
    full_name: str
    linkedin_url: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    location: str | None = None
    experience_count: int = 0
    education_count: int = 0
    project_count: int = 0
    skill_count: int = 0
    is_complete: bool = True


class Message(BaseModel):
    detail: str


# --------------------------------------------------------------------------
# Tailoring
# --------------------------------------------------------------------------


class JobIn(BaseModel):
    """The posting a resume is being tailored against."""

    model_config = ConfigDict(str_strip_whitespace=True)

    company: str = Field(min_length=1, max_length=160)
    position: str = Field(min_length=1, max_length=160)
    # Optional: plenty of applications arrive by referral with no link.
    url: str | None = Field(default=None, max_length=500)
    description: str = Field(
        min_length=40,
        max_length=20000,
        description="The full posting — this is what the resume is tailored against.",
    )

    @field_validator("url")
    @classmethod
    def _check_url(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        raw = v.strip()
        if not _SCHEME.match(raw):
            raise ValueError("Enter a full URL, starting with http:// or https://")
        return raw


class TailorRequest(BaseModel):
    user_id: str = Field(min_length=1)
    job: JobIn


# ---- The structured resume the model must return -------------------------
#
# Asking for JSON rather than prose is what makes a .docx possible: the model
# supplies the words, this schema proves they are the right shape, and the
# document builder lays them out identically every time.


class ResumeContact(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    email: str | None = None
    phone: str | None = None
    linkedin: str | None = None
    # Copied from the profile like the rest of this block, never inferred: the
    # model is told the candidate's city, and guessing one from an employer's
    # head office would put a place on a resume the candidate never claimed.
    location: str | None = None


class ResumeExperience(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")

    position: str = ""
    company: str = ""
    dates: str = ""
    bullets: list[str] = Field(default_factory=list)


class ResumeProject(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")

    name: str = ""
    dates: str = ""
    bullets: list[str] = Field(default_factory=list)


class ResumeEducation(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")

    university: str = ""
    dates: str = ""
    details: str = ""


class PostingTerms(BaseModel):
    """The job description read on its own terms, split into the four lists a
    screener matches on.

    Nothing here is a claim about the candidate and none of it reaches the
    resume — it is the posting's own vocabulary, shown beside the result so the
    person can see what the role is being measured against.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")

    hard_skills: list[str] = Field(default_factory=list)
    soft_skills: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    tech_stack: list[str] = Field(default_factory=list)
    # The four lists above put to work: model sentences showing how the
    # posting's vocabulary reads in a resume line. Examples of the
    # ADVERTISEMENT's language for the candidate to adapt where it is true of
    # their work — not claims about them, and never part of the resume.
    sample_sentences: list[str] = Field(default_factory=list)
    # Terms from the four lists that no sample sentence contains, worked out
    # here rather than taken on trust. The prompt asks for every term to be
    # covered; this is what checks it, and the UI names what was missed
    # instead of implying nothing was.
    uncovered_terms: list[str] = Field(default_factory=list)
    # Terms from the four lists that the candidate's PROFILE also contains,
    # and the 1-based positions of the sample sentences that use one. Filled in
    # by the router, which is where the profile is in scope; the UI marks those
    # lines, so the reader can tell the wording they already evidence from the
    # wording they would be claiming for the first time.
    terms_in_profile: list[str] = Field(default_factory=list)
    sentences_in_profile: list[int] = Field(default_factory=list)

    # Covering every listed term takes more lines than a handful of examples
    # would; the cap is a guard against a runaway answer, not a target.
    MAX_SENTENCES: ClassVar[int] = 24
    MIN_SENTENCE: ClassVar[int] = 20
    MAX_SENTENCE: ClassVar[int] = 400

    @field_validator("sample_sentences", mode="before")
    @classmethod
    def _clean_sentences(cls, value):
        """Lenient like the term lists: a malformed entry costs us that one
        sentence, never the panel."""
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            return []
        kept: list[str] = []
        for item in value:
            if len(kept) >= cls.MAX_SENTENCES:
                break
            if isinstance(item, dict):
                item = item.get("sentence") or item.get("text") or ""
            text = " ".join(str(item).split())
            # Long enough to be a sentence, short enough to be a bullet.
            if cls.MIN_SENTENCE <= len(text) <= cls.MAX_SENTENCE:
                kept.append(text)
        return kept

    @model_validator(mode="after")
    def _check_coverage(self):
        """Which listed terms the sample sentences do not actually contain.

        Matched the way a screener matches: the exact string, case-insensitive,
        on word boundaries — so 'experiments' does not count 'experimentation',
        and 'NLP' is not found inside an unrelated word.
        """
        if not self.sample_sentences:
            # Nothing to check against: no sentences is not the same finding as
            # a sentence that left a term out, and flagging every term here
            # would bury the panel in noise.
            self.uncovered_terms = []
            return self

        visible = self.sample_sentences
        haystack = " ".join(visible)
        self.uncovered_terms = _missing_terms(
            haystack,
            [*self.hard_skills, *self.tech_stack, *self.soft_skills, *self.keywords],
        )
        return self

    @field_validator("hard_skills", "soft_skills", "keywords", "tech_stack", mode="before")
    @classmethod
    def _clean(cls, value):
        """Lenient by design: a model that returns a string, a null or a list
        of objects should cost us this panel, not the whole resume."""
        if isinstance(value, str):
            value = [part for part in value.split(",")]
        if not isinstance(value, list):
            return []
        seen: set[str] = set()
        out: list[str] = []
        for raw in value:
            if isinstance(raw, dict):
                raw = raw.get("name") or raw.get("term") or raw.get("skill") or ""
            item = " ".join(str(raw).split())
            if not item or len(item) > 80:
                continue
            key = item.casefold()
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
        return out[:60]


class ResumeDoc(BaseModel):
    """Extra keys are ignored rather than rejected — models like to add them,
    and an unexpected field is no reason to throw away a good resume."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")

    full_name: str = Field(min_length=1)
    headline: str = ""
    # What the posting asks for and this profile shows no evidence of. Never
    # written into the resume — it is reported to the candidate so the gap is
    # theirs to close or to judge, rather than being quietly filled in.
    gaps: list[str] = Field(default_factory=list)
    # A reading of the posting on its own terms: the experience it is asking
    # for, whoever ends up applying. Not a claim about this candidate and never
    # part of the resume — it is shown beside the result so the person can see
    # what the role wants and judge the fit themselves.
    wants: list[str] = Field(default_factory=list)
    # The 1-based positions in `wants` the profile already evidences, decided
    # after that list was written. Keeping the judgement separate from the
    # reading is what stops the reading being quietly trimmed to flatter the
    # candidate: the posting is described in full, then matched.
    wants_met: list[int] = Field(default_factory=list)
    # The same posting, split into the four lists a screener matches on. Like
    # `wants`, a reading of the advertisement rather than anything about this
    # candidate, and never part of the resume.
    posting: PostingTerms = Field(default_factory=PostingTerms)
    # Posting terms the PROFILE evidences that this resume nonetheless does not
    # contain — matches the candidate already earned and the document dropped.
    # Filled in by the router, which has the profile; reported rather than
    # hidden, because it is the one failure this app is meant to prevent.
    missed_terms: list[str] = Field(default_factory=list)

    @field_validator("posting", mode="before")
    @classmethod
    def _object_or_nothing(cls, value):
        """A model that answers with a list or a sentence here should cost us
        this panel, not the resume — same bargain as `wants_met` below."""
        return value if isinstance(value, dict) else {}

    @field_validator("wants_met", mode="before")
    @classmethod
    def _only_numbers(cls, value):
        """Drop anything that is not a line number. A model that answers
        ["3", "seven"] should cost us one unusable entry, not the whole
        resume — this field is a convenience, and nothing downstream breaks
        without it."""
        if not isinstance(value, list):
            return []
        out = []
        for item in value:
            try:
                out.append(int(str(item).strip()))
            except (TypeError, ValueError):
                continue
        return out
    contact: ResumeContact = Field(default_factory=ResumeContact)
    summary: str = ""
    experience: list[ResumeExperience] = Field(default_factory=list)
    projects: list[ResumeProject] = Field(default_factory=list)
    education: list[ResumeEducation] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)

    @field_validator("skills", mode="before")
    @classmethod
    def _flatten_resume_skills(cls, v) -> list[str]:
        """A model asked for a flat list may still answer with the four groups
        it has seen in a thousand resumes. Flattened rather than dropped."""
        return coerce_skills(v)


class TokenUsage(BaseModel):
    """What one generation cost, as the provider reported it.

    Reported, never estimated: these are the numbers the provider billed. A
    server that sends no `usage` block leaves them at zero, and the UI shows
    nothing rather than a guess.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    # How many model calls the generation took — one by default, up to three
    # with LLM_REFINE=on. Without it the totals look inexplicably large.
    calls: int = 0


class TailorResponse(BaseModel):
    id: str
    resume: ResumeDoc
    resume_markdown: str
    model: str
    # Absent on resumes generated before this was recorded.
    usage: TokenUsage | None = None
    user_id: str
    full_name: str | None = None
    company: str
    position: str
    generated_at: datetime

    # Present once the humanizing pass has run.
    humanized: ResumeDoc | None = None
    humanized_markdown: str | None = None
    humanized_model: str | None = None
    humanized_at: datetime | None = None
    # Facts the rewrite tried to change and that the merge discarded.
    ignored_changes: list[str] = Field(default_factory=list)


class ProviderStatus(BaseModel):
    configured: bool
    base_url: str | None = None
    model: str | None = None
    detail: str | None = None
    # Seconds one request is given before it is abandoned. Reported so the UI
    # can count against the real limit rather than a number copied into the
    # frontend and left to drift when someone edits backend/.env.
    timeout: float | None = None


class TailorStatus(ProviderStatus):
    """Generation provider, plus the separate humanizing provider."""

    humanize: ProviderStatus


# --------------------------------------------------------------------------
# Application registry
# --------------------------------------------------------------------------


class RegistryEntry(BaseModel):
    """One downloaded resume. Lenient like the other output models: rows
    written by an earlier version must stay readable."""

    id: str
    full_name: str = ""
    company: str = ""
    position: str = ""
    url: str = ""
    applied_at: datetime | None = None
    resume_name: str = ""
    job_description: str = ""
    resume_id: str | None = None
    version: str | None = None
