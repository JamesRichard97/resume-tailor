import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import ExperienceFields, {
  newExperience,
  validateExperiences,
} from './ExperienceFields.jsx'
import SimpleEntryFields, {
  newSimpleEntry,
  validateEducation,
  validateProjects,
} from './SimpleEntryFields.jsx'
import SkillsFields from './SkillsFields.jsx'
import Modal from './Modal.jsx'
import { api } from '../api/client.js'
import {
  formatSkillList,
  parseSkillList,
  toFormEntry,
  toPayloadEntry,
} from '../lib/entries.js'
import styles from './UserFormDialog.module.css'

const EMPTY = {
  full_name: '',
  linkedin_url: '',
  email: '',
  phone: '',
  location: '',
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

export function validate(form) {
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

/**
 * The register/edit user form, as a dialog.
 *
 * It lives here rather than on the registration page because two places need
 * it: that page's Register/Edit buttons, and the Selected card on the tailor
 * page — where you notice a wrong phone number or a missing skill while
 * looking at the profile you are about to tailor, and want to fix it there.
 *
 * Props:
 *   open           whether the dialog is showing
 *   user           the record to edit, or null/undefined to register someone new
 *   onClose()      asked to close without saving
 *   onSaved(user, message)  saved successfully; `user` is the server's record.
 *                  Awaited, so the progress bar can cover the caller's refresh.
 *   suggestedSkills  skills a posting asked for that this profile does not
 *                  list. Shown as a tick list at the top of the form, every
 *                  one already ticked, so adding them is one click rather than
 *                  typing — but a click, not a silent write. See the panel's
 *                  own note for why.
 *   suggestedExperience  lines describing the experience a posting asks for.
 *                  Offered beside the roles as text to drop into one and
 *                  rewrite — never ticked, never merged on save. A skill is a
 *                  word you either know or do not; one of these is a claim
 *                  about what you did, for a named employer, between two
 *                  dates. It has to be made true before it is saved, and only
 *                  the person whose history it is can do that.
 */
export default function UserFormDialog({
  open,
  user,
  onClose,
  onSaved,
  suggestedSkills,
  suggestedExperience,
}) {
  const [form, setForm] = useState(EMPTY)
  const [experiences, setExperiences] = useState([])
  const [education, setEducation] = useState([])
  const [projects, setProjects] = useState([])
  const [skills, setSkills] = useState('')
  const [errors, setErrors] = useState({})
  const [expErrors, setExpErrors] = useState({})
  const [eduErrors, setEduErrors] = useState({})
  const [projErrors, setProjErrors] = useState({})
  const [submitError, setSubmitError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  // Which suggested skills to add, and where to file them. The group is a
  // batch choice rather than one per skill: whatever it is set to, the four
  // group boxes below are ordinary text and anything can be moved before
  // saving.
  const [picked, setPicked] = useState(() => new Set())
  // Which role a posting line gets dropped into, and which lines have been
  // dropped already (so the panel stops offering the same one twice).
  const [expTarget, setExpTarget] = useState(0)
  const [insertedWants, setInsertedWants] = useState(() => new Set())
  // Real stages, not a timer: 'saving' covers the PATCH, 'reloading' covers
  // the caller refreshing what it shows. A bar that moves on its own while
  // nothing is happening is a lie about the state of someone's data.
  const [stage, setStage] = useState(null)

  const editingId = user?.id ?? null
  const isEditing = editingId !== null

  /** Fills the fields from `record`, or empties them when there is none. */
  const prefill = useCallback((record) => {
    setForm(
      record
        ? {
            full_name: record.full_name ?? '',
            linkedin_url: record.linkedin_url ?? '',
            email: record.email ?? '',
            phone: record.phone ?? '',
            location: record.location ?? '',
          }
        : EMPTY,
    )
    setExperiences(
      (record?.experiences ?? []).map((exp) =>
        toFormEntry(exp, {
          position: exp.position ?? '',
          company: exp.company ?? '',
          details: exp.details ?? '',
          // Kept alongside details, never folded into it.
          inserted: Array.isArray(exp.inserted) ? exp.inserted : [],
        }),
      ),
    )
    setEducation(
      (record?.education ?? []).map((edu) =>
        toFormEntry(edu, {
          university: edu.university ?? '',
          details: edu.details ?? '',
        }),
      ),
    )
    setProjects(
      (record?.projects ?? []).map((proj) =>
        toFormEntry(proj, { name: proj.name ?? '', details: proj.details ?? '' }),
      ),
    )
    setSkills(record ? formatSkillList(record.skills) : '')
    setErrors({})
    setExpErrors({})
    setEduErrors({})
    setProjErrors({})
    setSubmitError(null)
  }, [])

  // Read through a ref so a re-rendered parent handing down a new object for
  // the same person cannot wipe what is being typed.
  const userRef = useRef(user)
  userRef.current = user

  useEffect(() => {
    if (open) prefill(userRef.current)
  }, [open, prefill])

  // A suggestion the profile already lists somewhere is not a suggestion.
  const alreadyListed = useMemo(
    () => new Set(parseSkillList(skills ?? '').map((item) => item.toLowerCase())),
    [skills],
  )

  const suggestions = useMemo(
    () =>
      (suggestedSkills ?? []).filter(
        (skill) => skill && !alreadyListed.has(skill.toLowerCase()),
      ),
    [suggestedSkills, alreadyListed],
  )

  // Every suggestion starts ticked, so the common case is one click. Reset
  // when the dialog opens with a different set rather than on every render,
  // which would undo the reader's own un-ticking as they went.
  const suggestionKey = suggestions.join('|')
  useEffect(() => {
    if (open) setPicked(new Set(suggestions))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggestionKey])

  useEffect(() => {
    if (open) {
      setInsertedWants(new Set())
      setExpTarget(0)
    }
  }, [open])

  const wantLines = suggestedExperience ?? []

  /** Drops a posting line into a role's details, where it can be edited.
   *
   *  Deliberately into the textarea rather than into the payload: the line
   *  says what the ROLE wants, not what this person did, and it is only true
   *  once they have rewritten it as their own work. Putting it where they are
   *  already typing is the help; saving it as written would be a claim nobody
   *  made.
   */
  const insertWant = (line) => insertWants([line])

  /**
   * Adds one or more posting lines to the selected role's inserted list.
   *
   * Written to take a batch rather than calling a single-line version N times:
   * each insert has to check what is already on the role, and N separate state
   * updates would each read the list as it was before the others ran, so a
   * batch containing two identical lines would store both. One pass builds the
   * new list once and sees every addition.
   *
   * Stored on the role's own list, NOT appended to `details`. Once the two are
   * one block of text there is no way to tell a suggestion from what the
   * candidate wrote, so "clear the suggestions and keep my own words" stops
   * being possible. No bullet character either: the mark was only there to
   * separate it from the details it was being pasted into, and these are their
   * own entries now.
   */
  const insertWants = (lines) => {
    const sentences = lines
      .map((line) => line.replace(/^\s*[\u2022\-*]\s*/, '').trim())
      .filter(Boolean)
    if (sentences.length === 0) return

    setExperiences((prev) =>
      prev.map((row, i) => {
        if (i !== expTarget) return row
        const already = [...(row.inserted ?? [])]
        const seen = new Set(already.map((s) => s.toLowerCase()))
        for (const sentence of sentences) {
          // The panel disables a line once inserted, but a role can also be
          // reached by re-opening the dialog, so the guard is kept here too.
          const key = sentence.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          already.push(sentence)
        }
        return { ...row, inserted: already }
      }),
    )
    // Keyed on the lines as offered, not as stored, so the panel matches them.
    setInsertedWants((prev) => {
      const next = new Set(prev)
      for (const line of lines) next.add(line)
      return next
    })
  }

  /** The offered lines not yet inserted \u2014 what "Insert all" would add. */
  const remainingWants = wantLines.filter((line) => !insertedWants.has(line))

  /** Drops one inserted sentence from a role, without touching its details. */
  const removeInserted = (rowIndex, sentenceIndex) =>
    setExperiences((prev) =>
      prev.map((row, i) =>
        i === rowIndex
          ? { ...row, inserted: (row.inserted ?? []).filter((_, j) => j !== sentenceIndex) }
          : row,
      ),
    )

  const togglePick = (skill) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(skill)) next.delete(skill)
      else next.add(skill)
      return next
    })

  const pickedCount = suggestions.filter((skill) => picked.has(skill)).length

  const setField = (name) => (event) => {
    const { value } = event.target
    setForm((prev) => ({ ...prev, [name]: value }))
    setErrors((prev) => (prev[name] ? { ...prev, [name]: undefined } : prev))
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


  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitError(null)

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

    // The ticked suggestions go on the end of the list, in the order shown.
    // parseSkillList de-duplicates, so a skill also typed into the box by hand
    // does not end up listed twice.
    const chosen = suggestions.filter((skill) => picked.has(skill))
    const merged = [...parseSkillList(skills ?? ''), ...chosen]

    const payload = {
      full_name: form.full_name.trim(),
      linkedin_url: form.linkedin_url.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      location: form.location.trim(),
      experiences: experiences.map((row) =>
        toPayloadEntry(row, {
          position: row.position.trim(),
          company: row.company.trim(),
          details: row.details.trim(),
          inserted: (row.inserted ?? []).map((s) => s.trim()).filter(Boolean),
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
      skills: parseSkillList(merged.join(', ')),
    }

    setSubmitting(true)
    setStage('saving')
    try {
      const saved = isEditing
        ? await api.users.update(editingId, payload)
        : await api.users.create(payload)
      // Show the fields as saved while the caller refreshes, so the bar
      // reaches the end on the work actually finishing.
      setSkills(formatSkillList(saved.skills))
      setPicked(new Set())
      setStage('reloading')
      await onSaved?.(
        saved,
        chosen.length
          ? `${saved.full_name} updated \u2014 ${chosen.length} skill${chosen.length === 1 ? '' : 's'} added.`
          : `${saved.full_name} ${isEditing ? 'updated' : 'registered'}.`,
      )
    } catch (err) {
      // Keep the dialog open so the error sits next to the fields it concerns.
      setSubmitError(err.message)
    } finally {
      setSubmitting(false)
      setStage(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEditing ? 'Edit user' : 'Add user'}
      subtitle={
        isEditing
          ? 'Update this person’s details, experience, education, projects and skills.'
          : 'Only the four contact fields are required — the rest can be filled in later.'
      }
    >
      <form className={styles.modalForm} onSubmit={handleSubmit} noValidate>
        <div className={styles.modalBody}>
          {/* First thing in the form, because it is why the dialog opened.
              Everything is ticked already, so adding the lot is one click —
              but it stays a click: these are skills the posting asked for and
              this profile does not show, and the profile is what every future
              resume is generated from. Saved unread, they would become claims
              nobody checked, written into resumes as fact. */}
          {suggestions.length > 0 && (
            <div className={styles.suggest}>
              <h3 className={styles.suggestTitle}>
                From the job posting
                <span className={styles.suggestCount}>{suggestions.length}</span>
              </h3>
              <p className={styles.suggestLede}>
                This posting asks for these and the profile does not list them.
                Untick anything you have not actually worked with.
              </p>

              <ul className={styles.suggestList}>
                {suggestions.map((skill) => (
                  <li key={skill}>
                    <label className={styles.suggestItem}>
                      <input
                        type="checkbox"
                        checked={picked.has(skill)}
                        onChange={() => togglePick(skill)}
                        disabled={submitting}
                      />
                      <span>{skill}</span>
                    </label>
                  </li>
                ))}
              </ul>

              <div className={styles.suggestFoot}>
                <span className={styles.suggestPicked}>
                  {pickedCount} of {suggestions.length} selected
                </span>
              </div>
            </div>
          )}

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

          {/* Optional, and labelled so — unlike the four fields above, a
              resume is perfectly valid without a city, and a profile saved
              before this field existed is not incomplete for lacking one. */}
          <Field
            label="Location"
            name="location"
            value={form.location}
            onChange={setField('location')}
            error={errors.location}
            placeholder="Montreal, QC"
            autoComplete="address-level2"
            optional
            hint="Written as you want it on the resume. Leave empty to keep it off."
          />

          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Experience</h3>

            {/* The posting's asks, beside the roles they might belong to.
                Nothing here is ticked and nothing is merged on save: each one
                describes what the ROLE wants, and becomes true only once it
                has been rewritten as what this person actually did. Insert
                drops it into a role's details, where it can be edited before
                anything is saved. */}
            {wantLines.length > 0 && (
              <div className={styles.suggest}>
                <h4 className={styles.suggestTitle}>
                  What the posting asks for
                  <span className={styles.suggestCount}>{wantLines.length}</span>
                </h4>
                <p className={styles.suggestLede}>
                  The posting's requirements and the sample sentences written
                  from its wording — not this person's history. Drop one into a
                  role below and rewrite it as what was actually done: dates,
                  employer, the real work. Anything left as the posting wrote it
                  is a claim nobody has made.
                </p>

                {experiences.length === 0 ? (
                  <p className={styles.suggestEmpty}>
                    Add a role below first, then these can be dropped into it.
                  </p>
                ) : (
                  <div className={styles.suggestControls}>
                    <label className={styles.suggestGroup}>
                      Insert into
                      <select
                        className={styles.suggestSelect}
                        value={expTarget}
                        onChange={(event) => setExpTarget(Number(event.target.value))}
                        disabled={submitting}
                      >
                        {experiences.map((row, index) => (
                          <option key={row._key ?? index} value={index}>
                            {[row.position, row.company].filter(Boolean).join(' \u00b7 ') ||
                              `Experience ${index + 1}`}
                          </option>
                        ))}
                      </select>
                    </label>

                    {/* Beside the selector on purpose: "this role" means the
                        one named in it, and putting them together is what
                        makes that read as one statement. Counts what it would
                        actually add, so it never claims to insert lines that
                        are already in. */}
                    <button
                      type="button"
                      className={styles.suggestInsertAll}
                      onClick={() => insertWants(remainingWants)}
                      disabled={submitting || remainingWants.length === 0}
                    >
                      {remainingWants.length === 0
                        ? 'All inserted'
                        : `Insert all ${remainingWants.length} to this role`}
                    </button>
                  </div>
                )}

                <ul className={styles.wantOffers}>
                  {wantLines.map((line, index) => {
                    const done = insertedWants.has(line)
                    return (
                      <li key={`${index}-${line}`} className={styles.wantOffer}>
                        <span className={done ? styles.wantOfferDone : undefined}>
                          {line}
                        </span>
                        <button
                          type="button"
                          className={styles.wantInsert}
                          onClick={() => insertWant(line)}
                          disabled={submitting || experiences.length === 0 || done}
                        >
                          {done ? 'Inserted' : 'Insert'}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            <ExperienceFields
              rows={experiences}
              errors={expErrors}
              {...experienceHandlers}
              onRemoveInserted={(rowIndex, sentenceIndex) =>
                removeInserted(rowIndex, sentenceIndex)
              }
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
            <SkillsFields value={skills} onChange={setSkills} disabled={submitting} />
          </div>

          {submitError && <p className={styles.error}>{submitError}</p>}
        </div>

        <div className={styles.modalFooter}>
          {/* Two real stages, each entered when that work starts, so the bar
              reports progress rather than animating through it. */}
          {stage && (
            <div
              className={styles.progress}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={2}
              aria-valuenow={stage === 'saving' ? 1 : 2}
              aria-label="Saving profile"
            >
              <span className={styles.progressLabel}>
                {stage === 'saving' ? 'Saving profile…' : 'Reloading profile…'}
              </span>
              <span className={styles.progressTrack}>
                <span
                  className={styles.progressFill}
                  style={{ width: stage === 'saving' ? '50%' : '100%' }}
                />
              </span>
            </div>
          )}
          <button
            type="button"
            className={styles.secondary}
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className={styles.primary} disabled={submitting}>
            {submitting
              ? isEditing
                ? 'Saving…'
                : 'Registering…'
              : pickedCount > 0
                ? `Add ${pickedCount} skill${pickedCount === 1 ? '' : 's'} and save`
                : isEditing
                  ? 'Save changes'
                  : 'Register user'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** `optional` is destructured rather than left in `...rest` on purpose: spread
 *  onto the <input> it would become an unknown DOM attribute and a React
 *  warning, and the field would still show the required marker. */
function Field({ label, name, error, hint, optional = false, ...rest }) {
  const describedBy = error ? `${name}-error` : hint ? `${name}-hint` : undefined
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={name}>
        {label}
        {optional ? (
          <span className={styles.optional}>Optional</span>
        ) : (
          <span className={styles.required}>*</span>
        )}
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
