/**
 * Media uploads, kept out of `api.ts` on purpose.
 *
 * This module is the one place in `src/` that touches a browser-only API —
 * XMLHttpRequest — and `api.ts` is typechecked by the SERVER project as well,
 * because the contract test imports its money and vocabulary helpers from
 * there. That project's lib is ES2023 plus @types/node: `fetch` and `FormData`
 * exist there, `XMLHttpRequest` does not. Splitting this out keeps the shared
 * module compiling under both without widening the server's type environment
 * to include the DOM.
 */
import { ApiError } from './api'

/**
 * Uploads go as multipart, so this deliberately does not use `api.post` —
 * setting Content-Type by hand would omit the multipart boundary.
 *
 * XMLHttpRequest rather than fetch, for one reason: fetch cannot report upload
 * progress. At the old 200 MB ceiling that was survivable; at 1 GB it is not —
 * a large upload on an office connection takes minutes, and a button that sits
 * there saying nothing for that long is indistinguishable from the broken one
 * this replaced. `onProgress` is what turns waiting into waiting-with-a-reason.
 */
export async function uploadMedia(
  file: File,
  opts: {
    clientId: string | null
    target: 'content' | 'moodboard' | 'file' | 'logo'
    contentItemId?: string
    /** Fills an existing File Folder row instead of adding a new one. */
    fileId?: string
    caption?: string
    /** 0..1, or null once the bytes are sent and the server is working. */
    onProgress?: (fraction: number | null) => void
  }
): Promise<unknown> {
  const form = new FormData()
  form.append('file', file)
  form.append('target', opts.target)
  if (opts.contentItemId) form.append('contentItemId', opts.contentItemId)
  if (opts.fileId) form.append('fileId', opts.fileId)
  if (opts.caption) form.append('caption', opts.caption)

  const qs = opts.clientId ? `?client=${opts.clientId}` : ''

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/media/upload${qs}`)
    xhr.withCredentials = true

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total)
    }
    // Bytes are up; the server is now hashing, thumbnailing or probing. Null
    // rather than 1 so the UI can say "processing" instead of sitting at 100%.
    xhr.upload.onload = () => opts.onProgress?.(null)

    xhr.onload = () => {
      let body: { error?: string } | null
      try {
        body = JSON.parse(xhr.responseText) as { error?: string }
      } catch {
        // A proxy error page, or an empty body. There is no server message to
        // pass on, so the status-based fallback below is used instead.
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body)
        return
      }
      reject(
        new ApiError(body?.error ?? `Upload failed (${xhr.status})`, xhr.status)
      )
    }

    // A dropped connection, a proxy timeout, or the tab going offline. Status
    // is 0 here, so there is no server message to surface — say what happened.
    xhr.onerror = () =>
      reject(
        new ApiError(
          'The upload did not reach the server. Check your connection and try again.',
          0
        )
      )
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0))
    xhr.ontimeout = () =>
      reject(
        new ApiError(
          'The upload timed out. A very large file may need a steadier connection.',
          0
        )
      )

    xhr.send(form)
  })
}
