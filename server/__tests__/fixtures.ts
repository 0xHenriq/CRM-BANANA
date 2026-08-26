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

/**
 * Enforce what the message above only ASKS for.
 *
 * This file truncates every tenant table on the database it is pointed at, and
 * `bd_portal_test` lives on the same Postgres server as production — both are
 * reached through the same SSH tunnel on 127.0.0.1:55432, differing by one
 * word in the path. A stray `TEST_DATABASE_URL=$DATABASE_URL` in a shell, or a
 * copied line in .env, and this wipes the live database of an agency with real
 * clients on it.
 *
 * That is not hypothetical: set-password.ts was once run against production by
 * exactly this route, an environment variable leaking in from the surrounding
 * shell. It threw before writing. This would not throw — truncate always
 * succeeds.
 *
 * So the name is checked, not trusted. A database that is not visibly a test
 * database does not get truncated.
 */
for (const [name, url] of [
  ['TEST_DATABASE_URL', appUrl],
  ['TEST_DATABASE_URL_OWNER', ownerUrl],
] as const) {
  // Last path segment, so query strings and credentials cannot smuggle it past.
  const database = new URL(url).pathname.replace(/^\//, '')
  if (!/_test$/.test(database)) {
    throw new Error(
      `${name} points at "${database}", which does not end in _test. This ` +
        'suite truncates every tenant table on that database and refuses to ' +
        'run against anything that is not plainly a test database.'
    )
  }
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
  /**
   * A file and a moodboard tile per client.
   *
   * Both tables were in CLIENT_VISIBLE_TABLES with no fixture rows at all, so
   * every cross-tenant assertion over them passed by having nothing to read.
   * A table with no seed rows makes the isolation suite agree with itself
   * rather than with Postgres.
   */
  fileA: string
  fileB: string
  moodboardA: string
  moodboardB: string
  noticeA: string
  noticeB: string
  /** A pending invitation, so writes to invitation_grants can be exercised. */
  invitationId: string
  /** Issued: client A may see it, and its receipt. */
  invoiceAIssued: string
  /** Draft: her working copy. Neither it nor its payment may be visible. */
  invoiceADraft: string
  invoiceB: string
}

const TENANT_TABLES = [
  'invoice_payments',
  'invoices',
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
      fileA: randomUUID(),
      fileB: randomUUID(),
      moodboardA: randomUUID(),
      moodboardB: randomUUID(),
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
      `insert into files(id, client_id, name, storage_key)
       values ($1,$2,'Agreement.pdf','a/agreement.pdf'),
              ($3,$4,'Other agreement.pdf','b/agreement.pdf')`,
      [ids.fileA, clientA, ids.fileB, clientB]
    )

    await c.query(
      `insert into moodboard_items(id, client_id, storage_key)
       values ($1,$2,'a/mood-01.webp'),
              ($3,$4,'b/mood-01.webp')`,
      [ids.moodboardA, clientA, ids.moodboardB, clientB]
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

    /**
     * Invoices, in the three shapes that matter.
     *
     * A draft carries a payment too, because the interesting failure is not
     * the invoice leaking — it is the RECEIPT leaking and telling the client
     * about money against a document they were never sent. Same shape as the
     * hidden content item and its asset above, and for the same reason.
     */
    const invoiceAIssued = randomUUID()
    const invoiceADraft = randomUUID()
    const invoiceB = randomUUID()

    await c.query(
      `insert into invoices(id, client_id, number, status, amount_pence, issued_on, due_on)
       values ($1,$2,'INV-TEST-0001','sent',500000, current_date - 30, current_date - 5),
              ($3,$2,'INV-TEST-0002','draft',120000, null, null),
              ($4,$5,'INV-TEST-0003','sent',80000, current_date - 10, current_date + 5)`,
      [invoiceAIssued, clientA, invoiceADraft, invoiceB, clientB]
    )

    await c.query(
      `insert into invoice_payments(client_id, invoice_id, receipt_number, amount_pence, paid_on)
       values ($1,$2,'RCP-TEST-0001',200000, current_date - 3),
              ($1,$3,'RCP-TEST-0002',50000, current_date - 1)`,
      [clientA, invoiceAIssued, invoiceADraft]
    )

    const invitationId = `inv_${randomUUID()}`
    await c.query(
      `insert into invitation(id, organization_id, email, role, status, expires_at, inviter_id)
       values ($1,$2,'invited@client.test','client','pending', now() + interval '14 days', $3)`,
      [invitationId, orgRows[0].id, staffUser]
    )

    await c.query('commit')
    return {
      clientA,
      clientB,
      staffUser,
      clientUserA,
      invitationId,
      invoiceAIssued,
      invoiceADraft,
      invoiceB,
      ...ids,
    }
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
  // A receipt for their own issued invoice.
  'invoice_payments',
] as const

export const STAFF_ONLY_TABLES = [
  'invitation_grants',
  'contacts',
  'deals',
  'activities',
  'audit_log',
  'review_links',
] as const

export const COLUMN_GATED_TABLES = [
  'tasks',
  'content_items',
  // A draft invoice is her working copy; the client sees it only once issued.
  'invoices',
] as const

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
