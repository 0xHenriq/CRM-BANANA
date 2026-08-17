import type { MiddlewareHandler } from 'hono'
import { logger } from '../logger.js'

type Bucket = { count: number; resetAt: number }

/**
 * Fixed-window rate limiter, in process.
 *
 * Better Auth rate limits its own routes, but nothing covered the invitation
 * endpoints — which are unauthenticated by necessity, and therefore the only
 * unauthenticated surface we own. A comment in invitations.ts claimed this
 * protection existed before it did.
 *
 * In-memory is correct while there is a single instance. When the background
 * worker lands in v1.3 and brings Redis, move the counter there or two
 * processes will each allow the full quota.
 */
export function rateLimit(opts: {
  windowMs: number
  max: number
  name: string
}): MiddlewareHandler {
  const buckets = new Map<string, Bucket>()

  return async (c, next) => {
    const now = Date.now()

    // Behind Caddy and the Cloudflare tunnel the socket address is always
    // localhost, so the forwarded headers are the only real client identity.
    const ip =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      'unknown'
    const key = `${opts.name}:${ip}`

    // Opportunistic sweep — without it the map grows unbounded under scanning.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
    }

    const bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs })
      return next()
    }

    bucket.count += 1
    if (bucket.count > opts.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      logger.warn({ ip, limiter: opts.name, count: bucket.count }, 'rate limited')
      c.header('Retry-After', String(retryAfter))
      return c.json(
        { error: 'Too many attempts. Please try again shortly.' },
        429
      )
    }

    return next()
  }
}
