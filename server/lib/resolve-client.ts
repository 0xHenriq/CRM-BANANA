import { asc, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { withTenant } from '../db/index.js'
import { clientAccess, clients } from '../db/schema.js'

/**
 * Resolves which client workspace a request is for.
 *
 * Staff pass `?client=<id>`; a client-role user has no say — they get the
 * workspace they were granted, and their own id is the only input. The value
 * is never read from the body, and RLS would refuse the rows anyway if it
 * were tampered with.
 *
 * Shared by the portal and content routes. It existed as two near-identical
 * copies that had already drifted (one had comments the other lacked), which
 * is not a shape you want for the function that decides whose data you are
 * about to read.
 */
export async function resolveClientId(c: Context): Promise<string | null> {
  const currentUser = c.get('user')
  if (!currentUser) return null

  if (currentUser.isStaff) {
    const requested = c.req.query('client')
    if (requested) return requested

    // No client chosen: fall back to the first open workspace so nav links
    // are never dead for staff. The UI keeps a persisted selection, so this
    // only applies before one has been made.
    const [first] = await withTenant(c.get('tenant'), (tx) =>
      tx
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.portalEnabled, true))
        .orderBy(asc(clients.name))
        .limit(1)
    )
    return first?.id ?? null
  }

  const [grant] = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({ clientId: clientAccess.clientId })
      .from(clientAccess)
      .where(eq(clientAccess.userId, currentUser.id))
      .limit(1)
  )
  return grant?.clientId ?? null
}
