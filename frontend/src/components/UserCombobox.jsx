import { useEffect, useId, useMemo, useRef, useState } from 'react'

import styles from './UserCombobox.module.css'

/**
 * Searchable single-select combobox for users.
 *
 * Props:
 *   users        Array<{ id, full_name, email, headline? }>
 *   value        selected user id (or null)
 *   onChange(id) called with the new id, or null when cleared
 *   loading      show a loading hint in the listbox
 *   disabled
 *   placeholder
 */
export default function UserCombobox({
  users = [],
  value = null,
  onChange,
  loading = false,
  disabled = false,
  placeholder = 'Search or select a user…',
  id,
}) {
  const generatedId = useId()
  const baseId = id ?? generatedId
  const listboxId = `${baseId}-listbox`

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)

  const rootRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const selected = useMemo(
    () => users.find((u) => u.id === value) ?? null,
    [users, value],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return users
    return users.filter(
      (u) =>
        u.full_name.toLowerCase().includes(needle) ||
        (u.email ?? '').toLowerCase().includes(needle) ||
        (u.linkedin_url ?? '').toLowerCase().includes(needle),
    )
  }, [users, query])

  // While closed, the input mirrors the selected user's name.
  const inputValue = open ? query : selected?.full_name ?? ''

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const node = listRef.current?.children?.[activeIndex]
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const openList = () => {
    if (disabled) return
    setOpen(true)
    setQuery('')
    const index = filtered.findIndex((u) => u.id === value)
    setActiveIndex(index)
  }

  const closeList = () => {
    setOpen(false)
    setQuery('')
    setActiveIndex(-1)
  }

  const commit = (user) => {
    onChange?.(user ? user.id : null)
    closeList()
    inputRef.current?.focus()
  }

  const handleKeyDown = (event) => {
    if (disabled) return

    if (!open && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
      event.preventDefault()
      openList()
      return
    }
    if (!open) return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : -1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((i) =>
          filtered.length ? (i - 1 + filtered.length) % filtered.length : -1,
        )
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(filtered.length ? 0 : -1)
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(filtered.length - 1)
        break
      case 'Enter':
        event.preventDefault()
        if (activeIndex >= 0 && filtered[activeIndex]) commit(filtered[activeIndex])
        break
      case 'Escape':
        event.preventDefault()
        closeList()
        break
      case 'Tab':
        closeList()
        break
      default:
        break
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <div
        className={`${styles.control} ${open ? styles.controlOpen : ''} ${
          disabled ? styles.controlDisabled : ''
        }`}
      >
        <input
          ref={inputRef}
          id={baseId}
          className={styles.input}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck="false"
          disabled={disabled}
          placeholder={selected && !open ? selected.full_name : placeholder}
          value={inputValue}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIndex >= 0 && filtered[activeIndex]
              ? `${baseId}-opt-${filtered[activeIndex].id}`
              : undefined
          }
          onChange={(event) => {
            if (!open) setOpen(true)
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          onFocus={() => !open && openList()}
          onKeyDown={handleKeyDown}
        />

        {selected && !disabled && (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear selection"
            onClick={() => commit(null)}
          >
            ×
          </button>
        )}

        <button
          type="button"
          className={styles.toggle}
          tabIndex={-1}
          aria-label={open ? 'Close list' : 'Open list'}
          disabled={disabled}
          onClick={() => (open ? closeList() : openList())}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M3.5 6 8 10.5 12.5 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {open && (
        <ul className={styles.listbox} id={listboxId} role="listbox" ref={listRef}>
          {loading && <li className={styles.empty}>Loading users…</li>}

          {!loading && filtered.length === 0 && (
            <li className={styles.empty}>
              {users.length === 0
                ? 'No users registered yet.'
                : `No match for “${query}”.`}
            </li>
          )}

          {!loading &&
            filtered.map((user, index) => {
              const isActive = index === activeIndex
              const isSelected = user.id === value
              // Rows written before a field existed come back incomplete.
              const meta = user.email ?? 'No email on file'
              return (
                <li
                  key={user.id}
                  id={`${baseId}-opt-${user.id}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`${styles.option} ${isActive ? styles.optionActive : ''} ${
                    isSelected ? styles.optionSelected : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commit(user)}
                >
                  <span className={styles.optionName}>
                    {user.full_name}
                    {user.is_complete === false && (
                      <span className={styles.badge}>Incomplete</span>
                    )}
                  </span>
                  {meta && <span className={styles.optionMeta}>{meta}</span>}
                </li>
              )
            })}
        </ul>
      )}
    </div>
  )
}
