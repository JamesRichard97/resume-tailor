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

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)

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


class ExperienceIn(DatedEntryIn):
    position: str = Field(min_length=1, max_length=120)
    company: str = Field(min_length=1, max_length=120)
    details: str = Field(min_length=1, max_length=4000)


class Experience(DatedEntry):
    position: str | None = None
    company: str | None = None
    details: str | None = None


class EducationIn(DatedEntryIn):
    university: str = Field(min_length=1, max_length=160)
    details: str = Field(min_length=1, max_length=4000)


class Education(DatedEntry):
    university: str | None = None
    details: str | None = None


class ProjectIn(DatedEntryIn):
    name: str = Field(min_length=1, max_length=160)
    details: str = Field(min_length=1, max_length=4000)


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


class Skills(BaseModel):
    """Four flat groups. Every group is optional and defaults to empty."""

    model_config = ConfigDict(str_strip_whitespace=True)

    languages: list[str] = Field(default_factory=list)
    frameworks: list[str] = Field(default_factory=list)
    developer_tools: list[str] = Field(default_factory=list)
    libraries: list[str] = Field(default_factory=list)

    @field_validator("languages", "frameworks", "developer_tools", "libraries")
    @classmethod
    def _clean(cls, v: list[str] | None) -> list[str]:
        return clean_skill_list(v)


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
    # Optional as a whole — a person may have none yet — but every entry that
    # IS supplied must be complete.
    experiences: list[ExperienceIn] = Field(default_factory=list)
    education: list[EducationIn] = Field(default_factory=list)
    projects: list[ProjectIn] = Field(default_factory=list)
    skills: Skills = Field(default_factory=Skills)

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
    # When sent, replaces the whole list — simpler and more predictable than
    # per-entry patching.
    experiences: list[ExperienceIn] | None = None
    education: list[EducationIn] | None = None
    projects: list[ProjectIn] | None = None
    skills: Skills | None = None

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
    experiences: list[Experience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    skills: Skills = Field(default_factory=Skills)
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


class ResumeSkills(BaseModel):
    model_config = ConfigDict(extra="ignore")

    languages: list[str] = Field(default_factory=list)
    frameworks: list[str] = Field(default_factory=list)
    developer_tools: list[str] = Field(default_factory=list)
    libraries: list[str] = Field(default_factory=list)


class ResumeDoc(BaseModel):
    """Extra keys are ignored rather than rejected — models like to add them,
    and an unexpected field is no reason to throw away a good resume."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")

    full_name: str = Field(min_length=1)
    headline: str = ""
    contact: ResumeContact = Field(default_factory=ResumeContact)
    summary: str = ""
    experience: list[ResumeExperience] = Field(default_factory=list)
    projects: list[ResumeProject] = Field(default_factory=list)
    education: list[ResumeEducation] = Field(default_factory=list)
    skills: ResumeSkills = Field(default_factory=ResumeSkills)


class TailorResponse(BaseModel):
    id: str
    resume: ResumeDoc
    resume_markdown: str
    model: str
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
