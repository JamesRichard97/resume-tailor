import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'rt-theme'

// Dark first: it is the default, and the cycle should start from what you see.
const MODES = ['dark', 'light', 'system']
const DEFAULT_MODE = 'dark'

const media = () =>
  typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

function readStored() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return MODES.includes(value) ? value : DEFAULT_MODE
  } catch {
    // Private mode / blocked storage — the default is still a fine answer.
    return DEFAULT_MODE
  }
}

/**
 * Theme mode is one of 'dark' | 'light' | 'system'; `theme` is the resolved
 * 'light' | 'dark' actually applied to <html data-theme>.
 *
 * Dark is the default: a first-time visitor gets the night sky rather than
 * whatever their OS happens to be set to. Following the OS is still available,
 * it is just no longer what you get by not choosing.
 *
 * index.html applies the stored theme before first paint, so this hook only
 * keeps it in sync — it never causes the initial flash.
 */
export function useTheme() {
  const [mode, setMode] = useState(readStored)
  const [systemDark, setSystemDark] = useState(() => media()?.matches ?? false)

  // Follow the OS while in 'system' mode.
  useEffect(() => {
    const mq = media()
    if (!mq) return undefined
    const onChange = (event) => setSystemDark(event.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const theme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      // Every mode is written, including 'system'. Clearing the key for
      // 'system' would be indistinguishable from never having chosen, and the
      // next load would silently put you back on the dark default.
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // Not being able to persist is not worth breaking the page over.
    }
  }, [mode, theme])

  const cycle = useCallback(() => {
    setMode((prev) => MODES[(MODES.indexOf(prev) + 1) % MODES.length])
  }, [])

  return { mode, theme, setMode, cycle }
}
