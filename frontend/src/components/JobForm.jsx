import { useEffect, useRef, useState } from 'react'

import { hasJob, parseJob } from '../lib/jobClipboard.js'
import styles from './JobForm.module.css'

export const EMPTY_JOB = {
  company: '',
  position: '',
  url: '',
  description: '',
}

const URL_RE = /^https?:\/\/.+\..+/i

/** Mirrors the field rules below. Returns {field: message}. */
export function validateJob(job) {
  const errors = {}

  if (!job.company.trim()) errors.company = 'Company name is required.'
  if (!job.position.trim()) errors.position = 'Position name is required.'

  // Optional — plenty of applications arrive by referral or email with no link.
  if (job.url.trim() && !URL_RE.test(job.url.trim())) {
    errors.url = 'Enter a full URL, starting with http:// or https://'
  }

  if (!job.description.trim()) {
    errors.description = 'Job description is required.'
  } else if (job.description.trim().length < 40) {
    errors.description = 'Paste a bit more — this is what the resume is tailored against.'
  }

  return errors
}

/**
 * The role being applied to.
 *
 * Props: value, errors, onChange(field, value), onSubmit(event), disabled,
 *        onPasted(job) — optional, told what the clipboard filled in,
 *        timeout — seconds the server gives one request, for the counter.
 */
/** The long form, for the tooltip — the short label has no room to say that
 *  "sent" is the prompt and "back" is what the model wrote. */
function usageTitle(usage) {
  const parts = [
    `${usage.prompt_tokens.toLocaleString()} tokens sent to the model`,
    `${usage.completion_tokens.toLocaleString()} tokens written back`,
  ]
  if (usage.calls > 1) {
    parts.push(`across ${usage.calls} calls (LLM_REFINE is on)`)
  }
  return parts.join(', ')
}

export default function JobForm({
  value,
  errors = {},
  onChange,
  onSubmit,
  disabled,
  busy = false,
  onPasted,
  timeout,
  usage,
  phase,
}) {
  const words = value.description.trim()
    ? value.description.trim().split(/\s+/).length
    : 0

  const [pasteError, setPasteError] = useState('')

  // Seconds since Generate was pressed. Measured from a timestamp rather than
  // counted up by the interval, so a throttled background tab reports the real
  // elapsed time instead of however many ticks the browser allowed.
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(0)

  useEffect(() => {
    if (!busy) {
      setElapsed(0)
      return undefined
    }
    startedAt.current = Date.now()
    setElapsed(0)
    const id = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)),
      250,
    )
    return () => clearInterval(id)
  }, [busy])

  const limit = Number(timeout) > 0 ? Math.round(Number(timeout)) : null
  // Past the limit the request has not necessarily failed: generation can be
  // followed by a second, smaller call, and each gets its own budget. Saying
  // "over" is honest; a bar stuck at 100% claiming to still be counting is not.
  const over = limit !== null && elapsed > limit
  const fraction = limit ? Math.min(elapsed / limit, 1) : 0

  /** Fills the form from the clipboard — a row copied on the registry page,
   *  or a posting copied straight off a careers page. */
  const pasteFromClipboard = async () => {
    setPasteError('')
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      // Reading needs a permission the browser may refuse; writing does not,
      // so this fails where the copy buttons work. Say what to do instead.
      setPasteError(
        'Your browser will not let the page read the clipboard. Click into a field and press Ctrl+V.',
      )
      return
    }

    const job = parseJob(text)
    if (!hasJob(job)) {
      setPasteError('The clipboard is empty, or has nothing that looks like a job.')
      return
    }

    // Only overwrite what the clipboard actually carried: a posting pasted on
    // its own should not blank a company name already typed.
    const filled = []
    ;['company', 'position', 'url', 'description'].forEach((field) => {
      if (job[field]) {
        onChange?.(field, job[field])
        filled.push(field)
      }
    })
    onPasted?.(job, filled)
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <div className={styles.pasteRow}>
        <button
          type="button"
          className={styles.paste}
          onClick={pasteFromClipboard}
          disabled={disabled || busy}
        >
          Paste from clipboard
        </button>
        <span className={styles.pasteHint}>
          Fills these fields from a registry row, or from a posting you copied.
        </span>
      </div>
      {pasteError && <p className={styles.pasteError}>{pasteError}</p>}

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="job-company">
            Company name<span className={styles.required}>*</span>
          </label>
          <input
            id="job-company"
            type="text"
            className={`${styles.input} ${errors.company ? styles.inputError : ''}`}
            value={value.company}
            placeholder="SSENSE"
            autoComplete="organization"
            disabled={disabled}
            onChange={(e) => onChange?.('company', e.target.value)}
            aria-invalid={errors.company ? 'true' : undefined}
          />
          {errors.company && (
            <span className={styles.fieldError}>{errors.company}</span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="job-position">
            Position name<span className={styles.required}>*</span>
          </label>
          <input
            id="job-position"
            type="text"
            className={`${styles.input} ${errors.position ? styles.inputError : ''}`}
            value={value.position}
            placeholder="Senior Software Engineer"
            disabled={disabled}
            onChange={(e) => onChange?.('position', e.target.value)}
            aria-invalid={errors.position ? 'true' : undefined}
          />
          {errors.position && (
            <span className={styles.fieldError}>{errors.position}</span>
          )}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="job-url">
          Applying URL
          <span className={styles.optional}>optional</span>
        </label>
        <input
          id="job-url"
          type="url"
          inputMode="url"
          className={`${styles.input} ${errors.url ? styles.inputError : ''}`}
          value={value.url}
          placeholder="https://jobs.example.com/postings/12345"
          disabled={disabled}
          onChange={(e) => onChange?.('url', e.target.value)}
          aria-invalid={errors.url ? 'true' : undefined}
        />
        {errors.url && <span className={styles.fieldError}>{errors.url}</span>}
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor="job-description">
            Job description<span className={styles.required}>*</span>
          </label>
          {words > 0 && (
            <span className={styles.counter}>
              {words} word{words === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <textarea
          id="job-description"
          rows={10}
          className={`${styles.textarea} ${
            errors.description ? styles.inputError : ''
          }`}
          value={value.description}
          placeholder="Paste the full posting — responsibilities, requirements, nice-to-haves. The more complete it is, the better the match."
          disabled={disabled}
          onChange={(e) => onChange?.('description', e.target.value)}
          aria-invalid={errors.description ? 'true' : undefined}
        />
        {errors.description && (
          <span className={styles.fieldError}>{errors.description}</span>
        )}
      </div>

      <div className={styles.actions}>
        {busy && (
          <div className={styles.timer} role="status" aria-live="off">
            {/* What the server says it is doing right now. Its own line above
                the clock: the clock answers "how long", this answers "at
                what", and stacking them keeps both readable in the narrow
                space beside the button. aria-live is polite rather than off
                on this one, because a phase changing is news; the seconds
                ticking are not. */}
            <span className={styles.phase} aria-live="polite">
              <span className={styles.phaseDot} aria-hidden="true" />
              {phase?.label ?? 'Sending the request'}
              {phase?.terms > 0 && (
                <span className={styles.phaseDetail}>
                  {' '}
                  {phase.terms} {phase.terms === 1 ? 'term' : 'terms'}
                </span>
              )}
            </span>
            <span className={styles.timerText}>
              <span className={styles.timerCount}>{elapsed}s</span>
              {limit !== null && (
                <span className={styles.timerLimit}>
                  {over ? ` \u2014 past the ${limit}s limit` : ` / ${limit}s`}
                </span>
              )}
            </span>
            {limit !== null && (
              <span className={styles.timerTrack}>
                <span
                  className={`${styles.timerFill} ${over ? styles.timerOver : ''}`}
                  style={{ width: `${fraction * 100}%` }}
                />
              </span>
            )}
          </div>
        )}
        {/* What the last generation actually cost, beside the button that
            spends it. Reported by the provider, not estimated here — and only
            when it is idle, so it reads as the result of the run just finished
            rather than a live count of one in progress. */}
        {!busy && usage?.total_tokens > 0 && (
          <span className={styles.usage} title={usageTitle(usage)}>
            {/* One flex item, so the number and its unit stay on one line —
                as two items the column layout would break between them. */}
            <span className={styles.usageLine}>
              <strong className={styles.usageTotal}>
                {usage.total_tokens.toLocaleString()}
              </strong>{' '}
              tokens
            </span>
            <span className={styles.usageSplit}>
              {usage.prompt_tokens.toLocaleString()} sent ·{' '}
              {usage.completion_tokens.toLocaleString()} back
              {usage.calls > 1 && ` · ${usage.calls} calls`}
            </span>
          </span>
        )}
        <button
          type="submit"
          className={styles.primary}
          disabled={disabled || busy}
        >
          {busy && <span className={styles.spinner} aria-hidden="true" />}
          {busy ? 'Generating…' : 'Generate tailored resume'}
        </button>
      </div>
    </form>
  )
}
