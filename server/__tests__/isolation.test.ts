import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ALL_TENANT_TABLES,
  CLIENT_VISIBLE_TABLES,
  COLUMN_GATED_TABLES,
  STAFF_ONLY_TABLES,
  asActor,
  asActorRaw,
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
    const tasks = await asActor(
      { kind: 'staff', userId: f.staffUser },
      'select id from tasks'
    )
    const content = await asActor(
      { kind: 'staff', userId: f.staffUser },
      'select id from content_items'
    )
    expect(tasks).toHaveLength(2)
    expect(content).toHaveLength(2)
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
