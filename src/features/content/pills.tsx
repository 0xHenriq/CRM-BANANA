import { cn } from '@/lib/utils'
import {
  approvalState,
  isApprovalOverdue,
  type ApprovalState,
  type ContentStatus,
  type ContentType,
} from '@/lib/api'
import {
  APPROVAL_STATE_LABEL,
  APPROVAL_TONE,
  approvalLabel,
  TYPE_LABEL,
  TYPE_TONE,
} from './vocabulary'

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border-[1.5px] border-bd-ink px-2 py-0.5',
        'text-[0.6875rem] font-bold whitespace-nowrap text-bd-ink',
        tone
      )}
    >
      {children}
    </span>
  )
}

export function TypePill({ type }: { type: ContentType }) {
  return <Pill tone={TYPE_TONE[type]}>{TYPE_LABEL[type]}</Pill>
}

/**
 * Where a post is, in her colours.
 *
 * Takes the ITEM rather than the status, because the third colour is not a
 * status: a declined post is moved back to `in_progress`, which is where a
 * fresh draft also sits. `lastDecision` is what tells them apart, and asking
 * every caller to work that out for themselves is how three screens end up
 * disagreeing about which posts are red.
 *
 * Optional `lastDecision` so a caller that genuinely does not have it — a
 * payload written before this existed, arriving in a tab open across a
 * deploy — renders a grey draft rather than blanking the row.
 */
export function StatusPill({
  item,
}: {
  item: { status: ContentStatus; lastDecision?: 'approved' | 'changes_requested' | null }
}) {
  return (
    <Pill tone={APPROVAL_TONE[approvalState(item)]}>{approvalLabel(item)}</Pill>
  )
}

/**
 * The traffic light on its own, for a square preview tile.
 *
 * The grid views have no room for a word, and the colour IS the message
 * there — but a dot with no text is unreadable to a screen reader and to
 * anyone who cannot separate the three hues, so the label rides along
 * invisibly. Never colour alone.
 */
export function ApprovalDot({
  state,
  className,
}: {
  state: ApprovalState
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex size-3 shrink-0 rounded-full border-[1.5px] border-bd-ink',
        APPROVAL_TONE[state],
        className
      )}
    >
      <span className='sr-only'>{APPROVAL_STATE_LABEL[state]}</span>
    </span>
  )
}

/**
 * "Approval not received" — the post whose day came and went unanswered.
 *
 * One component rather than the same markup in three screens, so the Ideas
 * Bank, the post itself and Next Steps cannot end up disagreeing about which
 * posts are chased. Callers pass the item and this decides, rather than each
 * caller writing the predicate again.
 *
 * Red, unlike every other pill here, and that is the point: the rest of this
 * vocabulary describes where a post is in the process, and this one is the
 * only one that means something has gone wrong and she has to act.
 */
export function ApprovalOverduePill({
  item,
}: {
  item: { status: ContentStatus; scheduledAt: string | null }
}) {
  if (!isApprovalOverdue(item)) return null
  return (
    <Pill tone='bg-destructive text-destructive-foreground'>
      Approval not received
    </Pill>
  )
}
