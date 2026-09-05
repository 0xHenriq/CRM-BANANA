import { Readable } from 'node:stream'
import { asc, eq, sql, desc } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { withTenant, type Tx } from '../db/index.js'
import {
  clients,
  contentAssets,
  contentItems,
  files,
  moodboardItems,
  invoices,
} from '../db/schema.js'
import { audit } from '../lib/audit.js'
import {
  IMAGE_MIME,
  MAX_UPLOAD_BYTES,
  isAcceptedDocumentMime,
  isAcceptedMime,
  isImageMime,
  processUpload,
  UnreadableMediaError,
  sniffDocumentMime,
  sniffMime,
} from '../lib/media.js'
import { isUuid, resolveClientId } from '../lib/resolve-client.js'

import { logger } from '../logger.js'
import { storage } from '../lib/storage.js'
import { requireAuth, requireStaff } from '../middleware/session.js'

export const mediaRoutes = new Hono()

mediaRoutes.use('*', requireAuth)

/**
 * Headroom for the multipart envelope — boundaries, headers, the other form
 * fields — when comparing `Content-Length` against a per-file limit. Without
 * it a file exactly on the limit is refused for the few hundred bytes of
 * wrapper around it.
 */
const MULTIPART_SLACK_BYTES = 1024 * 1024

/**
 * A size a person can act on.
 *
 * `(bytes / 1024 / 1024).toFixed(0)` produced "That file is 1024 MB. The limit
 * is 1024 MB." for a file nine bytes over the ceiling — technically true and
 * completely useless, because it names the same number twice and leaves her
 * with no idea by how much to trim.
 *
 * Rounding UP rather than to nearest is what actually fixes it. Two decimals
 * alone still collapsed 1 GB and 1 GB + 9 bytes to the same "1.00 GB", because
 * the difference is nine parts in a billion. Ceiling makes any size above the
 * limit render strictly larger than the limit does, and it is the honest
 * direction for this message: the file is at least this big, which is exactly
 * the fact being complained about.
 */
export function humanSize(bytes: number): string {
  const ceilTo = (value: number, places: number) => {
    const scale = 10 ** places
    return Math.ceil(value * scale) / scale
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${ceilTo(bytes / 1024 / 1024 / 1024, 2).toFixed(2)} GB`
  }
  return `${ceilTo(bytes / 1024 / 1024, 0)} MB`
}

const UPLOAD_LIMIT_LABEL = humanSize(MAX_UPLOAD_BYTES)

/**
 * Every storage key the row that was just written actually points at.
 *
 * `processUpload` produces up to three objects — the original, a thumbnail, a
 * poster — and the different targets keep different subsets of them. Anything
 * it produced that the row does not name is referenced by nothing, and this is
 * how that set is worked out: read off the RETURNED ROW, so the answer is what
 * was stored rather than a second guess at what should have been.
 *
 * Each target discards something different, which is why guessing does not
 * work:
 *
 *   content asset  keeps all three
 *   File Folder    keeps the original; `files` has no thumbnail column at all
 *   moodboard tile keeps the thumbnail, or the original when there is none
 *   logo           keeps the thumbnail, and a video never gets here
 *
 * Two earlier attempts at this were both too narrow. The first tested the
 * request's `target` string, and the insert falls through to a moodboard tile
 * for any target it does not recognise. The second asked only whether the
 * thumbnail had been stored, and so never noticed that a video in the File
 * Folder abandons its poster and an image in the File Folder abandons its
 * thumbnail — 11 stray files in one pass over the upload matrix.
 */
export function keysReferencedBy(result: object | null | undefined): string[] {
  if (!result) return []

  const keys: string[] = []
  for (const value of Object.values(result)) {
    // `replaced` is a bare string, and is removed separately — it belongs to
    // the logo this upload superseded, not to the row just written.
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    /*
     * Every column in this codebase that holds a storage key.
     *
     * This list is the one thing standing between a committed row and its
     * bytes being deleted as unreferenced. Adding a key column WITHOUT adding
     * it here means the cleanup below cannot see the reference and removes the
     * object the row points at — verified the moment `fullKey` was added for
     * moodboard originals: the upload succeeded, the row pointed at a file,
     * and the file was gone before the response was sent.
     */
    for (const field of [
      'storageKey',
      'thumbKey',
      'posterKey',
      'logoKey',
      'fullKey',
    ]) {
      const key = row[field]
      if (typeof key === 'string' && key) keys.push(key)
    }
  }
  return keys
}


/* ------------------------------------------------------------------ upload */

/**
 * Uploads land here, are validated, processed, and attached to something.
 *
 * `target` decides what the asset becomes: an asset on a content item, a
 * moodboard tile, or a file in the folder. One pipeline rather than three,
 * because the validation is the part that must not diverge.
 */
mediaRoutes.post('/upload', requireStaff, async (c) => {
  /**
   * Refuse an oversized upload from its declared length, before the body is
   * touched.
   *
   * `parseBody()` reads the entire request into memory, so the `file.size`
   * check further down — which is where this used to happen, under a comment
   * claiming it ran first — only fires once the bytes are already buffered. A
   * declared length is a claim rather than a fact, so both checks stay: this
   * one keeps an honest client's 4 GB export out of the heap, and the one
   * below is what actually enforces the limit.
   */
  const declared = Number(c.req.header('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_SLACK_BYTES) {
    return c.json(
      {
        error: `That upload is ${humanSize(declared)}, over the ${UPLOAD_LIMIT_LABEL} limit.`,
      },
      413
    )
  }

  const form = await c.req.parseBody().catch(() => null)
  if (!form) return c.json({ error: 'Expected a multipart upload' }, 400)

  const file = form['file']
  if (!(file instanceof File)) {
    return c.json({ error: 'No file was attached' }, 400)
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json(
      {
        // One line: this string is rendered verbatim in a toast, and a stray
        // newline here once came out as a line break mid-sentence.
        error: `That file is ${humanSize(file.size)}, over the ${UPLOAD_LIMIT_LABEL} limit.`,
      },
      413
    )
  }

  const buf = Buffer.from(await file.arrayBuffer())

  const target = String(form['target'] ?? 'moodboard')
  const contentItemId = form['contentItemId']
    ? String(form['contentItemId'])
    : null
  const caption = form['caption'] ? String(form['caption']) : null
  /**
   * Fill an existing File Folder row rather than adding another one.
   *
   * Without it, uploading a signed agreement left the seeded "Agreement" slot
   * still reading "Empty slot" AND added a second row called
   * agreement-signed.pdf at the bottom — which is what she was describing when
   * she said the folder "doesn't allow uploads into here or to categorise what
   * it is". The named rows ARE the categories; they simply could not be
   * filled.
   */
  const fileId = form['fileId'] ? String(form['fileId']) : null
  /**
   * Attach this document to an invoice.
   *
   * Still `target=file`, deliberately. An invoice attachment IS a file: it
   * gets the same document allowlist, the same row shape, and the same File
   * Folder listing — which is what makes the folder show invoice PDFs without
   * a second copy of the bytes that could drift from the first.
   */
  const invoiceId = form['invoiceId'] ? String(form['invoiceId']) : null
  const name = file.name || 'Untitled'

  /**
   * Trust the bytes, not the browser.
   *
   * Content-Type comes from the file extension on the client's machine, so a
   * renamed file arrives claiming whatever the browser inferred. The magic
   * number is what actually decides.
   *
   * `target` widens the allowlist rather than replacing it. The File Folder
   * holds proposals, agreements and invoices, so it takes documents as well as
   * media; a content asset and a moodboard tile stay images and video, because
   * a PDF in the 3x3 feed grid is not a thing. Deciding this per target rather
   * than globally is what keeps the folder useful without letting a document
   * reach the feed.
   */
  const sniffed =
    sniffMime(buf) ??
    (target === 'file' ? sniffDocumentMime(buf, name) : null)

  const accepted =
    !!sniffed &&
    (isAcceptedMime(sniffed) ||
      (target === 'file' && isAcceptedDocumentMime(sniffed)))

  /**
   * A logo is an image, never a video.
   *
   * The general allowlist accepts MP4 for content and moodboard tiles, and a
   * client's mark rendered as an unplayable video tile in the corner of their
   * own portal would be a strange thing to have shipped.
   *
   * `isImageMime`, not `IMAGE_MIME`: the latter is the list of formats we
   * STORE, and HEIC, TIFF and SVG are accepted-and-converted rather than
   * stored. Checking the storage map here refused a logo we can handle —
   * which is exactly the shape of the bug this whole area keeps producing.
   */
  if (target === 'logo' && (!sniffed || !isImageMime(sniffed))) {
    return c.json(
      {
        error:
          'A logo needs to be an image — JPEG, PNG, SVG, WebP, GIF, AVIF, HEIC or TIFF.',
      },
      415
    )
  }

  if (!accepted) {
    /**
     * Say what was refused, in the log as well as to her.
     *
     * A 415 used to leave no trace at all: the request line said 415 and
     * nothing said what the file was, so answering "why did my upload fail"
     * meant reconstructing it from the timestamps of the requests around it.
     * The first bytes are what the decision was actually made on, so they are
     * what gets recorded.
     */
    logger.warn(
      {
        target,
        filename: name,
        sizeBytes: file.size,
        sniffed,
        head: buf.subarray(0, 12).toString('hex'),
      },
      'upload refused: unsupported file type'
    )

    return c.json(
      {
        error:
          target === 'file'
            ? `“${name}” is not a file type we support. PDF, Word, Excel, PowerPoint, CSV and plain text are, along with images and video.`
            : `“${name}” is not an image or a video we can handle. JPEG, PNG, SVG, WebP, GIF, AVIF, HEIC, TIFF, MP4, MOV and WebM are supported.`,
      },
      415
    )
  }

  /**
   * Which workspace these bytes belong to.
   *
   * For a content upload the item decides, NOT `?client=`. The two disagree
   * routinely: the review queue spans every workspace, so she opens an item
   * belonging to one client while another is selected — and the detail dialog
   * sends no `?client=` at all, which used to fall back to the alphabetically
   * first workspace. The asset row then carried the wrong `client_id`, and
   * since a client may only read child rows whose `client_id` is in their
   * grants, the client who owned the post could not see the image attached to
   * it. Staff saw it, she had no way to tell, and the client saw a post with
   * nothing on it.
   *
   * Reading it from the item also keeps the invariant the schema and the RLS
   * policies assume: a child row's `client_id` always equals its parent's.
   */
  let clientId: string | null
  if (target === 'content') {
    if (!contentItemId) {
      return c.json({ error: 'contentItemId is required' }, 400)
    }
    if (!isUuid(contentItemId)) {
      return c.json({ error: 'That content item does not exist' }, 404)
    }
    const [item] = await withTenant(c.get('tenant'), (tx) =>
      tx
        .select({ clientId: contentItems.clientId })
        .from(contentItems)
        .where(eq(contentItems.id, contentItemId))
        .limit(1)
    )
    if (!item) return c.json({ error: 'That content item does not exist' }, 404)
    clientId = item.clientId
  } else if (target === 'file' && invoiceId) {
    // The invoice decides the workspace, for the same reason the content item
    // does: a child row's client_id must equal its parent's.
    if (!isUuid(invoiceId)) {
      return c.json({ error: 'That invoice does not exist' }, 404)
    }
    if (fileId) {
      return c.json(
        {
          error:
            'Send either a file slot or an invoice, not both — an attachment belongs to one or the other.',
        },
        400
      )
    }
    const [inv] = await withTenant(c.get('tenant'), (tx) =>
      tx
        .select({ clientId: invoices.clientId })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1)
    )
    if (!inv) return c.json({ error: 'That invoice does not exist' }, 404)
    clientId = inv.clientId
  } else if (target === 'file' && fileId) {
    /*
     * Same rule, same reason: the ROW decides, not `?client=`.
     *
     * Filling a slot writes the bytes into a per-client directory, and taking
     * that directory from the query string let the two disagree — verified by
     * sending one client's fileId with another's `?client=`: the row stayed
     * with its rightful owner (RLS saw to that) while its bytes were written
     * under the other client's prefix. Nobody could reach data they should
     * not, but the storage layout then lied about who a file belonged to, and
     * anything walking those directories would mis-attribute it.
     */
    if (!isUuid(fileId)) {
      return c.json({ error: 'That file slot does not exist' }, 404)
    }
    const [row] = await withTenant(c.get('tenant'), (tx) =>
      tx
        .select({ clientId: files.clientId })
        .from(files)
        .where(eq(files.id, fileId))
        .limit(1)
    )
    if (!row) return c.json({ error: 'That file slot does not exist' }, 404)
    clientId = row.clientId
  } else {
    clientId = await resolveClientId(c)
  }
  if (!clientId) return c.json({ error: 'No workspace selected' }, 400)

  /**
   * A file we recognise is not necessarily a file we can read.
   *
   * This call sits OUTSIDE the try below, so anything it threw reached the
   * global handler as a 500 "Internal server error". That was near-unreachable
   * while every accepted format was stored as-sent — the only throw was an
   * unsupported mime, which the check above has already excluded. It stopped
   * being unreachable the moment HEIC, TIFF and SVG began being DECODED here:
   * a truncated download, a HEIC variant libheif cannot open, or an SVG
   * librosvg refuses are all ordinary inputs now, and every one of them would
   * have told her the server was broken.
   *
   * Nothing is on disk when this fails — the conversion happens before the
   * first putBuffer — so there is nothing to clean up, only something to say.
   */
  let processed: Awaited<ReturnType<typeof processUpload>>
  try {
    processed = await processUpload(buf, sniffed, clientId)
  } catch (err) {
    /**
     * Only a failure to READ the file is her problem.
     *
     * Anything else — a full disk, a permissions fault, a missing upload
     * directory — is ours, and rethrowing keeps it a 500 rather than telling
     * her a perfectly good photo may be damaged and sending her looking for a
     * fault that is not hers.
     */
    if (!(err instanceof UnreadableMediaError)) throw err

    logger.warn(
      { err, target, filename: name, sizeBytes: file.size, sniffed },
      'upload refused: recognised but could not be read'
    )
    return c.json(
      {
        error: `“${name}” could not be read. It may be damaged, or a variant of ${sniffed} we cannot open — try exporting it as a JPEG or PNG.`,
      },
      415
    )
  }

  const actorId = c.get('user')?.id ?? null


  try {
    const result = await withTenant(c.get('tenant'), async (tx) => {
      // In the same transaction as the row it describes, per lib/audit.ts:
      // this used to run in a second transaction afterwards, so a failure
      // here landed in the catch below, deleted bytes that a committed row
      // still pointed at, and reported a 400 for an upload that had actually
      // succeeded.
      await audit(tx, {
        actorId,
        action: 'media.upload',
        entity: target,
        meta: { clientId, mime: processed.mime, bytes: processed.sizeBytes },
      })

      if (target === 'content') {

        if (!contentItemId) throw new Error('contentItemId is required')

        // Unreachable: sniffDocumentMime is only consulted for target=file, so
        // a document cannot get this far. Asserted rather than cast because
        // content_assets.kind is an image|video enum, and the one way to end
        // up writing a PDF into the feed grid is for a future edit to widen
        // the sniff and for this to be a silent `as` instead of a check.
        if (processed.kind === 'document') {
          throw new Error('A document cannot be attached to a content item')
        }

        const [item] = await tx
          .select({ id: contentItems.id })
          .from(contentItems)
          .where(eq(contentItems.id, contentItemId))
          .limit(1)
        if (!item) throw new Error('That content item does not exist')

        // Append, rather than every asset landing on sortOrder 0 — which
        // made "the item's first asset" ambiguous and duplicated the item in
        // the feed grid, once per asset.
        const [{ nextOrder }] = await tx
          .select({
            nextOrder: sql<number>`coalesce(max(sort_order), -1) + 1`,
          })
          .from(contentAssets)
          .where(eq(contentAssets.contentItemId, contentItemId))

        const [row] = await tx
          .insert(contentAssets)
          .values({
            clientId,
            contentItemId,
            sortOrder: nextOrder,
            kind: processed.kind,
            storageKey: processed.storageKey,
            thumbKey: processed.thumbKey,
            posterKey: processed.posterKey,
            durationMs: processed.durationMs,
            width: processed.width,
            height: processed.height,
            mime: processed.mime,
            sizeBytes: processed.sizeBytes,
            uploadedBy: actorId,
          })
          .returning()
        return { asset: row }
      }

      if (target === 'file') {
        if (fileId) {
          // Re-read inside the transaction for the key being superseded. The
          // row's existence and its client were settled above, before any
          // bytes were written.
          const [before] = await tx
            .select({ id: files.id, storageKey: files.storageKey })
            .from(files)
            .where(eq(files.id, fileId))
            .limit(1)
          if (!before) throw new Error('That file slot does not exist')

          const [row] = await tx
            .update(files)
            .set({
              storageKey: processed.storageKey,
              mime: processed.mime,
              sizeBytes: processed.sizeBytes,
              uploadedBy: actorId,
            })
            .where(eq(files.id, fileId))
            .returning()

          // The row's NAME is deliberately untouched: the whole point is that
          // "Agreement" stays called Agreement when the signed PDF lands in
          // it. `replaced` frees the bytes of anything it superseded, using
          // the same post-commit path a replaced logo uses.
          return { file: row, replaced: before.storageKey }
        }

        /*
         * One document per invoice, so "Replace PDF" replaces.
         *
         * Without this it INSERTED, and attaching twice left two rows on one
         * invoice: the invoice showed the newer, while the older stayed in the
         * client's File Folder carrying superseded figures with nothing on the
         * invoice to say it existed. The button said Replace and did not.
         *
         * Newest first, so if a workspace already carries duplicates from
         * before this existed, the one being replaced is the one on screen.
         */
        if (invoiceId) {
          const [existing] = await tx
            .select({ id: files.id, storageKey: files.storageKey })
            .from(files)
            .where(eq(files.invoiceId, invoiceId))
            .orderBy(desc(files.createdAt))
            .limit(1)

          if (existing) {
            const [row] = await tx
              .update(files)
              .set({
                // The NAME does move here, unlike a named slot: an invoice
                // attachment is called after the document, not after a
                // category, so replacing it should say what it now is.
                name,
                storageKey: processed.storageKey,
                mime: processed.mime,
                sizeBytes: processed.sizeBytes,
                uploadedBy: actorId,
              })
              .where(eq(files.id, existing.id))
              .returning()
            return { file: row, replaced: existing.storageKey }
          }
        }

        const [row] = await tx
          .insert(files)
          .values({
            clientId,
            name,
            storageKey: processed.storageKey,
            mime: processed.mime,
            sizeBytes: processed.sizeBytes,
            uploadedBy: actorId,
            // Set only for an invoice attachment. It is what makes the row
            // inherit the invoice's visibility — a document on a DRAFT stays
            // hidden from the client, though `files` is otherwise
            // client-visible. See migration 0018.
            invoiceId,
            sortOrder: 999,
          })
          .returning()
        return { file: row }
      }

      /**
       * A client's own mark, shown on their portal.
       *
       * Stored as the 400px thumbnail rather than the original: it is rendered
       * at 40px and nobody needs a 4 MB PNG for that. The PREVIOUS logo's
       * bytes are removed after the transaction commits — replacing a logo
       * five times should not leave five files nothing references.
       */
      if (target === 'logo') {
        if (processed.kind !== 'image') {
          throw new Error('A logo needs to be an image')
        }
        const [before] = await tx
          .select({ logoKey: clients.logoKey })
          .from(clients)
          .where(eq(clients.id, clientId))
          .limit(1)
        if (!before) throw new Error('That client does not exist')

        const [row] = await tx
          .update(clients)
          .set({
            logoKey: processed.thumbKey ?? processed.storageKey,
            updatedAt: new Date(),
          })
          .where(eq(clients.id, clientId))
          .returning({ id: clients.id, logoKey: clients.logoKey })

        return { client: row, replaced: before.logoKey }
      }

      // Moodboard tiles append to the end.
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(sort_order), -1) + 1` })
        .from(moodboardItems)
        .where(eq(moodboardItems.clientId, clientId))

      const [row] = await tx
        .insert(moodboardItems)
        .values({
          clientId,
          // The 400px tile the grid renders...
          storageKey: processed.thumbKey ?? processed.storageKey,
          // ...and the original, which is what clicking a tile opens. Kept
          // only when a thumbnail was actually produced — otherwise the two
          // would be the same object and deleting would try to remove it twice.
          fullKey: processed.thumbKey ? processed.storageKey : null,
          caption,
          sortOrder: next,
        })
        .returning()
      return { moodboardItem: row }
    })

    /**
     * Everything from here runs AFTER the commit, and is wrapped in its own
     * try so it can never reach the catch below.
     *
     * That catch deletes the uploaded bytes and answers 400. A failure while
     * tidying up a superseded file would therefore delete the bytes a
     * committed row still points at, and report failure for an upload that
     * worked — which the comment on the audit write above records as having
     * already happened once, in this handler. The upload succeeded; failing to
     * remove a byproduct is waste, and waste must not be reported as failure.
     */
    try {
      // A replaced logo's bytes. Replacing a mark five times should not leave
      // five files nothing references.
      if (result && 'replaced' in result && result.replaced) {
        await storage.remove(result.replaced)
      }

      /*
       * Whatever was produced and is not pointed at by the row now goes.
       *
       * Subtracting from what the row references, rather than naming the
       * cases, is what makes this correct for all four targets — including
       * the ones where the discarded object is the poster or the thumbnail
       * rather than the original.
       */
      const kept = new Set(keysReferencedBy(result))
      const produced = [
        processed.storageKey,
        processed.thumbKey,
        processed.posterKey,
      ]

      /*
       * A row that references nothing is not a row that needs tidying up — it
       * is a shape this code did not understand.
       *
       * Every branch returns a row carrying at least one key, so an empty set
       * means a future branch returns something new. Acting on it would delete
       * every byte of a COMMITTED row and leave her with an image that cannot
       * be recovered. Keeping a few stray files is the recoverable mistake, so
       * that is the one to make.
       */
      if (kept.size === 0) {
        logger.warn(
          { result },
          'upload committed but referenced no stored key — leaving its bytes alone'
        )
      } else {
        for (const key of produced) {
          if (key && !kept.has(key)) await storage.remove(key)
        }
      }
    } catch (err) {
      logger.warn(
        { err, key: processed.storageKey },
        'upload committed, but superseded bytes could not be removed'
      )
    }

    return c.json(result, 201)
  } catch (err) {
    // The bytes are already on disk; if attaching them failed there is nothing
    // pointing at them, so clean up rather than leaving an orphan.
    await storage.remove(processed.storageKey)
    if (processed.thumbKey) await storage.remove(processed.thumbKey)
    if (processed.posterKey) await storage.remove(processed.posterKey)
    return c.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      400
    )
  }
})

/* --------------------------------------------------------------- streaming */

/**
 * Serves stored bytes, authorised per request.
 *
 * Deliberately NOT a signed path served by Caddy: Caddy has no `secure_link`
 * equivalent, so nothing would validate the signature. Routing bytes through
 * the app costs an event-loop tick on a box with sixteen idle cores and keeps
 * the RLS check on the path.
 *
 * The key is never taken from the request — it is read from a row the caller
 * is allowed to see. An id they may not see simply is not found.
 */
/**
 * A single byte range, resolved against the size of the thing being served.
 *
 * Exported for `server/__tests__/media.test.ts` — the arithmetic is the part
 * that goes wrong, and it is worth testing without a socket.
 *
 * Returns `null` when the caller did not ask for a range, or asked in a way
 * this handler does not implement (multi-range) — both of which mean "send
 * the whole representation", which is always a valid answer.
 */
export function parseRange(
  header: string | undefined,
  total: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null

  // `bytes=-500` means the LAST 500 bytes, not the first 501. Reading it as a
  // start of zero served the wrong part of the file with a Content-Range that
  // disagreed with the bytes in the body.
  if (!rawStart) {
    const wanted = Number(rawEnd)
    if (wanted === 0 || total === 0) return 'unsatisfiable'
    return { start: Math.max(0, total - wanted), end: total - 1 }
  }

  const start = Number(rawStart)
  if (start >= total) return 'unsatisfiable'

  // An end past the last byte is clamped rather than refused. A range that
  // starts inside the representation is satisfiable (RFC 9110 §14.1.1), and
  // players routinely ask for a fixed-size window — `bytes=0-1048575` against
  // a 300 KB poster — which the old `end >= total` test answered with a 416
  // the player treats as a broken file.
  const end = rawEnd ? Math.min(Number(rawEnd), total - 1) : total - 1
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

/**
 * RFC 6266 `filename*`, so a download keeps the name she gave it.
 *
 * The plain `filename=` parameter is a quoted ASCII string: a quote or a
 * backslash in the name breaks out of it, and anything non-ASCII — an em dash
 * in "Acme — Agreement.pdf", say — is not representable at all. Both forms are
 * emitted, the ASCII one scrubbed as a fallback for anything that cannot read
 * the encoded one.
 */
/**
 * What the browser should call this file when it saves it.
 *
 * A named File Folder slot is called "Agreement", not "agreement.pdf" — that
 * is the whole point of R17, and it is also how the download ended up offering
 * a file with NO EXTENSION, which macOS and Windows cannot open by
 * double-clicking. Before slots could be filled, an upload created a row named
 * after the file, so the problem arrived with the feature.
 *
 * The stored key carries the real extension (processUpload names it from the
 * sniffed type, not from what the browser claimed), so it is the honest source
 * — more so than the row's display name, which she can type anything into.
 *
 * Left alone when the name already ends in that extension, so
 * "INV-2026-014.pdf" does not become "INV-2026-014.pdf.pdf".
 */
export function downloadFilename(
  name: string,
  storageKey: string | null
): string {
  if (!storageKey) return name
  const dot = storageKey.lastIndexOf('.')
  const slash = storageKey.lastIndexOf('/')
  // A dot in the directory part is not an extension, a leading dot is not
  // either, and a TRAILING dot would append a bare "." to her filename.
  if (dot <= slash + 1 || dot === storageKey.length - 1) return name

  const ext = storageKey.slice(dot).toLowerCase()
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`
}

export function contentDisposition(filename: string): string {
  /**
   * encodeURIComponent is not quite RFC 5987.
   *
   * It deliberately leaves `!*'()~` alone, and of those only `!`, `~`, `-`,
   * `_` and `.` are valid attr-char. The apostrophe is the one that actually
   * bites: it is the delimiter in `UTF-8'<lang>'<value>`, so "Sofia's
   * Agreement.pdf" emitted `filename*=UTF-8''Sofia's%20Agreement.pdf` and a
   * strict parser is entitled to stop reading at that quote. An apostrophe in
   * a client's filename is not an edge case for a London agency.
   */
  const rfc5987 = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    )

  const scrubbed = filename.replace(/[^\w.\- ]+/g, '_').trim()
  // A name that is entirely non-ASCII — "документ.pdf", or a string of em
  // dashes — scrubs down to nothing but separators, and "_.pdf" is no more
  // useful to the person saving it than "download" is. Require at least one
  // alphanumeric before trusting the fallback; the RFC 6266 form below still
  // carries the real name for every browser of the last decade.
  const fallback = /[a-z0-9]/i.test(scrubbed) ? scrubbed : 'download'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(filename)}`
}

/**
 * Exported so the public share route can serve the same bytes the same way.
 *
 * Range handling, mime, disposition and nosniff all live here; a second copy
 * for share links would be a second place for a Content-Disposition rule to
 * be got wrong. parseRange and contentDisposition are already exported for
 * tests, so a third is in keeping.
 */
/**
 * A Node read stream as a REAL web stream, rather than a cast that says so.
 *
 * This was `stream as unknown as ReadableStream`, which type-checks by
 * assertion and works right up until the client goes away mid-body. Then
 * undici finishes the response it is holding and calls `close()` on a
 * controller that the abort already closed:
 *
 *   TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is already
 *   closed   at ReadableByteStreamController.close (node:internal/webstreams…)
 *
 * It is thrown from a microtask with no request context around it, so it is an
 * UNCAUGHT EXCEPTION and the process exits — every other request in flight
 * dies with it, and systemd restarts into a cold pool. Observed here on a
 * 935ms asset response whose browser was closed while it was being written;
 * the everyday version is somebody scrubbing a video and navigating away,
 * which is exactly what range requests exist to support.
 *
 * `Readable.toWeb` builds the stream Node intends: cancelling it destroys the
 * file handle, and there is no second close to race. The double `as unknown
 * as` was the tell — a cast that has to go through `unknown` is a cast that
 * knows it is wrong.
 *
 * HONESTLY: this removes the mechanism the stack trace names, and it is not
 * proven against the crash. The failure was seen once and would not reproduce
 * — 40 aborted downloads of a 5.8 MB original and 14 throttled browser
 * teardowns mid-body left the process up on the OLD code as well. What IS
 * verified is that the response is unchanged: the full body hashes identically
 * to the file on disk, and a Range request still answers 206 with a slice that
 * matches the same offsets of that body. Treat a recurrence as this bug still
 * being open rather than as a new one.
 */
function webStream(node: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(node as Readable) as ReadableStream
}

export async function streamKey(
  c: Context,
  key: string,
  mime: string | null,
  /**
   * Set for File Folder downloads.
   *
   * These are arbitrary uploaded documents served from the application's own
   * origin, so rendering one inline would run it there — an uploaded .html or
   * .svg becomes stored XSS against a signed-in session, with the session
   * cookie in scope. `attachment` makes the browser save rather than render,
   * and `nosniff` stops it second-guessing the declared type. Images, video
   * and posters are unaffected: they must render inline, and their types are
   * fixed by magic-number sniffing rather than taken from the request.
   */
  download?: { filename: string }
) {
  /**
   * A row whose bytes are gone is NOT FOUND, not a server fault.
   *
   * `storage.size` raises ENOENT, which reached the error handler as a 500
   * with a stack trace — so a single dangling `storage_key` filled the log
   * with the shape of a real incident, and the browser was told the server
   * had broken when the honest answer is that the file is absent. A row can
   * outlive its bytes: a database restored from a dump taken after the last
   * uploads snapshot has exactly this state, and it is a recoverable one.
   */
  let total: number
  try {
    total = await storage.size(key)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    logger.warn({ key }, 'stored object is missing from disk')
    return c.json({ error: 'Not found' }, 404)
  }

  const extra: Record<string, string> = download
    ? {
        'Content-Disposition': contentDisposition(download.filename),
        'X-Content-Type-Options': 'nosniff',
      }
    : {}

  // Range support is what makes video seekable; without it Safari refuses to
  // play at all.
  const range = parseRange(c.req.header('range'), total)

  if (range === 'unsatisfiable') {
    return c.body(null, 416, { 'Content-Range': `bytes */${total}` })
  }

  if (range) {
    const { start, end } = range
    return c.body(webStream(storage.read(key, { start, end })), 206, {
      ...extra,
      'Content-Type': mime ?? 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    })
  }


  return c.body(webStream(storage.read(key)), 200, {
    ...extra,
    'Content-Type': mime ?? 'application/octet-stream',
    'Content-Length': String(total),
    'Accept-Ranges': 'bytes',
    // Private: these are one client's images, and a shared cache must not
    // hold them.
    'Cache-Control': 'private, max-age=3600',
  })
}

/**
 * Exported so the PUBLIC share route parses the same three names.
 *
 * A second copy is how the two routes come to disagree about what `poster`
 * means, and they must not: the grid she looks at and the grid she sends
 * resolve their bytes through this.
 */
export const variantSchema = z
  .enum(['original', 'thumb', 'poster'])
  .catch('original')

export type AssetVariant = z.infer<typeof variantSchema>

/**
 * Which stored object a variant resolves to, and what type it is.
 *
 * A pure function because it was written twice — once here and once, wrongly,
 * in the public share route, which ignored the variant entirely and always
 * returned `storage_key`. For a photo that reads as working. For a VIDEO it
 * hands an `<img>` an `video/mp4`, and every tile in a shared feed preview
 * renders as a broken image. Production's assets are all video, so that link
 * never worked for the account it was built for.
 *
 * The fallbacks matter and are the reason this is not two lines at each call
 * site: a video has no thumbnail, so `thumb` has to fall through to the poster
 * or the original rather than 404, and an image has no poster.
 */
export function assetVariantKey(
  asset: {
    storageKey: string
    thumbKey: string | null
    posterKey: string | null
    mime: string | null
  },
  variant: AssetVariant
): { key: string; mime: string | null } {
  const key =
    variant === 'thumb'
      ? (asset.thumbKey ?? asset.posterKey ?? asset.storageKey)
      : variant === 'poster'
        ? (asset.posterKey ?? asset.thumbKey ?? asset.storageKey)
        : asset.storageKey
  // A derived variant is always a webp; only the original keeps its own type.
  return { key, mime: key === asset.storageKey ? asset.mime : 'image/webp' }
}

mediaRoutes.get('/assets/:id', async (c) => {
  const variant = variantSchema.parse(c.req.query('variant'))

  const [asset] = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select()
      .from(contentAssets)
      .where(eq(contentAssets.id, c.req.param('id')))
      .limit(1)
  )
  if (!asset) return c.json({ error: 'Not found' }, 404)

  const { key, mime } = assetVariantKey(asset, variant)
  return streamKey(c, key, mime)
})

mediaRoutes.get('/moodboard/:id', async (c) => {
  const [row] = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select()
      .from(moodboardItems)
      .where(eq(moodboardItems.id, c.req.param('id')))
      .limit(1)
  )
  if (!row?.storageKey) return c.json({ error: 'Not found' }, 404)

  /*
   * `?full=1` serves the original; anything else serves the tile.
   *
   * One route rather than two, because both answer the same question — "the
   * image for this tile" — and RLS has already decided whether the caller may
   * have it. Falling back to the tile means a row uploaded before 0020 still
   * opens, showing what it always showed rather than a 404.
   */
  const wantsFull = c.req.query('full') === '1'
  const key = wantsFull ? (row.fullKey ?? row.storageKey) : row.storageKey
  return streamKey(c, key, 'image/webp')
})

/**
 * The content type for a stored image, from OUR extension.
 *
 * The logo is normally the derived webp, and hard-coding 'image/webp' was
 * nearly right — but processImage falls back to the ORIGINAL when sharp cannot
 * thumbnail a file, and it keeps the upload rather than failing it. In that
 * case the stored key is a .png or .gif, and serving it labelled as webp is a
 * lie the browser has to recover from by sniffing.
 *
 * Reading the extension is safe here precisely because we chose it: putBuffer
 * is given an ext derived from the SNIFFED mime, never from the uploaded
 * filename. An unrecognised extension is refused rather than guessed — this
 * only ever serves images.
 */
const EXT_IMAGE_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_MIME).map(([mime, ext]) => [ext, mime])
)

export function imageTypeForKey(key: string): string | null {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  return EXT_IMAGE_MIME[ext] ?? null
}

/**
 * A client's logo.
 *
 * Read from the row rather than taking a key from the URL, like every other
 * media route here — a caller who cannot see the client cannot see their mark.
 */
mediaRoutes.get('/clients/:id/logo', async (c) => {
  const [row] = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({ logoKey: clients.logoKey })
      .from(clients)
      .where(eq(clients.id, c.req.param('id')))
      .limit(1)
  )
  if (!row?.logoKey) return c.json({ error: 'Not found' }, 404)

  const mime = imageTypeForKey(row.logoKey)
  /*
   * A key we cannot type is treated as absent, not streamed as octet-stream.
   * streamKey sends nosniff, so an unidentified body renders as a BROKEN image
   * in the corner of her client's portal; a 404 makes the component fall back
   * to the initials, which looks deliberate. This should be unreachable — we
   * choose the extension ourselves — so it is the safe end of an impossible
   * case rather than an expected path.
   */
  if (!mime) return c.json({ error: 'Not found' }, 404)

  return streamKey(c, row.logoKey, mime)
})

mediaRoutes.get('/files/:id', async (c) => {
  const [row] = await withTenant(c.get('tenant'), (tx) =>
    tx.select().from(files).where(eq(files.id, c.req.param('id'))).limit(1)
  )
  if (!row?.storageKey) return c.json({ error: 'Not found' }, 404)
  return streamKey(c, row.storageKey, row.mime, {
    filename: downloadFilename(row.name, row.storageKey),
  })
})

/* --------------------------------------------------------------- moodboard */

mediaRoutes.get('/moodboard', async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace available' }, 404)

  const items = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select()
      .from(moodboardItems)
      .where(eq(moodboardItems.clientId, clientId))
      .orderBy(asc(moodboardItems.sortOrder))
  )
  return c.json({ clientId, items })
})

const reorderSchema = z.object({ ids: z.array(z.uuid()).max(500) })

mediaRoutes.patch('/moodboard/reorder', requireStaff, async (c) => {
  const parsed = reorderSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  await withTenant(c.get('tenant'), async (tx) => {
    // One statement per row, but inside a single transaction — a partial
    // reorder is worse than none.
    for (const [index, id] of parsed.data.ids.entries()) {
      await tx
        .update(moodboardItems)
        .set({ sortOrder: index })
        .where(eq(moodboardItems.id, id))
    }
  })

  return c.json({ ok: true })
})

mediaRoutes.delete('/moodboard/:id', requireStaff, async (c) => {
  const removed = await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(moodboardItems)
      .where(eq(moodboardItems.id, c.req.param('id')))
      .returning({
        storageKey: moodboardItems.storageKey,
        fullKey: moodboardItems.fullKey,
      })
  )
  if (!removed.length) return c.json({ error: 'Not found' }, 404)
  // BOTH keys. A tile holds the thumbnail and the original since 0020, and
  // removing only one is exactly the orphan this codebase already paid for.
  if (removed[0].storageKey) await storage.remove(removed[0].storageKey)
  if (removed[0].fullKey) await storage.remove(removed[0].fullKey)
  return c.json({ ok: true })
})

/* ------------------------------------------------------------ feed preview */

/**
 * The 3x3 grid.
 *
 * Derived from content items that have an asset, ordered by `feedOrder` where
 * she has arranged them and by schedule otherwise. In the prototype this was
 * nine independent text boxes holding image URLs, unconnected to anything.
 */
/**
 * One cell per content item, using its first asset.
 *
 * DISTINCT ON rather than a join on sortOrder = 0: assets are appended, so an
 * item whose first asset was deleted would otherwise vanish from the grid
 * entirely, and before sortOrder was assigned properly every item appeared
 * once per asset.
 *
 * Exported because the public share page renders the same grid, and a second
 * query for it diverged immediately: it left out the join, so items with no
 * creative appeared as blank tiles the client saw and she did not, and it
 * dropped `scheduled_time` from the ordering, so two posts on one day could
 * come out in a different order. A shared preview that shows something other
 * than the thing she looked at before sending it is worse than no preview.
 *
 * Takes a `tx` rather than a context, so it runs unchanged under a review
 * context — RLS narrows the rows, the SQL does not need to know.
 */
export type FeedCellRow = {
  itemId: string
  title: string
  type: string
  status: string
  /**
   * The latest decision, so the grid can carry the same traffic light as the
   * calendar and the Ideas Bank. Null under a review context by construction:
   * `content_approvals` has no review arm at all (migration 0016), so a share
   * link sees no decision history and every tile reads as undecided — which is
   * correct for someone who is being ASKED to decide.
   */
  lastDecision: 'approved' | 'changes_requested' | null
  scheduledAt: string | null
  scheduledTime: string | null
  feedOrder: number | null
  assetId: string
  assetKind: 'image' | 'video'
}

export function selectFeedCells(tx: Tx, clientId: string) {
  return tx.execute<FeedCellRow>(sql`
      select
        item_id       as "itemId",
        title,
        type,
        status,
        last_decision as "lastDecision",
        scheduled_at  as "scheduledAt",
        scheduled_time as "scheduledTime",
        feed_order    as "feedOrder",
        asset_id      as "assetId",
        asset_kind    as "assetKind"
      from (
        select distinct on (ci.id)
          ci.id            as item_id,
          ci.title         as title,
          ci.type          as type,
          ci.status        as status,
          (
            select ca2.decision from content_approvals ca2
             where ca2.content_item_id = ci.id
             order by ca2.decided_at desc
             limit 1
          )                as last_decision,
          ci.scheduled_at  as scheduled_at,
          ci.scheduled_time as scheduled_time,
          ci.feed_order    as feed_order,
          ca.id            as asset_id,
          ca.kind          as asset_kind
        from content_items ci
        join content_assets ca on ca.content_item_id = ci.id
        where ci.client_id = ${clientId}
        order by ci.id, ca.sort_order asc, ca.created_at asc
      ) first_assets
      order by feed_order asc nulls last,
               scheduled_at asc nulls last,
               scheduled_time asc nulls last
  `)
}

mediaRoutes.get('/feed', async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace available' }, 404)

  const result = await withTenant(c.get('tenant'), (tx) =>
    selectFeedCells(tx, clientId)
  )

  return c.json({ clientId, cells: result.rows })
})

const feedOrderSchema = z.object({ ids: z.array(z.uuid()).max(100) })

mediaRoutes.patch('/feed/reorder', requireStaff, async (c) => {
  const parsed = feedOrderSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  await withTenant(c.get('tenant'), async (tx) => {
    for (const [index, id] of parsed.data.ids.entries()) {
      await tx
        .update(contentItems)
        .set({ feedOrder: index })
        .where(eq(contentItems.id, id))
    }
  })

  return c.json({ ok: true })
})
