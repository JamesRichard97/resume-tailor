import { PAGE_SIZES } from '../hooks/usePagination.js'
import styles from './Pagination.module.css'

/**
 * Page numbers with the current page always in the middle where possible, and
 * ellipses standing in for the rest. Beyond about seven buttons the row stops
 * being scannable and starts being a wall of digits.
 */
function pageList(page, pageCount) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1)
  }
  const pages = new Set([1, pageCount, page, page - 1, page + 1])
  // Keep the row a stable width near the ends, so the buttons don't shuffle
  // under the cursor as you step through.
  if (page <= 3) [2, 3, 4].forEach((n) => pages.add(n))
  if (page >= pageCount - 2) {
    [pageCount - 3, pageCount - 2, pageCount - 1].forEach((n) => pages.add(n))
  }

  const sorted = [...pages].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)
  const out = []
  let previous = 0
  for (const n of sorted) {
    if (n - previous > 1) out.push(`gap-${n}`)
    out.push(n)
    previous = n
  }
  return out
}

export default function Pagination({ pagination, label = 'rows', id }) {
  const { page, pageCount, size, total, from, to, setPage, setSize, canPrev, canNext } =
    pagination

  // One page that fits comfortably needs no controls at all — but the page-size
  // select stays, because it is how you get back to a smaller page.
  const showPages = pageCount > 1

  return (
    <div className={styles.bar}>
      <p className={styles.count}>
        {total === 0 ? (
          `No ${label}`
        ) : (
          <>
            Showing <strong>{from}–{to}</strong> of {total} {label}
          </>
        )}
      </p>

      <div className={styles.controls}>
        <label className={styles.sizeLabel} htmlFor={`${id}-size`}>
          Rows
          <select
            id={`${id}-size`}
            className={styles.size}
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        {showPages && (
          <nav className={styles.pages} aria-label="Pagination">
            <button
              type="button"
              className={styles.step}
              onClick={() => setPage(page - 1)}
              disabled={!canPrev}
              aria-label="Previous page"
            >
              ‹
            </button>

            {pageList(page, pageCount).map((entry) =>
              typeof entry === 'number' ? (
                <button
                  key={entry}
                  type="button"
                  className={`${styles.page} ${entry === page ? styles.current : ''}`}
                  onClick={() => setPage(entry)}
                  aria-label={`Page ${entry}`}
                  aria-current={entry === page ? 'page' : undefined}
                >
                  {entry}
                </button>
              ) : (
                <span key={entry} className={styles.gap} aria-hidden="true">
                  …
                </span>
              ),
            )}

            <button
              type="button"
              className={styles.step}
              onClick={() => setPage(page + 1)}
              disabled={!canNext}
              aria-label="Next page"
            >
              ›
            </button>
          </nav>
        )}
      </div>
    </div>
  )
}
