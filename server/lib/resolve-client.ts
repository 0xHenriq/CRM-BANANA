import { asc, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { withTenant } from '../db/index.js'
import { clientAccess, clients } from '../db/schema.js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a value can be compared against a uuid column at all.
 *
 * Postgres raises on malformed input rather than returning no rows, and that
 * surfaces as a 500 for what is really "no such thing". Callers that take an
 * id straight from a URL check it here first.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

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
    if (requested) {
      // The value goes straight into a uuid comparison, so anything that is
      // not a uuid made Postgres raise and the request 500 — verified with
      // ?client=not-a-uuid. Parameterisation meant it was never injectable,
      // but "malformed input" is a 400-shaped problem, not a server fault.
      if (!isUuid(requested)) return null

      // A well-formed id for a client that does not exist previously came
      // back 200 with an empty list, which presents a workspace that is not
      // there as one that is merely empty. Confirm it is real; RLS confirms
      // this caller may see it.
      const [found] = await withTenant(c.get('tenant'), (tx) =>
        tx
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.id, requested))
          .limit(1)
      )
      return found?.id ?? null
    }

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
