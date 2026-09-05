import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Check, Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  formatShortDate,
  formatTime,
  localDayOf,
  type ContentType,
  approvalState,
  type ContentStatus,
  type Platform,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { safeHref } from '@/lib/safe-href'
import { cn } from '@/lib/utils'
import { AuthLayout } from '@/features/auth/auth-layout'
import { TypePill } from '@/features/content/pills'

type SharedAsset = {
  id: string
  kind: 'image' | 'video'
  mime: string | null
  width: number | null
  height: number | null
}

type SharePayload =
  | {
      scope: 'content_item'
      client: { name: string } | null
      item: {
        id: string
        title: string
        type: ContentType
        status: string
        caption: string | null
        hashtags: string[]
        scheduledAt: string | null
        scheduledTime: string | null
      }
      assets: SharedAsset[]
      approvals: {
        decision: 'approved' | 'changes_requested'
        note: string | null
        decidedAt: string
      }[]
    }
  | {
      scope: 'feed'
      client: { name: string } | null
      /** Shaped by selectFeedCells, the same rows the Feed Preview renders. */
      cells: {
        itemId: string
        title: string
        type: ContentType
        scheduledAt: string | null
        scheduledTime: string | null
        feedOrder: number | null
        assetId: string
        /**
         * `selectFeedCells` has always returned this; the type simply never
         * declared it, so the grid could not tell a Reel from a photo and put
         * both in an `<img>`. Her feed is entirely video.
         */
        assetKind: 'image' | 'video'
      }[]
      /** Shared ideas with no date yet. Internal ones cannot reach here. */
      ideas: {
        id: string
        title: string
        type: ContentType
        status: string
        caption: string | null
      }[]
      /** The board, so the link shows the look as well as the plan. */
      moodboard: {
        id: string
        caption: string | null
        url: string | null
        hasImage: boolean
      }[]
    }
  | {
      scope: 'moodboard'
      client: { name: string } | null
      items: {
        id: string
        caption: string | null
        /** Prototype-era rows hold a pasted address instead of stored bytes. */
        url: string | null
        hasImage: boolean
      }[]
    }
  | {
      scope: 'ideas'
      client: { name: string } | null
      items: {
        id: string
        title: string
        type: ContentType
        status: ContentStatus
        caption: string | null
        scheduledAt: string | null
        platforms: Platform[]
      }[]
      /** The asset per item, from the same query the app's own grid uses. */
      cells: { itemId: string; assetId: string; assetKind: 'image' | 'video' }[]
    }

/**
 * What a client sees when she sends them a link.
 *
 * No sidebar, no Header, no Main — those need the authenticated shell. This
 * follows the sign-in page's brand wrapper instead, which is the other screen
 * a person can reach without an account.
 *
 * Every failure — expired, revoked, unknown, wrong scope, archived client —
 * arrives here as the same 404, on purpose. Telling the difference would make
 * the endpoint an oracle for guessing tokens.
 */
/**
 * The bytes a GRID CELL should show, which is not the original.
 *
 * `assetUrl()` does this for the signed-in app; the public page needs the same
 * decision and did not have it. A video's original is an MP4, and an `<img>`
 * pointed at an MP4 renders as a broken image with the alt text showing —
 * which is what a shared feed preview looked like for an account whose posts
 * are all Reels. A poster frame is extracted on upload precisely so a video
 * has something to be a picture of.
 */
function shareTileUrl(
  token: string,
  assetId: string,
  kind: 'image' | 'video'
): string {
  return `/api/share/${token}/assets/${assetId}?variant=${kind === 'video' ? 'poster' : 'thumb'}`
}

export function SharePage() {
  const { token } = useParams({ from: '/(share)/share/$token' })
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['share', token],
    queryFn: () => api.get<SharePayload>(`/share/${token}`),
    retry: false,
  })

  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'changes_requested') =>
      api.post(`/share/${token}/decision`, {
        decision,
        note: note.trim() || null,
      }),
    onSuccess: async (_r, decision) => {
      toast.success(
        decision === 'approved'
          ? 'Approved. Thank you — we have let the team know.'
          : 'Sent back with your notes. The team will pick it up.'
      )
      setNote('')
      await queryClient.invalidateQueries({ queryKey: ['share', token] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  if (isLoading) {
    return (
      <AuthLayout>
        <Card className='crate-card w-full max-w-2xl'>
          <CardContent className='space-y-3 py-6'>
            <Skeleton className='h-8 w-2/3' />
            <Skeleton className='h-64' />
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  // isError before any empty state: an expired link and a broken request must
  // not both render as "nothing here".
  if (isError || !data) {
    return (
      <AuthLayout>
        <Card className='crate-card w-full max-w-lg'>
          <CardContent className='space-y-2 py-6 text-center'>
            <p className='display text-xl'>This link is no longer available</p>
            <p className='text-sm text-muted-foreground'>
              It may have expired, or been replaced with a newer one. Ask your
              Banana Digital contact for a fresh link.
            </p>
          </CardContent>
        </Card>
      </AuthLayout>
    )
  }

  if (data.scope === 'moodboard') {
    return (
      <AuthLayout>
        <div className='w-full max-w-3xl'>
          <p className='mb-1 text-center text-xs tracking-[0.16em] text-muted-foreground uppercase'>
            {data.client?.name ?? 'Brand'} moodboard
          </p>
          <h1 className='mb-4 text-center display text-3xl'>The look</h1>
          {data.items.length === 0 ? (
            <p className='text-center text-sm text-muted-foreground'>
              Nothing pinned yet.
            </p>
          ) : (
            /* A masonry, like the board itself. A moodboard read as a uniform
               grid of squares is a different document — the shapes are part of
               what she is showing. */
            <div className='columns-2 gap-3 sm:columns-3'>
              {data.items.map((item) => {
                const src = item.hasImage
                  ? `/api/share/${token}/moodboard/${item.id}`
                  : safeHref(item.url)
                if (!src) return null
                return (
                  <figure key={item.id} className='mb-3 break-inside-avoid'>
                    <img
                      src={src}
                      alt={item.caption ?? 'Moodboard reference'}
                      loading='lazy'
                      className='w-full rounded border-2 border-bd-ink'
                    />
                    {item.caption && (
                      <figcaption className='mt-1 text-xs text-muted-foreground'>
                        {item.caption}
                      </figcaption>
                    )}
                  </figure>
                )
              })}
            </div>
          )}
          <p className='mt-6 text-center text-xs text-muted-foreground'>
            Shared by Banana Digital. Anyone with this link can open it.
          </p>
        </div>
      </AuthLayout>
    )
  }

  if (data.scope === 'ideas') {
    /*
     * PENDING only, and that is a property of the boundary rather than a
     * choice about layout.
     *
     * Her own decision grid shows pending AND declined, because both are in
     * her queue. This page cannot show declined and must not pretend it can:
     * `content_approvals` has no review arm at all (migration 0016 — a link
     * holder can record a decision through a SECURITY DEFINER function but can
     * read no decision history), so `lastDecision` is absent under every
     * review context and `approvalState` can only ever answer pending,
     * approved or draft here.
     *
     * A first version branched on `declined` and styled a red tile for it. It
     * would never have rendered. A branch that cannot run is worse than no
     * branch: it reads as a case that is handled.
     *
     * It is also the right answer for the audience. The page is addressed to
     * the client — "waiting on you" — and a concept they have already sent
     * back is waiting on HER.
     */
    const assets = new Map(data.cells.map((c) => [c.itemId, c]))
    const waiting = data.items.filter((i) => approvalState(i) === 'pending')
    return (
      <AuthLayout>
        <div className='w-full max-w-3xl'>
          <p className='mb-1 text-center text-xs tracking-[0.16em] text-muted-foreground uppercase'>
            {data.client?.name ?? 'Your'} concepts
          </p>
          <h1 className='mb-4 text-center display text-3xl'>
            Waiting on you
          </h1>
          {waiting.length === 0 ? (
            <p className='text-center text-sm text-muted-foreground'>
              Nothing is waiting on a decision right now.
            </p>
          ) : (
            <ul className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
              {waiting.map((item) => {
                const asset = assets.get(item.id)
                return (
                  <li key={item.id}>
                    <div className='relative aspect-square overflow-hidden rounded border-2 border-bd-ink bg-bd-sand'>
                      {asset ? (
                        <img
                          src={shareTileUrl(token, asset.assetId, asset.assetKind)}
                          alt={item.title}
                          loading='lazy'
                          className='size-full object-cover'
                        />
                      ) : (
                        <span className='flex size-full items-center justify-center text-[0.625rem] font-bold tracking-[0.1em] uppercase'>
                          {item.type}
                        </span>
                      )}
                      {/* One state can reach this page — see `waiting` above. */}
                      <span
                        className={cn(
                          'absolute top-1 left-1 rounded-full border-[1.5px] border-bd-ink px-1.5 py-0.5',
                          'bg-pay-awaiting text-[0.5625rem] font-bold text-bd-ink'
                        )}
                      >
                        Waiting
                      </span>
                    </div>
                    <p className='mt-1 truncate text-xs font-semibold'>
                      {item.title}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
          <p className='mt-6 text-center text-xs text-muted-foreground'>
            Open the post links Banana Digital sent you to approve or ask for
            changes. Anyone with this link can see this page.
          </p>
        </div>
      </AuthLayout>
    )
  }

  if (data.scope === 'feed') {
    return (
      <AuthLayout>
        <div className='w-full max-w-3xl'>
          <p className='mb-1 text-center text-xs tracking-[0.16em] text-muted-foreground uppercase'>
            {data.client?.name ?? 'Your'} grid preview
          </p>
          <h1 className='mb-4 text-center display text-2xl'>Feed preview</h1>
          <Card className='crate-card'>
            <CardContent className='py-5'>
              {data.cells.length === 0 ? (
                <p className='text-center text-sm text-muted-foreground'>
                  Nothing scheduled yet.
                </p>
              ) : (
                <ul className='grid grid-cols-3 gap-1.5'>
                  {data.cells.slice(0, 9).map((cell) => (
                    <li
                      key={cell.itemId}
                      className='relative aspect-square overflow-hidden rounded border-2 border-bd-ink bg-bd-sand'
                    >
                      {cell.assetId ? (
                        <img
                          src={shareTileUrl(token, cell.assetId, cell.assetKind)}
                          alt={cell.title}
                          loading='lazy'
                          className='size-full object-cover'
                        />
                      ) : null}
                      <span className='absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-bd-ink/80 px-1.5 py-1 text-[0.625rem] font-bold text-white'>
                        <span className='min-w-0 flex-1 truncate'>
                          {cell.title}
                        </span>
                        {cell.scheduledAt && (
                          <span className='shrink-0 tabular-nums'>
                            {formatShortDate(cell.scheduledAt)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className='mt-4 text-center text-xs text-muted-foreground'>
                A preview of how the grid will look. Nothing here is live yet.
              </p>
            </CardContent>
          </Card>

          {/*
            The look, under the plan.

            The grid says what is coming; the board says what it will feel
            like, and the person opening this link wants both. A masonry rather
            than squares, because the shapes she chose are part of what she is
            showing — cropping a moodboard to a uniform grid makes it a
            different document.

            Absent, not empty, for a client with no board.
          */}
          {data.moodboard.length > 0 && (
            <Card className='mt-4 crate-card'>
              <CardContent className='py-5'>
                <p className='mb-3 pb-1 display text-sm crate-rule'>The look</p>
                <div className='columns-2 gap-2 sm:columns-3'>
                  {data.moodboard.map((tile) => {
                    const src = tile.hasImage
                      ? `/api/share/${token}/moodboard/${tile.id}`
                      : safeHref(tile.url)
                    if (!src) return null
                    return (
                      <img
                        key={tile.id}
                        src={src}
                        alt={tile.caption ?? 'Moodboard reference'}
                        loading='lazy'
                        className='mb-2 w-full break-inside-avoid rounded border-2 border-bd-ink'
                      />
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/*
            What is still being considered, under what is already booked.

            Only the ideas shared with them: the policy arm behind this link
            carries `AND visible_to_client`, so a raw concept or a rejected
            pitch cannot appear however this is rendered. Hidden entirely when
            there are none, rather than an empty heading implying something is
            missing.
          */}
          {data.ideas.length > 0 && (
            <Card className='mt-4 crate-card'>
              <CardContent className='py-5'>
                <p className='mb-1 display text-lg'>Ideas we are considering</p>
                <p className='mb-3 text-xs text-muted-foreground'>
                  Not scheduled yet — early thinking, shared so you can react to
                  it.
                </p>
                <ul className='divide-y divide-bd-rule-soft'>
                  {data.ideas.map((idea) => (
                    <li key={idea.id} className='flex items-start gap-3 py-2.5'>
                      <span className='mt-0.5 shrink-0'>
                        <TypePill type={idea.type} />
                      </span>
                      <span className='min-w-0 flex-1'>
                        <span className='block text-sm font-semibold'>
                          {idea.title}
                        </span>
                        {idea.caption && (
                          <span className='block text-xs text-muted-foreground'>
                            {idea.caption}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </AuthLayout>
    )
  }

  const { item, assets, approvals } = data
  const decided = approvals[0]

  return (
    <AuthLayout>
      <div className='w-full max-w-2xl'>
        <p className='mb-1 text-center text-xs tracking-[0.16em] text-muted-foreground uppercase'>
          {data.client?.name ?? 'For your review'}
        </p>
        <h1 className='mb-4 text-center display text-2xl'>{item.title}</h1>

        <Card className='crate-card'>
          <CardContent className='space-y-5 py-5'>
            <div className='flex flex-wrap items-center justify-center gap-2'>
              <TypePill type={item.type} />
              {item.scheduledAt && (
                <span className='text-xs text-muted-foreground'>
                  Going out {formatShortDate(item.scheduledAt)}
                  {item.scheduledTime
                    ? ` at ${formatTime(item.scheduledTime)}`
                    : ''}
                </span>
              )}
            </div>

            {assets.length > 0 && (
              <ul className='space-y-2'>
                {assets.map((a) =>
                  a.kind === 'video' ? (
                    <li key={a.id}>
                      {/* Range requests pass through the same streamKey the
                          signed-in route uses, so seeking works. */}
                      <video
                        controls
                        playsInline
                        preload='metadata'
                        /* The extracted frame, so the player is not a black
                           rectangle until somebody presses play. */
                        poster={`/api/share/${token}/assets/${a.id}?variant=poster`}
                        className='w-full rounded border-2 border-bd-ink'
                        src={`/api/share/${token}/assets/${a.id}`}
                      />
                    </li>
                  ) : (
                    <li key={a.id}>
                      <img
                        src={`/api/share/${token}/assets/${a.id}`}
                        alt={item.title}
                        className='w-full rounded border-2 border-bd-ink'
                      />
                    </li>
                  )
                )}
              </ul>
            )}

            {item.caption && (
              <div>
                <p className='mb-1 text-xs font-bold tracking-wide uppercase'>
                  Caption
                </p>
                <p className='text-sm whitespace-pre-wrap'>{item.caption}</p>
              </div>
            )}

            {item.hashtags.length > 0 && (
              <div>
                <p className='mb-1 text-xs font-bold tracking-wide uppercase'>
                  Hashtags
                </p>
                <p className='text-sm break-words text-muted-foreground'>
                  {item.hashtags.map((h) => `#${h}`).join(' ')}
                </p>
              </div>
            )}

            {decided ? (
              /* Their own answer, read back through the review arm on
                 content_approvals_select — so the buttons are not offered a
                 second time to somebody who has already replied. */
              <div className='rounded-md border border-border bg-muted/40 p-3 text-sm'>
                <p className='font-semibold'>
                  {decided.decision === 'approved'
                    ? 'You approved this'
                    : 'You asked for changes'}{' '}
                  {/* localDayOf, not .slice(0, 10). decidedAt is a
                      timestamp, and the slice takes the UTC day — this read
                      "31 Aug" for a decision made at half past midnight on
                      the 1st in London. Caught by looking at the page. */}
                  on {formatShortDate(localDayOf(decided.decidedAt))}.
                </p>
                {decided.note && (
                  <p className='mt-1 text-muted-foreground'>
                    “{decided.note}”
                  </p>
                )}
                <p className='mt-2 text-xs text-muted-foreground'>
                  Need to change your mind? Reply to whoever sent you this.
                </p>
              </div>
            ) : (
              <div className='space-y-2 pt-1'>
                <Textarea
                  aria-label='Anything you want to say'
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder='Anything you want to say (optional)'
                  className='min-h-16 resize-y'
                />
                <div className='flex flex-wrap gap-2'>
                  <Button
                    onClick={() => decide.mutate('approved')}
                    disabled={decide.isPending}
                  >
                    {decide.isPending && decide.variables === 'approved' ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <Check />
                    )}
                    Approve
                  </Button>
                  <Button
                    variant='outline'
                    onClick={() => decide.mutate('changes_requested')}
                    disabled={decide.isPending}
                  >
                    {decide.isPending &&
                    decide.variables === 'changes_requested' ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <Undo2 />
                    )}
                    Request changes
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <p className='mt-3 text-center text-xs text-muted-foreground'>
          Anyone with this link can answer on your behalf, so keep it to
          yourself.
        </p>
      </div>
    </AuthLayout>
  )
}
