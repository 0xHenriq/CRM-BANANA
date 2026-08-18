import { asc, desc, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import {
  clientAccess,
  clients,
  files,
  links,
  noticePosts,
  tasks,
} from '../db/schema.js'
import { user } from '../db/auth-schema.js'
import { audit } from '../lib/audit.js'
import { requireAuth, requireStaff } from '../middleware/session.js'

export const portalRoutes = new Hono()

portalRoutes.use('*', requireAuth)

/**
 * Resolves which client workspace a request is for.
 *
 * Staff pass `?client=<id>`; a client-role user has no say — they get the
 * workspace they were granted, and their own id is the only input. The value
 * is never taken from the body, so there is nothing to tamper with, and RLS
 * would refuse the rows anyway if it were.
 */
async function resolveClientId(c: Context): Promise<string | null> {
  const currentUser = c.get('user')
  if (!currentUser) return null

  if (currentUser.isStaff) {
    const requested = c.req.query('client')
    if (requested) return requested
    // No client chosen: fall back to the first active workspace so the nav
    // links are never dead for staff browsing the portal views.
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
        portalEnabled: clients.portalEnabled,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1)
    if (!client) return null

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

/** Which workspaces the signed-in account can switch between. */
portalRoutes.get('/workspaces', async (c) => {
  const rows = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(eq(clients.portalEnabled, true))
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
  await withTenant(c.get('tenant'), (tx) =>
    tx.delete(links).where(eq(links.id, c.req.param('id')))
  )
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

portalRoutes.delete('/files/:id', requireStaff, async (c) => {
  await withTenant(c.get('tenant'), (tx) =>
    tx.delete(files).where(eq(files.id, c.req.param('id')))
  )
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
  await withTenant(c.get('tenant'), (tx) =>
    tx.delete(tasks).where(eq(tasks.id, c.req.param('id')))
  )
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

  const created = await withTenant(c.get('tenant'), (tx) =>
    tx
      .insert(noticePosts)
      .values({
        clientId,
        authorId: c.get('user')?.id ?? null,
        body: parsed.data.body,
        parentId: parsed.data.parentId ?? null,
      })
      .returning()
  )

  return c.json({ notice: created[0] }, 201)
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
