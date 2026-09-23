import { useCallback, useEffect, useState } from 'react'

import ExperienceFields, {
  newExperience,
  validateExperiences,
} from '../components/ExperienceFields.jsx'
import SimpleEntryFields, {
  newSimpleEntry,
  validateEducation,
  validateProjects,
} from '../components/SimpleEntryFields.jsx'
import SkillsFields from '../components/SkillsFields.jsx'
import Modal from '../components/Modal.jsx'
import UserTable from '../components/UserTable.jsx'
import { api } from '../api/client.js'
import {
  EMPTY_SKILLS,
  SKILL_GROUPS,
  formatSkillList,
  parseSkillList,
  toFormEntry,
  toPayloadEntry,
} from '../lib/entries.js'
import styles from './UserRegistrationPage.module.css'

const EMPTY = {
  full_name: '',
  linkedin_url: '',
  email: '',
  phone: '',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Mirrors the server: linkedin.com (or a country subdomain) + a profile path.
const LINKEDIN_RE = /^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/.+/i
// Mirrors the server: allowed characters, then a 7–15 digit count.
const PHONE_CHARS_RE = /^\+?[0-9 ()\-./]+$/
const isPhone = (value) => {
  if (!PHONE_CHARS_RE.test(value)) return false
  const digits = value.replace(/\D/g, '').length
  return digits >= 7 && digits <= 15
}

/** Editing one field can invalidate another field's error message. */
const RELATED_ERRORS = {
  is_current: ['is_current', 'end_date'],
  start_date: ['start_date', 'end_date'],
}

function validate(form) {
  const errors = {}

  if (!form.full_name.trim()) {
    errors.full_name = 'Full name is required.'
  }

  if (!form.linkedin_url.trim()) {
    errors.linkedin_url = 'LinkedIn address is required.'
  } else if (!LINKEDIN_RE.test(form.linkedin_url.trim())) {
    errors.linkedin_url = 'Enter a LinkedIn profile URL, e.g. linkedin.com/in/your-name'
  }

  if (!form.email.trim()) {
    errors.email = 'Email is required.'
  } else if (!EMAIL_RE.test(form.email.trim())) {
    errors.email = 'Enter a valid email address.'
  }

  if (!form.phone.trim()) {
    errors.phone = 'Phone number is required.'
  } else if (!isPhone(form.phone.trim().replace(/\s+/g, ' '))) {
    errors.phone = 'Enter a valid phone number.'
  }

  return errors
}

export default function UserRegistrationPage() {
  const [users, setUsers] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState(null)

  const [form, setForm] = useState(EMPTY)
  const [experiences, setExperiences] = useState([])
  const [education, setEducation] = useState([])
  const [projects, setProjects] = useState([])
  const [skills, setSkills] = useState(EMPTY_SKILLS)
  const [editingId, setEditingId] = useState(null)
  const [errors, setErrors] = useState({})
  const [expErrors, setExpErrors] = useState({})
  const [eduErrors, setEduErrors] = useState({})
  const [projErrors, setProjErrors] = useState({})
  const [submitError, setSubmitError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [formOpen, setFormOpen] = useState(false)

  const isEditing = editingId !== null

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

  const setField = (name) => (event) => {
    const { value } = event.target
    setForm((prev) => ({ ...prev, [name]: value }))
    setErrors((prev) => (prev[name] ? { ...prev, [name]: undefined } : prev))
  }

  const resetForm = () => {
    setForm(EMPTY)
    setExperiences([])
    setEducation([])
    setProjects([])
    setSkills(EMPTY_SKILLS)
    setEditingId(null)
    setErrors({})
    setExpErrors({})
    setEduErrors({})
    setProjErrors({})
    setSubmitError(null)
  }

  /** One set of list handlers, bound per section — the three repeatable
   *  sections behave identically. */
  const listHandlers = (setRows, setRowErrors, makeRow) => ({
    onChange: (index, field, value) => {
      setRows((prev) =>
        prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
      )
      setRowErrors((prev) => {
        const rowErrors = prev[index]
        if (!rowErrors) return prev
        // The To-date rules depend on the other two date fields, so editing
        // either of those has to clear a stale end_date error as well —
        // otherwise ticking "currently" leaves the old message on screen.
        const clear = RELATED_ERRORS[field] ?? [field]
        if (!clear.some((name) => rowErrors[name])) return prev
        const next = { ...rowErrors }
        clear.forEach((name) => delete next[name])
        return { ...prev, [index]: next }
      })
    },
    onAdd: () => setRows((prev) => [...prev, makeRow()]),
    onRemove: (index) => {
      setRows((prev) => prev.filter((_, i) => i !== index))
      // Row indices shift, so stale per-row errors would point at the wrong row.
      setRowErrors({})
    },
  })

  const experienceHandlers = listHandlers(setExperiences, setExpErrors, newExperience)
  const educationHandlers = listHandlers(setEducation, setEduErrors, () =>
    newSimpleEntry('university'),
  )
  const projectHandlers = listHandlers(setProjects, setProjErrors, () =>
    newSimpleEntry('name'),
  )

  const setSkillGroup = (group, text) =>
    setSkills((prev) => ({ ...prev, [group]: text }))

  const openCreate = () => {
    resetForm()
    setNotice(null)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    resetForm()
  }

  const startEdit = (user) => {
    setForm({
      full_name: user.full_name ?? '',
      linkedin_url: user.linkedin_url ?? '',
      email: user.email ?? '',
      phone: user.phone ?? '',
    })
    setExperiences(
      (user.experiences ?? []).map((exp) =>
        toFormEntry(exp, {
          position: exp.position ?? '',
          company: exp.company ?? '',
          details: exp.details ?? '',
        }),
      ),
    )
    setEducation(
      (user.education ?? []).map((edu) =>
        toFormEntry(edu, {
          university: edu.university ?? '',
          details: edu.details ?? '',
        }),
      ),
    )
    setProjects(
      (user.projects ?? []).map((proj) =>
        toFormEntry(proj, { name: proj.name ?? '', details: proj.details ?? '' }),
      ),
    )
    setSkills(
      Object.fromEntries(
        SKILL_GROUPS.map(({ key }) => [
          key,
          formatSkillList(user.skills?.[key]),
        ]),
      ),
    )
    setEditingId(user.id)
    setErrors({})
    setExpErrors({})
    setEduErrors({})
    setProjErrors({})
    setSubmitError(null)
    setNotice(null)
    setFormOpen(true)
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitError(null)
    setNotice(null)

    const found = validate(form)
    const foundExp = validateExperiences(experiences)
    const foundEdu = validateEducation(education)
    const foundProj = validateProjects(projects)
    setErrors(found)
    setExpErrors(foundExp)
    setEduErrors(foundEdu)
    setProjErrors(foundProj)
    if (
      [found, foundExp, foundEdu, foundProj].some(
        (bag) => Object.keys(bag).length > 0,
      )
    ) {
      return
    }

    const payload = {
      full_name: form.full_name.trim(),
      linkedin_url: form.linkedin_url.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      experiences: experiences.map((row) =>
        toPayloadEntry(row, {
          position: row.position.trim(),
          company: row.company.trim(),
          details: row.details.trim(),
        }),
      ),
      education: education.map((row) =>
        toPayloadEntry(row, {
          university: row.university.trim(),
          details: row.details.trim(),
        }),
      ),
      projects: projects.map((row) =>
        toPayloadEntry(row, { name: row.name.trim(), details: row.details.trim() }),
      ),
      skills: Object.fromEntries(
        SKILL_GROUPS.map(({ key }) => [key, parseSkillList(skills[key] ?? '')]),
      ),
    }

    setSubmitting(true)
    try {
      if (isEditing) {
        const updated = await api.users.update(editingId, payload)
        setNotice(`${updated.full_name} updated.`)
      } else {
        const created = await api.users.create(payload)
        setNotice(`${created.full_name} registered.`)
      }
      setFormOpen(false)
      resetForm()
      await loadUsers()
    } catch (err) {
      // Keep the dialog open so the error sits next to the fields it concerns.
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id) => {
    setSubmitError(null)
    setNotice(null)
    setDeletingId(id)
    try {
      const removed = users.find((u) => u.id === id)
      await api.users.remove(id)
      if (editingId === id) resetForm()
      setNotice(`${removed?.full_name ?? 'User'} deleted.`)
      await loadUsers()
    } catch (err) {
      setSubmitError(err.message)
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
      {!formOpen && submitError && <p className={styles.error}>{submitError}</p>}

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
          editingId={editingId}
          busyId={deletingId}
          onEdit={startEdit}
          onDelete={handleDelete}
          onAdd={openCreate}
        />
      </section>

      <Modal
        open={formOpen}
        onClose={closeForm}
        title={isEditing ? 'Edit user' : 'Add user'}
        subtitle={
          isEditing
            ? 'Update this person\u2019s details, experience, education, projects and skills.'
            : 'Only the four contact fields are required \u2014 the rest can be filled in later.'
        }
      >
        <form className={styles.modalForm} onSubmit={handleSubmit} noValidate>
          <div className={styles.modalBody}>
            <Field
              label="Full name"
              name="full_name"
              value={form.full_name}
              onChange={setField('full_name')}
              error={errors.full_name}
              placeholder="Ada Lovelace"
              autoComplete="name"
            />

            <Field
              label="LinkedIn address"
              name="linkedin_url"
              value={form.linkedin_url}
              onChange={setField('linkedin_url')}
              error={errors.linkedin_url}
              placeholder="linkedin.com/in/ada-lovelace"
              autoComplete="url"
              inputMode="url"
              hint="With or without https:// — it gets normalized on save."
            />

            <div className={styles.row}>
              <Field
                label="Email"
                name="email"
                type="email"
                value={form.email}
                onChange={setField('email')}
                error={errors.email}
                placeholder="ada@example.com"
                autoComplete="email"
              />
              <Field
                label="Phone number"
                name="phone"
                type="tel"
                value={form.phone}
                onChange={setField('phone')}
                error={errors.phone}
                placeholder="+1 514 555 0100"
                autoComplete="tel"
                inputMode="tel"
              />
            </div>

            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Experience</h3>
              <ExperienceFields
                rows={experiences}
                errors={expErrors}
                {...experienceHandlers}
                disabled={submitting}
              />
            </div>

            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Education</h3>
              <SimpleEntryFields
                rows={education}
                errors={eduErrors}
                {...educationHandlers}
                disabled={submitting}
                idPrefix="edu"
                nameField="university"
                nameLabel="University"
                namePlaceholder="McGill University"
                legendLabel="Education"
                addLabel="+ Add education"
                emptyText="No education added yet."
                currentLabel="I study here currently"
                detailsPlaceholder="Degree, major, honours, relevant coursework."
              />
            </div>

            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Projects</h3>
              <SimpleEntryFields
                rows={projects}
                errors={projErrors}
                {...projectHandlers}
                disabled={submitting}
                idPrefix="proj"
                nameField="name"
                nameLabel="Project name"
                namePlaceholder="Resume Tailor"
                legendLabel="Project"
                addLabel="+ Add project"
                emptyText="No projects added yet."
                currentLabel="This project is ongoing"
                detailsPlaceholder="What it does, what you built, the stack."
              />
            </div>

            <div className={styles.section}>
              <h3 className={styles.sectionTitle}>Technical skills</h3>
              <SkillsFields
                value={skills}
                onChange={setSkillGroup}
                disabled={submitting}
              />
            </div>

            {submitError && <p className={styles.error}>{submitError}</p>}
          </div>

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.secondary}
              onClick={closeForm}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className={styles.primary} disabled={submitting}>
              {submitting
                ? isEditing
                  ? 'Saving…'
                  : 'Registering…'
                : isEditing
                  ? 'Save changes'
                  : 'Register user'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

function Field({ label, name, error, hint, ...rest }) {
  const describedBy = error ? `${name}-error` : hint ? `${name}-hint` : undefined
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={name}>
        {label}
        <span className={styles.required}>*</span>
      </label>
      <input
        id={name}
        name={name}
        className={`${styles.input} ${error ? styles.inputError : ''}`}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? (
        <span id={`${name}-error`} className={styles.fieldError}>
          {error}
        </span>
      ) : (
        hint && (
          <span id={`${name}-hint`} className={styles.hint}>
            {hint}
          </span>
        )
      )}
    </div>
  )
}
