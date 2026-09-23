import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import ClampedText from '../components/ClampedText.jsx'
import UserCombobox from '../components/UserCombobox.jsx'
import JobForm, { EMPTY_JOB, validateJob } from '../components/JobForm.jsx'
import { useToast } from '../components/Toast.jsx'
import { api, saveBlob } from '../api/client.js'
import { SKILL_GROUPS } from '../lib/entries.js'
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

const skillTotal = (skills) =>
  SKILL_GROUPS.reduce((sum, { key }) => sum + (skills?.[key]?.length ?? 0), 0)

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
  }, [selectedId])

  const selected = detail?.id === selectedId ? detail : null

  // The job being applied to. Kept across user switches — the posting is about
  // the role, not the person.
  const [job, setJob] = useState(EMPTY_JOB)
  const [jobErrors, setJobErrors] = useState({})
  const [generating, setGenerating] = useState(false)
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
    try {
      const data = await api.tailor.generate({
        user_id: selected.id,
        job: {
          company: job.company.trim(),
          position: job.position.trim(),
          url: job.url.trim() || null,
          description: job.description.trim(),
        },
      })
      setResult(data)
      toast.success(
        'Resume generated',
        `${data.full_name} → ${data.position} at ${data.company} (${data.model}).`,
      )
    } catch (err) {
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
      setGenerating(false)
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
      <div className={styles.columns}>
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
              <h2 className={styles.cardTitle}>Selected</h2>
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
                  missing some of them. Register the person again, or fill the gaps
                  with <code>PATCH /api/users/{selected.id}</code>.
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
                  <Link to="/register" className={styles.inlineLink}>
                    Add some
                  </Link>
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
                  <dl className={styles.skills}>
                    {SKILL_GROUPS.map(({ key, label }) =>
                      selected.skills?.[key]?.length ? (
                        <div className={styles.skillGroup} key={key}>
                          <dt>{label}</dt>
                          <dd className={styles.chips}>
                            {selected.skills[key].map((item) => (
                              <span className={styles.chip} key={item}>
                                {item}
                              </span>
                            ))}
                          </dd>
                        </div>
                      ) : null,
                    )}
                  </dl>
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
    </div>
  )
}
