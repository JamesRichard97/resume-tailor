import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'rt-font-scale'

/**
 * The available sizes. Multipliers rather than pixel values, because every
 * font-size in the app is `calc(Npx * var(--font-scale))` — one number moves
 * all of them and keeps their relative proportions.
 *
 * Kept to five steps with real names: a slider would invite 1.03, which is not
 * a meaningful difference and would make the app look subtly misaligned.
 */
export const SCALES = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.1, label: 'Large' },
  { value: 1.25, label: 'Larger' },
  { value: 1.4, label: 'Largest' },
]

export const DEFAULT_SCALE = 1

/** Snap an arbitrary number to the nearest step, so a hand-edited or
 *  out-of-date stored value can never produce an off-scale layout. */
export function nearestScale(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SCALE
  return SCALES.reduce(
    (best, s) => (Math.abs(s.value - n) < Math.abs(best - n) ? s.value : best),
    DEFAULT_SCALE,
  )
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? nearestScale(raw) : DEFAULT_SCALE
  } catch {
    // Private mode or blocked storage — the default is a fine answer.
    return DEFAULT_SCALE
  }
}

/**
 * Text size, applied as `--font-scale` on <html>.
 *
 * index.html sets the stored value before first paint, so this hook only keeps
 * it in sync; it never causes a resize flash on load.
 */
export function useFontScale() {
  const [scale, setScale] = useState(readStored)

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(scale))
    try {
      if (scale === DEFAULT_SCALE) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, String(scale))
    } catch {
      // Not being able to remember the choice is not a reason to ignore it.
    }
  }, [scale])

  const index = SCALES.findIndex((s) => s.value === scale)
  const current = SCALES[index] ?? SCALES[1]

  const step = useCallback(
    (direction) =>
      setScale((prev) => {
        const i = SCALES.findIndex((s) => s.value === prev)
        const next = Math.min(SCALES.length - 1, Math.max(0, i + direction))
        return SCALES[next].value
      }),
    [],
  )

  return {
    scale,
    label: current.label,
    percent: Math.round(scale * 100),
    canShrink: index > 0,
    canGrow: index < SCALES.length - 1,
    smaller: () => step(-1),
    larger: () => step(1),
    reset: () => setScale(DEFAULT_SCALE),
    set: (value) => setScale(nearestScale(value)),
  }
}
