import { asc, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import { HASHTAG_LIMIT, normaliseHashtags } from '../lib/hashtags.js'
import {
  contentApprovals,
  contentAssets,
  contentComments,
  contentItems,
} from '../db/schema.js'
import { user } from '../db/auth-schema.js'
import { audit, hhmm, recordActivity } from '../lib/audit.js'
import { requireAuth, requireStaff } from '../middleware/session.js'
import { storage } from '../lib/storage.js'
import { resolveClientId } from '../lib/resolve-client.js'

export const contentRoutes = new Hono()

contentRoutes.use('*', requireAuth)

/** Her five, verbatim. */
export const CONTENT_TYPES = [
  'video',
  'reel',
  'story',
  'graphic',
  'carousel',
] as const

/**
 * The networks a post can be aimed at.
 *
 * Her three first, in her order — the seeded link stack is TikTok, Instagram,
 * Facebook, and that is the agency's actual working set. The remaining five
 * are the ones a London social agency is next asked for; they cost nothing to
 * carry and mean a new client does not need a deploy.
 *
 * The allowlist lives HERE rather than in the database on purpose (migration
 * 0024): networks come and go — Threads did not exist, Twitter became X — and
 * appending to this array is a deploy where appending to a Postgres enum is a
 * migration. The column is `text[]`; this is what constrains it.
 */
export const PLATFORMS = [
  'tiktok',
  'instagram',
  'facebook',
  'youtube',
  'linkedin',
  'pinterest',
  'x',
  'threads',
] as const

/**
 * Her four statuses, plus the two the prototype implied but could not express.
 * A post that is approved and dated is `scheduled`; one that has gone out is
 * `published`.
 */
export const CONTENT_STATUSES = [
  'idea',
  'in_progress',
  'ready_for_review',
  'approved',
  'scheduled',
  'published',
] as const


/**
 * One list feeds three views.
 *
 * The Ideas Bank is this list unfiltered; the calendar is the rows with a
 * `scheduledAt`; the feed preview is the rows with assets. In the prototype
 * these were separate stores that never spoke, so approving an idea did
 * nothing to the calendar. Filtering happens client-side over one payload —
 * an agency's content volume is hundreds of rows, not millions.
 */
contentRoutes.get('/', async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace available' }, 404)

  const items = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({
        id: contentItems.id,
        clientId: contentItems.clientId,
        title: contentItems.title,
        type: contentItems.type,
        status: contentItems.status,
        scheduledAt: contentItems.scheduledAt,
        scheduledTime: contentItems.scheduledTime,
        caption: contentItems.caption,
        hashtags: contentItems.hashtags,
        platforms: contentItems.platforms,
        feedOrder: contentItems.feedOrder,
        visibleToClient: contentItems.visibleToClient,
        createdAt: contentItems.createdAt,
        updatedAt: contentItems.updatedAt,
        /*
         * The most recent decision, so a DECLINED post can be told apart from
         * one nobody has looked at yet.
         *
         * Sofia asked for a traffic light — "approved or scheduled green,
         * pending orange, red is declined" — and `status` cannot express the
         * third colour. Asking for changes moves a post back to `in_progress`,
         * which is exactly where a fresh draft sits, so on status alone a post
         * the client REJECTED looks identical to one nobody has sent yet.
         *
         * Derived, never stored: content_approvals is the append-only record
         * and this reads the top of it. Storing a `declined` flag beside it
         * would be a second account of the same fact, and the two would
         * disagree the first time one was corrected.
         *
         * Explicit alias and literal column names — interpolating
         * `${contentApprovals.contentItemId}` renders it UNQUALIFIED, "id"
         * would bind to the wrong table and every row would come back with the
         * same answer and no error. Failure Mode 2.
         *
         * The subquery runs under the caller's own policies, so a client sees
         * the decision history of items they can see and nothing else.
         */
        lastDecision: sql<
          'approved' | 'changes_requested' | null
        >`(
          select ca.decision from content_approvals ca
           where ca.content_item_id = content_items.id
           order by ca.decided_at desc
           limit 1
        )`,
      })
      .from(contentItems)
      .where(eq(contentItems.clientId, clientId))
      .orderBy(desc(contentItems.updatedAt))
  )

  return c.json({ clientId, items })
})

/**
 * Hashtags arrive as an array and are normalised server-side regardless.
 *
 * The cap is generous on purpose. HASHTAG_LIMIT (30) is Instagram's rule and
 * the UI warns at it, but the API does not refuse at 31: she may be drafting,
 * and a tool that rejects her work mid-thought because a platform she has not
 * chosen yet would reject it is a tool that is wrong more often than it is
 * right. The hard cap here only exists to stop something absurd reaching the
 * database.
 */
const hashtagSchema = z.array(z.string().max(140)).max(HASHTAG_LIMIT * 4)

/**
 * Deduped and ordered as PLATFORMS is, so two rows carrying the same networks
 * carry them in the same order. The API is the only thing constraining this
 * column — see migration 0024 — so it refuses anything not on the list rather
 * than storing a typo that every screen then has to render.
 */
const platformSchema = z
  .array(z.enum(PLATFORMS))
  .max(PLATFORMS.length)
  .transform((list) => PLATFORMS.filter((p) => list.includes(p)))


contentRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const detail = await withTenant(c.get('tenant'), async (tx) => {
    const [item] = await tx
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .limit(1)
    if (!item) return null

    const comments = await tx
      .select({
        id: contentComments.id,
        body: contentComments.body,
        createdAt: contentComments.createdAt,
        authorId: contentComments.authorId,
        authorName: user.name,
      })
      .from(contentComments)
      .leftJoin(user, eq(user.id, contentComments.authorId))
      .where(eq(contentComments.contentItemId, id))
      .orderBy(asc(contentComments.createdAt))

    const assets = await tx
      .select({
        id: contentAssets.id,
        kind: contentAssets.kind,
        durationMs: contentAssets.durationMs,
        width: contentAssets.width,
        height: contentAssets.height,
        sortOrder: contentAssets.sortOrder,
      })
      .from(contentAssets)
      .where(eq(contentAssets.contentItemId, id))
      .orderBy(asc(contentAssets.sortOrder))

    const approvals = await tx
      .select({
        id: contentApprovals.id,
        decision: contentApprovals.decision,
        note: contentApprovals.note,
        decidedAt: contentApprovals.decidedAt,
        actorName: user.name,
        /*
         * A link approval has no actor, by construction.
         *
         * `content_approvals_one_actor` allows exactly one of actor_id and
         * review_link_id, so this join produces NULL for every decision made
         * through a share link — and the dialog renders `actorName ?? 'Someone'`.
         * Without this flag the feature would manufacture history rows reading
         * "Someone approved this", which is worse than not having it.
         */
        viaShareLink: sql<boolean>`${contentApprovals.reviewLinkId} is not null`,
      })
      .from(contentApprovals)
      .leftJoin(user, eq(user.id, contentApprovals.actorId))
      .where(eq(contentApprovals.contentItemId, id))
      .orderBy(desc(contentApprovals.decidedAt))

    return { item, assets, comments, approvals }
  })

  if (!detail) return c.json({ error: 'Not found' }, 404)
  return c.json(detail)
})

const createSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(CONTENT_TYPES),
  status: z.enum(CONTENT_STATUSES).default('idea'),
  /** Null means "an idea"; a date puts it on the calendar. Same row either way. */
  scheduledAt: z.string().date().nullish(),
  /**
   * HH:MM, 24-hour. A bare wall-clock time, so no timezone and no seconds —
   * "post at 18:30" is an intent about the audience's clock, not an instant.
   */
  scheduledTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 18:30')
    .nullish(),
  caption: z.string().max(4000).nullish(),
  hashtags: hashtagSchema.optional(),
  platforms: platformSchema.optional(),
})

/**
 * PATCH schema, written separately and with NO defaults.
 *
 * `schema.partial()` does not strip `.default()`, and a field omitted from a
 * body coming back populated is how an internal task got published to a
 * client in Phase 4. See server/__tests__/patch-schemas.test.ts.
 */
const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  type: z.enum(CONTENT_TYPES).optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  scheduledAt: z.string().date().nullish(),
  scheduledTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 18:30')
    .nullish(),
  caption: z.string().max(4000).nullish(),
  hashtags: hashtagSchema.optional(),
  platforms: platformSchema.optional(),
  feedOrder: z.number().int().nullish(),
})


/**
 * A posting time only exists if the row has a day to sit on.
 *
 * Two entry points need this and they need it differently, so it is two small
 * functions rather than one clever one. Both are exported because the rule is
 * worth asserting directly: it was wrong once already, in the direction nobody
 * thought to check.
 */

/** For a create: the time to store, given the date being stored with it. */
export function timeForNewItem(
  scheduledAt: string | null | undefined,
  scheduledTime: string | null | undefined
): string | null {
  return scheduledAt ? (scheduledTime ?? null) : null
}

/**
 * For a PATCH: the schedule fields to force, on top of whatever was sent.
 *
 * Judged on the row as it will BE, not on what the request mentions —
 * `{}` when the row keeps a date, so an omitted `scheduledTime` stays omitted
 * and Drizzle leaves the column alone.
 */
export function scheduleOverrides(
  beforeScheduledAt: string | null,
  patch: { scheduledAt?: string | null }
): { scheduledTime?: null } {
  const next =
    patch.scheduledAt !== undefined ? patch.scheduledAt : beforeScheduledAt
  return next === null ? { scheduledTime: null } : {}
}

/**
 * Visibility is granted once and never revoked by a status change.
 *
 * Reaching `ready_for_review` shares the item. A later edit that drops it back
 * to `in_progress` must NOT un-share it: the client is mid-conversation on
 * that thread, and yanking it away mid-sentence is worse than showing them a
 * post that went back into progress.
 */
function shouldShare(status: string | undefined, already: boolean): boolean {
  if (already) return true
  return (
    status === 'ready_for_review' ||
    status === 'approved' ||
    status === 'scheduled' ||
    status === 'published'
  )
}

contentRoutes.post('/', requireStaff, async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace selected' }, 400)
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      400
    )
  }

  const actorId = c.get('user')?.id ?? null
  const data = parsed.data

  const created = await withTenant(c.get('tenant'), async (tx) => {
    const [row] = await tx
      .insert(contentItems)
      .values({
        clientId,
        title: data.title,
        type: data.type,
        status: data.status,
        scheduledAt: data.scheduledAt ?? null,
        scheduledTime: timeForNewItem(data.scheduledAt, data.scheduledTime),
        caption: data.caption ?? null,
        hashtags: normaliseHashtags(data.hashtags ?? []),
        visibleToClient: shouldShare(data.status, false),
        createdBy: actorId,
      })
      .returning()

    await audit(tx, {
      actorId,
      action: 'content.create',
      entity: 'content_item',
      entityId: row.id,
      meta: { clientId, title: row.title, status: row.status },
    })
    return row
  })

  return c.json({ item: created }, 201)
})

contentRoutes.patch('/:id', requireStaff, async (c) => {
  const id = c.req.param('id')
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'Nothing to update' }, 400)
  }

  const actorId = c.get('user')?.id ?? null
  const patch = parsed.data

  const updated = await withTenant(c.get('tenant'), async (tx) => {
    const [before] = await tx
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .limit(1)
    if (!before) return null

    /**
     * A time without a date is not a thing.
     *
     * Judged on the row as it will BE, not on what this request happens to
     * mention. The first version only handled an explicit `scheduledAt: null`,
     * which left the other way in wide open: sending just a time to an undated
     * idea stored "18:30, no date" — a state the calendar cannot place, the
     * detail dialog renders as an enabled time on a blank date, and which
     * reappears at a time nobody chose the day the post is finally scheduled.
     *
     * The UI disables the time field until there is a date, but the invariant
     * belongs here: a rule only the client enforces is not enforced.
     */
    const timePatch = scheduleOverrides(before.scheduledAt, patch)

    /*
     * Normalised HERE as well as on create, not only in the browser.
     *
     * The spread below would otherwise write whatever arrived — and the field
     * is an array, so a client sending ['#one', '#One', ' one '] would store
     * three tags that are one tag. The rule has to sit where the row is
     * written, or it is enforced by whichever caller happens to remember it.
     * Guarded on `undefined` rather than truthiness: an explicit [] is how the
     * UI clears every tag, and `!patch.hashtags` would silently ignore that.
     */
    const hashtagPatch =
      patch.hashtags === undefined
        ? {}
        : { hashtags: normaliseHashtags(patch.hashtags) }

    const [row] = await tx
      .update(contentItems)
      .set({
        ...patch,
        ...hashtagPatch,
        ...timePatch,
        visibleToClient: shouldShare(patch.status, before.visibleToClient),
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, id))
      .returning()

    if (patch.status && patch.status !== before.status) {
      await recordActivity(tx, {
        clientId: row.clientId,
        entityType: 'content_item',
        entityId: row.id,
        actorId,
        kind: 'status_change',
        body: `"${row.title}": ${before.status} → ${patch.status}`,
      })
    }

    // Rescheduling is the calendar's whole job, so it belongs in the timeline
    // as much as a status change does.
    const dateMoved =
      patch.scheduledAt !== undefined &&
      patch.scheduledAt !== before.scheduledAt
    const timeMoved =
      patch.scheduledTime !== undefined &&
      patch.scheduledTime !== hhmm(before.scheduledTime)

    if (dateMoved || timeMoved) {
      const when = row.scheduledAt
        ? `${row.scheduledAt}${row.scheduledTime ? ` at ${hhmm(row.scheduledTime)}` : ''}`
        : 'no date'
      await recordActivity(tx, {
        clientId: row.clientId,
        entityType: 'content_item',
        entityId: row.id,
        actorId,
        kind: 'status_change',
        body: `"${row.title}" scheduled for ${when}`,
      })
    }

    await audit(tx, {
      actorId,
      action: 'content.update',
      entity: 'content_item',
      entityId: id,
      meta: { before: { status: before.status, scheduledAt: before.scheduledAt }, patch },
    })

    return row
  })

  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json({ item: updated })
})

contentRoutes.delete('/:id', requireStaff, async (c) => {
  const id = c.req.param('id')
  const actorId = c.get('user')?.id ?? null

  const deleted = await withTenant(c.get('tenant'), async (tx) => {
    const rows = await tx
      .delete(contentItems)
      .where(eq(contentItems.id, id))
      .returning({ id: contentItems.id })
    if (rows.length) {
      await audit(tx, {
        actorId,
        action: 'content.delete',
        entity: 'content_item',
        entityId: id,
      })
    }
    return rows
  })

  if (!deleted.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

/* -------------------------------------------------------------- duplicate */

/**
 * Copy a post, creative and all.
 *
 * A content calendar is repetitive by nature — the same format, the same
 * caption skeleton, the same assets, a month later — and without this every
 * repeat meant retyping the post and re-uploading its images. It is the single
 * biggest per-post time saving available in this screen.
 *
 * What the copy deliberately does NOT inherit:
 *
 *   status          -> back to `idea`. A copy has not been reviewed, and
 *                      inheriting `approved` would let a post reach the
 *                      calendar carrying an approval nobody gave it.
 *   visibleToClient -> false, which follows from the status reset. Copying a
 *                      shared post must not silently share the copy.
 *   scheduledAt     -> null, with its time. Two posts on one slot is never
 *                      what "duplicate" meant.
 *   feedOrder       -> null, so it does not fight the original for a cell.
 *
 * Assets are copied as new objects rather than new rows pointing at the same
 * keys. Sharing them would couple the two posts: deleting one's bytes would
 * empty the other, months later and for no visible reason.
 */

/**
 * What a copy inherits, and what it must not.
 *
 * Pulled out of the handler so the rule can be asserted directly. The two that
 * matter are `status` and `visibleToClient`: a copy that inherited `approved`
 * would reach the calendar carrying an approval nobody gave it, and one that
 * inherited a shared flag would put unreviewed work in front of the client.
 */
export function duplicateFields(source: {
  title: string
  type: (typeof CONTENT_TYPES)[number]
  caption: string | null
  hashtags: string[]
  platforms: string[]
}) {
  return {
    title: `${source.title} (copy)`.slice(0, 200),
    type: source.type,
    caption: source.caption,
    // Carried over, like the caption: a duplicate exists to be the same post
    // again with a new date, and retyping thirty tags is the reason she would
    // stop using the button.
    hashtags: source.hashtags,
    /*
     * Carried too, and it is the same argument as the hashtags.
     *
     * Duplicating exists for the repurpose: the same post again with a new
     * date, and usually the same destinations. Dropping the platforms would
     * make every copy read as "nobody has said where this goes" — which is a
     * real state that means something, so manufacturing it here would be a
     * lie about a row she just told the system everything about.
     *
     * Adding a column to `content_items` is a TWO-PLACE change when a copy
     * path exists. Same shape as `keysReferencedBy` in media.ts, and the same
     * failure: a field the copier cannot see is a field the copy loses.
     */
    platforms: source.platforms,
    status: 'idea' as const,
    scheduledAt: null,
    scheduledTime: null,
    feedOrder: null,
    visibleToClient: false,
  }
}
contentRoutes.post('/:id/duplicate', requireStaff, async (c) => {
  const id = c.req.param('id')
  const actorId = c.get('user')?.id ?? null

  const source = await withTenant(c.get('tenant'), async (tx) => {
    const [item] = await tx
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .limit(1)
    if (!item) return null

    const assets = await tx
      .select()
      .from(contentAssets)
      .where(eq(contentAssets.contentItemId, id))
      .orderBy(asc(contentAssets.sortOrder))

    return { item, assets }
  })
  if (!source) return c.json({ error: 'Not found' }, 404)

  /**
   * Bytes are copied BEFORE the transaction opens.
   *
   * Copying a 200 MB video inside the transaction would hold it open for the
   * length of a disk copy, and a failure halfway would roll back rows while
   * leaving the copied files behind. Doing it first means a failure leaves
   * only orphaned bytes, which are cleaned up in the catch.
   */
  const copied: { key: string; thumb: string | null; poster: string | null }[] = []
  const written: string[] = []
  try {
    for (const asset of source.assets) {
      const main = await storage.copy(asset.storageKey, {
        prefix: source.item.clientId,
      })
      written.push(main.key)
      const thumb = asset.thumbKey
        ? await storage.copy(asset.thumbKey, { prefix: source.item.clientId })
        : null
      if (thumb) written.push(thumb.key)
      const poster = asset.posterKey
        ? await storage.copy(asset.posterKey, { prefix: source.item.clientId })
        : null
      if (poster) written.push(poster.key)
      copied.push({
        key: main.key,
        thumb: thumb?.key ?? null,
        poster: poster?.key ?? null,
      })
    }

    const created = await withTenant(c.get('tenant'), async (tx) => {
      const [row] = await tx
        .insert(contentItems)
        .values({
          clientId: source.item.clientId,
          ...duplicateFields(source.item),
          createdBy: actorId,
        })
        .returning()

      for (const [index, asset] of source.assets.entries()) {
        await tx.insert(contentAssets).values({
          clientId: source.item.clientId,
          contentItemId: row.id,
          kind: asset.kind,
          storageKey: copied[index].key,
          thumbKey: copied[index].thumb,
          posterKey: copied[index].poster,
          durationMs: asset.durationMs,
          width: asset.width,
          height: asset.height,
          mime: asset.mime,
          sizeBytes: asset.sizeBytes,
          sortOrder: asset.sortOrder,
          uploadedBy: actorId,
        })
      }

      await audit(tx, {
        actorId,
        action: 'content.duplicate',
        entity: 'content_item',
        entityId: row.id,
        meta: { from: id, assets: source.assets.length },
      })

      return row
    })

    return c.json({ item: created, assetsCopied: source.assets.length }, 201)
  } catch (err) {
    // The rows never committed, so nothing points at these bytes.
    for (const key of written) await storage.remove(key)
    throw err
  }
})

/* ---------------------------------------------------------------- comments */

const commentSchema = z.object({ body: z.string().min(1).max(4000) })

/**
 * Both audiences comment. The RLS insert policy confines a client to items
 * they can actually see — an item hidden from them is not a valid target, so
 * there is nothing to check here that the database does not already enforce.
 */
contentRoutes.post('/:id/comments', async (c) => {
  const id = c.req.param('id')
  const parsed = commentSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const created = await withTenant(c.get('tenant'), async (tx) => {
    const [item] = await tx
      .select({ clientId: contentItems.clientId })
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .limit(1)
    if (!item) return null

    const [row] = await tx
      .insert(contentComments)
      .values({
        clientId: item.clientId,
        contentItemId: id,
        authorId: c.get('user')?.id ?? null,
        body: parsed.data.body,
      })
      .returning()
    return row
  })

  if (!created) return c.json({ error: 'Not found' }, 404)
  return c.json({ comment: created }, 201)
})

/* --------------------------------------------------------------- decisions */

const decisionSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  note: z.string().max(4000).nullish(),
})

/**
 * Approve, or ask for changes.
 *
 * The approval row is the record — append-only, and the status field is
 * derived from it rather than the other way round. "You approved it" has to
 * point at something immutable, which is why content_approvals has no UPDATE
 * or DELETE policy at all.
 *
 * Requesting changes moves the item back to `in_progress` but leaves it shared
 * (see shouldShare), so the client keeps the thread they are talking in.
 */
contentRoutes.post('/:id/decision', async (c) => {
  const id = c.req.param('id')
  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const currentUser = c.get('user')!
  const { decision, note } = parsed.data

  /**
   * Authority first, under the CALLER's own context.
   *
   * A client can only decide on something they can see, and RLS is what
   * decides that — an item hidden from them is simply not found. Approving
   * also updates the item's status and writes the client timeline, both of
   * which are staff-only tables by design, so the bookkeeping runs elevated
   * once that authority is established. This is the same shape as ticking a
   * task, and the alternative — granting clients write access to
   * content_items and activities — would be far worse.
   *
   * Verified the hard way: writing these under the client's own context
   * failed the activities policy and rolled the whole transaction back, so
   * the approval row silently never appeared.
   */
  const [visible] = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .limit(1)
  )
  if (!visible) return c.json({ error: 'Not found' }, 404)

  const result = await withTenant(
    { userId: currentUser.id, isStaff: true },
    async (tx) => {
      const [item] = await tx
        .select()
        .from(contentItems)
        .where(eq(contentItems.id, id))
        .limit(1)
      if (!item) return null

      // A decision only makes sense on something actually sent for review.
      // Approving an idea nobody has seen is not approval.
      if (item.status === 'idea' || item.status === 'in_progress') {
        return { error: 'This has not been sent for review yet.' as const }
      }

      await tx.insert(contentApprovals).values({
        clientId: item.clientId,
        contentItemId: id,
        decision,
        actorId: currentUser.id,
        note: note ?? null,
      })

      const nextStatus =
        decision === 'approved'
          ? item.scheduledAt
            ? ('scheduled' as const)
            : ('approved' as const)
          : ('in_progress' as const)

      const [row] = await tx
        .update(contentItems)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(contentItems.id, id))
        .returning()

      await recordActivity(tx, {
        clientId: item.clientId,
        entityType: 'content_item',
        entityId: id,
        actorId: currentUser.id,
        kind: 'status_change',
        body:
          decision === 'approved'
            ? `"${item.title}" approved${item.scheduledAt ? ` and scheduled for ${item.scheduledAt}` : ''}`
            : `Changes requested on "${item.title}"${note ? `: ${note}` : ''}`,
      })

      return { item: row }
    }
  )

  if (!result) return c.json({ error: 'Not found' }, 404)
  if ('error' in result) return c.json({ error: result.error }, 409)
  return c.json(result)
})
