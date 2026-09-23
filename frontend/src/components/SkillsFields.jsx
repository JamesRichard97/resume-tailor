import { SKILL_GROUPS, parseSkillList } from '../lib/entries.js'
import styles from './EntryFields.module.css'

/**
 * Four comma-separated groups. Typing stays free-form text; the parsed chips
 * below each field show exactly what will be saved, so the de-duplication and
 * trimming the server does isn't a surprise.
 *
 * Props: value {group: string}, onChange(group, text), disabled.
 */
export default function SkillsFields({ value, onChange, disabled = false }) {
  return (
    <fieldset className={styles.row} disabled={disabled}>
      <legend className={styles.legend}>
        <span>Technical skills</span>
        <span className={styles.hintInline}>Comma-separated</span>
      </legend>

      <div className={styles.grid}>
        {SKILL_GROUPS.map(({ key, label, placeholder }) => {
          const parsed = parseSkillList(value[key] ?? '')
          return (
            <div className={styles.field} key={key}>
              <label className={styles.label} htmlFor={`skills-${key}`}>
                {label}
              </label>
              <input
                id={`skills-${key}`}
                type="text"
                className={styles.input}
                value={value[key] ?? ''}
                placeholder={placeholder}
                onChange={(e) => onChange?.(key, e.target.value)}
              />
              <div className={styles.chips}>
                {parsed.length === 0 ? (
                  <span className={styles.chipsEmpty}>None yet</span>
                ) : (
                  parsed.map((item) => (
                    <span className={styles.chip} key={item}>
                      {item}
                    </span>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}
