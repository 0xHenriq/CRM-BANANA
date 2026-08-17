import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import {
  activities,
  clientAccess,
  clients,
  contacts,
  deals,
} from '../db/schema.js'
import { user } from '../db/auth-schema.js'
import { audit, recordActivity, slugify } from '../lib/audit.js'
import { requireStaff } from '../middleware/session.js'
import { seedNewClientWorkspace } from '../lib/seed-workspace.js'

export const clientRoutes = new Hono()

// The whole CRM is staff-only. RLS enforces this independently, but a 403 is a
// clearer answer than an empty list when someone is debugging.
clientRoutes.use('*', requireStaff)

const CLIENT_STATUSES = [
  'lead',
  'proposal',
  'active',
  'paused',
  'churned',
] as const

/** Client list with the counts she actually scans for. */
clientRoutes.get('/', async (c) => {
  const rows = await withTenant(c.get('tenant'), async (tx) =>
    tx
      .select({
        id: clients.id,
        name: clients.name,
        slug: clients.slug,
        status: clients.status,
        portalEnabled: clients.portalEnabled,
        createdAt: clients.createdAt,
        // Every correlated subquery below is written with explicit aliases,
        // and that is not stylistic. Interpolating Drizzle columns —
        // `${tasks.clientId} = ${clients.id}` — renders them UNQUALIFIED, so
        // inside the subquery `"id"` binds to tasks.id rather than clients.id.
        // The comparison is then always false and every count silently reads
        // zero: no error, no warning, just a dashboard quietly lying.
        contactCount: sql<number>`(
          select count(*)::int from contacts ct where ct.client_id = clients.id
        )`,
        openTaskCount: sql<number>`(
          select count(*)::int from tasks tk
           where tk.client_id = clients.id and tk.done = false
        )`,
        awaitingReviewCount: sql<number>`(
          select count(*)::int from content_items ci
           where ci.client_id = clients.id and ci.status = 'ready_for_review'
        )`,
        seatCount: sql<number>`(
          select count(*)::int from client_access ca where ca.client_id = clients.id
        )`,
      })
      .from(clients)
      .orderBy(clients.name)
  )

  return c.json({ clients: rows })
})

const createSchema = z.object({
  name: z.string().min(1, 'A name is required.').max(120),
  status: z.enum(CLIENT_STATUSES).default('lead'),
  brandColor: z.string().max(32).optional(),
})

clientRoutes.post('/', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const { name, status, brandColor } = parsed.data
  const actorId = c.get('user')?.id ?? null

  const created = await withTenant(c.get('tenant'), async (tx) => {
    // Slug collisions are rare but real ("Acme" twice). Retry with a numeric
    // suffix rather than failing in front of her.
    const base = slugify(name)
    let slug = base
    for (let attempt = 1; attempt < 20; attempt++) {
      const clash = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.slug, slug))
        .limit(1)
      if (clash.length === 0) break
      slug = `${base}-${attempt + 1}`
    }

    const [row] = await tx
      .insert(clients)
      .values({
        name,
        slug,
        status,
        brandColor: brandColor ?? null,
        // A lead has no portal. It opens when she moves them to active.
        portalEnabled: status === 'active',
      })
      .returning()

    if (row.portalEnabled) await seedNewClientWorkspace(tx, row.id)

    await audit(tx, {
      actorId,
      action: 'client.create',
      entity: 'client',
      entityId: row.id,
      meta: { name, status },
    })
    await recordActivity(tx, {
      clientId: row.id,
      entityType: 'client',
      entityId: row.id,
      actorId,
      kind: 'status_change',
      body: `Client created as ${status}`,
    })

    return row
  })

  return c.json({ client: created }, 201)
})

clientRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const result = await withTenant(c.get('tenant'), async (tx) => {
    const [client] = await tx
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1)
    if (!client) return null

    const clientContacts = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.clientId, id))
      .orderBy(desc(contacts.isPrimary), contacts.name)

    const clientDeals = await tx
      .select()
      .from(deals)
      .where(eq(deals.clientId, id))
      .orderBy(desc(deals.createdAt))

    const timeline = await tx
      .select({
        id: activities.id,
        kind: activities.kind,
        body: activities.body,
        entityType: activities.entityType,
        occurredAt: activities.occurredAt,
        actorName: user.name,
      })
      .from(activities)
      .leftJoin(user, eq(user.id, activities.actorId))
      .where(eq(activities.clientId, id))
      .orderBy(desc(activities.occurredAt))
      .limit(50)

    const seats = await tx
      .select({ userId: clientAccess.userId, email: user.email, name: user.name })
      .from(clientAccess)
      .innerJoin(user, eq(user.id, clientAccess.userId))
      .where(eq(clientAccess.clientId, id))

    return { client, contacts: clientContacts, deals: clientDeals, timeline, seats }
  })

  if (!result) return c.json({ error: 'Not found' }, 404)
  return c.json(result)
})

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
  brandColor: z.string().max(32).nullable().optional(),
  portalEnabled: z.boolean().optional(),
})

clientRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  const actorId = c.get('user')?.id ?? null
  const patch = parsed.data

  const updated = await withTenant(c.get('tenant'), async (tx) => {
    const [before] = await tx
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1)
    if (!before) return null

    const [row] = await tx
      .update(clients)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning()

    // Turning the portal on for the first time seeds her standard workspace:
    // eight links, five file slots, four onboarding to-dos. Guarded on the
    // transition so re-saving the form never duplicates them.
    if (row.portalEnabled && !before.portalEnabled) {
      await seedNewClientWorkspace(tx, row.id)
      await recordActivity(tx, {
        clientId: row.id,
        entityType: 'client',
        entityId: row.id,
        actorId,
        kind: 'status_change',
        body: 'Portal opened and workspace seeded',
      })
    }

    if (patch.status && patch.status !== before.status) {
      await recordActivity(tx, {
        clientId: row.id,
        entityType: 'client',
        entityId: row.id,
        actorId,
        kind: 'status_change',
        body: `Status ${before.status} → ${patch.status}`,
      })
    }

    await audit(tx, {
      actorId,
      action: 'client.update',
      entity: 'client',
      entityId: id,
      meta: { before: { status: before.status, name: before.name }, patch },
    })

    return row
  })

  if (!updated) return c.json({ error: 'Not found' }, 404)
  return c.json({ client: updated })
})

/* ---------------------------------------------------------------- contacts */

const contactSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.email().nullish(),
  phone: z.string().max(40).nullish(),
  title: z.string().max(120).nullish(),
  isPrimary: z.boolean().default(false),
})

clientRoutes.post('/:id/contacts', async (c) => {
  const clientId = c.req.param('id')
  const parsed = contactSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const actorId = c.get('user')?.id ?? null

  const created = await withTenant(c.get('tenant'), async (tx) => {
    // Exactly one primary contact per client, or "who do I call" has no answer.
    if (parsed.data.isPrimary) {
      await tx
        .update(contacts)
        .set({ isPrimary: false })
        .where(eq(contacts.clientId, clientId))
    }

    const [row] = await tx
      .insert(contacts)
      .values({ ...parsed.data, clientId })
      .returning()

    await audit(tx, {
      actorId,
      action: 'contact.create',
      entity: 'contact',
      entityId: row.id,
      meta: { clientId, name: row.name },
    })
    return row
  })

  return c.json({ contact: created }, 201)
})

clientRoutes.delete('/:id/contacts/:contactId', async (c) => {
  const clientId = c.req.param('id')
  const contactId = c.req.param('contactId')
  const actorId = c.get('user')?.id ?? null

  await withTenant(c.get('tenant'), async (tx) => {
    await tx
      .delete(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.clientId, clientId)))
    await audit(tx, {
      actorId,
      action: 'contact.delete',
      entity: 'contact',
      entityId: contactId,
      meta: { clientId },
    })
  })

  return c.json({ ok: true })
})

/* ---------------------------------------------------------------- timeline */

const noteSchema = z.object({
  body: z.string().min(1).max(4000),
  kind: z.enum(['note', 'call', 'email', 'meeting']).default('note'),
})

clientRoutes.post('/:id/activities', async (c) => {
  const clientId = c.req.param('id')
  const parsed = noteSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)

  await withTenant(c.get('tenant'), (tx) =>
    recordActivity(tx, {
      clientId,
      entityType: 'client',
      entityId: clientId,
      actorId: c.get('user')?.id ?? null,
      kind: parsed.data.kind,
      body: parsed.data.body,
    })
  )

  return c.json({ ok: true }, 201)
})
