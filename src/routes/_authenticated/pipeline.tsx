import { createFileRoute } from '@tanstack/react-router'
import { Pipeline } from '@/features/pipeline'
import { requireStaffRoute } from '@/lib/route-guards'

export const Route = createFileRoute('/_authenticated/pipeline')({
  beforeLoad: ({ context }) => requireStaffRoute(context),
  component: Pipeline,
})
