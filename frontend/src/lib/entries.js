/** Shared helpers for the repeatable sections (experience, education, projects)
 *  and the skills groups. Mirrors the server's rules in schemas.py. */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// Local keys keep React list keys stable while a row has no server id yet.
let localSeq = 0
export const newEntry = (extra = {}) => ({
  id: null,
  start_date: '',
  end_date: '',
  is_current: false,
  ...extra,
  _key: `new-${(localSeq += 1)}`,
})

/** Maps a stored entry onto form state, tolerating fields added later. */
export const toFormEntry = (entry, extra = {}) => ({
  id: entry.id ?? null,
  start_date: entry.start_date ?? '',
  end_date: entry.end_date ?? '',
  is_current: Boolean(entry.is_current),
  ...extra,
  _key: entry.id ?? `edit-${Math.random().toString(36).slice(2)}`,
})

/** Shape a form row into the API payload. */
export const toPayloadEntry = (row, extra = {}) => ({
  id: row.id ?? undefined,
  start_date: row.start_date,
  end_date: row.is_current ? null : row.end_date,
  is_current: row.is_current,
  ...extra,
})

/**
 * Validates the From/To pair, writing into `rowErrors`.
 * `currentLabel` tailors the message, e.g. "the current role".
 */
export function validateDateRange(row, rowErrors, currentLabel = 'current') {
  if (!row.start_date) {
    rowErrors.start_date = 'From date is required.'
  } else if (!MONTH_RE.test(row.start_date)) {
    rowErrors.start_date = 'Use a month, e.g. 2024-03.'
  }

  if (row.is_current) return rowErrors

  if (!row.end_date) {
    rowErrors.end_date = `To date is required unless this is ${currentLabel}.`
  } else if (!MONTH_RE.test(row.end_date)) {
    rowErrors.end_date = 'Use a month, e.g. 2024-03.'
  } else if (row.start_date && row.end_date < row.start_date) {
    rowErrors.end_date = 'To date cannot be before the from date.'
  }

  return rowErrors
}

/** "Python, Java , python" -> ["Python", "Java"] — trimmed, blank-free, deduped
 *  case-insensitively, keeping the first spelling. Matches the server. */
export function parseSkillList(value) {
  const seen = new Set()
  const out = []
  for (const raw of String(value).split(',')) {
    const item = raw.trim().replace(/\s+/g, ' ')
    if (!item) continue
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export const formatSkillList = (list) => (list ?? []).join(', ')

export const SKILL_GROUPS = [
  { key: 'languages', label: 'Languages', placeholder: 'Python, TypeScript, Go' },
  { key: 'frameworks', label: 'Frameworks', placeholder: 'FastAPI, React, Django' },
  {
    key: 'developer_tools',
    label: 'Developer tools',
    placeholder: 'Docker, Git, Postman',
  },
  { key: 'libraries', label: 'Libraries', placeholder: 'pandas, pydantic, NumPy' },
]

export const EMPTY_SKILLS = {
  languages: '',
  frameworks: '',
  developer_tools: '',
  libraries: '',
}
