import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import { clients, files, links, noticePosts, tasks } from '../db/schema.js'
import { user } from '../db/auth-schema.js'
import { audit } from '../lib/audit.js'
import { requireAuth, requireStaff } from '../middleware/session.js'
import { storage } from '../lib/storage.js'
import { resolveClientId } from '../lib/resolve-client.js'

export const portalRoutes = new Hono()

portalRoutes.use('*', requireAuth)

/** Everything the portal homepage renders, in one round trip. */
portalRoutes.get('/', async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) {
    return c.json(
      { error: 'No client workspace is available for this account.' },
      404
    )
  }

  const data = await withTenant(c.get('tenant'), async (tx) => {
    const [client] = await tx
      .select({
        id: clients.id,
        name: clients.name,
        brandColor: clients.brandColor,
        logoKey: clients.logoKey,
        // Client-visible on purpose — it is what they told her, shown back so
        // they can check she got it right. `brief` is deliberately NOT here:
        // this select is an explicit column list precisely so adding a column
        // to `clients` never quietly widens what a client can read.
        toneOfVoice: clients.toneOfVoice,
        portalEnabled: clients.portalEnabled,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1)
    if (!client) return null

    /*
     * A closed portal is actually closed.
     *
     * This check was missing. `portal_enabled` gated the workspace SWITCHER
     * and nothing else, so a client whose portal she had turned off kept full
     * read access to their links, files, to-dos and notices by loading the
     * page directly — the switcher simply stopped offering it. The toggle she
     * uses to end an engagement did not end anything.
     *
     * Found while checking that archiving closes the portal: after a restore,
     * this endpoint answered 200 for a client whose portal_enabled was false.
     *
     * It was only ever this endpoint, which was the flaw: the calendar, ideas
     * bank, feed and moodboard reach their rows without coming through here,
     * and went on serving a closed workspace for as long as this comment
     * claimed otherwise. Migration 0014 moved the rule into the policies, so
     * this is now the friendlier of two gates rather than the only one — it
     * answers 404 where the database would merely answer nothing.
     *
     * Staff are exempt on purpose. She builds a workspace before opening it,
     * and the client page renders these same panels — enforcing this against
     * her own account would make a client unpreparable until it was already
     * visible to them.
     */
    if (!canSeePortal(c.get('user'), client)) return null

    const [linkRows, fileRows, taskRows, noticeRows] = await Promise.all([
      tx
        .select()
        .from(links)
        .where(eq(links.clientId, clientId))
        .orderBy(asc(links.sortOrder), asc(links.label)),
      tx
        .select()
        .from(files)
        .where(eq(files.clientId, clientId))
        .orderBy(asc(files.sortOrder), asc(files.name)),
      tx
        .select()
        .from(tasks)
        .where(eq(tasks.clientId, clientId))
        .orderBy(asc(tasks.sortOrder), asc(tasks.title)),
      tx
        .select({
          id: noticePosts.id,
          body: noticePosts.body,
          createdAt: noticePosts.createdAt,
          parentId: noticePosts.parentId,
          authorId: noticePosts.authorId,
          authorName: user.name,
        })
        .from(noticePosts)
        .leftJoin(user, eq(user.id, noticePosts.authorId))
        .where(eq(noticePosts.clientId, clientId))
        .orderBy(desc(noticePosts.createdAt))
        .limit(100),
    ])

    return {
      client,
      links: linkRows,
      files: fileRows,
      tasks: taskRows,
      notices: noticeRows,
    }
  })

  if (!data) return c.json({ error: 'Not found' }, 404)
  return c.json(data)
})

/**
 * Which workspaces the signed-in account can switch between.
 *
 * `archived_at` is filtered here as well as `portal_enabled`, and not because
 * both can be true at once today — archiving clears the toggle. It is because
 * RLS deliberately still shows STAFF an archived client, so nothing in the
 * database stops this list from carrying one the moment some future screen
 * turns the toggle back on without thinking about archiving. Invariant 15:
 * the filter has to be in the query.
 */
portalRoutes.get('/workspaces', async (c) => {
  const rows = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(and(eq(clients.portalEnabled, true), isNull(clients.archivedAt)))
      .orderBy(asc(clients.name))
  )
  return c.json({ workspaces: rows })
})

/* ------------------------------------------------------------------- links */

/**
 * Create and update schemas are defined SEPARATELY, and update schemas carry
 * no defaults. This is not duplication for its own sake.
 *
 * `schema.partial()` does NOT strip `.default()` — a field left out of a PATCH
 * body still comes back populated with its default. Verified: PATCH
 * /portal/tasks/:id with body {"done":true} parsed to
 * {done:true, visibleToClient:true} and flipped an internal task to
 * client-visible. Ticking "INTERNAL: chase unpaid invoice" off her own list
 * published it to the client.
 *
 * Any `.partial()` over a schema containing `.default()` has the same shape of
 * bug, so the rule is: defaults belong to creates, never to updates.
 */
const linkSchema = z.object({
  label: z.string().min(1).max(120),
  // Deliberately permissive: she pastes Drive, Canva and Notion URLs. The
  // client component is what refuses to render anything but http(s).
  url: z.string().max(2000).default(''),
  icon: z.string().max(60).nullish(),
})

export const linkPatchSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  url: z.string().max(2000).optional(),
  icon: z.string().max(60).nullish(),
})

portalRoutes.post('/links', requireStaff, async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace selected' }, 400)
  const parsed = linkSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const created = await withTenant(c.get('tenant'), async (tx) => {
    const [row] = await tx
      .insert(links)
      .values({ ...parsed.data, clientId, sortOrder: 999 })
      .returning()
    await audit(tx, {
      actorId: c.get('user')?.id ?? null,
      action: 'link.create',
      entity: 'link',
      entityId: row.id,
      meta: { clientId },
    })
    return row
  })

  return c.json({ link: created }, 201)
})

portalRoutes.patch('/links/:id', requireStaff, async (c) => {
  const parsed = linkPatchSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const updated = await withTenant(c.get('tenant'), (tx) =>
    tx
      .update(links)
      .set(parsed.data)
      .where(eq(links.id, c.req.param('id')))
      .returning()
  )
  if (!updated.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ link: updated[0] })
})

portalRoutes.delete('/links/:id', requireStaff, async (c) => {
  // 404 when nothing matched, as files and notices already did. Answering
  // {ok:true} to a delete that removed nothing tells the caller the row is
  // gone when it may simply be invisible to them, and the UI then quietly
  // drops it from the list until the next refetch puts it back.
  const removed = await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(links)
      .where(eq(links.id, c.req.param('id')))
      .returning({ id: links.id })
  )
  if (!removed.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

/* ------------------------------------------------------------------- files */

const fileSchema = z.object({
  name: z.string().min(1).max(160),
  externalUrl: z.string().max(2000).default(''),
})

export const filePatchSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  externalUrl: z.string().max(2000).optional(),
})

portalRoutes.post('/files', requireStaff, async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace selected' }, 400)
  const parsed = fileSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const created = await withTenant(c.get('tenant'), (tx) =>
    tx
      .insert(files)
      .values({ ...parsed.data, clientId, sortOrder: 999 })
      .returning()
  )
  return c.json({ file: created[0] }, 201)
})

portalRoutes.patch('/files/:id', requireStaff, async (c) => {
  const parsed = filePatchSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const updated = await withTenant(c.get('tenant'), (tx) =>
    tx
      .update(files)
      .set(parsed.data)
      .where(eq(files.id, c.req.param('id')))
      .returning()
  )
  if (!updated.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ file: updated[0] })
})

/**
 * Removing a file removes its bytes too.
 *
 * The row used to be deleted on its own, so every uploaded document left a
 * copy on disk that nothing referenced and nothing would ever collect — the
 * moodboard delete has always cleaned up after itself and this did not. The
 * key is returned by the delete so the unlink acts on a row that was really
 * removed, and it happens after the transaction commits: a file left on disk
 * is waste, but a row whose bytes were deleted underneath it is a broken
 * download.
 */
portalRoutes.delete('/files/:id', requireStaff, async (c) => {
  const removed = await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(files)
      .where(eq(files.id, c.req.param('id')))
      .returning({ storageKey: files.storageKey })
  )
  if (!removed.length) return c.json({ error: 'Not found' }, 404)

  const key = removed[0].storageKey
  // Link-only rows have no bytes to remove.
  if (key) await storage.remove(key)

  return c.json({ ok: true })
})

/* ------------------------------------------------------------------- tasks */

const taskSchema = z.object({
  title: z.string().min(1).max(200),
  dueDate: z.string().date().nullish(),
  visibleToClient: z.boolean().default(true),
})

portalRoutes.post('/tasks', requireStaff, async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace selected' }, 400)
  const parsed = taskSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const created = await withTenant(c.get('tenant'), (tx) =>
    tx
      .insert(tasks)
      .values({
        clientId,
        title: parsed.data.title,
        dueDate: parsed.data.dueDate ?? null,
        visibleToClient: parsed.data.visibleToClient,
        sortOrder: 999,
      })
      .returning()
  )
  return c.json({ task: created[0] }, 201)
})

/**
 * Ticking a task is the one portal write a client may make to `tasks`.
 *
 * RLS only grants staff write access there, so this runs the update under a
 * staff context AFTER establishing that the caller may see the task — the
 * narrow, deliberate elevation rather than opening the whole table to clients.
 * The client's own context is what decides visibility; theirs is the SELECT
 * that has to succeed first.
 */
export const taskPatchSchema = z.object({
  done: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(),
  dueDate: z.string().date().nullish(),
  visibleToClient: z.boolean().optional(),
})

portalRoutes.patch('/tasks/:id', async (c) => {
  const parsed = taskPatchSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const currentUser = c.get('user')!
  const taskId = c.req.param('id')

  // Read under the caller's own context: a client sees only their visible
  // tasks, so a task they may not see simply is not found.
  const [visible] = await withTenant(c.get('tenant'), (tx) =>
    tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
  )
  if (!visible) return c.json({ error: 'Not found' }, 404)

  // Clients may only flip `done`; title, due date and visibility are hers.
  // Note `done` is optional now, so a client sending nothing changes nothing
  // rather than writing undefined.
  const patch = currentUser.isStaff
    ? parsed.data
    : parsed.data.done === undefined
      ? {}
      : { done: parsed.data.done }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'Nothing to update' }, 400)
  }

  const [updated] = await withTenant(
    { userId: currentUser.id, isStaff: true },
    (tx) => tx.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning()
  )

  return c.json({ task: updated })
})

portalRoutes.delete('/tasks/:id', requireStaff, async (c) => {
  const removed = await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(tasks)
      .where(eq(tasks.id, c.req.param('id')))
      .returning({ id: tasks.id })
  )
  if (!removed.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

/* ------------------------------------------------------------ notice board */

const noticeSchema = z.object({
  body: z.string().min(1).max(4000),
  parentId: z.uuid().nullish(),
})

/**
 * The notice board is the point of the portal: the client can talk back.
 *
 * Both audiences may post — the RLS insert policy on notice_posts allows a
 * client to write into a workspace they hold a grant for, and nowhere else.
 */
portalRoutes.post('/notices', async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace selected' }, 400)
  const parsed = noticeSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const created = await withTenant(c.get('tenant'), async (tx) => {
    /**
     * A reply has to belong to the thread it claims to be under.
     *
     * `parent_id` came straight from the body with only a uuid check, and the
     * foreign key only asks that the post exists — not that it is in this
     * workspace. So a reply could be hung off another client's notice: the
     * row itself is confined to the author's own workspace by RLS, so nothing
     * leaks, but the board renders replies by parent, and a reply whose
     * parent is invisible is a message that has silently gone nowhere.
     *
     * Looked up under the caller's own context, so a parent they may not see
     * is indistinguishable from one that does not exist.
     */
    if (parsed.data.parentId) {
      const [parent] = await tx
        .select({ clientId: noticePosts.clientId })
        .from(noticePosts)
        .where(eq(noticePosts.id, parsed.data.parentId))
        .limit(1)
      if (!parent || parent.clientId !== clientId) return null
    }

    const [row] = await tx
      .insert(noticePosts)
      .values({
        clientId,
        authorId: c.get('user')?.id ?? null,
        body: parsed.data.body,
        parentId: parsed.data.parentId ?? null,
      })
      .returning()
    return row
  })

  if (!created) {
    return c.json({ error: 'That post is no longer on the board.' }, 404)
  }
  return c.json({ notice: created }, 201)
})

/**
 * Any post can be removed, root or reply.
 *
 * This previously matched `parent_id IS NULL`, so a reply could never be
 * deleted at all — and a reply is precisely where something she needs to
 * remove is most likely to appear. Deleting a root still cascades to its
 * replies through the foreign key.
 */
portalRoutes.delete('/notices/:id', requireStaff, async (c) => {
  const deleted = await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(noticePosts)
      .where(eq(noticePosts.id, c.req.param('id')))
      .returning({ id: noticePosts.id })
  )
  if (!deleted.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

/**
 * Whether an account may load a client's workspace.
 *
 * Pulled out of the handler so it can be tested. The rule is one line, but it
 * is one line that was ABSENT for the whole life of the product — the toggle
 * she uses to close a portal gated the workspace switcher and nothing else —
 * and a rule with no test is a rule that goes missing again in the next
 * refactor of the route around it.
 */
export function canSeePortal(
  user: { isStaff: boolean } | undefined | null,
  client: { portalEnabled: boolean }
): boolean {
  if (!user) return false
  // Staff build a workspace before opening it, and the client page renders
  // these same panels.
  if (user.isStaff) return true
  return client.portalEnabled
}
