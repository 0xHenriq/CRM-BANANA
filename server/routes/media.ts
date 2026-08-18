import { asc, eq, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import {
  contentAssets,
  contentItems,
  files,
  moodboardItems,
} from '../db/schema.js'
import { audit } from '../lib/audit.js'
import {
  MAX_UPLOAD_BYTES,
  isAcceptedMime,
  processUpload,
  sniffMime,
} from '../lib/media.js'
import { isUuid, resolveClientId } from '../lib/resolve-client.js'

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
        error: `That upload is ${(declared / 1024 / 1024).toFixed(0)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
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
        // One line: this string is rendered verbatim in a toast, and the stray
        // newline that used to sit after "That file is" came out as a line
        // break mid-sentence.
        error: `That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      },
      413
    )
  }

  const buf = Buffer.from(await file.arrayBuffer())

  /**
   * Trust the bytes, not the browser.
   *
   * Content-Type comes from the file extension on the client's machine, so a
   * renamed file arrives claiming whatever the browser inferred. The magic
   * number is what actually decides.
   */
  const sniffed = sniffMime(buf)
  if (!sniffed || !isAcceptedMime(sniffed)) {
    return c.json(
      {
        error:
          'That does not look like an image or a video we can handle. JPEG, PNG, WebP, GIF, AVIF, MP4, MOV and WebM are supported.',
      },
      415
    )
  }

  const target = String(form['target'] ?? 'moodboard')
  const contentItemId = form['contentItemId']
    ? String(form['contentItemId'])
    : null
  const caption = form['caption'] ? String(form['caption']) : null
  const name = file.name || 'Untitled'

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
  } else {
    clientId = await resolveClientId(c)
  }
  if (!clientId) return c.json({ error: 'No workspace selected' }, 400)

  const processed = await processUpload(buf, sniffed, clientId)
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
        const [row] = await tx
          .insert(files)
          .values({
            clientId,
            name,
            storageKey: processed.storageKey,
            mime: processed.mime,
            sizeBytes: processed.sizeBytes,
            uploadedBy: actorId,
            sortOrder: 999,
          })
          .returning()
        return { file: row }
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
          storageKey: processed.thumbKey ?? processed.storageKey,
          caption,
          sortOrder: next,
        })
        .returning()
      return { moodboardItem: row }
    })

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

async function streamKey(c: Context, key: string, mime: string | null) {
  const total = await storage.size(key)

  // Range support is what makes video seekable; without it Safari refuses to
  // play at all.
  const range = parseRange(c.req.header('range'), total)

  if (range === 'unsatisfiable') {
    return c.body(null, 416, { 'Content-Range': `bytes */${total}` })
  }

  if (range) {
    const { start, end } = range
    const stream = storage.read(key, { start, end })
    return c.body(stream as unknown as ReadableStream, 206, {
      'Content-Type': mime ?? 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    })
  }


  return c.body(storage.read(key) as unknown as ReadableStream, 200, {
    'Content-Type': mime ?? 'application/octet-stream',
    'Content-Length': String(total),
    'Accept-Ranges': 'bytes',
    // Private: these are one client's images, and a shared cache must not
    // hold them.
    'Cache-Control': 'private, max-age=3600',
  })
}

const variantSchema = z.enum(['original', 'thumb', 'poster']).catch('original')

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

  const key =
    variant === 'thumb'
      ? (asset.thumbKey ?? asset.storageKey)
      : variant === 'poster'
        ? (asset.posterKey ?? asset.thumbKey ?? asset.storageKey)
        : asset.storageKey

  // A derived variant is always a webp; only the original keeps its own type.
  const mime = key === asset.storageKey ? asset.mime : 'image/webp'
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
  return streamKey(c, row.storageKey, 'image/webp')
})

mediaRoutes.get('/files/:id', async (c) => {
  const [row] = await withTenant(c.get('tenant'), (tx) =>
    tx.select().from(files).where(eq(files.id, c.req.param('id'))).limit(1)
  )
  if (!row?.storageKey) return c.json({ error: 'Not found' }, 404)
  return streamKey(c, row.storageKey, row.mime)
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
      .returning({ storageKey: moodboardItems.storageKey })
  )
  if (!removed.length) return c.json({ error: 'Not found' }, 404)
  if (removed[0].storageKey) await storage.remove(removed[0].storageKey)
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
mediaRoutes.get('/feed', async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace available' }, 404)

  /**
   * One cell per content item, using its first asset.
   *
   * DISTINCT ON rather than a join on sortOrder = 0: assets are appended, so
   * an item whose first asset was deleted would otherwise vanish from the
   * grid entirely, and before sortOrder was assigned properly every item
   * appeared once per asset.
   */
  const result = await withTenant(c.get('tenant'), (tx) =>
    tx.execute(sql`
      select
        item_id       as "itemId",
        title,
        type,
        status,
        scheduled_at  as "scheduledAt",
        feed_order    as "feedOrder",
        asset_id      as "assetId",
        asset_kind    as "assetKind"
      from (
        select distinct on (ci.id)
          ci.id            as item_id,
          ci.title         as title,
          ci.type          as type,
          ci.status        as status,
          ci.scheduled_at  as scheduled_at,
          ci.feed_order    as feed_order,
          ca.id            as asset_id,
          ca.kind          as asset_kind
        from content_items ci
        join content_assets ca on ca.content_item_id = ci.id
        where ci.client_id = ${clientId}
        order by ci.id, ca.sort_order asc, ca.created_at asc
      ) first_assets
      order by feed_order asc nulls last, scheduled_at asc nulls last
    `)
  )

  const rows = result.rows

  return c.json({ clientId, cells: rows })
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
