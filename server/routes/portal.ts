import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import {
  clientCredentials,
  clients,
  files,
  links,
  noticePosts,
  taskComments,
  tasks,
} from '../db/schema.js'
import { user } from '../db/auth-schema.js'
import { audit } from '../lib/audit.js'
import { env } from '../env.js'
import { requireAuth, requireStaff } from '../middleware/session.js'
import {
  decryptSecret,
  encryptSecret,
  secretIsSet,
  secretsAvailable,
} from '../lib/secrets.js'
import { storage } from '../lib/storage.js'
import { isUuid, resolveClientId } from '../lib/resolve-client.js'

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
        // Both client-visible on purpose. Tone of voice is what they told
        // her, shown back so they can check she got it right; the brief is
        // what the work is FOR, and Sofia asked for them to see it — "I want
        // client to see project brief too".
        //
        // This select stays an explicit column list. That is what makes the
        // decision deliberate: adding a column to `clients` still shows a
        // client nothing until someone names it here.
        toneOfVoice: clients.toneOfVoice,
        brief: clients.brief,
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
      /*
       * The to-dos, each carrying how many replies it has.
       *
       * A correlated subquery with an EXPLICIT ALIAS and literal column names.
       * Interpolating `${taskComments.taskId}` here would render it
       * unqualified, `"task_id"` would bind to the outer row, and every count
       * would come back the same wrong number with no error — Failure Mode 2,
       * which read as "the dashboard counts are all zero" for a week.
       *
       * Counted rather than joined so a to-do with no replies still appears,
       * and cheap enough at an agency's volume that a second round trip to
       * fetch thread lengths would be the more expensive option.
       */
      tx
        .select({
          id: tasks.id,
          clientId: tasks.clientId,
          title: tasks.title,
          done: tasks.done,
          dueDate: tasks.dueDate,
          assigneeId: tasks.assigneeId,
          visibleToClient: tasks.visibleToClient,
          sortOrder: tasks.sortOrder,
          createdAt: tasks.createdAt,
          replies: sql<number>`(
            select count(*)::int from task_comments tc
             where tc.task_id = tasks.id
          )`,
        })
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

/* --------------------------------------------------- replies on a to-do */

/**
 * The thread on one to-do.
 *
 * Sofia asked to "reply to next steps" twice. A post in that panel opened its
 * detail dialog, which has had a comment thread since phase 2; a to-do had a
 * deadline and a Done button and nowhere to say anything, so half the panel
 * could be discussed in the product and half of it moved to WhatsApp.
 *
 * Read under the CALLER's own context, which is the whole access decision: a
 * to-do a client cannot see is not found, and its replies are unreachable
 * both here and at the database (migration 0021 composes the parent clause).
 */
portalRoutes.get('/tasks/:id/comments', async (c) => {
  const taskId = c.req.param('id')
  if (!isUuid(taskId)) return c.json({ error: 'Not found' }, 404)

  const result = await withTenant(c.get('tenant'), async (tx) => {
    const [task] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    if (!task) return null

    const comments = await tx
      .select({
        id: taskComments.id,
        body: taskComments.body,
        createdAt: taskComments.createdAt,
        authorId: taskComments.authorId,
        authorName: user.name,
      })
      .from(taskComments)
      .leftJoin(user, eq(user.id, taskComments.authorId))
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt))

    return comments
  })

  if (!result) return c.json({ error: 'Not found' }, 404)
  return c.json({ comments: result })
})

const taskCommentSchema = z.object({ body: z.string().min(1).max(4000) })

/**
 * Reply, from either side.
 *
 * NOT `requireStaff`, deliberately — a thread only she can write to is a
 * notice board, and there is already one of those. The client's own context is
 * what authorises the write, and the WITH CHECK arm on task_comments_insert is
 * what makes "reply to an internal to-do" return nothing rather than 403,
 * because the to-do itself is not supposed to be known to exist.
 *
 * No elevation here, unlike ticking a task off. Ticking writes to `tasks`,
 * which is staff-write-only; this table is client-writable by design, so the
 * insert runs under the caller and the policy decides. Reaching for
 * `withTenant({isStaff: true})` because a permissions error appeared is
 * Failure Mode 4 in reverse and would let a client write into any workspace.
 */
portalRoutes.post('/tasks/:id/comments', async (c) => {
  const taskId = c.req.param('id')
  if (!isUuid(taskId)) return c.json({ error: 'Not found' }, 404)

  const parsed = taskCommentSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Write something first.' }, 400)

  const currentUser = c.get('user')!

  const created = await withTenant(c.get('tenant'), async (tx) => {
    const [task] = await tx
      .select({ id: tasks.id, clientId: tasks.clientId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    if (!task) return null

    const [row] = await tx
      .insert(taskComments)
      .values({
        clientId: task.clientId,
        taskId: task.id,
        authorId: currentUser.id,
        body: parsed.data.body.trim(),
      })
      .returning()
    return row
  })

  if (!created) return c.json({ error: 'Not found' }, 404)
  return c.json({ comment: created }, 201)
})

/**
 * Remove a reply. Staff only, and there is no edit at all.
 *
 * A reply is a thing somebody said; rewriting it after the other side has read
 * it makes the thread unciteable, which is the same reasoning that leaves
 * content_approvals and invoice_payments without an UPDATE policy. Removing
 * one posted in error is a different act and she is the one who does it.
 */
portalRoutes.delete('/tasks/:taskId/comments/:id', requireStaff, async (c) => {
  const removed = await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(taskComments)
      .where(eq(taskComments.id, c.req.param('id')))
      .returning({ id: taskComments.id })
  )
  if (!removed.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

/* ------------------------------------------------------- the password hub */

/**
 * Where a client's social logins live, instead of in a WhatsApp thread.
 *
 * Sofia: "can we put a section for password hub - client can fill in social
 * media passwords". The agency cannot post to a client's Instagram without the
 * login, so those credentials already exist somewhere — today that somewhere
 * is a chat message on two phones, in both of their cloud backups, searchable
 * by anyone who picks either one up. That is the thing being replaced, and it
 * is the bar this has to clear rather than some ideal that never gets built.
 *
 * The secret is encrypted before it reaches Postgres (server/lib/secrets.ts),
 * so a nightly pg_dump copied to a laptop — which this repo's own runbook tells
 * you to do — does not contain anybody's password. It is never included in a
 * list payload either: revealing one is its own request and writes an audit
 * row naming who looked.
 */
const CREDENTIALS_UNCONFIGURED = {
  error:
    'The password hub is not set up yet. It needs CREDENTIALS_SECRET on the ' +
    'server before anything can be stored — passwords are encrypted at rest ' +
    'and there is deliberately no option to save one in plain text.',
} as const

/** Metadata only. The secret never appears here, set or not. */
const credentialColumns = {
  id: clientCredentials.id,
  clientId: clientCredentials.clientId,
  label: clientCredentials.label,
  username: clientCredentials.username,
  notes: clientCredentials.notes,
  sortOrder: clientCredentials.sortOrder,
  updatedAt: clientCredentials.updatedAt,
}

portalRoutes.get('/credentials', async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace available' }, 404)

  const rows = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({
        ...credentialColumns,
        // A boolean, not a masked string of the right length: a row of dots
        // that matches tells anyone glancing at the screen how long the
        // password is, which is the one thing worth knowing about a password
        // you cannot see.
        secretCipher: clientCredentials.secretCipher,
      })
      .from(clientCredentials)
      .where(eq(clientCredentials.clientId, clientId))
      .orderBy(asc(clientCredentials.sortOrder), asc(clientCredentials.label))
  )

  return c.json({
    clientId,
    configured: secretsAvailable(env.CREDENTIALS_SECRET),
    credentials: rows.map(({ secretCipher, ...rest }) => ({
      ...rest,
      hasSecret: secretIsSet(secretCipher),
    })),
  })
})

const credentialSchema = z.object({
  label: z.string().min(1).max(80),
  username: z.string().max(200).nullish(),
  secret: z.string().max(500).nullish(),
  notes: z.string().max(2000).nullish(),
})

/**
 * PATCH written separately with NO defaults, and one extra rule.
 *
 * `secret` absent means "leave the stored one alone"; `secret: null` means
 * "clear it"; a string replaces it. Three states, because the second and third
 * are different acts and `.partial()` on the create schema could express
 * neither — Failure Mode 1 is exactly this shape.
 */
export const credentialPatchSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  username: z.string().max(200).nullish(),
  secret: z.string().max(500).nullish(),
  notes: z.string().max(2000).nullish(),
})

portalRoutes.post('/credentials', async (c) => {
  const clientId = await resolveClientId(c)
  if (!clientId) return c.json({ error: 'No workspace available' }, 404)

  const parsed = credentialSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const { label, username, secret, notes } = parsed.data

  // Refuse rather than store it in the clear. 503, because this is a missing
  // server configuration and not something the caller did wrong.
  if (secret && !secretsAvailable(env.CREDENTIALS_SECRET)) {
    return c.json(CREDENTIALS_UNCONFIGURED, 503)
  }

  const created = await withTenant(c.get('tenant'), (tx) =>
    tx
      .insert(clientCredentials)
      .values({
        clientId,
        label: label.trim(),
        username: username?.trim() || null,
        secretCipher: secret
          ? encryptSecret(secret, env.CREDENTIALS_SECRET)
          : null,
        notes: notes?.trim() || null,
        sortOrder: 999,
        updatedBy: c.get('user')!.id,
      })
      .returning(credentialColumns)
  )

  if (!created.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ credential: created[0] }, 201)
})

portalRoutes.patch('/credentials/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Not found' }, 404)

  const parsed = credentialPatchSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const patch = parsed.data

  if (patch.secret && !secretsAvailable(env.CREDENTIALS_SECRET)) {
    return c.json(CREDENTIALS_UNCONFIGURED, 503)
  }

  const updated = await withTenant(c.get('tenant'), (tx) =>
    tx
      .update(clientCredentials)
      .set({
        ...(patch.label === undefined ? {} : { label: patch.label.trim() }),
        ...(patch.username === undefined
          ? {}
          : { username: patch.username?.trim() || null }),
        ...(patch.notes === undefined
          ? {}
          : { notes: patch.notes?.trim() || null }),
        // Absent leaves the stored secret alone; null clears it.
        ...(patch.secret === undefined
          ? {}
          : {
              secretCipher: patch.secret
                ? encryptSecret(patch.secret, env.CREDENTIALS_SECRET)
                : null,
            }),
        updatedBy: c.get('user')!.id,
        updatedAt: new Date(),
      })
      .where(eq(clientCredentials.id, id))
      .returning(credentialColumns)
  )

  if (!updated.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ credential: updated[0] })
})

portalRoutes.delete('/credentials/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Not found' }, 404)

  const removed = await withTenant(c.get('tenant'), (tx) =>
    tx
      .delete(clientCredentials)
      .where(eq(clientCredentials.id, id))
      .returning({ id: clientCredentials.id })
  )
  if (!removed.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

/**
 * Show me the password.
 *
 * Its own request rather than a field on the list, which is the difference
 * between a password that is on screen because someone asked for it and one
 * that is in every response body, the browser cache and the network tab of
 * whoever was sitting next to her.
 *
 * The audit row is written under an ELEVATED context on purpose. `audit_log`
 * is staff-only, and a client revealing their own password under their own
 * context would have the insert refused and take the whole transaction — and
 * therefore the reveal — down with it. That is Failure Mode 4 exactly, and it
 * is why this is two transactions rather than one: authority is established
 * under the caller, the bookkeeping runs elevated.
 */
portalRoutes.post('/credentials/:id/reveal', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json({ error: 'Not found' }, 404)
  if (!secretsAvailable(env.CREDENTIALS_SECRET)) {
    return c.json(CREDENTIALS_UNCONFIGURED, 503)
  }

  const currentUser = c.get('user')!

  const [row] = await withTenant(c.get('tenant'), (tx) =>
    tx
      .select({
        id: clientCredentials.id,
        clientId: clientCredentials.clientId,
        label: clientCredentials.label,
        secretCipher: clientCredentials.secretCipher,
      })
      .from(clientCredentials)
      .where(eq(clientCredentials.id, id))
      .limit(1)
  )
  if (!row) return c.json({ error: 'Not found' }, 404)

  const secret = decryptSecret(row.secretCipher, env.CREDENTIALS_SECRET)

  await withTenant({ userId: currentUser.id, isStaff: true }, (tx) =>
    audit(tx, {
      actorId: currentUser.id,
      action: 'credential.reveal',
      entity: 'client_credential',
      entityId: row.id,
      // The label and the workspace, never the secret. An audit trail that
      // records what it was watching is not an audit trail.
      meta: { clientId: row.clientId, label: row.label },
    })
  )

  if (row.secretCipher && secret === null) {
    // A row encrypted under a previous key is a real state, and it needs a
    // sentence rather than a blank box: nothing is broken, the key changed,
    // and the password has to be typed in again.
    return c.json(
      {
        error:
          'This password cannot be opened with the current key — it was saved ' +
          'under a previous one. Ask them for it again and save it here.',
      },
      409
    )
  }

  return c.json({ secret })
})
