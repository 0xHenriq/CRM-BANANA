import type { ContentStatus, ContentType } from '@/lib/api'

/**
 * Her vocabulary and her colours, kept out of the component files so fast
 * refresh works and so a Reel is the same colour everywhere it appears —
 * calendar tag, table pill, feed label.
 *
 * The fills are lifted verbatim from the prototype's CSS.
 */
export const TYPE_TONE: Record<ContentType, string> = {
  video: 'bg-tag-video',
  reel: 'bg-tag-reel',
  story: 'bg-tag-story',
  graphic: 'bg-tag-graphic',
  carousel: 'bg-tag-carousel',
}

export const TYPE_LABEL: Record<ContentType, string> = {
  video: 'Video',
  reel: 'Reel',
  story: 'Story',
  graphic: 'Graphic',
  carousel: 'Carousel',
}

/** Her four, plus the two the prototype implied but could not express. */
export const STATUS_LABEL: Record<ContentStatus, string> = {
  idea: 'Idea',
  in_progress: 'In progress',
  ready_for_review: 'Ready for review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
}

export const STATUS_TONE: Record<ContentStatus, string> = {
  idea: 'bg-bd-sand',
  in_progress: 'bg-tag-carousel',
  ready_for_review: 'bg-tag-story',
  approved: 'bg-tag-video',
  scheduled: 'bg-tag-reel',
  published: 'bg-bd-yellow',
}
