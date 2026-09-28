// Thin fetch wrapper around the FastAPI backend.
// In dev, Vite proxies /api -> http://127.0.0.1:8000 (see vite.config.js).

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api'

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 204) return null

  let payload = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!res.ok) {
    throw new ApiError(extractMessage(payload, res.status), res.status, payload)
  }
  return payload
}

function extractMessage(payload, status) {
  if (!payload) return `Request failed (${status})`
  if (typeof payload === 'string') return payload
  const { detail } = payload
  if (typeof detail === 'string') return detail
  // FastAPI validation errors: [{ loc, msg, type }, ...]
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : null
        return field ? `${field}: ${d.msg}` : d.msg
      })
      .join('\n')
  }
  return `Request failed (${status})`
}

/**
 * Fetches a binary response as a Blob, surfacing API errors the same way
 * `request` does — so a failed download shows a real message instead of
 * silently saving an HTML error page as a .docx.
 */
async function download(path) {
  const res = await fetch(`${BASE_URL}${path}`)

  if (!res.ok) {
    let payload = null
    const text = await res.text()
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }
    throw new ApiError(extractMessage(payload, res.status), res.status, payload)
  }

  // Prefer the server's filename; fall back if the header isn't exposed.
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)

  return { blob: await res.blob(), filename: match ? decodeURIComponent(match[1]) : null }
}

/** Saves a Blob under `filename` using a temporary object URL. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick; revoking immediately can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const api = {
  health: () => request('/health'),

  tailor: {
    status: () => request('/tailor/status'),
    generate: (body, signal) =>
      request('/tailor', { method: 'POST', body, signal }),
    /**
     * The same generation, reporting each phase as the server reaches it.
     *
     * `onPhase` is called with every event before the result — {phase, label}
     * plus whatever that phase carries. Resolves with the finished resume, or
     * throws an ApiError built from the stream's error event.
     *
     * Falls back to the plain endpoint on any transport that cannot stream
     * (no ReadableStream on the response, an older proxy that buffers it into
     * one chunk): the resume is what matters, the phases are the nicety.
     */
    generateStreaming: async (body, signal, onPhase) => {
      const res = await fetch(`${BASE_URL}/tailor/stream`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        // A failure before the stream starts is an ordinary HTTP error.
        let payload = null
        const text = await res.text()
        if (text) {
          try {
            payload = JSON.parse(text)
          } catch {
            payload = text
          }
        }
        throw new ApiError(extractMessage(payload, res.status), res.status, payload)
      }

      if (!res.body?.getReader) {
        return request('/tailor', { method: 'POST', body, signal })
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let result = null
      let failure = null

      // Events are newline-delimited, and a chunk can split one mid-line, so
      // the tail is held back until its newline arrives.
      const handle = (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let event
        try {
          event = JSON.parse(trimmed)
        } catch {
          return // A partial or malformed line is not worth failing over.
        }
        if (event.phase === 'done') result = event.result
        else if (event.phase === 'error') failure = event
        else onPhase?.(event)
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        lines.forEach(handle)
      }
      handle(buffer)

      if (failure) {
        throw new ApiError(failure.detail, failure.status, { detail: failure.detail })
      }
      if (!result) {
        throw new ApiError('The server closed the connection before finishing.', 502, null)
      }
      return result
    },
    get: (id) => request(`/tailor/${id}`),
    humanize: (id) => request(`/tailor/${id}/humanize`, { method: 'POST' }),
    docx: (id, version = 'auto') =>
      download(`/tailor/${id}/docx?version=${version}`),
  },

  // Read-only: rows are written by the backend when a .docx is downloaded.
  registry: {
    list: () => request('/registry'),
  },

  users: {
    list: (params = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
      ).toString()
      return request(`/users${qs ? `?${qs}` : ''}`)
    },
    options: (q) => request(`/users/options${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    get: (id) => request(`/users/${id}`),
    create: (data) => request('/users', { method: 'POST', body: data }),
    update: (id, data) => request(`/users/${id}`, { method: 'PATCH', body: data }),
    remove: (id) => request(`/users/${id}`, { method: 'DELETE' }),
    // Clears every sentence added with Insert, leaving the details the user
    // typed. Returns the updated user, so the caller can refill the form from
    // the server rather than guessing what is left.
    clearInserted: (id) => request(`/users/${id}/inserted`, { method: 'DELETE' }),
  },
}
