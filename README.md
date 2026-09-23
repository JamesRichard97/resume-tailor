# Resume Tailor

React (Vite) frontend + FastAPI backend, with SQLite as the datastore.

```
resume-tailor/
├── start.bat           Windows launcher - starts both servers
├── backend/            FastAPI app
│   ├── app/
│   │   ├── main.py     app factory, CORS, router wiring
│   │   ├── config.py   settings from env vars
│   │   ├── schemas.py  pydantic request/response models
│   │   ├── llm.py      OpenAI-compatible + Anthropic clients
│   │   ├── prompts.py  profile + posting -> chat messages
│   │   ├── humanize.py merges a rewrite back without letting facts change
│   │   ├── render.py   ResumeDoc -> Markdown and .docx
│   │   ├── database.py SQLite connection + schema
│   │   ├── db.py       users and resumes
│   │   ├── registry.py the application registry
│   │   ├── importer.py one-time import of the old JSON files
│   │   └── routers/    users.py, tailor.py, registry.py
│   └── data/resume-tailor.db   SQLite, created on first run
└── frontend/           React + Vite
    ├── public/         favicon.svg, PNG icons, site.webmanifest
    └── src/
        ├── api/client.js
        ├── lib/entries.js      shared entry/skill helpers
        ├── hooks/useTheme.js
        ├── styles/global.css   design tokens (light + dark)
        ├── components/  Header, Logo, ThemeToggle, UserCombobox, UserTable,
        │                Modal, Toast, JobForm, DateRangeFields,
        │                ExperienceFields, SimpleEntryFields, SkillsFields
        └── pages/       HomePage, UserRegistrationPage, RegistryPage
```

## Run it

### Windows: `start.bat`

Double-click `start.bat` in the project folder. It checks that Python and Node
are on PATH, creates `backend\.venv` and installs `requirements.txt` the first
time, runs `npm install` if `node_modules` is missing, then opens one window for
the API and one for the web app and points your browser at
<http://localhost:5173>.

Each server gets its own window, so you can read its log and stop it with Ctrl+C
without touching the other. Run it again later and it skips the install steps —
the Python packages are reinstalled only when `requirements.txt` has actually
changed, which it detects by comparing against the copy it keeps in the venv.

If a port is already listening it leaves that server alone rather than starting
a second one: a second uvicorn on a busy port exits immediately, and a second
Vite quietly moves to 5174 and then talks to nothing.

The backend window `cd`s into `backend\` before starting uvicorn, because
`DATABASE_FILE` defaults to the relative path `data/resume-tailor.db` — started
from anywhere else it would create a second, empty database in the wrong folder.

A missing `backend\.env` is a warning, not an error: the app starts and every
page works, but Generate and Humanize report that no model is configured.

### By hand

Two terminals.

**1. Backend** (Python 3.10+)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS / Linux
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

API docs: <http://localhost:8000/docs>

**2. Frontend** (Node 18+)

```bash
cd frontend
npm install
npm run dev
```

App: <http://localhost:5173>

Vite proxies `/api` to `http://127.0.0.1:8000`, so no CORS setup is needed in
development. CORS is also enabled server-side for `localhost:5173` if you'd
rather call the backend directly.

## Pages

| Route       | What it does                                                                        |
| ----------- | ----------------------------------------------------------------------------------- |
| `/`         | Tailor page - pick a user, review their profile, describe the target role           |
| `/register` | User CRUD — add/edit form plus the registered-users table, reachable from the header |
| `/registry` | Application registry — one row per downloaded resume, filterable and sortable       |

All three share one width (1440px) so the header controls never shift sideways
as you change page, and `scrollbar-gutter: stable` reserves the scrollbar's
width whether or not a page needs one — otherwise arriving at a page that
scrolls narrows the viewport and nudges everything left.

`/` is split in two: **User** and the selected person's profile on the left,
**Target role** and the generated resume on the right. Who you are tailoring
for stays in view beside what came back, instead of scrolling away above it.
Below 1060px the columns stack in that same order.

In the **Selected** card, each experience/education/project note is cut off
after three lines with an ellipsis and a **Show more** toggle
(`components/ClampedText.jsx`), and the contact values, the entry titles
(position · company, university, project name) and the dates all share one line
each — the title is the part that shrinks and ellipsizes, since a clipped date
range is unreadable while a clipped job title still says what the entry is.
Below 560px the dates drop below the title instead, which would otherwise be
squeezed to a few characters. A
profile with four paragraph-long notes would otherwise push the target role and
the result far down the page. The cut comes from `-webkit-line-clamp` rather
than from slicing the string, so it lands at the real end of the third line
whatever the column width and text-size setting are, and the toggle is rendered
only when the text actually overflows — measured with a `ResizeObserver`, so it
appears and disappears as the column or the text size changes. Truncated values
carry a `title` with the full text.

Selecting someone loads their full profile and reveals a **Target role**
card: company name, position name, applying URL (optional) and the job
description. The description is validated for a minimum length, since it is what
the resume gets tailored against, and a live word count sits next to the label.
The job is held in page state and kept when you switch users - the posting is
about the role, not the person. **Generate tailored resume** sends the selected user's id and the posting to
`POST /api/tailor`. The result is shown as Markdown with **Copy**,
**Download .md** and **Download .docx** buttons; the .docx is built server-side
and streamed from the stored generation.

`/register` is the full CRUD surface. The registered-users table is the page:
sticky header, and **10, 15 or 20 rows a page** with the pager below it.
**Register user** sits in the table's header, with a second copy in the empty
state.

The table **never scrolls sideways** (`overflow: hidden auto`). It uses
`table-layout: fixed` with proportional column widths, so a long value wraps or
ellipsizes inside its column instead of widening the table. Name and email share
one cell - two short values stacked read better than two narrow columns and free
the width the rest need. Truncated cells carry a `title`, so the full value is
still reachable. Below 820px the Phone column drops, and below 620px LinkedIn
does too; everything remains visible in the edit dialog.

The add/edit form lives in a modal built on the native `<dialog>` element —
`showModal()` provides focus trapping, inert background content, Esc-to-close
and top-layer stacking, all of which are fiddly to reproduce by hand. The dialog
header and footer stay put while the form body scrolls, so the save button is
always reachable. Below 560px it goes full-screen.

One form serves both create and update: **Edit** on a row opens the same dialog
prefilled, titled "Edit user". It closes on success (the confirmation appears
above the table) and stays open on failure, so a validation error or a duplicate
email sits next to the fields it concerns. **Delete** is a two-step inline
confirm (Delete → Yes/No) rather than `window.confirm`, which blocks the page and
is awkward to automate. Editing a row flagged **Incomplete** is how you complete
a profile written by an earlier version of the app.

The form has four repeatable/grouped sections below the contact fields:

| Section | Per row |
| ------- | ------- |
| Experience | From / To, Position, Company, Details |
| Education | From / To, University, Details |
| Projects | From / To, Project name, Details |
| Technical skills | Languages, Frameworks, Developer tools, Libraries (comma-separated) |

**+ Add ...** appends a row, **Remove** drops it, and ticking the "currently"
checkbox disables that row's To field. Rows validate per-entry, so errors point
at the exact field in the offending row.

Experience, education and projects are the same shape - a month range plus some
text - so they share `DateRangeFields` for the From/To/current trio and
`lib/entries.js` for the validation and payload mapping. Education and projects
are literally the same component (`SimpleEntryFields`) with different labels.

Skills are typed as comma-separated text, and the chips under each input show
the parsed result live, so the trimming and case-insensitive de-duplication the
server does is visible before you save rather than a surprise after.

`UserCombobox` is a hand-rolled combobox (no UI library): type to filter across
name/email/LinkedIn, ↑/↓/Home/End to move, Enter to pick, Esc to close, click
outside to dismiss, `×` to clear. It's ARIA-wired (`role="combobox"` +
`role="listbox"`).

Registration asks for four required fields: full name, LinkedIn address, email
and phone. Both sides validate; the server is the authority and the form
surfaces its errors.

## Generating resumes

`POST /api/tailor` takes `{user_id, job}`. The backend loads the stored profile
itself, so the browser only sends the id plus the posting.

**The model returns JSON, not a document.** A `.docx` is a ZIP of XML parts — no
chat API can emit one, and a model asked to "write a Word file" produces
something unopenable. So the model fills a schema (`ResumeDoc`: name, contact,
summary, experience[], projects[], education[], skills), Pydantic validates it,
and `render.py` builds both outputs from that one object:

- **Markdown** for the on-screen preview,
- **`.docx`** via `python-docx`, with the layout written in code.

That split is what makes the result dependable: the layout is identical every
run, a malformed model response fails loudly instead of producing a mangled
file, and preview and download can't drift apart because they share a source.

Each generation is **stored** in the `resumes` table, so
`GET /api/tailor/{id}/docx` streams the file without calling the model again —
clicking Download doesn't cost another generation.

Generation calls an **OpenAI-compatible** `/chat/completions` endpoint, so the
same code works against OpenAI, LM Studio, Ollama, vLLM or llama.cpp. Configure
it in `backend/.env` (copy `.env.example`):

```bash
LLM_BASE_URL=http://localhost:1234/v1   # include the port and /v1
LLM_MODEL=gpt-4o
LLM_API_KEY=                            # only for hosted providers
LLM_TIMEOUT=120                         # local models on CPU can be slow
LLM_JSON_MODE=auto                      # auto | on | off
```

`LLM_JSON_MODE=auto` sends `response_format={"type":"json_object"}` and silently
retries without it if the server rejects the parameter — not every
OpenAI-compatible server supports it, and the prompt asks for JSON either way.
Responses wrapped in a ``` fence or padded with a sentence of preamble are
tolerated too.

Leaving `LLM_BASE_URL` empty means "not configured" — the app says so plainly
rather than guessing a default. Restart uvicorn after editing `.env`.

The prompt (`prompts.py`) instructs the model to use only facts present in the
profile and to leave out anything the posting asks for that the candidate does
not have, rather than inventing it. `LLM_TEMPERATURE` defaults to 0.3 for the
same reason.

### Failure modes

Each one gets its own status code, because each needs a different fix, and the
frontend turns them into a toast with the matching title:

| Status | Meaning | Toast |
| ------ | ------- | ----- |
| 503 | `LLM_BASE_URL` is empty | "No model configured" |
| 502 | endpoint unreachable, bad credentials, error status, or unusable body | "The model is unavailable" |
| 504 | endpoint accepted the request but didn't answer in time | "The model timed out" |

A model that returns prose instead of JSON, or JSON in the wrong shape, is also
a 502 — with a message naming the offending field.

`GET /api/tailor/status` reports whether an endpoint is configured; the tailor
page checks it on load and shows an inline warning before you paste a posting,
rather than letting you type a long description and fail at the end.

## Humanizing

A generated resume reads like a model wrote it: "spearheaded", "leveraged",
"robust", every bullet the same length. **Humanize with Claude** in the result
card rewrites the wording so it reads like the candidate wrote it —
`POST /api/tailor/{id}/humanize`.

This pass uses **Anthropic's Messages API**, which is a different wire format
from the OpenAI one above (different URL, auth header and response shape), so it
is a separate client and configured separately. The two passes can point at
different providers entirely.

```bash
CLAUDE_BASE_URL=https://api.anthropic.com/v1
CLAUDE_MODEL=              # no default: model ids change, so set it explicitly
CLAUDE_API_KEY=
CLAUDE_TEMPERATURE=0.8     # higher than generation; facts are protected in code
```

### Facts cannot change

The prompt tells Claude to rewrite wording only. `humanize.py` makes that
**structural rather than hopeful**: the merge takes every factual field from the
ORIGINAL and accepts only prose from the rewrite. Names, employers, titles,
dates, universities and skills are copied from the original; there is no code
path by which a rewritten one reaches the document.

| Rewritable | Copied from the original |
| ---------- | ------------------------ |
| `headline`, `summary` | `full_name`, `contact` |
| `experience[].bullets` | `position`, `company`, `dates` |
| `projects[].bullets` | `name`, `dates` |
| `education[].details` | `university`, `dates`, all of `skills` |

Anything the rewrite tried to change outside its remit is discarded, returned as
`ignored_changes`, logged server-side, and shown to the user as a toast. An
empty or null rewrite falls back to the original rather than deleting content.

Humanizing always rewrites from the original, so running it twice doesn't
compound drift. Both versions are kept: the result card has an
Original / Humanized toggle, and Copy, Download .md and Download .docx all
follow whichever is selected (`?version=original|humanized|auto`).

## Theming

Every colour in the app is a CSS custom property defined in
`src/styles/global.css` — once under `:root[data-theme='light']` and once under
`:root[data-theme='dark']`. Components reference tokens only, so dark mode costs
nothing per component and a palette change is one file.

- **Three modes**: dark (default), light, system. The header toggle cycles
  dark -> light -> system. Every mode is written to `localStorage` (`rt-theme`),
  including `system` — clearing the key for it would be indistinguishable from
  never having chosen, and the next load would silently fall back to dark. On
  `system` the OS preference is followed live.
- **No flash on load.** A small inline script in `index.html` sets
  `data-theme` before first paint. Resolving the theme in React alone would
  render one light frame first.
- **`color-scheme` is set per theme**, so native widgets — the month pickers,
  checkboxes, scrollbars — follow along instead of staying stubbornly white.
- **Dark isn't an inverted light.** The accent lifts from `#2f5bd7` to `#7d9dfb`
  (the light-mode blue fails contrast on a dark surface), shadows give way to
  borders for elevation, and dropdowns use `--surface-raised` since a shadow
  over a same-coloured card reads as nothing.

Contrast was checked against WCAG AA: body, muted, accent, danger and success
text all pass 4.5:1 on their own backgrounds in both themes.

The icon is `public/favicon.svg` — a document with a folded corner and one
highlighted line, the "tailored" one. The PNGs beside it are rendered from that
same SVG, and `src/components/Logo.jsx` inlines the identical artwork for the
header.

## The header controls

Three things sit to the right of the nav, all remembered in `localStorage` and
all applied before first paint by the inline script in `index.html`, so nothing
visibly changes size, colour or position after the page loads.

**Text size** (`A · 100% · A`, key `rt-font-scale`). Five steps — 90, 100, 110,
125, 140%. Every `font-size` in the app is written as
`calc(Npx * var(--font-scale))`, so one number on `<html>` moves all of them
while padding and borders stay put; the layout does not reflow, the type just
grows. The middle button shows the current size and resets to 100% in one click
rather than making you step back. Icon buttons that hold a glyph are sized off
the same variable (`--control-sm/md/lg`), so nothing clips at 140%.

**Starfield** (key `rt-stars`). Toggles the animated background off. An
animated background with no way out is an annoyance, and it is the first thing
anyone reaches for on battery. Read synchronously on first render, so someone
who turned it off never sees a frame of it.

**Theme** — see [Theming](#theming).

Below 720px the text-size control hides: the nav and the theme toggle need the
room more than a control you touch once.

## The animated background

`src/components/StarfieldBackground.jsx` draws a full-window canvas behind the
app: stars drift slowly upward and twinkle, and moving the pointer brightens
the ones within 260px and draws constellation lines between any two lit stars
closer than 135px, so the pattern forms under the cursor and dissolves behind
it. The behaviour is inspired by Thibka's "Interactive Stars" canvas
experiment; none of the code is copied from it.

Underneath, the canvas paints the page background itself — a vertical gradient
that drifts between four colour pairs on a ~100s loop. The stars and lines run
their own faster cycle (~8.5s a step) through five tints each, so the colour is
the part you notice changing while the sky reads as constant. Light and dark
have separate palettes: near-whites on a deep sky, deep indigos on a pale one.

It is decoration, so it is constrained accordingly:

- `pointer-events: none` — it can never intercept a click meant for a card.
- `prefers-reduced-motion` gives a still field and a fixed sky, with no
  animation loop running at all.
- It stops when the tab is hidden, so a background tab costs nothing.
- Star count scales with the viewport and caps at 340, device pixel ratio caps
  at 2, and the constellation pass only looks at the stars near the cursor — so
  the per-frame cost stays flat rather than growing with the window.

## Pagination

Both tables page client-side, 10/15/20 rows, default 15, remembered across
reloads in `rt-page-size` and shared by both pages
(`src/hooks/usePagination.js`).

Client-side on purpose. Both tables sort and filter in the browser over the
whole set, and server-side paging would quietly break that: sorting by Company
would only reorder the fifteen rows you happen to be looking at, which is worse
than not working because it looks like it worked.

Two behaviours worth having:

- **Changing a filter returns you to page 1.** Staying on page 4 of a result
  that just became 13 rows shows an empty table.
- **Deleting the last row on the last page lands on the new last page**, not on
  a blank one — the page number is clamped to the page count rather than reset.

The users page asks the API for its 500-row maximum. The default is 100, which
would have silently paged over a first hundred with nothing to say so.

## API

Base path `/api`.

| Method   | Path                  | Notes                                       |
| -------- | --------------------- | ------------------------------------------- |
| `GET`    | `/health`             | liveness, database path, LLM configured?    |
| `GET`    | `/tailor/status`      | whether an LLM endpoint is configured       |
| `POST`   | `/tailor`             | generate a tailored resume (503/502/504)    |
| `GET`    | `/tailor/{id}`        | fetch a stored generation                   |
| `POST`   | `/tailor/{id}/humanize` | rewrite the prose via Claude              |
| `GET`    | `/tailor/{id}/docx`   | download as .docx (`?version=`)             |
| `GET`    | `/registry`           | downloads, newest first (`?from=`, `?to=`)   |
| `GET`    | `/registry/days`      | how many downloads on each day               |
| `GET`    | `/users`              | `?q=` search, `?limit=`, `?offset=`         |
| `GET`    | `/users/options`      | trimmed shape for the select box            |
| `GET`    | `/users/{id}`         |                                             |
| `POST`   | `/users`              | 409 if the email is already registered      |
| `PATCH`  | `/users/{id}`         | partial update                              |
| `DELETE` | `/users/{id}`         |                                             |

User shape:

```json
{
  "id": "uuid",
  "full_name": "Ada Lovelace",
  "linkedin_url": "https://linkedin.com/in/ada-lovelace",
  "email": "ada@example.com",
  "phone": "(514) 555-0100",
  "experiences": [
    {
      "id": "uuid",
      "position": "Research Fellow",
      "company": "Royal Society",
      "start_date": "2023-01",
      "end_date": null,
      "is_current": true,
      "details": "Research fellow."
    }
  ],
  "created_at": "2026-09-22T17:00:00+00:00",
  "updated_at": "2026-09-22T17:00:00+00:00"
}
```

### Experience, education and projects

All three are lists on the user - there are no separate endpoints. Each list is
optional as a whole (a person may have none), but every entry that IS supplied
must be complete:

| List | Required per entry |
| ---- | ------------------ |
| `experiences` | `position`, `company`, `details` |
| `education` | `university`, `details` |
| `projects` | `name`, `details` |

plus `start_date` for all three, and `end_date` unless `is_current` is true.
They share `DatedEntryIn` in `schemas.py`, so the date rules below are defined
once.

- **Dates are month-precision `YYYY-MM`** strings, matching what
  `<input type="month">` emits. They're compared as plain text, which works
  because ISO months sort lexicographically — no date parsing anywhere.
- **`is_current` wins over `end_date`.** Ticking it clears the end date server-side
  whatever the client sent, so "current until March" can't be stored.
- **`PATCH` replaces the whole list**, rather than patching entries individually.
  Send the entries you want to keep, each with its `id`; omit `experiences`
  entirely and the stored list is left alone.
- **Entries are stored newest-first** (ongoing ones, then by start date
  descending) - the order a resume reads in.

### Skills

`skills` is an object with four flat string lists: `languages`, `frameworks`,
`developer_tools`, `libraries`. Entries are trimmed, blanks dropped, and
de-duplicated case-insensitively keeping the first spelling and the order given
(`["Python", " java ", "python"]` stores as `["Python", "java"]`). Max 60
entries per group, 60 characters each. Like the lists above, sending `skills`
replaces the whole object.

All four input fields are required. Two normalizing validators live in
`schemas.py`:

- **`linkedin_url`** — accepts `linkedin.com/in/ada`, `www.linkedin.com/in/ada`,
  a country subdomain (`ca.linkedin.com/…`) or a full URL, and stores the
  canonical `https://…` form. Non-LinkedIn hosts and a bare domain with no
  profile path are rejected.
- **`phone`** — collapses whitespace and checks the digit count (7–15, per
  E.164) rather than pattern-matching punctuation, so `+1 514 555 0100`,
  `(514) 555-0100` and `5145550100` all pass and are stored as typed.

## Application registry

Every completed `.docx` download appends a row to the `registry` table. Each
row also stores `applied_day`, the local calendar date, indexed — so the date
filters are a lookup rather than timezone arithmetic across every row, and
archiving a period is `DELETE FROM registry WHERE applied_day < '2026-07-01'`.
The day comes from the local clock: a download at 8pm belongs to that evening.

Each row:

```json
{
  "id": "uuid",
  "full_name": "James Richard",
  "company": "SSENSE",
  "position": "Software Engineer",
  "url": "https://ssense.com/careers/1234",
  "applied_at": "2026-07-16T18:30:52.184000+00:00",
  "resume_name": "Tailored_20260716_143052_JamesRichard_SSENSE_SoftwareEngineer.docx",
  "job_description": "…"
}
```

Three deliberate choices:

* **The download is the event, not the generation.** A resume you generated and
  never downloaded is not an application.
* **One row per download.** Downloading the tailored version and then the
  humanized one gives you two rows, because those are two different documents
  that may have gone to two different places. Re-downloading the same file adds
  a row too — the registry records what happened, not what you meant.
* **Read-only.** A record you can edit from the app is not much of a record;
  correct a mistake with SQL against `registry` if you have to.

Unlike the resume record, a row keeps the full job description — months later,
"what was this job actually asking for" is the question a company name alone
cannot answer.

`/registry` shows the rows in a table, filterable by user name, company name
and an applied-from/to date range, and sortable on every column. Filtering and
sorting happen in the browser: it is one person's application history, so
shipping the list once and sorting it instantly beats a round trip per click.
Expanding a row shows the applying URL, the full resume filename and the whole
job description.

## Notes on the datastore

Everything lives in one SQLite file, `backend/data/resume-tailor.db`:

| Table | Holds |
| ----- | ----- |
| `users` | name, LinkedIn, email, phone, timestamps |
| `experiences`, `education`, `projects` | one row per entry, `sort_order` preserving display order |
| `skills` | one row per skill — `(user_id, kind, value)` |
| `resumes` | the generated document as JSON, plus its humanized version |
| `registry` | one row per download, with `applied_day` indexed for the date filters |
| `meta` | schema version, and which JSON files have been imported |

`app/database.py` owns the connection and the schema; `app/db.py` and
`app/registry.py` are the only modules that write SQL. The routers call
functions and get plain dicts, so the storage could change again without them
noticing.

Three choices worth knowing about:

* **Stdlib `sqlite3`, no ORM.** The whole data layer is a few hundred lines of
  plain SQL. An ORM would add a dependency, a migration tool and a layer of
  indirection to save none of it.
* **The sections are real tables, the generated resume is not.** What you typed
  into the form is structured data worth querying — *who knows Kafka* is a
  `SELECT`. The generated resume is an artifact the model produced and the app
  only ever reads whole, so it stays JSON in one column.
* **Foreign keys are enforced.** Deleting a user takes their experiences,
  education, projects and skills with them (`ON DELETE CASCADE`), while their
  generated resumes survive with a null link — you may still want the document.

Connections are per thread (a SQLite connection may not be shared across
threads, and FastAPI runs sync endpoints in a threadpool), in WAL mode with a
15-second busy timeout. That removes the old single-worker constraint: several
uvicorn workers on the same machine are fine now.

### Upgrading from the JSON version

Nothing to do. On startup the app imports `db.json` and every
`YYYYMMDD_registry.json` it finds, then renames them to `*.imported`. The
import is recorded in the `meta` table as well, so restoring a backup of the
old files next to a populated database will not duplicate anything. The
originals are renamed rather than deleted — removing them is your call.
