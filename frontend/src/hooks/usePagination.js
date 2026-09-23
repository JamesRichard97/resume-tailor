import { useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'rt-page-size'

export const PAGE_SIZES = [10, 15, 20]
export const DEFAULT_PAGE_SIZE = 15

function readStored() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY))
    return PAGE_SIZES.includes(value) ? value : DEFAULT_PAGE_SIZE
  } catch {
    return DEFAULT_PAGE_SIZE
  }
}

/**
 * Client-side pagination over an array that is already filtered and sorted.
 *
 * Client-side on purpose: both tables sort and filter in the browser over the
 * whole set, and server-side paging would quietly break that — sorting by
 * Company would only reorder the fifteen rows you happen to be looking at,
 * which is worse than useless because it looks like it worked.
 *
 * `resetKey` is anything that changes the meaning of the list — a filter, a
 * search term. When it changes the view returns to page 1, because staying on
 * page 4 of a result set that just became 2 pages long shows an empty table.
 */
export function usePagination(items, { resetKey = '' } = {}) {
  const [size, setSize] = useState(readStored)
  const [page, setPage] = useState(1)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(size))
    } catch {
      // Not remembering the choice is no reason to ignore it now.
    }
  }, [size])

  useEffect(() => {
    setPage(1)
  }, [resetKey])

  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / size))

  // Clamp rather than clear: deleting the last row on the last page should
  // land you on the new last page, not on an empty one.
  const current = Math.min(page, pageCount)
  useEffect(() => {
    if (page !== current) setPage(current)
  }, [page, current])

  const start = (current - 1) * size
  const slice = useMemo(
    () => items.slice(start, start + size),
    [items, start, size],
  )

  return {
    items: slice,
    page: current,
    pageCount,
    size,
    total,
    // 1-based, inclusive, for "Showing 1–15 of 42". Zero when there is nothing.
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + size, total),
    setPage,
    setSize: (next) => {
      // Keep the first visible row visible when the page size changes, so the
      // list does not jump somewhere unrelated.
      const anchor = start
      setSize(next)
      setPage(Math.floor(anchor / next) + 1)
    },
    canPrev: current > 1,
    canNext: current < pageCount,
  }
}
