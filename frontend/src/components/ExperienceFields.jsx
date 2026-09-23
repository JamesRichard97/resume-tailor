import DateRangeFields from './DateRangeFields.jsx'
import { newEntry, validateDateRange } from '../lib/entries.js'
import styles from './EntryFields.module.css'

export const newExperience = () =>
  newEntry({ position: '', company: '', details: '' })

/** Mirrors the server's per-entry rules. Returns {index: {field: message}}. */
export function validateExperiences(rows) {
  const errors = {}

  rows.forEach((row, index) => {
    const rowErrors = {}

    if (!row.position.trim()) rowErrors.position = 'Position is required.'
    if (!row.company.trim()) rowErrors.company = 'Company is required.'
    if (!row.details.trim()) rowErrors.details = 'Details are required.'

    validateDateRange(row, rowErrors, 'the current role')

    if (Object.keys(rowErrors).length > 0) errors[index] = rowErrors
  })

  return errors
}

/**
 * Repeatable experience rows.
 *
 * Props: rows, errors {index: {field: msg}}, onChange(index, field, value),
 * onAdd(), onRemove(index), disabled.
 */
export default function ExperienceFields({
  rows = [],
  errors = {},
  onChange,
  onAdd,
  onRemove,
  disabled = false,
}) {
  return (
    <div className={styles.wrap}>
      {rows.length === 0 && (
        <p className={styles.empty}>
          No experience added yet. Use <strong>Add experience</strong> below.
        </p>
      )}

      {rows.map((row, index) => {
        const rowErrors = errors[index] ?? {}
        const key = row._key ?? row.id ?? index
        const fieldKey = `exp-${key}`

        return (
          <fieldset className={styles.row} key={key} disabled={disabled}>
            <legend className={styles.legend}>
              <span>Experience {index + 1}</span>
              <button
                type="button"
                className={styles.remove}
                onClick={() => onRemove?.(index)}
              >
                Remove
              </button>
            </legend>

            <div className={styles.grid}>
              <DateRangeFields
                row={row}
                rowErrors={rowErrors}
                index={index}
                onChange={onChange}
                fieldKey={fieldKey}
                currentLabel="I currently work here"
              />

              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${fieldKey}-position`}>
                  Position<span className={styles.required}>*</span>
                </label>
                <input
                  id={`${fieldKey}-position`}
                  type="text"
                  className={`${styles.input} ${
                    rowErrors.position ? styles.inputError : ''
                  }`}
                  value={row.position}
                  placeholder="Senior Software Engineer"
                  onChange={(e) => onChange?.(index, 'position', e.target.value)}
                  aria-invalid={rowErrors.position ? 'true' : undefined}
                />
                {rowErrors.position && (
                  <span className={styles.fieldError}>{rowErrors.position}</span>
                )}
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${fieldKey}-company`}>
                  Company<span className={styles.required}>*</span>
                </label>
                <input
                  id={`${fieldKey}-company`}
                  type="text"
                  className={`${styles.input} ${
                    rowErrors.company ? styles.inputError : ''
                  }`}
                  value={row.company}
                  placeholder="SSENSE"
                  onChange={(e) => onChange?.(index, 'company', e.target.value)}
                  aria-invalid={rowErrors.company ? 'true' : undefined}
                />
                {rowErrors.company && (
                  <span className={styles.fieldError}>{rowErrors.company}</span>
                )}
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fieldKey}-details`}>
                Details<span className={styles.required}>*</span>
              </label>
              <textarea
                id={`${fieldKey}-details`}
                rows={4}
                className={`${styles.textarea} ${
                  rowErrors.details ? styles.inputError : ''
                }`}
                value={row.details}
                placeholder="What you owned, what you shipped, the impact — one bullet per line."
                onChange={(e) => onChange?.(index, 'details', e.target.value)}
                aria-invalid={rowErrors.details ? 'true' : undefined}
              />
              {rowErrors.details && (
                <span className={styles.fieldError}>{rowErrors.details}</span>
              )}
            </div>
          </fieldset>
        )
      })}

      <button type="button" className={styles.add} onClick={() => onAdd?.()}>
        + Add experience
      </button>
    </div>
  )
}
