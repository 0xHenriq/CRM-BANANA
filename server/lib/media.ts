import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { localPath, storage } from './storage.js'
import { logger } from '../logger.js'

const run = promisify(execFile)

/** What we accept, and what we call it on disk. */
export const IMAGE_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

export const VIDEO_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

/**
 * Documents, accepted ONLY by the File Folder.
 *
 * The folder's whole job is proposals, agreements, invoices and reports, and
 * those are PDFs and Office files — so a pipeline that took images and video
 * only made "upload a file" impossible. A content asset or a moodboard tile is
 * a different thing: a PDF in the 3x3 feed grid is meaningless, so `target`
 * decides which of these maps applies rather than one global allowlist.
 */
export const DOCUMENT_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'text/csv': 'csv',
  'text/plain': 'txt',
}

/**
 * The OOXML part that identifies each Office format.
 *
 * docx/xlsx/pptx are all just zip archives — the PK signature alone cannot
 * tell them apart, and it cannot tell any of them from a plain .zip either.
 * The archive names one of these parts, and the central directory at the tail
 * lists it, so a substring scan settles it without unzipping anything.
 */
const OOXML_MARKERS: Record<string, string> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
}

const EXT_TO_DOCUMENT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
}

/**
 * HEIC/HEIF major brands — an iPhone's default photo format.
 *
 * Not accepted: sharp's prebuilt binaries decode AVIF but not HEIC, so these
 * would store as an unreadable original with no thumbnail. They are listed
 * only so `sniffMime` can refuse them rather than mistaking the container for
 * an MP4.
 */
const HEIF_IMAGE_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
])

/**
 * 1 GB.
 *
 * Raised from 200 MB because that was refusing real work: a shoot's raw export
 * or a long-form video lands well over it, and "the limit is 200 MB" is not an
 * answer when the file is the deliverable.
 *
 * The box has 62 GB of RAM and one agency using it, so buffering a file this
 * size is affordable — but it is buffered, not streamed, so this is the ceiling
 * at which that stays true. Going meaningfully beyond 1 GB means streaming
 * multipart straight to disk rather than through the heap.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024

export type ProcessedMedia = {
  /**
   * `document` deliberately widens this beyond content_assets.kind, which is a
   * Postgres enum of image|video. That mismatch is the point: it makes the
   * compiler refuse to let a PDF be written as a content asset, so documents
   * can only ever land in the File Folder.
   */
  kind: 'image' | 'video' | 'document'
  storageKey: string
  thumbKey: string | null
  posterKey: string | null
  width: number | null
  height: number | null
  durationMs: number | null
  mime: string
  sizeBytes: number
}

const THUMB_WIDTH = 400

/**
 * Images: store the original, derive a 400px webp thumbnail.
 *
 * The thumbnail is what the feed grid and moodboard render — nine full-size
 * phone photos on one screen is several megabytes for no benefit. `rotate()`
 * with no argument applies the EXIF orientation, without which portrait
 * photos from a phone appear sideways.
 */
async function processImage(
  buf: Buffer,
  mime: string,
  prefix: string
): Promise<ProcessedMedia> {
  const ext = IMAGE_MIME[mime] ?? 'bin'
  const original = await storage.putBuffer(buf, { prefix, ext })

  let width: number | null = null
  let height: number | null = null
  let thumbKey: string | null = null

  try {
    const image = sharp(buf, { failOn: 'none' }).rotate()
    const meta = await image.metadata()
    width = meta.width ?? null
    height = meta.height ?? null

    const thumb = await image
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer()
    const stored = await storage.putBuffer(thumb, { prefix, ext: 'webp' })
    thumbKey = stored.key
  } catch (err) {
    // A file we cannot thumbnail is still a file she uploaded. Keep the
    // original and let the UI fall back to it rather than failing the upload.
    logger.warn({ err, mime }, 'could not derive a thumbnail')
  }

  return {
    kind: 'image',
    storageKey: original.key,
    thumbKey,
    posterKey: null,
    width,
    height,
    durationMs: null,
    mime,
    sizeBytes: original.sizeBytes,
  }
}

/**
 * Video: store the original, probe it, and pull a single poster frame.
 *
 * Two of her five content types are Video and Reel, so a portal that cannot
 * hold a Reel is not usable. The poster is what makes video look native in the
 * feed grid; the 720p review proxy — so clients review 3 MB rather than 200 —
 * is deliberately v1.3.
 *
 * Both ffmpeg calls are synchronous with the request. On sixteen idle cores a
 * single seek-and-encode of one frame is well under a second; transcoding is
 * what needs a queue.
 */
async function processVideo(
  buf: Buffer,
  mime: string,
  prefix: string
): Promise<ProcessedMedia> {
  const ext = VIDEO_MIME[mime] ?? 'mp4'
  const original = await storage.putBuffer(buf, { prefix, ext })
  const source = localPath(original.key)

  let width: number | null = null
  let height: number | null = null
  let durationMs: number | null = null
  let posterKey: string | null = null

  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration',
        '-of', 'json',
        source,
      ],
      { timeout: 20_000 }
    )
    const probed = JSON.parse(stdout) as {
      streams?: { width?: number; height?: number }[]
      format?: { duration?: string }
    }
    width = probed.streams?.[0]?.width ?? null
    height = probed.streams?.[0]?.height ?? null
    const seconds = Number(probed.format?.duration)
    durationMs = Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
  } catch (err) {
    logger.warn({ err }, 'ffprobe failed; storing the video without metadata')
  }

  const tmp = join(tmpdir(), `bd-poster-${randomUUID()}.jpg`)
  try {
    // One second in, not frame zero — the first frame of a phone video is
    // very often black.
    await run(
      'ffmpeg',
      ['-y', '-ss', '1', '-i', source, '-frames:v', '1', '-q:v', '4', tmp],
      { timeout: 30_000 }
    )
    const poster = await sharp(tmp)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer()
    const stored = await storage.putBuffer(poster, { prefix, ext: 'webp' })
    posterKey = stored.key
  } catch (err) {
    logger.warn({ err }, 'could not extract a poster frame')
  } finally {
    await unlink(tmp).catch(() => {})
  }

  return {
    kind: 'video',
    storageKey: original.key,
    thumbKey: null,
    posterKey,
    width,
    height,
    durationMs,
    mime,
    sizeBytes: original.sizeBytes,
  }
}

/**
 * Documents are stored and nothing else.
 *
 * No thumbnail (sharp cannot render a PDF without a full PDFium build) and no
 * probe. A first-page preview is a nice-to-have that needs poppler on the
 * host; the folder is useful without it and the absence is visible rather than
 * broken — the row shows a file icon, a size and a download.
 */
async function processDocument(
  buf: Buffer,
  mime: string,
  prefix: string
): Promise<ProcessedMedia> {
  const ext = DOCUMENT_MIME[mime] ?? 'bin'
  const stored = await storage.putBuffer(buf, { prefix, ext })
  return {
    kind: 'document',
    storageKey: stored.key,
    thumbKey: null,
    posterKey: null,
    width: null,
    height: null,
    durationMs: null,
    mime,
    sizeBytes: stored.sizeBytes,
  }
}

export async function processUpload(
  buf: Buffer,
  mime: string,
  prefix: string
): Promise<ProcessedMedia> {
  if (IMAGE_MIME[mime]) return processImage(buf, mime, prefix)
  if (VIDEO_MIME[mime]) return processVideo(buf, mime, prefix)
  if (DOCUMENT_MIME[mime]) return processDocument(buf, mime, prefix)
  throw new Error(`Unsupported file type: ${mime}`)
}

export function isAcceptedMime(mime: string): boolean {
  return Boolean(IMAGE_MIME[mime] || VIDEO_MIME[mime])
}

/** Whether a document mime is one the File Folder will store. */
export function isAcceptedDocumentMime(mime: string): boolean {
  return Boolean(DOCUMENT_MIME[mime])
}

/** Lowercase extension without the dot, or '' when there is none. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Whether a buffer is plain UTF-8 text.
 *
 * CSV and TXT have no magic number, so nothing can identify them from bytes
 * alone. The extension is a claim; this is the check on it. A NUL byte means
 * binary — that is what stops a renamed executable being stored as "notes.txt"
 * — and the strict decode rejects anything that is not valid UTF-8.
 */
function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 64 * 1024)
  if (sample.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return true
  } catch {
    return false
  }
}

/**
 * What a document upload actually is.
 *
 * Same principle as sniffMime: trust the bytes. PDF and the OOXML formats are
 * identified from their content, and the filename is consulted only to
 * disambiguate zip containers and to authorise the two text formats that have
 * no signature at all. Returns null for anything unrecognised, which the route
 * turns into a 415 naming the formats she can send.
 */
export function sniffDocumentMime(
  buf: Buffer,
  filename: string
): string | null {
  const ext = extensionOf(filename)

  // %PDF- — the only document format with an unambiguous signature.
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf'
  }

  // PK\x03\x04 — a zip. Which Office format (if any) comes from the parts.
  if (
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  ) {
    const marker = OOXML_MARKERS[ext]
    if (!marker) return null
    // Scan as text; the part names are stored uncompressed in the headers and
    // again in the central directory, so a plain substring search finds them.
    const haystack = buf.toString('latin1')
    return haystack.includes(marker) ? EXT_TO_DOCUMENT_MIME[ext] : null
  }

  if ((ext === 'csv' || ext === 'txt') && looksLikeText(buf)) {
    return EXT_TO_DOCUMENT_MIME[ext]
  }

  return null
}

/**
 * What the bytes actually are, rather than what the upload claimed.
 *
 * A browser sets Content-Type from the file extension, so it is a hint from
 * the client and nothing more. Sniffing the magic number is what stops a
 * renamed executable being stored as image/png.
 */
export function sniffMime(buf: Buffer): string | null {
  const b = buf.subarray(0, 16)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  const ascii4 = b.subarray(4, 8).toString('ascii')
  const ascii12 = b.subarray(8, 12).toString('ascii')
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && ascii12.startsWith('WEBP'))
    return 'image/webp'
  if (ascii4 === 'ftyp') {
    if (ascii12.startsWith('qt')) return 'video/quicktime'
    if (ascii12.startsWith('avif') || ascii12.startsWith('mif1'))
      return 'image/avif'
    // HEIC shares the ISO base media container with MP4, so the catch-all
    // below classified an iPhone photo as video/mp4: it was stored as a
    // video, ffprobe found no stream, no poster frame came out, and the feed
    // rendered a tile nothing can play. Naming the brands turns that into the
    // 415 that tells her which formats to send instead.
    if (HEIF_IMAGE_BRANDS.has(ascii12.slice(0, 4))) return null
    return 'video/mp4'
  }

  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return 'video/webm'
  return null
}
