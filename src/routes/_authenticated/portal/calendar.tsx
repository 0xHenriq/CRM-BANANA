import { createFileRoute } from '@tanstack/react-router'
import { NotBuiltYet } from '@/components/layout/not-built-yet'

export const Route = createFileRoute('/_authenticated/portal/calendar')({
  component: () => (
    <NotBuiltYet
      eyebrow='Content planning'
      title='Content Calendar'
      stamp={{ top: 'SCHED', big: '✎', bottom: 'ULE' }}
      summary='The month grid, with the post type chosen explicitly rather than cycled through, and drag to reschedule.'
      phase='Phase 5'
    />
  ),
})
