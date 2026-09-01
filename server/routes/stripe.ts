import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { withTenant } from '../db/index.js'
import { invoicePayments } from '../db/schema.js'
import { env } from '../env.js'
import { stripe, stripeEnabled } from '../lib/stripe.js'
import { logger } from '../logger.js'
import { recordPayment } from './invoices.js'

/**
 * Stripe's webhook. The only unauthenticated route that writes money.
 *
 * There is no session here and there cannot be — Stripe's servers call this,
 * not a browser. The signature IS the authentication: every delivery carries
 * a `stripe-signature` header computed with the endpoint's signing secret, and
 * `constructEvent` recomputes it over the RAW body. Anything that fails is
 * refused before a single field is read.
 *
 * If the signing secret is absent the handler refuses outright rather than
 * "trusting for now". An unverified webhook is an open endpoint that writes
 * payment rows: anyone who found the URL could post a JSON body and mark
 * every invoice paid.
 */
export const stripeRoutes = new Hono()

stripeRoutes.post('/webhook', async (c) => {
  if (!stripeEnabled() || !stripe) {
    logger.warn('stripe webhook called but no secret key is configured')
    return c.json({ error: 'Not configured' }, 503)
  }
  if (!env.STRIPE_WEBHOOK_SECRET) {
    // Loud, because this one is silent otherwise: payments would arrive, be
    // refused, and she would find out from a client asking why their card was
    // charged and the invoice still says unpaid.
    logger.error('stripe webhook received but STRIPE_WEBHOOK_SECRET is not set — refusing')
    return c.json({ error: 'Not configured' }, 503)
  }

  const signature = c.req.header('stripe-signature')
  if (!signature) return c.json({ error: 'Missing signature' }, 400)

  /*
   * The RAW body, before any JSON parsing.
   *
   * The signature is computed over the exact bytes Stripe sent. Parsing and
   * re-serialising changes key order and whitespace, and every signature then
   * fails for reasons that look like a wrong secret.
   */
  const raw = await c.req.text()

  let event
  try {
    event = stripe.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    logger.warn({ err }, 'stripe webhook signature rejected')
    return c.json({ error: 'Invalid signature' }, 400)
  }

  // Everything else is acknowledged and ignored. Returning 2xx stops Stripe
  // retrying an event we were never going to act on.
  if (event.type !== 'checkout.session.completed') {
    return c.json({ received: true, ignored: event.type })
  }

  const session = event.data.object
  const invoiceId = session.metadata?.invoiceId
  const amount = session.amount_total

  if (!invoiceId || typeof amount !== 'number' || amount <= 0) {
    logger.warn({ sessionId: session.id }, 'checkout completed without a usable invoice reference')
    // 200 on purpose: retrying will not add the metadata. This needs a human,
    // not another delivery.
    return c.json({ received: true, ignored: 'no invoice metadata' })
  }

  // Only money actually collected. An unpaid session can complete when the
  // method is delayed, and recording it would say she has been paid when she
  // has not.
  if (session.payment_status !== 'paid') {
    logger.info(
      { sessionId: session.id, status: session.payment_status },
      'checkout completed but not paid; nothing recorded'
    )
    return c.json({ received: true, ignored: session.payment_status })
  }

  /*
   * Already recorded? Then this is a retry, and retries are ORDINARY.
   *
   * Stripe redelivers until it gets a 2xx, so the same event arrives again
   * after a slow response, a deploy mid-delivery, or a network blip. This
   * check has to come BEFORE the money rules: without it the second delivery
   * fell through to the overpayment refusal — correct in that it wrote no
   * duplicate row, but it logged "CARD PAYMENT TAKEN THAT COULD NOT BE
   * RECORDED — refund or correct the invoice" every time, which is an alarm
   * about a non-event. Caught by replaying a signed event twice.
   *
   * The unique index on external_id stays as the backstop for the case this
   * cannot cover: two deliveries in flight at once, where both read before
   * either writes. Only the database can settle that.
   */
  const already = await withTenant({ userId: null, isStaff: true }, (tx) =>
    tx
      .select({ receiptNumber: invoicePayments.receiptNumber })
      .from(invoicePayments)
      .where(eq(invoicePayments.externalId, session.id))
      .limit(1)
  )
  if (already.length) {
    logger.info(
      { sessionId: session.id, receipt: already[0].receiptNumber },
      'stripe webhook redelivered; already recorded'
    )
    return c.json({ received: true, duplicate: true, receipt: already[0].receiptNumber })
  }

  /*
   * Staff context, because there is no user here at all.
   *
   * A card payment is the agency recording money against its own invoice, and
   * `invoices` and `invoice_payments` are both staff-writable. The authority
   * for this write is Stripe's signature, which has already been verified
   * above — nothing about the request body is trusted to decide it.
   */
  try {
    const result = await withTenant({ userId: null, isStaff: true }, (tx) =>
      recordPayment(tx, {
        invoiceId,
        amountPence: amount,
        // Stripe timestamps are seconds. The date is taken in the agency's own
        // calendar, like every other date in this application.
        paidOn: new Date(event.created * 1000).toLocaleDateString('en-CA'),
        method: 'Card (Stripe)',
        reference: session.payment_intent ? String(session.payment_intent) : null,
        actorId: null,
        externalId: session.id,
      })
    )

    if (result === null) {
      logger.warn({ invoiceId, sessionId: session.id }, 'paid session for an invoice that no longer exists')
      return c.json({ received: true, ignored: 'unknown invoice' })
    }
    if ('error' in result) {
      // The invoice was settled between the session being made and the card
      // clearing — she recorded a transfer while they had the page open. The
      // money is real and needs a human, so it is logged loudly and NOT
      // retried.
      logger.error(
        { invoiceId, sessionId: session.id, amount, reason: result.error },
        'CARD PAYMENT TAKEN THAT COULD NOT BE RECORDED — refund or correct the invoice'
      )
      return c.json({ received: true, ignored: 'would exceed the invoice' })
    }

    logger.info(
      { invoiceId, receipt: result.payment.receiptNumber, amount },
      'card payment recorded'
    )
    return c.json({ received: true, receipt: result.payment.receiptNumber })
  } catch (err) {
    /*
     * The unique index on external_id did its job: this delivery is a repeat.
     * 200, so Stripe stops retrying — the payment is already recorded.
     */
    if (String((err as { code?: string })?.code) === '23505') {
      logger.info({ sessionId: session.id }, 'duplicate stripe webhook ignored')
      return c.json({ received: true, duplicate: true })
    }
    throw err
  }
})
