import { createFileRoute } from '@tanstack/react-router'
import { NotBuiltYet } from '@/components/layout/not-built-yet'

export const Route = createFileRoute('/_authenticated/portal/feed')({
  component: () => (
    <NotBuiltYet
      eyebrow='3×3 grid mock up'
      title='Feed Preview'
      stamp={{ top: 'GRID', big: '9', bottom: 'POST' }}
      summary='Nine cells fed from real uploads rather than pasted image URLs, reorderable by drag.'
      phase='Phase 6'
    />
  ),
})
