import { useCallback, useEffect, useMemo, useState } from 'react'

import { api } from '../api/client.js'
import Pagination from '../components/Pagination.jsx'
import { usePagination } from '../hooks/usePagination.js'
import styles from './RegistryPage.module.css'

// Every column can be sorted. `get` returns the value to compare; strings are
// compared with localeCompare so accented names land where a person expects.
const COLUMNS = [
  { key: 'applied_at', label: 'Applied', type: 'date', get: (r) => r.applied_at ?? '' },
  { key: 'full_name', label: 'User name', get: (r) => r.full_name },
  { key: 'company', label: 'Company', get: (r) => r.company },
  { key: 'position', label: 'Position', get: (r) => r.position },
  { key: 'url', label: 'Applying URL', get: (r) => shortUrl(r.url) },
  { key: 'resume_name', label: 'Resume name', get: (r) => r.resume_name },
  { key: 'job_description', label: 'Job description', get: (r) => r.job_description },
]

// Header cells share a class with their body cells so a breakpoint can hide
// both at once.
const CELL_CLASS = {
  applied_at: 'cellWhen',
  company: 'cellCompany',
  position: 'cellPosition',
  url: 'cellUrl',
  resume_name: 'cellResume',
  job_description: 'cellJob',
}

/** `https://ssense.com/careers/1234/` -> `ssense.com/careers/1234`. The scheme
 *  is the same on every row, so showing it only costs column width. */
function shortUrl(url) {
  if (!url) return ''
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

function compare(a, b, column) {
  const left = column.get(a) ?? ''
  const right = column.get(b) ?? ''
  // ISO timestamps sort correctly as plain text, so dates need no parsing.
  if (column.type === 'date') return left < right ? -1 : left > right ? 1 : 0
  return String(left).localeCompare(String(right), undefined, {
    sensitivity: 'base',
    numeric: true,
  })
}

/** ISO timestamp -> the local calendar day, as the date inputs spell it. */
function localDay(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `2026-09-22 19:12`, in local time. Compact enough to fit the column
 *  without truncating, unambiguous in any locale, and it matches the shape of
 *  the timestamp in the .docx filename. */
function formatWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${localDay(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const EMPTY_FILTERS = { user: '', company: '', from: '', to: '' }

export default function RegistryPage() {
  const [entries, setEntries] = useState([])
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [error, setError] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [sort, setSort] = useState({ key: 'applied_at', dir: 'desc' })
  const [expanded, setExpanded] = useState(null)

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      setEntries(await api.registry.list())
      setStatus('ready')
    } catch (err) {
      setError(err.message)
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Distinct names, for the select. Built from the data rather than the user
  // list so the filter only ever offers names that actually appear here.
  const names = useMemo(
    () =>
      [...new Set(entries.map((e) => e.full_name).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [entries],
  )

  const visible = useMemo(() => {
    const company = filters.company.trim().toLowerCase()

    const filtered = entries.filter((e) => {
      if (filters.user && e.full_name !== filters.user) return false
      if (company && !(e.company ?? '').toLowerCase().includes(company)) return false
      const day = localDay(e.applied_at)
      if (filters.from && day < filters.from) return false
      if (filters.to && day > filters.to) return false
      return true
    })

    const column = COLUMNS.find((c) => c.key === sort.key) ?? COLUMNS[0]
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => compare(a, b, column) * factor)
  }, [entries, filters, sort])

  // Paginates what the filters and the sort have already decided, and returns
  // to page 1 whenever the filters change — page 4 of a two-page result is an
  // empty table.
  const pagination = usePagination(visible, {
    resetKey: `${filters.user}|${filters.company}|${filters.from}|${filters.to}|${sort.key}|${sort.dir}`,
  })

  const toggleSort = (key) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : // Dates start newest-first; text starts A-Z.
          { key, dir: key === 'applied_at' ? 'desc' : 'asc' },
    )

  const setFilter = (key) => (event) =>
    setFilters((prev) => ({ ...prev, [key]: event.target.value }))

  const isFiltered = Object.values(filters).some(Boolean)

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <h1>Application registry</h1>
        <p className={styles.lede}>
          One row for every resume you have downloaded — who it was for, which job,
          and when.
        </p>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            Applications
            <span className={styles.count}>
              {isFiltered ? `${visible.length} of ${entries.length}` : entries.length}
            </span>
          </h2>
          <button type="button" className={styles.ghost} onClick={load}>
            Refresh
          </button>
        </div>

        <div className={styles.filters}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="reg-user">
              User name
            </label>
            <select
              id="reg-user"
              className={styles.input}
              value={filters.user}
              onChange={setFilter('user')}
            >
              <option value="">All users</option>
              {names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="reg-company">
              Company name
            </label>
            <input
              id="reg-company"
              className={styles.input}
              type="search"
              placeholder="Search company"
              value={filters.company}
              onChange={setFilter('company')}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="reg-from">
              Applied from
            </label>
            <input
              id="reg-from"
              className={styles.input}
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={setFilter('from')}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="reg-to">
              Applied to
            </label>
            <input
              id="reg-to"
              className={styles.input}
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={setFilter('to')}
            />
          </div>

          <button
            type="button"
            className={styles.clear}
            onClick={() => setFilters(EMPTY_FILTERS)}
            disabled={!isFiltered}
          >
            Clear filters
          </button>
        </div>

        {status === 'error' && (
          <p className={styles.errorState}>{error}</p>
        )}

        {status === 'loading' && <p className={styles.state}>Loading…</p>}

        {status === 'ready' && entries.length === 0 && (
          <div className={styles.emptyBox}>
            <span className={styles.emptyTitle}>Nothing here yet</span>
            <p className={styles.emptyText}>
              A row is added each time you download a tailored or humanized resume.
            </p>
          </div>
        )}

        {status === 'ready' && entries.length > 0 && (
          <>
            <div className={styles.scroll}>
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.colWhen} />
                  <col className={styles.colUser} />
                  <col className={styles.colCompany} />
                  <col className={styles.colPosition} />
                  <col className={styles.colUrl} />
                  <col className={styles.colResume} />
                  <col className={styles.colJob} />
                </colgroup>

                <thead>
                  <tr>
                    {COLUMNS.map((column) => {
                      const active = sort.key === column.key
                      return (
                        <th
                          key={column.key}
                          scope="col"
                          className={styles[CELL_CLASS[column.key] ?? '']}
                          aria-sort={
                            active
                              ? sort.dir === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          <button
                            type="button"
                            className={`${styles.sortButton} ${
                              active ? styles.sortActive : ''
                            }`}
                            onClick={() => toggleSort(column.key)}
                          >
                            {column.label}
                            <span className={styles.arrow} aria-hidden="true">
                              {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                            </span>
                          </button>
                        </th>
                      )
                    })}
                  </tr>
                </thead>

                <tbody>
                  {pagination.items.length === 0 && (
                    <tr>
                      <td colSpan={7} className={styles.state}>
                        No applications match these filters.
                      </td>
                    </tr>
                  )}

                  {pagination.items.map((entry) => {
                    const open = expanded === entry.id
                    return [
                      <tr
                        key={entry.id}
                        className={open ? styles.rowOpen : undefined}
                      >
                        <td className={styles.cellWhen}>
                          <div className={styles.whenCell}>
                            <button
                              type="button"
                              className={styles.toggle}
                              aria-expanded={open}
                              aria-label={open ? 'Hide details' : 'Show details'}
                              onClick={() => setExpanded(open ? null : entry.id)}
                            >
                              <span className={open ? styles.chevronOpen : styles.chevron}>
                                ›
                              </span>
                            </button>
                            <span
                              className={styles.truncate}
                              title={formatWhen(entry.applied_at)}
                            >
                              {formatWhen(entry.applied_at)}
                            </span>
                          </div>
                        </td>
                        <td className={styles.truncate} title={entry.full_name}>
                          {entry.full_name || '—'}
                        </td>
                        <td className={styles.truncate} title={entry.company}>
                          {entry.company || '—'}
                        </td>
                        <td
                          className={`${styles.truncate} ${styles.cellPosition}`}
                          title={entry.position}
                        >
                          {entry.position || '—'}
                        </td>
                        <td className={styles.cellUrl}>
                          {entry.url ? (
                            <a
                              className={`${styles.link} ${styles.urlLink}`}
                              href={entry.url}
                              target="_blank"
                              rel="noreferrer"
                              title={entry.url}
                            >
                              <span className={styles.truncate}>
                                {shortUrl(entry.url)}
                              </span>
                              <span className={styles.external} aria-hidden="true">
                                ↗
                              </span>
                            </a>
                          ) : (
                            <span className={styles.muted}>—</span>
                          )}
                        </td>
                        <td
                          className={`${styles.truncate} ${styles.mono} ${styles.cellResume}`}
                          title={entry.resume_name}
                        >
                          {entry.resume_name || '—'}
                        </td>
                        <td
                          className={`${styles.truncate} ${styles.muted} ${styles.cellJob}`}
                          title={entry.job_description}
                        >
                          {entry.job_description || '—'}
                        </td>
                      </tr>,
                      open && (
                        <tr key={`${entry.id}-detail`} className={styles.detailRow}>
                          {/* The filename in full — the column truncates it,
                              and the whole point of the name is the parts at
                              the end — then the job description. */}
                          <td colSpan={7}>
                            <div className={styles.detail}>
                              <div className={styles.detailBlock}>
                                <span className={styles.detailLabel}>
                                  Resume name
                                </span>
                                <p className={styles.resumeName}>
                                  {entry.resume_name || '—'}
                                </p>
                              </div>

                              <div className={styles.detailBlock}>
                                <span className={styles.detailLabel}>
                                  Job description
                                </span>
                                <p className={styles.description}>
                                  {entry.job_description || 'No job description was saved for this download.'}
                                </p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ),
                    ]
                  })}
                </tbody>
              </table>
            </div>
            <Pagination pagination={pagination} label="applications" id="registry" />

            <p className={styles.footnote}>
              Click any column heading to sort, or a row’s arrow to see the full job
              description.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
