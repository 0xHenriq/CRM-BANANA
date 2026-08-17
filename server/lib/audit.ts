import { auditLog, activities } from '../db/schema.js'
import type { Tx } from '../db/index.js'

/**
 * Audit and activity writes.
 *
 * Both take the transaction rather than the pool, so the record lands or rolls
 * back with the change it describes. An audit row that survives a failed
 * mutation is worse than no audit row: it asserts something happened that
 * did not.
 *
 * `audit_log` is the org-wide, staff-only compliance trail — who changed what.
 * `activities` is the per-client timeline she actually reads on a client page.
 * They overlap deliberately: one is for answering "what happened to this
 * account", the other for "who touched this record".
 */
export async function audit(
  tx: Tx,
  entry: {
    actorId: string | null
    action: string
    entity: string
    entityId?: string | null
    meta?: Record<string, unknown>
  }
): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    meta: entry.meta ?? null,
  })
}

export async function recordActivity(
  tx: Tx,
  entry: {
    clientId: string
    entityType: string
    entityId?: string | null
    actorId: string | null
    kind?: 'note' | 'call' | 'email' | 'meeting' | 'status_change'
    body?: string | null
  }
): Promise<void> {
  await tx.insert(activities).values({
    clientId: entry.clientId,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    actorId: entry.actorId,
    kind: entry.kind ?? 'note',
    body: entry.body ?? null,
  })
}

/**
 * URL-safe slug from a client name, e.g. "Acme Skincare Ltd." -> acme-skincare-ltd.
 * Uniqueness is enforced by the column, not here; callers retry with a suffix.
 */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'client'
  )
}
