import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  CONTENT_TYPES,
  type ContentItem,
  type ContentType,
} from '@/lib/api'
import { useWorkspace, withClient } from '@/features/portal/use-workspace'
import { WorkspaceSwitcher } from '@/features/portal/workspace-switcher'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { ContentDetailDialog } from './detail-dialog'
import { TYPE_LABEL, TYPE_TONE } from './vocabulary'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** Monday-first, as her prototype had it. */
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Local YYYY-MM-DD.
 *
 * Deliberately NOT toISOString().slice(0,10) — that converts to UTC first, so
 * anywhere east of Greenwich a date picked late in the evening lands on the
 * previous day. The column is a plain `date` with no timezone; it should mean
 * the day she clicked.
 */
function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function ContentCalendar() {
  const { isStaff, clientId, setClientId, workspaces, isReady } = useWorkspace()
  const today = new Date()

  const [cursor, setCursor] = useState({
    year: today.getFullYear(),
    month: today.getMonth(),
  })
  const [openId, setOpenId] = useState<string | null>(null)
  const [addingOn, setAddingOn] = useState<string | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['content', clientId ?? 'default'],
    queryFn: () =>
      api.get<{ clientId: string; items: ContentItem[] }>(
        withClient('/content', clientId)
      ),
    enabled: isReady,
  })

  /** Scheduled rows only — an undated row is an idea, and lives in the bank. */
  const byDate = useMemo(() => {
    const map = new Map<string, ContentItem[]>()
    for (const item of data?.items ?? []) {
      if (!item.scheduledAt) continue
      const list = map.get(item.scheduledAt) ?? []
      list.push(item)
      map.set(item.scheduledAt, list)
    }
    return map
  }, [data])

  const monthItems = useMemo(() => {
    const prefix = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`
    return (data?.items ?? [])
      .filter((i) => i.scheduledAt?.startsWith(prefix))
      .sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''))
  }, [data, cursor])

  const grid = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1)
    const offset = (first.getDay() + 6) % 7 // Monday = 0
    const days = new Date(cursor.year, cursor.month + 1, 0).getDate()
    const cells: (number | null)[] = Array(offset).fill(null)
    for (let d = 1; d <= days; d++) cells.push(d)
    return cells
  }, [cursor])

  function shiftMonth(delta: number) {
    setCursor((c) => {
      const m = c.month + delta
      if (m < 0) return { year: c.year - 1, month: 11 }
      if (m > 11) return { year: c.year + 1, month: 0 }
      return { ...c, month: m }
    })
  }

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          {isStaff && (
            <WorkspaceSwitcher
              clientId={clientId}
              workspaces={workspaces}
              onChange={setClientId}
            />
          )}
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main>
        <PageHead
          eyebrow='Content planning'
          title='Content Calendar'
          stamp={{ top: 'SCHED', big: '✎', bottom: 'ULE' }}
        />

        {isLoading ? (
          <Skeleton className='h-[32rem]' />
        ) : isError ? (
          <QueryError
            title='Could not load the calendar'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : (
          <Card className='crate-card'>
            <CardContent>
              <div className='mb-4 flex items-center justify-between'>
                <h2 className='display text-2xl'>
                  {MONTHS[cursor.month]} {cursor.year}
                </h2>
                <div className='flex gap-2'>
                  <Button size='sm' variant='outline' onClick={() => shiftMonth(-1)}>
                    <ChevronLeft /> Prev
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() =>
                      setCursor({
                        year: today.getFullYear(),
                        month: today.getMonth(),
                      })
                    }
                  >
                    Today
                  </Button>
                  <Button size='sm' variant='outline' onClick={() => shiftMonth(1)}>
                    Next <ChevronRight />
                  </Button>
                </div>
              </div>

              {/* Phones get a list, not a 7-column grid: at 390px each cell
                  is ~45px and every post title truncates to nothing. The
                  client is the likeliest phone user, so this is their view. */}
              <ol className='space-y-2 sm:hidden'>
                {monthItems.length === 0 ? (
                  <li className='py-6 text-center text-sm text-muted-foreground'>
                    Nothing scheduled this month.
                  </li>
                ) : (
                  monthItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type='button'
                        onClick={() => setOpenId(item.id)}
                        className='flex w-full items-center gap-3 rounded-md border-[1.5px] border-bd-rule p-2 text-start'
                      >
                        <span
                          className={cn(
                            'flex size-9 shrink-0 flex-col items-center justify-center rounded border border-bd-ink text-[0.625rem] font-bold',
                            TYPE_TONE[item.type]
                          )}
                        >
                          {item.scheduledAt?.slice(8)}
                        </span>
                        <span className='min-w-0 flex-1'>
                          <span className='block truncate text-sm font-semibold'>
                            {item.title}
                          </span>
                          <span className='block text-xs text-muted-foreground'>
                            {TYPE_LABEL[item.type]}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ol>

              <div className='hidden grid-cols-7 gap-1.5 sm:grid'>
                {DOW.map((d) => (
                  <div
                    key={d}
                    className='pb-1 text-center text-[0.625rem] font-bold tracking-[0.1em] text-muted-foreground uppercase'
                  >
                    {d}
                  </div>
                ))}

                {grid.map((day, i) => {
                  if (day === null)
                    return <div key={`pad-${i}`} aria-hidden />

                  const date = isoDate(cursor.year, cursor.month, day)
                  const items = byDate.get(date) ?? []
                  const isToday =
                    date === isoDate(today.getFullYear(), today.getMonth(), today.getDate())

                  return (
                    <div
                      key={date}
                      // `group` is what makes the add affordance appear on
                      // hover — without it the button sat at opacity-0
                      // permanently and could only be reached by tabbing.
                      // Clicking the cell itself also adds, which is both what
                      // the hint below promises and what her prototype did.
                      className={cn(
                        'group min-h-24 rounded-md border-[1.5px] border-bd-rule bg-card p-1.5',
                        isToday && 'border-bd-ink border-2',
                        isStaff && 'cursor-pointer hover:bg-bd-cream'
                      )}
                      onClick={isStaff ? () => setAddingOn(date) : undefined}
                    >
                      <div className='mb-1 flex items-center justify-between'>
                        <span className='text-[0.6875rem] font-extrabold text-muted-foreground'>
                          {day}
                        </span>
                        {isStaff && (
                          <button
                            type='button'
                            onClick={(e) => {
                              e.stopPropagation()
                              setAddingOn(date)
                            }}
                            className='rounded p-0.5 text-muted-foreground opacity-0 hover:bg-bd-sand focus:opacity-100 group-hover:opacity-100'
                            aria-label={`Add a post on ${date}`}
                          >
                            <Plus className='size-3' />
                          </button>
                        )}
                      </div>

                      <ul className='space-y-1'>
                        {items.map((item) => (
                          <li key={item.id}>
                            <button
                              type='button'
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpenId(item.id)
                              }}
                              className={cn(
                                'block w-full truncate rounded border border-bd-ink px-1 py-0.5 text-start',
                                'text-[0.625rem] font-bold text-bd-ink hover:opacity-80',
                                TYPE_TONE[item.type]
                              )}
                              title={`${TYPE_LABEL[item.type]}: ${item.title}`}
                            >
                              {item.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>

              <p className='mt-3 text-xs text-muted-foreground italic'>
                {isStaff
                  ? 'Click a day to schedule a post, or a post to open it. Every post here is the same record as its entry in the Ideas Bank.'
                  : 'Click a post to review it and leave a comment.'}
              </p>
            </CardContent>
          </Card>
        )}
      </Main>

      <ContentDetailDialog itemId={openId} onClose={() => setOpenId(null)} />
      <SchedulePostDialog
        date={addingOn}
        onClose={() => setAddingOn(null)}
        existing={data?.items ?? []}
        clientId={clientId}
      />
    </>
  )
}

/**
 * Scheduling a post on a day.
 *
 * The type is CHOSEN. In her prototype the type was assigned positionally —
 * `types[entries.length % types.length]` — so to get a Story you added filler
 * tags until the cycle happened to reach one.
 *
 * It can also schedule an EXISTING idea, which is the whole point of the
 * merge: the backlog and the calendar are one list.
 */
function SchedulePostDialog({
  date,
  onClose,
  existing,
  clientId,
}: {
  date: string | null
  onClose: () => void
  existing: ContentItem[]
  clientId: string | null
}) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [title, setTitle] = useState('')
  const [type, setType] = useState<ContentType>('reel')
  const [pickedId, setPickedId] = useState('')

  const unscheduled = existing.filter((i) => !i.scheduledAt)

  const reset = () => {
    setTitle('')
    setType('reel')
    setPickedId('')
    setMode('new')
  }

  const create = useMutation({
    mutationFn: () =>
      api.post(withClient('/content', clientId), {
        title: title.trim(),
        type,
        scheduledAt: date,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['content'] })
      reset()
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const schedule = useMutation({
    mutationFn: () => api.patch(`/content/${pickedId}`, { scheduledAt: date }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['content'] })
      reset()
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Dialog open={!!date} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='crate-card sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='display text-xl'>
            Schedule for {date}
          </DialogTitle>
        </DialogHeader>

        <div className='flex gap-2'>
          <Button
            size='sm'
            variant={mode === 'new' ? 'default' : 'outline'}
            onClick={() => setMode('new')}
          >
            New post
          </Button>
          <Button
            size='sm'
            variant={mode === 'existing' ? 'default' : 'outline'}
            onClick={() => setMode('existing')}
            disabled={unscheduled.length === 0}
          >
            From the Ideas Bank ({unscheduled.length})
          </Button>
        </div>

        {mode === 'new' ? (
          <div className='grid gap-3'>
            <div className='grid gap-1.5'>
              <Label htmlFor='cal-title'>Post name</Label>
              <Input
                id='cal-title'
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder='Founder story, part 2'
                autoFocus
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='cal-type'>Content type</Label>
              <Select value={type} onValueChange={(v) => setType(v as ContentType)}>
                <SelectTrigger id='cal-type'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className='grid gap-1.5'>
            <Label htmlFor='cal-existing'>Unscheduled concept</Label>
            <Select value={pickedId} onValueChange={setPickedId}>
              <SelectTrigger id='cal-existing'>
                <SelectValue placeholder='Choose from the backlog' />
              </SelectTrigger>
              <SelectContent>
                {unscheduled.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.title} · {TYPE_LABEL[i.type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-xs text-muted-foreground'>
              This moves the existing record onto the calendar. Nothing is
              duplicated.
            </p>
          </div>
        )}

        <DialogFooter>
          {mode === 'new' ? (
            <Button
              onClick={() => create.mutate()}
              disabled={!title.trim() || create.isPending}
            >
              Schedule post
            </Button>
          ) : (
            <Button
              onClick={() => schedule.mutate()}
              disabled={!pickedId || schedule.isPending}
            >
              Put it on this day
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
