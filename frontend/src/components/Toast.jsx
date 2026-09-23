import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

import styles from './Toast.module.css'

const ToastContext = createContext(null)

let seq = 0

/**
 * Minimal toast stack. `useToast()` returns push/dismiss.
 *
 *   const toast = useToast()
 *   toast.error('Title', 'Longer explanation')
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    ({ tone = 'info', title, message, duration }) => {
      const id = ++seq
      setToasts((prev) => [...prev, { id, tone, title, message }])
      // Errors carry a full explanation, so they get longer on screen; a
      // duration of 0 means "stay until dismissed".
      const ms = duration ?? (tone === 'error' ? 9000 : 4500)
      if (ms > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms),
        )
      }
      return id
    },
    [dismiss],
  )

  const api = useMemo(
    () => ({
      push,
      dismiss,
      error: (title, message, opts) =>
        push({ tone: 'error', title, message, ...opts }),
      success: (title, message, opts) =>
        push({ tone: 'success', title, message, ...opts }),
      info: (title, message, opts) => push({ tone: 'info', title, message, ...opts }),
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.viewport} aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`${styles.toast} ${styles[t.tone]}`}
            role={t.tone === 'error' ? 'alert' : 'status'}
          >
            <span className={styles.icon} aria-hidden="true">
              {t.tone === 'error' ? '!' : t.tone === 'success' ? '✓' : 'i'}
            </span>
            <div className={styles.body}>
              {t.title && <p className={styles.title}>{t.title}</p>}
              {t.message && <p className={styles.message}>{t.message}</p>}
            </div>
            <button
              type="button"
              className={styles.close}
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
                <path
                  d="M5.5 5.5l9 9M14.5 5.5l-9 9"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
