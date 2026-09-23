import { useId, useLayoutEffect, useRef, useState } from 'react'

import styles from './ClampedText.module.css'

/**
 * A block of text cut off after `lines` lines with an ellipsis, plus a
 * Show more / Show less toggle.
 *
 * The ellipsis comes from `-webkit-line-clamp` rather than from slicing the
 * string: CSS knows the column width, the font and the current text-size
 * setting, so it cuts at the real end of the third line instead of at a
 * character count guessed in JS — which would truncate early on a wide column
 * and still overflow on a narrow one.
 *
 * The toggle only appears when the text genuinely does not fit. Rendering it
 * next to two short lines would be noise, and "Show more" that reveals nothing
 * is worse than noise.
 */
export default function ClampedText({ text, lines = 3, className = '' }) {
  const ref = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const id = useId()

  // Read by the measure callback below, which must not re-subscribe whenever
  // this flips.
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined

    const measure = () => {
      // Only meaningful while clamped: expanded, the element is its own full
      // height, so scrollHeight === clientHeight would read as "it fits" and
      // take the Show less button away mid-read.
      if (expandedRef.current) return
      setOverflowing(el.scrollHeight - el.clientHeight > 1)
    }

    measure()

    // Catches the column resizing, the window resizing, and the header's
    // text-size control — all of which change how much fits in three lines.
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, lines])

  if (!text) return null

  return (
    <div className={styles.wrap}>
      <p
        id={id}
        ref={ref}
        className={`${expanded ? styles.full : styles.clamped} ${className}`}
        style={expanded ? undefined : { '--clamp-lines': lines }}
        // The full text on hover, so a short read does not need the toggle.
        title={!expanded && overflowing ? text : undefined}
      >
        {text}
      </p>

      {overflowing && (
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={id}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
