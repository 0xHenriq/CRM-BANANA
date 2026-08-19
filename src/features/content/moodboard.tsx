import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GripVertical, ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  moodboardUrl,
  uploadMedia,
  type MoodboardItem,
} from '@/lib/api'
import { useWorkspace, withClient } from '@/features/portal/use-workspace'
import { WorkspaceSwitcher } from '@/features/portal/workspace-switcher'
import { safeHref } from '@/lib/safe-href'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { PageHead } from '@/components/layout/page-head'
import { QueryError } from '@/components/layout/query-error'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { ThemeSwitch } from '@/components/theme-switch'

/**
 * Visual direction, from real uploads.
 *
 * The prototype took image URLs only, which meant she had to host every
 * reference somewhere else first — so the two most visual features of the
 * portal went unused. Rows that still carry a `url` instead of a stored key
 * are rendered too, so nothing from that era is lost.
 */
export function Moodboard() {
  const { isStaff, clientId, setClientId, workspaces, isReady } = useWorkspace()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['moodboard', clientId ?? 'default'],
    queryFn: () =>
      api.get<{ clientId: string; items: MoodboardItem[] }>(
        withClient('/media/moodboard', clientId)
      ),
    enabled: isReady,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['moodboard'] })

  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      // Sequential, not parallel: each upload does image work on the server,
      // and a dozen at once would fight for the same cores for no gain.
      for (const file of Array.from(files)) {
        await uploadMedia(file, { clientId, target: 'moodboard' })
      }
    },
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/media/moodboard/${id}`),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.patch('/media/moodboard/reorder', { ids }),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  })

  const items = data?.items ?? []

  function onDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return
    const next = [...items]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(targetIndex, 0, moved)
    setDragIndex(null)
    reorder.mutate(next.map((i) => i.id))
  }

  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          {isStaff && (
            <WorkspaceSwitcher
              clientId={clientId}
              workspaces={workspaces}
              onChange={setClientId}
            />
          )}
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </div>
      </Header>

      <Main>
        <PageHead
          eyebrow='Visual direction'
          title='Social Moodboard'
          stamp={{ top: 'MOOD', big: '❦', bottom: 'BOARD' }}
          actions={
            isStaff ? (
              <>
                {/*
                  `sr-only`, never `hidden`. Tailwind's `hidden` is
                  display:none, and a display:none file input does not reliably
                  open its picker from a programmatic .click() — Safari and iOS
                  in particular ignore it, so the button appears to do nothing
                  at all: no picker, no request, no error. Nothing reaches the
                  server, so there is not even a log line to find. `sr-only`
                  keeps the input rendered and focusable while still invisible,
                  which is the shape every browser honours.
                */}
                <input
                  ref={inputRef}
                  type='file'
                  accept='image/*'
                  multiple
                  className='sr-only'
                  aria-label='Choose images to add'
                  onChange={(e) => {
                    if (e.target.files?.length) upload.mutate(e.target.files)
                    // Reset so choosing the same file twice still fires.
                    e.target.value = ''
                  }}
                />
                <Button
                  onClick={() => inputRef.current?.click()}
                  disabled={upload.isPending}
                >
                  {upload.isPending ? (
                    <Loader2 className='animate-spin' />
                  ) : (
                    <ImagePlus />
                  )}
                  Add images
                </Button>
              </>
            ) : undefined
          }
        />

        {isLoading ? (
          <Skeleton className='h-96' />
        ) : isError ? (
          <QueryError
            title='Could not load the moodboard'
            error={error as Error}
            onRetry={() => refetch()}
          />
        ) : items.length === 0 ? (
          <Card className='crate-card'>
            <CardContent className='py-12 text-center text-sm text-muted-foreground'>
              {isStaff
                ? 'Nothing pinned yet. Add images to set the visual direction.'
                : 'Your moodboard is empty for now.'}
            </CardContent>
          </Card>
        ) : (
          <div className='columns-2 gap-3 sm:columns-3 lg:columns-4'>
            {items.map((item, index) => {
              const external = item.storageKey ? null : safeHref(item.url)
              const src = item.storageKey ? moodboardUrl(item.id) : external
              if (!src) return null

              return (
                <figure
                  key={item.id}
                  draggable={isStaff}
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(index)}
                  className={cn(
                    'group relative mb-3 break-inside-avoid overflow-hidden rounded-md border-2 border-bd-ink',
                    isStaff && 'cursor-grab active:cursor-grabbing',
                    dragIndex === index && 'opacity-40'
                  )}
                >
                  <img
                    src={src}
                    alt={item.caption ?? 'Moodboard reference'}
                    loading='lazy'
                    className='block w-full'
                  />
                  {item.caption && (
                    <figcaption className='bg-bd-paper px-2 py-1 text-[0.6875rem]'>
                      {item.caption}
                    </figcaption>
                  )}

                  {isStaff && (
                    <>
                      <GripVertical className='absolute top-1 left-1 size-4 text-white opacity-0 drop-shadow group-hover:opacity-100' />
                      <Button
                        size='icon'
                        variant='destructive'
                        className='absolute top-1 right-1 size-6 opacity-0 group-hover:opacity-100'
                        aria-label='Remove this image'
                        onClick={() => remove.mutate(item.id)}
                      >
                        <Trash2 className='size-3' />
                      </Button>
                    </>
                  )}
                </figure>
              )
            })}
          </div>
        )}
      </Main>
    </>
  )
}
