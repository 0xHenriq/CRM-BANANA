import { Link } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Button } from '../ui/button'

/**
 * The banana peel mark from her prototype: a yellow square with three rounded
 * corners, rotated -15deg, outlined in cream. Reproduced in CSS rather than
 * shipped as an asset so it inherits the theme and stays crisp at any size.
 */
export function PeelMark({
  className,
  outline = 'cream',
}: {
  className?: string
  /**
   * Which ground the mark sits on. The outline must contrast with the
   * background or the peel reads as an amorphous yellow blob — 'cream' for the
   * ink sidebar, 'ink' for the cream page.
   */
  outline?: 'cream' | 'ink'
}) {
  return (
    <div
      aria-hidden
      className={cn('size-7 shrink-0 -rotate-[15deg] border-2', className)}
      style={{
        backgroundColor: 'var(--bd-yellow)',
        borderColor: outline === 'ink' ? 'var(--bd-ink)' : 'var(--bd-cream)',
        borderRadius: '0 60% 60% 60% / 0 70% 70% 70%',
      }}
    />
  )
}

export function AppTitle() {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size='lg'
          className='gap-0 py-0 hover:bg-transparent active:bg-transparent'
          asChild
        >
          <div>
            <Link
              to='/'
              onClick={() => setOpenMobile(false)}
              className='flex flex-1 items-center gap-2.5'
            >
              <PeelMark />
              <div className='grid flex-1 text-start leading-tight'>
                <span className='display truncate text-[1.35rem]'>
                  Banana Digital
                </span>
                <span className='truncate text-[0.625rem] tracking-[0.16em] uppercase opacity-70'>
                  Client Portal
                </span>
              </div>
            </Link>
            <ToggleSidebar />
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function ToggleSidebar({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar='trigger'
      data-slot='sidebar-trigger'
      variant='ghost'
      size='icon'
      className={cn('aspect-square size-8 max-md:scale-125', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <X className='md:hidden' />
      <Menu className='max-md:hidden' />
      <span className='sr-only'>Toggle Sidebar</span>
    </Button>
  )
}
