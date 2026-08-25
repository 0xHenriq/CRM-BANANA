import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  formatMoney,
  formatPence,
  paymentState,
  sumPence,
  DEAL_STAGES,
  type ClientSummary,
  type DealStage,
  type DealWithClient,
  type PaymentState,
  type PaymentStatus,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { STAGE_LABEL } from '../clients/status-pill'

/**
 * Follow the cursor, not the card's rectangle.
 *
 * dnd-kit's default (rectIntersection) requires the dragged card's rect to
 * overlap a column's rect. On a board that fails quietly: drag a card so the
 * cursor is clearly over "Proposal" but the card still mostly overlaps its
 * origin column, release, and nothing happens — no error, no movement, just a
 * gesture that did not take. Observed here: a drop reported over='negotiation'
 * (the source column) with a single collision.
 *
 * pointerWithin resolves to whatever is under the cursor, which is what the
 * gesture means. closestCorners is the fallback for keyboard dragging, where
 * there is no pointer at all.
 */
const collisionDetection: CollisionDetection = (args) => {
  const underPointer = pointerWithin(args)
  return underPointer.length > 0 ? underPointer : closestCorners(args)
}

// Shared with the API contract rather than re-declared, so the board and the
// server cannot drift apart.
const STAGES: readonly DealStage[] = DEAL_STAGES

export function Pipeline() {
  const queryClient = useQueryClient()
  const [dragging, setDragging] = useState<DealWithClient | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['deals'],
    queryFn: () => api.get<{ deals: DealWithClient[] }>('/deals'),
  })

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: DealStage }) =>
      api.patch(`/deals/${id}`, { stage }),
    /**
     * Optimistic: the card must land where it was dropped immediately, or the
     * board feels broken. On failure the snapshot is restored, so a rejected
     * move visibly snaps back rather than lying about having succeeded.
     */
    onMutate: async ({ id, stage }) => {
      await queryClient.cancelQueries({ queryKey: ['deals'] })
      const previous = queryClient.getQueryData<{ deals: DealWithClient[] }>([
        'deals',
      ])
      queryClient.setQueryData<{ deals: DealWithClient[] }>(['deals'], (old) =>
        old
          ? {
              deals: old.deals.map((d) => (d.id === id ? { ...d, stage } : d)),
            }
          : old
      )
      return { previous }
    },
    onError: (err: Error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['deals'], context.previous)
      toast.error(err.message)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['deals'] })
      // A stage change writes the client's timeline, and the clients list
      // shows per-client counts. Note ['client'] does not match ['clients'] —
      // prefix matching is element-wise, so both keys are needed.
      queryClient.invalidateQueries({ queryKey: ['client'] })
      queryClient.invalidateQueries({ queryKey: ['clients'] })
    },
  })

  /**
   * Marking a deal paid or awaiting.
   *
   * Same endpoint as a stage change, so it inherits the timeline entry and the
   * client-list invalidation. Not optimistic: unlike a drag, there is no
   * gesture whose result has to appear instantly, and money is the one thing
   * worth showing only once the server has agreed.
   */
  const setPayment = useMutation({
    mutationFn: ({
      id,
      paymentStatus,
    }: {
      id: string
      paymentStatus: PaymentStatus
    }) => api.patch(`/deals/${id}`, { paymentStatus }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deals'] })
      queryClient.invalidateQueries({ queryKey: ['client'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const sensors = useSensors(
    // A small activation distance keeps a click on the card from being read as
    // a drag — otherwise every attempt to select text starts one.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  )

  const byStage = useMemo(() => {
    const map = new Map<DealStage, DealWithClient[]>(
      STAGES.map((s) => [s, [] as DealWithClient[]])
    )
    for (const deal of data?.deals ?? []) map.get(deal.stage)?.push(deal)
    return map
  }, [data])

  function onDragStart(event: DragStartEvent) {
    setDragging(
      (data?.deals ?? []).find((d) => d.id === event.active.id) ?? null
    )
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null)
    const stage = event.over?.id as DealStage | undefined
    const id = event.active.id as string
    if (!stage) return
    const deal = (data?.deals ?? []).find((d) => d.id === id)
    if (!deal || deal.stage === stage) return
    move.mutate({ id, stage })
  }

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main fixed>
        <PageHead
          eyebrow='New business'
          title='Pipeline'
          stamp={{ top: 'DEAL', big: '£', bottom: 'FLOW' }}
          actions={<NewDealDialog />}
        />

        {isLoading ? (
          <div className='flex gap-4'>
            {STAGES.map((s) => (
              <Skeleton key={s} className='h-72 w-64 shrink-0 rounded-lg' />
            ))}
          </div>
        ) : isError ? (
          // An empty board and a failed request look identical otherwise.
          <QueryError
            title='Could not load the pipeline'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          >
            <div className='flex gap-4 overflow-x-auto pb-4'>
              {STAGES.map((stage) => (
                <StageColumn
                  key={stage}
                  stage={stage}
                  deals={byStage.get(stage) ?? []}
                  onMove={(id, next) => move.mutate({ id, stage: next })}
                  onPayment={(id, paymentStatus) =>
                    setPayment.mutate({ id, paymentStatus })
                  }
                />
              ))}
            </div>

            <DragOverlay>
              {dragging ? <DealCard deal={dragging} overlay /> : null}
            </DragOverlay>
          </DndContext>
        )}
      </Main>
    </>
  )
}

function StageColumn({
  stage,
  deals,
  onMove,
  onPayment,
}: {
  stage: DealStage
  deals: DealWithClient[]
  onMove: (id: string, stage: DealStage) => void
  onPayment: (id: string, paymentStatus: PaymentStatus) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage })

  // Summed in integer pence. Adding these as floats drifted:
  // 1800.10 + 2400.20 + 99.30 came out as 4299.599999999999.
  const totalPence = sumPence(deals.map((d) => d.value))

  return (
    <section
      ref={setNodeRef}
      className={cn(
        'flex w-64 shrink-0 flex-col rounded-lg border-2 border-bd-ink bg-card/60 p-3 transition-colors',
        isOver && 'bg-bd-sand'
      )}
      aria-label={STAGE_LABEL[stage]}
    >
      <header className='crate-rule mb-3 flex items-baseline justify-between pb-2'>
        <h2 className='display text-base'>{STAGE_LABEL[stage]}</h2>
        <span className='text-xs text-muted-foreground'>
          {deals.length}
          {totalPence > 0 && ` · ${formatPence(totalPence)}`}
        </span>
      </header>

      <div className='flex flex-1 flex-col gap-2'>
        {deals.map((deal) => (
          <DealCard
            key={deal.id}
            deal={deal}
            onMove={onMove}
            onPayment={onPayment}
          />
        ))}
        {deals.length === 0 && (
          <p className='py-6 text-center text-xs text-muted-foreground'>
            Drop a deal here
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * The payment box.
 *
 * Bright and filled rather than a pastel outline — she asked for something her
 * "tired self can see", and the money state is the one thing on this board she
 * scans for. `overdue` is derived from the due date rather than stored, so it
 * turns red on its own the morning it becomes true.
 */
const PAY_TONE: Record<Exclude<PaymentState, 'none'>, string> = {
  paid: 'bg-pay-paid text-white',
  awaiting: 'bg-pay-awaiting text-bd-ink',
  overdue: 'bg-pay-overdue text-white',
}

function PaymentBadge({ deal }: { deal: DealWithClient }) {
  const state = paymentState(deal)
  if (state === 'none') return null

  const label =
    state === 'paid'
      ? 'Paid'
      : state === 'overdue'
        ? `Overdue${deal.paymentDue ? ` · ${deal.paymentDue}` : ''}`
        : `Awaiting${deal.paymentDue ? ` · due ${deal.paymentDue}` : ''}`

  return (
    <span
      className={cn(
        'inline-flex items-center rounded border-[1.5px] border-bd-ink px-1.5 py-0.5',
        'text-[0.625rem] font-bold whitespace-nowrap',
        PAY_TONE[state]
      )}
    >
      {label}
    </span>
  )
}

function DealCard({
  deal,
  overlay = false,
  onMove,
  onPayment,
}: {
  deal: DealWithClient
  overlay?: boolean
  onMove?: (id: string, stage: DealStage) => void
  onPayment?: (id: string, paymentStatus: PaymentStatus) => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: deal.id, disabled: overlay })

  return (
    <Card
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'crate-card cursor-grab gap-0 py-3 active:cursor-grabbing',
        isDragging && 'opacity-40',
        overlay && 'rotate-2 shadow-lg'
      )}
      {...listeners}
      {...attributes}
    >
      <CardContent className='px-3'>
        <div className='flex items-start justify-between gap-1'>
          <div className='min-w-0'>
            <p className='truncate text-sm font-semibold'>{deal.title}</p>
            <p className='truncate text-xs text-muted-foreground'>
              {deal.clientName}
            </p>
          </div>
          {/*
            Dragging is not the only way to move a card, and should not be.
            It is unavailable on touch without a long press, awkward with a
            keyboard, and impossible with a screen reader in practice. This
            menu is the accessible path to the same mutation — and it is what
            makes the behaviour testable without synthesising pointer events.

            stopPropagation keeps opening the menu from starting a drag.
          */}
          {!overlay && onMove && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size='icon'
                  variant='ghost'
                  className='-me-1 size-6 shrink-0'
                  aria-label={`Move ${deal.title} to another stage`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className='size-3.5' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                <DropdownMenuLabel>Move to</DropdownMenuLabel>
                {STAGES.filter((s) => s !== deal.stage).map((s) => (
                  <DropdownMenuItem key={s} onSelect={() => onMove(deal.id, s)}>
                    {STAGE_LABEL[s]}
                  </DropdownMenuItem>
                ))}
                {onPayment && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Payment</DropdownMenuLabel>
                    {deal.paymentStatus !== 'paid' && (
                      <DropdownMenuItem
                        onSelect={() => onPayment(deal.id, 'paid')}
                      >
                        Mark paid
                      </DropdownMenuItem>
                    )}
                    {deal.paymentStatus !== 'awaiting' && (
                      <DropdownMenuItem
                        onSelect={() => onPayment(deal.id, 'awaiting')}
                      >
                        Awaiting payment
                      </DropdownMenuItem>
                    )}
                    {deal.paymentStatus !== 'none' && (
                      <DropdownMenuItem
                        onSelect={() => onPayment(deal.id, 'none')}
                      >
                        Clear payment status
                      </DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className='mt-2 flex items-baseline justify-between gap-2'>
          <span className='display text-base'>
            {formatMoney(deal.value, deal.currency)}
          </span>
          {deal.expectedClose && (
            <span className='text-[0.625rem] text-muted-foreground'>
              {deal.expectedClose}
            </span>
          )}
        </div>
        <div className='mt-1.5 empty:mt-0'>
          <PaymentBadge deal={deal} />
        </div>
      </CardContent>
    </Card>
  )
}

function NewDealDialog() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    clientId: '',
    title: '',
    value: '',
    stage: 'lead' as DealStage,
    expectedClose: '',
  })

  const { data: clientsData } = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: ClientSummary[] }>('/clients'),
    enabled: open,
  })

  const create = useMutation({
    mutationFn: () =>
      api.post('/deals', {
        clientId: form.clientId,
        title: form.title.trim(),
        value: form.value.trim() || null,
        stage: form.stage,
        expectedClose: form.expectedClose || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['deals'] })
      setOpen(false)
      setForm({
        clientId: '',
        title: '',
        value: '',
        stage: 'lead',
        expectedClose: '',
      })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          New deal
        </Button>
      </DialogTrigger>
      <DialogContent className='crate-card sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='display text-xl'>New deal</DialogTitle>
        </DialogHeader>

        <div className='grid gap-3'>
          <div className='grid gap-1.5'>
            <Label htmlFor='deal-client'>Client</Label>
            <Select
              value={form.clientId}
              onValueChange={(v) => setForm({ ...form, clientId: v })}
            >
              <SelectTrigger id='deal-client'>
                <SelectValue placeholder='Choose a client' />
              </SelectTrigger>
              <SelectContent>
                {(clientsData?.clients ?? []).map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='grid gap-1.5'>
            <Label htmlFor='deal-title'>Title</Label>
            <Input
              id='deal-title'
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder='Q4 social retainer'
            />
          </div>

          <div className='grid grid-cols-2 gap-3'>
            <div className='grid gap-1.5'>
              <Label htmlFor='deal-value'>Value (GBP)</Label>
              <Input
                id='deal-value'
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                placeholder='2400.00'
                inputMode='decimal'
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='deal-close'>Expected close</Label>
              <Input
                id='deal-close'
                type='date'
                value={form.expectedClose}
                onChange={(e) =>
                  setForm({ ...form, expectedClose: e.target.value })
                }
              />
            </div>
          </div>

          <div className='grid gap-1.5'>
            <Label htmlFor='deal-stage'>Stage</Label>
            <Select
              value={form.stage}
              onValueChange={(v) => setForm({ ...form, stage: v as DealStage })}
            >
              <SelectTrigger id='deal-stage'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STAGE_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={!form.clientId || !form.title.trim() || create.isPending}
          >
            Create deal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
