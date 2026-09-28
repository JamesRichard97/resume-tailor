import { useCallback, useEffect, useState } from 'react'

import UserFormDialog from '../components/UserFormDialog.jsx'
import UserTable from '../components/UserTable.jsx'
import { api } from '../api/client.js'
import styles from './UserRegistrationPage.module.css'

export default function UserRegistrationPage() {
  const [users, setUsers] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState(null)

  // The record the dialog is editing, or null for "register someone new".
  const [editing, setEditing] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  const loadUsers = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      // The endpoint defaults to 100 and caps at 500; ask for the cap so the
      // pager is paging over everything rather than a silent first hundred.
      setUsers(await api.users.list({ limit: 500 }))
    } catch (err) {
      setListError(
        `${err.message}. Is the backend running on http://127.0.0.1:8000 ?`,
      )
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  const openCreate = () => {
    setEditing(null)
    setNotice(null)
    setError(null)
    setFormOpen(true)
  }

  const startEdit = (user) => {
    setEditing(user)
    setNotice(null)
    setError(null)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditing(null)
  }

  const handleSaved = async (_saved, message) => {
    setFormOpen(false)
    setEditing(null)
    setNotice(message)
    await loadUsers()
  }

  const handleDelete = async (id) => {
    setError(null)
    setNotice(null)
    setDeletingId(id)
    try {
      const removed = users.find((u) => u.id === id)
      await api.users.remove(id)
      if (editing?.id === id) closeForm()
      setNotice(`${removed?.full_name ?? 'User'} deleted.`)
      await loadUsers()
    } catch (err) {
      setError(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <h1>User registration</h1>
        <p className={styles.lede}>
          Register people here and keep their details current. Everyone in this
          list appears in the user select box on the tailor page.
        </p>
      </div>

      {notice && <p className={styles.success}>{notice}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            Registered users
            {!listLoading && !listError && (
              <span className={styles.count}>{users.length}</span>
            )}
          </h2>

          <div className={styles.headActions}>
            <button type="button" className={styles.linkButton} onClick={loadUsers}>
              Refresh
            </button>
            <button type="button" className={styles.primary} onClick={openCreate}>
              Register user
            </button>
          </div>
        </div>

        <UserTable
          users={users}
          loading={listLoading}
          error={listError}
          editingId={formOpen ? (editing?.id ?? null) : null}
          busyId={deletingId}
          onEdit={startEdit}
          onDelete={handleDelete}
          onAdd={openCreate}
        />
      </section>

      <UserFormDialog
        open={formOpen}
        user={editing}
        onClose={closeForm}
        onSaved={handleSaved}
      />
    </div>
  )
}
