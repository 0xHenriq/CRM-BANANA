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
  limit = 8,
}: {
  clientId: string
  canEdit: boolean
  /** Eight, so the grid fills two rows of four rather than ending ragged. */
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
          /*
            A grid of large squares, not a strip of 96px thumbnails.

            Sofia: "can we make a little bigger please moodboard". The tiles
            were `size-24` — 96 pixels — which is smaller than the thumbnail a
            phone shows in its camera roll, on the one card in this product
            whose entire job is to be LOOKED at. Six of them on a full-width
            card left most of the row empty as well, so it read as a leftover
            strip rather than as the visual direction.

            Sized by COLUMN COUNT rather than by a fixed pixel width, so the
            tiles grow with the card instead of staying small on a wide screen
            and overflowing on a phone. Three across on a phone is roughly
            110px; four on a laptop is around 200px.
          */
          <ul className='grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3'>
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
                    className='block w-full cursor-zoom-in transition-opacity hover:opacity-85'
                  >
                    <img
                      src={src}
                      alt={item.caption ?? 'Moodboard reference'}
                      loading='lazy'
                      className='aspect-square w-full rounded border-2 border-bd-ink object-cover'
                    />
                  </button>
                </li>
              )
            })}
            {items.length > shown.length && (
              /* A cell in the same grid, so the row never ends ragged. It is a
                 LINK now rather than a dead label: "+4 more" that cannot be
                 clicked is a sign pointing at nothing. */
              <li>
                <Link
                  to='/portal/moodboard'
                  className='flex aspect-square w-full items-center justify-center rounded border-2 border-dashed border-bd-rule text-xs text-muted-foreground hover:border-bd-ink hover:text-bd-ink'
                >
                  +{items.length - shown.length} more
                </Link>
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
