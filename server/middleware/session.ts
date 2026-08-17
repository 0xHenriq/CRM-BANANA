import { eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { auth } from '../auth/index.js'
import { isStaffRole } from '../auth/access.js'
import { db, type TenantContext } from '../db/index.js'
import { member } from '../db/auth-schema.js'

export type SessionUser = {
  id: string
  email: string
  name: string
  /** Role on the single Banana Digital organization. */
  role: string
  isStaff: boolean
}

declare module 'hono' {
  interface ContextVariableMap {
    user: SessionUser | null
    tenant: TenantContext
  }
}

/**
 * Resolves the Better Auth session and derives the tenant context every
 * downstream query runs under.
 *
 * The staff/client determination happens here, once, from the `member.role`
 * row — never from anything the client sends. A request with no session gets
 * `{ userId: null, isStaff: false }`, which the RLS policies evaluate to zero
 * rows rather than an error.
 */
export const withSession: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })

  if (!session?.user) {
    c.set('user', null)
    c.set('tenant', { userId: null, isStaff: false })
    return next()
  }

  // Role lives on the membership, not the user, so it is read per request
  // rather than trusted from the session payload.
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(eq(member.userId, session.user.id))
    .limit(1)

  const role = rows[0]?.role ?? ''
  const isStaff = isStaffRole(role)

  c.set('user', {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role,
    isStaff,
  })
  c.set('tenant', { userId: session.user.id, isStaff })

  return next()
}

/** 401 unless a session resolved. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Not authenticated' }, 401)
  return next()
}

/**
 * 403 unless the caller is agency staff.
 *
 * Belt to RLS's braces: the staff-only tables would return zero rows anyway,
 * but an empty list reads as "you have no clients" rather than "you may not
 * look at this", and the difference matters when debugging.
 */
export const requireStaff: MiddlewareHandler = async (c, next) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not authenticated' }, 401)
  if (!user.isStaff) return c.json({ error: 'Forbidden' }, 403)
  return next()
}
