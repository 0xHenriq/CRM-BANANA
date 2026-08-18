import { Link } from '@tanstack/react-router'
import { getDisplayNameInitials } from '@/lib/utils'
import { useCurrentUser } from '@/hooks/use-current-user'
import useDialogState from '@/hooks/use-dialog-state'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SignOutDialog } from '@/components/sign-out-dialog'

/**
 * The account menu in the page header.
 *
 * It shipped with the shadcn-admin scaffold's placeholder identity still in it:
 * the avatar, the name "satnaing" and the address "satnaingdev@gmail.com" were
 * hardcoded, so every signed-in person — her clients included — saw a stranger's
 * name and email address at the top of every screen. It is on the portal
 * homepage, the calendar, the ideas bank, the feed and the moodboard, which is
 * to say on every screen a client ever sees.
 *
 * `useCurrentUser` is the single authority on who is signed in (resolved
 * server-side from the member row), and the sidebar's NavUser already reads it.
 * This now reads the same source, so the two can never disagree.
 */
export function ProfileDropdown() {
  const [open, setOpen] = useDialogState()
  const { data: currentUser } = useCurrentUser()

  const name = currentUser?.name ?? 'Signed in'
  const email = currentUser?.email ?? ''

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant='ghost'
            className='relative h-8 w-8 rounded-full'
            aria-label={`Account menu for ${name}`}
          >
            {/*
              No AvatarImage: there is no avatar upload, and pointing at a file
              that does not exist ('/avatars/01.png') just rendered a broken
              image before the fallback took over. Initials are the honest
              representation of an account with no picture.
            */}
            <Avatar className='h-8 w-8'>
              <AvatarFallback>
                {currentUser ? getDisplayNameInitials(name) : '…'}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className='w-56' align='end' forceMount>
          <DropdownMenuLabel className='font-normal'>
            <div className='flex flex-col gap-1.5'>
              <p className='truncate text-sm leading-none font-medium'>
                {name}
              </p>
              {email && (
                <p className='truncate text-xs leading-none text-muted-foreground'>
                  {email}
                </p>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {/*
              Only destinations that exist. "Billing" pointed at the profile
              settings page — there is no billing in this product — and "New
              Team" was not a link or a handler at all, so clicking it did
              nothing at all. A menu entry that silently does nothing teaches
              people the menu is broken.
            */}
            <DropdownMenuItem asChild>
              <Link to='/settings'>
                Profile
                <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to='/settings/account'>Account</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to='/settings/notifications'>Notifications</Link>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant='destructive' onClick={() => setOpen(true)}>
            Sign out
            <DropdownMenuShortcut className='text-current'>
              ⇧⌘Q
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
