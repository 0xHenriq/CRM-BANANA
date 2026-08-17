/**
 * Drizzle schema.
 *
 * Phase 1 defines only what is needed to prove the stack end to end. The real
 * tables land in Phase 2 (auth + client_access + RLS) and Phase 3+ (CRM and
 * portal), per the plan.
 *
 * Two conventions that apply to every table added later:
 *
 *  1. Anything holding tenant data carries `clientId` directly — including
 *     child tables like content_assets. An RLS policy that has to join upward
 *     to find its tenant is both slower and easier to get subtly wrong.
 *  2. Nothing is queried outside `withTenant()`. There is no ambient
 *     "current user"; the transaction carries it.
 */
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Boot marker. Lets `/healthz` prove it can actually reach Postgres and read a
 * real table, rather than only that a TCP connection opened — a distinction
 * that matters once RLS is on and permissions can fail silently.
 */
export const systemMeta = pgTable('system_meta', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
