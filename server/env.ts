import { z } from 'zod'

/**
 * Fail loudly at boot rather than at the first request. A missing DATABASE_URL
 * that surfaces as a 500 three screens into a client demo is the worst version
 * of this bug.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_URL_OWNER: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(4300),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  MAX_SEATS: z.coerce.number().int().positive().default(10),
  /** Public origin. Better Auth derives callbacks and cookie domain from it. */
  APP_URL: z.string().url().default('http://localhost:5173'),
  /** Signing key for sessions. Rotating it invalidates every login. */
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  UPLOAD_DIR: z.string().default('./.uploads'),
  /**
   * Stripe. Optional, so the app still boots without them — every payment
   * route answers 503 with a sentence saying what is missing rather than
   * throwing, because a portal that will not start is worse than one that
   * cannot take a card yet.
   */
  STRIPE_SECRET_KEY: z.string().optional(),
  /**
   * From the webhook endpoint, not the API keys page. Without it a webhook
   * cannot be verified, and an UNVERIFIED webhook is an open endpoint that
   * writes payment rows — so the handler refuses to run at all rather than
   * trusting the body.
   */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /**
   * The password hub's encryption key. Optional in the same way and for the
   * same reason as the Stripe keys — the app boots without it and the hub says
   * what is missing — but with one difference worth stating: absent, nothing
   * is stored at all. There is no degraded mode where a password is written in
   * plain text "until the key is set up", because that is how plain text
   * becomes permanent.
   *
   * NOT BETTER_AUTH_SECRET. Rotating that logs everyone out and is recoverable
   * in a minute; rotating it must not also make every stored password
   * undecryptable, which is not recoverable at all.
   */
  CREDENTIALS_SECRET: z.string().min(32).optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`Invalid environment:\n${issues}`)
}

export const env = parsed.data

if (env.NODE_ENV === 'production' && !env.BETTER_AUTH_SECRET) {
  // Without an explicit secret Better Auth derives one, which changes between
  // deploys — silently logging everyone out — and is not a value anyone chose.
  throw new Error(
    'BETTER_AUTH_SECRET is required in production. Generate one with:\n' +
      '  openssl rand -base64 48'
  )
}

if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
  // Not fatal — the bare-IP fallback in the deploy plan is a legitimate,
  // temporary configuration. But it should never pass unnoticed.
  // eslint-disable-next-line no-console
  console.warn(
    '[env] COOKIE_SECURE=false in production: session cookies will be sent ' +
      'over plaintext HTTP. Only acceptable on the bare-IP fallback ingress.'
  )
}
