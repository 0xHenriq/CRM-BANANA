import { approvalState, type ApprovalState, type ContentStatus, type ContentType } from '@/lib/api'

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

/**
 * The traffic light, and the reason the pale fills above are no longer used
 * for status.
 *
 * Sofia: "can approved or scheduled be a green colour - pending orange - red
 * is declined". The old mapping gave each of the six statuses one of the
 * crate-palette tag fills, which are pale by design and differ from each other
 * by hue rather than by urgency — so "Ready for review" (peach) and "Approved"
 * (mint) read as two flavours of the same nothing, and there was no red at all
 * because `changes_requested` is not a status.
 *
 * These are the SAME three tokens the invoice panel uses for paid, awaiting
 * and overdue. Deliberately: across this product green means settled, orange
 * means somebody is waiting, red means something is wrong. Two different
 * greens for the two halves of the same screen would make the colour decorative
 * rather than a signal, and these three were already chosen to be legible
 * "across a room at the end of a long day", which is the requirement here too.
 *
 * `draft` is deliberately colourless. It covers every raw idea in the backlog,
 * and lighting those up would leave the Ideas Bank with a colour on every row —
 * a screen where everything is a signal has no signals on it.
 */
export const APPROVAL_TONE: Record<ApprovalState, string> = {
  approved: 'bg-pay-paid text-white',
  pending: 'bg-pay-awaiting text-bd-ink',
  declined: 'bg-pay-overdue text-white',
  draft: 'bg-bd-sand text-bd-ink',
}

/**
 * What the pill says when the traffic light is red.
 *
 * A declined post is back at `in_progress`, and "In progress" is the one thing
 * it must not read as — that is the same words a fresh draft gets, on the one
 * row that needs somebody to do something. The wording is hers: she calls it
 * declined, the API records it as `changes_requested`, and the client's button
 * says "Ask for changes" because that is kinder to send than to receive.
 */
export const DECLINED_LABEL = 'Changes requested'

/**
 * One sentence for where a post is, wherever it appears.
 *
 * The pill, the calendar chip's tooltip and the grid tile's screen-reader
 * label all need the same words, and writing them three times is how the
 * calendar ends up calling something "In progress" while the table beside it
 * calls the same row "Changes requested".
 */
export function approvalLabel(item: {
  status: ContentStatus
  lastDecision?: 'approved' | 'changes_requested' | null
}): string {
  const state = approvalState(item)
  return state === 'declined' ? DECLINED_LABEL : STATUS_LABEL[item.status]
}

/**
 * The content type, as a stripe down the leading edge.
 *
 * The calendar chip's FILL now carries the approval traffic light, which is
 * what Sofia asked to see there. The type still has to be visible — a grid of
 * nine identically-shaped chips tells her nothing about the mix — so it moves
 * to the border. Same five colours; a Reel is the same blue everywhere.
 */
export const TYPE_STRIPE: Record<ContentType, string> = {
  video: 'border-s-tag-video',
  reel: 'border-s-tag-reel',
  story: 'border-s-tag-story',
  graphic: 'border-s-tag-graphic',
  carousel: 'border-s-tag-carousel',
}
