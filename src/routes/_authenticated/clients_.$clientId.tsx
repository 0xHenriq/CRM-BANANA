import { createFileRoute } from '@tanstack/react-router'
import { ClientDetailPage } from '@/features/clients/detail'
import { requireStaffRoute } from '@/lib/route-guards'

export const Route = createFileRoute('/_authenticated/clients_/$clientId')({
  beforeLoad: ({ context }) => requireStaffRoute(context),
  component: ClientDetailPage,
})
