import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../db/index.js'
import {
  activities,
  clientAccess,
  clients,
  contacts,
  deals,
  invitationGrants,
} from '../db/schema.js'
import { invitation, user } from '../db/auth-schema.js'
import { audit, recordActivity, slugify } from '../lib/audit.js'
import { requireStaff } from '../middleware/session.js'
import { seedNewClientWorkspace } from '../lib/seed-workspace.js'

export const clientRoutes = new Hono()

// The whole CRM is staff-only. RLS enforces this independently, but a 403 is a
// clearer answer than an empty list when someone is debugging.
clientRoutes.use('*', requireStaff)

// Exported so contract.test.ts can bind it to the Postgres enum and to the
// browser's copy. This vocabulary lived in five places and none of them were
// checked against each other.
export const CLIENT_STATUSES = [
  'lead',
  'proposal',
  'active',
  'paused',
  'churned',
] as const

/**
 * The stages that come with a client workspace.
 *
 * Sofia: "make client portal active in the 'proposal stage'". A proposal IS
 * the pitch — the moodboard, the content calendar and the brief are most of
 * what she is selling — and until now the portal opened only once they had
 * already said yes, so the one artefact that wins the work could not be shown
 * through the product that produces it. The Work tab said "has no workspace
 * yet" on exactly the clients she most needed to show something to.
 *
 * A lead is deliberately still closed. A lead is a name in a list, often
 * somebody who has not spoken to her yet; seeding eight links and four
 * onboarding to-dos for every one of those fills the database with workspaces
 * nobody opens. Proposal is where a real engagement starts.
 *
 * `paused` and `churned` are absent for a different reason: they are stages
 * you arrive at from `active`, so the portal is already open and the guard
 * below only fires on the way IN. Closing one is her decision, not a status
 * side effect — see the archive route for the case where it is automatic.
 */
const PORTAL_STAGES = new Set<(typeof CLIENT_STATUSES)[number]>([
  'proposal',
  'active',
])

/** Client list with the counts she actually scans for. */
clientRoutes.get('/', async (c) => {
  // Archived clients are hidden unless explicitly asked for. Opt-IN rather
  // than opt-out: every existing caller keeps the behaviour it has, and the
  // one screen that wants them says so.
  const includeArchived = c.req.query('archived') === '1'

  const rows = await withTenant(c.get('tenant'), async (tx) =>
    tx
      .select({
        id: clients.id,
        name: clients.name,
        slug: clients.slug,
        status: clients.status,
        portalEnabled: clients.portalEnabled,
        logoKey: clients.logoKey,
        brandColor: clients.brandColor,
        archivedAt: clients.archivedAt,
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
      .where(includeArchived ? undefined : isNull(clients.archivedAt))
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
        // A lead has no portal; a PROPOSAL does. See PORTAL_STAGES.
        portalEnabled: PORTAL_STAGES.has(status),
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

    /**
     * Invitations sent for this workspace that nobody has accepted yet.
     *
     * Without this the contacts card can only tell "has a login" from "has
     * not", and an invited contact looks identical to an uninvited one — so
     * she clicks Invite again and mints a SECOND invitation, which holds a
     * SECOND seat out of ten, for one person. The state exists in the data;
     * it just was not being returned.
     *
     * Read through the staging table, because the grant is what ties an
     * invitation to a workspace and it is written at invite time — the user
     * row does not exist until acceptance.
     */
    const pendingInvites = await tx
      .select({
        id: invitation.id,
        email: invitation.email,
        expiresAt: invitation.expiresAt,
      })
      .from(invitationGrants)
      .innerJoin(invitation, eq(invitation.id, invitationGrants.invitationId))
      .where(
        and(
          eq(invitationGrants.clientId, id),
          eq(invitation.status, 'pending')
        )
      )

    return {
      client,
      contacts: clientContacts,
      deals: clientDeals,
      timeline,
      seats,
      pendingInvites,
    }
  })

  if (!result) return c.json({ error: 'Not found' }, 404)
  return c.json(result)
})

/**
 * Five slots, and '' means "not set".
 *
 * `.length(5)` rather than `.max(5)` because the slots are named roles and a
 * short array would silently reassign them — send three colours and the two
 * secondaries she had chosen are gone with nothing on screen saying so. The
 * client always sends the whole palette.
 */
export const BRAND_COLOR_SLOTS = 5
const brandColorsSchema = z
  .array(
    z.union([
      z.literal(''),
      z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'A brand colour must look like #1a2b3c')
        // One spelling per colour. The browser lowercases before sending, but
        // anything else reaching this route would otherwise be able to store
        // #AABBCC beside #aabbcc — the same colour, twice, comparing unequal.
        .transform((v) => v.toLowerCase()),
    ])
  )
  .length(
    BRAND_COLOR_SLOTS,
    `Send all ${BRAND_COLOR_SLOTS} brand colour slots, using "" for the ones that are not set.`
  )

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
  // brandColor is NOT here on purpose. It mirrors brandColors[0] and is set
  // below from the palette, so there is one way to change a brand colour
  // rather than two that can disagree. Migration 0015 argues the case.
  brandColors: brandColorsSchema.optional(),
  brief: z.string().max(20000).nullable().optional(),
  toneOfVoice: z.string().max(5000).nullable().optional(),
  /** Who the invoice is made out to. Printed verbatim — see migration 0023. */
  billingAddress: z.string().max(1000).nullable().optional(),
  portalEnabled: z.boolean().optional(),
})

/**
 * Blank is absent.
 *
 * Clearing a textarea sends '', and stored as '' the field is "set to nothing"
 * — which reads as empty on screen but is a different value from never having
 * been filled in, so `brief IS NULL` stops meaning what it says. One
 * representation for "no brief".
 */
function blankToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined
  const trimmed = v?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

clientRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null))
  // Say which field and why, like the contact and deal handlers already do.
  // "Invalid request" against a form with eight inputs on it is not an answer.
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request' },
      400
    )
  }

  const actorId = c.get('user')?.id ?? null
  const patch = parsed.data

  const updated = await withTenant(c.get('tenant'), async (tx) => {
    const [before] = await tx
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1)
    if (!before) return null

    // Moving a client into a stage that has a portal opens it, exactly as
    // creating one in that stage does. Without this the two paths diverged:
    // create-as-active seeded a workspace, but the ordinary route — lead
    // becomes client — left portalEnabled false. She would move them to
    // Active, hand over a login, and they would find an empty portal with
    // nothing to explain it.
    //
    // An explicit portalEnabled in the same patch still wins, and closing one
    // is never undone by this: the guard is on the TRANSITION into a portal
    // stage, so re-saving the form on a client whose portal she deliberately
    // closed does not reopen it behind her.
    const opensPortal =
      patch.portalEnabled ??
      (patch.status &&
      PORTAL_STAGES.has(patch.status) &&
      !PORTAL_STAGES.has(before.status)
        ? true
        : undefined)

    const [row] = await tx
      .update(clients)
      .set({
        ...patch,
        ...(patch.brief === undefined ? {} : { brief: blankToNull(patch.brief) }),
        ...(patch.toneOfVoice === undefined
          ? {}
          : { toneOfVoice: blankToNull(patch.toneOfVoice) }),
        ...(patch.billingAddress === undefined
          ? {}
          : { billingAddress: blankToNull(patch.billingAddress) }),
        // brand_color follows slot 1 rather than being written beside it, so
        // the logo's initials fallback can never show a colour the palette
        // does not. An unset slot 1 puts it back to null — the yellow default.
        ...(patch.brandColors === undefined
          ? {}
          : { brandColor: patch.brandColors[0] || null }),
        ...(opensPortal === undefined ? {} : { portalEnabled: opensPortal }),
        updatedAt: new Date(),
      })
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

/**
 * Archive a client, and restore one.
 *
 * She asked to be able to remove a client — two of the seeded examples are not
 * hers. This does not DELETE: a client is the parent of contacts, deals,
 * content items and their assets, files, invoices, receipts, tasks, notes and
 * every uploaded byte behind them, all of it ON DELETE CASCADE. One click
 * would take all of it, the uploaded files would not come back with a database
 * restore because they do not live in the database, and the client whose data
 * it was is real and paying.
 *
 * So the row stays and stops being shown. Restore is a single click, the data
 * is exactly where it was, and nothing has to be recovered from a backup to
 * undo a mis-click.
 *
 * Archiving also closes the portal. An archived client whose users could still
 * sign in and read their workspace would be archived in name only — and unlike
 * the RLS predicate, portal_enabled is a field any future screen could flip
 * back on without thinking about archived clients, which is why there are two
 * gates rather than one.
 */
clientRoutes.post('/:id/archive', async (c) => {
  const id = c.req.param('id')
  const actorId = c.get('user')?.id ?? null

  const row = await withTenant(c.get('tenant'), async (tx) => {
    const [before] = await tx
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1)
    if (!before) return null
    if (before.archivedAt) return before

    const [updated] = await tx
      .update(clients)
      .set({ archivedAt: new Date(), portalEnabled: false, updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning()

    await audit(tx, {
      actorId,
      action: 'client.archive',
      entity: 'client',
      entityId: id,
      // The name, because the whole point of the log is to answer "what was
      // that one called" after it has stopped appearing in any list.
      meta: { name: before.name, portalWasEnabled: before.portalEnabled },
    })
    await recordActivity(tx, {
      clientId: id,
      entityType: 'client',
      entityId: id,
      kind: 'note',
      body: 'Client archived.',
      actorId,
    })

    return updated
  })

  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ client: row })
})

clientRoutes.post('/:id/restore', async (c) => {
  const id = c.req.param('id')
  const actorId = c.get('user')?.id ?? null

  const row = await withTenant(c.get('tenant'), async (tx) => {
    const [before] = await tx
      .select()
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1)
    if (!before) return null

    /*
     * The portal is NOT reopened automatically.
     *
     * Archiving turned it off, so symmetry argues for turning it back on — but
     * the two are not symmetrical in consequence. Getting it wrong on the way
     * in shows her a client she meant to hide; getting it wrong on the way out
     * gives a former client's users their workspace back without her deciding
     * that. The toggle is on the page she lands on.
     */
    const [updated] = await tx
      .update(clients)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning()

    await audit(tx, {
      actorId,
      action: 'client.restore',
      entity: 'client',
      entityId: id,
      meta: { name: before.name },
    })

    return updated
  })

  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ client: row })
})
