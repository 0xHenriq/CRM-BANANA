import { Client, Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'

/**
 * Fixtures for the isolation suite.
 *
 * Deliberately raw SQL rather than Drizzle: these tests assert what Postgres
 * does, not what the ORM asks it to do. Going through the query builder would
 * mean a passing suite could still coexist with a route that hand-writes SQL.
 */

const ownerUrl = process.env.TEST_DATABASE_URL_OWNER
const appUrl = process.env.TEST_DATABASE_URL

if (!ownerUrl || !appUrl) {
  throw new Error(
    'TEST_DATABASE_URL and TEST_DATABASE_URL_OWNER must be set. The isolation ' +
      'suite truncates its database, so it must never point at bd_portal.'
  )
}

/** Schema owner. Used only to build fixtures — never to assert visibility. */
export const ownerPool = new Pool({ connectionString: ownerUrl, max: 4 })

/** The runtime role: non-owner, rolbypassrls = false. All assertions run here. */
export const appPool = new Pool({ connectionString: appUrl, max: 4 })

export type Fixture = {
  clientA: string
  clientB: string
  staffUser: string
  clientUserA: string
  taskAVisible: string
  taskAInternal: string
  contentAVisible: string
  contentAHidden: string
  dealA: string
  contactA: string
  linkA: string
  linkB: string
  noticeA: string
  noticeB: string
  /** A pending invitation, so writes to invitation_grants can be exercised. */
  invitationId: string
}

const TENANT_TABLES = [
  'invitation_grants',
  'content_approvals',
  'content_comments',
  'content_assets',
  'review_links',
  'content_items',
  'moodboard_items',
  'notice_posts',
  'tasks',
  'files',
  'links',
  'activities',
  'audit_log',
  'deals',
  'contacts',
  'client_access',
  'clients',
] as const

export async function resetAndSeed(): Promise<Fixture> {
  const c = await ownerPool.connect()
  try {
    await c.query('begin')
    await c.query(`truncate ${TENANT_TABLES.join(', ')} cascade`)
    await c.query('truncate "member", "session", "account", "user" cascade')

    const clientA = randomUUID()
    const clientB = randomUUID()
    const staffUser = `staff_${randomUUID()}`
    const clientUserA = `client_${randomUUID()}`

    await c.query(
      `insert into "user"(id, name, email, email_verified, created_at, updated_at)
       values ($1,'Sophie','sophie@test.local',true,now(),now()),
              ($2,'Client A','a@client.test',true,now(),now())`,
      [staffUser, clientUserA]
    )

    await c.query(
      `insert into clients(id, name, slug, status, portal_enabled)
       values ($1,'Client A','client-a','active',true),
              ($2,'Client B','client-b','active',true)`,
      [clientA, clientB]
    )

    // The client user is granted A and, crucially, NOT B.
    await c.query(
      `insert into client_access(user_id, client_id) values ($1,$2)`,
      [clientUserA, clientA]
    )

    const ids = {
      taskAVisible: randomUUID(),
      taskAInternal: randomUUID(),
      contentAVisible: randomUUID(),
      contentAHidden: randomUUID(),
      dealA: randomUUID(),
      contactA: randomUUID(),
      linkA: randomUUID(),
      linkB: randomUUID(),
      noticeA: randomUUID(),
      noticeB: randomUUID(),
    }

    await c.query(
      `insert into tasks(id, client_id, title, visible_to_client)
       values ($1,$2,'Client can see this',true),
              ($3,$2,'Internal: chase invoice',false)`,
      [ids.taskAVisible, clientA, ids.taskAInternal]
    )

    await c.query(
      `insert into content_items(id, client_id, title, type, status, visible_to_client)
       values ($1,$2,'Shared for review','reel','ready_for_review',true),
              ($3,$2,'Raw idea, rejected pitch','graphic','idea',false)`,
      [ids.contentAVisible, clientA, ids.contentAHidden]
    )

    await c.query(
      `insert into deals(id, client_id, title, value, stage)
       values ($1,$2,'Retainer 2026',2400.00,'negotiation')`,
      [ids.dealA, clientA]
    )

    await c.query(
      `insert into contacts(id, client_id, name, email)
       values ($1,$2,'Primary contact','contact@client.test')`,
      [ids.contactA, clientA]
    )

    await c.query(
      `insert into links(id, client_id, label, url)
       values ($1,$2,'Google Drive','https://drive.example/a'),
              ($3,$4,'Google Drive','https://drive.example/b')`,
      [ids.linkA, clientA, ids.linkB, clientB]
    )

    await c.query(
      `insert into notice_posts(id, client_id, body)
       values ($1,$2,'Welcome aboard'),
              ($3,$4,'Other client notice')`,
      [ids.noticeA, clientA, ids.noticeB, clientB]
    )

    await c.query(
      `insert into activities(client_id, entity_type, kind, body)
       values ($1,'client','note','Internal account note')`,
      [clientA]
    )

    // Children of the HIDDEN content item. These are what leaked before
    // migration 0006: the client could not see the item, but could read its
    // asset key and the internal comment attached to it.
    await c.query(
      `insert into content_assets(client_id, content_item_id, kind, storage_key)
       values ($1,$2,'image','secret-pitch-deck.png')`,
      [clientA, ids.contentAHidden]
    )
    await c.query(
      `insert into content_comments(client_id, content_item_id, author_id, body)
       values ($1,$2,$3,'Internal: client rejected this angle')`,
      [clientA, ids.contentAHidden, staffUser]
    )
    // And a visible one, so the tests prove the rule is selective rather than
    // simply hiding everything.
    await c.query(
      `insert into content_assets(client_id, content_item_id, kind, storage_key)
       values ($1,$2,'image','september-grid-01.jpg')`,
      [clientA, ids.contentAVisible]
    )

    /**
     * An organization and a pending invitation.
     *
     * Only invitation_grants needs these, and it needs them because that table
     * is the one staff-only row the app writes from a route rather than from a
     * fixture — POST /api/seats/invite. Truncating "user" cascades the
     * invitation away, so both are rebuilt each run; the organization is
     * matched on its slug because it is not in TENANT_TABLES and therefore
     * survives.
     */
    await c.query(
      `insert into organization(id, name, slug, created_at)
       values ($1,'Isolation Fixture','isolation-fixture',now())
       on conflict (slug) do nothing`,
      [randomUUID()]
    )
    const { rows: orgRows } = await c.query<{ id: string }>(
      `select id from organization where slug = 'isolation-fixture'`
    )

    const invitationId = `inv_${randomUUID()}`
    await c.query(
      `insert into invitation(id, organization_id, email, role, status, expires_at, inviter_id)
       values ($1,$2,'invited@client.test','client','pending', now() + interval '14 days', $3)`,
      [invitationId, orgRows[0].id, staffUser]
    )

    await c.query('commit')
    return { clientA, clientB, staffUser, clientUserA, invitationId, ...ids }
  } catch (err) {
    await c.query('rollback')
    throw err
  } finally {
    c.release()
  }
}

export type Actor =
  | { kind: 'staff'; userId: string }
  | { kind: 'client'; userId: string }
  | { kind: 'anonymous' }

/**
 * Runs a query as an actor, applying the same session variables the
 * application applies — and, for `anonymous`, applying none at all.
 *
 * That last case is the point: with nothing set, every policy must yield zero
 * rows rather than raising. `current_setting` without missing_ok would throw
 * here, and the tempting "fix" for a test failing that way is to loosen the
 * policy.
 */
export async function asActor<T = unknown>(
  actor: Actor,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  /**
   * Anonymous actors get a brand-new connection, never a pooled one.
   *
   * This is not fussiness. Once `set_config('app.is_staff', …)` has run on a
   * connection, that custom GUC exists on the session for its lifetime — after
   * the transaction ends it reverts to empty rather than ceasing to exist. So
   * `current_setting('app.is_staff')` stops raising on any connection a
   * previous test has touched.
   *
   * Reusing the pool here made the fail-closed tests pass whether or not the
   * helpers used missing_ok: verified by mutation, they did not fail when the
   * flag was removed. A fresh connection is the only way this assertion
   * actually exercises the never-set case.
   */
  if (actor.kind === 'anonymous') {
    const client = new Client({ connectionString: appUrl })
    await client.connect()
    try {
      await client.query('begin')
      const res = await client.query(sql, params)
      await client.query('commit')
      return res.rows as T[]
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      await client.end()
    }
  }

  const c: PoolClient = await appPool.connect()
  try {
    await c.query('begin')
    await c.query(
      `select set_config('app.user_id', $1, true),
              set_config('app.is_staff', $2, true)`,
      [actor.userId, actor.kind === 'staff' ? 'true' : 'false']
    )
    const res = await c.query(sql, params)
    await c.query('commit')
    return res.rows as T[]
  } catch (err) {
    await c.query('rollback')
    throw err
  } finally {
    c.release()
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([ownerPool.end(), appPool.end()])
}

/**
 * Every table the isolation suite must cover. Keeping this list here — rather
 * than inline in one test — is what makes "added a table without a policy"
 * a build failure: a new tenant table with no entry fails the coverage test.
 */
export const CLIENT_VISIBLE_TABLES = [
  'links',
  'files',
  'notice_posts',
  'moodboard_items',
  'content_assets',
  'content_comments',
  'content_approvals',
] as const

export const STAFF_ONLY_TABLES = [
  'invitation_grants',
  'contacts',
  'deals',
  'activities',
  'audit_log',
  'review_links',
] as const

export const COLUMN_GATED_TABLES = ['tasks', 'content_items'] as const

export const ALL_TENANT_TABLES = [
  ...CLIENT_VISIBLE_TABLES,
  ...STAFF_ONLY_TABLES,
  ...COLUMN_GATED_TABLES,
  'clients',
  'client_access',
] as const

/**
 * Runs a query with session variables set to exact literal values.
 *
 * `asActor` always writes well-formed values, so it cannot exercise what the
 * SQL helpers do with a malformed one — an empty string, or something that is
 * not a boolean at all. Those are the inputs a bug would actually produce.
 */
export async function asActorRaw<T = unknown>(
  settings: Record<string, string>,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const c: PoolClient = await appPool.connect()
  try {
    await c.query('begin')
    for (const [name, value] of Object.entries(settings)) {
      await c.query('select set_config($1, $2, true)', [name, value])
    }
    const res = await c.query(sql, params)
    await c.query('commit')
    return res.rows as T[]
  } catch (err) {
    await c.query('rollback').catch(() => {})
    throw err
  } finally {
    c.release()
  }
}
