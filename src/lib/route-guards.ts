import { redirect } from '@tanstack/react-router'
import type { CurrentUser } from '@/hooks/use-current-user'

/**
 * Blocks a client-role session from an agency route.
 *
 * Hiding the nav entry is not enough — the URL is still typeable, and a client
 * landing on a screen headed "New business" learns things about how she runs
 * her agency. Send them back to their own workspace instead of showing a
 * forbidden page, which would confirm the route exists.
 *
 * This is presentation-layer only. The API and the RLS policies are what
 * actually keep client data and agency data apart.
 */
export function requireStaffRoute(context: { user?: CurrentUser | null }) {
  if (!context.user?.isStaff) {
    throw redirect({ to: '/portal' })
  }
}
