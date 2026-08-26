import { and, asc, eq, isNull } from 'drizzle-orm'
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
    //
    // Archived clients are excluded explicitly rather than relying on the
    // archive route also clearing portal_enabled — RLS deliberately still
    // shows staff an archived client (Restore has to read the row), so the
    // filter has to be in the query. Invariant 15.
    const [first] = await withTenant(c.get('tenant'), (tx) =>
      tx
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.portalEnabled, true), isNull(clients.archivedAt)))
        .orderBy(asc(clients.name))
        .limit(1)
    )
    return first?.id ?? null
  }

  /*
   * A grant is not on its own a workspace they may open.
   *
   * `client_access` outlives both the portal toggle and archiving, so reading
   * it alone answered with a workspace she had closed — the content calendar,
   * ideas bank, feed preview and moodboard all resolved normally for a client
   * whose portal was off, because only GET /api/portal ever checked the flag.
   *
   * Migration 0014 is what actually enforces this: the policies now return no
   * rows for a closed workspace, so this join is the second of two gates. It
   * earns its place by making the answer 404 "no workspace" rather than a
   * workspace that is merely empty — which is the same distinction the
   * ?client= branch above already draws for staff.
   */
  const [grant] = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({ clientId: clientAccess.clientId })
      .from(clientAccess)
      .innerJoin(clients, eq(clients.id, clientAccess.clientId))
      .where(
        and(
          eq(clientAccess.userId, currentUser.id),
          eq(clients.portalEnabled, true)
        )
      )
      .limit(1)
  )
  return grant?.clientId ?? null
}
