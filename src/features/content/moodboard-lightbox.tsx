import { useCallback, useEffect } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { moodboardFullUrl, type MoodboardItem } from '@/lib/api'
import { safeHref } from '@/lib/safe-href'
import { cn } from '@/lib/utils'

/**
 * Look at a moodboard image properly.
 *
 * Sofia: the tiles could not be clicked, on the board or on the preview strip.
 * A moodboard is the one screen that exists to be LOOKED at, and it was the one
 * screen showing 96px thumbnails with no way in — so it read as a grid of
 * decoration rather than the visual direction it is.
 *
 * Its own component because both surfaces need it and a second copy would
 * drift; the board and the strip should behave identically when you click a
 * picture.
 *
 * Deliberately not the shadcn Dialog: this is a full-bleed image viewer, and
 * Dialog's padded, max-width card is the wrong shape for it. The behaviours a
 * dialog would have given are here explicitly — Escape closes, arrows move,
 * the background scroll is locked, and the backdrop is a button so a click
 * anywhere outside the image closes it.
 */
export function MoodboardLightbox({
  items,
  openIndex,
  onClose,
  onMove,
}: {
  items: MoodboardItem[]
  /** Null when closed. */
  openIndex: number | null
  onClose: () => void
  onMove: (nextIndex: number) => void
}) {
  const open = openIndex !== null && openIndex >= 0 && openIndex < items.length

  const step = useCallback(
    (delta: number) => {
      if (openIndex === null || items.length === 0) return
      // Wraps, so the arrows never dead-end on the first or last image.
      onMove((openIndex + delta + items.length) % items.length)
    },
    [openIndex, items.length, onMove]
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    // The page behind must not scroll while this is up, or dismissing it
    // returns you somewhere else.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose, step])

  if (!open || openIndex === null) return null
  const item = items[openIndex]
  // Rows from the prototype era hold a URL instead of stored bytes.
  const src = item.storageKey ? moodboardFullUrl(item.id) : safeHref(item.url)
  if (!src) return null

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-bd-ink/90 p-4'
      role='dialog'
      aria-modal='true'
      aria-label={item.caption ?? 'Moodboard image'}
    >
      {/* The backdrop closes. A button rather than a div with onClick, so it
          is reachable by keyboard and announced as an action. */}
      <button
        type='button'
        className='absolute inset-0 cursor-zoom-out'
        aria-label='Close'
        onClick={onClose}
      />

      <button
        type='button'
        onClick={onClose}
        aria-label='Close'
        className='absolute end-4 top-4 z-10 flex size-9 items-center justify-center rounded-full border-[1.5px] border-bd-ink bg-bd-cream text-bd-ink hover:bg-bd-yellow'
      >
        <X className='size-4' />
      </button>

      {items.length > 1 && (
        <>
          <NavButton side='start' onClick={() => step(-1)} label='Previous image'>
            <ChevronLeft className='size-5' />
          </NavButton>
          <NavButton side='end' onClick={() => step(1)} label='Next image'>
            <ChevronRight className='size-5' />
          </NavButton>
        </>
      )}

      <figure className='relative z-10 flex max-h-full flex-col items-center gap-3'>
        <img
          src={src}
          alt={item.caption ?? 'Moodboard reference'}
          className='max-h-[80vh] max-w-full rounded border-2 border-bd-ink object-contain'
        />
        <figcaption className='text-center text-xs text-bd-cream'>
          {item.caption && <span className='block'>{item.caption}</span>}
          {items.length > 1 && (
            <span className='block opacity-70 tabular-nums'>
              {openIndex + 1} of {items.length}
            </span>
          )}
        </figcaption>
      </figure>
    </div>
  )
}

function NavButton({
  side,
  onClick,
  label,
  children,
}: {
  side: 'start' | 'end'
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-label={label}
      className={cn(
        'absolute top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center',
        'rounded-full border-[1.5px] border-bd-ink bg-bd-cream text-bd-ink hover:bg-bd-yellow',
        side === 'start' ? 'start-4' : 'end-4'
      )}
    >
      {children}
    </button>
  )
}
