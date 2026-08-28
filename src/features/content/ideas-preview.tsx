import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { api, type ContentItem } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/layout/query-error'
import { withClient } from '@/features/portal/use-workspace'
import { StatusPill, TypePill } from './pills'

/**
 * The backlog for one client, short, on their page.
 *
 * Deliberately only the UNDATED items. The calendar preview sits beside this
 * one and lists what is scheduled, so showing everything here would print the
 * same rows twice and answer neither question. Split this way the pair reads
 * as "what we have not booked yet" and "what is going out next", which is the
 * two things she asks about a client.
 *
 * Same ['content', clientId] key as the full Ideas Bank, so this shares its
 * cache rather than costing a second request, and an edit there refreshes
 * here.
 */
export function IdeasPreview({
  clientId,
  limit = 5,
}: {
  clientId: string
  limit?: number
}) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['content', clientId],
    queryFn: () =>
      api.get<{ clientId: string; items: ContentItem[] }>(
        withClient('/content', clientId)
      ),
  })

  const undated = (data?.items ?? []).filter((i) => !i.scheduledAt)
  const shown = undated.slice(0, limit)

  return (
    <Card className='crate-card'>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle className='flex items-center gap-2 display text-lg'>
          <span className='size-2.5 rounded-full border-[1.5px] border-bd-ink bg-bd-sand' />
          Ideas Bank
        </CardTitle>
        <Button size='sm' variant='ghost' asChild>
          <Link to='/portal/ideas'>
            Open <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <div className='mb-3 crate-rule' />
        {isLoading ? (
          <Skeleton className='h-24' />
        ) : isError ? (
          /* Before the empty state, never after it: an empty state over a
             failed request tells her this client has no ideas, which is a lie
             she would act on. */
          <QueryError
            title='Could not load the ideas'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : shown.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            Nothing waiting. Every idea for this client has a date on it.
          </p>
        ) : (
          <>
            <ul className='divide-y divide-bd-rule-soft'>
              {shown.map((item) => (
                <li
                  key={item.id}
                  className='flex items-center justify-between gap-3 py-2.5'
                >
                  <p className='min-w-0 flex-1 truncate text-sm font-semibold'>
                    {item.title}
                  </p>
                  <div className='flex shrink-0 items-center gap-2'>
                    <TypePill type={item.type} />
                    <StatusPill status={item.status} />
                  </div>
                </li>
              ))}
            </ul>
            {undated.length > shown.length && (
              <p className='pt-2.5 text-xs text-muted-foreground'>
                +{undated.length - shown.length} more waiting for a date.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
