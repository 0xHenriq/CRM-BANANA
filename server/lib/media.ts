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
 * 200 MB.
 *
 * A phone-shot Reel is comfortably under this; a raw export is not, and she
 * should be sending the export rather than the master anyway. The 720p review
 * proxy that would make big files painless is v1.3.
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

export type ProcessedMedia = {
  kind: 'image' | 'video'
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

export async function processUpload(
  buf: Buffer,
  mime: string,
  prefix: string
): Promise<ProcessedMedia> {
  if (IMAGE_MIME[mime]) return processImage(buf, mime, prefix)
  if (VIDEO_MIME[mime]) return processVideo(buf, mime, prefix)
  throw new Error(`Unsupported file type: ${mime}`)
}

export function isAcceptedMime(mime: string): boolean {
  return Boolean(IMAGE_MIME[mime] || VIDEO_MIME[mime])
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
    return 'video/mp4'
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return 'video/webm'
  return null
}
