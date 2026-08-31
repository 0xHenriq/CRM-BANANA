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
 * What a redeemed share link turned out to be.
 *
 * `contentItemId` is null for a feed link and `clientId` is always set, which
 * mirrors the CHECK on the table rather than restating it in TypeScript.
 */
export type ReviewContext = {
  linkId: string
  clientId: string
  contentItemId: string | null
  scope: 'content_item' | 'feed'
  useCount: number
  lastUsedAt: Date | null
  /** From the redeeming function, not from a select — `clients` stays closed. */
  clientName: string
  clientBrandColor: string | null
}

/**
 * Runs `fn` under a share link's authority, or returns null if it has none.
 *
 * The ONLY way to obtain a review context, and it requires a live token hash
 * in the same transaction — there is no way to set the review GUCs without
 * having first proved a token redeems. Compare with withTenant, which takes a
 * context object it trusts: this one earns it.
 *
 * Redemption is ONE statement so there is no check-then-use window between
 * "is this link still valid" and "act on it". Zero rows means expired,
 * revoked, unknown, or belonging to an archived client — all of which the
 * caller must answer identically, or the endpoint becomes an oracle for
 * guessing tokens.
 *
 * `portal_enabled` is deliberately NOT checked: the entire point is a
 * recipient with no portal account, so gating on the portal being open would
 * defeat the feature. `archived_at` IS checked, because archiving has to close
 * everything — that rule is why migration 0014 exists.
 *
 * The session variables it sets are worth reading closely. `app.user_id` is
 * emptied and `app.is_staff` is the literal 'false', so a review context can
 * never satisfy `app_is_staff()` — which compares to the literal 'true'
 * precisely so that no cast can be talked into agreeing (migration 0007).
 * app.review_content_id is set ONLY for an item-scoped link and
 * app.review_feed_client_id ONLY for a feed one, so a link cannot reach the
 * other scope's policy arm.
 */
export async function withReviewToken<T>(
  tokenHash: string,
  opts: { bump: boolean },
  fn: (tx: Tx, review: ReviewContext) => Promise<T>
): Promise<T | null> {
  return db.transaction(async (tx) => {
    /*
     * Through a SECURITY DEFINER function, because `review_links` is a
     * staff-only table and this request has no session at all.
     *
     * Written first as a plain UPDATE here, which matched zero rows for every
     * valid link: RLS was doing its job and the redemption had no authority
     * yet — it is the thing that CREATES the authority. Migration 0016
     * explains why a policy arm keyed to a GUC would be circular. The bump is
     * inside the same statement within the function, so a link cannot be
     * redeemed without being counted, and `bump: false` is for the asset route
     * — a post with three images must not score four views.
     */
    const redeemed = await tx.execute<{
      id: string
      client_id: string
      content_item_id: string | null
      scope: 'content_item' | 'feed'
      use_count: number
      last_used_at: Date | null
      client_name: string
      client_brand_color: string | null
    }>(sql`select * from redeem_review_link(${tokenHash}, ${opts.bump})`)

    const row = redeemed.rows[0]
    if (!row) return null

    await tx.execute(sql`
      select
        set_config('app.user_id', '', true),
        set_config('app.is_staff', 'false', true),
        set_config('app.review_link_id', ${row.id}, true),
        set_config('app.review_content_id', ${row.content_item_id ?? ''}, true),
        set_config('app.review_feed_client_id', ${row.scope === 'feed' ? row.client_id : ''}, true)
    `)

    return fn(tx, {
      linkId: row.id,
      clientId: row.client_id,
      contentItemId: row.content_item_id,
      scope: row.scope,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      clientName: row.client_name,
      clientBrandColor: row.client_brand_color,
    })
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
