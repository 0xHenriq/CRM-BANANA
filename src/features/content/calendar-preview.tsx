import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import {
  api,
  formatShortDate,
  formatTime,
  isPastDate,
  type ContentItem,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/layout/query-error'
import { withClient } from '@/features/portal/use-workspace'
import { StatusPill, TypePill } from './pills'

/**
 * What goes out next for one client.
 *
 * A list of the next few posts rather than a shrunk month grid: in a column
 * half a page wide a miniature calendar is thirty empty boxes and three dots,
 * and "when is the next one" — the question she is actually asking — takes
 * longer to answer from it than from four lines of text. Same rows, same
 * ['content', clientId] cache as the full calendar, one click away.
 *
 * Upcoming only. A preview headed by last month's posts is a history panel,
 * and she has the calendar itself for looking backwards.
 */
export function CalendarPreview({
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

  // `isPastDate` compares local calendar days, so today's posts stay listed
  // all day. `new Date(iso) < new Date()` would parse the date as UTC midnight
  // and drop this morning's post at breakfast, in London, in summer.
  const upcoming = (data?.items ?? [])
    .filter((i) => i.scheduledAt && !isPastDate(i.scheduledAt))
    .sort((a, b) => {
      const byDate = (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '')
      if (byDate !== 0) return byDate
      // Two posts on one day read in the order they go out. An untimed post
      // sorts first — it is the one still needing a time.
      return (a.scheduledTime ?? '').localeCompare(b.scheduledTime ?? '')
    })
  const shown = upcoming.slice(0, limit)

  return (
    <Card className='crate-card'>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle className='flex items-center gap-2 display text-lg'>
          <span className='size-2.5 rounded-full border-[1.5px] border-bd-ink bg-tag-reel' />
          Coming up
        </CardTitle>
        <Button size='sm' variant='ghost' asChild>
          <Link to='/portal/calendar'>
            View the full calendar <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <div className='mb-3 crate-rule' />
        {isLoading ? (
          <Skeleton className='h-24' />
        ) : isError ? (
          <QueryError
            title='Could not load the calendar'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : shown.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            Nothing scheduled from today onwards.
          </p>
        ) : (
          <>
            <ul className='divide-y divide-bd-rule-soft'>
              {shown.map((item) => (
                <li key={item.id} className='flex items-center gap-3 py-2.5'>
                  <div className='w-16 shrink-0'>
                    <p className='display text-sm tabular-nums'>
                      {formatShortDate(item.scheduledAt)}
                    </p>
                    {item.scheduledTime && (
                      <p className='text-xs text-muted-foreground tabular-nums'>
                        {formatTime(item.scheduledTime)}
                      </p>
                    )}
                  </div>
                  <p className='min-w-0 flex-1 truncate text-sm font-semibold'>
                    {item.title}
                  </p>
                  <div className='flex shrink-0 items-center gap-2'>
                    <TypePill type={item.type} />
                    <StatusPill item={item} />
                  </div>
                </li>
              ))}
            </ul>
            {upcoming.length > shown.length && (
              <p className='pt-2.5 text-xs text-muted-foreground'>
                +{upcoming.length - shown.length} more scheduled.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
