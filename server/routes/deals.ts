import { desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import { clients, deals } from '../db/schema.js'
import { audit, recordActivity } from '../lib/audit.js'
import { requireStaff } from '../middleware/session.js'

export const dealRoutes = new Hono()

dealRoutes.use('*', requireStaff)

/**
 * Deal stages, in board order.
 *
 * Derived from her own process, which the prototype's default links spell out:
 * Proposal → Kick Off Meeting → Agreement. `won` is the point the retainer
 * starts and the portal opens.
 */
/**
 * Payment states she can set. `overdue` is not one of them — see the note on
 * the enum in schema.ts. The client derives it from `paymentDue`.
 */
export const PAYMENT_STATUSES = ['none', 'awaiting', 'paid'] as const

export const DEAL_STAGES = [
  'lead',
  'contacted',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const

dealRoutes.get('/', async (c) => {
  const rows = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({
        id: deals.id,
        title: deals.title,
        value: deals.value,
        currency: deals.currency,
        stage: deals.stage,
        expectedClose: deals.expectedClose,
        paymentStatus: deals.paymentStatus,
        paymentDue: deals.paymentDue,
        paidAt: deals.paidAt,
        clientId: deals.clientId,
        clientName: clients.name,
        updatedAt: deals.updatedAt,
      })
      .from(deals)
      .innerJoin(clients, eq(clients.id, deals.clientId))
      /*
       * Not an archived client's deals.
       *
       * This list feeds the pipeline board and the dashboard — the two screens
       * she archived a client to clear. Her own client page loads its deals
       * directly by id, so an archived client's page still shows theirs and
       * nothing is hidden from the place it belongs.
       */
      .where(isNull(clients.archivedAt))
      .orderBy(desc(deals.updatedAt))
  )

  return c.json({ deals: rows, stages: DEAL_STAGES })
})

const createSchema = z.object({
  clientId: z.uuid(),
  title: z.string().min(1).max(160),
  // Sent as a string so 2400.00 survives the round trip without float drift;
  // numeric(12,2) in Postgres, string in JS. Never parseFloat this.
  value: z.string().regex(/^\d+(\.\d{1,2})?$/).nullish(),
  currency: z.string().length(3).default('GBP'),
  stage: z.enum(DEAL_STAGES).default('lead'),
  expectedClose: z.string().date().nullish(),
  paymentStatus: z.enum(PAYMENT_STATUSES).default('none'),
  paymentDue: z.string().date().nullish(),
})

dealRoutes.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const actorId = c.get('user')?.id ?? null
  const data = parsed.data

  const created = await withTenant(c.get('tenant'), async (tx) => {
    const [row] = await tx
      .insert(deals)
      .values({
        clientId: data.clientId,
        title: data.title,
        value: data.value ?? null,
        currency: data.currency,
        stage: data.stage,
        expectedClose: data.expectedClose ?? null,
        paymentStatus: data.paymentStatus,
        paymentDue: data.paymentDue ?? null,
        paidAt: data.paymentStatus === 'paid' ? today() : null,
        ownerId: actorId,
      })
      .returning()

    await audit(tx, {
      actorId,
      action: 'deal.create',
      entity: 'deal',
      entityId: row.id,
      meta: { clientId: data.clientId, title: data.title, stage: data.stage },
    })
    await recordActivity(tx, {
      clientId: data.clientId,
      entityType: 'deal',
      entityId: row.id,
      actorId,
      kind: 'status_change',
      body: `Deal "${data.title}" created at ${data.stage}`,
    })

    return row
  })

  return c.json({ deal: created }, 201)
})

const updateSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  value: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  stage: z.enum(DEAL_STAGES).optional(),
  expectedClose: z.string().date().nullable().optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  paymentDue: z.string().date().nullable().optional(),
})

/**
 * Today as a local calendar date.
 *
 * Not toISOString().slice(0,10): that converts to UTC first, so an evening in
 * London stamps a payment as received the previous day. Same reasoning as
 * isoDate() on the calendar.
 */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * `paid_at` is stamped by the server, never sent by the client.
 *
 * It is the answer to "when did they actually pay", which is a fact about the
 * moment she marked it, not something worth trusting a request body for. It is
 * cleared if a payment is un-marked, so a mistaken tick leaves no false record.
 */
function paidAtFor(
  next: (typeof PAYMENT_STATUSES)[number] | undefined,
  before: { paymentStatus: string; paidAt: string | null }
): { paidAt?: string | null } {
  if (next === undefined || next === before.paymentStatus) return {}
  return { paidAt: next === 'paid' ? today() : null }
}

/**
 * Also the drag-and-drop endpoint: moving a card between columns is a stage
 * patch. Stage changes are written to the client timeline, because "when did
 * this go to proposal" is a question she will ask.
 */
dealRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const actorId = c.get('user')?.id ?? null
  const patch = parsed.data

  const updated = await withTenant(c.get('tenant'), async (tx) => {
    const [before] = await tx.select().from(deals).where(eq(deals.id, id)).limit(1)
    if (!before) return null

    const [row] = await tx
      .update(deals)
      .set({
        ...patch,
        ...paidAtFor(patch.paymentStatus, before),
        updatedAt: new Date(),
      })
      .where(eq(deals.id, id))
      .returning()

    if (patch.paymentStatus && patch.paymentStatus !== before.paymentStatus) {
      await recordActivity(tx, {
        clientId: row.clientId,
        entityType: 'deal',
        entityId: row.id,
        actorId,
        kind: 'status_change',
        body:
          patch.paymentStatus === 'paid'
            ? `"${row.title}" marked paid`
            : patch.paymentStatus === 'awaiting'
              ? `"${row.title}" awaiting payment${row.paymentDue ? `, due ${row.paymentDue}` : ''}`
              : `"${row.title}" payment tracking cleared`,
      })
    }

    if (patch.stage && patch.stage !== before.stage) {
      await recordActivity(tx, {
        clientId: row.clientId,
        entityType: 'deal',
        entityId: row.id,
        actorId,
        kind: 'status_change',
        body: `Deal "${row.title}": ${before.stage} → ${patch.stage}`,
      })
    }

    await audit(tx, {
      actorId,
      action: 'deal.update',
      entity: 'deal',
      entityId: id,
      meta: { before: { stage: before.stage, value: before.value }, patch },
    })

    return row
  })

  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json({ deal: updated })
})

dealRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const actorId = c.get('user')?.id ?? null

  await withTenant(c.get('tenant'), async (tx) => {
    await tx.delete(deals).where(eq(deals.id, id))
    await audit(tx, {
      actorId,
      action: 'deal.delete',
      entity: 'deal',
      entityId: id,
    })
  })

  return c.json({ ok: true })
})
