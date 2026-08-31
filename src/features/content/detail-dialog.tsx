import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Copy,
  ImagePlus,
  Loader2,
  MessageSquare,
  Play,
  Send,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  assetUrl,
  CONTENT_STATUSES,
  CONTENT_TYPES,
  formatTime,
  type ContentDetail,
  type ContentItem,
  type ContentStatus,
  type ContentType,
  formatShortDate,
  localDayOf,
} from '@/lib/api'
import { uploadMedia } from '@/lib/upload'
import { useCurrentUser } from '@/hooks/use-current-user'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { UploadButton } from '@/components/upload-button'
import { HashtagEditor } from './hashtag-editor'
import { ApprovalOverduePill, StatusPill, TypePill } from './pills'
import { ShareLinks } from './share-links'
import { STATUS_LABEL, TYPE_LABEL } from './vocabulary'

/**
 * One dialog for both the Ideas Bank and the Calendar, because they are the
 * same record. Opening a row from either place lands here.
 */
export function ContentDetailDialog({
  itemId,
  onClose,
}: {
  itemId: string | null
  onClose: () => void
}) {
  const { data: currentUser } = useCurrentUser()
  const isStaff = currentUser?.isStaff ?? false
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [note, setNote] = useState('')
  const [progress, setProgress] = useState<number | null>(null)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['content-item', itemId],
    queryFn: () => api.get<ContentDetail>(`/content/${itemId}`),
    enabled: !!itemId,
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['content'] })
    await queryClient.invalidateQueries({ queryKey: ['content-item', itemId] })
    // The review queue is keyed separately, and every decision or status
    // change moves an item in or out of it. Without this the client approved
    // a post and the panel still read "2 posts need your review" — which
    // looks exactly like the approval not working.
    await queryClient.invalidateQueries({ queryKey: ['next-steps'] })
    // The dashboard's awaiting count comes from the client list.
    await queryClient.invalidateQueries({ queryKey: ['clients'] })
    // Feed cells carry title, status and the scheduled date, so a patch or a
    // decision made here changes what the grid shows. This used to be bolted
    // on at two of the five call sites — the upload and the duplicate — which
    // left `patch` and `decide` refreshing everything EXCEPT the grid: the
    // client approved a post and its cell still read "Ready for review".
    // Every caller needs it, so it belongs in the shared helper.
    await queryClient.invalidateQueries({ queryKey: ['feed'] })
    /*
     * And the client's own page.
     *
     * Every mutation in this dialog writes an `activities` row — approving,
     * requesting changes, renaming, rescheduling — and that row is the
     * Activity timeline on the client page, which reads ['client', clientId].
     * The dialog opens from Next Steps, which sits ON that page, so she could
     * approve a post and watch the timeline below it not mention it.
     *
     * ['clients'] above does NOT cover this. Prefix matching is element-wise:
     * ['clients'] and ['client', id] share no first element, and mistaking one
     * for the other is the exact bug this codebase has already paid for twice.
     */
    await queryClient.invalidateQueries({ queryKey: ['client'] })
  }

  const patch = useMutation({
    mutationFn: (body: Partial<ContentItem>) =>
      api.patch(`/content/${itemId}`, body),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  const addComment = useMutation({
    mutationFn: () =>
      api.post(`/content/${itemId}/comments`, { body: comment.trim() }),
    onSuccess: async () => {
      await invalidate()
      setComment('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      for (const file of Array.from(files)) {
        setProgress(0)
        await uploadMedia(file, {
          clientId: null,
          target: 'content',
          contentItemId: itemId ?? undefined,
          onProgress: setProgress,
        })
      }
    },
    onSuccess: async () => {
      await invalidate()
    },
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => setProgress(null),
  })

  /**
   * Repeat a post without retyping it or re-uploading its creative.
   *
   * The copy lands in the Ideas Bank as an unscheduled idea, so it is never
   * mistaken for something already approved or already on the calendar.
   */
  const duplicate = useMutation({
    mutationFn: () =>
      api.post<{ assetsCopied: number }>(`/content/${itemId}/duplicate`),
    onSuccess: async (result) => {
      await invalidate()
      toast.success(
        result.assetsCopied
          ? `Copied to the Ideas Bank with ${result.assetsCopied} asset${result.assetsCopied === 1 ? '' : 's'}.`
          : 'Copied to the Ideas Bank.'
      )
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'changes_requested') =>
      api.post(`/content/${itemId}/decision`, {
        decision,
        note: note.trim() || null,
      }),
    onSuccess: async () => {
      await invalidate()
      setNote('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const item = data?.item
  // A decision only applies to something actually sent for review — the API
  // returns 409 otherwise, so the buttons should not be offered.
  const decidable =
    item && item.status !== 'idea' && item.status !== 'in_progress'

  return (
    <Dialog open={!!itemId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='max-h-[85vh] overflow-y-auto crate-card sm:max-w-2xl'>
        {isLoading || (!data && !isError) ? (
          <div className='space-y-3 py-4'>
            <Skeleton className='h-8 w-2/3' />
            <Skeleton className='h-32' />
          </div>
        ) : isError || !item ? (
          <DialogHeader>
            <DialogTitle className='display text-xl'>Unavailable</DialogTitle>
            <DialogDescription>
              This item could not be loaded, or you no longer have access to it.
            </DialogDescription>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className='pe-6 display text-2xl'>
                {item.title}
              </DialogTitle>
              <DialogDescription asChild>
                <div className='flex flex-wrap items-center gap-2 pt-1'>
                  <TypePill type={item.type} />
                  <StatusPill status={item.status} />
                  <ApprovalOverduePill item={item} />
                  {item.scheduledAt ? (
                    <span className='text-xs text-muted-foreground'>
                      Scheduled {item.scheduledAt}
                      {item.scheduledTime
                        ? ` at ${formatTime(item.scheduledTime)}`
                        : ''}
                    </span>
                  ) : (
                    <span className='text-xs text-muted-foreground'>
                      Not scheduled — still an idea
                    </span>
                  )}
                </div>
              </DialogDescription>
            </DialogHeader>

            {isStaff && (
              <div className='grid gap-3 rounded-md border-[1.5px] border-dashed border-bd-rule p-3 sm:grid-cols-3'>
                {/* Title and caption were previously read-only everywhere in
                    the product, so a typo in a post name could not be fixed
                    at all. Saved on blur rather than per keystroke. */}
                <div className='grid gap-1.5 sm:col-span-3'>
                  <Label htmlFor='cd-title'>Name</Label>
                  <Input
                    id='cd-title'
                    name='content-title'
                    className='h-8'
                    defaultValue={item.title}
                    key={`title-${item.id}-${item.updatedAt}`}
                    onBlur={(e) => {
                      const next = e.target.value.trim()
                      if (next && next !== item.title)
                        patch.mutate({ title: next })
                    }}
                  />
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor='cd-type'>Type</Label>
                  <Select
                    value={item.type}
                    onValueChange={(v) =>
                      patch.mutate({ type: v as ContentType })
                    }
                  >
                    <SelectTrigger id='cd-type' className='h-8'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTENT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {TYPE_LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor='cd-status'>Status</Label>
                  <Select
                    value={item.status}
                    onValueChange={(v) =>
                      patch.mutate({ status: v as ContentStatus })
                    }
                  >
                    <SelectTrigger id='cd-status' className='h-8'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTENT_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor='cd-date'>Scheduled for</Label>
                  <div className='flex gap-1.5'>
                    <Input
                      id='cd-date'
                      type='date'
                      className='h-8 flex-1'
                      value={item.scheduledAt ?? ''}
                      onChange={(e) =>
                        patch.mutate({ scheduledAt: e.target.value || null })
                      }
                    />
                    {/*
                      Posting time is a large part of what the agency is paid
                      for, so it sits beside the date rather than behind an
                      "advanced" disclosure. Disabled until there is a date:
                      a time with no day is not a schedule, and the server
                      clears it if the date goes away.
                    */}
                    <Input
                      type='time'
                      className='h-8 w-28'
                      aria-label='Time of day'
                      disabled={!item.scheduledAt}
                      value={formatTime(item.scheduledTime)}
                      onChange={(e) =>
                        patch.mutate({ scheduledTime: e.target.value || null })
                      }
                    />
                  </div>
                </div>
                <div className='grid gap-1.5 sm:col-span-3'>
                  <Label htmlFor='cd-caption'>Caption</Label>
                  <Textarea
                    id='cd-caption'
                    name='content-caption'
                    className='min-h-16 resize-y'
                    placeholder='The copy that goes out with this post…'
                    defaultValue={item.caption ?? ''}
                    key={`caption-${item.id}-${item.updatedAt}`}
                    onBlur={(e) => {
                      const next = e.target.value
                      if (next !== (item.caption ?? '')) {
                        patch.mutate({ caption: next || null })
                      }
                    }}
                  />
                </div>
                <div className='sm:col-span-3'>
                  <HashtagEditor
                    value={item.hashtags ?? []}
                    onChange={(next) => patch.mutate({ hashtags: next })}
                  />
                </div>
                <div className='flex flex-wrap items-center justify-between gap-2 sm:col-span-3'>
                  <p className='text-xs text-muted-foreground'>
                    Giving this a date puts it on the calendar. It is the same
                    record either way — there is no separate calendar entry to
                    keep in step.
                  </p>
                  <div className='flex flex-wrap items-center gap-2'>
                  {/*
                    Only for a post already shared with the client. An
                    internal Ideas Bank row has nothing to show a recipient —
                    and the mint route refuses it, backed by the
                    `AND visible_to_client` arm on content_items_select.
                  */}
                  <ShareLinks
                    contentItemId={item.id}
                    canShare={isStaff && item.visibleToClient}
                  />
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => duplicate.mutate()}
                    disabled={duplicate.isPending}
                  >
                    {duplicate.isPending ? (
                      <Loader2 className='animate-spin' />
                    ) : (
                      <Copy />
                    )}
                    Duplicate
                  </Button>
                  </div>
                </div>
              </div>
            )}

            {/*
              `(item.hashtags?.length ?? 0) > 0`, not the bare length. A guard
              that ends in a NUMBER renders that number when it is zero, so a
              client opening a post with no caption and no tags — every post
              captured in the Ideas Bank, which has neither field — was shown a
              stray "0" above the assets. JSX renders 0; it only skips false.
            */}
            {!isStaff && (item.caption || (item.hashtags?.length ?? 0) > 0) && (
              <div className='grid gap-2'>
                {item.caption && (
                  <p className='text-sm whitespace-pre-wrap'>{item.caption}</p>
                )}
                {/* The client sees the tags that will go out with their post —
                    read-only, but visible: approving a caption without them is
                    approving half of what gets published. */}
                <HashtagEditor
                  value={item.hashtags ?? []}
                  onChange={() => {}}
                  readOnly
                />
              </div>
            )}

            {/* ---------------------------------------------------- assets */}
            <div>
              <div className='mb-2 flex items-center justify-between pb-1 crate-rule'>
                <p className='display text-sm'>Assets</p>
                {isStaff && (
                  <UploadButton
                    size='sm'
                    variant='outline'
                    label='Add'
                    icon={<ImagePlus />}
                    accept='image/*,video/*'
                    pending={upload.isPending}
                    progress={progress}
                    onFiles={(files) => upload.mutate(files)}
                  />
                )}
              </div>

              {data.assets.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  {isStaff
                    ? 'Nothing attached. The first asset here becomes this post’s cell in the feed preview.'
                    : 'Nothing to see yet.'}
                </p>
              ) : (
                <ul className='flex flex-wrap gap-2'>
                  {data.assets.map((asset) => (
                    <li key={asset.id} className='relative'>
                      <a
                        href={assetUrl(asset.id)}
                        target='_blank'
                        rel='noopener noreferrer'
                        className='block size-24 overflow-hidden rounded border-2 border-bd-ink'
                      >
                        <img
                          src={assetUrl(
                            asset.id,
                            asset.kind === 'video' ? 'poster' : 'thumb'
                          )}
                          alt=''
                          loading='lazy'
                          className='size-full object-cover'
                        />
                      </a>
                      {asset.kind === 'video' && (
                        <span className='pointer-events-none absolute inset-0 flex items-center justify-center'>
                          <Play className='size-5 fill-white/90 text-white drop-shadow' />
                        </span>
                      )}
                      {asset.durationMs && (
                        <span className='absolute right-0.5 bottom-0.5 rounded bg-bd-ink/80 px-1 text-[0.5625rem] text-bd-cream'>
                          {Math.round(asset.durationMs / 1000)}s
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ------------------------------------------------ decisions */}
            {decidable && (
              <div className='space-y-2 rounded-md border-2 border-bd-ink bg-bd-cream p-3'>
                <p className='display text-sm'>
                  {isStaff ? 'Record a decision' : 'Your call'}
                </p>
                <Textarea
                  id='decision-note'
                  name='decision-note'
                  aria-label='Note on your decision'
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder='Optional note — what needs changing?'
                  className='min-h-14 resize-y bg-card'
                />
                {/*
                  The spinner goes on the button that was actually pressed.

                  Both buttons disable while a decision is in flight, which is
                  right — content_approvals is append-only, so a double click
                  writes two rows that can never be tidied up. But the spinner
                  was hard-wired to Approve, so requesting changes greyed both
                  buttons and span the APPROVE one: for as long as the request
                  took, the screen said she was approving a post she had just
                  sent back. `decide.variables` is the decision in flight.
                */}
                <div className='flex flex-wrap gap-2'>
                  <Button
                    size='sm'
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
                    size='sm'
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

            {data.approvals.length > 0 && (
              <div>
                <p className='mb-2 pb-1 display text-sm crate-rule'>
                  Decision history
                </p>
                <ul className='space-y-1.5'>
                  {data.approvals.map((a) => (
                    <li key={a.id} className='text-sm'>
                      <span className='font-semibold'>
                        {a.decision === 'approved'
                          ? 'Approved'
                          : 'Changes requested'}
                      </span>
                      <span className='text-muted-foreground'>
                        {' '}
                        {/* A link decision genuinely has no actor — the
                            CHECK on content_approvals allows one or the
                            other — so it is named for what it was rather
                            than falling through to "Someone". */}
                        · {a.viaShareLink
                          ? 'via share link'
                          : (a.actorName ?? 'Someone')}{' '}
                        ·{' '}
                        {/* "1 Sep", not en-GB's "1 Sept". The same date is
                            rendered three characters differently three lines
                            from here on the share page, and a product should
                            not spell a month two ways. */}
                        {formatShortDate(localDayOf(a.decidedAt))}
                        {', '}
                        {new Date(a.decidedAt).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {a.note && (
                        <p className='text-sm text-muted-foreground'>
                          {a.note}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ------------------------------------------------- comments */}
            <div>
              <p className='mb-2 flex items-center gap-1.5 pb-1 display text-sm crate-rule'>
                <MessageSquare className='size-3.5' />
                Comments
              </p>
              {data.comments.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  No comments yet.
                </p>
              ) : (
                <ul className='space-y-2.5'>
                  {data.comments.map((cm) => (
                    <li key={cm.id}>
                      <p className='text-xs text-muted-foreground'>
                        {cm.authorName ?? 'Someone'} ·{' '}
                        {new Date(cm.createdAt).toLocaleString('en-GB', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </p>
                      <p className='text-sm whitespace-pre-wrap'>{cm.body}</p>
                    </li>
                  ))}
                </ul>
              )}

              <form
                className='mt-3 flex gap-2'
                onSubmit={(e) => {
                  e.preventDefault()
                  if (comment.trim()) addComment.mutate()
                }}
              >
                <Input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder='Add a comment…'
                  className='h-8'
                  aria-label='Add a comment'
                />
                <Button
                  size='sm'
                  disabled={!comment.trim() || addComment.isPending}
                >
                  <Send />
                </Button>
              </form>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
