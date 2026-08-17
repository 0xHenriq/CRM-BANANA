import { cn } from '@/lib/utils'
import type { ClientStatus, DealStage } from '@/lib/api'

/**
 * Status pills, styled with the tag fills from her prototype rather than
 * generic semantic colours — the same palette the content types use, so the
 * whole product reads as one system.
 */
const CLIENT_TONE: Record<ClientStatus, string> = {
  lead: 'bg-tag-reel',
  proposal: 'bg-tag-carousel',
  active: 'bg-tag-video',
  paused: 'bg-tag-story',
  churned: 'bg-tag-graphic',
}

const CLIENT_LABEL: Record<ClientStatus, string> = {
  lead: 'Lead',
  proposal: 'Proposal',
  active: 'Active',
  paused: 'Paused',
  churned: 'Churned',
}

const STAGE_LABEL: Record<DealStage, string> = {
  lead: 'Lead',
  contacted: 'Contacted',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
}

const STAGE_TONE: Record<DealStage, string> = {
  lead: 'bg-tag-reel',
  contacted: 'bg-tag-carousel',
  proposal: 'bg-tag-graphic',
  negotiation: 'bg-tag-story',
  won: 'bg-tag-video',
  lost: 'bg-bd-sand',
}

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

export function ClientStatusPill({ status }: { status: ClientStatus }) {
  return <Pill tone={CLIENT_TONE[status]}>{CLIENT_LABEL[status]}</Pill>
}

export function DealStagePill({ stage }: { stage: DealStage }) {
  return <Pill tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Pill>
}

export { CLIENT_LABEL, STAGE_LABEL }
