import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant, type Tx } from '../db/index.js'
import { clients, invoicePayments, invoices } from '../db/schema.js'
import { audit, recordActivity } from '../lib/audit.js'
import { requireAuth, requireStaff } from '../middleware/session.js'

export const invoiceRoutes = new Hono()

invoiceRoutes.use('*', requireAuth)

export const INVOICE_STATUSES = ['draft', 'sent', 'void'] as const

/**
 * Today as a local calendar date.
 *
 * Never toISOString().slice(0,10) — that converts to UTC first, so an evening
 * in London issues an invoice dated yesterday. The same trap the content
 * calendar documents.
 */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The next invoice or receipt number.
 *
 * A Postgres sequence rather than max(number)+1: two invoices raised in the
 * same second would race on a max() and collide on the unique index. Gaps are
 * expected — a sequence is not gapless, and neither is a real invoice book once
 * something has been voided.
 */
async function nextNumber(
  tx: Tx,
  kind: 'invoice' | 'receipt'
): Promise<string> {
  const prefix = kind === 'invoice' ? 'INV' : 'RCP'
  const seq = kind === 'invoice' ? 'invoice_number_seq' : 'receipt_number_seq'
  const result = await tx.execute<{ n: string }>(
    sql`select nextval(${seq})::text as n`
  )
  const n = Number(result.rows[0]?.n ?? 0)
  return `${prefix}-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`
}

/**
 * How much has actually been paid, as a correlated subquery.
 *
 * Written with an explicit alias — `from invoice_payments p where p.invoice_id
 * = invoices.id` — and NOT by interpolating Drizzle columns. Drizzle renders
 * those unqualified, so inside the subquery `id` would bind to
 * invoice_payments.id, the comparison would always be false, and every invoice
 * would read as unpaid. Silently. That exact bug has already been paid for
 * once in this codebase, on the client dashboard counts.
 */
const paidPence = sql<number>`(
  select coalesce(sum(p.amount_pence), 0)::int
    from invoice_payments p
   where p.invoice_id = invoices.id
)`

/**
 * Everything the caller may see, newest first.
 *
 * No resolveClientId here: RLS already limits a client-role session to their
 * own issued invoices, so the same query serves both audiences — staff get
 * every client (which is what the payment schedule needs), a client gets
 * theirs. `?client=` narrows it for the per-client views.
 */
invoiceRoutes.get('/', async (c) => {
  const clientFilter = c.req.query('client')

  const rows = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        clientName: clients.name,
        dealId: invoices.dealId,
        number: invoices.number,
        status: invoices.status,
        amountPence: invoices.amountPence,
        paidPence,
        currency: invoices.currency,
        description: invoices.description,
        issuedOn: invoices.issuedOn,
        dueOn: invoices.dueOn,
        notes: invoices.notes,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(clientFilter ? eq(invoices.clientId, clientFilter) : undefined)
      .orderBy(desc(invoices.issuedOn), desc(invoices.createdAt))
  )

  return c.json({ invoices: rows })
})

/** One invoice with its receipts. */
invoiceRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const detail = await withTenant(c.get('tenant'), async (tx) => {
    const [invoice] = await tx
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        clientName: clients.name,
        dealId: invoices.dealId,
        number: invoices.number,
        status: invoices.status,
        amountPence: invoices.amountPence,
        paidPence,
        currency: invoices.currency,
        description: invoices.description,
        issuedOn: invoices.issuedOn,
        dueOn: invoices.dueOn,
        notes: invoices.notes,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(eq(invoices.id, id))
      .limit(1)
    if (!invoice) return null

    const payments = await tx
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, id))
      .orderBy(asc(invoicePayments.paidOn))

    return { invoice, payments }
  })

  if (!detail) return c.json({ error: 'Not found' }, 404)
  return c.json(detail)
})

const createSchema = z.object({
  clientId: z.uuid(),
  dealId: z.uuid().nullish(),
  /** Integer pence. The client sends pence so nothing is parsed twice. */
  amountPence: z.number().int().positive('An invoice needs an amount.'),
  currency: z.string().length(3).default('GBP'),
  description: z.string().max(500).nullish(),
  dueOn: z.string().date().nullish(),
  notes: z.string().max(4000).nullish(),
  /** Raise it as a draft, or issue it immediately. */
  issue: z.boolean().default(false),
})

invoiceRoutes.post('/', requireStaff, async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      400
    )
  }
  const data = parsed.data
  const actorId = c.get('user')?.id ?? null

  const created = await withTenant(c.get('tenant'), async (tx) => {
    // Confirm the workspace is one this caller may see before numbering an
    // invoice against it — RLS would refuse the insert anyway, but burning a
    // sequence value on a request that cannot succeed is avoidable.
    const [client] = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, data.clientId))
      .limit(1)
    if (!client) return null

    const number = await nextNumber(tx, 'invoice')
    const [row] = await tx
      .insert(invoices)
      .values({
        clientId: data.clientId,
        dealId: data.dealId ?? null,
        number,
        status: data.issue ? 'sent' : 'draft',
        amountPence: data.amountPence,
        currency: data.currency,
        description: data.description ?? null,
        // issued_on is the RLS gate: setting it is what makes the invoice
        // visible to the client, so it is set exactly when it is issued.
        issuedOn: data.issue ? today() : null,
        dueOn: data.dueOn ?? null,
        notes: data.notes ?? null,
        createdBy: actorId,
      })
      .returning()

    await audit(tx, {
      actorId,
      action: 'invoice.create',
      entity: 'invoice',
      entityId: row.id,
      meta: { number, amountPence: row.amountPence, issued: data.issue },
    })
    if (data.issue) {
      await recordActivity(tx, {
        clientId: row.clientId,
        entityType: 'invoice',
        entityId: row.id,
        actorId,
        kind: 'note',
        body: `Invoice ${number} issued${row.dueOn ? `, due ${row.dueOn}` : ''}`,
      })
    }
    return row
  })

  if (!created) return c.json({ error: 'That client does not exist' }, 404)
  return c.json({ invoice: created }, 201)
})

const updateSchema = z.object({
  amountPence: z.number().int().positive().optional(),
  description: z.string().max(500).nullish(),
  dueOn: z.string().date().nullish(),
  notes: z.string().max(4000).nullish(),
  status: z.enum(INVOICE_STATUSES).optional(),
  dealId: z.uuid().nullish(),
})

invoiceRoutes.patch('/:id', requireStaff, async (c) => {
  const id = c.req.param('id')
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: 'Nothing to update' }, 400)
  }
  const patch = parsed.data
  const actorId = c.get('user')?.id ?? null

  const updated = await withTenant(c.get('tenant'), async (tx) => {
    const [before] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1)
    if (!before) return null

    /**
     * Issuing stamps the date; un-issuing never clears it.
     *
     * `issued_on` is the RLS gate, so clearing it would retroactively hide an
     * invoice the client has already been sent and may be looking at. Moving a
     * sent invoice back to draft is not a thing an invoice book allows either
     * — the correction is a void, which stays visible and says so.
     */
    const issuing = patch.status === 'sent' && !before.issuedOn
    const [row] = await tx
      .update(invoices)
      .set({
        ...patch,
        ...(issuing ? { issuedOn: today() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, id))
      .returning()

    if (patch.status && patch.status !== before.status) {
      await recordActivity(tx, {
        clientId: row.clientId,
        entityType: 'invoice',
        entityId: row.id,
        actorId,
        kind: 'note',
        body:
          patch.status === 'sent'
            ? `Invoice ${row.number} issued${row.dueOn ? `, due ${row.dueOn}` : ''}`
            : patch.status === 'void'
              ? `Invoice ${row.number} voided`
              : `Invoice ${row.number} moved back to draft`,
      })
    }

    await audit(tx, {
      actorId,
      action: 'invoice.update',
      entity: 'invoice',
      entityId: id,
      meta: { before: { status: before.status, amountPence: before.amountPence }, patch },
    })
    return row
  })

  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json({ invoice: updated })
})

/**
 * Only a draft can be deleted.
 *
 * Once an invoice has been issued the client has a copy of it, and making it
 * vanish leaves them holding a document this system denies exists. Voiding is
 * the correction: it stays visible and says what happened.
 */
invoiceRoutes.delete('/:id', requireStaff, async (c) => {
  const id = c.req.param('id')
  const actorId = c.get('user')?.id ?? null

  const outcome = await withTenant(c.get('tenant'), async (tx) => {
    const [before] = await tx
      .select({ id: invoices.id, number: invoices.number, issuedOn: invoices.issuedOn })
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1)
    if (!before) return 'missing' as const
    if (before.issuedOn) return 'issued' as const

    await tx.delete(invoices).where(eq(invoices.id, id))
    await audit(tx, {
      actorId,
      action: 'invoice.delete',
      entity: 'invoice',
      entityId: id,
      meta: { number: before.number },
    })
    return 'deleted' as const
  })

  if (outcome === 'missing') return c.json({ error: 'Not found' }, 404)
  if (outcome === 'issued') {
    return c.json(
      {
        error:
          'This invoice has been issued, so it cannot be deleted. Void it instead — the client already has a copy.',
      },
      409
    )
  }
  return c.json({ ok: true })
})

/* ---------------------------------------------------------------- receipts */

const paymentSchema = z.object({
  amountPence: z.number().int().positive('A payment needs an amount.'),
  paidOn: z.string().date(),
  method: z.string().max(60).nullish(),
  reference: z.string().max(120).nullish(),
})

/**
 * Record money received. The row IS the receipt.
 *
 * Partial payments are ordinary — a deposit and a balance are two rows against
 * one invoice, which is why "paid" is a sum rather than a flag.
 */
invoiceRoutes.post('/:id/payments', requireStaff, async (c) => {
  const id = c.req.param('id')
  const parsed = paymentSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      400
    )
  }
  const data = parsed.data
  const actorId = c.get('user')?.id ?? null

  const result = await withTenant(c.get('tenant'), async (tx) => {
    const [invoice] = await tx
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        number: invoices.number,
        amountPence: invoices.amountPence,
        status: invoices.status,
        paid: paidPence,
      })
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1)
    if (!invoice) return null

    if (invoice.status === 'void') {
      return { error: 'That invoice has been voided.' }
    }

    /**
     * Refuse a payment that would exceed the invoice.
     *
     * Overpayment in a one-person agency is almost always a typo — 500000
     * pence typed where 50000 was meant — and silently accepting it makes the
     * books wrong in a way nobody notices until a reconciliation. The message
     * names both figures so the mistake is obvious; a genuine overpayment is
     * handled by correcting the invoice, which is the honest record anyway.
     */
    const remaining = invoice.amountPence - invoice.paid
    if (data.amountPence > remaining) {
      return {
        error:
          `That is more than is outstanding. ${invoice.number} has £${(remaining / 100).toFixed(2)} left to pay ` +
          `of £${(invoice.amountPence / 100).toFixed(2)}.`,
      }
    }

    const receiptNumber = await nextNumber(tx, 'receipt')
    const [row] = await tx
      .insert(invoicePayments)
      .values({
        clientId: invoice.clientId,
        invoiceId: id,
        receiptNumber,
        amountPence: data.amountPence,
        paidOn: data.paidOn,
        method: data.method ?? null,
        reference: data.reference ?? null,
        recordedBy: actorId,
      })
      .returning()

    const nowPaid = invoice.paid + data.amountPence
    await audit(tx, {
      actorId,
      action: 'invoice.payment',
      entity: 'invoice',
      entityId: id,
      meta: { receiptNumber, amountPence: data.amountPence },
    })
    await recordActivity(tx, {
      clientId: invoice.clientId,
      entityType: 'invoice',
      entityId: id,
      actorId,
      kind: 'note',
      body:
        nowPaid >= invoice.amountPence
          ? `Invoice ${invoice.number} paid in full (receipt ${receiptNumber})`
          : `Payment received on ${invoice.number} (receipt ${receiptNumber})`,
    })

    return { payment: row }
  })

  if (!result) return c.json({ error: 'Not found' }, 404)
  if ('error' in result) return c.json({ error: result.error }, 409)
  return c.json(result, 201)
})

/**
 * Withdraw a mis-keyed payment.
 *
 * There is no UPDATE policy on invoice_payments: a receipt's amount and date
 * are evidence, and rewriting one in place would leave the client holding a
 * receipt that no longer matches ours. Withdrawing and re-recording issues a
 * NEW receipt number, which is the honest way to correct it.
 */
invoiceRoutes.delete('/:id/payments/:paymentId', requireStaff, async (c) => {
  const id = c.req.param('id')
  const paymentId = c.req.param('paymentId')
  const actorId = c.get('user')?.id ?? null

  const removed = await withTenant(c.get('tenant'), async (tx) => {
    const rows = await tx
      .delete(invoicePayments)
      .where(
        and(
          eq(invoicePayments.id, paymentId),
          eq(invoicePayments.invoiceId, id)
        )
      )
      .returning({ receiptNumber: invoicePayments.receiptNumber })
    if (rows.length) {
      await audit(tx, {
        actorId,
        action: 'invoice.payment.withdraw',
        entity: 'invoice',
        entityId: id,
        meta: { receiptNumber: rows[0].receiptNumber },
      })
    }
    return rows
  })

  if (!removed.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})
