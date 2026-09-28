import { SKILLS_PLACEHOLDER, parseSkillList } from '../lib/entries.js'
import styles from './EntryFields.module.css'

/**
 * One comma-separated list. Typing stays free-form text; the parsed chips
 * below show exactly what will be saved, so the de-duplication and trimming
 * the server does isn't a surprise.
 *
 * Skills used to be split across Languages / Frameworks / Developer tools /
 * Libraries. They are one list now: a screener matches the strings, not the
 * heading above them, and deciding which box "CI/CD" or "machine learning"
 * belonged in was a question with no useful answer.
 *
 * Props: value (string), onChange(text), disabled.
 */
export default function SkillsFields({ value, onChange, disabled = false }) {
  const parsed = parseSkillList(value ?? '')

  return (
    <fieldset className={styles.row} disabled={disabled}>
      {/* The section above already says "Technical skills"; repeating it here
          was noise once the four group boxes became one. The legend carries
          the instruction instead. */}
      <legend className={styles.legend}>
        <span>Everything you work with</span>
        <span className={styles.hintInline}>Comma-separated</span>
      </legend>

      <div className={styles.field}>
        <label className={styles.srOnly} htmlFor="skills-all">
          Technical skills, comma-separated
        </label>
        {/* A textarea rather than an input: this is one long line now, and a
            single-line field would hide most of it behind the cursor. */}
        <textarea
          id="skills-all"
          className={styles.input}
          rows={3}
          value={value ?? ''}
          placeholder={SKILLS_PLACEHOLDER}
          onChange={(e) => onChange?.(e.target.value)}
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
    </fieldset>
  )
}
