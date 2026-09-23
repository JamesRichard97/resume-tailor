import { useState } from 'react'

import Pagination from './Pagination.jsx'
import { usePagination } from '../hooks/usePagination.js'
import styles from './UserTable.module.css'

/**
 * Registered users with row-level edit / delete.
 *
 * Delete is a two-step inline confirm rather than window.confirm — a native
 * modal blocks the page and is awkward to drive from tests.
 *
 * Props:
 *   users       Array<User>
 *   loading     initial fetch in flight
 *   error       fetch error message, if any
 *   editingId   id of the row currently loaded into the form
 *   busyId      id of the row with a delete in flight
 *   onEdit(user)
 *   onDelete(id)
 *   onAdd()      empty-state call to action
 */
const SKILL_KEYS = ['languages', 'frameworks', 'developer_tools', 'libraries']

/** "2 roles · 1 edu · 3 proj · 9 skills", skipping whatever is empty. */
function summarize(user) {
  const skills = SKILL_KEYS.reduce(
    (sum, key) => sum + (user.skills?.[key]?.length ?? 0),
    0,
  )
  const parts = [
    [user.experiences?.length, 'role', 'roles'],
    [user.education?.length, 'edu', 'edu'],
    [user.projects?.length, 'proj', 'proj'],
    [skills, 'skill', 'skills'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  return parts.join(' · ')
}

export default function UserTable({
  users = [],
  loading = false,
  error = null,
  editingId = null,
  busyId = null,
  onEdit,
  onDelete,
  onAdd,
}) {
  const [confirmingId, setConfirmingId] = useState(null)

  // Every hook has to run on every render, so this sits above the early
  // returns below rather than next to the table it feeds.
  const pagination = usePagination(users)

  if (loading) {
    return <p className={styles.state}>Loading users…</p>
  }

  if (error) {
    return <p className={styles.errorState}>{error}</p>
  }

  if (users.length === 0) {
    return (
      <div className={styles.emptyBox}>
        <span className={styles.emptyTitle}>No users yet</span>
        <p className={styles.emptyText}>
          Register someone to see them here and in the tailor page select box.
        </p>
        <button type="button" className={styles.emptyButton} onClick={onAdd}>
          Register user
        </button>
      </div>
    )
  }

  return (
    <>
    <div className={styles.scroll}>
      <table className={styles.table}>
        <caption className={styles.srOnly}>Registered users</caption>
        <colgroup>
          <col className={styles.colUser} />
          <col className={styles.colPhone} />
          <col className={styles.colLink} />
          <col className={styles.colContent} />
          <col className={styles.colActions} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col" className={styles.cellPhone}>
              Phone
            </th>
            <th scope="col" className={styles.cellLink}>
              LinkedIn
            </th>
            <th scope="col">Content</th>
            <th scope="col" className={styles.actionsHead}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {pagination.items.map((user) => {
            const isEditing = user.id === editingId
            const isConfirming = user.id === confirmingId
            const isBusy = user.id === busyId

            return (
              <tr
                key={user.id}
                className={isEditing ? styles.rowEditing : undefined}
              >
                {/* Name and email share a cell: two short values stacked read
                    better than two narrow columns, and it frees the width the
                    other columns need. */}
                <td>
                  <div className={styles.userCell}>
                    <span className={`${styles.name} ${styles.wrap}`}>
                      {user.full_name}
                      {user.is_complete === false && (
                        <span className={styles.badge}>Incomplete</span>
                      )}
                    </span>
                    <span
                      className={`${styles.sub} ${styles.truncate}`}
                      title={user.email ?? undefined}
                    >
                      {user.email ?? '—'}
                    </span>
                  </div>
                </td>
                <td
                  className={`${styles.cellPhone} ${styles.truncate}`}
                  title={user.phone ?? undefined}
                >
                  {user.phone ?? <span className={styles.missing}>—</span>}
                </td>
                <td
                  className={`${styles.cellLink} ${styles.truncate}`}
                  title={user.linkedin_url ?? undefined}
                >
                  {user.linkedin_url ? (
                    <a
                      className={styles.link}
                      href={user.linkedin_url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {user.linkedin_url.replace(/^https?:\/\/(www\.)?/, '')}
                    </a>
                  ) : (
                    <span className={styles.missing}>—</span>
                  )}
                </td>
                <td className={`${styles.content} ${styles.wrap}`}>
                  {summarize(user) || <span className={styles.missing}>—</span>}
                </td>
                <td className={styles.actionsCell}>
                  {isConfirming ? (
                    <div className={styles.actions}>
                      <span className={styles.confirmText}>Delete?</span>
                      <button
                        type="button"
                        className={styles.danger}
                        disabled={isBusy}
                        onClick={async () => {
                          await onDelete?.(user.id)
                          setConfirmingId(null)
                        }}
                      >
                        {isBusy ? 'Deleting…' : 'Yes'}
                      </button>
                      <button
                        type="button"
                        className={styles.ghost}
                        disabled={isBusy}
                        onClick={() => setConfirmingId(null)}
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.ghost}
                        onClick={() => onEdit?.(user)}
                      >
                        {isEditing ? 'Editing' : 'Edit'}
                      </button>
                      <button
                        type="button"
                        className={styles.ghost}
                        onClick={() => setConfirmingId(user.id)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>

    <Pagination pagination={pagination} label="users" id="users" />
    </>
  )
}
