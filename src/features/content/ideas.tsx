import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpDown, Loader2, Plus, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  CONTENT_STATUSES,
  CONTENT_TYPES,
  type ContentItem,
  type ContentStatus,
  type ContentType,
} from '@/lib/api'
import { useWorkspace, withClient } from '@/features/portal/use-workspace'
import { WorkspaceSwitcher } from '@/features/portal/workspace-switcher'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { ContentDetailDialog } from './detail-dialog'
import { PostGrid } from './post-grid'
import { ApprovalOverduePill, StatusPill, TypePill } from './pills'
import { STATUS_LABEL, TYPE_LABEL } from './vocabulary'

type SortKey = 'title' | 'type' | 'scheduledAt' | 'status'

/** One frozen empty set, so a stale selection is a stable reference. */
const EMPTY_IDS: ReadonlySet<string> = new Set()

export function IdeasBank() {
  const { isStaff, clientId, setClientId, workspaces, isReady } = useWorkspace()
  const queryClient = useQueryClient()

  const [openId, setOpenId] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<ContentType | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<ContentStatus | 'all'>('all')
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({
    key: 'scheduledAt',
    asc: true,
  })
  /**
   * A selection belongs to the workspace it was made in — DERIVED, not synced.
   *
   * Ticking four of Change of Perspective's concepts and then switching to
   * Verdant Botanicals must not leave four ids selected that are not on
   * screen: "Send 4 to client" would then push one client's work into
   * another's portal. That is Failure Mode 6 with a different noun.
   *
   * The workspace is stored WITH the selection and a stale one reads as empty,
   * rather than an effect that clears it after the fact. Same reasoning as
   * use-workspace.ts: deriving avoids a set-state-in-effect round trip and the
   * render flash where the old count is briefly still on screen — and the lint
   * rule that forbids setState in an effect is enforcing exactly this.
   */
  const [selection, setSelection] = useState<{
    clientId: string | null
    ids: Set<string>
  }>({ clientId, ids: new Set() })

  const selected = selection.clientId === clientId ? selection.ids : EMPTY_IDS

  const setSelected = (ids: Set<string>) => setSelection({ clientId, ids })

  const { data, isLoading, isError, error, refetch } = useQuery({
    // The workspace is part of the key: without it, switching clients showed
    // the previous client's cached rows.
    queryKey: ['content', clientId ?? 'default'],
    queryFn: () =>
      api.get<{ clientId: string; items: ContentItem[] }>(
        withClient('/content', clientId)
      ),
    enabled: isReady,
  })

  /**
   * Send a batch for approval.
   *
   * The unit of work is a MONTH, not a post: she builds out the plan, then
   * asks the client to look at the lot. Doing that one row at a time meant
   * opening a dialog, finding "Ready for review" in a six-item dropdown and
   * closing it again, nine times — and the dropdown is not obviously the thing
   * that shares a post with the client at all.
   *
   * `allSettled`, not `all`. One refusal out of nine must not report the other
   * eight as failed, and it must not report them as succeeded either: the
   * toast says exactly how many went and names the shortfall. There is no
   * bulk endpoint behind this — it is the same PATCH the dialog uses, so the
   * two cannot disagree about what sending means, and `shouldShare` on the
   * server is what actually opens each post to the client.
   */
  const sendBatch = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.patch(`/content/${id}`, { status: 'ready_for_review' }))
      )
      return {
        sent: results.filter((r) => r.status === 'fulfilled').length,
        failed: results.filter((r) => r.status === 'rejected').length,
      }
    },
    onSuccess: async ({ sent, failed }) => {
      // Every key a status change touches — the same list the detail dialog
      // invalidates, because this performs the same change.
      await queryClient.invalidateQueries({ queryKey: ['content'] })
      await queryClient.invalidateQueries({ queryKey: ['next-steps'] })
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
      await queryClient.invalidateQueries({ queryKey: ['client'] })
      await queryClient.invalidateQueries({ queryKey: ['feed'] })
      setSelected(new Set())
      if (failed) {
        toast.error(
          `Sent ${sent}. ${failed} could not be sent — reopen those and check them.`
        )
      } else {
        toast.success(
          `Sent ${sent} ${sent === 1 ? 'post' : 'posts'} to the client for approval.`
        )
      }
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const rows = useMemo(() => {
    let list = data?.items ?? []
    if (typeFilter !== 'all') list = list.filter((i) => i.type === typeFilter)
    if (statusFilter !== 'all')
      list = list.filter((i) => i.status === statusFilter)

    // The prototype defined a .type-pill class and a "sortable table" and
    // shipped neither. This is that table.
    return [...list].sort((a, b) => {
      const dir = sort.asc ? 1 : -1
      if (sort.key === 'scheduledAt') {
        // Undated ideas sort last regardless of direction — they are the
        // backlog, not the schedule.
        if (!a.scheduledAt && !b.scheduledAt) return 0
        if (!a.scheduledAt) return 1
        if (!b.scheduledAt) return -1
        return a.scheduledAt.localeCompare(b.scheduledAt) * dir
      }
      if (sort.key === 'status') {
        // Alphabetical status ordering is meaningless for a workflow —
        // "approved, idea, in_progress, published, ready_for_review,
        // scheduled" tells her nothing. Sort by pipeline position instead.
        return (
          (CONTENT_STATUSES.indexOf(a.status) -
            CONTENT_STATUSES.indexOf(b.status)) *
          dir
        )
      }
      return String(a[sort.key]).localeCompare(String(b[sort.key])) * dir
    })
  }, [data, typeFilter, statusFilter, sort])

  /**
   * Which of the rows on screen can be sent.
   *
   * Only a concept that has NOT been shared yet: `idea` and `in_progress`.
   * Everything else is either with the client already or has had its answer,
   * and re-sending it would move a decided post back into their queue.
   *
   * Rows that cannot be sent get no checkbox at all rather than a disabled
   * one. A selection that silently drops half of itself when you press the
   * button is worse than a column with gaps in it — the gap is the
   * explanation.
   */
  const sendable = useMemo(
    () =>
      rows.filter((i) => i.status === 'idea' || i.status === 'in_progress'),
    [rows]
  )
  const selectedSendable = sendable.filter((i) => selected.has(i.id))
  const allSendableSelected =
    sendable.length > 0 && selectedSendable.length === sendable.length

  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: true }))
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
          eyebrow='Concept backlog'
          title='Ideas Bank'
          stamp={{ top: 'IDEA', big: '★', bottom: 'BANK' }}
          actions={isStaff ? <NewIdeaDialog clientId={clientId} /> : undefined}
        />

        {/*
          The pictures first, then the table.

          Sofia: "ideas bank should look like feedpreview with little square
          previews, but only the pending approval ones or declined one. with a
          red or orange button". A social post IS an image, and a table of
          titles is the one view of it that cannot tell you whether it is any
          good — so the posts somebody is waiting on get shown as posts.

          ABOVE the table rather than instead of it. The table is how she
          finds, sorts and filters two hundred concepts; the grid is how she
          sees the four that need an answer today. Replacing one with the other
          would have traded a working screen for a nicer-looking one.

          Rendered once the workspace is settled. For STAFF that means waiting
          for `clientId`: without it the request falls back to the first open
          workspace alphabetically, which is the exact defect use-workspace.ts
          exists to prevent. A CLIENT has no clientId by design and never needs
          one — the server resolves their workspace from their grant — so
          gating on it would have hidden this grid from the one audience Sofia
          asked for it for.
        */}
        {(!isStaff || clientId) && (
          <PostGrid clientId={clientId} mode='decisions' className='mb-5' />
        )}

        <div className='mb-4 flex flex-wrap gap-2'>
          <Select
            value={typeFilter}
            onValueChange={(v) => setTypeFilter(v as ContentType | 'all')}
          >
            <SelectTrigger className='h-8 w-40' aria-label='Filter by type'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All types</SelectItem>
              {CONTENT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as ContentStatus | 'all')}
          >
            <SelectTrigger className='h-8 w-44' aria-label='Filter by status'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All statuses</SelectItem>
              {CONTENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(typeFilter !== 'all' || statusFilter !== 'all') && (
            <Button
              size='sm'
              variant='ghost'
              onClick={() => {
                setTypeFilter('all')
                setStatusFilter('all')
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {/*
          The batch bar, and it only exists once something is ticked.

          Persistent bulk toolbars take a strip of the screen away from the
          table for the ninety per cent of visits that are not a batch send.
          This appears when there is a batch and says what will happen to how
          many, so the button is never a guess.
        */}
        {isStaff && selectedSendable.length > 0 && (
          <div className='mb-4 flex flex-wrap items-center gap-3 rounded-md border-[1.5px] border-bd-ink bg-bd-yellow px-3 py-2'>
            <span className='text-sm font-bold'>
              {selectedSendable.length} selected
            </span>
            <Button
              size='sm'
              onClick={() =>
                sendBatch.mutate(selectedSendable.map((i) => i.id))
              }
              disabled={sendBatch.isPending}
            >
              {sendBatch.isPending ? (
                <Loader2 className='animate-spin' />
              ) : (
                <Send className='size-3.5' />
              )}
              Send {selectedSendable.length} to client
            </Button>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => setSelected(new Set())}
              disabled={sendBatch.isPending}
            >
              Clear
            </Button>
            <span className='text-xs'>
              They appear in the client&rsquo;s portal to approve or ask for
              changes.
            </span>
          </div>
        )}

        {isLoading ? (
          <Skeleton className='h-64' />
        ) : isError ? (
          <QueryError
            title='Could not load the ideas bank'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : rows.length === 0 ? (
          <Card className='crate-card'>
            <CardContent className='py-10 text-center text-sm text-muted-foreground'>
              {(data?.items.length ?? 0) === 0
                ? 'No concepts yet.'
                : 'Nothing matches those filters.'}
            </CardContent>
          </Card>
        ) : (
          <Card className='crate-card overflow-hidden p-0'>
            <div className='overflow-x-auto'>
              <Table>
                <TableHeader>
                  <TableRow>
                    {isStaff && (
                      <TableHead className='w-10'>
                        {sendable.length > 0 && (
                          <Checkbox
                            checked={allSendableSelected}
                            aria-label={
                              allSendableSelected
                                ? 'Clear the selection'
                                : `Select all ${sendable.length} concepts that can be sent`
                            }
                            onCheckedChange={(v) =>
                              setSelected(
                                v === true
                                  ? new Set(sendable.map((i) => i.id))
                                  : new Set()
                              )
                            }
                          />
                        )}
                      </TableHead>
                    )}
                    <SortableHead
                      label='Name'
                      onClick={() => toggleSort('title')}
                      active={sort.key === 'title'}
                    />
                    <SortableHead
                      label='Content type'
                      onClick={() => toggleSort('type')}
                      active={sort.key === 'type'}
                    />
                    <SortableHead
                      label='Date'
                      onClick={() => toggleSort('scheduledAt')}
                      active={sort.key === 'scheduledAt'}
                    />
                    <SortableHead
                      label='Status'
                      onClick={() => toggleSort('status')}
                      active={sort.key === 'status'}
                    />
                    {isStaff && <TableHead className='w-10' />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((item) => (
                    <IdeaRow
                      key={item.id}
                      item={item}
                      isStaff={isStaff}
                      selected={selected.has(item.id)}
                      onSelect={
                        item.status === 'idea' || item.status === 'in_progress'
                          ? () => toggleOne(item.id)
                          : undefined
                      }
                      onOpen={() => setOpenId(item.id)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </Main>

      <ContentDetailDialog itemId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}

function SortableHead({
  label,
  onClick,
  active,
}: {
  label: string
  onClick: () => void
  active: boolean
}) {
  return (
    <TableHead>
      <button
        type='button'
        onClick={onClick}
        className={cn(
          'flex items-center gap-1 text-[0.625rem] font-bold tracking-[0.1em] uppercase',
          active ? 'text-bd-ink' : 'text-muted-foreground'
        )}
      >
        {label}
        <ArrowUpDown className='size-3' />
      </button>
    </TableHead>
  )
}

function IdeaRow({
  item,
  isStaff,
  selected,
  onSelect,
  onOpen,
}: {
  item: ContentItem
  isStaff: boolean
  selected: boolean
  /** Absent when this row cannot be sent — see `sendable`. */
  onSelect?: () => void
  onOpen: () => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api.del(`/content/${item.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['content'] })
      // Deleting an item that was awaiting a decision changes both of these
      // too. Without them the review queue kept offering a post that no
      // longer exists — opening it answered 404 — and the client list went on
      // counting it. Same rule as every other content mutation: invalidate
      // every key the change touches, not just the one on screen.
      await queryClient.invalidateQueries({ queryKey: ['next-steps'] })
      await queryClient.invalidateQueries({ queryKey: ['clients'] })
      // Deleting the item cascades its assets, so a post that filled a cell in
      // the feed grid leaves a hole. The grid went on rendering the deleted
      // post's thumbnail, whose asset endpoint now answers 404 — a broken
      // image where the fix is one more key.
      await queryClient.invalidateQueries({ queryKey: ['feed'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })


  return (
    <TableRow className='group cursor-pointer' onClick={onOpen}>
      {isStaff && (
        // stopPropagation, or ticking the box also opens the dialog — the row
        // itself is the click target for opening a post.
        <TableCell onClick={(e) => e.stopPropagation()}>
          {onSelect && (
            <Checkbox
              checked={selected}
              onCheckedChange={onSelect}
              aria-label={`Select "${item.title}" to send to the client`}
            />
          )}
        </TableCell>
      )}
      <TableCell className='font-semibold'>{item.title}</TableCell>
      <TableCell>
        <TypePill type={item.type} />
      </TableCell>
      <TableCell className='text-sm text-muted-foreground'>
        {item.scheduledAt ?? '—'}
      </TableCell>
      <TableCell>
        {/* Two pills, not one: the status still says where the post is in the
            process, and the red one says the date went past without an answer.
            Collapsing them into a single "overdue" status would lose the fact
            that it is still sitting at ready-for-review. */}
        <div className='flex flex-wrap items-center gap-1.5'>
          <StatusPill item={item} />
          <ApprovalOverduePill item={item} />
        </div>
      </TableCell>
      {isStaff && (
        <TableCell>
          <Button
            size='icon'
            variant='ghost'
            className='size-7 opacity-0 group-hover:opacity-100'
            aria-label={`Delete ${item.title}`}
            onClick={(e) => {
              e.stopPropagation()
              remove.mutate()
            }}
          >
            <Trash2 className='size-3.5 text-destructive' />
          </Button>
        </TableCell>
      )}
    </TableRow>
  )
}

function NewIdeaDialog({ clientId }: { clientId: string | null }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    title: '',
    type: 'reel' as ContentType,
    scheduledAt: '',
  })

  const create = useMutation({
    mutationFn: () =>
      api.post(withClient('/content', clientId), {
        title: form.title.trim(),
        type: form.type,
        scheduledAt: form.scheduledAt || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['content'] })
      setOpen(false)
      setForm({ title: '', type: 'reel', scheduledAt: '' })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          Add concept
        </Button>
      </DialogTrigger>
      <DialogContent className='crate-card sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='display text-xl'>New concept</DialogTitle>
        </DialogHeader>
        <div className='grid gap-3'>
          <div className='grid gap-1.5'>
            <Label htmlFor='idea-title'>Name</Label>
            <Input
              id='idea-title'
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder='Behind the scenes at the shoot'
            />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='idea-type'>Content type</Label>
            <Select
              value={form.type}
              onValueChange={(v) => setForm({ ...form, type: v as ContentType })}
            >
              <SelectTrigger id='idea-type'>
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
          <div className='grid gap-1.5'>
            <Label htmlFor='idea-date'>Date (optional)</Label>
            <Input
              id='idea-date'
              type='date'
              value={form.scheduledAt}
              onChange={(e) =>
                setForm({ ...form, scheduledAt: e.target.value })
              }
            />
            <p className='text-xs text-muted-foreground'>
              Leave blank to keep it in the backlog. Adding a date puts this
              same record on the calendar.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={!form.title.trim() || create.isPending}
          >
            Add concept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
