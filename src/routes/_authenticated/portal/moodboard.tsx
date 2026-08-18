import { createFileRoute } from '@tanstack/react-router'
import { Moodboard } from '@/features/content/moodboard'

export const Route = createFileRoute('/_authenticated/portal/moodboard')({
  component: Moodboard,
})
