import { createFileRoute } from '@tanstack/react-router'
import { NotBuiltYet } from '@/components/layout/not-built-yet'

export const Route = createFileRoute('/_authenticated/portal/moodboard')({
  component: () => (
    <NotBuiltYet
      eyebrow='Visual direction'
      title='Social Moodboard'
      stamp={{ top: 'MOOD', big: '❦', bottom: 'BOARD' }}
      summary='A collage of real uploaded images with captions, not links to images hosted somewhere else.'
      phase='Phase 6'
    />
  ),
})
