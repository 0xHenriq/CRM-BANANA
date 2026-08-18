import { cn } from '@/lib/utils'
import type { ContentStatus, ContentType } from '@/lib/api'
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
