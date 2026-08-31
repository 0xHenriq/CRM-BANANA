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

  const organizationId = await getOrganizationId()

  /**
   * Somebody who already has an account is GRANTED access, not invited.
   *
   * Invitations only work for an address with no account: the accept handler
   * refuses one that exists ("Sign in instead") and Better Auth refuses to
   * invite an existing member outright. So without this branch, the whole
   * flow dead-ends for two ordinary situations — a contact who works across
   * two of her clients, and anyone whose seat was removed and is being added
   * back — and the only thing on screen was "Could not create the
   * invitation."
   *
   * Matched case-insensitively, because contacts and invitations are both
   * typed by hand and `user.email` is compared exactly everywhere else. Left
   * exact, "Jane@x.com" would miss the existing "jane@x.com" and go on to
   * mint an invitation that can never be accepted.
   */
  const [existingUser] = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email})`)
    .limit(1)

  if (existingUser) {
    const [existingMember] = await db
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(
        and(
          eq(member.userId, existingUser.id),
          eq(member.organizationId, organizationId)
        )
      )
      .limit(1)

    // Already a seat holder: no seat is consumed, so the cap below does not
    // apply and must not block. Granting a second workspace to an existing
    // client is exactly the thing that should still work at 10 of 10.
    if (existingMember) {
      if (role !== CLIENT_ROLE) {
        return c.json(
          {
            error: `${existingUser.email} already has a seat. Remove it first if you need to change what they are.`,
          },
          409
        )
      }
      if (!isStaffRole(existingMember.role)) {
        const granted = await withTenant(c.get('tenant'), (tx) =>
          tx
            .insert(clientAccess)
            .values(
              clientIds.map((clientId) => ({ userId: existingUser.id, clientId }))
            )
            .onConflictDoNothing()
            .returning({ clientId: clientAccess.clientId })
        )
        logger.info(
          { userId: existingUser.id, granted: granted.length },
          'existing seat granted more workspaces'
        )
        return c.json({
          kind: 'granted' as const,
          email: existingUser.email,
          workspacesGranted: granted.length,
        })
      }
      return c.json(
        {
          error: `${existingUser.email} is agency staff and already sees every client.`,
        },
        409
      )
    }
    // A user with no membership — their seat was removed at some point. Adding
    // them back DOES consume a seat, so this falls through to the cap check
    // and is handled after it.
  }

  // Explicit pre-check rather than relying on the plugin to reject.
  // `membershipLimit` guards acceptance; without this, she could send fifteen
  // invitations and five people would hit an error after clicking their link —
  // the failure landing on her clients rather than on her.
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

  /**
   * The account outlived its seat. Put the seat back rather than inviting.
   *
   * Removing a seat deletes the membership and the workspace grants but leaves
   * the login — so adding the same person back a week later hit the same
   * dead end as any other existing account. The seat cap above has already
   * been checked, because this genuinely consumes one.
   */
  if (existingUser) {
    const restoredRole = role === CLIENT_ROLE ? CLIENT_ROLE : role
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: existingUser.id,
      role: restoredRole,
      createdAt: new Date(),
    })

    const granted = clientIds.length
      ? await withTenant(c.get('tenant'), (tx) =>
          tx
            .insert(clientAccess)
            .values(
              clientIds.map((clientId) => ({ userId: existingUser.id, clientId }))
            )
            .onConflictDoNothing()
            .returning({ clientId: clientAccess.clientId })
        )
      : []

    logger.info(
      { userId: existingUser.id, role: restoredRole, granted: granted.length },
      'seat restored for an existing account'
    )
    return c.json({
      kind: 'granted' as const,
      email: existingUser.email,
      workspacesGranted: granted.length,
      restored: true,
    })
  }

  let invitationId: string
  try {
    const created = await auth.api.createInvitation({
      body: { email, role: role as 'member', organizationId },
      headers: c.req.raw.headers,
    })
    invitationId = created.id
  } catch (err) {
    logger.warn({ err, email, role }, 'invitation rejected')

    /*
     * Say which refusal it was.
     *
     * Every one of these used to read "Could not create the invitation.",
     * which is true and useless: she cannot tell a typo from a duplicate from
     * a full house, and the three have different fixes. Better Auth names the
     * reason in a stable code, so it is read rather than guessed at from the
     * message text.
     */
    const code =
      err && typeof err === 'object' && 'body' in err
        ? ((err as { body?: { code?: string } }).body?.code ?? '')
        : ''

    const message =
      code === 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION'
        ? `${email} has already been invited. Revoke that invitation on the Seats page if you need to send a fresh link.`
        : code === 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION'
          ? `${email} already has a seat.`
          : err instanceof Error && /limit/i.test(err.message)
            ? `All ${env.MAX_SEATS} seats are taken or reserved by a pending invitation.`
            : 'Could not create the invitation.'

    return c.json({ error: message }, 400)
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
    kind: 'invited' as const,
    invitationId,
    email,
    role,
    inviteUrl: `${env.APP_URL}/accept-invitation/${invitationId}`,
    note: 'Send this link to the invitee. Email delivery arrives in v1.1.',
  })
})

/**
 * Take back an invitation that has not been accepted.
 *
 * The 409 above tells her to "revoke a pending invitation or remove a member
 * first" and until now there was no way to do either — the copy described a
 * door that did not exist. Cancelling frees the seat immediately, because the
 * seat count above reserves against `status = 'pending'` and this leaves
 * 'canceled'.
 *
 * The staged workspace grants go with it: invitation_grants is
 * ON DELETE CASCADE against the invitation, but cancelling does not DELETE the
 * invitation row, so they are cleared explicitly. Left behind, re-inviting the
 * same person to a different workspace would hand them the old one as well.
 */
seatsRoutes.post('/invitations/:id/cancel', async (c) => {
  const invitationId = c.req.param('id')
  const organizationId = await getOrganizationId()

  // Confirm it is ours and still pending before asking Better Auth, so a bad
  // id gets a plain 404 rather than a plugin error surfaced as a 500.
  const [existing] = await db
    .select({ id: invitation.id, status: invitation.status })
    .from(invitation)
    .where(
      and(
        eq(invitation.id, invitationId),
        eq(invitation.organizationId, organizationId)
      )
    )
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.status !== 'pending') {
    return c.json(
      { error: `That invitation is already ${existing.status}.` },
      409
    )
  }

  try {
    await auth.api.cancelInvitation({
      body: { invitationId },
      headers: c.req.raw.headers,
    })
  } catch (err) {
    logger.warn({ err, invitationId }, 'invitation cancel rejected')
    return c.json({ error: 'Could not cancel that invitation.' }, 400)
  }

  await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(invitationGrants)
      .where(eq(invitationGrants.invitationId, invitationId))
  )

  logger.info({ invitationId }, 'invitation cancelled')
  return c.json({ ok: true })
})

/**
 * Remove someone's seat — and, for a client, their access with it.
 *
 * THE MEMBER ROW IS NOT WHAT GATES A CLIENT'S PORTAL. Access comes from
 * `client_access`, which is what `app_client_ids()` reads, so removing only
 * the membership frees the seat and revokes nothing: the client keeps their
 * session, keeps their workspaces, and keeps reading everything in them. The
 * role lookup in withSession would return '' and quietly reclassify them as a
 * client — which they already were. Verified at the database level in
 * isolation.test.ts, both halves.
 *
 * So both go, in that order, and the grants are deleted through withTenant
 * because client_access carries RLS and a bare db.delete runs with no session
 * variables at all.
 *
 * Their existing browser session is NOT revoked here and that is a known gap,
 * not an oversight: Better Auth owns session storage and there is no seam for
 * it in this codebase yet. With client_access gone the policies return zero
 * rows, so the worst case is a signed-in stranger looking at an empty portal
 * until their session expires — not at data.
 */
seatsRoutes.delete('/members/:memberId', async (c) => {
  const memberId = c.req.param('memberId')
  const organizationId = await getOrganizationId()
  const currentUserId = c.get('user')!.id

  const [target] = await db
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      email: user.email,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.id, memberId), eq(member.organizationId, organizationId)))
    .limit(1)

  if (!target) return c.json({ error: 'Not found' }, 404)

  // She cannot remove herself. There is one agency and one owner in it, and a
  // "are you sure?" is not a substitute for the account being irrecoverable.
  if (target.userId === currentUserId) {
    return c.json(
      {
        error:
          'You cannot remove your own seat. Ask another owner to do it if you are handing the agency over.',
      },
      409
    )
  }

  // Nor the last owner, however it is reached.
  if (target.role.split(',').some((r) => r.trim() === 'owner')) {
    const [{ owners }] = await db
      .select({ owners: sql<number>`count(*)::int` })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          sql`${member.role} like '%owner%'`
        )
      )
    if (owners <= 1) {
      return c.json(
        { error: 'That is the only owner. Make someone else an owner first.' },
        409
      )
    }
  }

  try {
    await auth.api.removeMember({
      body: { memberIdOrEmail: memberId, organizationId },
      headers: c.req.raw.headers,
    })
  } catch (err) {
    logger.warn({ err, memberId }, 'member removal rejected')
    return c.json({ error: 'Could not remove that seat.' }, 400)
  }

  // The half that actually revokes anything.
  const removed = await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(clientAccess)
      .where(eq(clientAccess.userId, target.userId))
      .returning({ clientId: clientAccess.clientId })
  )

  logger.info(
    { memberId, email: target.email, workspacesRevoked: removed.length },
    'seat removed'
  )
  return c.json({ ok: true, workspacesRevoked: removed.length })
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
