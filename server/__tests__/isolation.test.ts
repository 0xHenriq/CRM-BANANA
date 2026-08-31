import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ALL_TENANT_TABLES,
  CLIENT_VISIBLE_TABLES,
  COLUMN_GATED_TABLES,
  STAFF_ONLY_TABLES,
  asActor,
  asActorRaw,
  asReviewer,
  closePools,
  ownerPool,
  resetAndSeed,
  type Fixture,
} from './fixtures.js'

/**
 * Tenancy isolation.
 *
 * The one property in this application that must never regress, tested at the
 * database layer so it holds even if the API is bypassed entirely. Three
 * distinct failure modes, because they fail independently:
 *
 *   1. Cross-tenant   — A's user reading B's rows.
 *   2. Class confusion — A's user reading A's own staff-only rows. A
 *                        client_id-only policy passes cross-tenant and fails
 *                        this one, which is what makes it worth separating.
 *   3. Fail-closed    — no session variables at all.
 */

let f: Fixture

beforeAll(async () => {
  f = await resetAndSeed()
})

afterAll(async () => {
  await closePools()
})

describe('the runtime role cannot bypass RLS', () => {
  it('bd_app is not a superuser, has no BYPASSRLS, and owns no tables', async () => {
    const [row] = await asActor<{
      role: string
      is_superuser: boolean
      bypasses_rls: boolean
      owned: number
    }>({ kind: 'anonymous' }, `
      select current_user as role,
             (select rolsuper     from pg_roles where rolname = current_user) as is_superuser,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypasses_rls,
             (select count(*)::int from pg_class c
               where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                 and pg_get_userbyid(c.relowner) = current_user) as owned
    `)

    expect(row.role).toBe('bd_app')
    expect(row.is_superuser).toBe(false)
    expect(row.bypasses_rls).toBe(false)
    // A table owner is exempt from its own policies unless FORCE is set, so
    // ownership by the app role would silently disable everything below.
    expect(row.owned).toBe(0)
  })

  it('every tenant table has row level security enabled', async () => {
    const rows = await asActor<{ relname: string }>({ kind: 'anonymous' }, `
      select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace
         and c.relkind = 'r'
         and not c.relrowsecurity
         and c.relname = any($1::text[])
    `, [[...ALL_TENANT_TABLES]])

    expect(rows.map((r) => r.relname)).toEqual([])
  })

  it('every tenant table has at least one policy', async () => {
    const rows = await asActor<{ tablename: string; n: number }>(
      { kind: 'anonymous' },
      `select tablename, count(*)::int as n from pg_policies
        where schemaname = 'public' group by 1`
    )
    const withPolicies = new Set(rows.map((r) => r.tablename))
    const missing = ALL_TENANT_TABLES.filter((t) => !withPolicies.has(t))

    // Adding a tenant table without a policy fails the build here.
    expect(missing).toEqual([])
  })
})

describe('1 — cross-tenant', () => {
  it('a client user sees only their own client row', async () => {
    const rows = await asActor<{ id: string }>(
      { kind: 'client', userId: f.clientUserA },
      'select id from clients order by name'
    )
    expect(rows.map((r) => r.id)).toEqual([f.clientA])
  })

  it.each([...CLIENT_VISIBLE_TABLES, ...COLUMN_GATED_TABLES])(
    'a client user reads no rows belonging to another client from %s',
    async (table) => {
      const rows = await asActor<{ client_id: string }>(
        { kind: 'client', userId: f.clientUserA },
        `select client_id from ${table}`
      )
      expect(rows.every((r) => r.client_id === f.clientA)).toBe(true)
      expect(rows.some((r) => r.client_id === f.clientB)).toBe(false)
    }
  )

  it("cannot fetch another client's link by its exact id", async () => {
    const rows = await asActor(
      { kind: 'client', userId: f.clientUserA },
      'select id from links where id = $1',
      [f.linkB]
    )
    expect(rows).toHaveLength(0)
  })

  it("cannot fetch another client's notice post by its exact id", async () => {
    const rows = await asActor(
      { kind: 'client', userId: f.clientUserA },
      'select id from notice_posts where id = $1',
      [f.noticeB]
    )
    expect(rows).toHaveLength(0)
  })

  it("cannot write into another client's workspace", async () => {
    // The WITH CHECK clause makes this affect zero rows rather than erroring.
    const inserted = await asActor(
      { kind: 'client', userId: f.clientUserA },
      `insert into notice_posts(client_id, body) values ($1,'injected')
       returning id`,
      [f.clientB]
    ).catch(() => [] as unknown[])

    expect(inserted).toHaveLength(0)

    const { rows: check } = await ownerPool.query(
      `select count(*)::int as n from notice_posts where client_id = $1 and body = 'injected'`,
      [f.clientB]
    )
    expect(check[0].n).toBe(0)
  })

  it('staff see both clients', async () => {
    const rows = await asActor<{ id: string }>(
      { kind: 'staff', userId: f.staffUser },
      'select id from clients'
    )
    expect(rows).toHaveLength(2)
  })
})

describe('2 — class confusion (same tenant, wrong audience)', () => {
  it.each([...STAFF_ONLY_TABLES])(
    'a client user reads nothing from %s, not even their own rows',
    async (table) => {
      const rows = await asActor(
        { kind: 'client', userId: f.clientUserA },
        `select * from ${table}`
      )
      expect(rows).toHaveLength(0)
    }
  )

  it('a client cannot read their own deal — value, stage, or close date', async () => {
    const rows = await asActor(
      { kind: 'client', userId: f.clientUserA },
      'select id, value, stage from deals where client_id = $1',
      [f.clientA]
    )
    // This is the disclosure a client_id-only policy would have allowed:
    // what she charges them and when she expects to close.
    expect(rows).toHaveLength(0)
  })

  it('a client sees only tasks flagged visible_to_client', async () => {
    const rows = await asActor<{ id: string }>(
      { kind: 'client', userId: f.clientUserA },
      'select id from tasks'
    )
    expect(rows.map((r) => r.id)).toEqual([f.taskAVisible])
  })

  it('a client does not see the raw Ideas Bank backlog', async () => {
    const rows = await asActor<{ id: string }>(
      { kind: 'client', userId: f.clientUserA },
      'select id from content_items'
    )
    expect(rows.map((r) => r.id)).toEqual([f.contentAVisible])
  })

  it('a client cannot flip visible_to_client on their own content', async () => {
    await asActor(
      { kind: 'client', userId: f.clientUserA },
      'update content_items set visible_to_client = true where id = $1',
      [f.contentAHidden]
    ).catch(() => [])

    const { rows } = await ownerPool.query(
      'select visible_to_client from content_items where id = $1',
      [f.contentAHidden]
    )
    expect(rows[0].visible_to_client).toBe(false)
  })

  it('children of a hidden content item are hidden too', async () => {
    // Regression: the original policies checked only client_id, so a client
    // who could not see an item could still read its assets and comments.
    const assets = await asActor<{ storage_key: string }>(
      { kind: 'client', userId: f.clientUserA },
      'select storage_key from content_assets'
    )
    const comments = await asActor<{ body: string }>(
      { kind: 'client', userId: f.clientUserA },
      'select body from content_comments'
    )

    expect(assets.map((a) => a.storage_key)).toEqual(['september-grid-01.jpg'])
    expect(comments).toHaveLength(0)
  })

  it('a client cannot approve content they were never shown', async () => {
    await asActor(
      { kind: 'client', userId: f.clientUserA },
      `insert into content_approvals(client_id, content_item_id, decision, actor_id)
       values ($1,$2,'approved',$3)`,
      [f.clientA, f.contentAHidden, f.clientUserA]
    ).catch(() => [])

    const { rows } = await ownerPool.query(
      'select count(*)::int as n from content_approvals where content_item_id = $1',
      [f.contentAHidden]
    )
    expect(rows[0].n).toBe(0)
  })

  it('staff do see internal tasks and the full backlog', async () => {
    // Scoped to client A, which is what the counts mean. Unscoped, this
    // asserted "the fixture has exactly two content items in total" and broke
    // the moment client B got one — a test measuring the fixture rather than
    // the policy.
    const tasks = await asActor(
      { kind: 'staff', userId: f.staffUser },
      'select id from tasks where client_id = $1',
      [f.clientA]
    )
    const content = await asActor(
      { kind: 'staff', userId: f.staffUser },
      'select id from content_items where client_id = $1',
      [f.clientA]
    )
    expect(tasks).toHaveLength(2)
    expect(content).toHaveLength(2)

    // And staff still see across clients, which is the other half of the claim.
    const all = await asActor(
      { kind: 'staff', userId: f.staffUser },
      'select id from content_items'
    )
    expect(all.length).toBeGreaterThan(content.length)
  })
})

describe('3 — fail closed', () => {
  it.each([...ALL_TENANT_TABLES])(
    'returns zero rows from %s with no session variables set — and does not raise',
    async (table) => {
      // If current_setting were called without missing_ok, this would throw.
      // A suite that fails with an exception invites "fixing" the policy.
      const rows = await asActor({ kind: 'anonymous' }, `select * from ${table}`)
      expect(rows).toHaveLength(0)
    }
  )

  it('an unknown user id grants nothing', async () => {
    const rows = await asActor(
      { kind: 'client', userId: 'no-such-user' },
      'select id from clients'
    )
    expect(rows).toHaveLength(0)
  })

  it('an empty is_staff string is not treated as staff', async () => {
    // This previously set is_staff='false' and asserted deals was empty, which
    // the test above already covered — the name promised something the body
    // never did. Set the value the helper actually has to defend against.
    const rows = await asActorRaw(
      { 'app.user_id': f.clientUserA, 'app.is_staff': '' },
      'select id from deals'
    )
    expect(rows).toHaveLength(0)
  })

  it.each(['yes', 'y', 'on', 't', '1', 'TRUE', 'True', 'anything'])(
    'is_staff=%s does not grant staff access',
    async (value) => {
      // Postgres's boolean input accepts yes/y/on/t/1, so the original
      // `::boolean` cast escalated a client to staff on any of them —
      // confirmed by reading the agency's deal row. app_is_staff() now
      // compares against the literal 'true' and nothing else.
      const rows = await asActorRaw(
        { 'app.user_id': f.clientUserA, 'app.is_staff': value },
        'select id from deals'
      )
      expect(rows).toHaveLength(0)
    }
  )

  it("is_staff='true' still grants staff access", async () => {
    // The tightening must not break the one value that is supposed to work.
    const rows = await asActorRaw(
      { 'app.user_id': f.staffUser, 'app.is_staff': 'true' },
      'select id from deals'
    )
    expect(rows.length).toBeGreaterThan(0)
  })
})

/**
 * The mirror of "fail closed": a write with no tenant context is refused too.
 *
 * Reads failing closed are easy to spot — the screen is empty. A write failing
 * closed raises, and if the raise happens after something else has already
 * committed, the caller is left with half an operation. That is what
 * POST /api/seats/invite did: it created the invitation through Better Auth,
 * then staged the workspace grants with a bare `db.insert`, which carries no
 * session variables and is therefore indistinguishable from an anonymous
 * request. 42501, a 500 to the operator, a seat consumed, and an invitee whose
 * link resolved to an empty portal.
 *
 * invitation_grants is the only staff-only table the app writes from a route,
 * so it is the one that has to be pinned here.
 */
describe('staff-only writes require a tenant context', () => {
  it('refuses an insert into invitation_grants with no session variables', async () => {
    await expect(
      asActor(
        { kind: 'anonymous' },
        `insert into invitation_grants(invitation_id, client_id) values ($1,$2)`,
        [f.invitationId, f.clientA]
      )
    ).rejects.toThrow(/row-level security/i)

    const { rows } = await ownerPool.query(
      'select count(*)::int as n from invitation_grants where invitation_id = $1',
      [f.invitationId]
    )
    expect(rows[0].n).toBe(0)
  })

  it('accepts the same insert under a staff context', async () => {
    await asActor(
      { kind: 'staff', userId: f.staffUser },
      `insert into invitation_grants(invitation_id, client_id) values ($1,$2)
       on conflict do nothing`,
      [f.invitationId, f.clientA]
    )

    const { rows } = await ownerPool.query(
      'select count(*)::int as n from invitation_grants where invitation_id = $1',
      [f.invitationId]
    )
    expect(rows[0].n).toBe(1)
  })

  it('refuses it under a client context', async () => {
    // clientB, not clientA: the staff insert above already took (invitation,
    // clientA), and a unique-index violation would pass this assertion for
    // entirely the wrong reason.
    await expect(
      asActor(
        { kind: 'client', userId: f.clientUserA },
        `insert into invitation_grants(invitation_id, client_id) values ($1,$2)`,
        [f.invitationId, f.clientB]
      )
    ).rejects.toThrow(/row-level security/i)
  })
})

/**
 * Invoices and receipts.
 *
 * Money between her and the client, so the client must see their own — that is
 * the point of putting it in the portal. But a draft is her working copy, and
 * the failure that matters is not the draft leaking: it is the RECEIPT leaking
 * and telling a client about money moving against a document they were never
 * sent. Exactly the shape migration 0006 fixed for content assets.
 */
describe('invoices and receipts', () => {
  it('a client sees their ISSUED invoice but not the draft', async () => {
    const rows = await asActor<{ id: string }>(
      { kind: 'client', userId: f.clientUserA },
      'select id from invoices'
    )
    expect(rows.map((r) => r.id)).toEqual([f.invoiceAIssued])
  })

  it("cannot see another client's invoice by its exact id", async () => {
    const rows = await asActor(
      { kind: 'client', userId: f.clientUserA },
      'select id from invoices where id = $1',
      [f.invoiceB]
    )
    expect(rows).toHaveLength(0)
  })

  it('a receipt against a draft invoice is hidden with its parent', async () => {
    const rows = await asActor<{ receipt_number: string }>(
      { kind: 'client', userId: f.clientUserA },
      'select receipt_number from invoice_payments'
    )
    // The issued invoice's receipt only. The draft's must not appear, or the
    // client learns about money against a document they have never seen.
    expect(rows.map((r) => r.receipt_number)).toEqual(['RCP-TEST-0001'])
  })

  it('a client cannot raise, alter or settle an invoice', async () => {
    await asActor(
      { kind: 'client', userId: f.clientUserA },
      `insert into invoices(client_id, number, status, amount_pence, issued_on)
       values ($1,'INV-FORGED-1','sent',1,current_date)`,
      [f.clientA]
    ).catch(() => [])

    await asActor(
      { kind: 'client', userId: f.clientUserA },
      'update invoices set amount_pence = 1 where id = $1',
      [f.invoiceAIssued]
    ).catch(() => [])

    await asActor(
      { kind: 'client', userId: f.clientUserA },
      `insert into invoice_payments(client_id, invoice_id, receipt_number, amount_pence, paid_on)
       values ($1,$2,'RCP-FORGED-1',500000,current_date)`,
      [f.clientA, f.invoiceAIssued]
    ).catch(() => [])

    const { rows } = await ownerPool.query(
      `select (select count(*)::int from invoices where number='INV-FORGED-1') as forged,
              (select amount_pence from invoices where id=$1) as amount,
              (select count(*)::int from invoice_payments where receipt_number='RCP-FORGED-1') as paid`,
      [f.invoiceAIssued]
    )
    expect(rows[0].forged).toBe(0)
    expect(rows[0].amount).toBe(500000)
    expect(rows[0].paid).toBe(0)
  })

  it('a receipt cannot be rewritten, even by staff', async () => {
    // Append-only in the same spirit as content_approvals: the amount and date
    // are evidence. A mistake is withdrawn and re-recorded under a new receipt
    // number rather than edited in place, so the client's copy never silently
    // stops matching ours.
    await asActor(
      { kind: 'staff', userId: f.staffUser },
      `update invoice_payments set amount_pence = 1 where receipt_number = 'RCP-TEST-0001'`
    ).catch(() => [])

    const { rows } = await ownerPool.query(
      `select amount_pence from invoice_payments where receipt_number = 'RCP-TEST-0001'`
    )
    expect(rows[0].amount_pence).toBe(200000)
  })

  it('staff see every invoice, draft included', async () => {
    const rows = await asActor(
      { kind: 'staff', userId: f.staffUser },
      'select id from invoices'
    )
    expect(rows).toHaveLength(3)
  })
})

describe('append-only approvals', () => {
  it('nobody can update or delete an approval, staff included', async () => {
    const { rows: seeded } = await ownerPool.query(
      `insert into content_approvals(client_id, content_item_id, decision, actor_id, note)
       values ($1,$2,'approved',$3,'looks good') returning id`,
      [f.clientA, f.contentAVisible, f.staffUser]
    )
    const approvalId = seeded[0].id

    await asActor(
      { kind: 'staff', userId: f.staffUser },
      `update content_approvals set note = 'rewritten' where id = $1`,
      [approvalId]
    ).catch(() => [])

    await asActor(
      { kind: 'staff', userId: f.staffUser },
      'delete from content_approvals where id = $1',
      [approvalId]
    ).catch(() => [])

    const { rows } = await ownerPool.query(
      'select note from content_approvals where id = $1',
      [approvalId]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('looks good')
  })
})

describe('client logos', () => {
/**
 * The logo route is the first place a stored key becomes a file read via a
 * column, rather than via an id the policy already filtered. It answers with
 * whatever `clients.logo_key` points at, so if a client could write that
 * column they could aim it at another client's bytes and read them. The
 * defence is that clients_write is staff-only — assert it, because the whole
 * route rests on it.
 */
it('a client cannot repoint their own logo at another client\'s bytes', async () => {
  // RLS filters an UPDATE rather than raising on it, so this is a silent
  // zero-row write, not an error. Assert the row COUNT and then the stored
  // value: asserting a throw here would pass today for the wrong reason and
  // keep passing if the policy were ever replaced by a WHERE clause.
  const updated = await asActor(
    { kind: 'client', userId: f.clientUserA },
    "update clients set logo_key = 'uploads/somebody-else.webp' where id = $1 returning id",
    [f.clientA]
  )
  expect(updated).toHaveLength(0)

  const [row] = await asActor<{ logo_key: string | null }>(
    { kind: 'staff', userId: f.staffUser },
    'select logo_key from clients where id = $1',
    [f.clientA]
  )
  expect(row?.logo_key).not.toBe('uploads/somebody-else.webp')
})
})

/**
 * Archiving closes the portal at the database, not just in the UI.
 *
 * The archive route also sets portal_enabled = false, and that alone would
 * hide the workspace today. It is not enough on its own: portal_enabled is an
 * ordinary editable field that any future screen could switch back on without
 * anyone thinking about archived clients, whereas this predicate cannot be
 * turned off by accident. Both gates, tested separately.
 */
describe('archived clients', () => {
  const setArchived = (value: string | null) =>
    asActor(
      { kind: 'staff', userId: f.staffUser },
      'update clients set archived_at = $1 where id = $2',
      [value, f.clientA]
    )

  it('a client cannot see their own client row once it is archived', async () => {
    const before = await asActor(
      { kind: 'client', userId: f.clientUserA },
      'select id from clients where id = $1',
      [f.clientA]
    )
    // Non-vacuous: they can see it before, or the assertion below proves
    // nothing about archiving.
    expect(before).toHaveLength(1)

    await setArchived('2026-08-26T00:00:00Z')
    try {
      const after = await asActor(
        { kind: 'client', userId: f.clientUserA },
        'select id from clients where id = $1',
        [f.clientA]
      )
      expect(after).toHaveLength(0)
    } finally {
      await setArchived(null)
    }
  })

  it('staff still see an archived client, or Restore could not work', async () => {
    await setArchived('2026-08-26T00:00:00Z')
    try {
      const rows = await asActor(
        { kind: 'staff', userId: f.staffUser },
        'select id from clients where id = $1',
        [f.clientA]
      )
      expect(rows).toHaveLength(1)
    } finally {
      await setArchived(null)
    }
  })

  it('a client cannot archive or restore themselves', async () => {
    const updated = await asActor(
      { kind: 'client', userId: f.clientUserA },
      'update clients set archived_at = now() where id = $1 returning id',
      [f.clientA]
    )
    expect(updated).toHaveLength(0)
  })
})

/**
 * A closed portal closes the whole workspace, not just its homepage.
 *
 * `portal_enabled` was enforced in exactly one place — canSeePortal(), inside
 * GET /api/portal — while every other client-facing screen resolves its
 * workspace from `client_access` alone. A grant outlives both the toggle and
 * the archive, so a client whose portal she had turned off kept full read
 * access to their content calendar, ideas bank, feed preview and moodboard by
 * loading those pages directly. Reproduced against bd_portal_test before
 * migration 0014: with portal_enabled = false the client still read their
 * content_items rows.
 *
 * These are DATABASE assertions on purpose. The route-level check in
 * resolveClientId() is the second gate and answers 404 rather than an empty
 * workspace, but a rule only the application enforces is one route away from
 * not being enforced at all — which is precisely how this hole was made.
 */
describe('a closed portal closes the workspace', () => {
  const setPortal = (enabled: boolean) =>
    asActor(
      { kind: 'staff', userId: f.staffUser },
      'update clients set portal_enabled = $1 where id = $2',
      [enabled, f.clientA]
    )

  /** Every table the client may read in an OPEN workspace, and must not in a closed one. */
  const WORKSPACE_TABLES = [
    'content_items',
    'content_assets',
    'links',
    'files',
    'moodboard_items',
    'notice_posts',
    'tasks',
  ] as const

  it.each([...WORKSPACE_TABLES])(
    'a client reads %s while their portal is open and nothing once it is closed',
    async (table) => {
      // Non-vacuous: they must actually see rows first, or "zero rows after"
      // proves only that the fixture is empty.
      const before = await asActor(
        { kind: 'client', userId: f.clientUserA },
        `select client_id from ${table}`
      )
      expect(before.length).toBeGreaterThan(0)

      await setPortal(false)
      try {
        const after = await asActor(
          { kind: 'client', userId: f.clientUserA },
          `select client_id from ${table}`
        )
        expect(after).toHaveLength(0)
      } finally {
        await setPortal(true)
      }
    }
  )

  it('staff still see a closed workspace — she builds one before opening it', async () => {
    await setPortal(false)
    try {
      const rows = await asActor(
        { kind: 'staff', userId: f.staffUser },
        'select id from content_items where client_id = $1',
        [f.clientA]
      )
      expect(rows.length).toBeGreaterThan(0)
    } finally {
      await setPortal(true)
    }
  })

  it('a client cannot post to the notice board of a closed workspace', async () => {
    await setPortal(false)
    try {
      // RLS filters a refused INSERT into an error, not a silent no-op, so the
      // assertion is on the throw. Asserting zero rows would pass vacuously.
      await expect(
        asActor(
          { kind: 'client', userId: f.clientUserA },
          'insert into notice_posts(client_id, body) values ($1, $2) returning id',
          [f.clientA, 'still talking']
        )
      ).rejects.toThrow(/row-level security/i)
    } finally {
      await setPortal(true)
    }
  })

  it('a client cannot approve content in a closed workspace', async () => {
    await setPortal(false)
    try {
      await expect(
        asActor(
          { kind: 'client', userId: f.clientUserA },
          `insert into content_approvals(client_id, content_item_id, decision, actor_id)
           values ($1, $2, 'approved', $3) returning id`,
          [f.clientA, f.contentAVisible, f.clientUserA]
        )
      ).rejects.toThrow(/row-level security/i)
    } finally {
      await setPortal(true)
    }
  })

  it('an archived client is closed too, whatever portal_enabled says', async () => {
    // The two gates are independent by design: portal_enabled is an ordinary
    // editable field, so a screen that flips it back on must not reopen an
    // archived workspace.
    await asActor(
      { kind: 'staff', userId: f.staffUser },
      'update clients set archived_at = now(), portal_enabled = true where id = $1',
      [f.clientA]
    )
    try {
      const rows = await asActor(
        { kind: 'client', userId: f.clientUserA },
        'select id from content_items'
      )
      expect(rows).toHaveLength(0)
    } finally {
      await asActor(
        { kind: 'staff', userId: f.staffUser },
        'update clients set archived_at = null where id = $1',
        [f.clientA]
      )
    }
  })

  it('closing one workspace does not close another client\'s', async () => {
    // app_client_ids() returns a SET; a bug that collapsed it to "the first
    // grant" or to nothing at all would pass every assertion above.
    const [{ n }] = await asActor<{ n: number }>(
      { kind: 'staff', userId: f.staffUser },
      'select count(*)::int as n from content_items where client_id = $1',
      [f.clientB]
    )
    await setPortal(false)
    try {
      const rows = await asActor(
        { kind: 'staff', userId: f.staffUser },
        'select id from content_items where client_id = $1',
        [f.clientB]
      )
      expect(rows).toHaveLength(n)
    } finally {
      await setPortal(true)
    }
  })
})

/**
 * Removing a seat has to remove the access, not just the membership.
 *
 * These assert the property DELETE /seats/members/:id depends on, at the layer
 * that actually decides it. That handler deletes the member row AND the
 * client_access rows, and the first test is why the second half exists:
 * membership is not what gates a client's portal, so removing only the seat
 * frees a licence and revokes nothing.
 */
describe('9 — removing a seat', () => {
  it('membership is not what grants access — client_access is', async () => {
    // This fixture never creates a `member` row for the client user; it grants
    // client_access and nothing else. So the strongest form of the claim is
    // already true here: no membership whatsoever, and full sight of their
    // workspace. A "remove the member and stop" handler would therefore take
    // away a seat and leave every door open.
    const memberships = await ownerPool.query(
      'select id from member where user_id = $1',
      [f.clientUserA]
    )
    expect(memberships.rowCount).toBe(0)

    const clients = await asActor<{ id: string }>(
      { kind: 'client', userId: f.clientUserA },
      'select id from clients'
    )
    expect(clients.map((r) => r.id)).toEqual([f.clientA])

    const items = await asActor(
      { kind: 'client', userId: f.clientUserA },
      'select id from content_items'
    )
    expect(items.length).toBeGreaterThan(0)
  })

  it('dropping client_access is what actually closes the door', async () => {
    const before = await ownerPool.query(
      'select user_id, client_id from client_access where user_id = $1',
      [f.clientUserA]
    )
    expect(before.rowCount).toBeGreaterThan(0)

    await ownerPool.query('delete from client_access where user_id = $1', [
      f.clientUserA,
    ])
    try {
      const clients = await asActor(
        { kind: 'client', userId: f.clientUserA },
        'select id from clients'
      )
      expect(clients).toHaveLength(0)

      for (const table of ['content_items', 'files', 'links', 'tasks']) {
        const rows = await asActor(
          { kind: 'client', userId: f.clientUserA },
          `select 1 from ${table}`
        )
        expect(rows, table).toHaveLength(0)
      }
    } finally {
      for (const row of before.rows) {
        await ownerPool.query(
          'insert into client_access(user_id, client_id) values ($1,$2) on conflict do nothing',
          [row.user_id, row.client_id]
        )
      }
    }
  })
})

/**
 * Share links (migration 0016).
 *
 * The security question is not "does the share page work" — it is "what ELSE
 * can a token reach". So most of these assert zero rows. They set the session
 * variables directly rather than going through withReviewToken, because what
 * is under test is what Postgres does once a review context exists, including
 * contexts the redeeming helper would never hand out.
 */
describe('10 — share links', () => {
  const itemLink = () => ({
    linkId: f.reviewLinkA,
    contentItemId: f.contentAVisible,
  })
  const feedLink = () => ({
    linkId: f.reviewLinkFeedA,
    feedClientId: f.clientA,
  })

  it('an item token sees exactly the one post it is for', async () => {
    const rows = await asReviewer<{ id: string }>(
      itemLink(),
      'select id from content_items'
    )
    expect(rows.map((r) => r.id)).toEqual([f.contentAVisible])
  })

  it('and that post’s creative', async () => {
    const rows = await asReviewer<{ storage_key: string }>(
      itemLink(),
      'select storage_key from content_assets'
    )
    expect(rows.map((r) => r.storage_key)).toEqual(['september-grid-01.jpg'])
  })

  /**
   * The load-bearing one. `AND visible_to_client` on the policy arm is what
   * stops a token minted around the handler from opening a raw Ideas Bank row
   * — a rejected pitch, an internal concept — at the database rather than only
   * in the route.
   */
  it('a token aimed at an UNSHARED item opens nothing', async () => {
    const rows = await asReviewer(
      { linkId: f.reviewLinkHidden, contentItemId: f.contentAHidden },
      'select id from content_items'
    )
    expect(rows).toHaveLength(0)
  })

  it('nor that unshared item’s creative', async () => {
    const rows = await asReviewer(
      { linkId: f.reviewLinkHidden, contentItemId: f.contentAHidden },
      'select storage_key from content_assets'
    )
    expect(rows).toHaveLength(0)
  })

  it('a token for one client cannot read another client’s post', async () => {
    const rows = await asReviewer(
      itemLink(),
      'select id from content_items where client_id = $1',
      [f.clientB]
    )
    expect(rows).toHaveLength(0)
  })

  it('nor another client’s creative, by its exact id', async () => {
    const rows = await asReviewer(
      itemLink(),
      'select storage_key from content_assets where client_id = $1',
      [f.clientB]
    )
    expect(rows).toHaveLength(0)
  })

  /**
   * 0002_rls.sql's instruction was to extend ONLY the content_* policies, "so
   * a review token routed into the files or deals handler still returns zero
   * rows". This is that sentence as a test.
   */
  it.each([
    'files',
    'links',
    'tasks',
    'deals',
    'contacts',
    'invoices',
    'invoice_payments',
    'moodboard_items',
    'notice_posts',
    'activities',
    'clients',
    'client_access',
    'review_links',
    'audit_log',
  ])('a review context reads nothing at all from %s', async (table) => {
    const rows = await asReviewer(itemLink(), `select 1 from ${table}`)
    expect(rows).toHaveLength(0)
  })

  it('reads its own decision back, and no one else’s', async () => {
    await ownerPool.query(
      `insert into content_approvals(client_id, content_item_id, decision, actor_id, review_link_id)
       values ($1,$2,'approved',null,$3)`,
      [f.clientA, f.contentAVisible, f.reviewLinkA]
    )
    await ownerPool.query(
      `insert into content_approvals(client_id, content_item_id, decision, actor_id, review_link_id)
       values ($1,$2,'approved',$3,null)`,
      [f.clientA, f.contentAVisible, f.staffUser]
    )
    try {
      const rows = await asReviewer<{ review_link_id: string }>(
        itemLink(),
        'select review_link_id from content_approvals'
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].review_link_id).toBe(f.reviewLinkA)
    } finally {
      await ownerPool.query('delete from content_approvals where content_item_id = $1', [
        f.contentAVisible,
      ])
    }
  })

  it('cannot read the internal comment thread', async () => {
    // content_comments_* were deliberately left untouched by 0016. Narrower
    // than 0002's note permits is fine; wider is not.
    const rows = await asReviewer(itemLink(), 'select body from content_comments')
    expect(rows).toHaveLength(0)
  })

  /**
   * The positive property that exists BECAUSE the decision goes through a
   * SECURITY DEFINER function instead of a policy arm.
   */
  it('cannot insert an approval directly', async () => {
    const rows = await asReviewer(
      itemLink(),
      `insert into content_approvals(client_id, content_item_id, decision, actor_id, review_link_id)
       values ($1,$2,'approved',null,$3) returning id`,
      [f.clientA, f.contentAVisible, f.reviewLinkA]
    ).catch(() => [] as unknown[])
    expect(rows).toHaveLength(0)
  })

  it('cannot write into the post it is reviewing', async () => {
    const rows = await asReviewer(
      itemLink(),
      `update content_items set title = 'injected' where id = $1 returning id`,
      [f.contentAVisible]
    ).catch(() => [] as unknown[])
    expect(rows).toHaveLength(0)
  })

  it('can never become staff, whatever the flag says', async () => {
    // app_is_staff() compares to the literal 'true' (migration 0007), so no
    // cast can be talked into agreeing. A review context sets 'false'.
    const rows = await asActorRaw<{ staff: boolean }>(
      {
        'app.user_id': '',
        'app.is_staff': 'false',
        'app.review_link_id': f.reviewLinkA,
        'app.review_content_id': f.contentAVisible,
      },
      'select app_is_staff() as staff'
    )
    expect(rows[0].staff).toBe(false)
  })

  it('a feed token sees the client’s shared posts and only those', async () => {
    const rows = await asReviewer<{ id: string; visible_to_client: boolean }>(
      feedLink(),
      'select id, visible_to_client from content_items'
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.visible_to_client)).toBe(true)
    expect(rows.map((r) => r.id)).not.toContain(f.contentAHidden)
    expect(rows.map((r) => r.id)).not.toContain(f.contentB)
  })

  it('a feed token reads no other client’s creative', async () => {
    const rows = await asReviewer(
      feedLink(),
      'select storage_key from content_assets where client_id = $1',
      [f.clientB]
    )
    expect(rows).toHaveLength(0)
  })

  it('a feed token still reads nothing from files or invoices', async () => {
    for (const table of ['files', 'invoices', 'deals']) {
      const rows = await asReviewer(feedLink(), `select 1 from ${table}`)
      expect(rows, table).toHaveLength(0)
    }
  })

  it('a malformed GUC returns NULL rather than raising 22P02', async () => {
    // A policy that throws invites the next person to "fix" the policy.
    const rows = await asActorRaw<{ a: string | null; b: string | null }>(
      {
        'app.user_id': '',
        'app.is_staff': 'false',
        'app.review_content_id': 'not-a-uuid',
        'app.review_feed_client_id': '¯\\_(ツ)_/¯',
      },
      'select app_review_content_id() as a, app_review_feed_client_id() as b'
    )
    expect(rows[0].a).toBeNull()
    expect(rows[0].b).toBeNull()
  })

  it('no review context at all reads nothing', async () => {
    const rows = await asActorRaw(
      { 'app.user_id': '', 'app.is_staff': 'false' },
      'select id from content_items'
    )
    expect(rows).toHaveLength(0)
  })
})
