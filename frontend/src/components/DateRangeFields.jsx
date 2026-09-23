import styles from './EntryFields.module.css'

/**
 * The From / To / "still ongoing" trio shared by experience, education and
 * projects. Ticking the checkbox disables the To field; the server clears
 * end_date for an ongoing entry regardless of what the client sends.
 */
export default function DateRangeFields({
  row,
  rowErrors = {},
  index,
  onChange,
  fieldKey,
  currentLabel = 'I currently work here',
}) {
  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${fieldKey}-start`}>
          From<span className={styles.required}>*</span>
        </label>
        <input
          id={`${fieldKey}-start`}
          type="month"
          className={`${styles.input} ${
            rowErrors.start_date ? styles.inputError : ''
          }`}
          value={row.start_date}
          onChange={(e) => onChange?.(index, 'start_date', e.target.value)}
          aria-invalid={rowErrors.start_date ? 'true' : undefined}
        />
        {rowErrors.start_date && (
          <span className={styles.fieldError}>{rowErrors.start_date}</span>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${fieldKey}-end`}>
          To<span className={styles.required}>*</span>
        </label>
        <input
          id={`${fieldKey}-end`}
          type="month"
          className={`${styles.input} ${rowErrors.end_date ? styles.inputError : ''}`}
          value={row.is_current ? '' : row.end_date}
          disabled={row.is_current}
          onChange={(e) => onChange?.(index, 'end_date', e.target.value)}
          aria-invalid={rowErrors.end_date ? 'true' : undefined}
        />
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={row.is_current}
            onChange={(e) => onChange?.(index, 'is_current', e.target.checked)}
          />
          {currentLabel}
        </label>
        {rowErrors.end_date && (
          <span className={styles.fieldError}>{rowErrors.end_date}</span>
        )}
      </div>
    </>
  )
}
