import { useTheme } from '../hooks/useTheme.js'
import styles from './ThemeToggle.module.css'

const LABEL = {
  system: 'Theme: follow system',
  light: 'Theme: light',
  dark: 'Theme: dark',
}

function Icon({ mode }) {
  if (mode === 'light') {
    return (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="10" cy="10" r="3.6" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M10 2.2v1.6M10 16.2v1.6M17.8 10h-1.6M3.8 10H2.2" />
          <path d="M15.5 4.5l-1.1 1.1M5.6 14.4l-1.1 1.1M15.5 15.5l-1.1-1.1M5.6 5.6L4.5 4.5" />
        </g>
      </svg>
    )
  }

  if (mode === 'dark') {
    return (
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <path
          d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9Z"
          fill="currentColor"
        />
      </svg>
    )
  }

  // system
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect
        x="2.6"
        y="3.6"
        width="14.8"
        height="10"
        rx="1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M7 16.8h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Cycles system -> light -> dark. Defaults to following the OS. */
export default function ThemeToggle() {
  const { mode, cycle } = useTheme()

  return (
    <button
      type="button"
      className={styles.button}
      onClick={cycle}
      title={LABEL[mode]}
      aria-label={LABEL[mode]}
    >
      <Icon mode={mode} />
    </button>
  )
}
