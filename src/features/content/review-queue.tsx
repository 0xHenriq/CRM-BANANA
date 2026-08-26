import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ListChecks, SquareCheckBig } from 'lucide-react'
import { api, type ContentType } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { DueDate } from '@/features/portal/panels'
import { ContentDetailDialog } from './detail-dialog'
import { TypePill } from './pills'

/**
 * "What happens next, and by when."
 *
 * This panel used to be the review queue, headed "Waiting on clients". Sofia
 * asked for that to become next steps with date deadlines, and she was right
 * about the framing: "waiting on clients" describes the agency's feelings, not
 * anybody's next action, and a client reading it learns nothing about what
 * they are supposed to do.
 *
 * It now shows two kinds of step — a post that needs a decision, and an open
 * to-do that has a due date — soonest first, each with its deadline. The file
 * keeps its old name so no import path disappears; the export is what changed.
 *
 * Rendered only when there is something to act on. An empty prompt is noise,
 * and noise is how people learn to ignore a panel.
 */
export function NextSteps({
  variant = 'client',
  clientId,
}: {
  variant?: 'client' | 'agency'
  /** Narrow to one client — the client detail page, where the other nine are noise. */
  clientId?: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['next-steps', clientId ?? 'all'],
    queryFn: () =>
      api.get<{ steps: NextStep[]; scope: string }>(
        clientId ? `/next-steps/${clientId}` : '/next-steps'
      ),
  })

  // Nothing while loading, rather than an empty panel that flashes "all clear"
  // and then fills — the failure mode that made the dashboard confidently
  // report "Nothing outstanding" over an array it had not received yet.
  if (isPending) return null

  const steps = data?.steps ?? []
  if (steps.length === 0) return null

  const isClient = variant === 'client'

  return (
    <>
      <Card className='mb-5 crate-card border-bd-yellow-deep bg-bd-cream'>
        <CardContent className='py-4'>
          <div className='mb-3 flex items-center gap-2'>
            <span className='flex size-6 items-center justify-center rounded-full border-[1.5px] border-bd-ink bg-bd-yellow'>
              <ListChecks className='size-3.5 text-bd-ink' />
            </span>
            <h2 className='display text-lg'>
              {isClient ? 'Your next steps' : 'Next steps'}
            </h2>
            <span className='text-xs text-muted-foreground'>
              {steps.length} {steps.length === 1 ? 'thing' : 'things'}
            </span>
          </div>

          <ul className='divide-y divide-bd-rule-soft'>
            {steps.map((step) => (
              <li key={`${step.kind}-${step.id}`}>
                <StepRow
                  step={step}
                  isClient={isClient}
                  showClient={!isClient && !clientId}
                  onOpen={
                    step.kind === 'review'
                      ? () => setOpenId(step.id)
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>

          {isClient && (
            <p className='mt-3 text-xs text-muted-foreground'>
              Open a post to approve it or ask for changes.
            </p>
          )}
        </CardContent>
      </Card>

      <ContentDetailDialog itemId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}

type NextStep = {
  kind: 'review' | 'task'
  id: string
  clientId: string
  clientName: string
  title: string
  due: string | null
  /** Only on a review step — it is the content item's own type. */
  type?: ContentType
  visibleToClient?: boolean
}

/**
 * A review step opens its post; a to-do does not.
 *
 * Rendered as a button only when there is somewhere to go. A row that looks
 * clickable and does nothing is worse than a plain row — it reads as broken
 * rather than as informational.
 */
function StepRow({
  step,
  isClient,
  showClient,
  onOpen,
}: {
  step: NextStep
  isClient: boolean
  showClient: boolean
  onOpen?: () => void
}) {
  const body = (
    <>
      {step.kind === 'review' && step.type ? (
        <TypePill type={step.type} />
      ) : (
        <span
          aria-hidden
          className='flex size-5 shrink-0 items-center justify-center'
        >
          <SquareCheckBig className='size-4 text-muted-foreground' />
        </span>
      )}
      <span className='min-w-0 flex-1'>
        <span className='block truncate text-sm font-semibold'>
          {step.title}
        </span>
        <span className='block truncate text-xs text-muted-foreground'>
          {/* Staff need to know whose it is; the client already knows, and
              would only find it patronising. */}
          {showClient && `${step.clientName} · `}
          {step.kind === 'review'
            ? isClient
              ? 'Needs your review'
              : 'Waiting on the client'
            : 'To-do'}
        </span>
      </span>
      {step.due ? (
        <DueDate date={step.due} />
      ) : (
        <span className='shrink-0 text-xs text-muted-foreground'>No date</span>
      )}
      {onOpen && (
        <ArrowRight className='size-4 shrink-0 text-muted-foreground' />
      )}
    </>
  )

  return onOpen ? (
    <button
      type='button'
      onClick={onOpen}
      className='flex w-full items-center gap-3 py-2 text-start hover:opacity-70'
    >
      {body}
    </button>
  ) : (
    <div className='flex w-full items-center gap-3 py-2 text-start'>{body}</div>
  )
}
