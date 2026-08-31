import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatShortDate, linkState, localDayOf, type ShareLink } from '@/lib/api'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  const now = new Date()

  const { data, isLoading } = useQuery({
    queryKey: ['shares', contentItemId],
    queryFn: () => api.get<{ links: ShareLink[] }>(`/shares/content/${contentItemId}`),
    enabled: open,
  })

  const mint = useMutation({
    mutationFn: () => api.post<{ url: string }>(`/shares/content/${contentItemId}`, {}),
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

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setFresh(null)
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
            <div className='space-y-1.5'>
              <Input readOnly value={fresh} className='font-mono text-xs' />
              <p className='text-xs text-muted-foreground'>
                Copy it now — it cannot be displayed again.
              </p>
            </div>
          )}

          <Button
            size='sm'
            className='w-full'
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
                        The thing she actually wants to know is whether they
                        looked, so the count leads and the dates follow.
                      */}
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
