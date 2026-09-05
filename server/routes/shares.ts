import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import { clients, contentItems, reviewLinks } from '../db/schema.js'
import { audit } from '../lib/audit.js'
import { logger } from '../logger.js'
import {
  mintReviewToken,
  REVIEW_LINK_DAYS,
  reviewLinkExpiry,
} from '../lib/review-tokens.js'
import { env } from '../env.js'
import { requireStaff } from '../middleware/session.js'

/**
 * Minting, listing and revoking share links. Staff only.
 *
 * The public half lives in review.ts and shares no middleware with this file
 * on purpose — the two are mounted separately so a change to the guards here
 * cannot silently open or close the other.
 *
 * EVERY PATH HERE IS RELATIVE TO ITS OWN MOUNT POINT, and that is not a
 * stylistic choice. These handlers cover three different nouns — a post, a
 * client, a link — so the first version mounted the file at `/api` and used
 * absolute-looking paths. `use('*', requireStaff)` then applied to the WHOLE
 * API: every client got 403 from their own portal. Caught against the running
 * server before deploying, and the shape below makes it impossible — the
 * wildcard cannot reach past `/api/shares`.
 */
export const shareRoutes = new Hono()

shareRoutes.use('*', requireStaff)

const linkUrl = (token: string) => `${env.APP_URL}/share/${token}`

/** Everything except the token, which cannot be re-displayed by design. */
const linkColumns = {
  id: reviewLinks.id,
  label: reviewLinks.label,
  scope: reviewLinks.scope,
  contentItemId: reviewLinks.contentItemId,
  expiresAt: reviewLinks.expiresAt,
  revokedAt: reviewLinks.revokedAt,
  lastUsedAt: reviewLinks.lastUsedAt,
  useCount: reviewLinks.useCount,
  createdAt: reviewLinks.createdAt,
}

const mintSchema = z.object({
  days: z.number().int().min(1).max(365).optional(),
  /**
   * Who this one is for. Trimmed before the length check so "   " is not a
   * label — an empty string would defeat the point, which is telling two
   * otherwise identical rows apart.
   */
  label: z.string().trim().max(80).nullish(),
})

/**
 * Share one post.
 *
 * Refuses anything not shared with the client. That refusal is also enforced
 * by the `AND visible_to_client` arm added to content_items_select in 0016,
 * so a link minted around this handler would still read nothing — but
 * answering here means she gets a sentence rather than an empty page.
 */
shareRoutes.post('/content/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = mintSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const actorId = c.get('user')?.id ?? null
  const { token, tokenHash } = mintReviewToken()
  const expiresAt = reviewLinkExpiry(new Date(), parsed.data.days)

  const result = await withTenant(c.get('tenant'), async (tx) => {
    const [item] = await tx
      .select({
        id: contentItems.id,
        clientId: contentItems.clientId,
        visibleToClient: contentItems.visibleToClient,
        title: contentItems.title,
      })
      .from(contentItems)
      .where(eq(contentItems.id, id))
      .limit(1)
    if (!item) return { error: 'not_found' as const }

    if (!item.visibleToClient) {
      return { error: 'not_shared' as const }
    }

    const [row] = await tx
      .insert(reviewLinks)
      .values({
        clientId: item.clientId,
        contentItemId: item.id,
        scope: 'content_item',
        label: parsed.data.label || null,
        tokenHash,
        expiresAt,
        createdBy: actorId,
      })
      .returning(linkColumns)

    await audit(tx, {
      actorId,
      action: 'share.mint',
      entity: 'review_link',
      entityId: row.id,
      // The token is never logged, here or anywhere.
      meta: { scope: 'content_item', contentItemId: item.id, expiresAt },
    })

    return { link: row }
  })

  if ('error' in result) {
    return result.error === 'not_found'
      ? c.json({ error: 'Not found' }, 404)
      : c.json(
          {
            error:
              'Share it with the client first — this post is still internal, so a link to it would open an empty page.',
          },
          409
        )
  }

  logger.info({ linkId: result.link.id, scope: 'content_item' }, 'share link minted')
  return c.json({ link: result.link, url: linkUrl(token), days: REVIEW_LINK_DAYS }, 201)
})

/** Live and dead links for one post. Never the token. */
shareRoutes.get('/content/:id', async (c) => {
  const links = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select(linkColumns)
      .from(reviewLinks)
      .where(eq(reviewLinks.contentItemId, c.req.param('id')))
      .orderBy(desc(reviewLinks.createdAt))
  )
  return c.json({ links })
})

/** A read-only link to one client's feed grid. */
/**
 * The client-scoped share links, in one handler.
 *
 * `feed`, `moodboard` and `ideas` differ by one word in an insert and one word
 * in an audit row. Written as three handlers they would differ by that — and,
 * within a month, by whether the archived check is still there, which is the
 * one line here doing any work.
 */
const CLIENT_SCOPES = ['feed', 'moodboard', 'ideas'] as const
type ClientScope = (typeof CLIENT_SCOPES)[number]

const isClientScope = (v: string): v is ClientScope =>
  (CLIENT_SCOPES as readonly string[]).includes(v)

shareRoutes.post('/client/:id/:scope', async (c) => {
  const clientId = c.req.param('id')
  const scope = c.req.param('scope')
  // An unknown scope is a 404 rather than a 400: the route is not a thing.
  if (!isClientScope(scope)) return c.json({ error: 'Not found' }, 404)
  const parsed = mintSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const actorId = c.get('user')?.id ?? null
  const { token, tokenHash } = mintReviewToken()
  const expiresAt = reviewLinkExpiry(new Date(), parsed.data.days)

  const result = await withTenant(c.get('tenant'), async (tx) => {
    const [client] = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, clientId), isNull(clients.archivedAt)))
      .limit(1)
    if (!client) return null

    const [row] = await tx
      .insert(reviewLinks)
      .values({
        clientId: client.id,
        contentItemId: null,
        scope,
        label: parsed.data.label || null,
        tokenHash,
        expiresAt,
        createdBy: actorId,
      })
      .returning(linkColumns)

    await audit(tx, {
      actorId,
      action: 'share.mint',
      entity: 'review_link',
      entityId: row.id,
      meta: { scope, clientId: client.id, expiresAt },
    })

    return row
  })

  if (!result) return c.json({ error: 'Not found' }, 404)

  logger.info({ linkId: result.id, scope }, 'share link minted')
  return c.json({ link: result, url: linkUrl(token), days: REVIEW_LINK_DAYS }, 201)
})

/** Every link for one client's feed. */
shareRoutes.get('/client/:id/:scope', async (c) => {
  const scope = c.req.param('scope')
  if (!isClientScope(scope)) return c.json({ error: 'Not found' }, 404)

  const links = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select(linkColumns)
      .from(reviewLinks)
      // Scoped to the ONE view being asked about. Listing every client-scoped
      // link here would show the moodboard's links on the feed's popover, and
      // "Revoke" would then revoke something the reader was not looking at.
      .where(
        and(
          eq(reviewLinks.clientId, c.req.param('id')),
          eq(reviewLinks.scope, scope)
        )
      )
      .orderBy(desc(reviewLinks.createdAt))
  )
  return c.json({ links })
})

/**
 * Revoke — and there is deliberately NO delete.
 *
 * `content_approvals.review_link_id` is ON DELETE SET NULL under
 * CHECK num_nonnulls(actor_id, review_link_id) = 1, so deleting a link that
 * has been used to approve something nulls the FK on a row whose actor_id is
 * already NULL and violates the check. Reproduced against bd_portal_test; see
 * migration 0016. Revoking is also the better verb: the decision history has
 * to keep pointing at the link that made it.
 */
shareRoutes.post('/:id/revoke', async (c) => {
  const id = c.req.param('id')
  const actorId = c.get('user')?.id ?? null

  const [row] = await withTenant(c.get('tenant'), (tx) =>
    tx
      .update(reviewLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(reviewLinks.id, id), isNull(reviewLinks.revokedAt)))
      .returning(linkColumns)
  )

  if (!row) {
    // Already revoked, or not ours. Both are "there is nothing live here".
    return c.json({ error: 'That link is not live.' }, 404)
  }

  await withTenant(c.get('tenant'), (tx) =>
    audit(tx, {
      actorId,
      action: 'share.revoke',
      entity: 'review_link',
      entityId: id,
      meta: { useCount: row.useCount },
    })
  )

  logger.info({ linkId: id }, 'share link revoked')
  return c.json({ link: row })
})
