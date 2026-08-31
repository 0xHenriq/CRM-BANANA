import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from '../auth/index.js'
import { getOrganizationId } from '../auth/org.js'
import { db } from '../db/index.js'
import { invitation, member, user } from '../db/auth-schema.js'
import { logger } from '../logger.js'
import { rateLimit } from '../middleware/rate-limit.js'

/**
 * Invitation acceptance.
 *
 * Better Auth's own acceptInvitation assumes the invitee already has an
 * account, but public sign-up is disabled — seats are invited, never
 * self-served. So the account has to be created here, at the moment the
 * invitation is redeemed, using the same internal adapter (and therefore the
 * same password hashing) a normal registration would.
 *
 * Unauthenticated by necessity: the whole point is that the caller has no
 * account yet. The invitation id is the credential, which is why it is a
 * 32-character random token and why this route is rate limited.
 */
export const invitationRoutes = new Hono()

// The only unauthenticated surface we own. 20 lookups and 5 acceptances per
// 15 minutes per IP is far above any honest use and far below useful scanning.
invitationRoutes.use('*', rateLimit({ windowMs: 15 * 60_000, max: 20, name: 'invitation-read' }))
invitationRoutes.use('/:id/accept', rateLimit({ windowMs: 15 * 60_000, max: 5, name: 'invitation-accept' }))

/** Enough to render "You've been invited as…" without leaking anything else. */
invitationRoutes.get('/:id', async (c) => {
  const rows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(eq(invitation.id, c.req.param('id')))
    .limit(1)

  const inv = rows[0]
  // One generic response for missing, used, and expired. Distinguishing them
  // would turn this into an oracle for guessing invitation ids.
  if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) {
    return c.json({ error: 'This invitation is no longer valid.' }, 404)
  }

  return c.json({ email: inv.email, role: inv.role })
})

const acceptSchema = z.object({
  name: z.string().min(1, 'Please enter your name.').max(120),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
})

invitationRoutes.post('/:id/accept', async (c) => {
  const invitationId = c.req.param('id')
  const parsed = acceptSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }

  const rows = await db
    .select()
    .from(invitation)
    .where(eq(invitation.id, invitationId))
    .limit(1)

  const inv = rows[0]
  if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) {
    return c.json({ error: 'This invitation is no longer valid.' }, 404)
  }

  /*
   * Case-insensitive, matching the invite path.
   *
   * `user_email_unique` is a plain btree on `email`, so "Jane@x.com" and
   * "jane@x.com" are two different rows to Postgres and would become two
   * accounts for one person — with sign-in landing on whichever they happened
   * to type. POST /seats/invite now refuses to mint an invitation for an
   * address that already exists in any casing, so this is the second of two
   * gates rather than the only one; it is here because two halves of one flow
   * comparing the same field two different ways is how the gap comes back.
   */
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${inv.email})`)
    .limit(1)

  if (existing.length) {
    return c.json(
      { error: 'An account already exists for this address. Sign in instead.' },
      409
    )
  }

  const ctx = await auth.$context
  const created = await ctx.internalAdapter.createUser({
    email: inv.email,
    name: parsed.data.name,
    // The invitation was delivered to this address, which is the verification.
    emailVerified: true,
  })

  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: await ctx.password.hash(parsed.data.password),
  })

  const organizationId = await getOrganizationId()

  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: created.id,
    role: inv.role ?? 'member',
    createdAt: new Date(),
  })

  await db
    .update(invitation)
    .set({ status: 'accepted' })
    .where(
      and(eq(invitation.id, invitationId), eq(invitation.status, 'pending'))
    )

  // Client workspace grants staged at invitation time. Goes through a
  // SECURITY DEFINER function because this request is unauthenticated by
  // design, so the RLS write policy on client_access correctly refuses a
  // direct insert. See migration 0004 for why that is the right shape.
  const granted = await db.execute<{ grant_client_access_from_invitation: number }>(
    sql`select grant_client_access_from_invitation(${invitationId}, ${created.id})`
  )
  logger.info(
    {
      userId: created.id,
      email: inv.email,
      role: inv.role,
      grantsApplied: granted.rows[0]?.grant_client_access_from_invitation ?? 0,
    },
    'invitation accepted'
  )

  // The client signs in with the credentials just set, rather than this route
  // minting a session — one code path for establishing a session, not two.
  return c.json({ ok: true, email: inv.email })
})
