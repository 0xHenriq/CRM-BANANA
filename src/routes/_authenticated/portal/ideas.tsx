import { createFileRoute } from '@tanstack/react-router'
import { IdeasBank } from '@/features/content/ideas'

export const Route = createFileRoute('/_authenticated/portal/ideas')({
  component: IdeasBank,
})
