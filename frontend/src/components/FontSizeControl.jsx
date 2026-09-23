import { useFontScale } from '../hooks/useFontScale.js'
import styles from './FontSizeControl.module.css'

/**
 * Text size: smaller / reset / larger.
 *
 * The middle button shows the current size and resets to Default on click, so
 * getting back is one action rather than however many steps you took. It is
 * only enabled when there is something to reset.
 */
export default function FontSizeControl() {
  const { label, percent, canShrink, canGrow, smaller, larger, reset } =
    useFontScale()

  return (
    <div className={styles.group} role="group" aria-label="Text size">
      <button
        type="button"
        className={styles.button}
        onClick={smaller}
        disabled={!canShrink}
        title="Smaller text"
        aria-label="Smaller text"
      >
        <span className={styles.small} aria-hidden="true">
          A
        </span>
      </button>

      <button
        type="button"
        className={`${styles.button} ${styles.middle}`}
        onClick={reset}
        disabled={percent === 100}
        title={`Text size: ${label} (${percent}%) — click to reset`}
        aria-label={`Text size: ${label}, ${percent} percent. Reset to default.`}
      >
        <span className={styles.percent} aria-hidden="true">
          {percent}%
        </span>
      </button>

      <button
        type="button"
        className={styles.button}
        onClick={larger}
        disabled={!canGrow}
        title="Larger text"
        aria-label="Larger text"
      >
        <span className={styles.large} aria-hidden="true">
          A
        </span>
      </button>

      {/* Announced to screen readers when the size changes; the buttons
          themselves only say what they do, not what happened. */}
      <span className={styles.srOnly} role="status" aria-live="polite">
        Text size {label}, {percent} percent
      </span>
    </div>
  )
}
