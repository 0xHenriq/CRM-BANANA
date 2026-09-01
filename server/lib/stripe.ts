import Stripe from 'stripe'
import { env } from '../env.js'

/**
 * The Stripe client, or null when no key is configured.
 *
 * Null rather than throwing at import time: the portal must boot without
 * Stripe. She ran it for weeks before there were keys, and a missing payment
 * integration should cost her the Pay button, not the whole application.
 * Callers check `stripeEnabled()` and answer 503 with a sentence saying what
 * is missing.
 */
export const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY)
  : null

export function stripeEnabled(): boolean {
  return stripe !== null
}

/**
 * Stripe takes the smallest currency unit, which is exactly how this codebase
 * already carries money — integer pence, never a float. So there is no
 * conversion here at all, and that is the point: the moment an amount passes
 * through a `Number(x) * 100` it can arrive as 4299.599999999999.
 */
export function toStripeAmount(pence: number): number {
  if (!Number.isInteger(pence) || pence <= 0) {
    throw new Error(`Refusing to charge a non-integer or non-positive amount: ${pence}`)
  }
  return pence
}
