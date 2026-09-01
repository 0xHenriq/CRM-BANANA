import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withReviewToken, type ReviewContext, type Tx } from '../db/index.js'
import { contentApprovals, contentAssets, contentItems } from '../db/schema.js'
import { hashReviewToken } from '../lib/review-tokens.js'
import { logger } from '../logger.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { selectFeedCells, streamKey } from './media.js'

/**
 * The share-link surface. Deliberately unauthenticated.
 *
 * NOTHING in this file may use `withTenant`, `c.get('tenant')` or
 * `isStaff: true`. The only authority here is a token that redeems, and
 * `withReviewToken` is the only way to obtain it — it will not set the review
 * session variables without a live row. A source-text test asserts those three
 * strings never appear in this file, because the single worst regression on
 * this boundary is somebody "fixing" a permissions error by reaching for
 * withTenant.
 *
 * A link is a BEARER token: whoever holds it can approve. That is stated in
 * the UI beside the copy button, because it is the property she is choosing
 * when she sends one.
 */
export const reviewRoutes = new Hono()

/**
 * Rate limiting is NOT what makes guessing infeasible — 256 bits of token
 * entropy is. This protects the box from the traffic, which is a different
 * job. Note rate-limit.ts's own caveat: in-process counters are correct only
 * while there is one instance.
 */
reviewRoutes.use('*', rateLimit({ windowMs: 15 * 60_000, max: 120, name: 'share-read' }))
reviewRoutes.use('/:token/decision', rateLimit({ windowMs: 15 * 60_000, max: 10, name: 'share-decision' }))

/**
 * One generic 404 for missing, expired, revoked, archived and wrong-scope.
 *
 * Distinguishing them would turn this endpoint into an oracle: "expired" tells
 * a guesser the token existed, which is the only expensive bit of information
 * there is.
 */
const gone = { error: 'This link is no longer available.' } as const

async function loadItemPayload(tx: Tx, review: ReviewContext) {
  // The CHECK on review_links guarantees an item-scoped link has one, but an
  // empty string reaching a uuid comparison raises 22P02 — a 500 where a 404
  // belongs. Cheaper to answer here than to explain later.
  if (!review.contentItemId) return null

  const [item] = await tx
    .select({
      id: contentItems.id,
      title: contentItems.title,
      type: contentItems.type,
      status: contentItems.status,
      caption: contentItems.caption,
      hashtags: contentItems.hashtags,
      scheduledAt: contentItems.scheduledAt,
      scheduledTime: contentItems.scheduledTime,
    })
    .from(contentItems)
    // Explicit, though RLS already narrows this to the one row a link opens.
    // A bare `limit(1)` leaned entirely on the policy being right: correct
    // today, and silently the WRONG POST the day anything widens it. Two
    // gates on the thing a share link is for.
    .where(eq(contentItems.id, review.contentItemId))
    .limit(1)
  if (!item) return null

  const assets = await tx
    .select({
      id: contentAssets.id,
      kind: contentAssets.kind,
      mime: contentAssets.mime,
      width: contentAssets.width,
      height: contentAssets.height,
    })
    .from(contentAssets)
    .where(eq(contentAssets.contentItemId, item.id))
    .orderBy(asc(contentAssets.sortOrder))

  // Their own past decision, so the page can say "you approved this on the
  // 12th" rather than offering the buttons again. Reachable only because
  // content_approvals_select gained `OR review_link_id = app_review_link_id()`.
  const approvals = await tx
    .select({
      decision: contentApprovals.decision,
      note: contentApprovals.note,
      decidedAt: contentApprovals.decidedAt,
    })
    .from(contentApprovals)
    .where(eq(contentApprovals.reviewLinkId, review.linkId))

  return { item, assets, approvals }
}

/**
 * The shared ideas that have no date yet.
 *
 * She asked for the Ideas Bank to travel with a feed link. What the recipient
 * gets is the SHARED half of it: `content_items_select`'s feed arm carries
 * `AND visible_to_client`, so a raw concept or a rejected pitch cannot appear
 * here however this query is written. That term is load-bearing and the
 * isolation suite pins it.
 *
 * Undated only, so this and the grid do not print the same post twice — the
 * grid is what is booked, this is what is still being considered.
 */
async function loadSharedIdeas(tx: Tx, review: ReviewContext) {
  return tx
    .select({
      id: contentItems.id,
      title: contentItems.title,
      type: contentItems.type,
      status: contentItems.status,
      caption: contentItems.caption,
    })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.clientId, review.clientId),
        isNull(contentItems.scheduledAt)
      )
    )
    .orderBy(asc(contentItems.createdAt))
}

async function loadFeedPayload(tx: Tx, review: ReviewContext) {
  /*
   * The SAME query the Feed Preview screen uses, not a second one.
   *
   * The second one diverged the moment it was written: no join to
   * content_assets, so items with no creative showed as blank tiles the client
   * saw and she did not, and no `scheduled_time` in the ordering, so two posts
   * on one day could come out in a different order. She looks at the grid and
   * then sends a link to it; the two have to be the same grid.
   *
   * RLS does the narrowing — under a feed token this returns only the client's
   * posts that are shared with them.
   */
  const result = await selectFeedCells(tx, review.clientId)
  return { cells: result.rows }
}

/** The payload for whichever scope the link carries. */
reviewRoutes.get('/:token', async (c) => {
  const tokenHash = hashReviewToken(c.req.param('token'))

  const payload = await withReviewToken(tokenHash, { bump: true }, async (tx, review) => {
    // From the redeeming function. Selecting it here would return nothing:
    // `clients` is staff-only and a review context reads none of it, which the
    // isolation suite asserts.
    const client = {
      name: review.clientName,
      brandColor: review.clientBrandColor,
    }

    if (review.scope === 'feed') {
      return {
        scope: 'feed' as const,
        client,
        ...(await loadFeedPayload(tx, review)),
        ideas: await loadSharedIdeas(tx, review),
      }
    }
    const item = await loadItemPayload(tx, review)
    if (!item) return null
    return { scope: 'content_item' as const, client, ...item }
  })

  if (!payload) return c.json(gone, 404)
  return c.json(payload)
})

const decisionSchema = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  note: z.string().max(2000).nullish(),
})

/**
 * Record a decision, through the SECURITY DEFINER function.
 *
 * The insert is not the whole job — the item's status moves and an activities
 * row is written, both staff-only tables — so this is a function rather than a
 * policy arm plus an escalation. It re-validates the token itself, so this
 * handler cannot record a decision for a link whose token it does not hold.
 */
reviewRoutes.post('/:token/decision', async (c) => {
  const tokenHash = hashReviewToken(c.req.param('token'))
  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const result = await withReviewToken(tokenHash, { bump: false }, async (tx) => {
    const rows = await tx.execute<{ outcome: string; new_status: string | null }>(
      sql`select * from record_review_decision(
            ${tokenHash}, ${parsed.data.decision}::approval_decision, ${parsed.data.note ?? null})`
    )
    return rows.rows[0] ?? { outcome: 'not_found', new_status: null }
  })

  if (!result || result.outcome === 'not_found' || result.outcome === 'wrong_scope') {
    return c.json(gone, 404)
  }
  if (result.outcome === 'not_for_review') {
    return c.json({ error: 'This post is not open for review.' }, 409)
  }
  if (result.outcome === 'already_decided') {
    return c.json({ error: 'You have already answered on this link.' }, 409)
  }

  logger.info({ decision: parsed.data.decision }, 'decision recorded via share link')
  return c.json({ ok: true, status: result.new_status })
})

/**
 * The creative itself.
 *
 * A separate route rather than widening GET /api/media/assets/:id, which is
 * closed by `mediaRoutes.use('*', requireAuth)` and should stay that way. RLS
 * decides what this can see: the select runs under the review context, so an
 * asset id from another post simply is not found.
 *
 * `bump: false` — a post with three images must not score four views, and the
 * use counter is what she reads to answer "did they even look at it".
 */
reviewRoutes.get('/:token/assets/:assetId', async (c) => {
  const tokenHash = hashReviewToken(c.req.param('token'))

  const asset = await withReviewToken(tokenHash, { bump: false }, async (tx) => {
    const [row] = await tx
      .select({
        storageKey: contentAssets.storageKey,
        mime: contentAssets.mime,
      })
      .from(contentAssets)
      .where(eq(contentAssets.id, c.req.param('assetId')))
      .limit(1)
    return row ?? null
  })

  if (!asset) return c.json(gone, 404)
  // The same helper the authenticated route uses, so range requests — and
  // therefore video seeking — behave identically.
  return streamKey(c, asset.storageKey, asset.mime)
})
