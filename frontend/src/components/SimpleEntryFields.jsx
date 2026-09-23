import DateRangeFields from './DateRangeFields.jsx'
import { newEntry, validateDateRange } from '../lib/entries.js'
import styles from './EntryFields.module.css'

/**
 * Repeatable rows of "a date range plus one name" — education (university) and
 * projects (project name) are the same shape, so they share one component.
 *
 * Props:
 *   nameField     the payload key, e.g. 'university' | 'name'
 *   nameLabel     visible label
 *   legendLabel   per-row legend, e.g. 'Education'
 *   addLabel      button text, e.g. '+ Add education'
 *   emptyText     shown when there are no rows
 *   currentLabel  checkbox label, e.g. 'I study here currently'
 *   detailsPlaceholder  hint text for the Details textarea
 */
export default function SimpleEntryFields({
  rows = [],
  errors = {},
  onChange,
  onAdd,
  onRemove,
  disabled = false,
  idPrefix,
  nameField,
  nameLabel,
  namePlaceholder,
  legendLabel,
  addLabel,
  emptyText,
  currentLabel,
  detailsPlaceholder,
}) {
  return (
    <div className={styles.wrap}>
      {rows.length === 0 && <p className={styles.empty}>{emptyText}</p>}

      {rows.map((row, index) => {
        const rowErrors = errors[index] ?? {}
        const key = row._key ?? row.id ?? index
        const fieldKey = `${idPrefix}-${key}`

        return (
          <fieldset className={styles.row} key={key} disabled={disabled}>
            <legend className={styles.legend}>
              <span>
                {legendLabel} {index + 1}
              </span>
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
                currentLabel={currentLabel}
              />

              <div className={`${styles.field} ${styles.full}`}>
                <label className={styles.label} htmlFor={`${fieldKey}-name`}>
                  {nameLabel}
                  <span className={styles.required}>*</span>
                </label>
                <input
                  id={`${fieldKey}-name`}
                  type="text"
                  className={`${styles.input} ${
                    rowErrors[nameField] ? styles.inputError : ''
                  }`}
                  value={row[nameField]}
                  placeholder={namePlaceholder}
                  onChange={(e) => onChange?.(index, nameField, e.target.value)}
                  aria-invalid={rowErrors[nameField] ? 'true' : undefined}
                />
                {rowErrors[nameField] && (
                  <span className={styles.fieldError}>{rowErrors[nameField]}</span>
                )}
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fieldKey}-details`}>
                Details<span className={styles.required}>*</span>
              </label>
              <textarea
                id={`${fieldKey}-details`}
                rows={3}
                className={`${styles.textarea} ${
                  rowErrors.details ? styles.inputError : ''
                }`}
                value={row.details}
                placeholder={detailsPlaceholder}
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
        {addLabel}
      </button>
    </div>
  )
}

export const newSimpleEntry = (nameField) =>
  newEntry({ [nameField]: '', details: '' })

/** Factory: validator for one of these sections. */
export const makeSimpleValidator = (nameField, message, currentLabel) => (rows) => {
  const errors = {}
  rows.forEach((row, index) => {
    const rowErrors = {}
    if (!String(row[nameField] ?? '').trim()) rowErrors[nameField] = message
    if (!String(row.details ?? '').trim()) rowErrors.details = 'Details are required.'
    validateDateRange(row, rowErrors, currentLabel)
    if (Object.keys(rowErrors).length > 0) errors[index] = rowErrors
  })
  return errors
}

export const validateEducation = makeSimpleValidator(
  'university',
  'University name is required.',
  'ongoing study',
)

export const validateProjects = makeSimpleValidator(
  'name',
  'Project name is required.',
  'an ongoing project',
)
