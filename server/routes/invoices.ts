import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant, type Tx } from '../db/index.js'
import { env } from '../env.js'
import { logger } from '../logger.js'
import { stripe, stripeEnabled, toStripeAmount } from '../lib/stripe.js'
import { clients, invoicePayments, invoices, systemMeta } from '../db/schema.js'
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
        /*
         * The attached document, if there is one.
         *
         * A correlated subquery rather than a join, so an invoice with no
         * attachment still comes back exactly once — a left join would be
         * correct today and would silently double the row the moment two
         * documents are attached to one invoice.
         *
         * Aliased explicitly. Interpolating Drizzle columns inside sql`` here
         * renders them unqualified, so `invoice_id` would bind to `files`'
         * own column rather than the outer invoice — the same trap the client
         * list's count subqueries carry a comment about.
         */
        attachmentId: sql<string | null>`(
          select f.id from files f
           where f.invoice_id = invoices.id
           order by f.created_at desc limit 1
        )`,
        attachmentName: sql<string | null>`(
          select f.name from files f
           where f.invoice_id = invoices.id
           order by f.created_at desc limit 1
        )`,
      })
      .from(invoices)
      .innerJoin(clients, eq(clients.id, invoices.clientId))
      .where(clientFilter ? eq(invoices.clientId, clientFilter) : undefined)
      .orderBy(desc(invoices.issuedOn), desc(invoices.createdAt))
  )

  return c.json({ invoices: rows })
})

/* ------------------------------------------------ the document's fixed half */

/**
 * How to pay her, and on what terms. One row per key in `system_meta`.
 *
 * Agency-wide rather than per invoice: it is the same sort code on every one,
 * and asking her to retype it each time is how a wrong account number ends up
 * on a document somebody pays against.
 *
 * NOT an environment variable and NOT a constant in this repository — the repo
 * is PUBLIC. It is not a credential (an account number is printed on every
 * invoice she sends) but there is no reason to publish it, which is the same
 * argument `deploy.config.sh` is gitignored under.
 *
 * `system_meta` carries no RLS because it holds nothing belonging to a tenant.
 * The guard list in `db/guard.ts` deliberately does not name it.
 */
const INVOICE_SETTING_KEYS = {
  paymentMethod: 'invoice.payment_method',
  paymentTerms: 'invoice.payment_terms',
  footer: 'invoice.footer',
} as const

export type InvoiceSettings = Record<keyof typeof INVOICE_SETTING_KEYS, string>

async function loadInvoiceSettings(tx: Tx): Promise<InvoiceSettings> {
  const rows = await tx
    .select({ key: systemMeta.key, value: systemMeta.value })
    .from(systemMeta)
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  return {
    paymentMethod: byKey.get(INVOICE_SETTING_KEYS.paymentMethod) ?? '',
    paymentTerms: byKey.get(INVOICE_SETTING_KEYS.paymentTerms) ?? '',
    footer: byKey.get(INVOICE_SETTING_KEYS.footer) ?? '',
  }
}

/**
 * Readable by a CLIENT, not just staff.
 *
 * This is the block that tells them where to send the money. Gating it to
 * staff would produce an invoice with an empty Payment Method box for the only
 * person who needs to read it.
 */
invoiceRoutes.get('/settings', async (c) => {
  const settings = await withTenant(c.get('tenant'), loadInvoiceSettings)
  return c.json({ settings })
})

const settingsSchema = z.object({
  paymentMethod: z.string().max(1000).optional(),
  paymentTerms: z.string().max(2000).optional(),
  footer: z.string().max(500).optional(),
})

invoiceRoutes.patch('/settings', requireStaff, async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const settings = await withTenant(c.get('tenant'), async (tx) => {
    for (const [field, key] of Object.entries(INVOICE_SETTING_KEYS)) {
      const value = parsed.data[field as keyof typeof INVOICE_SETTING_KEYS]
      if (value === undefined) continue
      // Upsert on the unique key, so saving twice does not accumulate rows.
      await tx
        .insert(systemMeta)
        .values({ key, value: value.trim() })
        .onConflictDoUpdate({
          target: systemMeta.key,
          set: { value: value.trim(), updatedAt: new Date() },
        })
    }
    return loadInvoiceSettings(tx)
  })

  await withTenant(c.get('tenant'), (tx) =>
    audit(tx, {
      actorId: c.get('user')?.id ?? null,
      action: 'invoice.settings.update',
      entity: 'system_meta',
      // The values are printed on every invoice, but an audit row is not the
      // place to keep a second copy of a bank account number.
      meta: { fields: Object.keys(parsed.data) },
    })
  )

  return c.json({ settings })
})

/**
 * One invoice with its receipts, plus everything the printable document needs.
 *
 * `billingAddress` and the settings block ride along rather than being fetched
 * by the document view separately: an invoice that renders in three requests
 * shows a header, then a body, then a payment block, and printing it mid-way
 * produces a document missing whichever part had not arrived.
 */
invoiceRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const detail = await withTenant(c.get('tenant'), async (tx) => {
    const [invoice] = await tx
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        clientName: clients.name,
        clientBillingAddress: clients.billingAddress,
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

    const settings = await loadInvoiceSettings(tx)

    return { invoice, payments, settings }
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
  /*
   * The itemised description, which is why this is 4000 and not 500.
   *
   * Her real invoices carry a paragraph and a numbered list under one line
   * item — "Development of a high-performance 10-page website", then the ten
   * pages, then five bullets of strategic importance. At 500 characters the
   * document could only ever hold the heading, which would have made the
   * printable invoice a worse version of the one she already writes by hand.
   * Line breaks are preserved and rendered as typed.
   */
  description: z.string().max(4000).nullish(),
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
  /*
   * The itemised description, which is why this is 4000 and not 500.
   *
   * Her real invoices carry a paragraph and a numbered list under one line
   * item — "Development of a high-performance 10-page website", then the ten
   * pages, then five bullets of strategic importance. At 500 characters the
   * document could only ever hold the heading, which would have made the
   * printable invoice a worse version of the one she already writes by hand.
   * Line breaks are preserved and rendered as typed.
   */
  description: z.string().max(4000).nullish(),
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
 * A Stripe Checkout Session for what is still owed on this invoice.
 *
 * `requireAuth`, not `requireStaff`, and that is deliberate: the same endpoint
 * serves her "send a payment request" button and the client's "Pay now"
 * button. RLS is what separates them — a client can only see an invoice once
 * `issued_on` is set, so an unissued draft simply is not found here, and no
 * check in this handler is what enforces that.
 *
 * Hosted Checkout rather than card fields of our own: no card number ever
 * touches this server, which keeps the whole application out of PCI scope. The
 * price is built inline rather than as a Stripe Product, because the invoice is
 * already the source of truth for what is owed and a second catalogue would be
 * a second thing to keep in step.
 */
invoiceRoutes.post('/:id/checkout', async (c) => {
  if (!stripeEnabled() || !stripe) {
    return c.json(
      { error: 'Card payments are not configured yet — STRIPE_SECRET_KEY is missing.' },
      503
    )
  }

  const id = c.req.param('id')

  const invoice = await withTenant(c.get('tenant'), async (tx) => {
    const [row] = await tx
      .select({
        id: invoices.id,
        clientId: invoices.clientId,
        number: invoices.number,
        description: invoices.description,
        currency: invoices.currency,
        amountPence: invoices.amountPence,
        status: invoices.status,
        issuedOn: invoices.issuedOn,
        paid: paidPence,
      })
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1)
    return row ?? null
  })

  if (!invoice) return c.json({ error: 'Not found' }, 404)
  if (invoice.status === 'void') {
    return c.json({ error: 'That invoice has been voided.' }, 409)
  }
  if (!invoice.issuedOn) {
    return c.json(
      { error: 'Issue the invoice first — a draft is your working copy and the client cannot see it.' },
      409
    )
  }

  const outstanding = invoice.amountPence - invoice.paid
  if (outstanding <= 0) {
    return c.json({ error: `${invoice.number} is already paid in full.` }, 409)
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: invoice.currency.toLowerCase(),
          unit_amount: toStripeAmount(outstanding),
          product_data: {
            name: invoice.number,
            ...(invoice.description ? { description: invoice.description } : {}),
          },
        },
      },
    ],
    // The webhook reads these back. Stripe returns metadata verbatim, and it
    // is the only thing tying a session to a row in this database — the
    // amount alone would be ambiguous across two invoices for the same figure.
    metadata: { invoiceId: invoice.id, invoiceNumber: invoice.number },
    success_url: `${env.APP_URL}/portal?paid=${encodeURIComponent(invoice.number)}`,
    cancel_url: `${env.APP_URL}/portal`,
  })

  if (!session.url) {
    return c.json({ error: 'Stripe did not return a payment page. Try again.' }, 502)
  }

  logger.info(
    { invoiceId: invoice.id, number: invoice.number, outstanding, sessionId: session.id },
    'stripe checkout session created'
  )
  return c.json({ url: session.url, amountPence: outstanding, number: invoice.number })
})

/**
 * Write a payment against an invoice. The one place that does.
 *
 * Extracted so a card payment arriving by webhook takes EXACTLY the path she
 * takes by hand — the same overpayment refusal, the same receipt numbering,
 * the same audit and activity rows. A second implementation for Stripe would
 * be a second set of money rules, and the two would drift the first time one
 * of them was corrected.
 *
 * Returns a discriminated result rather than throwing, because "that is more
 * than is outstanding" is an answer for the caller to render, not a fault.
 * `null` means the invoice is not visible to whoever is asking — RLS decides
 * that, not this function.
 */
export async function recordPayment(
  tx: Tx,
  input: {
    invoiceId: string
    amountPence: number
    paidOn: string
    method: string | null
    reference: string | null
    actorId: string | null
    /** Stripe Checkout Session id. Null for anything entered by hand. */
    externalId?: string | null
  }
): Promise<{ payment: typeof invoicePayments.$inferSelect } | { error: string } | null> {
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
    .where(eq(invoices.id, input.invoiceId))
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
   *
   * This applies to card payments too. A Checkout Session is created for the
   * outstanding amount, but she can record a bank transfer while the client
   * has the payment page open — so the invoice can be settled between the
   * session being made and the card clearing.
   */
  const remaining = invoice.amountPence - invoice.paid
  if (input.amountPence > remaining) {
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
      invoiceId: input.invoiceId,
      receiptNumber,
      amountPence: input.amountPence,
      paidOn: input.paidOn,
      method: input.method,
      reference: input.reference,
      externalId: input.externalId ?? null,
      recordedBy: input.actorId,
    })
    .returning()

  const nowPaid = invoice.paid + input.amountPence
  await audit(tx, {
    actorId: input.actorId,
    action: 'invoice.payment',
    entity: 'invoice',
    entityId: input.invoiceId,
    meta: { receiptNumber, amountPence: input.amountPence, externalId: input.externalId ?? null },
  })
  await recordActivity(tx, {
    clientId: invoice.clientId,
    entityType: 'invoice',
    entityId: input.invoiceId,
    actorId: input.actorId,
    kind: 'note',
    body:
      nowPaid >= invoice.amountPence
        ? `Invoice ${invoice.number} paid in full (receipt ${receiptNumber})`
        : `Payment received on ${invoice.number} (receipt ${receiptNumber})`,
  })

  return { payment: row }
}

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

  const result = await withTenant(c.get('tenant'), (tx) =>
    recordPayment(tx, {
      invoiceId: id,
      amountPence: data.amountPence,
      paidOn: data.paidOn,
      method: data.method ?? null,
      reference: data.reference ?? null,
      actorId,
    })
  )

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
