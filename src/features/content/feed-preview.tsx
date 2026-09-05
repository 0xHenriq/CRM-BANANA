import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, GripVertical } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  approvalState,
  assetUrl,
  formatShortDate,
  formatTime,
  type FeedCell,
} from '@/lib/api'
import { useWorkspace, withClient } from '@/features/portal/use-workspace'
import { WorkspaceSwitcher } from '@/features/portal/workspace-switcher'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'
import { ContentDetailDialog } from './detail-dialog'
import { ApprovalDot } from './pills'
import { FeedShareButton } from './share-links'
import { approvalLabel, TYPE_LABEL } from './vocabulary'

/**
 * The 3×3 grid.
 *
 * Every cell is a real content item with a real uploaded asset. In the
 * prototype this was nine independent text boxes holding pasted image URLs,
 * connected to nothing — so in practice it stayed empty, because clients will
 * not go and host images somewhere else first.
 */
export function FeedPreview() {
  const { isStaff, clientId, setClientId, workspaces, isReady } = useWorkspace()
  const queryClient = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['feed', clientId ?? 'default'],
    queryFn: () =>
      api.get<{ clientId: string; cells: FeedCell[] }>(
        withClient('/media/feed', clientId)
      ),
    enabled: isReady,
  })

  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api.patch('/media/feed/reorder', { ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feed'] })
      queryClient.invalidateQueries({ queryKey: ['content'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const cells = data?.cells ?? []
  const grid = cells.slice(0, 9)

  function onDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return
    const next = [...grid]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(targetIndex, 0, moved)
    setDragIndex(null)
    reorder.mutate(next.map((c) => c.itemId))
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
        {/*
          Named, now that a post can say where it goes.

          This grid has always been an Instagram profile — three across,
          newest first — and calling it "3×3 grid mock up" let it quietly
          stand for every network at once. A TikTok plan does not look like
          this, and until migration 0024 there was no way for the product to
          know the difference, so the label had to stay vague.
        */}
        <PageHead
          eyebrow='Instagram · 3×3 grid mock up'
          title='Feed Preview'
          stamp={{ top: 'GRID', big: '9', bottom: 'POST' }}
          /*
            Sofia: "when u click on feed preview tab can we have a button that
            send that preview to client". The link could already be minted —
            from a popover on the client page, which is not where anybody is
            standing when they look at the grid and decide it is ready. Same
            component, so the two cannot drift.

            Staff only, and only once a workspace has actually resolved: a
            Send button that answers "no workspace" is worse than no button.
          */
          actions={
            isStaff && data?.clientId ? (
              <FeedShareButton clientId={data.clientId} />
            ) : undefined
          }
        />

        {isLoading ? (
          <Skeleton className='aspect-square max-w-lg' />
        ) : isError ? (
          <QueryError
            title='Could not load the feed'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : (
          <Card className='crate-card max-w-lg'>
            <CardContent>
              <div className='grid grid-cols-3 gap-1 border-2 border-bd-ink bg-bd-ink p-1'>
                {Array.from({ length: 9 }).map((_, i) => {
                  const cell = grid[i]
                  if (!cell) {
                    return (
                      <div
                        key={`empty-${i}`}
                        className='flex aspect-square items-center justify-center bg-bd-sand text-[0.625rem] text-muted-foreground'
                      >
                        Post {i + 1}
                      </div>
                    )
                  }

                  return (
                    <button
                      key={cell.itemId}
                      type='button'
                      draggable={isStaff}
                      onDragStart={() => setDragIndex(i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDrop(i)}
                      onClick={() => setOpenId(cell.itemId)}
                      className={cn(
                        'group relative aspect-square overflow-hidden bg-bd-sand',
                        isStaff && 'cursor-grab active:cursor-grabbing',
                        dragIndex === i && 'opacity-40'
                      )}
                      title={`${TYPE_LABEL[cell.type]}: ${cell.title}${
                        cell.scheduledAt
                          ? ` · ${formatShortDate(cell.scheduledAt)}${cell.scheduledTime ? ` at ${formatTime(cell.scheduledTime)}` : ''}`
                          : ''
                      } — ${approvalLabel(cell)}`}
                    >
                      <img
                        src={assetUrl(
                          cell.assetId,
                          cell.assetKind === 'video' ? 'poster' : 'thumb'
                        )}
                        alt={cell.title}
                        loading='lazy'
                        className='size-full object-cover'
                      />

                      {/* Video reads as video at a glance, which is the whole
                          reason a poster frame is extracted on upload. */}
                      {cell.assetKind === 'video' && (
                        <span className='absolute inset-0 flex items-center justify-center'>
                          <Play className='size-6 fill-white/90 text-white drop-shadow' />
                        </span>
                      )}

                      {isStaff && (
                        <GripVertical className='absolute top-1 left-1 size-3.5 text-white opacity-0 drop-shadow group-hover:opacity-100' />
                      )}

                      {/*
                        The traffic light, top right, on the grid too.
                        
                        The nine cells are the thing she sends; whether each
                        one has actually been approved is the question she is
                        answering when she decides to send them, and until now
                        the grid was the one content screen that did not say.
                      */}
                      <ApprovalDot
                        state={approvalState(cell)}
                        className='absolute top-1 right-1 shadow'
                      />

                      {/*
                        Title and posting date together.

                        Nine thumbnails in date order look identical to nine in
                        any other order; the date is what makes the grid read
                        as a plan. An undated cell simply shows its title —
                        the row is not padded with an em dash for it.
                      */}
                      <span className='absolute inset-x-0 bottom-0 flex items-baseline gap-1 bg-bd-ink/75 px-1 py-0.5 text-[0.5625rem] text-bd-cream'>
                        <span className='min-w-0 flex-1 truncate'>
                          {cell.title}
                        </span>
                        {cell.scheduledAt && (
                          <span className='shrink-0 font-bold tabular-nums opacity-90'>
                            {formatShortDate(cell.scheduledAt)}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>

              <p className='mt-3 text-xs text-muted-foreground italic'>
                {isStaff
                  ? 'Drag to rearrange. Cells come from scheduled content with an uploaded asset — add one from a post to fill the grid.'
                  : 'How the next nine posts will sit together.'}
                {/*
                  Say what is not on screen.

                  The grid is nine cells by design — it is a mock-up of a
                  profile, and she titled it "3×3 grid mock up". But a month of
                  content is more than nine posts, and a grid that shows nine
                  of fourteen looks exactly like a grid that shows all
                  fourteen. Same silent-cap problem the decision grid had:
                  truncation nobody is told about reads as completeness.
                */}
                {cells.length > grid.length &&
                  ` ${cells.length - grid.length} more with creative are not in the first nine.`}
              </p>
            </CardContent>
          </Card>
        )}
      </Main>

      <ContentDetailDialog itemId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}
