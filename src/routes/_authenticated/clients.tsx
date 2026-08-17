import { createFileRoute } from '@tanstack/react-router'
import { NotBuiltYet } from '@/components/layout/not-built-yet'
import { requireStaffRoute } from '@/lib/route-guards'

export const Route = createFileRoute('/_authenticated/clients')({
  beforeLoad: ({ context }) => requireStaffRoute(context),
  component: () => (
    <NotBuiltYet
      eyebrow='Accounts'
      title='Clients'
      stamp={{ top: 'BD', big: 'CL', bottom: 'LDN' }}
      summary='Every client account, their contacts, and the state of their workspace.'
      phase='Phase 3'
    />
  ),
})
