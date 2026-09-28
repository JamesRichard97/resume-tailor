import { useEffect, useRef, useState } from 'react'

import styles from './CopyButton.module.css'

/**
 * Copies one value to the clipboard and says so for a moment.
 *
 * Built for table cells, where the text is truncated and selecting it by hand
 * means dragging across an ellipsis and getting half of it. The button copies
 * the whole value, not what happens to be visible.
 *
 * Props:
 *   value   the text to copy; the button hides itself when there is none
 *   label   what it is, for the tooltip and for screen readers ("company")
 */
export default function CopyButton({ value, label }) {
  const [state, setState] = useState('idle') // idle | copied | failed
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!value) return null

  const flash = (next) => {
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1600)
  }

  const copy = async (event) => {
    // The cell may sit inside a link or a sortable row; copying is the whole
    // of this click.
    event.preventDefault()
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      flash('copied')
    } catch {
      // Firefox without permission, an insecure origin, an embedded webview —
      // the old selection trick still works in all of them.
      try {
        const scratch = document.createElement('textarea')
        scratch.value = value
        scratch.setAttribute('readonly', '')
        scratch.style.position = 'fixed'
        scratch.style.opacity = '0'
        document.body.appendChild(scratch)
        scratch.select()
        const ok = document.execCommand('copy')
        scratch.remove()
        flash(ok ? 'copied' : 'failed')
      } catch {
        flash('failed')
      }
    }
  }

  const title =
    state === 'copied'
      ? `Copied the ${label}`
      : state === 'failed'
        ? 'Could not copy \u2014 your browser blocked it'
        : `Copy ${label}`

  return (
    <button
      type="button"
      className={`${styles.copy} ${state !== 'idle' ? styles.flash : ''}`}
      onClick={copy}
      title={title}
      // Deliberately constant. A name that changes to "Copied" leaves a
      // screen-reader user with a button that no longer says what it copies,
      // and anything holding a reference to it by name — a test, a browser
      // extension — loses it for as long as the tick shows. The outcome is
      // announced by the live region below instead.
      aria-label={`Copy ${label}`}
    >
      {state === 'copied' ? (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : state === 'failed' ? (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        /* Two offset sheets — the usual copy mark, drawn rather than pulled
           from an icon font so it inherits the text colour in both themes. */
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect
            x="5.25"
            y="5.25"
            width="8"
            height="8"
            rx="1.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M10.75 2.75H4.35c-.88 0-1.6.72-1.6 1.6v6.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      )}
      {/* Announced once, when it changes. Empty the rest of the time so it
          says nothing on the way past. */}
      <span className={styles.srOnly} role="status" aria-live="polite">
        {state === 'idle' ? '' : title}
      </span>
    </button>
  )
}
