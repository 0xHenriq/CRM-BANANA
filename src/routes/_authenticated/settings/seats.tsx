import { createFileRoute } from '@tanstack/react-router'
import { SettingsSeats } from '@/features/settings/seats'
import { requireStaffRoute } from '@/lib/route-guards'

/**
 * The one staff-only page in Settings.
 *
 * The section as a whole is deliberately left open — a client changing their
 * own name or picking a dark theme is theirs to do, and guarding the parent
 * route would take that away to fix a problem it does not have. This page is
 * different: it lists every account in the agency and can revoke them.
 */
export const Route = createFileRoute('/_authenticated/settings/seats')({
  beforeLoad: ({ context }) => requireStaffRoute(context),
  component: SettingsSeats,
})
