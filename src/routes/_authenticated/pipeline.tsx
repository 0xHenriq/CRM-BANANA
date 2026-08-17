import { createFileRoute } from '@tanstack/react-router'
import { NotBuiltYet } from '@/components/layout/not-built-yet'
import { requireStaffRoute } from '@/lib/route-guards'

export const Route = createFileRoute('/_authenticated/pipeline')({
  beforeLoad: ({ context }) => requireStaffRoute(context),
  component: () => (
    <NotBuiltYet
      eyebrow='New business'
      title='Pipeline'
      stamp={{ top: 'DEAL', big: '£', bottom: 'FLOW' }}
      summary='Lead to won, as a drag-and-drop board: proposal, agreement, retainer value, expected close.'
      phase='Phase 3'
    />
  ),
})
