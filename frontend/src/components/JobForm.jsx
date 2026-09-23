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
 * Props: value, errors, onChange(field, value), onSubmit(event), disabled.
 */
export default function JobForm({
  value,
  errors = {},
  onChange,
  onSubmit,
  disabled,
  busy = false,
}) {
  const words = value.description.trim()
    ? value.description.trim().split(/\s+/).length
    : 0

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
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
