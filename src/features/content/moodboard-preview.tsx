import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, ImagePlus } from 'lucide-react'
import { toast } from 'sonner'
import { api, moodboardUrl, type MoodboardItem } from '@/lib/api'
import { safeHref } from '@/lib/safe-href'
import { uploadMedia } from '@/lib/upload'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryError } from '@/components/layout/query-error'
import { UploadButton } from '@/components/upload-button'
import { MoodboardLightbox } from './moodboard-lightbox'

/**
 * The moodboard, small, for the top of a workspace.
 *
 * She asked for it above everything else on a client's homepage, and the
 * reasoning is sound: the visual direction is what a social client actually
 * cares about, and it was buried behind a nav item they had to know to click.
 * The same strip sits on the agency's client page, which is why this is a
 * component rather than markup copied into two screens.
 *
 * Deliberately a strip, not the full masonry board: this is a glance and a way
 * in, and the board itself is one click away for the rest.
 */
export function MoodboardPreview({
  clientId,
  canEdit,
  limit = 6,
}: {
  clientId: string
  canEdit: boolean
  limit?: number
}) {
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<number | null>(null)
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['moodboard', clientId],
    queryFn: () =>
      api.get<{ clientId: string; items: MoodboardItem[] }>(
        `/media/moodboard?client=${clientId}`
      ),
  })

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of Array.from(files)) {
        setProgress(0)
        await uploadMedia(file, {
          clientId,
          target: 'moodboard',
          onProgress: setProgress,
        })
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['moodboard'] }),
    onError: (err: Error) => toast.error(err.message),
    onSettled: () => setProgress(null),
  })

  const items = data?.items ?? []
  const shown = items.slice(0, limit)

  return (
    <Card className='mb-5 crate-card'>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle className='flex items-center gap-2 display text-lg'>
          <span className='size-2.5 rounded-full border-[1.5px] border-bd-ink bg-bd-yellow' />
          Brand Moodboard
        </CardTitle>
        <div className='flex items-center gap-2'>
          {canEdit && (
            <UploadButton
              size='sm'
              variant='outline'
              label='Add'
              icon={<ImagePlus />}
              accept='image/*'
              pending={upload.isPending}
              progress={progress}
              onFiles={(files) => upload.mutate(files)}
            />
          )}
          <Button size='sm' variant='ghost' asChild>
            <Link to='/portal/moodboard'>
              Open board <ArrowRight />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className='mb-3 crate-rule' />
        {isLoading ? (
          <Skeleton className='h-24' />
        ) : isError ? (
          /* Before the empty state, not after it: a failed request rendered
             "Your moodboard is empty for now." to the client, which is a lie
             about their own workspace and gives them nothing to do about it. */
          <QueryError
            title='Could not load the moodboard'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : shown.length === 0 ? (
          <p className='text-sm text-muted-foreground'>
            {canEdit
              ? 'Nothing pinned yet. Add images to set the visual direction.'
              : 'Your moodboard is empty for now.'}
          </p>
        ) : (
          <ul className='flex flex-wrap gap-2'>
            {shown.map((item, index) => {
              // Rows from the prototype era hold a URL instead of stored bytes.
              const src = item.storageKey
                ? moodboardUrl(item.id)
                : safeHref(item.url)
              if (!src) return null
              return (
                <li key={item.id}>
                  {/* A button, not an image with a click handler: this IS an
                      action, so it should be focusable and announced as one.
                      The index is the position in `shown`, which is what the
                      viewer pages through. */}
                  <button
                    type='button'
                    onClick={() => setOpenIndex(index)}
                    aria-label={`Open ${item.caption ?? 'moodboard image'}`}
                    className='block cursor-zoom-in transition-opacity hover:opacity-85'
                  >
                    <img
                      src={src}
                      alt={item.caption ?? 'Moodboard reference'}
                      loading='lazy'
                      className='size-24 rounded border-2 border-bd-ink object-cover'
                    />
                  </button>
                </li>
              )
            })}
            {items.length > shown.length && (
              <li className='flex size-24 items-center justify-center rounded border-2 border-dashed border-bd-rule text-xs text-muted-foreground'>
                +{items.length - shown.length} more
              </li>
            )}
          </ul>
        )}
      </CardContent>

      {/* Pages through the tiles ACTUALLY SHOWN, not every tile the client
          has — the strip is capped at `limit`, and arrowing into pictures that
          are not on screen would be disorienting. */}
      <MoodboardLightbox
        items={shown}
        openIndex={openIndex}
        onClose={() => setOpenIndex(null)}
        onMove={setOpenIndex}
      />
    </Card>
  )
}
