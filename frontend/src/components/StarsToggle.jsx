import styles from './ThemeToggle.module.css'

/**
 * Turns the animated background off. An animated background with no way out is
 * an annoyance, not a feature — and it is the first thing anyone reaches for on
 * a laptop running on battery.
 */
export default function StarsToggle({ enabled, onToggle }) {
  const label = enabled ? 'Starfield: on' : 'Starfield: off'

  return (
    <button
      type="button"
      className={styles.button}
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path
          d="M10 2.6l1.5 4.2 4.4 1.4-4.4 1.4L10 13.8 8.5 9.6 4.1 8.2l4.4-1.4L10 2.6Z"
          fill={enabled ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <circle cx="15.6" cy="14.4" r={enabled ? 1.5 : 1.1} fill="currentColor" />
        <circle cx="4.8" cy="14.9" r={enabled ? 1.1 : 0.8} fill="currentColor" />
        {!enabled && (
          // A slash, so "off" reads at a glance instead of needing the tooltip.
          <path
            d="M3.2 16.8L16.8 3.2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        )}
      </svg>
    </button>
  )
}
