import { useEffect, useRef } from 'react'

import styles from './Modal.module.css'

/**
 * Built on the native <dialog> element rather than a hand-rolled overlay:
 * showModal() gives focus trapping, inert background content, Esc-to-close and
 * the top-layer stacking for free — all of which are easy to get subtly wrong
 * by hand.
 *
 * Props:
 *   open        whether the dialog is showing
 *   onClose()   asked to close (Esc, backdrop click, or the × button)
 *   title       heading text
 *   subtitle    optional line under the heading
 *   children    dialog contents — pass a <form> to keep submit working
 */
export default function Modal({ open, onClose, title, subtitle, children }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])

  // <dialog> doesn't lock the page behind it, so a long form would scroll the
  // list underneath.
  useEffect(() => {
    if (!open) return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  const handleCancel = (event) => {
    // Esc fires 'cancel' and would close the dialog without telling React.
    event.preventDefault()
    onClose?.()
  }

  const handleClick = (event) => {
    // A click on the backdrop lands on the <dialog> itself, since the panel
    // covers the rest of its box.
    if (event.target === ref.current) onClose?.()
  }

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      onCancel={handleCancel}
      onClick={handleClick}
      aria-labelledby="modal-title"
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.title} id="modal-title">
              {title}
            </h2>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={() => onClose?.()}
            aria-label="Close"
          >
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path
                d="M5.5 5.5l9 9M14.5 5.5l-9 9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        {children}
      </div>
    </dialog>
  )
}
