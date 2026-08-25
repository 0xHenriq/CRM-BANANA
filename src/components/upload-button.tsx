import { useId } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * The one way this application opens a file picker.
 *
 * It exists because the previous approach — a hidden input and
 * `ref.current.click()` — failed silently and cost a real day. Tailwind's
 * `hidden` is display:none, and a display:none file input does not reliably
 * open its picker from a programmatic click: Safari and iOS ignore it. Nothing
 * opens, no request is made, no error is raised, and there is not even a log
 * line to find, because nothing ever reaches the server.
 *
 * There is no JavaScript in the path at all now. A `<label for>` pointing at
 * the input is native browser behaviour, honoured everywhere including iOS,
 * and it survives a stale bundle, a blocked script and a browser we have never
 * tested. `useId` keeps the pairing unique, because two of these can be on
 * screen at once — the calendar and the review queue both mount the content
 * dialog — and duplicate ids would make one button drive the other's input.
 *
 * Three call sites shared it precisely so the mechanics cannot diverge again.
 */
export function UploadButton({
  onFiles,
  label,
  icon,
  accept,
  multiple = true,
  pending = false,
  progress,
  size,
  variant,
  className,
}: {
  onFiles: (files: FileList) => void
  label: string
  icon: React.ReactNode
  accept?: string
  multiple?: boolean
  pending?: boolean
  /** 0..1 while bytes are in flight, null once the server took over. */
  progress?: number | null
  size?: React.ComponentProps<typeof Button>['size']
  variant?: React.ComponentProps<typeof Button>['variant']
  className?: string
}) {
  const inputId = useId()

  /**
   * A 1 GB upload takes minutes. A button that says nothing for that long is
   * indistinguishable from the broken one this replaced, so it says where it
   * is: a percentage while the bytes move, then "Processing" for the window
   * where the server is hashing, thumbnailing or probing and the browser has
   * nothing left to report.
   */
  const text = !pending
    ? label
    : progress === null || progress === undefined
      ? 'Processing…'
      : `${Math.round(progress * 100)}%`

  return (
    <>
      <input
        id={inputId}
        type='file'
        accept={accept}
        multiple={multiple}
        className='sr-only'
        aria-label={label}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files)
          // Reset so choosing the same file twice still fires a change event.
          e.target.value = ''
        }}
      />
      {/*
        `disabled` does nothing to a label, so a pending upload is blocked with
        pointer-events instead. aria-disabled carries the same fact to assistive
        technology, which a visual-only treatment would not.
      */}
      <Button
        asChild
        size={size}
        variant={variant}
        className={cn(pending && 'pointer-events-none opacity-70', className)}
      >
        <label htmlFor={inputId} aria-disabled={pending}>
          {pending ? <Loader2 className='animate-spin' /> : icon}
          {text}
        </label>
      </Button>
    </>
  )
}
