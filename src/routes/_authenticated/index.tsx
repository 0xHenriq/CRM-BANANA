import { createFileRoute } from '@tanstack/react-router'
import { Dashboard } from '@/features/dashboard'
import { requireStaffRoute } from '@/lib/route-guards'

export const Route = createFileRoute('/_authenticated/')({
  /**
   * Clients never see the agency dashboard — not even an empty one. Landing a
   * client on a screen headed "Agency overview" is a framing leak: it tells
   * them there is an inside they are outside of, and invites them to go
   * looking. Send them straight to their own workspace.
   *
   * `context.user` is resolved by the parent `_authenticated` route.
   */
  beforeLoad: ({ context }) => requireStaffRoute(context),
  component: Dashboard,
})
