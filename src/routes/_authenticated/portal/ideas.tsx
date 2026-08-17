import { createFileRoute } from '@tanstack/react-router'
import { NotBuiltYet } from '@/components/layout/not-built-yet'

export const Route = createFileRoute('/_authenticated/portal/ideas')({
  component: () => (
    <NotBuiltYet
      eyebrow='Concept backlog'
      title='Ideas Bank'
      stamp={{ top: 'IDEA', big: '☀', bottom: 'BANK' }}
      summary='Sortable and filterable, with status pills — and the same records the calendar shows, so approving an idea actually schedules it.'
      phase='Phase 5'
    />
  ),
})
