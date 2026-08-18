import { asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import {
  clients,
  contentApprovals,
  contentAssets,
  contentComments,
  contentItems,
} from '../db/schema.js'
import { user } from '../db/auth-schema.js'
import { audit, recordActivity } from '../lib/audit.js'
import { requireAuth, requireStaff } from '../middleware/session.js'
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
        caption: contentItems.caption,
        feedOrder: contentItems.feedOrder,
        visibleToClient: contentItems.visibleToClient,
        createdAt: contentItems.createdAt,
        updatedAt: contentItems.updatedAt,
      })
      .from(contentItems)
      .where(eq(contentItems.clientId, clientId))
      .orderBy(desc(contentItems.updatedAt))
  )

  return c.json({ clientId, items })
})

/**
 * What is waiting on a decision, across every workspace.
 *
 * The product's whole value is that the client responds, and until now
 * nothing asked them to: a client signed in to links and files with no
 * indication that two posts needed approving. Staff had the same blind spot in
 * reverse — a count on the dashboard with no way to see which items.
 *
 * Deliberately registered before '/:id', or "awaiting" is read as an id.
 */
contentRoutes.get('/awaiting', async (c) => {
  const currentUser = c.get('user')!

  const rows = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({
        id: contentItems.id,
        clientId: contentItems.clientId,
        clientName: clients.name,
        title: contentItems.title,
        type: contentItems.type,
        scheduledAt: contentItems.scheduledAt,
        updatedAt: contentItems.updatedAt,
      })
      .from(contentItems)
      .innerJoin(clients, eq(clients.id, contentItems.clientId))
      .where(eq(contentItems.status, 'ready_for_review'))
      .orderBy(asc(contentItems.scheduledAt), desc(contentItems.updatedAt))
  )

  // RLS already limits a client to their own workspace, so the same query
  // serves both audiences — staff see every client, a client sees theirs.
  return c.json({ items: rows, scope: currentUser.isStaff ? 'agency' : 'client' })
})

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
  caption: z.string().max(4000).nullish(),
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
  caption: z.string().max(4000).nullish(),
  feedOrder: z.number().int().nullish(),
})

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
        caption: data.caption ?? null,
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

    const [row] = await tx
      .update(contentItems)
      .set({
        ...patch,
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
    if (
      patch.scheduledAt !== undefined &&
      patch.scheduledAt !== before.scheduledAt
    ) {
      await recordActivity(tx, {
        clientId: row.clientId,
        entityType: 'content_item',
        entityId: row.id,
        actorId,
        kind: 'status_change',
        body: `"${row.title}" scheduled for ${row.scheduledAt ?? 'no date'}`,
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
