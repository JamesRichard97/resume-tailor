"""Renders a validated ResumeDoc as Markdown (for the on-screen preview) and as
a .docx (for download).

Both come from the same structured object, so what the browser shows and what
Word opens can never drift apart. The model never produces either format
directly — it returns JSON, and the layout below is deterministic.
"""

from __future__ import annotations

import io
import re
import unicodedata
from datetime import datetime, timezone

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

from .schemas import ResumeDoc

ACCENT = RGBColor(0x1F, 0x36, 0x64)
MUTED = RGBColor(0x55, 0x5B, 0x66)



def all_text(resume) -> str:
    """Every word the finished resume contains.

    Used to check what actually reached the page, so a term counted as
    "covered" is one a screener reading this document would really find.
    """
    parts: list[str] = [resume.headline, resume.summary, *resume.skills]
    for entry in resume.experience:
        parts += [entry.position, entry.company, *entry.bullets]
    for entry in resume.projects:
        parts += [entry.name, *entry.bullets]
    for entry in resume.education:
        parts += [entry.university, entry.details]
    return "\n".join(p for p in parts if p)


# --------------------------------------------------------------------------
# Markdown
# --------------------------------------------------------------------------


def to_markdown(resume: ResumeDoc) -> str:
    out: list[str] = [f"# {resume.full_name}"]

    if resume.headline:
        out.append(f"**{resume.headline}**")

    # Location last: it is the one item a reader scans for rather than acts on,
    # and appending keeps the order of the three contact methods people are
    # already used to.
    contact = [
        v
        for v in (
            resume.contact.email,
            resume.contact.phone,
            resume.contact.linkedin,
            resume.contact.location,
        )
        if v
    ]
    if contact:
        out.append(" · ".join(contact))

    if resume.summary:
        out += ["", "## Summary", "", resume.summary]

    if resume.experience:
        out += ["", "## Experience"]
        for exp in resume.experience:
            head = " — ".join(x for x in (exp.position, exp.company) if x)
            out += ["", f"### {head}" + (f"  \n*{exp.dates}*" if exp.dates else "")]
            out += [f"- {b}" for b in exp.bullets if b]

    if resume.projects:
        out += ["", "## Projects"]
        for proj in resume.projects:
            out += ["", f"### {proj.name}" + (f"  \n*{proj.dates}*" if proj.dates else "")]
            out += [f"- {b}" for b in proj.bullets if b]

    if resume.education:
        out += ["", "## Education"]
        for edu in resume.education:
            line = f"- **{edu.university}**"
            if edu.dates:
                line += f" — *{edu.dates}*"
            out.append(line)
            if edu.details:
                out.append(f"  {edu.details}")

    # One line, in the order the model put them: what the posting asks for
    # first. A screener reads the strings, not the headings that used to group
    # them, and a single line leaves the ordering to say what matters.
    if resume.skills:
        out += ["", "## Technical skills", "", ", ".join(resume.skills)]

    return "\n".join(out).strip() + "\n"


# --------------------------------------------------------------------------
# .docx
# --------------------------------------------------------------------------


def _bottom_border(paragraph) -> None:
    """A rule under a section heading. python-docx has no API for paragraph
    borders, so this edits the underlying XML."""
    p_pr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "2")
    bottom.set(qn("w:color"), "BFC6D4")
    borders.append(bottom)
    p_pr.append(borders)


def _spacing(paragraph, before: int = 0, after: int = 0, line: float | None = None):
    fmt = paragraph.paragraph_format
    fmt.space_before = Pt(before)
    fmt.space_after = Pt(after)
    if line is not None:
        fmt.line_spacing = line
    return paragraph


def _heading(doc: Document, text: str):
    p = doc.add_paragraph()
    run = p.add_run(text.upper())
    run.bold = True
    run.font.size = Pt(10.5)
    run.font.color.rgb = ACCENT
    run.font.name = "Calibri"
    _spacing(p, before=12, after=4)
    _bottom_border(p)
    return p


def _entry_header(doc: Document, left: str, right: str):
    """Title on the left, dates right-aligned on the same line, via a right tab
    stop — a two-column table would confuse some ATS parsers."""
    from docx.enum.text import WD_TAB_ALIGNMENT

    p = doc.add_paragraph()
    _spacing(p, before=8, after=1)
    p.paragraph_format.tab_stops.add_tab_stop(
        doc.sections[0].page_width
        - doc.sections[0].left_margin
        - doc.sections[0].right_margin,
        WD_TAB_ALIGNMENT.RIGHT,
    )
    run = p.add_run(left)
    run.bold = True
    run.font.size = Pt(11)
    if right:
        dates = p.add_run(f"\t{right}")
        dates.font.size = Pt(9.5)
        dates.font.color.rgb = MUTED
        dates.italic = True
    return p


def _bullets(doc: Document, items: list[str]) -> None:
    for text in items:
        if not text or not text.strip():
            continue
        p = doc.add_paragraph(text.strip(), style="List Bullet")
        _spacing(p, before=0, after=2, line=1.08)
        for run in p.runs:
            run.font.size = Pt(10)


def to_docx_bytes(resume: ResumeDoc) -> bytes:
    doc = Document()

    section = doc.sections[0]
    section.top_margin = section.bottom_margin = Pt(36)  # 0.5"
    section.left_margin = section.right_margin = Pt(45)  # ~0.63"

    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10)
    # East-Asian font mapping, so the font actually applies everywhere.
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "Calibri")

    # --- name -------------------------------------------------------------
    name_p = doc.add_paragraph()
    name_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    name_run = name_p.add_run(resume.full_name)
    name_run.bold = True
    name_run.font.size = Pt(22)
    name_run.font.color.rgb = ACCENT
    _spacing(name_p, after=2)

    if resume.headline:
        h = doc.add_paragraph()
        h.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = h.add_run(resume.headline)
        run.font.size = Pt(11)
        run.font.color.rgb = MUTED
        _spacing(h, after=2)

    # Location last: it is the one item a reader scans for rather than acts on,
    # and appending keeps the order of the three contact methods people are
    # already used to.
    contact = [
        v
        for v in (
            resume.contact.email,
            resume.contact.phone,
            resume.contact.linkedin,
            resume.contact.location,
        )
        if v
    ]
    if contact:
        c = doc.add_paragraph()
        c.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = c.add_run("  |  ".join(contact))
        run.font.size = Pt(9.5)
        run.font.color.rgb = MUTED
        _spacing(c, after=4)

    # --- summary ----------------------------------------------------------
    if resume.summary:
        _heading(doc, "Summary")
        p = doc.add_paragraph(resume.summary)
        _spacing(p, after=2, line=1.1)
        for run in p.runs:
            run.font.size = Pt(10)

    # --- experience -------------------------------------------------------
    if resume.experience:
        _heading(doc, "Experience")
        for exp in resume.experience:
            title = " — ".join(x for x in (exp.position, exp.company) if x)
            _entry_header(doc, title or "Experience", exp.dates)
            _bullets(doc, exp.bullets)

    # --- projects ---------------------------------------------------------
    if resume.projects:
        _heading(doc, "Projects")
        for proj in resume.projects:
            _entry_header(doc, proj.name or "Project", proj.dates)
            _bullets(doc, proj.bullets)

    # --- education --------------------------------------------------------
    if resume.education:
        _heading(doc, "Education")
        for edu in resume.education:
            _entry_header(doc, edu.university or "Education", edu.dates)
            if edu.details:
                p = doc.add_paragraph(edu.details)
                _spacing(p, after=2, line=1.08)
                for run in p.runs:
                    run.font.size = Pt(10)

    # --- skills -----------------------------------------------------------
    if resume.skills:
        _heading(doc, "Technical skills")
        p = doc.add_paragraph()
        _spacing(p, before=1, after=1, line=1.08)
        run = p.add_run(", ".join(resume.skills))
        run.font.size = Pt(10)

    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


# --------------------------------------------------------------------------
# Download filename
# --------------------------------------------------------------------------
#
#   Tailored_20260716_143052_JamesRichard_SSENSE_SoftwareEngineer.docx
#   Humanized_20260716_150418_JamesRichard_SSENSE_SoftwareEngineer.docx
#
# Underscore separates the fields, so no field may contain one — spaces and
# punctuation are removed and each word is capitalised instead. The result is
# ASCII-only, which keeps it legal on NTFS, ext4 and APFS alike and lets the
# Content-Disposition header quote it directly without RFC 5987 escaping.
#
# The timestamp carries seconds, so two resumes for the same role never land on
# the same name and Windows never appends " (1)". Date and time are separated by
# an underscore like every other field, which sorts correctly as plain text.
TIMESTAMP_FORMAT = "%Y%m%d_%H%M%S"

# Long enough for a real company or job title, short enough that all five
# fields together stay well inside the 255-byte filename limit.
_TOKEN_MAX = 48


def _token(value: str) -> str:
    """`James Richard` -> `JamesRichard`. Existing capitals survive, so
    `SSENSE` stays `SSENSE` rather than becoming `Ssense`."""
    # Fold accents instead of dropping them: José -> Jose, not Jos.
    decomposed = unicodedata.normalize("NFKD", value or "")
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    words = re.findall(r"[A-Za-z0-9]+", ascii_only)
    return "".join(w[:1].upper() + w[1:] for w in words)[:_TOKEN_MAX]


def filename_for(
    kind: str,
    *,
    full_name: str,
    company: str = "",
    position: str = "",
    when: datetime | None = None,
) -> str:
    """Build the download name for one document.

    `kind` is "Tailored" or "Humanized"; `when` is the moment that version was
    produced, so re-downloading an old resume keeps the time it was generated
    rather than now. Empty fields are omitted rather than filled with a
    placeholder — `..._JamesRichard_SoftwareEngineer.docx` reads better than
    `..._JamesRichard_Company_SoftwareEngineer.docx`.
    """
    moment = when or datetime.now(timezone.utc)
    if moment.tzinfo is not None:
        # Stored timestamps are UTC; show the server's local clock, which is the
        # time the person actually clicked Generate.
        moment = moment.astimezone()

    parts = [
        _token(kind) or "Resume",
        moment.strftime(TIMESTAMP_FORMAT),
        _token(full_name) or "Resume",
        _token(company),
        _token(position),
    ]
    return "_".join(p for p in parts if p) + ".docx"
