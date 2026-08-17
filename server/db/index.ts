import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { env } from '../env.js'
import * as schema from './schema.js'

/**
 * The runtime pool connects as `bd_app` — a non-owner, non-superuser role with
 * rolbypassrls = false. That is not a detail: RLS policies are only binding
 * because of it. Never point this at bd_owner "to fix a permissions error";
 * doing so silently disables every tenancy guarantee in the application.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

export const db = drizzle(pool, { schema })

export type TenantContext = {
  /** Signed-in user id, or null for unauthenticated/system contexts. */
  userId: string | null
  /** True for owner/admin/member roles; false for the `client` role. */
  isStaff: boolean
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Runs `fn` inside a transaction with the RLS session variables applied.
 *
 * Every query that touches tenant data must go through here. `SET LOCAL`
 * semantics (the `true` third argument to set_config) scope the settings to the
 * transaction, which is what makes this safe under connection pooling — the
 * next checkout of the same physical connection cannot inherit them.
 *
 * Empty strings rather than NULLs are deliberate: the SQL helpers use
 * `nullif(current_setting(..., true), '')`, so an absent user reads back as
 * NULL and every policy evaluates to zero rows. Fail closed, never fail open.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.user_id', ${ctx.userId ?? ''}, true),
        set_config('app.is_staff', ${ctx.isStaff ? 'true' : 'false'}, true)
    `)
    return fn(tx)
  })
}

/**
 * Escape hatch for genuinely tenant-free work: migrations, health checks, and
 * the Better Auth tables (which have no client_id and no policies).
 *
 * It still connects as bd_app, so it cannot read tenant rows either — the
 * policies deny by default with no session variables set. That is intentional:
 * there is no "read everything" door in this codebase.
 */
export async function withoutTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn)
}

export async function closeDb() {
  await pool.end()
}
