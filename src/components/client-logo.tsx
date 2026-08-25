import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImagePlus } from 'lucide-react'
import { logoUrl } from '@/lib/api'
import { uploadMedia } from '@/lib/upload'
import { cn } from '@/lib/utils'
import { UploadButton } from '@/components/upload-button'

/**
 * The client's own mark, top-right of their portal.
 *
 * Asked for directly: "the client logo/icon should be top right." A portal
 * that carries only our branding reads as our tool that they have been given
 * a login to. Their own mark in the corner is the cheapest possible signal
 * that the workspace is theirs.
 *
 * Falls back to initials on their brand colour rather than to an empty box or
 * a generic placeholder icon — most clients will never send a logo, and the
 * fallback is what almost everyone sees, so it has to look deliberate.
 */
export function ClientLogo({
  clientId,
  name,
  logoKey,
  brandColor,
  canEdit = false,
  markOnly = false,
  className,
}: {
  clientId: string
  name: string
  logoKey: string | null
  brandColor?: string | null
  canEdit?: boolean
  /** Just the mark — no name, no upload control. For dense lists. */
  markOnly?: boolean
  className?: string
}) {
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadMedia(file, {
        clientId,
        target: 'logo',
        onProgress: setProgress,
      }),
    onSuccess: () => {
      setError(null)
      // Both shapes carry logoKey, and it is the cache-buster — a stale one
      // would leave her looking at the logo she just replaced.
      queryClient.invalidateQueries({ queryKey: ['portal'] })
      queryClient.invalidateQueries({ queryKey: ['client', clientId] })
      queryClient.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (e: Error) => setError(e.message),
    onSettled: () => setProgress(null),
  })

  // Two initials, from the first and last word — "Change of Perspective"
  // becomes CP rather than CH, which is what a person would write.
  const words = name.trim().split(/\s+/).filter(Boolean)
  const initials = (
    words.length > 1
      ? `${words[0]![0]}${words[words.length - 1]![0]}`
      : (words[0]?.slice(0, 2) ?? '?')
  ).toUpperCase()

  const mark = logoKey ? (
    <img
      src={logoUrl(clientId, logoKey)}
      alt={`${name} logo`}
      className='size-11 shrink-0 rounded-xl border border-border bg-white object-contain'
    />
  ) : (
    <span
      aria-hidden
      className='grid size-11 shrink-0 place-items-center rounded-xl border border-border display text-sm tracking-wide'
      style={
        brandColor
          ? { backgroundColor: brandColor, color: readableOn(brandColor) }
          : undefined
      }
    >
      {initials}
    </span>
  )

  if (markOnly) return mark

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className='display text-xl max-sm:hidden'>{name}</span>
      {mark}
      {canEdit && (
        <div className='flex flex-col items-start'>
          <UploadButton
            onFiles={(files) => files[0] && upload.mutate(files[0])}
            label={logoKey ? 'Change logo' : 'Add logo'}
            icon={<ImagePlus className='size-3.5' />}
            accept='image/*'
            multiple={false}
            pending={upload.isPending}
            progress={progress}
            size='sm'
            variant='ghost'
          />
          {error && (
            <span role='alert' className='max-w-40 text-xs text-destructive'>
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Black or white text on a brand colour, whichever a person can actually read.
 *
 * Sofia's palette runs from near-black to bright yellow, and white-on-yellow
 * initials are illegible. Perceived luminance, not a naive average of the
 * channels — that would call yellow dark and green light.
 */
function readableOn(hex: string): string {
  const m = /^#?([\da-f]{6}|[\da-f]{3})$/i.exec(hex.trim())
  if (!m) return '#fff'
  const h =
    m[1]!.length === 3
      ? m[1]!
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1]!
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  return luminance > 0.55 ? '#111' : '#fff'
}
