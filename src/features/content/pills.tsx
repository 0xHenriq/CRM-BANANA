import { cn } from '@/lib/utils'
import { isApprovalOverdue, type ContentStatus, type ContentType } from '@/lib/api'
import { STATUS_LABEL, STATUS_TONE, TYPE_LABEL, TYPE_TONE } from './vocabulary'

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

export function StatusPill({ status }: { status: ContentStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>
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
