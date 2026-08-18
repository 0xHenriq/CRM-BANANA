import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, ArrowRight } from 'lucide-react'
import { api, type AwaitingItem } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { ContentDetailDialog } from './detail-dialog'
import { TypePill } from './pills'

/**
 * "Here is what needs a decision."
 *
 * This is the panel the product was missing. A client would sign in, see a
 * link stack and a file folder, and have no idea two posts were waiting on
 * their approval — while the entire point of a client portal is that the
 * client responds. Staff had the mirror-image problem: a number on the
 * dashboard and no way to see which items were behind it.
 *
 * Rendered only when there is something to act on. An empty prompt is noise,
 * and noise is how people learn to ignore a panel.
 */
export function ReviewQueue({
  variant = 'client',
}: {
  variant?: 'client' | 'agency'
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: ['awaiting'],
    queryFn: () =>
      api.get<{ items: AwaitingItem[]; scope: string }>('/content/awaiting'),
  })

  const items = data?.items ?? []
  if (items.length === 0) return null

  const isClient = variant === 'client'

  return (
    <>
      <Card className='crate-card mb-5 border-bd-yellow-deep bg-bd-cream'>
        <CardContent className='py-4'>
          <div className='mb-3 flex items-center gap-2'>
            <span className='flex size-6 items-center justify-center rounded-full border-[1.5px] border-bd-ink bg-bd-yellow'>
              <Eye className='size-3.5 text-bd-ink' />
            </span>
            <h2 className='display text-lg'>
              {isClient
                ? `${items.length} ${items.length === 1 ? 'post needs' : 'posts need'} your review`
                : `Waiting on ${items.length === 1 ? 'a client' : 'clients'}`}
            </h2>
          </div>

          <ul className='divide-y divide-bd-rule-soft'>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type='button'
                  onClick={() => setOpenId(item.id)}
                  className='flex w-full items-center gap-3 py-2 text-start hover:opacity-70'
                >
                  <TypePill type={item.type} />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-sm font-semibold'>
                      {item.title}
                    </span>
                    <span className='block truncate text-xs text-muted-foreground'>
                      {/* Staff need to know whose it is; the client already
                          knows, and would only find it patronising. */}
                      {!isClient && `${item.clientName} · `}
                      {item.scheduledAt
                        ? `Scheduled ${item.scheduledAt}`
                        : 'Not scheduled'}
                    </span>
                  </span>
                  <ArrowRight className='size-4 shrink-0 text-muted-foreground' />
                </button>
              </li>
            ))}
          </ul>

          {isClient && (
            <p className='mt-3 text-xs text-muted-foreground'>
              Open a post to approve it or ask for changes.
            </p>
          )}
        </CardContent>
      </Card>

      <ContentDetailDialog itemId={openId} onClose={() => setOpenId(null)} />
    </>
  )
}
