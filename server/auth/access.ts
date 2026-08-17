import { createAccessControl } from 'better-auth/plugins/access'
import {
  defaultStatements,
  adminAc,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access'

/**
 * Roles.
 *
 * There is exactly one organization — Banana Digital — and every seat is a
 * member of it. Four roles, split into two audiences:
 *
 *   owner / admin / member  → agency staff. See every client.
 *   client                  → her clients. See only the workspaces granted to
 *                             them in `client_access`, and never the CRM.
 *
 * Modelling clients as members of the agency org is slightly odd semantically
 * (they don't work there), but it keeps the seat count exactly what she asked
 * for — "10 seats inside" is `select count(*) from member` — and it means one
 * identity system rather than two.
 *
 * These permission statements gate Better Auth's own organization endpoints.
 * They are NOT what protects tenant data: that is Postgres RLS. Anything here
 * is a second line, and the isolation suite tests the first.
 */
export const statements = {
  ...defaultStatements,
  client: ['create', 'update', 'delete', 'read'],
  deal: ['create', 'update', 'delete', 'read'],
  content: ['create', 'update', 'delete', 'read', 'approve'],
  portal: ['read', 'write'],
} as const

export const ac = createAccessControl(statements)

export const roles = {
  owner: ac.newRole({
    ...ownerAc.statements,
    client: ['create', 'update', 'delete', 'read'],
    deal: ['create', 'update', 'delete', 'read'],
    content: ['create', 'update', 'delete', 'read', 'approve'],
    portal: ['read', 'write'],
  }),
  admin: ac.newRole({
    ...adminAc.statements,
    client: ['create', 'update', 'delete', 'read'],
    deal: ['create', 'update', 'delete', 'read'],
    content: ['create', 'update', 'delete', 'read', 'approve'],
    portal: ['read', 'write'],
  }),
  member: ac.newRole({
    ...memberAc.statements,
    client: ['read', 'update'],
    deal: ['read'],
    content: ['create', 'update', 'read'],
    portal: ['read', 'write'],
  }),
  /**
   * Clients can read their own workspace, contribute to it, and approve
   * content. They cannot touch the CRM at all — note the absent `deal` and
   * `client` statements. A client reading their own deal row would expose
   * what she charges them and her expected close date.
   */
  client: ac.newRole({
    content: ['read', 'approve'],
    portal: ['read', 'write'],
  }),
}

export const STAFF_ROLES = ['owner', 'admin', 'member'] as const
export const CLIENT_ROLE = 'client' as const

export type AppRole = keyof typeof roles

/**
 * The single source of truth for the staff/client split.
 *
 * Everything downstream keys off this: the RLS `app.is_staff` session
 * variable, the sidebar's staffOnly groups, and route guards. Anything not
 * explicitly a staff role is treated as a client — an unknown or malformed
 * role must degrade to the *less* privileged side, never the more.
 */
export function isStaffRole(role: string | null | undefined): boolean {
  if (!role) return false
  // A member row can carry a comma-separated role list.
  return role
    .split(',')
    .map((r) => r.trim())
    .some((r) => (STAFF_ROLES as readonly string[]).includes(r))
}
