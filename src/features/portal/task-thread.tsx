import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, formatShortDate, localDayOf, type TaskComment } from '@/lib/api'
import { useCurrentUser } from '@/hooks/use-current-user'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { QueryError } from '@/components/layout/query-error'

/**
 * The conversation about one to-do.
 *
 * Sofia asked for this twice — "reply to next steps in this section" — and the
 * reason it was missing is worth keeping: the Next Steps panel carries two
 * kinds of row, and a post has had a comment thread since phase 2. So half of
 * the panel headed "what happens next" could be discussed inside the product
 * and the other half could not, which meant "swap the Nyall photo for the CIC
 * logo" got answered in WhatsApp, where the answer is not attached to anything.
 *
 * BOTH SIDES can write. A thread only the agency can post in is a notice board
 * and there is already one of those; the point is that the client can say
 * "actually use the other photo" against the specific thing it is about.
 *
 * Loaded only when a row is opened. Fetching every thread on a page with
 * fifteen to-dos on it would be fifteen requests for text nobody has asked to
 * read — which is why the reply COUNT rides along on the to-do itself, so the
 * button can say there is something here before anything is fetched.
 */
export function TaskThread({
  taskId,
  taskTitle,
  canModerate,
  className,
}: {
  taskId: string
  /**
   * Named in every control's accessible label, because more than one of these
   * can be open at once — the Next Steps panel keeps expansion state per row,
   * so three threads on screen meant three buttons announcing themselves as
   * "Write a reply" with nothing to tell them apart.
   */
  taskTitle: string
  /** Staff may remove a reply. Nobody may edit one — see migration 0021. */
  canModerate: boolean
  className?: string
}) {
  const queryClient = useQueryClient()
  const { data: currentUser } = useCurrentUser()
  const [draft, setDraft] = useState('')

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['task-comments', taskId],
    queryFn: () =>
      api.get<{ comments: TaskComment[] }>(`/portal/tasks/${taskId}/comments`),
  })

  /**
   * Every key a reply changes.
   *
   * The thread itself, plus the two panels that render the count on the row —
   * ['portal'] for the To-do list and ['next-steps'] for the panel above it.
   * Missing one of those leaves a reply posted and a button still reading
   * "Reply" with no number, which reads as the message not having sent.
   */
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['task-comments', taskId] })
    await queryClient.invalidateQueries({ queryKey: ['portal'] })
    await queryClient.invalidateQueries({ queryKey: ['next-steps'] })
  }

  const send = useMutation({
    mutationFn: (body: string) =>
      api.post(`/portal/tasks/${taskId}/comments`, { body }),
    onSuccess: async () => {
      setDraft('')
      await invalidate()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api.del(`/portal/tasks/${taskId}/comments/${id}`),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <div
      className={cn(
        'mt-1 mb-2 space-y-2 rounded-md border-[1.5px] border-bd-rule-soft bg-bd-cream/60 p-2.5',
        className
      )}
    >
      {isError ? (
        <QueryError
          title='Could not load the replies'
          error={error as Error}
          onRetry={() => refetch()}
        />
      ) : isPending ? (
        <Skeleton className='h-10' />
      ) : data.comments.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          No replies yet. Write the first one.
        </p>
      ) : (
        <ul className='space-y-2'>
          {data.comments.map((comment) => (
            <li key={comment.id} className='flex items-start gap-2'>
              <div className='min-w-0 flex-1'>
                <p className='text-xs font-semibold'>
                  {/* `authorName` is null when the account has been removed —
                      the column is ON DELETE SET NULL, so the reply survives
                      the person. "Someone" is honest; a blank name reads as a
                      rendering bug. */}
                  {comment.authorName ?? 'Someone'}
                  <span className='ms-2 font-normal text-muted-foreground'>
                    {/* localDayOf, not .slice(0, 10). createdAt is a
                        timestamp and the slice takes the UTC day, so a reply
                        written at half past midnight in London reads as
                        yesterday. This repo has already fixed this once, on
                        the share page — see the same comment there. */}
                    {formatShortDate(localDayOf(comment.createdAt))}
                  </span>
                </p>
                <p className='text-sm whitespace-pre-wrap'>{comment.body}</p>
              </div>
              {canModerate && (
                <Button
                  size='icon'
                  variant='ghost'
                  className='size-6 shrink-0'
                  aria-label={`Remove ${comment.authorName ?? 'someone'}'s reply on "${taskTitle}"`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(comment.id)}
                >
                  <Trash2 className='size-3 text-destructive' />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className='flex items-end gap-2'
        onSubmit={(e) => {
          e.preventDefault()
          const body = draft.trim()
          if (body && !send.isPending) send.mutate(body)
        }}
      >
        <Textarea
          aria-label={`Write a reply on "${taskTitle}"`}
          placeholder={
            currentUser?.isStaff
              ? 'Reply to your client about this…'
              : 'Reply about this…'
          }
          className='min-h-9 flex-1 resize-y py-1.5 text-sm'
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, shift+Enter is a new line — the shape everybody
            // already has in their fingers from every chat app. A textarea is
            // still the control underneath so a long reply can be written.
            //
            // `send.isPending` is checked here as well as on the button: the
            // button is disabled while a reply is in flight, and the keyboard
            // path went straight past that. Two Enters on a slow connection
            // posted the same reply twice.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const body = draft.trim()
              if (body && !send.isPending) send.mutate(body)
            }
          }}
        />
        <Button
          size='sm'
          className='h-9'
          /* Starts with the visible word. An accessible name that does not
             contain the label a sighted user reads breaks voice control —
             "click Reply" has to match the thing that says Reply. */
          aria-label={`Reply on "${taskTitle}"`}
          disabled={!draft.trim() || send.isPending}
        >
          {send.isPending ? (
            <Loader2 className='animate-spin' />
          ) : (
            <Send className='size-3.5' />
          )}
          Reply
        </Button>
      </form>
    </div>
  )
}
