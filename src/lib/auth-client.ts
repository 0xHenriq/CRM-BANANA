import { createAuthClient } from 'better-auth/react'
import { organizationClient } from 'better-auth/client/plugins'

/**
 * Session lives in an httpOnly cookie, so there is no token for this client —
 * or for any script on the page — to hold. That is deliberate: a token in
 * localStorage is readable by every dependency in the bundle.
 *
 * Same-origin `/api/auth` in both environments (Vite proxies it in dev, Caddy
 * in production), so cookies behave identically and there is no CORS to
 * configure.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [organizationClient()],
})

export const { signIn, signOut, useSession } = authClient

const STAFF_ROLES = new Set(['owner', 'admin', 'member'])

/**
 * Mirrors `isStaffRole` on the server. Presentation only — hiding agency nav
 * from a client is courtesy; the RLS policies are what actually stop them
 * reading it.
 */
export function isStaffRole(role: string | null | undefined): boolean {
  if (!role) return false
  return role
    .split(',')
    .map((r) => r.trim())
    .some((r) => STAFF_ROLES.has(r))
}
