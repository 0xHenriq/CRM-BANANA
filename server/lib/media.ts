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
 * These share the ISO base media container with MP4, so without naming them
 * the `ftyp` catch-all below calls an iPhone photo `video/mp4`: it is stored
 * as a video, ffprobe finds no stream, no poster comes out, and the feed
 * renders a tile nothing can play.
 *
 * They were refused outright until now, because sharp cannot decode them —
 * verified across six real photos and every combination of `failOn` and
 * `unlimited`: the header parses but the pixels always fail with
 * "source: bad seek", since sharp's prebuilt libheif carries the AV1 decoder
 * for AVIF and no HEVC one. VPS4's ffmpeg 6.1 cannot open a HEIF at all.
 * They are decoded by libheif-js instead — see `heicToJpeg`.
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

/**
 * Image formats we accept but never STORE.
 *
 * IMAGE_MIME is the list of things that can sit on disk and be served back to
 * a browser. These three cannot: no browser but Safari renders HEIC, none
 * render TIFF, and an SVG served from our own origin is a script that runs
 * there. Each is converted on the way in, so everything downstream — the feed
 * grid, the logo endpoint, `imageTypeForKey` — keeps dealing only with formats
 * it already understands.
 *
 * The value is what the bytes become.
 */
const CONVERTED_IMAGE_MIME: Record<string, string> = {
  'image/heic': 'image/jpeg',
  'image/tiff': 'image/jpeg',
  // PNG, not JPEG: a logo is the common case and it needs its transparency.
  'image/svg+xml': 'image/png',
}

/** Every image mime we will take, whether or not it is one we store. */
export function isImageMime(mime: string): boolean {
  return Boolean(IMAGE_MIME[mime] || CONVERTED_IMAGE_MIME[mime])
}

/**
 * A file whose type we recognised and whose contents we could not read.
 *
 * Distinct from any other failure on purpose. A decode that fails is the
 * FILE's problem — a truncated download, a variant libheif will not open — and
 * the honest answer is 415 with something she can act on. A failure to write
 * the bytes afterwards is OUR problem and must stay a 500: telling her a
 * perfectly good photo "may be damaged" because the disk was full would send
 * her looking for a fault that is not hers.
 */
export class UnreadableMediaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'UnreadableMediaError'
  }
}

/** The longest edge a rasterised vector is given. Beyond this is waste. */
const SVG_RASTER_EDGE = 1024

/**
 * Rasterise a vector at a useful size, not at the size it happens to declare.
 *
 * A vector has no resolution, only a declared viewport, and brand marks
 * routinely declare a tiny one — a 24x24 icon is normal. Rendering at face
 * value gives a 24px PNG, and RESIZING that up afterwards just enlarges 24
 * pixels: the logo would arrive visibly blurry and look like our fault.
 *
 * So the density is raised instead, which makes librsvg draw the geometry at
 * the larger size rather than scaling a small bitmap. 72 is librsvg's default
 * and corresponds to the declared size, so the factor is simply how much
 * bigger we want it.
 */
async function rasteriseSvg(buf: Buffer): Promise<Buffer> {
  const probe = await sharp(buf).metadata()
  const edge = Math.max(probe.width ?? 0, probe.height ?? 0)

  // Never shrink a vector that already declares a large viewport, and never
  // ask librsvg for an absurd canvas if it declares a 1x1 one.
  const scale = edge > 0 ? Math.min(Math.max(SVG_RASTER_EDGE / edge, 1), 32) : 1

  return sharp(buf, { density: Math.round(72 * scale) })
    .resize({
      width: SVG_RASTER_EDGE,
      height: SVG_RASTER_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer()
}

/**
 * An iPhone photo, decoded.
 *
 * libheif-js rather than sharp or ffmpeg, and the reason is worth recording:
 * sharp's prebuilt libheif has the AV1 decoder (so AVIF works) and no HEVC
 * one, and VPS4's ffmpeg 6.1 predates HEIF support entirely — verified on both
 * machines. libheif-js is WebAssembly, which also means there is no native
 * module to rebuild on the host, so dev and production decode identically.
 *
 * A modern iPhone photo is a GRID of 512px HEVC tiles, which is what defeated
 * every other route: libheif assembles them, so this returns the whole
 * picture rather than one corner of it.
 */
async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  // Loaded on demand: the WASM bundle is several megabytes and most uploads
  // are not HEIC, so the boot cost is not worth paying up front.
  const { default: libheif } = await import('libheif-js/wasm-bundle.js')

  const images = new libheif.HeifDecoder().decode(buf)
  const image = images?.[0]
  if (!image) throw new UnreadableMediaError('That photo could not be read.')

  const width = image.get_width()
  const height = image.get_height()
  if (!width || !height)
    throw new UnreadableMediaError('That photo could not be read.')

  /**
   * `display` applies the container's rotation. Do not "correct" this.
   *
   * A phone stores the sensor buffer landscape with an `irot` property saying
   * how to turn it, and the two obvious ways of checking disagree: `sips -g
   * pixelWidth` reports the ROTATED size while `sips -s format png` exports
   * the UNROTATED buffer. Comparing our output's dimensions against the first
   * makes a correct decode look transposed, and acting on that would rotate
   * every photo ninety degrees. Compared as pictures rather than as numbers,
   * this is the one that comes out upright.
   */
  const raw = { data: Buffer.alloc(width * height * 4), width, height }
  await new Promise<void>((resolve, reject) => {
    image.display(raw, (result) =>
      result
        ? resolve()
        : reject(new UnreadableMediaError('That photo could not be read.'))
    )
  })

  // Quality 88 rather than the default 80: this JPEG replaces the original
  // she uploaded, so it is the only copy and should not visibly lose anything.
  return sharp(raw.data, { raw: { width, height, channels: 4 } })
    .jpeg({ quality: 88 })
    .toBuffer()
}

/**
 * Convert anything we accept but cannot serve into something we can.
 *
 * Runs before processUpload picks a pipeline, so processImage only ever sees a
 * format it can both thumbnail and hand back to a browser.
 */
async function toStorableImage(
  buf: Buffer,
  mime: string
): Promise<{ buf: Buffer; mime: string }> {
  const target = CONVERTED_IMAGE_MIME[mime]
  if (!target) return { buf, mime }

  try {
    return await convertImage(buf, mime, target)
  } catch (err) {
    // Only the decode is wrapped. Storage happens after this returns, so a
    // disk fault keeps its own identity and its own status code.
    throw new UnreadableMediaError(
      err instanceof UnreadableMediaError
        ? err.message
        : 'That file could not be read.',
      { cause: err }
    )
  }
}

async function convertImage(
  buf: Buffer,
  mime: string,
  target: string
): Promise<{ buf: Buffer; mime: string }> {
  if (mime === 'image/heic') {
    return { buf: await heicToJpeg(buf), mime: target }
  }

  if (mime === 'image/svg+xml') {
    return { buf: await rasteriseSvg(buf), mime: target }
  }

  /**
   * TIFF, which sharp reads natively — but not always to a JPEG.
   *
   * JPEG has no alpha channel, so a transparent region flattens to BLACK.
   * Verified: a TIFF of a mark on a transparent ground came out as that mark
   * in a black box, which on a client's portal reads as a broken image rather
   * than as a logo. A scan or a print export is the common case and JPEG is
   * right for it; a designer's layered export is the case that has alpha, and
   * for that PNG keeps what was sent.
   */
  const meta = await sharp(buf).metadata()
  if (meta.hasAlpha) {
    return { buf: await sharp(buf).png().toBuffer(), mime: 'image/png' }
  }
  return { buf: await sharp(buf).jpeg({ quality: 88 }).toBuffer(), mime: target }
}

export async function processUpload(
  buf: Buffer,
  mime: string,
  prefix: string
): Promise<ProcessedMedia> {
  if (VIDEO_MIME[mime]) return processVideo(buf, mime, prefix)
  if (DOCUMENT_MIME[mime]) return processDocument(buf, mime, prefix)

  if (isImageMime(mime)) {
    const storable = await toStorableImage(buf, mime)
    return processImage(storable.buf, storable.mime, prefix)
  }

  throw new Error(`Unsupported file type: ${mime}`)
}

export function isAcceptedMime(mime: string): boolean {
  return Boolean(isImageMime(mime) || VIDEO_MIME[mime])
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
  if (ascii4 === 'ftyp') return sniffIsoBrand(buf)

  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return 'video/webm'

  // TIFF, in both byte orders. A scan or a print-ready export arrives as one,
  // and no browser renders it — sharp can, so it is converted like HEIC.
  if (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)
  ) {
    return 'image/tiff'
  }

  if (looksLikeSvg(buf)) return 'image/svg+xml'

  return null
}

/**
 * What an ISO base media file actually is, from all of its brands.
 *
 * MP4, MOV, HEIC and AVIF share this container, and the MAJOR brand alone does
 * not settle it. `mif1` and `msf1` are the generic HEIF brands: they say "a
 * HEIF image" and leave the codec to the compatible brands that follow. The
 * previous test read the major brand only and answered AVIF for those, so a
 * generic HEIF carrying HEVC was stored with a `.avif` extension — a file no
 * browser can render, with no thumbnail, no error, and nothing in the log.
 *
 * Verified against real files: an iPhone HEIC is major `heic` with compatible
 * `mif1 MiHB MiHE MiPr miaf heic tmap`, and an AVIF is major `avif` with
 * compatible `mif1 avif miaf`. Both list `mif1`, which is exactly why the
 * order below matters — AVIF has to be decided before anything looks at the
 * generic brand.
 */
const FTYP_SCAN_LIMIT = 16 + 64 * 4

function sniffIsoBrand(buf: Buffer): string {
  const major = buf.subarray(8, 12).toString('ascii')

  /*
   * 4 bytes of box size, 'ftyp', the major brand, a minor version, then the
   * compatible brands to the end of the box. A size we cannot trust simply
   * yields fewer brands, which degrades to deciding on the major one.
   *
   * Capped, and not as a nicety: the size is a number out of the file, and
   * this runs over a buffer that may be a 1 GB video. Trusting a corrupt or
   * hostile length would walk the whole upload four bytes at a time. A real
   * ftyp box carries a handful of brands — an iPhone HEIC has seven.
   */
  const boxSize = buf.readUInt32BE(0)
  const end = Math.min(boxSize, buf.length, FTYP_SCAN_LIMIT)
  const brands = new Set<string>([major])
  for (let at = 16; at + 4 <= end; at += 4) {
    brands.add(buf.subarray(at, at + 4).toString('ascii'))
  }

  // QuickTime writes 'qt  '.
  if (major.startsWith('qt')) return 'video/quicktime'

  // Before the HEIF checks, because an AVIF's compatible brands include mif1.
  if (brands.has('avif') || brands.has('avis')) return 'image/avif'

  // HEVC-coded stills, and the generic HEIF brands that name no codec at all.
  // libheif decodes whichever of the two it turns out to be, so pointing the
  // ambiguous case at it is the safe direction.
  for (const brand of brands) {
    if (HEIF_IMAGE_BRANDS.has(brand)) return 'image/heic'
  }
  if (major === 'mif1' || major === 'msf1') return 'image/heic'

  return 'video/mp4'
}

/**
 * Whether a buffer is an SVG document.
 *
 * SVG has no magic number — it is XML — so this is a shape check rather than a
 * signature. It must be tight in one direction specifically: an uploaded HTML
 * file is a stored-XSS vector, so the opening token has to be `<?xml` or
 * `<svg` and never `<!doctype html`. A `<svg>` buried inside an HTML document
 * does not match, which is the point.
 *
 * Nothing is served from these bytes either way — an SVG is rasterised on
 * ingest and the original is discarded, so a false positive costs a failed
 * render, not an execution.
 */
function looksLikeSvg(buf: Buffer): boolean {
  // A BOM, then whitespace, then the first token. 4 KB is generous room for
  // an XML declaration, a doctype and a comment header before <svg appears.
  // The BOM is written as an escape, never as a literal: a byte-order mark
  // pasted into source is invisible in every editor and lint refuses it.
  const head = buf
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (!head.startsWith('<?xml') && !head.startsWith('<svg')) return false
  return /<svg[\s>]/i.test(head)
}
