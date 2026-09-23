import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'rt-stars'

function readStored() {
  try {
    // On by default; only an explicit "off" turns it off.
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * Whether the animated starfield is running.
 *
 * Read synchronously on first render rather than in an effect, so someone who
 * turned it off never sees a frame of stars before it disappears again.
 */
export function useStarfield() {
  const [enabled, setEnabled] = useState(readStored)

  useEffect(() => {
    try {
      if (enabled) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, 'off')
    } catch {
      // Not remembering the choice is no reason to ignore it now.
    }
  }, [enabled])

  return { enabled, toggle: useCallback(() => setEnabled((v) => !v), []) }
}
