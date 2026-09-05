import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  ListChecks,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  SquareCheckBig,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, type ContentType } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { DueDate } from '@/features/portal/panels'
import { TaskThread } from '@/features/portal/task-thread'
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
 * to-do that has a due date — soonest first, each with its deadline, and a
 * reply thread on each to-do. The file keeps its old name so no import path
 * disappears; the export is what changed.
 *
 * Empty means ABSENT everywhere except one screen: a client's own page, to
 * staff, where it renders empty with an Add button. See `canAdd` below for
 * why — a lead or a proposal has nothing outstanding by definition, and that
 * was the one place with nowhere to write down what happens next.
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
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ title: '', dueDate: '' })
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
  /**
   * Change a to-do without leaving the panel.
   *
   * Sofia asked to "edit actions" here. Ticking one off was not enough: a
   * deadline she needs to move, or a title she typed in a hurry, sent her to
   * the client's workspace to find the same row again.
   */
  const editTask = useMutation({
    mutationFn: ({ id, ...body }: { id: string; title?: string; dueDate?: string | null }) =>
      api.patch(`/portal/tasks/${id}`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['next-steps'] })
      await queryClient.invalidateQueries({ queryKey: ['portal'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  /**
   * And add one. Only on a client-scoped panel — the agency-wide dashboard
   * spans every client, so there is no single workspace a new to-do could
   * belong to, and asking her to pick one inside a panel headed "what happens
   * next" would be a form pretending to be a list.
   */
  const addTask = useMutation({
    mutationFn: (body: { title: string; dueDate: string | null }) =>
      api.post(`/portal/tasks?client=${clientId}`, {
        title: body.title,
        dueDate: body.dueDate,
        // Internal by default: a to-do she adds from her own next-steps panel
        // is her work, not something to publish to the client's portal.
        visibleToClient: false,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['next-steps'] })
      await queryClient.invalidateQueries({ queryKey: ['portal'] })
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
      setAdding(false)
      setDraft({ title: '', dueDate: '' })
    },
    onError: (err: Error) => toast.error(err.message),
  })

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
  const isClient = variant === 'client'

  /*
   * An empty panel is shown on ONE screen: a client's own page, to staff.
   *
   * Sofia, under a screenshot of a client at proposal stage: "no next steps on
   * client that are in proposal or lead mode". A lead or a proposal has no
   * content awaiting review and no dated to-dos, so this panel returned null
   * and the one place to write down "send the quote by Friday" simply was not
   * on the page — on exactly the clients where chasing is the entire job.
   *
   * Everywhere else, empty still means absent. On the agency dashboard an
   * empty next-steps panel says nothing and takes the space above the work;
   * for a CLIENT it is worse than nothing, because a box headed "Your next
   * steps" containing a shrug invites them to wonder what they have missed.
   */
  const canAdd = !isClient && Boolean(clientId)
  if (steps.length === 0 && !canAdd) return null

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
              {steps.length === 0
                ? 'nothing outstanding'
                : `${steps.length} ${steps.length === 1 ? 'thing' : 'things'}`}
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
                  onEdit={
                    step.kind === 'task' && !isClient
                      ? (patch) => editTask.mutate({ id: step.id, ...patch })
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>

          {/*
            Adding is offered only on a client's own page. On the agency-wide
            dashboard `clientId` is undefined and a new to-do would have no
            workspace to belong to.
          */}
          {canAdd && (
            adding ? (
              <form
                className='mt-3 flex flex-wrap gap-2 rounded-md border-[1.5px] border-dashed border-bd-rule p-2'
                onSubmit={(e) => {
                  e.preventDefault()
                  const title = draft.title.trim()
                  if (title) addTask.mutate({ title, dueDate: draft.dueDate || null })
                }}
              >
                <Input
                  autoFocus
                  aria-label='What needs doing'
                  placeholder='What needs doing?'
                  className='h-8 min-w-40 flex-[2]'
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
                <Input
                  type='date'
                  aria-label='Deadline'
                  className='h-8 w-36'
                  value={draft.dueDate}
                  onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                />
                <Button size='sm' disabled={!draft.title.trim() || addTask.isPending}>
                  {addTask.isPending && <Loader2 className='animate-spin' />}
                  Add
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <Button
                size='sm'
                variant='outline'
                className='mt-3 h-7 px-2 text-xs'
                onClick={() => setAdding(true)}
              >
                <Plus className='size-3' />
                Add a to-do
              </Button>
            )
          )}

          <p className='mt-3 text-xs text-muted-foreground'>
            {isClient
              ? 'Open a post to approve it or ask for changes, or reply on a to-do.'
              : steps.length === 0
                ? 'Nothing is waiting. Add what happens next and it appears here and on your dashboard.'
                : 'Open a post to decide on it, or tick, edit and reply to a to-do here.'}
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
  /** Only on a to-do. Lets the Reply button say there is something to read. */
  replies?: number
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
  onEdit,
}: {
  step: NextStep
  isClient: boolean
  showClient: boolean
  onOpen?: () => void
  /** Only on a to-do, and only for staff — clients do not own these. */
  onDone?: () => void
  ticking?: boolean
  /** Only on a to-do, and only for staff. Absent turns editing off. */
  onEdit?: (patch: { title?: string; dueDate?: string | null }) => void
}) {
  const [editing, setEditing] = useState(false)
  const [replying, setReplying] = useState(false)
  const [form, setForm] = useState({ title: step.title, due: step.due ?? '' })
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

  if (editing && onEdit) {
    return (
      <form
        className='flex w-full flex-wrap items-center gap-2 py-2'
        onSubmit={(e) => {
          e.preventDefault()
          const title = form.title.trim()
          if (!title) return
          onEdit({ title, dueDate: form.due || null })
          setEditing(false)
        }}
      >
        <Input
          autoFocus
          aria-label={`Rename ${step.title}`}
          className='h-8 min-w-40 flex-[2]'
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <Input
          type='date'
          aria-label={`Deadline for ${step.title}`}
          className='h-8 w-36'
          value={form.due}
          onChange={(e) => setForm({ ...form, due: e.target.value })}
        />
        <Button size='sm' disabled={!form.title.trim()}>
          Save
        </Button>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          onClick={() => {
            // Back to what is stored, not to what was half-typed.
            setForm({ title: step.title, due: step.due ?? '' })
            setEditing(false)
          }}
        >
          Cancel
        </Button>
      </form>
    )
  }

  const editButton = onEdit ? (
    <button
      type='button'
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      aria-label={`Edit "${step.title}"`}
      className='flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-bd-sand hover:text-bd-ink'
    >
      <Pencil className='size-3' />
    </button>
  ) : null

  /*
   * Reply, on a to-do, for BOTH audiences.
   *
   * Sofia asked for this twice. A review step already had somewhere to talk —
   * opening the post gives you its comment thread — so the gap was entirely on
   * the to-do rows, which is where "swap the Nyall photo for the CIC logo"
   * lives. The client can write here too; a thread only the agency can post in
   * is a notice board, and there is already one of those on the homepage.
   *
   * The count is on the button before anything is fetched, which is what makes
   * it worth pressing: "Reply" alone gives nobody a reason to look, and a
   * thread nobody looks at is a thread nobody answers.
   */
  const replyButton = step.kind === 'task' ? (
    <button
      type='button'
      onClick={(e) => {
        e.stopPropagation()
        setReplying((open) => !open)
      }}
      aria-expanded={replying}
      aria-label={
        step.replies
          ? `${replying ? 'Hide' : 'Show'} ${step.replies} ${step.replies === 1 ? 'reply' : 'replies'} on "${step.title}"`
          : `Reply to "${step.title}"`
      }
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full border-[1.5px] px-2 py-0.5',
        'text-[0.625rem] font-bold whitespace-nowrap transition-colors',
        step.replies
          ? 'border-bd-ink bg-bd-yellow text-bd-ink hover:brightness-95'
          : 'border-bd-rule text-muted-foreground hover:border-bd-ink hover:text-bd-ink'
      )}
    >
      <MessageSquare className='size-3' />
      {step.replies ? step.replies : 'Reply'}
    </button>
  ) : null

  return (
    <>
      {onOpen ? (
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
          {replyButton}
          {editButton}
          {doneButton}
        </div>
      )}

      {replying && step.kind === 'task' && (
        <TaskThread
          taskId={step.id}
          taskTitle={step.title}
          canModerate={!isClient}
        />
      )}
    </>
  )
}
