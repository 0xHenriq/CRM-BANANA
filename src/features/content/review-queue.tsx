import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, ListChecks, Loader2, SquareCheckBig } from 'lucide-react'
import { toast } from 'sonner'
import { api, type ContentType } from '@/lib/api'
import { cn } from '@/lib/utils'
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
  const queryClient = useQueryClient()

  /**
   * Tick a to-do off from here.
   *
   * Sofia: "Next steps - cant edit actions". A review step opened its post; a
   * to-do was a plain row with a deadline and no way to act on it, so the one
   * panel headed "what happens next" was the one place she could not do the
   * next thing. She had to find the same to-do again in the client's workspace.
   *
   * The same endpoint the To-do list uses, so the two cannot disagree about
   * what ticking means. Every key that counts open steps is refreshed: this
   * panel, the workspace panels, and the client list's open-task metric.
   */
  const tick = useMutation({
    mutationFn: (id: string) => api.patch(`/portal/tasks/${id}`, { done: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['next-steps'] })
      await queryClient.invalidateQueries({ queryKey: ['portal'] })
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

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
                  onDone={
                    step.kind === 'task'
                      ? () => tick.mutate(step.id)
                      : undefined
                  }
                  ticking={tick.isPending && tick.variables === step.id}
                />
              </li>
            ))}
          </ul>

          <p className='mt-3 text-xs text-muted-foreground'>
            {isClient
              ? 'Open a post to approve it or ask for changes.'
              : 'Open a post to decide on it, or tick a to-do off here.'}
          </p>
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
  onDone,
  ticking,
}: {
  step: NextStep
  isClient: boolean
  showClient: boolean
  onOpen?: () => void
  /** Only on a to-do, and only for staff — clients do not own these. */
  onDone?: () => void
  ticking?: boolean
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
      {/*
        No "Approval not received" pill here, deliberately.

        This panel already answers it twice: the line above reads "Waiting on
        the client", and DueDate renders a RED "3d overdue" badge for any date
        that has passed. A third red badge saying the same thing is noise, and
        two reds side by side make each other look less urgent rather than
        more. The pill earns its place on the Ideas Bank table and on the post
        itself, where the scheduled date is plain grey text and nothing else
        marks it as missed.
      */}
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

  /*
   * The deadline badge and the Done button carry the same vocabulary in
   * opposite directions, which is the point of having both: red says this one
   * has slipped, green says this one is settled. Without a green anywhere, red
   * is just how the panel looks rather than a signal that means something.
   */
  const doneButton = onDone ? (
    <button
      type='button'
      onClick={(e) => {
        // The row itself may be a button. Ticking must not also open anything.
        e.stopPropagation()
        onDone()
      }}
      disabled={ticking}
      aria-label={`Mark "${step.title}" done`}
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full border-[1.5px] border-bd-ink px-2 py-0.5',
        'text-[0.625rem] font-bold whitespace-nowrap transition-colors',
        // Green at rest, not only on hover: the point is that red and green
        // are visible on the same row at the same time, so "3d overdue" reads
        // as a signal rather than as how this panel happens to look.
        'bg-tag-video text-bd-ink hover:brightness-95',
        ticking && 'pointer-events-none opacity-70'
      )}
    >
      {ticking ? (
        <Loader2 className='size-3 animate-spin' />
      ) : (
        <Check className='size-3' />
      )}
      Done
    </button>
  ) : null

  return onOpen ? (
    <button
      type='button'
      onClick={onOpen}
      className='flex w-full items-center gap-3 py-2 text-start hover:opacity-70'
    >
      {body}
    </button>
  ) : (
    <div className='flex w-full items-center gap-3 py-2 text-start'>
      {body}
      {doneButton}
    </div>
  )
}
