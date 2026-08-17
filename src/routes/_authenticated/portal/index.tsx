import { createFileRoute } from '@tanstack/react-router'
import { PortalHome } from '@/features/portal'

export const Route = createFileRoute('/_authenticated/portal/')({
  component: PortalHome,
})
