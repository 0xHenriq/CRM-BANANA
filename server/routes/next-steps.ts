import { and, eq, isNotNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { withTenant, type TenantContext } from '../db/index.js'
import { clients, contentItems, tasks } from '../db/schema.js'
import { requireAuth } from '../middleware/session.js'

export const nextStepRoutes = new Hono()

// withSession only POPULATES the user; it does not demand one. Without this
// an anonymous request reaches the handler and `c.get('user')!` is undefined.
nextStepRoutes.use('*', requireAuth)

/**
 * "Next steps", with dates.
 *
 * This replaces the panel that used to say "Waiting on clients". That heading
 * described the agency's feelings rather than anyone's next action, and it
 * only ever counted one kind of thing — a post sitting in review. Sofia asked
 * for next steps with deadlines, per client, and for the client to see theirs.
 *
 * A step is one of two things:
 *
 *   review — a post that needs a decision. Its deadline is the date it is
 *            scheduled to go out, because that is when the decision stops
 *            being useful, not some separate date somebody has to maintain.
 *   task   — an open to-do that has a due date.
 *
 * Undated to-dos are deliberately excluded. They already have a home in the
 * To-Do panel directly below this one, and pulling every one of them up here
 * would turn a short deadline list into a second copy of that panel — which
 * is how a person learns to stop reading the top of the page.
 */
export type NextStep = {
  kind: 'review' | 'task'
  id: string
  clientId: string
  clientName: string
  title: string
  due: string | null
  type?: string
  visibleToClient?: boolean
}

/**
 * One loader for both routes.
 *
 * The whole-agency list and a single client's list differ by one predicate, so
 * they are one function. Written as two handlers with a copied query, they
 * drift: the first time a kind of step is added to one and not the other, a
 * client's page and the dashboard disagree about what is outstanding, and
 * neither is obviously wrong to look at.
 */
async function loadSteps(
  tenant: TenantContext,
  clientId?: string
): Promise<NextStep[]> {
  const data = await withTenant(tenant, async (tx) => {
    const [reviews, todos] = await Promise.all([
      tx
        .select({
          id: contentItems.id,
          clientId: contentItems.clientId,
          clientName: clients.name,
          title: contentItems.title,
          type: contentItems.type,
          due: contentItems.scheduledAt,
        })
        .from(contentItems)
        .innerJoin(clients, eq(clients.id, contentItems.clientId))
        .where(
          and(
            eq(contentItems.status, 'ready_for_review'),
            clientId ? eq(contentItems.clientId, clientId) : undefined
          )
        ),

      /*
       * RLS already hides an internal to-do from a client, so there is no
       * visible_to_client filter here. Adding one would be harmless today and
       * would quietly become the only thing enforcing it if the policy ever
       * changed — the rule belongs in one place.
       */
      tx
        .select({
          id: tasks.id,
          clientId: tasks.clientId,
          clientName: clients.name,
          title: tasks.title,
          due: tasks.dueDate,
          visibleToClient: tasks.visibleToClient,
        })
        .from(tasks)
        .innerJoin(clients, eq(clients.id, tasks.clientId))
        .where(
          and(
            eq(tasks.done, false),
            isNotNull(tasks.dueDate),
            clientId ? eq(tasks.clientId, clientId) : undefined
          )
        ),
    ])
    return { reviews, todos }
  })

  const steps: NextStep[] = [
    ...data.reviews.map((r) => ({ kind: 'review' as const, ...r })),
    ...data.todos.map((t) => ({ kind: 'task' as const, ...t })),
  ]

  /*
   * Soonest first, undated last.
   *
   * Sorted here rather than in SQL because the two queries are independent and
   * a date is a plain 'YYYY-MM-DD' string in both — lexicographic order is
   * chronological order for that format, which is the whole reason the column
   * is a date and not a timestamp. An undated review sorts LAST rather than
   * first: a post with no schedule is not more urgent than one due tomorrow,
   * and sorting null first is the classic way this panel would end up leading
   * with the least urgent thing on it.
   */
  return steps.sort(compareSteps)
}

/** Exported so the ordering can be tested without a database. */
export function compareSteps(
  a: Pick<NextStep, 'due' | 'title'>,
  b: Pick<NextStep, 'due' | 'title'>
): number {
  if (a.due === b.due) return a.title.localeCompare(b.title)
  if (!a.due) return 1
  if (!b.due) return -1
  return a.due < b.due ? -1 : 1
}

nextStepRoutes.get('/', async (c) => {
  const steps = await loadSteps(c.get('tenant'))
  return c.json({ steps, scope: c.get('user')!.isStaff ? 'agency' : 'client' })
})

/**
 * The same list, for one client.
 *
 * Staff open a client and want that client's next actions without the other
 * nine in the way. RLS still applies on top, so a client hitting this with
 * somebody else's id gets an empty list rather than a leak.
 */
nextStepRoutes.get('/:clientId', async (c) => {
  const steps = await loadSteps(c.get('tenant'), c.req.param('clientId'))
  return c.json({ steps, scope: c.get('user')!.isStaff ? 'agency' : 'client' })
})
