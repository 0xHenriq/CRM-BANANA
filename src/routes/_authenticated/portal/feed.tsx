import { createFileRoute } from '@tanstack/react-router'
import { FeedPreview } from '@/features/content/feed-preview'

export const Route = createFileRoute('/_authenticated/portal/feed')({
  component: FeedPreview,
})
