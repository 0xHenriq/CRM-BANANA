import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Loader2, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatShortDate, linkState, localDayOf, type ShareLink } from '@/lib/api'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Mint and manage share links for one post.
 *
 * The token is shown ONCE, at creation, and the copy step says so — the API
 * physically cannot re-display it, because only a sha256 is stored. That is
 * the point rather than an inconvenience: it means a `backup.sh` dump contains
 * no live approval credentials. Minting a replacement is one click.
 */
export function ShareLinks({
  contentItemId,
  canShare,
}: {
  contentItemId: string
  canShare: boolean
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const [recipient, setRecipient] = useState('')
  const now = new Date()

  const { data, isLoading } = useQuery({
    queryKey: ['shares', contentItemId],
    queryFn: () => api.get<{ links: ShareLink[] }>(`/shares/content/${contentItemId}`),
    enabled: open,
  })

  const mint = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>(`/shares/content/${contentItemId}`, {
        label: recipient.trim() || null,
      }),
    onSuccess: async (result) => {
      setFresh(result.url)
      const ok = await copyText(result.url)
      toast[ok ? 'success' : 'error'](
        ok
          ? 'Link copied. This is the only time it can be shown.'
          : 'Link created — copy it from the box, it cannot be shown again.'
      )
      await queryClient.invalidateQueries({ queryKey: ['shares', contentItemId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/shares/${id}/revoke`, {}),
    onSuccess: async () => {
      toast.success('Link revoked. It stops working immediately.')
      await queryClient.invalidateQueries({ queryKey: ['shares', contentItemId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  if (!canShare) return null

  const links = data?.links ?? []
  // The ones that still open. The list below shows revoked and expired too —
  // history is useful here — but only live ones are a reason not to mint.
  const live = links.filter((l) => linkState(l, now) === 'live')

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        /*
         * A freshly minted token SURVIVES a click outside.
         *
         * It used to be dropped here, and this is the likeliest source of the
         * four never-opened links sitting in production: the token exists on
         * screen exactly once, a stray click destroys it, and the only way
         * back is to mint another. Now it stays until it is explicitly
         * dismissed, and the label resets with it so the next one starts
         * clean.
         */
        setOpen(next)
        if (!next) setRecipient('')
      }}
    >
      <PopoverTrigger asChild>
        <Button size='sm' variant='outline'>
          <Link2 />
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-96 crate-card'>
        <div className='space-y-3'>
          <div>
            <p className='display text-sm'>Share this post</p>
            <p className='text-xs text-muted-foreground'>
              {/* Said plainly, because it is the property she is choosing. */}
              Anyone holding the link can approve it. There is no sign-in.
            </p>
          </div>

          {fresh && (
            <div className='space-y-1.5 rounded-md border-[1.5px] border-bd-ink bg-bd-yellow/25 p-2'>
              <Input readOnly value={fresh} className='bg-card font-mono text-xs' />
              <p className='text-xs'>Copy it now — it cannot be shown again.</p>
              <Button
                size='sm'
                variant='ghost'
                className='h-6 w-full px-2 text-xs'
                onClick={() => setFresh(null)}
              >
                Done — hide it
              </Button>
            </div>
          )}

          {/* See the client-scope popover for why this is asked. */}
          <div className='grid gap-1.5'>
            <Label htmlFor={`post-share-label-${contentItemId}`} className='text-xs'>
              Who is this for?
            </Label>
            <Input
              id={`post-share-label-${contentItemId}`}
              className='h-8'
              placeholder='Nyall, or "the WhatsApp group"'
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>

          {live.length > 0 && (
            <p className='text-xs text-muted-foreground'>
              {live.length === 1
                ? 'There is already a live link'
                : `There are already ${live.length} live links`}{' '}
              for this post. Another does not replace them.
            </p>
          )}

          <Button
            size='sm'
            className='w-full'
            variant={live.length ? 'outline' : 'default'}
            onClick={() => mint.mutate()}
            disabled={mint.isPending}
          >
            {mint.isPending && <Loader2 className='animate-spin' />}
            {links.length ? 'Create another link' : 'Create a link'}
          </Button>

          <div className='crate-rule' />

          {isLoading ? (
            <Skeleton className='h-16' />
          ) : links.length === 0 ? (
            <p className='text-xs text-muted-foreground'>
              No links yet for this post.
            </p>
          ) : (
            <ul className='space-y-2'>
              {links.map((l) => {
                const state = linkState(l, now)
                return (
                  <li key={l.id} className='flex items-start gap-2 text-xs'>
                    <span
                      className={cn(
                        'mt-0.5 shrink-0 rounded-full border-[1.5px] border-bd-ink px-1.5 py-0.5 text-[0.625rem] font-bold',
                        state === 'live'
                          ? 'bg-tag-video'
                          : state === 'revoked'
                            ? 'bg-destructive text-white'
                            : 'bg-bd-sand'
                      )}
                    >
                      {state === 'live'
                        ? 'Live'
                        : state === 'revoked'
                          ? 'Revoked'
                          : 'Expired'}
                    </span>
                    <span className='min-w-0 flex-1'>
                      {/*
                        Who it was for, then whether they looked, then the
                        dates. Three rows of "Not opened yet" cannot be told
                        apart, which is why nobody revokes any of them.
                      */}
                      <span className='block truncate font-semibold'>
                        {l.label ?? 'Unlabelled'}
                      </span>
                      <span className='block'>
                        {l.useCount === 0
                          ? 'Not opened yet'
                          : `Opened ${l.useCount} time${l.useCount === 1 ? '' : 's'}`}
                        {l.lastUsedAt &&
                          `, last on ${formatShortDate(localDayOf(l.lastUsedAt))}`}
                      </span>
                      <span className='block text-muted-foreground'>
                        {state === 'revoked' ? 'Revoked' : 'Expires'}{' '}
                        {formatShortDate(
                          localDayOf(
                            state === 'revoked' ? l.revokedAt! : l.expiresAt
                          )
                        )}
                      </span>
                    </span>
                    {state === 'live' && (
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-6 shrink-0 px-2 text-xs'
                        onClick={() => revoke.mutate(l.id)}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * "Send this preview to the client" — the whole feed grid, as a link.
 *
 * Sofia, looking at the Feed Preview page: "when u click on feed preview tab
 * can we have a button that send that preview to client". The capability
 * already existed and was reachable from exactly one place — the Share menu on
 * the client page — which is not where anybody is standing when they decide
 * the grid looks right. So this is the same popover, moved into a component,
 * and BOTH screens now render it.
 *
 * Extracted rather than copied on purpose. A second implementation of "mint a
 * feed link" is a second set of wording about what the link exposes, and the
 * two would disagree the first time either was corrected — which matters here
 * because one of those sentences is the warning that anyone holding the link
 * can open it.
 */
/** What a client-scoped link opens. Mirrors CLIENT_SCOPES on the server. */
export type ShareScope = 'feed' | 'moodboard' | 'ideas'

/**
 * The sentence each scope needs, because they are not the same promise.
 *
 * A feed preview is a plan; a moodboard is a pitch; a page of concepts is a
 * request for an opinion. Sending all three under one line of copy would make
 * the warning that actually matters — anyone holding the link can open it —
 * read as boilerplate.
 */
const SCOPE_COPY: Record<ShareScope, { title: string; what: string; caveat?: string }> = {
  feed: {
    title: 'Share the feed preview',
    what: 'A read-only grid of what is coming up.',
    caveat:
      'Only posts already shared with the client appear — internal ones are left out.',
  },
  moodboard: {
    title: 'Share the moodboard',
    what: 'The whole board, as a page. Nothing on it can be changed.',
  },
  ideas: {
    title: 'Share the concepts waiting',
    what: 'The posts that need a decision, as pictures.',
    caveat:
      'Only concepts already shared with the client appear — the raw backlog is left out.',
  },
}

export function FeedShareButton({
  clientId,
  scope = 'feed',
  label = 'Send preview',
  variant = 'default',
}: {
  clientId: string
  /** Which view the link opens. See SCOPE_COPY. */
  scope?: ShareScope
  /** The page decides the wording; the behaviour is the same everywhere. */
  label?: string
  variant?: 'default' | 'outline'
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const [recipient, setRecipient] = useState('')
  const now = new Date()

  // Only while the popover is open. Without the gate every page load fetched
  // share links nobody had asked to see.
  const { data } = useQuery({
    // The scope is in the key AND the path: a moodboard link listed under the
    // feed's popover would put "Revoke" next to something the reader is not
    // looking at.
    queryKey: ['feed-shares', clientId, scope],
    queryFn: () =>
      api.get<{ links: ShareLink[] }>(`/shares/client/${clientId}/${scope}`),
    enabled: open,
  })

  const mint = useMutation({
    mutationFn: () =>
      api.post<{ url: string }>(`/shares/client/${clientId}/${scope}`, {
        label: recipient.trim() || null,
      }),
    onSuccess: async (result) => {
      setFresh(result.url)
      const ok = await copyText(result.url)
      toast[ok ? 'success' : 'error'](
        ok
          ? 'Feed preview link copied. It cannot be shown again.'
          : 'Link created — copy it from the box, it cannot be shown again.'
      )
      await queryClient.invalidateQueries({
        queryKey: ['feed-shares', clientId, scope],
      })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/shares/${id}/revoke`, {}),
    onSuccess: async () => {
      toast.success('Link revoked.')
      await queryClient.invalidateQueries({
        queryKey: ['feed-shares', clientId, scope],
      })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const live = (data?.links ?? []).filter((l) => linkState(l, now) === 'live')

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        /*
         * A freshly minted token SURVIVES a dismissal.
         *
         * It used to be dropped here, and that is the likeliest source of the
         * four never-opened links sitting in production: the token exists on
         * screen exactly once, Escape or a stray click destroys it, and the
         * only way back is to mint another — which adds a second live
         * credential nobody can tell from the first.
         *
         * It stays until "Done — hide it". The recipient field resets so the
         * next one starts clean.
         */
        setOpen(next)
        if (!next) setRecipient('')
      }}
    >
      <PopoverTrigger asChild>
        <Button size='sm' variant={variant}>
          <Share2 />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80 crate-card'>
        <div className='space-y-3'>
          <div>
            <p className='display text-sm'>{SCOPE_COPY[scope].title}</p>
            <p className='text-xs text-muted-foreground'>
              {SCOPE_COPY[scope].what} No sign-in, and anyone with the link can
              open it.
            </p>
            {/*
              Said out loud, because what she is looking at and what they get
              are not the same thing. Her screens show everything including
              internal work; a share link shows only what is already shared
              with the client. Without this she sends nine cells and they open
              seven, and the first she hears of it is them asking.
            */}
            {SCOPE_COPY[scope].caveat && (
              <p className='mt-1 text-xs text-muted-foreground'>
                {SCOPE_COPY[scope].caveat}
              </p>
            )}
          </div>

          {fresh && (
            <div className='space-y-1.5 rounded-md border-[1.5px] border-bd-ink bg-bd-yellow/25 p-2'>
              <Input readOnly value={fresh} className='bg-card font-mono text-xs' />
              <div className='flex items-center justify-between gap-2'>
                <p className='text-xs'>
                  Copy it now — it cannot be shown again.
                </p>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-6 shrink-0 px-2 text-xs'
                  onClick={async () => {
                    const ok = await copyText(fresh)
                    toast[ok ? 'success' : 'error'](
                      ok ? 'Copied.' : 'Copy failed — select it and copy by hand.'
                    )
                  }}
                >
                  Copy again
                </Button>
              </div>
              <Button
                size='sm'
                variant='ghost'
                className='h-6 w-full px-2 text-xs'
                onClick={() => setFresh(null)}
              >
                Done — hide it
              </Button>
            </div>
          )}

          {/*
            WHO it is for, asked before it is minted.

            Without it the list below is rows of "Not opened yet, expires
            4 Oct" that cannot be told apart, so revoking one is a guess and
            nobody revokes anything — which is how production reached eight
            live links. It also lets an approval that arrives through this one
            say who it was addressed to instead of "Someone".
          */}
          <div className='grid gap-1.5'>
            <Label htmlFor={`share-label-${scope}`} className='text-xs'>
              Who is this for?
            </Label>
            <Input
              id={`share-label-${scope}`}
              className='h-8'
              placeholder='Nyall, or "the WhatsApp group"'
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>

          {/*
            Demoted once a live link exists, and it says why.

            "Create another link" as the primary action is an invitation to
            press it, and each press issues another key to the same door. The
            second one is occasionally what she wants — a separate link she can
            revoke without breaking the first — so this explains rather than
            blocks.
          */}
          {live.length > 0 && (
            <p className='text-xs text-muted-foreground'>
              {live.length === 1 ? 'There is already a live link' : `There are already ${live.length} live links`}
              {' '}for this. Another one is only useful if you want to revoke
              them separately — it does not replace the others.
            </p>
          )}

          <Button
            size='sm'
            className='w-full'
            variant={live.length ? 'outline' : 'default'}
            onClick={() => mint.mutate()}
            disabled={mint.isPending}
          >
            {mint.isPending && <Loader2 className='animate-spin' />}
            {live.length ? 'Create another link' : 'Create a link'}
          </Button>

          {live.length > 0 && (
            <ul className='space-y-1.5 text-xs'>
              {live.map((l) => (
                <li key={l.id} className='flex items-center gap-2'>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate font-semibold'>
                      {/* Rows minted before labels existed, and any she left
                          blank. Better than inventing a name for them. */}
                      {l.label ?? 'Unlabelled'}
                    </span>
                    <span className='block truncate text-muted-foreground'>
                      {l.useCount === 0
                        ? 'Not opened yet'
                        : `Opened ${l.useCount} time${l.useCount === 1 ? '' : 's'}`}
                      , expires {formatShortDate(localDayOf(l.expiresAt))}
                    </span>
                  </span>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-6 shrink-0 px-2 text-xs'
                    onClick={() => revoke.mutate(l.id)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className='crate-rule' />
          <p className='text-xs text-muted-foreground'>
            Need them to see invoices and files too? Give them a login from the
            client&rsquo;s Overview tab, or on the Seats page.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
