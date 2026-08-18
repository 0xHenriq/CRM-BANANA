import { createFileRoute } from '@tanstack/react-router'
import { ContentCalendar } from '@/features/content/calendar'

export const Route = createFileRoute('/_authenticated/portal/calendar')({
  component: ContentCalendar,
})
