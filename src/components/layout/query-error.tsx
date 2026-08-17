import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

/**
 * Shown when a query fails.
 *
 * Exists because the alternative is worse than ugly: rendering the empty state
 * on error told her "No clients yet — add the first one" when the request had
 * actually failed, and the client detail page sat on skeletons forever after a
 * 404. Both are lies, and the second one has no exit.
 */
export function QueryError({
  title = 'Could not load this',
  error,
  onRetry,
}: {
  title?: string
  error?: Error | null
  onRetry?: () => void
}) {
  return (
    <Card className='crate-card'>
      <CardContent className='flex flex-col items-center gap-3 py-10 text-center'>
        <AlertTriangle className='size-5 text-destructive' />
        <div>
          <p className='text-sm font-semibold'>{title}</p>
          {error?.message && (
            <p className='mt-1 text-xs text-muted-foreground'>{error.message}</p>
          )}
        </div>
        {onRetry && (
          <Button size='sm' variant='outline' onClick={onRetry}>
            <RotateCw />
            Try again
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
