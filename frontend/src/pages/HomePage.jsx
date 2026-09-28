import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import ClampedText from '../components/ClampedText.jsx'
import UserCombobox from '../components/UserCombobox.jsx'
import UserFormDialog from '../components/UserFormDialog.jsx'
import JobForm, { EMPTY_JOB, validateJob } from '../components/JobForm.jsx'
import { useToast } from '../components/Toast.jsx'
import { api, saveBlob } from '../api/client.js'
import { toSkillList } from '../lib/entries.js'
import styles from './HomePage.module.css'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** "2024-03" -> "Mar 2024". Parsed by hand: `new Date("2024-03")` is UTC and
 *  can render as the previous month in negative-offset timezones. */
function formatMonth(value) {
  if (!value) return '—'
  const [year, month] = value.split('-')
  const name = MONTHS[Number(month) - 1]
  return name ? `${name} ${year}` : value
}

const skillTotal = (skills) => toSkillList(skills).length

function Section({ title, count, children }) {
  return (
    <>
      <h2 className={`${styles.cardTitle} ${styles.subhead}`}>
        {title}
        {count > 0 && <span className={styles.count}>{count}</span>}
      </h2>
      {children}
    </>
  )
}

export default function HomePage() {
  const toast = useToast()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setUsers(await api.users.options())
    } catch (err) {
      setError(
        `${err.message}. Is the backend running on http://127.0.0.1:8000 ?`,
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  // The select box only needs the lightweight option shape; the full record
  // (with experiences) is fetched when someone is actually selected.
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // Bumped after an edit is saved, to re-run the fetch below for the same id.
  const [detailVersion, setDetailVersion] = useState(0)

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return undefined
    }
    let cancelled = false
    setDetailLoading(true)
    api.users
      .get(selectedId)
      .then((user) => {
        if (!cancelled) setDetail(user)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    // Ignore a response that lands after the selection changed again.
    return () => {
      cancelled = true
    }
  }, [selectedId, detailVersion])

  const selected = detail?.id === selectedId ? detail : null

  // Editing the selected person from this page: the profile you are about to
  // tailor from is right here, so a wrong phone number or a missing skill is
  // fixed here rather than by going to the registration page and back.
  const [editOpen, setEditOpen] = useState(false)
  // Skills the last generation found in the posting and not in the profile.
  // Handed to the dialog as ticked proposals; cleared once it closes, so
  // reopening Edit later is a plain edit.
  const [skillSuggestions, setSkillSuggestions] = useState([])
  // The same generation's reading of what the role wants, offered in the form
  // as text to drop into a role and rewrite.
  const [experienceSuggestions, setExperienceSuggestions] = useState([])

  const handleUserSaved = async (saved, message) => {
    setEditOpen(false)
    setSkillSuggestions([])
    setExperienceSuggestions([])
    // Show the saved record straight away, then re-fetch so anything the
    // server normalized (the LinkedIn URL, entry ids) is what stays on screen.
    setDetail(saved)
    setDetailVersion((n) => n + 1)
    // Awaited so the dialog's progress bar finishes on the refresh actually
    // finishing. The combobox carries the name, so a rename has to reach it
    // too.
    await loadUsers()
    toast.success('Profile updated', message)
  }

  // The job being applied to. Kept across user switches — the posting is about
  // the role, not the person.
  const [job, setJob] = useState(EMPTY_JOB)
  const [jobErrors, setJobErrors] = useState({})
  const [generating, setGenerating] = useState(false)
  // The server's latest progress event, or null between generations. Held as
  // the event rather than a string so the label and its detail (which call,
  // how many terms) stay together.
  const [phase, setPhase] = useState(null)
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState(false)
  const [humanizing, setHumanizing] = useState(false)
  // Which version the card shows: 'original' | 'humanized'.
  const [version, setVersion] = useState('original')

  // Whether the backend has an LLM endpoint configured. Checked once on mount
  // so the warning appears before anyone pastes a posting.
  const [llm, setLlm] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.tailor
      .status()
      .then((s) => {
        if (!cancelled) setLlm(s)
      })
      .catch(() => {
        // The list fetch already reports a dead backend; don't double up.
        if (!cancelled) setLlm(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setJobField = (field, value) => {
    setJob((prev) => ({ ...prev, [field]: value }))
    setJobErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev))
  }

  const handleTailor = async (event) => {
    event.preventDefault()
    const found = validateJob(job)
    setJobErrors(found)
    if (Object.keys(found).length > 0) {
      toast.error('Check the target role', 'Some fields still need attention.')
      return
    }

    setGenerating(true)
    setResult(null)
    setCopied(false)
    setVersion('original')
    setPhase(null)

    // The server answers a timeout with a clear 504, so this is the backstop
    // for the case where nothing comes back at all — a backend that died
    // mid-request, a proxy that swallowed it. Given a few seconds past the
    // server's own deadline so its explanation wins the race when there is
    // one; without it the page waits for as long as the browser feels like.
    const GRACE_MS = 8000
    const limitMs = (Number(llm?.timeout) > 0 ? Number(llm.timeout) * 1000 : 60000) + GRACE_MS
    const controller = new AbortController()
    const abortAt = setTimeout(() => controller.abort(), limitMs)

    try {
      const data = await api.tailor.generateStreaming(
        {
          user_id: selected.id,
          job: {
            company: job.company.trim(),
            position: job.position.trim(),
            url: job.url.trim() || null,
            description: job.description.trim(),
          },
        },
        controller.signal,
        setPhase,
      )
      setResult(data)
      toast.success(
        'Resume generated',
        `${data.full_name} \u2192 ${data.position} at ${data.company} (${data.model}).`,
      )
      // The posting named skills this profile does not list. Open the form on
      // them straight away, ticked and ready: the alternative is reading the
      // gap list, remembering it, and typing it back in by hand. The save
      // itself stays a click — see the panel in UserFormDialog.
      const missing = data.resume?.gaps ?? []

      // Both readings of the posting, as the two panels below show them: the
      // requirements it states, and the sample sentences written from its
      // vocabulary. Each is offered in the form beside the roles, to drop into
      // one and rewrite — never merged on save, because neither describes
      // anything this person has actually done yet.
      const metWants = new Set(data.resume?.wants_met ?? [])
      const openAsks = (data.resume?.wants ?? []).filter(
        (_, index) => !metWants.has(index + 1),
      )
      const covered = new Set(data.resume?.posting?.sentences_in_profile ?? [])
      const openSentences = (data.resume?.posting?.sample_sentences ?? []).filter(
        (_, index) => !covered.has(index + 1),
      )
      // One list, de-duplicated: the two readings overlap, and the same line
      // offered twice is just a second chance to insert it twice.
      const offers = [...new Set([...openAsks, ...openSentences])]

      setSkillSuggestions(missing)
      setExperienceSuggestions(offers)
      if (missing.length > 0 || offers.length > 0) setEditOpen(true)
    } catch (err) {
      if (err?.name === 'AbortError') {
        toast.error(
          'Gave up waiting',
          `The server did not answer within ${Math.round(limitMs / 1000)}s. It may still be ` +
            'working — check the backend log, or raise LLM_TIMEOUT if the model is just slow.',
        )
        return
      }
      // The backend distinguishes "no endpoint configured" (503) from "the
      // endpoint is down" (502) and "it timed out" (504); each needs a
      // different action from whoever is reading the toast.
      const title =
        err.status === 503
          ? 'No model configured'
          : err.status === 504
            ? 'The model timed out'
            : err.status === 502
              ? 'The model is unavailable'
              : 'Could not generate the resume'
      toast.error(title, err.message)
      if (err.status === 503) {
        setLlm({ configured: false, detail: err.message })
      }
    } finally {
      clearTimeout(abortAt)
      setGenerating(false)
      // Cleared here rather than on success: a run that failed should not
      // leave its last phase on screen looking like it is still going.
      setPhase(null)
    }
  }

  const handleHumanize = async () => {
    setHumanizing(true)
    try {
      const data = await api.tailor.humanize(result.id)
      setResult(data)
      setVersion('humanized')
      setCopied(false)
      toast.success(
        'Humanized',
        `Rewritten by ${data.humanized_model}. Facts are unchanged — only the wording.`,
      )
      // The backend discards any fact the rewrite tried to change; say so
      // rather than hiding it.
      if (data.ignored_changes?.length) {
        toast.info(
          'Some edits were discarded',
          `The rewrite tried to change ${data.ignored_changes.length} protected ` +
            `field(s) (${data.ignored_changes.join(', ')}). Those were kept as generated.`,
        )
      }
    } catch (err) {
      const title =
        err.status === 503
          ? 'Claude is not configured'
          : err.status === 504
            ? 'Claude timed out'
            : err.status === 502
              ? 'Claude is unavailable'
              : 'Could not humanize the resume'
      toast.error(title, err.message)
      if (err.status === 503) {
        setLlm((prev) => ({
          ...(prev ?? {}),
          humanize: { configured: false, detail: err.message },
        }))
      }
    } finally {
      setHumanizing(false)
    }
  }

  // The posting's asks, minus the ones this profile already evidences. The
  // model writes the full reading first and marks the covered lines second
  // (1-based), so what is left here is the part still worth thinking about.
  const wants = result?.resume?.wants ?? []
  const met = new Set(result?.resume?.wants_met ?? [])
  const openWants = wants.filter((_, index) => !met.has(index + 1))
  const metWants = wants.length - openWants.length

  const allSentences = result?.resume?.posting?.sample_sentences ?? []
  // Checked by the backend against those sentences, not promised by the
  // prompt: they are meant to use every listed term, and this is what says so
  // when they do not.
  const uncoveredTerms = result?.resume?.posting?.uncovered_terms ?? []
  // Terms this profile evidences that the resume still does not contain, after
  // the server asked once for them to be worked back in. Matches already
  // earned and still not on the page — worth seeing, because the fix is a
  // sentence the profile already has.
  const missedTerms = result?.resume?.missed_terms ?? []
  // Sentences (1-based) whose posting terms are ALL accounted for by this
  // profile's experience, and so are hidden: the work is already described,
  // and what is worth reading is the wording there is no line for yet.
  const sentencesInProfile = new Set(
    result?.resume?.posting?.sentences_in_profile ?? [],
  )
  const postingSentences = allSentences.filter(
    (_, index) => !sentencesInProfile.has(index + 1),
  )
  const coveredSentences = allSentences.length - postingSentences.length

  // What the card currently shows, and what Download sends.
  const showingHumanized = version === 'humanized' && !!result?.humanized
  const shownMarkdown = showingHumanized
    ? result?.humanized_markdown
    : result?.resume_markdown

  const copyResume = async () => {
    try {
      await navigator.clipboard.writeText(shownMarkdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.')
    }
  }

  const [downloading, setDownloading] = useState(false)

  const downloadDocx = async () => {
    setDownloading(true)
    try {
      const { blob, filename } = await api.tailor.docx(
        result.id,
        showingHumanized ? 'humanized' : 'original',
      )
      saveBlob(blob, filename ?? 'resume.docx')
    } catch (err) {
      toast.error('Could not download the .docx', err.message)
    } finally {
      setDownloading(false)
    }
  }

  // --- the two columns, same height, each scrolling on its own -----------
  // The left column is as long as the person's history; the right is as long
  // as the posting and the resume that comes back. Left to themselves one runs
  // far past the other, and the page scrolls on whichever is taller — so the
  // profile you are tailoring from scrolls away exactly when you are reading
  // the resume beside it. Instead both columns are given the same height, the
  // rest of the window below them, and each scrolls inside it.
  //
  // Measured rather than written in CSS because where the columns start
  // depends on the heading above them, which moves with the font-size control.
  const columnsRef = useRef(null)
  const [columnsHeight, setColumnsHeight] = useState(null)
  const [columnsPull, setColumnsPull] = useState(0)

  useEffect(() => {
    // Breathing room under the columns, and the breakpoint below which they
    // stack — stacked, there is no second column to match, so both are left to
    // their natural height and the page scrolls as usual.
    const BOTTOM = 20
    const twoColumns = window.matchMedia('(min-width: 1061px)')
    // Under this the panes would be too short to read in; better a long page.
    const FLOOR = 420

    const measure = () => {
      const el = columnsRef.current
      if (!el || !twoColumns.matches) {
        setColumnsHeight(null)
        setColumnsPull(0)
        return
      }
      const available = window.innerHeight - el.getBoundingClientRect().top - BOTTOM
      if (available < FLOOR) {
        setColumnsHeight(null)
        setColumnsPull(0)
        return
      }
      setColumnsHeight(Math.floor(available))
      // The layout gives every page a generous gutter below its content. On a
      // page that scrolls, that is the end of the page; here it would be dead
      // space that the window still has to make room for, so the panes would
      // lose that height and the page would scroll by exactly that much.
      // Pulled back to BOTTOM, the window fits the panes and nothing scrolls
      // but the panes themselves.
      const main = el.closest('main')
      const gutter = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0
      setColumnsPull(gutter > BOTTOM ? Math.round(gutter - BOTTOM) : 0)
    }

    measure()

    // The heading above the columns changes height with the font-size control
    // and with the window width, which moves where the columns start.
    const observer = new ResizeObserver(measure)
    if (columnsRef.current?.parentElement) {
      observer.observe(columnsRef.current.parentElement)
    }
    window.addEventListener('resize', measure)
    twoColumns.addEventListener('change', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      twoColumns.removeEventListener('change', measure)
    }
  }, [])

  const downloadResume = () => {
    const safe = `${result.full_name ?? 'resume'} - ${result.company}`
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase()
    const blob = new Blob([shownMarkdown], {
      type: 'text/markdown;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safe}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={styles.page}>
      <div className={styles.intro}>
        <h1>Tailor a resume</h1>
        <p className={styles.lede}>
          Pick the person whose resume you want to tailor. Not in the list?{' '}
          <Link to="/register" className={styles.inlineLink}>
            Register a user
          </Link>
          .
        </p>
      </div>

      {/* Left: who — the person and the profile they were registered with.
          Right: this application — the job being tailored for, and the resume
          that comes back. Kept apart so the profile you are drawing from stays
          in view beside the result, rather than scrolling away above it. */}
      <div
        className={`${styles.columns} ${columnsHeight ? styles.columnsFixed : ''}`}
        ref={columnsRef}
        style={
          columnsHeight
            ? {
                height: `${columnsHeight}px`,
                marginBottom: columnsPull ? `-${columnsPull}px` : undefined,
              }
            : undefined
        }
      >
        <div className={styles.column}>

          <section className={styles.card}>
            <label className={styles.label} htmlFor="user-select">
              User
            </label>

            <UserCombobox
              id="user-select"
              users={users}
              value={selectedId}
              onChange={setSelectedId}
              loading={loading}
              disabled={!!error}
            />

            <p className={styles.hint}>
              {loading
                ? 'Loading users…'
                : `${users.length} user${users.length === 1 ? '' : 's'} registered`}
              {' · '}
              <button type="button" className={styles.linkButton} onClick={loadUsers}>
                Refresh
              </button>
            </p>

            {error && <p className={styles.error}>{error}</p>}
          </section>

          {selected && (
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2 className={`${styles.cardTitle} ${styles.cardHeadTitle}`}>
                  Selected
                </h2>
                <button
                  type="button"
                  className={styles.ghost}
                  onClick={() => setEditOpen(true)}
                >
                  Edit user information
                </button>
              </div>
              <dl className={styles.details}>
                {/* Each value is one line with an ellipsis past the column's
                    width, so `title` is what makes the whole thing readable. */}
                <div>
                  <dt>Name</dt>
                  <dd title={selected.full_name}>{selected.full_name}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd title={selected.email ?? undefined}>
                    {selected.email ?? <span className={styles.missing}>Not set</span>}
                  </dd>
                </div>
                <div>
                  <dt>Phone</dt>
                  <dd title={selected.phone ?? undefined}>
                    {selected.phone ?? <span className={styles.missing}>Not set</span>}
                  </dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd title={selected.location ?? undefined}>
                    {selected.location ?? <span className={styles.missing}>Not set</span>}
                  </dd>
                </div>
                <div>
                  <dt>LinkedIn</dt>
                  <dd title={selected.linkedin_url ?? undefined}>
                    {selected.linkedin_url ? (
                      <a
                        className={styles.inlineLink}
                        href={selected.linkedin_url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {selected.linkedin_url.replace(/^https?:\/\//, '')}
                      </a>
                    ) : (
                      <span className={styles.missing}>Not set</span>
                    )}
                  </dd>
                </div>
              </dl>

              {selected.is_complete === false && (
                <p className={styles.warning}>
                  This profile was saved before the current fields existed and is
                  missing some of them.{' '}
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setEditOpen(true)}
                  >
                    Fill them in
                  </button>
                  .
                </p>
              )}
              <Section title="Experience" count={selected.experiences?.length}>
              {selected.experiences?.length ? (
                <ol className={styles.timeline}>
                  {selected.experiences.map((exp) => (
                    <li key={exp.id} className={styles.entry}>
                      <div className={styles.entryHead}>
                        <span
                          className={styles.company}
                          title={[exp.position, exp.company].filter(Boolean).join(' · ')}
                        >
                          {exp.position ? (
                            <>
                              {exp.position}
                              {exp.company && (
                                <span className={styles.at}> · {exp.company}</span>
                              )}
                            </>
                          ) : (
                            exp.company
                          )}
                        </span>
                        <span className={styles.dates}>
                          {formatMonth(exp.start_date)} —{' '}
                          {exp.is_current ? 'Present' : formatMonth(exp.end_date)}
                        </span>
                      </div>
                      <ClampedText text={exp.details} />
                    </li>
                  ))}
                </ol>
              ) : (
                <p className={styles.noExperience}>
                  No experience recorded.{' '}
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setEditOpen(true)}
                  >
                    Add some
                  </button>
                  .
                </p>
              )}
              </Section>

              <Section title="Education" count={selected.education?.length}>
                {selected.education?.length ? (
                  <ol className={styles.timeline}>
                    {selected.education.map((edu) => (
                      <li key={edu.id} className={styles.entry}>
                        <div className={styles.entryHead}>
                          <span className={styles.company} title={edu.university}>
                            {edu.university}
                          </span>
                          <span className={styles.dates}>
                            {formatMonth(edu.start_date)} —{' '}
                            {edu.is_current ? 'Present' : formatMonth(edu.end_date)}
                          </span>
                        </div>
                        <ClampedText text={edu.details} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className={styles.noExperience}>No education recorded.</p>
                )}
              </Section>

              <Section title="Projects" count={selected.projects?.length}>
                {selected.projects?.length ? (
                  <ol className={styles.timeline}>
                    {selected.projects.map((proj) => (
                      <li key={proj.id} className={styles.entry}>
                        <div className={styles.entryHead}>
                          <span className={styles.company} title={proj.name}>
                            {proj.name}
                          </span>
                          <span className={styles.dates}>
                            {formatMonth(proj.start_date)} —{' '}
                            {proj.is_current ? 'Present' : formatMonth(proj.end_date)}
                          </span>
                        </div>
                        <ClampedText text={proj.details} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className={styles.noExperience}>No projects recorded.</p>
                )}
              </Section>

              <Section title="Technical skills" count={skillTotal(selected.skills)}>
                {skillTotal(selected.skills) ? (
                  /* One run of chips, in the order they were entered. They
                     used to be grouped by kind; the grouping said nothing a
                     reader needed and forced a filing decision on every
                     entry. */
                  <div className={styles.chips}>
                    {toSkillList(selected.skills).map((item) => (
                      <span className={styles.chip} key={item}>
                        {item}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className={styles.noExperience}>No skills recorded.</p>
                )}
              </Section>
            </section>
          )}
        </div>

        <div className={styles.column}>
          {selected && (
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Target role</h2>
              <p className={styles.cardLede}>
                Describe the job you're tailoring <strong>{selected.full_name}</strong>'s
                resume for.
              </p>

              {llm && !llm.configured && (
                <p className={styles.warning}>
                  <strong>No model is configured.</strong> {llm.detail} Generating
                  will fail until then.
                </p>
              )}

              <JobForm
                value={job}
                errors={jobErrors}
                onChange={setJobField}
                onSubmit={handleTailor}
                busy={generating}
                timeout={llm?.timeout}
                phase={phase}
                // From the generation just finished. Comes off the resume
                // record, so it survives a refresh and is still right when an
                // older resume is reloaded rather than regenerated.
                usage={result?.usage}
                onPasted={(_, filled) =>
                  toast.success(
                    'Pasted from clipboard',
                    `Filled ${filled.length} field${filled.length === 1 ? '' : 's'}: ${filled
                      .map((f) => (f === 'url' ? 'applying URL' : f))
                      .join(', ')}.`,
                  )
                }
              />
            </section>
          )}

          {result && (
            <section className={styles.card}>
              <div className={styles.resultHead}>
                <div>
                  <h2 className={styles.cardTitle}>Tailored resume</h2>
                  <p className={styles.resultMeta}>
                    {result.position} at {result.company} ·{' '}
                    {showingHumanized ? (
                      <>
                        humanized by <code>{result.humanized_model}</code>
                      </>
                    ) : (
                      <>
                        generated by <code>{result.model}</code>
                      </>
                    )}
                  </p>
                </div>
                <div className={styles.resultActions}>
                  {!result.humanized && (
                    <button
                      type="button"
                      className={styles.primaryGhost}
                      onClick={handleHumanize}
                      disabled={humanizing}
                    >
                      {humanizing && <span className={styles.spinner} aria-hidden="true" />}
                      {humanizing ? 'Humanizing…' : 'Humanize with Claude'}
                    </button>
                  )}
                  <button type="button" className={styles.ghost} onClick={copyResume}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button type="button" className={styles.ghost} onClick={downloadResume}>
                    Download .md
                  </button>
                  <button
                    type="button"
                    className={styles.primaryGhost}
                    onClick={downloadDocx}
                    disabled={downloading}
                  >
                    {downloading ? 'Preparing…' : 'Download .docx'}
                  </button>
                </div>
              </div>

              {result.humanized && (
                <div className={styles.versions} role="group" aria-label="Resume version">
                  <button
                    type="button"
                    className={`${styles.tab} ${!showingHumanized ? styles.tabActive : ''}`}
                    onClick={() => {
                      setVersion('original')
                      setCopied(false)
                    }}
                  >
                    Original
                  </button>
                  <button
                    type="button"
                    className={`${styles.tab} ${showingHumanized ? styles.tabActive : ''}`}
                    onClick={() => {
                      setVersion('humanized')
                      setCopied(false)
                    }}
                  >
                    Humanized
                  </button>
                  <span className={styles.versionNote}>
                    Same facts — only the wording differs. Copy and both downloads
                    follow this choice.
                  </span>
                </div>
              )}

              {llm?.humanize && !llm.humanize.configured && !result.humanized && (
                <p className={styles.warning}>
                  <strong>Claude is not configured.</strong> {llm.humanize.detail}
                </p>
              )}

              <pre className={styles.resume}>{shownMarkdown}</pre>

              {/* Matches the profile earned and the document dropped. Above
                  the panels that read the posting, because this one is about
                  the resume printed right there \u2014 and unlike a gap, every
                  line of it is already true of this person. */}
              {missedTerms.length > 0 && (
                <div className={styles.missed}>
                  <h3 className={styles.gapsTitle}>
                    In this profile, but not in the resume above
                    <span className={styles.gapsCount}>{missedTerms.length}</span>
                  </h3>
                  <p className={styles.gapList}>{missedTerms.join(', ')}</p>
                  <p className={styles.gapsNote}>
                    The posting asks for these and the profile shows them, but
                    they did not reach the page. Generating again usually picks
                    them up; naming them in the profile the way the posting
                    does makes it certain.
                  </p>
                </div>
              )}

              {/* The posting in its own words, as sentences. The four term
                  lists behind them (hard skills, stack, soft skills,
                  keywords) still drive what is written and are still checked
                  against it on the server — they are simply not shown, since
                  the sentences are what a person can actually use. */}
              {allSentences.length > 0 && (
                <div className={styles.terms}>
                  <h3 className={styles.gapsTitle}>
                    What this posting asks for
                    <span className={styles.gapsCount}>{postingSentences.length}</span>
                  </h3>
                  {postingSentences.length > 0 ? (
                    <ul className={styles.sampleList}>
                      {/* Index in the key, not the sentence alone: the server
                          dedupes these, but a duplicate slipping through must
                          render as two lines rather than crash the list. */}
                      {postingSentences.map((sentence, index) => (
                        <li key={`${index}-${sentence}`}>
                          {/* A real character: a list marker is drawn, not
                              text, so it is left behind when these are
                              copied. */}
                          <span aria-hidden="true">{'• '}</span>
                          {sentence}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.gapsNote}>
                      Every line this posting suggested is already covered by
                      this profile's experience.
                    </p>
                  )}
                  <p className={styles.gapsNote}>
                    Written from the job description's own wording, not from this
                    profile. Use one only where it is true of your own work — edit
                    it to what you actually did.
                    {coveredSentences > 0 &&
                      ` ${coveredSentences} further ${coveredSentences === 1 ? 'line is' : 'lines are'} already covered by this profile's experience and hidden.`}
                  </p>

                  {/* Between them the sentences are meant to use every term the
                      posting names. Saying which ones they missed is better than
                      leaving the reader to check by eye, and honest about a rule
                      the model does not always keep. */}
                  {uncoveredTerms.length > 0 && (
                    <p className={styles.uncovered}>
                      <strong>
                        Still no sentence for {uncoveredTerms.length}{' '}
                        {uncoveredTerms.length === 1 ? 'term' : 'terms'}, after
                        asking again:
                      </strong>{' '}
                      {uncoveredTerms.join(', ')}
                    </p>
                  )}
                </div>
              )}

              {/* The posting read on its own terms: the experience it asks
                  for, whoever applies. Above the gap list because it is the
                  wider frame — what the role wants — and stated as a reading
                  of the advertisement, not as anything about this person. */}
              {openWants.length > 0 && (
                <div className={styles.wants}>
                  <h3 className={styles.gapsTitle}>
                    What this posting wants that this profile does not show
                    <span className={styles.gapsCount}>{openWants.length}</span>
                  </h3>
                  <ul className={styles.wantList}>
                    {openWants.map((want) => (
                      <li key={want}>
                        {/* A real character rather than the browser's list
                            marker: a marker is drawn, not text, so it is left
                            behind when these lines are copied. Hidden from
                            screen readers, which announce the list itself. */}
                        <span aria-hidden="true">{'• '}</span>
                        {want}
                      </li>
                    ))}
                  </ul>
                  <p className={styles.gapsNote}>
                    Read from the job description alone.
                    {metWants > 0 &&
                      ` ${metWants} further ${metWants === 1 ? 'line is' : 'lines are'} already covered by this profile and hidden.`}
                  </p>
                </div>
              )}

              {/* What this posting asks for that the profile cannot evidence.
                  Below the resume and stated plainly: it is not an error, and
                  it asks nothing of the reader — it is what the posting wanted,
                  so what to do about each one stays with the person whose
                  resume this is. */}
              {result.resume?.gaps?.length > 0 && (
                <div className={styles.gaps}>
                  <h3 className={styles.gapsTitle}>
                    Technical skills this posting asks for, not in this profile
                    <span className={styles.gapsCount}>{result.resume.gaps.length}</span>
                  </h3>
                  {/* One comma-separated line: quicker to read across than a
                      row of chips, and it can be selected and copied in one go. */}
                  <p className={styles.gapList}>{result.resume.gaps.join(', ')}</p>
                  <p className={styles.gapsNote}>
                    Left out of the resume, because nothing in the profile shows them.
                  </p>
                </div>
              )}
            </section>
          )}

          {selectedId && detailLoading && !selected && (
            <section className={styles.card}>
              <p className={styles.noExperience}>Loading profile…</p>
            </section>
          )}

          {!selectedId && (
            <section className={styles.placeholder}>
              <p className={styles.placeholderTitle}>Nothing selected yet</p>
              <p className={styles.placeholderText}>
                Pick someone on the left. The job you are tailoring for goes
                here, and the resume appears below it.
              </p>
            </section>
          )}

          {selected && !result && (
            <section className={styles.placeholder}>
              <p className={styles.placeholderTitle}>No resume yet</p>
              <p className={styles.placeholderText}>
                Fill in the target role above and generate — the tailored resume
                appears here.
              </p>
            </section>
          )}
        </div>
      </div>

      <UserFormDialog
        open={editOpen && !!selected}
        user={selected}
        onClose={() => {
          setEditOpen(false)
          setSkillSuggestions([])
          setExperienceSuggestions([])
        }}
        onSaved={handleUserSaved}
        suggestedSkills={skillSuggestions}
        suggestedExperience={experienceSuggestions}
      />
    </div>
  )
}
