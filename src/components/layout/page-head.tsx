import { cn } from '@/lib/utils'

/**
 * The page header from her prototype: a red eyebrow, a League Gothic title,
 * and a rotated wax stamp, sitting on a 3px ink rule. Every screen uses it,
 * so it lives here rather than being re-hand-rolled per feature.
 */
export function PageHead({
  eyebrow,
  title,
  stamp,
  actions,
  className,
}: {
  eyebrow: string
  title: string
  stamp?: { top: string; big: string; bottom: string }
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'crate-underline mb-6 flex items-end justify-between gap-4 pb-3.5',
        className
      )}
    >
      <div className='min-w-0'>
        <div className='crate-eyebrow mb-1'>{eyebrow}</div>
        <h1 className='display truncate text-4xl'>{title}</h1>
      </div>
      <div className='flex shrink-0 items-center gap-3'>
        {actions}
        {stamp && <CrateStamp {...stamp} />}
      </div>
    </div>
  )
}

export function CrateStamp({
  top,
  big,
  bottom,
}: {
  top: string
  big: string
  bottom: string
}) {
  return (
    <div className='crate-stamp max-sm:hidden' aria-hidden>
      <span className='text-[0.5625rem]'>{top}</span>
      <span className='text-base leading-none'>{big}</span>
      <span className='text-[0.5625rem]'>{bottom}</span>
    </div>
  )
}
