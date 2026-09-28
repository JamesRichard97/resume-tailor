/** The clipboard format shared by the registry (which writes it) and the
 *  tailor page (which reads it back).
 *
 *  Labelled lines rather than JSON: the same text pasted into an email, a note
 *  or a spreadsheet still reads as a job, which is what someone copying a row
 *  usually wants. The description goes last, unlabelled after its heading, so
 *  a posting containing the word "Company:" cannot confuse the parse.
 */

const LABELS = {
  company: 'Company',
  position: 'Position',
  url: 'Applying URL',
  description: 'Job description',
}

/** A registry row (or anything with these four fields) -> clipboard text. */
export function formatJob(entry) {
  const lines = []
  if (entry?.company) lines.push(`${LABELS.company}: ${entry.company}`)
  if (entry?.position) lines.push(`${LABELS.position}: ${entry.position}`)
  if (entry?.url) lines.push(`${LABELS.url}: ${entry.url}`)
  if (entry?.job_description ?? entry?.description) {
    lines.push('', `${LABELS.description}:`, entry.job_description ?? entry.description)
  }
  return lines.join('\n')
}

// One label at the very start of a line, e.g. "Applying URL: https://…".
const HEADER = /^[ \t]*(Company|Position|Applying URL|URL|Job description|Description)[ \t]*:[ \t]*(.*)$/i

const FIELD_FOR = {
  company: 'company',
  position: 'position',
  'applying url': 'url',
  url: 'url',
  'job description': 'description',
  description: 'description',
}

/**
 * Clipboard text -> {company, position, url, description}, all strings.
 *
 * Lenient on purpose. Text that carries none of the labels is treated as a
 * job description, because that is what someone who copied a posting straight
 * off a careers page has on their clipboard — and filling the big field is
 * more useful than refusing the paste.
 */
export function parseJob(text) {
  const out = { company: '', position: '', url: '', description: '' }
  if (typeof text !== 'string' || !text.trim()) return out

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let descriptionFrom = -1
  const seen = new Set()

  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADER.exec(lines[i])
    if (!match) continue
    const field = FIELD_FOR[match[1].toLowerCase()]
    // Only the first of each label counts: a posting that happens to contain
    // "Position: …" halfway down must not overwrite the real one.
    if (!field || seen.has(field)) continue

    if (field === 'description') {
      seen.add(field)
      // Everything after this heading is the description, labels included —
      // a posting is prose and may well contain one.
      descriptionFrom = i + 1
      break
    }
    seen.add(field)
    out[field] = match[2].trim()
  }

  if (descriptionFrom >= 0) {
    out.description = lines.slice(descriptionFrom).join('\n').trim()
  } else if (seen.size === 0) {
    // No labels at all: the whole clipboard is the posting.
    out.description = text.trim()
  }

  return out
}

/** Whether a parse found anything worth filling a form with. */
export const hasJob = (job) =>
  Boolean(job.company || job.position || job.url || job.description)
