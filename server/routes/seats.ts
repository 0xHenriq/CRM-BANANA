import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from '../auth/index.js'
import { CLIENT_ROLE, isStaffRole } from '../auth/access.js'
import { db, withTenant } from '../db/index.js'
import { invitation, member, user } from '../db/auth-schema.js'
import { clientAccess, clients, invitationGrants } from '../db/schema.js'
import { env } from '../env.js'
import { logger } from '../logger.js'
import { requireStaff } from '../middleware/session.js'
import { getOrganizationId } from '../auth/org.js'

export const seatsRoutes = new Hono()

seatsRoutes.use('*', requireStaff)

/**
 * Who holds the seats, and how many are left.
 *
 * Better Auth enforces `membershipLimit` at invitation time; this endpoint
 * exists so she can see the count before she runs out, rather than
 * discovering it as a rejected invitation.
 */
seatsRoutes.get('/', async (c) => {
  const organizationId = await getOrganizationId()

  const members = await db
    .select({
      memberId: member.id,
      userId: member.userId,
      role: member.role,
      email: user.email,
      name: user.name,
      joinedAt: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))

  const pending = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, 'pending')
      )
    )

  // Pending invitations count against the cap. Otherwise she could invite
  // fifteen people, watch ten accept, and have five confusing failures.
  const used = members.length + pending.length

  return c.json({
    seats: { used, total: env.MAX_SEATS, remaining: env.MAX_SEATS - used },
    members: members.map((m) => ({ ...m, isStaff: isStaffRole(m.role) })),
    pending,
  })
})

const inviteSchema = z.object({
  email: z.email(),
  role: z.enum(['owner', 'admin', 'member', 'client']),
  /** Required for the client role: which workspaces they may see. */
  clientIds: z.array(z.uuid()).default([]),
})

/**
 * Creates an invitation and returns a link to pass on by hand.
 *
 * v1.1 sends this through Resend. Returning the URL keeps the MVP unblocked
 * without pretending email exists — a silently undelivered invitation is worse
 * than an obviously manual one.
 */
seatsRoutes.post('/invite', async (c) => {
  const parsed = inviteSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400)
  }
  const { email, role, clientIds } = parsed.data

  if (role === CLIENT_ROLE && clientIds.length === 0) {
    return c.json(
      {
        error:
          'A client seat needs at least one client workspace, or they sign in to nothing.',
      },
      400
    )
  }

  // Verify the workspaces exist before minting an invitation that would
  // resolve to a dead end.
  if (clientIds.length) {
    const found = await withTenant(c.get('tenant'), (tx) =>
      tx.select({ id: clients.id }).from(clients)
    )
    const known = new Set(found.map((r) => r.id))
    const unknown = clientIds.filter((id) => !known.has(id))
    if (unknown.length) {
      return c.json({ error: `Unknown client(s): ${unknown.join(', ')}` }, 400)
    }
  }

  // Explicit pre-check rather than relying on the plugin to reject.
  // `membershipLimit` guards acceptance; without this, she could send fifteen
  // invitations and five people would hit an error after clicking their link —
  // the failure landing on her clients rather than on her.
  const organizationId = await getOrganizationId()
  const [{ used }] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(member)
    .where(eq(member.organizationId, organizationId))
  const [{ reserved }] = await db
    .select({ reserved: sql<number>`count(*)::int` })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, 'pending')
      )
    )

  if (used + reserved >= env.MAX_SEATS) {
    return c.json(
      {
        error: `All ${env.MAX_SEATS} seats are taken (${used} active, ${reserved} pending). Revoke a pending invitation or remove a member first.`,
      },
      409
    )
  }

  let invitationId: string
  try {
    const created = await auth.api.createInvitation({
      body: { email, role: role as 'member', organizationId },
      headers: c.req.raw.headers,
    })
    invitationId = created.id
  } catch (err) {
    // membershipLimit rejections land here.
    logger.warn({ err, email, role }, 'invitation rejected')
    return c.json(
      {
        error:
          err instanceof Error && /limit/i.test(err.message)
            ? `All ${env.MAX_SEATS} seats are taken or reserved by a pending invitation.`
            : 'Could not create the invitation.',
      },
      400
    )
  }

  // Staged in the database, not process memory: the user row does not exist
  // until acceptance, and a restart between the two must not silently drop the
  // grant — leaving a client signed in to an empty portal with no error.
  //
  // Through withTenant, because invitation_grants carries RLS (migration 0005)
  // and a bare `db.insert` runs with no session variables at all — which is
  // indistinguishable from an anonymous request, so app_is_staff() is false and
  // the WITH CHECK refuses the row. Verified against bd_portal_test: the bare
  // insert raises 42501, the same insert under a staff context succeeds. The
  // invitation itself is created above and already committed, so the failure
  // landed AFTER a seat had been reserved: she saw "Internal server error",
  // the invitee got a link, and accepting it granted them no workspace —
  // exactly the empty portal this staging table exists to prevent.
  if (clientIds.length) {
    await withTenant(c.get('tenant'), (tx) =>
      tx
        .insert(invitationGrants)
        .values(clientIds.map((clientId) => ({ invitationId, clientId })))
        .onConflictDoNothing()
    )
  }

  // APP_URL, not the request origin: in production the API is reached through
  // Caddy on an internal port, so the request origin is not a URL anyone can
  // open. This link goes to a human.
  return c.json({
    invitationId,
    email,
    role,
    inviteUrl: `${env.APP_URL}/accept-invitation/${invitationId}`,
    note: 'Send this link to the invitee. Email delivery arrives in v1.1.',
  })
})

const grantSchema = z.object({ clientId: z.uuid() })

/**
 * Grant an existing client-role seat access to another workspace.
 *
 * Goes through withTenant so the caller's staff context reaches the write
 * policy on client_access. A bare `db.insert` here would be refused by RLS —
 * correctly, since without session variables the request is indistinguishable
 * from an anonymous one.
 */
seatsRoutes.post('/:userId/access', async (c) => {
  const parsed = grantSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const userId = c.req.param('userId')
  await withTenant(c.get('tenant'), (tx) =>
    tx
      .insert(clientAccess)
      .values({ userId, clientId: parsed.data.clientId })
      .onConflictDoNothing()
  )

  return c.json({ ok: true })
})

seatsRoutes.delete('/:userId/access/:clientId', async (c) => {
  await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(clientAccess)
      .where(
        and(
          eq(clientAccess.userId, c.req.param('userId')),
          eq(clientAccess.clientId, c.req.param('clientId'))
        )
      )
  )
  return c.json({ ok: true })
})
