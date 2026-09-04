import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import {
  api,
  approvalState,
  assetUrl,
  formatShortDate,
  formatTime,
  type ApprovalState,
  type ContentItem,
  type FeedCell,
} from '@/lib/api'
import { withClient } from '@/features/portal/use-workspace'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/layout/query-error'
import { ContentDetailDialog } from './detail-dialog'
import { APPROVAL_TONE, approvalLabel, TYPE_LABEL, TYPE_TONE } from './vocabulary'

/**
 * Posts as square previews, the way the Feed Preview shows them.
 *
 * Two of Sofia's notes are the same component:
 *
 *   "ideas bank should look like feedpreview with little square previews, but
 *    only the pending approval ones or declined one. with a red or orange
 *    button"
 *   "in comming up on client portal - i want a page feed of approved one and
 *    in Ideas bank i want a page feed of ones pending (preview images)"
 *
 * She is describing one idea from both ends: the work should be looked at as
 * PICTURES, filtered by whether it is waiting on somebody. A social post is an
 * image; a table row of its title is the one representation that cannot tell
 * you whether it is any good.
 *
 * Written once and filtered, rather than as an "awaiting grid" and an "upcoming
 * grid". The two differ by a predicate and a heading; as two components they
 * would differ by a predicate, a heading, and — within a month — by whether a
 * video shows its poster frame.
 */
export type PostGridMode = 'decisions' | 'upcoming'

const MODE_COPY: Record<
  PostGridMode,
  { title: string; empty: string; hint: string }
> = {
  decisions: {
    title: 'Needs a decision',
    empty: 'Nothing is waiting on a decision.',
    hint: 'Open one to approve it or ask for changes.',
  },
  upcoming: {
    title: 'Coming up',
    empty: 'Nothing approved yet — approved posts appear here.',
    hint: 'Approved and scheduled work, soonest first.',
  },
}

export function PostGrid({
  clientId,
  mode,
  limit = 12,
  className,
}: {
  /**
   * NULL for a client, and that is not an oversight.
   *
   * `useWorkspace()` returns null for a client-role session — they have
   * exactly one workspace and no say in it, and the server resolves it from
   * their grant. Passing a real id here instead would still work (the API
   * ignores `?client=` for a client) but it would key the cache on a value
   * every other content screen spells `'default'`, so the Ideas Bank and this
   * grid would hold two copies of the same rows and refetch each other's.
   *
   * The first version typed this `string` and the Ideas Bank guarded on
   * `{clientId && …}` — which meant the grid Sofia asked for ("in Ideas bank
   * i want a page feed of ones pending") rendered for everybody EXCEPT the
   * client it was for.
   */
  clientId: string | null
  mode: PostGridMode
  limit?: number
  className?: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  /*
   * Two queries, and the SAME KEYS the Ideas Bank and Feed Preview already
   * use, so mounting this beside either of them costs nothing — TanStack
   * serves both from cache and one refetch updates the table and the grid
   * together. A bespoke endpoint returning "items with their first asset"
   * would be a third query over the same rows, and the first thing to go
   * stale when a post is approved somewhere else.
   */
  const items = useQuery({
    queryKey: ['content', clientId ?? 'default'],
    queryFn: () =>
      api.get<{ clientId: string; items: ContentItem[] }>(
        withClient('/content', clientId)
      ),
  })

  const feed = useQuery({
    queryKey: ['feed', clientId ?? 'default'],
    queryFn: () =>
      api.get<{ clientId: string; cells: FeedCell[] }>(
        withClient('/media/feed', clientId)
      ),
  })

  const { rows, hidden } = useMemo(() => {
    const assets = new Map(
      (feed.data?.cells ?? []).map((c) => [
        c.itemId,
        { assetId: c.assetId, assetKind: c.assetKind },
      ])
    )

    /*
     * `published` is deliberately excluded from "Coming up".
     *
     * `approvalState` groups approved, scheduled and published as one green,
     * which is right for a traffic light — nobody is waiting on any of them.
     * It is wrong for a panel headed "Coming up": a post that has already gone
     * out is not coming up, and because nothing ever leaves this filter they
     * would pile up in the client's grid for the life of the account until the
     * twelve slots held nothing but old work.
     */
    const wanted = (item: ContentItem): boolean => {
      const state: ApprovalState = approvalState(item)
      return mode === 'decisions'
        ? state === 'pending' || state === 'declined'
        : state === 'approved' && item.status !== 'published'
    }

    const matched = (items.data?.items ?? []).filter(wanted).sort(byWhenItMatters)

    return {
      rows: matched
        .slice(0, limit)
        .map((item) => ({ item, asset: assets.get(item.id) ?? null })),
      // Said out loud rather than silently truncated. A grid capped at twelve
      // that shows twelve is indistinguishable from a grid showing everything.
      hidden: Math.max(0, matched.length - limit),
    }
  }, [items.data, feed.data, mode, limit])

  const copy = MODE_COPY[mode]

  return (
    <Card className={cn('crate-card', className)}>
      <CardContent className='py-4'>
        <div className='mb-3 flex items-center gap-2'>
          <span
            aria-hidden
            className={cn(
              'size-2.5 rounded-full border-[1.5px] border-bd-ink',
              mode === 'decisions' ? 'bg-pay-awaiting' : 'bg-pay-paid'
            )}
          />
          <h2 className='display text-lg'>{copy.title}</h2>
          {rows.length > 0 && (
            <span className='text-xs text-muted-foreground'>
              {rows.length} {rows.length === 1 ? 'post' : 'posts'}
            </span>
          )}
        </div>
        <div className='mb-3 crate-rule' />

        {/*
          Error BEFORE empty. "Nothing is waiting on a decision" over a failed
          request is a confident, wrong answer to the one question this panel
          exists to answer, and she would act on it by not looking again.
        */}
        {items.isError || feed.isError ? (
          <QueryError
            title='Could not load the posts'
            error={(items.error ?? feed.error) as Error}
            onRetry={() => {
              items.refetch()
              feed.refetch()
            }}
          />
        ) : items.isPending || feed.isPending ? (
          <div className='grid grid-cols-3 gap-2 sm:grid-cols-4'>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className='aspect-square' />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className='py-2 text-sm text-muted-foreground'>{copy.empty}</p>
        ) : (
          <>
            <ul className='grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4'>
              {rows.map(({ item, asset }) => (
                <li key={item.id}>
                  <PostTile
                    item={item}
                    asset={asset}
                    onOpen={() => setOpenId(item.id)}
                  />
                </li>
              ))}
            </ul>
            <p className='mt-3 text-xs text-muted-foreground italic'>
              {copy.hint}
              {hidden > 0 && ` ${hidden} more not shown.`}
            </p>
          </>
        )}
      </CardContent>

      <ContentDetailDialog itemId={openId} onClose={() => setOpenId(null)} />
    </Card>
  )
}

/**
 * Soonest first, undated last.
 *
 * The same rule as the Next Steps panel, and for the same reason: `null` sorts
 * before everything in a naive comparator, which would lead a grid headed
 * "Coming up" with the post that has no date on it.
 */
function byWhenItMatters(a: ContentItem, b: ContentItem): number {
  if (a.scheduledAt === b.scheduledAt) return a.title.localeCompare(b.title)
  if (!a.scheduledAt) return 1
  if (!b.scheduledAt) return -1
  return a.scheduledAt < b.scheduledAt ? -1 : 1
}

/**
 * One square.
 *
 * A post with no creative yet still gets a tile — in its type colour, with the
 * type spelled out. Dropping it would make the grid quietly disagree with the
 * count beside the heading, and a post awaiting approval that is invisible
 * because nobody has uploaded the image yet is exactly the one that needs
 * chasing.
 */
function PostTile({
  item,
  asset,
  onOpen,
}: {
  item: ContentItem
  asset: { assetId: string; assetKind: 'image' | 'video' } | null
  onOpen: () => void
}) {
  const state = approvalState(item)

  return (
    <button
      type='button'
      onClick={onOpen}
      title={`${TYPE_LABEL[item.type]}: ${item.title} — ${approvalLabel(item)}`}
      className='group relative block aspect-square w-full overflow-hidden rounded border-2 border-bd-ink bg-bd-sand text-start hover:opacity-90'
    >
      {asset ? (
        <img
          src={assetUrl(asset.assetId, asset.assetKind === 'video' ? 'poster' : 'thumb')}
          alt={item.title}
          loading='lazy'
          className='size-full object-cover'
        />
      ) : (
        <span
          className={cn(
            'flex size-full items-center justify-center text-[0.625rem] font-bold tracking-[0.1em] text-bd-ink uppercase',
            TYPE_TONE[item.type]
          )}
        >
          {TYPE_LABEL[item.type]}
        </span>
      )}

      {asset?.assetKind === 'video' && (
        <span className='absolute inset-0 flex items-center justify-center'>
          <Play className='size-6 fill-white/90 text-white drop-shadow' />
        </span>
      )}

      {/*
        The button she asked for — "with a red or orange button".
        
        A word rather than a bare dot, because three colours on a tile with no
        text is a code you have to be taught. It sits at the TOP so it is not
        the thing competing with the title, and it says what the state is
        rather than what would happen if you pressed it: the tile opens the
        post, where approving and asking for changes are two separate,
        deliberate buttons. A tile that approved on one click would approve on
        one mis-click.
      */}
      <span
        className={cn(
          'absolute top-1 left-1 rounded-full border-[1.5px] border-bd-ink px-1.5 py-0.5',
          'text-[0.5625rem] font-bold whitespace-nowrap',
          APPROVAL_TONE[state]
        )}
      >
        {approvalLabel(item)}
      </span>

      <span className='absolute inset-x-0 bottom-0 flex items-baseline gap-1 bg-bd-ink/75 px-1 py-0.5 text-[0.5625rem] text-bd-cream'>
        <span className='min-w-0 flex-1 truncate'>{item.title}</span>
        {item.scheduledAt && (
          <span className='shrink-0 font-bold tabular-nums opacity-90'>
            {formatShortDate(item.scheduledAt)}
            {item.scheduledTime ? ` ${formatTime(item.scheduledTime)}` : ''}
          </span>
        )}
      </span>
    </button>
  )
}
