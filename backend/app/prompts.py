"""Turns a stored profile and a job posting into chat messages.

Kept apart from the router so the wording can be tuned without touching the
HTTP layer, and so it can be exercised without a live model.
"""

from __future__ import annotations

from typing import Any

# JSON rather than prose: the shape is validated before anything is built from
# it, and the .docx layout is then produced by code, not by the model.
SCHEMA = """{
  "full_name": "string",
  "headline": "string - short title aimed at this role, e.g. 'Senior Backend Engineer'",
  "contact": {"email": "string", "phone": "string", "linkedin": "string"},
  "summary": "string - 2-3 sentences positioning this candidate for THIS posting",
  "experience": [
    {
      "position": "string",
      "company": "string",
      "dates": "string - e.g. 'Sep 2022 - Present'",
      "bullets": ["string - one accomplishment per bullet"]
    }
  ],
  "projects": [{"name": "string", "dates": "string", "bullets": ["string"]}],
  "education": [{"university": "string", "dates": "string", "details": "string"}],
  "skills": {
    "languages": ["string"],
    "frameworks": ["string"],
    "developer_tools": ["string"],
    "libraries": ["string"]
  }
}"""

SYSTEM_PROMPT = f"""You are an expert technical resume writer.

You will be given a candidate's full profile and a job posting. Produce a resume \
for this candidate, tailored to that posting.

Rules:
- Use ONLY facts present in the candidate profile. Never invent employers, \
dates, degrees, titles, metrics or technologies. If the profile lacks something \
the posting asks for, leave it out rather than fabricating it.
- Reorder the candidate's real experience so the parts most relevant to the \
posting come first, and describe them in the posting's own vocabulary.
- Turn each role's details into concrete, outcome-oriented bullets. Keep each \
bullet to one or two lines. Three to five bullets per role is usually right.
- Copy contact details and dates from the profile exactly as given.
- Leave a section as an empty array if the profile has no data for it.

Respond with a single JSON object and nothing else — no prose, no explanation, \
no markdown code fences. It must match this shape exactly:

{SCHEMA}
"""


def _format_range(entry: dict[str, Any]) -> str:
    start = entry.get("start_date") or "?"
    if entry.get("is_current"):
        return f"{start} – Present"
    return f"{start} – {entry.get('end_date') or '?'}"


def _format_profile(user: dict[str, Any]) -> str:
    lines: list[str] = ["# CANDIDATE PROFILE", ""]

    lines.append(f"Name: {user.get('full_name') or '?'}")
    for label, key in (("Email", "email"), ("Phone", "phone"), ("LinkedIn", "linkedin_url")):
        if user.get(key):
            lines.append(f"{label}: {user[key]}")

    experiences = user.get("experiences") or []
    if experiences:
        lines += ["", "## Experience"]
        for exp in experiences:
            lines.append(
                f"- {exp.get('position') or '?'} at {exp.get('company') or '?'} "
                f"({_format_range(exp)})"
            )
            if exp.get("details"):
                for detail in str(exp["details"]).splitlines():
                    if detail.strip():
                        lines.append(f"    {detail.strip()}")

    projects = user.get("projects") or []
    if projects:
        lines += ["", "## Projects"]
        for proj in projects:
            lines.append(f"- {proj.get('name') or '?'} ({_format_range(proj)})")
            if proj.get("details"):
                for detail in str(proj["details"]).splitlines():
                    if detail.strip():
                        lines.append(f"    {detail.strip()}")

    education = user.get("education") or []
    if education:
        lines += ["", "## Education"]
        for edu in education:
            lines.append(f"- {edu.get('university') or '?'} ({_format_range(edu)})")
            if edu.get("details"):
                for detail in str(edu["details"]).splitlines():
                    if detail.strip():
                        lines.append(f"    {detail.strip()}")

    skills = user.get("skills") or {}
    groups = [
        ("Languages", skills.get("languages")),
        ("Frameworks", skills.get("frameworks")),
        ("Developer tools", skills.get("developer_tools")),
        ("Libraries", skills.get("libraries")),
    ]
    if any(items for _, items in groups):
        lines += ["", "## Technical skills"]
        for label, items in groups:
            if items:
                lines.append(f"- {label}: {', '.join(items)}")

    return "\n".join(lines)


def _format_job(job: dict[str, Any]) -> str:
    lines = [
        "# TARGET ROLE",
        "",
        f"Company: {job.get('company')}",
        f"Position: {job.get('position')}",
    ]
    if job.get("url"):
        lines.append(f"Posting URL: {job['url']}")
    lines += ["", "## Job description", "", str(job.get("description") or "").strip()]
    return "\n".join(lines)


def build_messages(user: dict[str, Any], job: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"{_format_profile(user)}\n\n"
                f"{_format_job(job)}\n\n"
                "Return the tailored resume as a single JSON object now."
            ),
        },
    ]


# --------------------------------------------------------------------------
# Humanizing pass
# --------------------------------------------------------------------------
#
# A rewrite, not a rewrite-and-embellish. The facts were already constrained to
# the candidate's real profile by the first pass; this pass may change only how
# they are worded. Anything that adds, removes or inflates a fact is a bug.

HUMANIZE_SYSTEM = """You are a careful editor who makes resumes read like a \
person wrote them, not a language model.

You will receive a resume as JSON. Rewrite the WORDING of the prose fields so it \
sounds like the candidate wrote it themselves — plain, specific, a little \
uneven, the way real writing is.

ABSOLUTE RULES — breaking any of these ruins the resume:
- Change no facts. Every company, job title, date, university, project name, \
technology, tool and number must survive exactly as given.
- Add nothing. No new achievements, metrics, percentages, team sizes or \
technologies. If it is not in the input, it does not go in the output.
- Remove no substance. Every bullet in must have a bullet out, carrying the \
same information.
- Do not touch `full_name`, `contact`, `company`, `position`, `dates`, \
`university`, `name`, or any entry in `skills`. Copy those through verbatim.

You may only rewrite: `headline`, `summary`, the strings inside `bullets`, and \
`education[].details`.

WHAT TO CHANGE — the things that make writing read as machine-made:
- Corporate and LLM vocabulary. Cut "spearheaded", "leveraged", "utilized", \
"orchestrated", "championed", "drove", "robust", "seamless", "cutting-edge", \
"best-in-class", "world-class", "passionate", "dynamic", "synergy", "holistic", \
"streamlined", "delve", "tapestry", "landscape", "realm", "testament". Use the \
plain verb a person would say: built, wrote, shipped, fixed, cut, moved, \
rewrote, ran, set up, took over, sped up.
- Uniform rhythm. Models write bullets of near-identical length and structure. \
Vary them on purpose: some six or eight words, some two lines. Do not start \
every bullet with a past-tense verb — let some open with the context or the \
problem.
- The rule of three. Models group everything into triads ("designed, built and \
deployed"). Break most of these into pairs or single items.
- Hedged padding. "Responsible for", "successfully", "effectively", "in order \
to", "helped to", "worked to", "various", "a range of" — delete them and say \
the thing.
- Inflation. "Transformed the platform" when the truth is "moved the platform \
off cron jobs". Prefer the smaller, truer claim.
- Decorative punctuation. Ordinary commas and full stops. No em-dash habit, no \
semicolon chains, no exclamation marks.

TONE: direct and unshowy. First person is implied, so no "I". Contractions are \
fine in the summary. It is fine — good, even — if the bullets are not perfectly \
parallel to each other.

Return the SAME JSON object with only those prose fields rewritten. Respond with \
the JSON and nothing else — no preamble, no explanation, no code fences."""


def build_humanize_messages(resume: dict[str, Any]) -> tuple[str, str]:
    """Returns (system, user_content) for the Anthropic Messages API."""
    import json

    return (
        HUMANIZE_SYSTEM,
        "Here is the resume JSON to rewrite:\n\n"
        + json.dumps(resume, indent=2, ensure_ascii=False)
        + "\n\nReturn the rewritten JSON now.",
    )
